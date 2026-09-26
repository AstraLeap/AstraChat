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
 * 表结构共 5 张，与需求一致：`providers`、`conversations`、`messages`、`personas`、`qq_config`。
 */

/** 当前 schema 版本。升级时递增，并在 {@link migrate} 中追加迁移分支。 */
const SCHEMA_VERSION = 1;

/**
 * 建表 DDL。
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

CREATE TABLE IF NOT EXISTS qq_config (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL DEFAULT '',
  app_secret     TEXT NOT NULL DEFAULT '',
  token          TEXT NOT NULL DEFAULT '',
  group_ids      TEXT NOT NULL DEFAULT '[]',
  enabled        INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'disconnected'
                   CHECK (status IN ('disconnected','connected','error')),
  status_message TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations(updated_at DESC);
`;

/** 数据库句柄包装。 */
export interface Db {
  /** 底层 better-sqlite3 连接，供各 repository 直接使用。 */
  readonly raw: DatabaseType;
  /** 关闭连接（应用退出时调用）。 */
  close(): void;
}

/**
 * 执行 schema 迁移。
 *
 * v1 直接建全部表；后续版本在此追加 `if (from < N) { ... }` 分支。
 * 用 `user_version` pragma 记录版本，避免额外的元数据表。
 *
 * @param db 已打开的数据库连接。
 */
function migrate(db: DatabaseType): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current < 1) {
    db.exec(SCHEMA_SQL);
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