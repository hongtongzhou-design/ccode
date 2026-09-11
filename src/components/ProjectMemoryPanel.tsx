import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { secondaryActionClass } from "./PageFrame";

type Entry = {
  meta: { id: string; createdAt: string; goalName: string; sourceVersion: string | null; state: string; replaces: string | null; reason: string };
  text: string;
  stalePaths: string[];
};
type Document = { revision: string; legacyText: string; entries: Entry[] };

export default function ProjectMemoryPanel({ projectPath }: { projectPath: string }) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stale = false;
    setDoc(null); setError(null); setEditing(null); setText(""); setReason("");
    invoke<Document>("project_memory_read", { path: projectPath })
      .then((value) => { if (!stale) setDoc(value); })
      .catch((e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [projectPath, reload]);
  async function save(action: "add" | "replace" | "revoke" | "archive_legacy", id: string | null) {
    if (!doc || busy) return;
    if (!reason.trim()) { setError("请写明确认或作废的依据"); return; }
    if ((action === "revoke" || action === "archive_legacy") && !await confirmDialog("作废这条项目知识？历史仍保留，之后开工不再把它当作有效结论。", { focusCancel: true })) return;
    setBusy(true); setError(null);
    try {
      setDoc(await invoke<Document>("project_memory_update", { path: projectPath, expectedRevision: doc.revision, id, action, text, reason }));
      setText(""); setReason(""); setEditing(null);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section aria-label="项目长期知识" className="space-y-2 text-xs">
    <div className="flex items-center justify-between"><h3 className="font-medium text-l2">项目长期知识</h3><button type="button" className={secondaryActionClass} disabled={busy} onClick={() => setReload((n) => n + 1)}>重新读取</button></div>
    <p className="text-l4">只保存你确认的结论。来源文件变化会提示重新确认；修订和作废保留原记录。</p>
    {doc?.entries.filter((e) => e.meta.state === "active").map((entry) => <article key={entry.meta.id} className="rounded ccode-well p-2">
      <p className="whitespace-pre-wrap text-l2">{entry.text}</p>
      <p className="mt-1 break-all text-micro text-l4">{entry.meta.goalName} · {entry.meta.createdAt} · {entry.meta.sourceVersion ?? "人工确认"}</p>
      {!!entry.stalePaths.length && <p className="text-warn-text">来源已变化或无法在预算内确认，当前不作为有效结论：{entry.stalePaths.join("、")}</p>}
      <div className="mt-1 flex gap-2"><button type="button" className={secondaryActionClass} disabled={busy} onClick={() => { setEditing(entry.meta.id); setText(entry.text); setReason(""); }}>修订 / 重新确认</button><button type="button" className={secondaryActionClass} disabled={busy} onClick={() => void save("revoke", entry.meta.id)}>作废</button></div>
    </article>)}
    {!!doc?.legacyText && <details className="text-l3"><summary>旧知识原文（未绑定版本）</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{doc.legacyText}</pre><button type="button" className={secondaryActionClass} disabled={busy} onClick={() => void save("archive_legacy", null)}>停止带入旧知识（保留历史）</button></details>}
    {!!doc?.entries.some((e) => e.meta.state !== "active") && <details className="text-l4"><summary>历史与作废条目</summary>{doc.entries.filter((e) => e.meta.state !== "active").map((e) => <p key={e.meta.id} className="mt-1 whitespace-pre-wrap">{e.meta.state === "revoked" ? "已作废" : "已替代"}：{e.text}；依据：{e.meta.reason}</p>)}</details>}
    <label className="block text-l3">{editing ? "修订后的结论" : "新增人工确认的结论"}<textarea className="mt-1 w-full rounded border border-field bg-canvas p-2 text-l1" rows={3} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} /></label>
    <label className="block text-l3">确认 / 作废依据<input className="mt-1 w-full rounded border border-field bg-canvas p-2 text-l1" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
    <button type="button" className={secondaryActionClass} disabled={busy || !doc || !text.trim() || !reason.trim()} onClick={() => void save(editing ? "replace" : "add", editing)}>{busy ? "保存中…" : editing ? "确认替代旧结论" : "确认新增"}</button>
    {editing && <button type="button" className={`${secondaryActionClass} ml-2`} disabled={busy} onClick={() => { setEditing(null); setText(""); }}>取消修订</button>}
    {error && <p role="alert" className="text-err-text">{error}</p>}
  </section>;
}
