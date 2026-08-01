import { useEffect, useState } from "react";
import "./App.css";
import ProfilesPage from "./pages/ProfilesPage";
import SessionsPage from "./pages/SessionsPage";
import SettingsPage from "./pages/SettingsPage";
import SkillsPage from "./pages/SkillsPage";
import StatsPage from "./pages/StatsPage";
import TerminalPage from "./pages/TerminalPage";
import WorkspacesPage from "./pages/WorkspacesPage";
import { useAppStore } from "./store";

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
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("ccode.navCollapsed") === "1",
  );
  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem("ccode.navCollapsed", c ? "0" : "1");
      return !c;
    });
  }
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadSettings = useAppStore((s) => s.loadSettings);

  useEffect(() => {
    loadAll().catch((e) => console.error(e));
    loadSessions().catch((e) => console.error(e));
    // 设置（含主题）在启动时加载并应用
    loadSettings().catch((e) => console.error(e));
  }, [loadAll, loadSessions, loadSettings]);

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
    <div className="flex h-full bg-canvas text-l2">
      <aside
        className={`flex shrink-0 flex-col bg-rail transition-[width] duration-150 ${
          collapsed ? "w-14" : "w-36"
        }`}
      >
        <div
          className={`py-4 text-base font-semibold tracking-wide text-l1 ${
            collapsed ? "text-center text-sm" : "px-4"
          }`}
          title="Ccode"
        >
          {collapsed ? "C" : "Ccode"}
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setPage(n.id)}
            title={n.label}
            className={`mx-1 mb-0.5 flex items-center rounded-md text-sm ${
              collapsed ? "h-10 w-12 justify-center self-center" : "px-3 py-2.5"
            } ${
              page === n.id
                ? "bg-rail-sel text-l1"
                : "text-l3 hover:bg-white/5"
            }`}
          >
            <span className={collapsed ? "text-lg" : "mr-2 w-5 text-center"}>
              {n.icon}
            </span>
            {!collapsed && n.label}
          </button>
        ))}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "展开侧栏" : "收起为图标"}
          className={`mt-auto mb-2 flex items-center justify-center self-center rounded-md text-l4 hover:bg-white/5 hover:text-l2 ${
            collapsed ? "h-9 w-12" : "h-8 w-[calc(100%-8px)] mx-1"
          }`}
        >
          {collapsed ? "»" : "«"}
        </button>
      </aside>
      <main className="min-w-0 flex-1">
        {/* 页面保持挂载，切换标签不销毁终端 */}
        <div className={page === "profiles" ? "h-full overflow-auto" : "hidden"}>
          <ProfilesPage />
        </div>
        <div className={page === "workspaces" ? "h-full" : "hidden"}>
          <WorkspacesPage visible={page === "workspaces"} />
        </div>
        <div className={page === "terminal" ? "h-full" : "hidden"}>
          <TerminalPage visible={page === "terminal"} />
        </div>
        <div className={page === "sessions" ? "h-full" : "hidden"}>
          <SessionsPage visible={page === "sessions"} />
        </div>
        <div className={page === "skills" ? "h-full" : "hidden"}>
          <SkillsPage visible={page === "skills"} />
        </div>
        <div className={page === "stats" ? "h-full overflow-auto" : "hidden"}>
          <StatsPage visible={page === "stats"} />
        </div>
        <div className={page === "settings" ? "h-full overflow-auto" : "hidden"}>
          <SettingsPage visible={page === "settings"} />
        </div>
      </main>
    </div>
  );
}

export default App;
