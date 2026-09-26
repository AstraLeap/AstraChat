/**
 * 发送消息的**纯逻辑**：请求路径、请求体、响应解析、错误分类。
 *
 * 依据见 `docs/qq-protocol-notes.md` §6。三条硬约束在这里落地：
 *
 * 1. **`content` 与 `markdown` 不能同时传**（官方明文）。我们只发纯文本
 *    （`msg_type = 0` + `content`），所以构建请求体时**绝不**带 `markdown` 字段。
 * 2. **相同 `msg_id` + `msg_seq` 重复发送会失败**（错误码 `40054005 消息被去重`）。
 *    多段回复必须用递增的 `msg_seq`，因此这里把它做成显式参数而不是让它走默认值。
 * 3. **被动回复有次数上限**：群聊 5 次、单聊 4 次。超出的段落应该在**切分后就丢掉**，
 *    而不是发出去被服务端拒绝 —— 后者会浪费一次调用并产生无意义的错误日志。
 */

/** 会话类型。 */
export type SendKind = 'group' | 'private';

/**
 * 被动回复的次数上限。
 *
 * 官方原文：「被动消息有效时间 5 分钟，每个消息最多回复 5 次」（群聊）；
 * 单聊是「60 分钟，最多回复 4 次」。
 */
export const MAX_PASSIVE_REPLIES: Record<SendKind, number> = {
  group: 5,
  private: 4,
};

/** 发送失败的种类。 */
export type SendErrorKind =
  /** 被动回复窗口过期 / 次数超限（消息 id 已失效）。 */
  | 'expired-passive'
  /** `msg_seq` 冲突导致被去重。 */
  | 'duplicate-seq'
  /** 触发频控。 */
  | 'rate-limited'
  /** 机器人不在群里 / 被禁言 / 已下线。 */
  | 'unavailable'
  /** 内容被拒（含违规、不允许发 URL、超长）。 */
  | 'content-rejected'
  /** 其它确定性失败。 */
  | 'permanent'
  /** 服务端临时异常，值得重试。 */
  | 'transient';

/** 发送失败。 */
export interface SendFailure {
  ok: false;
  /** 业务错误码；拿不到时为 `null`。 */
  code: number | null;
  /** 服务端给的错误信息（仅用于人工排查）。 */
  message: string;
  kind: SendErrorKind;
  /** 同一条内容再发一次是否可能成功。 */
  retryable: boolean;
  /** 可直接展示给用户/日志的原因。 */
  reason: string;
}

/** 发送成功。 */
export interface SendSuccess {
  ok: true;
  /** 消息 id，可用于撤回。 */
  messageId: string;
  /** 发送时间（RFC3339 东八区）。 */
  timestamp: string | null;
  /** 引用索引（发富媒体/引用回复时才有）。 */
  refIdx: string | null;
}

/** 发送结果。 */
export type SendResult = SendSuccess | SendFailure;

/** 一条待发送的纯文本消息。 */
export interface OutboundMessage {
  /** 文本内容。 */
  content: string;
  /**
   * 被动回复的消息 id（事件里的 `d.id`）。
   *
   * 不传即主动消息 —— 注意主动消息受更严格频控，且用户可在客户端关闭「允许主动发送」。
   */
  msgId?: string;
  /**
   * 回复序号，**从 1 开始**。
   *
   * 与 `msgId` 联合使用：相同的 `msgId + msgSeq` 重复发送会失败。
   * 因此把一条回复切成 N 段时，第 i 段必须用 `i + 1`。
   */
  msgSeq?: number;
}

/**
 * 拼出发送接口的路径。
 *
 * @param kind 群聊 / 私聊。
 * @param openId 群的 `group_openid` 或用户的 `user_openid`。
 * @returns 形如 `/v2/groups/{openid}/messages` 的路径。
 */
export function sendPath(kind: SendKind, openId: string): string {
  const segment = kind === 'group' ? 'groups' : 'users';
  return `/v2/${segment}/${encodeURIComponent(openId)}/messages`;
}

/**
 * 构造发送请求体。
 *
 * 只产出**纯文本**消息：`msg_type = 0` 且只带 `content`，绝不带 `markdown`
 * （官方要求两者不能同时出现）。
 *
 * @param message 待发送内容。
 * @returns 可直接 JSON 序列化的请求体。
 */
export function buildSendBody(message: OutboundMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    msg_type: 0,
    content: message.content,
  };

  const msgId = typeof message.msgId === 'string' ? message.msgId.trim() : '';
  if (msgId.length > 0) {
    body['msg_id'] = msgId;
    // 只有被动回复才带 msg_seq；主动消息没有 msg_id，seq 无意义
    body['msg_seq'] = normalizeSeq(message.msgSeq);
  }

  return body;
}

/**
 * 规范化回复序号：必须是 ≥1 的整数，否则回退到 1（官方默认值）。
 *
 * @param seq 原始值。
 * @returns 合法的序号。
 */
function normalizeSeq(seq: unknown): number {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return 1;
  }
  const floored = Math.floor(seq);
  return floored >= 1 ? floored : 1;
}

/**
 * 按错误码判断失败种类与是否值得重试。
 *
 * 判断偏保守：**未知码一律视为不可重试**。因为重试一条内容违规或参数错误的消息
 * 只会重复失败并消耗频控配额，而真正的临时故障在官方码表里是有明确编号的。
 *
 * @param code 业务错误码。
 * @returns 种类、是否可重试与可读原因。
 */
export function classifySendError(code: number | null): {
  kind: SendErrorKind;
  retryable: boolean;
  reason: string;
} {
  switch (code) {
    case 304103:
    case 40034005:
      return {
        kind: 'expired-passive',
        retryable: false,
        reason: '被动回复窗口已过（消息 id 失效），本条不再发送',
      };
    case 40034128:
      return {
        kind: 'expired-passive',
        retryable: false,
        reason: '被动回复时间或次数超限，本条不再发送',
      };
    case 40034024:
      return {
        kind: 'expired-passive',
        retryable: false,
        reason: '被动回复的 msg_id 无效或越权，本条不再发送',
      };
    case 40054005:
      return {
        kind: 'duplicate-seq',
        retryable: true,
        reason: 'msg_seq 与已发送的消息重复（被去重），需递增 msg_seq 后重发',
      };
    case 40034100:
      return {
        kind: 'rate-limited',
        retryable: true,
        reason: '触发主动消息频控，稍后重试',
      };
    case 40054002:
      return { kind: 'unavailable', retryable: false, reason: '机器人被禁言，等待解禁' };
    case 40034101:
    case 40054003:
      return { kind: 'unavailable', retryable: false, reason: '机器人不是群成员，无法发送' };
    case 40054016:
      return { kind: 'unavailable', retryable: false, reason: '机器人已下线' };
    case 40054007:
      return {
        kind: 'content-rejected',
        retryable: false,
        reason: '消息长度超限，需缩短后再发',
      };
    case 40054010:
      return {
        kind: 'content-rejected',
        retryable: false,
        reason: '该场景不允许发送 URL，需去掉链接后再发',
      };
    case 40034006:
      return { kind: 'content-rejected', retryable: false, reason: '消息内容违规' };
    case 22006:
    case 304061:
    case 305007:
    case 340069:
      return { kind: 'permanent', retryable: false, reason: '请求参数与消息类型不匹配' };
    case 50055001:
    case 50055006:
      return { kind: 'transient', retryable: true, reason: '服务端临时异常，稍后重试' };
    default:
      return {
        kind: 'permanent',
        retryable: false,
        reason: code === null ? '发送失败（无错误码）' : `发送失败（错误码 ${code}）`,
      };
  }
}

/**
 * 解析发送接口的响应体。
 *
 * **必须用 `code` 判定成败**：官方接口在业务失败时 HTTP 状态码仍是 200
 * （凭证接口页明确说明，发送接口的错误码表也印证了这一点）。
 *
 * @param body 响应体（已 JSON 解析）。
 * @returns 成功给出消息 id；失败给出分类与原因。
 */
export function parseSendResponse(body: unknown): SendResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      code: null,
      message: '',
      kind: 'permanent',
      retryable: false,
      reason: '发送接口返回的不是 JSON 对象',
    };
  }

  const record = body as Record<string, unknown>;

  const rawCode = record['code'];
  if (rawCode !== undefined && rawCode !== null) {
    const code = typeof rawCode === 'number' ? rawCode : Number(rawCode);
    const message = typeof record['message'] === 'string' ? record['message'] : '';
    const classified = classifySendError(Number.isFinite(code) ? code : null);
    return {
      ok: false,
      code: Number.isFinite(code) ? code : null,
      message,
      ...classified,
    };
  }

  const rawId = record['id'];
  const messageId = typeof rawId === 'string' ? rawId.trim() : '';
  if (messageId.length === 0) {
    return {
      ok: false,
      code: null,
      message: '发送响应里没有 id',
      kind: 'permanent',
      retryable: false,
      reason: '发送响应缺少消息 id，无法确认是否送达',
    };
  }

  const rawTimestamp = record['timestamp'];
  const extInfo = record['ext_info'];
  const rawRefIdx =
    typeof extInfo === 'object' && extInfo !== null && !Array.isArray(extInfo)
      ? (extInfo as Record<string, unknown>)['ref_idx']
      : undefined;

  return {
    ok: true,
    messageId,
    timestamp: typeof rawTimestamp === 'string' ? rawTimestamp : null,
    refIdx: typeof rawRefIdx === 'string' ? rawRefIdx : null,
  };
}

/**
 * 按会话类型的被动回复上限截断段落。
 *
 * 超出上限的段落直接丢掉（而不是发出去被服务端拒绝）。返回值同时给出被丢弃的数量，
 * 便于调用方如实告知用户「回复太长，后面 N 段没有发出」。
 *
 * @param parts 已切分的段落。
 * @param kind 群聊 / 私聊。
 * @param passive 是否被动回复（主动消息不受该上限约束）。
 * @returns 要发送的段落与被丢弃的数量。
 */
export function limitPassiveParts(
  parts: readonly string[],
  kind: SendKind,
  passive: boolean,
): { parts: string[]; dropped: number } {
  if (!passive) {
    return { parts: [...parts], dropped: 0 };
  }
  const limit = MAX_PASSIVE_REPLIES[kind];
  if (parts.length <= limit) {
    return { parts: [...parts], dropped: 0 };
  }
  return { parts: parts.slice(0, limit), dropped: parts.length - limit };
}
