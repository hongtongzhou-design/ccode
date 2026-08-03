import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ErrorBoundary from "./components/ErrorBoundary";
import { LoadingRows } from "./components/PageFrame";
import "./App.css";
import { useAppStore } from "./store";

// 页面懒加载：首屏只拉当前页 chunk，其余页首次访问时才加载
const ProfilesPage = lazy(() => import("./pages/ProfilesPage"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const StatsPage = lazy(() => import("./pages/StatsPage"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const WorkspacesPage = lazy(() => import("./pages/WorkspacesPage"));

function PageLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <LoadingRows />
    </div>
  );
}

const NAV: { id: string; label: string; icon: string }[] = [
  { id: "profiles", label: "配置", icon: "⇄" },
  { id: "workspaces", label: "工作区", icon: "⛁" },
  { id: "terminal", label: "终端", icon: "⌨" },
  { id: "sessions", label: "会话", icon: "◔" },
  { id: "skills", label: "技能", icon: "✦" },
  { id: "stats", label: "统计", icon: "◫" },
  { id: "settings", label: "设置", icon: "⛭" },
];

function App() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const collapsed = useAppStore((s) => s.navCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleNavCollapsed);
  // 终端里运行中的 agent 数（任意页面可见，徽标挂在「终端」图标上）
  const runningCount = useAppStore((s) => Object.keys(s.liveSessions).length);
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);

  // 记录访问过的页面：懒加载的页面首次访问后才挂载，之后保持挂载（切回状态不丢、终端不断线）
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([page]));
  useEffect(() => {
    setVisited((v) => (v.has(page) ? v : new Set(v).add(page)));
  }, [page]);

  useEffect(() => {
    loadAll().catch((e) => console.error(e));
    loadSessions().catch((e) => console.error(e));
    // 设置（含主题）在启动时加载并应用
    loadSettings().catch((e) => console.error(e));
    // 启动时静默检查应用更新（内部已吞错，命中后在设置页「更新」分区提示）
    checkAppUpdate().catch(() => {});
  }, [loadAll, loadSessions, loadSettings, checkAppUpdate]);

  // 前端未捕获异常上报到进程内日志缓冲（设置页「诊断」可见）；同消息 5s 去重防刷屏
  useEffect(() => {
    const last = new Map<string, number>();
    const report = (source: string, message: string) => {
      const now = Date.now();
      if (now - (last.get(message) ?? 0) < 5000) return;
      last.set(message, now);
      invoke("log_event", { level: "error", source, message }).catch(() => {});
    };
    const onError = (e: ErrorEvent) => {
      report("onerror", `${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      report(
        "unhandledrejection",
        r instanceof Error ? (r.stack ?? r.message) : String(r),
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // 跨实例同步：窗口重新聚焦/可见时重拉配置、设置与会话（2s 节流）。
  // 双开场景（worktree 演示）里另一个实例的改动能即时反映过来。
  useEffect(() => {
    let last = 0;
    const sync = () => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      loadAll().catch(() => {});
      loadSettings().catch(() => {});
      loadSessions().catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadAll, loadSessions, loadSettings]);

  return (
    <ErrorBoundary>
      <div className="flex h-full bg-canvas text-l2">
      <aside
        className={`flex shrink-0 flex-col bg-rail transition-[width] duration-150 ${
          collapsed ? "w-14" : "w-36"
        }`}
      >
        {/* 图标即侧栏开关：直接点击文字收起为图标 / 展开（原底部 « 按钮并入此处） */}
        <div
          onClick={toggleCollapsed}
          title={collapsed ? "展开侧栏" : "收起为图标"}
          className={`cursor-pointer select-none py-4 text-base font-semibold tracking-wide text-l1 ${
            collapsed ? "text-center text-sm" : "px-4"
          }`}
        >
          {collapsed ? "C" : "Ccode"}
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setPage(n.id)}
            title={n.id === "terminal" && runningCount > 0 ? `${n.label}（${runningCount} 个 agent 运行中）` : n.label}
            className={`mx-1 mb-0.5 flex items-center rounded-md text-sm ${
              collapsed ? "h-10 w-12 justify-center self-center" : "px-3 py-2.5"
            } ${
              page === n.id
                ? "bg-rail-sel text-l1"
                : "text-l3 hover:bg-white/5"
            }`}
          >
            <span className={`relative ${collapsed ? "text-lg" : "mr-2 w-5 text-center"}`}>
              {n.icon}
              {n.id === "terminal" && runningCount > 0 && (
                <span className="absolute -right-1.5 -top-1 rounded-full bg-ok px-1 text-[9px] leading-3 text-ok-text">
                  {runningCount}
                </span>
              )}
            </span>
            {!collapsed && n.label}
          </button>
        ))}
        {/* 专注模式插槽：终端页专注时把纵向标签列表 + ⋯ 操作按钮 portal 到这里 */}
        <div id="app-rail-focus-slot" className="mt-1 flex min-h-0 flex-col overflow-y-auto" />
      </aside>
      <main className="min-w-0 flex-1">
        {/* 页面保持挂载，切换标签不销毁终端；未访问过的页不挂载（懒加载） */}
        <div className={page === "profiles" ? "h-full overflow-auto" : "hidden"}>
          {visited.has("profiles") && (
            <Suspense fallback={<PageLoading />}>
              <ProfilesPage />
            </Suspense>
          )}
        </div>
        <div className={page === "workspaces" ? "h-full" : "hidden"}>
          {visited.has("workspaces") && (
            <Suspense fallback={<PageLoading />}>
              <WorkspacesPage visible={page === "workspaces"} />
            </Suspense>
          )}
        </div>
        <div className={page === "terminal" ? "h-full" : "hidden"}>
          {visited.has("terminal") && (
            <Suspense fallback={<PageLoading />}>
              <TerminalPage visible={page === "terminal"} />
            </Suspense>
          )}
        </div>
        <div className={page === "sessions" ? "h-full" : "hidden"}>
          {visited.has("sessions") && (
            <Suspense fallback={<PageLoading />}>
              <SessionsPage visible={page === "sessions"} />
            </Suspense>
          )}
        </div>
        <div className={page === "skills" ? "h-full" : "hidden"}>
          {visited.has("skills") && (
            <Suspense fallback={<PageLoading />}>
              <SkillsPage visible={page === "skills"} />
            </Suspense>
          )}
        </div>
        <div className={page === "stats" ? "h-full overflow-auto" : "hidden"}>
          {visited.has("stats") && (
            <Suspense fallback={<PageLoading />}>
              <StatsPage visible={page === "stats"} />
            </Suspense>
          )}
        </div>
        <div className={page === "settings" ? "h-full overflow-auto" : "hidden"}>
          {visited.has("settings") && (
            <Suspense fallback={<PageLoading />}>
              <SettingsPage visible={page === "settings"} />
            </Suspense>
          )}
        </div>
      </main>
      </div>
    </ErrorBoundary>
  );
}

export default App;
