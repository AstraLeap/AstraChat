import type { AstraApi } from '../types/ipc';

/**
 * 渲染进程访问主进程能力的唯一入口。
 *
 * `window.astra` 由 `electron/preload.ts` 通过 `contextBridge` 注入。渲染进程开启了
 * `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，没有任何
 * Node 权限，因此所有数据读写都必须走这个对象。
 *
 * 为什么要包一层而不是直接写 `window.astra.xxx`：
 * 1. 在纯浏览器里跑 `vite dev`（不经 Electron）时 `window.astra` 不存在，集中在这里
 *    抛出一条可读的错误，比在几十处 `undefined is not an object` 里排查容易得多。
 * 2. 便于以后加统一的错误归一化与埋点。
 */

/**
 * 以类型安全的方式取出宿主注入的桥接对象。
 *
 * 这里刻意使用 `globalThis` 而**不是**裸 `window` 标识符。渲染进程里两者本就是同一个
 * 对象，但 `src/stores/**` 同时也会进入 Node 侧的类型检查程序
 * （`tsconfig.node.json`，其 `lib` 不含 DOM）—— 因为 `tests/**` 会 import store。
 * 裸 `window` 在那里会直接报 `TS2304: Cannot find name 'window'`。
 * 用 `globalThis` + 显式断言，同一份代码就能在两种 lib 环境下都通过类型检查。
 *
 * @returns 桥接对象；不可用时返回 `undefined`。
 */
function hostBridge(): AstraApi | undefined {
  const host = globalThis as unknown as { astra?: AstraApi };
  return typeof host.astra === 'object' && host.astra !== null ? host.astra : undefined;
}

/**
 * 判断当前是否运行在 Electron 宿主中（即预加载桥接是否可用）。
 *
 * 用于 UI 在浏览器预览模式下显示降级提示，而不是直接崩溃。
 *
 * @returns 桥接可用返回 `true`。
 */
export function hasBridge(): boolean {
  return hostBridge() !== undefined;
}

/**
 * 获取预加载桥接对象；不可用时抛出可读错误。
 *
 * @returns `window.astra`。
 * @throws 当页面未运行在 Electron 中时抛出 `Error`。
 */
export function getBridge(): AstraApi {
  const bridge = hostBridge();
  if (!bridge) {
    throw new Error(
      'AstraChat 桥接不可用：window.astra 不存在。请通过 `npm run dev` 或 `npm start` 以 Electron 方式启动，而不是直接在浏览器里打开。',
    );
  }
  return bridge;
}

/**
 * 把任意异常归一化成便于展示的中文错误文案。
 *
 * Electron 的 `ipcRenderer.invoke` 在远端抛错时会得到形如
 * `Error invoking remote method 'providers:list': Error: xxx` 的信息，这里剥掉前缀。
 *
 * @param error 捕获到的异常。
 * @returns 可直接显示的文案。
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
  return stripped.trim() || '未知错误';
}
