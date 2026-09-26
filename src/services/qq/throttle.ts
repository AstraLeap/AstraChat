/**
 * 发送节流：防止机器人被官方频控掐掉。
 *
 * 官方对群消息的限制是「单群 20 条/分钟、每日 1000 条/群」（见
 * `docs/qq-integration-design.md` §2.3），超了会被限流甚至短时封禁。这里同时管三个约束：
 *
 * 1. **相邻两条的固定间隔**（`sendDelayMs`）—— 防连发刷屏。
 * 2. **每分钟上限**。
 * 3. **每小时上限**。
 *
 * ## 为什么把时间当参数传进来
 *
 * `check(now)` / `record(now)` 都接收毫秒时间戳，模块自己不读时钟。这样单测可以精确控制
 * 时间轴，不需要 `vi.useFakeTimers()`，也不会因为真实时钟抖动而变成偶发失败。
 *
 * ## `check` 不消耗配额
 *
 * 查询与记账分开：调用方可以先 `check()` 决定等多久，真正发出后再 `record()`。
 * 这样「查一次就少一次配额」这种奇怪语义不会出现。
 */

/** 被拦下的原因。 */
export type ThrottleReason = 'delay' | 'per-minute' | 'per-hour';

/** 一次可发送性判定。 */
export interface ThrottleDecision {
  /** 现在是否可以发送。 */
  allowed: boolean;
  /** 还需等待多少毫秒；`allowed` 为真时为 0。 */
  waitMs: number;
  /** 被拦下的原因；`allowed` 为真时不存在。 */
  reason?: ThrottleReason;
}

/** 节流配置。 */
export interface ThrottleOptions {
  /** 相邻两条之间的最小间隔（毫秒）。 */
  sendDelayMs: number;
  /** 每分钟最多发送多少条。 */
  maxPerMinute: number;
  /** 每小时最多发送多少条。 */
  maxPerHour: number;
}

/** 节流器。 */
export interface Throttle {
  /**
   * 判定此刻能否发送（**不消耗配额**）。
   *
   * @param now 当前时间（Unix 毫秒）。
   * @returns 判定结果。
   */
  check(now: number): ThrottleDecision;
  /**
   * 记录一次发送（消耗配额）。
   *
   * @param now 发送时间（Unix 毫秒）。
   */
  record(now: number): void;
  /** 清空历史。重连或手动恢复后调用，避免旧数据继续压制发送。 */
  reset(): void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * 把配置值夹到合法范围。
 *
 * 上限类配置小于 1 时按 1 处理：`0` 会让「已经发过 0 条」也判定为超限，等于永久锁死；
 * 抬到 1 至少保证能发第一条，并且在窗口滑出后必然恢复。
 *
 * @param value 原始值。
 * @param fallback 非法时回退。
 * @returns 合法的非负整数。
 */
function normalizeLimit(value: number, fallback: number): number {
  const num = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, num);
}

/**
 * 创建一个节流器。
 *
 * @param options 配置。
 * @returns 节流器实例。
 */
export function createThrottle(options: ThrottleOptions): Throttle {
  const sendDelayMs = Math.max(0, Number.isFinite(options.sendDelayMs) ? options.sendDelayMs : 0);
  const maxPerMinute = normalizeLimit(options.maxPerMinute, 1);
  const maxPerHour = normalizeLimit(options.maxPerHour, 1);

  /** 已发送的时间戳，升序。会被裁剪到最近一小时。 */
  let history: number[] = [];

  /**
   * 丢掉一小时以前的记录。
   *
   * 用 `<=` 而不是 `<`：恰好一小时前的那条算「已经滑出窗口」，否则边界上会多压一条。
   *
   * @param now 当前时间。
   */
  const prune = (now: number): void => {
    history = history.filter((timestamp) => now - timestamp < HOUR_MS);
  };

  return {
    check(now: number): ThrottleDecision {
      prune(now);

      let waitMs = 0;
      let reason: ThrottleReason | undefined;

      /**
       * 记下某个约束要求的等待时间，取最长的那条。
       *
       * @param candidate 该约束要求的等待毫秒数。
       * @param why 约束名。
       */
      const consider = (candidate: number, why: ThrottleReason): void => {
        if (candidate > waitMs) {
          waitMs = candidate;
          reason = why;
        }
      };

      // 1) 固定间隔
      const last = history[history.length - 1];
      if (last !== undefined) {
        const elapsed = now - last;
        if (elapsed < sendDelayMs) {
          consider(sendDelayMs - elapsed, 'delay');
        }
      }

      // 2) 每分钟上限
      const inMinute = history.filter((timestamp) => now - timestamp < MINUTE_MS);
      if (inMinute.length >= maxPerMinute) {
        // 只等「最老的那一条」是不够的：窗口里可能远超上限，要等到足够多条滑出，
        // 使剩余条数降到 maxPerMinute - 1。需要滑出 inMinute.length - (maxPerMinute - 1) 条，
        // 其中最后一条的下标是 inMinute.length - maxPerMinute。
        const blocking = inMinute[inMinute.length - maxPerMinute];
        if (blocking !== undefined) {
          consider(blocking + MINUTE_MS - now, 'per-minute');
        }
      }

      // 3) 每小时上限（history 已按一小时裁剪，长度即窗口内条数）
      if (history.length >= maxPerHour) {
        const blocking = history[history.length - maxPerHour];
        if (blocking !== undefined) {
          consider(blocking + HOUR_MS - now, 'per-hour');
        }
      }

      if (waitMs > 0) {
        return { allowed: false, waitMs, reason: reason ?? 'delay' };
      }
      return { allowed: true, waitMs: 0 };
    },

    record(now: number): void {
      prune(now);
      history.push(now);
      // 保证升序：调用方通常按时间递增调用，但排序一次很便宜（数组被裁剪得很小），
      // 换来的是「乱序调用也不会算错」。
      history.sort((a, b) => a - b);
    },

    reset(): void {
      history = [];
    },
  };
}
