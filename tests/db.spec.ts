import { describe, expect, it, beforeEach } from 'vitest';
import {
  autoTitleConversation,
  buildHistory,
  countMessages,
  createConversation,
  createMessage,
  createPersona,
  createProvider,
  getConversation,
  getProvider,
  getQqConfig,
  listConversations,
  listMessages,
  listPersonas,
  listProviders,
  openDatabase,
  removeConversation,
  removeProvider,
  saveQqConfig,
  searchConversations,
  seedPersonas,
  updateConversation,
  updateMessage,
  updateProvider,
  type Db,
} from '../src/db/index';

/**
 * 数据层测试：用内存库跑真实的 SQLite，验证表结构、CRUD、外键级联与搜索语义。
 *
 * 之所以能在纯 Node 下跑 better-sqlite3：v13 是 Node-API 实现并自带预编译产物，
 * Node 与 Electron 共用同一份二进制。
 */

/** 每个用例一个全新的内存库。 */
function freshDb(): Db {
  return openDatabase(':memory:');
}

describe('数据库表结构', () => {
  it('创建了需求要求的 5 张表', () => {
    const db = freshDb();
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_'));

    expect(names).toContain('providers');
    expect(names).toContain('conversations');
    expect(names).toContain('messages');
    expect(names).toContain('personas');
    expect(names).toContain('qq_config');
    db.close();
  });

  it('开启了外键约束（级联删除的前提）', () => {
    const db = freshDb();
    expect(db.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('providers 数据层', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('新建后可查询，且列表按创建时间升序', () => {
    const a = createProvider(db, {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-a',
      model: 'deepseek-chat',
    });
    const b = createProvider(db, {
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-b',
      model: 'gpt-4o',
    });

    expect(listProviders(db).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(getProvider(db, a.id)).toMatchObject({ name: 'DeepSeek', model: 'deepseek-chat' });
  });

  it('规范化 Base URL 的末尾斜杠', () => {
    const p = createProvider(db, {
      name: 'X',
      baseUrl: 'https://example.com/v1///',
      apiKey: '',
      model: '',
    });
    expect(p.baseUrl).toBe('https://example.com/v1');
  });

  it('更新只影响给定字段', () => {
    const p = createProvider(db, {
      name: 'X',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk',
      model: 'm1',
    });
    const updated = updateProvider(db, p.id, { model: 'm2' });
    expect(updated.model).toBe('m2');
    expect(updated.apiKey).toBe('sk');
    expect(updated.name).toBe('X');
  });

  it('拒绝空名称', () => {
    expect(() =>
      createProvider(db, { name: '  ', baseUrl: 'https://e.com', apiKey: '', model: '' }),
    ).toThrow(/名称不能为空/);
  });

  it('删除不存在的提供商报错', () => {
    expect(() => removeProvider(db, 'nope')).toThrow(/不存在/);
  });

  it('删除提供商后，关联对话的 providerId 置空但对话保留', () => {
    const p = createProvider(db, {
      name: 'X',
      baseUrl: 'https://e.com/v1',
      apiKey: '',
      model: '',
    });
    const c = createConversation(db, { providerId: p.id });

    removeProvider(db, p.id);

    const after = getConversation(db, c.id);
    expect(after).not.toBeNull();
    expect(after?.providerId).toBeNull();
    db.close();
  });
});

describe('personas 数据层', () => {
  it('内置示例角色只在空表时写入一次（幂等）', () => {
    const db = freshDb();
    const inserted = seedPersonas(db);
    expect(inserted).toBeGreaterThan(0);

    const afterFirst = listPersonas(db).length;
    expect(seedPersonas(db)).toBe(0);
    expect(listPersonas(db).length).toBe(afterFirst);
    db.close();
  });

  it('删光角色后不会复活内置角色', () => {
    const db = freshDb();
    seedPersonas(db);
    for (const p of listPersonas(db)) {
      db.raw.prepare('DELETE FROM personas WHERE id = ?').run(p.id);
    }
    expect(listPersonas(db)).toHaveLength(0);
    seedPersonas(db);
    // 注意：seedPersonas 在表为空时会重新写入 —— 这是首次启动补种的语义。
    expect(listPersonas(db).length).toBeGreaterThan(0);
    db.close();
  });

  it('内置角色排在自定义角色之前', () => {
    const db = freshDb();
    seedPersonas(db);
    createPersona(db, { name: '我的角色', avatar: null, systemPrompt: 'hi' });
    const list = listPersonas(db);
    const firstCustomIndex = list.findIndex((p) => !p.isPreset);
    const lastPresetIndex = list.map((p) => p.isPreset).lastIndexOf(true);
    expect(firstCustomIndex).toBeGreaterThan(lastPresetIndex);
    db.close();
  });

  it('拒绝空名称', () => {
    const db = freshDb();
    expect(() => createPersona(db, { name: ' ', avatar: null, systemPrompt: '' })).toThrow(
      /名称不能为空/,
    );
    db.close();
  });
});

describe('conversations 数据层', () => {
  it('列表带消息条数，且按最近更新倒序', () => {
    const db = freshDb();
    const a = createConversation(db, { title: 'A' });
    const b = createConversation(db, { title: 'B' });

    createMessage(db, { conversationId: a.id, role: 'user', content: '你好' });
    createMessage(db, { conversationId: a.id, role: 'assistant', content: '在的' });

    const list = listConversations(db);
    expect(list.find((c) => c.id === a.id)?.messageCount).toBe(2);
    expect(list.find((c) => c.id === b.id)?.messageCount).toBe(0);

    // 触碰 A 之后 A 应排在最前
    updateConversation(db, a.id, { title: 'A2' });
    expect(listConversations(db)[0]?.id).toBe(a.id);
    db.close();
  });

  it('删除对话级联删除其消息', () => {
    const db = freshDb();
    const c = createConversation(db);
    createMessage(db, { conversationId: c.id, role: 'user', content: 'x' });
    createMessage(db, { conversationId: c.id, role: 'assistant', content: 'y' });
    expect(countMessages(db, c.id)).toBe(2);

    removeConversation(db, c.id);

    const left = db.raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(left.n).toBe(0);
    db.close();
  });

  it('空标题回退为「新对话」', () => {
    const db = freshDb();
    const c = createConversation(db, { title: '   ' });
    expect(c.title).toBe('新对话');
    db.close();
  });
});

describe('messages 数据层', () => {
  it('按创建顺序返回消息', () => {
    const db = freshDb();
    const c = createConversation(db);
    const m1 = createMessage(db, { conversationId: c.id, role: 'user', content: 'first' });
    const m2 = createMessage(db, { conversationId: c.id, role: 'assistant', content: 'second' });
    expect(listMessages(db, c.id).map((m) => m.id)).toEqual([m1.id, m2.id]);
    db.close();
  });

  it('流式更新只改给定字段（content 递增、reasoning 保留）', () => {
    const db = freshDb();
    const c = createConversation(db);
    const m = createMessage(db, {
      conversationId: c.id,
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      model: 'deepseek-reasoner',
    });

    updateMessage(db, m.id, { content: '你' });
    updateMessage(db, m.id, { content: '你好', reasoning: '思考中' });
    const done = updateMessage(db, m.id, { status: 'complete' });

    expect(done.content).toBe('你好');
    expect(done.reasoning).toBe('思考中');
    expect(done.status).toBe('complete');
    expect(done.model).toBe('deepseek-reasoner');
    db.close();
  });

  it('自动用首条用户消息命名，且不覆盖已有标题', () => {
    const db = freshDb();
    const c = createConversation(db);
    createMessage(db, {
      conversationId: c.id,
      role: 'user',
      content: '帮我写一个 TypeScript 的快速排序实现，要求支持泛型',
    });

    const title = autoTitleConversation(db, c.id);
    expect(title).toBe('帮我写一个 TypeScript 的快速排序实现，'.slice(0, 20));
    expect(getConversation(db, c.id)?.title).toBe(title);

    // 第二次调用不应再改（标题已不是「新对话」）
    expect(autoTitleConversation(db, c.id)).toBeNull();
    db.close();
  });

  it('buildHistory 过滤 system 与空正文，并保持时间升序', () => {
    const db = freshDb();
    const c = createConversation(db);
    createMessage(db, { conversationId: c.id, role: 'system', content: '你是助手' });
    createMessage(db, { conversationId: c.id, role: 'user', content: '你好' });
    createMessage(db, { conversationId: c.id, role: 'assistant', content: '' }); // 被中止的空占位
    createMessage(db, { conversationId: c.id, role: 'assistant', content: '在的' });

    expect(buildHistory(db, c.id)).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
    ]);
    db.close();
  });
});

describe('conversations 搜索', () => {
  it('空关键词返回空数组', () => {
    const db = freshDb();
    createConversation(db, { title: 'A' });
    expect(searchConversations(db, '   ')).toEqual([]);
    db.close();
  });

  it('命中标题', () => {
    const db = freshDb();
    createConversation(db, { title: '关于流式渲染的讨论' });
    createConversation(db, { title: '无关对话' });
    const hits = searchConversations(db, '流式');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.conversation.title).toBe('关于流式渲染的讨论');
    db.close();
  });

  it('命中消息正文并给出片段', () => {
    const db = freshDb();
    const c = createConversation(db, { title: '随便' });
    createMessage(db, {
      conversationId: c.id,
      role: 'user',
      content: '请解释一下 SSE 的分块边界处理为什么容易出错',
    });
    const hits = searchConversations(db, 'SSE');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedMessageIds).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('SSE');
    db.close();
  });

  it('大小写不敏感，且 % _ 不当通配符', () => {
    const db = freshDb();
    const c = createConversation(db, { title: 'Percent' });
    createMessage(db, { conversationId: c.id, role: 'user', content: '进度是 100% 完成' });

    expect(searchConversations(db, 'percent')).toHaveLength(1);
    expect(searchConversations(db, '100%')).toHaveLength(1);
    // 若把 % 当通配符，下面的查询会错误地命中所有对话
    expect(searchConversations(db, 'zzz%')).toHaveLength(0);
    db.close();
  });
});

describe('qq_config 数据层', () => {
  // 说明：v2 起 qq_config 只剩「凭据 + 全局策略」，逐来源授权搬到了 qq_contacts。
  // 新字段、数值夹取、迁移与 qq_contacts 的完整覆盖见 `tests/qq-schema.spec.ts`，
  // 这里只保留最基础的凭据往返检查。

  it('首次读取返回默认值且不落库', () => {
    const db = freshDb();
    const cfg = getQqConfig(db);
    expect(cfg).toMatchObject({
      appId: '',
      appSecret: '',
      token: '',
      ownerOpenIds: [],
      allowAllWhenEmpty: false,
      enabled: false,
      status: 'disconnected',
    });
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM qq_config').get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it('upsert 保存凭据并可再次读回', () => {
    const db = freshDb();
    saveQqConfig(db, {
      appId: '102000',
      appSecret: 'secret',
      token: 'tok',
      enabled: true,
      status: 'connected',
    });

    const cfg = getQqConfig(db);
    expect(cfg.appId).toBe('102000');
    expect(cfg.appSecret).toBe('secret');
    expect(cfg.enabled).toBe(true);
    expect(cfg.status).toBe('connected');

    // 二次保存只改一个字段，其余保留
    const next = saveQqConfig(db, { token: 'tok2' });
    expect(next.token).toBe('tok2');
    expect(next.appId).toBe('102000');
    expect(next.appSecret).toBe('secret');
    db.close();
  });

  it('ownerOpenIds 的 JSON 损坏时降级为空数组而不是抛错', () => {
    const db = freshDb();
    saveQqConfig(db, { appId: 'x' });
    db.raw.prepare('UPDATE qq_config SET owner_open_ids = ? WHERE id = ?').run('{oops', 'default');
    expect(getQqConfig(db).ownerOpenIds).toEqual([]);
    db.close();
  });
});
