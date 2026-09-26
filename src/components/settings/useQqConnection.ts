import { useCallback, useEffect, useState } from 'react';
import type { AstraApi } from '../../types/ipc';
import type { QqConnectionSnapshot } from '../../types/index';

/**
 * 订阅 QQ 真实连接状态。
 *
 * ## 为什么单独抽一个 hook
 *
 * 连接状态有**两个来源**，用途不同，混用是之前「已连接（模拟）」那种假状态的根源：
 *
 * | 来源 | 内容 | 特点 |
 * |---|---|---|
 * | `QqConfig.status` | 落库的粗粒度状态 + 说明 | 跨重启保留，但**可能过期** |
 * | 本 hook 的 `status` | 运行期实时快照 | 准确，但每次启动从零开始 |
 *
 * 界面上要显示「现在到底连上没有」必须用**实时快照**；落库那份只适合在从未连接过时
 * 当初始值。所以这个 hook 在挂载时先用 `status()` 取一次当前值（覆盖「连接是在上次
 * 会话里建立的」这种情况），之后完全靠 `onStatus()` 推送。
 *
 * ## 为什么不用 store
 *
 * 连接状态是**主进程的单例状态**，不是界面状态：多个组件同时订阅应该看到同一份推送。
 * 放进每次挂载都会重建的组件局部 state 里恰好符合这一点（推送源只有一个），
 * 而塞进全局 store 反而会出现「退出设置页再进来，状态就丢了」的问题。
 */

/** 未连接时的初始快照（与主进程的应答保持一致）。 */
const IDLE: QqConnectionSnapshot = { state: 'stopped', message: '未连接', botId: null };

/** hook 返回值。 */
export interface UseQqConnectionResult {
  /** 实时连接状态。 */
  status: QqConnectionSnapshot;
  /** 是否正在执行连接/断开（用于按钮 loading）。 */
  busy: boolean;
  /** 启动连接。 */
  connect: () => Promise<void>;
  /** 停止连接。 */
  disconnect: () => Promise<void>;
}

/**
 * 取渲染进程的 `window.astra`。
 *
 * 项目里没有 DOM 的 `window` 类型声明，统一用这个取值方式（见 `src/stores/bridge.ts`）。
 *
 * @returns API 对象；预加载尚未注入时为 `undefined`。
 */
function getApi(): AstraApi['qq'] | undefined {
  return (globalThis as unknown as { astra?: AstraApi }).astra?.qq;
}

/**
 * 订阅 QQ 连接状态。
 *
 * @returns 状态与连接/断开操作。
 */
export function useQqConnection(): UseQqConnectionResult {
  const [status, setStatus] = useState<QqConnectionSnapshot>(IDLE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = getApi();
    if (api === undefined) {
      return;
    }

    let alive = true;
    // 先取一次当前值：连接可能是上个界面/上次会话里建立的
    void api
      .status()
      .then((snapshot) => {
        if (alive) {
          setStatus(snapshot);
        }
      })
      .catch(() => undefined);

    const unsubscribe = api.onStatus((snapshot) => {
      if (alive) {
        setStatus(snapshot);
      }
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    const api = getApi();
    if (api === undefined) {
      return;
    }
    setBusy(true);
    try {
      setStatus(await api.connect());
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    const api = getApi();
    if (api === undefined) {
      return;
    }
    setBusy(true);
    try {
      setStatus(await api.disconnect());
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, connect, disconnect };
}
