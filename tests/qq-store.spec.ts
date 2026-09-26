import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQqStore } from '../src/stores/useQqStore';
import type { QqConfig, QqContact, QqContactCounts, QqContactPolicy } from '../src/types/index';

/**
 * QQ 配置 / 来源授权 store 的测试。
 *
 * 重点在两处**安全语义**，它们靠肉眼看不出来、只能靠测试锁住：
 *
 * 1. **授权失败不能乐观更新**。授权状态决定「消息要不要投给模型」。如果失败后界面
 *    显示「已允许」而库里其实是 `none`，用户会以为已经放行（或以为已经拉黑），
 *    这是安全边界上最危险的一类不一致。
 * 2. **默认 fail-closed**。兜底配置必须是「不启用 + 不放行未知来源」。
 *
 * 对比：`connect` / `disconnect` 只改状态字段、不涉及安全边界，所以走乐观更新。
 */

/** 造一份配置。 */
function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    id: 'default',
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
    sendDelayMs: 300,
    maxSendPerMinute: 8,
    maxSendPerHour: 60,
    maxReplyChars: 500,
    updatedAt: 0,
    ...overrides,
  };
}

/** 造一个来源。 */
function makeContact(overrides: Partial<QqContact> = {}): QqContact {
  return {
    openId: 'g1',
    kind: 'group',
    displayName: '测试群',
    policy: 'none',
    firstSeenAt: 1000,
    lastSeenAt: 2000,
    messageCount: 3,
    ...overrides,
  };
}

/** 计数。 */
const COUNTS: QqContactCounts = { none: 1, allow: 0, deny: 0, total: 1 };

/** 假的 `qq` 桥接。 */
interface FakeQqBridge {
  get: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  contactsList: ReturnType<typeof vi.fn>;
  contactsSetPolicy: ReturnType<typeof vi.fn>;
  contactsUpdate: ReturnType<typeof vi.fn>;
  contactsRemove: ReturnType<typeof vi.fn>;
  contactsCounts: ReturnType<typeof vi.fn>;
}

/**
 * 安装一个假的 `window.astra`，只实现 store 用到的方法。
 *
 * @param overrides 覆盖某个方法的行为。
 * @returns 假桥接，便于断言调用。
 */
function installBridge(overrides: Partial<FakeQqBridge> = {}): FakeQqBridge {
  const bridge: FakeQqBridge = {
    get: vi.fn(async () => makeConfig()),
    save: vi.fn(async (patch: Partial<QqConfig>) => makeConfig(patch)),
    contactsList: vi.fn(async () => [makeContact()]),
    contactsSetPolicy: vi.fn(async (_openId: string, policy: QqContactPolicy) =>
      makeContact({ policy }),
    ),
    contactsUpdate: vi.fn(async (_openId: string, patch: Partial<QqContact>) =>
      makeContact(patch),
    ),
    contactsRemove: vi.fn(async () => undefined),
    contactsCounts: vi.fn(async () => COUNTS),
    ...overrides,
  };

  (globalThis as unknown as { astra: { qq: FakeQqBridge } }).astra = { qq: bridge };
  return bridge;
}

describe('useQqStore：来源授权', () => {
  beforeEach(() => {
    // 每个用例都从干净状态开始（zustand store 在文件内是共享的）
    useQqStore.setState({
      config: makeConfig(),
      contacts: [],
      counts: { none: 0, allow: 0, deny: 0, total: 0 },
      loading: false,
      loadingContacts: false,
      saving: false,
      updatingContactId: null,
      togglingConnection: false,
      error: null,
    });
  });

  it('loadContacts 同时拉列表与计数', async () => {
    installBridge();
    await useQqStore.getState().loadContacts();

    const state = useQqStore.getState();
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0]?.openId).toBe('g1');
    expect(state.counts).toEqual(COUNTS);
    expect(state.loadingContacts).toBe(false);
  });

  it('授权成功后列表项与计数一起更新', async () => {
    installBridge();
    useQqStore.setState({ contacts: [makeContact()] });

    const ok = await useQqStore.getState().setContactPolicy('g1', 'allow');

    expect(ok).toBe(true);
    expect(useQqStore.getState().contacts[0]?.policy).toBe('allow');
    expect(useQqStore.getState().counts).toEqual(COUNTS);
    expect(useQqStore.getState().updatingContactId).toBeNull();
    expect(useQqStore.getState().error).toBeNull();
  });

  it('【安全】授权失败时不做乐观更新，界面必须保持原状', async () => {
    installBridge({
      contactsSetPolicy: vi.fn(async () => {
        throw new Error('主进程拒绝了这次写入');
      }),
    });
    useQqStore.setState({ contacts: [makeContact({ policy: 'none' })] });

    const ok = await useQqStore.getState().setContactPolicy('g1', 'allow');

    expect(ok).toBe(false);
    // 关键：不能因为「用户点了允许」就把界面改成已允许
    expect(useQqStore.getState().contacts[0]?.policy).toBe('none');
    expect(useQqStore.getState().error).toContain('主进程拒绝了这次写入');
    expect(useQqStore.getState().updatingContactId).toBeNull();
  });

  it('拒绝授权同样能落库（deny 优先于 allow）', async () => {
    installBridge();
    useQqStore.setState({ contacts: [makeContact({ policy: 'allow' })] });

    const ok = await useQqStore.getState().setContactPolicy('g1', 'deny');

    expect(ok).toBe(true);
    expect(useQqStore.getState().contacts[0]?.policy).toBe('deny');
  });

  it('删除来源成功后从列表移除', async () => {
    installBridge();
    useQqStore.setState({ contacts: [makeContact({ openId: 'g1' }), makeContact({ openId: 'g2' })] });

    const ok = await useQqStore.getState().removeContact('g1');

    expect(ok).toBe(true);
    expect(useQqStore.getState().contacts.map((c) => c.openId)).toEqual(['g2']);
  });

  it('删除失败时列表不变并报错', async () => {
    installBridge({
      contactsRemove: vi.fn(async () => {
        throw new Error('删不掉');
      }),
    });
    useQqStore.setState({ contacts: [makeContact()] });

    const ok = await useQqStore.getState().removeContact('g1');

    expect(ok).toBe(false);
    expect(useQqStore.getState().contacts).toHaveLength(1);
    expect(useQqStore.getState().error).toContain('删不掉');
  });

  it('updateContact 可改显示名', async () => {
    installBridge();
    useQqStore.setState({ contacts: [makeContact()] });

    const ok = await useQqStore.getState().updateContact('g1', { displayName: '新群名' });

    expect(ok).toBe(true);
    expect(useQqStore.getState().contacts[0]?.displayName).toBe('新群名');
  });
});

describe('useQqStore：配置与连接状态', () => {
  beforeEach(() => {
    useQqStore.setState({
      config: makeConfig(),
      contacts: [],
      counts: { none: 0, allow: 0, deny: 0, total: 0 },
      loading: false,
      loadingContacts: false,
      saving: false,
      updatingContactId: null,
      togglingConnection: false,
      error: null,
    });
  });

  it('兜底配置默认 fail-closed（未启用、不放行未知来源）', () => {
    const state = useQqStore.getState();
    expect(state.config.enabled).toBe(false);
    expect(state.config.allowAllWhenEmpty).toBe(false);
    expect(state.contacts).toEqual([]);
  });

  it('save 成功返回 true 并刷新配置', async () => {
    installBridge({ save: vi.fn(async (patch: Partial<QqConfig>) => makeConfig(patch)) });

    const ok = await useQqStore.getState().save({ appId: 'new-app' });

    expect(ok).toBe(true);
    expect(useQqStore.getState().config.appId).toBe('new-app');
  });

  it('save 失败返回 false 并报错，配置不变', async () => {
    installBridge({
      save: vi.fn(async () => {
        throw new Error('写库失败');
      }),
    });

    const ok = await useQqStore.getState().save({ appId: 'new-app' });

    expect(ok).toBe(false);
    expect(useQqStore.getState().config.appId).toBe('');
    expect(useQqStore.getState().error).toContain('写库失败');
  });

  it('connect 乐观更新状态字段（这里没有任何 I/O）', async () => {
    installBridge();
    const ok = await useQqStore.getState().connect();

    expect(ok).toBe(true);
    expect(useQqStore.getState().config.status).toBe('connected');
  });

  it('connect 落库失败时回滚到之前的状态', async () => {
    installBridge({
      save: vi.fn(async () => {
        throw new Error('落库失败');
      }),
    });

    const ok = await useQqStore.getState().connect();

    expect(ok).toBe(false);
    expect(useQqStore.getState().config.status).toBe('disconnected');
    expect(useQqStore.getState().error).toContain('落库失败');
  });

  it('disconnect 同样回滚', async () => {
    installBridge({
      save: vi.fn(async () => {
        throw new Error('落库失败');
      }),
    });
    useQqStore.setState({ config: makeConfig({ status: 'connected' }) });

    const ok = await useQqStore.getState().disconnect();

    expect(ok).toBe(false);
    expect(useQqStore.getState().config.status).toBe('connected');
  });

  it('clearError 清掉错误文案', async () => {
    installBridge({
      save: vi.fn(async () => {
        throw new Error('x');
      }),
    });
    await useQqStore.getState().save({ appId: 'a' });

    useQqStore.getState().clearError();
    expect(useQqStore.getState().error).toBeNull();
  });
});
