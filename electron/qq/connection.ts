import {
  createGateway as createRealGateway,
  type GatewayDeps,
  type QqGateway,
} from '../../src/services/qq/gateway';
import type { GatewayInfo, GatewayPayload } from '../../src/services/qq/protocol';

/**
 * QQ 连接管理器。
 *
 * 它是设置页显示内容的**唯一来源**：连接状态、补充说明、机器人 id。
 * 自己不含任何判定逻辑，只负责把「配置 → HTTP 客户端 → 网关状态机」组合起来，
 * 并把网关的状态翻译成界面能直接用的三样东西。
 *
 * ## 为什么状态要在这里「翻译」而不是直接用网关的
 *
 * 网关的状态机对「网络抖动」分得很细（`connecting` / `reconnecting`），因为重连策略要
 * 依赖这个区分；但用户不需要知道现在是第几次重连 —— 他们只想知道「连上了没有」。
 * 所以这里把 `reconnecting` 也呈现为 `connecting`，把 `stopped` 分成「用户主动停的」
 * 与「遇到不可恢复的错误」，后者才是用户需要看到并去处理的。
 *
 * ## 配置不全时拒绝启动
 *
 * 少了 AppID / ClientSecret / intents，连上去也只会得到 4013/4014 或者收不到任何事件。
 * 与其带着坏配置去撞服务端、让用户看到一句「连接失败」，不如**在本地就明确说清楚**
 * 缺什么 —— 这类问题用户自己能立刻修好。
 */

/** 连接对外状态。 */
export type QqConnectionState =
  /** 未连接（初始状态，或用户主动停止）。 */
  | 'stopped'
  /** 正在建立连接或重连中。 */
  | 'connecting'
  /** 已就绪（收到过 READY）。 */
  | 'connected'
  /** 遇到不可恢复的错误，已停止。 */
  | 'error';

/** 对外状态快照。 */
export interface QqConnectionStatus {
  state: QqConnectionState;
  /** 补充说明：错误原因、进度提示等；可直接展示给用户。 */
  message: string;
  /** 机器人自己的 id；收到 READY 之前为 `null`。 */
  botId: string | null;
}

/** 连接管理器只需要的 HTTP 能力（真实 `QqHttpClient` 结构上满足它）。 */
export interface QqConnectionHttp {
  getAccessToken(): Promise<string>;
  getGatewayInfo(): Promise<GatewayInfo>;
}

/** 连接管理器需要的配置切片。 */
export interface QqConnectionConfig {
  appId: string;
  appSecret: string;
  /** 事件订阅位掩码。 */
  intents: number;
  /** 是否沙箱环境（留给后续区分域名用）。 */
  sandbox: boolean;
}

/** 连接管理器依赖。 */
export interface QqConnectionDeps {
  /** 读当前配置（每次启动/重启都重新读，用户改了设置立即生效）。 */
  getConfig: () => QqConnectionConfig;
  /** 用配置创建 HTTP 客户端。 */
  createHttp: (options: { appId: string; appSecret: string }) => QqConnectionHttp;
  /** 创建网关（测试注入）。缺省用真实实现。 */
  createGateway?: (deps: GatewayDeps) => QqGateway;
  /** 收到业务事件。 */
  onEvent: (payload: GatewayPayload) => void;
  /** 状态变化：落库 + 推给界面。 */
  onState: (state: QqConnectionState, message: string) => void;
  /** 日志出口。 */
  log?: (message: string) => void;
}

/** 连接管理器句柄。 */
export interface QqConnection {
  /** 启动连接。已启动时不做任何事。 */
  start(): Promise<void>;
  /** 停止连接，不再重连。 */
  stop(): void;
  /** 重新读配置并重连（用户改了设置 / 手动重连）。 */
  restart(): Promise<void>;
  /** 当前状态快照。 */
  getState(): QqConnectionStatus;
}

/**
 * 检查配置是否可用。
 *
 * @param config 配置。
 * @returns 可用返回 `null`，否则返回缺什么的说明。
 */
function validate(config: QqConnectionConfig): string | null {
  if (typeof config.appId !== 'string' || config.appId.trim().length === 0) {
    return '尚未填写 AppID，无法连接。请到 QQ 开放平台复制机器人 AppID。';
  }
  if (typeof config.appSecret !== 'string' || config.appSecret.trim().length === 0) {
    return '尚未填写 AppSecret，无法连接。请到 QQ 开放平台复制机器人密钥。';
  }
  if (!Number.isFinite(config.intents) || config.intents <= 0) {
    return '尚未配置事件订阅（intents 为空），连上去也收不到任何消息。';
  }
  return null;
}

/**
 * 创建连接管理器。
 *
 * @param deps 依赖。
 * @returns 连接管理器。
 */
export function createQqConnection(deps: QqConnectionDeps): QqConnection {
  const log = deps.log ?? ((): void => undefined);
  const makeGateway = deps.createGateway ?? createRealGateway;

  let state: QqConnectionState = 'stopped';
  let message = '';
  let botId: string | null = null;
  let gateway: QqGateway | null = null;

  /**
   * 更新状态并上报。
   *
   * @param next 新状态。
   * @param detail 说明。
   */
  function setState(next: QqConnectionState, detail: string): void {
    state = next;
    message = detail;
    deps.onState(next, detail);
  }

  /**
   * 把网关状态翻译成对外状态。
   *
   * @param gatewayState 网关状态。
   * @param detail 网关给的说明。
   */
  function onGatewayState(gatewayState: string, detail: string): void {
    switch (gatewayState) {
      case 'connected':
        setState('connected', detail);
        break;
      case 'stopped':
        // 主动停止与致命错误都会走到这里；错误场景下 onFatal 随后会覆盖成 error
        setState('stopped', detail);
        break;
      default:
        // connecting / reconnecting / idle 对用户都是「正在连接」
        setState('connecting', detail);
        break;
    }
  }

  async function start(): Promise<void> {
    if (gateway !== null) {
      return;
    }

    const config = deps.getConfig();
    const problem = validate(config);
    if (problem !== null) {
      setState('error', problem);
      return;
    }

    const http = deps.createHttp({
      appId: config.appId.trim(),
      appSecret: config.appSecret.trim(),
    });

    const next = makeGateway({
      getGatewayUrl: async () => (await http.getGatewayInfo()).url,
      getToken: () => http.getAccessToken(),
      intents: config.intents,
      onEvent: (payload) => deps.onEvent(payload),
      onStateChange: onGatewayState,
      onReady: (info) => {
        botId = info.userId;
      },
      onFatal: (error) => {
        setState('error', error.message);
      },
      onWarn: (warning) => log(warning),
    });

    gateway = next;
    setState('connecting', '正在连接 QQ 网关…');
    await next.start();
  }

  /**
   * 停止连接，不再重连。
   */
  function stop(): void {
    const current = gateway;
    gateway = null;
    if (current !== null) {
      current.stop();
    }
    setState('stopped', '已停止连接');
  }

  return {
    start,

    stop,

    async restart(): Promise<void> {
      // 刻意用局部函数而不是 this.stop()：否则 `const { restart } = connection`
      // 这种解构用法会因为 this 丢失而崩掉
      stop();
      await start();
    },

    getState(): QqConnectionStatus {
      return { state, message, botId };
    },
  };
}
