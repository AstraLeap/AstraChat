import { app, ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../src/types/ipc';
import type {
  AppInfo,
  ChatSendRequest,
  CreateConversationInput,
  CreateMessageInput,
  CreatePersonaInput,
  CreateProviderInput,
  UpdateConversationInput,
  UpdateMessageInput,
  UpdatePersonaInput,
  UpdateProviderInput,
  UpdateQqConfigInput,
} from '../src/types/index';
import * as repo from '../src/db/index';
import type { Db } from '../src/db/index';
import { abortStream, startStream } from './chat';

/**
 * 主进程侧的全部 IPC handler 注册。
 *
 * 约定：
 * - 一律用 `ipcMain.handle`（请求-响应），只有流式事件是主进程主动 push。
 * - handler **只返回裸业务值**；出错就让它抛，`invoke` 会自动把错误转成渲染层的
 *   rejected Promise。不要在这里包 `{ ok, value }`，否则渲染层要写两套判断。
 * - 每个 handler 都对入参做最小校验（类型/非空），避免渲染层被 XSS 之外的意外输入
 *   写坏数据库。
 */

/** 注册 handler 所需的依赖。 */
export interface IpcDeps {
  /** 数据库句柄。 */
  db: Db;
  /** 获取当前主窗口（用于流式事件推送）。 */
  getWindow: () => BrowserWindow | null;
}

/**
 * 断言某个入参是非空字符串。
 *
 * @param value 待校验的值。
 * @param label 用于报错的字段名。
 * @returns 原字符串。
 * @throws 校验失败时抛出 `Error`。
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`参数「${label}」必须是非空字符串`);
  }
  return value;
}

/**
 * 断言某个入参是对象。
 *
 * @param value 待校验的值。
 * @param label 用于报错的字段名。
 * @returns 原对象。
 * @throws 校验失败时抛出 `Error`。
 */
function requireObject<T extends object>(value: unknown, label: string): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`参数「${label}」必须是对象`);
  }
  return value as T;
}

/**
 * 注册全部 IPC handler。
 *
 * @param deps 依赖。
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  const { db } = deps;

  // ---------------------------------------------------------------- app

  ipcMain.handle(IPC_CHANNELS.app.info, (): AppInfo => {
    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? 'unknown',
      userDataDir: app.getPath('userData'),
    };
  });

  // ---------------------------------------------------------- providers

  ipcMain.handle(IPC_CHANNELS.providers.list, () => repo.listProviders(db));

  ipcMain.handle(IPC_CHANNELS.providers.create, (_event, input: unknown) =>
    repo.createProvider(db, requireObject<CreateProviderInput>(input, 'input')),
  );

  ipcMain.handle(IPC_CHANNELS.providers.update, (_event, id: unknown, patch: unknown) =>
    repo.updateProvider(
      db,
      requireString(id, 'id'),
      requireObject<UpdateProviderInput>(patch, 'patch'),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.providers.remove, (_event, id: unknown) => {
    repo.removeProvider(db, requireString(id, 'id'));
  });

  // ------------------------------------------------------ conversations

  ipcMain.handle(IPC_CHANNELS.conversations.list, () => repo.listConversations(db));

  ipcMain.handle(IPC_CHANNELS.conversations.get, (_event, id: unknown) =>
    repo.getConversation(db, requireString(id, 'id')),
  );

  ipcMain.handle(IPC_CHANNELS.conversations.create, (_event, input: unknown) =>
    repo.createConversation(db, (input ?? {}) as CreateConversationInput),
  );

  ipcMain.handle(IPC_CHANNELS.conversations.update, (_event, id: unknown, patch: unknown) =>
    repo.updateConversation(
      db,
      requireString(id, 'id'),
      requireObject<UpdateConversationInput>(patch, 'patch'),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.conversations.remove, (_event, id: unknown) => {
    repo.removeConversation(db, requireString(id, 'id'));
  });

  ipcMain.handle(IPC_CHANNELS.conversations.search, (_event, keyword: unknown) =>
    repo.searchConversations(db, typeof keyword === 'string' ? keyword : ''),
  );

  // ----------------------------------------------------------- messages

  ipcMain.handle(IPC_CHANNELS.messages.list, (_event, conversationId: unknown) =>
    repo.listMessages(db, requireString(conversationId, 'conversationId')),
  );

  ipcMain.handle(IPC_CHANNELS.messages.create, (_event, input: unknown) =>
    repo.createMessage(db, requireObject<CreateMessageInput>(input, 'input')),
  );

  ipcMain.handle(IPC_CHANNELS.messages.update, (_event, id: unknown, patch: unknown) =>
    repo.updateMessage(
      db,
      requireString(id, 'id'),
      requireObject<UpdateMessageInput>(patch, 'patch'),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.messages.remove, (_event, id: unknown) => {
    repo.removeMessage(db, requireString(id, 'id'));
  });

  // ----------------------------------------------------------- personas

  ipcMain.handle(IPC_CHANNELS.personas.list, () => repo.listPersonas(db));

  ipcMain.handle(IPC_CHANNELS.personas.create, (_event, input: unknown) =>
    repo.createPersona(db, requireObject<CreatePersonaInput>(input, 'input')),
  );

  ipcMain.handle(IPC_CHANNELS.personas.update, (_event, id: unknown, patch: unknown) =>
    repo.updatePersona(
      db,
      requireString(id, 'id'),
      requireObject<UpdatePersonaInput>(patch, 'patch'),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.personas.remove, (_event, id: unknown) => {
    repo.removePersona(db, requireString(id, 'id'));
  });

  // ---------------------------------------------------------------- qq

  ipcMain.handle(IPC_CHANNELS.qq.get, () => repo.getQqConfig(db));

  ipcMain.handle(IPC_CHANNELS.qq.save, (_event, patch: unknown) =>
    repo.saveQqConfig(db, requireObject<UpdateQqConfigInput>(patch, 'patch')),
  );

  // -------------------------------------------------------------- chat

  ipcMain.handle(IPC_CHANNELS.chat.send, (_event, request: unknown) =>
    startStream(
      { db, getWindow: deps.getWindow },
      requireObject<ChatSendRequest>(request, 'request'),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.chat.abort, (_event, streamId: unknown) => {
    abortStream(requireString(streamId, 'streamId'));
  });
}
