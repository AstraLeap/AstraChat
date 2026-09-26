import PersonaList from '../components/settings/PersonaList';

/**
 * 角色管理页。
 *
 * 只负责页面级布局与说明；列表、表单、二次确认都封装在 `PersonaList` 内
 * （它同时负责首次挂载时的数据加载）。
 *
 * @returns 页面元素。
 */
export default function PersonasPage() {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--astra-bg)]">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
        <header>
          <h1 className="text-lg font-semibold text-[var(--astra-text)]">角色（人格）</h1>
          <p className="mt-1 text-xs leading-relaxed text-[var(--astra-muted)]">
            每个角色由「名称 + 头像 + 系统提示词」组成。在对话里选定角色后，系统提示词会作为
            首条 system 消息注入，用来约束助手的人设、语气与输出格式。
          </p>
        </header>

        <PersonaList />

        <p className="text-[11px] leading-relaxed text-[var(--astra-muted)]">
          提示：首次启动时应用会种入 4 个内置示例角色（通用助手 / 代码搭档 / 产品文案 /
          翻译润色）。它们和自建角色一样可以随意编辑或删除 —— 只有把角色表清空后，应用下次
          启动才会重新写入这些示例。
        </p>
      </div>
    </div>
  );
}
