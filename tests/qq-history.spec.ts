import { describe, expect, it } from 'vitest';
import { createQqHistory, type HistoryEntry } from '../src/services/qq/history';

/**
 * 对话历史的测试。
 *
 * 这块的价值全在**边界**上：隔离有没有破、裁剪会不会把该留的丢掉、
 * 单条超长消息是丢还是截、来源数会不会无界增长。正常路径反而是最不重要的。
 */

/** 造一条历史。 */
function entry(text: string, speaker = '小明', fromBot = false): HistoryEntry {
  return { speaker, text, fromBot };
}

const LIMITS = { maxEntries: 3, maxChars: 100, maxSources: 2 };

describe('基本读写', () => {
  it('追加后能按最旧在前的顺序取回', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('第一句'));
    history.append('group:A', entry('第二句'));

    expect(history.list('group:A').map((item) => item.text)).toEqual(['第一句', '第二句']);
  });

  it('没有历史的来源返回空数组', () => {
    expect(createQqHistory(LIMITS).list('group:NEVER')).toEqual([]);
  });

  it('返回的是副本，外部改动不影响内部', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('原句'));

    const list = history.list('group:A');
    list[0]!.text = '被改了';

    expect(history.list('group:A')[0]?.text).toBe('原句');
  });

  it('clear 清掉一个来源', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('x'));
    history.clear('group:A');

    expect(history.list('group:A')).toEqual([]);
    expect(history.size()).toBe(0);
  });

  it('空键被忽略（不能造出一个「没有来源」的历史）', () => {
    const history = createQqHistory(LIMITS);
    history.append('', entry('x'));
    expect(history.size()).toBe(0);
  });
});

describe('来源隔离（隐私底线）', () => {
  it('两个群的历史互不可见', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('A 群的秘密'));
    history.append('group:B', entry('B 群的秘密'));

    expect(history.list('group:A').map((item) => item.text)).toEqual(['A 群的秘密']);
    expect(history.list('group:B').map((item) => item.text)).toEqual(['B 群的秘密']);
  });

  it('群与私聊即使 openid 相同也互不可见', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:X', entry('群里的'));
    history.append('private:X', entry('私聊的'));

    expect(history.list('group:X').map((item) => item.text)).toEqual(['群里的']);
    expect(history.list('private:X').map((item) => item.text)).toEqual(['私聊的']);
  });

  it('clear 只影响指定来源', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('a'));
    history.append('group:B', entry('b'));
    history.clear('group:A');

    expect(history.list('group:A')).toEqual([]);
    expect(history.list('group:B')).toHaveLength(1);
  });
});

describe('按条数裁剪', () => {
  it('超过条数上限时丢最旧的', () => {
    const history = createQqHistory(LIMITS);
    for (const text of ['1', '2', '3', '4', '5']) {
      history.append('group:A', entry(text));
    }

    expect(history.list('group:A').map((item) => item.text)).toEqual(['3', '4', '5']);
  });
});

describe('按字符数裁剪', () => {
  it('超过字符上限时从最旧的丢', () => {
    const history = createQqHistory({ maxEntries: 100, maxChars: 10, maxSources: 2 });
    history.append('group:A', entry('12345'));
    history.append('group:A', entry('67890'));
    history.append('group:A', entry('abcde'));

    const texts = history.list('group:A').map((item) => item.text);
    expect(texts).toEqual(['67890', 'abcde']);
    expect(history.charCount('group:A')).toBeLessThanOrEqual(10);
  });

  it('【关键】单条超长消息被截断而不是整条丢弃', () => {
    // 丢掉的后果是历史里永远缺这一条，模型会以为「刚才没人说话」
    const history = createQqHistory({ maxEntries: 5, maxChars: 10, maxSources: 2 });
    history.append('group:A', entry('x'.repeat(50)));

    const list = history.list('group:A');
    expect(list).toHaveLength(1);
    expect(list[0]?.text).toHaveLength(10);
  });

  it('始终保留至少一条（不能裁成空的）', () => {
    const history = createQqHistory({ maxEntries: 5, maxChars: 1, maxSources: 2 });
    history.append('group:A', entry('abc'));
    history.append('group:A', entry('def'));

    expect(history.list('group:A').length).toBeGreaterThanOrEqual(1);
  });
});

describe('来源数上限（防内存无界增长）', () => {
  it('超过上限时淘汰最久未用的来源', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('a'));
    history.append('group:B', entry('b'));
    history.append('group:C', entry('c'));

    expect(history.size()).toBe(2);
    // A 最久未用，被淘汰
    expect(history.list('group:A')).toEqual([]);
    expect(history.list('group:B')).toHaveLength(1);
    expect(history.list('group:C')).toHaveLength(1);
  });

  it('读取会让来源变「最近使用」，不再被优先淘汰', () => {
    const history = createQqHistory(LIMITS);
    history.append('group:A', entry('a'));
    history.append('group:B', entry('b'));
    // 读一下 A，把它变成最近使用
    history.list('group:A');
    history.append('group:C', entry('c'));

    expect(history.list('group:A')).toHaveLength(1);
    // 这次该淘汰 B
    expect(history.list('group:B')).toEqual([]);
  });
});

describe('参数容错', () => {
  it('非法上限被夹到至少 1', () => {
    const history = createQqHistory({ maxEntries: 0, maxChars: 0, maxSources: 0 });
    history.append('group:A', entry('x'));
    history.append('group:B', entry('y'));

    expect(history.size()).toBe(1);
    expect(history.list('group:B')).toHaveLength(1);
  });
});
