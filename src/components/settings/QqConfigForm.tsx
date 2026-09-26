import { useEffect, useState } from 'react';
import { useQqStore } from '../../stores/useQqStore';
import type { QqConfig, QqConnectionStatus } from '../../types/index';
import { Badge, Button, Field, IconX, Input, type BadgeTone } from '../ui';
import { hasSecret, maskSecret } from './mask';

/**
 * QQ bot 配置表单（v0.1.0）。
 *
 * **版本边界**：本版本只把 AppID / AppSecret / Token / 群号列表落库，并在界面上呈现一个
 * 由用户操作驱动的连接状态；「连接 / 断开」**不会**建立任何真实连接，也不会与 QQ 服务器
 * 发生任何交互。真实连接属于 v0.2.0（`electron/qq.ts` 适配器）。界面上必须始终能看到
 * 这条提示，不能让用户误以为真的连上了。
 */

/** 表单草稿：与 `QqConfig` 的差别是群号输入框内容单独管理。 */
interface QqDraft {
  appId: string;
  appSecret: string;
  token: string;
  groupIds: string[];
  enabled: boolean;
}

/** 连接状态 → 徽章文案与语义色。 */
const STATUS_META: Record<QqConnectionStatus, { label: string; tone: BadgeTone }> = {
  disconnected: { label: '未连接', tone: 'neutral' },
  connected: { label: '已连接（模拟）', tone: 'success' },
  error: { label: '错误', tone: 'danger' },
};

/** 需要校验的字段集合。 */
type QqFieldErrors = Partial<Record<'appId' | 'appSecret' | 'token' | 'groupIds', string>>;

/**
 * 从配置构造表单草稿。
 *
 * @param config QQ 配置。
 * @returns 表单草稿。
 */
function toDraft(config: QqConfig): QqDraft {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    token: config.token,
    groupIds: [...config.groupIds],
    enabled: config.enabled,
  };
}

/**
 * QQ bot 配置表单。
 *
 * @returns 表单区块。
 */
export default function QqConfigForm() {
  const config = useQqStore((state) => state.config);
  const loading = useQqStore((state) => state.loading);
  const saving = useQqStore((state) => state.saving);
  const toggling = useQqStore((state) => state.togglingConnection);
  const error = useQqStore((state) => state.error);
  const load = useQqStore((state) => state.load);
  const save = useQqStore((state) => state.save);
  const connect = useQqStore((state) => state.connect);
  const disconnect = useQqStore((state) => state.disconnect);
  const clearError = useQqStore((state) => state.clearError);

  const [draft, setDraft] = useState<QqDraft>(() => toDraft(config));
  /** 是否有未保存的修改；为真时不会被 store 的推送覆盖，避免连接状态切换吃掉用户输入。 */
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<QqFieldErrors>({});
  const [groupInput, setGroupInput] = useState('');
  const [groupInputError, setGroupInputError] = useState<string | null>(null);
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // 只在「没有未保存修改」时把 store 的值灌回草稿（初次加载、以及保存成功后）。
  useEffect(() => {
    if (!dirty) {
      setDraft(toDraft(config));
    }
  }, [config, dirty]);

  /**
   * 更新草稿字段并标记为脏。
   *
   * @param key 字段名。
   * @param value 新值。
   * @returns 无。
   */
  function setField<K extends keyof QqDraft>(key: K, value: QqDraft[K]): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
    setSavedHint(false);
    setErrors((previous) => {
      if (!previous[key as keyof QqFieldErrors]) {
        return previous;
      }
      const next = { ...previous };
      delete next[key as keyof QqFieldErrors];
      return next;
    });
  }

  /**
   * 新增一个群号 tag。
   *
   * @returns 无。
   */
  function addGroupId(): void {
    const value = groupInput.trim();
    if (!value) {
      setGroupInputError('请输入群号');
      return;
    }
    if (!/^\d+$/.test(value)) {
      setGroupInputError('群号只能是数字');
      return;
    }
    if (draft.groupIds.includes(value)) {
      setGroupInputError('该群号已在列表中');
      return;
    }
    setDraft((previous) => ({ ...previous, groupIds: [...previous.groupIds, value] }));
    setGroupInput('');
    setGroupInputError(null);
    setDirty(true);
    setSavedHint(false);
  }

  /**
   * 移除一个群号 tag。
   *
   * @param groupId 群号。
   * @returns 无。
   */
  function removeGroupId(groupId: string): void {
    setDraft((previous) => ({
      ...previous,
      groupIds: previous.groupIds.filter((item) => item !== groupId),
    }));
    setDirty(true);
    setSavedHint(false);
  }

  /**
   * 校验草稿。
   *
   * 只有在「启用」打开时才强制 AppID / AppSecret / Token 必填 —— 关掉开关时可以只存一半
   * 配置，但一旦启用就必须完整，避免运行时才炸。
   *
   * @returns 字段级错误。
   */
  function validate(): QqFieldErrors {
    const next: QqFieldErrors = {};
    if (!draft.enabled) {
      return next;
    }
    if (!draft.appId.trim()) {
      next.appId = '启用后必须填写 AppID';
    }
    if (!draft.appSecret.trim()) {
      next.appSecret = '启用后必须填写 AppSecret';
    }
    if (!draft.token.trim()) {
      next.token = '启用后必须填写 Token';
    }
    if (draft.groupIds.length === 0) {
      next.groupIds = '启用后至少需要一个允许响应的群号';
    }
    return next;
  }

  /**
   * 保存配置。
   *
   * @returns 无。
   */
  async function handleSave(): Promise<void> {
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const ok = await save({
      appId: draft.appId.trim(),
      appSecret: draft.appSecret.trim(),
      token: draft.token.trim(),
      groupIds: draft.groupIds,
      enabled: draft.enabled,
    });
    setDirty(!ok);
    setSavedHint(ok);
  }

  const statusMeta = STATUS_META[config.status];
  const isConnected = config.status === 'connected';

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--astra-text)]">QQ bot</h2>
          <p className="mt-0.5 text-[11px] text-[var(--astra-muted)]">
            群消息接入配置（v0.2.0 起生效）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
          <Button
            size="sm"
            variant={isConnected ? 'secondary' : 'primary'}
            loading={toggling}
            onClick={() => void (isConnected ? disconnect() : connect())}
          >
            {isConnected ? '断开' : '连接'}
          </Button>
        </div>
      </header>

      {/* 版本边界提示：这是需求明确要求常驻可见的说明，不要删。 */}
      <p
        role="note"
        className="rounded-md border border-[var(--astra-accent)]/30 bg-[var(--astra-accent-soft)] px-3 py-2 text-[11px] leading-relaxed text-[var(--astra-text)]"
      >
        <strong className="font-semibold">v0.1.0 仅保存配置，尚未实现真实连接。</strong>{' '}
        「连接 / 断开」只切换上面的状态标记，不会与 QQ 服务器建立任何连接，也不会收发任何消息。
      </p>

      {config.statusMessage ? (
        <p className="text-[11px] text-[var(--astra-muted)]">状态说明：{config.statusMessage}</p>
      ) : null}

      {loading ? <p className="text-[11px] text-[var(--astra-muted)]">正在读取配置…</p> : null}

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

      <Field
        label="AppID"
        htmlFor="qq-app-id"
        required={draft.enabled}
        error={errors.appId}
        hint="QQ 开放平台机器人（Bot）的 AppID。"
      >
        <Input
          id="qq-app-id"
          value={draft.appId}
          invalid={Boolean(errors.appId)}
          placeholder="102xxxxxx"
          spellCheck={false}
          onChange={(event) => setField('appId', event.target.value)}
        />
      </Field>

      <Field
        label="AppSecret"
        htmlFor="qq-app-secret"
        required={draft.enabled}
        error={errors.appSecret}
        hint={
          hasSecret(config.appSecret)
            ? `已保存：${maskSecret(config.appSecret)}。清空输入框再保存会删除该值。`
            : '明文保存在本机 SQLite（v0.1.0 不做加密）。'
        }
      >
        <div className="flex items-center gap-2">
          <Input
            id="qq-app-secret"
            type={showAppSecret ? 'text' : 'password'}
            value={draft.appSecret}
            invalid={Boolean(errors.appSecret)}
            autoComplete="off"
            spellCheck={false}
            placeholder="••••••••"
            onChange={(event) => setField('appSecret', event.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={() => setShowAppSecret((v) => !v)}>
            {showAppSecret ? '隐藏' : '显示'}
          </Button>
        </div>
      </Field>

      <Field
        label="Token"
        htmlFor="qq-token"
        required={draft.enabled}
        error={errors.token}
        hint={
          hasSecret(config.token)
            ? `已保存：${maskSecret(config.token)}。清空输入框再保存会删除该值。`
            : 'QQ 开放平台回调校验用的 Token。'
        }
      >
        <div className="flex items-center gap-2">
          <Input
            id="qq-token"
            type={showToken ? 'text' : 'password'}
            value={draft.token}
            invalid={Boolean(errors.token)}
            autoComplete="off"
            spellCheck={false}
            placeholder="••••••••"
            onChange={(event) => setField('token', event.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={() => setShowToken((v) => !v)}>
            {showToken ? '隐藏' : '显示'}
          </Button>
        </div>
      </Field>

      <Field
        label="允许响应的群号"
        htmlFor="qq-group-input"
        required={draft.enabled}
        error={errors.groupIds ?? groupInputError}
        hint="留空并启用会在保存时被拦截；群号只接受数字。"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              id="qq-group-input"
              value={groupInput}
              invalid={Boolean(groupInputError)}
              placeholder="例如：123456789"
              inputMode="numeric"
              spellCheck={false}
              onChange={(event) => {
                setGroupInput(event.target.value);
                setGroupInputError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // 避免在表单里按回车触发意外的提交行为。
                  event.preventDefault();
                  addGroupId();
                }
              }}
            />
            <Button size="sm" variant="secondary" onClick={addGroupId}>
              添加
            </Button>
          </div>

          {draft.groupIds.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {draft.groupIds.map((groupId) => (
                <li key={groupId}>
                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--astra-border)] bg-[var(--astra-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--astra-text)]">
                    {groupId}
                    <button
                      type="button"
                      aria-label={`移除群号 ${groupId}`}
                      className="rounded p-0.5 text-[var(--astra-muted)] hover:text-[var(--astra-danger)]"
                      onClick={() => removeGroupId(groupId)}
                    >
                      <IconX size={11} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-[var(--astra-muted)]">尚未添加任何群号。</p>
          )}
        </div>
      </Field>

      <label className="flex items-center gap-2 text-xs text-[var(--astra-text)]">
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--astra-accent)]"
          checked={draft.enabled}
          onChange={(event) => setField('enabled', event.target.checked)}
        />
        启用自动回复（v0.2.0 生效，v0.1.0 仅保存该开关）
      </label>

      <div className="flex items-center gap-2">
        <Button variant="primary" loading={saving} onClick={() => void handleSave()}>
          保存配置
        </Button>
        {dirty ? <span className="text-[11px] text-[var(--astra-muted)]">有未保存的修改</span> : null}
        {!dirty && savedHint ? (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">已保存到本机</span>
        ) : null}
      </div>
    </section>
  );
}
