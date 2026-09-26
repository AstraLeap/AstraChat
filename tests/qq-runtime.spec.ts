import { describe, expect, it } from 'vitest';
import { conversationKeyOf, createQqRuntime, type QqRuntimeHttp } from '../electron/qq/runtime';
import type { QqConnectionStatus } from '../electron/qq/connection';
import type { GatewayDeps, GatewayState, QqGateway } from '../src/services/qq/gateway';
import type { QqInbound } from '../src/services/qq/events';
import type { OutboundMessage } from '../src/services/qq/send';
import type { GatewayInfo } from '../src/services/qq/protocol';
import type { QqConfig } from '../src/types/index';

/**
 * QQ 运行时的测试。
 *
 * 这一层是「配置 → 连接 → 编排 → 状态出口」的装配处，容易出的错都不是算法错，
 * 而是**接线错**：配置有没有真的传到 Identify、状态有没有真的流出去、
 * 会话键拼得对不对、状态重复上报会不会把界面刷爆。所以断言都落在这些接线上。
 */

/** 造配置。 */
function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    id: 'default',
    appId: 'APP',
    appSecret: 'SECRET',
    token: '',
    enabled: true,
    status: 'disconnected',
    statusMessage: null,
    intents: 1 << 25,
    sandbox: false,
    ownerOpenIds: [],
    allowAllWhenEmpty: false,
    replyInPrivate: true,
    auditEnabled: true,
    sendDelayMs: 0,
    maxSendPerMinute: 100,
    maxSendPerHour: 100,
    maxReplyChars: 4000,
    updatedAt: 0,
    ...overrides,
  };
}

/** 假网关。 */
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
    deps: (): GatewayDeps => {
      if (captured === null) {
        throw new Error('网关还没创建');
      }
      return captured;
    },
    created: () => captured !== null,
  };
}

/** 一条被记录下来的发送。 */
interface SendRecord {
  kind: string;
  openId: string;
  message: OutboundMessage;
}

/**
 * 假 HTTP 客户端（支持发送，并记录发出去的消息）。
 *
 * **必须带 sendGroup/sendPrivate** —— 少了这两个方法时，service 的防御性 catch
 * 会把 `undefined is not a function` 吞掉，表现为「消息永远发不出去」
 * 而测试全绿。所以这里的发送记录要真的断言。
 *
 * @param sends 发送记录收集器。
 * @returns createHttp 工厂。
 */
function fakeHttp(sends: SendRecord[]) {
  return (_options: { appId: string; appSecret: string }): QqRuntimeHttp => ({
    getAccessToken: async () => 'AT',
    getGatewayInfo: async (): Promise<GatewayInfo> => ({
      url: 'wss://fake/websocket',
      shards: 1,
      sessionStartLimit: null,
    }),
    sendGroup: async (openId, message) => {
      sends.push({ kind: 'group', openId, message });
      return { ok: true, messageId: 'SENT', timestamp: null, refIdx: null };
    },
    sendPrivate: async (openId, message) => {
      sends.push({ kind: 'private', openId, message });
      return { ok: true, messageId: 'SENT', timestamp: null, refIdx: null };
    },
  });
}

/** 搭一套被测环境。 */
function setup(configOverrides: Partial<QqConfig> = {}) {
  const gateway = makeFakeGateway();
  const statuses: QqConnectionStatus[] = [];
  const replies: { key: string; text: string; role: string }[] = [];
  const logs: string[] = [];
  const seen: { openId: string; kind: string }[] = [];
  const sends: SendRecord[] = [];
  let config = makeConfig(configOverrides);

  const runtime = createQqRuntime({
    loadConfig: () => config,
    lookupContact: () => ({ policy: 'allow', allowedCount: 1 }),
    recordContactSeen: (input) => {
      seen.push({ openId: input.openId, kind: input.kind });
    },
    generateReply: async (key, message, role) => {
      replies.push({ key, text: message.content, role });
      return '模型回复';
    },
    executeCommand: async () => '命令结果',
    onStatus: (status) => {
      statuses.push(status);
    },
    log: (message) => logs.push(message),
    createHttp: fakeHttp(sends),
    createGateway: gateway.factory,
  });

  return {
    runtime,
    gateway,
    statuses,
    replies,
    logs,
    seen,
    sends,
    setConfig: (next: Partial<QqConfig>) => {
      config = makeConfig(next);
    },
    getConfig: () => config,
  };
}

/** 一条群消息事件。 */
function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'E',
    op: 0,
    s: 1,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'MSG',
      author: { member_openid: 'MEMBER', member_role: 'member', username: '小明' },
      content: '你好',
      group_openid: 'GROUP_OPENID',
      ...overrides,
    },
  };
}

describe('会话键', () => {
  it('群与私聊拼出不同的前缀', () => {
    expect(conversationKeyOf({ kind: 'group', openId: 'G' })).toBe('group:G');
    expect(conversationKeyOf({ kind: 'private', openId: 'U' })).toBe('private:U');
  });
});

describe('装配', () => {
  it('start 把配置传给连接（intents 真的进了 Identify 前的网关依赖）', async () => {
    const ctx = setup({ intents: 1 << 25 });
    await ctx.runtime.start();

    expect(ctx.gateway.created()).toBe(true);
    expect(ctx.gateway.deps().intents).toBe(1 << 25);
    expect(ctx.gateway.calls).toEqual(['start']);
  });

  it('配置不全时形成 error 状态并上报，且不创建网关', async () => {
    const ctx = setup({ appId: '' });
    await ctx.runtime.start();

    expect(ctx.runtime.getStatus().state).toBe('error');
    expect(ctx.gateway.created()).toBe(false);
    expect(ctx.statuses.some((item) => item.state === 'error')).toBe(true);
  });

  it('restart 会重新读配置（AppID 改了要生效）', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    const created: string[] = [];
    // 换一个记录 appId 的 HTTP 工厂再重启
    const runtime = createQqRuntime({
      loadConfig: () => ctx.getConfig(),
      lookupContact: () => ({ policy: 'allow', allowedCount: 1 }),
      recordContactSeen: () => undefined,
      generateReply: async () => 'x',
      executeCommand: async () => 'x',
      onStatus: () => undefined,
      createHttp: (options) => {
        created.push(options.appId);
        return fakeHttp([])(options);
      },
      createGateway: ctx.gateway.factory,
    });

    ctx.setConfig({ appId: 'NEW_APP' });
    await runtime.restart();
    expect(created).toEqual(['NEW_APP']);
  });
});

describe('状态出口', () => {
  it('连接状态变化会流到 onStatus', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onStateChange?.('connected', '已就绪');
    expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
      state: 'connected',
      message: '已就绪',
      botId: null,
    });
  });

  it('READY 之后的状态带上机器人 id（界面要显示名字）', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onReady?.({ sessionId: 'sid', userId: 'BOT_ID', username: '笙澜' });
    ctx.gateway.deps().onStateChange?.('connected', '已就绪');
    expect(ctx.statuses[ctx.statuses.length - 1]?.botId).toBe('BOT_ID');
  });

  it('【关键】完全相同的状态不重复上报（否则界面会被刷爆）', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onStateChange?.('connected', '已就绪');
    const after = ctx.statuses.length;
    ctx.gateway.deps().onStateChange?.('connected', '已就绪');
    ctx.gateway.deps().onStateChange?.('connected', '已就绪');

    expect(ctx.statuses).toHaveLength(after);
  });

  it('状态内容变了就要上报（去重不能把真实变化吞掉）', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onStateChange?.('connected', '已就绪');
    const after = ctx.statuses.length;
    ctx.gateway.deps().onStateChange?.('reconnecting', '1000 ms 后重连（第 1 次）');

    expect(ctx.statuses.length).toBeGreaterThan(after);
    expect(ctx.statuses[ctx.statuses.length - 1]?.state).toBe('connecting');
  });

  it('onStatus 抛异常不会打断连接', async () => {
    const gateway = makeFakeGateway();
    const logs: string[] = [];
    const runtime = createQqRuntime({
      loadConfig: makeConfig,
      lookupContact: () => ({ policy: 'allow', allowedCount: 1 }),
      recordContactSeen: () => undefined,
      generateReply: async () => 'x',
      executeCommand: async () => 'x',
      onStatus: () => {
        throw new Error('界面已销毁');
      },
      log: (message) => logs.push(message),
      createHttp: fakeHttp([]),
      createGateway: gateway.factory,
    });

    await runtime.start();
    gateway.deps().onStateChange?.('connected', '已就绪');

    expect(logs.some((line) => line.includes('界面已销毁'))).toBe(true);
  });

  it('stop 会以 stopped 状态上报', async () => {
    const ctx = setup();
    await ctx.runtime.start();
    ctx.runtime.stop();

    expect(ctx.runtime.getStatus().state).toBe('stopped');
    expect(ctx.statuses[ctx.statuses.length - 1]?.state).toBe('stopped');
    expect(ctx.gateway.calls).toEqual(['start', 'stop']);
  });
});

describe('事件到编排的接线上', () => {
  it('网关事件会走到模型，且带正确的会话键', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onEvent({
      id: 'E',
      op: 0,
      s: 1,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: { id: 'MSG', author: { member_openid: 'M' }, content: '你好', group_openid: 'G' },
    } as never);

    // handleInbound 是 async，等一个宏任务让它跑完
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]?.key).toBe('group:G');
    expect(ctx.replies[0]?.text).toBe('你好');
  });

  it('私聊事件用私聊的会话键', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onEvent({
      id: 'E',
      op: 0,
      s: 1,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'MSG', author: { user_openid: 'U' }, content: '在吗' },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.replies[0]?.key).toBe('private:U');
  });

  it('【回归】回复真的通过 HTTP 客户端发出去了（send 不能漏接）', async () => {
    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onEvent(groupEvent() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 这条用例的存在理由：漏接 send 时 service 的防御性 catch 会把
    // 「undefined is not a function」吞掉，表现为「消息永远发不出去」而其它用例全绿。
    // 所以必须断言真的有一条发送发生在正确的目标上。
    expect(ctx.sends).toHaveLength(1);
    expect(ctx.sends[0]?.kind).toBe('group');
    expect(ctx.sends[0]?.openId).toBe('GROUP_OPENID');
    expect(ctx.sends[0]?.message).toMatchObject({
      content: '模型回复',
      msgId: 'MSG',
      msgSeq: 1,
    });
  });

  it('来源被记录进「已发现的来源」', async () => {    const ctx = setup();
    await ctx.runtime.start();

    ctx.gateway.deps().onEvent(groupEvent() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.seen).toEqual([{ openId: 'GROUP_OPENID', kind: 'group' }]);
  });

  it('管理员身份随事件传给模型（管理命令与角色提示要靠它）', async () => {
    const ctx = setup({ ownerOpenIds: ['MEMBER'] });
    await ctx.runtime.start();

    ctx.gateway.deps().onEvent(groupEvent() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.replies[0]?.role).toBe('owner');
  });

  it('模型回复为空时不报错也不崩', async () => {
    const gateway = makeFakeGateway();
    const runtime = createQqRuntime({
      loadConfig: makeConfig,
      lookupContact: () => ({ policy: 'allow', allowedCount: 1 }),
      recordContactSeen: () => undefined,
      generateReply: async () => '',
      executeCommand: async () => 'x',
      onStatus: () => undefined,
      createHttp: fakeHttp([]),
      createGateway: gateway.factory,
    });

    await runtime.start();
    gateway.deps().onEvent(groupEvent() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getStatus()).toBeDefined();
  });
});

describe('类型自查：会话键用的字段不能错', () => {
  it('QqInbound 的 kind/openId 就是拼键依据', () => {
    const sample: Pick<QqInbound, 'kind' | 'openId'> = { kind: 'group', openId: 'X' };
    expect(conversationKeyOf(sample)).toBe('group:X');
  });
});
