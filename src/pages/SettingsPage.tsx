import { useState, type ComponentType } from 'react';
import AboutSection from '../components/settings/AboutSection';
import ProviderList from '../components/settings/ProviderList';
import QqConfigForm from '../components/settings/QqConfigForm';
import {
  IconChatDots,
  IconInfo,
  IconPlug,
  type IconProps,
} from '../components/ui/index';

/**
 * 设置页：左侧分区导航 + 右侧内容区。
 *
 * 采用「单页内分区」而不是子路由，是为了不侵入 `App.tsx` 的路由结构（那份组合由 Lead
 * 负责），同时设置页内部切换分区不需要重新挂载整页，交互更接近原生偏好设置窗口。
 *
 * 各分区组件在**首次被切到时才挂载**，因此数据加载发生在真正需要的地方；切走后再切回
 * 会重新挂载并刷新数据（列表数据是本地 SQLite，代价可忽略）。
 */

/** 设置页的分区标识。 */
type SettingsSectionKey = 'providers' | 'qq' | 'about';

/** 一个分区导航项。 */
interface SettingsSection {
  key: SettingsSectionKey;
  /** 导航标签。 */
  label: string;
  /** 图标组件。 */
  icon: ComponentType<IconProps>;
  /** 右侧标题栏下的说明。 */
  description: string;
}

/** 分区定义，顺序即导航顺序。 */
const SECTIONS: SettingsSection[] = [
  {
    key: 'providers',
    label: '模型提供商',
    icon: IconPlug,
    description: '添加 OpenAI 兼容的接口地址与 API Key，作为对话使用的模型来源。',
  },
  {
    key: 'qq',
    label: 'QQ bot',
    icon: IconChatDots,
    description: '群消息接入配置。v0.1.0 只保存配置，不建立真实连接。',
  },
  {
    key: 'about',
    label: '关于',
    icon: IconInfo,
    description: '版本信息、运行环境与许可证声明。',
  },
];

/**
 * 设置页。
 *
 * @returns 页面元素。
 */
export default function SettingsPage() {
  const [active, setActive] = useState<SettingsSectionKey>('providers');
  const activeSection = SECTIONS.find((section) => section.key === active) ?? SECTIONS[0];

  return (
    <div className="flex h-full min-h-0 bg-[var(--astra-bg)]">
      <nav
        aria-label="设置分区"
        className="flex w-52 shrink-0 flex-col gap-1 border-r border-[var(--astra-border)] bg-[var(--astra-surface)] p-3"
      >
        <h1 className="px-2 pb-2 pt-1 text-sm font-semibold text-[var(--astra-text)]">设置</h1>
        {SECTIONS.map((section) => {
          const selected = section.key === active;
          const Icon = section.icon;
          return (
            <button
              key={section.key}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => setActive(section.key)}
              className={
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ' +
                (selected
                  ? 'bg-[var(--astra-accent-soft)] font-medium text-[var(--astra-accent)]'
                  : 'text-[var(--astra-text)] hover:bg-[var(--astra-surface-2)]')
              }
            >
              <Icon size={14} />
              {section.label}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {activeSection ? (
            <p className="mb-4 text-[11px] leading-relaxed text-[var(--astra-muted)]">
              {activeSection.description}
            </p>
          ) : null}

          {active === 'providers' ? <ProviderList /> : null}
          {active === 'qq' ? <QqConfigForm /> : null}
          {active === 'about' ? <AboutSection /> : null}
        </div>
      </div>
    </div>
  );
}
