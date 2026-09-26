import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * 渲染进程入口。
 *
 * 挂载前先确认宿主环境：在纯浏览器里打开（不经 Electron）时 `window.astra` 不存在，
 * 此时给出明确的提示页，而不是让界面在一堆 `undefined` 报错里白屏。
 */

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点，index.html 可能已损坏。');
}

/**
 * 渲染「环境不可用」提示页。
 *
 * 注意：这一页在 **React 挂载之前**就要显示（桥接缺失时我们根本不会 `createRoot`），
 * 所以这里不能用 `src/components/ui/icons.tsx` 的组件，只能内嵌一段等价的 SVG 字符串。
 * 造型与 `IconWarning` 保持一致，改动其一请同步另一处。
 *
 * @param message 具体原因。
 */
function renderBridgeMissing(message: string): void {
  const warningIcon = `
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#5b5bd6"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 4.2a1.7 1.7 0 0 1 1.5.9l7.2 12.6a1.7 1.7 0 0 1-1.5 2.6H4.8a1.7 1.7 0 0 1-1.5-2.6l7.2-12.6a1.7 1.7 0 0 1 1.5-.9Z"/>
      <path d="M12 10v4.2"/>
      <path d="M12 17.3h.01" stroke-width="2.4"/>
    </svg>`;

  container!.innerHTML = `
    <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:32px;font-family:'Segoe UI','Microsoft YaHei',sans-serif;">
      <div style="max-width:520px;text-align:center;">
        ${warningIcon}
        <h1 style="font-size:18px;margin:12px 0 8px;">AstraChat 无法访问本地数据</h1>
        <p style="color:#6b7280;font-size:13px;line-height:1.7;">${message}</p>
        <p style="color:#6b7280;font-size:13px;line-height:1.7;">
          请使用 <code style="background:#eef0f7;padding:2px 6px;border-radius:4px;">npm run dev</code>
          或 <code style="background:#eef0f7;padding:2px 6px;border-radius:4px;">npm start</code>
          以 Electron 方式启动。
        </p>
      </div>
    </div>`;
}

if (typeof window.astra !== 'object' || window.astra === null) {
  renderBridgeMissing('当前页面没有检测到预加载桥接（window.astra 缺失），因此无法读取本机数据库。');
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
