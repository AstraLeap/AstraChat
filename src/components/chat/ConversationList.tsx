import { useState } from 'react';
import clsx from 'clsx';
import { Button, ConfirmDialog, IconPencil, IconTrash, Input, LoadingBlock, Modal } from '../ui/index';
import type { ConversationSummary } from '../../types/index';

/**
 * 左侧对话列表。
 *
 * 纯展示组件：数据与动作都由父组件（`AppSidebar`）通过 props 传入，自己不订阅 store。
 * 这样列表既能被侧边栏复用，也能在测试里用假数据单独渲染。
 */

/** `ConversationList` 组件属性。 */
export interface ConversationListProps {
  /** 对话摘要（父组件保证已按 `updatedAt` 倒序）。 */
  conversations: ConversationSummary[];
  /** 当前选中的对话 id。 */
  currentId: string | null;
  /** 是否正在加载。 */
  loading?: boolean;
  /** 错误文案。 */
  error?: string | null;
  /** 点击某条对话。 */
  onSelect: (id: string) => void;
  /** 重命名某条对话。 */
  onRename: (id: string, title: string) => void;
  /** 删除某条对话。 */
  onRemove: (id: string) => void;
}

/**
 * 生成对话列表项的时间标签。
 *
 * @param timestamp Unix 毫秒。
 * @returns 当天显示 `HH:mm`，否则显示 `M月D日`。
 */
function formatUpdatedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 渲染对话列表与重命名/删除交互。
 *
 * @param props 见 {@link ConversationListProps}。
 * @returns 列表元素。
 */
export function ConversationList({
  conversations,
  currentId,
  loading = false,
  error,
  onSelect,
  onRename,
  onRemove,
}: ConversationListProps) {
  /** 正在重命名的对话 id；`null` 表示弹窗关闭。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** 重命名草稿。 */
  const [renameDraft, setRenameDraft] = useState('');
  /** 待删除的对话（用于二次确认弹窗）。 */
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);

  /**
   * 打开重命名弹窗。
   *
   * @param conversation 目标对话。
   */
  const openRename = (conversation: ConversationSummary) => {
    setRenamingId(conversation.id);
    setRenameDraft(conversation.title);
  };

  /** 提交重命名。 */
  const submitRename = () => {
    if (!renamingId) {
      return;
    }
    const title = renameDraft.trim();
    if (title) {
      onRename(renamingId, title);
    }
    setRenamingId(null);
  };

  if (loading && conversations.length === 0) {
    return <LoadingBlock text="正在加载对话…" />;
  }

  if (error && conversations.length === 0) {
    return <p className="p-3 text-[11px] text-[var(--astra-danger)]">{error}</p>;
  }

  if (conversations.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-[var(--astra-muted)]">
        还没有对话
        <br />
        点击上方「新建对话」开始
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {conversations.map((conversation) => {
          const active = conversation.id === currentId;
          return (
            <li key={conversation.id} className="group/item relative">
              <button
                type="button"
                onClick={() => onSelect(conversation.id)}
                title={conversation.title}
                className={clsx(
                  'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 pr-14 text-left transition-colors',
                  active
                    ? 'bg-[var(--astra-accent-soft)] text-[var(--astra-text)]'
                    : 'text-[var(--astra-text)] hover:bg-[var(--astra-surface-2)]',
                )}
              >
                <span className="w-full truncate text-xs font-medium">{conversation.title}</span>
                <span className="flex w-full items-center gap-1.5 text-[10px] text-[var(--astra-muted)]">
                  <span>{conversation.messageCount} 条</span>
                  <span aria-hidden>·</span>
                  <span>{formatUpdatedAt(conversation.updatedAt)}</span>
                </span>
              </button>

              {/* 悬停才显形的操作按钮，避免列表常态下过于嘈杂。 */}
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={`重命名「${conversation.title}」`}
                  title="重命名"
                  onClick={() => openRename(conversation)}
                  className="rounded p-1 text-[var(--astra-muted)] hover:bg-[var(--astra-surface-2)] hover:text-[var(--astra-text)]"
                >
                  <IconPencil size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`删除「${conversation.title}」`}
                  title="删除"
                  onClick={() => setPendingDelete(conversation)}
                  className="rounded p-1 text-[var(--astra-muted)] hover:bg-[var(--astra-surface-2)] hover:text-[var(--astra-danger)]"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <Modal
        open={renamingId !== null}
        title="重命名对话"
        onClose={() => setRenamingId(null)}
        widthClassName="max-w-sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenamingId(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={submitRename} disabled={!renameDraft.trim()}>
              保存
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={renameDraft}
          aria-label="对话标题"
          onChange={(event) => setRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitRename();
            }
          }}
        />
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除对话"
        message={`确定删除「${pendingDelete?.title ?? ''}」吗？该对话下的全部消息也会一并删除，此操作不可撤销。`}
        confirmText="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            onRemove(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </>
  );
}