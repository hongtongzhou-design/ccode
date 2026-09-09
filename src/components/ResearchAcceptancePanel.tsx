import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadResearchReports, readResearchFile } from "../research-report-load";
import { researchReportPatterns } from "../research-report";
import type { ProjectStepDto, ResearchAcceptanceDto, ResearchAcceptedFile, WorkspaceDto } from "../types";

const VERDICTS = [
  { value: "accept", label: "接受" },
  { value: "accept_with_conditions", label: "有条件接受" },
  { value: "return", label: "退回" },
] as const;

export default function ResearchAcceptancePanel({ workspace, step, runId = null }: {
  workspace: WorkspaceDto; step: ProjectStepDto; runId?: string | null;
}) {
  const [verdict, setVerdict] = useState<typeof VERDICTS[number]["value"]>("return");
  const [scope, setScope] = useState("");
  const [blockers, setBlockers] = useState("");
  const [files, setFiles] = useState<ResearchAcceptedFile[]>([]);
  const [saved, setSaved] = useState<ResearchAcceptanceDto | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const existing = await invoke<ResearchAcceptanceDto | null>("research_get_acceptance", {
          projectRoot: workspace.repoPath, workspaceId: workspace.id, stepName: step.name,
        });
        const reports = await loadResearchReports(workspace.worktreePath, researchReportPatterns(step, "acceptance"), "acceptance");
        const current: ResearchAcceptedFile[] = [];
        for (const report of reports.reports) {
          if (report.revision) current.push({ path: report.path, revision: report.revision });
        }
        if (cancelled) return;
        setFiles(current);
        if (existing) {
          setSaved(existing);
          setVerdict(existing.verdict === "accept" || existing.verdict === "accept_with_conditions" ? existing.verdict : "return");
          setScope(existing.conclusionScope);
          setBlockers(existing.openBlockers.join("\n"));
          const changed = existing.files.filter((file) => current.find((c) => c.path === file.path)?.revision !== file.revision).map((f) => f.path);
          setStale(changed);
        } else {
          setSaved(null); setStale([]);
        }
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [workspace.id, workspace.repoPath, workspace.worktreePath, step.name]);
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const current: ResearchAcceptedFile[] = [];
      for (const file of files) {
        const preview = await readResearchFile(workspace.worktreePath, file.path);
        if (!preview.revision || preview.truncated) throw new Error(`${file.path}：无法绑定完整版本`);
        current.push({ path: file.path, revision: preview.revision });
      }
      const record = await invoke<ResearchAcceptanceDto>("research_save_acceptance", {
        projectRoot: workspace.repoPath,
        record: {
          verdict,
          stepName: step.name,
          workspaceId: workspace.id,
          files: current,
          conclusionScope: scope.trim(),
          openBlockers: blockers.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
          runId,
          createdAt: "",
        },
      });
      setSaved(record);
      setFiles(current);
      setStale([]);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <section aria-label="科研验收决定" className="my-3 rounded-md bg-inset p-3 text-xs">
    <h3 className="font-medium text-l1">科研验收决定</h3>
    <p className="my-1 text-micro text-l4">这是接受研究结论的记录，不是 Git 合并，也不是报告里写了「通过」。保存工作仍用原来的提交/合并。</p>
    {saved && <p className="text-l2">上次：{VERDICTS.find((v) => v.value === saved.verdict)?.label ?? saved.verdict} · {saved.createdAt}{saved.runId ? ` · 运行 ${saved.runId}` : ""}</p>}
    {stale.length > 0 && <p className="text-warn-text">以下文件版本已变，需要重新确认：{stale.join("、")}</p>}
    <label className="mt-2 block text-l2">决定
      <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)} className="mt-1 w-full rounded border border-field bg-canvas p-1">
        {VERDICTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
    <label className="mt-2 block text-l2">接受的结论范围
      <textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={2} className="mt-1 w-full rounded border border-field bg-canvas p-1" placeholder="例如：仅接受合成演示范围内的描述性差值，不外推真实任务。" />
    </label>
    <label className="mt-2 block text-l2">未关闭的阻塞项
      <textarea value={blockers} onChange={(e) => setBlockers(e.target.value)} rows={2} className="mt-1 w-full rounded border border-field bg-canvas p-1" placeholder="一行一项；没有则留空" />
    </label>
    {files.length > 0 && <p className="mt-2 break-all text-micro text-l4">绑定文件：{files.map((f) => `${f.path}（${f.revision.slice(0, 8)}）`).join("、")}</p>}
    <button type="button" disabled={busy || !scope.trim()} onClick={() => void save()} className="mt-2 rounded border border-field px-2 py-1 text-l2 disabled:opacity-50">{busy ? "保存中…" : "记下验收决定"}</button>
    {error && <p role="alert" className="mt-2 text-err-text">{error}</p>}
  </section>;
}
