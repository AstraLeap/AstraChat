import type { QqInbound } from './events';
import type { QqHistory } from './history';

/**
 * 把「按来源隔离的历史」拼成给模型的对话。
 *
 * ## 这一层存在的理由
 *
 * 模型的输入不是「一条消息」而是**一段对话**。QQ 推过来的却是孤立的事件，所以中间必须
 * 有一次装配：谁说的、是机器人说的还是别人说的、之前发生了什么。
 *
 * ## 两个关键规则
 *
 * 1. **谁说的必须标出来。** 群聊里如果只把各人的话拼成一串，模型分不清「你好」是谁说的，
 *    会把它当成一个连续的第一人称叙述，回出来的话就驴唇不对马嘴。所以群聊按
 *    `昵称：内容` 标注；机器人自己的历史标成 `助手` 语义（`role: 'assistant'`）。
 * 2. **`fromBot` 决定 role，而不是靠昵称猜。** 历史里存了明确的布尔值，
 *    避免「有人把昵称改成机器人的名字」就能污染对话结构这种低级但真实的问题。
 *
 * ## 模型调用为什么是注入的
 *
 * 这一层只负责「拼出 messages」，不负责调用模型 —— 于是它完全是纯逻辑、可以被单测覆盖。
 * 真正碰 `src/services/openai.ts` 的适配由调用方注入，那部分不需要新的判定逻辑。
 */

/** 给模型的一条消息（结构上兼容 OpenAI 风格）。 */
export interface QqPromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 装配依赖。 */
export interface QqConversationDeps {
  /** 按来源隔离的历史。 */
  history: QqHistory;
  /**
   * 取系统提示词。
   *
   * @param message 入站消息（可按群 / 私聊给不同的人格与说明）。
   * @returns 系统提示词。
   */
  getSystemPrompt: (message: QqInbound) => string;
}

/** 会话装配器。 */
export interface QqConversation {
  /**
   * 记下一条入站消息并产出给模型的完整对话。
   *
   * **先记录再拼装**：这样当前这条天然包含在 prompt 里，不需要额外补一次 ——
   * 反过来（先拼装再记录）很容易写成把当前消息加两遍。
   *
   * @param message 入站消息。
   * @returns 从系统提示词开始的完整 messages。
   */
  buildPrompt: (message: QqInbound) => QqPromptMessage[];
  /**
   * 记下机器人的回复。
   *
   * @param key 来源键。
   * @param reply 回复内容（空白不记）。
   */
  rememberReply: (key: string, reply: string) => void;
  /**
   * 清空某个来源的历史（`/reset` 命令用）。
   *
   * @param key 来源键。
   */
  reset: (key: string) => void;
}

/**
   * 拼出某个来源的键。
   *
   * 与 `runtime.ts` 的 `conversationKeyOf` 保持一致：
   * 群与私聊用不同前缀，**即使 openid 相同也不共用上下文**。
   *
   * @param message 入站消息。
   * @returns 来源键。
   */
export function promptKeyOf(message: Pick<QqInbound, 'kind' | 'openId'>): string {
  return `${message.kind}:${message.openId}`;
}

/**
 * 给一条入站消息标注说话人。
 *
 * @param message 入站消息。
 * @returns 带标注的文本。
 */
function labelIncoming(message: QqInbound): string {
  const name = message.senderName !== null && message.senderName.length > 0
    ? message.senderName
    : message.kind === 'group'
      ? '某位群友'
      : '用户';
  return `${name}：${message.content}`;
}

/**
 * 创建会话装配器。
 *
 * @param deps 依赖。
 * @returns 装配器。
 */
export function createQqConversation(deps: QqConversationDeps): QqConversation {
  return {
    buildPrompt(message: QqInbound): QqPromptMessage[] {
      const key = promptKeyOf(message);

      // 先记录当前这条，再整体读出来 —— 避免把当前消息加两遍
      deps.history.append(key, {
        speaker: message.senderName ?? '',
        text: message.content,
        fromBot: false,
      });

      const messages: QqPromptMessage[] = [];
      const system = deps.getSystemPrompt(message);
      if (system.trim().length > 0) {
        messages.push({ role: 'system', content: system });
      }

      // 历史里最后一条就是刚记录的当前消息，因此按「谁会看到」标注它
      const entries = deps.history.list(key);
      const lastIndex = entries.length - 1;
      entries.forEach((entry, index) => {
        if (entry.fromBot) {
          // 机器人自己说过的话：用 assistant role 表达，不靠昵称猜测 ——
          // 否则有人把昵称改成机器人的名字就能污染对话结构
          messages.push({ role: 'assistant', content: entry.text });
          return;
        }
        if (index === lastIndex) {
          messages.push({ role: 'user', content: labelIncoming(message) });
          return;
        }
        const name = entry.speaker.length > 0 ? entry.speaker : '群友';
        messages.push({ role: 'user', content: `${name}：${entry.text}` });
      });

      return messages;
    },

    rememberReply(key: string, reply: string): void {
      if (typeof reply !== 'string' || reply.trim().length === 0) {
        return;
      }
      deps.history.append(key, { speaker: '', text: reply, fromBot: true });
    },

    reset(key: string): void {
      deps.history.clear(key);
    },
  };
}
