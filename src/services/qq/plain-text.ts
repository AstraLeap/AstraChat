/**
 * 把模型输出的 Markdown 转成适合发到 QQ 的纯文本。
 *
 * QQ 不渲染 Markdown，直接发过去会变成一堆符号（`**加粗**`、`[文字](url)`、``` 围栏 ```）。
 * 本模块把它压成可读纯文本。
 *
 * ## 关键设计：先把代码保护起来，再做变换
 *
 * 直觉写法是「先去掉代码围栏，再全局替换 `**` `*` `_`」，但那样会**破坏代码内容** ——
 * 代码块里的 `2 * 3 * 4` 会被当成斜体标记、`snake_case_name` 会被当成下划线强调，
 * 结果发出去的代码是错的。
 *
 * 因此这里先把围栏代码块与行内代码替换成占位符（内容存进 `blocks`），所有 Markdown
 * 变换跑完之后再原样填回。`tests/qq-plain-text.spec.ts` 里有专门一组用例锁定这个行为。
 *
 * 有意的简化：
 * - **不处理单下划线斜体**（`_x_`）：`snake_case` 这类标识符在普通文本里也很常见，
 *   按单下划线判断误伤率太高，收益不值。
 * - 占位符用 `\u0000`（NUL）包裹。NUL 不是 ECMAScript 的空白字符，因此不会被
 *   `trim()` 吃掉，也不会被任何 Markdown 规则命中。
 */

/** 占位符中用于标识代码片段的前缀字符。 */
const NUL = '\u0000';

/**
 * 把围栏代码块与行内代码抽出来，替换成占位符。
 *
 * @param text 原始 Markdown。
 * @param blocks 代码内容收集数组（原地追加）。
 * @returns 代码已被占位符替换的文本。
 */
function protectCode(text: string, blocks: string[]): string {
  // 围栏代码块：`[^\n`]*` 吃掉语言标记；body 用惰性匹配；结尾允许是 ``` 或文本结束
  // （即未闭合的围栏也要能处理，否则用户会看到半截代码后面跟着一堆规则）。
  let out = text.replace(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g, (_match, body: string) => {
    const index = blocks.push(body.replace(/\n+$/, '')) - 1;
    return `${NUL}B${index}${NUL}`;
  });

  // 行内代码：不含换行的一段
  out = out.replace(/`([^`\n]+)`/g, (_match, body: string) => {
    const index = blocks.push(body) - 1;
    return `${NUL}B${index}${NUL}`;
  });

  return out;
}

/**
 * 把占位符还原成代码原文。
 *
 * @param text 已变换的文本。
 * @param blocks 代码内容数组。
 * @returns 还原后的文本。
 */
function restoreCode(text: string, blocks: string[]): string {
  return text.replace(new RegExp(`${NUL}B(\\d+)${NUL}`, 'g'), (_match, digits: string) => {
    return blocks[Number(digits)] ?? '';
  });
}

/**
 * 把 Markdown 压成 QQ 可读的纯文本。
 *
 * @param markdown 模型输出的 Markdown 文本。
 * @returns 纯文本；输入不是字符串时按空串处理。
 */
export function markdownToPlain(markdown: string): string {
  const source = typeof markdown === 'string' ? markdown : '';
  if (source.length === 0) {
    return '';
  }

  const blocks: string[] = [];
  let text = protectCode(source, blocks);

  // ---------- 块级 ----------

  // 标题：# ~ ###### 后的井号与空格
  text = text.replace(/^#{1,6}[ \t]+/gm, '');
  // 引用：行首的 "> " 或 ">"
  text = text.replace(/^>[ \t]?/gm, '');
  // 无序列表：- / * / + 转成圆点，保留缩进
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  // 表格分隔行（如 `| --- | :--: |`）整行连同换行删掉。
  // 只由 | - : 与空白构成的行才匹配，普通的 `- 文本` 列表行不会被误删。
  text = text.replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\n?/gm, '');
  // 表格首尾竖线
  text = text.replace(/^[ \t]*\|/gm, '').replace(/\|[ \t]*$/gm, '');

  // ---------- 行内 ----------

  // 图片：保留 alt，alt 为空时退回 url。必须在链接之前，否则 `![a](u)` 会先被链接规则吃掉。
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) =>
    alt || url,
  );
  // 链接：转成「文字 (url)」形式，QQ 里 url 可点
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 强调标记：从最长的开始，避免 `***x***` 被 `**` 规则切坏
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  // 斜体：限制不跨行，且必须成对
  text = text.replace(/\*([^*\n]+)\*/g, '$1');

  // ---------- 收尾 ----------

  // 逐行去首尾空白（代码块此时还是单行占位符，内部缩进不受影响）
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  // 折叠 3 个以上连续换行
  text = text.replace(/\n{3,}/g, '\n\n');

  // 还原代码
  text = restoreCode(text, blocks);

  return text.trim();
}
