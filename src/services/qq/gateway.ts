import {
  OP,
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  classifyCloseCode,
  classifyOpcode,
  nextReconnectDelay,
  parseGatewayPayload,
  parseHelloInterval,
  parseReady,
  type BackoffConfig,
  type GatewayPayload,
  type ReadyInfo,
} from './protocol';

/**
 * QQ 网关连接状态机。
 *
 * ## 为什么把 socket 做成可注入的
 *
 * 这块最容易出 bug 的地方全在**状态迁移**上：Hello 要不要发 Identify、
 * 断线后该 Resume 还是重新 Identify、心跳丢了几次才判定连接已死、退避够不够。
 * 这些跟「socket 是谁」无关，所以这里只依赖一个最小接口
 * {@link WebSocketLike}，真实实现（全局 `WebSocket`）与测试用的假 socket 都往这个口子里塞。
 *
 * 好处是测试可以用假定时器把时间轴精确推进，**不需要手写一个 RFC6455 服务端**，
 * 也不需要等真实的秒级心跳。
 *
 * ## 时序契约
 *
 * ```
 * start() → connecting → [Hello] → Identify/Resume → [READY/RESUMED] → connected
 *                                    ↓ 断线 / 关闭
 *                              reconnecting → connecting → …
 *                                    ↓ 不可重试的关闭码
 *                                 stopped（并回调 onFatal）
 * ```
 *
 * ## 陈旧回调的保护
 *
 * 重连时旧 socket 的 `close` / `message` 回调可能**在新连接建立之后**才触发。
 * 每次建立连接都会领取一个单调递增的 `serial`，回调里先比对 serial，
 * 不等就丢弃 —— 否则会出现「一次断线触发两次重连」这类难查的重复连接。
 */

/** 最小 socket 接口。 */
export interface WebSocketLike {
  /** 发送一帧文本。 */
  send(data: string): void;
  /** 关闭连接。 */
  close(code?: number, reason?: string): void;
  /** 注册「连接已建立」。 */
  onOpen(handler: () => void): void;
  /** 注册「收到一帧文本」。 */
  onMessage(handler: (data: string) => void): void;
  /** 注册「连接已关闭」。 */
  onClose(handler: (event: SocketCloseEvent) => void): void;
  /** 注册「出错」。 */
  onError(handler: () => void): void;
}

/** 关闭事件（只取我们需要的字段）。 */
export interface SocketCloseEvent {
  /** 关闭码。 */
  code: number;
  /** 服务端给的原因。 */
  reason: string;
}

/** socket 工厂。 */
export type SocketFactory = (url: string) => WebSocketLike;

/** 网关连接状态。 */
export type GatewayState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** 创建网关所需的依赖。 */
export interface GatewayDeps {
  /** 取网关地址（`GET /gateway/bot` 的 `url`）。 */
  getGatewayUrl: () => Promise<string>;
  /** 取**裸** access_token；内部会在每次连接前调用，刷新由调用方负责。 */
  getToken: () => Promise<string>;
  /** 要订阅的 intents 位掩码。 */
  intents: number;
  /** 收到业务事件（`op 0` Dispatch，且不是 READY/RESUMED）。 */
  onEvent: (payload: GatewayPayload) => void;
  /** 状态变化通知。 */
  onStateChange?: (state: GatewayState, detail: string) => void;
  /** 鉴权成功（收到 READY）。 */
  onReady?: (info: ReadyInfo) => void;
  /** 不可重试的致命错误（此时已停止，不会自动重连）。 */
  onFatal?: (error: Error) => void;
  /** 可自行恢复的警告（已安排重连）。 */
  onWarn?: (message: string) => void;
  /** socket 工厂；缺省用全局 `WebSocket`（仅 Node 22+ / 浏览器可用）。 */
  createSocket?: SocketFactory;
  /** 退避配置。 */
  backoff?: BackoffConfig;
  /** 随机数发生器（测试注入）。 */
  random?: () => number;
  /** 连续多少次心跳未收到 ACK 就判定连接已死并重连，缺省 2。 */
  maxMissedHeartbeats?: number;
}

/** 网关句柄。 */
export interface QqGateway {
  /** 启动（或在 `stopped` 之前手动重连）。重复调用无副作用。 */
  start(): Promise<void>;
  /** 停止：不再重连，只关连接。可重复调用。 */
  stop(): void;
  /** 当前状态。 */
  getState(): GatewayState;
}

/** 默认退避：1 秒起，最长 1 分钟，±25% 抖动。 */
const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0.25 };

/** 默认把连续 2 次心跳无 ACK 视为连接已死。 */
const DEFAULT_MAX_MISSED = 2;

/** 全局 `WebSocket` 的最小结构（不依赖 DOM 类型声明）。 */
interface RawWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * 用宿主环境的全局 `WebSocket` 创建连接。
 *
 * Node 22+ 与 Electron 主进程都自带全局 `WebSocket`，因此本项目**不需要引入 ws 依赖**。
 *
 * @param url 网关地址。
 * @returns 适配后的 socket。
 * @throws 宿主环境没有全局 `WebSocket` 时抛出 `Error`。
 */
export const createGlobalSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => RawWebSocket })
    .WebSocket;
  if (typeof Ctor !== 'function') {
    throw new Error('当前运行环境没有全局 WebSocket，请通过 createSocket 注入一个实现');
  }
  const raw = new Ctor(url);

  return {
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
    onOpen: (handler) => raw.addEventListener('open', () => handler()),
    onMessage: (handler) =>
      raw.addEventListener('message', (event) => {
        const data = (event as { data?: unknown }).data;
        handler(typeof data === 'string' ? data : String(data ?? ''));
      }),
    onClose: (handler) =>
      raw.addEventListener('close', (event) => {
        const detail = event as { code?: unknown; reason?: unknown };
        handler({
          code: typeof detail.code === 'number' ? detail.code : 1006,
          reason: typeof detail.reason === 'string' ? detail.reason : '',
        });
      }),
    onError: (handler) => raw.addEventListener('error', () => handler()),
  };
};

/**
 * 创建一个网关。
 *
 * @param deps 依赖。
 * @returns 网关句柄。
 */
export function createGateway(deps: GatewayDeps): QqGateway {
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const maxMissed = Math.max(1, Math.floor(deps.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED));
  const factory = deps.createSocket ?? createGlobalSocket;

  let state: GatewayState = 'idle';
  /** 单调递增的连接序号，用来让陈旧回调失效。 */
  let serial = 0;
  let socket: WebSocketLike | null = null;
  let stopped = false;
  let starting = false;

  /** 会话与游标：Resume 需要。 */
  let sessionId: string | null = null;
  let latestSeq: number | null = null;
  /** 下一次连接是否优先走 Resume（缺省重新 Identify）。 */
  let nextPreferResume = false;

  let attempts = 0;
  let missedHeartbeats = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 更新状态并通知。
   *
   * @param next 新状态。
   * @param detail 说明。
   */
  function setState(next: GatewayState, detail: string): void {
    state = next;
    deps.onStateChange?.(next, detail);
  }

  /** 停掉心跳定时器。 */
  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** 停掉重连定时器。 */
  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * 领取新的连接序号，使所有旧回调失效。
   *
   * @returns 新的序号。
   */
  function beginSerial(): number {
    serial += 1;
    return serial;
  }

  /**
   * 关掉当前 socket（不触发重连逻辑）。
   */
  function dropSocket(): void {
    clearHeartbeat();
    const current = socket;
    socket = null;
    if (current !== null) {
      try {
        current.close();
      } catch {
        // 已经关了就算了
      }
    }
  }

  /**
   * 判定连接是否已死并重连。
   *
   * @param preferResume 重连时是否优先 Resume。
   * @param reason 给用户看的原因。
   */
  function forceReconnect(preferResume: boolean, reason: string): void {
    if (stopped) {
      return;
    }
    deps.onWarn?.(reason);
    nextPreferResume = preferResume;
    // 先让旧回调失效，再关闭，避免关闭事件又触发一次重连
    beginSerial();
    dropSocket();
    scheduleReconnect();
  }

  /**
   * 安排一次重连（带指数退避）。
   */
  function scheduleReconnect(): void {
    if (stopped) {
      return;
    }
    clearReconnect();
    const delay = nextReconnectDelay(attempts, backoff, deps.random);
    attempts += 1;
    setState('reconnecting', `${delay} ms 后重连（第 ${attempts} 次）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  /**
   * 建立一次连接。
   */
  async function connect(): Promise<void> {
    if (stopped) {
      return;
    }
    const mySerial = beginSerial();
    clearReconnect();
    clearHeartbeat();
    setState(attempts === 0 ? 'connecting' : 'reconnecting', '正在建立连接');

    let url: string;
    let token: string;
    try {
      url = await deps.getGatewayUrl();
      token = await deps.getToken();
    } catch (error) {
      if (mySerial !== serial || stopped) {
        return;
      }
      deps.onWarn?.(`获取网关地址或凭证失败：${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect();
      return;
    }
    if (mySerial !== serial || stopped) {
      return;
    }

    let next: WebSocketLike;
    try {
      next = factory(url);
    } catch (error) {
      if (mySerial !== serial || stopped) {
        return;
      }
      deps.onWarn?.(`建立连接失败：${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onOpen(() => {
      // 等 Hello，什么都不用做
    });

    next.onMessage((raw) => {
      if (mySerial !== serial) {
        return;
      }
      handleMessage(mySerial, next, raw, token);
    });

    next.onClose((event) => {
      if (mySerial !== serial) {
        return;
      }
      handleClose(event);
    });

    next.onError(() => {
      if (mySerial !== serial) {
        return;
      }
      // 出错后通常会紧跟 close，交给 close 决定是否重连；这里只提示
      deps.onWarn?.('连接出错');
    });
  }

  /**
   * 处理一帧服务端消息。
   *
   * @param mySerial 本连接的序号。
   * @param current 本连接的 socket。
   * @param raw 原始文本。
   * @param token 本次连接使用的裸 token。
   */
  function handleMessage(
    mySerial: number,
    current: WebSocketLike,
    raw: string,
    token: string,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      deps.onWarn?.('收到非 JSON 帧，已忽略');
      return;
    }

    const payload = parseGatewayPayload(parsed);
    if (payload === null) {
      return;
    }
    if (payload.s !== null) {
      latestSeq = payload.s;
    }

    // 服务端要求重连 / 会话失效
    const directive = classifyOpcode(payload.op);
    if (directive !== null) {
      forceReconnect(directive.preferResume, directive.reason);
      return;
    }

    if (payload.op === OP.HELLO) {
      const interval = parseHelloInterval(payload) ?? 45_000;

      const canResume = nextPreferResume && sessionId !== null && latestSeq !== null;
      if (canResume) {
        current.send(
          JSON.stringify(
            buildResumePayload({ token, sessionId: sessionId as string, seq: latestSeq as number }),
          ),
        );
        deps.onWarn?.('已发送 Resume，等待补发遗漏事件');
      } else {
        current.send(JSON.stringify(buildIdentifyPayload({ token, intents: deps.intents })));
      }
      nextPreferResume = false;

      clearHeartbeat();
      missedHeartbeats = 0;
      heartbeatTimer = setInterval(() => {
        if (mySerial !== serial) {
          return;
        }
        try {
          current.send(JSON.stringify(buildHeartbeatPayload(latestSeq)));
        } catch {
          // 发送失败交由 close 处理
          return;
        }
        missedHeartbeats += 1;
        if (missedHeartbeats >= maxMissed) {
          forceReconnect(true, `连续 ${missedHeartbeats} 次心跳未收到 ACK，判定连接已死`);
        }
      }, interval);
      return;
    }

    if (payload.op === OP.HEARTBEAT_ACK) {
      missedHeartbeats = 0;
      return;
    }

    if (payload.op !== OP.DISPATCH) {
      return;
    }

    if (payload.t === 'READY') {
      const info = parseReady(payload);
      if (info !== null) {
        sessionId = info.sessionId;
      }
      attempts = 0;
      setState('connected', info === null ? '已就绪' : `已就绪：${info.username || '机器人'}`);
      if (info !== null) {
        deps.onReady?.(info);
      }
      return;
    }

    if (payload.t === 'RESUMED') {
      attempts = 0;
      setState('connected', '已恢复会话');
      return;
    }

    deps.onEvent(payload);
  }

  /**
   * 处理连接关闭。
   *
   * @param event 关闭事件。
   */
  function handleClose(event: SocketCloseEvent): void {
    clearHeartbeat();
    dropSocket();

    if (stopped) {
      return;
    }

    const directive = classifyCloseCode(event.code);
    if (!directive.retryable) {
      stopped = true;
      beginSerial();
      clearReconnect();
      setState('stopped', directive.reason);
      deps.onFatal?.(new Error(directive.reason));
      return;
    }

    deps.onWarn?.(`连接关闭（${event.code}）：${directive.reason}`);
    nextPreferResume = directive.preferResume;
    scheduleReconnect();
  }

  return {
    async start(): Promise<void> {
      if (stopped) {
        // 允许从 stopped 重新开始（用户手动重连）
        stopped = false;
        attempts = 0;
        sessionId = null;
        latestSeq = null;
      }
      if (starting || state === 'connecting' || state === 'connected' || state === 'reconnecting') {
        return;
      }
      starting = true;
      try {
        await connect();
      } finally {
        starting = false;
      }
    },

    stop(): void {
      stopped = true;
      beginSerial();
      clearReconnect();
      clearHeartbeat();
      dropSocket();
      setState('stopped', '已手动停止');
    },

    getState(): GatewayState {
      return state;
    },
  };
}
