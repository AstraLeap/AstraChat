import { create } from 'zustand';
import type { CreatePersonaInput, Persona, UpdatePersonaInput } from '../types/index';
import { describeError, getBridge } from './bridge';

/**
 * 角色（人格）的状态管理。
 *
 * 与 {@link useProviderStore} 相同的约定：数据访问只经 `getBridge()` → `window.astra.personas`，
 * 校验逻辑以纯函数导出供表单复用。
 *
 * 关于内置角色：数据层在首次启动时会种入 4 个 `isPreset: true` 的示例角色
 * （通用助手 / 代码搭档 / 产品文案 / 翻译润色）。内置角色**允许编辑**，删除时由 UI 给出
 * 额外提示，store 层不做拦截。
 */

/** 角色表单的字段值。 */
export interface PersonaFormValues {
  /** 角色名称。 */
  name: string;
  /** 头像 data URL；`null` 表示留空（UI 用首字母占位）。 */
  avatar: string | null;
  /** 系统提示词。 */
  systemPrompt: string;
}

/** 字段级校验结果。 */
export type PersonaFormErrors = Partial<Record<keyof PersonaFormValues, string>>;

/** 新建角色时的表单初始值。 */
export const EMPTY_PERSONA_FORM: PersonaFormValues = {
  name: '',
  avatar: null,
  systemPrompt: '',
};

/**
 * 校验角色表单。
 *
 * 名称必填；系统提示词为空时给出**提示**而不是硬性错误（有些人只想建一个空壳角色稍后补）。
 * 头像限制为 `data:` 开头的 data URL —— 渲染进程没有 Node 权限，只能把图片读成 data URL
 * 存库，顺手挡掉用户手填的 http 链接（那会导致 CSP/离线场景下裂图）。
 *
 * @param values 表单字段值。
 * @returns 字段级错误；全部通过时为空对象。
 */
export function validatePersonaForm(values: PersonaFormValues): PersonaFormErrors {
  const errors: PersonaFormErrors = {};

  if (!values.name.trim()) {
    errors.name = '请填写角色名称';
  }

  const avatar = values.avatar?.trim() ?? '';
  if (avatar && !avatar.startsWith('data:')) {
    errors.avatar = '头像必须是 Data URL（通过「选择图片」按钮上传）';
  }

  return errors;
}

/** 判断校验结果中是否存在错误。 */
function hasErrors(errors: PersonaFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** store 状态与动作。 */
interface PersonaState {
  /** 角色列表（内置角色在前，与数据层排序一致）。 */
  items: Persona[];
  /** 当前选中的角色 id。 */
  selectedId: string | null;
  /** 是否正在加载列表。 */
  loading: boolean;
  /** 是否正在提交新建/更新。 */
  saving: boolean;
  /** 正在删除的角色 id。 */
  removingId: string | null;
  /** 最近一次操作的错误文案。 */
  error: string | null;

  /**
   * 拉取角色列表。
   *
   * @returns 无。
   */
  load: () => Promise<void>;

  /**
   * 新建角色。
   *
   * @param input 新建入参。
   * @returns 成功返回新角色，否则 `null`。
   */
  create: (input: CreatePersonaInput) => Promise<Persona | null>;

  /**
   * 更新角色。
   *
   * @param id 角色 id。
   * @param patch 需要更新的字段。
   * @returns 成功返回更新后的角色，否则 `null`。
   */
  update: (id: string, patch: UpdatePersonaInput) => Promise<Persona | null>;

  /**
   * 删除角色。
   *
   * @param id 角色 id。
   * @returns 成功返回 `true`。
   */
  remove: (id: string) => Promise<boolean>;

  /**
   * 选中角色。
   *
   * @param id 角色 id；`null` 表示取消选中。
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
 * 从表单值构造数据层入参。
 *
 * @param values 表单值。
 * @returns 数据层入参（头像空串归一为 `null`）。
 */
export function toPersonaInput(values: PersonaFormValues): CreatePersonaInput {
  const avatar = values.avatar?.trim() ?? '';
  return {
    name: values.name.trim(),
    avatar: avatar ? avatar : null,
    systemPrompt: values.systemPrompt,
  };
}

/**
 * 角色 store。
 *
 * @returns zustand hook。
 */
export const usePersonaStore = create<PersonaState>((set, get) => ({
  items: [],
  selectedId: null,
  loading: false,
  saving: false,
  removingId: null,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const items = await getBridge().personas.list();
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
    const errors = validatePersonaForm({
      name: input.name ?? '',
      avatar: input.avatar ?? null,
      systemPrompt: input.systemPrompt ?? '',
    });
    if (hasErrors(errors)) {
      set({ error: Object.values(errors).join('；') });
      return null;
    }

    set({ saving: true, error: null });
    try {
      const created = await getBridge().personas.create(input);
      set((state) => ({
        items: [...state.items, created],
        selectedId: created.id,
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
      set({ error: '该角色已不存在，请刷新列表后重试' });
      return null;
    }

    const merged: PersonaFormValues = {
      name: patch.name ?? existing.name,
      avatar: patch.avatar !== undefined ? patch.avatar : existing.avatar,
      systemPrompt: patch.systemPrompt ?? existing.systemPrompt,
    };
    const errors = validatePersonaForm(merged);
    if (hasErrors(errors)) {
      set({ error: Object.values(errors).join('；') });
      return null;
    }

    set({ saving: true, error: null });
    try {
      const updated = await getBridge().personas.update(id, patch);
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
      await getBridge().personas.remove(id);
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
