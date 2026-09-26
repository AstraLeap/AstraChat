import { app, ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../src/types/ipc';
import type {
  AppInfo,
  ChatSendRequest,
  CreateConversationInput,
  CreateMessageInput,
  CreatePersonaInput,
  CreateProviderInput,
  ListQqContactsFilter,
  QqContactPolicy,
  UpdateConversationInput,
  UpdateMessageInput,
  UpdatePersonaInput,
  UpdateProviderInput,
  UpdateQqConfigInput,
  UpdateQqContactInput,
} from '../src/types/index';
import * as repo from '../src/db/index';
import type { Db } from '../src/db/index';
import { abortStream, startStream } from './chat';
import { createQqConnection, type QqConnection } from './qq/connection';
import { createQqHttp } from './qq/http';
import type { QqConnectionSnapshot } from '../src/types/index';

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

/** QQ 来源授权状态的合法取值。 */
const QQ_CONTACT_POLICIES: readonly QqContactPolicy[] = ['none', 'allow', 'deny'];

/**
 * 断言入参是合法的来源授权状态。
 *
 * 必须白名单校验：授权状态直接决定「消息要不要投给模型」，是安全边界，
 * 不能让渲染层塞任意字符串（数据库的 CHECK 约束也会拦，但错误信息不如这里清楚）。
 *
 * @param value 待校验的值。
 * @returns 合法的授权状态。
 * @throws 校验失败时抛出 `Error`。
 */
function requireQqContactPolicy(value: unknown): QqContactPolicy {
  if (typeof value !== 'string' || !QQ_CONTACT_POLICIES.includes(value as QqContactPolicy)) {
    throw new Error(`参数「policy」必须是 ${QQ_CONTACT_POLICIES.join(' / ')} 之一`);
  }
  return value as QqContactPolicy;
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

  // 已发现的来源（群 / 私聊）及其授权。官方 API 只给 openid，来源是「发现」来的，
  // 所以这里提供的是列表 + 逐条授权，而不是让用户填群号。
  ipcMain.handle(IPC_CHANNELS.qq.contactsList, (_event, filter: unknown) =>
    repo.listQqContacts(db, (filter ?? {}) as ListQqContactsFilter),
  );

  ipcMain.handle(
    IPC_CHANNELS.qq.contactsSetPolicy,
    (_event, openId: unknown, policy: unknown) =>
      repo.setQqContactPolicy(
        db,
        requireString(openId, 'openId'),
        requireQqContactPolicy(policy),
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.qq.contactsUpdate,
    (_event, openId: unknown, patch: unknown) =>
      repo.updateQqContact(
        db,
        requireString(openId, 'openId'),
        requireObject<UpdateQqContactInput>(patch, 'patch'),
      ),
  );

  ipcMain.handle(IPC_CHANNELS.qq.contactsRemove, (_event, openId: unknown) => {
    repo.removeQqContact(db, requireString(openId, 'openId'));
  });

  ipcMain.handle(IPC_CHANNELS.qq.contactsCounts, () => repo.countQqContactsByPolicy(db));

  // --------------------------------------------------------- qq 真实连接

  /** 惰性创建的 QQ 连接；未点「连接」前不建立，避免无意义的重连循环。 */
  let qqConnection: QqConnection | null = null;

  /** 未连接时的状态应答。 */
  const IDLE_SNAPSHOT: QqConnectionSnapshot = {
    state: 'stopped',
    message: '未连接',
    botId: null,
  };

  /**
   * 把状态推给渲染进程。
   *
   * @param status 状态快照。
   */
  function broadcastQqStatus(status: QqConnectionSnapshot): void {
    const win = deps.getWindow();
    if (win === null || win.isDestroyed()) {
      return;
    }
    win.webContents.send(IPC_CHANNELS.qq.statusEvent, status);
  }

  /**
   * 取（必要时创建）QQ 连接。
   *
   * @returns 连接句柄。
   */
  function getQqConnection(): QqConnection {
    if (qqConnection === null) {
      qqConnection = createQqConnection({
        // 每次都重新读库，用户在设置页改完配置点「连接」即生效
        getConfig: () => {
          const config = repo.getQqConfig(db);
          return {
            appId: config.appId,
            appSecret: config.appSecret,
            intents: config.intents,
            sandbox: config.sandbox,
          };
        },
        createHttp: (options) => createQqHttp(options),
        onEvent: (payload) => {
          // 消息处理链路（授权 → 模型 → 发送）**尚未接线**。
          // 这里如实记录而不是假装处理 —— 否则界面上看起来「连上了、在工作」，
          // 实际什么都不会回，那比明确的日志难查得多。
          console.warn(
            `[qq] 已连接但消息处理尚未接线，收到事件 ${payload.t ?? '(无 t)'} 已忽略`,
          );
        },
        onState: (state, message) => {
          broadcastQqStatus({
            state,
            message,
            botId: qqConnection?.getState().botId ?? null,
          });
        },
      });
    }
    return qqConnection;
  }

  ipcMain.handle(IPC_CHANNELS.qq.status, () => qqConnection?.getState() ?? IDLE_SNAPSHOT);

  ipcMain.handle(IPC_CHANNELS.qq.connect, async () => {
    const connection = getQqConnection();
    await connection.start();
    return connection.getState();
  });

  ipcMain.handle(IPC_CHANNELS.qq.disconnect, () => {
    qqConnection?.stop();
    return qqConnection?.getState() ?? IDLE_SNAPSHOT;
  });

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
