import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * 把 electron-builder 产出的可分发文件收集到根目录的 `releases/`。
 *
 * 为什么要单独一步：electron-builder 的 `directories.output`（`release/`）是**构建工作区**，
 * 里面混着 `win-unpacked/` 中间产物、`.blockmap`、`builder-debug.yml` 等一堆东西。
 * 而用户要的是「一个能直接双击的 exe」，所以把最终可分发文件拷到一个干净的
 * `releases/` 里，避免在几百 MB 的中间产物里翻找。
 *
 * ⚠️ 注意：**不要**直接去 `release/win-unpacked/` 里拿 `AstraChat.exe` —— 那个 exe 必须和
 * 同目录的 `resources/`、`*.dll` 待在一起才能启动，单独拷出来双击只会报错。
 * 免安装分发请用 `*-portable.exe`（自解压单文件）。
 *
 * 幂等：每次先清空 `releases/` 再拷贝，避免旧版本残留造成「拿到的是上一次的包」。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromDir = join(projectRoot, 'release');
const toDir = join(projectRoot, 'releases');

if (!existsSync(fromDir)) {
  console.error('✖ 找不到 release/ 目录，请先执行 `npm run build && electron-builder`。');
  process.exit(1);
}

/**
 * 判断是否是要收集的可分发文件。
 *
 * 只收 `.exe`（Windows 安装版 / 免安装版）。macOS 的 `.dmg`、Linux 的 `.AppImage` 在没有
 * 对应平台时不会产出；若以后在别的平台构建，这里再按需扩展。
 *
 * @param name 文件名。
 * @returns 是否收集。
 */
function isDistributable(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.exe');
}

const artifacts = readdirSync(fromDir).filter(isDistributable);

if (artifacts.length === 0) {
  console.error(`✖ ${fromDir} 里没有找到任何 .exe —— 打包可能没成功。`);
  process.exit(1);
}

rmSync(toDir, { recursive: true, force: true });
mkdirSync(toDir, { recursive: true });

console.log('▶ 收集可分发文件到 releases/');
for (const name of artifacts) {
  const src = join(fromDir, name);
  const dst = join(toDir, name);
  copyFileSync(src, dst);
  const kb = statSync(dst).size / 1024;
  const mb = kb / 1024;
  const human = mb >= 1 ? `${mb.toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  console.log(`  ✅ ${name}  (${human})`);
}

console.log(`\n完成：${artifacts.length} 个文件已放入 releases/`);
console.log('   *-portable.exe = 免安装，双击直接启动');
console.log('   *-setup.exe    = 安装版，走安装向导');
