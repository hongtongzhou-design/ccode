import { useEffect, useState } from "react";
import "./App.css";
import ProfilesPage from "./pages/ProfilesPage";
import SessionsPage from "./pages/SessionsPage";
import TerminalPage from "./pages/TerminalPage";
import { useAppStore } from "./store";

type Page = "profiles" | "sessions" | "terminal";

const NAV: { id: Page; label: string }[] = [
  { id: "profiles", label: "配置" },
  { id: "sessions", label: "会话" },
  { id: "terminal", label: "终端" },
];

function App() {
  const [page, setPage] = useState<Page>("profiles");
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);

  useEffect(() => {
    loadAll().catch((e) => console.error(e));
    loadSessions().catch((e) => console.error(e));
  }, [loadAll, loadSessions]);

  return (
    <div className="flex h-full bg-neutral-100 text-neutral-800">
      <aside className="flex w-40 shrink-0 flex-col bg-neutral-900">
        <div className="px-4 py-4 text-lg font-semibold text-white">Ccode</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setPage(n.id)}
            className={`mx-2 mb-1 rounded px-3 py-2 text-left text-sm ${
              page === n.id
                ? "bg-neutral-700 text-white"
                : "text-neutral-300 hover:bg-neutral-800"
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
        <div className={page === "sessions" ? "h-full" : "hidden"}>
          <SessionsPage visible={page === "sessions"} />
        </div>
        <div className={page === "terminal" ? "h-full" : "hidden"}>
          <TerminalPage visible={page === "terminal"} />
        </div>
      </main>
    </div>
  );
}

export default App;
