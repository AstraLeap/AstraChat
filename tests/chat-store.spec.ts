import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeChatStream,
  ensureChatStreamSubscribed,
  useChatStore,
} from '../src/stores/useChatStore';
import type { ChatSendRequest, ChatStreamEvent, Message } from '../src/types/index';

/**
 * 流式 store 的事件路由回归测试。
 *
 * 这是整个渲染层最容易出错、也最难靠肉眼发现的部分：一旦 `delta` 落错消息，
 * 用户看到的就是「AI 气泡空白、内容最后突然出现或串到别的对话」。
 *
 * 测试方式：stub 掉 `window.astra`，**手工构造主进程的事件时序**，直接驱动 store。
 * 关键是忠实复现真实时序 —— 主进程的 `startStream` 是同步函数，在 IPC invoke 返回
 * 之前就已经把 `start` 推给了渲染层。
 */

/** 当前注册的事件监听器（模拟预加载层的订阅表）。 */
let listeners: ((event: ChatStreamEvent) => void)[] = [];

/** 向所有监听器广播一个事件（模拟主进程 → 渲染进程的推送）。 */
function emit(event: ChatStreamEvent): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

/** 构造一条落库后的真实消息。 */
function realMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'real-assistant-1',
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    reasoning: null,
    status: 'complete',
    error: null,
    model: 'test-model',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** 造一个假的 `window.astra`。 */
function installBridge(options: {
  /** `chat.send` 的行为；默认返回 streamId `s1`。 */
  onSend?: (request: ChatSendRequest) => Promise<{ streamId: string }>;
} = {}) {
  const send =
    options.onSend ??
    (async (_request: ChatSendRequest) => ({ streamId: 's1' }));

  const astra = {
    chat: {
      send: vi.fn(send),
      abort: vi.fn(async () => undefined),
      onEvent: (listener: (event: ChatStreamEvent) => void) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((item) => item !== listener);
        };
      },
    },
    messages: {
      list: vi.fn(async () => [] as Message[]),
    },
  };

  // 在真实渲染进程里 globalThis === window，`astra` 就是全局对象上的属性；
  // 因此这里直接挂到 globalThis 上，而不是造一个独立的 window 对象。
  (globalThis as unknown as { astra: unknown }).astra = astra;
}

/** 发送参数的默认值。 */
const SEND_REQUEST: ChatSendRequest = {
  conversationId: 'c1',
  content: '你好',
  providerId: 'p1',
  model: 'test-model',
  personaId: null,
};

/**
 * 取出当前列表里的 assistant 消息。
 *
 * @returns 第一条 assistant 消息，没有则返回 `undefined`。
 */
function assistant(): Message | undefined {
  return useChatStore.getState().messages.find((m) => m.role === 'assistant');
}

beforeEach(() => {
  listeners = [];
  installBridge();
  disposeChatStream();
  useChatStore.getState().reset('c1');
});

afterEach(() => {
  disposeChatStream();
  delete (globalThis as unknown as { astra?: unknown }).astra;
  vi.restoreAllMocks();
});

describe('流式事件路由', () => {
  it('start 先于 chat.send() resolve 到达时，首批 delta 不会丢失（核心时序契约）', async () => {
    // 忠实复现真实时序：主进程在返回 streamId **之前**就同步推送了 start 与首个 delta。
    installBridge({
      onSend: async (request) => {
        emit({
          type: 'start',
          streamId: 's1',
          messageId: 'real-assistant-1',
          conversationId: request.conversationId,
        });
        emit({
          type: 'delta',
          streamId: 's1',
          messageId: 'real-assistant-1',
          content: '你',
          reasoning: '',
        });
        return { streamId: 's1' };
      },
    });

    const ok = await useChatStore.getState().sendMessage(SEND_REQUEST);
    expect(ok).toBe(true);

    // 首批增量必须已经落在 assistant 气泡上（这正是最容易丢字的地方）
    expect(assistant()?.content).toBe('你');
    // 乐观占位 id 已被认领为落库后的真实 id
    expect(assistant()?.id).toBe('real-assistant-1');

    // 后续增量继续累加
    emit({
      type: 'delta',
      streamId: 's1',
      messageId: 'real-assistant-1',
      content: '好',
      reasoning: '',
    });
    expect(assistant()?.content).toBe('你好');
  });

  it('delta 按 messageId 追加，不会写到「最后一条消息」上', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });

    // 先给一个「幽灵」消息占住列表末尾：若实现按最后一条追加，内容就会串到这里
    useChatStore.setState((prev) => ({
      messages: [
        ...prev.messages,
        {
          id: 'ghost',
          conversationId: 'c1',
          role: 'assistant',
          content: '不该被改写',
          reasoning: null,
          status: 'complete',
          error: null,
          model: null,
          createdAt: 0,
        },
      ],
    }));

    emit({
      type: 'delta',
      streamId: 's1',
      messageId: 'real-assistant-1',
      content: '正文',
      reasoning: '思考',
    });

    const messages = useChatStore.getState().messages;
    expect(messages.find((m) => m.id === 'ghost')?.content).toBe('不该被改写');
    expect(messages.find((m) => m.id === 'real-assistant-1')?.content).toBe('正文');
    expect(messages.find((m) => m.id === 'real-assistant-1')?.reasoning).toBe('思考');
  });

  it('切换到别的对话后，旧对话的 delta 一律丢弃', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });

    // 用户切到 c2 并加载它的消息
    useChatStore.getState().reset('c2');

    emit({
      type: 'delta',
      streamId: 's1',
      messageId: 'real-assistant-1',
      content: '迟到的内容',
      reasoning: '',
    });

    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().conversationId).toBe('c2');
  });

  it('done 用落库消息替换乐观占位，并清空 streamingId', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    expect(useChatStore.getState().streamingId).toBe('s1');

    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });
    emit({
      type: 'delta',
      streamId: 's1',
      messageId: 'real-assistant-1',
      content: '完整',
      reasoning: '',
    });
    emit({
      type: 'done',
      streamId: 's1',
      messageId: 'real-assistant-1',
      message: realMessage({ content: '完整', status: 'complete' }),
    });

    const messages = useChatStore.getState().messages;
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(messages.find((m) => m.id === 'real-assistant-1')?.content).toBe('完整');
    expect(useChatStore.getState().streamingId).toBeNull();
  });

  it('被中止（done 且 status=aborted）不算错误，不产生红条', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });
    emit({
      type: 'done',
      streamId: 's1',
      messageId: 'real-assistant-1',
      message: realMessage({ content: '半截', status: 'aborted' }),
    });

    expect(useChatStore.getState().error).toBeNull();
    expect(assistant()?.status).toBe('aborted');
    expect(assistant()?.content).toBe('半截');
  });

  it('error 事件把目标消息标记为失败', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });
    emit({
      type: 'error',
      streamId: 's1',
      messageId: 'real-assistant-1',
      error: '模型接口返回 401：Invalid API key',
    });

    expect(assistant()?.status).toBe('error');
    expect(assistant()?.error).toContain('Invalid API key');
    expect(useChatStore.getState().streamingId).toBeNull();
  });

  it('未登记归属的过期事件被丢弃，不污染当前对话', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });

    // 一个从未登记过的 streamId
    emit({
      type: 'delta',
      streamId: 'unknown-stream',
      messageId: 'nobody',
      content: '幽灵',
      reasoning: '',
    });

    expect(useChatStore.getState().messages.some((m) => m.content.includes('幽灵'))).toBe(false);
  });
});

describe('订阅生命周期', () => {
  it('重复调用 ensureChatStreamSubscribed 不会叠加监听器', () => {
    ensureChatStreamSubscribed();
    ensureChatStreamSubscribed();
    ensureChatStreamSubscribed();
    expect(listeners).toHaveLength(1);
  });

  it('disposeChatStream 会移除监听器并清空流状态', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    expect(listeners).toHaveLength(1);
    expect(useChatStore.getState().streamingId).toBe('s1');

    disposeChatStream();

    expect(listeners).toHaveLength(0);
    expect(useChatStore.getState().streamingId).toBeNull();
  });

  it('dispose 后重新订阅能正常工作，且不会重复追加内容', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's1', messageId: 'real-assistant-1', conversationId: 'c1' });
    disposeChatStream();

    useChatStore.getState().reset('c1');
    installBridge({
      onSend: async () => ({ streamId: 's2' }),
    });
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    emit({ type: 'start', streamId: 's2', messageId: 'real-2', conversationId: 'c1' });
    emit({ type: 'delta', streamId: 's2', messageId: 'real-2', content: '唯一', reasoning: '' });

    // 若订阅重复，'唯一' 会被追加两次
    expect(assistant()?.content).toBe('唯一');
    expect(listeners).toHaveLength(1);
  });
});

describe('发送与中止', () => {
  it('发送失败时把占位标记为 error，并保留用户消息以便重试', async () => {
    installBridge({
      onSend: async () => {
        throw new Error("Error invoking remote method 'chat:send': Error: 提供商不存在");
      },
    });

    const ok = await useChatStore.getState().sendMessage(SEND_REQUEST);

    expect(ok).toBe(false);
    const messages = useChatStore.getState().messages;
    expect(messages.find((m) => m.role === 'user')?.content).toBe('你好');
    expect(messages.find((m) => m.role === 'assistant')?.status).toBe('error');
    // 错误文案里的 Electron 前缀应被剥掉
    expect(useChatStore.getState().error).toBe('提供商不存在');
  });

  it('拒绝发送空消息', async () => {
    const ok = await useChatStore.getState().sendMessage({ ...SEND_REQUEST, content: '   ' });
    expect(ok).toBe(false);
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().error).toContain('不能为空');
  });

  it('视图不在目标对话时拒绝发送', async () => {
    useChatStore.getState().reset('c2');
    const ok = await useChatStore.getState().sendMessage(SEND_REQUEST);
    expect(ok).toBe(false);
    expect(useChatStore.getState().error).toContain('已切换');
  });

  it('abort 会调用桥接并即时熄灭 streamingId', async () => {
    await useChatStore.getState().sendMessage(SEND_REQUEST);
    await useChatStore.getState().abort();
    expect(useChatStore.getState().streamingId).toBeNull();
  });
});
