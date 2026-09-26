import { useEffect, useState } from 'react';
import { useConversationStore } from '../../stores/useConversationStore';
import { IconX, Input, Spinner } from '../ui/index';

/**
 * 对话搜索框。
 *
 * 输入时做 250ms 防抖：搜索会走 SQLite 的 `instr()` 全表匹配，逐字符触发既浪费又
 * 会让列表闪烁。
 */

/** 防抖延迟（毫秒）。 */
const DEBOUNCE_MS = 250;

/** `ConversationSearch` 组件属性。 */
export interface ConversationSearchProps {
  /** 点击命中项时切换对话。 */
  onSelect: (conversationId: string) => void;
  /** 附加类名。 */
  className?: string;
}

/**
 * 渲染搜索输入框与命中片段列表。
 *
 * 命中结果只在有关键词时展示；清空输入即回到普通对话列表（由父组件控制渲染分支）。
 *
 * @param props 见 {@link ConversationSearchProps}。
 * @returns 搜索区元素。
 */
export function ConversationSearch({ onSelect, className }: ConversationSearchProps) {
  const keyword = useConversationStore((state) => state.keyword);
  const results = useConversationStore((state) => state.results);
  const searching = useConversationStore((state) => state.searching);
  const search = useConversationStore((state) => state.search);
  const clearSearch = useConversationStore((state) => state.clearSearch);

  const [draft, setDraft] = useState(keyword);

  /**
   * 防抖触发搜索。
   *
   * 关键词变空时立刻清空结果（不等防抖），否则用户清空输入后还会看到残留的命中项。
   */
  useEffect(() => {
    if (!draft.trim()) {
      clearSearch();
      return;
    }
    const timer = window.setTimeout(() => {
      void search(draft);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, search, clearSearch]);

  /** 外部清空关键词时同步清空输入框（例如删除当前对话后）。 */
  useEffect(() => {
    if (!keyword && draft) {
      setDraft('');
    }
    // 仅在外部关键词被清空时同步，不监听 draft 本身。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const active = Boolean(keyword.trim());

  return (
    <div className={className}>
      <div className="relative">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="搜索对话与消息…"
          aria-label="搜索对话"
          className="pr-7"
        />
        {draft ? (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => setDraft('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--astra-muted)] hover:text-[var(--astra-text)]"
          >
            <IconX size={12} />
          </button>
        ) : null}
      </div>

      {active ? (
        <div className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-[var(--astra-border)] bg-[var(--astra-surface)]">
          {searching && results.length === 0 ? (
            <div className="flex items-center gap-2 p-3 text-[11px] text-[var(--astra-muted)]">
              <Spinner className="size-3" />
              搜索中…
            </div>
          ) : null}

          {!searching && results.length === 0 ? (
            <p className="p-3 text-[11px] text-[var(--astra-muted)]">没有找到匹配的对话</p>
          ) : null}

          {results.map((hit) => (
            <button
              key={hit.conversation.id}
              type="button"
              onClick={() => onSelect(hit.conversation.id)}
              className="block w-full border-b border-[var(--astra-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--astra-surface-2)]"
            >
              <span className="block truncate text-xs font-medium text-[var(--astra-text)]">
                {hit.conversation.title}
              </span>
              {hit.snippet ? (
                <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-[var(--astra-muted)]">
                  {hit.snippet}
                </span>
              ) : null}
              <span className="mt-0.5 block text-[10px] text-[var(--astra-muted)]">
                {hit.matchedMessageIds.length} 条消息命中 · 共 {hit.conversation.messageCount} 条
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}