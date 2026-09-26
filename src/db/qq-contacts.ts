import type {
  ListQqContactsFilter,
  QqContact,
  QqContactCounts,
  QqContactKind,
  QqContactPolicy,
  UpdateQqContactInput,
} from '../types/index';
import type { Db } from './connection';

// 过滤条件与计数结构的唯一定义在 `src/types/index.ts`（渲染进程也要用），
// 这里只是转出去，方便 `src/db/index.ts` 一并导出。
export type { ListQqContactsFilter, QqContactCounts };

/**
 * `qq_contacts` 表的数据访问层：QQ 来源（群 / 私聊）的授权管理。
 *
 * ## 为什么是「发现」而不是「配置」
 *
 * 官方 QQ 开放平台只提供 `openid`（机器人视角的唯一标识），**不提供 QQ 号 / 群号**。
 * 用户没有办法预先手填白名单，所以流程必然是：
 *
 * 1. 机器人先收到消息 → 把来源 `upsert` 进本表（`policy` 默认 `'none'`）；
 * 2. 消息**不投递给模型**（fail-closed），只在设置页的「已发现的来源」里出现；
 * 3. 用户逐个设为 `allow` / `deny`；
 * 4. 只有 `policy='allow'`（且未被 `deny` 覆盖）的来源才会被回应。
 *
 * 这个设计比「手填群号」更安全（不会填错）也更省事（不用去查群号）。
 */

/** SQLite 返回的 qq_contacts 行。 */
interface QqContactRow {
  open_id: string;
  kind: string;
  display_name: string | null;
  policy: string;
  first_seen_at: number;
  last_seen_at: number;
  message_count: number;
}

/**
 * 把数据库行映射为领域对象。
 *
 * @param row SQLite 行。
 * @returns 来源对象。
 */
function toQqContact(row: QqContactRow): QqContact {
  return {
    openId: row.open_id,
    kind: row.kind as QqContactKind,
    displayName: row.display_name,
    policy: row.policy as QqContactPolicy,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    messageCount: row.message_count,
  };
}

/** 列出来源时的可选过滤条件（定义见 `src/types/index.ts`）。 */

/**
 * 列出已发现的来源，按最近活动倒序。
 *
 * @param db 数据库句柄。
 * @param filter 可选过滤条件。
 * @returns 来源数组。
 */
export function listQqContacts(db: Db, filter: ListQqContactsFilter = {}): QqContact[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.kind) {
    conditions.push('kind = @kind');
    params.kind = filter.kind;
  }
  if (filter.policy) {
    conditions.push('policy = @policy');
    params.policy = filter.policy;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.raw
    .prepare(`SELECT * FROM qq_contacts ${where} ORDER BY last_seen_at DESC`)
    .all(params) as QqContactRow[];

  return rows.map(toQqContact);
}

/**
 * 按 openid 查询单个来源。
 *
 * @param db 数据库句柄。
 * @param openId 来源标识。
 * @returns 找到则返回，否则 `null`。
 */
export function getQqContact(db: Db, openId: string): QqContact | null {
  const row = db.raw.prepare('SELECT * FROM qq_contacts WHERE open_id = ?').get(openId) as
    | QqContactRow
    | undefined;
  return row ? toQqContact(row) : null;
}

/** 记录一次「见到来源」所需的信息。 */
export interface RecordQqContactSeenInput {
  /** `group_openid` 或 `user_openid`。 */
  openId: string;
  /** 来源类型。 */
  kind: QqContactKind;
  /** 群名 / 昵称；拿不到时省略。 */
  displayName?: string | null;
  /** 事件时间（Unix 毫秒）；省略时取当前时间。 */
  seenAt?: number;
}

/**
 * 记录「又见到这个来源一条消息」，不存在则新建。
 *
 * 语义要点：
 * - 已存在的来源**保留其授权状态**（`policy` 不被覆盖）—— 用户授权过就不该因为
 *   又来一条消息而被重置；
 * - `display_name` 只在传入非空时才更新（事件里未必带昵称）；
 * - `message_count` 自增，`last_seen_at` 刷新。
 *
 * @param db 数据库句柄。
 * @param input 来源信息。
 * @returns 更新后的来源对象。
 * @throws 当 `openId` 为空时抛出 `Error`。
 */
export function recordQqContactSeen(db: Db, input: RecordQqContactSeenInput): QqContact {
  const openId = String(input.openId ?? '').trim();
  if (!openId) {
    throw new Error('openId 不能为空');
  }
  const now = input.seenAt ?? Date.now();
  const displayName = input.displayName?.trim() ? input.displayName.trim() : null;

  db.raw
    .prepare(
      `INSERT INTO qq_contacts
         (open_id, kind, display_name, policy, first_seen_at, last_seen_at, message_count)
       VALUES
         (@openId, @kind, @displayName, 'none', @now, @now, 1)
       ON CONFLICT(open_id) DO UPDATE SET
         kind = excluded.kind,
         last_seen_at = excluded.last_seen_at,
         message_count = qq_contacts.message_count + 1,
         display_name = COALESCE(excluded.display_name, qq_contacts.display_name)`,
    )
    .run({ openId, kind: input.kind, displayName, now });

  const saved = getQqContact(db, openId);
  if (!saved) {
    throw new Error(`来源写入后读回失败：${openId}`);
  }
  return saved;
}

/**
 * 设置来源的授权状态。
 *
 * @param db 数据库句柄。
 * @param openId 来源标识。
 * @param policy 目标授权状态。
 * @returns 更新后的来源对象。
 * @throws 当来源不存在时抛出 `Error`。
 */
export function setQqContactPolicy(
  db: Db,
  openId: string,
  policy: QqContactPolicy,
): QqContact {
  const result = db.raw
    .prepare('UPDATE qq_contacts SET policy = ? WHERE open_id = ?')
    .run(policy, openId);
  if (result.changes === 0) {
    throw new Error(`来源不存在：${openId}`);
  }
  const saved = getQqContact(db, openId);
  if (!saved) {
    throw new Error(`来源读回失败：${openId}`);
  }
  return saved;
}

/**
 * 更新来源的可编辑字段（授权状态 / 显示名）。
 *
 * @param db 数据库句柄。
 * @param openId 来源标识。
 * @param patch 需要更新的字段。
 * @returns 更新后的来源对象。
 * @throws 当来源不存在时抛出 `Error`。
 */
export function updateQqContact(
  db: Db,
  openId: string,
  patch: UpdateQqContactInput,
): QqContact {
  const existing = getQqContact(db, openId);
  if (!existing) {
    throw new Error(`来源不存在：${openId}`);
  }

  const next: QqContact = {
    ...existing,
    policy: patch.policy ?? existing.policy,
    displayName: patch.displayName !== undefined ? patch.displayName : existing.displayName,
  };

  db.raw
    .prepare('UPDATE qq_contacts SET policy = ?, display_name = ? WHERE open_id = ?')
    .run(next.policy, next.displayName, openId);

  return next;
}

/**
 * 删除一个来源记录。
 *
 * @param db 数据库句柄。
 * @param openId 来源标识。
 * @throws 当来源不存在时抛出 `Error`。
 */
export function removeQqContact(db: Db, openId: string): void {
  const result = db.raw.prepare('DELETE FROM qq_contacts WHERE open_id = ?').run(openId);
  if (result.changes === 0) {
    throw new Error(`来源不存在：${openId}`);
  }
}

/**
 * 取出被允许的来源 openid 列表。
 *
 * 供 v0.2.0 的消息投递判定使用：**`deny` 不在这里出现**，因此天然满足
 * 「deny 优先于 allow」—— 判定时只需看「是不是在这个集合里」。
 *
 * @param db 数据库句柄。
 * @param kind 只取某一类来源；省略则两类都取。
 * @returns 允许的 openid 数组。
 */
export function listAllowedOpenIds(db: Db, kind?: QqContactKind): string[] {
  const filter: ListQqContactsFilter = { policy: 'allow' };
  if (kind) {
    filter.kind = kind;
  }
  return listQqContacts(db, filter).map((contact) => contact.openId);
}

/**
 * 统计各授权状态下的来源数量（设置页徽章用）。
 *
 * @param db 数据库句柄。
 * @returns `{ none, allow, deny, total }`。
 */
export function countQqContactsByPolicy(db: Db): QqContactCounts {
  const rows = db.raw
    .prepare('SELECT policy, COUNT(*) AS n FROM qq_contacts GROUP BY policy')
    .all() as { policy: string; n: number }[];

  const counts: QqContactCounts = {
    none: 0,
    allow: 0,
    deny: 0,
    total: 0,
  };
  for (const row of rows) {
    const policy = row.policy as QqContactPolicy;
    if (policy in counts) {
      counts[policy] = row.n;
    }
    counts.total += row.n;
  }
  return counts;
}
