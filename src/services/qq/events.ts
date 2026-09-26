/**
 * 入站事件 → 领域模型。
 *
 * 官方事件字段见 `docs/qq-protocol-notes.md` §8。这一层的作用是把**线协议的形状**
 * 收敛成主进程能直接用的领域对象，顺便把不稳定之处消化掉：
 *
 * 1. **授权主体的取法最容易错**：群用 `d.group_openid`；私聊用 `author.user_openid`；
 *    群成员标识用 `author.member_openid`。取错了白名单就形同虚设，所以这里集中处理并
 *    在测试里逐个钉死。
 * 2. **容错优先于严格**：`C2C_MESSAGE_CREATE` 的字段官方没有单独取证（见
 *    `docs/qq-protocol-notes.md` §9 第 5 条），因此缺字段时退回 `author.id`、
 *    拿不到授权主体才返回 `null`，绝不因为一个字段缺失就抛异常。
 * 3. **不可授权的事件直接丢弃**：没有消息 id（无法被动回复）或没有来源标识
 *    （无法判定白名单）的事件返回 `null`，让上层只需处理「可回应的事件」。
 */

/** 我们处理的事件类型。 */
export const INBOUND_EVENT_TYPES = [
  /** 全量群消息（需机器人开启「接收所有消息」）。**开启全量后 @ 消息也走这个类型。** */
  'GROUP_MESSAGE_CREATE',
  /**
   * 群里 @ 机器人。
   *
   * ⚠️ **只在「全量模式关闭」时才会出现**。开启全量后 @ 消息同样走
   * `GROUP_MESSAGE_CREATE`（2026-09-26 实测，见 `docs/qq-protocol-notes.md` §5.1），
   * 此时「有没有 @ 机器人」只能靠 `mentions` 判断 —— 见 {@link QqInbound.addressedToBot}。
   */
  'GROUP_AT_MESSAGE_CREATE',
  /** 单聊。 */
  'C2C_MESSAGE_CREATE',
] as const;

/** 入站事件类型。 */
export type QqEventType = (typeof INBOUND_EVENT_TYPES)[number];

/** 会话类型。 */
export type QqChatKind = 'group' | 'private';

/** 群内角色。 */
export type QqMemberRole = 'member' | 'admin' | 'owner';

/** 引用上下文。 */
export interface QqQuote {
  /** 被引用人的昵称；拿不到为 `null`。 */
  senderName: string | null;
  /** 被引用原文。 */
  text: string;
}

/** 附件摘要（只保留我们用得上的字段）。 */
export interface QqAttachment {
  /** `content_type`，如 `image/jpeg` / `voice` / `video/mp4` / `file`。 */
  contentType: string;
  /** 下载地址。 */
  url: string;
  /** 语音消息的 ASR 参考文本（官方直接给，省一套 STT）。 */
  asrText: string | null;
}

/** 一条可回应的入站消息。 */
export interface QqInbound {
  eventType: QqEventType;
  /** 群聊 / 私聊。 */
  kind: QqChatKind;
  /** **授权主体**：群的 `group_openid` 或私聊的 `user_openid`。对应 `qq_contacts.open_id`。 */
  openId: string;
  /** 发送者标识（群成员 openid / 用户 openid）。 */
  senderId: string;
  senderName: string | null;
  /** 群内角色；私聊恒为 `null`。 */
  senderRole: QqMemberRole | null;
  /** 消息 id。被动回复的 `msg_id` 用它，**5 分钟内有效**。 */
  messageId: string;
  /** 事件外层 id，可作为发送接口的 `event_id`。 */
  eventId: string | null;
  /** 正文（官方已去掉 @ 机器人的前缀）。纯图片消息可能为空串。 */
  content: string;
  /** 是否指向机器人：@ 事件与私聊恒为真；全量群消息看 `mentions` 是否含机器人。 */
  addressedToBot: boolean;
  /** 引用上下文；没有引用时为 `null`。 */
  quote: QqQuote | null;
  /** 附件列表。 */
  attachments: QqAttachment[];
  /** 卡片消息降级成的可读文本；没有卡片时为 `null`。 */
  cardText: string | null;
  /** 事件时间（RFC3339，原样保留）。 */
  timestamp: string | null;
}

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
 * 取非空字符串。
 *
 * @param value 原始值。
 * @returns 去空白后非空则返回该字符串，否则 `null`。
 */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 取第一个非空字符串。
 *
 * @param values 候选值，按优先级排列。
 * @returns 第一个非空值，都没有则 `null`。
 */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/**
 * 取数组字段；不是数组时给空数组。
 *
 * @param value 原始值。
 * @returns 对象数组。
 */
function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPlainObject);
}

/**
 * 把群内角色归一成受支持的取值。
 *
 * @param value 原始值。
 * @returns 合法角色，否则 `null`。
 */
function asMemberRole(value: unknown): QqMemberRole | null {
  return value === 'member' || value === 'admin' || value === 'owner' ? value : null;
}

/**
 * 解析附件列表。
 *
 * 没有 `url` 的附件直接跳过 —— 拿不到字节就没法用，留着只会让上层多写判断。
 *
 * @param raw `d.attachments`。
 * @returns 附件摘要数组。
 */
function parseAttachments(raw: unknown): QqAttachment[] {
  const attachments: QqAttachment[] = [];
  for (const item of asObjectArray(raw)) {
    const url = asNonEmptyString(item['url']);
    if (url === null) {
      continue;
    }
    attachments.push({
      contentType: asNonEmptyString(item['content_type']) ?? '',
      url,
      asrText: asNonEmptyString(item['asr_refer_text']),
    });
  }
  return attachments;
}

/**
 * 从 `ark_data` 里拼出可读的卡片文本。
 *
 * 卡片（小程序 / 音乐 / 位置等）本身没有正文，模型只看到一片空白会误判「对方没说话」，
 * 所以降级成一句话。`ark_type` 是机器枚举，对模型没意义，不取。
 *
 * @param raw `d.ark_data`。
 * @returns 可读文本；没有可读内容时 `null`。
 */
function parseCardText(raw: unknown): string | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const fields = isPlainObject(raw['fields']) ? raw['fields'] : {};
  const parts = [
    asNonEmptyString(raw['ark_name']),
    asNonEmptyString(fields['title']),
    asNonEmptyString(fields['desc']),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * 从 `msg_elements` 里取引用上下文。
 *
 * `message_type = 103` 表示引用消息，元素里带被引用人与原文
 * （见 `docs/qq-protocol-notes.md` §8）。
 *
 * @param raw `d.msg_elements`。
 * @returns 引用上下文；没有引用时 `null`。
 */
function parseQuote(raw: unknown): QqQuote | null {
  for (const element of asObjectArray(raw)) {
    if (element['message_type'] !== 103) {
      continue;
    }
    const author = isPlainObject(element['author']) ? element['author'] : {};
    return {
      senderName: asNonEmptyString(author['username']),
      text: typeof element['content'] === 'string' ? element['content'] : '',
    };
  }
  return null;
}

/**
 * 剥掉正文里的 `<@openid>` @ 占位符。
 *
 * **全量模式下官方不剥离它**（2026-09-26 实测）：@ 了机器人的正文形如
 * `<@112B3DDE…> 111`。直接投给模型，模型看到的是一串 openid 而不是「111」。
 *
 * 只删占位符本身与紧跟其后的一个空白，**不做全局空白折叠** ——
 * 否则会把用户正文里的换行与多个空格压平，那是另一类破坏。
 *
 * @param text 原始正文。
 * @returns 清理后的正文。
 */
function stripMentionPlaceholders(text: string): string {
  return text.replace(/<@[^>\s]*>\s?/g, '').trim();
}

/**
 * 判断 `mentions` 里有没有「@ 了自己」。
 *
 * ## 为什么不能只比对 id（这是一个已经踩过的坑）
 *
 * READY 给的机器人 id 是数字（实测 `1227781930829794431`），
 * 而 `mentions[].id` 是 **openid**（实测 `112B3DDE009A9992D13BF0AF7BE443A3`）——
 * **两套不同的 id 空间，永远不相等**。只比对 id 会让全量模式下的 `addressedToBot`
 * 恒为 `false`，表现为「机器人永远不回应任何 @」，而且**不产生任何错误信号**。
 *
 * 官方给了明确标记 `is_you`，与 id 空间无关，所以以它为主判据。
 *
 * 注意**不能把 `bot: true` 当成「@ 了我」** —— 群里可能同时有别的机器人，
 * 那个字段只说明被提及的是个机器人，不说明是自己。
 *
 * @param raw `d.mentions`。
 * @param botId 调用方提供的机器人 id（READY 的数字 id 或 openid 均可），作为兜底。
 * @returns 被 @ 了返回 `true`。
 */
function mentionsSelf(raw: unknown, botId: string | null): boolean {
  for (const mention of asObjectArray(raw)) {
    if (mention['is_you'] === true) {
      return true;
    }
    if (botId !== null) {
      if (asNonEmptyString(mention['id']) === botId) {
        return true;
      }
      if (asNonEmptyString(mention['member_openid']) === botId) {
        return true;
      }
    }
  }
  return false;
}

/** `parseInboundEvent` 的选项。 */
export interface ParseInboundOptions {
  /**
   * 机器人自己的用户 id（来自 READY 的 `d.user.id`）。
   *
   * 全量群消息要靠它判断「这条消息有没有 @ 机器人」。不给就一律判为未 @
   * —— 宁可不回应，也不要因为猜错而对着无关的话插嘴。
   */
  botId?: string;
}

/**
 * 解析一条网关事件。
 *
 * @param payload 网关信封（`{ id, op, t, d }`）。
 * @param options 选项。
 * @returns 可回应的入站消息；不认识或不可回应时返回 `null`。
 */
export function parseInboundEvent(payload: unknown, options: ParseInboundOptions = {}): QqInbound | null {
  if (!isPlainObject(payload)) {
    return null;
  }

  const eventType = payload['t'];
  if (typeof eventType !== 'string' || !(INBOUND_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return null;
  }

  const d = payload['d'];
  if (!isPlainObject(d)) {
    return null;
  }

  const messageId = asNonEmptyString(d['id']);
  if (messageId === null) {
    return null;
  }

  const kind: QqChatKind = eventType === 'C2C_MESSAGE_CREATE' ? 'private' : 'group';
  const author = isPlainObject(d['author']) ? d['author'] : {};

  // 授权主体：群用 group_openid，私聊用 author.user_openid
  const openId =
    kind === 'group'
      ? asNonEmptyString(d['group_openid'])
      : firstNonEmpty(asNonEmptyString(author['user_openid']), asNonEmptyString(author['id']));

  if (openId === null) {
    return null;
  }

  const senderId =
    firstNonEmpty(
      asNonEmptyString(author['member_openid']),
      asNonEmptyString(author['user_openid']),
      asNonEmptyString(author['id']),
    ) ?? '';

  // 正文：chat-record（102）的 content 是空白，真正的文本在 msg_elements 里
  const rawContent = typeof d['content'] === 'string' ? d['content'] : '';
  const elements = asObjectArray(d['msg_elements']);
  let content = rawContent;
  if (d['message_type'] === 102 && rawContent.trim().length === 0 && elements.length > 0) {
    content = elements
      .map((element) => (typeof element['content'] === 'string' ? element['content'] : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  // 全量模式下官方不剥离 @ 占位符，正文里会残留 `<@openid>`
  content = stripMentionPlaceholders(content);

  // 是否指向机器人
  const botId = asNonEmptyString(options.botId);
  let addressedToBot: boolean;
  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'C2C_MESSAGE_CREATE') {
    addressedToBot = true;
  } else {
    // 全量模式：@ 消息也走 GROUP_MESSAGE_CREATE，只能靠 mentions 判断
    addressedToBot = mentionsSelf(d['mentions'], botId);
  }

  return {
    eventType: eventType as QqEventType,
    kind,
    openId,
    senderId,
    senderName: asNonEmptyString(author['username']),
    senderRole: kind === 'group' ? asMemberRole(author['member_role']) : null,
    messageId,
    eventId: asNonEmptyString(payload['id']),
    content,
    addressedToBot,
    quote: parseQuote(d['msg_elements']),
    attachments: parseAttachments(d['attachments']),
    cardText: parseCardText(d['ark_data']),
    timestamp: asNonEmptyString(d['timestamp']),
  };
}
