import { useEffect, useState } from 'react';
import { useProviderStore } from '../../stores/useProviderStore';
import type { Provider } from '../../types/index';
import { Badge, Button, ConfirmDialog, EmptyState, IconPlug, LoadingBlock } from '../ui';
import ProviderForm from './ProviderForm';
import { hasSecret, maskSecret } from './mask';

/**
 * 提供商列表：卡片式展示名称、接口地址、默认模型与 **掩码后的** API Key，
 * 并提供新建 / 编辑 / 删除 / 设为当前四项操作。
 *
 * 列表与表单、二次确认框都收敛在本组件内，设置页只需渲染 `<ProviderList />`。
 */

/**
 * 单个提供商卡片。
 *
 * @param props.provider 提供商数据。
 * @param props.selected 是否为当前选中项。
 * @param props.removing 是否正在删除（按钮 loading）。
 * @param props.onSelect 设为当前选中项。
 * @param props.onEdit 打开编辑表单。
 * @param props.onDelete 请求删除（由父组件弹二次确认）。
 * @returns 卡片元素。
 */
function ProviderCard({
  provider,
  selected,
  removing,
  onSelect,
  onEdit,
  onDelete,
}: {
  provider: Provider;
  selected: boolean;
  removing: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={
        'flex flex-col gap-2 rounded-lg border bg-[var(--astra-surface)] p-3 ' +
        (selected ? 'border-[var(--astra-accent)]' : 'border-[var(--astra-border)]')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--astra-text)]">
              {provider.name}
            </h3>
            {selected ? <Badge tone="accent">当前使用</Badge> : null}
          </div>
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-[var(--astra-muted)]"
            title={provider.baseUrl}
          >
            {provider.baseUrl}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {selected ? null : (
            <Button size="sm" variant="ghost" onClick={onSelect}>
              设为当前
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="danger" loading={removing} onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--astra-muted)]">
        <div className="flex items-center gap-1">
          <dt>模型</dt>
          <dd className="font-mono text-[var(--astra-text)]">
            {provider.model || <span className="text-[var(--astra-muted)]">未指定</span>}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>API Key</dt>
          <dd className="font-mono text-[var(--astra-text)]" title="出于安全考虑此处只显示掩码">
            {/* 只渲染掩码，明文既不进 DOM 也不进 console。 */}
            {maskSecret(provider.apiKey)}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>密钥状态</dt>
          <dd>
            {hasSecret(provider.apiKey) ? (
              <Badge tone="success">已配置</Badge>
            ) : (
              <Badge tone="danger">未配置</Badge>
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * 提供商列表容器。
 *
 * @returns 列表区块。
 */
export default function ProviderList() {
  const items = useProviderStore((state) => state.items);
  const loading = useProviderStore((state) => state.loading);
  const removingId = useProviderStore((state) => state.removingId);
  const error = useProviderStore((state) => state.error);
  const selectedId = useProviderStore((state) => state.selectedId);
  const load = useProviderStore((state) => state.load);
  const remove = useProviderStore((state) => state.remove);
  const select = useProviderStore((state) => state.select);
  const clearError = useProviderStore((state) => state.clearError);

  /** 表单弹窗状态：`open` 控制显隐，`editing` 为 null 表示新建。 */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  /** 待删除的提供商；非空时显示二次确认框。 */
  const [pendingDelete, setPendingDelete] = useState<Provider | null>(null);

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
   * @param provider 待编辑的提供商。
   * @returns 无。
   */
  function openEdit(provider: Provider): void {
    setEditing(provider);
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
          <h2 className="text-sm font-semibold text-[var(--astra-text)]">模型提供商</h2>
          <p className="mt-0.5 text-[11px] text-[var(--astra-muted)]">
            仅支持 OpenAI 兼容协议（<span className="font-mono">POST /chat/completions</span>）。
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openCreate}>
          新建提供商
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
        <LoadingBlock text="正在读取提供商…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconPlug size={32} />}
          title="还没有配置模型提供商"
          description="添加一个 OpenAI 兼容的接口地址与 API Key 后，就可以开始对话了。"
          action={
            <Button variant="primary" size="sm" onClick={openCreate}>
              新建提供商
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              selected={provider.id === selectedId}
              removing={removingId === provider.id}
              onSelect={() => select(provider.id)}
              onEdit={() => openEdit(provider)}
              onDelete={() => setPendingDelete(provider)}
            />
          ))}
        </ul>
      )}

      <ProviderForm open={formOpen} provider={editing} onClose={() => setFormOpen(false)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除提供商"
        message={`确定要删除提供商「${pendingDelete?.name ?? ''}」吗？此操作不可撤销。`}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
