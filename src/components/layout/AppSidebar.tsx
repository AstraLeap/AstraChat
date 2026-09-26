import { useEffect, type ComponentType } from 'react';
import clsx from 'clsx';
import { ConversationList } from '../chat/ConversationList';
import { ConversationSearch } from '../chat/ConversationSearch';
import { Button, IconChat, IconSettings, IconSparkle, IconUser, type IconProps } from '../ui/index';
import { useConversationStore } from '../../stores/useConversationStore';
import { useChatStore } from '../../stores/useChatStore';
import { APP_NAV_ITEMS, type AppIconName, type AppRoute } from '../../types/routes';

/**
 * 导航图标名 → SVG 组件。
 *
 * `src/types/routes.ts` 里刻意只存字符串 key（那里的文件会被主进程侧的类型检查程序
 * 一起纳入，不能出现 `.tsx`），映射关系收在这里。
 */
const NAV_ICONS: Record<AppIconName, ComponentType<IconProps>> = {
  chat: IconChat,
  personas: IconUser,
  settings: IconSettings,
};

/**
 * 左侧栏外壳：顶部「新建对话」、中部搜索 + 对话列表、底部页面导航。
 *
 * 组合契约（由 `App.tsx` 常驻渲染）：具名导出 `AppSidebar`，props 为
 * `{ route, onNavigate }`。侧边栏负责对话的增删改查，**不**渲染消息区。
 */

/** `AppSidebar` 组件属性。 */
export interface AppSidebarProps {
  /** 当前页面路由，用于高亮底部导航。 */
  route: AppRoute;
  /** 切换页面回调。 */
  onNavigate: (route: AppRoute) => void;
}

/**
 * 渲染应用侧边栏。
 *
 * @param props 见 {@link AppSidebarProps}。
 * @returns 侧边栏元素。
 */
export function AppSidebar({ route, onNavigate }: AppSidebarProps) {
  const conversations = useConversationStore((state) => state.conversations);
  const currentId = useConversationStore((state) => state.currentId);
  const loading = useConversationStore((state) => state.loading);
  const error = useConversationStore((state) => state.error);
  const keyword = useConversationStore((state) => state.keyword);
  const list = useConversationStore((state) => state.list);
  const create = useConversationStore((state) => state.create);
  const update = useConversationStore((state) => state.update);
  const remove = useConversationStore((state) => state.remove);
  const select = useConversationStore((state) => state.select);
  const clearSearch = useConversationStore((state) => state.clearSearch);

  /**
   * 首次挂载时加载对话列表，并自动选中最近更新的一条。
   *
   * 依赖数组里带上 `list` 是安全的：zustand 的 action 引用在整个 store 生命周期内稳定。
   */
  useEffect(() => {
    void list({ selectFirstWhenEmpty: true });
  }, [list]);

  /**
   * 切换对话：清空消息视图（含任何正在接收的流式内容）。
   *
   * 消息由 `ChatPage` 的 effect 监听 `currentId` 后加载，这里只负责把状态切干净，
   * 避免旧对话的消息在新对话下闪现。
   *
   * @param id 目标对话 id。
   */
  const handleSelect = (id: string) => {
    if (id === currentId) {
      return;
    }
    select(id);
    useChatStore.getState().reset(id);
  };

  /** 新建对话并选中它。 */
  const handleCreate = async () => {
    clearSearch();
    const created = await create({});
    if (created) {
      useChatStore.getState().reset(created.id);
    }
  };

  /**
   * 重命名对话。
   *
   * @param id 对话 id。
   * @param title 新标题。
   */
  const handleRename = (id: string, title: string) => {
    void update(id, { title });
  };

  /**
   * 删除对话；若删的是当前对话，把消息视图一并清空。
   *
   * 重载列表时传 `selectFirstWhenEmpty: false`：删除后让用户停在空态，而不是被自动
   * 跳到另一个对话上（焦点跳转会让人以为删错了）。
   *
   * @param id 对话 id。
   */
  const handleRemove = async (id: string) => {
    const ok = await remove(id);
    if (!ok) {
      return;
    }
    if (id === currentId) {
      useChatStore.getState().reset(null);
    }
    await list({ selectFirstWhenEmpty: false });
  };

  const searching = Boolean(keyword.trim());

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[var(--astra-border)] bg-[var(--astra-surface)]">
      <div className="border-b border-[var(--astra-border)] px-3 py-3">
        <div className="mb-2 flex items-center gap-2">
          <IconSparkle size={16} className="text-[var(--astra-accent)]" />
          <h1 className="text-sm font-semibold tracking-wide text-[var(--astra-text)]">AstraChat</h1>
        </div>
        <Button variant="primary" size="md" className="w-full" onClick={() => void handleCreate()}>
          + 新建对话
        </Button>
      </div>

      <div className="px-3 py-2">
        <ConversationSearch onSelect={handleSelect} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {searching ? (
          <p className="px-3 py-2 text-[10px] text-[var(--astra-muted)]">搜索结果见上方</p>
        ) : (
          <ConversationList
            conversations={conversations}
            currentId={currentId}
            loading={loading}
            error={error}
            onSelect={handleSelect}
            onRename={handleRename}
            onRemove={(id) => void handleRemove(id)}
          />
        )}
      </div>

      <nav className="border-t border-[var(--astra-border)] p-2">
        {APP_NAV_ITEMS.map((item) => {
          const active = item.route === route;
          const Icon = NAV_ICONS[item.icon];
          return (
            <button
              key={item.route}
              type="button"
              onClick={() => onNavigate(item.route)}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors',
                active
                  ? 'bg-[var(--astra-accent-soft)] text-[var(--astra-accent)]'
                  : 'text-[var(--astra-muted)] hover:bg-[var(--astra-surface-2)] hover:text-[var(--astra-text)]',
              )}
            >
              <Icon size={15} />
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}