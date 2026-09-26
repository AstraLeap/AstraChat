import clsx from 'clsx';
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * Markdown 渲染组件。
 *
 * 插件链：`remark-gfm`（表格 / 删除线 / 任务列表）+ `rehype-highlight`（代码高亮，
 * 主题 CSS 由 `src/styles.css` 引入）。
 *
 * 排版样式一律由全局类 `.astra-markdown` 提供（定义在 `src/styles.css`），本组件
 * **不**重复定义段落/标题/表格的样式，避免两套排版规则互相打架。
 */

/** `Markdown` 组件属性。 */
export interface MarkdownProps {
  /** Markdown 源文本。 */
  content: string;
  /** 附加类名（追加在 `astra-markdown` 之后）。 */
  className?: string;
}

/**
 * 从 `pre > code` 的类名中提取语言标识。
 *
 * `rehype-highlight` 会写成 `hljs language-ts`，因此取 `language-` 前缀的那一段。
 *
 * @param className 代码元素上的类名。
 * @returns 语言名（如 `ts`），未标注语言时返回空串。
 */
function extractLanguage(className: unknown): string {
  if (typeof className !== 'string') {
    return '';
  }
  const match = /language-([\w+#-]+)/.exec(className);
  return match?.[1] ?? '';
}

/**
 * 把 React 节点树还原成纯文本（用于「复制代码」）。
 *
 * `rehype-highlight` 会把代码切成大量 `<span>`，因此必须递归取文本，不能只读
 * `children` 的第一层。
 *
 * @param node React 节点。
 * @returns 拼接后的纯文本。
 */
function toPlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(toPlainText).join('');
  }
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return toPlainText(props?.children);
  }
  return '';
}

/** 代码块：语言标签 + 复制按钮 + 高亮后的代码。 */
function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  /**
   * 复制代码到剪贴板。
   *
   * `navigator.clipboard` 在 `file://` 协议下可能不可用，因此保留了
   * `document.execCommand('copy')` 的兜底路径。
   */
  const handleCopy = async () => {
    const text = toPlainText(children);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-[var(--astra-border)] bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-white/50">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded px-1.5 py-0.5 text-[11px] text-white/60 transition-colors hover:bg-white/10 hover:text-white/90"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto text-[12.5px] leading-[1.55]">{children}</pre>
    </div>
  );
}

/** `react-markdown` 的组件映射；稳定引用可避免每次渲染重建组件树。 */
const COMPONENTS: Components = {
  /**
   * 拦截 `pre`：把「语言标签 + 复制按钮」的容器包在代码块外面。
   *
   * @param props `pre` 元素属性。
   * @returns 自定义代码块外壳。
   */
  pre({ children }) {
    const codeElement = Array.isArray(children) ? children[0] : children;
    const codeProps =
      codeElement && typeof codeElement === 'object' && 'props' in codeElement
        ? (codeElement as { props?: { className?: unknown } }).props
        : undefined;
    return <CodeBlock language={extractLanguage(codeProps?.className)}>{children}</CodeBlock>;
  },
  /**
   * 链接统一在新窗口打开（Electron 里由主进程的 `setWindowOpenHandler` 接管）。
   *
   * @param props `a` 元素属性。
   * @returns 链接元素。
   */
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

/**
 * 渲染 Markdown 正文。
 *
 * 用 `memo` 包裹：流式追加时只有最后一条气泡的内容在变，历史消息不必重解析
 * （Markdown 解析 + 高亮是这里最贵的一步）。
 *
 * @param props 见 {@link MarkdownProps}。
 * @returns 渲染后的 Markdown 容器。
 */
export const Markdown = memo(function Markdown({ content, className }: MarkdownProps) {
  return (
    <div className={clsx('astra-markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});