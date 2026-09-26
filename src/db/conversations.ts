import { randomUUID } from 'node:crypto';
import type {
  CreateConversationInput,
  Conversation,
  ConversationSearchHit,
  ConversationSummary,
  UpdateConversationInput,
} from '../types/index';
import type { Db } from './connection';

/**
 * `conversations` 表的数据访问层，含关键词搜索。
 */

/** SQLite 返回的 conversations 行（含可选的聚合列）。 */
interface ConversationRow {
  id: string;
  title: string;
  persona_id: string | null;
  provider_id: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  message_count?: number;
}

/**
 * 把数据库行映射为领域对象。
 *
 * @param row SQLite 行。
 * @returns 对话领域对象。
 */
function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    personaId: row.persona_id,
    providerId: row.provider_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 把数据库行映射为带消息条数的摘要对象。
 *
 * @param row SQLite 行（必须包含 `message_count`）。
 * @returns 对话摘要。
 */
function toSummary(row: ConversationRow): ConversationSummary {
  return { ...toConversation(row), messageCount: row.message_count ?? 0 };
}

/** 列表查询：左连接统计每个对话的消息条数。 */
const LIST_SQL = `
  SELECT c.*, COUNT(m.id) AS message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
   GROUP BY c.id
   ORDER BY c.updated_at DESC
`;

/**
 * 列出全部对话摘要，按最近更新倒序。
 *
 * @param db 数据库句柄。
 * @returns 对话摘要数组。
 */
export function listConversations(db: Db): ConversationSummary[] {
  const rows = db.raw.prepare(LIST_SQL).all() as ConversationRow[];
  return rows.map(toSummary);
}

/**
 * 按 id 查询单个对话。
 *
 * @param db 数据库句柄。
 * @param id 对话 id。
 * @returns 找到则返回，否则 `null`。
 */
export function getConversation(db: Db, id: string): Conversation | null {
  const row = db.raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    | ConversationRow
    | undefined;
  return row ? toConversation(row) : null;
}

/**
 * 新建对话。
 *
 * @param db 数据库句柄。
 * @param input 可选标题 / 人格 / 提供商 / 模型覆盖。
 * @returns 新建的对话。
 */
export function createConversation(db: Db, input: CreateConversationInput = {}): Conversation {
  const now = Date.now();
  const conversation: Conversation = {
    id: randomUUID(),
    title: input.title?.trim() || '新对话',
    personaId: input.personaId ?? null,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.raw
    .prepare(
      `INSERT INTO conversations (id, title, persona_id, provider_id, model, created_at, updated_at)
       VALUES (@id, @title, @personaId, @providerId, @model, @createdAt, @updatedAt)`,
    )
    .run(conversation);

  return conversation;
}

/**
 * 更新对话的部分字段。
 *
 * 注意：有意**不**在这里自动刷新 `updatedAt` 以外的排序语义 —— 发送消息时由
 * {@link touchConversation} 统一刷新，避免「改标题」和「发消息」两种语义混淆。
 *
 * @param db 数据库句柄。
 * @param id 对话 id。
 * @param patch 需要更新的字段。
 * @returns 更新后的对话。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function updateConversation(
  db: Db,
  id: string,
  patch: UpdateConversationInput,
): Conversation {
  const existing = getConversation(db, id);
  if (!existing) {
    throw new Error(`对话不存在：${id}`);
  }

  const next: Conversation = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() || '新对话' : existing.title,
    personaId: patch.personaId !== undefined ? patch.personaId : existing.personaId,
    providerId: patch.providerId !== undefined ? patch.providerId : existing.providerId,
    model: patch.model !== undefined ? patch.model : existing.model,
    updatedAt: Date.now(),
  };

  db.raw
    .prepare(
      `UPDATE conversations
          SET title = @title, persona_id = @personaId, provider_id = @providerId,
              model = @model, updated_at = @updatedAt
        WHERE id = @id`,
    )
    .run(next);

  return next;
}

/**
 * 触碰对话的 `updated_at`（发送消息后调用，让对话冒到列表顶部）。
 *
 * @param db 数据库句柄。
 * @param id 对话 id。
 */
export function touchConversation(db: Db, id: string): void {
  db.raw.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * 删除对话；其消息因外键 `ON DELETE CASCADE` 一并删除。
 *
 * @param db 数据库句柄。
 * @param id 对话 id。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function removeConversation(db: Db, id: string): void {
  const result = db.raw.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error(`对话不存在：${id}`);
  }
}

/**
 * 按关键词搜索对话。
 *
 * 命中范围：对话标题，或该对话下任意消息的正文。返回的 `snippet` 取第一条命中消息
 * 的上下文片段（命中词前后各留一段），便于列表预览。
 *
 * 实现说明：用 `instr()` 做**大小写不敏感**的子串匹配（先对两边 `lower()`），
 * 而不是 `LIKE` —— 这样用户输入 `%` 或 `_` 时不会被当成通配符，无需额外转义。
 *
 * @param db 数据库句柄。
 * @param keyword 搜索关键词；空白字符串直接返回空数组。
 * @returns 命中列表，按对话最近更新倒序。
 */
export function searchConversations(db: Db, keyword: string): ConversationSearchHit[] {
  const needle = keyword.trim();
  if (!needle) {
    return [];
  }

  const lowered = needle.toLowerCase();

  const matched = db.raw
    .prepare(
      `SELECT c.*, COUNT(m.id) AS message_count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE instr(lower(c.title), @needle) > 0
           OR EXISTS (
                SELECT 1 FROM messages mm
                 WHERE mm.conversation_id = c.id
                   AND instr(lower(mm.content), @needle) > 0
              )
        GROUP BY c.id
        ORDER BY c.updated_at DESC`,
    )
    .all({ needle: lowered }) as ConversationRow[];

  const messageStmt = db.raw.prepare(
    `SELECT id, content FROM messages
      WHERE conversation_id = ? AND instr(lower(content), ?) > 0
      ORDER BY created_at ASC
      LIMIT 5`,
  );

  return matched.map((row) => {
    const hits = messageStmt.all(row.id, lowered) as { id: string; content: string }[];
    const first = hits[0];
    return {
      conversation: toSummary(row),
      matchedMessageIds: hits.map((h) => h.id),
      snippet: first ? buildSnippet(first.content, needle) : '',
    };
  });
}

/**
 * 从消息正文中截取包含关键词的片段。
 *
 * @param content 消息全文。
 * @param needle 关键词。
 * @returns 截断后的片段（命中词前后各留 40 字符），带省略号。
 */
function buildSnippet(content: string, needle: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const index = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) {
    return flat.slice(0, 80);
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(flat.length, index + needle.length + 40);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
