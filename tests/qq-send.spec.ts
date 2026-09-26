import { describe, expect, it } from 'vitest';
import {
  MAX_PASSIVE_REPLIES,
  buildSendBody,
  classifySendError,
  limitPassiveParts,
  parseSendResponse,
  sendPath,
} from '../src/services/qq/send';

/**
 * 发送逻辑的测试（`docs/qq-protocol-notes.md` §6）。
 *
 * 三条官方硬约束在这里被钉死：
 * 1. `content` 与 `markdown` 不能同时传 → 请求体里**不该出现** markdown 字段
 * 2. 相同 `msg_id + msg_seq` 会失败 → 多段回复必须递增 seq
 * 3. 被动回复有次数上限（群 5 / 单聊 4）→ 超出部分在切分后就丢掉
 *
 * 以及一条关于**业务错误的**：发送接口失败时 HTTP 状态码仍是 200，必须看 `code`。
 */

describe('请求路径', () => {
  it('群聊与单聊路径不同', () => {
    expect(sendPath('group', 'GROUP_OPENID')).toBe('/v2/groups/GROUP_OPENID/messages');
    expect(sendPath('private', 'USER_OPENID')).toBe('/v2/users/USER_OPENID/messages');
  });

  it('openid 被转义，避免拼出畸形路径', () => {
    expect(sendPath('group', 'a/b')).toBe('/v2/groups/a%2Fb/messages');
  });
});

describe('请求体', () => {
  it('纯文本：只带 msg_type 与 content', () => {
    expect(buildSendBody({ content: '你好' })).toEqual({ msg_type: 0, content: '你好' });
  });

  it('【关键】绝不出现 markdown 字段（官方禁止与 content 同时传）', () => {
    const body = buildSendBody({ content: '## 标题', msgId: 'm1', msgSeq: 1 });
    expect(body).not.toHaveProperty('markdown');
    expect(body['msg_type']).toBe(0);
  });

  it('被动回复带 msg_id，msg_seq 缺省为 1', () => {
    expect(buildSendBody({ content: 'x', msgId: 'm1' })).toEqual({
      msg_type: 0,
      content: 'x',
      msg_id: 'm1',
      msg_seq: 1,
    });
  });

  it('多段回复用递增的 msg_seq', () => {
    expect(buildSendBody({ content: 'x', msgId: 'm1', msgSeq: 3 })['msg_seq']).toBe(3);
  });

  it('主动消息不带 msg_seq（没有 msg_id 时序号无意义）', () => {
    const body = buildSendBody({ content: 'x' });
    expect(body).not.toHaveProperty('msg_id');
    expect(body).not.toHaveProperty('msg_seq');
  });

  it('空白 msg_id 视为主动消息', () => {
    expect(buildSendBody({ content: 'x', msgId: '   ' })).toEqual({ msg_type: 0, content: 'x' });
  });

  it('msg_seq 非法值回退到 1', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildSendBody({ content: 'x', msgId: 'm', msgSeq: bad })['msg_seq'], `seq=${bad}`).toBe(1);
    }
  });

  it('msg_seq 小数向下取整', () => {
    expect(buildSendBody({ content: 'x', msgId: 'm', msgSeq: 2.9 })['msg_seq']).toBe(2);
  });
});

describe('错误码分类', () => {
  it('被动回复过期的几种码都不可重试', () => {
    for (const code of [304103, 40034005, 40034128, 40034024]) {
      const result = classifySendError(code);
      expect(result.kind, `code=${code}`).toBe('expired-passive');
      expect(result.retryable).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('msg_seq 冲突可重试（递增后能成功）', () => {
    const result = classifySendError(40054005);
    expect(result.kind).toBe('duplicate-seq');
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain('msg_seq');
  });

  it('频控可重试', () => {
    expect(classifySendError(40034100).kind).toBe('rate-limited');
    expect(classifySendError(40034100).retryable).toBe(true);
  });

  it('机器人不可用（禁言 / 非群成员 / 下线）都不可重试', () => {
    for (const code of [40054002, 40034101, 40054003, 40054016]) {
      const result = classifySendError(code);
      expect(result.kind, `code=${code}`).toBe('unavailable');
      expect(result.retryable).toBe(false);
    }
  });

  it('内容被拒（超长 / 不允许 URL / 违规）都不可重试', () => {
    expect(classifySendError(40054007).kind).toBe('content-rejected');
    expect(classifySendError(40054010).kind).toBe('content-rejected');
    expect(classifySendError(40054010).reason).toContain('URL');
    expect(classifySendError(40034006).kind).toBe('content-rejected');
  });

  it('服务端临时异常可重试', () => {
    for (const code of [50055001, 50055006]) {
      expect(classifySendError(code).retryable, `code=${code}`).toBe(true);
      expect(classifySendError(code).kind).toBe('transient');
    }
  });

  it('【保守】未知码一律不可重试', () => {
    for (const code of [999999, 1, 42]) {
      const result = classifySendError(code);
      expect(result.kind, `code=${code}`).toBe('permanent');
      expect(result.retryable).toBe(false);
    }
  });

  it('没有错误码也不可重试', () => {
    expect(classifySendError(null).retryable).toBe(false);
  });
});

describe('响应解析', () => {
  it('成功：取出 id 与 timestamp', () => {
    const result = parseSendResponse({
      id: 'ROBOT1.0_abc',
      timestamp: '2026-07-21T10:00:00+08:00',
    });
    expect(result).toEqual({
      ok: true,
      messageId: 'ROBOT1.0_abc',
      timestamp: '2026-07-21T10:00:00+08:00',
      refIdx: null,
    });
  });

  it('成功且带 ext_info.ref_idx', () => {
    const result = parseSendResponse({ id: 'x', ext_info: { ref_idx: 'REFIDX_y' } });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.refIdx).toBe('REFIDX_y');
  });

  it('【关键】业务失败时 HTTP 仍是 200，必须看 code', () => {
    const result = parseSendResponse({ code: 40054005, message: '消息被去重' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(40054005);
    expect(result.kind).toBe('duplicate-seq');
    expect(result.retryable).toBe(true);
  });

  it('code 优先于 id（同时出现时按失败处理）', () => {
    const result = parseSendResponse({ code: 40054002, id: 'should-be-ignored' });
    expect(result.ok).toBe(false);
  });

  it('code 是字符串时也能识别', () => {
    const result = parseSendResponse({ code: '40034100', message: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(40034100);
    expect(result.kind).toBe('rate-limited');
  });

  it('没有 id 视为失败（无法确认是否送达）', () => {
    const result = parseSendResponse({ timestamp: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('id');
  });

  it('空白 id 视为失败', () => {
    expect(parseSendResponse({ id: '  ' }).ok).toBe(false);
  });

  it('响应体不是对象时给出可读失败', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      const result = parseSendResponse(body);
      expect(result.ok, `body=${String(body)}`).toBe(false);
    }
  });
});

describe('被动回复次数上限', () => {
  it('群聊 5 次、单聊 4 次（来自官方文档）', () => {
    expect(MAX_PASSIVE_REPLIES.group).toBe(5);
    expect(MAX_PASSIVE_REPLIES.private).toBe(4);
  });

  it('未超限时不截断', () => {
    expect(limitPassiveParts(['a', 'b'], 'group', true)).toEqual({ parts: ['a', 'b'], dropped: 0 });
  });

  it('群聊超过 5 段时截断并报出丢弃数量', () => {
    const parts = ['1', '2', '3', '4', '5', '6', '7'];
    expect(limitPassiveParts(parts, 'group', true)).toEqual({
      parts: ['1', '2', '3', '4', '5'],
      dropped: 2,
    });
  });

  it('单聊上限更严（4 段）', () => {
    const parts = ['1', '2', '3', '4', '5'];
    expect(limitPassiveParts(parts, 'private', true)).toEqual({
      parts: ['1', '2', '3', '4'],
      dropped: 1,
    });
  });

  it('主动消息不受该上限约束', () => {
    const parts = ['1', '2', '3', '4', '5', '6'];
    expect(limitPassiveParts(parts, 'group', false)).toEqual({ parts, dropped: 0 });
  });

  it('返回的是副本，不共享原数组', () => {
    const parts = ['a'];
    const result = limitPassiveParts(parts, 'group', true);
    result.parts.push('b');
    expect(parts).toEqual(['a']);
  });
});
