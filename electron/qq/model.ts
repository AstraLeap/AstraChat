import { streamChatCompletion, type ChatCompletionMessage } from '../../src/services/openai';

/**
 * QQ 回复的模型调用适配（唯一剩下的 I/O 适配）。
 *
 * ## 为什么是「累积流式」而不是找一个非流式接口
 *
 * 项目里只有 `streamChatCompletion` 这一个模型入口（它是为聊天界面写的，逐块回调）。
 * QQ 这边要的是**一整段回复**（要通过审计、转纯文本、切分、再按段发送），
 * 所以这里把增量累积成完整文本。
 *
 * 刻意**不为了一个非流式接口去改 `openai.ts`**：那会让聊天界面那条已经很稳的流式链路
 * 承担额外风险，收益却只是省下十几行累积代码。
 *
 * ## 错误为什么不吞
 *
 * 网络故障、鉴权失败、模型名不存在都应该**抛出去**。调用方
 * （`electron/qq/service.ts` 的 `composeReply`）已经统一 catch 并记日志 ——
 * 在那里处理能保证「模型失败」和「审计拦下」是两条不同的日志，而不是在这里
 * 都变成一句含糊的「回复为空」。
 */

/** 调用模型所需的提供商配置。 */
export interface QqProviderConfig {
  /** 接口根地址，不含 `/chat/completions`。 */
  baseUrl: string;
  /** API Key；空串表示无需鉴权（本地 Ollama 等）。 */
  apiKey: string;
  /** 模型名。 */
  model: string;
  /** 采样温度；不传则交给服务端默认值。 */
  temperature?: number;
}

/** 适配器依赖。 */
export interface QqCompleterDeps {
  /**
   * 取当前选用的提供商配置。
   *
   * @returns 配置；用户尚未配置任何可用提供商时返回 `null`。
   */
  getProvider: () => QqProviderConfig | null;
  /** 日志出口。 */
  log?: (message: string) => void;
}

/** 模型调用器。 */
export interface QqCompleter {
  /**
   * 让模型生成一段完整回复。
   *
   * @param messages 完整对话（含系统提示词）。
   * @returns Markdown 文本；没有可用提供商时返回空串。
   * @throws 模型请求失败时抛出（由调用方统一处理）。
   */
  complete: (messages: ChatCompletionMessage[]) => Promise<string>;
}

/**
 * 创建模型调用器。
 *
 * @param deps 依赖。
 * @returns 调用器。
 */
export function createQqCompleter(deps: QqCompleterDeps): QqCompleter {
  const log = deps.log ?? ((): void => undefined);

  return {
    async complete(messages: ChatCompletionMessage[]): Promise<string> {
      const provider = deps.getProvider();
      if (provider === null) {
        // 没配提供商就干脆不发请求：返回空串后由编排层判为「无内容」，
        // 而不是发一个必然失败的请求再报错
        log('尚未配置可用的模型提供商，无法生成 QQ 回复');
        return '';
      }

      let text = '';
      await streamChatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages,
        ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
        onDelta: (delta) => {
          // 只累积正文；思维链（reasoning）不该发到群里
          text += delta.content;
        },
      });

      return text;
    },
  };
}
