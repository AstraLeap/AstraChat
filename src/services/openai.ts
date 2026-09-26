import { ChatApiError, extractApiErrorMessage } from './errors';
import { createSseParser } from './sse';

/**
 * OpenAI 兼容协议的流式聊天客户端。
 *
 * 需求硬性要求「流式输出使用 fetch + ReadableStream 解析 SSE」，本模块就是那个实现点：
 * 全程只用全局 `fetch` / `response.body.getReader()` / `TextDecoder`，不依赖任何
 * SDK，也不依赖浏览器专有的 `EventSource`（它只支持 GET，无法发 POST + 自定义头）。
 *
 * 运行位置：Electron **主进程**。这样既能绕开渲染进程的 CORS 限制，又让 API Key
 * 不必进入渲染进程。
 */

/** 发给模型的单条消息。 */
export interface ChatCompletionMessage {
  /** 消息角色。 */
  role: 'system' | 'user' | 'assistant';
  /** 消息正文。 */
  content: string;
}

/** 一次增量回调的载荷。 */
export interface StreamDelta {
  /** 正文增量（可能为空串）。 */
  content: string;
  /** 思维链增量（可能为空串）。 */
  reasoning: string;
}

/** `streamChatCompletion` 的调用参数。 */
export interface StreamChatOptions {
  /** 接口根地址，不含 `/chat/completions`。 */
  baseUrl: string;
  /** API Key；为空时不发送 `Authorization` 头（本地 Ollama 等无需鉴权）。 */
  apiKey: string;
  /** 模型名。 */
  model: string;
  /** 完整消息数组（含系统提示词）。 */
  messages: ChatCompletionMessage[];
  /** 采样温度；`undefined` 时不写入请求体，交给服务端默认值。 */
  temperature?: number;
  /** 中止信号，用于「停止生成」。 */
  signal?: AbortSignal;
  /** 每收到一段增量就回调一次。 */
  onDelta: (delta: StreamDelta) => void;
}

/**
 * 把 content 字段规整成字符串。
 *
 * 绝大多数服务端返回 `delta.content` 是字符串，但部分兼容实现（以及多模态响应）会返回
 * `[{ type: 'text', text: '...' }]` 这样的分片数组，这里一并兼容。
 *
 * @param value 原始 content 值。
 * @returns 拼接后的文本；无法识别时返回空串。
 */
function readContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part === 'object' && part !== null) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * 从一条已解析的 SSE 事件里抽出增量文本。
 *
 * 同时兼容 `delta`（流式）与 `message`（某些实现即使 `stream:true` 也返回完整消息）。
 * 优先读取 `reasoning_content`（DeepSeek 约定），退回 `reasoning`（部分第三方网关）。
 *
 * @param data 事件的 `data` 字段文本。
 * @returns 增量载荷；该事件不含可用增量时返回 `null`。
 * @throws 当服务端在流中回传 `error` 对象时抛出 {@link ChatApiError}。
 */
function readDelta(data: string): StreamDelta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // 不是 JSON：忽略这一条，避免因为一个畸形分片打断整个回复。
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  // 流中途的错误：OpenAI 会以 data: {"error": {...}} 的形式下发。
  const errorField = (parsed as { error?: unknown }).error;
  if (errorField) {
    const message =
      typeof errorField === 'string'
        ? errorField
        : typeof errorField === 'object' && errorField !== null
          ? ((errorField as { message?: unknown }).message ?? '')
          : '';
    throw new ChatApiError(
      typeof message === 'string' && message.trim() ? message.trim() : '流式响应中途返回了错误',
    );
  }

  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const first = choices[0] as { delta?: unknown; message?: unknown; text?: unknown };
  const container =
    (typeof first.delta === 'object' && first.delta !== null ? first.delta : null) ??
    (typeof first.message === 'object' && first.message !== null ? first.message : null);

  if (container) {
    const record = container as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    const content = readContent(record.content);
    const reasoningRaw =
      typeof record.reasoning_content === 'string'
        ? record.reasoning_content
        : typeof record.reasoning === 'string'
          ? record.reasoning
          : '';
    if (!content && !reasoningRaw) {
      return null;
    }
    return { content, reasoning: reasoningRaw };
  }

  // 极少见的 legacy `choices[0].text` 形式
  if (typeof first.text === 'string' && first.text) {
    return { content: first.text, reasoning: '' };
  }

  return null;
}

/**
 * 以流式方式请求一次聊天补全，逐段回调增量。
 *
 * @param options 请求参数，见 {@link StreamChatOptions}。
 * @returns 流正常结束（收到 `[DONE]` 或响应体自然结束）时 resolve。
 * @throws {ChatApiError} 非 2xx 响应、响应体为空、或流中途回传错误。
 * @throws {Error} 网络层失败；用户中止时抛出 `AbortError`（**不吞**，交由上层标记为「已中止」）。
 */
export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const { baseUrl, apiKey, model, messages, temperature, signal, onDelta } = options;

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };
  if (temperature !== undefined) {
    payload.temperature = temperature;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    // 失败时服务端返回的通常是 JSON 错误对象，但网关错误可能是 HTML —— 都读成文本再尽力解析。
    const body = await response.text().catch(() => '');
    throw new ChatApiError(extractApiErrorMessage(body), {
      status: response.status,
      body,
    });
  }

  if (!response.body) {
    throw new ChatApiError('响应没有可读取的流（response.body 为空）', {
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  // `stream: true` 让 TextDecoder 缓存跨 chunk 被切断的多字节字符（中文/emoji 必需）。
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser();
  let finished = false;

  /**
   * 处理一批已解析的 SSE 事件。
   *
   * @param events 事件列表。
   * @returns 是否收到终止标记 `[DONE]`。
   */
  const consume = (events: ReturnType<typeof parser.push>): boolean => {
    for (const event of events) {
      if (event.data === '[DONE]') {
        return true;
      }
      const delta = readDelta(event.data);
      if (delta) {
        onDelta(delta);
      }
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        if (consume(parser.push(decoder.decode(value, { stream: true })))) {
          finished = true;
          break;
        }
      }
    }

    if (!finished) {
      // 冲掉解码器与解析器里残留的尾巴（服务端可能没发最后的空行）。
      const tail = decoder.decode();
      if (tail && consume(parser.push(tail))) {
        finished = true;
      }
      if (!finished) {
        consume(parser.flush());
      }
    }
  } finally {
    // 无论正常结束还是出错，都释放底层连接；已 cancel 过的 reader 再次 cancel 是安全的。
    if (finished) {
      void reader.cancel().catch(() => undefined);
    }
  }
}
