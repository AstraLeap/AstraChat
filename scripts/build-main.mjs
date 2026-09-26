import { builtinModules } from 'node:module';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';

/**
 * 构建 Electron **主进程**与**预加载脚本**。
 *
 * 为什么用 esbuild 而不是 tsc：主进程与 preload 都需要是 CommonJS（Electron 44
 * 默认以 CJS 加载 `.cjs` 入口，preload 在沙箱下同样要求 CJS），而我们源码是 ESM +
 * TypeScript。esbuild 一步完成「TS → CJS 单文件 bundle」，避免额外的运行时模块解析。
 *
 * 外部依赖：
 * - `electron` 由运行时注入，绝不打包。
 * - `better-sqlite3` 是原生模块（.node 预编译产物），必须保持 external 并在
 *   electron-builder 里通过 asarUnpack 解包。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(projectRoot, 'dist/electron');

/** 所有 Node 内置模块及其 `node:` 前缀形式都视为外部依赖。 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/**
 * 生成一份 esbuild 构建配置。
 *
 * @param entry 入口文件（相对仓库根目录）。
 * @param outfile 输出文件（相对仓库根目录）。
 * @returns esbuild 构建选项。
 */
function configFor(entry, outfile) {
  return {
    entryPoints: [resolve(projectRoot, entry)],
    outfile: resolve(projectRoot, outfile),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    sourcemap: true,
    logLevel: 'info',
    external: ['electron', 'better-sqlite3', ...nodeBuiltins],
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  };
}

rmSync(outDir, { recursive: true, force: true });

await Promise.all([
  esbuild.build(configFor('electron/main.ts', 'dist/electron/main.cjs')),
  esbuild.build(configFor('electron/preload.ts', 'dist/electron/preload.cjs')),
]);

console.log('✅ 主进程与预加载脚本构建完成 → dist/electron');
