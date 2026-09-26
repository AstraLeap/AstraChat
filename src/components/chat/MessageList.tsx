import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { Button, EmptyState, IconArrowDown, IconSparkle, IconWarning, LoadingBlock } from '../ui/index';
import type { Message } from '../../types/index';

/**
 * 消息滚动区。
 *
 * 滚动策略（对应「用户手动上滚时不要强制抢滚动」这条要求）：
 * - 用一个 `stickToBottom` 标志跟随用户的滚动位置：滚动条距离底部超过
 *   {@link STICK_THRESHOLD} 就认为用户「正在回看历史」，此后新内容只提示、不抢滚动。
 * - 用户滚回底部（或点「回到底部」）后重新贴底。
 * - 距离底部的判断带一个容差，因为 `scrollTop` 是整数而 `scrollHeight - clientHeight`
 *   可能是小数，严格相等会导致刚滚到底就被判成「已离开底部」。
 */

/** 判定「仍贴底」的容差（像素）。 */
const STICK_THRESHOLD = 48;

/** `MessageList` 组件属性。 */
export interface MessageListProps {
  /** 要展示的消息（已按时间正序）。 */
  messages: Message[];
  /** 是否正在加载历史消息。 */
  loading?: boolean;
  /** 加载失败时的错误文案。 */
  error?: string | null;
  /** 重试加载的回调。 */
  onRetry?: () => void;
  /**
   * 每条消息正在接收的流式增量。
   *
   * 传这个值而不是让本组件订阅 store，是因为滚动组件只关心「内容变长了要贴底」，
   * 不关心增量内容本身。
   */
  streamTick?: string | null;
}

/**
 * 渲染消息列表并管理自动滚动。
 *
 * @param props 见 {@link MessageListProps}。
 * @returns 滚动容器；无消息时展示空态。
 */
export function MessageList({ messages, loading = false, error, onRetry, streamTick }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  /**
   * 记录用户是否还想贴底。
   *
   * 用 ref 保存一份「当前值」而不是只依赖 state：`useEffect` 里读取 state 会是上一次
   * 渲染的闭包值，流式高频渲染时容易读到过期结果。
   */
  const stickRef = useRef(true);

  /** 滚动到底部。 */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior });
    stickRef.current = true;
    setStickToBottom(true);
    setShowJumpButton(false);
  }, []);

  /**
   * 监听滚动：更新「是否贴底」以及「是否显示回到底部按钮」。
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }

    /** 根据当前滚动位置刷新状态。 */
    const handleScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const atBottom = distance <= STICK_THRESHOLD;
      stickRef.current = atBottom;
      setStickToBottom(atBottom);
      setShowJumpButton(!atBottom);
    };

    node.addEventListener('scroll', handleScroll, { passive: true });
    return () => node.removeEventListener('scroll', handleScroll);
  }, []);

  /**
   * 内容变化后按需贴底。
   *
   * 依赖里包含 `messages.length` 与 `streamTick`：前者覆盖「新消息」，
   * 后者覆盖「同一条消息的流式增长」。只有用户仍处于贴底状态才真正滚动。
   */
  useEffect(() => {
    if (!stickRef.current) {
      return;
    }
    // 等 DOM 高度更新完再滚，否则会停在旧高度上。
    const frame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) {
        node.scrollTop = node.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, streamTick]);

  /** 首次挂载 / 切换对话（消息整体替换）时无条件贴底。 */
  useEffect(() => {
    stickRef.current = true;
    setStickToBottom(true);
    setShowJumpButton(false);
    const frame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) {
        node.scrollTop = node.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages[0]?.conversationId]);

  if (loading && messages.length === 0) {
    return <LoadingBlock text="正在加载消息…" />;
  }

  if (error && messages.length === 0) {
    return (
      <EmptyState
        icon={<IconWarning size={32} />}
        title="消息加载失败"
        description={error}
        action={
          onRetry ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              重试
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (messages.length === 0) {
    return (
      <EmptyState
        icon={<IconSparkle size={32} />}
        title="开始新的对话吧"
        description="在下方输入框里说出你的问题，Enter 发送，Shift + Enter 换行。"
      />
    );
  }

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      </div>

      {showJumpButton && !stickToBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--astra-border)] bg-[var(--astra-surface)] px-3 py-1 text-xs text-[var(--astra-text)] shadow-md hover:bg-[var(--astra-surface-2)]"
        >
          <IconArrowDown size={12} />
          回到底部
        </button>
      ) : null}
    </div>
  );
}