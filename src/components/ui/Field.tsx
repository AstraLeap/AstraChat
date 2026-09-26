import clsx from 'clsx';
import type { ComponentPropsWithRef, ReactNode } from 'react';

/**
 * 表单控件集合：`Field`（带标签/错误的外壳）、`Input`、`Textarea`、`Select`。
 *
 * 说明：这些控件只负责样式与无障碍属性（`aria-invalid`），不做任何校验逻辑。
 */

/** 字段外壳属性。 */
export interface FieldProps {
  /** 字段标签。 */
  label: string;
  /** 关联控件的 id（用于 `htmlFor`）。 */
  htmlFor?: string;
  /** 校验错误文案；非空时控件描边转为危险色。 */
  error?: string | null;
  /** 辅助说明，展示在标签下方。 */
  hint?: ReactNode;
  /** 是否必填（在标签后显示星号）。 */
  required?: boolean;
  /** 控件本身。 */
  children: ReactNode;
  /** 外层附加类名。 */
  className?: string;
}

/**
 * 表单字段外壳：统一「标签 + 控件 + 提示/错误」的排版。
 *
 * @param props 见 {@link FieldProps}。
 * @returns 字段容器。
 */
export function Field({ label, htmlFor, error, hint, required, children, className }: FieldProps) {
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-[var(--astra-text)]">
        {label}
        {required ? <span className="ml-0.5 text-[var(--astra-danger)]">*</span> : null}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--astra-muted)]">{hint}</p> : null}
      {error ? <p className="text-[11px] text-[var(--astra-danger)]">{error}</p> : null}
    </div>
  );
}

/** 输入框属性（在原生属性基础上补充 `invalid`）。 */
export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** 是否处于校验失败态。 */
  invalid?: boolean;
}

/**
 * 单行文本输入框。
 *
 * @param props 见 {@link InputProps}。
 * @returns 输入框元素。
 */
export function Input({ className, invalid, ref, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(
        'w-full rounded-md border bg-[var(--astra-surface)] px-2.5 py-1.5 text-sm text-[var(--astra-text)]',
        'placeholder:text-[var(--astra-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--astra-accent)]/40',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-[var(--astra-danger)]' : 'border-[var(--astra-border)]',
        className,
      )}
    />
  );
}

/** 多行文本域属性。 */
export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  /** 是否处于校验失败态。 */
  invalid?: boolean;
}

/**
 * 多行文本域。
 *
 * @param props 见 {@link TextareaProps}。
 * @returns 文本域元素。
 */
export function Textarea({ className, invalid, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(
        'w-full resize-y rounded-md border bg-[var(--astra-surface)] px-2.5 py-1.5 text-sm leading-relaxed text-[var(--astra-text)]',
        'placeholder:text-[var(--astra-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--astra-accent)]/40',
        invalid ? 'border-[var(--astra-danger)]' : 'border-[var(--astra-border)]',
        className,
      )}
    />
  );
}

/** 下拉选择框属性。 */
export interface SelectProps extends ComponentPropsWithRef<'select'> {
  /** 是否处于校验失败态。 */
  invalid?: boolean;
}

/**
 * 下拉选择框。
 *
 * @param props 见 {@link SelectProps}。
 * @returns 选择框元素。
 */
export function Select({ className, invalid, ref, children, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(
        'w-full rounded-md border bg-[var(--astra-surface)] px-2.5 py-1.5 text-sm text-[var(--astra-text)]',
        'focus:outline-none focus:ring-2 focus:ring-[var(--astra-accent)]/40',
        invalid ? 'border-[var(--astra-danger)]' : 'border-[var(--astra-border)]',
        className,
      )}
    >
      {children}
    </select>
  );
}