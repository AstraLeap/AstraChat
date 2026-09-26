import { authorizeInbound } from '../../src/services/qq/authorization';
import { resolveCommand, type QqCommand } from '../../src/services/qq/commands';
import { parseInboundEvent, type QqChatKind, type QqInbound } from '../../src/services/qq/events';
import { planReply } from '../../src/services/qq/reply';
import type { OutboundMessage, SendKind, SendResult } from '../../src/services/qq/send';
import { createThrottle, type Throttle } from '../../src/services/qq/throttle';
import type { QqConfig, QqContactPolicy } from '../../src/types/index';

/**
 * QQ 消息链路的编排层（I/O 侧的「大脑」）。
 *
 * 它自己不实现任何判定逻辑，只把 `src/services/qq/` 里那些**已被完整单测覆盖的纯函数**
 * 按顺序接起来：
 *
 * ```
 * 网关事件 → 事件解析 → 记录来源 → 授权判定 → 命令判定
 *        → (管理命令 | 模型) → 出站编排（审计/转换/切分/msg_seq）
 *        → 节流 → 发送 → 记录节流
 * ```
 *
 * ## 为什么数据库与模型调用都是注入的
 *
 * 直接在这里 `import` 数据库与模型客户端，会让这条链路只能靠「起整个 Electron + 真账号」
 * 来验证 —— 而链路上最容易错的地方（未授权来源有没有触达模型、群友的命令有没有被拦、
 * 段落顺序与 msg_seq、失败后要不要继续发）恰恰是最难在真机上观察的。
 *
 * 所以这里只声明「我需要什么」（查授权状态、记录来源、让模型生成回复、发一条消息），
 * 由调用方注入。这样测试能用假依赖把整条链路端到端跑一遍，
 * 而真正碰 SQLite / 模型的胶水代码被压缩成一层很薄、几乎不含分支的适配器。
 *
 * ## 三处刻意保守的选择
 *
 * 1. **未授权来源在授权判定之前就记进「已发现的来源」**。这正是该列表存在的意义
 *    —— 用户要能看到「有哪些群/人来找过机器人」然后逐个授权。只记录已授权来源的话，
 *    这个列表永远是空的，用户也就没有入口去授权。
 * 2. **审计默认开启**（由 `qq_config.audit_enabled` 决定，缺省真值）。
 * 3. **节流等待有上限**：需要等超过 {@link DEFAULT_MAX_WAIT_MS} 时**直接丢弃**而不是干等。
 *    被动回复窗口只有 5 分钟，为了一条超频的消息把整条管线阻塞一分钟，代价比丢掉一条
 *    消息大得多；而且阻塞期间收到的新事件会排队积压。
 */

/** 最长愿意为节流等待的时间。超过就丢弃。 */
export const DEFAULT_MAX_WAIT_MS = 10_000;

/** 来源的授权查询结果。 */
export interface QqContactLookup {
  /** 三态授权状态。 */
  policy: QqContactPolicy;
  /** 当前有多少来源是 `allow`（用于判断「白名单是否为空」）。 */
  allowedCount: number;
}

/** 编排层依赖。 */
export interface QqServiceDeps {
  /** 读当前配置（每次事件都重新读，配置改了立即生效）。 */
  getConfig: () => QqConfig;
  /** 查来源的授权状态。 */
  getContactPolicy: (openId: string) => QqContactLookup;
  /** 记录「见过这个来源」，用于设置页的待授权列表。 */
  recordContactSeen: (input: {
    openId: string;
    kind: QqChatKind;
    displayName?: string | null;
  }) => void;
  /** 让模型生成回复（返回 Markdown）。由调用方决定用哪个会话与人格。 */
  generateReply: (message: QqInbound, role: 'owner' | 'member') => Promise<string>;
  /** 执行管理命令，返回要回复的文本。**不经过模型。** */
  executeCommand: (command: QqCommand, message: QqInbound) => Promise<string>;
  /** 发送一条消息。 */
  send: (kind: SendKind, openId: string, message: OutboundMessage) => Promise<SendResult>;
  /** 已知的敏感值，传给审计（零误报地拦下「模型复述本机密钥」）。 */
  knownSecrets?: () => readonly string[];
  /** 机器人自己的 id，用于判断全量群消息有没有 @ 它。 */
  getBotId?: () => string | null;
  /** 日志出口。 */
  log?: (message: string) => void;
  /** 等待（测试注入）。 */
  wait?: (ms: number) => Promise<void>;
  /** 时钟（测试注入）。 */
  now?: () => number;
  /** 节流最长等待时间，缺省 {@link DEFAULT_MAX_WAIT_MS}。 */
  maxWaitMs?: number;
}

/** 编排层句柄。 */
export interface QqService {
  /**
   * 处理一个网关事件。
   *
   * **不会抛异常**：任何环节出错都记日志并结束，因为这里是网关回调的接收端，
   * 抛出去会打断网关的消息循环。
   *
   * @param payload 网关信封。
   */
  handleInbound(payload: unknown): Promise<void>;
}

/**
 * 创建编排层。
 *
 * @param deps 依赖。
 * @returns 编排层句柄。
 */
export function createQqService(deps: QqServiceDeps): QqService {
  const log = deps.log ?? ((): void => undefined);
  const now = deps.now ?? ((): number => Date.now());
  const wait = deps.wait ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  /** 节流器：配置变了就重建（用户改设置后立即生效）。 */
  let throttle: Throttle | null = null;
  let throttleKey = '';

  /**
   * 取节流器，必要时按当前配置重建。
   *
   * @param config 当前配置。
   * @returns 节流器。
   */
  function getThrottle(config: QqConfig): Throttle {
    const key = `${config.sendDelayMs}|${config.maxSendPerMinute}|${config.maxSendPerHour}`;
    if (throttle === null || throttleKey !== key) {
      throttle = createThrottle({
        sendDelayMs: config.sendDelayMs,
        maxPerMinute: config.maxSendPerMinute,
        maxPerHour: config.maxSendPerHour,
      });
      throttleKey = key;
    }
    return throttle;
  }

  /**
   * 生成回复文本：管理命令走程序，其余走模型。
   *
   * @param message 入站消息。
   * @param role 权限分层。
   * @returns Markdown 文本。
   */
  async function composeReply(message: QqInbound, role: 'owner' | 'member'): Promise<string> {
    const decision = resolveCommand(message.content, role);

    if (decision.action === 'execute') {
      try {
        return await deps.executeCommand(decision.command, message);
      } catch (error) {
        log(`执行管理命令失败：${describe(error)}`);
        return '命令执行失败，请稍后重试。';
      }
    }

    if (decision.action === 'reject' || decision.action === 'unknown') {
      // 命令被拦下时**回复原因**而不是沉默：群友知道边界在哪，管理员知道拼错了什么。
      // 注意这里仍然不经过模型。
      log(`命令被拦下（${decision.action}）：${decision.reason}`);
      return decision.reason;
    }

    try {
      return await deps.generateReply(message, role);
    } catch (error) {
      log(`模型生成回复失败：${describe(error)}`);
      return '';
    }
  }

  /**
   * 按节流规则依次发送清单。
   *
   * @param kind 群聊 / 私聊。
   * @param openId 授权主体 openid。
   * @param items 发送清单。
   * @param throttler 节流器。
   */
  async function deliver(
    kind: SendKind,
    openId: string,
    items: readonly OutboundMessage[],
    throttler: Throttle,
  ): Promise<void> {
    for (const item of items) {
      // 节流：先等，等不起就丢
      let decision = throttler.check(now());
      if (!decision.allowed) {
        if (decision.waitMs > maxWaitMs) {
          log(
            `发送节流（${decision.reason ?? 'delay'}）：需等待 ${decision.waitMs} ms，` +
              `超过上限 ${maxWaitMs} ms，丢弃本条及后续 ${items.length - items.indexOf(item) - 1} 段`,
          );
          return;
        }
        log(`发送节流（${decision.reason ?? 'delay'}）：等待 ${decision.waitMs} ms`);
        await wait(decision.waitMs);
        decision = throttler.check(now());
        if (!decision.allowed) {
          log(`节流等待后仍不放行，丢弃本条（${decision.reason ?? 'delay'}）`);
          return;
        }
      }

      let result: SendResult;
      try {
        result = await deps.send(kind, openId, item);
      } catch (error) {
        log(`发送异常，停止后续发送：${describe(error)}`);
        return;
      }

      if (result.ok) {
        throttler.record(now());
        continue;
      }

      // msg_seq 撞去重是唯一「换个序号就能成功」的失败，值得重试一次
      if (result.kind === 'duplicate-seq' && result.retryable && item.msgSeq !== undefined) {
        const retry: OutboundMessage = { ...item, msgSeq: item.msgSeq + 1 };
        log(`msg_seq 冲突，用 ${retry.msgSeq} 重试一次`);
        let retried: SendResult;
        try {
          retried = await deps.send(kind, openId, retry);
        } catch (error) {
          log(`重试发送异常：${describe(error)}`);
          return;
        }
        if (retried.ok) {
          throttler.record(now());
          continue;
        }
        log(`重试仍失败（${retried.reason}），停止后续发送`);
        return;
      }

      log(`发送失败：${result.reason}`);
      if (!result.retryable) {
        // 不可重试（非群成员 / 被动窗口过期 / 内容违规）→ 后续段落也没意义
        return;
      }
      // 可重试的临时故障：本段放弃，继续尝试下一段
    }
  }

  return {
    async handleInbound(payload: unknown): Promise<void> {
      const config = deps.getConfig();

      const message = parseInboundEvent(payload, {
        ...(deps.getBotId !== undefined && deps.getBotId() !== null
          ? { botId: deps.getBotId() as string }
          : {}),
      });
      if (message === null) {
        return;
      }

      // 先记录来源（含未授权的），否则设置页的待授权列表永远是空的
      try {
        deps.recordContactSeen({
          openId: message.openId,
          kind: message.kind,
          displayName: message.senderName,
        });
      } catch (error) {
        log(`记录来源失败：${describe(error)}`);
      }

      const contact = deps.getContactPolicy(message.openId);
      const decision = authorizeInbound({
        config: {
          enabled: config.enabled,
          allowAllWhenEmpty: config.allowAllWhenEmpty,
          replyInPrivate: config.replyInPrivate,
          ownerOpenIds: config.ownerOpenIds,
        },
        message: {
          kind: message.kind,
          openId: message.openId,
          senderId: message.senderId,
          senderRole: message.senderRole,
          addressedToBot: message.addressedToBot,
        },
        contactPolicy: contact.policy,
        allowedCount: contact.allowedCount,
      });

      if (decision.action === 'ignore') {
        log(`忽略消息（${decision.reason}）：${decision.detail}`);
        return;
      }

      const markdown = await composeReply(message, decision.role);

      const plan = planReply({
        kind: message.kind,
        messageId: message.messageId,
        markdown,
        maxChars: config.maxReplyChars,
        auditEnabled: config.auditEnabled,
        ...(deps.knownSecrets !== undefined ? { knownSecrets: deps.knownSecrets() } : {}),
      });

      if (plan.status === 'blocked') {
        // 只记规则名与位置，**不记命中原文** —— 否则等于把要保护的秘密换个地方存
        log(
          `出站内容被拦截（未发送）：${plan.findings
            .map((finding) => `${finding.rule}@${finding.start}`)
            .join(', ')}`,
        );
        return;
      }
      if (plan.status === 'empty') {
        return;
      }

      await deliver(message.kind, message.openId, plan.items, getThrottle(config));
    },
  };
}

/**
 * 把任意抛出物转成可读文本。
 *
 * @param error 抛出物。
 * @returns 文本。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
