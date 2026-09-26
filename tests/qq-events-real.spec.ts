import { describe, expect, it } from 'vitest';
import { parseInboundEvent } from '../src/services/qq/events';

/**
 * 用**真实账号抓到的载荷**回归测试。
 *
 * 载荷来源：2026-09-26 `node scripts/qq-probe.mjs --listen 60 --dump`
 * 在开启全量模式的群里实测采集（见 `docs/qq-protocol-notes.md` §5.1）。
 *
 * 这批用例修的是两个**静默失效**的 bug —— 它们的共同点是：不报错、不崩溃，
 * 只是行为完全不对，靠单测想不出来，只有真实数据能暴露。
 *
 * ### bug 1：`addressedToBot` 恒为 false（最严重）
 *
 * READY 给的机器人 id 是 `1227781930829794431`（数字 id），
 * 而 `mentions[].id` 是 openid `112B3DDE009A9992D13BF0AF7BE443A3`（32 位十六进制）——
 * **两套不同的 id 空间**。原实现拿它们比较，永远不相等，
 * 于是全量模式下**机器人永远不会回应任何 @**。
 *
 * 官方其实给了明确字段：`mentions[].is_you === true`。
 *
 * ### bug 2：`content` 里残留 `<@openid>` 占位符
 *
 * 全量模式下官方**不剥离** @ 占位符，正文是 `<@112B3DDE…> 111`。
 * 直接投给模型，模型看到的是一串 openid 而不是「111」。
 */

/** 实测抓到的机器人数字 id（READY 的 `d.user.id`）。 */
const READY_BOT_ID = '1227781930829794431';

/** 实测抓到的机器人 openid（出现在 `mentions[].id` / `member_openid`）。 */
const BOT_OPEN_ID = '112B3DDE009A9992D13BF0AF7BE443A3';

/** 一条 @ 了机器人的全量群消息（原文照录，只截短了超长 id 与 ext）。 */
const AT_MESSAGE = {
  id: 'ROBOT1.0_.olD1oyHsH2diuGt9ocn1PCK37Suj3a4FsBKOAFP79dP3xSOfkEBLrXX2Y4xoiLL24DG708QSKK4okaEG8RhRUPErOzDjOLYJuD2UYydx7YNIqrVm3QhC6-bhktADRFg',
  op: 0,
  s: 4,
  t: 'GROUP_MESSAGE_CREATE',
  d: {
    id: 'ROBOT1.0_.olD1oyHsH2diuGt9ocn1PCK37Suj3a4FsBKOAFP79dP3xSOfkEBLrXX2Y4xoiLL24DG708QSKK4okaEG8RhRUPErOzDjOLYJuD2UYydx7YNIqrVm3QhC6-bhktADRFg',
    author: {
      bot: false,
      id: 'BF298E6D5873946353CC66AC75C4AF50',
      member_openid: 'BF298E6D5873946353CC66AC75C4AF50',
      member_role: 'owner',
      union_openid: '',
      username: '一条咸鱼',
    },
    content: `<@${BOT_OPEN_ID}> 111`,
    group_id: '28AA082DCD2C8D2B6F97E15E7061E4DD',
    group_openid: '28AA082DCD2C8D2B6F97E15E7061E4DD',
    mentions: [
      {
        bot: true,
        id: BOT_OPEN_ID,
        is_you: true,
        member_openid: BOT_OPEN_ID,
        member_role: 'member',
        scope: 'single',
        username: '笙澜',
      },
    ],
    message_scene: {
      ext: ['msg_idx=REFIDX_E2gdcUTjny+E/NrbaAOyqE', 'auth_token=T76w7oJC6I7C8p0gG1O9VeFDeeqzaXEl'],
      source: 'default',
    },
    message_type: 0,
    timestamp: '2026-09-26T14:06:38+08:00',
  },
};

/** 可自由改字段的载荷副本结构。 */
type MutablePayload = {
  id: string;
  op: number;
  s: number;
  t: string;
  d: Record<string, unknown>;
};

/**
 * 复制一份载荷并允许改单个字段（用来构造变异用例）。
 *
 * @param payload 原始载荷。
 * @returns 可变副本。
 */
function edit<T>(payload: T): MutablePayload {
  return structuredClone(payload) as unknown as MutablePayload;
}

/** 一条普通群消息（不 @）。 */
const PLAIN_MESSAGE = {
  id: 'ROBOT1.0_.olD1oyHsH2diuGt9ocn1Av1FXihkr1y9ELmASCV7RamHeQBWkwiv1NexgQqCxxfJlprvMUg5bAgBpVnhuZ1eefc9CcD.q-wjum3kSu84kM!',
  op: 0,
  s: 1,
  t: 'GROUP_MESSAGE_CREATE',
  d: {
    id: 'ROBOT1.0_.olD1oyHsH2diuGt9ocn1Av1FXihkr1y9ELmASCV7RamHeQBWkwiv1NexgQqCxxfJlprvMUg5bAgBpVnhuZ1eefc9CcD.q-wjum3kSu84kM!',
    author: {
      bot: false,
      id: 'BF298E6D5873946353CC66AC75C4AF50',
      member_openid: 'BF298E6D5873946353CC66AC75C4AF50',
      member_role: 'owner',
      union_openid: '',
      username: '一条咸鱼',
    },
    content: 'OK朋友们',
    group_id: '28AA082DCD2C8D2B6F97E15E7061E4DD',
    group_openid: '28AA082DCD2C8D2B6F97E15E7061E4DD',
    message_scene: { ext: ['msg_idx=REFIDX_zbD31anhaqXfAQdCFkY1yE'], source: 'default' },
    message_type: 0,
    timestamp: '2026-09-26T14:06:27+08:00',
  },
};

/** 一位管理员发的表情消息。 */
const EMOJI_MESSAGE = {
  id: 'ROBOT1.0_0tn.FkPkV3MyH2vXn6IbgNLZnInCYz8KSo.DhIYSEAOZ',
  op: 0,
  s: 5,
  t: 'GROUP_MESSAGE_CREATE',
  d: {
    id: 'ROBOT1.0_0tn.FkPkV3MyH2vXn6IbgNLZnInCYz8KSo.DhIYSEAOZ',
    author: {
      bot: false,
      id: '686C97DFA4815E21B1AAB3C373C1C898',
      member_openid: '686C97DFA4815E21B1AAB3C373C1C898',
      member_role: 'admin',
      union_openid: '',
      username: 'I̶n̶k̶F̶r̶A̶N̶c̶I̶S̶',
    },
    content: '🤔',
    group_id: '28AA082DCD2C8D2B6F97E15E7061E4DD',
    group_openid: '28AA082DCD2C8D2B6F97E15E7061E4DD',
    message_scene: { ext: ['msg_idx=REFIDX_t/ksbClhLqWnFksl6SUJ9j'], source: 'default' },
    message_type: 0,
    timestamp: '2026-09-26T14:06:39+08:00',
  },
};

describe('bug 1 回归：mentions 的 is_you 才是「@ 了我」的判据', () => {
  it('【关键】READY 的数字 id 与 mentions 的 openid 对不上时，仍应判定为被 @', () => {
    const parsed = parseInboundEvent(AT_MESSAGE, { botId: READY_BOT_ID });

    expect(parsed).not.toBeNull();
    // 这正是原实现漏掉的地方：比较 id 永远不相等，导致机器人永不回应
    expect(parsed!.addressedToBot).toBe(true);
  });

  it('不给 botId 也能靠 is_you 判定（id 空间无关）', () => {
    expect(parseInboundEvent(AT_MESSAGE)!.addressedToBot).toBe(true);
  });

  it('is_you 为 false 的机器人提及不算「@ 了我」（群里有别的机器人）', () => {
    const other = edit(AT_MESSAGE);
    other.d = { ...AT_MESSAGE.d, mentions: [{ ...AT_MESSAGE.d.mentions[0], is_you: false }] };
    expect(parseInboundEvent(other, { botId: READY_BOT_ID })!.addressedToBot).toBe(false);
  });

  it('仅 bot:true 但没有 is_you 时不算「@ 了我」（避免误判成别的机器人）', () => {
    const other = edit(AT_MESSAGE);
    other.d = {
      ...AT_MESSAGE.d,
      mentions: [{ bot: true, id: 'OTHER_BOT', member_openid: 'OTHER_BOT' }],
    };
    expect(parseInboundEvent(other, { botId: READY_BOT_ID })!.addressedToBot).toBe(false);
  });

  it('保留了 id / member_openid 精确匹配作为兜底', () => {
    const other = edit(AT_MESSAGE);
    other.d = {
      ...AT_MESSAGE.d,
      content: '你好',
      mentions: [{ id: BOT_OPEN_ID, member_openid: BOT_OPEN_ID }],
    };
    expect(parseInboundEvent(other, { botId: BOT_OPEN_ID })!.addressedToBot).toBe(true);
  });

  it('普通群消息仍然判定为未被 @', () => {
    expect(parseInboundEvent(PLAIN_MESSAGE, { botId: READY_BOT_ID })!.addressedToBot).toBe(false);
  });
});

describe('bug 2 回归：正文里的 <@openid> 占位符必须剥掉', () => {
  it('@ 消息的正文只留真实内容', () => {
    const parsed = parseInboundEvent(AT_MESSAGE, { botId: READY_BOT_ID });
    expect(parsed!.content).toBe('111');
  });

  it('只有 @ 没有正文时正文为空串（不会把 openid 当内容喂给模型）', () => {
    const only = structuredClone(AT_MESSAGE) as typeof AT_MESSAGE & { d: { content: string } };
    only.d = { ...AT_MESSAGE.d, content: `<@${BOT_OPEN_ID}> ` };
    expect(parseInboundEvent(only, { botId: READY_BOT_ID })!.content).toBe('');
  });

  it('剥离 @ 他人（非机器人）的占位符', () => {
    const other = edit(AT_MESSAGE);
    other.d = { ...AT_MESSAGE.d, content: '<@SOMEONE_ELSE> 帮我看下' };
    expect(parseInboundEvent(other, { botId: READY_BOT_ID })!.content).toBe('帮我看下');
  });

  it('正文里的其它尖括号不被误伤', () => {
    const other = edit(AT_MESSAGE);
    other.d = { ...AT_MESSAGE.d, content: 'a<b>c <@X> d' };
    expect(parseInboundEvent(other, { botId: READY_BOT_ID })!.content).toBe('a<b>c d');
  });

  it('普通消息的正文不受影响', () => {
    expect(parseInboundEvent(PLAIN_MESSAGE)!.content).toBe('OK朋友们');
  });
});

describe('真实载荷的其它字段都解析正确', () => {
  it('群 openid 与 group_id 相同（官方不给群号）', () => {
    const parsed = parseInboundEvent(PLAIN_MESSAGE, { botId: READY_BOT_ID });
    expect(parsed!.openId).toBe('28AA082DCD2C8D2B6F97E15E7061E4DD');
    expect(parsed!.kind).toBe('group');
  });

  it('senderId 取 member_openid', () => {
    const parsed = parseInboundEvent(PLAIN_MESSAGE, { botId: READY_BOT_ID });
    expect(parsed!.senderId).toBe('BF298E6D5873946353CC66AC75C4AF50');
  });

  it('群主与管理员角色都被识别', () => {
    expect(parseInboundEvent(PLAIN_MESSAGE)!.senderRole).toBe('owner');
    expect(parseInboundEvent(EMOJI_MESSAGE)!.senderRole).toBe('admin');
  });

  it('emoji 正文完整保留（代理对不被切坏）', () => {
    expect(parseInboundEvent(EMOJI_MESSAGE)!.content).toBe('🤔');
  });

  it('昵称里的组合变音符原样保留', () => {
    expect(parseInboundEvent(EMOJI_MESSAGE)!.senderName).toBe('I̶n̶k̶F̶r̶A̶N̶c̶I̶S̶');
  });

  it('message_scene.ext 是字符串数组，不影响解析', () => {
    const parsed = parseInboundEvent(AT_MESSAGE, { botId: READY_BOT_ID });
    expect(parsed!.messageId.startsWith('ROBOT1.0_')).toBe(true);
    expect(parsed!.timestamp).toBe('2026-09-26T14:06:38+08:00');
    expect(parsed!.quote).toBeNull();
    expect(parsed!.attachments).toEqual([]);
  });
});
