import type { QqConfig, QqConnectionStatus, UpdateQqConfigInput } from '../types/index';
import { fromBool, toBool, type Db } from './connection';

/**
 * `qq_config` 表的数据访问层。
 *
 * v0.1.0 只做配置存储：本模块**不建立任何网络连接**，「连接 / 断开」仅落库状态字段。
 * v0.2.0 的真实连接应实现于 `electron/qq.ts`，复用这里的读写。
 */

/** 单例行的固定主键。QQ 配置全局只有一份。 */
const SINGLETON_ID = 'default';

/** SQLite 返回的 qq_config 行。 */
interface QqConfigRow {
  id: string;
  app_id: string;
  app_secret: string;
  token: string;
  group_ids: string;
  enabled: number;
  status: string;
  status_message: string | null;
  updated_at: number;
}

/**
 * 把数据库行映射为领域对象。
 *
 * @param row SQLite 行。
 * @returns QQ 配置对象。
 */
function toQqConfig(row: QqConfigRow): QqConfig {
  return {
    id: row.id,
    appId: row.app_id,
    appSecret: row.app_secret,
    token: row.token,
    groupIds: parseGroupIds(row.group_ids),
    enabled: toBool(row.enabled),
    status: row.status as QqConnectionStatus,
    statusMessage: row.status_message,
    updatedAt: row.updated_at,
  };
}

/**
 * 解析存库的群号 JSON。
 *
 * 存库格式是 JSON 字符串数组。解析失败时返回空数组而不是抛错 —— 配置损坏不应该让
 * 整个设置页打不开。
 *
 * @param raw 数据库中的原始字符串。
 * @returns 群号数组。
 */
function parseGroupIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * 读取 QQ 配置；首次访问时返回一份默认值（此时**不写库**）。
 *
 * @param db 数据库句柄。
 * @returns QQ 配置。
 */
export function getQqConfig(db: Db): QqConfig {
  const row = db.raw.prepare('SELECT * FROM qq_config WHERE id = ?').get(SINGLETON_ID) as
    | QqConfigRow
    | undefined;

  if (!row) {
    return {
      id: SINGLETON_ID,
      appId: '',
      appSecret: '',
      token: '',
      groupIds: [],
      enabled: false,
      status: 'disconnected',
      statusMessage: null,
      updatedAt: Date.now(),
    };
  }

  return toQqConfig(row);
}

/**
 * 保存 QQ 配置（upsert）。
 *
 * @param db 数据库句柄。
 * @param patch 需要更新的字段；未给出的字段沿用当前值。
 * @returns 保存后的完整配置。
 */
export function saveQqConfig(db: Db, patch: UpdateQqConfigInput): QqConfig {
  const next: QqConfig = {
    ...getQqConfig(db),
    ...patch,
    id: SINGLETON_ID,
    updatedAt: Date.now(),
  };

  // 群号去重并剔除空字符串，避免 UI 误输入导致脏数据。
  next.groupIds = normalizeGroupIds(next.groupIds);

  db.raw
    .prepare(
      `INSERT INTO qq_config
         (id, app_id, app_secret, token, group_ids, enabled, status, status_message, updated_at)
       VALUES
         (@id, @appId, @appSecret, @token, @groupIds, @enabled, @status, @statusMessage, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         app_id = excluded.app_id,
         app_secret = excluded.app_secret,
         token = excluded.token,
         group_ids = excluded.group_ids,
         enabled = excluded.enabled,
         status = excluded.status,
         status_message = excluded.status_message,
         updated_at = excluded.updated_at`,
    )
    .run({
      id: next.id,
      appId: next.appId,
      appSecret: next.appSecret,
      token: next.token,
      groupIds: JSON.stringify(next.groupIds),
      enabled: fromBool(next.enabled),
      status: next.status,
      statusMessage: next.statusMessage,
      updatedAt: next.updatedAt,
    });

  return next;
}

/**
 * 清洗群号列表：去空白、去空项、去重。
 *
 * @param groupIds 原始群号列表。
 * @returns 清洗后的群号列表。
 */
function normalizeGroupIds(groupIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of groupIds) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
