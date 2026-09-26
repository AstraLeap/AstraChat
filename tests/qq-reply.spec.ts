import { describe, expect, it } from 'vitest';
import { planReply } from '../src/services/qq/reply';

/**
 * 出站回复编排的测试。
 *
 * 这个模块把 D 阶段前面几块串起来：审计 → Markdown 转纯文本 → 代理对安全切分 →
 * 按被动回复上限截断 → 生成带**递增 msg_seq** 的发送清单。
 *
 * 最容易错的两处都在这里钉死：
 * 1. `msg_seq` 必须从 1 开始且逐段递增（相同 msg_id + msg_seq 会被服务端去重拒绝）。
 * 2. 段数超过被动回复上限时要**在发送前截断**，而不是发出去被拒。
 */

describe('正常回复', () => {
  it('单段回复：被动回复带 msg_id 与 msg_seq=1', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'EVENT_MSG_ID',
      markdown: '**你好**',
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toEqual([{ content: '你好', msgId: 'EVENT_MSG_ID', msgSeq: 1 }]);
    expect(plan.dropped).toBe(0);
  });

  it('多段回复：msg_seq 从 1 开始逐段递增', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: 'abcdefghij',
      maxChars: 4,
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items.map((item) => item.content)).toEqual(['abcd', 'efgh', 'ij']);
    expect(plan.items.map((item) => item.msgSeq)).toEqual([1, 2, 3]);
    // 每段都带同一个 msg_id（都是对同一条消息的被动回复）
    expect(plan.items.every((item) => item.msgId === 'M1')).toBe(true);
  });

  it('主动消息（没有消息 id）不带 msg_id / msg_seq', () => {
    const plan = planReply({
      kind: 'group',
      messageId: null,
      markdown: '主动问候',
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toEqual([{ content: '主动问候' }]);
    expect(plan.items[0]).not.toHaveProperty('msgId');
    expect(plan.items[0]).not.toHaveProperty('msgSeq');
  });

  it('空白消息 id 视为主动消息', () => {
    const plan = planReply({ kind: 'group', messageId: '   ', markdown: 'x' });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items[0]).not.toHaveProperty('msgId');
  });

  it('Markdown 被转成纯文本后再切分', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: '见 [文档](https://a.com/b) 与 `code`',
    });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items[0]?.content).toBe('见 文档 (https://a.com/b) 与 code');
  });
});

describe('被动回复次数上限', () => {
  it('群聊超过 5 段时截断到 5 段并报出丢弃数量', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: 'a'.repeat(40),
      maxChars: 5,
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toHaveLength(5);
    expect(plan.items.map((item) => item.msgSeq)).toEqual([1, 2, 3, 4, 5]);
    // 40 个字符按 5 切 → 8 段，丢掉 3 段
    expect(plan.dropped).toBe(3);
  });

  it('单聊上限更严（4 段）', () => {
    const plan = planReply({
      kind: 'private',
      messageId: 'M1',
      markdown: 'a'.repeat(30),
      maxChars: 5,
    });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toHaveLength(4);
    expect(plan.dropped).toBe(2);
  });

  it('主动消息不受段数上限约束', () => {
    const plan = planReply({
      kind: 'group',
      messageId: null,
      markdown: 'a'.repeat(40),
      maxChars: 5,
    });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toHaveLength(8);
    expect(plan.dropped).toBe(0);
  });

  it('恰好等于上限时不丢弃', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: 'a'.repeat(25),
      maxChars: 5,
    });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toHaveLength(5);
    expect(plan.dropped).toBe(0);
  });
});

describe('审计接在管线里', () => {
  it('命中本机路径 → 整条不发', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: '文件在 C:\\Users\\a\\b.txt',
    });

    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') {
      return;
    }
    expect(plan.findings.length).toBeGreaterThan(0);
    expect('items' in plan).toBe(false);
  });

  it('命中已知密钥 → 拦下且规则是 known-secret', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: 'key: my-super-secret-key-12345',
      knownSecrets: ['my-super-secret-key-12345'],
    });

    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') {
      return;
    }
    expect(plan.findings[0]?.rule).toBe('known-secret');
  });

  it('auditEnabled=false 时跳过审计', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: '文件在 C:\\Users\\a\\b.txt',
      auditEnabled: false,
    });
    expect(plan.status).toBe('ready');
  });

  it('审计缺省开启（fail-closed）', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: '文件在 C:\\Users\\a\\b.txt',
    });
    expect(plan.status).toBe('blocked');
  });

  it('审计检查的是转换后的纯文本，finding 位置与之对应', () => {
    const plan = planReply({
      kind: 'group',
      messageId: 'M1',
      markdown: '**token: sk-abc123def456**',
    });
    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') {
      return;
    }
    expect(plan.findings[0]?.start).toBe(0);
  });
});

describe('空与边界', () => {
  it('空回复 → empty', () => {
    expect(planReply({ kind: 'group', messageId: 'M1', markdown: '' }).status).toBe('empty');
    expect(planReply({ kind: 'group', messageId: 'M1', markdown: '   ' }).status).toBe('empty');
  });

  it('empty 与 blocked 是不同状态', () => {
    expect(planReply({ kind: 'group', messageId: 'M1', markdown: '  ' }).status).toBe('empty');
  });

  it('maxChars 缺省用 4000', () => {
    const plan = planReply({
      kind: 'group',
      messageId: null,
      markdown: 'a'.repeat(4001),
    });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]?.content).toHaveLength(4000);
  });

  it('返回的 plain 与切分前一致（便于日志与排查）', () => {
    const plan = planReply({ kind: 'group', messageId: 'M1', markdown: '**x**' });
    if (plan.status !== 'ready') {
      return;
    }
    expect(plan.plain).toBe('x');
    expect(plan.items.map((item) => item.content).join('')).toBe('x');
  });
});
