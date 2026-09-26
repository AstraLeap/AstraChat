import type { QqConfig, QqConnectionStatus, UpdateQqConfigInput } from '../types/index';
import { fromBool, parseJsonStringArray, toBool, type Db } from './connection';

/**
 * `qq_config` 表的数据访问层（单例行，承载凭据与**全局策略**）。
 *
 * v0.1.0 只做配置存储；v0.2.0 按 `docs/qq-integration-design.md` 走官方 QQ 开放平台
 * Bot API，本模块仍**不建立任何网络连接**。
 *
 * 逐来源的授权（哪个群/哪个私聊允许对话）不在本表，而在 `qq_contacts`
 * （见 `src/db/qq-contacts.ts`）—— 因为官方 API 只给 `openid`，来源是「发现」来的
 * 而不是「预先配置」的。
 */

/** 单例行的固定主键。QQ 配置全局只有一份。 */
const SINGLETON_ID = 'default';

/** 数值字段的合法区间，用于把界面输入夹到合理范围。 */
const NUMERIC_LIMITS = {
  sendDelayMs: { min: 0, max: 60_000, fallback: 300 },
  maxSendPerMinute: { min: 1, max: 600, fallback: 8 },
  maxSendPerHour: { min: 1, max: 36_000, fallback: 60 },
  maxReplyChars: { min: 1, max: 4500, fallback: 500 },
  socialCooldownMs: { min: 0, max: 3_600_000, fallback: 60_000 },
  socialMaxPerHour: { min: 1, max: 600, fallback: 6 },
} as const;

/**
 * 归一化发言模式。
 *
 * 非法值回退到 `off`（最保守）而不是 `standard`：
 * 配置读坏时**不该突然开始自己插嘴**。
 *
 * @param value 原始值。
 * @returns 合法模式。
 */
function normalizeSocialMode(value: unknown): QqConfig['socialMode'] {
  return value === 'standard' || value === 'exp' ? value : 'off';
}

/** SQLite 返回的 qq_config 行。 */
interface QqConfigRow {
  id: string;
  app_id: string;
  app_secret: string;
  token: string;
  enabled: number;
  status: string;
  status_message: string | null;
  intents: number;
  sandbox: number;
  owner_open_ids: string;
  allow_all_when_empty: number;
  reply_in_private: number;
  audit_enabled: number;
  send_delay_ms: number;
  max_send_per_minute: number;
  max_send_per_hour: number;
  max_reply_chars: number;
  social_mode: string;
  social_cooldown_ms: number;
  social_max_per_hour: number;
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
    enabled: toBool(row.enabled),
    status: row.status as QqConnectionStatus,
    statusMessage: row.status_message,
    intents: row.intents,
    sandbox: toBool(row.sandbox),
    ownerOpenIds: parseJsonStringArray(row.owner_open_ids),
    allowAllWhenEmpty: toBool(row.allow_all_when_empty),
    replyInPrivate: toBool(row.reply_in_private),
    auditEnabled: toBool(row.audit_enabled),
    sendDelayMs: row.send_delay_ms,
    maxSendPerMinute: row.max_send_per_minute,
    maxSendPerHour: row.max_send_per_hour,
    maxReplyChars: row.max_reply_chars,
    socialMode: normalizeSocialMode(row.social_mode),
    socialCooldownMs: row.social_cooldown_ms,
    socialMaxPerHour: row.social_max_per_hour,
    updatedAt: row.updated_at,
  };
}

/**
 * 构造一份默认配置（**不落库**）。
 *
 * 默认值刻意选安全的一侧：`enabled=false`、`allowAllWhenEmpty=false`（fail-closed）；
 * `replyInPrivate=true` 但所有来源初始 `policy='none'`，所以实际不会回应任何人，
 * 直到用户显式授权。
 *
 * @returns 默认配置。
 */
function defaultQqConfig(): QqConfig {
  return {
    id: SINGLETON_ID,
    appId: '',
    appSecret: '',
    token: '',
    enabled: false,
    status: 'disconnected',
    statusMessage: null,
    intents: 0,
    sandbox: true,
    ownerOpenIds: [],
    allowAllWhenEmpty: false,
    replyInPrivate: true,
    auditEnabled: true,
    sendDelayMs: NUMERIC_LIMITS.sendDelayMs.fallback,
    maxSendPerMinute: NUMERIC_LIMITS.maxSendPerMinute.fallback,
    maxSendPerHour: NUMERIC_LIMITS.maxSendPerHour.fallback,
    maxReplyChars: NUMERIC_LIMITS.maxReplyChars.fallback,
    // 默认关闭：不让模型自己插嘴，行为最保守
    socialMode: 'off',
    socialCooldownMs: NUMERIC_LIMITS.socialCooldownMs.fallback,
    socialMaxPerHour: NUMERIC_LIMITS.socialMaxPerHour.fallback,
    updatedAt: Date.now(),
  };
}

/**
 * 把数值夹到合法区间；非法值（NaN / 非数字）回退到默认值。
 *
 * @param value 原始值。
 * @param limit 区间与回退值。
 * @returns 夹取后的整数。
 */
function clampNumber(
  value: unknown,
  limit: { min: number; max: number; fallback: number },
): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return limit.fallback;
  }
  return Math.min(limit.max, Math.max(limit.min, Math.floor(num)));
}

/**
 * 清洗 openid 列表：去空白、去空项、去重。
 *
 * @param ids 原始列表。
 * @returns 清洗后的列表。
 */
function normalizeOpenIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
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

  return row ? toQqConfig(row) : defaultQqConfig();
}

/**
 * 保存 QQ 配置（upsert）。
 *
 * 未给出的字段沿用当前值；数值字段会被夹到合法区间；`ownerOpenIds` 会被去重清洗。
 *
 * @param db 数据库句柄。
 * @param patch 需要更新的字段。
 * @returns 保存后的完整配置。
 */
export function saveQqConfig(db: Db, patch: UpdateQqConfigInput): QqConfig {
  const current = getQqConfig(db);

  const next: QqConfig = {
    ...current,
    ...patch,
    id: SINGLETON_ID,
    ownerOpenIds: normalizeOpenIds(patch.ownerOpenIds ?? current.ownerOpenIds),
    sendDelayMs: clampNumber(patch.sendDelayMs ?? current.sendDelayMs, NUMERIC_LIMITS.sendDelayMs),
    maxSendPerMinute: clampNumber(
      patch.maxSendPerMinute ?? current.maxSendPerMinute,
      NUMERIC_LIMITS.maxSendPerMinute,
    ),
    maxSendPerHour: clampNumber(
      patch.maxSendPerHour ?? current.maxSendPerHour,
      NUMERIC_LIMITS.maxSendPerHour,
    ),
    maxReplyChars: clampNumber(
      patch.maxReplyChars ?? current.maxReplyChars,
      NUMERIC_LIMITS.maxReplyChars,
    ),
    socialMode: normalizeSocialMode(patch.socialMode ?? current.socialMode),
    socialCooldownMs: clampNumber(
      patch.socialCooldownMs ?? current.socialCooldownMs,
      NUMERIC_LIMITS.socialCooldownMs,
    ),
    socialMaxPerHour: clampNumber(
      patch.socialMaxPerHour ?? current.socialMaxPerHour,
      NUMERIC_LIMITS.socialMaxPerHour,
    ),
    updatedAt: Date.now(),
  };

  db.raw
    .prepare(
      `INSERT INTO qq_config
         (id, app_id, app_secret, token, enabled, status, status_message,
          intents, sandbox, owner_open_ids, allow_all_when_empty, reply_in_private,
          audit_enabled, send_delay_ms, max_send_per_minute, max_send_per_hour,
          max_reply_chars, social_mode, social_cooldown_ms, social_max_per_hour,
          updated_at)
       VALUES
         (@id, @appId, @appSecret, @token, @enabled, @status, @statusMessage,
          @intents, @sandbox, @ownerOpenIds, @allowAllWhenEmpty, @replyInPrivate,
          @auditEnabled, @sendDelayMs, @maxSendPerMinute, @maxSendPerHour,
          @maxReplyChars, @socialMode, @socialCooldownMs, @socialMaxPerHour,
          @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         app_id = excluded.app_id,
         app_secret = excluded.app_secret,
         token = excluded.token,
         enabled = excluded.enabled,
         status = excluded.status,
         status_message = excluded.status_message,
         intents = excluded.intents,
         sandbox = excluded.sandbox,
         owner_open_ids = excluded.owner_open_ids,
         allow_all_when_empty = excluded.allow_all_when_empty,
         reply_in_private = excluded.reply_in_private,
         audit_enabled = excluded.audit_enabled,
         send_delay_ms = excluded.send_delay_ms,
         max_send_per_minute = excluded.max_send_per_minute,
         max_send_per_hour = excluded.max_send_per_hour,
         max_reply_chars = excluded.max_reply_chars,
         social_mode = excluded.social_mode,
         social_cooldown_ms = excluded.social_cooldown_ms,
         social_max_per_hour = excluded.social_max_per_hour,
         updated_at = excluded.updated_at`,
    )
    .run({
      id: next.id,
      appId: next.appId,
      appSecret: next.appSecret,
      token: next.token,
      enabled: fromBool(next.enabled),
      status: next.status,
      statusMessage: next.statusMessage,
      intents: next.intents,
      sandbox: fromBool(next.sandbox),
      ownerOpenIds: JSON.stringify(next.ownerOpenIds),
      allowAllWhenEmpty: fromBool(next.allowAllWhenEmpty),
      replyInPrivate: fromBool(next.replyInPrivate),
      auditEnabled: fromBool(next.auditEnabled),
      sendDelayMs: next.sendDelayMs,
      maxSendPerMinute: next.maxSendPerMinute,
      maxSendPerHour: next.maxSendPerHour,
      maxReplyChars: next.maxReplyChars,
      socialMode: next.socialMode,
      socialCooldownMs: next.socialCooldownMs,
      socialMaxPerHour: next.socialMaxPerHour,
      updatedAt: next.updatedAt,
    });

  return next;
}
