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

const NAV_GROUPS = [
  {
    label: "工作",
    items: [
      { id: "workspaces", label: "工作区", icon: "⛁" },
      { id: "terminal", label: "终端", icon: "⌨" },
      { id: "sessions", label: "对话", icon: "◔" },
    ],
  },
  {
    label: "能力",
    items: [
      { id: "profiles", label: "配置", icon: "⇄" },
      { id: "skills", label: "技能", icon: "✦" },
    ],
  },
] as const;

const NAV_BOTTOM = [
  { id: "stats", label: "统计", icon: "◫" },
  { id: "settings", label: "设置", icon: "⛭" },
] as const;

function App() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const collapsed = useAppStore((s) => s.navCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleNavCollapsed);
  // 终端里运行中的 agent 数（任意页面可见，徽标挂在「终端」图标上）
  const runningCount = useAppStore((s) => Object.keys(s.liveSessions).length);
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);

  // 记录访问过的页面：懒加载的页面首次访问后才挂载，之后保持挂载（切回状态不丢、终端不断线）
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set([page]),
  );
  useEffect(() => {
    setVisited((v) => (v.has(page) ? v : new Set(v).add(page)));
  }, [page]);

  // 侧栏按页面自动收展：终端/对话是多列工作页，收成图标栏让出横向空间；
  // 离开后恢复 localStorage 里的手动偏好；用户手动折叠/展开后本 session 停止自动跟随
  const navManual = useAppStore((s) => s.navManual);
  const setNavCollapsedAuto = useAppStore((s) => s.setNavCollapsedAuto);
  useEffect(() => {
    if (navManual) return;
    const crowded = page === "terminal" || page === "sessions";
    setNavCollapsedAuto(
      crowded ? true : localStorage.getItem("ccode.navCollapsed") === "1",
    );
  }, [page, navManual, setNavCollapsedAuto]);

  useEffect(() => {
    loadAll().catch((e) => console.error(e));
    loadSessions().catch((e) => console.error(e));
    loadRecentRepos().catch(() => {});
    // 设置（含主题）在启动时加载并应用
    loadSettings().catch((e) => console.error(e));
    // 启动时静默检查应用更新（内部已吞错，命中后在设置页「更新」分区提示）
    checkAppUpdate().catch(() => {});
  }, [loadAll, loadSessions, loadRecentRepos, loadSettings, checkAppUpdate]);

  // 前端未捕获异常上报到进程内日志缓冲（设置页「诊断」可见）；同消息 5s 去重防刷屏
  useEffect(() => {
    const last = new Map<string, number>();
    const report = (source: string, message: string) => {
      const now = Date.now();
      if (now - (last.get(message) ?? 0) < 5000) return;
      last.set(message, now);
      // 顺手淘汰 1 分钟前的旧条目，避免 Map 只增不清
      for (const [m, t] of last) {
        if (now - t > 60_000) last.delete(m);
      }
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
      loadRecentRepos().catch(() => {});
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
  }, [loadAll, loadSessions, loadRecentRepos, loadSettings]);

  return (
    <ErrorBoundary>
      <div className="ccode-app-shell flex h-full overflow-hidden bg-rail text-l2">
        <aside
          className={`ccode-app-rail flex shrink-0 flex-col border-r border-hairline bg-rail transition-[width] duration-150 ${
            collapsed ? "w-14" : "w-40"
          }`}
        >
          {/* 品牌区同时承担侧栏收起/展开，避免额外占用一个操作位。 */}
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "展开侧栏" : "收起为图标"}
            className={`ccode-brand-bar flex h-12 shrink-0 select-none items-center text-left text-l1 ${
              collapsed ? "justify-center text-sm" : "px-3"
            }`}
          >
            {collapsed ? (
              <span className="font-semibold">C</span>
            ) : (
              <span className="block min-w-0 text-base font-semibold tracking-wide">
                Ccode
              </span>
            )}
          </button>

          <nav className="ccode-app-nav min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
            {NAV_GROUPS.map((group, groupIndex) => (
              <div key={group.label} className={groupIndex > 0 ? "mt-3" : ""}>
                {!collapsed && (
                  <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-l4">
                    {group.label}
                  </div>
                )}
                {group.items.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => setPage(n.id)}
                    aria-current={page === n.id ? "page" : undefined}
                    title={
                      n.id === "terminal" && runningCount > 0
                        ? `${n.label}（${runningCount} 个 agent 运行中）`
                        : n.label
                    }
                    className={`relative mb-0.5 flex h-7 items-center rounded-md text-sm transition-colors ${
                      collapsed
                        ? "w-11 justify-center"
                        : "w-full px-2.5"
                    } ${
                      page === n.id
                        ? "bg-rail-sel text-l1"
                        : "text-l3 hover:bg-white/5 hover:text-l2"
                    }`}
                  >
                    {page === n.id && (
                      <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-nav-accent" />
                    )}
                    <span
                      className={`relative ${collapsed ? "text-base" : "mr-2 w-5 text-center text-base"} ${page === n.id ? "text-nav-accent" : ""}`}
                    >
                      {n.icon}
                      {n.id === "terminal" && runningCount > 0 && (
                        <span className="absolute -right-2 -top-1 flex min-w-3.5 items-center justify-center rounded-full bg-inset px-1 text-[9px] leading-3 text-ok-text">
                          {runningCount}
                        </span>
                      )}
                    </span>
                    {!collapsed && <span className="truncate">{n.label}</span>}
                  </button>
                ))}
              </div>
            ))}

            {/* 专注模式插槽：终端页专注时把纵向标签列表 + ⋯ 操作按钮 portal 到这里 */}
            <div
              id="app-rail-focus-slot"
              className="mt-2 flex min-h-0 flex-col overflow-y-auto"
            />
          </nav>

          {/* 底部管理区与导航之间只留一根隐约细线（5% 白 + 0.5px），不完全消失 */}
          <div className="shrink-0 border-t border-white/5 px-1.5 py-2">
            {NAV_BOTTOM.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setPage(n.id)}
                aria-current={page === n.id ? "page" : undefined}
                title={n.label}
                className={`relative mb-0.5 flex h-7 items-center rounded-md text-sm transition-colors ${
                  collapsed ? "w-11 justify-center" : "w-full px-2.5"
                } ${
                  page === n.id
                    ? "bg-rail-sel text-l1"
                    : "text-l3 hover:bg-white/5 hover:text-l2"
                }`}
              >
                {page === n.id && (
                  <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-nav-accent" />
                )}
                <span
                  className={`${collapsed ? "text-base" : "mr-2 w-5 text-center text-base"} ${page === n.id ? "text-nav-accent" : ""}`}
                >
                  {n.icon}
                </span>
                {!collapsed && <span>{n.label}</span>}
              </button>
            ))}
          </div>
        </aside>
        <main className="ccode-app-main h-full min-h-0 min-w-0 flex-1">
          {/* 页面保持挂载，切换标签不销毁终端；未访问过的页不挂载（懒加载） */}
          <div
            className={page === "profiles" ? "h-full overflow-auto" : "hidden"}
          >
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
          <div
            className={page === "settings" ? "h-full overflow-auto" : "hidden"}
          >
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
