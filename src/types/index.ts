/**
 * AstraChat 领域模型（Domain Model）。
 *
 * 本文件是主进程与渲染进程之间**唯一的事实来源**：两侧都只 `import type` 这里定义
 * 的结构，任何一侧都不得私自扩展字段。IPC 通道常量见 `./ipc.ts`。
 *
 * 约定：
 * - 所有实体的 `id` 都是主进程生成的 UUID v4 字符串。
 * - 所有时间戳（`createdAt` / `updatedAt`）都是 **Unix 毫秒**（`Date.now()`），
 *   而不是秒 —— 渲染层直接用 `new Date(ms)` 即可。
 * - 发送给渲染进程的实体一律是「裸业务值」，不带 `{ ok, value }` 包装。
 */

// ---------------------------------------------------------------------------
// 模型提供商
// ---------------------------------------------------------------------------

/**
 * 一个 OpenAI 兼容的模型提供商配置。
 *
 * AstraChat v0.1.0 只对接 OpenAI 兼容协议（`POST {baseUrl}/chat/completions`），
 * Anthropic / Gemini 等非兼容协议需要各自的中转网关或后续版本适配。
 */
export interface Provider {
  /** UUID v4。 */
  id: string;
  /** 展示名称，如「DeepSeek 官方」。 */
  name: string;
  /** 接口根地址，不含 `/chat/completions`，如 `https://api.deepseek.com/v1`。 */
  baseUrl: string;
  /** API Key（明文存储在本机 SQLite，v0.1.0 不做加密）。 */
  apiKey: string;
  /** 该提供商的默认模型名，如 `deepseek-chat`。 */
  model: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建提供商时的入参（`id` 与时间戳由数据层生成）。 */
export type CreateProviderInput = Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>;

/** 更新提供商的入参，所有字段可选。 */
export type UpdateProviderInput = Partial<CreateProviderInput>;

/**
 * 内置的提供商预设（仅用于「新建提供商」表单的一键填充，不是硬编码依赖）。
 *
 * 预设不会写入数据库，用户可以完全自由地增删改。
 */
export interface ProviderPreset {
  /** 预设标识，如 `deepseek`。 */
  key: string;
  /** 展示名称。 */
  name: string;
  /** 预填的接口根地址。 */
  baseUrl: string;
  /** 预填的默认模型名。 */
  model: string;
  /** 该提供商申请 API Key 的页面（可选，用于 UI 提示）。 */
  docsUrl?: string;
}

// ---------------------------------------------------------------------------
// 对话与消息
// ---------------------------------------------------------------------------

/** 消息角色。`system` 一般由人格提示词注入，不直接展示为气泡。 */
export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * 消息的生命周期状态。
 *
 * - `streaming`：正在流式接收，渲染层应显示光标/加载态。
 * - `complete`：正常结束。
 * - `error`：请求失败，`Message.error` 携带原因。
 * - `aborted`：被用户主动中止，已接收的内容予以保留。
 */
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'aborted';

/** 一条聊天消息。 */
export interface Message {
  /** UUID v4。 */
  id: string;
  /** 所属对话 id。 */
  conversationId: string;
  role: MessageRole;
  /** 正文（Markdown 文本）。 */
  content: string;
  /**
   * 推理模型的思维链内容（如 DeepSeek-R1 的 `reasoning_content`）。
   * 非推理模型为 `null`。
   */
  reasoning: string | null;
  status: MessageStatus;
  /** 失败原因；仅 `status === 'error'` 时有值。 */
  error: string | null;
  /** 该消息使用的模型名（便于回看历史时区分模型）。 */
  model: string | null;
  createdAt: number;
}

/** 新建消息的入参。 */
export interface CreateMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  reasoning?: string | null;
  status?: MessageStatus;
  error?: string | null;
  model?: string | null;
}

/** 更新消息的入参（流式过程中不断追加内容）。 */
export type UpdateMessageInput = Partial<Omit<CreateMessageInput, 'conversationId'>>;

/** 一个会话（对话）。 */
export interface Conversation {
  /** UUID v4。 */
  id: string;
  /** 标题；新建时默认为「新对话」，首条消息后可自动改写。 */
  title: string;
  /** 绑定的人格 id；`null` 表示不注入系统提示词。 */
  personaId: string | null;
  /** 使用的提供商 id；`null` 表示尚未选择。 */
  providerId: string | null;
  /** 覆盖提供商默认模型的模型名；`null` 表示用提供商的默认模型。 */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 携带消息条数的对话（列表页展示用）。 */
export interface ConversationSummary extends Conversation {
  /** 该对话下的消息总数。 */
  messageCount: number;
}

/** 新建对话的入参。 */
export interface CreateConversationInput {
  title?: string;
  personaId?: string | null;
  providerId?: string | null;
  model?: string | null;
}

/** 更新对话的入参。 */
export type UpdateConversationInput = Partial<CreateConversationInput>;

/**
 * 对话搜索结果：命中关键词的对话，以及**命中消息的片段摘要**。
 */
export interface ConversationSearchHit {
  conversation: ConversationSummary;
  /** 命中的消息 id 列表（最多若干条）。 */
  matchedMessageIds: string[];
  /** 命中消息的正文片段（截断，用于列表预览）。 */
  snippet: string;
}

// ---------------------------------------------------------------------------
// 人格 / 提示词
// ---------------------------------------------------------------------------

/** 一个「角色」（人格）：名称 + 头像 + 系统提示词。 */
export interface Persona {
  /** UUID v4。 */
  id: string;
  name: string;
  /** 头像：data URL 或空。`null` 表示使用首字母占位。 */
  avatar: string | null;
  /** 系统提示词，发送消息时注入到 messages 数组首位。 */
  systemPrompt: string;
  /** 是否为内置示例角色（内置角色可编辑，但删除时会给出提示）。 */
  isPreset: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 新建人格的入参。 */
export type CreatePersonaInput = Omit<Persona, 'id' | 'createdAt' | 'updatedAt' | 'isPreset'> & {
  isPreset?: boolean;
};

/** 更新人格的入参。 */
export type UpdatePersonaInput = Partial<Omit<Persona, 'id' | 'createdAt' | 'updatedAt'>>;

// ---------------------------------------------------------------------------
// QQ bot 接入配置（v0.1.0 仅 UI 与配置存储）
// ---------------------------------------------------------------------------

/** QQ bot 的连接状态。v0.1.0 不会真正连接，状态由用户操作驱动。 */
export type QqConnectionStatus = 'disconnected' | 'connected' | 'error';

/**
 * QQ bot 配置。
 *
 * v0.1.0 **只做配置存储与界面呈现**：`appId` / `appSecret` / `token` / `groupIds`
 * 落库，「连接 / 断开」按钮只切换本地状态，不会建立任何网络连接。
 * v0.2.0 的真实连接实现应接入 `electron/qq.ts`（预留的适配器接口）。
 */
export interface QqConfig {
  /** 单例行 id，固定为 `default`。 */
  id: string;
  appId: string;
  appSecret: string;
  token: string;
  /** 允许响应的群号列表（字符串形式，避免超出 JS 安全整数范围）。 */
  groupIds: string[];
  /** 是否启用自动回复（v0.2.0 生效）。 */
  enabled: boolean;
  status: QqConnectionStatus;
  /** 状态补充说明，如最近一次错误原因。 */
  statusMessage: string | null;
  updatedAt: number;
}

/** 更新 QQ 配置的入参。 */
export type UpdateQqConfigInput = Partial<Omit<QqConfig, 'id' | 'updatedAt'>>;

// ---------------------------------------------------------------------------
// 聊天流式事件
// ---------------------------------------------------------------------------

/** 一次流式回复的发起参数。 */
export interface ChatSendRequest {
  /** 目标对话 id。 */
  conversationId: string;
  /** 用户本轮输入的文本。 */
  content: string;
  /** 使用的提供商 id。 */
  providerId: string;
  /** 实际使用的模型名。 */
  model: string;
  /** 绑定的人格 id（决定注入哪段系统提示词）。 */
  personaId: string | null;
  /** 采样温度，`undefined` 表示用服务端默认值。 */
  temperature?: number;
}

/**
 * 主进程 → 渲染进程的流式事件。
 *
 * 全部事件都带 `streamId`，渲染层据此区分并发/历史流；`messageId` 指向那条
 * 正在被写入的 assistant 消息。
 */
export type ChatStreamEvent =
  | { type: 'start'; streamId: string; messageId: string; conversationId: string }
  | {
      type: 'delta';
      streamId: string;
      messageId: string;
      /** 正文增量。 */
      content: string;
      /** 思维链增量。 */
      reasoning: string;
    }
  | { type: 'done'; streamId: string; messageId: string; message: Message }
  | { type: 'error'; streamId: string; messageId: string; error: string };

// ---------------------------------------------------------------------------
// 应用信息
// ---------------------------------------------------------------------------

/** 应用与环境信息（设置页「关于」区块展示）。 */
export interface AppInfo {
  /** `package.json` 中的版本号。 */
  version: string;
  /** Electron 版本。 */
  electronVersion: string;
  /** Node 版本。 */
  nodeVersion: string;
  /** Chrome 版本。 */
  chromeVersion: string;
  /** SQLite 文件所在目录。 */
  userDataDir: string;
}
