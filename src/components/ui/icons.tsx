import type { ReactNode } from 'react';

/**
 * 应用内图标库：一组**内联 SVG** 线性图标。
 *
 * 为什么不用 emoji（这是本文件的立项理由）：
 * 1. Windows 上 emoji 由 **Segoe UI Emoji 彩色字体**渲染，它天然**忽略 `currentColor`** ——
 *    所以 hover / 选中态 / `--astra-accent` 靛蓝紫配色对它们完全无效，气泡 emoji 永远
 *    显示自己那套彩色（这也是本文件刻意不出现任何 emoji 字面量的原因，方便用 grep 审计）。
 * 2. 同一 emoji 在 Windows / macOS / Linux 与不同 Chromium 版本下字形不同，界面跨平台不一致。
 * 3. emoji 的基线不受控，跟文字对不齐，`size` 也就失去意义。
 * 4. 无法统一 `stroke-width`，做不出统一的线性图标语言。
 *
 * 为什么用**内联组件**而不是 `.svg` 文件：
 * - 不需要任何 Vite 插件或 loader；
 * - 用 `currentColor` 描边，颜色由外层的 `text-*` 工具类决定，**hover 与选中态免费**；
 *   （`.svg` 文件做不到这一点，除非再引入 svgr 之类的 loader）
 * - 随组件一起 tree-shake，没有额外网络请求；
 * - 矢量，任意 DPI 都锐利。
 *
 * 设计规范：24×24 网格，内容控制在 2–21 之间留出安全边距；`stroke-width` 统一 1.75；
 * 圆角端点与圆角连接（`round`），保证 16px 下不出现尖刺。
 */

/** 所有图标组件共用的属性。 */
export interface IconProps {
  /** 边长（px），默认 16。图标是正方形。 */
  size?: number;
  /**
   * 附加类名。
   *
   * **颜色请通过 `text-*` 指定**，图标用 `currentColor` 描边，例如
   * `className="text-[var(--astra-accent)]"`。
   */
  className?: string;
  /**
   * 无障碍名称。
   *
   * 提供时图标被视作**有语义**（`role="img"` + `<title>`）；省略时视为纯装饰
   * （`aria-hidden`），此时可访问名称应由相邻的文字或按钮的 `aria-label` 提供。
   */
  title?: string;
}

/** 内部通用外壳：统一 viewBox、描边风格与无障碍属性。 */
interface IconShellProps extends IconProps {
  /** 图标路径内容。 */
  children: ReactNode;
}

/**
 * 图标外壳。所有图标都经此渲染，保证风格完全一致。
 *
 * @param props 见 {@link IconShellProps}。
 * @returns SVG 元素。
 */
function IconShell({ size = 16, className, title, children }: IconShellProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/**
 * 对话气泡（左下带尾巴）。用于侧栏「聊天」。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconChat(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M20 12.5A2.5 2.5 0 0 1 17.5 15H8.5L4 19V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5Z" />
    </IconShell>
  );
}

/**
 * 带三个点的对话气泡。用于设置页的「QQ bot」分区，与纯气泡的「聊天」区分开。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconChatDots(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M20 12.5A2.5 2.5 0 0 1 17.5 15H8.5L4 19V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5Z" />
      <path d="M8.6 9.6h.01M12 9.6h.01M15.4 9.6h.01" strokeWidth={2.4} />
    </IconShell>
  );
}

/**
 * 人物剪影（头 + 肩）。用于侧栏「角色」。
 *
 * 说明：原本打算用「戏剧面具」表达角色，但面具的双层轮廓在 16px 下会糊成一团，
 * 人物剪影语义同样准确（角色 = 身份）且任何尺寸都清晰，故采用后者。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconUser(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5.4 19.6a6.6 6.6 0 0 1 13.2 0" />
    </IconShell>
  );
}

/**
 * 齿轮。用于侧栏「设置」。
 *
 * 齿形不是手写的，而是用脚本按齿数/齿顶/齿根角度算出来的（8 齿，周期 45°，
 * 齿顶 18°、齿根谷 19°，节圆上齿宽 ≈2.54u、齿槽 ≈2.69u 近似相等 —— 这才是齿轮的比例）。
 * 第一版手写成了「圆环 + 8 根细辐条」，15px 下看起来像船舵/太阳，故重做。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconSettings(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M10.52 5.57 10.5 2.52 13.5 2.52 13.48 5.57 15.5 6.4 17.64 4.23 19.77 6.36 17.6 8.5 18.43 10.52 21.48 10.5 21.48 13.5 18.43 13.48 17.6 15.5 19.77 17.64 17.64 19.77 15.5 17.6 13.48 18.43 13.5 21.48 10.5 21.48 10.52 18.43 8.5 17.6 6.36 19.77 4.23 17.64 6.4 15.5 5.57 13.48 2.52 13.5 2.52 10.5 5.57 10.52 6.4 8.5 4.23 6.36 6.36 4.23 8.5 6.4Z" />
      <circle cx="12" cy="12" r="3.1" />
    </IconShell>
  );
}

/**
 * 插头。用于设置页「模型提供商」分区。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconPlug(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M9 3.2v5.3M15 3.2v5.3" />
      <path d="M6.2 8.5h11.6v2.6a5.8 5.8 0 0 1-11.6 0Z" />
      <path d="M12 16.9V20.8" />
    </IconShell>
  );
}

/**
 * 信息。用于设置页「关于」分区。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconInfo(props: IconProps) {
  return (
    <IconShell {...props}>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 11.2v5.4" />
      <path d="M12 7.7h.01" strokeWidth={2.4} />
    </IconShell>
  );
}

/**
 * 四角星芒。用于空态与 AI 相关位置，造型呼应应用图标里的星尾。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconSparkle(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M12 4.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5Z" />
    </IconShell>
  );
}

/**
 * 警告三角。用于空态提示、消息错误条、启动失败页与错误边界。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconWarning(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M12 4.2a1.7 1.7 0 0 1 1.5.9l7.2 12.6a1.7 1.7 0 0 1-1.5 2.6H4.8a1.7 1.7 0 0 1-1.5-2.6l7.2-12.6a1.7 1.7 0 0 1 1.5-.9Z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.3h.01" strokeWidth={2.4} />
    </IconShell>
  );
}

/**
 * 垃圾桶。用于删除对话。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconTrash(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M3.8 7h16.4" />
      <path d="M9.6 7V5.5A1.5 1.5 0 0 1 11.1 4h1.8a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.3 7l.9 12.1A2 2 0 0 0 9.2 21h5.6a2 2 0 0 0 2-1.9L17.7 7" />
      <path d="M10.2 10.6v6.6M13.8 10.6v6.6" />
    </IconShell>
  );
}

/**
 * 铅笔。用于重命名对话。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconPencil(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M5 19l1-4 9.5-9.5a2.1 2.1 0 0 1 3 3L9 18Z" />
      <path d="M13.6 6.4l4 4" />
    </IconShell>
  );
}

/**
 * 关闭 / 清除（叉）。用于弹窗关闭、搜索清空、删除群号。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconX(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />
    </IconShell>
  );
}

/**
 * 向下箭头。用于「回到底部」。
 *
 * @param props 见 {@link IconProps}。
 * @returns 图标元素。
 */
export function IconArrowDown(props: IconProps) {
  return (
    <IconShell {...props}>
      <path d="M12 4.8v14.4" />
      <path d="M6.4 13.6 12 19.2l5.6-5.6" />
    </IconShell>
  );
}
