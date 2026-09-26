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
 * **运行期**连接状态。
 *
 * 与 {@link QqConnectionStatus} 是**两个不同概念**，别混：
 *
 * | 类型 | 取值 | 用途 |
 * |---|---|---|
 * | `QqConnectionStatus` | `disconnected` / `connected` / `error` | **落库**（`QqConfig.status`） |
 * | `QqConnectionState` | `stopped` / `connecting` / `connected` / `error` | **运行期快照** |
 *
 * 运行期多一个 `connecting`（瞬时态，不该落库），且「用户主动停止」在运行期是
 * `stopped`、落库是 `disconnected`。两者的映射见
 * `src/services/qq/status.ts` 的 `toPersistedStatus`。
 */
export type QqConnectionState = 'stopped' | 'connecting' | 'connected' | 'error';

/** 运行期连接状态快照（设置页显示的就是它）。 */
export interface QqConnectionSnapshot {
  /** 运行期状态。 */
  state: QqConnectionState;
  /** 补充说明：错误原因、进度提示等；可直接展示给用户。 */
  message: string;
  /** 机器人自己的 id；收到 READY 之前为 `null`。 */
  botId: string | null;
}

/**
 * QQ bot 配置。
 *
 * v0.1.0 **只做配置存储与界面呈现**：「连接 / 断开」按钮只切换本地状态，不建立任何网络连接。
 * v0.2.0 按 `docs/qq-integration-design.md` 走**官方 QQ 开放平台 Bot API**，真实连接实现在
 * 主进程（`electron/qq/`）。
 *
 * 关于白名单：官方 API 只提供 `openid`（不给 QQ 号 / 群号），因此授权主体记录在
 * `qq_contacts` 表里（见 {@link QqContact}），本配置只保留**全局策略**。
 * v0.1.0 的 `groupIds` 单列已在 schema v2 中迁移进 `qq_contacts`。
 */
export interface QqConfig {
  /** 单例行 id，固定为 `default`。 */
  id: string;
  appId: string;
  appSecret: string;
  token: string;
  /** 总开关。关闭时不处理任何消息。 */
  enabled: boolean;
  status: QqConnectionStatus;
  /** 状态补充说明，如最近一次错误原因。 */
  statusMessage: string | null;
  /**
   * 事件订阅位掩码。
   *
   * 要收到**群里全部消息**（不限于 @ 机器人）必须包含 `GROUP_AND_C2C_EVENT`（`1 << 25`）。
   * 默认 0 表示尚未配置。
   */
  intents: number;
  /** 是否使用沙箱环境（开发期用沙箱，正式发布用正式环境）。 */
  sandbox: boolean;
  /** 管理员 openid 列表。管理命令只认这个列表，与模型判断无关。 */
  ownerOpenIds: string[];
  /**
   * 白名单为空时是否放行全部来源。
   *
   * **默认 `false`（fail-closed）**：白名单为空时谁都不理，只把来源记进 `qq_contacts`
   * 等用户授权。打开它等于把机器人账号交给模型，界面上必须给出警示。
   */
  allowAllWhenEmpty: boolean;
  /** 私聊是否应答（仍受 `qq_contacts.policy` 约束）。 */
  replyInPrivate: boolean;
  /** 发送前是否做内容审计（拦截本机路径与凭据特征）。 */
  auditEnabled: boolean;
  /** 相邻两条消息之间的固定间隔（毫秒），防触发风控。 */
  sendDelayMs: number;
  /** 每分钟发送上限。 */
  maxSendPerMinute: number;
  /** 每小时发送上限。 */
  maxSendPerHour: number;
  /** 单条回复字符上限，超出会按代理对安全切分。 */
  maxReplyChars: number;
  /**
   * 是否让模型**自行决定是否回复**群里的背景消息。
   *
   * - `off`：只回应被 @ 或私聊的消息（默认，行为最保守）
   * - `standard`：标准模式。单次调用 + 哨兵，模型不想说话时只输出 `[[SILENCE]]`
   * - `exp`：**实验性**模式。两次调用（先判定再生成），更准但消耗约翻倍
   *
   * 开启后，未被指向的群消息也会投给模型由它判断 —— 这正是「选择性参与」。
   * 关掉时这些消息在授权阶段就被忽略，不会产生任何模型调用。
   */
  socialMode: QqSocialMode;
  /** 同一来源两次**主动**发言之间的最小间隔（毫秒）。防止机器人刷屏。 */
  socialCooldownMs: number;
  /** 同一来源每小时的主动发言上限。被 @ 与私聊不受此限制。 */
  socialMaxPerHour: number;
  updatedAt: number;
}

/**
 * QQ 发言模式。
 *
 * `standard` 与 `exp` 的区别只在**判定方式**：前者在同一次调用里让模型用哨兵表态，
 * 后者多花一次调用来判定。后者更准的原因是「生成中的模型有把话说下去的惯性」。
 */
export type QqSocialMode = 'off' | 'standard' | 'exp';

/** 更新 QQ 配置的入参。 */
export type UpdateQqConfigInput = Partial<Omit<QqConfig, 'id' | 'updatedAt'>>;

/** 来源类型：群聊或私聊。 */
export type QqContactKind = 'group' | 'private';

/**
 * 来源授权三态。
 *
 * - `none`：见过但**未授权**（默认）。消息不投递给模型，仅出现在设置页待授权列表里。
 * - `allow`：允许。消息会投递给模型。
 * - `deny`：拒绝。**优先级高于 `allow`**，用于临时拉黑某个群/人。
 */
export type QqContactPolicy = 'none' | 'allow' | 'deny';

/**
 * 一个 QQ 来源（群或私聊）。
 *
 * 为什么需要这张表：官方 API 的群与用户标识是 `openid`（机器人视角唯一），
 * 用户**无法预先手填**。所以机器人必须先收到消息、把来源记录下来，用户再到设置页里
 * 逐个授权。`openId` 对群是 `group_openid`，对私聊是 `user_openid`。
 */
export interface QqContact {
  /** `group_openid` 或 `user_openid`，全局唯一。 */
  openId: string;
  kind: QqContactKind;
  /** 群名 / 昵称；事件里通常没有群名，取不到时为 `null`。 */
  displayName: string | null;
  policy: QqContactPolicy;
  /** 首次见到的时间（Unix 毫秒）。 */
  firstSeenAt: number;
  /** 最近一次见到的时间（Unix 毫秒）。 */
  lastSeenAt: number;
  /** 累计收到多少条消息，用于列表排序与判断活跃度。 */
  messageCount: number;
}

/** 更新来源授权的入参。 */
export interface UpdateQqContactInput {
  /** 只允许改授权状态与显示名，来源标识本身不可改。 */
  policy?: QqContactPolicy;
  displayName?: string | null;
}

/**
 * 列出来源时的过滤条件。
 *
 * 放在 `src/types` 而不是 `src/db` 里，是为了让渲染进程也能引用它
 * （渲染进程不能 import `src/db`，那里依赖 better-sqlite3 原生模块）。
 */
export interface ListQqContactsFilter {
  /** 只看群或只看私聊。 */
  kind?: QqContactKind;
  /** 只看某个授权状态。 */
  policy?: QqContactPolicy;
}

/** 各授权状态下的来源数量（设置页徽章用）。 */
export interface QqContactCounts {
  /** 见过但未授权。 */
  none: number;
  /** 已允许。 */
  allow: number;
  /** 已拒绝。 */
  deny: number;
  /** 总数。 */
  total: number;
}

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
