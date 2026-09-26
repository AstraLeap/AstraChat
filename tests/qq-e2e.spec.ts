import { afterEach, describe, expect, it } from 'vitest';
import { startFakeQqServer, type FakeQqServer } from './helpers/fake-qq-server';
import { createQqConnection, type QqConnection } from '../electron/qq/connection';
import { createQqHttp } from '../electron/qq/http';
import { createQqService } from '../electron/qq/service';
import { createQqStack } from '../electron/qq/setup';
import { openDatabase } from '../src/db/index';
import { saveQqConfig } from '../src/db/qq';
import { recordQqContactSeen, setQqContactPolicy } from '../src/db/qq-contacts';
import type { QqConfig } from '../src/types/index';

/**
 * 端到端测试：假 QQ 服务端 → 真 HTTP → 真全局 `WebSocket` → 网关状态机
 * → 事件解析 → 授权判定 → 编排 → 真的 POST 回发送接口。
 *
 * ## 这层测试补的是什么
 *
 * 前面每个模块都有单测，但**模块之间的接缝**只有在整条链路里才会暴露：
 * 网关给 `onEvent` 的信封形状对不对、`intents` 有没有真的传到 Identify、
 * 机器人 id 有没有从 READY 接到 `addressedToBot` 的判定上、
 * 发送用的是不是 `group_openid` 而不是发送者 id。
 *
 * 而且它**不需要任何真实凭据**，所以每次改代码都能跑；真账号只能验证
 * 「官方接受我们的请求」，跑不了这类回归。
 *
 * 网关用的是真实的全局 `WebSocket`（不是注入的假 socket），服务端是手写的
 * RFC6455 实现（`tests/helpers/fake-qq-server.ts`），因此连握手与帧编解码都是真的。
 */

/** 当前启动的服务端，afterEach 统一关闭。 */
let server: FakeQqServer | null = null;
/** 当前建立的连接，afterEach 统一停止。 */
let connection: QqConnection | null = null;

afterEach(async () => {
  connection?.stop();
  connection = null;
  await server?.close();
  server = null;
});

/**
 * 轮询等待一个条件成立。
 *
 * @param predicate 条件。
 * @param timeoutMs 超时。
 * @param what 描述（超时报错用）。
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${what}`);
}

/** 造一份开启的 QQ 配置。 */
function makeConfig(): QqConfig {
  return {
    id: 'default',
    appId: 'APP',
    appSecret: 'SECRET',
    token: '',
    enabled: true,
    status: 'connected',
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
    socialMode: 'off',
    socialCooldownMs: 60_000,
    socialMaxPerHour: 6,
    updatedAt: 0,
  };
}

/** 一条群消息事件的 `d`。 */
function groupData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'EVENT_MSG_ID',
    author: {
      id: 'AUTHOR',
      member_openid: 'MEMBER_OPENID',
      member_role: 'member',
      username: '小明',
    },
    content: '你好',
    group_openid: 'GROUP_OPENID',
    timestamp: '2026-07-21T10:00:00+08:00',
    ...overrides,
  };
}

/** 搭起整条链路（连接 + 编排）。 */
function wire(current: FakeQqServer, reply = '你好呀，我是假机器人'): {
  connection: QqConnection;
  service: ReturnType<typeof createQqService>;
} {
  const httpFor = (options: { appId: string; appSecret: string }) =>
    createQqHttp({ ...options, baseUrl: current.baseUrl });

  const service = createQqService({
    getConfig: makeConfig,
    getContactPolicy: () => ({ policy: 'allow', allowedCount: 1 }),
    recordContactSeen: () => undefined,
    generateReply: async () => reply,
    executeCommand: async () => '命令结果',
    send: async (kind, openId, message) => {
      const client = httpFor({ appId: 'APP', appSecret: 'SECRET' });
      return kind === 'group'
        ? client.sendGroup(openId, message)
        : client.sendPrivate(openId, message);
    },
    // 机器人 id 来自 READY，接到全量群消息「有没有 @ 我」的判定上
    getBotId: () => connectionRef?.getState().botId ?? null,
  });

  const connection = createQqConnection({
    getConfig: () => ({ appId: 'APP', appSecret: 'SECRET', intents: 1 << 25, sandbox: false }),
    createHttp: httpFor,
    onEvent: (payload) => {
      void service.handleInbound(payload);
    },
    onState: () => undefined,
  });

  connectionRef = connection;
  return { connection, service };
}

/** 让 `getBotId` 能读到当前连接（避免闭包顺序问题）。 */
let connectionRef: QqConnection | null = null;

describe('HTTP 客户端对着假服务端', () => {
  it('取凭证与网关信息（网关地址指向假服务端的 WS 端点）', async () => {
    server = await startFakeQqServer();
    const client = createQqHttp({ appId: 'APP', appSecret: 'SECRET', baseUrl: server.baseUrl });

    await expect(client.getAccessToken()).resolves.toBe('FAKE_ACCESS_TOKEN');
    const info = await client.getGatewayInfo();
    expect(info.url).toBe(server.wsUrl);
  });
});

describe('端到端：收到群消息 → 回复真的发出去', () => {
  it('真 WebSocket 握手、Identify 带上配置的 intents、回复 POST 到正确路径', async () => {
    server = await startFakeQqServer();
    const wired = wire(server);
    connection = wired.connection;
    const current = server;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'connected', '连接就绪');

    // Identify 真的发出去了，且 intents 是配置里的值
    expect(current.identify).not.toBeNull();
    expect(current.identify?.['token']).toBe('QQBot FAKE_ACCESS_TOKEN');
    expect(current.identify?.['intents']).toBe(1 << 25);

    // 推送一条 @ 机器人的群消息
    current.pushEvent('GROUP_AT_MESSAGE_CREATE', groupData());

    await waitFor(() => current.sent.length > 0, '收到回复');
    expect(current.sent[0]?.path).toBe('/v2/groups/GROUP_OPENID/messages');
    // 被动回复：带事件的 msg_id，msg_seq 从 1 开始
    expect(current.sent[0]?.body).toEqual({
      msg_type: 0,
      content: '你好呀，我是假机器人',
      msg_id: 'EVENT_MSG_ID',
      msg_seq: 1,
    });
  });

  it('【全量模式】机器人 id 来自 READY，mentions 命中时才算被指向', async () => {
    server = await startFakeQqServer();
    const wired = wire(server);
    connection = wired.connection;
    const current = server;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'connected', '连接就绪');
    expect(connection.getState().botId).toBe('FAKE_BOT_ID');

    // 全量群消息，mentions 里没有机器人 → 不该回
    current.pushEvent('GROUP_MESSAGE_CREATE', groupData({ id: 'M1' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(current.sent).toHaveLength(0);

    // 全量群消息，mentions 命中机器人 → 该回
    current.pushEvent(
      'GROUP_MESSAGE_CREATE',
      groupData({ id: 'M2', mentions: [{ id: 'FAKE_BOT_ID', username: '假机器人' }] }),
    );
    await waitFor(() => current.sent.length > 0, '收到回复');
    expect(current.sent[0]?.body['msg_id']).toBe('M2');
  });

  it('私聊走 /v2/users/{openid}/messages', async () => {
    server = await startFakeQqServer();
    const wired = wire(server);
    connection = wired.connection;
    const current = server;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'connected', '连接就绪');

    current.pushEvent('C2C_MESSAGE_CREATE', {
      id: 'C2C_MSG',
      author: { id: 'AUTHOR', user_openid: 'USER_OPENID', username: '小红' },
      content: '在吗',
      timestamp: '2026-07-21T10:00:00+08:00',
    });

    await waitFor(() => current.sent.length > 0, '收到回复');
    expect(current.sent[0]?.path).toBe('/v2/users/USER_OPENID/messages');
    expect(current.sent[0]?.body['msg_id']).toBe('C2C_MSG');
  });

  it('审计拦下的回复不会发出去', async () => {
    server = await startFakeQqServer();
    const wired = wire(server, '文件在 C:\\Users\\a\\b.txt');
    connection = wired.connection;
    const current = server;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'connected', '连接就绪');
    current.pushEvent('GROUP_AT_MESSAGE_CREATE', groupData());

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(current.sent).toHaveLength(0);
  });
});

describe('端到端：失败与恢复', () => {
  it('【关键】intents 无权限（4014）时连接进入 error 并带上可操作原因', async () => {
    server = await startFakeQqServer({ rejectWithCode: 4014 });
    const wired = wire(server);
    connection = wired.connection;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'error', '进入错误状态');

    const status = connection.getState();
    expect(status.message).toContain('4014');
    // 不可重试：不该反复建连接
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(connection.getState().state).toBe('error');
    expect(server.clientCount()).toBe(0);
  });

  it('被服务端断开（4009）后自动重连并发送 Resume', async () => {
    server = await startFakeQqServer();
    const wired = wire(server);
    connection = wired.connection;
    const current = server;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'connected', '连接就绪');

    current.dropClients(4009);

    // 重连后应带会话信息走 Resume（而不是重新 Identify）
    await waitFor(() => current.resume !== null, '收到 Resume', 10_000);
    expect(current.resume?.['session_id']).toBe('FAKE_SESSION');
    await waitFor(() => connection?.getState().state === 'connected', '重连就绪', 10_000);
  });

  it('心跳被服务端确认（ACK）', async () => {
    server = await startFakeQqServer({ heartbeatIntervalMs: 100 });
    const wired = wire(server);
    connection = wired.connection;

    await connection.start();
    await waitFor(() => connection?.getState().state === 'connected', '连接就绪');
    await waitFor(() => (server?.heartbeats ?? 0) > 0, '收到心跳', 5000);

    expect(server.heartbeats).toBeGreaterThan(0);
    // 心跳被确认 → 不会因为「连续未确认」被误判断线
    expect(connection.getState().state).toBe('connected');
  });
});

describe('【核心】整条链路：真实 setup 栈 + 内存数据库 + 假模型', () => {
  it('群消息 → 授权 → 会话装配 → 模型 → 出站管线 → 真的发出去', async () => {
    server = await startFakeQqServer({ modelReply: '模型回复：你好' });
    const current = server;

    // 真实数据库（内存），配置与授权都配好 —— 这一层不再是手写的假依赖
    const db = openDatabase(':memory:');
    saveQqConfig(db, {
      appId: 'APP',
      appSecret: 'SECRET',
      intents: 1 << 25,
      enabled: true,
      replyInPrivate: true,
      auditEnabled: true,
    });
    recordQqContactSeen(db, { openId: 'GROUP_OPENID', kind: 'group', displayName: '测试群' });
    setQqContactPolicy(db, 'GROUP_OPENID', 'allow');

    const stack = createQqStack({
      db,
      onStatus: () => undefined,
      getSystemPrompt: () => '你是群友。',
      // 模型也指向假服务端：它同时提供 /chat/completions
      getProvider: () => ({ baseUrl: current.baseUrl, apiKey: '', model: 'fake-model' }),
      createHttp: (options) => createQqHttp({ ...options, baseUrl: current.baseUrl }),
      log: () => undefined,
    });

    await stack.start();
    await waitFor(() => stack.getStatus().state === 'connected', '连接就绪');

    current.pushEvent('GROUP_AT_MESSAGE_CREATE', groupData({ content: '你好' }));

    // ① 模型真的被调用了，且 prompt 是拼对的
    await waitFor(() => current.chatRequests.length > 0, '模型收到请求');
    const messages = current.chatRequests[0]?.['messages'] as
      | { role: string; content: string }[]
      | undefined;
    expect(messages?.[0]).toEqual({ role: 'system', content: '你是群友。' });
    expect(messages?.[messages.length - 1]).toEqual({ role: 'user', content: '小明：你好' });

    // ② 分段增量被拼成完整回复，并经出站管线发出去
    await waitFor(() => current.sent.length > 0, '收到回复');
    expect(current.sent[0]?.path).toBe('/v2/groups/GROUP_OPENID/messages');
    expect(current.sent[0]?.body).toEqual({
      msg_type: 0,
      content: '模型回复：你好',
      msg_id: 'EVENT_MSG_ID',
      msg_seq: 1,
    });

    stack.stop();
  });

  it('未授权来源不会触达模型', async () => {
    server = await startFakeQqServer({ modelReply: '不该出现' });
    const current = server;

    const db = openDatabase(':memory:');
    saveQqConfig(db, { enabled: true, appId: 'APP', appSecret: 'SECRET', intents: 1 << 25 });
    // 见过但**不授权**
    recordQqContactSeen(db, { openId: 'GROUP_OPENID', kind: 'group' });

    const stack = createQqStack({
      db,
      onStatus: () => undefined,
      getSystemPrompt: () => '你是群友。',
      getProvider: () => ({ baseUrl: current.baseUrl, apiKey: '', model: 'fake-model' }),
      createHttp: (options) => createQqHttp({ ...options, baseUrl: current.baseUrl }),
      log: () => undefined,
    });

    await stack.start();
    await waitFor(() => stack.getStatus().state === 'connected', '连接就绪');
    current.pushEvent('GROUP_AT_MESSAGE_CREATE', groupData());

    // 给它足够时间「如果会发就发了」
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(current.chatRequests).toHaveLength(0);
    expect(current.sent).toHaveLength(0);

    stack.stop();
  });

  it('命中审计的内容不会发出去（模型说了本机路径）', async () => {
    server = await startFakeQqServer({ modelReply: '文件在 C:\\Users\\a\\b.txt' });
    const current = server;

    const db = openDatabase(':memory:');
    saveQqConfig(db, {
      enabled: true,
      appId: 'APP',
      appSecret: 'SECRET',
      intents: 1 << 25,
      auditEnabled: true,
    });
    recordQqContactSeen(db, { openId: 'GROUP_OPENID', kind: 'group' });
    setQqContactPolicy(db, 'GROUP_OPENID', 'allow');

    const stack = createQqStack({
      db,
      onStatus: () => undefined,
      getSystemPrompt: () => '你是群友。',
      getProvider: () => ({ baseUrl: current.baseUrl, apiKey: '', model: 'fake-model' }),
      createHttp: (options) => createQqHttp({ ...options, baseUrl: current.baseUrl }),
      log: () => undefined,
    });

    await stack.start();
    await waitFor(() => stack.getStatus().state === 'connected', '连接就绪');
    current.pushEvent('GROUP_AT_MESSAGE_CREATE', groupData());

    await waitFor(() => current.chatRequests.length > 0, '模型被调用了');
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 模型回了，但审计拦下 → 一条都不发
    expect(current.sent).toHaveLength(0);

    stack.stop();
  });
});
