import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, type Db } from '../src/db/index';
import {
  countQqContactsByPolicy,
  getQqConfig,
  getQqContact,
  listAllowedOpenIds,
  listQqContacts,
  recordQqContactSeen,
  removeQqContact,
  saveQqConfig,
  setQqContactPolicy,
  updateQqContact,
} from '../src/db/index';

/**
 * schema v2 迁移与 `qq_contacts` 数据层的测试。
 *
 * 迁移最怕的是「全新库建出来的结构」与「老库升级出来的结构」不一致 —— 那种 bug 只在
 * 升级用户身上出现，开发机上永远复现不了。所以这里有一条用例**把两条路径分别跑一遍，
 * 再逐表比对列集合**。
 */

/** v1 时期的 qq_config 建表语句（模拟老库）。刻意写死在测试里，不放进生产代码。 */
const LEGACY_V1_QQ_CONFIG = `
CREATE TABLE qq_config (
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
`;

/**
 * 读取某张表的列名集合。
 *
 * @param db 数据库句柄。
 * @param table 表名。
 * @returns 列名数组（按表定义顺序）。
 */
function columnNames(db: Db, table: string): string[] {
  const rows = db.raw.pragma(`table_info(${table})`) as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 读某张表的列名与类型声明，用于跨库比对。
 *
 * @param db 数据库句柄。
 * @param table 表名。
 * @returns `列名 -> 类型` 映射。
 */
function columnTypes(db: Db, table: string): Record<string, string> {
  const rows = db.raw.pragma(`table_info(${table})`) as { name: string; type: string }[];
  return Object.fromEntries(rows.map((row) => [row.name, row.type.toUpperCase()]));
}

/**
 * 造一个「v1 老库」。
 *
 * 做法：先用当前代码把库建起来（这样 providers / conversations / messages / personas
 * 与真实 v1 库一致 —— v2 没动这几张表），再把 `qq_config` **退化成 v1 形态**并把
 * `user_version` 拨回 1。比手写全套 v1 DDL 更贴近真实，也不会因为漏建某张表
 * 让「结构一致性」用例产生假失败。
 *
 * v1 的 qq_config DDL 刻意写死在测试里：它是**被迁移的对象**，应当冻结成历史快照。
 *
 * @param filePath 临时文件路径（用文件而不是内存库，便于反复开关连接）。
 * @returns 无返回值。
 */
function createLegacyV1Database(filePath: string): void {
  // 1) 先建出一个完整的库
  const seeded = openDatabase(filePath);
  // 2) 把 qq_config 退回 v1 形态
  seeded.raw.exec('DROP TABLE qq_config');
  seeded.raw.exec(LEGACY_V1_QQ_CONFIG);
  seeded.raw
    .prepare(
      `INSERT INTO qq_config (id, app_id, app_secret, token, group_ids, enabled, status, status_message, updated_at)
       VALUES ('default', 'legacy-app', 'legacy-secret', 'legacy-token', ?, 1, 'connected', '来自 v1', 1700000000000)`,
    )
    .run(JSON.stringify(['123456', '789012', '  123456  ', '']));
  // 3) 版本号拨回 1，让下一次 openDatabase 走迁移分支
  seeded.raw.pragma('user_version = 1');
  seeded.close();
}

describe('schema v2：全新库', () => {
  it('user_version 升到 2，且 6 张表都在', () => {
    const db = openDatabase(':memory:');
    expect(db.raw.pragma('user_version', { simple: true })).toBe(2);

    const names = (
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    for (const table of [
      'providers',
      'conversations',
      'messages',
      'personas',
      'qq_config',
      'qq_contacts',
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it('qq_config 已无 group_ids 列，且含全部 v2 新列', () => {
    const db = openDatabase(':memory:');
    const columns = columnNames(db, 'qq_config');

    expect(columns).not.toContain('group_ids');
    for (const expected of [
      'intents',
      'sandbox',
      'owner_open_ids',
      'allow_all_when_empty',
      'reply_in_private',
      'audit_enabled',
      'send_delay_ms',
      'max_send_per_minute',
      'max_send_per_hour',
      'max_reply_chars',
    ]) {
      expect(columns).toContain(expected);
    }
    db.close();
  });

  it('默认配置是 fail-closed 的', () => {
    const db = openDatabase(':memory:');
    const config = getQqConfig(db);

    expect(config.enabled).toBe(false);
    expect(config.allowAllWhenEmpty).toBe(false);
    expect(config.replyInPrivate).toBe(true);
    expect(config.auditEnabled).toBe(true);
    expect(config.sandbox).toBe(true);
    expect(config.intents).toBe(0);
    expect(config.ownerOpenIds).toEqual([]);
    expect(config.sendDelayMs).toBe(300);
    expect(config.maxReplyChars).toBe(500);
    db.close();
  });
});

describe('schema v2：v1 老库升级', () => {
  it('保留原凭据，补齐新列默认值', () => {
    const dir = `${process.env.TEMP ?? '.'}\\astra-schema-v1-${Date.now()}.db`;
    createLegacyV1Database(dir);

    const db = openDatabase(dir);
    const config = getQqConfig(db);

    expect(config.appId).toBe('legacy-app');
    expect(config.appSecret).toBe('legacy-secret');
    expect(config.token).toBe('legacy-token');
    expect(config.enabled).toBe(true);
    expect(config.status).toBe('connected');
    expect(config.statusMessage).toBe('来自 v1');

    // 新列的默认值
    expect(config.allowAllWhenEmpty).toBe(false);
    expect(config.auditEnabled).toBe(true);
    expect(config.ownerOpenIds).toEqual([]);
    expect(config.sendDelayMs).toBe(300);
    db.close();
  });

  it('把 v1 的 group_ids 搬进 qq_contacts（policy=allow，去重去空）', () => {
    const dir = `${process.env.TEMP ?? '.'}\\astra-schema-v1-${Date.now()}-b.db`;
    createLegacyV1Database(dir);

    const db = openDatabase(dir);
    const contacts = listQqContacts(db);

    expect(contacts.map((c) => c.openId).sort()).toEqual(['123456', '789012']);
    for (const contact of contacts) {
      expect(contact.kind).toBe('group');
      expect(contact.policy).toBe('allow');
      expect(contact.messageCount).toBe(0);
    }
    // 重复项与空白项已被清洗；'  123456  ' 归一成 '123456' 且只出现一次
    expect(listAllowedOpenIds(db, 'group').sort()).toEqual(['123456', '789012']);
    db.close();
  });

  it('迁移后 user_version = 2 且 group_ids 列已删除', () => {
    const dir = `${process.env.TEMP ?? '.'}\\astra-schema-v1-${Date.now()}-c.db`;
    createLegacyV1Database(dir);

    const db = openDatabase(dir);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(2);
    expect(columnNames(db, 'qq_config')).not.toContain('group_ids');
    db.close();
  });

  it('重复打开已升级的库不会报错，也不会重复搬迁', () => {
    const dir = `${process.env.TEMP ?? '.'}\\astra-schema-v1-${Date.now()}-d.db`;
    createLegacyV1Database(dir);

    const first = openDatabase(dir);
    const firstCount = listQqContacts(first).length;
    first.close();

    const second = openDatabase(dir);
    expect(listQqContacts(second).length).toBe(firstCount);
    expect(second.raw.pragma('user_version', { simple: true })).toBe(2);
    second.close();
  });

  it('【关键】全新库与升级库的最终结构完全一致', () => {
    const dir = `${process.env.TEMP ?? '.'}\\astra-schema-v1-${Date.now()}-e.db`;
    createLegacyV1Database(dir);

    const fresh = openDatabase(':memory:');
    const upgraded = openDatabase(dir);

    // qq_config 的列名、顺序与类型都要一致，否则两条路径已经分叉
    expect(columnNames(upgraded, 'qq_config')).toEqual(columnNames(fresh, 'qq_config'));
    expect(columnTypes(upgraded, 'qq_config')).toEqual(columnTypes(fresh, 'qq_config'));

    expect(columnNames(upgraded, 'qq_contacts')).toEqual(columnNames(fresh, 'qq_contacts'));
    expect(columnTypes(upgraded, 'qq_contacts')).toEqual(columnTypes(fresh, 'qq_contacts'));

    // 其它表不应受 v2 影响
    for (const table of ['providers', 'conversations', 'messages', 'personas']) {
      expect(columnNames(upgraded, table)).toEqual(columnNames(fresh, table));
    }

    fresh.close();
    upgraded.close();
  });
});

describe('qq_config：新字段与数值夹取', () => {
  it('保存后能读回全部新字段', () => {
    const db = openDatabase(':memory:');
    saveQqConfig(db, {
      appId: 'app-1',
      appSecret: 'secret-1',
      token: 'token-1',
      enabled: true,
      intents: 1 << 25,
      sandbox: false,
      ownerOpenIds: ['owner-a', 'owner-b'],
      allowAllWhenEmpty: false,
      replyInPrivate: false,
      auditEnabled: false,
      sendDelayMs: 500,
      maxSendPerMinute: 5,
      maxSendPerHour: 50,
      maxReplyChars: 800,
      status: 'connected',
    });

    const saved = getQqConfig(db);
    expect(saved.appId).toBe('app-1');
    expect(saved.intents).toBe(1 << 25);
    expect(saved.sandbox).toBe(false);
    expect(saved.ownerOpenIds).toEqual(['owner-a', 'owner-b']);
    expect(saved.replyInPrivate).toBe(false);
    expect(saved.auditEnabled).toBe(false);
    expect(saved.sendDelayMs).toBe(500);
    expect(saved.maxSendPerMinute).toBe(5);
    expect(saved.maxSendPerHour).toBe(50);
    expect(saved.maxReplyChars).toBe(800);
    db.close();
  });

  it('ownerOpenIds 去重、去空白、剔除空项', () => {
    const db = openDatabase(':memory:');
    const saved = saveQqConfig(db, { ownerOpenIds: [' a ', 'a', '', '  ', 'b'] });
    expect(saved.ownerOpenIds).toEqual(['a', 'b']);
    db.close();
  });

  it('数值超范围时被夹到区间内', () => {
    const db = openDatabase(':memory:');
    expect(saveQqConfig(db, { sendDelayMs: -50 }).sendDelayMs).toBe(0);
    expect(saveQqConfig(db, { sendDelayMs: 999_999 }).sendDelayMs).toBe(60_000);
    expect(saveQqConfig(db, { maxSendPerMinute: 0 }).maxSendPerMinute).toBe(1);
    expect(saveQqConfig(db, { maxReplyChars: 99_999 }).maxReplyChars).toBe(4500);
    db.close();
  });

  it('数值非法（NaN）时回退到默认值', () => {
    const db = openDatabase(':memory:');
    expect(saveQqConfig(db, { sendDelayMs: Number.NaN }).sendDelayMs).toBe(300);
    expect(saveQqConfig(db, { maxSendPerMinute: Number.NaN }).maxSendPerMinute).toBe(8);
    db.close();
  });

  it('部分更新不影响其它字段', () => {
    const db = openDatabase(':memory:');
    saveQqConfig(db, { appId: 'keep-me', maxReplyChars: 900 });
    const after = saveQqConfig(db, { auditEnabled: false });

    expect(after.appId).toBe('keep-me');
    expect(after.maxReplyChars).toBe(900);
    expect(after.auditEnabled).toBe(false);
    db.close();
  });
});

describe('qq_contacts：发现与授权', () => {
  it('首次记录一个来源 → policy 为 none（不投递给模型）', () => {
    const db = openDatabase(':memory:');
    const contact = recordQqContactSeen(db, {
      openId: 'group-openid-1',
      kind: 'group',
      displayName: '测试群',
    });

    expect(contact.openId).toBe('group-openid-1');
    expect(contact.kind).toBe('group');
    expect(contact.displayName).toBe('测试群');
    expect(contact.policy).toBe('none');
    expect(contact.messageCount).toBe(1);
    expect(listAllowedOpenIds(db)).toEqual([]);
    db.close();
  });

  it('再见到同一来源 → 计数自增、时间刷新、授权状态不被重置', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group', seenAt: 1000 });
    setQqContactPolicy(db, 'g1', 'allow');

    const again = recordQqContactSeen(db, { openId: 'g1', kind: 'group', seenAt: 2000 });

    expect(again.messageCount).toBe(2);
    expect(again.lastSeenAt).toBe(2000);
    expect(again.firstSeenAt).toBe(1000);
    // 用户已经授权过，再来消息不该把它打回 none
    expect(again.policy).toBe('allow');
    db.close();
  });

  it('displayName 只在传入非空时覆盖', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group', displayName: '原名' });
    expect(recordQqContactSeen(db, { openId: 'g1', kind: 'group' }).displayName).toBe('原名');
    expect(
      recordQqContactSeen(db, { openId: 'g1', kind: 'group', displayName: '新名' }).displayName,
    ).toBe('新名');
    db.close();
  });

  it('授权为 allow 后才出现在允许列表里', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group' });
    recordQqContactSeen(db, { openId: 'g2', kind: 'group' });
    recordQqContactSeen(db, { openId: 'p1', kind: 'private' });

    setQqContactPolicy(db, 'g1', 'allow');
    setQqContactPolicy(db, 'p1', 'allow');

    expect(listAllowedOpenIds(db).sort()).toEqual(['g1', 'p1']);
    expect(listAllowedOpenIds(db, 'group')).toEqual(['g1']);
    expect(listAllowedOpenIds(db, 'private')).toEqual(['p1']);
    db.close();
  });

  it('deny 优先于 allow：被拒的来源不在允许列表里', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group' });
    recordQqContactSeen(db, { openId: 'g2', kind: 'group' });
    setQqContactPolicy(db, 'g1', 'allow');
    setQqContactPolicy(db, 'g2', 'allow');
    // 把 g2 改成拒绝
    setQqContactPolicy(db, 'g2', 'deny');

    expect(listAllowedOpenIds(db, 'group')).toEqual(['g1']);
    db.close();
  });

  it('分类计数正确', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'a', kind: 'group' });
    recordQqContactSeen(db, { openId: 'b', kind: 'group' });
    recordQqContactSeen(db, { openId: 'c', kind: 'private' });
    setQqContactPolicy(db, 'b', 'allow');
    setQqContactPolicy(db, 'c', 'deny');

    expect(countQqContactsByPolicy(db)).toEqual({ none: 1, allow: 1, deny: 1, total: 3 });
    db.close();
  });

  it('按 kind / policy 过滤列表', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group', seenAt: 1 });
    recordQqContactSeen(db, { openId: 'g2', kind: 'group', seenAt: 2 });
    recordQqContactSeen(db, { openId: 'p1', kind: 'private', seenAt: 3 });
    setQqContactPolicy(db, 'g1', 'allow');

    expect(listQqContacts(db, { kind: 'group' }).map((c) => c.openId)).toEqual(['g2', 'g1']);
    expect(listQqContacts(db, { policy: 'allow' }).map((c) => c.openId)).toEqual(['g1']);
    expect(listQqContacts(db, { kind: 'private' }).map((c) => c.openId)).toEqual(['p1']);
    db.close();
  });

  it('updateQqContact 可改授权与显示名', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group', displayName: '旧名' });
    const updated = updateQqContact(db, 'g1', { policy: 'deny', displayName: '新名' });

    expect(updated.policy).toBe('deny');
    expect(updated.displayName).toBe('新名');
    expect(getQqContact(db, 'g1')).toEqual(updated);
    db.close();
  });

  it('删除来源', () => {
    const db = openDatabase(':memory:');
    recordQqContactSeen(db, { openId: 'g1', kind: 'group' });
    removeQqContact(db, 'g1');
    expect(getQqContact(db, 'g1')).toBeNull();
    expect(() => removeQqContact(db, 'g1')).toThrow(/不存在/);
    db.close();
  });

  it('空 openId 被拒绝', () => {
    const db = openDatabase(':memory:');
    expect(() => recordQqContactSeen(db, { openId: '   ', kind: 'group' })).toThrow(
      /openId 不能为空/,
    );
    db.close();
  });

  it('对不存在的来源设置授权会报错', () => {
    const db = openDatabase(':memory:');
    expect(() => setQqContactPolicy(db, 'nope', 'allow')).toThrow(/不存在/);
    db.close();
  });

  it('非法 kind / policy 被 CHECK 约束拒绝', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO qq_contacts (open_id, kind, policy, first_seen_at, last_seen_at, message_count)
           VALUES ('x', 'channel', 'none', 1, 1, 0)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});
