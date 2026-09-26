import { auditOutgoingText, type AuditFinding, type AuditOptions } from './audit';
import { markdownToPlain } from './plain-text';
import { splitForQQ } from './split-text';

/**
 * 出站文本管线：把模型产出的 Markdown 变成一串**可以安全发给 QQ** 的纯文本消息。
 *
 * ## 顺序是刻意的：先转纯文本 → 再审计 → 再切分
 *
 * 审计必须检查**真正会发出去的那段文本**。如果先审计 Markdown 原文再转换，审计对象与实际
 * 发送对象就可能不一致（转换会增删字符），而且 `AuditFinding` 的位置也会对不上。
 * `tests/qq-outbound.spec.ts` 里有一条用例专门锁住这个顺序：输入 `**token: sk-...**`，
 * 断言的命中位置从**转换后**的纯文本第 0 个字符开始，而不是 Markdown 的第 2 个。
 *
 * ## 三种结果
 *
 * - `blocked`：命中安全策略，**整条不发**（由 `findings` 说明原因，不含敏感原文）。
 * - `empty`：转换后没有可发内容。注意它与 `blocked` 是**不同**的事——前者无需告警，
 *   后者要记录与提示。
 * - `ready`：`parts` 是依次发送的纯文本段落（已按上限切分、代理对安全）。
 */

/** `prepareOutbound` 的选项。 */
export interface OutboundOptions {
  /** 单条消息的字符上限（对应 `qq_config.maxReplyChars`）。默认 4000。 */
  maxChars?: number;
  /**
   * 是否启用内容审计（对应 `qq_config.auditEnabled`）。
   *
   * **缺省视为开启**：审计是安全边界，忘记传参不应该导致它被静默关掉。
   */
  auditEnabled?: boolean;
  /** 已知的敏感值，透传给审计（各提供商的 API Key、QQ AppSecret 等）。 */
  knownSecrets?: readonly string[];
  /** 审计的细粒度开关，透传。 */
  auditOptions?: AuditOptions;
}

/** `prepareOutbound` 的结果。 */
export type OutboundResult =
  | { status: 'blocked'; findings: AuditFinding[]; plain: string }
  | { status: 'empty' }
  | { status: 'ready'; parts: string[]; plain: string };

/** 单条消息的默认字符上限。与 `splitForQQ` 的默认值保持一致。 */
const DEFAULT_MAX_CHARS = 4000;

/**
 * 把模型回复处理成可发送的纯文本段落，或判定为不可发送。
 *
 * @param markdown 模型输出的 Markdown 原文。
 * @param options 选项。
 * @returns 处理结果。
 */
export function prepareOutbound(markdown: string, options: OutboundOptions = {}): OutboundResult {
  // 1) 先转成真正会发出去的形态
  const plain = markdownToPlain(typeof markdown === 'string' ? markdown : '');

  // 2) 审计这段纯文本（缺省开启，fail-closed）
  if (options.auditEnabled !== false) {
    const audit = auditOutgoingText(plain, {
      ...options.auditOptions,
      ...(options.knownSecrets !== undefined ? { knownSecrets: options.knownSecrets } : {}),
    });
    if (audit.blocked) {
      return { status: 'blocked', findings: audit.findings, plain };
    }
  }

  // 3) 没有内容可发
  if (plain.length === 0) {
    return { status: 'empty' };
  }

  // 4) 按上限切分（代理对安全）
  const maxChars =
    typeof options.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars >= 1
      ? Math.floor(options.maxChars)
      : DEFAULT_MAX_CHARS;
  const parts = splitForQQ(plain, maxChars);

  if (parts.length === 0) {
    return { status: 'empty' };
  }

  return { status: 'ready', parts, plain };
}
