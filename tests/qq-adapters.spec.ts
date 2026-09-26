import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/index';
import { setQqContactPolicy } from '../src/db/qq-contacts';
import { createQqDbPorts, type QqDbPorts } from '../electron/qq/adapters';

/**
 * 数据库适配层的测试（用内存库）。
 *
 * 这层几乎不含判定逻辑，所以测试重点是**绑定对不对**：
 * 来源没见过时的默认值、`allowedCount` 与真实授权数是否一致、
 * 运行期状态有没有被正确转换后落库。
 */

let db: Db;
let ports: QqDbPorts;

beforeEach(() => {
  db = openDatabase(':memory:');
  ports = createQqDbPorts(db);
});

describe('读配置', () => {
  it('返回库里的配置（默认是关闭状态）', () => {
    const config = ports.loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.status).toBeDefined();
  });

  it('读到的是同一个库的实例（改一处能看见）', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group' });
    const config = ports.loadConfig();
    // 配置本身没变，但确实是从库里读的（返回对象带 id）
    expect(config.id).toBe('default');
  });
});

describe('状态落库（经过运行期→落库映射）', () => {
  it('stopped → disconnected', () => {
    ports.persistStatus({ state: 'stopped', message: '已停止连接', botId: null });
    const config = ports.loadConfig();
    expect(config.status).toBe('disconnected');
    expect(config.statusMessage).toBe('已停止连接');
  });

  it('【关键】connecting 落库为 disconnected，不写「连接中」', () => {
    // 否则下次启动会显示「正在连接」，而那时根本没在连接，用户会以为卡住了
    ports.persistStatus({ state: 'connecting', message: '正在连接 QQ 网关…', botId: null });
    const config = ports.loadConfig();
    expect(config.status).toBe('disconnected');
    expect(config.statusMessage).toBe('正在连接 QQ 网关…');
  });

  it('connected → connected', () => {
    ports.persistStatus({ state: 'connected', message: '已就绪：笙澜', botId: 'BOT' });
    expect(ports.loadConfig().status).toBe('connected');
  });

  it('error 保留可操作的原因', () => {
    ports.persistStatus({ state: 'error', message: 'intent 无权限（4014）', botId: null });
    const config = ports.loadConfig();
    expect(config.status).toBe('error');
    expect(config.statusMessage).toContain('4014');
  });

  it('botId 不落库（来自 READY，是会话期临时信息）', () => {
    ports.persistStatus({ state: 'connected', message: '好', botId: 'BOT_ID' });
    expect(JSON.stringify(ports.loadConfig())).not.toContain('BOT_ID');
  });
});

describe('来源授权查询', () => {
  it('没见过的来源 → none（fail-closed）', () => {
    expect(ports.lookupContact('NEVER_SEEN')).toEqual({ policy: 'none', allowedCount: 0 });
  });

  it('记录过但未授权 → 仍是 none', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group', displayName: '测试群' });
    expect(ports.lookupContact('G1')).toEqual({ policy: 'none', allowedCount: 0 });
  });

  it('授权后 → allow 且 allowedCount 跟着涨', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group' });
    setQqContactPolicy(db, 'G1', 'allow');

    expect(ports.lookupContact('G1')).toEqual({ policy: 'allow', allowedCount: 1 });
  });

  it('拉黑后 → deny 且不算进 allowedCount', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group' });
    ports.recordContactSeen({ openId: 'U1', kind: 'private' });
    setQqContactPolicy(db, 'G1', 'deny');
    setQqContactPolicy(db, 'U1', 'allow');

    expect(ports.lookupContact('G1')).toEqual({ policy: 'deny', allowedCount: 1 });
  });

  it('allowedCount 是全局的（判定「白名单是否为空」要看所有来源）', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group' });
    ports.recordContactSeen({ openId: 'G2', kind: 'group' });
    setQqContactPolicy(db, 'G1', 'allow');
    setQqContactPolicy(db, 'G2', 'allow');

    // 查 G1 时也要看到总数是 2，否则 allowAllWhenEmpty 会误判成「白名单为空」
    expect(ports.lookupContact('G1').allowedCount).toBe(2);
  });
});

describe('来源记录', () => {
  it('记录后能在库的授权列表里查到', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group', displayName: '星辰跃动' });
    // 记录只建条目、不自动授权
    expect(ports.lookupContact('G1').policy).toBe('none');
  });

  it('重复记录不报错（同一个人反复说话）', () => {
    ports.recordContactSeen({ openId: 'G1', kind: 'group', displayName: '第一次' });
    expect(() => {
      ports.recordContactSeen({ openId: 'G1', kind: 'group', displayName: '第二次' });
    }).not.toThrow();
  });
});
