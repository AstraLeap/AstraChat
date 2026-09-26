import { randomUUID } from 'node:crypto';
import type { CreateMessageInput, Message, MessageRole, MessageStatus, UpdateMessageInput } from '../types/index';
import type { Db } from './connection';

/**
 * `messages` 表的数据访问层。
 *
 * 流式场景下写入非常频繁（每个 SSE chunk 都可能更新一次 assistant 消息），因此：
 * - `updateMessage` 只更新调用方显式给出的字段（用 COALESCE 式合并），避免整行覆盖。
 * - 这里不做节流，节流策略放在 IPC 层（按内容长度/时间窗批量推送），保持数据层纯粹。
 */

/** SQLite 返回的 messages 行。 */
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  status: string;
  error: string | null;
  model: string | null;
  created_at: number;
}

/**
 * 把数据库行映射为领域对象。
 *
 * @param row SQLite 行。
 * @returns 消息领域对象。
 */
function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    reasoning: row.reasoning,
    status: row.status as MessageStatus,
    error: row.error,
    model: row.model,
    createdAt: row.created_at,
  };
}

/**
 * 列出某个对话的全部消息，按创建时间升序（即对话顺序）。
 *
 * @param db 数据库句柄。
 * @param conversationId 对话 id。
 * @returns 消息数组。
 */
export function listMessages(db: Db, conversationId: string): Message[] {
  const rows = db.raw
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as MessageRow[];
  return rows.map(toMessage);
}

/**
 * 按 id 查询单条消息。
 *
 * @param db 数据库句柄。
 * @param id 消息 id。
 * @returns 找到则返回，否则 `null`。
 */
export function getMessage(db: Db, id: string): Message | null {
  const row = db.raw.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : null;
}

/**
 * 新建消息。
 *
 * @param db 数据库句柄。
 * @param input 对话 id / 角色 / 正文等。
 * @returns 新建的消息。
 * @throws 当对话 id 为空时抛出 `Error`。
 */
export function createMessage(db: Db, input: CreateMessageInput): Message {
  if (!input.conversationId) {
    throw new Error('conversationId 不能为空');
  }

  const message: Message = {
    id: randomUUID(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning ?? null,
    status: input.status ?? 'complete',
    error: input.error ?? null,
    model: input.model ?? null,
    createdAt: Date.now(),
  };

  db.raw
    .prepare(
      `INSERT INTO messages
         (id, conversation_id, role, content, reasoning, status, error, model, created_at)
       VALUES
         (@id, @conversationId, @role, @content, @reasoning, @status, @error, @model, @createdAt)`,
    )
    .run(message);

  return message;
}

/**
 * 更新消息的部分字段。
 *
 * 只更新 `patch` 中出现的键；未出现的字段保持原值。这是流式追加正文的核心方法。
 *
 * @param db 数据库句柄。
 * @param id 消息 id。
 * @param patch 需要更新的字段。
 * @returns 更新后的消息。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function updateMessage(db: Db, id: string, patch: UpdateMessageInput): Message {
  const existing = getMessage(db, id);
  if (!existing) {
    throw new Error(`消息不存在：${id}`);
  }

  const next: Message = {
    ...existing,
    content: patch.content !== undefined ? patch.content : existing.content,
    reasoning: patch.reasoning !== undefined ? patch.reasoning : existing.reasoning,
    status: patch.status !== undefined ? patch.status : existing.status,
    error: patch.error !== undefined ? patch.error : existing.error,
    model: patch.model !== undefined ? patch.model : existing.model,
  };

  db.raw
    .prepare(
      `UPDATE messages
          SET content = @content, reasoning = @reasoning, status = @status,
              error = @error, model = @model
        WHERE id = @id`,
    )
    .run(next);

  return next;
}

/**
 * 删除单条消息。
 *
 * @param db 数据库句柄。
 * @param id 消息 id。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function removeMessage(db: Db, id: string): void {
  const result = db.raw.prepare('DELETE FROM messages WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error(`消息不存在：${id}`);
  }
}

/**
 * 统计某个对话的消息条数。
 *
 * @param db 数据库句柄。
 * @param conversationId 对话 id。
 * @returns 消息条数。
 */
export function countMessages(db: Db, conversationId: string): number {
  const row = db.raw
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
    .get(conversationId) as { n: number };
  return row.n;
}

/**
 * 用对话的首条用户消息自动命名对话。
 *
 * 仅当对话仍是默认标题（`新对话`）时才改写，避免覆盖用户手动命名的标题。
 * 标题取首条用户消息的前 20 个字符。
 *
 * @param db 数据库句柄。
 * @param conversationId 对话 id。
 * @returns 若改写了则返回新标题，否则返回 `null`。
 */
export function autoTitleConversation(db: Db, conversationId: string): string | null {
  const row = db.raw.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as
    | { title: string }
    | undefined;
  if (!row || row.title !== '新对话') {
    return null;
  }

  const first = db.raw
    .prepare(
      `SELECT content FROM messages
        WHERE conversation_id = ? AND role = 'user'
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(conversationId) as { content: string } | undefined;

  if (!first || !first.content.trim()) {
    return null;
  }

  const title = first.content.replace(/\s+/g, ' ').trim().slice(0, 20);
  db.raw.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
  return title;
}

/**
 * 构建发送给模型的历史消息数组（供主进程组装请求体）。
 *
 * 过滤规则：跳过 `system` 消息（系统提示词由人格单独注入）与空内容的 assistant 消息
 * （例如被中止且没吐出任何 token 的占位消息）。
 *
 * @param db 数据库句柄。
 * @param conversationId 对话 id。
 * @param limit 最多取最近多少条，防止上下文无限增长。
 * @returns 形如 `[{ role, content }]` 的数组。
 */
export function buildHistory(
  db: Db,
  conversationId: string,
  limit = 40,
): { role: MessageRole; content: string }[] {
  const rows = db.raw
    .prepare(
      `SELECT role, content FROM (
         SELECT role, content, created_at, rowid AS rid
           FROM messages
          WHERE conversation_id = ? AND role != 'system' AND content != ''
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
       ) ORDER BY created_at ASC, rid ASC`,
    )
    .all(conversationId, limit) as { role: string; content: string }[];

  return rows.map((r) => ({ role: r.role as MessageRole, content: r.content }));
}
