import { describe, expect, it } from 'vitest';
import { parseInboundEvent } from '../src/services/qq/events';

/**
 * 入站事件 → 领域模型 的测试。
 *
 * 事件字段来自 `docs/qq-protocol-notes.md` §8 的取证（`message_scene.ext` 是字符串数组、
 * `msg_elements` 是递归结构、`content_type` 区分语音/图片等）。
 *
 * 这里最要紧的两点：
 * 1. **授权主体的取法**：群用 `group_openid`，私聊用 `author.user_openid`，群成员用
 *    `author.member_openid` —— 取错了白名单就形同虚设。
 * 2. **容错**：文档没写死的地方（比如 C2C 事件的字段）要「缺字段也不崩」，
 *    因为真实事件形状只能靠账号验证。
 */

/** 构造一个群聊事件的 `d`。 */
function groupData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ROBOT1.0_msg',
    author: {
      id: 'AUTHOR_ID',
      member_openid: 'MEMBER_OPENID',
      member_role: 'member',
      username: '小明',
      bot: false,
    },
    content: '大家早上好呀',
    group_openid: 'GROUP_OPENID',
    timestamp: '2026-07-21T08:00:00+08:00',
    message_type: 0,
    ...overrides,
  };
}

/** 包一层信封。 */
function envelope(t: string, d: unknown, id = 'EVENT_ID'): Record<string, unknown> {
  return { id, op: 0, s: 42, t, d };
}

describe('群聊：全量模式（GROUP_MESSAGE_CREATE）', () => {
  it('解析出授权主体、发送者与正文', () => {
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', groupData()));
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('GROUP_MESSAGE_CREATE');
    expect(result!.kind).toBe('group');
    expect(result!.openId).toBe('GROUP_OPENID');
    expect(result!.senderId).toBe('MEMBER_OPENID');
    expect(result!.senderName).toBe('小明');
    expect(result!.senderRole).toBe('member');
    expect(result!.messageId).toBe('ROBOT1.0_msg');
    expect(result!.eventId).toBe('EVENT_ID');
    expect(result!.content).toBe('大家早上好呀');
    expect(result!.timestamp).toBe('2026-07-21T08:00:00+08:00');
  });

  it('没有 @ 机器人时 addressedToBot 为 false（全量模式的核心用例）', () => {
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', groupData()), {
      botId: 'BOT_ID',
    });
    expect(result!.addressedToBot).toBe(false);
  });

  it('mentions 里含机器人 id 时 addressedToBot 为 true', () => {
    const data = groupData({
      mentions: [{ id: 'SOMEONE' }, { id: 'BOT_ID', username: '机器人', bot: true }],
    });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data), { botId: 'BOT_ID' });
    expect(result!.addressedToBot).toBe(true);
  });

  it('没给 botId 时不猜，addressedToBot 为 false', () => {
    const data = groupData({ mentions: [{ id: 'BOT_ID' }] });
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data))!.addressedToBot).toBe(false);
  });

  it('群主 / 管理员的角色被识别', () => {
    for (const role of ['admin', 'owner']) {
      const data = groupData({ author: { member_openid: 'M', member_role: role } });
      expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data))!.senderRole).toBe(role);
    }
  });

  it('未知角色归一成 null', () => {
    const data = groupData({ author: { member_openid: 'M', member_role: 'vip' } });
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data))!.senderRole).toBeNull();
  });
});

describe('群聊：@ 机器人（GROUP_AT_MESSAGE_CREATE）', () => {
  it('恒为 addressedToBot，即使没有 mentions', () => {
    const result = parseInboundEvent(envelope('GROUP_AT_MESSAGE_CREATE', groupData()));
    expect(result!.addressedToBot).toBe(true);
    expect(result!.eventType).toBe('GROUP_AT_MESSAGE_CREATE');
  });
});

describe('私聊（C2C_MESSAGE_CREATE）', () => {
  it('kind 为 private，授权主体取 author.user_openid', () => {
    const data = {
      id: 'msg-c2c',
      author: { id: 'AUTHOR_ID', user_openid: 'USER_OPENID', username: '小红', bot: false },
      content: '在吗',
      timestamp: '2026-07-21T09:00:00+08:00',
    };
    const result = parseInboundEvent(envelope('C2C_MESSAGE_CREATE', data));
    expect(result!.kind).toBe('private');
    expect(result!.openId).toBe('USER_OPENID');
    expect(result!.senderId).toBe('USER_OPENID');
    expect(result!.senderRole).toBeNull(); // 私聊没有群角色
    expect(result!.addressedToBot).toBe(true); // 私聊天然是对机器人说的
  });

  it('缺 user_openid 时退回 author.id，不崩（文档未写死 C2C 字段）', () => {
    const data = { id: 'msg-c2c', author: { id: 'FALLBACK_ID' }, content: 'hi' };
    const result = parseInboundEvent(envelope('C2C_MESSAGE_CREATE', data));
    expect(result!.openId).toBe('FALLBACK_ID');
  });
});

describe('引用解析（message_type=103）', () => {
  it('从 msg_elements 里取出被引用人与原文', () => {
    const data = groupData({
      content: '机关的走狗',
      message_type: 103,
      msg_elements: [
        {
          msg_idx: 'REFIDX_x',
          author: { username: 'Derp' },
          message_type: 103,
          content: 'El Psy Kongroo 是啥',
        },
      ],
    });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.quote).not.toBeNull();
    expect(result!.quote!.senderName).toBe('Derp');
    expect(result!.quote!.text).toBe('El Psy Kongroo 是啥');
    expect(result!.content).toBe('机关的走狗');
  });

  it('没有引用时为 null', () => {
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', groupData()))!.quote).toBeNull();
  });
});

describe('聊天记录（message_type=102）', () => {
  it('正文为空白时用 msg_elements 的内容拼出可读文本', () => {
    const data = groupData({
      content: ' ',
      message_type: 102,
      msg_elements: [
        { content: '=== 消息 1 ===\n[消息内容] 今天的学习计划已完成' },
        { content: '=== 消息 2 ===\n[消息内容] 很棒！继续保持' },
      ],
    });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.content).toContain('今天的学习计划已完成');
    expect(result!.content).toContain('很棒！继续保持');
  });

  it('正文非空时保持原样，不被 msg_elements 覆盖', () => {
    const data = groupData({ content: '真正的正文', message_type: 0, msg_elements: [{ content: '别的' }] });
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data))!.content).toBe('真正的正文');
  });
});

describe('附件与卡片', () => {
  it('图片附件', () => {
    const data = groupData({
      attachments: [
        {
          url: 'https://multimedia.nt.qq.com.cn/download?x=1',
          filename: 'photo.jpg',
          content_type: 'image/jpeg',
          width: 1920,
          height: 1080,
          size: 256000,
        },
      ],
    });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0]!.contentType).toBe('image/jpeg');
    expect(result!.attachments[0]!.url).toContain('multimedia.nt.qq.com.cn');
    expect(result!.attachments[0]!.asrText).toBeNull();
  });

  it('语音附件带 ASR 参考文本', () => {
    const data = groupData({
      attachments: [
        {
          url: 'https://x/voice.wav',
          content_type: 'voice',
          voice_wav_url: 'https://x/voice.wav',
          asr_refer_text: '今天天气不错',
        },
      ],
    });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.attachments[0]!.asrText).toBe('今天天气不错');
  });

  it('缺 url 的附件被跳过', () => {
    const data = groupData({ attachments: [{ content_type: 'image/png' }, { url: 'https://x/a.png' }] });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.attachments).toHaveLength(1);
  });

  it('卡片消息降级成可读文本', () => {
    const data = groupData({
      ark_data: {
        ark_name: '小程序',
        ark_type: 'miniapp',
        fields: { title: '某小程序', desc: '点开看看' },
      },
    });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.cardText).toContain('小程序');
    expect(result!.cardText).toContain('某小程序');
  });

  it('没有卡片时 cardText 为 null', () => {
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', groupData()))!.cardText).toBeNull();
  });
});

describe('容错：坏数据不能崩', () => {
  it('不认识的事件类型返回 null', () => {
    expect(parseInboundEvent(envelope('GUILD_CREATE', groupData()))).toBeNull();
    expect(parseInboundEvent(envelope('MESSAGE_CREATE', groupData()))).toBeNull();
  });

  it('缺少 d 返回 null', () => {
    expect(parseInboundEvent({ id: 'e', op: 0, s: 1, t: 'GROUP_MESSAGE_CREATE', d: null })).toBeNull();
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', 'not-an-object'))).toBeNull();
  });

  it('缺少消息 id 返回 null（无法被动回复）', () => {
    const data = groupData({ id: undefined });
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data))).toBeNull();
  });

  it('群事件缺少 group_openid 返回 null（无法判定授权主体）', () => {
    const data = groupData({ group_openid: undefined });
    expect(parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data))).toBeNull();
  });

  it('私聊事件连 author 都没有时返回 null（无标识可用于授权）', () => {
    expect(parseInboundEvent(envelope('C2C_MESSAGE_CREATE', { id: 'm', content: 'hi' }))).toBeNull();
  });

  it('author 形状异常时不崩，缺字段取默认值', () => {
    const data = groupData({ author: 'oops' });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe('');
    expect(result!.senderName).toBeNull();
    expect(result!.senderRole).toBeNull();
  });

  it('content 缺失按空串处理（纯图片消息）', () => {
    const data = groupData({ content: undefined, attachments: [{ url: 'https://x/a.png' }] });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.content).toBe('');
    expect(result!.attachments).toHaveLength(1);
  });

  it('信封本身无效时返回 null', () => {
    expect(parseInboundEvent(null)).toBeNull();
    expect(parseInboundEvent({ op: 10 })).toBeNull();
  });

  it('attachments / mentions / msg_elements 不是数组时按空处理', () => {
    const data = groupData({ attachments: 'oops', mentions: 42, msg_elements: null });
    const result = parseInboundEvent(envelope('GROUP_MESSAGE_CREATE', data));
    expect(result!.attachments).toEqual([]);
    expect(result!.quote).toBeNull();
  });
});
