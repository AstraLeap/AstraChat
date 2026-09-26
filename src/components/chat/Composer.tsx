import { useEffect, useRef, type ComponentType, type KeyboardEvent, type Ref } from 'react';
import { Button, Textarea, type TextareaProps } from '../ui/index';

/**
 * 带 `ref` 的 `Textarea` 类型别名。
 *
 * React 19 起函数组件的 `ref` 会作为普通 prop 透传（`Textarea` 内部 `...rest` 展开到
 * `<textarea>` 上），运行时没有问题；但 `TextareaProps` 的类型未声明 `ref`，直接写
 * `ref={...}` 会报 TS2322。这里只做**类型层面**的收窄，不改变任何运行时行为 ——
 * `src/components/ui/**` 归 Lead 所有，本文件不改动它。
 */
const RefTextarea = Textarea as ComponentType<TextareaProps & { ref?: Ref<HTMLTextAreaElement> }>;

/**
 * 底部输入框。
 *
 * 交互约定：Enter 发送、Shift + Enter 换行；正在流式接收时发送按钮变成「停止」，
 * 点击调用 {@link ComposerProps.onAbort}。
 */

/** `Composer` 组件属性。 */
export interface ComposerProps {
  /** 当前草稿。 */
  value: string;
  /** 草稿变化回调。 */
  onChange: (value: string) => void;
  /** 发送回调（已去除首尾空白；空内容不会触发）。 */
  onSend: () => void;
  /** 中止当前流式回复的回调。 */
  onAbort: () => void;
  /** 是否正在流式接收。 */
  streaming?: boolean;
  /** 是否整体禁用（如未选中对话、未配置提供商）。 */
  disabled?: boolean;
  /** 禁用原因，展示在输入框下方。 */
  disabledHint?: string;
  /** 发送失败等错误文案。 */
  error?: string | null;
}

/** 输入框最大高度（像素），超过后内部滚动而不继续撑高。 */
const MAX_HEIGHT = 200;

/**
 * 渲染底部输入区。
 *
 * @param props 见 {@link ComposerProps}。
 * @returns 输入区元素。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onAbort,
  streaming = false,
  disabled = false,
  disabledHint,
  error,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 随内容自适应高度：先把高度归零再按 `scrollHeight` 撑开，否则删除文字时不会缩回。
   */
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) {
      return;
    }
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  /** 流式结束后把焦点还给输入框，方便连续提问。 */
  useEffect(() => {
    if (!streaming && !disabled) {
      textareaRef.current?.focus();
    }
  }, [streaming, disabled]);

  /**
   * 键盘处理：Enter 发送，Shift + Enter 换行，Esc 中止。
   *
   * @param event 键盘事件。
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && streaming) {
      event.preventDefault();
      onAbort();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      // `isComposing` 用于避开中文输入法选词回车 —— 否则选字时会把半截拼音发出去。
      return;
    }
    event.preventDefault();
    if (streaming || disabled || !value.trim()) {
      return;
    }
    onSend();
  };

  const canSend = !disabled && !streaming && value.trim().length > 0;

  return (
    <div className="border-t border-[var(--astra-border)] bg-[var(--astra-bg)] px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border border-[var(--astra-border)] bg-[var(--astra-surface)] p-2 focus-within:ring-2 focus-within:ring-[var(--astra-accent)]/30">
          <RefTextarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={disabled ? (disabledHint ?? '当前无法发送') : '输入消息，Enter 发送，Shift + Enter 换行'}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            className="max-h-[200px] resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus:ring-0"
          />
          {streaming ? (
            <Button variant="secondary" size="md" onClick={onAbort} title="停止生成（Esc）">
              停止
            </Button>
          ) : (
            <Button variant="primary" size="md" disabled={!canSend} onClick={onSend}>
              发送
            </Button>
          )}
        </div>

        <div className="mt-1.5 flex min-h-[16px] items-center justify-between gap-2 text-[11px]">
          <span className="text-[var(--astra-danger)]">{error ?? ''}</span>
          <span className="text-[var(--astra-muted)]">
            {disabled && disabledHint ? disabledHint : 'Enter 发送 · Shift + Enter 换行'}
          </span>
        </div>
      </div>
    </div>
  );
}