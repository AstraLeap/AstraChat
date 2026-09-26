import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * 轻量展示型组件：`Spinner`、`Badge`、`EmptyState`、`LoadingBlock`。
 */

/** `Spinner` 组件属性。 */
export interface SpinnerProps {
  /** 尺寸类名，默认 `size-4`。 */
  className?: string;
  /** 无障碍标签。 */
  label?: string;
}

/**
 * 旋转加载图标。
 *
 * @param props 见 {@link SpinnerProps}。
 * @returns 图标元素。
 */
export function Spinner({ className, label = '加载中' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={clsx(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-[-0.125em]',
        className ?? 'size-4',
      )}
    />
  );
}

/** 徽章的语义色。 */
export type BadgeTone = 'neutral' | 'success' | 'danger' | 'accent';

/** `Badge` 组件属性。 */
export interface BadgeProps {
  /** 语义色，默认 `neutral`。 */
  tone?: BadgeTone;
  /** 内容。 */
  children: ReactNode;
  /** 附加类名。 */
  className?: string;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--astra-surface-2)] text-[var(--astra-muted)] border-[var(--astra-border)]',
  success: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
  danger: 'bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400',
  accent: 'bg-[var(--astra-accent-soft)] text-[var(--astra-accent)] border-[var(--astra-accent)]/30',
};

/**
 * 状态徽章。
 *
 * @param props 见 {@link BadgeProps}。
 * @returns 徽章元素。
 */
export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** `EmptyState` 组件属性。 */
export interface EmptyStateProps {
  /**
   * 图标节点。请传入 `src/components/ui/icons.tsx` 里的 SVG 图标（如
   * `<IconSparkle size={32} />`），**不要**再用 emoji —— emoji 是彩色字体，不继承
   * `currentColor`，无法跟随主题与选中态配色。
   */
  icon?: ReactNode;
  /** 主标题。 */
  title: string;
  /** 补充说明。 */
  description?: ReactNode;
  /** 操作区。 */
  action?: ReactNode;
}

/**
 * 空状态占位。
 *
 * @param props 见 {@link EmptyStateProps}。
 * @returns 空状态元素。
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon ? (
        <div className="mb-1 text-[var(--astra-muted)] opacity-80" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-[var(--astra-text)]">{title}</h3>
      {description ? (
        <p className="max-w-sm text-xs leading-relaxed text-[var(--astra-muted)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** `LoadingBlock` 组件属性。 */
export interface LoadingBlockProps {
  /** 提示文案，默认「加载中…」。 */
  text?: string;
}

/**
 * 局域加载占位。
 *
 * @param props 见 {@link LoadingBlockProps}。
 * @returns 加载块。
 */
export function LoadingBlock({ text = '加载中…' }: LoadingBlockProps) {
  return (
    <div className="flex items-center justify-center gap-2 p-6 text-xs text-[var(--astra-muted)]">
      <Spinner className="size-3.5" />
      {text}
    </div>
  );
}
