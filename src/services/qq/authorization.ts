import type { QqContactPolicy } from '../../types/index';
import type { QqChatKind, QqMemberRole } from './events';

/**
 * 授权判定与权限分层 —— **安全边界**。
 *
 * 判定顺序是刻意设计的，改动前先想清楚理由：
 *
 * ```
 * 总开关 → 私聊开关 → deny → allow / 放行全部 → 是否指向机器人 → 角色分层
 * ```
 *
 * 1. **总开关最先**：关掉就该彻底安静，连管理员消息也不回。
 * 2. **`deny` 先于放行判定**：拉黑必须压过白名单与「放行全部」，否则拉黑形同虚设。
 * 3. **授权先于「是否 @ 机器人」**：未授权来源即使 @ 了也不能放行；
 *    反过来若先判 @，日志里会看到一堆「没 @ 所以忽略」，掩盖真正的越权尝试。
 * 4. **`allowAllWhenEmpty` 只在白名单真的为空时生效**。一旦用户显式授权过任何来源，
 *    这个开关就失效 —— 否则「我明明只允许了 A 群，怎么 B 群也能说话」。
 *
 * ## 三条默认值都偏向保守
 *
 * - `allowAllWhenEmpty` 由配置决定，配置层的默认是 `false`。
 * - `requireAddressInGroup` 默认 **true**：群里必须 @ 机器人才回应。全量模式让我们
 *   *看得到*所有消息，但不等于要*回应*所有消息（单群频控只有 20 条/分钟）。
 * - `trustGroupAdmins` 默认 **false**：只认 `owner_open_ids` 里显式写的人。
 *   群主/管理员身份来自事件字段，虽然可信但会随群成员变动而变动，
 *   让「谁能远程操控机器人」跟着群管理权走太宽松，所以默认关掉。
 */

/** 忽略的原因。 */
export type AuthorizationIgnoreReason =
  /** 总开关未启用。 */
  | 'disabled'
  /** 私聊应答被关闭。 */
  | 'private-disabled'
  /** 来源在拒绝列表里。 */
  | 'denied'
  /** 来源未授权（fail-closed）。 */
  | 'not-authorized'
  /** 群消息未指向机器人。 */
  | 'not-addressed';

/** 判定结果。 */
export type AuthorizationOutcome =
  | {
      action: 'respond';
      /** 权限分层：管理员可用管理命令，普通来源只能聊天。 */
      role: 'owner' | 'member';
      reason: string;
    }
  | { action: 'ignore'; reason: AuthorizationIgnoreReason; detail: string };

/** 判定所需的配置切片。 */
export interface AuthorizationConfig {
  /** QQ bot 总开关。 */
  enabled: boolean;
  /** 白名单为空时是否放行全部来源。 */
  allowAllWhenEmpty: boolean;
  /** 是否应答私聊。 */
  replyInPrivate: boolean;
  /** 管理员 openid 列表。 */
  ownerOpenIds: readonly string[];
}

/** 判定所需的消息切片。 */
export interface AuthorizationMessage {
  /** 群聊 / 私聊。 */
  kind: QqChatKind;
  /** 授权主体：群的 `group_openid` 或私聊的 `user_openid`。 */
  openId: string;
  /** 发送者标识。 */
  senderId: string;
  /** 群内角色；私聊为 `null`。 */
  senderRole: QqMemberRole | null;
  /** 消息是否指向机器人。 */
  addressedToBot: boolean;
}

/** 判定入参。 */
export interface AuthorizeInput {
  config: AuthorizationConfig;
  message: AuthorizationMessage;
  /** 该来源在 `qq_contacts` 里的授权状态；没有记录时传 `'none'`。 */
  contactPolicy: QqContactPolicy;
  /** 当前有多少来源是 `allow`。用于判断「白名单是否为空」。 */
  allowedCount: number;
  /** 群聊是否只在被指向时回应；缺省 `true`。 */
  requireAddressInGroup?: boolean;
  /** 是否信任事件里的群主/管理员身份；缺省 `false`（只认 `ownerOpenIds`）。 */
  trustGroupAdmins?: boolean;
}

/**
 * 清洗 openid 列表：去空白、剔空项。
 *
 * @param values 原始列表。
 * @returns 清洗后的列表。
 */
function normalizeOwners(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * 判定权限分层。
 *
 * @param input 判定入参。
 * @param owners 已清洗的管理员列表。
 * @returns `owner` 或 `member`。
 */
function resolveRole(input: AuthorizeInput, owners: readonly string[]): 'owner' | 'member' {
  const { senderId, openId, kind, senderRole } = input.message;

  if (owners.includes(senderId)) {
    return 'owner';
  }
  // 私聊场景下「来源」就是这个人，两边都认，避免调用方纠结该传哪个
  if (kind === 'private' && owners.includes(openId)) {
    return 'owner';
  }
  if (
    input.trustGroupAdmins === true &&
    kind === 'group' &&
    (senderRole === 'owner' || senderRole === 'admin')
  ) {
    return 'owner';
  }
  return 'member';
}

/**
 * 判定一条入站消息是否应该被回应。
 *
 * @param input 判定入参。
 * @returns 判定结果；`action` 为 `'ignore'` 时 `detail` 说明原因（可直接进日志）。
 */
export function authorizeInbound(input: AuthorizeInput): AuthorizationOutcome {
  const { config, message, contactPolicy } = input;

  if (!config.enabled) {
    return { action: 'ignore', reason: 'disabled', detail: 'QQ bot 总开关未启用' };
  }

  if (message.kind === 'private' && !config.replyInPrivate) {
    return { action: 'ignore', reason: 'private-disabled', detail: '私聊应答已关闭' };
  }

  // deny 优先于任何放行路径
  if (contactPolicy === 'deny') {
    return {
      action: 'ignore',
      reason: 'denied',
      detail: `来源 ${message.openId} 在拒绝列表里（deny 优先于白名单）`,
    };
  }

  if (contactPolicy !== 'allow') {
    const allowedCount = Number.isFinite(input.allowedCount)
      ? Math.max(0, Math.floor(input.allowedCount))
      : 0;
    const allowListEmpty = allowedCount === 0;

    if (!(allowListEmpty && config.allowAllWhenEmpty)) {
      return {
        action: 'ignore',
        reason: 'not-authorized',
        detail: allowListEmpty
          ? `来源 ${message.openId} 未授权，且未开启「白名单为空时放行全部」（fail-closed）`
          : `来源 ${message.openId} 未授权；白名单非空（${allowedCount} 个），因此不放行未授权来源`,
      };
    }
  }

  const requireAddress = input.requireAddressInGroup !== false;
  if (message.kind === 'group' && requireAddress && !message.addressedToBot) {
    return {
      action: 'ignore',
      reason: 'not-addressed',
      detail: '群消息未指向机器人（未 @ 也未在 mentions 里），按策略不主动参与',
    };
  }

  const role = resolveRole(input, normalizeOwners(config.ownerOpenIds));
  return {
    action: 'respond',
    role,
    reason: role === 'owner' ? '管理员消息' : '已授权来源的普通消息',
  };
}
