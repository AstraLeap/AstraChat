import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../src/types/ipc';
import type { ChatSendRequest, ChatStreamEvent, Message } from '../src/types/index';
import * as repo from '../src/db/index';
import type { Db } from '../src/db/index';
import { ChatApiError, normalizeError } from '../src/services/errors';
import { streamChatCompletion } from '../src/services/openai';

/**
 * 流式聊天的编排层（主进程）。
 *
 * 为什么流式请求放在主进程而不是渲染进程：
 * 1. **绕开 CORS**。渲染进程是 `file://`（生产）或 `http://localhost:5173`（开发），
 *    直连 `api.openai.com` 这类接口会被浏览器同源策略拦截，而很多提供商并不返回
 *    `Access-Control-Allow-Origin`。主进程的 fetch 不受同源策略约束。
 * 2. **API Key 不进入渲染进程**（渲染层只发 providerId，密钥在主进程从 SQLite 取）。
 * 3. 仍然满足「用 fetch + ReadableStream 解析 SSE」的要求 —— 只是发生在主进程。
 *
 * 事件协议：`start` → 0..n 个 `delta` → 恰好一个终态事件。终态统一用 `done` 表示
 * （正常结束、被中止都走 `done`，由 `message.status` 区分），只有真正的失败才发 `error`。
 * 这样渲染层只需要处理「一个开始、若干增量、一个结束」三段式。
 *
 * ⚠️ **时序契约（改动前务必读完）**：{@link startStream} 是**同步函数**，它在
 * `return { streamId }` **之前**就同步推送了 `start` 事件。因此渲染层的
 * `await window.astra.chat.send(req)` resolve 时，`start` 事件**几乎总是已经先到了**，
 * 紧随其后的首批 `delta` 也可能先于该 Promise 的 resolve 抵达。
 *
 * 渲染层不能「等 send() resolve 拿到 messageId 之后再开始收增量」，否则首批 delta 会
 * 因为找不到目标消息而被丢弃，表现为「AI 气泡一直空白、最后内容突然出现」。
 * `src/stores/useChatStore.ts` 采用「按 conversationId 预登记占位消息 + delta 兜底认领」
 * 来应对这个时序。若要调整这里的推送顺序，必须同步检查该 store。
 */

/** 持久化节流间隔（毫秒）。SSE 分块可能非常密集，没必要每块都写一次磁盘。 */
const PERSIST_INTERVAL_MS = 120;

/** 一个进行中的流。 */
interface ActiveStream {
  streamId: string;
  messageId: string;
  conversationId: string;
  controller: AbortController;
  /** 已累积的正文与思维链，终态时一次性落库，避免节流导致丢数据。 */
  content: string;
  reasoning: string;
  /** 上次落库的时间戳。 */
  lastPersistAt: number;
}

/** 进行中的流表，key 为 streamId。 */
const activeStreams = new Map<string, ActiveStream>();

/** 编排层依赖注入。 */
export interface ChatDeps {
  /** 数据库句柄。 */
  db: Db;
  /** 获取当前主窗口；窗口可能已销毁，取不到就静默丢弃事件。 */
  getWindow: () => BrowserWindow | null;
}

/**
 * 向渲染进程推送一个流式事件。
 *
 * 窗口已关闭时静默返回：用户关窗不应该在主进程里抛异常。
 *
 * @param deps 依赖。
 * @param event 事件负载。
 */
function emit(deps: ChatDeps, event: ChatStreamEvent): void {
  const win = deps.getWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  win.webContents.send(IPC_CHANNELS.chat.event, event);
}

/**
 * 中止指定流。
 *
 * @param streamId 流 id。
 * @returns 是否确实中止了一个进行中的流。
 */
export function abortStream(streamId: string): boolean {
  const stream = activeStreams.get(streamId);
  if (!stream) {
    return false;
  }
  stream.controller.abort();
  return true;
}

/**
 * 中止全部进行中的流（应用退出时调用）。
 */
export function abortAllStreams(): void {
  for (const stream of activeStreams.values()) {
    stream.controller.abort();
  }
  activeStreams.clear();
}

/**
 * 发起一次流式回复。
 *
 * 立即返回 `streamId`，真正的网络请求在后台继续，通过 `chat:event` 通道推送进度。
 *
 * @param deps 依赖。
 * @param request 发起参数。
 * @returns `streamId`。
 * @throws 当提供商不存在或未配置 Base URL 时抛出 `Error`（`invoke` 会把它转成 reject）。
 */
export function startStream(deps: ChatDeps, request: ChatSendRequest): { streamId: string } {
  const { db } = deps;

  const provider = repo.getProvider(db, request.providerId);
  if (!provider) {
    throw new Error('所选模型提供商不存在，请在「设置 → 模型提供商」中重新选择。');
  }
  if (!provider.baseUrl) {
    throw new Error(`提供商「${provider.name}」未配置 Base URL。`);
  }

  const model = (request.model || provider.model || '').trim();
  if (!model) {
    throw new Error(`提供商「${provider.name}」未配置默认模型名。`);
  }

  const conversation = repo.getConversation(db, request.conversationId);
  if (!conversation) {
    throw new Error('对话不存在或已被删除。');
  }

  // ① 落库用户消息
  repo.createMessage(db, {
    conversationId: conversation.id,
    role: 'user',
    content: request.content,
  });
  repo.autoTitleConversation(db, conversation.id);

  // ② 落库 assistant 占位消息（status=streaming）
  const placeholder = repo.createMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    reasoning: '',
    status: 'streaming',
    model,
  });
  repo.touchConversation(db, conversation.id);

  // ③ 组装消息数组：人格系统提示词 + 历史
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (request.personaId) {
    const persona = repo.getPersona(db, request.personaId);
    if (persona && persona.systemPrompt.trim()) {
      messages.push({ role: 'system', content: persona.systemPrompt });
    }
  }
  messages.push(...repo.buildHistory(db, conversation.id));

  const streamId = randomUUID();
  const controller = new AbortController();
  const stream: ActiveStream = {
    streamId,
    messageId: placeholder.id,
    conversationId: conversation.id,
    controller,
    content: '',
    reasoning: '',
    lastPersistAt: Date.now(),
  };
  activeStreams.set(streamId, stream);

  emit(deps, {
    type: 'start',
    streamId,
    messageId: placeholder.id,
    conversationId: conversation.id,
  });

  // ④ 后台执行流式请求；有意不 await，handler 需要立刻返回 streamId。
  void runStream(deps, stream, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  });

  return { streamId };
}

/** 传给 `streamChatCompletion` 的参数。 */
interface RunStreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
}

/**
 * 执行一次流式请求并把结果写入数据库、推送给渲染进程。
 *
 * @param deps 依赖。
 * @param stream 进行中的流状态。
 * @param options 请求参数。
 */
async function runStream(
  deps: ChatDeps,
  stream: ActiveStream,
  options: RunStreamOptions,
): Promise<void> {
  const { db } = deps;
  const { streamId, messageId } = stream;

  /**
   * 把当前累积内容落库。
   *
   * @param force 为真时忽略节流强制写入（终态必用）。
   */
  const persist = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - stream.lastPersistAt < PERSIST_INTERVAL_MS) {
      return;
    }
    stream.lastPersistAt = now;
    try {
      repo.updateMessage(db, messageId, {
        content: stream.content,
        reasoning: stream.reasoning,
      });
    } catch {
      // 消息可能已被用户删除（例如删掉了整个对话），此时静默放弃落库，
      // 但流本身继续，避免一个删除操作把整个回复打断。
    }
  };

  let finalMessage: Message;

  try {
    await streamChatCompletion({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages: options.messages,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      signal: stream.controller.signal,
      onDelta: (delta) => {
        if (delta.content) {
          stream.content += delta.content;
        }
        if (delta.reasoning) {
          stream.reasoning += delta.reasoning;
        }
        persist(false);
        emit(deps, {
          type: 'delta',
          streamId,
          messageId,
          content: delta.content,
          reasoning: delta.reasoning,
        });
      },
    });

    finalMessage = repo.updateMessage(db, messageId, {
      content: stream.content,
      reasoning: stream.reasoning,
      status: 'complete',
      error: null,
    });
  } catch (error) {
    const aborted = stream.controller.signal.aborted;
    const reason = aborted ? '已中止' : normalizeError(error);

    finalMessage = repo.updateMessage(db, messageId, {
      content: stream.content,
      reasoning: stream.reasoning,
      status: aborted ? 'aborted' : 'error',
      error: aborted ? null : reason,
    });

    if (!aborted) {
      emit(deps, { type: 'error', streamId, messageId, error: reason });
      activeStreams.delete(streamId);
      return;
    }
  } finally {
    activeStreams.delete(streamId);
  }

  emit(deps, { type: 'done', streamId, messageId, message: finalMessage });
}

/**
 * 判定一个错误是否是可识别的 API 错误（用于日志分级）。
 *
 * @param error 捕获的异常。
 * @returns 是 `ChatApiError` 时返回 `true`。
 */
export function isApiError(error: unknown): error is ChatApiError {
  return error instanceof ChatApiError;
}
