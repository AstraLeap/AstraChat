import { describe, expect, it } from 'vitest';
import { createThrottle } from '../src/services/qq/throttle';

/**
 * 发送节流的测试。
 *
 * 时间由调用方以毫秒传入（`check(now)` / `record(now)`），所以测试里可以精确控制时间轴，
 * 不依赖真实时钟、也不需要 `vi.useFakeTimers()`。
 *
 * 节流要同时满足三个约束：相邻两条的固定间隔、每分钟上限、每小时上限。
 */

/** 常用配置：间隔 300ms、每分钟 3 条、每小时 10 条。 */
const CONFIG = { sendDelayMs: 300, maxPerMinute: 3, maxPerHour: 10 } as const;

describe('固定间隔', () => {
  it('刚创建时可以发送', () => {
    const throttle = createThrottle(CONFIG);
    expect(throttle.check(1000)).toEqual({ allowed: true, waitMs: 0 });
  });

  it('刚发过一条，间隔未到就不能再发', () => {
    const throttle = createThrottle(CONFIG);
    throttle.record(1000);
    expect(throttle.check(1000)).toEqual({ allowed: false, waitMs: 300, reason: 'delay' });
    expect(throttle.check(1200)).toEqual({ allowed: false, waitMs: 100, reason: 'delay' });
  });

  it('间隔到了就可以发', () => {
    const throttle = createThrottle(CONFIG);
    throttle.record(1000);
    expect(throttle.check(1300)).toEqual({ allowed: true, waitMs: 0 });
  });

  it('间隔为 0 时不限制', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 5, maxPerHour: 5 });
    throttle.record(1000);
    expect(throttle.check(1000).allowed).toBe(true);
  });
});

describe('每分钟上限', () => {
  it('达到每分钟上限后被拦，并要求等到窗口滑出', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 3, maxPerHour: 100 });
    throttle.record(0);
    throttle.record(1000);
    throttle.record(2000);

    const decision = throttle.check(2001);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('per-minute');
    // 最早一条在 t=0，滑出 60s 窗口是 t=60000
    expect(decision.waitMs).toBe(60000 - 2001);
  });

  it('窗口滑出后又可以发', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 3, maxPerHour: 100 });
    throttle.record(0);
    throttle.record(1000);
    throttle.record(2000);
    // 60000 时 t=0 那条已滑出（不算在内），此时历史只剩 2 条
    expect(throttle.check(60000).allowed).toBe(true);
  });

  it('恰好等于上限仍算未超（边界）', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 2, maxPerHour: 100 });
    throttle.record(0);
    expect(throttle.check(1).allowed).toBe(true);
    throttle.record(2);
    expect(throttle.check(3).allowed).toBe(false);
  });
});

describe('每小时上限', () => {
  it('只受每小时上限约束时，等待时间按最老一条算', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 100, maxPerHour: 2 });
    throttle.record(0);
    throttle.record(10 * 60_000);

    const decision = throttle.check(10 * 60_000 + 1);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('per-hour');
    expect(decision.waitMs).toBe(3_600_000 - (10 * 60_000 + 1));
  });

  it('每小时窗口滑出后恢复', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 100, maxPerHour: 2 });
    throttle.record(0);
    throttle.record(1000);
    expect(throttle.check(3_600_000).allowed).toBe(true);
  });
});

describe('多约束同时生效时取最严格的一条', () => {
  it('间隔与每分钟都超时，给出更长的等待', () => {
    const throttle = createThrottle({ sendDelayMs: 5000, maxPerMinute: 1, maxPerHour: 100 });
    throttle.record(0);

    const decision = throttle.check(100);
    expect(decision.allowed).toBe(false);
    // 间隔还差 4900；每分钟要等到 60000 —— 取更长的那条
    expect(decision.waitMs).toBe(60000 - 100);
    expect(decision.reason).toBe('per-minute');
  });
});

describe('记录与重置', () => {
  it('check 不消耗配额（可以反复查）', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 1, maxPerHour: 100 });
    expect(throttle.check(0).allowed).toBe(true);
    expect(throttle.check(0).allowed).toBe(true);
    throttle.record(0);
    expect(throttle.check(0).allowed).toBe(false);
  });

  it('reset 清空历史（重连后调用）', () => {
    const throttle = createThrottle({ sendDelayMs: 1000, maxPerMinute: 1, maxPerHour: 1 });
    throttle.record(0);
    expect(throttle.check(10).allowed).toBe(false);
    throttle.reset();
    expect(throttle.check(10)).toEqual({ allowed: true, waitMs: 0 });
  });

  it('很老的历史会被清理，不无限增长', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 100, maxPerHour: 100 });
    for (let i = 0; i < 50; i++) {
      throttle.record(i * 10_000);
    }
    // 最后一条在 t=490000；等到 3_600_000 + 490000 时全部过期
    expect(throttle.check(4_100_000).allowed).toBe(true);
  });
});

describe('非法配置的兜底', () => {
  it('上限小于 1 时按 1 处理，不会永久锁死', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 0, maxPerHour: 0 });
    // 两个上限都被抬到 1：第一条还能发
    expect(throttle.check(0).allowed).toBe(true);
    throttle.record(0);
    expect(throttle.check(0).allowed).toBe(false);
    // 注意：此时受**每小时**上限约束（maxPerHour 也是 1），所以要等到小时边界
    expect(throttle.check(60_000).allowed).toBe(false);
    expect(throttle.check(3_600_000).allowed).toBe(true);
  });

  it('负数的间隔按 0 处理', () => {
    const throttle = createThrottle({ sendDelayMs: -500, maxPerMinute: 5, maxPerHour: 5 });
    throttle.record(0);
    expect(throttle.check(0).allowed).toBe(true);
  });
});

describe('窗口内条数远超上限', () => {
  it('要等到足够多的条目滑出，而不是只等最老的一条', () => {
    const throttle = createThrottle({ sendDelayMs: 0, maxPerMinute: 2, maxPerHour: 100 });
    throttle.record(0);
    throttle.record(1000);
    throttle.record(2000);
    throttle.record(3000);

    // 窗口内 4 条、上限 2：需要滑出 3 条才降到 1 < 2。
    // 第 3 老的那条在 t=2000，所以等到 62000。
    // 若只等最老一条（t=0 → 60000），那时窗口里还剩 3 条，仍然发不出去。
    expect(throttle.check(3001)).toEqual({
      allowed: false,
      waitMs: 2000 + 60_000 - 3001,
      reason: 'per-minute',
    });
    expect(throttle.check(2000 + 60_000).allowed).toBe(true);
  });
});
