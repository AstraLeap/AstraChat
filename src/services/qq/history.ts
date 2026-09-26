/**
 * 按来源隔离的对话历史（有界）。
 *
 * ## 为什么需要它
 *
 * 机器人在群里要「参与聊天」而不是「对孤立的一句话做反应」，就必须看得到刚才大家在
 * 聊什么。QQ 的事件是**一条一条推过来**的，不带上下文，所以上下文得我们自己攒。
 *
 * ## 三个必须做对的地方
 *
 * 1. **按来源严格隔离。** 键是 `group:<openid>` / `private:<openid>`，
 *    一个群的上下文绝不能泄漏到另一个群，更不能从群泄漏到私聊 —— 那是最难解释的隐私事故。
 * 2. **条数与字符数**双重**裁剪。** 只限条数时，一条几千字的消息就能把 prompt 撑爆；
 *    只限字符数时，几百条「哈哈哈」会让 prompt 里全是碎片而真正的信息被挤掉。
 * 3. **来源数量也要有上限**（LRU 淘汰）。否则一个被拉进几百个群的机器人会内存无界增长 ——
 *    这类泄漏在开发期完全看不出来，上线后才发现。
 *
 * ## 单条超长消息的处理
 *
 * 截断到上限而不是整条丢弃。丢掉的后果是**历史里永远缺这一条**，模型会以为
 * 「刚才没人说话」，比看到一句被截断的话更糟。
 */

/** 一条历史。 */
export interface HistoryEntry {
  /** 说话人显示名（群成员昵称 / 「用户」/ 机器人名）。 */
  speaker: string;
  /** 内容。 */
  text: string;
  /** 是否机器人自己说的。 */
  fromBot: boolean;
}

/** 裁剪参数。 */
export interface HistoryLimits {
  /** 每个来源最多保留多少条。 */
  maxEntries: number;
  /** 每个来源最多保留多少字符。 */
  maxChars: number;
  /** 最多同时跟踪多少个来源（超出按最久未用淘汰）。 */
  maxSources: number;
}

/** 默认上限：约几轮对话的量，足够理解「刚才在聊什么」而不至于把 prompt 撑满。 */
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxEntries: 20,
  maxChars: 4_000,
  maxSources: 200,
};

/** 对话历史。 */
export interface QqHistory {
  /**
   * 追加一条并自动裁剪。
   *
   * @param key 来源键（`group:<openid>` / `private:<openid>`）。
   * @param entry 历史条目。
   */
  append(key: string, entry: HistoryEntry): void;
  /**
   * 取某个来源的历史（最旧在前）。
   *
   * @param key 来源键。
   * @returns 历史副本（外部改动不影响内部）。
   */
  list(key: string): HistoryEntry[];
  /**
   * 清空某个来源（`/reset` 用）。
   *
   * @param key 来源键。
   */
  clear(key: string): void;
  /** 当前跟踪的来源数量。 */
  size(): number;
  /** 一个来源当前的字符数（测试与诊断用）。 */
  charCount(key: string): number;
}

/**
 * 创建对话历史。
 *
 * @param limits 裁剪参数。
 * @returns 历史实例。
 */
export function createQqHistory(limits: HistoryLimits = DEFAULT_HISTORY_LIMITS): QqHistory {
  const maxEntries = Math.max(1, Math.floor(limits.maxEntries));
  const maxChars = Math.max(1, Math.floor(limits.maxChars));
  const maxSources = Math.max(1, Math.floor(limits.maxSources));

  /** 每来源的条目；Map 的插入顺序即 LRU 顺序（最旧在前）。 */
  const store = new Map<string, HistoryEntry[]>();

  /**
   * 把来源标记为「最近使用」。
   *
   * @param key 来源键。
   */
  function touch(key: string): void {
    const existing = store.get(key);
    if (existing === undefined) {
      return;
    }
    store.delete(key);
    store.set(key, existing);
  }

  /**
   * 追加条目（假定调用方已 touch 过）。
   *
   * @param key 来源键。
   * @param entry 历史条目。
   */
  function appendRaw(key: string, entry: HistoryEntry): void {
    const list = store.get(key) ?? [];

    // 单条超长 → 截断而不是丢弃
    const text = entry.text.length > maxChars ? entry.text.slice(0, maxChars) : entry.text;
    list.push({ speaker: entry.speaker, text, fromBot: entry.fromBot });

    // 先按条数裁
    while (list.length > maxEntries) {
      list.shift();
    }

    // 再按字符数裁（从最旧的开始丢）
    let total = list.reduce((sum, item) => sum + item.text.length, 0);
    while (total > maxChars && list.length > 1) {
      const removed = list.shift();
      total -= removed === undefined ? 0 : removed.text.length;
    }

    store.set(key, list);
  }

  return {
    append(key: string, entry: HistoryEntry): void {
      if (typeof key !== 'string' || key.length === 0) {
        return;
      }
      touch(key);
      appendRaw(key, entry);

      // 来源数超限 → 淘汰最久未用（Map 的第一个）
      while (store.size > maxSources) {
        const oldest = store.keys().next();
        if (oldest.done === true) {
          break;
        }
        store.delete(oldest.value);
      }
    },

    list(key: string): HistoryEntry[] {
      const list = store.get(key);
      if (list === undefined) {
        return [];
      }
      touch(key);
      return list.map((item) => ({ ...item }));
    },

    clear(key: string): void {
      store.delete(key);
    },

    size(): number {
      return store.size;
    },

    charCount(key: string): number {
      const list = store.get(key);
      if (list === undefined) {
        return 0;
      }
      return list.reduce((sum, item) => sum + item.text.length, 0);
    },
  };
}
