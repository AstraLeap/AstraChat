import { useEffect, useState } from 'react';
import { describeError, getBridge } from '../../stores/bridge';
import type { AppInfo } from '../../types/index';
import { LoadingBlock } from '../ui';

/**
 * 「关于」区块：展示应用与运行环境信息，以及许可证声明。
 *
 * 数据来源是 `window.astra.app.info()`（经 `getBridge()` 访问）。这些值只在应用启动后
 * 才确定，因此必须异步读取，不能用构建期常量糊弄。
 */

/** 环境信息表格的一行。 */
interface InfoRow {
  label: string;
  value: string;
}

/**
 * 把 `AppInfo` 摊平成待展示的行。
 *
 * @param info 应用信息。
 * @returns 表格行数组。
 */
function toRows(info: AppInfo): InfoRow[] {
  return [
    { label: 'AstraChat 版本', value: info.version },
    { label: 'Electron', value: info.electronVersion },
    { label: 'Node.js', value: info.nodeVersion },
    { label: 'Chromium', value: info.chromeVersion },
    { label: '数据目录', value: info.userDataDir },
  ];
}

/**
 * 关于区块。
 *
 * @returns 关于区块元素。
 */
export default function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    /**
     * 读取应用信息；组件已卸载则丢弃结果。
     *
     * @returns 无。
     */
    async function load(): Promise<void> {
      try {
        const value = await getBridge().app.info();
        if (!cancelled) {
          setInfo(value);
          setLoading(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause));
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-sm font-semibold text-[var(--astra-text)]">关于 AstraChat</h2>
        <p className="mt-0.5 text-[11px] text-[var(--astra-muted)]">
          本地优先的桌面 AI 聊天客户端：数据全部存放在本机 SQLite，不经过任何中转服务器。
        </p>
      </header>

      {loading ? <LoadingBlock text="正在读取环境信息…" /> : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-[var(--astra-danger)]/40 bg-[var(--astra-danger)]/10 px-3 py-2 text-xs text-[var(--astra-danger)]"
        >
          {error}
        </p>
      ) : null}

      {info ? (
        <dl className="divide-y divide-[var(--astra-border)] overflow-hidden rounded-lg border border-[var(--astra-border)] bg-[var(--astra-surface)]">
          {toRows(info).map((row) => (
            <div key={row.label} className="flex items-start gap-4 px-3 py-2">
              <dt className="w-32 shrink-0 text-[11px] text-[var(--astra-muted)]">{row.label}</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--astra-text)]">
                {row.value || '—'}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="rounded-lg border border-[var(--astra-border)] bg-[var(--astra-surface)] px-3 py-2.5">
        <h3 className="text-xs font-semibold text-[var(--astra-text)]">许可证</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--astra-muted)]">
          AstraChat 以 <span className="font-semibold text-[var(--astra-text)]">MIT License</span>{' '}
          发布。Copyright © 2025 星辰跃动（Starry Motion Studio）。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--astra-muted)]">
          第三方依赖（Electron、React、Tailwind CSS、better-sqlite3 等）遵循各自的许可证，
          详见随应用分发的 <span className="font-mono">LICENSE</span> 与依赖包内的声明文件。
        </p>
      </div>
    </section>
  );
}
