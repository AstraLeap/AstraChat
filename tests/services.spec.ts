/**
 * `src/services/**` 的单元测试。
 *
 * 全部测试运行在纯 Node 环境（见 `vitest.config.ts`），不依赖 Electron 运行时：
 * 主进程可用的全局 `fetch` / `ReadableStream` / `Response` / `TextDecoder` 在 Node 22+
 * 同样存在，因此可以真实地驱动「fetch + ReadableStream 解析 SSE」这条代码路径。
 */

import { describe, expect, it } from 'vitest';

import { ChatApiError, normalizeError } from '../src/services/errors';
import { PROVIDER_PRESETS } from '../src/services/presets';
import { createSseParser, type SseEvent } from '../src/services/sse';
import type { ProviderPreset } from '../src/types/index';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/**
 * 创建一个带事件收集能力的 SSE 解析器包装。
 *
 * @returns `parser` 原始解析器、`events` 已解析事件、`push` 连续喂入多个 chunk、
 *          `flush` 结束输入并收集剩余事件。
 */
function collector() {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  return {
    parser,
    events,
    /** 依次喂入若干 chunk，返回累计事件列表。 */
    push(...chunks: string[]): SseEvent[] {
      for (const chunk of chunks) events.push(...parser.push(chunk));
      return events;
    },
    /** 结束输入（不再有空行），返回累计事件列表。 */
    flush(): SseEvent[] {
      events.push(...parser.flush());
      return events;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE 增量解析器
// ---------------------------------------------------------------------------

describe('createSseParser —— 增量 SSE 解析', () => {
  it('解析单行 data 并由空行结束事件', () => {
    const c = collector();
    c.push('data: hello\n\n');

    expect(c.events).toEqual([{ event: null, data: 'hello', id: null, retry: null } satisfies SseEvent]);
  });

  it('chunk 边界切断一行时能跨 chunk 拼回完整事件', () => {
    const c = collector();
    c.push('data: {"a"', ':1}\n\n');

    expect(c.events).toHaveLength(1);
    expect(c.events[0]?.data).toBe('{"a":1}');
  });

  it('chunk 在 CRLF 中间切断时不会把 CR 误判为行终止', () => {
    const c = collector();
    // 第一个 chunk 以孤立的 \r 结尾，必须等待下一个 chunk 判断是否为 CRLF
    c.push('data: a\r', '\n\r\n');

    expect(c.events).toEqual([{ event: null, data: 'a', id: null, retry: null } satisfies SseEvent]);
  });

  it('CRLF 与 LF 混用时都能正确断行', () => {
    const c = collector();
    c.push('data: a\r\ndata: b\n\r\n');

    // 第一条 data 用 CRLF 结束，第二条用 LF，最后用 CRLF 空行派发
    expect(c.events).toHaveLength(1);
    expect(c.events[0]?.data).toBe('a\nb');
  });

  it('多行 data 以 \\n 连接成一个事件', () => {
    const c = collector();
    c.push('data: line1\ndata: line2\ndata: line3\n\n');

    expect(c.events).toEqual([
      { event: null, data: 'line1\nline2\nline3', id: null, retry: null } satisfies SseEvent,
    ]);
  });

  it('以 : 开头的注释行被忽略', () => {
    const c = collector();
    c.push(': this is a keep-alive comment\n\n', 'data: real\n\n');

    expect(c.events).toEqual([{ event: null, data: 'real', id: null, retry: null } satisfies SseEvent]);
  });

  it('事件中间的注释行不影响 data 拼接', () => {
    const c = collector();
    c.push('data: a\n: comment\ndata: b\n\n');

    expect(c.events[0]?.data).toBe('a\nb');
  });

  it('空行派发事件，一次 push 可以派发多个事件', () => {
    const c = collector();
    c.push('data: 1\n\ndata: 2\n\n');

    expect(c.events.map((e) => e.data)).toEqual(['1', '2']);
  });

  it('没有 data 的空行不会派发事件', () => {
    const c = collector();
    c.push('\n\n: only comment\n\n');

    expect(c.events).toEqual([]);
  });

  it('data: [DONE] 作为普通事件原样解析', () => {
    const c = collector();
    c.push('data: [DONE]\n\n');

    expect(c.events).toEqual([{ event: null, data: '[DONE]', id: null, retry: null } satisfies SseEvent]);
  });

  it('解析 event / id / retry 字段', () => {
    const c = collector();
    c.push('event: message\nid: 42\nretry: 3000\ndata: hi\n\n');

    expect(c.events).toEqual([
      { event: 'message', data: 'hi', id: '42', retry: 3000 } satisfies SseEvent,
    ]);
  });

  it('retry 非纯数字时被忽略', () => {
    const c = collector();
    c.push('retry: abc\ndata: x\n\n');

    expect(c.events[0]?.retry).toBeNull();
  });

  it('未知字段行被忽略', () => {
    const c = collector();
    c.push('unknown-field\n\n');

    expect(c.events).toEqual([]);
  });

  it('data 值只剥掉一个前导空格', () => {
    const c = collector();
    c.push('data:x\ndata:  y\n\n');

    expect(c.events[0]?.data).toBe('x\n y');
  });

  it('flush：结尾没有空行时补发已累积的事件', () => {
    const c = collector();
    c.push('data: tail\n');

    // 尚未见到空行，push 阶段不应派发
    expect(c.events).toEqual([]);

    c.flush();
    expect(c.events).toEqual([{ event: null, data: 'tail', id: null, retry: null } satisfies SseEvent]);
  });

  it('flush：已正常派发的事件不会被重复派发', () => {
    const c = collector();
    c.push('data: done\n\n');
    c.flush();

    expect(c.events).toHaveLength(1);
  });

  it('flush：没有残留数据时返回空数组', () => {
    const c = collector();
    expect(c.flush()).toEqual([]);
  });
});
