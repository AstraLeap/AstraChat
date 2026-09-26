import { useState } from 'react';

/**
 * 思维链（reasoning）折叠面板。
 *
 * 只有推理模型（如 DeepSeek-R1）才会返回 `reasoning`，因此调用方应先判断非空再渲染
 * 本组件。默认折叠：思维链通常很长，展开状态应由用户主动选择。
 */

/** `ReasoningPanel` 组件属性。 */
export interface ReasoningPanelProps {
  /** 思维链全文。 */
  reasoning: string;
  /**
   * 该消息是否仍在流式接收中。流式时强制展开，让用户能看到推理过程在推进；
   * 结束后回到用户自己的折叠选择。
   */
  streaming?: boolean;
  /** 附加类名。 */
  className?: string;
}

/**
 * 渲染可折叠的思维链区块。
 *
 * @param props 见 {@link ReasoningPanelProps}。
 * @returns 折叠面板元素。
 */
export function ReasoningPanel({ reasoning, streaming = false, className }: ReasoningPanelProps) {
  const [userOpen, setUserOpen] = useState(false);
  const open = streaming || userOpen;
  const text = reasoning.trim();

  if (!text) {
    return null;
  }

  return (
    <div
      className={`mb-2 overflow-hidden rounded-lg border border-[var(--astra-border)] bg-[var(--astra-surface-2)] ${className ?? ''}`}
    >
      <button
        type="button"
        onClick={() => setUserOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-[var(--astra-muted)] hover:text-[var(--astra-text)]"
      >
        <span aria-hidden className={`transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        思维链
        {streaming ? <span className="text-[10px] opacity-70">（思考中…）</span> : null}
      </button>
      {open ? (
        <div className="max-h-64 overflow-y-auto border-t border-[var(--astra-border)] px-3 py-2">
          <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-[12.5px] leading-relaxed text-[var(--astra-muted)]">
            {text}
          </pre>
        </div>
      ) : null}
    </div>
  );
}