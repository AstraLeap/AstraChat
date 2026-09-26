/**
 * 模型 API 调用的错误类型与归一化工具。
 *
 * 分层意图：`openai.ts` 只负责把 HTTP/网络层面的失败**原样**表达成 `ChatApiError`，
 * 由上层（`electron/chat.ts`）决定落库文案。这样错误信息里能保留服务端原始 body，
 * 便于用户排查（例如「model not found」「invalid api key」），而不是被压成一句「请求失败」。
 */

/** 构造 `ChatApiError` 的选项。 */
export interface ChatApiErrorOptions {
  /** HTTP 状态码；网络层失败（DNS、连接被拒）时为 `null`。 */
  status?: number | null;
  /** 服务端返回的原始响应体（已截断），便于排查。 */
  body?: string | null;
}

/** 服务端原始响应体的最大保留长度，避免一条超长 HTML 错误页把日志撑爆。 */
const MAX_BODY_LENGTH = 2000;

/**
 * 模型 API 返回非 2xx，或响应体不符合预期时抛出的错误。
 */
export class ChatApiError extends Error {
  /** HTTP 状态码；网络层失败时为 `null`。 */
  readonly status: number | null;

  /** 服务端原始响应体（可能为 `null`）。 */
  readonly body: string | null;

  /**
   * @param message 面向用户的错误描述。
   * @param options 可选的 HTTP 状态码与响应体。
   */
  constructor(message: string, options: ChatApiErrorOptions = {}) {
    super(message);
    this.name = 'ChatApiError';
    this.status = options.status ?? null;
    this.body = options.body ? options.body.slice(0, MAX_BODY_LENGTH) : null;
  }
}

/**
 * 判断异常是否为「用户主动中止」。
 *
 * 不同运行时的表现不一致：浏览器/Node 的 `fetch` 抛 `AbortError`，而某些封装会抛
 * 已被置为 aborted 的 `DOMException`。统一在这里识别。
 *
 * @param error 捕获到的异常。
 * @returns 是中止类错误时返回 `true`。
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * 从服务端响应体里尽力抽出可读的错误信息。
 *
 * OpenAI 兼容接口的失败响应通常是 `{ "error": { "message": "..." } }`，但也可能是
 * 纯文本或 HTML（网关错误页）。依次尝试 JSON → 纯文本 → 原始片段。
 *
 * @param body 原始响应体文本。
 * @returns 尽力提取出的错误描述。
 */
export function extractApiErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return '服务端未返回错误详情';
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string' && error.trim()) {
        return error.trim();
      }
      if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return message.trim();
        }
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  } catch {
    // 不是 JSON，继续按纯文本处理
  }

  return trimmed.slice(0, 500);
}

/**
 * 把任意异常归一化成可直接展示给用户的中文文案。
 *
 * @param error 捕获到的异常。
 * @returns 面向用户的错误文案。
 */
export function normalizeError(error: unknown): string {
  if (isAbortError(error)) {
    return '已中止';
  }

  if (error instanceof ChatApiError) {
    const prefix = error.status ? `模型接口返回 ${error.status}：` : '模型接口调用失败：';
    return `${prefix}${error.message}`;
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    if (!message) {
      return '未知错误（错误对象没有 message）';
    }
    // 网络层常见错误的友好化
    if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return `无法解析接口域名，请检查 Base URL 与网络连接：${message}`;
    }
    if (/ECONNREFUSED/i.test(message)) {
      return `连接被拒绝，请检查 Base URL 是否正确、服务是否可达：${message}`;
    }
    if (/certificate|self-signed/i.test(message)) {
      return `TLS 证书校验失败：${message}`;
    }
    if (/fetch failed/i.test(message)) {
      return `网络请求失败，请检查网络或代理设置：${message}`;
    }
    return message;
  }

  return String(error);
}
