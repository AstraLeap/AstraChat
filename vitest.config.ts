import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置。
 *
 * 测试只覆盖**可在纯 Node 下运行**的模块：SQLite 数据层（`src/db`）、SSE 解析与
 * OpenAI 兼容客户端（`src/services`）、以及纯函数型工具。
 *
 * 之所以能在 Node 下直接跑 better-sqlite3：v13 起它是 Node-API（node-addon-api）
 * 实现，npm tarball 内自带 `prebuilds/` 预编译产物，Node 与 Electron 共用同一份
 * 二进制（无需 electron-rebuild）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    reporters: ['default'],
    testTimeout: 20000,
    server: {
      deps: {
        // better-sqlite3 是原生 CJS 模块，必须交给 Node 直接 require，
        // 不能由 Vite 转换/打包，否则拿不到 .node 绑定。
        external: ['better-sqlite3'],
      },
    },
  },
});
