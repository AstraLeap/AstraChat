import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

/**
 * 开发模式启动器：`npm run dev`。
 *
 * 三步走：
 * 1. 用 esbuild 先把主进程 / 预加载脚本构建到 `dist/electron`（Electron 需要真实的
 *    `.cjs` 文件，不能像渲染层那样由 Vite 在内存里服务）。
 * 2. 启动 Vite dev server 服务渲染层，拿到本地 URL。
 * 3. 以 `VITE_DEV_SERVER_URL` 环境变量启动 Electron；主进程检测到该变量就加载
 *    开发服务器地址（从而获得 HMR），否则加载打包后的 `dist/renderer/index.html`。
 *
 * Electron 退出时一并关闭 Vite server。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** 第 1 步：构建主进程与预加载脚本。 */
console.log('▶ 构建主进程 / 预加载脚本…');
execFileSync(process.execPath, [resolve(projectRoot, 'scripts/build-main.mjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
});

/** 第 2 步：启动 Vite dev server。 */
const server = await createServer({
  configFile: resolve(projectRoot, 'vite.config.ts'),
  root: projectRoot,
});
await server.listen();
const devServerUrl = server.resolvedUrls?.local?.[0];
if (!devServerUrl) {
  console.error('✖ 无法获取 Vite dev server 地址');
  await server.close();
  process.exit(1);
}
console.log(`▶ Vite dev server: ${devServerUrl}`);

/** 第 3 步：启动 Electron。 */
const electronPath = require('electron');
const electron = spawn(electronPath, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

electron.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

const shutdown = () => {
  electron.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
