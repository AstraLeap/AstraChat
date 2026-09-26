import { describe, expect, it } from 'vitest';
import { splitForQQ } from '../src/services/qq/split-text';

/**
 * 按长度安全切分的测试。
 *
 * 两条不变量是重点：
 * 1. **无损坏**：`parts.join('') === 原文`（一字不多一字不少）。
 * 2. **不切坏代理对**：任何一段都不能含「落单的代理码元」，否则 QQ 上会显示成 �。
 *
 * emoji / 生僻汉字都是 UTF-16 代理对（占 2 个码元），所以「按码元数切」必然会切坏它们，
 * 这正是这个模块存在的理由。
 */

/**
 * 判断字符串里是否存在落单（未配对）的代理码元。
 *
 * @param s 待检查字符串。
 * @returns 存在落单代理码元返回 `true`。
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++; // 跳过配对的低位
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // 低位出现在没有高位的地方
    }
  }
  return false;
}

/** 一组包含 emoji / CJK / 混排的素材，用于不变量检查。 */
const SAMPLES: string[] = [
  '',
  'a',
  'abc',
  '中文测试内容',
  '😀',
  '😀😀😀😀😀',
  'a😀b😀c😀d',
  '混排 😀 与中文 🇨🇳 国旗 还有 👨‍👩‍👧‍👦 家庭',
  '带\n换行\n的\n内容',
  'a'.repeat(100) + '😀' + 'b'.repeat(100),
  '𠀋', // 生僻汉字（单个代理对）
  '末尾是 emoji 😀',
  '😀开头',
];

describe('splitForQQ：不变量', () => {
  it('任何输入与任何 max 下，拼接结果都等于原文', () => {
    for (const sample of SAMPLES) {
      for (const max of [1, 2, 3, 4, 5, 7, 16, 64, 4000]) {
        const parts = splitForQQ(sample, max);
        expect(parts.join(''), `sample=${JSON.stringify(sample)} max=${max}`).toBe(sample);
      }
    }
  });

  it('任何输入与任何 max 下，都不产生落单的代理码元', () => {
    for (const sample of SAMPLES) {
      for (const max of [1, 2, 3, 4, 5, 7, 16, 64, 4000]) {
        for (const part of splitForQQ(sample, max)) {
          expect(hasLoneSurrogate(part), `sample=${JSON.stringify(sample)} max=${max} part=${JSON.stringify(part)}`).toBe(false);
        }
      }
    }
  });

  it('除最后一段外，每段长度都不超过 max（按码元数）', () => {
    const text = 'a'.repeat(50);
    for (const max of [1, 3, 7, 10, 49, 50, 51]) {
      const parts = splitForQQ(text, max);
      for (let i = 0; i < parts.length - 1; i++) {
        expect(parts[i]!.length).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe('splitForQQ：基本行为', () => {
  it('空串返回空数组（没有要发的内容）', () => {
    expect(splitForQQ('', 10)).toEqual([]);
  });

  it('短于上限时不切分', () => {
    expect(splitForQQ('abc', 10)).toEqual(['abc']);
  });

  it('长度恰好等于上限时不切分', () => {
    expect(splitForQQ('abcd', 4)).toEqual(['abcd']);
  });

  it('超长时按上限切分', () => {
    expect(splitForQQ('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('优先在换行处切，且换行归属前一段', () => {
    // 在 max=6 之前最后一个换行在第 3 位 → 第一段为 'abc\n'（含换行，4 个码元）；
    // 剩下的 'defghij' 有 7 个码元仍超限，继续硬切成 'defghi' + 'j'。
    expect(splitForQQ('abc\ndefghij', 6)).toEqual(['abc\n', 'defghi', 'j']);
  });

  it('单个字符也能切（max=1）', () => {
    expect(splitForQQ('abc', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitForQQ：代理对安全（核心）', () => {
  it('切点落在 emoji 中间时前移，不把 emoji 劈开', () => {
    // 'ab😀cd' 的码元：a b [D83D DE00] c d = 6 个；max=3 会正落在 emoji 中间，
    // 前移一位后第一段是 'ab'，剩下的 '😀cd'（4 个码元）仍超限需继续切。
    expect(splitForQQ('ab😀cd', 3)).toEqual(['ab', '😀c', 'd']);
  });

  it('开头就是 emoji 且 max=1 时不死循环，且至少推进一个完整字符', () => {
    const parts = splitForQQ('😀😀', 1);
    expect(parts.join('')).toBe('😀😀');
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.length > 0)).toBe(true);
  });

  it('全是 emoji 时按完整字符切分', () => {
    expect(splitForQQ('😀😀😀', 2)).toEqual(['😀', '😀', '😀']);
  });

  it('生僻汉字（单个代理对）不会被切坏', () => {
    const parts = splitForQQ('𠀋𠀋', 1);
    expect(parts.join('')).toBe('𠀋𠀋');
    expect(parts).toEqual(['𠀋', '𠀋']);
  });

  it('ZWJ 家庭 emoji 在按码元硬切时会断开，但拼接仍完整（不产生落单代理码元）', () => {
    const family = '👨‍👩‍👧‍👦';
    const parts = splitForQQ(family + family, 3);
    expect(parts.join('')).toBe(family + family);
    for (const part of parts) {
      expect(hasLoneSurrogate(part)).toBe(false);
    }
  });
});

describe('splitForQQ：max 参数校验', () => {
  it('max 非法（0 / 负数 / NaN / Infinity）时回退到默认 4000', () => {
    const text = 'a'.repeat(5000);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const parts = splitForQQ(text, bad as number);
      expect(parts.length).toBe(2);
      expect(parts[0]!.length).toBe(4000);
      expect(parts.join('')).toBe(text);
    }
  });

  it('小数 max 向下取整', () => {
    expect(splitForQQ('abcdef', 2.9)).toEqual(['ab', 'cd', 'ef']);
  });

  it('未传 max 时使用默认 4000', () => {
    const text = 'a'.repeat(4001);
    const parts = splitForQQ(text);
    expect(parts[0]!.length).toBe(4000);
    expect(parts[1]).toBe('a');
  });
});
