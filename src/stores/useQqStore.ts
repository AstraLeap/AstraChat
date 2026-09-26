import { create } from 'zustand';
import type {
  ListQqContactsFilter,
  QqConfig,
  QqContact,
  QqContactCounts,
  QqContactPolicy,
  UpdateQqConfigInput,
  UpdateQqContactInput,
} from '../types/index';
import { describeError, getBridge } from './bridge';

/**
 * QQ bot 配置与来源授权的状态管理。
 *
 * **v0.1.0/v0.2.0 边界（必须让用户看得见）**：本版本只做配置存储与界面呈现，
 * `连接 / 断开` 不会建立任何网络连接，也不会有任何真实的 QQ 协议握手。
 * 真实连接实现于后续阶段的 `electron/qq/`（官方 QQ 开放平台 Bot API）。
 *
 * ## 「来源」为什么是一张列表而不是一个输入框
 *
 * 官方 API 只提供 `openid`，**不提供 QQ 号 / 群号**，用户无法预先手填白名单。
 * 所以流程是：机器人先收到消息 → 来源被记进 `qq_contacts`（`policy='none'`，此时
 * **消息不投给模型**）→ 用户在设置页把它设为 `allow` 或 `deny`。
 *
 * 因此本 store 管理两份数据：单例的 `config`（凭据 + 全局策略）与 `contacts`（来源列表）。
 *
 * ## 落库行为
 *
 * `qq.save()` 是 upsert，`status` / `statusMessage` 也在表结构里，所以「连接 / 断开」
 * 采用**本地乐观更新 + 落库**：界面立即响应，重启后徽章保持一致。授权操作则相反 ——
 * 它是安全边界，采用**先落库、成功后再更新界面**，失败即回滚，不做乐观更新。
 */

/** 读取失败时的兜底配置，保证设置页在桥接不可用时仍能渲染而不是白屏。 */
const FALLBACK_QQ_CONFIG: QqConfig = {
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
};

/** 来源数量的空值，避免界面在未加载时判空。 */
const EMPTY_COUNTS: QqContactCounts = { none: 0, allow: 0, deny: 0, total: 0 };

/** store 状态与动作。 */
interface QqState {
  /** 当前配置（单例）。 */
  config: QqConfig;
  /** 已发现的来源，按最近活动倒序。 */
  contacts: QqContact[];
  /** 各授权状态下的来源数量。 */
  counts: QqContactCounts;
  /** 是否正在加载配置。 */
  loading: boolean;
  /** 是否正在加载来源列表。 */
  loadingContacts: boolean;
  /** 是否正在保存配置。 */
  saving: boolean;
  /** 正在切换授权状态的来源 openid（用于按钮禁用）。 */
  updatingContactId: string | null;
  /** 是否正在切换连接状态。 */
  togglingConnection: boolean;
  /** 最近一次操作的错误文案。 */
  error: string | null;

  /**
   * 读取 QQ 配置（首次会拿到一份默认值，此时不落库）。
   *
   * @returns 无。
   */
  load: () => Promise<void>;

  /**
   * 保存配置（upsert）。表单的「保存」按钮走这里。
   *
   * @param patch 需要更新的字段。
   * @returns 成功返回 `true`。
   */
  save: (patch: UpdateQqConfigInput) => Promise<boolean>;

  /**
   * 重新拉取来源列表与数量。
   *
   * @param filter 可选过滤条件。
   * @returns 无。
   */
  loadContacts: (filter?: ListQqContactsFilter) => Promise<void>;

  /**
   * 设置某个来源的授权状态。
   *
   * 安全边界，因此**不做乐观更新**：先落库，成功后再把新状态写进列表；
   * 失败则保持原状并报错。
   *
   * @param openId 来源标识（openid）。
   * @param policy 目标授权状态。
   * @returns 成功返回 `true`。
   */
  setContactPolicy: (openId: string, policy: QqContactPolicy) => Promise<boolean>;

  /**
   * 更新来源的授权与显示名。
   *
   * @param openId 来源标识。
   * @param patch 需要更新的字段。
   * @returns 成功返回 `true`。
   */
  updateContact: (openId: string, patch: UpdateQqContactInput) => Promise<boolean>;

  /**
   * 删除一条来源记录。
   *
   * @param openId 来源标识。
   * @returns 成功返回 `true`。
   */
  removeContact: (openId: string) => Promise<boolean>;

  /**
   * 「连接」：**只切换状态字段**，不建立真实连接。
   *
   * @returns 成功返回 `true`。
   */
  connect: () => Promise<boolean>;

  /**
   * 「断开」：**只切换状态字段**。
   *
   * @returns 成功返回 `true`。
   */
  disconnect: () => Promise<boolean>;

  /**
   * 清除错误提示。
   *
   * @returns 无。
   */
  clearError: () => void;
}

/**
 * QQ 配置 store。
 *
 * @returns zustand hook。
 */
export const useQqStore = create<QqState>((set, get) => ({
  config: FALLBACK_QQ_CONFIG,
  contacts: [],
  counts: EMPTY_COUNTS,
  loading: false,
  loadingContacts: false,
  saving: false,
  updatingContactId: null,
  togglingConnection: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const config = await getBridge().qq.get();
      set({ config, loading: false });
    } catch (error) {
      set({ loading: false, error: describeError(error) });
    }
  },

  save: async (patch) => {
    set({ saving: true, error: null });
    try {
      const config = await getBridge().qq.save(patch);
      set({ config, saving: false });
      return true;
    } catch (error) {
      set({ saving: false, error: describeError(error) });
      return false;
    }
  },

  loadContacts: async (filter) => {
    set({ loadingContacts: true, error: null });
    try {
      const [contacts, counts] = await Promise.all([
        getBridge().qq.contactsList(filter),
        getBridge().qq.contactsCounts(),
      ]);
      set({ contacts, counts, loadingContacts: false });
    } catch (error) {
      set({ loadingContacts: false, error: describeError(error) });
    }
  },

  setContactPolicy: async (openId, policy) => {
    set({ updatingContactId: openId, error: null });
    try {
      const updated = await getBridge().qq.contactsSetPolicy(openId, policy);
      const counts = await getBridge().qq.contactsCounts();
      set((state) => ({
        contacts: state.contacts.map((contact) =>
          contact.openId === openId ? updated : contact,
        ),
        counts,
        updatingContactId: null,
      }));
      return true;
    } catch (error) {
      set({ updatingContactId: null, error: describeError(error) });
      return false;
    }
  },

  updateContact: async (openId, patch) => {
    set({ updatingContactId: openId, error: null });
    try {
      const updated = await getBridge().qq.contactsUpdate(openId, patch);
      const counts = await getBridge().qq.contactsCounts();
      set((state) => ({
        contacts: state.contacts.map((contact) =>
          contact.openId === openId ? updated : contact,
        ),
        counts,
        updatingContactId: null,
      }));
      return true;
    } catch (error) {
      set({ updatingContactId: null, error: describeError(error) });
      return false;
    }
  },

  removeContact: async (openId) => {
    set({ updatingContactId: openId, error: null });
    try {
      await getBridge().qq.contactsRemove(openId);
      const counts = await getBridge().qq.contactsCounts();
      set((state) => ({
        contacts: state.contacts.filter((contact) => contact.openId !== openId),
        counts,
        updatingContactId: null,
      }));
      return true;
    } catch (error) {
      set({ updatingContactId: null, error: describeError(error) });
      return false;
    }
  },

  connect: async () => {
    const previous = get().config;
    // 乐观更新：本阶段这里没有任何 I/O，界面应瞬时响应。
    set({
      config: { ...previous, status: 'connected', statusMessage: null },
      togglingConnection: true,
      error: null,
    });
    try {
      const config = await getBridge().qq.save({ status: 'connected', statusMessage: null });
      set({ config, togglingConnection: false });
      return true;
    } catch (error) {
      set({ config: previous, togglingConnection: false, error: describeError(error) });
      return false;
    }
  },

  disconnect: async () => {
    const previous = get().config;
    set({
      config: { ...previous, status: 'disconnected', statusMessage: null },
      togglingConnection: true,
      error: null,
    });
    try {
      const config = await getBridge().qq.save({ status: 'disconnected', statusMessage: null });
      set({ config, togglingConnection: false });
      return true;
    } catch (error) {
      set({ config: previous, togglingConnection: false, error: describeError(error) });
      return false;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
