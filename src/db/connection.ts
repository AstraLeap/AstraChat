import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * SQLite 连接与表结构管理。
 *
 * 设计要点：
 * - 使用 better-sqlite3 的**同步** API。主进程是单线程事件循环，同步调用反而更简单、
 *   更快（无回调地狱），且不会与 IPC 的异步边界互相干扰。
 * - 打开 WAL 模式：读写并发更好，崩溃恢复更可靠。
 * - 打开 `foreign_keys`：`messages.conversation_id` 的级联删除依赖它（SQLite 默认关闭！）。
 *
 * 表结构（schema v2）：`providers`、`conversations`、`messages`、`personas`、`qq_config`，
 * 以及 v2 新增的 `qq_contacts`（QQ 来源授权，见 `docs/qq-integration-design.md` §5）。
 *
 * ## 迁移策略：让「全新库」与「升级库」结构一致由**构造**保证
 *
 * - **全新库**（`user_version = 0`）执行 {@link SCHEMA_SQL}，一步建到 v2。
 * - **v1 老库**执行 {@link upgradeQqConfigToV2}：**重命名旧表 → 用同一份 DDL 建新表 →
 *   搬数据 → 删旧表**。因为两边用的是**同一个** {@link QQ_CONFIG_DDL} 常量，列的顺序与
 *   类型必然一致，不存在「两条 DDL 字面量慢慢写歪」的风险。
 *
 * 一开始我用的是 `ALTER TABLE ADD COLUMN`，结果 `tests/qq-schema.spec.ts` 的结构一致性
 * 用例立刻抓出分叉：新列被追加到 `updated_at` **之后**，与全新库的列顺序不同。
 * 虽然按名取列时顺序无语义，但「两条路径产出同一个结构」是更强、更好推理的不变量，
 * 所以改成重建表。该用例保留为守卫。
 */

/** 当前 schema 版本。升级时递增，并在 {@link migrate} 中追加迁移分支。 */
const SCHEMA_VERSION = 2;

/**
 * `qq_config` 的**唯一**建表语句（v2 形态）。
 *
 * 全新库与 v1→v2 迁移共用这一份，避免两处 DDL 写歪。
 */
const QQ_CONFIG_DDL = `
CREATE TABLE IF NOT EXISTS qq_config (
  id                   TEXT PRIMARY KEY,
  app_id               TEXT NOT NULL DEFAULT '',
  app_secret           TEXT NOT NULL DEFAULT '',
  token                TEXT NOT NULL DEFAULT '',
  enabled              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'disconnected'
                         CHECK (status IN ('disconnected','connected','error')),
  status_message       TEXT,
  intents              INTEGER NOT NULL DEFAULT 0,
  sandbox              INTEGER NOT NULL DEFAULT 1,
  owner_open_ids       TEXT NOT NULL DEFAULT '[]',
  allow_all_when_empty INTEGER NOT NULL DEFAULT 0,
  reply_in_private     INTEGER NOT NULL DEFAULT 1,
  audit_enabled        INTEGER NOT NULL DEFAULT 1,
  send_delay_ms        INTEGER NOT NULL DEFAULT 300,
  max_send_per_minute  INTEGER NOT NULL DEFAULT 8,
  max_send_per_hour    INTEGER NOT NULL DEFAULT 60,
  max_reply_chars      INTEGER NOT NULL DEFAULT 500,
  updated_at           INTEGER NOT NULL
);
`;

/** `qq_contacts` 的**唯一**建表语句（v2 新增，见 `docs/qq-integration-design.md` §5.2）。 */
const QQ_CONTACTS_DDL = `
CREATE TABLE IF NOT EXISTS qq_contacts (
  open_id       TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('group','private')),
  display_name  TEXT,
  policy        TEXT NOT NULL DEFAULT 'none' CHECK (policy IN ('none','allow','deny')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
`;

/** `qq_contacts` 的索引（两份路径共用）。 */
const QQ_CONTACTS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_qq_contacts_policy
  ON qq_contacts(policy, last_seen_at DESC);
`;

/**
 * 完整的 v2 建表 DDL。
 *
 * 时间戳统一用 INTEGER（Unix 毫秒）。`messages.conversation_id` 上的外键使用
 * `ON DELETE CASCADE`，删除对话时消息自动清理。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  api_key     TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  avatar        TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  is_preset     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '新对话',
  persona_id  TEXT REFERENCES personas(id) ON DELETE SET NULL,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
  reasoning       TEXT,
  status          TEXT NOT NULL DEFAULT 'complete'
                    CHECK (status IN ('streaming','complete','error','aborted')),
  error           TEXT,
  model           TEXT,
  created_at      INTEGER NOT NULL
);

${QQ_CONFIG_DDL}
${QQ_CONTACTS_DDL}

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations(updated_at DESC);
${QQ_CONTACTS_INDEX_DDL}
`;

/** v1 时期 `qq_config` 的名字（迁移时旧表临时改名用）。 */
const QQ_CONFIG_BACKUP_TABLE = 'qq_config_v1_backup';

/** 数据库句柄包装。 */
export interface Db {
  /** 底层 better-sqlite3 连接，供各 repository 直接使用。 */
  readonly raw: DatabaseType;
  /** 关闭连接（应用退出时调用）。 */
  close(): void;
}

/**
 * 读取某张表当前已有的列名集合。
 *
 * 迁移前用它判断结构是否已是目标形态，让迁移天然可重入。
 *
 * @param db 数据库连接。
 * @param table 表名。
 * @returns 列名集合；表不存在时为空集合。
 */
function tableColumns(db: DatabaseType, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * 解析存库的字符串数组 JSON。
 *
 * 解析失败返回空数组而不是抛错 —— 一条损坏的配置不应该让整个应用打不开。
 *
 * @param raw 数据库中的原始值。
 * @returns 字符串数组（已剔除空项）。
 */
function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

/**
 * 把值转成 SQLite 可写的字符串（`undefined` / `null` 归一成空串）。
 *
 * @param value 原始值。
 * @returns 字符串。
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * v1 → v2 迁移：把 `qq_config` 从「凭据 + JSON 白名单」拆成「凭据 + 全局策略」，
 * 并新增 `qq_contacts` 承载逐来源授权。
 *
 * 做法是**重建表**（而不是逐列 `ALTER TABLE ADD COLUMN`），这样最终列顺序与
 * {@link SCHEMA_SQL} 完全一致。整个过程包在一个事务里，失败不会留下半迁移状态。
 *
 * 关键语义：
 * 1. 新列取 DDL 里的默认值，其中 `allow_all_when_empty = 0`（fail-closed），
 *    所以老库升级后**不会意外放行任何人**。
 * 2. 老的 `group_ids` 数组搬进 `qq_contacts`（`kind='group'`、`policy='allow'`），
 *    **保留用户已有的白名单意图**。
 * 3. 幂等：结构已是 v2 形态时直接返回（只补建 `qq_contacts`）。
 *
 * @param db 数据库连接。
 */
function upgradeQqConfigToV2(db: DatabaseType): void {
  const before = tableColumns(db, 'qq_config');
  const isV2Shape = before.has('intents') && !before.has('group_ids');

  if (isV2Shape) {
    // 已迁移过：只保证 qq_contacts 存在，避免重复搬迁。
    db.exec(QQ_CONTACTS_DDL);
    db.exec(QQ_CONTACTS_INDEX_DDL);
    return;
  }

  /** 整段迁移放在一个事务里，避免中途失败留下半迁移的库。 */
  const runMigration = db.transaction(() => {
    const oldRows = db.prepare('SELECT * FROM qq_config').all() as Record<string, unknown>[];

    // 上一次异常退出可能留下备份表，先清掉再改名。
    db.exec(`DROP TABLE IF EXISTS ${QQ_CONFIG_BACKUP_TABLE}`);
    db.exec(`ALTER TABLE qq_config RENAME TO ${QQ_CONFIG_BACKUP_TABLE}`);

    // 用与全新库**同一份** DDL 建表，保证列顺序/类型一致。
    db.exec(QQ_CONFIG_DDL);
    db.exec(QQ_CONTACTS_DDL);
    db.exec(QQ_CONTACTS_INDEX_DDL);

    const insertConfig = db.prepare(
      `INSERT INTO qq_config
         (id, app_id, app_secret, token, enabled, status, status_message,
          intents, sandbox, owner_open_ids, allow_all_when_empty, reply_in_private,
          audit_enabled, send_delay_ms, max_send_per_minute, max_send_per_hour,
          max_reply_chars, updated_at)
       VALUES
         (@id, @appId, @appSecret, @token, @enabled, @status, @statusMessage,
          @intents, @sandbox, @ownerOpenIds, @allowAllWhenEmpty, @replyInPrivate,
          @auditEnabled, @sendDelayMs, @maxSendPerMinute, @maxSendPerHour,
          @maxReplyChars, @updatedAt)`,
    );
    const insertContact = db.prepare(
      `INSERT OR IGNORE INTO qq_contacts
         (open_id, kind, display_name, policy, first_seen_at, last_seen_at, message_count)
       VALUES (?, 'group', NULL, 'allow', ?, ?, 0)`,
    );

    const now = Date.now();
    for (const row of oldRows) {
      // v1 的 group_ids 是「允许的群」→ 直接以 allow 身份落到 qq_contacts
      for (const openId of parseStringArray(row['group_ids'])) {
        insertContact.run(openId, now, now);
      }

      insertConfig.run({
        id: asText(row['id']) || 'default',
        appId: asText(row['app_id']),
        appSecret: asText(row['app_secret']),
        token: asText(row['token']),
        enabled: row['enabled'] === 1 ? 1 : 0,
        status: asText(row['status']) || 'disconnected',
        statusMessage: typeof row['status_message'] === 'string' ? row['status_message'] : null,
        // 以下新列一律取 DDL 默认值，不做推断
        intents: 0,
        sandbox: 1,
        ownerOpenIds: '[]',
        allowAllWhenEmpty: 0,
        replyInPrivate: 1,
        auditEnabled: 1,
        sendDelayMs: 300,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxReplyChars: 500,
        updatedAt: typeof row['updated_at'] === 'number' ? row['updated_at'] : now,
      });
    }

    db.exec(`DROP TABLE ${QQ_CONFIG_BACKUP_TABLE}`);
  });

  runMigration();
}

/**
 * 执行 schema 迁移。
 *
 * 用 `user_version` pragma 记录版本，避免额外的元数据表。
 *
 * @param db 已打开的数据库连接。
 */
function migrate(db: DatabaseType): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current < 1) {
    // 全新库：直接建到最新版。
    db.exec(SCHEMA_SQL);
  } else if (current < 2) {
    // v1 老库：v2 只动了 QQ 相关结构。
    upgradeQqConfigToV2(db);
  }

  if (current !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

/**
 * 打开（或创建）数据库并确保表结构就绪。
 *
 * @param filePath SQLite 文件路径；传入 `':memory:'` 可用于测试。
 * @returns 数据库包装对象。
 */
export function openDatabase(filePath: string): Db {
  const raw = new Database(filePath);

  // WAL 提升并发读写与崩溃恢复能力；内存库不支持 WAL，因此跳过。
  if (filePath !== ':memory:') {
    raw.pragma('journal_mode = WAL');
  }
  // 外键约束默认关闭，必须显式开启，否则级联删除不会生效。
  raw.pragma('foreign_keys = ON');
  raw.pragma('synchronous = NORMAL');

  migrate(raw);

  return {
    raw,
    close(): void {
      raw.close();
    },
  };
}

/**
 * 把 SQLite 的 0/1 整数转成布尔值。
 *
 * @param value SQLite 返回的整数。
 * @returns 是否为 1。
 */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

/**
 * 把布尔值转成 SQLite 的 0/1。
 *
 * @param value 布尔值。
 * @returns 1 或 0。
 */
export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * 解析存库的字符串数组（对 repository 暴露；见 {@link parseStringArray}）。
 *
 * @param raw 数据库中的原始字符串。
 * @returns 字符串数组。
 */
export function parseJsonStringArray(raw: unknown): string[] {
  return parseStringArray(raw);
}
