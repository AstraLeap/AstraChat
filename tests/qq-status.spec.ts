import { describe, expect, it } from 'vitest';
import { toPersistedStatus } from '../src/services/qq/status';

/**
 * 运行期状态 → 落库状态 的映射测试。
 *
 * 这里有两个**不同含义**的状态需要区分清楚，它们曾经同名，很容易混：
 *
 * | 类型 | 取值 | 用途 |
 * |---|---|---|
 * | `QqConnectionStatus` | `disconnected` / `connected` / `error` | **落库**（`QqConfig.status`） |
 * | `QqConnectionState` | `stopped` / `connecting` / `connected` / `error` | **运行期**快照 |
 *
 * 运行期比落库多一个 `connecting`，而且「用户主动停」在运行期是 `stopped`、
 * 落库是 `disconnected`。所以必须有这层显式映射，不能直接赋值。
 */

describe('状态映射', () => {
  it('运行期的 stopped 落库为 disconnected（主动停止要能持久化）', () => {
    expect(toPersistedStatus({ state: 'stopped', message: '已停止连接', botId: null })).toEqual({
      status: 'disconnected',
      statusMessage: '已停止连接',
    });
  });

  it('connected 直接对应', () => {
    expect(
      toPersistedStatus({ state: 'connected', message: '已就绪：笙澜', botId: 'BOT' }),
    ).toEqual({ status: 'connected', statusMessage: '已就绪：笙澜' });
  });

  it('error 保留可操作的原因', () => {
    const result = toPersistedStatus({
      state: 'error',
      message: 'intent 无权限（4014），请到开放平台申请',
      botId: null,
    });
    expect(result.status).toBe('error');
    expect(result.statusMessage).toContain('4014');
  });

  it('【关键】connecting 不落库为连接中，而是 disconnected + 说明', () => {
    // 理由：connecting 是瞬时态。若落库，应用下次启动会显示「正在连接」——
    // 而那时根本没有在连接。细节靠 statusMessage 保留（它存在的意义就是这个）。
    const result = toPersistedStatus({
      state: 'connecting',
      message: '正在连接 QQ 网关…',
      botId: null,
    });
    expect(result.status).toBe('disconnected');
    expect(result.statusMessage).toBe('正在连接 QQ 网关…');
  });

  it('botId 不落库（它来自 READY，是会话期的临时信息）', () => {
    const result = toPersistedStatus({ state: 'connected', message: '好了', botId: 'BOT_ID' });
    expect(result).not.toHaveProperty('botId');
    expect(Object.keys(result).sort()).toEqual(['status', 'statusMessage']);
  });

  it('message 为空时也给出可读的兜底说明', () => {
    expect(toPersistedStatus({ state: 'connected', message: '', botId: null }).statusMessage.length)
      .toBeGreaterThan(0);
  });

  it('每种运行期状态都有明确落库结果（不能漏分支）', () => {
    const states = ['stopped', 'connecting', 'connected', 'error'] as const;
    const seen = states.map(
      (state) => toPersistedStatus({ state, message: 'x', botId: null }).status,
    );
    expect(seen).toEqual(['disconnected', 'disconnected', 'connected', 'error']);
  });
});
