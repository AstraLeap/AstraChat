/**
 * 出站内容审计：QQ 回复**发送之前**的最后一道硬拦截。
 *
 * ## 为什么需要它
 *
 * 模型可能把不该外发的东西写进回复里，而 QQ 群是不可撤回的公共场所（官方接口只允许
 * 2 分钟内撤回，且已经被人看到）。威胁模型里最要命的两条是：
 *
 * 1. **把本机路径写出去** —— 泄露用户名、目录结构、内网共享名（`\\NAS\share`）。
 * 2. **把凭据复述出去** —— AstraChat 本身就在本机存着各提供商的 API Key 与 QQ
 *    AppSecret，模型完全有可能在解释配置时把它们抄出来。
 *
 * ## 两条互补的防线
 *
 * - **精确匹配（`known-secret`）**：调用方把**已知的**密钥原文传进来，命中即拦。
 *   这是最可靠的一层——没有猜测、零误报，直接针对「模型复述了我们自己的 Key」。
 *   太短的值（< {@link MIN_KNOWN_SECRET_LENGTH}）会被忽略，否则几乎任何文本都会命中。
 * - **启发式规则**：覆盖本机路径与**未知**凭据的常见写法，作为兜底。
 *
 * ## 为什么「凭据关键词必须带赋值关系」才判定
 *
 * 如果只要出现 `token` / `password` 这类词就拦，正常聊天会被大量误伤：
 * 「这个 token 怎么申请」「请把 password 字段留空」「token 过期了要重新登录」——
 * 这些一句都不是泄露。而拦截的后果是**整条消息不发**，用户只会觉得机器人突然哑了。
 *
 * 所以只在分隔符能明确表达「赋值」时才判定：
 *
 * | 分隔符 | 右侧要求 | 理由 |
 * |---|---|---|
 * | `:` `=` `：` | 任意非空白串（≥3 字符） | 显式赋值，本身就是技术写法 |
 * | `是` `为` | 必须像技术串 | 中文系词太常见，「token 是怎么生成的」必须放过 |
 * | 纯空白 | 必须像技术串（≥8 字符） | 「token 真难用」与「token abc12345def」的区别就在这 |
 *
 * 「像技术串」= `[A-Za-z0-9_\-./+=]`，中文字符天然不满足，因此中文句子不会误报。
 *
 * ## 审计结果本身不能存秘密
 *
 * {@link AuditFinding} 只给**规则名 + 位置 + 脱敏预览**，不保留命中原文。否则「把密钥
 * 写进日志」等于换个地方泄露。要记录被拦的回复时用 {@link redactForLog}，它会把敏感
 * 片段替换成占位符。
 *
 * ## 上游契约
 *
 * 本模块是**纯函数**，不做 I/O、不读配置。是否启用由 `qq_config.audit_enabled` 决定，
 * 调用方负责在 `auditEnabled === false` 时跳过审计（见 `docs/qq-integration-design.md` §6.4）。
 */

/** 审计规则标识。 */
export type AuditRuleId =
  /** 命中调用方传入的已知密钥原文。 */
  | 'known-secret'
  /** Windows 盘符路径（`C:\` / `D:/`）。 */
  | 'windows-path'
  /** UNC 网络共享路径（`\\host\share`）。 */
  | 'unc-path'
  /** Unix 本机路径（`/home/`、`/Users/`、`/etc/`、`/var/`、`/root/`）。 */
  | 'unix-path'
  /** 凭据关键词 + 显式赋值（`token: xxx`、`密码是 xxx`）。 */
  | 'credential-assignment'
  /** 凭据关键词 + 纯空白 + 技术串（`access_key abc12345def`）。 */
  | 'credential-technical'
  /** 裸的密钥形态（`sk-` 开头，OpenAI 风格）。 */
  | 'key-shape';

/** 一条命中记录。 */
export interface AuditFinding {
  /** 命中的规则。 */
  rule: AuditRuleId;
  /** 命中起点（按 UTF-16 码元，可直接用于 `slice`）。 */
  start: number;
  /** 命中终点（不含）。 */
  end: number;
  /**
   * **脱敏**预览：只保留前两个字符与总长度，绝不包含完整敏感值。
   *
   * 例：`sk…（共 18 字符）`。够用来判断「漏的是哪一类」，又不足以还原内容。
   */
  masked: string;
}

/** 审计选项。 */
export interface AuditOptions {
  /**
   * 已知的敏感值（各提供商的 API Key、QQ AppSecret 等）。
   *
   * 命中即拦，且**大小写敏感**（密钥区分大小写）。长度小于
   * {@link MIN_KNOWN_SECRET_LENGTH} 的条目会被忽略。
   */
  knownSecrets?: readonly string[];
  /** 是否检查本机路径，默认 `true`。 */
  checkPaths?: boolean;
  /** 是否检查凭据特征与已知密钥，默认 `true`。 */
  checkCredentials?: boolean;
}

/** 审计结果。 */
export interface AuditResult {
  /** 是否应当**整条不发送**。 */
  blocked: boolean;
  /** 命中明细，按位置升序。 */
  findings: AuditFinding[];
}

/** 已知密钥参与匹配的最短长度。太短会到处误命中。 */
export const MIN_KNOWN_SECRET_LENGTH = 8;

/** 「看起来像技术串」的字符集：中文字符不在此列，因此中文句子不会被误判。 */
const TECHNICAL_CHARS = 'A-Za-z0-9_\\-./+=';

/** 凭据关键词。`api key` / `api_key` / `api-key` 三种写法都认。 */
const CREDENTIAL_KEYWORD =
  '(?:token|密码|密钥|口令|私钥|凭据|password|passwd|secret|api[ _-]?key|authorization|bearer|access[ _-]?key|credential)';

/** 规则表。优先级越大越优先（重叠时保留优先级高的那条）。 */
const RULES: readonly { id: AuditRuleId; priority: number; pattern: RegExp }[] = [
  {
    id: 'windows-path',
    priority: 2,
    // 盘符前不能是字母/数字/斜杠，避免把 URL 里的 `s:/` 当成路径
    pattern: /(?<![A-Za-z0-9/\\])[A-Za-z]:[\\/][^\s"'<>|]+/g,
  },
  {
    id: 'unc-path',
    priority: 2,
    pattern: /\\\\[^\\\s"'<>|]+\\[^\\\s"'<>|]+/g,
  },
  {
    id: 'unix-path',
    priority: 2,
    // 前一个字符不能是字母/数字，避免 URL 里的 `/etc/`、`/Users/` 误命中
    pattern: /(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*/g,
  },
  {
    id: 'credential-assignment',
    priority: 1,
    // 显式赋值：冒号/等号右侧可以是任意非空白串（≥3 字符）
    pattern: new RegExp(
      `${CREDENTIAL_KEYWORD}\\s*[:=：]\\s*["']?[^\\s，。；、"'<>]{3,}`,
      'gi',
    ),
  },
  {
    id: 'credential-assignment',
    priority: 1,
    // 中文系词：右侧必须是技术串，否则「token 是怎么生成的」会被误拦
    pattern: new RegExp(
      `${CREDENTIAL_KEYWORD}\\s*(?:是|为)\\s*["']?[${TECHNICAL_CHARS}]{4,}`,
      'gi',
    ),
  },
  {
    id: 'credential-technical',
    priority: 1,
    // 纯空白分隔：右侧必须是较长的技术串，否则「token 真难用」会被误拦
    pattern: new RegExp(`${CREDENTIAL_KEYWORD}\\s+[${TECHNICAL_CHARS}]{8,}`, 'gi'),
  },
  {
    id: 'key-shape',
    priority: 1,
    // 裸的 OpenAI 风格密钥；`\b` 避免匹配 `task-abcdef...` 这类词中片段
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
  },
];

/** 内部候选命中。 */
interface RawMatch {
  rule: AuditRuleId;
  priority: number;
  start: number;
  end: number;
}

/**
 * 把敏感片段转成**可安全记录**的预览。
 *
 * 只保留前两个字符与总长度：足够判断「漏的是哪一类」，又不足以还原内容。
 *
 * @param value 原始片段。
 * @returns 脱敏预览。
 */
export function maskSensitive(value: string): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length === 0) {
    return '';
  }
  if (text.length <= 4) {
    return '•'.repeat(text.length);
  }
  return `${text.slice(0, 2)}…（共 ${text.length} 字符）`;
}

/**
 * 在文本里找出某个固定串的全部出现位置（大小写敏感）。
 *
 * @param text 被搜索的文本。
 * @param needle 要查找的串。
 * @param out 命中收集数组。
 */
function collectLiteral(text: string, needle: string, out: RawMatch[]): void {
  const trimmed = needle.trim();
  if (trimmed.length < MIN_KNOWN_SECRET_LENGTH) {
    return;
  }
  let from = 0;
  for (;;) {
    const index = text.indexOf(trimmed, from);
    if (index === -1) {
      return;
    }
    out.push({
      rule: 'known-secret',
      priority: 3,
      start: index,
      end: index + trimmed.length,
    });
    from = index + trimmed.length;
  }
}

/**
 * 用一条正则收集全部命中。
 *
 * 每次都新建 RegExp：带 `g` 的正则对象有 `lastIndex` 状态，在模块级复用会互相污染。
 *
 * @param text 被搜索的文本。
 * @param pattern 带 `g` 的正则模板。
 * @param rule 规则名。
 * @param priority 优先级。
 * @param out 命中收集数组。
 */
function collectPattern(
  text: string,
  pattern: RegExp,
  rule: AuditRuleId,
  priority: number,
  out: RawMatch[],
): void {
  const regex = new RegExp(pattern.source, pattern.flags);
  let match = regex.exec(text);
  while (match !== null) {
    if (match[0].length > 0) {
      out.push({ rule, priority, start: match.index, end: match.index + match[0].length });
    }
    match = regex.exec(text);
  }
}

/**
 * 合并重叠命中：同一段内容只报一条，保留优先级最高的。
 *
 * 典型场景是「已知密钥嵌在赋值里」（`token: <已知密钥>`）——精确匹配更有价值，
 * 所以它的优先级高于启发式规则。
 *
 * @param matches 原始命中。
 * @returns 去重后按位置升序的命中。
 */
function mergeOverlaps(matches: readonly RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort(
    (a, b) =>
      a.start - b.start ||
      b.priority - a.priority ||
      // 同优先级时长的优先，让报出的区间更完整
      b.end - b.start - (a.end - a.start),
  );

  const merged: RawMatch[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && current.start < last.end) {
      const better =
        current.priority > last.priority ||
        (current.priority === last.priority && current.end > last.end);
      if (better) {
        merged[merged.length - 1] = current;
      }
      continue;
    }
    merged.push(current);
  }
  return merged;
}

/**
 * 审计一段准备发往 QQ 的文本。
 *
 * @param text 待发送文本。
 * @param options 审计选项。
 * @returns 审计结果；`blocked` 为真时调用方应**整条不发送**。
 */
export function auditOutgoingText(text: string, options: AuditOptions = {}): AuditResult {
  const source = typeof text === 'string' ? text : '';
  if (source.length === 0) {
    return { blocked: false, findings: [] };
  }

  const checkPaths = options.checkPaths !== false;
  const checkCredentials = options.checkCredentials !== false;

  const matches: RawMatch[] = [];

  if (checkCredentials) {
    for (const secret of options.knownSecrets ?? []) {
      collectLiteral(source, secret, matches);
    }
  }

  for (const rule of RULES) {
    const isPathRule = rule.id === 'windows-path' || rule.id === 'unc-path' || rule.id === 'unix-path';
    if (isPathRule ? !checkPaths : !checkCredentials) {
      continue;
    }
    collectPattern(source, rule.pattern, rule.id, rule.priority, matches);
  }

  const findings: AuditFinding[] = mergeOverlaps(matches).map((match) => ({
    rule: match.rule,
    start: match.start,
    end: match.end,
    masked: maskSensitive(source.slice(match.start, match.end)),
  }));

  return { blocked: findings.length > 0, findings };
}

/**
 * 生成一份**可安全记录**的文本：把命中片段替换成占位符，其余原样保留。
 *
 * 用来记录「被拦了什么」，同时不把敏感内容写进日志。
 *
 * @param text 原始文本。
 * @param findings 审计结果里的命中列表。
 * @returns 脱敏后的文本。
 */
export function redactForLog(text: string, findings: readonly AuditFinding[]): string {
  const source = typeof text === 'string' ? text : '';
  // 从后往前替换：避免前面的替换改变了后面命中的下标
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  let result = source;
  for (const finding of ordered) {
    result = `${result.slice(0, finding.start)}[已拦截:${finding.rule}]${result.slice(finding.end)}`;
  }
  return result;
}
