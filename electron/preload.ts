import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type AstraApi } from '../src/types/ipc';
import type { ChatStreamEvent } from '../src/types/index';

/**
 * 预加载脚本：把主进程能力以**最小可用面**暴露给渲染进程。
 *
 * 安全约束：渲染进程沙箱化（`sandbox: true` + `contextIsolation: true`），本文件是
 * 它与主进程之间唯一的桥。这里**只暴露 `AstraApi` 约定的方法**，绝不暴露
 * `ipcRenderer` 本身 —— 否则渲染层就能往任意通道发消息，桥接形同虚设。
 */

/**
 * 构造暴露给渲染进程的 API 对象。
 *
 * @returns 符合 {@link AstraApi} 的对象。
 */
function createApi(): AstraApi {
  return {
    app: {
      info: () => ipcRenderer.invoke(IPC_CHANNELS.app.info),
    },
    providers: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.providers.list),
      create: (input) => ipcRenderer.invoke(IPC_CHANNELS.providers.create, input),
      update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.providers.update, id, patch),
      remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.providers.remove, id),
    },
    conversations: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.conversations.list),
      get: (id) => ipcRenderer.invoke(IPC_CHANNELS.conversations.get, id),
      create: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversations.create, input),
      update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.conversations.update, id, patch),
      remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.conversations.remove, id),
      search: (keyword) => ipcRenderer.invoke(IPC_CHANNELS.conversations.search, keyword),
    },
    messages: {
      list: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.messages.list, conversationId),
      create: (input) => ipcRenderer.invoke(IPC_CHANNELS.messages.create, input),
      update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.messages.update, id, patch),
      remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.messages.remove, id),
    },
    personas: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.personas.list),
      create: (input) => ipcRenderer.invoke(IPC_CHANNELS.personas.create, input),
      update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.personas.update, id, patch),
      remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.personas.remove, id),
    },
    qq: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.qq.get),
      save: (patch) => ipcRenderer.invoke(IPC_CHANNELS.qq.save, patch),
    },
    chat: {
      send: (request) => ipcRenderer.invoke(IPC_CHANNELS.chat.send, request),
      abort: (streamId) => ipcRenderer.invoke(IPC_CHANNELS.chat.abort, streamId),
      onEvent: (listener) => {
        /**
         * 只转发事件负载，不把 Electron 的 `IpcRendererEvent` 泄漏给渲染层
         * （它带有 `sender` 等可用于越权的引用）。
         */
        const handler = (_event: unknown, payload: ChatStreamEvent): void => {
          listener(payload);
        };
        ipcRenderer.on(IPC_CHANNELS.chat.event, handler);
        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.chat.event, handler);
        };
      },
    },
  };
}

contextBridge.exposeInMainWorld('astra', createApi());
