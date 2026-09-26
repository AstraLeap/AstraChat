/**
 * 「让模型自行决定是否回复」——判定逻辑（纯函数 + 有界状态）。
 *
 * ## 两种模式
 *
 * | 模式 | 做法 | 成本 | 准确性 |
 * |---|---|---|---|
 * | **标准** | 单次调用 + 哨兵：提示词约定不想说话时只输出 `[[SILENCE]]` | 低 | 够用 |
 * | **EXP 实验性** | 两次调用：先用一个短调用判定，再生成 | 约翻倍 | 更高 |
 *
 * EXP 更准的原因：**生成中的模型有「把话说下去」的惯性** —— 让它一边生成回复一边判断
 * 自己该不该说话，它天然偏向说话。把判定拆成一次独立调用，它是在「没有正在生成的内容」
 * 的状态下做判断的。
 *
 * ## 为什么判定必须 fail-closed（无法解析 → 沉默）
 *
 * 判定器坏掉时按沉默处理，而不是按说话处理。理由：
 *
 * - 判定器坏了**不应该导致插嘴** —— 插嘴的代价（惹人厌）比少说一句大得多
 * - **@ 消息不经过判定**，所以机器人不会因此完全变哑
 *
 * ## 最要紧的一条规则
 *
 * 判定「沉默」**只在整条输出除了哨兵什么都没有时才成立**。
 * 正文里出现哨兵字样（模型复述了提示词、或正巧提到这个词）绝不能把真实内容一起丢掉 ——
 * 那会造成「模型说了话，但用户什么都没收到」，是最难查的一类故障。
 */

/** 沉默哨兵：模型不想说话时只输出它。 */
export const SILENCE_SENTINEL = '[[SILENCE]]';

/**
 * 匹配哨兵的正则（大小写不敏感，同时容忍全角方括号）。
 *
 * 用一次正则覆盖两种括号形式，而不是先把全角转成半角 ——
 * 后者会顺带改掉正文里所有无关的全角方括号。
 */
const SENTINEL_PATTERN = /(?:\[\[|【【)\s*silence\s*(?:\]\]|】】)/gi;

/** 只有标点与空白（用来判断「除了哨兵什么都没说」）。 */
const ONLY_PUNCTUATION = /^[\s"'`“”‘’.。,，!！?？~～:：;；\-—_*（）()\[\]【】]*$/;

/** 标准模式：附在系统提示词末尾的发言说明。 */
export const SILENCE_INSTRUCTION = [
  '【关于是否发言】群里会有大量与你无关的消息。**大多数时候你应该保持沉默**，',
  '不要为了刷存在感而接话。只有当这句话确实需要你回应（在问你、在讨论你熟悉的事、',
  '或你确实有想说的）时才发言。',
  `不想发言时，**只输出 ${SILENCE_SENTINEL}**，不要输出任何其它文字。`,
].join('');

/** EXP 模式：判定调用的系统提示词。 */
export const VERDICT_SYSTEM_PROMPT = [
  '你在判断「要不要在群聊里接这句话」。',
  '**大多数时候答案是 SILENCE** —— 群聊里大部分消息与你无关，插嘴只会让人反感。',
  '只有确实需要你回应时才 SPEAK。',
  '',
  '只输出一个词，不要解释：',
  'SPEAK —— 应该回应',
  'SILENCE —— 不要回应',
].join('\n');

/** 判定结果。 */
export type ParticipationVerdict = { speak: true } | { speak: false; reason: string };

/** 主动发言的三条理由之一。 */
const REASON_CHOSEN_SILENCE = '模型主动选择不说话';
const REASON_UNPARSEABLE = '判定结果无法解析，按沉默处理（fail-closed）';

/**
 * 清掉文本里所有的哨兵字样。
 *
 * @param text 原始文本。
 * @returns 去掉哨兵并去除首尾空白的结果。
 */
export function stripSentinel(text: string): string {
  return text.replace(SENTINEL_PATTERN, '').trim();
}

/**
 * 判断文本里有没有哨兵。
 *
 * @param text 原始文本。
 * @returns 有返回 `true`。
 */
function hasSentinel(text: string): boolean {
  SENTINEL_PATTERN.lastIndex = 0;
  return SENTINEL_PATTERN.test(text);
}

/**
 * 标准模式：从整条输出判定模型要不要说话。
 *
 * 只有「出现过哨兵」**且**「去掉哨兵后只剩标点空白」才算沉默。
 *
 * @param reply 模型输出全文。
 * @returns 判定结果。
 */
export function readSentinelVerdict(reply: string): ParticipationVerdict {
  if (!hasSentinel(reply)) {
    // 没有哨兵就是正常回复。空输出也走这里 —— 空输出不是「沉默」这个语义：
    // 沉默是模型的主动选择，空输出是异常，混为一谈会让日志里分不清两者。
    return { speak: true };
  }

  const residue = stripSentinel(reply);
  if (ONLY_PUNCTUATION.test(residue)) {
    return { speak: false, reason: REASON_CHOSEN_SILENCE };
  }

  // 正文里混着哨兵但还有真实内容 → 必须说话，不能把内容丢掉
  return { speak: true };
}

/** 判定为「说话」的词。 */
const SPEAK_TOKENS = new Set(['speak', 'yes', '说话', '回', '回话', '回应']);

/** 判定为「沉默」的词。 */
const SILENCE_TOKENS = new Set(['silence', 'no', '沉默', '不说话', '不说', '静默', '别说话']);

/**
 * 取判定输出的第一个词（去掉首尾标点）。
 *
 * @param raw 判定调用的输出。
 * @returns 归一化后的第一个词；取不到时返回空串。
 */
function firstToken(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return '';
  }
  const head = trimmed.split(/[\s\n\r:：,，。.!！?？]+/)[0] ?? '';
  return head.replace(/^[\s"'`“”‘’【】\[\]()（）]+|[\s"'`“”‘’【】\[\]()（）]+$/g, '');
}

/**
 * EXP 模式：解析判定调用的输出。
 *
 * 认不出第一个词时按沉默处理（见模块头的说明）。
 *
 * @param raw 判定调用的输出。
 * @returns 判定结果。
 */
export function parseVerdict(raw: string): ParticipationVerdict {
  const token = firstToken(raw);

  if (SPEAK_TOKENS.has(token)) {
    return { speak: true };
  }
  if (SILENCE_TOKENS.has(token)) {
    return { speak: false, reason: REASON_CHOSEN_SILENCE };
  }
  return { speak: false, reason: REASON_UNPARSEABLE };
}

/** 预算上限。 */
export interface ParticipationBudgetLimits {
  /** 同一来源两次主动发言之间的最小间隔（毫秒）。 */
  cooldownMs: number;
  /** 同一来源每小时的主动发言上限。 */
  maxPerHour: number;
}

/** 预算判定结果。 */
export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

/** 冷却与每小时预算。 */
export interface ParticipationBudget {
  /**
   * 现在能不能主动发言。
   *
   * @param key 来源键。
   * @param now 当前时刻。
   * @returns 判定结果。
   */
  check: (key: string, now: number) => BudgetDecision;
  /**
   * 记一次主动发言。
   *
   * @param key 来源键。
   * @param now 当前时刻。
   */
  record: (key: string, now: number) => void;
  /**
   * 清空某来源的冷却与计数。
   *
   * @param key 来源键。
   */
  reset: (key: string) => void;
}

/** 一小时（毫秒）。 */
const ONE_HOUR_MS = 3_600_000;

/**
 * 创建冷却与预算。
 *
 * ## 为什么 `maxPerHour` 至少夹到 1
 *
 * 配置成 0 会让机器人**永久无法主动发言**，而界面上看起来「功能是开着的」。
 * 夹到 1 至少保留了最小能力，也让用户从行为上察觉配置不对。
 *
 * @param limits 上限。
 * @returns 预算实例。
 */
export function createParticipationBudget(limits: ParticipationBudgetLimits): ParticipationBudget {
  const cooldownMs = Number.isFinite(limits.cooldownMs) ? Math.max(0, Math.floor(limits.cooldownMs)) : 0;
  const maxPerHour = Number.isFinite(limits.maxPerHour) ? Math.max(1, Math.floor(limits.maxPerHour)) : 1;

  /** 每个来源：上次发言时刻 + 最近一小时内的发言时刻。 */
  const state = new Map<string, { lastSpokeAt: number; recent: number[] }>();

  /**
   * 取某来源的状态（不存在则创建）。
   *
   * @param key 来源键。
   * @returns 状态对象。
   */
  function ensure(key: string): { lastSpokeAt: number; recent: number[] } {
    const found = state.get(key);
    if (found !== undefined) {
      return found;
    }
    const created = { lastSpokeAt: 0, recent: [] as number[] };
    state.set(key, created);
    return created;
  }

  return {
    check(key: string, now: number): BudgetDecision {
      const current = state.get(key);
      if (current === undefined) {
        return { allowed: true };
      }

      if (current.lastSpokeAt > 0 && now - current.lastSpokeAt < cooldownMs) {
        const remaining = cooldownMs - (now - current.lastSpokeAt);
        return { allowed: false, reason: `发言冷却中，还需 ${remaining} ms` };
      }

      const recent = current.recent.filter((at) => now - at < ONE_HOUR_MS);
      if (recent.length >= maxPerHour) {
        return { allowed: false, reason: `已达每小时主动发言上限（${maxPerHour} 次）` };
      }

      return { allowed: true };
    },

    record(key: string, now: number): void {
      const current = ensure(key);
      current.lastSpokeAt = now;
      current.recent = [...current.recent.filter((at) => now - at < ONE_HOUR_MS), now];
    },

    reset(key: string): void {
      state.delete(key);
    },
  };
}
