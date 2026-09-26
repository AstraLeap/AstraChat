import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { AppSidebar } from './components/layout/AppSidebar';
import { IconWarning } from './components/ui/index';
import ChatPage from './pages/ChatPage';
import PersonasPage from './pages/PersonasPage';
import SettingsPage from './pages/SettingsPage';
import type { AppRoute } from './types/routes';

/**
 * 应用根组件：常驻左侧边栏 + 右侧页面区。
 *
 * 路由方式：`useState` 切换三个页面。桌面应用没有 URL 语义，不引入 react-router。
 * 侧边栏常驻，这样在「角色 / 设置」页之间切换时对话列表不丢失滚动位置与加载状态。
 */

/** 错误边界的 props。 */
interface ErrorBoundaryProps {
  /** 子组件树。 */
  children: ReactNode;
}

/** 错误边界的 state。 */
interface ErrorBoundaryState {
  /** 捕获到的错误。 */
  error: Error | null;
}

/**
 * 顶层错误边界。
 *
 * 桌面应用最怕「渲染抛错 → 整个窗口白屏、且用户拿不到任何信息」。这里把错误兜住并
 * 展示可读的原因，让问题可被反馈而不是变成一块白板。
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** 初始状态。 */
  override state: ErrorBoundaryState = { error: null };

  /**
   * 捕获子树抛出的错误。
   *
   * @param error 抛出的错误。
   * @returns 新的 state。
   */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  /**
   * 把错误打到控制台，便于开发时定位。
   *
   * @param error 抛出的错误。
   * @param info React 的组件栈信息。
   */
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[AstraChat] 渲染出错：', error, info.componentStack);
  }

  /**
   * 渲染子组件或错误页。
   *
   * @returns 正常时渲染 children，出错时渲染错误提示。
   */
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <IconWarning size={32} className="text-[var(--astra-danger)]" />
        <h1 className="text-base font-semibold text-[var(--astra-text)]">界面出现异常</h1>
        <p className="max-w-lg text-xs leading-relaxed text-[var(--astra-muted)]">
          {error.message}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-md border border-[var(--astra-border)] bg-[var(--astra-surface)] px-3 py-1.5 text-xs text-[var(--astra-text)] hover:bg-[var(--astra-surface-2)]"
        >
          重试渲染
        </button>
      </div>
    );
  }
}

/**
 * 应用根组件。
 *
 * @returns 完整界面。
 */
export default function App() {
  const [route, setRoute] = useState<AppRoute>('chat');

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full overflow-hidden bg-[var(--astra-bg)] text-[var(--astra-text)]">
        <AppSidebar route={route} onNavigate={setRoute} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {route === 'chat' ? <ChatPage /> : null}
          {route === 'personas' ? <PersonasPage /> : null}
          {route === 'settings' ? <SettingsPage /> : null}
        </main>
      </div>
    </ErrorBoundary>
  );
}
