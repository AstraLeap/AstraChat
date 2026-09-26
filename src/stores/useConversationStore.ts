import { create } from 'zustand';
import { describeError, getBridge } from './bridge';
import type {
  Conversation,
  ConversationSearchHit,
  ConversationSummary,
  CreateConversationInput,
  UpdateConversationInput,
} from '../types/index';

/**
 * 对话列表的状态管理。
 *
 * 职责边界：
 * - 只负责「对话级」数据（列表、当前选中、搜索命中），**不**持有消息数组 ——
 *   消息与流式状态归 `useChatStore`，避免两个 store 互相 import 形成环。
 * - 所有数据访问都走 `getBridge()`（即 `window.astra`），本文件不直接碰主进程模块。
 */

/** {@link useConversationStore} 的状态与动作。 */
export interface ConversationState {
  /** 全部对话摘要，按 `updatedAt` 倒序。 */
  conversations: ConversationSummary[];
  /** 当前选中的对话 id；`null` 表示未选中任何对话。 */
  currentId: string | null;
  /** 是否正在加载列表。 */
  loading: boolean;
  /** 列表级错误文案（加载 / 新建 / 重命名 / 删除失败）。 */
  error: string | null;
  /** 当前搜索关键词（空串表示未搜索）。 */
  keyword: string;
  /** 搜索结果；`keyword` 为空时为空数组。 */
  results: ConversationSearchHit[];
  /** 是否正在执行搜索。 */
  searching: boolean;

  /**
   * 拉取全部对话摘要（主进程已按 `updatedAt` 倒序返回），并同步当前选中项。
   *
   * @param options.selectFirstWhenEmpty 为 `true`（默认）且当前没有选中对话时，
   *   自动选中列表第一条；删除对话后的重载应传 `false`，否则会把用户刚删完的焦点
   *   又跳到另一个对话上。
   * @returns 无返回值；结果写入 store。
   */
  list(options?: { selectFirstWhenEmpty?: boolean }): Promise<void>;

  /**
   * 按 id 读取单个对话（不含消息条数）。
   *
   * @param id 对话 id。
   * @returns 找到则返回对话，否则返回 `null`。
   */
  get(id: string): Promise<Conversation | null>;

  /**
   * 新建对话并自动选中它。
   *
   * @param input 可选标题 / 人格 / 提供商 / 模型覆盖。
   * @returns 新建的对话；失败时返回 `null` 并把原因写入 `error`。
   */
  create(input?: CreateConversationInput): Promise<Conversation | null>;

  /**
   * 更新对话（主要用于重命名与绑定提供商/模型）。
   *
   * @param id 对话 id。
   * @param patch 需要更新的字段。
   * @returns 更新后的对话；失败时返回 `null`。
   */
  update(id: string, patch: UpdateConversationInput): Promise<Conversation | null>;

  /**
   * 删除对话（其消息由数据库外键级联删除）。
   *
   * @param id 对话 id。
   * @returns 是否删除成功。
   */
  remove(id: string): Promise<boolean>;

  /**
   * 按关键词搜索对话；关键词为空白时清空结果而不发请求。
   *
   * @param keyword 搜索关键词。
   * @returns 命中列表（同时写入 `results`）。
   */
  search(keyword: string): Promise<ConversationSearchHit[]>;

  /** 清空搜索关键词与结果，回到普通列表视图。 */
  clearSearch(): void;

  /**
   * 切换当前选中的对话。
   *
   * @param id 目标对话 id；传 `null` 表示取消选中。
   */
  select(id: string | null): void;
}

/**
 * 按 `updatedAt` 倒序排序（不修改入参数组）。
 *
 * 列表排序权在主进程 SQL，但新建 / 重命名后我们本地也会改数组，统一在这里收口，
 * 避免出现「刷新后顺序变了」的观感抖动。
 *
 * @param list 对话摘要数组。
 * @returns 新的、已排序的数组。
 */
function sortByUpdatedAt(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 对话列表 store。
 *
 * 用法：`const conversations = useConversationStore((s) => s.conversations)`。
 * 建议在 `AppSidebar` 挂载时调用一次 {@link ConversationState.list}。
 */
export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentId: null,
  loading: false,
  error: null,
  keyword: '',
  results: [],
  searching: false,

  async list(options) {
    const selectFirstWhenEmpty = options?.selectFirstWhenEmpty ?? true;
    set({ loading: true, error: null });
    try {
      const conversations = await getBridge().conversations.list();
      const sorted = sortByUpdatedAt(conversations);
      const currentId = get().currentId;
      // 选中的对话可能已被删除，此时视为未选中。
      const stillExists = currentId !== null && sorted.some((item) => item.id === currentId);
      const nextId =
        stillExists || !selectFirstWhenEmpty ? (stillExists ? currentId : null) : (sorted[0]?.id ?? null);
      set({ conversations: sorted, currentId: nextId, loading: false });
    } catch (error) {
      set({ loading: false, error: describeError(error) });
    }
  },

  async get(id) {
    try {
      return await getBridge().conversations.get(id);
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async create(input = {}) {
    set({ error: null });
    try {
      const created = await getBridge().conversations.create(input);
      const summary: ConversationSummary = { ...created, messageCount: 0 };
      set((state) => ({
        conversations: sortByUpdatedAt([summary, ...state.conversations]),
        currentId: created.id,
      }));
      return created;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async update(id, patch) {
    set({ error: null });
    try {
      const updated = await getBridge().conversations.update(id, patch);
      set((state) => ({
        conversations: sortByUpdatedAt(
          state.conversations.map((item) =>
            item.id === id ? { ...item, ...updated } : item,
          ),
        ),
      }));
      return updated;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  async remove(id) {
    set({ error: null });
    try {
      await getBridge().conversations.remove(id);
      set((state) => ({
        conversations: state.conversations.filter((item) => item.id !== id),
        currentId: state.currentId === id ? null : state.currentId,
        results: state.results.filter((hit) => hit.conversation.id !== id),
      }));
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async search(keyword) {
    const trimmed = keyword.trim();
    set({ keyword });
    if (!trimmed) {
      set({ results: [], searching: false });
      return [];
    }
    set({ searching: true, error: null });
    try {
      const hits = await getBridge().conversations.search(trimmed);
      // 关键词在等待期间又被改掉时，丢弃这次过期的响应。
      if (get().keyword.trim() !== trimmed) {
        return hits;
      }
      set({ results: hits, searching: false });
      return hits;
    } catch (error) {
      set({ searching: false, error: describeError(error) });
      return [];
    }
  },

  clearSearch() {
    set({ keyword: '', results: [], searching: false });
  },

  select(id) {
    set({ currentId: id });
  },
}));