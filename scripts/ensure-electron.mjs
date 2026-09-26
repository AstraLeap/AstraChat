import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 确保 Electron 运行时二进制已就位。
 *
 * 背景：npm 11 的 `allow-scripts` 策略会拦截**依赖包**的 postinstall 脚本。Electron
 * 正是靠 postinstall 下载那个 200MB+ 的运行时二进制（`node_modules/electron/dist/`），
 * 被拦截后 `electron .` 会因为找不到可执行文件而直接失败 —— 而且 npm 不会报错，
 * 只在安装日志里留一行 warn，很容易被忽略。
 *
 * 依赖包自己的脚本我们可以拦不住，但**根项目自己的 postinstall 不受该策略限制**，
 * 所以这里显式兜底：缺失就手动执行 Electron 自带的 `install.js`。幂等，可重复运行。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let electronDir;
try {
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  console.log('ℹ 未安装 electron，跳过运行时校验。');
  process.exit(0);
}

const distExe = resolve(
  electronDir,
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron',
);

if (existsSync(distExe)) {
  console.log('✅ Electron 运行时已就位。');
  process.exit(0);
}

console.log('▶ Electron 运行时缺失，正在下载…');
const installScript = resolve(electronDir, 'install.js');
if (!existsSync(installScript)) {
  console.error(`✖ 找不到 ${installScript}，请手动执行 npm install electron 后重试。`);
  process.exit(1);
}

// 直接以子进程运行 Electron 的 install.js（它会读取 ELECTRON_MIRROR 环境变量）。
const { spawnSync } = await import('node:child_process');
const result = spawnSync(process.execPath, [installScript], {
  cwd: electronDir,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0 || !existsSync(distExe)) {
  console.error('✖ Electron 运行时下载失败。可设置镜像后重试：');
  console.error('  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm run postinstall');
  process.exit(1);
}

console.log('✅ Electron 运行时下载完成。');
void pathToFileURL;
