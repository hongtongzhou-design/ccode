import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface GitFileDto {
  path: string;
  status: string; // "M" | "A" | "D" | "R" | "??"
  additions: number | null;
  deletions: number | null;
}

interface GitStatusDto {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
}

const STATUS_STYLE: Record<string, string> = {
  M: "bg-amber-100 text-amber-700",
  A: "bg-green-100 text-green-700",
  "??": "bg-green-100 text-green-700",
  D: "bg-red-100 text-red-700",
  R: "bg-blue-100 text-blue-700",
};

/**
 * 改动面板：活动标签 cwd 的 git 状态（8s 轮询）+ 提交/推送。
 * 输入提交信息并显式点击即视为用户同意，不再二次确认。
 */
export default function GitPanel({
  cwd,
  visible,
  onTotals,
}: {
  cwd: string;
  /** 右侧面板打开且页面可见；不可见时暂停轮询 */
  visible: boolean;
  onTotals: (t: { add: number; del: number }) => void;
}) {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState<"commit" | "push" | null>(null);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<GitStatusDto>("git_status", { cwd });
      setStatus(s);
      onTotals({ add: s.totalAdd, del: s.totalDel });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [cwd, onTotals]);

  // cwd / 可见性变化立即刷新；可见时每 8s 轮询
  useEffect(() => {
    void refresh();
    if (!visible) return;
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh, visible]);

  async function doCommit(push: boolean) {
    setRunning(push ? "push" : "commit");
    setOutput(null);
    try {
      const out = await invoke<string>("git_commit", {
        cwd,
        message: message.trim(),
        push,
      });
      setOutput({ ok: true, text: out });
      setMessage("");
    } catch (e) {
      setOutput({ ok: false, text: String(e) });
    } finally {
      setRunning(null);
      void refresh();
    }
  }

  const hasChanges = (status?.files.length ?? 0) > 0;
  const canCommit = hasChanges && message.trim().length > 0 && running === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：分支 / 上游差距 / 总增删 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-100 px-3 py-2 text-xs">
        {status?.isRepo ? (
          <>
            <span className="font-medium text-neutral-700">⑂ {status.branch}</span>
            {(status.ahead > 0 || status.behind > 0) && (
              <span className="text-neutral-500">
                {status.ahead > 0 && `↑${status.ahead}`}
                {status.behind > 0 && ` ↓${status.behind}`}
              </span>
            )}
            {(status.totalAdd > 0 || status.totalDel > 0) && (
              <span className="ml-auto font-mono">
                <span className="text-green-600">+{status.totalAdd}</span>{" "}
                <span className="text-red-600">-{status.totalDel}</span>
              </span>
            )}
          </>
        ) : (
          <span className="text-neutral-400">git</span>
        )}
      </div>

      {/* 文件列表 */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <p className="p-1 text-xs text-red-600">{error}</p>
        ) : !status ? (
          <p className="p-1 text-xs text-neutral-400">加载中…</p>
        ) : !status.isRepo ? (
          <p className="p-1 text-sm text-neutral-400">当前目录不是 git 仓库</p>
        ) : status.files.length === 0 ? (
          <p className="p-1 text-sm text-neutral-400">工作区干净 ✓</p>
        ) : (
          status.files.map((f) => (
            <div
              key={`${f.status}:${f.path}`}
              title={f.path}
              className="flex items-center gap-1.5 px-1 py-1 text-xs"
            >
              <span
                className={`shrink-0 rounded px-1 font-mono ${STATUS_STYLE[f.status] ?? "bg-neutral-100 text-neutral-600"}`}
              >
                {f.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-neutral-700">
                {f.path}
              </span>
              {(f.additions !== null || f.deletions !== null) && (
                <span className="shrink-0 font-mono">
                  {f.additions !== null && (
                    <span className="text-green-600">+{f.additions}</span>
                  )}{" "}
                  {f.deletions !== null && f.deletions > 0 && (
                    <span className="text-red-600">-{f.deletions}</span>
                  )}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      {/* 提交区 */}
      {status?.isRepo && (
        <div className="shrink-0 border-t border-neutral-200 p-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCommit) void doCommit(false);
            }}
            placeholder="提交信息（Enter 提交）"
            disabled={running !== null}
            className="mb-2 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <div className="flex gap-2">
            <button
              onClick={() => void doCommit(false)}
              disabled={!canCommit}
              className="flex-1 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {running === "commit" ? "提交中…" : "提交"}
            </button>
            <button
              onClick={() => void doCommit(true)}
              disabled={!canCommit}
              className="flex-1 rounded border border-blue-600 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              {running === "push" ? "推送中…" : "提交并推送"}
            </button>
          </div>
          {output && (
            <pre
              className={`mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded p-2 font-mono text-xs ${
                output.ok ? "bg-neutral-50 text-neutral-600" : "bg-red-50 text-red-700"
              }`}
            >
              {output.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
