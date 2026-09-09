import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import type { RunDto } from "../types";

interface SnapshotFile {
  path: string;
  before: string | null;
  initial: string | null;
  after: string | null;
}
interface Snapshot { runId: string; files: SnapshotFile[] }

/** 定时历史只能展示冻结证据；当前工作目录是另外一个明确标注的入口。 */
export default function WatchRunReview({ run, onClose, currentDirectory }: {
  run: RunDto;
  onClose: () => void;
  currentDirectory: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  useEffect(() => {
    let cancelled = false;
    invoke<Snapshot>("watch_run_snapshot", { runId: run.id })
      .then((value) => { if (!cancelled) setSnapshot(value); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [run.id]);
  const changed = snapshot?.files.filter((file) => file.initial !== file.after) ?? [];
  async function adopt() {
    if (busy || !snapshot || adopted) return;
    if (!(await confirmDialog("将这次运行的冻结产物采纳进主仓？保存前会检查版本冲突和保护路径，并备份原文件；冲突时不自动覆盖。", { confirmText: "采纳进主仓" }))) return;
    setBusy(true);
    setError(null);
    try {
      await invoke<string[]>("adopt_watch_run", { runId: run.id });
      setAdopted(true);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3 text-sm">
        <button type="button" onClick={onClose} disabled={busy} className="rounded-sm px-2 py-1 text-l2 hover:bg-hover">返回</button>
        <span className="min-w-0 flex-1 text-l1">{showCurrent ? "当前工作目录（不是这次运行的历史快照）" : "本次定时任务 · 冻结产物评审"}</span>
        <button type="button" onClick={() => setShowCurrent((v) => !v)} className="rounded-sm px-2 py-1 text-l3 hover:bg-hover">
          {showCurrent ? "回到冻结产物" : "查看当前工作目录"}
        </button>
        {!showCurrent && <button type="button" disabled={busy || adopted || !snapshot || run.status !== "completed" || changed.length === 0}
          onClick={() => void adopt()} className="rounded-sm border border-cta-bd bg-cta px-3 py-1 text-cta-text disabled:opacity-50">
          {busy ? "正在采纳…" : adopted ? "已采纳" : "采纳进主仓"}
        </button>}
      </div>
      {showCurrent ? <div className="relative min-h-0 flex-1">{currentDirectory}</div> : <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-3 text-xs text-l3">这里只冻结四类可采纳台账文件；下一次巡检不会改变这些证据。其他产物请在当前工作目录中查看。无内容表示该文件当时不存在。</p>
        {error && <p role="alert" className="mb-3 whitespace-pre-wrap text-sm text-err-text">{error}</p>}
        {!snapshot && !error && <p className="text-sm text-l3">正在读取冻结证据…</p>}
        {snapshot && changed.length === 0 && <p className="text-sm text-l3">本次没有可采纳台账文件的变更。</p>}
        {changed.map((file) => <section key={file.path} className="mb-4 rounded-md border border-hairline p-3">
          <h3 className="mb-2 font-mono text-sm text-l1">{file.path}</h3>
          <div className="grid gap-3 lg:grid-cols-3">
            {([['执行前主仓', file.before], ['执行前隔离目录', file.initial], ['本次冻结结果', file.after]] as const).map(([label, text]) =>
              <div key={label} className="min-w-0"><p className="mb-1 text-xs text-l3">{label}</p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-2 font-mono text-xs text-l2">{text ?? "（不存在）"}</pre>
              </div>)}
          </div>
        </section>)}
      </div>}
    </div>
  );
}
