import clsx from 'clsx';
import { useEffect, type ReactNode } from 'react';
import { Button } from './Button';
import { IconX } from './icons';

/**
 * 模态对话框与确认框。
 *
 * 用原生 `<dialog>` 之外的最简实现：固定定位遮罩 + 居中面板，支持 Esc 关闭与
 * 点击遮罩关闭。不做焦点陷阱（v0.1.0 的交互复杂度不需要）。
 */

/** `Modal` 组件属性。 */
export interface ModalProps {
  /** 是否显示。 */
  open: boolean;
  /** 标题。 */
  title: string;
  /** 关闭回调（Esc / 遮罩点击 / 右上角关闭按钮）。 */
  onClose: () => void;
  /** 内容。 */
  children: ReactNode;
  /** 底部操作区。 */
  footer?: ReactNode;
  /** 面板宽度类名，默认 `max-w-lg`。 */
  widthClassName?: string;
}

/**
 * 通用模态框。
 *
 * @param props 见 {@link ModalProps}。
 * @returns 模态框，或 `open` 为假时返回 `null`。
 */
export function Modal({ open, title, onClose, children, footer, widthClassName }: ModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    /** Esc 关闭。 */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-[var(--astra-border)] bg-[var(--astra-surface)] shadow-xl',
          widthClassName ?? 'max-w-lg',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--astra-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--astra-text)]">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded p-1 text-[var(--astra-muted)] hover:bg-[var(--astra-surface-2)] hover:text-[var(--astra-text)]"
          >
            <IconX size={14} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-[var(--astra-text)]">
          {children}
        </div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--astra-border)] px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** `ConfirmDialog` 组件属性。 */
export interface ConfirmDialogProps {
  /** 是否显示。 */
  open: boolean;
  /** 标题。 */
  title: string;
  /** 说明文案。 */
  message: string;
  /** 确认按钮文案，默认「确定」。 */
  confirmText?: string;
  /** 是否为危险操作（确认按钮变红），默认 `true`。 */
  danger?: boolean;
  /** 确认回调。 */
  onConfirm: () => void;
  /** 取消回调。 */
  onCancel: () => void;
}

/**
 * 二次确认对话框。
 *
 * @param props 见 {@link ConfirmDialogProps}。
 * @returns 确认框。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      widthClassName="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-[var(--astra-text)]">{message}</p>
    </Modal>
  );
}
