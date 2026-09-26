/**
 * 敏感字段（API Key / AppSecret / Token）的展示辅助。
 *
 * 安全约定：这些值**只能**以掩码形式出现在列表、概览等非输入场景；不允许 `console.log`
 * 明文（调试时用 {@link maskSecret} 打印）。
 */

/** 完全未设置时的占位文案。 */
const UNSET_TEXT = '未设置';

/**
 * 把敏感值转成可安全展示的掩码，形如 `sk-…abcd`。
 *
 * 长度不足 9 的短串一律整体打码：短串保留首尾几乎等于泄露。
 *
 * @param value 原始敏感值；允许 `null` / `undefined`。
 * @returns 掩码文案；未设置时返回「未设置」。
 */
export function maskSecret(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) {
    return UNSET_TEXT;
  }
  if (raw.length < 9) {
    return '•'.repeat(raw.length);
  }
  return `${raw.slice(0, 3)}…${raw.slice(-4)}`;
}

/**
 * 判断敏感值是否已设置（用于「已配置 / 未配置」徽章）。
 *
 * @param value 原始敏感值。
 * @returns 已设置返回 `true`。
 */
export function hasSecret(value: string | null | undefined): boolean {
  return ((value ?? '').trim().length > 0);
}
