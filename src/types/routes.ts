/**
 * 应用内的页面路由标识。
 *
 * v0.1.0 只有三个页面，用 `useState` 做切换即可，不引入 react-router —— 桌面应用没有
 * URL 语义，多一个依赖只会增加打包体积与心智负担。
 *
 * 本文件由 Lead 维护，`App.tsx` 与 `AppSidebar` 共享。
 */

/** 当前显示的页面。 */
export type AppRoute = 'chat' | 'personas' | 'settings';

/**
 * 侧边栏导航项可用的图标名。
 *
 * 这里存的是**字符串 key 而不是 React 组件**：`src/types/**` 同时会进入主进程侧的类型
 * 检查程序（`tsconfig.node.json`，不含 DOM lib、未开 `jsx`），一旦 import `.tsx` 就会
 * 连锁报错。因此由 `AppSidebar` 负责把 key 映射到 `src/components/ui/icons.tsx` 里的组件。
 */
export type AppIconName = 'chat' | 'personas' | 'settings';

/** 侧边栏导航项定义。 */
export interface AppNavItem {
  /** 目标路由。 */
  route: AppRoute;
  /** 显示名称。 */
  label: string;
  /** 图标名（由 AppSidebar 映射成 SVG 组件）。 */
  icon: AppIconName;
}

/** 侧边栏底部的导航项列表（顺序即展示顺序）。 */
export const APP_NAV_ITEMS: AppNavItem[] = [
  { route: 'chat', label: '聊天', icon: 'chat' },
  { route: 'personas', label: '角色', icon: 'personas' },
  { route: 'settings', label: '设置', icon: 'settings' },
];
