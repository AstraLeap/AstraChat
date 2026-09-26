import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatApiError,
  extractApiErrorMessage,
  isAbortError,
  normalizeError,
} from '../src/services/errors';
import { streamChatCompletion, type ChatCompletionMessage } from '../src/services/openai';
import { findProviderPreset, PROVIDER_PRESETS } from '../src/services/presets';

/**
 * OpenAI 兼容流式客户端 + 错误归一化 + 提供商预设的测试。
 *
 * `streamChatCompletion` 用 stub 掉的 `global.fetch` 驱动 —— 测试的是**解析逻辑与
 * 协议处理**，不发真实网络请求。
 */

const encoder = new TextEncoder();

/**
 * 构造一个以分块形式吐出 SSE 文本的 `Response`。
 *
 * @param chunks 依次入队的文本片段（刻意可以切断行，用来验证增量解析）。
 * @param init 额外的 Response 初始化参数。
 * @returns 模拟的 HTTP 响应。
 */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

/**
 * 构造一条 OpenAI 风格的流式分片。
 *
 * @param delta `choices[0].delta` 的内容。
 * @returns SSE 文本（含结尾空行）。
 */
function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
}

/** 记录所有回调收到的增量。 */
function collector(): { deltas: { content: string; reasoning: string }[]; onDelta: (d: { content: string; reasoning: string }) => void } {
  const deltas: { content: string; reasoning: string }[] = [];
  return { deltas, onDelta: (d) => deltas.push(d) };
}

const MESSAGES: ChatCompletionMessage[] = [{ role: 'user', content: '你好' }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamChatCompletion', () => {
  it('拼接正文与思维链，并用正确的 URL / 请求头 / 请求体发起 POST', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        chunk({ reasoning_content: '思考' }),
        chunk({ content: '你' }),
        chunk({ content: '好' }),
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { deltas, onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'demo-model',
      messages: MESSAGES,
      temperature: 0.7,
      onDelta,
    });

    expect(deltas.map((d) => d.content).join('')).toBe('你好');
    expect(deltas.map((d) => d.reasoning).join('')).toBe('思考');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // 末尾斜杠必须被规范化，否则会拼出 //chat/completions
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'demo-model', stream: true, temperature: 0.7 });
  });

  it('apiKey 为空时不发送 Authorization 头（本地 Ollama 场景）', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const { onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'qwen2.5:7b',
      messages: MESSAGES,
      onDelta,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('未指定 temperature 时不写入请求体', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const { onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      onDelta,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('temperature');
  });

  it('正确跨 chunk 拼合被切断的行与多字节字符', async () => {
    // 刻意把一行 JSON 与中文字符都从中间切开
    const full = chunk({ content: '星辰跃动' });
    const cut = Math.floor(full.length / 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([full.slice(0, cut), full.slice(cut), 'data: [DONE]\n\n'])),
    );
    const { deltas, onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      onDelta,
    });

    expect(deltas.map((d) => d.content).join('')).toBe('星辰跃动');
  });

  it('兼容 reasoning 字段与数组形式的 content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ reasoning: '推理中' }),
          chunk({ content: [{ type: 'text', text: '分段' }, { type: 'text', text: '内容' }] }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const { deltas, onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      onDelta,
    });

    expect(deltas.map((d) => d.content).join('')).toBe('分段内容');
    expect(deltas.map((d) => d.reasoning).join('')).toBe('推理中');
  });

  it('收到 [DONE] 后不再处理后续分片', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([chunk({ content: '正常' }), 'data: [DONE]\n\n', chunk({ content: '不应出现' })]),
      ),
    );
    const { deltas, onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      onDelta,
    });

    expect(deltas.map((d) => d.content).join('')).toBe('正常');
  });

  it('没有结尾空行时也能拿到最后一个事件（flush 路径）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: '尾' } }] })}`])),
    );
    const { deltas, onDelta } = collector();

    await streamChatCompletion({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      onDelta,
    });

    expect(deltas.map((d) => d.content).join('')).toBe('尾');
  });

  it('非 2xx 时抛出携带状态码与 message 的 ChatApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const { onDelta } = collector();

    await expect(
      streamChatCompletion({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'bad',
        model: 'm',
        messages: MESSAGES,
        onDelta,
      }),
    ).rejects.toThrowError(ChatApiError);

    try {
      await streamChatCompletion({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'bad',
        model: 'm',
        messages: MESSAGES,
        onDelta,
      });
      expect.unreachable('应当抛出 ChatApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatApiError);
      const apiError = error as ChatApiError;
      expect(apiError.status).toBe(401);
      expect(apiError.message).toBe('Invalid API key');
    }
  });

  it('网关返回 HTML 错误页时也能给出可读信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );
    const { onDelta } = collector();

    await expect(
      streamChatCompletion({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: MESSAGES,
        onDelta,
      }),
    ).rejects.toThrow(/502 Bad Gateway/);
  });

  it('流中途回传 error 对象时抛出 ChatApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          chunk({ content: '开始' }),
          `data: ${JSON.stringify({ error: { message: 'rate limit exceeded' } })}\n\n`,
        ]),
      ),
    );
    const { onDelta } = collector();

    await expect(
      streamChatCompletion({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: MESSAGES,
        onDelta,
      }),
    ).rejects.toThrow(/rate limit exceeded/);
  });

  it('用户中止时抛出的 AbortError 会向上传播（不吞掉）', async () => {
    const controller = new AbortController();
    const { deltas, onDelta } = collector();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              encoder.encode(chunk({ content: '部分内容' })),
            );
            // 流保持打开，直到外部 abort
            signal.addEventListener('abort', () => {
              streamController.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    // 一收到增量就中止
    const wrapped = (d: { content: string; reasoning: string }) => {
      onDelta(d);
      controller.abort();
    };

    await expect(
      streamChatCompletion({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: MESSAGES,
        signal: controller.signal,
        onDelta: wrapped,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // 中止前收到的内容应被保留，而不是丢失
    expect(deltas.map((d) => d.content).join('')).toBe('部分内容');
  });
});

describe('错误归一化', () => {
  it('extractApiErrorMessage 依次尝试 error.message / error / message / 纯文本', () => {
    expect(extractApiErrorMessage('{"error":{"message":"A"}}')).toBe('A');
    expect(extractApiErrorMessage('{"error":"B"}')).toBe('B');
    expect(extractApiErrorMessage('{"message":"C"}')).toBe('C');
    expect(extractApiErrorMessage('plain text')).toBe('plain text');
    expect(extractApiErrorMessage('')).toBe('服务端未返回错误详情');
  });

  it('isAbortError 识别 AbortError / TimeoutError，不误判普通错误', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('boom')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it('normalizeError 对中止、API 错误、网络错误给出可读文案', () => {
    expect(normalizeError(new DOMException('x', 'AbortError'))).toBe('已中止');
    expect(normalizeError(new ChatApiError('模型不存在', { status: 404 }))).toBe(
      '模型接口返回 404：模型不存在',
    );
    expect(normalizeError(new ChatApiError('未知'))).toBe('模型接口调用失败：未知');
    expect(normalizeError(new Error('getaddrinfo ENOTFOUND api.x.com'))).toContain('无法解析接口域名');
    expect(normalizeError(new Error('connect ECONNREFUSED'))).toContain('连接被拒绝');
    expect(normalizeError(new Error('fetch failed'))).toContain('网络请求失败');
    expect(normalizeError(new Error('   '))).toBe('未知错误（错误对象没有 message）');
    expect(normalizeError('字符串错误')).toBe('字符串错误');
  });

  it('ChatApiError 截断超长响应体，避免日志爆炸', () => {
    const huge = 'x'.repeat(5000);
    const err = new ChatApiError('boom', { status: 500, body: huge });
    expect(err.body?.length).toBe(2000);
    expect(err.name).toBe('ChatApiError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('提供商预设', () => {
  it('包含需求点名的常见提供商', () => {
    const keys = PROVIDER_PRESETS.map((p) => p.key);
    for (const expected of ['deepseek', 'openai', 'anthropic', 'gemini', 'glm', 'qwen']) {
      expect(keys).toContain(expected);
    }
  });

  it('Base URL 不含末尾斜杠，也不含 /chat/completions（由客户端拼接）', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl.endsWith('/')).toBe(false);
      expect(preset.baseUrl).not.toContain('/chat/completions');
    }
  });

  it('除「自定义」外，预设都必须带可用的 Base URL 与模型名', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.key === 'custom') {
        continue;
      }
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.model.length).toBeGreaterThan(0);
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it('findProviderPreset 命中与未命中', () => {
    expect(findProviderPreset('deepseek')?.model).toBe('deepseek-chat');
    expect(findProviderPreset('nope')).toBeNull();
  });

  it('预设 key 唯一', () => {
    const keys = PROVIDER_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
