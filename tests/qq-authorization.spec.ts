import { describe, expect, it } from 'vitest';
import { authorizeInbound } from '../src/services/qq/authorization';
import type { AuthorizeInput } from '../src/services/qq/authorization';

/**
 * 授权判定与权限分层的测试。
 *
 * 这是安全边界：判错了要么「谁都能让机器人开口」（过度放行），要么「该回的不回」
 * （过度保守）。所以每个判定分支都要有用例，尤其是两条容易写错的语义：
 *
 * 1. **deny 优先于 allow** —— 拉黑必须压过白名单。
 * 2. **`allowAllWhenEmpty` 只在白名单「为空」时生效** —— 一旦有显式白名单，
 *    未授权来源就不能再靠这个开关混进来。
 */

/** 造一份入参。 */
function input(overrides: Partial<AuthorizeInput> = {}): AuthorizeInput {
  return {
    config: {
      enabled: true,
      allowAllWhenEmpty: false,
      replyInPrivate: true,
      ownerOpenIds: [],
    },
    message: {
      kind: 'group',
      openId: 'GROUP_OPENID',
      senderId: 'MEMBER_OPENID',
      senderRole: 'member',
      addressedToBot: true,
    },
    contactPolicy: 'allow',
    allowedCount: 1,
    ...overrides,
  };
}

describe('总开关', () => {
  it('未启用时一律忽略', () => {
    const result = authorizeInbound(input({ config: { enabled: false, allowAllWhenEmpty: false, replyInPrivate: true, ownerOpenIds: [] } }));
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('disabled');
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('未启用时连管理员也不放行', () => {
    const result = authorizeInbound(
      input({
        config: { enabled: false, allowAllWhenEmpty: true, replyInPrivate: true, ownerOpenIds: ['MEMBER_OPENID'] },
      }),
    );
    expect(result.action).toBe('ignore');
  });
});

describe('私聊开关', () => {
  it('关掉私聊后私聊被忽略', () => {
    const result = authorizeInbound(
      input({
        config: { enabled: true, allowAllWhenEmpty: false, replyInPrivate: false, ownerOpenIds: [] },
        message: { kind: 'private', openId: 'USER_OPENID', senderId: 'USER_OPENID', senderRole: null, addressedToBot: true },
      }),
    );
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('private-disabled');
  });

  it('关掉私聊不影响群聊', () => {
    const result = authorizeInbound(
      input({ config: { enabled: true, allowAllWhenEmpty: false, replyInPrivate: false, ownerOpenIds: [] } }),
    );
    expect(result.action).toBe('respond');
  });
});

describe('来源授权三态', () => {
  it('allow → 应答', () => {
    expect(authorizeInbound(input({ contactPolicy: 'allow' })).action).toBe('respond');
  });

  it('deny → 忽略', () => {
    const result = authorizeInbound(input({ contactPolicy: 'deny' }));
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('denied');
  });

  it('【关键】deny 优先于 allowAllWhenEmpty', () => {
    const result = authorizeInbound(
      input({
        contactPolicy: 'deny',
        config: { enabled: true, allowAllWhenEmpty: true, replyInPrivate: true, ownerOpenIds: [] },
      }),
    );
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('denied');
  });

  it('none + 白名单为空 + 开启放行全部 → 应答', () => {
    const result = authorizeInbound(
      input({
        contactPolicy: 'none',
        allowedCount: 0,
        config: { enabled: true, allowAllWhenEmpty: true, replyInPrivate: true, ownerOpenIds: [] },
      }),
    );
    expect(result.action).toBe('respond');
  });

  it('【关键】none + 白名单非空 → 即使开了放行全部也不放行', () => {
    const result = authorizeInbound(
      input({
        contactPolicy: 'none',
        allowedCount: 3,
        config: { enabled: true, allowAllWhenEmpty: true, replyInPrivate: true, ownerOpenIds: [] },
      }),
    );
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('not-authorized');
    expect(result.detail).toContain('白名单');
  });

  it('none + 未开启放行全部 → 忽略（默认 fail-closed）', () => {
    const result = authorizeInbound(input({ contactPolicy: 'none', allowedCount: 0 }));
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('not-authorized');
  });
});

describe('群聊是否必须被 @', () => {
  it('默认要求被指向：没 @ 机器人就忽略', () => {
    const result = authorizeInbound(
      input({ message: { kind: 'group', openId: 'G', senderId: 'M', senderRole: 'member', addressedToBot: false } }),
    );
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('not-addressed');
  });

  it('被 @ 则应答', () => {
    expect(authorizeInbound(input()).action).toBe('respond');
  });

  it('显式关掉该要求后，未被 @ 的群消息也应答（全量模式主动参与）', () => {
    const result = authorizeInbound(
      input({
        requireAddressInGroup: false,
        message: { kind: 'group', openId: 'G', senderId: 'M', senderRole: 'member', addressedToBot: false },
      }),
    );
    expect(result.action).toBe('respond');
  });

  it('私聊不受「必须被 @」约束', () => {
    const result = authorizeInbound(
      input({
        message: { kind: 'private', openId: 'U', senderId: 'U', senderRole: null, addressedToBot: false },
      }),
    );
    expect(result.action).toBe('respond');
  });

  it('授权检查优先于「被 @」检查：未授权来源即使 @ 了也不放行', () => {
    const result = authorizeInbound(input({ contactPolicy: 'none', allowedCount: 5 }));
    expect(result.action).toBe('ignore');
    if (result.action !== 'ignore') {
      return;
    }
    expect(result.reason).toBe('not-authorized');
  });
});

describe('权限分层', () => {
  it('普通群友的角色是 member', () => {
    const result = authorizeInbound(input());
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') {
      return;
    }
    expect(result.role).toBe('member');
  });

  it('发送者在 ownerOpenIds 里 → owner', () => {
    const result = authorizeInbound(
      input({ config: { enabled: true, allowAllWhenEmpty: false, replyInPrivate: true, ownerOpenIds: ['MEMBER_OPENID'] } }),
    );
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') {
      return;
    }
    expect(result.role).toBe('owner');
  });

  it('私聊时用来源 openid 判定管理员', () => {
    const result = authorizeInbound(
      input({
        config: { enabled: true, allowAllWhenEmpty: false, replyInPrivate: true, ownerOpenIds: ['USER_OPENID'] },
        message: { kind: 'private', openId: 'USER_OPENID', senderId: 'USER_OPENID', senderRole: null, addressedToBot: true },
      }),
    );
    expect(result.action).toBe('respond');
    if (result.action !== 'respond') {
      return;
    }
    expect(result.role).toBe('owner');
  });

  it('默认不信任群主/管理员身份', () => {
    for (const role of ['owner', 'admin'] as const) {
      const result = authorizeInbound(
        input({ message: { kind: 'group', openId: 'G', senderId: 'M', senderRole: role, addressedToBot: true } }),
      );
      expect(result.action).toBe('respond');
      if (result.action !== 'respond') {
        continue;
      }
      expect(result.role, `role=${role}`).toBe('member');
    }
  });

  it('显式信任群主/管理员后，他们算 owner', () => {
    for (const role of ['owner', 'admin'] as const) {
      const result = authorizeInbound(
        input({
          trustGroupAdmins: true,
          message: { kind: 'group', openId: 'G', senderId: 'M', senderRole: role, addressedToBot: true },
        }),
      );
      expect(result.action).toBe('respond');
      if (result.action !== 'respond') {
        continue;
      }
      expect(result.role, `role=${role}`).toBe('owner');
    }
  });

  it('显式信任模式下，普通成员仍是 member', () => {
    const result = authorizeInbound(
      input({
        trustGroupAdmins: true,
        message: { kind: 'group', openId: 'G', senderId: 'M', senderRole: 'member', addressedToBot: true },
      }),
    );
    if (result.action !== 'respond') {
      return;
    }
    expect(result.role).toBe('member');
  });

  it('靠「放行全部」进来的陌生人只是 member，不会因为放行而变成 owner', () => {
    const result = authorizeInbound(
      input({
        contactPolicy: 'none',
        allowedCount: 0,
        config: { enabled: true, allowAllWhenEmpty: true, replyInPrivate: true, ownerOpenIds: [] },
      }),
    );
    if (result.action !== 'respond') {
      return;
    }
    expect(result.role).toBe('member');
  });

  it('ownerOpenIds 里的空项不误伤', () => {
    const result = authorizeInbound(
      input({ config: { enabled: true, allowAllWhenEmpty: false, replyInPrivate: true, ownerOpenIds: ['', '   '] } }),
    );
    if (result.action !== 'respond') {
      return;
    }
    expect(result.role).toBe('member');
  });
});

describe('判定结果始终可解释', () => {
  it('每个分支都给出非空 reason/detail', () => {
    const cases: AuthorizeInput[] = [
      input({ config: { enabled: false, allowAllWhenEmpty: false, replyInPrivate: true, ownerOpenIds: [] } }),
      input({ config: { enabled: true, allowAllWhenEmpty: false, replyInPrivate: false, ownerOpenIds: [] }, message: { kind: 'private', openId: 'U', senderId: 'U', senderRole: null, addressedToBot: true } }),
      input({ contactPolicy: 'deny' }),
      input({ contactPolicy: 'none', allowedCount: 0 }),
      input({ message: { kind: 'group', openId: 'G', senderId: 'M', senderRole: 'member', addressedToBot: false } }),
    ];
    for (const item of cases) {
      const result = authorizeInbound(item);
      if (result.action === 'ignore') {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.detail.length).toBeGreaterThan(0);
      } else {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
