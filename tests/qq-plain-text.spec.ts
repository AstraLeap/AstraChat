import { describe, expect, it } from 'vitest';
import { markdownToPlain } from '../src/services/qq/plain-text';

/**
 * Markdown → QQ 纯文本 的测试。
 *
 * 背景：QQ 不渲染 Markdown，模型输出的 `**粗体**`、`[文字](url)`、``` 代码围栏 ``` 原样发到群里
 * 会变成一堆符号。这里验证转换结果的**可读性**，尤其关注「代码块内容必须原样保留」——
 * 代码里的 `2 * 3 * 4`、`snake_case_name` 若被当成 Markdown 标记处理就会被破坏。
 */

describe('markdownToPlain：行内标记', () => {
  it('去掉粗体 / 斜体 / 删除线的标记符', () => {
    expect(markdownToPlain('**加粗**')).toBe('加粗');
    expect(markdownToPlain('*斜体*')).toBe('斜体');
    expect(markdownToPlain('***又粗又斜***')).toBe('又粗又斜');
    expect(markdownToPlain('~~删除~~')).toBe('删除');
    expect(markdownToPlain('__下划线加粗__')).toBe('下划线加粗');
  });

  it('行内代码去掉反引号但保留内容', () => {
    expect(markdownToPlain('用 `npm run dev` 启动')).toBe('用 npm run dev 启动');
  });

  it('链接转成「文字 (url)」形式，QQ 里可点', () => {
    expect(markdownToPlain('见 [官方文档](https://example.com/a)')).toBe(
      '见 官方文档 (https://example.com/a)',
    );
  });

  it('图片保留 alt 文字；alt 为空时退回 url', () => {
    expect(markdownToPlain('![架构图](https://example.com/a.png)')).toBe('架构图');
    expect(markdownToPlain('![](https://example.com/a.png)')).toBe('https://example.com/a.png');
  });
});

describe('markdownToPlain：块级标记', () => {
  it('去掉标题符号', () => {
    expect(markdownToPlain('# 一级\n## 二级\n### 三级')).toBe('一级\n二级\n三级');
  });

  it('去掉引用符号但保留内容', () => {
    expect(markdownToPlain('> 引用一句\n> 再来一句')).toBe('引用一句\n再来一句');
  });

  it('无序列表转成圆点', () => {
    expect(markdownToPlain('- 甲\n- 乙')).toBe('• 甲\n• 乙');
    expect(markdownToPlain('* 甲\n+ 乙')).toBe('• 甲\n• 乙');
  });

  it('有序列表保留序号', () => {
    expect(markdownToPlain('1. 甲\n2. 乙')).toBe('1. 甲\n2. 乙');
  });

  it('表格去掉分隔行与首尾竖线', () => {
    const md = ['| 名称 | 值 |', '| --- | --- |', '| a | 1 |'].join('\n');
    expect(markdownToPlain(md)).toBe('名称 | 值\na | 1');
  });

  it('折叠连续空行为最多一个空行', () => {
    expect(markdownToPlain('甲\n\n\n\n乙')).toBe('甲\n\n乙');
  });

  it('去掉首尾空白', () => {
    expect(markdownToPlain('\n\n  甲  \n\n')).toBe('甲');
  });
});

describe('markdownToPlain：代码块必须原样保留（关键）', () => {
  it('围栏被去掉，但代码内容一字不改', () => {
    const md = ['```ts', 'const a = 2 * 3 * 4;', '```'].join('\n');
    expect(markdownToPlain(md)).toBe('const a = 2 * 3 * 4;');
  });

  it('代码块里的下划线标识符不会被当成 Markdown 斜体', () => {
    const md = ['```python', 'snake_case_name = _private * __dunder__', '```'].join('\n');
    expect(markdownToPlain(md)).toBe('snake_case_name = _private * __dunder__');
  });

  it('代码块里的星号乘法不会被吞掉', () => {
    const md = ['```c', 'int x = a * b * c;', '```'].join('\n');
    expect(markdownToPlain(md)).toBe('int x = a * b * c;');
  });

  it('代码块里的 Markdown 语法与链接保持原样', () => {
    const md = ['```md', '**不该变粗**  [不该变链接](http://x)', '```'].join('\n');
    expect(markdownToPlain(md)).toBe('**不该变粗**  [不该变链接](http://x)');
  });

  it('行内代码里的星号同样不被处理', () => {
    expect(markdownToPlain('结果是 `a * b` 这样')).toBe('结果是 a * b 这样');
  });

  it('代码块与普通文本混排时互不干扰', () => {
    const md = ['**结论**', '', '```js', 'const r = a * b;', '```', '', '结束'].join('\n');
    expect(markdownToPlain(md)).toBe('结论\n\nconst r = a * b;\n\n结束');
  });

  it('支持多个代码块', () => {
    const md = ['```', 'x * y', '```', '', '```', 'p * q', '```'].join('\n');
    expect(markdownToPlain(md)).toBe('x * y\n\np * q');
  });

  it('无语言标记的围栏同样处理', () => {
    expect(markdownToPlain('```\nplain\n```')).toBe('plain');
  });
});

describe('markdownToPlain：边界情况', () => {
  it('非字符串输入按空串处理', () => {
    expect(markdownToPlain('')).toBe('');
  });

  it('纯文本原样返回', () => {
    expect(markdownToPlain('就是一句普通的话，没有任何标记。')).toBe('就是一句普通的话，没有任何标记。');
  });

  it('未闭合的代码围栏不会丢内容', () => {
    expect(markdownToPlain('```ts\nconst a = 1;')).toBe('const a = 1;');
  });

  it('中文与 emoji 不受影响', () => {
    expect(markdownToPlain('**星辰跃动** 🚀 出发')).toBe('星辰跃动 🚀 出发');
  });

  it('单个星号（乘号）在普通文本里不被误删', () => {
    // 只有成对的标记符才应被去掉；孤立的 * 是正常字符
    expect(markdownToPlain('3 * 4 = 12')).toBe('3 * 4 = 12');
  });
});
