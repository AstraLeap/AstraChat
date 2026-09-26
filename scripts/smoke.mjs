import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * 端到端冒烟测试：`npm run smoke`。
 *
 * 用**隔离的临时 userData 目录**启动真实 Electron 应用，让主进程执行
 * `electron/smoke.ts` 里的全链路检查（渲染 → IPC → fetch/SSE → SQLite → 事件回推），
 * 读回 JSON 结果并据以设置退出码。
 *
 * 之所以隔离 userData：冒烟测试会写入提供商、对话、消息，绝不能污染开发者本机的真实数据。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** 构建产物入口（必须先 `npm run build:main`）。 */
const mainEntry = join(projectRoot, 'dist/electron/main.cjs');
if (!existsSync(mainEntry)) {
  console.error('✖ 找不到 dist/electron/main.cjs，请先执行 `npm run build`。');
  process.exit(1);
}

/** 渲染层产物（冒烟测试要真实渲染 React）。 */
const rendererEntry = join(projectRoot, 'dist/renderer/index.html');
if (!existsSync(rendererEntry)) {
  console.error('✖ 找不到 dist/renderer/index.html，请先执行 `npm run build`。');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'astra-smoke-'));
const logPath = join(workDir, 'smoke.json');
const userDataDir = join(workDir, 'userdata');

console.log(`▶ 冒烟测试：userData=${userDataDir}`);

const electronPath = require('electron');
const child = spawn(electronPath, ['.'], {
  cwd: projectRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ASTRA_SMOKE_LOG: logPath,
    ASTRA_USER_DATA_DIR: userDataDir,
    // 去掉开发服务器变量，强制走打包后的 file:// 加载路径（这也是发布形态）
    VITE_DEV_SERVER_URL: '',
  },
});

/** 兜底超时：Electron 卡死时不能永远挂着。 */
const timeout = setTimeout(() => {
  console.error('✖ 冒烟测试超时（60s），强制结束。');
  child.kill();
}, 60_000);

child.on('exit', (code) => {
  clearTimeout(timeout);

  if (!existsSync(logPath)) {
    console.error(`✖ 冒烟测试未产出结果文件（Electron 退出码 ${code}）。`);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }

  const raw = readFileSync(logPath, 'utf8');
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    console.error('✖ 冒烟结果不是合法 JSON：', String(error));
    console.error(raw);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }

  console.log('');
  for (const check of report.checks) {
    console.log(`${check.ok ? '✅' : '❌'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  console.log('');
  console.log(`冒烟检查：${report.total - report.failed}/${report.total} 通过`);

  rmSync(workDir, { recursive: true, force: true });
  process.exit(report.ok ? 0 : 1);
});
