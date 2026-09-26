import clsx from 'clsx';
import { memo, useState } from 'react';
import { Markdown } from './Markdown';
import { ReasoningPanel } from './ReasoningPanel';
import { IconWarning, Spinner } from '../ui/index';
import type { Message } from '../../types/index';

/**
 * 单条消息气泡。
 *
 * 视觉规则：用户消息靠右、使用强调色实心气泡；assistant 消息靠左、使用表面色气泡
 * （Markdown 正文在浅色卡片上更好读）。
 */

/** `MessageBubble` 组件属性。 */
export interface MessageBubbleProps {
  /** 消息实体。 */
  message: Message;
}

/**
 * 生成气泡时间戳文案。
 *
 * @param timestamp Unix 毫秒。
 * @returns `HH:mm` 形式的字符串。
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 渲染一条消息气泡。
 *
 * @param props 见 {@link MessageBubbleProps}。
 * @returns 气泡元素。
 */
export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isStreaming = message.status === 'streaming';
  const isError = message.status === 'error';
  const isAborted = message.status === 'aborted';

  /**
   * 复制本条消息正文。
   */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  /** 等待首字时显示「思考中」，有内容后改为追加光标。 */
  const showWaiting = isStreaming && !message.content;
  const showCaret = isStreaming && Boolean(message.content);

  return (
    <div
      className={clsx(
        'group/bubble flex w-full gap-2.5',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      <div
        aria-hidden
        className={clsx(
          'mt-0.5 flex size-7 shrink-0 select-none items-center justify-center rounded-full text-xs font-semibold',
          isUser
            ? 'bg-[var(--astra-accent-soft)] text-[var(--astra-accent)]'
            : 'bg-[var(--astra-surface-2)] text-[var(--astra-text)]',
        )}
      >
        {isUser ? '我' : 'AI'}
      </div>

      <div className={clsx('flex min-w-0 max-w-[min(46rem,82%)] flex-col', isUser ? 'items-end' : 'items-start')}>
        {!isUser && message.reasoning ? (
          <ReasoningPanel reasoning={message.reasoning} streaming={isStreaming} className="w-full" />
        ) : null}

        <div
          className={clsx(
            'w-full rounded-xl px-3.5 py-2 text-sm shadow-sm',
            isUser
              ? 'bg-[var(--astra-user-bubble)] text-[var(--astra-user-bubble-text)]'
              : 'border border-[var(--astra-border)] bg-[var(--astra-surface)] text-[var(--astra-text)]',
          )}
        >
          {isUser ? (
            // 用户消息按纯文本渲染：Markdown 会吃掉换行与星号，与输入框所见不一致。
            <p className="m-0 whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
          ) : (
            <Markdown content={message.content} className={clsx(showCaret && 'astra-caret')} />
          )}

          {showWaiting ? (
            <span className="flex items-center gap-2 text-xs text-[var(--astra-muted)]">
              <Spinner className="size-3" />
              思考中…
            </span>
          ) : null}
        </div>

        {isError ? (
          <div className="mt-1.5 flex w-full items-start gap-1.5 rounded-lg border border-[var(--astra-danger)]/40 bg-[var(--astra-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--astra-danger)]">
            <IconWarning size={13} className="mt-px shrink-0" />
            <span className="break-words">{message.error ?? '生成失败'}</span>
          </div>
        ) : null}

        {isAborted ? (
          <p className="mt-1 text-[11px] text-[var(--astra-muted)]">已停止生成</p>
        ) : null}

        {/* 操作条：流式中不显示，避免每帧重排；hover 才显形，保持界面安静。 */}
        <div
          className={clsx(
            'mt-1 flex items-center gap-2 text-[11px] text-[var(--astra-muted)]',
            isStreaming ? 'opacity-0' : 'opacity-0 transition-opacity group-hover/bubble:opacity-100',
          )}
        >
          <span>{formatTime(message.createdAt)}</span>
          {!isUser && message.model ? (
            <span className="rounded bg-[var(--astra-surface-2)] px-1.5 py-0.5">{message.model}</span>
          ) : null}
          {message.content ? (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded px-1 py-0.5 hover:bg-[var(--astra-surface-2)] hover:text-[var(--astra-text)]"
            >
              {copied ? '已复制' : '复制'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
});