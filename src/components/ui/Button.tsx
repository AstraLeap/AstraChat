import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** 按钮视觉变体。 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** 按钮尺寸。 */
export type ButtonSize = 'sm' | 'md';

/** `Button` 组件属性。 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体，默认 `secondary`。 */
  variant?: ButtonVariant;
  /** 尺寸，默认 `md`。 */
  size?: ButtonSize;
  /** 是否处于加载中（显示旋转图标并禁用点击）。 */
  loading?: boolean;
  /** 按钮内容。 */
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--astra-accent)] text-white hover:brightness-110 active:brightness-95 border border-transparent',
  secondary:
    'bg-[var(--astra-surface)] text-[var(--astra-text)] border border-[var(--astra-border)] hover:bg-[var(--astra-surface-2)]',
  ghost:
    'bg-transparent text-[var(--astra-text)] border border-transparent hover:bg-[var(--astra-surface-2)]',
  danger:
    'bg-[var(--astra-danger)] text-white hover:brightness-110 active:brightness-95 border border-transparent',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1',
  md: 'h-9 px-3.5 text-sm gap-1.5',
};

/**
 * 通用按钮。所有交互元素都经此统一，避免各处自造样式导致视觉漂移。
 *
 * @param props 见 {@link ButtonProps}。
 * @returns 按钮元素。
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex select-none items-center justify-center rounded-md font-medium transition-[filter,background-color]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--astra-accent)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
    >
      {loading ? (
        <span
          aria-hidden
          className="mr-1 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
