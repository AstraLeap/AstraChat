/**
 * 数据层统一出口。
 *
 * 主进程只从这里 import，避免各处散落地记忆「哪个函数在哪个文件」。渲染进程**不应**
 * import 本模块（它依赖 better-sqlite3 原生模块，只能在主进程加载）。
 */

export { openDatabase, type Db } from './connection';
export {
  createProvider,
  getProvider,
  listProviders,
  removeProvider,
  updateProvider,
} from './providers';
export {
  createConversation,
  getConversation,
  listConversations,
  removeConversation,
  searchConversations,
  touchConversation,
  updateConversation,
} from './conversations';
export {
  autoTitleConversation,
  buildHistory,
  countMessages,
  createMessage,
  getMessage,
  listMessages,
  removeMessage,
  updateMessage,
} from './messages';
export {
  createPersona,
  getPersona,
  listPersonas,
  removePersona,
  updatePersona,
} from './personas';
export { getQqConfig, saveQqConfig } from './qq';
export { seedPersonas } from './seed';
