import { create } from 'zustand';
import type { CreateProviderInput, Provider, UpdateProviderInput } from '../types/index';
import { describeError, getBridge } from './bridge';

/**
 * 模型提供商（OpenAI 兼容端点）的状态管理。
 *
 * 数据访问一律经由 `getBridge()` → `window.astra.providers`，渲染进程没有任何 Node
 * 权限，**不允许**直接 import `src/db`。
 *
 * 校验策略：校验逻辑以纯函数 {@link validateProviderForm} 的形式导出，表单组件直接复用它
 * 做实时反馈，store 的动作在真正落库前再校验一次作为兜底 —— 单一事实来源，避免「表单放过、
 * 数据层抛错」的割裂体验。
 */

/** 提供商表单的字段值。 */
export interface ProviderFormValues {
  /** 展示名称。 */
  name: string;
  /** 接口根地址（不含 `/chat/completions`）。 */
  baseUrl: string;
  /** API Key。 */
  apiKey: string;
  /** 默认模型名。 */
  model: string;
}

/** 字段级校验结果：键为字段名，值为错误文案。 */
export type ProviderFormErrors = Partial<Record<keyof ProviderFormValues, string>>;

/** 新建提供商时的表单初始值。 */
export const EMPTY_PROVIDER_FORM: ProviderFormValues = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
};

/**
 * 判断字符串是否是合法的 `http(s)` URL。
 *
 * 用 `new URL()` 做真实解析而不是正则：正则会放过 `https://` 这类没有主机名的串，
 * 也会误杀合法的带端口/IPv6 地址。
 *
 * @param value 待校验的字符串。
 * @returns 合法返回 `true`。
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 校验提供商表单。
 *
 * 规则：名称 / BaseUrl / API Key 必填，BaseUrl 必须是合法的 `http(s)` URL。
 * 模型名（`model`）不作必填要求 —— 部分兼容端点会在请求时使用服务端默认模型。
 *
 * @param values 表单字段值。
 * @returns 字段级错误；全部通过时为空对象。
 */
export function validateProviderForm(values: ProviderFormValues): ProviderFormErrors {
  const errors: ProviderFormErrors = {};

  if (!values.name.trim()) {
    errors.name = '请填写提供商名称';
  }

  const baseUrl = values.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = '请填写接口地址（Base URL）';
  } else if (!isHttpUrl(baseUrl)) {
    errors.baseUrl = '接口地址必须是合法的 http(s) URL，例如 https://api.deepseek.com/v1';
  }

  if (!values.apiKey.trim()) {
    errors.apiKey = '请填写 API Key';
  }

  return errors;
}

/** 判断校验结果中是否存在错误。 */
function hasErrors(errors: ProviderFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * store 状态与动作。
 */
interface ProviderState {
  /** 提供商列表。 */
  items: Provider[];
  /** 当前选中的提供商 id（供聊天页选择使用）。 */
  selectedId: string | null;
  /** 是否正在加载列表。 */
  loading: boolean;
  /** 是否正在提交新建/更新。 */
  saving: boolean;
  /** 正在删除的提供商 id（用于按钮 loading 态）。 */
  removingId: string | null;
  /** 最近一次操作的错误文案；`null` 表示无错误。 */
  error: string | null;

  /**
   * 拉取提供商列表。
   *
   * @returns 无。
   */
  load: () => Promise<void>;

  /**
   * 新建提供商；内部先做表单校验。
   *
   * @param input 新建入参。
   * @returns 成功返回新建的提供商；校验失败或落库失败返回 `null`（错误写入 `error`）。
   */
  create: (input: CreateProviderInput) => Promise<Provider | null>;

  /**
   * 更新提供商；内部先做表单校验。
   *
   * @param id 提供商 id。
   * @param patch 需要更新的字段。
   * @returns 成功返回更新后的提供商，否则 `null`。
   */
  update: (id: string, patch: UpdateProviderInput) => Promise<Provider | null>;

  /**
   * 删除提供商。
   *
   * @param id 提供商 id。
   * @returns 成功返回 `true`。
   */
  remove: (id: string) => Promise<boolean>;

  /**
   * 选中/取消选中提供商。
   *
   * @param id 提供商 id；`null` 表示取消选中。
   * @returns 无。
   */
  select: (id: string | null) => void;

  /**
   * 清除错误提示。
   *
   * @returns 无。
   */
  clearError: () => void;
}

/**
 * 从表单值中挑出应写入数据层的字段（去掉首尾空白）。
 *
 * @param values 表单值。
 * @returns 数据层入参。
 */
export function toProviderInput(values: ProviderFormValues): CreateProviderInput {
  return {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
    apiKey: values.apiKey.trim(),
    model: values.model.trim(),
  };
}

/**
 * 提供商 store。
 *
 * @returns zustand hook。
 */
export const useProviderStore = create<ProviderState>((set, get) => ({
  items: [],
  selectedId: null,
  loading: false,
  saving: false,
  removingId: null,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const items = await getBridge().providers.list();
      // 选中项若已被删除则回落为第一个，避免聊天页拿着悬空 id。
      const current = get().selectedId;
      const stillExists = current !== null && items.some((item) => item.id === current);
      set({
        items,
        loading: false,
        selectedId: stillExists ? current : (items[0]?.id ?? null),
      });
    } catch (error) {
      set({ loading: false, error: describeError(error) });
    }
  },

  create: async (input) => {
    const errors = validateProviderForm({
      name: input.name ?? '',
      baseUrl: input.baseUrl ?? '',
      apiKey: input.apiKey ?? '',
      model: input.model ?? '',
    });
    if (hasErrors(errors)) {
      set({ error: Object.values(errors).join('；') });
      return null;
    }

    set({ saving: true, error: null });
    try {
      const created = await getBridge().providers.create(input);
      set((state) => ({
        items: [...state.items, created],
        selectedId: state.selectedId ?? created.id,
        saving: false,
      }));
      return created;
    } catch (error) {
      set({ saving: false, error: describeError(error) });
      return null;
    }
  },

  update: async (id, patch) => {
    const existing = get().items.find((item) => item.id === id);
    if (!existing) {
      set({ error: '该提供商已不存在，请刷新列表后重试' });
      return null;
    }

    // 以「更新后的完整值」做校验，避免只改模型名时被空的 API Key 拦截。
    const merged: ProviderFormValues = {
      name: patch.name ?? existing.name,
      baseUrl: patch.baseUrl ?? existing.baseUrl,
      apiKey: patch.apiKey ?? existing.apiKey,
      model: patch.model ?? existing.model,
    };
    const errors = validateProviderForm(merged);
    if (hasErrors(errors)) {
      set({ error: Object.values(errors).join('；') });
      return null;
    }

    set({ saving: true, error: null });
    try {
      const updated = await getBridge().providers.update(id, patch);
      set((state) => ({
        items: state.items.map((item) => (item.id === id ? updated : item)),
        saving: false,
      }));
      return updated;
    } catch (error) {
      set({ saving: false, error: describeError(error) });
      return null;
    }
  },

  remove: async (id) => {
    set({ removingId: id, error: null });
    try {
      await getBridge().providers.remove(id);
      set((state) => {
        const items = state.items.filter((item) => item.id !== id);
        return {
          items,
          removingId: null,
          selectedId: state.selectedId === id ? (items[0]?.id ?? null) : state.selectedId,
        };
      });
      return true;
    } catch (error) {
      set({ removingId: null, error: describeError(error) });
      return false;
    }
  },

  select: (id) => {
    set({ selectedId: id });
  },

  clearError: () => {
    set({ error: null });
  },
}));
