import { countQqContactsByPolicy, getQqContact, recordQqContactSeen } from '../../src/db/qq-contacts';
import { getQqConfig, saveQqConfig } from '../../src/db/qq';
import { toPersistedStatus } from '../../src/services/qq/status';
import type { Db } from '../../src/db/index';
import type { QqConfig, QqConnectionSnapshot, QqContactPolicy } from '../../src/types/index';

/**
 * QQ 运行时需要的数据访问能力（数据库适配层）。
 *
 * ## 这一层薄的刻意的
 *
 * `electron/qq/runtime.ts` 只声明「我需要什么」（读配置、查授权、记来源、落状态），
 * 由调用方注入。这个模块就是把那些声明**逐个绑到具体的数据库函数上** —— 因此它几乎
 * 不含分支，也不含任何判定逻辑：所有判断都在 `src/services/qq/` 里那些有单测的纯函数里。
 *
 * ## 三个绑定里值得说明的地方
 *
 * 1. **`lookupContact` 同时返回 `allowedCount`。** 授权判定需要「白名单是不是空的」来决定
 *    `allowAllWhenEmpty` 是否生效。若分两次查（先查来源再查总数）会有并发下的不一致窗口，
 *    所以这里一次性取。
 * 2. **`persistStatus` 经过 `toPersistedStatus` 转换。** 运行期状态（4 值，含 `connecting`）
 *    与落库状态（3 值）不是一回事，直接赋值会把瞬时的 `connecting` 写进库，
 *    下次启动就会显示「正在连接」而那时根本没在连接。转换逻辑在纯函数里并有单测。
 * 3. **`recordContactSeen` 直接透传。** 「见过就记下来（默认未授权）」是设置页待授权
 *    列表的唯一来源，因此**未授权来源也必须记**（判定由调用方在授权之前执行）。
 */

/** 数据库适配层提供的能力。 */
export interface QqDbPorts {
  /** 读 QQ 配置。 */
  loadConfig: () => QqConfig;
  /**
   * 把运行期状态落库。
   *
   * @param snapshot 运行期快照。
   */
  persistStatus: (snapshot: QqConnectionSnapshot) => void;
  /**
   * 查来源的授权状态与当前已授权数量。
   *
   * @param openId 来源 openid。
   * @returns 三态授权状态与 `allow` 数量。
   */
  lookupContact: (openId: string) => { policy: QqContactPolicy; allowedCount: number };
  /**
   * 记录「见过这个来源」。
   *
   * @param input 来源信息。
   */
  recordContactSeen: (input: {
    openId: string;
    kind: 'group' | 'private';
    displayName?: string | null;
  }) => void;
}

/**
 * 把数据库函数绑成运行时端口。
 *
 * @param db 数据库句柄。
 * @returns 适配层。
 */
export function createQqDbPorts(db: Db): QqDbPorts {
  return {
    loadConfig: () => getQqConfig(db),

    persistStatus: (snapshot) => {
      const { status, statusMessage } = toPersistedStatus(snapshot);
      saveQqConfig(db, { status, statusMessage });
    },

    lookupContact: (openId) => {
      const contact = getQqContact(db, openId);
      const counts = countQqContactsByPolicy(db);
      return {
        // 没见过就是未授权（fail-closed）
        policy: contact?.policy ?? 'none',
        allowedCount: counts.allow,
      };
    },

    recordContactSeen: (input) => {
      recordQqContactSeen(db, input);
    },
  };
}
