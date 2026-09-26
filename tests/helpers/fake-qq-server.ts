import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * 假 QQ 服务端（HTTP + WebSocket），协议形状对齐官方。
 *
 * 存在的意义：让整条链路能在**不需要任何真实凭据**的情况下端到端跑通。
 * 真账号只能验证「官方接受我们的请求」，跑不了「未授权来源会不会触达模型」
 * 「多条消息的顺序对不对」这类回归 —— 那些才是改代码时最容易挂掉的地方。
 *
 * ## 为什么连 WebSocket 也手写
 *
 * Node 24 有全局 `WebSocket` **客户端**，但没有服务端。想用真的 WS 协议栈跑端到端，
 * 就得自己实现握手与帧编解码。这部分工作是一次性的（约 100 行），换来的是：
 * `electron/qq/connection.ts` → `gateway.ts` → 真实 `WebSocket` 全局对象 → 这个服务端
 * 的完整链路被真实覆盖，而不是用注入的假 socket 绕过去。
 *
 * 实现的协议子集（RFC6455）：
 * - 握手：`Sec-WebSocket-Accept = base64(sha1(key + GUID))`
 * - 解析**带掩码**的客户端帧（文本 / close / ping），长度 7 位与 16 位都支持
 * - 发送**不带掩码**的服务端帧（文本 / pong / close）
 * - 分片帧（FIN=0）不处理 —— 官方消息都是小 JSON，单片足够；遇到就报错而不是静默丢数据
 *
 * 对齐官方的行为：
 * - `POST /app/getAppAccessToken` → `{access_token, expires_in}`
 * - `GET /gateway/bot` → `{url, shards, session_start_limit}`（url 指向自己的 WS 端点）
 * - WS 握手后先下发 Hello（op 10），收到 Identify/Resume 回 READY/RESUMED，心跳回 ACK
 * - `POST /v2/{groups|users}/{openid}/messages` → `{id, timestamp}`
 */

/** WebSocket 握手用的固定 GUID（协议规定）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 一个已建立的 WS 连接。 */
interface Client {
  socket: Socket;
  /** 发送一帧文本。 */
  send: (text: string) => void;
  /** 发送 close 帧并结束连接。 */
  close: (code: number, reason?: string) => void;
}

/** 假服务端句柄。 */
export interface FakeQqServer {
  /** REST base（`http://127.0.0.1:<port>`）。 */
  baseUrl: string;
  /** WS 端点。 */
  wsUrl: string;
  /** 收到的发送请求，按到达顺序。 */
  sent: { path: string; body: Record<string, unknown> }[];
  /** 收到的 Identify 载荷；没有则为 `null`。 */
  identify: Record<string, unknown> | null;
  /** 收到的 Resume 载荷；没有则为 `null`。 */
  resume: Record<string, unknown> | null;
  /** 收到的心跳次数。 */
  heartbeats: number;
  /** 收到的模型请求（`/chat/completions`），用来断言 prompt 拼得对不对。 */
  chatRequests: Record<string, unknown>[];
  /** 当前连接数。 */
  clientCount: () => number;
  /** 向所有已连接客户端推送一个 Dispatch 事件。 */
  pushEvent: (t: string, d: unknown, seq?: number) => void;
  /** 让服务端主动断开所有连接（测试重连用）。 */
  dropClients: (code?: number) => void;
  /** 关闭服务端。 */
  close: () => Promise<void>;
}

/** 启动选项。 */
export interface FakeQqServerOptions {
  /** 返回给客户端的 access_token。 */
  token?: string;
  /** Hello 里的心跳周期。 */
  heartbeatIntervalMs?: number;
  /** 发送接口是否返回业务错误（用来测失败路径）。 */
  sendError?: { code: number; message: string } | null;
  /** 模型端点返回的正文；分两段流式吐出，用来验证增量累积。 */
  modelReply?: string;
  /** 是否在下发 Hello 后立刻用关闭码踢掉连接（测 intents 无权限）。 */
  rejectWithCode?: number | null;
}

/**
 * 计算握手响应头里的 `Sec-WebSocket-Accept`。
 *
 * @param key 客户端给的 `Sec-WebSocket-Key`。
 * @returns base64 摘要。
 */
function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/**
 * 编码一个服务端 → 客户端的文本帧（不加掩码）。
 *
 * @param text 文本。
 * @returns 帧字节。
 */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }
  if (length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/**
 * 编码一个 close 帧。
 *
 * @param code 关闭码。
 * @param reason 原因。
 * @returns 帧字节。
 */
function encodeCloseFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

/** 解码结果。 */
type DecodeResult =
  | { kind: 'incomplete' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'frame'; opcode: number; fin: boolean; payload: Buffer; consumed: number };

/**
 * 从缓冲区里解析一个客户端帧。
 *
 * 客户端帧**必须带掩码**（协议规定），解析时按掩码还原。
 *
 * @param buffer 累积的字节。
 * @returns 解析结果。
 */
export function decodeFrame(buffer: Buffer): DecodeResult {
  if (buffer.length < 2) {
    return { kind: 'incomplete' };
  }

  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return { kind: 'incomplete' };
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return { kind: 'incomplete' };
    }
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { kind: 'invalid', reason: '帧长度超出可处理范围' };
    }
    length = Number(big);
    offset += 8;
  }

  if (!masked) {
    return { kind: 'invalid', reason: '客户端帧必须带掩码' };
  }
  if (buffer.length < offset + 4) {
    return { kind: 'incomplete' };
  }
  const maskKey = buffer.subarray(offset, offset + 4);
  offset += 4;

  if (buffer.length < offset + length) {
    return { kind: 'incomplete' };
  }

  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[offset + index] ?? 0;
    payload[index] = byte ^ (maskKey[index % 4] ?? 0);
  }

  return { kind: 'frame', opcode, fin, payload, consumed: offset + length };
}

/**
 * 启动假服务端。
 *
 * @param options 选项。
 * @returns 句柄。
 */
export async function startFakeQqServer(options: FakeQqServerOptions = {}): Promise<FakeQqServer> {
  const token = options.token ?? 'FAKE_ACCESS_TOKEN';
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1000;
  const sendError = options.sendError ?? null;
  const rejectWithCode = options.rejectWithCode ?? null;
  const modelReply = options.modelReply ?? '模型回复';

  const clients = new Set<Client>();
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  /** 收到的模型请求。 */
  const chatRequests: Record<string, unknown>[] = [];
  const state = {
    identify: null as Record<string, unknown> | null,
    resume: null as Record<string, unknown> | null,
    heartbeats: 0,
  };

  /** 端口还没定下来之前先占位，等 listen 后再填。 */
  let port = 0;
  /** 用于给发出的 Dispatch 事件递增 s。 */
  let seq = 1;

  /**
   * 处理一个 HTTP 请求。
   *
   * @param req 请求。
   * @param res 响应。
   */
  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { __raw: raw };
        }
      }

      res.setHeader('content-type', 'application/json');

      // 模型端点：吐 SSE，用来让整条链路真的走一次模型调用
      if (url.startsWith('/chat/completions')) {
        chatRequests.push(body);
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');

        const reply = modelReply;
        // 分两段，验证调用方把增量拼对了（而不是只取第一段）
        const half = Math.ceil(reply.length / 2);
        for (const piece of [reply.slice(0, half), reply.slice(half)]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (url === '/app/getAppAccessToken') {
        res.end(JSON.stringify({ access_token: token, expires_in: 7200 }));
        return;
      }

      if (url === '/gateway/bot') {
        res.end(
          JSON.stringify({
            url: `ws://127.0.0.1:${port}/websocket`,
            shards: 1,
            session_start_limit: {
              total: 1000,
              remaining: 999,
              reset_after: 1000,
              max_concurrency: 1,
            },
          }),
        );
        return;
      }

      if (url.startsWith('/v2/') && url.endsWith('/messages')) {
        sent.push({ path: url, body });
        if (sendError !== null) {
          // 官方特性：业务失败时 HTTP 仍是 200
          res.end(JSON.stringify(sendError));
          return;
        }
        res.end(JSON.stringify({ id: `MSG_${sent.length}`, timestamp: '2026-07-21T10:00:00+08:00' }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, message: 'not found' }));
    });
  }

  const server: Server = createServer(handleHttp);

  // WebSocket 升级：自己处理，不用第三方库
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        '\r\n',
    );

    const raw = socket as Socket;
    let buffer = Buffer.alloc(0);
    let closed = false;

    const client: Client = {
      socket: raw,
      send: (text) => {
        if (!closed) {
          raw.write(encodeTextFrame(text));
        }
      },
      close: (code, reason = '') => {
        if (closed) {
          return;
        }
        closed = true;
        raw.write(encodeCloseFrame(code, reason));
        raw.end();
        clients.delete(client);
      },
    };
    clients.add(client);

    raw.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        const decoded = decodeFrame(buffer);
        if (decoded.kind === 'incomplete') {
          return;
        }
        if (decoded.kind === 'invalid') {
          client.close(1002, decoded.reason);
          return;
        }
        buffer = buffer.subarray(decoded.consumed);

        if (!decoded.fin) {
          // 官方消息都是小 JSON，单片足够；分片就明确报错而不是静默丢数据
          client.close(1003, '不支持分片帧');
          return;
        }

        if (decoded.opcode === 0x8) {
          client.close(1000, 'bye');
          return;
        }
        if (decoded.opcode === 0x9) {
          raw.write(Buffer.concat([Buffer.from([0x8a, decoded.payload.length]), decoded.payload]));
          continue;
        }
        if (decoded.opcode !== 0x1) {
          continue;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(decoded.payload.toString('utf8')) as Record<string, unknown>;
        } catch {
          continue;
        }

        const op = payload['op'];
        if (op === 2) {
          state.identify = (payload['d'] ?? null) as Record<string, unknown> | null;
          if (rejectWithCode !== null) {
            // 模拟「intents 无权限」：连上就踢
            client.close(rejectWithCode, 'intent 无权限');
            return;
          }
          seq += 1;
          client.send(
            JSON.stringify({
              op: 0,
              s: seq,
              t: 'READY',
              d: {
                version: 1,
                session_id: 'FAKE_SESSION',
                user: { id: 'FAKE_BOT_ID', username: '假机器人', bot: true },
                shard: [0, 0],
              },
            }),
          );
          continue;
        }
        if (op === 6) {
          state.resume = (payload['d'] ?? null) as Record<string, unknown> | null;
          seq += 1;
          client.send(JSON.stringify({ op: 0, s: seq, t: 'RESUMED', d: '' }));
          continue;
        }
        if (op === 1) {
          state.heartbeats += 1;
          client.send(JSON.stringify({ op: 11, d: null }));
          continue;
        }
      }
    });

    raw.on('error', () => {
      closed = true;
      clients.delete(client);
    });
    raw.on('close', () => {
      closed = true;
      clients.delete(client);
    });

    // 握手完成后立刻下发 Hello
    client.send(
      JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } }),
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/websocket`,
    sent,
    chatRequests,
    get identify() {
      return state.identify;
    },
    get resume() {
      return state.resume;
    },
    get heartbeats() {
      return state.heartbeats;
    },
    clientCount: () => clients.size,
    pushEvent: (t, d, nextSeq) => {
      const current = nextSeq ?? seq + 1;
      seq = current;
      const frame = JSON.stringify({ op: 0, s: current, t, d });
      for (const client of clients) {
        client.send(frame);
      }
    },
    dropClients: (code = 4009) => {
      for (const client of [...clients]) {
        client.close(code, '服务端主动断开');
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of [...clients]) {
          client.close(1001, 'shutting down');
        }
        server.close(() => resolve());
      }),
  };
}
