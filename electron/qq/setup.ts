import * as repo from '../../src/db/index';
import { createQqConversation, promptKeyOf } from '../../src/services/qq/conversation';
import {
  SILENCE_INSTRUCTION,
  VERDICT_SYSTEM_PROMPT,
  createParticipationBudget,
  parseVerdict,
  readSentinelVerdict,
  stripSentinel,
  type ParticipationBudget,
} from '../../src/services/qq/participation';
import { createQqHistory } from '../../src/services/qq/history';
import { isRoleClearRequest, type QqCommand } from '../../src/services/qq/commands';
import { createQqDbPorts } from './adapters';
import { createQqCompleter, type QqProviderConfig } from './model';
import { createQqRuntime, type QqRuntime, type QqRuntimeHttp } from './runtime';

export type { QqRuntime };
import type { Db } from '../../src/db/index';
import type { QqInbound } from '../../src/services/qq/events';
import type { QqConfig, QqConnectionSnapshot } from '../../src/types/index';

/**
 * 把 QQ 的全部零件装配成可直接使用的运行时。
 *
 * ## 装配了什么
 *
 * ```
 * 数据库适配 ─┐
 * 对话历史   ─┼─→ runtime ─→ 连接（配置/HTTP/网关状态机）
 * 会话装配   ─┤           └→ 编排（授权 → 命令或模型 → 出站管线 → 发送）
 * 模型适配   ─┘
 * ```
 *
 * 这一层**不含任何判定逻辑**，只做连接与注入 —— 所有判断都在 `src/services/qq/`
 * 里那些有单测的纯函数里，所以这里读起来应该很直白。
 *
 * ## 管理命令为什么在这里执行
 *
 * `/reset` 要动历史、`/status` 要读连接状态 —— 这些都是本层持有的东西，
 * 所以由本层兑现 `executeCommand` 端口。**没有实现的命令如实说没实现**，
 * 而不是回一句含糊的「好的」把用户糊弄过去。
 */

/** 装配依赖。 */
export interface QqStackDeps {
  /** 数据库句柄。 */
  db: Db;
  /** 状态变化出口（由 IPC 层广播给界面）。 */
  onStatus: (status: QqConnectionSnapshot) => void;
  /**
   * 取系统提示词。
   *
   * @param message 入站消息（群聊与私聊可给不同人格）。
   * @returns 系统提示词。
   */
  getSystemPrompt: (message: QqInbound) => string;
  /** 日志出口。 */
  log?: (message: string) => void;
  /**
   * 覆盖模型提供商的选择（测试用）。
   *
   * 缺省从数据库取第一个可用提供商。做成可注入是为了让整条链路能在测试里跑通
   * ——否则必须先往库里塞一条 provider 记录。
   */
  getProvider?: () => QqProviderConfig | null;
  /** 覆盖 HTTP 客户端构造（测试用；缺省打正式环境）。 */
  createHttp?: (options: { appId: string; appSecret: string }) => QqRuntimeHttp;
}

/** 命令说明。 */
const COMMAND_HELP = [
  '可用命令：',
  '/status — 查看连接状态',
  '/reset — 清空本来源的对话上下文',
  '/help — 显示本说明',
].join('\n');

/**
 * 挑一个可用的模型提供商。
 *
 * 目前取列表里的第一个。**注意**：如果将来支持「默认提供商」标记，这里要跟着改 ——
 * 否则用户在界面上切换默认提供商后 QQ 侧不会生效。
 *
 * @param db 数据库句柄。
 * @returns 提供商配置；没有可用项时返回 `null`。
 */
function pickProvider(db: Db): QqProviderConfig | null {
  const first = repo.listProviders(db)[0];
  if (first === undefined) {
    return null;
  }
  if (first.baseUrl.trim().length === 0 || first.model.trim().length === 0) {
    return null;
  }
  return { baseUrl: first.baseUrl, apiKey: first.apiKey, model: first.model };
}

/**
 * 把连接状态说成一句人能懂的话。
 *
 * @param snapshot 状态快照。
 * @returns 描述文本。
 */
function describeStatus(snapshot: QqConnectionSnapshot): string {
  const label: Record<QqConnectionSnapshot['state'], string> = {
    stopped: '未连接',
    connecting: '连接中',
    connected: '已连接',
    error: '连接错误',
  };
  const bot = snapshot.botId !== null ? `，机器人 id ${snapshot.botId}` : '';
  const detail = snapshot.message.trim().length > 0 ? `\n${snapshot.message}` : '';
  return `状态：${label[snapshot.state]}${bot}${detail}`;
}

/**
 * 创建 QQ 运行时（全部依赖已装配）。
 *
 * @param deps 装配依赖。
 * @returns 运行时句柄。
 */
export function createQqStack(deps: QqStackDeps): QqRuntime {
  const log = deps.log ?? ((): void => undefined);
  const ports = createQqDbPorts(deps.db);
  const history = createQqHistory();
  const conversation = createQqConversation({
    history,
    getSystemPrompt: (message) => {
      const base = deps.getSystemPrompt(message);
      const config = ports.loadConfig();
      // 只有「标准模式的**背景**消息」才需要那段发言说明：
      // 被指向的消息必定回复（说明是多余的），EXP 模式由独立的判定调用负责。
      const needsInstruction = config.socialMode === 'standard' && !message.addressedToBot;
      return needsInstruction ? `${base}\n\n${SILENCE_INSTRUCTION}` : base;
    },
  });
  const completer = createQqCompleter({
    getProvider: deps.getProvider ?? (() => pickProvider(deps.db)),
    log,
  });

  /** 主动发言的冷却与预算；上限配置变了就重建。 */
  let budget: ParticipationBudget | null = null;
  let budgetKey = '';

  /**
   * 取发言预算，必要时按当前配置重建。
   *
   * 必须**在 setup 层持有**而不是每次调用新建 —— 后者每次都是全新状态，
   * 冷却与每小时上限会完全失效（而且测试很难发现，因为行为看起来「正常」）。
   *
   * @param config 当前配置。
   * @returns 预算实例。
   */
  function getBudget(config: QqConfig): ParticipationBudget {
    const key = `${config.socialCooldownMs}|${config.socialMaxPerHour}`;
    if (budget === null || budgetKey !== key) {
      budget = createParticipationBudget({
        cooldownMs: config.socialCooldownMs,
        maxPerHour: config.socialMaxPerHour,
      });
      budgetKey = key;
    }
    return budget;
  }

  /**
   * 正常生成一条回复并记进历史。
   *
   * @param key 来源键。
   * @param message 入站消息。
   * @returns 回复文本。
   */
  async function speak(key: string, message: QqInbound): Promise<string> {
    const messages = conversation.buildPrompt(message);
    const reply = await completer.complete(messages);
    conversation.rememberReply(key, reply);
    return reply;
  }

  /** 运行中的实例引用，供 `/status` 这类命令读取。 */
  let current: QqRuntime | null = null;

  const runtime = createQqRuntime({
    loadConfig: () => ports.loadConfig(),
    // 开启「让模型自行决定是否回复」时放行背景消息。
    // 用取值函数而不是固定值：用户在设置页切换模式后立即生效，不必重连。
    requireAddressInGroup: () => ports.loadConfig().socialMode === 'off',
    ...(deps.createHttp !== undefined ? { createHttp: deps.createHttp } : {}),
    lookupContact: (openId) => ports.lookupContact(openId),
    recordContactSeen: (input) => ports.recordContactSeen(input),

    generateReply: async (key, message) => {
      const config = ports.loadConfig();
      const mode = config.socialMode;

      // 被 @ 或私聊 → **必定回复**：不做判定、也不占主动发言额度。
      // 被叫到不回是社交事故；而且这样只有背景消息才付判定成本。
      if (mode === 'off' || message.addressedToBot) {
        return await speak(key, message);
      }

      const judge = getBudget(config);
      const now = Date.now();
      const allowed = judge.check(key, now);
      if (!allowed.allowed) {
        log(`不主动发言：${allowed.reason}`);
        return '';
      }

      if (mode === 'standard') {
        // 标准模式：单次调用 + 哨兵。发言说明已由 conversation 拼进系统提示词。
        const messages = conversation.buildPrompt(message);
        const raw = await completer.complete(messages);
        const verdict = readSentinelVerdict(raw);
        if (!verdict.speak) {
          log(`不主动发言：${verdict.reason}`);
          return '';
        }
        judge.record(key, now);
        // 清掉正文里偶现的哨兵字样，避免它跟着回复被发到群里
        const text = stripSentinel(raw);
        conversation.rememberReply(key, text);
        return text;
      }

      // EXP 实验性模式：先判定、再生成。
      // **同一个 messages 用于两次调用**，避免把当前消息记两遍
      // （`buildPrompt` 已经把它写进历史了）。
      const messages = conversation.buildPrompt(message);
      const verdictRaw = await completer.complete([
        { role: 'system', content: VERDICT_SYSTEM_PROMPT },
        // 判定不需要人格设定，去掉原来的 system，只留对话与当前这条
        ...messages.filter((item) => item.role !== 'system'),
      ]);
      const verdict = parseVerdict(verdictRaw);
      if (!verdict.speak) {
        log(`不主动发言：${verdict.reason}`);
        return '';
      }

      judge.record(key, now);
      const reply = await completer.complete(messages);
      conversation.rememberReply(key, reply);
      return reply;
    },

    executeCommand: async (command: QqCommand, message: QqInbound): Promise<string> => {
      const key = promptKeyOf(message);
      switch (command.name) {
        case 'help':
          return COMMAND_HELP;
        case 'reset':
          conversation.reset(key);
          return '已清空本来源的对话上下文。';
        case 'status':
          return current === null ? '状态：未连接' : describeStatus(current.getStatus());
        case 'role':
          // 如实说没实现，而不是回一句「好的」把用户糊弄过去
          return command.argument !== null && !isRoleClearRequest(command.argument)
            ? `人格切换尚未实现（收到「${command.argument}」）。`
            : '人格切换尚未实现。';
        case 'silent':
        case 'active':
          return `/${command.name} 尚未实现。`;
        default:
          return '该命令尚未实现。';
      }
    },

    onStatus: (status) => {
      // 状态同时落库（重开应用后仍可见）与广播（界面实时更新）
      try {
        ports.persistStatus(status);
      } catch (error) {
        log(`QQ 状态落库失败：${error instanceof Error ? error.message : String(error)}`);
      }
      deps.onStatus(status);
    },

    log,
  });

  current = runtime;
  return runtime;
}
