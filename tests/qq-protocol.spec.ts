import { describe, expect, it } from 'vitest';
import {
  OP,
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  classifyCloseCode,
  classifyOpcode,
  needsTokenRefresh,
  nextReconnectDelay,
  parseAccessTokenResponse,
  parseGatewayPayload,
  parseGatewayResponse,
  parseHelloInterval,
  parseReady,
  qqBotToken,
} from '../src/services/qq/protocol';

/**
 * 官方 Bot API 线协议的测试。
 *
 * 所有字段名、op 码、关闭码都来自 `docs/qq-protocol-notes.md` 的取证结果。
 * 这个文件的作用是**把那些容易写错的地方钉死**：字段是 `clientSecret` 还是 `appSecret`、
 * `session_id` 是蛇形还是驼峰、失败时 HTTP 仍是 200、哪个关闭码可以重试。
 */

describe('凭证响应解析', () => {
  it('成功：expires_in 是数字', () => {
    expect(parseAccessTokenResponse({ access_token: 'AT', expires_in: 7200 }, 1_000)).toEqual({
      ok: true,
      token: 'AT',
      // 1000 + 7200 * 1000
      expiresAt: 7_201_000,
    });
  });

  it('成功：expires_in 是字符串（官方示例就是字符串）', () => {
    expect(parseAccessTokenResponse({ access_token: 'AT', expires_in: '7200' }, 0)).toEqual({
      ok: true,
      token: 'AT',
      expiresAt: 7_200_000,
    });
  });

  it('expires_in 缺失时回退到官方默认 7200 秒', () => {
    expect(parseAccessTokenResponse({ access_token: 'AT' }, 0)).toEqual({
      ok: true,
      token: 'AT',
      expiresAt: 7_200_000,
    });
  });

  it('【关键】业务失败时 HTTP 仍是 200，必须靠响应体 code 判定', () => {
    const result = parseAccessTokenResponse(
      { code: 100016, message: 'invalid appid or secret' },
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(100016);
    expect(result.message).toContain('invalid appid or secret');
  });

  it('各种失败码都能识别', () => {
    for (const code of [100001, 100007, 100016, 10004]) {
      const result = parseAccessTokenResponse({ code, message: 'x' }, 0);
      expect(result.ok, `code=${code}`).toBe(false);
    }
  });

  it('有 code 但同时有 access_token 时，仍按失败处理（code 优先）', () => {
    const result = parseAccessTokenResponse({ code: 100007, access_token: 'AT' }, 0);
    expect(result.ok).toBe(false);
  });

  it('access_token 是空串视为失败', () => {
    expect(parseAccessTokenResponse({ access_token: '   ' }, 0).ok).toBe(false);
  });

  it('响应体不是对象时给出可读失败', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      const result = parseAccessTokenResponse(body, 0);
      expect(result.ok).toBe(false);
    }
  });
});

describe('凭证刷新时机（对齐官方「过期前 60 秒」语义）', () => {
  const token = { token: 'AT', expiresAt: 100_000 };

  it('没有凭证时需要获取', () => {
    expect(needsTokenRefresh(null, 0)).toBe(true);
  });

  it('离过期还很久时不需要刷新', () => {
    expect(needsTokenRefresh(token, 30_000)).toBe(false);
  });

  it('进入过期前 60 秒就要刷新', () => {
    expect(needsTokenRefresh(token, 39_999)).toBe(false);
    expect(needsTokenRefresh(token, 40_000)).toBe(true);
  });

  it('已过期当然要刷新', () => {
    expect(needsTokenRefresh(token, 200_000)).toBe(true);
  });
});

describe('QQBot 授权前缀', () => {
  it('REST 头与网关 token 用同一个前缀格式', () => {
    expect(qqBotToken('AT')).toBe('QQBot AT');
  });
});

describe('Gateway 接入点响应解析', () => {
  it('解析完整响应', () => {
    const info = parseGatewayResponse({
      url: 'wss://api.bot.qq.com/websocket/',
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 14_400_000,
        max_concurrency: 1,
      },
    });
    expect(info).not.toBeNull();
    expect(info!.url).toBe('wss://api.bot.qq.com/websocket/');
    expect(info!.shards).toBe(1);
    expect(info!.sessionStartLimit?.maxConcurrency).toBe(1);
    expect(info!.sessionStartLimit?.remaining).toBe(999);
  });

  it('缺少 session_start_limit 时不报错', () => {
    const info = parseGatewayResponse({ url: 'wss://x/websocket' });
    expect(info?.url).toBe('wss://x/websocket');
    expect(info?.shards).toBe(1); // 缺省不分片
    expect(info?.sessionStartLimit).toBeNull();
  });

  it('没有 url 视为失败', () => {
    expect(parseGatewayResponse({ shards: 1 })).toBeNull();
    expect(parseGatewayResponse({ url: '' })).toBeNull();
    expect(parseGatewayResponse(null)).toBeNull();
  });
});

describe('信封与 op 码', () => {
  it('解析 Dispatch 信封', () => {
    const payload = parseGatewayPayload({ id: 'e1', op: 0, d: { a: 1 }, s: 42, t: 'READY' });
    expect(payload).toEqual({ id: 'e1', op: 0, d: { a: 1 }, s: 42, t: 'READY' });
  });

  it('s 与 t 缺失时归一成 null（心跳与 Hello 都没有）', () => {
    const payload = parseGatewayPayload({ op: 10, d: { heartbeat_interval: 45_000 } });
    expect(payload?.op).toBe(10);
    expect(payload?.s).toBeNull();
    expect(payload?.t).toBeNull();
  });

  it('op 不是数字时判为无效', () => {
    expect(parseGatewayPayload({ op: 'x' })).toBeNull();
    expect(parseGatewayPayload({ d: {} })).toBeNull();
    expect(parseGatewayPayload(null)).toBeNull();
    expect(parseGatewayPayload('nope')).toBeNull();
  });

  it('OP 常量与文档一致（含 7 与 9）', () => {
    expect(OP.DISPATCH).toBe(0);
    expect(OP.HEARTBEAT).toBe(1);
    expect(OP.IDENTIFY).toBe(2);
    expect(OP.RESUME).toBe(6);
    expect(OP.RECONNECT).toBe(7);
    expect(OP.INVALID_SESSION).toBe(9);
    expect(OP.HELLO).toBe(10);
    expect(OP.HEARTBEAT_ACK).toBe(11);
  });
});

describe('Hello 与 READY', () => {
  it('从 Hello 取出心跳周期（毫秒）', () => {
    expect(parseHelloInterval({ op: 10, d: { heartbeat_interval: 45_000 } })).toBe(45_000);
  });

  it('Hello 缺字段时返回 null', () => {
    expect(parseHelloInterval({ op: 10, d: {} })).toBeNull();
    expect(parseHelloInterval({ op: 10, d: { heartbeat_interval: 0 } })).toBeNull();
    expect(parseHelloInterval(null)).toBeNull();
  });

  it('从 READY 取 session_id 与机器人自己的身份', () => {
    const ready = parseReady({
      op: 0,
      s: 1,
      t: 'READY',
      d: {
        version: 1,
        session_id: 'sid-1',
        user: { id: 'u1', username: '群pro测试机器人', bot: true },
        shard: [0, 0],
      },
    });
    expect(ready).toEqual({ sessionId: 'sid-1', userId: 'u1', username: '群pro测试机器人' });
  });

  it('缺 session_id 视为无效 READY', () => {
    expect(parseReady({ op: 0, t: 'READY', d: { user: { id: 'u1' } } })).toBeNull();
    expect(parseReady(null)).toBeNull();
  });
});

describe('上行 payload 构造（字段名必须与文档完全一致）', () => {
  it('Identify：token 带 QQBot 前缀，shard 默认 [0,1]，properties 用 $ 前缀键', () => {
    const payload = buildIdentifyPayload({ token: 'AT', intents: 1 << 25 });
    expect(payload).toEqual({
      op: 2,
      d: {
        token: 'QQBot AT',
        intents: 33_554_432,
        shard: [0, 1],
        properties: { $os: expect.any(String), $browser: expect.any(String), $device: expect.any(String) },
      },
    });
    // 1 << 25 = 33554432
    expect((payload.d as { intents: number }).intents).toBe(1 << 25);
  });

  it('Identify 支持自定义分片', () => {
    const payload = buildIdentifyPayload({ token: 'AT', intents: 1, shard: [2, 4] });
    expect((payload.d as { shard: number[] }).shard).toEqual([2, 4]);
  });

  it('Resume：字段是 session_id（蛇形），seq 原样带上', () => {
    const payload = buildResumePayload({ token: 'AT', sessionId: 'sid-1', seq: 251 });
    expect(payload).toEqual({
      op: 6,
      d: { token: 'QQBot AT', session_id: 'sid-1', seq: 251 },
    });
  });

  it('心跳：首连时 d 为 null，之后带最新的 s', () => {
    expect(buildHeartbeatPayload(null)).toEqual({ op: 1, d: null });
    expect(buildHeartbeatPayload(251)).toEqual({ op: 1, d: 251 });
    expect(buildHeartbeatPayload(0)).toEqual({ op: 1, d: 0 });
  });
});

describe('关闭码 → 重连策略（官方文档的重试依据）', () => {
  it('4009 连接过期 → 可重试且优先 resume', () => {
    const directive = classifyCloseCode(4009);
    expect(directive.retryable).toBe(true);
    expect(directive.preferResume).toBe(true);
  });

  it('4008 发送过快 → 可重试（应退避）', () => {
    const directive = classifyCloseCode(4008);
    expect(directive.retryable).toBe(true);
    expect(directive.preferResume).toBe(true);
  });

  it('4006 / 4007 → 可重试但必须重新 identify', () => {
    for (const code of [4006, 4007]) {
      const directive = classifyCloseCode(code);
      expect(directive.retryable, `code=${code}`).toBe(true);
      expect(directive.preferResume).toBe(false);
    }
  });

  it('4900~4913 内部错误 → 可重试，重新 identify', () => {
    for (let code = 4900; code <= 4913; code++) {
      const directive = classifyCloseCode(code);
      expect(directive.retryable, `code=${code}`).toBe(true);
      expect(directive.preferResume).toBe(false);
    }
  });

  it('4013 / 4014（intent 无效或无权限）→ 不可重试，且提示要申请权限', () => {
    for (const code of [4013, 4014]) {
      const directive = classifyCloseCode(code);
      expect(directive.retryable, `code=${code}`).toBe(false);
      expect(directive.reason).toMatch(/intent/i);
      expect(directive.reason).toMatch(/权限/);
    }
  });

  it('4001 / 4002 / 4010 / 4011 / 4012 → 不可重试', () => {
    for (const code of [4001, 4002, 4010, 4011, 4012]) {
      expect(classifyCloseCode(code).retryable, `code=${code}`).toBe(false);
    }
  });

  it('4914 / 4915（下架 / 封禁）→ 不可重试，并说明原因', () => {
    expect(classifyCloseCode(4914).retryable).toBe(false);
    expect(classifyCloseCode(4914).reason).toMatch(/沙箱|下架/);
    expect(classifyCloseCode(4915).retryable).toBe(false);
    expect(classifyCloseCode(4915).reason).toMatch(/封禁/);
  });

  it('未知码按文档「其他错误重新 identify」处理', () => {
    const directive = classifyCloseCode(4999);
    expect(directive.retryable).toBe(true);
    expect(directive.preferResume).toBe(false);
  });

  it('正常关闭（1000）也应重连，优先 resume', () => {
    const directive = classifyCloseCode(1000);
    expect(directive.retryable).toBe(true);
    expect(directive.preferResume).toBe(true);
  });

  it('每个关闭码都给出可读原因', () => {
    for (const code of [1000, 4001, 4006, 4007, 4008, 4009, 4013, 4014, 4900, 4913, 4914, 4915, 4999]) {
      expect(classifyCloseCode(code).reason.length, `code=${code}`).toBeGreaterThan(0);
    }
  });
});

describe('服务端 op 信号（7 重连 / 9 会话失效）', () => {
  it('op 7 → 重连，可 resume', () => {
    const directive = classifyOpcode(OP.RECONNECT);
    expect(directive).not.toBeNull();
    expect(directive!.retryable).toBe(true);
    expect(directive!.preferResume).toBe(true);
  });

  it('op 9 → 会话失效，必须重新 identify', () => {
    const directive = classifyOpcode(OP.INVALID_SESSION);
    expect(directive).not.toBeNull();
    expect(directive!.retryable).toBe(true);
    expect(directive!.preferResume).toBe(false);
  });

  it('其他 op 不是重连信号', () => {
    for (const op of [OP.DISPATCH, OP.HEARTBEAT, OP.HELLO, OP.HEARTBEAT_ACK]) {
      expect(classifyOpcode(op)).toBeNull();
    }
  });
});

describe('指数退避', () => {
  const config = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0.25 };
  /** 固定随机数，让退避可精确断言。 */
  const fixed = (value: number) => () => value;

  it('按 2 的幂增长', () => {
    expect(nextReconnectDelay(0, config, fixed(0.5))).toBe(1000);
    expect(nextReconnectDelay(1, config, fixed(0.5))).toBe(2000);
    expect(nextReconnectDelay(2, config, fixed(0.5))).toBe(4000);
    expect(nextReconnectDelay(5, config, fixed(0.5))).toBe(32_000);
  });

  it('超过上限时被截到 maxMs', () => {
    expect(nextReconnectDelay(6, config, fixed(0.5))).toBe(60_000);
    expect(nextReconnectDelay(20, config, fixed(0.5))).toBe(60_000);
  });

  it('抖动是 ±ratio，且加抖动后仍不超过上限', () => {
    expect(nextReconnectDelay(0, config, fixed(0))).toBe(750);
    expect(nextReconnectDelay(0, config, fixed(1))).toBe(1250);
    // 上限处的正向抖动必须被夹回 maxMs
    expect(nextReconnectDelay(10, config, fixed(1))).toBe(60_000);
    expect(nextReconnectDelay(10, config, fixed(0))).toBe(45_000);
  });

  it('负数 attempt 按 0 处理', () => {
    expect(nextReconnectDelay(-3, config, fixed(0.5))).toBe(1000);
  });

  it('jitterRatio 缺省为 0（不做抖动）', () => {
    expect(nextReconnectDelay(1, { baseMs: 1000, maxMs: 60_000 }, fixed(0.9))).toBe(2000);
  });
});
