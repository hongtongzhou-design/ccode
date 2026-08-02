import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitFileDto, WorkspaceDiffDto } from "../types";

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
  M: "bg-warn text-warn-text",
  A: "bg-ok text-ok-text",
  "??": "bg-ok text-ok-text",
  D: "bg-err text-err-text",
  R: "bg-inset text-l3",
};

/**
 * 改动面板：活动标签 cwd 的 git 状态（8s 轮询）+ 提交/推送。
 * 输入提交信息并显式点击即视为用户同意，不再二次确认。
 */
function GitPanel({
  cwd,
  visible,
  refreshKey,
  onTotals,
}: {
  cwd: string;
  /** 右侧面板打开且页面可见；不可见时暂停轮询 */
  visible: boolean;
  /** 外部刷新信号（如 fs-changed 文件监听事件），变化时立即刷新 */
  refreshKey?: number;
  onTotals: (t: { add: number; del: number }) => void;
}) {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  /** 活动标签 cwd 落在工作区里时为任务累计 diff（W3），否则为 null */
  const [wsDiff, setWsDiff] = useState<WorkspaceDiffDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState<"commit" | "push" | null>(null);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  // 成功 toast（主题 CTA 绿，右下角浮出 2.5s 自动淡出）；失败仍走 output 红字详情
  const [toast, setToast] = useState<{ text: string; hiding: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(text: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, hiding: false });
    toastTimerRef.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, hiding: true } : t));
      toastTimerRef.current = setTimeout(() => setToast(null), 300);
    }, 2200);
  }

  /** ◈ AI 生成提交信息：填入输入框由用户审阅后再提交（不自动提交） */
  async function genMessage() {
    setAiBusy(true);
    try {
      const text = await invoke<string>("ai_commit_message", { cwd });
      setMessage(text.trim());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    let s: GitStatusDto | null = null;
    try {
      s = await invoke<GitStatusDto>("git_status", { cwd });
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    // 工作区探测：cwd 落在 worktree 里时切任务 diff 视图；失败/非工作区保持普通视图
    let d: WorkspaceDiffDto | null = null;
    try {
      const diff = await invoke<WorkspaceDiffDto>("workspace_diff", {
        worktreePath: cwd,
      });
      if (diff.inWorkspace) d = diff;
    } catch {
      // 保持普通 git 视图
    }
    setWsDiff(d);
    onTotals(
      d
        ? { add: d.totalAdd, del: d.totalDel }
        : { add: s?.totalAdd ?? 0, del: s?.totalDel ?? 0 },
    );
  }, [cwd, onTotals]);

  // cwd / 可见性 / 外部信号变化立即刷新；可见时每 8s 轮询
  useEffect(() => {
    void refresh();
    if (!visible) return;
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh, visible, refreshKey]);

  async function doCommit(push: boolean) {
    setRunning(push ? "push" : "commit");
    setOutput(null);
    try {
      const out = await invoke<string>("git_commit", {
        cwd,
        message: message.trim(),
        push,
      });
      // 提交输出首行形如 [branch abc1234] msg，提取出来让 toast 带提交号
      const bracket = out.match(/\[([^\]]+)\]/)?.[1];
      showToast(
        `${push ? "提交并推送成功" : "提交成功"}${bracket ? ` · ${bracket}` : ""}`,
      );
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
  const inWs = wsDiff?.inWorkspace === true;
  const files = inWs ? wsDiff!.files : (status?.files ?? []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：分支 / 上游差距（工作区模式：任务基准）/ 总增删 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2 text-xs">
        {status?.isRepo ? (
          inWs ? (
            <>
              <span className="font-medium text-l1">⑂ {status.branch}</span>
              <span className="text-l3">
                → 基准 {wsDiff!.baseBranch}（{wsDiff!.mergeBase.slice(0, 7)}）
              </span>
              {(wsDiff!.totalAdd > 0 || wsDiff!.totalDel > 0) && (
                <span className="ml-auto font-mono">
                  <span className="text-add">+{wsDiff!.totalAdd}</span>{" "}
                  <span className="text-del">-{wsDiff!.totalDel}</span>
                </span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-l1">⑂ {status.branch}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="text-l3">
                  {status.ahead > 0 && `↑${status.ahead}`}
                  {status.behind > 0 && ` ↓${status.behind}`}
                </span>
              )}
              {(status.totalAdd > 0 || status.totalDel > 0) && (
                <span className="ml-auto font-mono">
                  <span className="text-add">+{status.totalAdd}</span>{" "}
                  <span className="text-del">-{status.totalDel}</span>
                </span>
              )}
            </>
          )
        ) : (
          <span className="text-l4">git</span>
        )}
      </div>

      {/* 文件列表 */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <p className="p-1 text-xs text-err-text">{error}</p>
        ) : !status ? (
          <p className="p-1 text-xs text-l4">加载中…</p>
        ) : !status.isRepo ? (
          <p className="p-1 text-sm text-l4">
            该目录不是 git 仓库，无改动可显示
            <span className="block text-xs text-l4" title={cwd}>
              {cwd}
            </span>
          </p>
        ) : files.length === 0 ? (
          <p className="p-1 text-sm text-l4">
            {inWs ? "任务无改动 ✓" : "工作区干净 ✓"}
          </p>
        ) : (
          files.map((f) => (
            <div
              key={`${f.status}:${f.path}`}
              title={f.path}
              className="flex items-center gap-1.5 px-1 py-1 text-xs"
            >
              <span
                className={`shrink-0 rounded px-1 font-mono ${STATUS_STYLE[f.status] ?? "bg-inset text-l3"}`}
              >
                {f.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-l2">
                {f.path}
              </span>
              {(f.additions !== null || f.deletions !== null) && (
                <span className="shrink-0 font-mono">
                  {f.additions !== null && (
                    <span className="text-add">+{f.additions}</span>
                  )}{" "}
                  {f.deletions !== null && f.deletions > 0 && (
                    <span className="text-del">-{f.deletions}</span>
                  )}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      {/* 提交区 */}
      {status?.isRepo && (
        <div className="shrink-0 border-t border-hairline p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCommit) void doCommit(false);
              }}
              placeholder="提交信息（Enter 提交）"
              disabled={running !== null}
              className="w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4 disabled:opacity-50"
            />
            <button
              onClick={genMessage}
              disabled={!hasChanges || aiBusy || running !== null}
              title="AI 生成提交信息"
              className={`shrink-0 rounded px-2 py-1.5 text-sm text-l2 hover:bg-white/5 disabled:opacity-50 ${
                aiBusy ? "animate-pulse" : ""
              }`}
            >
              {aiBusy ? "◈…" : "◈"}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void doCommit(false)}
              disabled={!canCommit}
              className="flex-1 rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
            >
              {running === "commit" ? "提交中…" : "提交"}
            </button>
            <button
              onClick={() => void doCommit(true)}
              disabled={!canCommit}
              className="flex-1 rounded bg-btn px-3 py-1.5 text-sm text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              {running === "push" ? "推送中…" : "提交并推送"}
            </button>
          </div>
          {output && !output.ok && (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-inset p-2 font-mono text-xs text-err-text">
              {output.text}
            </pre>
          )}
        </div>
      )}
      {/* 提交/推送成功 toast：主题 CTA 绿，右下角浮出，2.5s 自动淡出 */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border border-cta-bd bg-cta px-3 py-2 text-sm text-cta-text transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <span>✓</span>
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 git 面板（其内部轮询/状态自更新不受影响） */
export default memo(GitPanel);
