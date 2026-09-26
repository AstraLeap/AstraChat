/**
 * 管理命令的判定（纯逻辑）。
 *
 * ## 这是硬边界，不是「提示词约束」
 *
 * 设计 §6.3 的要求：**管理命令由程序直接执行，不经过模型**；群友的斜杠命令必须被程序
 * 拦下。原因是——只要斜杠命令进了模型，群友就能用话术尝试让模型「扮演」管理员去执行动作；
 * 把判定放在程序层，话术诱导在设计上就不可能生效。
 *
 * ## 一条容易被忽略但很关键的决定
 *
 * **所有以斜杠开头的消息都不进模型**，无论这个命令认不认识。
 * 把一个不认识的 `/xxx` 交给模型，等于把「命令语法」本身变成了一条提示词注入通道
 * —— 攻击者可以构造 `/ignore previous instructions` 这类内容直接抵达模型。
 *
 * 代价是「/etc/passwd 是什么」这类以斜杠开头的正常提问也会被当成命令拦掉。
 * 这是**有意接受**的：拦截是确定性的、可解释的（会回复用法提示），而注入通道是隐蔽的。
 *
 * ## 判定顺序
 *
 * ```
 * 不是斜杠消息 → chat（正常聊天）
 * 是斜杠消息 + 群友      → reject（先按权限拒绝，不区分认不认识）
 * 是斜杠消息 + 管理员    → 认识 → execute ／ 不认识 → unknown
 * ```
 */

/** 半角斜杠。 */
const SLASH = '/';

/** 全角斜杠（U+FF0F）—— 中文输入法下很常见，用户不该为这个踩坑。 */
const FULLWIDTH_SLASH = '\uFF0F';

/** 支持的管理命令名。 */
export const COMMAND_NAMES = ['status', 'reset', 'silent', 'active', 'role', 'help'] as const;

/** 管理命令名类型。 */
export type QqCommandName = (typeof COMMAND_NAMES)[number];

/**
 * `/role` 里表示「清除角色」的写法。
 *
 * 用一组词而不是只认 `off`，是因为用户可能写成 `none` 或中文。全部按小写比较。
 */
export const ROLE_CLEAR_TOKENS = ['off', 'none', '清除', '取消'] as const;

/** 解析出来的命令。 */
export interface QqCommand {
  /** 命令名。 */
  name: QqCommandName;
  /** 参数（已去首尾空白）；没有参数时为 `null`。 */
  argument: string | null;
  /** 原始文本（已 trim），便于回显与日志。 */
  raw: string;
}

/** 命令判定结果。 */
export type CommandDecision =
  /** 不是命令 → 走正常聊天链路。 */
  | { action: 'chat' }
  /** 是命令且发送者是管理员 → 由程序执行，**不经过模型**。 */
  | { action: 'execute'; command: QqCommand }
  /** 是命令但发送者不是管理员 → 拦下，既不执行也不交给模型。 */
  | { action: 'reject'; reason: string }
  /** 是斜杠消息但命令不合法/不认识 → 拦下，不交给模型。 */
  | { action: 'unknown'; reason: string; raw: string };

/**
 * 判断参数是不是「清除角色」。
 *
 * @param argument `/role` 的参数。
 * @returns 是清除请求返回 `true`。
 */
export function isRoleClearRequest(argument: string | null): boolean {
  if (typeof argument !== 'string') {
    return false;
  }
  const normalized = argument.trim().toLowerCase();
  return (ROLE_CLEAR_TOKENS as readonly string[]).includes(normalized);
}

/**
 * 判定一条消息是不是管理命令、以及该怎么处理。
 *
 * @param content 消息正文（官方已去掉 @ 前缀）。
 * @param role 发送者的权限分层（来自 {@link import('./authorization').authorizeInbound}）。
 * @returns 判定结果。
 */
export function resolveCommand(content: string, role: 'owner' | 'member'): CommandDecision {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (raw.length === 0) {
    return { action: 'chat' };
  }

  const first = raw.slice(0, 1);
  if (first !== SLASH && first !== FULLWIDTH_SLASH) {
    return { action: 'chat' };
  }

  // 命令名取到第一个空白为止，其余整体作为参数（含换行，不擅自丢内容）
  const body = raw.slice(1);
  const match = /^(\S*)\s*([\s\S]*)$/.exec(body);
  const name = (match?.[1] ?? '').toLowerCase();
  const argument = (match?.[2] ?? '').trim();

  // 群友的任何斜杠消息都先按权限拒绝 —— 与「认不认识这个命令」无关
  if (role !== 'owner') {
    return { action: 'reject', reason: '只有管理员可以使用管理命令' };
  }

  if (!(COMMAND_NAMES as readonly string[]).includes(name)) {
    return {
      action: 'unknown',
      reason:
        name.length === 0
          ? `无法识别的命令：${raw}`
          : `未知命令 /${name}，可用：${COMMAND_NAMES.map((item) => `/${item}`).join(' ')}`,
      raw,
    };
  }

  if (name === 'role' && argument.length === 0) {
    return { action: 'unknown', reason: '用法：/role <角色名>，或 /role off 清除角色', raw };
  }

  return {
    action: 'execute',
    command: {
      name: name as QqCommandName,
      argument: argument.length > 0 ? argument : null,
      raw,
    },
  };
}
