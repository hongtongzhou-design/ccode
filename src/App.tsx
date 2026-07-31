import { useEffect } from "react";
import "./App.css";
import ProfilesPage from "./pages/ProfilesPage";
import SessionsPage from "./pages/SessionsPage";
import SkillsPage from "./pages/SkillsPage";
import StatsPage from "./pages/StatsPage";
import TerminalPage from "./pages/TerminalPage";
import WorkspacesPage from "./pages/WorkspacesPage";
import { useAppStore } from "./store";

const NAV: { id: string; label: string }[] = [
  { id: "profiles", label: "配置" },
  { id: "workspaces", label: "工作区" },
  { id: "terminal", label: "终端" },
  { id: "sessions", label: "会话" },
  { id: "skills", label: "技能" },
  { id: "stats", label: "统计" },
];

function App() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);

  useEffect(() => {
    loadAll().catch((e) => console.error(e));
    loadSessions().catch((e) => console.error(e));
  }, [loadAll, loadSessions]);

  return (
    <div className="flex h-full bg-canvas text-l2">
      <aside className="flex w-36 shrink-0 flex-col bg-rail">
        <div className="px-4 py-4 text-base font-semibold tracking-wide text-l1">
          Ccode
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setPage(n.id)}
            className={`mx-1 mb-0.5 block w-[calc(100%-8px)] rounded-md px-3 py-2.5 text-left text-sm ${
              page === n.id
                ? "bg-rail-sel text-l1"
                : "text-l3 hover:bg-white/5"
            }`}
          >
            {n.label}
          </button>
        ))}
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
        <div className={page === "stats" ? "h-full" : "hidden"}>
          <StatsPage visible={page === "stats"} />
        </div>
      </main>
    </div>
  );
}

export default App;
