import { create } from 'zustand';
import type { QqConfig, UpdateQqConfigInput } from '../types/index';
import { describeError, getBridge } from './bridge';

/**
 * QQ bot 配置的状态管理。
 *
 * **v0.1.0 边界（必须让用户看得见）**：本版本只做配置存储与界面呈现，`连接 / 断开` 不会
 * 建立任何网络连接，也不会有任何真实的 QQ 协议握手。真实连接实现于 v0.2.0 的
 * `electron/qq.ts` 适配器（当前仅为预留接口）。
 *
 * 状态的落库行为：`qq.save()` 是 upsert，`status` / `statusMessage` 也在表结构里
 * （见 `src/db/qq.ts` 的说明「连接 / 断开仅落库状态字段」），所以这里采用
 * **本地乐观更新 + 落库** 的方式：界面立即响应，重启后徽章保持一致。
 */

/** 读取失败时的兜底配置，保证设置页在桥接不可用时仍能渲染而不是白屏。 */
const FALLBACK_QQ_CONFIG: QqConfig = {
  id: 'default',
  appId: '',
  appSecret: '',
  token: '',
  groupIds: [],
  enabled: false,
  status: 'disconnected',
  statusMessage: null,
  updatedAt: 0,
};

/** store 状态与动作。 */
interface QqState {
  /** 当前配置。 */
  config: QqConfig;
  /** 是否正在加载配置。 */
  loading: boolean;
  /** 是否正在保存配置。 */
  saving: boolean;
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
  loading: false,
  saving: false,
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

  connect: async () => {
    const previous = get().config;
    // 乐观更新：v0.1.0 状态下这里没有任何 I/O，界面应瞬时响应。
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
