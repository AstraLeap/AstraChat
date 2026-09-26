/**
 * IPC 契约：主进程 ⇄ 渲染进程的通道名与 API 形状。
 *
 * 这是**冻结接口**。三条铁律：
 * 1. 通道名只在 `IPC_CHANNELS` 里出现一次，主进程注册与预加载暴露都从这里取值，
 *    杜绝字符串字面量拼错导致的「静默无响应」。
 * 2. 所有请求-响应型调用走 `ipcRenderer.invoke`（Promise），只有服务端主动推送的
 *    流式事件走 `ipcRenderer.on`。
 * 3. 主进程**只返回裸业务值**；失败时抛 `Error`，由 `invoke` 自动转成渲染层的
 *    rejected Promise（Electron 会把 message 串起来，前缀为 `Error invoking remote method`）。
 */

import type {
  AppInfo,
  ChatSendRequest,
  ChatStreamEvent,
  Conversation,
  ConversationSearchHit,
  ConversationSummary,
  CreateConversationInput,
  CreateMessageInput,
  CreatePersonaInput,
  CreateProviderInput,
  Message,
  Persona,
  Provider,
  QqConfig,
  UpdateConversationInput,
  UpdateMessageInput,
  UpdatePersonaInput,
  UpdateProviderInput,
  UpdateQqConfigInput,
} from './index';

/** 全部 IPC 通道名。 */
export const IPC_CHANNELS = {
  app: {
    info: 'app:info',
  },
  providers: {
    list: 'providers:list',
    create: 'providers:create',
    update: 'providers:update',
    remove: 'providers:remove',
  },
  conversations: {
    list: 'conversations:list',
    get: 'conversations:get',
    create: 'conversations:create',
    update: 'conversations:update',
    remove: 'conversations:remove',
    search: 'conversations:search',
  },
  messages: {
    list: 'messages:list',
    create: 'messages:create',
    update: 'messages:update',
    remove: 'messages:remove',
  },
  personas: {
    list: 'personas:list',
    create: 'personas:create',
    update: 'personas:update',
    remove: 'personas:remove',
  },
  qq: {
    get: 'qq:get',
    save: 'qq:save',
  },
  chat: {
    /** 发起一次流式回复（invoke，立即返回 streamId）。 */
    send: 'chat:send',
    /** 中止一次流式回复（invoke）。 */
    abort: 'chat:abort',
    /** 主进程 → 渲染进程的流式事件推送（on）。 */
    event: 'chat:event',
  },
} as const;

/**
 * `window.astra` 的形状：预加载脚本通过 `contextBridge` 暴露给渲染进程的全部能力。
 *
 * 渲染进程**没有任何 Node 权限**（`contextIsolation: true` + `sandbox: true` +
 * `nodeIntegration: false`），一切数据访问都必须经由这个对象。
 */
export interface AstraApi {
  /** 应用与环境信息。 */
  app: {
    info(): Promise<AppInfo>;
  };

  /** 模型提供商 CRUD。 */
  providers: {
    list(): Promise<Provider[]>;
    create(input: CreateProviderInput): Promise<Provider>;
    update(id: string, patch: UpdateProviderInput): Promise<Provider>;
    remove(id: string): Promise<void>;
  };

  /** 对话 CRUD 与搜索。 */
  conversations: {
    list(): Promise<ConversationSummary[]>;
    get(id: string): Promise<Conversation | null>;
    create(input: CreateConversationInput): Promise<Conversation>;
    update(id: string, patch: UpdateConversationInput): Promise<Conversation>;
    remove(id: string): Promise<void>;
    search(keyword: string): Promise<ConversationSearchHit[]>;
  };

  /** 消息 CRUD。 */
  messages: {
    list(conversationId: string): Promise<Message[]>;
    create(input: CreateMessageInput): Promise<Message>;
    update(id: string, patch: UpdateMessageInput): Promise<Message>;
    remove(id: string): Promise<void>;
  };

  /** 人格（角色）CRUD。 */
  personas: {
    list(): Promise<Persona[]>;
    create(input: CreatePersonaInput): Promise<Persona>;
    update(id: string, patch: UpdatePersonaInput): Promise<Persona>;
    remove(id: string): Promise<void>;
  };

  /** QQ bot 配置（v0.1.0 仅存储）。 */
  qq: {
    get(): Promise<QqConfig>;
    save(patch: UpdateQqConfigInput): Promise<QqConfig>;
  };

  /** 流式聊天。 */
  chat: {
    /**
     * 发起一次流式回复。
     *
     * 主进程会：①落库用户消息 → ②落库一条 `streaming` 状态的 assistant 消息 →
     * ③用 fetch + ReadableStream 请求提供商并按 SSE 解析 → ④逐块推送 `delta` 事件 →
     * ⑤结束时把 assistant 消息落为 `complete` 并推送 `done`。
     *
     * @returns `streamId`，用于 `abort` 或匹配事件。
     */
    send(request: ChatSendRequest): Promise<{ streamId: string }>;
    /** 中止指定的流；已接收内容会被保留并标记为 `aborted`。 */
    abort(streamId: string): Promise<void>;
    /**
     * 订阅流式事件。
     *
     * @param listener 事件回调。
     * @returns 取消订阅函数（React 里应在 `useEffect` 的清理阶段调用）。
     */
    onEvent(listener: (event: ChatStreamEvent) => void): () => void;
  };
}
