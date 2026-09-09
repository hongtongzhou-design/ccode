import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RunDto } from "../types";

/** 低频诊断区提供无头任务停止入口，避免只能等待超时。 */
export default function BackgroundTasksPanel() {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const reload = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const rows = await invoke<RunDto[]>("active_background_runs");
        if (!disposed) { setRuns(rows); setError(null); }
      } catch (reason) { if (!disposed) setError(String(reason)); }
      finally { inFlight = false; }
    };
    void reload();
    const timer = window.setInterval(() => void reload(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  return <div className="border-b border-hairline py-3 text-xs">
    <p className="mb-2 text-l2">后台任务</p>
    {error && <p role="alert" className="text-err-text">{error}</p>}
    {!runs.length && !error && <p className="text-l4">当前没有无头 Agent 任务。</p>}
    {runs.map((run) => <div key={run.id} className="flex items-center gap-2 py-1">
      <span className="min-w-0 flex-1 truncate text-l3">{run.agent} · {run.taskRef || run.projectRoot || "AI 辅助任务"}</span>
      <button type="button" disabled={stopping === run.id} className="text-l2 hover:underline disabled:opacity-50" onClick={() => {
        setStopping(run.id);
        void invoke("run_cancel", { id: run.id }).catch((reason) => setError(String(reason))).finally(() => setStopping(null));
      }}>{stopping === run.id ? "请求停止…" : "停止"}</button>
    </div>)}
  </div>;
}
