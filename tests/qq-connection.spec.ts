import { describe, expect, it } from 'vitest';
import {
  createQqConnection,
  type QqConnection,
  type QqConnectionHttp,
} from '../electron/qq/connection';
import type { GatewayDeps, QqGateway, GatewayState } from '../src/services/qq/gateway';
import type { GatewayInfo, GatewayPayload } from '../src/services/qq/protocol';

/**
 * 连接管理器的测试。
 *
 * 这一层是设置页显示内容的**唯一来源**（状态 / 说明 / 机器人 id）。它自己不含判定逻辑，
 * 只负责把配置 → HTTP 客户端 → 网关状态机组合起来，所以测试的重点是**组合关系**：
 * 配置有没有真的传下去、状态有没有真的传上来、重复 start 会不会建出两条连接。
 */

/** 造一个可驱动的假网关。 */
function makeFakeGateway() {
  const calls: string[] = [];
  let captured: GatewayDeps | null = null;

  const gateway: QqGateway = {
    start: async () => {
      calls.push('start');
    },
    stop: () => {
      calls.push('stop');
    },
    getState: () => 'idle' as GatewayState,
  };

  return {
    factory: (deps: GatewayDeps): QqGateway => {
      captured = deps;
      return gateway;
    },
    calls,
    /** 取被捕获的网关依赖，用来模拟网关回调。 */
    deps: (): GatewayDeps => {
      if (captured === null) {
        throw new Error('网关还没被创建');
      }
      return captured;
    },
    /** 网关是否已创建。 */
    created: () => captured !== null,
  };
}

/** 造一个假 HTTP 客户端。 */
function makeFakeHttp(overrides: Partial<QqConnectionHttp> = {}) {
  const created: { appId: string; appSecret: string }[] = [];
  return {
    created,
    create: (options: { appId: string; appSecret: string }): QqConnectionHttp => {
      created.push(options);
      return {
        getAccessToken: async () => 'AT',
        getGatewayInfo: async (): Promise<GatewayInfo> => ({
          url: 'wss://fake/websocket',
          shards: 1,
          sessionStartLimit: null,
        }),
        ...overrides,
      };
    },
  };
}

/** 搭一套被测环境。 */
function setup(configOverrides: Record<string, unknown> = {}) {
  const gateway = makeFakeGateway();
  const http = makeFakeHttp();
  const events: GatewayPayload[] = [];
  const states: [string, string][] = [];
  const logs: string[] = [];

  const connection: QqConnection = createQqConnection({
    getConfig: () => ({
      appId: 'APP_ID',
      appSecret: 'SECRET',
      intents: 1 << 25,
      sandbox: false,
      ...configOverrides,
    }),
    createHttp: http.create,
    createGateway: gateway.factory,
    onEvent: (payload) => events.push(payload),
    onState: (state, message) => states.push([state, message]),
    log: (message) => logs.push(message),
  });

  return { connection, gateway, http, events, states, logs };
}

describe('初始状态', () => {
  it('未启动时是 stopped', () => {
    const ctx = setup();
    const status = ctx.connection.getState();
    expect(status.state).toBe('stopped');
    expect(status.botId).toBeNull();
  });
});

describe('启动', () => {
  it('用配置创建 HTTP 客户端与网关，并启动网关', async () => {
    const ctx = setup();
    await ctx.connection.start();

    expect(ctx.http.created).toEqual([{ appId: 'APP_ID', appSecret: 'SECRET' }]);
    expect(ctx.gateway.created()).toBe(true);
    expect(ctx.gateway.deps().intents).toBe(1 << 25);
    expect(ctx.gateway.calls).toEqual(['start']);
  });

  it('网关地址与凭证都从 HTTP 客户端取（不硬编码域名）', async () => {
    const ctx = setup();
    await ctx.connection.start();

    await expect(ctx.gateway.deps().getGatewayUrl()).resolves.toBe('wss://fake/websocket');
    await expect(ctx.gateway.deps().getToken()).resolves.toBe('AT');
  });

  it('重复 start 不会建出第二条连接', async () => {
    const ctx = setup();
    await ctx.connection.start();
    await ctx.connection.start();

    expect(ctx.gateway.calls).toEqual(['start']);
  });

  it('业务事件被转发给 onEvent', async () => {
    const ctx = setup();
    await ctx.connection.start();

    const payload: GatewayPayload = { id: 'e', op: 0, s: 1, t: 'GROUP_AT_MESSAGE_CREATE', d: {} };
    ctx.gateway.deps().onEvent(payload);

    expect(ctx.events).toEqual([payload]);
  });
});

describe('状态上报', () => {
  it('网关进入 connected 时上报已连接', async () => {
    const ctx = setup();
    await ctx.connection.start();

    ctx.gateway.deps().onStateChange?.('connected', '已就绪');
    expect(ctx.connection.getState().state).toBe('connected');
    expect(ctx.states[ctx.states.length - 1]?.[0]).toBe('connected');
  });

  it('收到 READY 时记下机器人 id（界面要显示名字）', async () => {
    const ctx = setup();
    await ctx.connection.start();

    ctx.gateway.deps().onReady?.({
      sessionId: 'sid',
      userId: 'BOT_ID',
      username: '笙澜',
    });

    expect(ctx.connection.getState().botId).toBe('BOT_ID');
  });

  it('reconnecting 对外仍显示为连接中', async () => {
    const ctx = setup();
    await ctx.connection.start();

    ctx.gateway.deps().onStateChange?.('reconnecting', '1000 ms 后重连（第 1 次）');
    expect(ctx.connection.getState().state).toBe('connecting');
  });

  it('【关键】致命错误上报为 error 并带上可操作的原因', async () => {
    const ctx = setup();
    await ctx.connection.start();

    ctx.gateway.deps().onFatal?.(new Error('intent 无权限（4014），请到开放平台申请'));
    const status = ctx.connection.getState();

    expect(status.state).toBe('error');
    expect(status.message).toContain('4014');
  });

  it('警告只记日志，不把状态改成 error', async () => {
    const ctx = setup();
    await ctx.connection.start();
    ctx.gateway.deps().onStateChange?.('connected', '已就绪');

    ctx.gateway.deps().onWarn?.('连接关闭（4009）：会话失效');
    expect(ctx.connection.getState().state).toBe('connected');
    expect(ctx.logs.some((line) => line.includes('4009'))).toBe(true);
  });
});

describe('停止与重启', () => {
  it('stop 会停掉网关并上报 stopped', async () => {
    const ctx = setup();
    await ctx.connection.start();
    ctx.connection.stop();

    expect(ctx.gateway.calls).toEqual(['start', 'stop']);
    expect(ctx.connection.getState().state).toBe('stopped');
  });

  it('stop 后可以再 start（用户手动重连）', async () => {
    const ctx = setup();
    await ctx.connection.start();
    ctx.connection.stop();
    await ctx.connection.start();

    expect(ctx.gateway.calls).toEqual(['start', 'stop', 'start']);
  });

  it('【关键】restart 会重新读配置（用户改了 AppID 要生效）', async () => {
    let appId = 'OLD_APP';
    const gateway = makeFakeGateway();
    const http = makeFakeHttp();

    const connection = createQqConnection({
      getConfig: () => ({ appId, appSecret: 'SECRET', intents: 1, sandbox: false }),
      createHttp: http.create,
      createGateway: gateway.factory,
      onEvent: () => undefined,
      onState: () => undefined,
    });

    await connection.start();
    appId = 'NEW_APP';
    await connection.restart();

    expect(http.created.map((item) => item.appId)).toEqual(['OLD_APP', 'NEW_APP']);
  });

  it('restart 时若已停止也能正常启动', async () => {
    const ctx = setup();
    await ctx.connection.restart();
    expect(ctx.gateway.calls).toEqual(['start']);
  });

  it('【回归】解构使用也不崩（restart 不能依赖 this）', async () => {
    const ctx = setup();
    const { restart, getState } = ctx.connection;
    await restart();
    expect(getState().state).toBe('connecting');
  });
});

describe('配置不全会拒绝启动而不是带着坏配置乱连', () => {
  it('缺 AppID 时上报 error 且不创建网关', async () => {
    const ctx = setup({ appId: '' });
    await ctx.connection.start();

    const status = ctx.connection.getState();
    expect(status.state).toBe('error');
    expect(status.message.length).toBeGreaterThan(0);
    expect(ctx.gateway.created()).toBe(false);
  });

  it('缺 ClientSecret 时同样拒绝', async () => {
    const ctx = setup({ appSecret: '' });
    await ctx.connection.start();
    expect(ctx.connection.getState().state).toBe('error');
    expect(ctx.gateway.created()).toBe(false);
  });

  it('intents 为 0 时拒绝启动（订阅不到任何事件）', async () => {
    const ctx = setup({ intents: 0 });
    await ctx.connection.start();
    expect(ctx.connection.getState().state).toBe('error');
    expect(ctx.gateway.created()).toBe(false);
  });
});
