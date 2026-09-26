/**
 * 按长度切分文本，保证**不切坏 UTF-16 代理对**。
 *
 * 为什么需要这个模块：QQ 单条消息有长度上限（群消息一般 ≤ 4500 字，这里默认留到 4000），
 * 超长回复必须分条发送。但 emoji、生僻汉字（CJK 扩展 B 区及以上）在 UTF-16 里占**两个码元**，
 * 若直接按 `slice(0, max)` 硬切，正好落在中间时会产生**落单的代理码元** ——
 * 在 QQ 上显示成 `�`，而且拼接回去已经与原文字节不同了。
 *
 * 本模块由 `tests/qq-split-text.spec.ts` 用两条不变量兜住：
 * 1. `parts.join('') === 原文`（一字不多一字不少）；
 * 2. 任何一段都不含落单代理码元。
 */

/** 默认单条长度上限（码元数）。群消息一般 ≤ 4500 字，留出余量。 */
const DEFAULT_MAX = 4000;

/**
 * 规范化长度上限。
 *
 * 非法值（`<= 0`、`NaN`、`Infinity`）一律回退到 {@link DEFAULT_MAX}，避免出现
 * 「上限为 0 导致死循环」或「上限为 Infinity 导致不切分」这两种坏情况。
 *
 * @param max 调用方传入的上限。
 * @returns 合法的正整数上限。
 */
function normalizeMax(max: number | undefined): number {
  return typeof max === 'number' && Number.isFinite(max) && max >= 1
    ? Math.floor(max)
    : DEFAULT_MAX;
}

/**
 * 判断指定下标处的码元是否是「高代理码元」（代理对的前半）。
 *
 * @param text 源文本。
 * @param index 下标。
 * @returns 是高代理码元返回 `true`。
 */
function isHighSurrogateAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return false;
  }
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 判断从 0 开始是否是一个完整的代理对。
 *
 * @param text 源文本。
 * @returns 前两个码元构成一个代理对返回 `true`。
 */
function startsWithSurrogatePair(text: string): boolean {
  const first = text.charCodeAt(0);
  const second = text.charCodeAt(1);
  return (
    first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
  );
}

/**
 * 把文本切成若干段，每段不超过 `max` 个码元，且不破坏代理对。
 *
 * 切分策略：
 * - 优先在 `max` 之前**最后一个换行处**切，换行符归属**前一段**（这样分条后语义连贯，
 *   不会出现「上一段缺个换行、下一段以空行开头」）；
 * - 找不到换行时硬切；
 * - 若切点正好落在代理对中间，把切点**前移一个码元**；
 * - 有「至少推进一个完整字符」的兜底，杜绝零进度死循环。
 *
 * @param text 待切分文本。
 * @param max 每段最大码元数，默认 4000；非法值回退到默认值。
 * @returns 切分后的段落数组；输入为空串时返回**空数组**（表示没有要发送的内容）。
 */
export function splitForQQ(text: string, max?: number): string[] {
  const source = typeof text === 'string' ? text : '';
  if (source.length === 0) {
    return [];
  }

  const limit = normalizeMax(max);
  if (source.length <= limit) {
    return [source];
  }

  const parts: string[] = [];
  let rest = source;

  while (rest.length > limit) {
    // 优先在换行处切；lastIndexOf 的 fromIndex 取 limit-1，保证切点不越过上限。
    const newlineAt = rest.lastIndexOf('\n', limit - 1);
    let cut: number;
    let keepNewline: number;

    if (newlineAt > 0) {
      cut = newlineAt;
      keepNewline = 1; // 换行归前一段
    } else {
      cut = limit;
      keepNewline = 0;
    }

    // 切点落在代理对中间（前一个码元是高代理）→ 前移一位。
    if (isHighSurrogateAt(rest, cut - 1)) {
      cut -= 1;
    }

    // 兜底：确保至少推进一个完整字符，否则会死循环。
    if (cut <= 0) {
      cut = startsWithSurrogatePair(rest) ? 2 : 1;
      keepNewline = 0;
    }

    parts.push(rest.slice(0, cut + keepNewline));
    rest = rest.slice(cut + keepNewline);
  }

  if (rest.length > 0) {
    parts.push(rest);
  }

  return parts;
}
