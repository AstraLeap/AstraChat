import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { openDatabase, seedPersonas, type Db } from '../src/db/index';
import { registerIpcHandlers } from './ipc';
import { abortAllStreams } from './chat';
import { runSmokeChecks } from './smoke';

/**
 * Electron 主进程入口。
 *
 * 职责：应用生命周期、创建主窗口、初始化 SQLite 数据层、注册 IPC。
 * 窗口安全基线：`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，
 * 并禁止渲染进程自行打开新窗口或跳转到外部地址。
 */

/** 当前主窗口；关闭后置空，流式推送据此判断是否需要丢弃事件。 */
let mainWindow: BrowserWindow | null = null;

/** 数据库句柄；`app.whenReady` 时创建，`before-quit` 时关闭。 */
let db: Db | null = null;

/**
 * 解析数据库文件路径。
 *
 * 支持 `ASTRA_USER_DATA_DIR` 覆盖 userData 目录 —— 冒烟测试用它把数据写到临时目录，
 * 避免污染开发者本机的真实数据。
 *
 * @returns SQLite 文件绝对路径。
 */
function resolveDatabasePath(): string {
  const overrideDir = process.env.ASTRA_USER_DATA_DIR;
  if (overrideDir) {
    app.setPath('userData', overrideDir);
  }
  return join(app.getPath('userData'), 'astra-chat.db');
}

/**
 * 初始化数据层：确保目录存在、打开数据库，并把内置示例角色种入（仅首次）。
 *
 * 注意 `mkdirSync` 不是多余的：better-sqlite3 **不会**自动创建父目录，目录不存在时
 * 直接抛 `Cannot open database because the directory does not exist`。
 * 正常情况下 Electron 会预先建好 userData，但用 `ASTRA_USER_DATA_DIR` 指向一个全新
 * 临时目录（冒烟测试就是这么做的）时目录并不存在。
 *
 * @returns 数据库句柄。
 */
function bootstrapDatabase(): Db {
  const dbPath = resolveDatabasePath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = openDatabase(dbPath);
  const seeded = seedPersonas(handle);
  if (seeded > 0) {
    console.log(`[astra] 已写入 ${seeded} 个内置示例角色`);
  }
  return handle;
}

/**
 * 判断是否运行在开发模式（由 `scripts/dev.mjs` 注入 `VITE_DEV_SERVER_URL`）。
 *
 * @returns 开发服务器 URL，或 `null`。
 */
function devServerUrl(): string | null {
  return process.env.VITE_DEV_SERVER_URL ?? null;
}

/**
 * 创建主窗口。
 *
 * @returns 创建好的窗口。
 */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    title: 'AstraChat',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // 首帧渲染完成再显示，避免白屏闪烁。
  win.once('ready-to-show', () => {
    win.show();
  });

  // 渲染进程不允许自己开新窗口：外链一律交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 禁止渲染进程导航离开应用页面（防钓鱼/白屏）。
  win.webContents.on('will-navigate', (event, url) => {
    const dev = devServerUrl();
    const allowed = dev ? url.startsWith(dev) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
    }
  });

  const dev = devServerUrl();
  if (dev) {
    void win.loadURL(dev);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// 单实例锁：第二次启动时聚焦已有窗口，而不是开第二个实例（SQLite 同文件双写会出问题）。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    db = bootstrapDatabase();

    registerIpcHandlers({
      db,
      getWindow: () => mainWindow,
    });

    mainWindow = createMainWindow();

    // 冒烟测试钩子：仅在显式传入 ASTRA_SMOKE_LOG 时启用，用于 CI / 自动化验证。
    if (process.env.ASTRA_SMOKE_LOG) {
      await runSmokeChecks({ db, getWindow: () => mainWindow });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  }).catch((error: unknown) => {
    // 启动阶段失败必须显式退出：否则会变成一个「窗口没出现、进程还在后台挂着」的僵尸，
    // 既看不到错误也没法排查（冒烟测试就曾被这一点拖到超时）。
    console.error('[astra] 启动失败：', error);
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // 先掐掉所有进行中的网络流，再关数据库，避免写入已关闭的连接。
  abortAllStreams();
  db?.close();
  db = null;
});
