import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  type GatewayState,
  type SocketCloseEvent,
  type WebSocketLike,
} from '../src/services/qq/gateway';
import { OP, type GatewayPayload, type ReadyInfo } from '../src/services/qq/protocol';

/**
 * 网关状态机的测试。
 *
 * 用**假 socket + 假定时器**：时间轴可以精确推进，不需要手写 RFC6455 服务端，
 * 也不用等真实的秒级心跳。断言全部落在状态迁移与**实际发出的帧**上——
 * 出错的代价是「悄悄连不上」或「疯狂重连」，这两类问题在真机上很难观察。
 */

/** 可手动驱动的假 socket。 */
class FakeSocket implements WebSocketLike {
  /** 发出去的原始帧。 */
  readonly sent: string[] = [];
  /** 是否被关闭过。 */
  closed = false;

  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((event: SocketCloseEvent) => void) | null = null;
  private errorHandler: (() => void) | null = null;

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (event: SocketCloseEvent) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: () => void): void {
    this.errorHandler = handler;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** 驱动 open。 */
  fireOpen(): void {
    this.openHandler?.();
  }

  /** 驱动一条 JSON 消息。 */
  fireMessage(payload: unknown): void {
    this.messageHandler?.(JSON.stringify(payload));
  }

  /** 驱动一条原始文本消息。 */
  fireRaw(text: string): void {
    this.messageHandler?.(text);
  }

  /** 驱动 close。 */
  fireClose(code: number, reason = ''): void {
    this.closeHandler?.({ code, reason });
  }

  /** 驱动 error。 */
  fireError(): void {
    this.errorHandler?.();
  }

  /** 取最后一帧（已解析）。 */
  lastSent(): Record<string, unknown> | null {
    const raw = this.sent[this.sent.length - 1];
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  }
}

/** Hello 帧。 */
function hello(intervalMs = 45_000): Record<string, unknown> {
  return { op: OP.HELLO, d: { heartbeat_interval: intervalMs } };
}

/** READY 帧（`s` 用于让 latestSeq 有值）。 */
function ready(seq = 1): Record<string, unknown> {
  return {
    op: OP.DISPATCH,
    s: seq,
    t: 'READY',
    d: {
      version: 1,
      session_id: 'sid-1',
      user: { id: 'BOT_ID', username: '测试机器人', bot: true },
      shard: [0, 0],
    },
  };
}

/** 搭一套被测环境。 */
function setup(overrides: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const events: GatewayPayload[] = [];
  const states: [GatewayState, string][] = [];
  const warns: string[] = [];
  const fatals: Error[] = [];
  const readies: ReadyInfo[] = [];

  const gateway = createGateway({
    getGatewayUrl: async () => 'wss://fake/websocket',
    getToken: async () => 'AT',
    intents: 1 << 25,
    onEvent: (payload) => events.push(payload),
    onStateChange: (state, detail) => states.push([state, detail]),
    onReady: (info) => readies.push(info),
    onFatal: (error) => fatals.push(error),
    onWarn: (message) => warns.push(message),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    // 关掉抖动让退避可精确断言
    backoff: { baseMs: 1000, maxMs: 60_000 },
    random: () => 0.5,
    ...overrides,
  });

  return { gateway, sockets, events, states, warns, fatals, readies };
}

/**
 * 推进假时间并让微任务跑完。
 *
 * @param ms 推进的毫秒数。
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** 取第 n 个 socket（断言过数量后用，避免 undefined 噪音）。 */
function socketAt(sockets: FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (socket === undefined) {
    throw new Error(`期望第 ${index} 个 socket 存在，实际只有 ${sockets.length} 个`);
  }
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('连接建立与鉴权', () => {
  it('start 后进入 connecting 并创建 socket', async () => {
    const { gateway, sockets } = setup();
    await gateway.start();

    expect(gateway.getState()).toBe('connecting');
    expect(sockets).toHaveLength(1);
    // 还没收到 Hello，不该抢跑发 Identify
    expect(socketAt(sockets, 0).sent).toHaveLength(0);
  });

  it('收到 Hello 后按官方格式发 Identify', async () => {
    const { gateway, sockets } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());

    expect(socketAt(sockets, 0).lastSent()).toEqual({
      op: 2,
      d: {
        token: 'QQBot AT',
        intents: 1 << 25,
        shard: [0, 1],
        properties: {
          $os: expect.any(String),
          $browser: 'AstraChat',
          $device: 'AstraChat',
        },
      },
    });
    expect(gateway.getState()).toBe('connecting');
  });

  it('收到 READY 后进入 connected 并回调机器人身份', async () => {
    const { gateway, sockets, readies } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready());

    expect(gateway.getState()).toBe('connected');
    expect(readies).toEqual([{ sessionId: 'sid-1', userId: 'BOT_ID', username: '测试机器人' }]);
  });

  it('业务事件转交 onEvent，READY/RESUMED 不转交', async () => {
    const { gateway, sockets, events } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready());
    socketAt(sockets, 0).fireMessage({ op: 0, s: 5, t: 'GROUP_MESSAGE_CREATE', d: { id: 'm1' } });
    socketAt(sockets, 0).fireMessage({ op: 0, s: 6, t: 'RESUMED', d: '' });

    expect(events).toHaveLength(1);
    expect(events[0]?.t).toBe('GROUP_MESSAGE_CREATE');
    expect(gateway.getState()).toBe('connected');
  });

  it('非 JSON 帧只告警，不打断连接', async () => {
    const { gateway, sockets, warns } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireRaw('这不是 JSON');
    socketAt(sockets, 0).fireMessage(hello());

    expect(warns.some((w) => w.includes('非 JSON'))).toBe(true);
    expect(gateway.getState()).toBe('connecting');
  });
});

describe('心跳', () => {
  it('按 Hello 给的周期发送，并带上最新的 s', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello(1000));
    socketAt(sockets, 0).fireMessage(ready(7));

    await advance(1000);
    expect(socketAt(sockets, 0).lastSent()).toEqual({ op: 1, d: 7 });
    expect(gateway.getState()).toBe('connected');
  });

  it('收到 ACK 会清空丢失计数，不会误判连接已死', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello(1000));
    socketAt(sockets, 0).fireMessage(ready());

    await advance(1000); // 第一次心跳，丢失计数 1
    socketAt(sockets, 0).fireMessage({ op: OP.HEARTBEAT_ACK }); // 清空
    await advance(1000); // 第二次心跳，丢失计数 1

    expect(gateway.getState()).toBe('connected');
  });

  it('【关键】连续 2 次心跳无 ACK 判定连接已死并重连', async () => {
    const { sockets, gateway, warns } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello(1000));
    socketAt(sockets, 0).fireMessage(ready());

    await advance(1000); // 1 次
    expect(gateway.getState()).toBe('connected');
    await advance(1000); // 2 次 → 触发重连

    expect(warns.some((w) => w.includes('心跳'))).toBe(true);
    expect(gateway.getState()).toBe('reconnecting');
  });

  it('maxMissedHeartbeats 可配置', async () => {
    const { sockets, gateway } = setup({ maxMissedHeartbeats: 3 });
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello(1000));
    socketAt(sockets, 0).fireMessage(ready());

    await advance(1000);
    await advance(1000);
    expect(gateway.getState()).toBe('connected'); // 2 次还不够
    await advance(1000);
    expect(gateway.getState()).toBe('reconnecting'); // 第 3 次触发
  });
});

describe('重连：Resume 还是重新 Identify', () => {
  it('关闭码 4009 → 重连并发送 Resume（补发遗漏事件）', async () => {
    const { gateway, sockets } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready(7));
    socketAt(sockets, 0).fireClose(4009);

    expect(gateway.getState()).toBe('reconnecting');
    await advance(1000);

    expect(sockets).toHaveLength(2);
    socketAt(sockets, 1).fireMessage(hello());
    expect(socketAt(sockets, 1).lastSent()).toEqual({
      op: 6,
      d: { token: 'QQBot AT', session_id: 'sid-1', seq: 7 },
    });
  });

  it('关闭码 4006（session 失效）→ 重新 Identify 而不是 Resume', async () => {
    const { sockets } = setup();
    const gateway = createGateway({
      getGatewayUrl: async () => 'wss://fake/websocket',
      getToken: async () => 'AT',
      intents: 1,
      onEvent: () => undefined,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoff: { baseMs: 1000, maxMs: 60_000 },
    });
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready(3));
    socketAt(sockets, 0).fireClose(4006);

    await advance(1000);
    socketAt(sockets, 1).fireMessage(hello());
    expect(socketAt(sockets, 1).lastSent()?.['op']).toBe(2);
  });

  it('未知关闭码 → 重连并重新 Identify', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready(3));
    socketAt(sockets, 0).fireClose(4999);

    await advance(1000);
    socketAt(sockets, 1).fireMessage(hello());
    expect(socketAt(sockets, 1).lastSent()?.['op']).toBe(2);
  });

  it('没有 session 时即使 4009 也只能 Identify', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello()); // 还没 READY
    socketAt(sockets, 0).fireClose(4009);

    await advance(1000);
    socketAt(sockets, 1).fireMessage(hello());
    expect(socketAt(sockets, 1).lastSent()?.['op']).toBe(2);
    // 这是第 2 次连接，所以状态是 reconnecting 而不是 connecting
    expect(gateway.getState()).toBe('reconnecting');
  });
});

describe('不可重试的关闭码', () => {
  it('4014（intent 无权限）→ 停止、回调致命错误、不再重连', async () => {
    const { gateway, sockets, fatals } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireClose(4014, 'intent 无权限');

    expect(gateway.getState()).toBe('stopped');
    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.message).toMatch(/权限/);

    await advance(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('4915（封禁）→ 停止', async () => {
    const { gateway, sockets, fatals } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireClose(4915);

    expect(gateway.getState()).toBe('stopped');
    expect(fatals[0]?.message).toMatch(/封禁/);
  });

  it('4013（intent 无效）→ 停止', async () => {
    const { gateway, sockets, fatals } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireClose(4013);
    expect(gateway.getState()).toBe('stopped');
    expect(fatals).toHaveLength(1);
  });
});

describe('服务端 op 信号', () => {
  it('op 7 → 重连并 resume', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready(4));
    socketAt(sockets, 0).fireMessage({ op: OP.RECONNECT });

    expect(gateway.getState()).toBe('reconnecting');
    await advance(1000);
    socketAt(sockets, 1).fireMessage(hello());
    expect(socketAt(sockets, 1).lastSent()?.['op']).toBe(6);
  });

  it('op 9 → 重连并重新 identify', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready(4));
    socketAt(sockets, 0).fireMessage({ op: OP.INVALID_SESSION });

    await advance(1000);
    socketAt(sockets, 1).fireMessage(hello());
    expect(socketAt(sockets, 1).lastSent()?.['op']).toBe(2);
  });
});

describe('退避', () => {
  it('每次重连等待翻倍', async () => {
    const { sockets, gateway, states } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireClose(4999);
    expect(states[states.length - 1]).toEqual(['reconnecting', '1000 ms 后重连（第 1 次）']);

    await advance(1000);
    socketAt(sockets, 1).fireClose(4999);
    expect(states[states.length - 1]).toEqual(['reconnecting', '2000 ms 后重连（第 2 次）']);

    await advance(2000);
    socketAt(sockets, 2).fireClose(4999);
    expect(states[states.length - 1]).toEqual(['reconnecting', '4000 ms 后重连（第 3 次）']);
  });

  it('READY 后重试计数归零（恢复后再次断线从 1 秒起）', async () => {
    const { sockets, gateway, states } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireClose(4999);
    await advance(1000);
    socketAt(sockets, 1).fireMessage(hello());
    socketAt(sockets, 1).fireMessage(ready());
    socketAt(sockets, 1).fireClose(4999);

    expect(states[states.length - 1]).toEqual(['reconnecting', '1000 ms 后重连（第 1 次）']);
  });
});

describe('健壮性', () => {
  it('取网关地址失败不抛异常，进入退避重试', async () => {
    const { gateway, warns, sockets, states } = setup({
      getGatewayUrl: async () => {
        throw new Error('网络不可达');
      },
    });
    await gateway.start();

    expect(gateway.getState()).toBe('reconnecting');
    expect(sockets).toHaveLength(0);
    expect(warns.some((w) => w.includes('网络不可达'))).toBe(true);
    expect(states[states.length - 1]?.[1]).toContain('1000 ms');
  });

  it('【关键】陈旧 socket 的回调不会触发多余的重连', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireClose(4009);
    await advance(1000);

    expect(sockets).toHaveLength(2);

    // 旧 socket 再吐一次 close（真实场景里很常见：关闭事件晚于新连接建立）
    socketAt(sockets, 0).fireClose(4009);
    expect(sockets).toHaveLength(2);

    await advance(5000);
    expect(sockets).toHaveLength(2);
    expect(gateway.getState()).toBe('reconnecting');
  });

  it('stop 之后不再重连，也不会新建连接', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    socketAt(sockets, 0).fireMessage(hello());
    socketAt(sockets, 0).fireMessage(ready());

    gateway.stop();
    expect(gateway.getState()).toBe('stopped');
    expect(socketAt(sockets, 0).closed).toBe(true);

    await advance(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('stop 后 start 可以重新开始（用户手动重连）', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    gateway.stop();
    await gateway.start();

    expect(sockets).toHaveLength(2);
    expect(gateway.getState()).toBe('connecting');
  });

  it('重复 start 不会叠加连接', async () => {
    const { sockets, gateway } = setup();
    await gateway.start();
    await gateway.start();
    await gateway.start();
    expect(sockets).toHaveLength(1);
  });
});
