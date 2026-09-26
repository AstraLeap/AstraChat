import type { ProviderPreset } from '../types/index';

/**
 * 内置的模型提供商预设。
 *
 * 用途**仅限**于「新建提供商」表单的一键填充，让用户少查一次文档。它们不是硬编码
 * 依赖：不会被自动写库，用户随时可以改名、换地址、全部删掉。
 *
 * 关于 Anthropic 与 Gemini：这两家的原生协议并不是 OpenAI 兼容协议，但它们都官方
 * 提供了 OpenAI 兼容端点（因此 `baseUrl` 指向的是那个兼容端点，而不是原生 API 根路径）。
 * AstraChat v0.1.0 只实现 OpenAI 兼容协议，所以这里统一给出兼容端点。
 */

/** 预设列表。地址均不含末尾斜杠与 `/chat/completions`。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    // Anthropic 官方的 OpenAI SDK 兼容层。
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    // Gemini 官方的 OpenAI 兼容端点。
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    key: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    key: 'qwen',
    name: '阿里云通义千问',
    // DashScope 的 OpenAI 兼容模式。
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    docsUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    key: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    key: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    key: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    docsUrl: 'https://ollama.com/download',
  },
  {
    key: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
  },
];

/**
 * 按 key 查找预设。
 *
 * @param key 预设标识。
 * @returns 找到则返回，否则 `null`。
 */
export function findProviderPreset(key: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.key === key) ?? null;
}
