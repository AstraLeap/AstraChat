import type { AuditFinding, AuditOptions } from './audit';
import { prepareOutbound } from './outbound';
import { limitPassiveParts, type OutboundMessage, type SendKind } from './send';

/**
 * 出站回复编排（纯逻辑）。
 *
 * 把 D 阶段前面几块串成一条链，产出**可直接依次发送的清单**：
 *
 * ```
 * 审计 → Markdown 转纯文本 → 代理对安全切分 → 被动回复段数上限 → 生成 msg_seq
 * ```
 *
 * ## 为什么把这层单独拆出来
 *
 * 真正的「收消息 → 问模型 → 发回复」链路要碰数据库、模型 API 与网络，很难测。
 * 但其中**决定「到底发什么」的部分**完全是纯逻辑，而且是最容易出错的部分：
 * 切分会不会切坏 emoji、审计有没有真的接上、`msg_seq` 有没有递增、超长回复怎么处理。
 * 把它抽成纯函数后这些都能被精确断言，I/O 层只剩「照着清单发」。
 *
 * ## 两条不能忘的官方约束
 *
 * 1. **相同 `msg_id` + `msg_seq` 重复发送会失败**（`40054005 消息被去重`）。
 *    所以被动回复的第 i 段用 `msg_seq = i + 1`，从 1 开始。
 * 2. **被动回复有次数上限**（群 5 次、单聊 4 次）。超出的段落在**发送前**就丢掉，
 *    并把丢弃数量报出来，让调用方能如实告诉用户「后面 N 段没发出」——
 *    而不是发出去被服务端拒绝，白费一次调用和一条无意义的错误日志。
 */

/** 编排入参。 */
export interface ReplyPlanInput {
  /** 群聊 / 私聊（决定被动回复段数上限）。 */
  kind: SendKind;
  /**
   * 被动回复的消息 id（事件里的 `d.id`）。
   *
   * 传 `null` 或空白即**主动消息**：不带 `msg_id`/`msg_seq`，也不受段数上限约束。
   * 注意主动消息受更严格的频控，且用户可在客户端关闭「允许主动发送」。
   */
  messageId: string | null;
  /** 模型输出的 Markdown 原文。 */
  markdown: string;
  /** 单条字符上限；缺省 4000。 */
  maxChars?: number;
  /** 是否启用内容审计；缺省**开启**（fail-closed）。 */
  auditEnabled?: boolean;
  /** 已知的敏感值，透传给审计（如各提供商的 API Key）。 */
  knownSecrets?: readonly string[];
  /** 审计的细粒度开关，透传。 */
  auditOptions?: AuditOptions;
}

/** 编排结果。 */
export type ReplyPlan =
  | {
      /** 命中安全策略，**整条不发**。 */
      status: 'blocked';
      /** 命中明细（**不含**敏感原文，可安全写日志）。 */
      findings: AuditFinding[];
      /** 被拦下的纯文本，便于用 `redactForLog` 记录。 */
      plain: string;
    }
  | {
      /** 转换后没有可发内容。注意它与 `blocked` 是**不同**的事。 */
      status: 'empty';
    }
  | {
      /** 可以发送。 */
      status: 'ready';
      /** 依次发送的清单。 */
      items: OutboundMessage[];
      /** 因超出被动回复上限而被丢弃的段数。 */
      dropped: number;
      /** 切分前的纯文本，便于日志与排查。 */
      plain: string;
    };

/**
 * 规划一条回复要发什么。
 *
 * @param input 入参。
 * @returns 编排结果。
 */
export function planReply(input: ReplyPlanInput): ReplyPlan {
  // 1) 转换 + 审计 + 切分（审计检查的是转换后真正会发出去的文本）
  const prepared = prepareOutbound(input.markdown, {
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
    ...(input.auditEnabled !== undefined ? { auditEnabled: input.auditEnabled } : {}),
    ...(input.knownSecrets !== undefined ? { knownSecrets: input.knownSecrets } : {}),
    ...(input.auditOptions !== undefined ? { auditOptions: input.auditOptions } : {}),
  });

  if (prepared.status === 'blocked') {
    return { status: 'blocked', findings: prepared.findings, plain: prepared.plain };
  }
  if (prepared.status === 'empty') {
    return { status: 'empty' };
  }

  // 2) 被动回复的段数上限
  const msgId = typeof input.messageId === 'string' ? input.messageId.trim() : '';
  const passive = msgId.length > 0;
  const limited = limitPassiveParts(prepared.parts, input.kind, passive);

  // 3) 生成清单：被动回复第 i 段用 msg_seq = i + 1
  const items: OutboundMessage[] = limited.parts.map((content, index) =>
    passive ? { content, msgId, msgSeq: index + 1 } : { content },
  );

  return { status: 'ready', items, dropped: limited.dropped, plain: prepared.plain };
}
