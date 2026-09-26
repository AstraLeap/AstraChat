import { create } from 'zustand';
import { describeError, getBridge } from './bridge';
import type { ChatSendRequest, ChatStreamEvent, Message } from '../types/index';

/**
 * 消息列表与流式回复状态。
 *
 * 设计要点（对流式「切错位置」的防御）：
 * 1. **按 id 定位，绝不按「最后一条」定位**。所有 `delta` 都通过 `messageId` 找到目标
 *    assistant 消息再追加；找不到就直接丢弃。
 * 2. **按会话过滤**。每条事件都记录到 `streamOwners`（`streamId → conversationId`），
 *    切到别的对话后，属于旧对话的事件全部忽略（`start` 事件恰好会被忽略，因为
 *    `streamOwners` 是在 `sendMessage` 里就已经登记的）。
 * 3. **终态即抹除归属**。`done` / `error` 之后从 `streamOwners` 删除该 `streamId`，
 *    主进程若重复推送终态或迟到事件，都会被当作过期事件丢弃，不会污染新对话。
 * 4. **代际（generation）守卫**：`loadMessages` 与 `sendMessage` 都会自增 `generation`，
 *    异步 await 返回后若代际已变，说明用户已经切走，直接放弃写入，避免「先发的请求
 *    后返回」把旧对话的消息盖到新对话上。
 * 5. **单例订阅**。`onEvent` 只在模块内订阅一次并由 `ensureSubscribed()` 复用，
 *    见 {@link disposeChatStream}；重复订阅会导致同一 `delta` 被追加两次（内容翻倍）。
 */

/** {@link useChatStore} 的状态与动作。 */
export interface ChatState {
  /** 当前展示的消息列表（归属 `conversationId`）。 */
  messages: Message[];
  /** 当前消息列表归属的对话 id；`null` 表示没有加载任何对话。 */
  conversationId: string | null;
  /** 是否正在加载消息列表。 */
  loading: boolean;
  /** 消息级错误（加载失败、发送失败、流式失败）。 */
  error: string | null;
  /** 当前活跃的流 id；`null` 表示空闲。 */
  streamingId: string | null;

  /**
   * 加载指定对话的消息；切换对话时前一个对话的流式事件会被自动忽略。
   *
   * @param conversationId 目标对话 id。
   * @returns 无返回值；结果写入 store。
   */
  loadMessages(conversationId: string): Promise<void>;

  /**
   * 发送一条用户消息并启动主进程流式回复。
   *
   * 主进程会自行落库用户消息与一条 `streaming` 的 assistant 占位消息；渲染层**先**
   * 乐观插入这两条（用户体验上不等 IPC 往返），待 `start` / `done` 事件到达后用真实
   * 记录替换。
   *
   * @param request 发送参数（对话 id、正文、提供商、模型、人格、温度）。
   * @returns 启动成功返回 `true`；参数缺失或 IPC 失败返回 `false`。
   */
  sendMessage(request: ChatSendRequest): Promise<boolean>;

  /**
   * 中止指定的流（已接收内容会被保留并标记为 `aborted`）。
   *
   * @param streamId 目标流 id；省略时中止当前活跃的流。
   * @returns 无返回值。
   */
  abort(streamId?: string): Promise<void>;

  /**
   * 清空消息与流式状态（切换对话前调用，避免旧消息闪现）。
   *
   * @param conversationId 可选：清空后直接标记为某个对话（尚未加载其消息）。
   */
  reset(conversationId?: string | null): void;
}

// ---------------------------------------------------------------------------
// 模块级流状态（刻意放在 React 之外）
// ---------------------------------------------------------------------------

/** `streamId → conversationId`：判断某个流的事件是否属于当前对话。 */
const streamOwners = new Map<string, string>();

/** `streamId → assistant 占位消息 id`：`start` 到达前也能把 delta 落到位。 */
const streamPlaceholders = new Map<string, string>();

/**
 * `conversationId → 待认领的乐观 assistant 占位 id 队列`（FIFO）。
 *
 * 必须在 `chat.send()` **之前**登记。原因：主进程的 `startStream` 是同步函数，它在
 * 返回 `{ streamId }` 之前就已经 `emit('start')` 了（见 `electron/chat.ts`），因此
 * `start` 事件几乎总是**先于** `await chat.send()` 的 resolve 到达渲染层。若等
 * `send` 返回后再登记占位 id，`start` 就没有可认领的本地占位消息，紧随其后的
 * `delta` 会因为找不到 `messageId` 对应的消息而被整批丢弃 —— 表现就是「AI 一直空白」。
 *
 * 用**队列**而不是单个 id：同一对话里可能有两条流短暂重叠（例如用户点了「停止」
 * 后立刻再发一条，而上一条流还在收尾）。`start` 事件按主进程处理的先后顺序到达，
 * 因此 FIFO 出队即可精确配对；若用单个值，后一次登记会覆盖前一次，导致 `start`
 * 认领到错误的气泡。
 */
const pendingAssistantByConversation = new Map<string, string[]>();

/**
 * 登记一个待认领的乐观占位 id（入队）。
 *
 * @param conversationId 对话 id。
 * @param localId 乐观 assistant 消息的本地 id。
 */
function enqueuePendingPlaceholder(conversationId: string, localId: string): void {
  const queue = pendingAssistantByConversation.get(conversationId);
  if (queue) {
    queue.push(localId);
  } else {
    pendingAssistantByConversation.set(conversationId, [localId]);
  }
}

/**
 * 取出并移除一个待认领的乐观占位 id（出队，FIFO）。
 *
 * @param conversationId 对话 id。
 * @returns 队首的本地 id；队列为空时返回 `null`。
 */
function takePendingPlaceholder(conversationId: string): string | null {
  const queue = pendingAssistantByConversation.get(conversationId);
  if (!queue || queue.length === 0) {
    return null;
  }
  const localId = queue.shift() ?? null;
  if (queue.length === 0) {
    pendingAssistantByConversation.delete(conversationId);
  }
  return localId;
}

/**
 * 从待认领队列里移除指定的本地 id（发送失败时回滚）。
 *
 * 只删指定的那一个，不动同对话中其他并发发送登记的占位 id。
 *
 * @param conversationId 对话 id。
 * @param localId 要移除的本地 id。
 */
function dropPendingPlaceholder(conversationId: string, localId: string): void {
  const queue = pendingAssistantByConversation.get(conversationId);
  if (!queue) {
    return;
  }
  const next = queue.filter((id) => id !== localId);
  if (next.length === 0) {
    pendingAssistantByConversation.delete(conversationId);
  } else {
    pendingAssistantByConversation.set(conversationId, next);
  }
}

/** `conversationId → 该对话当前活跃的 streamId`：用于 `done` 时清理与 `abort()`。 */
const activeStreamByConversation = new Map<string, string>();

/**
 * 乐观占位 id 生成器。
 *
 * 形态为 `local:<conversationId>:<序号>:<角色>`，可被 {@link isLocalId} 识别。
 * 之所以不用随机数：同一会话内连续发送时，前缀加序号即可保证唯一且便于排查。
 */
let localSequence = 0;

/**
 * 生成一条乐观占位消息的本地 id。
 *
 * @param conversationId 所属对话。
 * @param role 消息角色。
 * @returns 本地占位 id。
 */
function makeLocalId(conversationId: string, role: Message['role']): string {
  localSequence += 1;
  return `local:${conversationId}:${localSequence}:${role}`;
}

/**
 * 判断一个消息 id 是否是渲染层生成的乐观占位 id（尚未落库）。
 *
 * @param id 消息 id。
 * @returns 是本地占位 id 返回 `true`。
 */
export function isLocalId(id: string): boolean {
  return id.startsWith('local:');
}

/**
 * 构造一条乐观占位消息。
 *
 * @param params 消息字段。
 * @returns 完整的 `Message` 对象。
 */
function makeMessage(params: {
  id: string;
  conversationId: string;
  role: Message['role'];
  content: string;
  status: Message['status'];
  model?: string | null;
  reasoning?: string | null;
  error?: string | null;
}): Message {
  return {
    id: params.id,
    conversationId: params.conversationId,
    role: params.role,
    content: params.content,
    reasoning: params.reasoning ?? null,
    status: params.status,
    error: params.error ?? null,
    model: params.model ?? null,
    createdAt: Date.now(),
  };
}

/**
 * 把 `done` 携带的**已落库真实消息**写入列表。
 *
 * 三种情况都要能吃掉占位消息：
 * 1. 列表里已有同 id 的记录（`start` 已认领）→ 原地替换；
 * 2. 列表里还有本地占位 id（`start` 从未到达 / 无增量就结束）→ 用 `localId` 替换；
 * 3. 都没有 → 追加（例如用户切换过对话又切回来）。
 *
 * @param list 当前消息列表。
 * @param message 落库后的真实消息。
 * @param localId 本流对应的本地占位 id（可能不存在）。
 * @returns 新列表。
 */
function upsertRealMessage(list: Message[], message: Message, localId: string | null): Message[] {
  if (list.some((item) => item.id === message.id)) {
    return list.map((item) => (item.id === message.id ? message : item));
  }
  if (localId !== null && list.some((item) => item.id === localId)) {
    return list.map((item) => (item.id === localId ? message : item));
  }
  return [...list, message];
}

/** 取消当前订阅的函数；`startSubscription` / `stopSubscription` 成对管理。 */
let unsubscribe: (() => void) | null = null;

/**
 * 处理来自主进程的流式事件。
 *
 * 所有分支都遵循同一条铁律：**只认 `messageId` / `conversationId`，不认「最后一条」**。
 *
 * @param event 流式事件。
 */
function handleStreamEvent(event: ChatStreamEvent): void {
  const state = useChatStore.getState();
  const owner = streamOwners.get(event.streamId);

  if (event.type === 'start') {
    streamOwners.set(event.streamId, event.conversationId);
    activeStreamByConversation.set(event.conversationId, event.streamId);
    // `start` 通常先于 `chat.send()` 的 resolve 到达，此时占位 id 只能从
    // 「按对话登记的待认领占位」里取。取到后转入 streamId 索引。
    if (!streamPlaceholders.has(event.streamId)) {
      const pending = takePendingPlaceholder(event.conversationId);
      if (pending) {
        streamPlaceholders.set(event.streamId, pending);
      }
    }
    // 属于别的对话：只记账，不改当前视图。
    if (state.conversationId !== event.conversationId) {
      return;
    }
    useChatStore.setState((prev) => {
      const placeholderId = streamPlaceholders.get(event.streamId);
      const hasRealPlaceholder = prev.messages.some((item) => item.id === event.messageId);
      if (hasRealPlaceholder) {
        return { streamingId: event.streamId };
      }
      // 把乐观占位消息「认领」为落库后的 id。
      const retargeted = placeholderId
        ? prev.messages.map((item) =>
            item.id === placeholderId ? { ...item, id: event.messageId } : item,
          )
        : prev.messages;
      return {
        messages: retargeted,
        streamingId: event.streamId,
      };
    });
    return;
  }

  // 未登记归属的流：要么是过期事件，要么属于本进程启动前的残留流，一律丢弃。
  if (owner === undefined || state.conversationId !== owner) {
    if (event.type === 'done' || event.type === 'error') {
      streamOwners.delete(event.streamId);
      activeStreamByConversation.delete(owner ?? '');
      streamPlaceholders.delete(event.streamId);
    }
    return;
  }

  switch (event.type) {
    case 'delta': {
      useChatStore.setState((prev) => {
        const hasTarget = prev.messages.some((item) => item.id === event.messageId);
        // 兜底认领：`start` 万一没到达（或到达时还没登记占位 id），这里先把本地占位
        // 消息改名为落库后的 `messageId`，再在同一批更新里追加增量，避免丢字。
        const localId = hasTarget ? null : (streamPlaceholders.get(event.streamId) ?? null);
        return {
          messages: prev.messages.map((item) => {
            const isTarget =
              item.id === event.messageId || (localId !== null && item.id === localId);
            if (!isTarget) {
              return item;
            }
            return {
              ...item,
              id: event.messageId,
              content: item.content + event.content,
              reasoning: event.reasoning
                ? (item.reasoning ?? '') + event.reasoning
                : item.reasoning,
              status: 'streaming',
            };
          }),
        };
      });
      return;
    }
    case 'done': {
      const finished = event.message;
      const localId = streamPlaceholders.get(event.streamId) ?? null;
      useChatStore.setState((prev) => ({
        messages: upsertRealMessage(prev.messages, finished, localId),
        streamingId: prev.streamingId === event.streamId ? null : prev.streamingId,
        // 被中止不算错误，不要给用户弹红条。
        error: finished.status === 'error' ? (finished.error ?? '生成失败') : prev.error,
      }));
      streamOwners.delete(event.streamId);
      streamPlaceholders.delete(event.streamId);
      if (activeStreamByConversation.get(owner) === event.streamId) {
        activeStreamByConversation.delete(owner);
      }
      return;
    }
    case 'error': {
      useChatStore.setState((prev) => ({
        messages: prev.messages.map((item) =>
          item.id === event.messageId
            ? { ...item, status: 'error', error: event.error }
            : item,
        ),
        streamingId: prev.streamingId === event.streamId ? null : prev.streamingId,
        error: event.error,
      }));
      streamOwners.delete(event.streamId);
      streamPlaceholders.delete(event.streamId);
      if (activeStreamByConversation.get(owner) === event.streamId) {
        activeStreamByConversation.delete(owner);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * 建立对 `window.astra.chat.onEvent` 的**唯一**订阅（幂等）。
 *
 * @returns 无返回值。
 * @throws 桥接不可用时抛出 `Error`（由调用方捕获并展示）。
 */
export function ensureChatStreamSubscribed(): void {
  if (unsubscribe) {
    return;
  }
  unsubscribe = getBridge().chat.onEvent(handleStreamEvent);
}

/**
 * 取消订阅并清空所有模块级流状态。
 *
 * 必须在 `ChatPage` 卸载时调用：`onEvent` 返回的取消函数如果丢失，监听器会永久驻留，
 * 下次挂载再订阅一次 —— 同一个 `delta` 被处理两遍，内容就会翻倍。
 *
 * 同时把 `streamingId` 归零：卸载时若有流仍在进行，它的终态事件已经收不到了，
 * 留着会让「停止」按钮在回到聊天页后一直亮着。已接收内容由主进程落库，重新
 * `loadMessages` 即可恢复。
 *
 * @returns 无返回值。
 */
export function disposeChatStream(): void {
  unsubscribe?.();
  unsubscribe = null;
  streamOwners.clear();
  streamPlaceholders.clear();
  pendingAssistantByConversation.clear();
  activeStreamByConversation.clear();
  useChatStore.setState({ streamingId: null });
}

/** 消息列表与流式状态 store。 */
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  conversationId: null,
  loading: false,
  error: null,
  streamingId: null,

  async loadMessages(conversationId) {
    // 切走即重置视图：先清空，避免上一个对话的消息在新对话里闪现。
    const previousId = get().conversationId;
    if (previousId !== conversationId) {
      set({ messages: [], conversationId, error: null, streamingId: null });
    }
    set({ loading: true, error: null });
    try {
      const messages = await getBridge().messages.list(conversationId);
      // 等待期间用户又切走了：丢弃这次过期响应。
      if (get().conversationId !== conversationId) {
        return;
      }
      set({ messages, loading: false });
    } catch (error) {
      if (get().conversationId !== conversationId) {
        return;
      }
      set({ loading: false, error: describeError(error) });
    }
  },

  async sendMessage(request) {
    const { conversationId, content } = request;
    if (get().conversationId !== conversationId) {
      // 视图不在目标对话上就直接拒绝，避免把消息发到用户看不见的地方。
      set({ error: '当前对话已切换，消息未发送。' });
      return false;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      set({ error: '消息内容不能为空。' });
      return false;
    }

    const userPlaceholder = makeMessage({
      id: makeLocalId(conversationId, 'user'),
      conversationId,
      role: 'user',
      content: trimmed,
      status: 'complete',
    });
    const assistantPlaceholder = makeMessage({
      id: makeLocalId(conversationId, 'assistant'),
      conversationId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: request.model,
    });

    set((prev) => ({
      messages: [...prev.messages, userPlaceholder, assistantPlaceholder],
      error: null,
    }));

    // 必须在 `chat.send()` 之前登记：主进程在返回 streamId 之前就推送了 `start`，
    // 见 pendingAssistantByConversation 的说明。
    enqueuePendingPlaceholder(conversationId, assistantPlaceholder.id);

    try {
      ensureChatStreamSubscribed();
      const { streamId } = await getBridge().chat.send({ ...request, content: trimmed });
      // 发送期间用户切走了：仍然登记归属（后续事件会被 owner 校验丢掉），但不改视图。
      streamOwners.set(streamId, conversationId);
      if (!streamPlaceholders.has(streamId)) {
        streamPlaceholders.set(streamId, assistantPlaceholder.id);
      }
      dropPendingPlaceholder(conversationId, assistantPlaceholder.id);
      activeStreamByConversation.set(conversationId, streamId);
      if (get().conversationId === conversationId) {
        set({ streamingId: streamId });
      }
      return true;
    } catch (error) {
      dropPendingPlaceholder(conversationId, assistantPlaceholder.id);
      const message = describeError(error);
      set((prev) => ({
        error: message,
        // 发送失败：把占位 assistant 标记为 error，并把乐观插入的用户消息留在原地，
        // 用户可以直接重试，无需重新输入。
        messages: prev.messages.map((item) =>
          item.id === assistantPlaceholder.id
            ? { ...item, status: 'error', error: message }
            : item,
        ),
      }));
      return false;
    }
  },

  async abort(streamId) {
    const target = streamId ?? get().streamingId ?? undefined;
    if (!target) {
      return;
    }
    try {
      await getBridge().chat.abort(target);
      // 终态仍由主进程的 `done(status='aborted')` 推送回来，这里只做即时反馈。
      set((prev) => (prev.streamingId === target ? { streamingId: null } : {}));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  reset(conversationId) {
    set({
      messages: [],
      conversationId: conversationId ?? null,
      loading: false,
      error: null,
      streamingId: null,
    });
  },
}));