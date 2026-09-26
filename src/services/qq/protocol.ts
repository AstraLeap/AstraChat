/**
 * 官方 QQ 开放平台 Bot API 的**线协议**（纯函数）。
 *
 * 所有字段名、op 码、关闭码都来自 `docs/qq-protocol-notes.md` 的取证结果，并与
 * `tests/qq-protocol.spec.ts` 一一对应。这个模块刻意不含任何 I/O：HTTP 与 WebSocket
 * 的收发放在 `electron/qq/`，这样协议细节可以被完整单测覆盖。
 *
 * ## 最容易写错的几处（都在测试里钉死了）
 *
 * - 凭证请求体字段是 **`clientSecret`**，不是 `appSecret`。
 * - 凭证接口**失败时 HTTP 仍是 200**，必须靠响应体 `code` 判定。
 * - `expires_in` 文档标 `number`，但官方示例给的是**字符串**，解析必须兼容。
 * - Resume 的字段是蛇形 **`session_id`**，Identify 的 properties 键带 **`$`** 前缀。
 * - 重连依据是 **close code**（4001~4015、4900~4913），不是只看 op 7/9；
 *   两者都处理，因为官方 op 表里 7/9 确实存在。
 */

/** 持有的访问凭证：裸 token 与**绝对**过期时刻。 */
export interface AccessToken {
  /** 裸 access_token（不含 `QQBot ` 前缀）。 */
  token: string;
  /** 绝对过期时间（Unix 毫秒），由 `expires_in` 换算而来。 */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// op 码
// ---------------------------------------------------------------------------

/** OpCode（来源：[通用数据结构](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)）。 */
export const OP = {
  /** 服务端推送（`t` 与 `d` 在此有意义）。 */
  DISPATCH: 0,
  /** 心跳，双向。 */
  HEARTBEAT: 1,
  /** 客户端鉴权。 */
  IDENTIFY: 2,
  /** 客户端恢复连接。 */
  RESUME: 6,
  /** 服务端通知客户端重新连接。 */
  RECONNECT: 7,
  /** 会话失效（identify / resume 参数有错）。 */
  INVALID_SESSION: 9,
  /** 建立连接后服务端下发的第一条消息。 */
  HELLO: 10,
  /** 心跳 ACK。 */
  HEARTBEAT_ACK: 11,
} as const;

/** 官方默认凭证有效期（秒）。`expires_in` 缺失或非法时回退到它。 */
export const DEFAULT_TOKEN_TTL_SECONDS = 7200;

/**
 * 提前刷新余量（毫秒）。
 *
 * 官方语义：**在接近过期时间 60 秒内获取会返回新 token，且老 token 在这 60 秒内仍有效**。
 * 因此在这个窗口一进入就刷新，既不会用到过期凭证，也不会出现空窗。
 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

// ---------------------------------------------------------------------------
// 访问凭证
// ---------------------------------------------------------------------------

/** 凭证解析结果。 */
export type AccessTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; code: number | null; message: string };

/**
 * 判断一个值是不是「非数组的对象」。
 *
 * @param value 待判定值。
 * @returns 是普通对象返回 `true`。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析 `POST /app/getAppAccessToken` 的响应体。
 *
 * **必须用 `code` 判定成败**：官方明确说明该接口失败时 HTTP 返回码仍是 200。
 *
 * @param body 响应体（已 JSON 解析）。
 * @param now 当前时间（Unix 毫秒），用于算绝对过期时刻。
 * @returns 成功时给出裸 token 与绝对过期时间；失败时给出错误码与信息。
 */
export function parseAccessTokenResponse(body: unknown, now: number): AccessTokenResult {
  if (!isPlainObject(body)) {
    return { ok: false, code: null, message: '凭证接口返回的不是 JSON 对象' };
  }

  // code 优先：即使同时带了 access_token，也认定这次调用失败
  const rawCode = body['code'];
  if (rawCode !== undefined && rawCode !== null) {
    const code = typeof rawCode === 'number' ? rawCode : Number(rawCode);
    const message = typeof body['message'] === 'string' ? body['message'] : '';
    return {
      ok: false,
      code: Number.isFinite(code) ? code : null,
      message: message || `凭证接口返回业务错误码 ${String(rawCode)}`,
    };
  }

  const rawToken = body['access_token'];
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    return { ok: false, code: null, message: '凭证响应里没有有效的 access_token' };
  }

  // expires_in 可能是数字也可能是字符串（官方示例就是字符串 "7200"）
  const rawTtl = body['expires_in'];
  const ttl = typeof rawTtl === 'number' ? rawTtl : Number(rawTtl);
  const seconds =
    Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TOKEN_TTL_SECONDS;

  return { ok: true, token, expiresAt: now + seconds * 1000 };
}

/**
 * 判断是否该去获取／刷新凭证。
 *
 * @param token 当前持有的凭证；`null` 表示还没有。
 * @param now 当前时间（Unix 毫秒）。
 * @returns 需要获取或刷新返回 `true`。
 */
export function needsTokenRefresh(token: AccessToken | null, now: number): boolean {
  if (token === null) {
    return true;
  }
  return now >= token.expiresAt - TOKEN_REFRESH_MARGIN_MS;
}

/**
 * 组装 `QQBot <token>` 授权值。
 *
 * 注意：**REST 请求头与网关 Identify/Resume 用的是同一种带前缀格式**，
 * 所以只暴露一个函数，避免两处各写一遍拼错。
 *
 * @param accessToken 裸 access_token。
 * @returns 形如 `QQBot AT` 的字符串。
 */
export function qqBotToken(accessToken: string): string {
  return `QQBot ${accessToken}`;
}

// ---------------------------------------------------------------------------
// Gateway 接入点
// ---------------------------------------------------------------------------

/** `GET /gateway/bot` 里的连接额度信息。 */
export interface SessionStartLimit {
  total: number;
  remaining: number;
  resetAfter: number;
  maxConcurrency: number;
}

/** Gateway 接入点信息。 */
export interface GatewayInfo {
  url: string;
  shards: number;
  sessionStartLimit: SessionStartLimit | null;
}

/**
 * 把任意值转成有限数字。
 *
 * @param value 原始值。
 * @param fallback 非法时回退。
 * @returns 有限数字。
 */
function toFiniteNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * 解析 `GET /gateway/bot` 的响应体。
 *
 * @param body 响应体（已 JSON 解析）。
 * @returns 缺少可用 `url` 时返回 `null`。
 */
export function parseGatewayResponse(body: unknown): GatewayInfo | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const rawUrl = body['url'];
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) {
    return null;
  }

  const shardsRaw = Math.floor(toFiniteNumber(body['shards'], 1));
  const shards = shardsRaw >= 1 ? shardsRaw : 1;

  const rawLimit = body['session_start_limit'];
  const sessionStartLimit = isPlainObject(rawLimit)
    ? {
        total: toFiniteNumber(rawLimit['total'], 0),
        remaining: toFiniteNumber(rawLimit['remaining'], 0),
        resetAfter: toFiniteNumber(rawLimit['reset_after'], 0),
        maxConcurrency: toFiniteNumber(rawLimit['max_concurrency'], 0),
      }
    : null;

  return { url, shards, sessionStartLimit };
}

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

/** 网关上下行共用的信封结构。 */
export interface GatewayPayload {
  /** 事件 id（可作为发送接口的 `event_id`）。 */
  id: string | null;
  /** opcode。 */
  op: number;
  /** 事件内容。 */
  d: unknown;
  /** 下行序列号；心跳要带上最新值。 */
  s: number | null;
  /** 事件类型，仅在 `op = 0` 时有意义。 */
  t: string | null;
}

/**
 * 解析一行网关消息。
 *
 * 字段缺失一律归一成 `null`（而不是 `undefined`），方便调用方断言与序列化。
 *
 * @param raw 已 JSON 解析的消息。
 * @returns 无效信封返回 `null`。
 */
export function parseGatewayPayload(raw: unknown): GatewayPayload | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const rawOp = raw['op'];
  if (typeof rawOp !== 'number' || !Number.isFinite(rawOp)) {
    return null;
  }

  const rawId = raw['id'];
  const rawS = raw['s'];
  const rawT = raw['t'];

  return {
    id: typeof rawId === 'string' && rawId.length > 0 ? rawId : null,
    op: rawOp,
    d: raw['d'] ?? null,
    s: typeof rawS === 'number' && Number.isFinite(rawS) ? rawS : null,
    t: typeof rawT === 'string' && rawT.length > 0 ? rawT : null,
  };
}

/**
 * 从 Hello（op 10）里取心跳周期。
 *
 * @param payload 信封。
 * @returns 心跳周期（毫秒）；取不到返回 `null`。
 */
export function parseHelloInterval(payload: unknown): number | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  const d = payload['d'];
  if (!isPlainObject(d)) {
    return null;
  }
  const interval = toFiniteNumber(d['heartbeat_interval'], 0);
  return interval > 0 ? interval : null;
}

/** READY 里我们需要的部分。 */
export interface ReadyInfo {
  sessionId: string;
  /** 机器人自己的用户 id，用于判断消息里是否 @ 了机器人。 */
  userId: string;
  username: string;
}

/**
 * 从 READY（op 0 / t=READY）里取会话与机器人身份。
 *
 * @param payload 信封。
 * @returns 缺少 `session_id` 时返回 `null`。
 */
export function parseReady(payload: unknown): ReadyInfo | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  const d = payload['d'];
  if (!isPlainObject(d)) {
    return null;
  }
  const rawSession = d['session_id'];
  const sessionId = typeof rawSession === 'string' ? rawSession.trim() : '';
  if (!sessionId) {
    return null;
  }

  const user = isPlainObject(d['user']) ? d['user'] : {};
  const rawId = user['id'];
  const rawName = user['username'];

  return {
    sessionId,
    userId: typeof rawId === 'string' ? rawId : '',
    username: typeof rawName === 'string' ? rawName : '',
  };
}

// ---------------------------------------------------------------------------
// 上行 payload 构造
// ---------------------------------------------------------------------------

/** Identify 的入参。 */
export interface IdentifyInput {
  /** 裸 access_token（本函数负责加 `QQBot ` 前缀）。 */
  token: string;
  /** 事件订阅位掩码。 */
  intents: number;
  /** 分片 `[当前片, 总片数]`；省略为 `[0, 1]`（不分片）。 */
  shard?: [number, number];
}

/**
 * 构造 Identify（op 2）。
 *
 * `properties` 官方注明**无实际作用**，但字段名要带 `$` 前缀（照文档填）。
 *
 * @param input 入参。
 * @returns 可直接 `JSON.stringify` 后发送的对象。
 */
export function buildIdentifyPayload(input: IdentifyInput): { op: number; d: unknown } {
  const platform =
    typeof process !== 'undefined' && typeof process.platform === 'string'
      ? process.platform
      : 'unknown';
  return {
    op: OP.IDENTIFY,
    d: {
      token: qqBotToken(input.token),
      intents: input.intents,
      shard: input.shard ?? [0, 1],
      properties: { $os: platform, $browser: 'AstraChat', $device: 'AstraChat' },
    },
  };
}

/** Resume 的入参。 */
export interface ResumeInput {
  /** 裸 access_token。 */
  token: string;
  /** READY 里拿到的 session_id。 */
  sessionId: string;
  /** 已处理的最新 `s`；没有则传 0。 */
  seq: number;
}

/**
 * 构造 Resume（op 6）。
 *
 * 注意字段是蛇形 `session_id`。
 *
 * @param input 入参。
 * @returns 可直接发送的对象。
 */
export function buildResumePayload(input: ResumeInput): { op: number; d: unknown } {
  return {
    op: OP.RESUME,
    d: {
      token: qqBotToken(input.token),
      session_id: input.sessionId,
      seq: input.seq,
    },
  };
}

/**
 * 构造心跳（op 1）。
 *
 * `d` 是**客户端收到的最新消息的 `s`**，首次连接时为 `null`。
 *
 * @param seq 最新序列号；非有限数字时归一成 `null`。
 * @returns 可直接发送的对象。
 */
export function buildHeartbeatPayload(seq: number | null): { op: number; d: number | null } {
  const value = typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
  return { op: OP.HEARTBEAT, d: value };
}

// ---------------------------------------------------------------------------
// 重连策略
// ---------------------------------------------------------------------------

/** 重连指令。 */
export interface ReconnectDirective {
  /** 是否应该重连。`false` 表示这是**配置性或账号性问题**，重连只会白转。 */
  retryable: boolean;
  /** 重连时优先走 Resume（补发遗漏事件）；`false` 表示必须重新 Identify。 */
  preferResume: boolean;
  /** 给用户看的原因。 */
  reason: string;
}

/**
 * 按官方文档的关闭码表给出重连策略。
 *
 * 官方原文的处理逻辑：`4009` 可以重新 resume；`4914`、`4915` 不可以连接；
 * 其他错误请重新发起 identify。
 *
 * @param code WebSocket 关闭码。
 * @returns 重连指令。
 */
export function classifyCloseCode(code: number): ReconnectDirective {
  switch (code) {
    case 1000:
    case 1001:
      return {
        retryable: true,
        preferResume: true,
        reason: '连接正常关闭，重连并尝试 resume',
      };
    case 4001:
      return { retryable: false, preferResume: false, reason: '无效的 opcode（4001），请检查实现' };
    case 4002:
      return { retryable: false, preferResume: false, reason: '无效的 payload（4002），请检查实现' };
    case 4006:
      return {
        retryable: true,
        preferResume: false,
        reason: 'session id 无效（4006），需重新 identify',
      };
    case 4007:
      return { retryable: true, preferResume: false, reason: 'seq 错误（4007），需重新 identify' };
    case 4008:
      return {
        retryable: true,
        preferResume: true,
        reason: '发送 payload 过快（4008），退避后重连',
      };
    case 4009:
      return { retryable: true, preferResume: true, reason: '连接过期（4009），重连并 resume' };
    case 4010:
      return { retryable: false, preferResume: false, reason: '无效的 shard（4010），请检查分片配置' };
    case 4011:
      return { retryable: false, preferResume: false, reason: '单连接承载的 guild 过多（4011）' };
    case 4012:
      return { retryable: false, preferResume: false, reason: '无效的 version（4012）' };
    case 4013:
      return {
        retryable: false,
        preferResume: false,
        reason: '无效的 intent（4013）：订阅的 intents 无权限，请到开放平台申请对应事件权限',
      };
    case 4014:
      return {
        retryable: false,
        preferResume: false,
        reason: 'intent 无权限（4014）：请到开放平台申请对应事件权限后再连接',
      };
    case 4914:
      return {
        retryable: false,
        preferResume: false,
        reason: '机器人已下架（4914）：只允许连接沙箱环境',
      };
    case 4915:
      return { retryable: false, preferResume: false, reason: '机器人已封禁（4915）' };
    default:
      break;
  }

  if (code >= 4900 && code <= 4913) {
    return {
      retryable: true,
      preferResume: false,
      reason: `网关内部错误（${code}），需重新 identify`,
    };
  }

  return {
    retryable: true,
    preferResume: false,
    reason: `未知关闭码 ${code}，按文档「其他错误」重新 identify`,
  };
}

/**
 * 判断服务端下发的 op 码是不是重连信号。
 *
 * @param op opcode。
 * @returns `7`（Reconnect）与 `9`（Invalid Session）给出指令，其余返回 `null`。
 */
export function classifyOpcode(op: number): ReconnectDirective | null {
  if (op === OP.RECONNECT) {
    return { retryable: true, preferResume: true, reason: '服务端要求重连（op 7）' };
  }
  if (op === OP.INVALID_SESSION) {
    return {
      retryable: true,
      preferResume: false,
      reason: '会话失效（op 9），需重新 identify',
    };
  }
  return null;
}

/** 退避配置。 */
export interface BackoffConfig {
  /** 首次重试等待（毫秒）。 */
  baseMs: number;
  /** 等待上限（毫秒）。 */
  maxMs: number;
  /** 抖动比例，`0.25` 表示 ±25%；缺省 0（不抖动）。 */
  jitterRatio?: number;
}

/**
 * 计算第 N 次重连的等待时间（指数退避 + 抖动）。
 *
 * 抖动是为了避免多个实例同时重连把网关打垮。抖动后再夹一次上限，
 * 保证返回值永不超过 `maxMs`。
 *
 * @param attempt 已重试次数（从 0 开始）。
 * @param config 配置。
 * @param random 随机数发生器，注入以便测试；缺省 `Math.random`。
 * @returns 等待毫秒数。
 */
export function nextReconnectDelay(
  attempt: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  const baseMs = Math.max(1, toFiniteNumber(config.baseMs, 1000));
  const maxMs = Math.max(baseMs, toFiniteNumber(config.maxMs, 60_000));

  const raw = Math.min(maxMs, baseMs * 2 ** safeAttempt);

  const ratio = toFiniteNumber(config.jitterRatio, 0);
  if (ratio <= 0) {
    return Math.round(raw);
  }

  const clampedRatio = Math.min(1, ratio);
  const sample = Math.min(1, Math.max(0, toFiniteNumber(random(), 0.5)));
  const jittered = raw * (1 - clampedRatio + 2 * clampedRatio * sample);

  return Math.round(Math.min(maxMs, Math.max(0, jittered)));
}
