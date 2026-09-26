/**
 * 增量 SSE（Server-Sent Events）解析器。
 *
 * 为什么不用现成库：需求硬性要求「用 fetch + ReadableStream 自行解析 SSE」，
 * 而且网络 chunk 的切分点完全不受控 —— 一行可能被切成两半、CRLF 可能被切开、
 * 一个 chunk 里可能同时包含多个完整事件。因此解析器必须是**增量有状态**的：
 * 每次 `push(chunk)` 只消化能确定的行，把不完整的尾巴留在内部缓冲区。
 *
 * 本模块不依赖任何浏览器/Node 专有 API，可在主进程与测试中直接使用。
 *
 * 解析规则遵循 WHATWG HTML 规范的 SSE 章节：
 * - 行终止符为 `\r\n`、`\n` 或 `\r`；
 * - 以 `:` 开头的行是注释，忽略；
 * - `field: value` 在**第一个**冒号处切分，值若以单个空格开头则剥掉这一个空格；
 * - `data` 字段累加，派发时用 `\n` 连接；
 * - 空行表示派发事件；若此时没有任何 `data`，则不派发（但会清空事件类型）；
 * - `id` / `retry` 跨事件持久保留。
 */

/** 一个已解析完成的 SSE 事件。 */
export interface SseEvent {
  /** `event:` 字段值；未指定时为 `null`（按规范默认是 `message`）。 */
  event: string | null;
  /** 由多行 `data:` 用 `\n` 连接后的载荷（`data: [DONE]` 也走这里）。 */
  data: string;
  /** 最近一次 `id:` 字段值（跨事件持久）；从未出现时为 `null`。 */
  id: string | null;
  /** 最近一次合法的 `retry:` 值（毫秒，跨事件持久）；未出现或非法时为 `null`。 */
  retry: number | null;
}

/** 增量 SSE 解析器。 */
export interface SseParser {
  /**
   * 喂入一段**解码后的文本**（调用方负责用 `TextDecoder` 处理多字节边界）。
   *
   * @param chunk 新到达的文本片段，可以是任意切分位置，甚至是空串。
   * @returns 本次喂入后能确定下来的事件列表（可能为空）。
   */
  push(chunk: string): SseEvent[];

  /**
   * 声明输入已结束：把缓冲区里没有行终止符的尾行也当作完整行处理，
   * 并在存在未派发的 `data` 时补发事件。重复调用是幂等的。
   *
   * @returns 收尾时新派发的事件列表（可能为空）。
   */
  flush(): SseEvent[];
}

/**
 * 创建一个增量 SSE 解析器实例。
 *
 * 每次调用返回**独立**的解析器，各自维护自己的缓冲区与字段状态。
 *
 * @returns 实现了 {@link SseParser} 的解析器对象。
 */
export function createSseParser(): SseParser {
  /** 尚未处理的文本尾巴（可能是一行的一半，也可能是被切开的 CRLF 的 `\r`）。 */
  let buffer = '';
  /** 当前事件累积的 data 行。 */
  const dataLines: string[] = [];
  /** 当前事件的 `event:` 字段值。 */
  let eventType: string | null = null;
  /** 最近一次 `id:` 字段值（跨事件持久）。 */
  let lastId: string | null = null;
  /** 最近一次合法的 `retry:` 值（跨事件持久）。 */
  let retry: number | null = null;

  /**
   * 派发当前累积的事件。
   *
   * 没有任何 data 行时不产生事件（但按规范仍要清空事件类型缓冲）。
   *
   * @param out 事件收集数组。
   */
  function dispatch(out: SseEvent[]): void {
    if (dataLines.length === 0) {
      eventType = null;
      return;
    }
    out.push({ event: eventType, data: dataLines.join('\n'), id: lastId, retry });
    dataLines.length = 0;
    eventType = null;
  }

  /**
   * 处理一个完整的逻辑行。
   *
   * @param line 不含行终止符的一行文本。
   * @param out 事件收集数组。
   */
  function processLine(line: string, out: SseEvent[]): void {
    // 空行 → 派发事件
    if (line === '') {
      dispatch(out);
      return;
    }
    // 注释行 → 忽略
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // 规范：冒号后若恰有一个空格则剥掉它（多于一个空格时只剥一个）
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        // 规范：含 U+0000 的 id 必须忽略
        if (!value.includes('\u0000')) lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) retry = Number.parseInt(value, 10);
        break;
      default:
        // 未知字段（含无冒号的整行）按规范忽略
        break;
    }
  }

  return {
    push(chunk: string): SseEvent[] {
      const out: SseEvent[] = [];
      buffer += chunk;

      for (;;) {
        const cr = buffer.indexOf('\r');
        const lf = buffer.indexOf('\n');
        let index: number;
        if (cr === -1) index = lf;
        else if (lf === -1) index = cr;
        else index = Math.min(cr, lf);

        // 没有行终止符 → 剩下的都是不完整的尾巴
        if (index === -1) break;

        // 尾巴处的孤立 \r 可能是被切断的 CRLF，等下一个 chunk 再判断
        if (buffer[index] === '\r' && index === buffer.length - 1) break;

        const isCrlf = buffer[index] === '\r' && buffer[index + 1] === '\n';
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (isCrlf ? 2 : 1));
        processLine(line, out);
      }

      return out;
    },

    flush(): SseEvent[] {
      const out: SseEvent[] = [];

      if (buffer !== '') {
        const rest = buffer;
        buffer = '';
        // 结尾的 \r 视作行终止符；按行拆开后，末段即使没有终止符也要处理
        const parts = rest.split(/\r\n|\r|\n/);
        for (const line of parts) processLine(line, out);
      }

      // 结尾没有空行 → 把已累积但未派发的事件补发
      dispatch(out);
      return out;
    },
  };
}
