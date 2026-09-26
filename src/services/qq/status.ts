import type { QqConnectionSnapshot, QqConnectionState, QqConnectionStatus } from '../../types/index';

export type { QqConnectionSnapshot, QqConnectionState };

/**
 * 连接状态：**运行期快照** → **落库形态**。
 *
 * ## 为什么需要这层映射（以及为什么这里有两种「状态」）
 *
 * 项目里有两个含义不同的状态概念，**它们曾经同名**，非常容易混：
 *
 * | 类型 | 取值 | 用途 |
 * |---|---|---|
 * | {@link QqConnectionStatus} | `disconnected` / `connected` / `error` | **落库**（`QqConfig.status`） |
 * | {@link QqConnectionSnapshot} | `stopped` / `connecting` / `connected` / `error` | **运行期**快照 |
 *
 * 差异有两处，都不是笔误：
 *
 * 1. 运行期多一个 {@link QqConnectionState} 的 `connecting` —— 落库的联合类型里没有它。
 * 2. 「用户主动停止」在运行期叫 `stopped`，落库叫 `disconnected`。
 *
 * 所以**不能直接赋值**，必须显式映射。本模块就是那个映射，并且把
 * 「运行期快照」定义为这里的规范类型（它不属于 I/O，属于领域概念）。
 */

/** 落库结果。 */
export interface PersistedStatus {
  /** 写回 `qq_config.status`。 */
  status: QqConnectionStatus;
  /** 写回 `qq_config.status_message`。 */
  statusMessage: string;
}

/**
 * 运行期状态 → 落库状态。
 *
 * ## 为什么 `connecting` 落库成 `disconnected`
 *
 * `connecting` 是**瞬时态**。若照原样落库，下次启动应用时会显示「正在连接」——
 * 而那时根本没有在连接，用户会以为卡住了。详细信息由 `statusMessage` 保留
 * （这正是 `statusMessage` 这个字段存在的意义：把粗粒度状态与细粒度说明分开）。
 *
 * ## 为什么 `botId` 不落库
 *
 * 它来自 READY，是**会话期的临时信息**：换了凭证或换了机器人就失效，
 * 存下来只会在界面上显示一个过期的名字。需要时重新连接即可拿到。
 *
 * @param snapshot 运行期快照。
 * @returns 可直接写入 `qq_config` 的状态与说明。
 */
export function toPersistedStatus(snapshot: QqConnectionSnapshot): PersistedStatus {
  const fallback =
    snapshot.message.trim().length > 0 ? snapshot.message : DEFAULT_MESSAGES[snapshot.state];

  switch (snapshot.state) {
    case 'connected':
      return { status: 'connected', statusMessage: fallback };
    case 'error':
      return { status: 'error', statusMessage: fallback };
    case 'connecting':
    case 'stopped':
    default:
      // connecting 是瞬时态，不能落库成「连接中」；stopped 与落库的 disconnected 同义
      return { status: 'disconnected', statusMessage: fallback };
  }
}

/** 状态对应的兜底说明（`message` 为空时用）。 */
const DEFAULT_MESSAGES: Record<QqConnectionState, string> = {
  stopped: '未连接',
  connecting: '正在连接 QQ 网关…',
  connected: '已连接',
  error: '连接出错',
};
