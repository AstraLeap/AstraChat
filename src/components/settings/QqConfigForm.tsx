import { useEffect, useState } from 'react';
import { useQqStore } from '../../stores/useQqStore';
import { useQqConnection } from './useQqConnection';
import type { QqConfig, QqConnectionState, QqSocialMode } from '../../types/index';
import { Badge, Button, Field, IconWarning, Input, Select, type BadgeTone } from '../ui';
import { hasSecret, maskSecret } from './mask';
import QqContactList from './QqContactList';

/**
 * QQ bot 配置表单。
 *
 * ## 版本边界
 *
 * 「连接 / 断开」是**真实连接**：走官方 QQ 开放平台 Bot API，由主进程建立
 * WebSocket 网关。连接状态取自运行期快照（{@link useQqConnection}），不是落库的旧状态。
 *
 * ## 与 v0.1.0 的实质差别
 *
 * v0.1.0 让用户手填「群号」白名单。但官方 API 只给 `openid`、不给群号，用户无从手填，
 * 因此改成「**已发现的来源**」列表（{@link QqContactList}）：机器人先把来源记下来，
 * 用户再逐条授权。本表单因此只剩凭据、连接行为、发言模式与发送节流。
 */

/** 表单草稿。数字字段用字符串保存，便于处理「清空输入框」这种中间态。 */
interface QqDraft {
  appId: string;
  appSecret: string;
  token: string;
  enabled: boolean;
  replyInPrivate: boolean;
  auditEnabled: boolean;
  allowAllWhenEmpty: boolean;
  sendDelayMs: string;
  maxSendPerMinute: string;
  maxSendPerHour: string;
  maxReplyChars: string;
  socialMode: QqSocialMode;
  socialCooldownMs: string;
  socialMaxPerHour: string;
}

/** 发言模式的说明文案（选哪个直接决定成本）。 */
const SOCIAL_MODE_HINT: Record<QqSocialMode, string> = {
  off: '只回应被 @ 或私聊的消息。群里其它消息连模型都不会调用。',
  standard: '单次调用：模型不想接话时只输出 [[SILENCE]]。省 token，判定略粗。',
  exp: '两次调用：先单独判断要不要接话，再生成。更准（生成中的模型有「把话说下去」的惯性），但消耗约翻倍。',
};

/**
 * **实时**连接状态 → 徽章文案与语义色。
 *
 * 注意用的是 `QqConnectionState`（运行期，4 值）而不是 `QqConnectionStatus`
 * （落库，3 值）—— 界面上要显示的是「现在到底连上没有」，不是上次落库的快照。
 */
const LIVE_STATUS_META: Record<QqConnectionState, { label: string; tone: BadgeTone }> = {
  stopped: { label: '未连接', tone: 'neutral' },
  connecting: { label: '连接中…', tone: 'neutral' },
  connected: { label: '已连接', tone: 'success' },
  error: { label: '连接错误', tone: 'danger' },
};

/** 数字字段的取值范围，与数据库层的夹取区间保持一致。 */
const NUMERIC_FIELDS = {
  sendDelayMs: { label: '发送间隔', min: 0, max: 60_000, unit: '毫秒' },
  maxSendPerMinute: { label: '每分钟上限', min: 1, max: 600, unit: '条' },
  maxSendPerHour: { label: '每小时上限', min: 1, max: 36_000, unit: '条' },
  maxReplyChars: { label: '单条字符上限', min: 1, max: 4500, unit: '字符' },
  socialCooldownMs: { label: '主动发言冷却', min: 0, max: 3_600_000, unit: '毫秒' },
  socialMaxPerHour: { label: '每小时主动发言上限', min: 1, max: 600, unit: '条' },
} as const;

/** 需要校验的字段集合。 */
type QqFieldErrors = Partial<
  Record<'appId' | 'appSecret' | 'token' | keyof typeof NUMERIC_FIELDS, string>
>;

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
    enabled: config.enabled,
    replyInPrivate: config.replyInPrivate,
    auditEnabled: config.auditEnabled,
    allowAllWhenEmpty: config.allowAllWhenEmpty,
    sendDelayMs: String(config.sendDelayMs),
    maxSendPerMinute: String(config.maxSendPerMinute),
    maxSendPerHour: String(config.maxSendPerHour),
    maxReplyChars: String(config.maxReplyChars),
    socialMode: config.socialMode,
    socialCooldownMs: String(config.socialCooldownMs),
    socialMaxPerHour: String(config.socialMaxPerHour),
  };
}

/**
 * QQ bot 配置表单。
 *
 * @returns 表单区块。
 */
export default function QqConfigForm() {
  const config = useQqStore((state) => state.config);
  const counts = useQqStore((state) => state.counts);
  const loading = useQqStore((state) => state.loading);
  const saving = useQqStore((state) => state.saving);
  const error = useQqStore((state) => state.error);
  const load = useQqStore((state) => state.load);
  const save = useQqStore((state) => state.save);
  const clearError = useQqStore((state) => state.clearError);

  // 真实连接状态来自主进程（不是 store 里那份落库状态）
  const {
    status: liveStatus,
    busy: connecting,
    connect,
    disconnect,
  } = useQqConnection();

  const [draft, setDraft] = useState<QqDraft>(() => toDraft(config));
  /** 是否有未保存的修改；为真时不会被 store 的推送覆盖，避免连接状态切换吃掉用户输入。 */
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<QqFieldErrors>({});
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
   * 校验草稿。
   *
   * 只有「启用」打开时才强制 AppID / AppSecret / Token 必填 —— 关掉开关时可以只存一半
   * 配置，但一旦启用就必须完整，避免运行时才炸。
   *
   * @returns 字段级错误。
   */
  function validate(): QqFieldErrors {
    const next: QqFieldErrors = {};
    if (draft.enabled) {
      if (!draft.appId.trim()) {
        next.appId = '启用后必须填写 AppID';
      }
      if (!draft.appSecret.trim()) {
        next.appSecret = '启用后必须填写 AppSecret';
      }
      if (!draft.token.trim()) {
        next.token = '启用后必须填写 Token';
      }
    }

    for (const key of Object.keys(NUMERIC_FIELDS) as (keyof typeof NUMERIC_FIELDS)[]) {
      const limit = NUMERIC_FIELDS[key];
      const raw = draft[key].trim();
      if (!/^\d+$/.test(raw)) {
        next[key] = `${limit.label}必须是非负整数`;
        continue;
      }
      const value = Number(raw);
      if (value < limit.min || value > limit.max) {
        next[key] = `${limit.label}需在 ${limit.min} ~ ${limit.max} ${limit.unit}之间`;
      }
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
      enabled: draft.enabled,
      replyInPrivate: draft.replyInPrivate,
      auditEnabled: draft.auditEnabled,
      allowAllWhenEmpty: draft.allowAllWhenEmpty,
      sendDelayMs: Number(draft.sendDelayMs),
      maxSendPerMinute: Number(draft.maxSendPerMinute),
      maxSendPerHour: Number(draft.maxSendPerHour),
      maxReplyChars: Number(draft.maxReplyChars),
      socialMode: draft.socialMode,
      socialCooldownMs: Number(draft.socialCooldownMs),
      socialMaxPerHour: Number(draft.socialMaxPerHour),
    });
    setDirty(!ok);
    setSavedHint(ok);
    if (ok) {
      // 保存会动 ownerOpenIds / 策略，来源列表的徽章要跟着刷新。
      void useQqStore.getState().loadContacts();
    }
  }

  const statusMeta = LIVE_STATUS_META[liveStatus.state];
  // 连接中也算「已连接」：按钮显示「断开」，避免用户在重连过程中反复点「连接」
  const isConnected =
    liveStatus.state === 'connected' || liveStatus.state === 'connecting';

  /** 启用但没有任何已授权来源、又没打开「放行全部」→ 实际上不会回应任何人。 */
  const blockedByPolicy =
    draft.enabled && !draft.allowAllWhenEmpty && counts.allow === 0;

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--astra-text)]">QQ bot</h2>
          <p className="mt-0.5 text-[11px] text-[var(--astra-muted)]">
            走 QQ 开放平台官方 Bot API；群消息接入配置。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
          <Button
            size="sm"
            variant={isConnected ? 'secondary' : 'primary'}
            loading={connecting}
            onClick={() => void (isConnected ? disconnect() : connect())}
          >
            {isConnected ? '断开' : '连接'}
          </Button>
        </div>
      </header>

      {/* 版本边界提示：需求明确要求常驻可见，不要删。 */}
      <p
        role="note"
        className="rounded-md border border-[var(--astra-accent)]/30 bg-[var(--astra-accent-soft)] px-3 py-2 text-[11px] leading-relaxed text-[var(--astra-text)]"
      >
        <strong className="font-semibold">连接是真实的，消息处理还没接线。</strong>{' '}
        点「连接」会与 QQ 开放平台建立真实连接，状态与机器人身份都来自服务端；
        但「收到消息 → 问模型 → 自动回复」这条链路尚未接线，收到的事件只会写进主进程日志。
        下面的「已发现的来源」要在消息处理接线后才会出现内容。
      </p>

      {liveStatus.message ? (
        <p className="text-[11px] text-[var(--astra-muted)]">状态说明：{liveStatus.message}</p>
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

      {/* ---------------------------------------------------------- 凭据 */}
      <div className="flex flex-col gap-4">
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
              : '明文保存在本机 SQLite（当前不做加密）。'
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
      </div>

      {/* ------------------------------------------------------ 连接行为 */}
      <fieldset className="flex flex-col gap-2.5 rounded-md border border-[var(--astra-border)] px-3 py-3">
        <legend className="px-1 text-[11px] font-semibold text-[var(--astra-text)]">
          连接行为
        </legend>

        <label className="flex items-start gap-2 text-xs text-[var(--astra-text)]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-[var(--astra-accent)]"
            checked={draft.enabled}
            onChange={(event) => setField('enabled', event.target.checked)}
          />
          <span>
            启用 QQ bot
            <span className="mt-0.5 block text-[11px] text-[var(--astra-muted)]">
              关闭时（默认）不处理任何消息，即使凭据已填好。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs text-[var(--astra-text)]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-[var(--astra-accent)]"
            checked={draft.replyInPrivate}
            onChange={(event) => setField('replyInPrivate', event.target.checked)}
          />
          <span>
            允许回应私聊
            <span className="mt-0.5 block text-[11px] text-[var(--astra-muted)]">
              仍受下方来源授权约束；未授权的私聊不会被回应。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs text-[var(--astra-text)]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-[var(--astra-accent)]"
            checked={draft.auditEnabled}
            onChange={(event) => setField('auditEnabled', event.target.checked)}
          />
          <span>
            发送前做内容审计
            <span className="mt-0.5 block text-[11px] text-[var(--astra-muted)]">
              拦截含本机路径或凭据特征的整条回复，避免把密钥发到群里。建议保持开启。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs text-[var(--astra-text)]">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-[var(--astra-accent)]"
            checked={draft.allowAllWhenEmpty}
            onChange={(event) => setField('allowAllWhenEmpty', event.target.checked)}
          />
          <span>
            白名单为空时放行全部来源
            <span className="mt-0.5 block text-[11px] text-[var(--astra-muted)]">
              默认关闭（fail-closed）。打开后<strong className="font-semibold">任何人</strong>
              加机器人为好友或拉它进群都能让它开口，等于把这个账号交给模型。
              除非你在完全封闭的测试群里，否则不要打开。
            </span>
          </span>
        </label>

        {draft.allowAllWhenEmpty ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-[var(--astra-danger)]/40 bg-[var(--astra-danger)]/10 px-2.5 py-2 text-[11px] text-[var(--astra-danger)]"
          >
            <IconWarning size={14} />
            <span>已开启「放行全部来源」。任何陌生人都能触发模型回复，请确认这是有意为之。</span>
          </p>
        ) : null}

        {blockedByPolicy ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md border border-[var(--astra-border)] bg-[var(--astra-surface-2)] px-2.5 py-2 text-[11px] text-[var(--astra-muted)]"
          >
            <IconWarning size={14} />
            <span>
              已启用，但还没有任何被允许的来源，因此实际上不会回应任何人。请到下方「已发现的来源」
              授权，或（仅测试环境）打开「放行全部来源」。
            </span>
          </p>
        ) : null}
      </fieldset>

      {/* ---------------------------------------------------- 发言模式 */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--astra-border)] px-3 py-3">
        <legend className="px-1 text-[11px] font-semibold text-[var(--astra-text)]">
          让模型自行决定是否回复
        </legend>
        <p className="-mt-1 text-[11px] text-[var(--astra-muted)]">
          关闭时只回应被 @ 或私聊的消息。开启后，群里**未被指向**的消息也会交给模型判断要不要接话；
          被 @ 与私聊**始终必定回复**，不经过判断。冷却与每小时上限在下方「发送节流」里设置。
        </p>

        <Field label="发言模式" htmlFor="qq-socialMode" hint={SOCIAL_MODE_HINT[draft.socialMode]}>
          <Select
            id="qq-socialMode"
            value={draft.socialMode}
            onChange={(event) => setField('socialMode', event.target.value as QqSocialMode)}
          >
            <option value="off">关闭 —— 只回应被 @ 的消息（默认）</option>
            <option value="standard">标准 —— 单次调用，模型用哨兵表态（省 token）</option>
            <option value="exp">EXP 实验性 —— 两次调用，判定更准但消耗约翻倍</option>
          </Select>
        </Field>
      </fieldset>

      {/* ------------------------------------------------------ 发送节流 */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--astra-border)] px-3 py-3">
        <legend className="px-1 text-[11px] font-semibold text-[var(--astra-text)]">
          发送节流
        </legend>
        <p className="-mt-1 text-[11px] text-[var(--astra-muted)]">
          官方对群消息有频控（单群 20 条/分钟、每日 1000 条）。上限设太低会被限流，设太高没有防护意义。
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(NUMERIC_FIELDS) as (keyof typeof NUMERIC_FIELDS)[]).map((key) => {
            const limit = NUMERIC_FIELDS[key];
            return (
              <Field
                key={key}
                label={limit.label}
                htmlFor={`qq-${key}`}
                error={errors[key]}
                hint={`${limit.min} ~ ${limit.max} ${limit.unit}`}
              >
                <Input
                  id={`qq-${key}`}
                  type="number"
                  min={limit.min}
                  max={limit.max}
                  value={draft[key]}
                  invalid={Boolean(errors[key])}
                  inputMode="numeric"
                  onChange={(event) => setField(key, event.target.value)}
                />
              </Field>
            );
          })}
        </div>
      </fieldset>

      {/* -------------------------------------------------- 已发现来源 */}
      <QqContactList />

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
