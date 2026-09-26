import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 渲染进程（React）的 Vite 构建配置。
 *
 * 关键点：`base: './'` 让产物使用相对路径引用资源 —— Electron 生产环境通过
 * `file://` 协议加载 `dist/renderer/index.html`，绝对路径 `/assets/...` 会解析到
 * 磁盘根目录从而白屏。
 */
export default defineConfig({
  root: '.',
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    // Electron 44 内置 Chromium 版本足够新，无需为旧浏览器降级。
    target: 'chrome130',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  clearScreen: false,
});
