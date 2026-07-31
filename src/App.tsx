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
