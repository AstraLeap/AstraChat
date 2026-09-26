import {
  needsTokenRefresh,
  parseAccessTokenResponse,
  parseGatewayResponse,
  qqBotToken,
  type AccessToken,
  type GatewayInfo,
} from '../../src/services/qq/protocol';
import {
  buildSendBody,
  parseSendResponse,
  sendPath,
  type OutboundMessage,
  type SendKind,
  type SendResult,
} from '../../src/services/qq/send';

/**
 * QQ 开放平台的 HTTP 客户端（主进程侧 I/O）。
 *
 * 只做三件事：取凭证（带缓存与提前刷新）、取网关接入点、发送消息。
 * **所有解析都在 `src/services/qq/` 的纯函数里**，这里只负责发请求与拼装，
 * 因此本模块很薄 —— 它需要真实网络才能测，而纯逻辑已经被完整单测覆盖。
 *
 * ## 两个官方特性必须照做
 *
 * 1. **业务失败时 HTTP 状态码仍是 200**，必须看响应体的 `code`。凭证与发送接口都如此。
 * 2. **凭证在有效期内重复获取会返回同一个值**，且**过期前 60 秒内获取会换新**。
 *    所以这里「按需取 + 缓存到 `expiresAt - 60s`」既不会用到过期凭证，也不会空窗。
 *
 * ## 为什么 `baseUrl` 可注入
 *
 * 测试用 `node:http` 起一个本地假服务端指向它，就能在**没有任何真实凭据**的情况下
 * 验证请求路径、请求体字段名与授权头格式。生产用默认的正式环境地址。
 *
 * ## 发送失败为什么返回结果而不是抛异常
 *
 * 编排层需要统一处理「这条到底发出去没有」，抛异常会强迫它在每个调用点写 try/catch。
 * 所以 `sendGroup` / `sendPrivate` 把**网络故障也折叠成 `retryable` 的失败结果**。
 * 取凭证与取网关地址则相反 —— 那是前置条件，失败就该抛，让网关的去重试逻辑接手。
 */

/** 正式环境 REST 地址。 */
export const DEFAULT_BASE_URL = 'https://api.bot.qq.com';

/** 最小响应结构（不依赖 DOM / undici 的类型声明）。 */
interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** 最小请求结构。 */
interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 最小 fetch 签名。 */
export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** 创建客户端所需的参数。 */
export interface QqHttpOptions {
  /** 开放平台的 AppID。 */
  appId: string;
  /** 开放平台的 ClientSecret（注意官方字段名不是 appSecret）。 */
  appSecret: string;
  /** REST base；缺省为正式环境。 */
  baseUrl?: string;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: FetchLike;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

/** HTTP 客户端。 */
export interface QqHttpClient {
  /**
   * 取（必要时刷新）access_token。
   *
   * @returns 裸 token（不含 `QQBot ` 前缀）。
   * @throws 取不到时抛出 `Error`；不可恢复的凭证错误带 `permanent: true`。
   */
  getAccessToken(): Promise<string>;
  /**
   * 取网关接入点信息。
   *
   * @returns 网关信息。
   * @throws 响应里没有可用 url 时抛出 `Error`。
   */
  getGatewayInfo(): Promise<GatewayInfo>;
  /**
   * 发送群消息。
   *
   * @param groupOpenId 群 `group_openid`。
   * @param message 待发送内容。
   * @returns 发送结果（失败也不抛）。
   */
  sendGroup(groupOpenId: string, message: OutboundMessage): Promise<SendResult>;
  /**
   * 发送单聊消息。
   *
   * @param userOpenId 用户 `user_openid`。
   * @param message 待发送内容。
   * @returns 发送结果（失败也不抛）。
   */
  sendPrivate(userOpenId: string, message: OutboundMessage): Promise<SendResult>;
  /** 清空缓存的凭证。配置变更或收到鉴权失败后调用。 */
  invalidateToken(): void;
  /** 当前凭证的绝对过期时刻；没有缓存时为 `null`（供界面展示）。 */
  getTokenExpiry(): number | null;
}

/** 凭证错误：把业务错误码与是否可恢复一并带出来。 */
export interface TokenError extends Error {
  /** 业务错误码；拿不到为 `null`。 */
  code: number | null;
  /** 是否属于「重试也没用」的配置性错误（AppID/密钥错、机器人不存在）。 */
  permanent: boolean;
}

/** 这些错误码重试没有意义，属于配置问题。 */
const PERMANENT_TOKEN_CODES = new Set([100007, 100016, 10004]);

/**
 * 构造一个带 `code` 与 `permanent` 的凭证错误。
 *
 * @param code 业务错误码。
 * @param message 错误信息。
 * @returns 凭证错误对象。
 */
function tokenError(code: number | null, message: string): TokenError {
  const error = new Error(message) as TokenError;
  error.code = code;
  error.permanent = code !== null && PERMANENT_TOKEN_CODES.has(code);
  return error;
}

/**
 * 创建 HTTP 客户端。
 *
 * @param options 参数。
 * @returns 客户端实例。
 */
export function createQqHttp(options: QqHttpOptions): QqHttpClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const now = options.now ?? (() => Date.now());
  const doFetch: FetchLike =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  /** 缓存的凭证。 */
  let cached: AccessToken | null = null;
  /** 进行中的取凭证请求，用于合并并发调用。 */
  let pending: Promise<string> | null = null;

  /**
   * 真正去取一次凭证。
   *
   * @returns 裸 token。
   * @throws 取不到时抛出 {@link TokenError}。
   */
  async function fetchToken(): Promise<string> {
    let response: HttpResponseLike;
    try {
      response = await doFetch(`${baseUrl}/app/getAppAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 官方字段名是 clientSecret
        body: JSON.stringify({ appId: options.appId, clientSecret: options.appSecret }),
      });
    } catch (error) {
      throw tokenError(null, `请求凭证接口失败：${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw tokenError(null, `凭证接口返回 HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw tokenError(null, '凭证接口响应不是合法 JSON');
    }

    const parsed = parseAccessTokenResponse(body, now());
    if (!parsed.ok) {
      throw tokenError(parsed.code, parsed.message || '凭证获取失败');
    }

    cached = { token: parsed.token, expiresAt: parsed.expiresAt };
    return parsed.token;
  }

  /**
   * 发一个带授权的请求。
   *
   * @param path 路径。
   * @param init 请求参数。
   * @returns 响应。
   */
  async function authorizedFetch(path: string, init: HttpRequestInit): Promise<HttpResponseLike> {
    const token = await getAccessToken();
    return doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: qqBotToken(token) },
    });
  }

  /**
   * 取凭证（带缓存与并发合并）。
   *
   * @returns 裸 token。
   */
  async function getAccessToken(): Promise<string> {
    if (cached !== null && !needsTokenRefresh(cached, now())) {
      return cached.token;
    }
    if (pending !== null) {
      return pending;
    }
    pending = fetchToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  /**
   * 发送一条消息（群或单聊）。
   *
   * @param kind 群聊 / 私聊。
   * @param openId 授权主体 openid。
   * @param message 待发送内容。
   * @returns 发送结果。
   */
  async function send(
    kind: SendKind,
    openId: string,
    message: OutboundMessage,
  ): Promise<SendResult> {
    let response: HttpResponseLike;
    try {
      response = await authorizedFetch(sendPath(kind, openId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSendBody(message)),
      });
    } catch (error) {
      // 网络故障折叠成可重试的失败结果，调用方无需 try/catch
      return {
        ok: false,
        code: null,
        message: error instanceof Error ? error.message : String(error),
        kind: 'transient',
        retryable: true,
        reason: '网络请求失败，可稍后重试',
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        code: null,
        message: `HTTP ${response.status}`,
        kind: 'transient',
        retryable: true,
        reason: `发送接口返回 HTTP ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        code: null,
        message: '',
        kind: 'transient',
        retryable: true,
        reason: '发送接口响应不是合法 JSON',
      };
    }

    return parseSendResponse(body);
  }

  return {
    getAccessToken,

    async getGatewayInfo(): Promise<GatewayInfo> {
      const response = await authorizedFetch('/gateway/bot', { method: 'GET' });

      if (!response.ok) {
        throw new Error(`获取网关接入点失败：HTTP ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('网关接入点响应不是合法 JSON');
      }

      const info = parseGatewayResponse(body);
      if (info === null) {
        throw new Error('网关接入点响应里没有可用 url');
      }
      return info;
    },

    sendGroup(groupOpenId: string, message: OutboundMessage): Promise<SendResult> {
      return send('group', groupOpenId, message);
    },

    sendPrivate(userOpenId: string, message: OutboundMessage): Promise<SendResult> {
      return send('private', userOpenId, message);
    },

    invalidateToken(): void {
      cached = null;
    },

    getTokenExpiry(): number | null {
      return cached === null ? null : cached.expiresAt;
    },
  };
}
