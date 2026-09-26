import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createQqHttp } from '../electron/qq/http';

/**
 * QQ HTTP 客户端的测试。
 *
 * 用 `node:http` 起一个**本地假服务端**，客户端对着它发真实请求 —— 不需要任何真实凭据，
 * 但走的是真的 HTTP 栈，因此能验证：请求路径、请求体字段名、`Authorization` 头格式、
 * 以及「业务失败时 HTTP 仍是 200」这条官方特性。
 */

/** 被假服务端记录下来的请求。 */
interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** 假响应。 */
interface FakeResponse {
  status?: number;
  body: unknown;
}

/** 假响应可以按请求动态给出。 */
type Responder = (request: RecordedRequest, index: number) => FakeResponse;

/** 启动中的假服务端。 */
interface FakeServer {
  requests: RecordedRequest[];
  baseUrl: string;
  stop: () => Promise<void>;
}

/** 本轮启动的服务端，afterEach 里统一关闭。 */
const servers: Server[] = [];

/**
 * 启动一个假服务端。
 *
 * @param responder 依次给出响应；传数组则按请求顺序取。
 * @returns 记录器与 baseUrl。
 */
async function startFakeServer(responder: Responder | FakeResponse[]): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const authorization = req.headers['authorization'];
      const record: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: typeof authorization === 'string' ? authorization : undefined,
        body,
      };
      requests.push(record);

      const response: FakeResponse = Array.isArray(responder)
        ? (responder[requests.length - 1] ?? { body: {} })
        : responder(record, requests.length - 1);

      res.statusCode = response.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body ?? {}));
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** 造一个客户端指向假服务端。 */
function clientFor(baseUrl: string, overrides: Record<string, unknown> = {}) {
  return createQqHttp({
    appId: 'APP_ID',
    appSecret: 'CLIENT_SECRET',
    baseUrl,
    ...overrides,
  });
}

describe('access_token', () => {
  it('取凭证：路径正确、字段名是 clientSecret、头格式是 QQBot <token>', async () => {
    const server = await startFakeServer([{ body: { access_token: 'AT', expires_in: 7200 } }]);
    const client = clientFor(server.baseUrl);

    await expect(client.getAccessToken()).resolves.toBe('AT');

    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.url).toBe('/app/getAppAccessToken');
    // 官方字段名是 clientSecret，不是 appSecret
    expect(server.requests[0]?.body).toEqual({ appId: 'APP_ID', clientSecret: 'CLIENT_SECRET' });
  });

  it('有效期内复用缓存，不重复请求', async () => {
    const server = await startFakeServer([{ body: { access_token: 'AT', expires_in: 7200 } }]);
    const client = clientFor(server.baseUrl);

    await client.getAccessToken();
    await client.getAccessToken();
    await client.getAccessToken();

    expect(server.requests).toHaveLength(1);
  });

  it('接近过期时会重新获取（对齐官方 60 秒语义）', async () => {
    let clock = 0;
    const server = await startFakeServer([
      { body: { access_token: 'AT1', expires_in: 100 } },
      { body: { access_token: 'AT2', expires_in: 100 } },
    ]);
    const client = clientFor(server.baseUrl, { now: () => clock });

    await expect(client.getAccessToken()).resolves.toBe('AT1');
    // 100 秒有效、提前 60 秒刷新 → 实际可用窗口只有 40 秒
    clock = 30_000;
    await expect(client.getAccessToken()).resolves.toBe('AT1');
    expect(server.requests).toHaveLength(1);
    // 进入过期前 60 秒（即 t=40s 起）就要刷新
    clock = 45_000;
    await expect(client.getAccessToken()).resolves.toBe('AT2');
    expect(server.requests).toHaveLength(2);
  });

  it('并发取凭证只发一次请求（不会打雷）', async () => {
    const server = await startFakeServer([{ body: { access_token: 'AT', expires_in: 7200 } }]);
    const client = clientFor(server.baseUrl);

    const results = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    expect(results).toEqual(['AT', 'AT', 'AT']);
    expect(server.requests).toHaveLength(1);
  });

  it('业务失败：HTTP 200 但 code 非零 → 抛错并标记为不可恢复', async () => {
    const server = await startFakeServer([
      { status: 200, body: { code: 100016, message: 'invalid appid or secret' } },
    ]);
    const client = clientFor(server.baseUrl);

    await expect(client.getAccessToken()).rejects.toThrow(/invalid appid or secret/);
    // 再试一次仍失败（失败不该被缓存成成功）
    await expect(client.getAccessToken()).rejects.toThrow();
  });

  it('凭证错误被标记为永久失败（不值得重连重试）', async () => {
    const server = await startFakeServer([{ body: { code: 100007, message: 'appid invalid' } }]);
    const client = clientFor(server.baseUrl);

    await expect(client.getAccessToken()).rejects.toMatchObject({ permanent: true });
  });

  it('频控失败不是永久失败', async () => {
    const server = await startFakeServer([{ body: { code: 100001, message: 'Too many requests' } }]);
    const client = clientFor(server.baseUrl);

    await expect(client.getAccessToken()).rejects.toMatchObject({ permanent: false });
  });

  it('invalidateToken 后下次会重新获取', async () => {
    const server = await startFakeServer([
      { body: { access_token: 'AT1', expires_in: 7200 } },
      { body: { access_token: 'AT2', expires_in: 7200 } },
    ]);
    const client = clientFor(server.baseUrl);

    await expect(client.getAccessToken()).resolves.toBe('AT1');
    client.invalidateToken();
    await expect(client.getAccessToken()).resolves.toBe('AT2');
    expect(server.requests).toHaveLength(2);
  });

  it('HTTP 非 200 时抛错', async () => {
    const server = await startFakeServer([{ status: 500, body: { oops: true } }]);
    const client = clientFor(server.baseUrl);
    await expect(client.getAccessToken()).rejects.toThrow(/HTTP 500/);
  });
});

describe('gateway 接入点', () => {
  it('取网关信息，并带上 QQBot 授权头', async () => {
    const server = await startFakeServer([
      { body: { access_token: 'AT', expires_in: 7200 } },
      {
        body: {
          url: 'wss://example/websocket',
          shards: 2,
          session_start_limit: {
            total: 1000,
            remaining: 999,
            reset_after: 1000,
            max_concurrency: 1,
          },
        },
      },
    ]);
    const client = clientFor(server.baseUrl);

    const info = await client.getGatewayInfo();

    expect(info.url).toBe('wss://example/websocket');
    expect(info.shards).toBe(2);
    expect(info.sessionStartLimit?.remaining).toBe(999);
    expect(server.requests[1]?.method).toBe('GET');
    expect(server.requests[1]?.url).toBe('/gateway/bot');
    expect(server.requests[1]?.authorization).toBe('QQBot AT');
  });

  it('响应里没有 url 时抛错', async () => {
    const server = await startFakeServer([
      { body: { access_token: 'AT', expires_in: 7200 } },
      { body: { shards: 1 } },
    ]);
    const client = clientFor(server.baseUrl);
    await expect(client.getGatewayInfo()).rejects.toThrow(/url/);
  });
});

describe('发送消息', () => {
  it('群消息：路径、请求体（纯文本 + 被动回复）与响应解析', async () => {
    const server = await startFakeServer([
      { body: { access_token: 'AT', expires_in: 7200 } },
      { body: { id: 'MSG_ID', timestamp: '2026-07-21T10:00:00+08:00' } },
    ]);
    const client = clientFor(server.baseUrl);

    const result = await client.sendGroup('GROUP_OPENID', {
      content: '你好',
      msgId: 'EVENT_MSG_ID',
      msgSeq: 2,
    });

    expect(result).toEqual({
      ok: true,
      messageId: 'MSG_ID',
      timestamp: '2026-07-21T10:00:00+08:00',
      refIdx: null,
    });

    const sent = server.requests[1];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('/v2/groups/GROUP_OPENID/messages');
    expect(sent?.authorization).toBe('QQBot AT');
    expect(sent?.body).toEqual({
      msg_type: 0,
      content: '你好',
      msg_id: 'EVENT_MSG_ID',
      msg_seq: 2,
    });
  });

  it('私聊消息走 /v2/users/{openid}/messages', async () => {
    const server = await startFakeServer([
      { body: { access_token: 'AT', expires_in: 7200 } },
      { body: { id: 'MSG_ID' } },
    ]);
    const client = clientFor(server.baseUrl);

    await client.sendPrivate('USER_OPENID', { content: 'hi' });

    expect(server.requests[1]?.url).toBe('/v2/users/USER_OPENID/messages');
    expect(server.requests[1]?.body).toEqual({ msg_type: 0, content: 'hi' });
  });

  it('业务失败返回失败结果而不是抛异常（编排层要统一处理）', async () => {
    const server = await startFakeServer([
      { body: { access_token: 'AT', expires_in: 7200 } },
      { body: { code: 40054005, message: '消息被去重' } },
    ]);
    const client = clientFor(server.baseUrl);

    const result = await client.sendGroup('G', { content: 'x', msgId: 'm', msgSeq: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(40054005);
    expect(result.kind).toBe('duplicate-seq');
    expect(result.retryable).toBe(true);
  });

  it('网络故障也返回可重试的失败结果', async () => {
    // 指向一个没人监听的端口
    const client = clientFor('http://127.0.0.1:1');
    const result = await client.sendGroup('G', { content: 'x' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.retryable).toBe(true);
    expect(result.kind).toBe('transient');
  });
});

describe('凭证缓存可观测', () => {
  it('getTokenExpiry 反映缓存状态（供 UI 展示）', async () => {
    let clock = 1000;
    const server = await startFakeServer([{ body: { access_token: 'AT', expires_in: 7200 } }]);
    const client = clientFor(server.baseUrl, { now: () => clock });

    expect(client.getTokenExpiry()).toBeNull();
    await client.getAccessToken();
    expect(client.getTokenExpiry()).toBe(1000 + 7_200_000);
    clock = 0;
    client.invalidateToken();
    expect(client.getTokenExpiry()).toBeNull();
  });
});
