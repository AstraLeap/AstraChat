import { useEffect, useState } from 'react';
import { usePersonaStore } from '../../stores/usePersonaStore';
import type { Persona } from '../../types/index';
import { Badge, Button, ConfirmDialog, EmptyState, IconUser, LoadingBlock } from '../ui';
import PersonaForm from './PersonaForm';

/**
 * 角色（人格）列表：展示头像、名称、内置标记与系统提示词摘要，支持新建 / 编辑 / 删除。
 *
 * 列表、表单与二次确认框都收敛在本组件内，页面层只需渲染 `<PersonaList />`。
 */

/**
 * 取名称首字母作为无头像时的占位。
 *
 * @param name 角色名称。
 * @returns 单个字符。
 */
function initialOf(name: string): string {
  return name.trim().slice(0, 1) || '?';
}

/**
 * 单个角色卡片。
 *
 * @param props.persona 角色数据。
 * @param props.removing 是否正在删除。
 * @param props.onEdit 打开编辑表单。
 * @param props.onDelete 请求删除（由父组件弹二次确认）。
 * @returns 卡片元素。
 */
function PersonaCard({
  persona,
  removing,
  onEdit,
  onDelete,
}: {
  persona: Persona;
  removing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--astra-border)] bg-[var(--astra-surface)] p-3">
      <div className="flex items-start gap-3">
        {persona.avatar ? (
          <img
            src={persona.avatar}
            alt={`${persona.name} 的头像`}
            className="size-9 shrink-0 rounded-full border border-[var(--astra-border)] object-cover"
          />
        ) : (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--astra-accent-soft)] text-sm font-semibold text-[var(--astra-accent)]">
            {initialOf(persona.name)}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--astra-text)]">
              {persona.name}
            </h3>
            {persona.isPreset ? <Badge tone="accent">内置</Badge> : null}
          </div>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--astra-muted)]">
            {persona.systemPrompt.trim() || '（未填写系统提示词）'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="danger" loading={removing} onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * 角色列表容器。
 *
 * @returns 列表区块。
 */
export default function PersonaList() {
  const items = usePersonaStore((state) => state.items);
  const loading = usePersonaStore((state) => state.loading);
  const removingId = usePersonaStore((state) => state.removingId);
  const error = usePersonaStore((state) => state.error);
  const load = usePersonaStore((state) => state.load);
  const remove = usePersonaStore((state) => state.remove);
  const clearError = usePersonaStore((state) => state.clearError);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Persona | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 打开新建表单。
   *
   * @returns 无。
   */
  function openCreate(): void {
    setEditing(null);
    setFormOpen(true);
  }

  /**
   * 打开编辑表单。
   *
   * @param persona 待编辑的角色。
   * @returns 无。
   */
  function openEdit(persona: Persona): void {
    setEditing(persona);
    setFormOpen(true);
  }

  /**
   * 确认删除。
   *
   * @returns 无。
   */
  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    setPendingDelete(null);
    if (target) {
      await remove(target.id);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--astra-text)]">角色（人格）</h2>
          <p className="mt-0.5 text-[11px] text-[var(--astra-muted)]">
            系统提示词会在每轮请求时作为首条 system 消息注入。
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openCreate}>
          新建角色
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-[var(--astra-danger)]/40 bg-[var(--astra-danger)]/10 px-3 py-2 text-xs text-[var(--astra-danger)]"
        >
          <span className="min-w-0 break-words">{error}</span>
          <Button size="sm" variant="ghost" onClick={clearError}>
            知道了
          </Button>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <LoadingBlock text="正在读取角色…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconUser size={32} />}
          title="还没有任何角色"
          description="创建一个角色并写下系统提示词，聊天时即可一键切换「人格」。"
          action={
            <Button variant="primary" size="sm" onClick={openCreate}>
              新建角色
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((persona) => (
            <PersonaCard
              key={persona.id}
              persona={persona}
              removing={removingId === persona.id}
              onEdit={() => openEdit(persona)}
              onDelete={() => setPendingDelete(persona)}
            />
          ))}
        </ul>
      )}

      <PersonaForm open={formOpen} persona={editing} onClose={() => setFormOpen(false)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.isPreset ? '删除内置角色' : '删除角色'}
        message={
          pendingDelete?.isPreset
            ? `「${pendingDelete.name}」是内置示例角色，删除操作不可撤销。注意：仅当你把角色表删空时，应用下次启动才会重新写入全部内置角色；只要还剩任意一个角色，它就不会回来。`
            : `确定要删除角色「${pendingDelete?.name ?? ''}」吗？此操作不可撤销。`
        }
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
