import { useEffect } from 'react';
import { useQqStore } from '../../stores/useQqStore';
import type { QqContact, QqContactPolicy } from '../../types/index';
import { Badge, Button, EmptyState, IconChat, IconSparkle, IconTrash, IconUser, type BadgeTone } from '../ui';

/**
 * 「已发现的来源」授权列表。
 *
 * ## 为什么不是白名单输入框
 *
 * 官方 QQ 开放平台只给机器人 `openid`（群是 `group_openid`，人是 `user_openid`），
 * **不给 QQ 号 / 群号**。用户没有地方可以查到这些值，所以不可能手填。可行流程只能是：
 *
 * 1. 机器人收到消息时把来源记进 `qq_contacts`，初始 `policy = 'none'`；
 * 2. `none` 的来源**消息不投给模型**（fail-closed），只在这里出现；
 * 3. 用户点「允许 / 拒绝」逐条授权。
 *
 * 这比手填群号更安全（不会填错）也更省事（不用去查群号）。
 *
 * ## 授权操作不做乐观更新
 *
 * 授权状态是安全边界，因此这里等落库成功后再更新界面；失败保持原状并报错。
 */

/** 授权状态 → 徽章文案与语义色。 */
const POLICY_META: Record<QqContactPolicy, { label: string; tone: BadgeTone }> = {
  none: { label: '未授权', tone: 'neutral' },
  allow: { label: '已允许', tone: 'success' },
  deny: { label: '已拒绝', tone: 'danger' },
};

/** 来源类型 → 文案。 */
const KIND_LABEL: Record<QqContact['kind'], string> = {
  group: '群聊',
  private: '私聊',
};

/**
 * 把时间戳格式化成相对时间，便于一眼看出活跃度。
 *
 * @param timestamp Unix 毫秒。
 * @returns 人类可读的相对时间；无法解析时返回空串。
 */
function formatRelative(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 来源的展示名：优先显示名，没有就退回 openid 前缀。
 *
 * @param contact 来源。
 * @returns 展示用名称。
 */
function displayLabel(contact: QqContact): string {
  if (contact.displayName && contact.displayName.trim()) {
    return contact.displayName;
  }
  return `${KIND_LABEL[contact.kind]} ${contact.openId.slice(0, 8)}…`;
}

/**
 * 「已发现的来源」列表。
 *
 * @returns 列表区块。
 */
export default function QqContactList() {
  const contacts = useQqStore((state) => state.contacts);
  const counts = useQqStore((state) => state.counts);
  const loading = useQqStore((state) => state.loadingContacts);
  const updatingId = useQqStore((state) => state.updatingContactId);
  const ownerOpenIds = useQqStore((state) => state.config.ownerOpenIds);
  const loadContacts = useQqStore((state) => state.loadContacts);
  const setContactPolicy = useQqStore((state) => state.setContactPolicy);
  const removeContact = useQqStore((state) => state.removeContact);
  const save = useQqStore((state) => state.save);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  /**
   * 切换某个来源的管理员身份。
   *
   * 管理员列表存在 `qq_config.owner_open_ids`，所以走 `save()` 而不是来源表。
   *
   * @param openId 来源标识。
   * @returns 无。
   */
  async function toggleOwner(openId: string): Promise<void> {
    const next = ownerOpenIds.includes(openId)
      ? ownerOpenIds.filter((item) => item !== openId)
      : [...ownerOpenIds, openId];
    await save({ ownerOpenIds: next });
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-[var(--astra-text)]">已发现的来源</h3>
          <p className="mt-0.5 text-[11px] text-[var(--astra-muted)]">
            消息投递到模型前必须在这里被授权；「未授权」的来源不会被回应。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone="neutral">共 {counts.total}</Badge>
          <Badge tone="success">允许 {counts.allow}</Badge>
          <Badge tone="neutral">未授权 {counts.none}</Badge>
          {counts.deny > 0 ? <Badge tone="danger">拒绝 {counts.deny}</Badge> : null}
          <Button size="sm" variant="ghost" loading={loading} onClick={() => void loadContacts()}>
            刷新
          </Button>
        </div>
      </header>

      {contacts.length === 0 ? (
        <EmptyState
          icon={<IconUser size={22} />}
          title="还没有发现任何来源"
          description="机器人收到第一条群消息或私聊后，来源会自动出现在这里，届时再决定允许或拒绝。当前版本尚未建立真实连接，所以列表是空的。"
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {contacts.map((contact) => {
            const policyMeta = POLICY_META[contact.policy];
            const isOwner = ownerOpenIds.includes(contact.openId);
            const busy = updatingId === contact.openId;
            return (
              <li
                key={contact.openId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-[var(--astra-border)] bg-[var(--astra-surface-2)] px-3 py-2"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--astra-surface)] text-[var(--astra-muted)]">
                  {contact.kind === 'group' ? <IconChat size={13} /> : <IconUser size={13} />}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-[var(--astra-text)]">
                      {displayLabel(contact)}
                    </span>
                    <Badge tone={policyMeta.tone}>{policyMeta.label}</Badge>
                    {isOwner ? (
                      <Badge tone="accent">
                        <IconSparkle size={10} />
                        管理员
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-[var(--astra-muted)]">
                    {contact.openId} · {contact.messageCount} 条
                    {formatRelative(contact.lastSeenAt)
                      ? ` · 最近 ${formatRelative(contact.lastSeenAt)}`
                      : ''}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant={contact.policy === 'allow' ? 'primary' : 'secondary'}
                    disabled={busy}
                    onClick={() => void setContactPolicy(contact.openId, 'allow')}
                  >
                    允许
                  </Button>
                  <Button
                    size="sm"
                    variant={contact.policy === 'deny' ? 'danger' : 'secondary'}
                    disabled={busy}
                    onClick={() => void setContactPolicy(contact.openId, 'deny')}
                  >
                    拒绝
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void toggleOwner(contact.openId)}
                    title={isOwner ? '取消管理员' : '设为管理员（可用管理命令）'}
                  >
                    {isOwner ? '取消管理员' : '设为管理员'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`删除来源 ${contact.openId}`}
                    onClick={() => void removeContact(contact.openId)}
                  >
                    <IconTrash size={13} />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
