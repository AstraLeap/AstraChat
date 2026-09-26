/**
 * 渲染进程的全局类型补充。
 */

import type { AstraApi } from './types/ipc';

declare global {
  interface Window {
    /**
     * 由 `electron/preload.ts` 通过 `contextBridge` 注入。
     *
     * 注意：在浏览器里直接跑 `vite dev`（不经 Electron）时这个对象不存在，
     * 因此 `src/stores` 层统一通过 `src/stores/bridge.ts` 访问并做可用性检查。
     */
    astra: AstraApi;
  }
}

export {};
