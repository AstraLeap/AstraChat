import { createQqConnection, type QqConnection, type QqConnectionHttp, type QqConnectionStatus } from './connection';
import { createQqHttp } from './http';
import { createQqService, type QqService } from './service';
import type { QqCommand } from '../../src/services/qq/commands';
import type { GatewayDeps, QqGateway } from '../../src/services/qq/gateway';
import type { QqInbound } from '../../src/services/qq/events';
import type { OutboundMessage, SendResult } from '../../src/services/qq/send';
import type { GatewayPayload } from '../../src/services/qq/protocol';
import type { QqConfig, QqContactPolicy } from '../../src/types/index';

/**
 * QQ 运行时：把配置、连接、消息编排装配成一个能被 IPC 层直接驱动的东西。
 *
 * ## 它解决的最后一公里
 *
 * `connection.ts` 会连、`service.ts` 会答，但两者都**不知道彼此存在**，
 * 也不知道配置从哪来、状态该往哪去。这个模块负责：
 *
 * 1. 把数据库里的 `QqConfig` 喂给连接与编排
 * 2. 把连接的状态**落库 + 推给界面**（重开应用后状态可见，不用等重新连接）
 * 3. 把网关事件接到编排层
 *
 * ## QQ 会话映射为什么是一个「键」而不是一个表
 *
 * `generateReply` 收到的不是 `conversationId` 而是 `conversationKey`
 * （形如 `group:<group_openid>` / `private:<user_openid>`），
 * 由适配器决定「这个键对应哪个本地会话」。
 *
 * 这样切分的原因：映射策略是个**产品决定**，不该藏在装配层里。推荐的做法见
 * `docs/qq-integration-design.md`：**一个 QQ 来源对应一个本地会话**（整个群共用一个上下文），
 * 因为机器人要参与群聊就必须看得到群里在聊什么；代价是同一群里所有人的消息与机器人的
 * 回复都在一个会话里，适配器需要据此在界面上明确标注。
 *
 * 反过来，如果将来要按人隔离，只需改适配器里的键到会话的映射，这个模块不用动。
 */

/** 运行时需要的 HTTP 能力：既能连网关，也能发消息。 */
export interface QqRuntimeHttp extends QqConnectionHttp {
  sendGroup(groupOpenId: string, message: OutboundMessage): Promise<SendResult>;
  sendPrivate(userOpenId: string, message: OutboundMessage): Promise<SendResult>;
}

/** 运行时需要的数据访问能力。 */
export interface QqRuntimePorts {
  /** 读 QQ 配置。 */
  loadConfig: () => QqConfig;
  /** 查某个来源的授权状态。 */
  lookupContact: (openId: string) => { policy: QqContactPolicy; allowedCount: number };
  /** 记录「见过这个来源」，用于设置页的待授权列表。 */
  recordContactSeen: (input: {
    openId: string;
    kind: 'group' | 'private';
    displayName?: string | null;
  }) => void;
  /**
   * 让模型生成回复。
   *
   * @param conversationKey `group:<openid>` 或 `private:<openid>`，由适配器映射到本地会话。
   */
  generateReply: (
    conversationKey: string,
    message: QqInbound,
    role: 'owner' | 'member',
  ) => Promise<string>;
  /** 执行管理命令（不经过模型）。 */
  executeCommand: (command: QqCommand, message: QqInbound) => Promise<string>;
  /** 已知的敏感值，传给审计。 */
  knownSecrets?: () => readonly string[];
  /** 状态变化：落库 + 推给界面。 */
  onStatus: (status: QqConnectionStatus) => void;
  /** 日志出口。 */
  log?: (message: string) => void;
  /** 注入 HTTP 工厂（测试用）。 */
  createHttp?: (options: { appId: string; appSecret: string }) => QqRuntimeHttp;
  /** 注入网关工厂（测试用）。 */
  createGateway?: (deps: GatewayDeps) => QqGateway;
}

/** 运行时句柄。 */
export interface QqRuntime {
  /** 按当前配置启动连接。 */
  start(): Promise<void>;
  /** 停止连接。 */
  stop(): void;
  /** 重新读配置并重连（用户改了设置）。 */
  restart(): Promise<void>;
  /** 当前状态。 */
  getStatus(): QqConnectionStatus;
}

/**
 * 把 QQ 来源拼成会话键。
 *
 * @param message 入站消息。
 * @returns 会话键。
 */
export function conversationKeyOf(message: Pick<QqInbound, 'kind' | 'openId'>): string {
  return `${message.kind}:${message.openId}`;
}

/**
 * 创建 QQ 运行时。
 *
 * @param ports 数据访问与回调。
 * @returns 运行时句柄。
 */
export function createQqRuntime(ports: QqRuntimePorts): QqRuntime {
  const log = ports.log ?? ((): void => undefined);
  const createHttp = ports.createHttp ?? ((options) => createQqHttp(options));
  /** 上一次上报过的状态，用来避免重复落库与重复推送。 */
  let lastStatusKey = '';

  /** 发送用的 HTTP 客户端：配置变了就重建。 */
  let sendHttp: QqRuntimeHttp | null = null;
  let sendHttpKey = '';

  /**
   * 取发送用的 HTTP 客户端。
   *
   * 与连接各自持有一个实例是有意的：连接的实例在重连时会被替换，
   * 而发送要在连接之外也能工作（比如用户点了「发送测试消息」）。
   *
   * @returns HTTP 客户端。
   */
  function getSendHttp(): QqRuntimeHttp {
    const config = ports.loadConfig();
    const key = `${config.appId}|${config.appSecret}`;
    if (sendHttp === null || sendHttpKey !== key) {
      sendHttp = createHttp({ appId: config.appId.trim(), appSecret: config.appSecret.trim() });
      sendHttpKey = key;
    }
    return sendHttp;
  }

  /**
   * 状态出口：去重后落库并推送。
   *
   * @param status 状态快照。
   */
  function publishStatus(status: QqConnectionStatus): void {
    const key = `${status.state}|${status.message}|${status.botId ?? ''}`;
    if (key === lastStatusKey) {
      return;
    }
    lastStatusKey = key;
    try {
      ports.onStatus(status);
    } catch (error) {
      log(`上报 QQ 状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 编排层：把事件处理接到运行时提供的端口上。 */
  const service: QqService = createQqService({
    getConfig: () => ports.loadConfig(),
    getContactPolicy: (openId) => ports.lookupContact(openId),
    recordContactSeen: (input) => ports.recordContactSeen(input),
    generateReply: (message, role) =>
      ports.generateReply(conversationKeyOf(message), message, role),
    executeCommand: (command, message) => ports.executeCommand(command, message),
    send: (kind, openId, message) => {
      const http = getSendHttp();
      return kind === 'group'
        ? http.sendGroup(openId, message)
        : http.sendPrivate(openId, message);
    },
    ...(ports.knownSecrets !== undefined ? { knownSecrets: ports.knownSecrets } : {}),
    log,
  });

  /** 连接层：配置从端口读，事件转给编排层。 */
  const connection: QqConnection = createQqConnection({
    getConfig: () => {
      const config = ports.loadConfig();
      return {
        appId: config.appId,
        appSecret: config.appSecret,
        intents: config.intents,
        sandbox: config.sandbox,
      };
    },
    createHttp,
    ...(ports.createGateway !== undefined ? { createGateway: ports.createGateway } : {}),
    onEvent: (payload: GatewayPayload) => {
      // 编排层承诺不抛，这里再兜一层：它是网关回调的接收端
      void service.handleInbound(payload).catch((error: unknown) => {
        log(`处理入站事件失败：${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onState: (state, message) => {
      const current = connection.getState();
      publishStatus({ state, message, botId: current.botId });
    },
    log,
  });

  return {
    async start(): Promise<void> {
      await connection.start();
      publishStatus(connection.getState());
    },

    stop(): void {
      connection.stop();
      publishStatus(connection.getState());
    },

    async restart(): Promise<void> {
      // 配置可能整块换掉（AppID/密钥/intents），所以重建连接而不是原地改
      await connection.restart();
      publishStatus(connection.getState());
    },

    getStatus(): QqConnectionStatus {
      return connection.getState();
    },
  };
}
