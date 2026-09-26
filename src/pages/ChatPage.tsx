import { useEffect, useMemo, useState } from 'react';
import { MessageList } from '../components/chat/MessageList';
import { Composer } from '../components/chat/Composer';
import { Button, EmptyState, IconSparkle } from '../components/ui/index';
import { useConversationStore } from '../stores/useConversationStore';
import {
  disposeChatStream,
  ensureChatStreamSubscribed,
  useChatStore,
} from '../stores/useChatStore';
import { describeError, getBridge } from '../stores/bridge';
import type { Provider } from '../types/index';

/**
 * 聊天页：**只**负责「消息区 + 输入框」。
 *
 * 侧边栏由 `App.tsx` 常驻渲染（见 `AppSidebar`），本页不重复渲染它，因此不需要任何
 * props，直接消费两个 store。
 *
 * 订阅生命周期：挂载时调用 {@link ensureChatStreamSubscribed}（幂等），卸载时调用
 * {@link disposeChatStream}。这一步不能省 —— `window.astra.chat.onEvent` 的监听器如果
 * 在卸载时没取消，下次挂载会再订阅一次，同一个 `delta` 被处理两遍，正文就会翻倍。
 */

/**
 * 渲染聊天页。
 *
 * @returns 消息区与输入框。
 */
export default function ChatPage() {
  const conversations = useConversationStore((state) => state.conversations);
  const currentId = useConversationStore((state) => state.currentId);
  const createConversation = useConversationStore((state) => state.create);
  const listConversations = useConversationStore((state) => state.list);

  const messages = useChatStore((state) => state.messages);
  const loading = useChatStore((state) => state.loading);
  const error = useChatStore((state) => state.error);
  const streamingId = useChatStore((state) => state.streamingId);
  const loadMessages = useChatStore((state) => state.loadMessages);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abort = useChatStore((state) => state.abort);
  const resetChat = useChatStore((state) => state.reset);

  const [draft, setDraft] = useState('');
  /** 可用的提供商列表：仅用于给「未绑定提供商」的对话挑一个默认值。 */
  const [providers, setProviders] = useState<Provider[]>([]);
  /** 提供商列表加载失败的原因（不影响历史消息浏览）。 */
  const [providersError, setProvidersError] = useState<string | null>(null);

  /** 当前对话实体。 */
  const conversation = useMemo(
    () => conversations.find((item) => item.id === currentId) ?? null,
    [conversations, currentId],
  );

  /**
   * 订阅流式事件；卸载时取消订阅。
   *
   * 空依赖数组是刻意的：订阅只做一次，事件处理函数读的是 store 的实时状态，
   * 不依赖任何闭包变量。
   */
  useEffect(() => {
    try {
      ensureChatStreamSubscribed();
    } catch (bridgeError) {
      // 桥接不可用（例如浏览器里直接跑 vite dev）：不阻断页面渲染，只提示。
      setProvidersError(describeError(bridgeError));
    }
    return () => {
      disposeChatStream();
    };
  }, []);

  /**
   * 拉取提供商列表，用于解析默认 provider / model。
   *
   * 这里直接走 `window.astra` 而不是引入设置页的 store：聊天页只需要一份只读列表，
   * 没必要和设置页的编辑状态耦合。
   */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getBridge().providers.list();
        if (!cancelled) {
          setProviders(list);
          setProvidersError(null);
        }
      } catch (bridgeError) {
        if (!cancelled) {
          setProvidersError(describeError(bridgeError));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 选中对话变化时加载其消息。 */
  useEffect(() => {
    if (!currentId) {
      resetChat(null);
      return;
    }
    void loadMessages(currentId);
  }, [currentId, loadMessages, resetChat]);

  /** 当前对话生效的提供商：优先用对话绑定的，否则退回第一个可用提供商。 */
  const effectiveProvider = useMemo(() => {
    if (conversation?.providerId) {
      const bound = providers.find((item) => item.id === conversation.providerId);
      if (bound) {
        return bound;
      }
    }
    return providers[0] ?? null;
  }, [conversation?.providerId, providers]);

  /** 当前对话生效的模型名：对话覆盖 > 提供商默认。 */
  const effectiveModel = conversation?.model ?? effectiveProvider?.model ?? null;

  const streaming = streamingId !== null;

  /** 无法发送的原因；非空时输入框禁用并展示该文案。 */
  const blockedReason = useMemo(() => {
    if (!currentId) {
      return '请先新建或选择一个对话';
    }
    if (providersError) {
      return providersError;
    }
    if (providers.length === 0) {
      return '请先在「设置」里添加一个模型提供商';
    }
    if (!effectiveModel) {
      return '当前提供商没有默认模型，请在「设置」里补全';
    }
    return null;
  }, [currentId, providersError, providers.length, effectiveModel]);

  /**
   * 流式进度信号：内容长度变化即触发列表贴底判断。
   *
   * 只传一个「变化了就变」的字符串，避免把整段正文塞进 `MessageList` 的依赖里。
   */
  const streamTick = useMemo(() => {
    if (!streaming) {
      return null;
    }
    const last = messages[messages.length - 1];
    return `${streamingId}:${last?.content.length ?? 0}:${last?.reasoning?.length ?? 0}`;
  }, [streaming, streamingId, messages]);

  /** 发送当前草稿。 */
  const handleSend = async () => {
    if (!currentId || !effectiveProvider || !effectiveModel) {
      return;
    }
    const content = draft.trim();
    if (!content) {
      return;
    }
    setDraft('');
    const ok = await sendMessage({
      conversationId: currentId,
      content,
      providerId: effectiveProvider.id,
      model: effectiveModel,
      personaId: conversation?.personaId ?? null,
    });
    if (!ok) {
      // 发送失败时把草稿还回去，避免用户白打一段字。
      setDraft((prev) => (prev ? prev : content));
    } else {
      // 首条消息后对话标题会由主进程改写，刷新列表以同步标题与消息条数。
      void listConversations({ selectFirstWhenEmpty: false });
    }
  };

  /** 中止当前流式回复。 */
  const handleAbort = () => {
    void abort();
  };

  // ---------------------------------------------------------------- 空态

  if (!currentId || !conversation) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-[var(--astra-bg)]">
        <EmptyState
          icon={<IconSparkle size={32} />}
          title="开始对话"
          description="从左侧选择一条对话，或新建一个对话。绑定提供商后即可与模型对话。"
          action={
            <Button
              variant="primary"
              onClick={() => {
                void createConversation({}).then((created) => {
                  if (created) {
                    resetChat(created.id);
                  }
                });
              }}
            >
              + 新建对话
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--astra-bg)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--astra-border)] bg-[var(--astra-surface)] px-4 py-2.5">
        <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--astra-text)]">
          {conversation.title}
        </h2>
        <span className="shrink-0 text-[11px] text-[var(--astra-muted)]">
          {effectiveProvider ? effectiveProvider.name : '未配置提供商'}
          {effectiveModel ? ` · ${effectiveModel}` : ''}
        </span>
      </header>

      <div className="min-h-0 flex-1">
        <MessageList
          messages={messages}
          loading={loading}
          error={error}
          onRetry={() => void loadMessages(currentId)}
          streamTick={streamTick}
        />
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => void handleSend()}
        onAbort={handleAbort}
        streaming={streaming}
        disabled={blockedReason !== null}
        disabledHint={blockedReason ?? undefined}
        error={streaming ? null : error}
      />
    </div>
  );
}