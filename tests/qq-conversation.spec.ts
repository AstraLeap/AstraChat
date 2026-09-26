import { describe, expect, it } from 'vitest';
import { createQqConversation, promptKeyOf } from '../src/services/qq/conversation';
import { createQqHistory } from '../src/services/qq/history';
import type { QqInbound } from '../src/services/qq/events';

/**
 * 会话装配的测试。
 *
 * 这块的意义只有一个：**让模型分得清谁在说话、以及之前发生了什么**。
 * 所以断言全部落在「拼出来的 messages 长什么样」上。
 */

/** 造一条入站消息。 */
function inbound(overrides: Partial<QqInbound> = {}): QqInbound {
  return {
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    openId: 'GROUP_OPENID',
    senderId: 'MEMBER',
    senderName: '小明',
    senderRole: 'member',
    messageId: 'MSG',
    eventId: 'E',
    content: '你好',
    addressedToBot: true,
    quote: null,
    attachments: [],
    cardText: null,
    timestamp: null,
    ...overrides,
  };
}

/** 搭一套被测环境。 */
function setup(system = '你是一个群友。') {
  const history = createQqHistory({ maxEntries: 20, maxChars: 1000, maxSources: 10 });
  const conversation = createQqConversation({
    history,
    getSystemPrompt: () => system,
  });
  return { history, conversation };
}

describe('来源键', () => {
  it('群与私聊用不同前缀（即使 openid 相同也不共用上下文）', () => {
    expect(promptKeyOf({ kind: 'group', openId: 'X' })).toBe('group:X');
    expect(promptKeyOf({ kind: 'private', openId: 'X' })).toBe('private:X');
  });
});

describe('拼装结构', () => {
  it('系统提示词在最前面', () => {
    const ctx = setup('你是笙澜。');
    const messages = ctx.conversation.buildPrompt(inbound());

    expect(messages[0]).toEqual({ role: 'system', content: '你是笙澜。' });
  });

  it('系统提示词为空时不插入空消息', () => {
    const ctx = setup('   ');
    const messages = ctx.conversation.buildPrompt(inbound());
    expect(messages[0]?.role).toBe('user');
  });

  it('群聊里当前这条带昵称标注', () => {
    const ctx = setup();
    const messages = ctx.conversation.buildPrompt(inbound({ senderName: '小明', content: '你好' }));

    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '小明：你好' });
  });

  it('私聊里当前这条标为「用户」', () => {
    const ctx = setup();
    const messages = ctx.conversation.buildPrompt(
      inbound({ kind: 'private', senderName: null, content: '在吗' }),
    );

    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '用户：在吗' });
  });

  it('群聊昵称缺失时用兜底名，不产生「：内容」这种残缺标注', () => {
    const ctx = setup();
    const messages = ctx.conversation.buildPrompt(inbound({ senderName: null, content: '你好' }));

    expect(messages[messages.length - 1]?.content).toBe('某位群友：你好');
  });
});

describe('上下文累积', () => {
  it('【关键】上一轮的历史会进入下一次的 prompt', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound({ content: '第一句' }));
    ctx.conversation.rememberReply('group:GROUP_OPENID', '机器人回了');

    const messages = ctx.conversation.buildPrompt(inbound({ content: '第二句' }));

    expect(messages.map((item) => item.content)).toEqual([
      '你是一个群友。',
      '小明：第一句',
      '机器人回了',
      '小明：第二句',
    ]);
  });

  it('机器人自己说过的话是 assistant，不是伪装成用户', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound({ content: '第一句' }));
    ctx.conversation.rememberReply('group:GROUP_OPENID', '机器人回了');

    const messages = ctx.conversation.buildPrompt(inbound({ content: '第二句' }));
    const assistant = messages.filter((item) => item.role === 'assistant');

    expect(assistant).toEqual([{ role: 'assistant', content: '机器人回了' }]);
  });

  it('【关键】当前消息只出现一次（不能因为「先记录再拼装」而重复）', () => {
    const ctx = setup();
    const messages = ctx.conversation.buildPrompt(inbound({ content: '只此一次' }));

    const occurrences = messages.filter((item) => item.content.includes('只此一次'));
    expect(occurrences).toHaveLength(1);
  });

  it('同一个来源反复说话会累积', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound({ content: '一' }));
    ctx.conversation.buildPrompt(inbound({ content: '二' }));
    const messages = ctx.conversation.buildPrompt(inbound({ content: '三' }));

    const users = messages.filter((item) => item.role === 'user');
    expect(users.map((item) => item.content)).toEqual(['小明：一', '小明：二', '小明：三']);
  });
});

describe('来源隔离（隐私底线）', () => {
  it('另一个群的上下文不会进入本群的 prompt', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound({ openId: 'GROUP_A', content: 'A 群的秘密' }));
    const messages = ctx.conversation.buildPrompt(inbound({ openId: 'GROUP_B', content: 'B 群的话' }));

    expect(messages.some((item) => item.content.includes('A 群的秘密'))).toBe(false);
  });

  it('群上下文不会泄漏到私聊', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound({ kind: 'group', openId: 'X', content: '群里的' }));
    const messages = ctx.conversation.buildPrompt(
      inbound({ kind: 'private', openId: 'X', content: '私聊的' }),
    );

    expect(messages.some((item) => item.content.includes('群里的'))).toBe(false);
  });
});

describe('记录回复与重置', () => {
  it('空回复不记进历史', () => {
    const ctx = setup();
    ctx.conversation.rememberReply('group:G', '');
    ctx.conversation.rememberReply('group:G', '   ');
    expect(ctx.history.list('group:G')).toEqual([]);
  });

  it('reset 清掉该来源的历史', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound());
    ctx.conversation.reset('group:GROUP_OPENID');

    expect(ctx.history.list('group:GROUP_OPENID')).toEqual([]);
  });

  it('reset 只影响指定来源', () => {
    const ctx = setup();
    ctx.conversation.buildPrompt(inbound({ openId: 'A', content: 'a' }));
    ctx.conversation.buildPrompt(inbound({ openId: 'B', content: 'b' }));
    ctx.conversation.reset('group:A');

    const messages = ctx.conversation.buildPrompt(inbound({ openId: 'B', content: 'b2' }));
    expect(messages.some((item) => item.content.includes('b：') || item.content.includes('小明：b'))).toBe(true);
  });
});
