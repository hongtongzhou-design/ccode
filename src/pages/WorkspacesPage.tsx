import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import ContextMenu from "../components/ContextMenu";
import { PageFrame, PageHeader, primaryActionClass } from "../components/PageFrame";
import type {
  GitCommitResultDto,
  RepoDto,
  RunScriptDto,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
  WorkspaceMergeResultDto,
  WorkspacePrResultDto,
  WsSettingsDto,
} from "../types";

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

/** 保留工作区的合并已完成，且分支尚未产生新的待合并提交。 */
function isMerged(ws: WorkspaceDto, health: WorkspaceHealthDto | undefined): boolean {
  return ws.status === "active" && !!ws.mergedAt && health?.ahead === 0;
}

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
function sanitizeBranch(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** 工作区 → 终端的交接：取端口段 env，交给终端页开新标签；预填该目录上次使用的配置（W3-C） */
function useOpenInTerminal() {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  return async (ws: WorkspaceDto) => {
    const pairs = await invoke<[string, string][]>("workspace_env_for", {
      worktreePath: ws.worktreePath,
    });
    const last = (() => {
      try {
        return JSON.parse(
          localStorage.getItem(`ccode.wsLast.${ws.worktreePath}`) ?? "{}",
        ) as Partial<{ agentId: string; profileId: string; model: string }>;
      } catch {
        return {};
      }
    })();
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: Object.fromEntries(pairs),
      title: ws.name,
      agentId: last.agentId,
      profileId: last.profileId,
      model: last.model,
    });
    setPage("terminal");
  };
}

const field =
  "w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

function NewWorkspaceModal({
  repos,
  reposLoading,
  onClose,
  onCreated,
}: {
  /** 页面级预热的候选仓库（后端聚合的会话目录，已过滤为真实存在的 git 仓库） */
  repos: RepoDto[];
  reposLoading: boolean;
  onClose: () => void;
  onCreated: (ws: WorkspaceDto) => void;
}) {
  const [repoChoice, setRepoChoice] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 仓库列表由页面预热传入；就绪后默认选中第一个，为空/加载失败兜底手动输入
  useEffect(() => {
    if (reposLoading) return;
    setRepoChoice((c) => c || repos[0]?.path || "__custom__");
  }, [repos, reposLoading]);

  const repoPath = repoChoice === "__custom__" ? customPath.trim() : repoChoice;
  const branch = `ccode/${sanitizeBranch(name)}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const ws = await invoke<WorkspaceDto>("create_workspace", {
        repoPath,
        name: name.trim(),
      });
      onCreated(ws);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[26rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">新建工作区</h2>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">仓库</span>
          <select
            className={field}
            value={repoChoice}
            disabled={reposLoading}
            onChange={(e) => setRepoChoice(e.target.value)}
          >
            {reposLoading && <option value="">加载仓库列表…</option>}
            {repos.map((r) => (
              <option key={r.path} value={r.path} title={r.path}>
                {r.name}（{r.path}）
              </option>
            ))}
            <option value="__custom__">其他目录…</option>
          </select>
        </label>
        {repoChoice === "__custom__" && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">仓库路径</span>
            <input
              className={field}
              required
              placeholder="~/work/myproject"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
            />
          </label>
        )}
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">任务名</span>
          <input
            className={field}
            required
            placeholder="如 fix-login"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {name.trim() && (
            <span className="mt-1 block font-mono text-xs text-l4">
              分支：{branch}
            </span>
          )}
        </label>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={creating || !name.trim() || !repoPath}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PrModal({ ws, onClose }: { ws: WorkspaceDto; onClose: () => void }) {
  const [title, setTitle] = useState(ws.name);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [pushed, setPushed] = useState(false);

  /** ◈ AI 起草 PR 描述：body 为空直接起草；非空先确认覆盖 */
  async function onDraft() {
    if (body.trim() && !window.confirm("将用 AI 起草覆盖当前描述，继续？")) return;
    setAiDrafting(true);
    setError(null);
    try {
      const md = await invoke<string>("ai_draft_pr", { id: ws.id });
      setBody(md);
    } catch (e) {
      setError(`${e}（检查设置页「AI 专用配置」是否可用，或换更快的模型）`);
    } finally {
      setAiDrafting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<WorkspacePrResultDto>("create_pr", {
        id: ws.id,
        title: title.trim(),
        body: body.trim() || null,
        skipPush: pushed,
      });
      setPushed(result.pushed);
      if (result.prCreated && result.prUrl) setPrUrl(result.prUrl);
      else setError(result.message);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[26rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">
          创建 PR（{ws.branch} → {ws.baseBranch}）
        </h2>
        {prUrl ? (
          <div className="mb-4">
            <p className="mb-2 text-sm text-ok-text">✓ PR 已创建</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void openUrl(prUrl)}
                title={prUrl}
                className="truncate text-sm text-l1 underline decoration-l4 underline-offset-2 hover:decoration-l1"
              >
                {prUrl}
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(prUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="shrink-0 rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5"
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-xs text-l3">标题</span>
              <input
                className={field}
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="mb-4 block text-sm">
              <span className="mb-1 flex items-center justify-between">
                <span className="text-xs text-l3">描述</span>
                <button
                  type="button"
                  onClick={onDraft}
                  disabled={aiDrafting}
                  title="AI 起草 PR 描述"
                  className={`rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50 ${
                    aiDrafting ? "animate-pulse" : ""
                  }`}
                >
                  {aiDrafting ? "◈ 起草中…" : "◈ AI 起草"}
                </button>
              </span>
              <textarea
                className={`${field} h-20`}
                placeholder="留空自动生成提交摘要"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
          </>
        )}
        <div className="flex justify-end gap-2">
          {prUrl ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
            >
              关闭
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy || !title.trim()}
                className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "创建中…" : pushed ? "重试创建 PR" : "创建 PR"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function ArchiveModal({
  ws,
  onClose,
  onDone,
}: {
  ws: WorkspaceDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const [message, setMessage] = useState(`chore: 保存 ${ws.name}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    let commitCompleted = committed;
    try {
      if (!committed) {
        const result = await invoke<GitCommitResultDto>("git_commit", {
          cwd: ws.worktreePath,
          message: message.trim(),
          push: false,
        });
        if (!result.committed) throw new Error(result.message);
        commitCompleted = result.committed;
        setCommitted(result.committed);
      }
      await invoke("archive_workspace", { id: ws.id });
      onDone();
    } catch (reason) {
      setError(`${commitCompleted ? "提交已完成，仅归档未完成：" : ""}${reason}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[26rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-2 text-base font-semibold text-l1">提交并归档</h2>
        <p className="mb-4 text-xs text-l3">工作区有未提交改动。先提交到 {ws.branch}，再移除工作树；分支仍可恢复。</p>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-l3">提交信息</span>
          <input
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={committed}
            className={field}
          />
        </label>
        {error && <div className="mb-3 bg-inset p-2 text-xs text-err-text">✗ {error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5">
            取消
          </button>
          <button
            type="submit"
            disabled={busy || (!committed && !message.trim())}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "处理中…" : committed ? "重试归档" : "提交并归档"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function WorkspacesPage({ visible }: { visible: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [settings, setSettings] = useState<Record<string, WsSettingsDto>>({});
  const [health, setHealth] = useState<Record<string, WorkspaceHealthDto>>({});
  const [drift, setDrift] = useState<Record<string, WorkspaceDriftDto>>({});
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [created, setCreated] = useState<WorkspaceDto | null>(null);
  const [runMenu, setRunMenu] = useState<{ x: number; y: number; ws: WorkspaceDto } | null>(null);
  const [mergeResults, setMergeResults] = useState<
    Record<string, { status: "ok" | "partial" | "error"; text: string }>
  >({});
  // 「合并 ▾」下拉（只合并 / 合并并归档）
  const [mergeMenu, setMergeMenu] = useState<{ x: number; y: number; ws: WorkspaceDto } | null>(
    null,
  );
  const [prModal, setPrModal] = useState<WorkspaceDto | null>(null);
  const [archiveModal, setArchiveModal] = useState<WorkspaceDto | null>(null);
  // 新建弹窗的仓库候选在页面可见时预热（list_repos 扫描慢，避免弹窗内空等）
  const [repos, setRepos] = useState<RepoDto[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const openInTerminal = useOpenInTerminal();
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore((s) => s.setWorkspaceReviewRequest);
  const setPage = useAppStore((s) => s.setPage);
  const setSessionsQuery = useAppStore((s) => s.setSessionsQuery);
  const runningScripts = useAppStore((s) => s.runningScripts);

  async function refresh() {
    try {
      const list = await invoke<WorkspaceDto[]>("list_workspaces");
      setWorkspaces(list);
      const driftEntries = await Promise.all(
        list.map(async (workspace) => {
          try {
            return [
              workspace.id,
              await invoke<WorkspaceDriftDto>("workspace_drift", { id: workspace.id }),
            ] as const;
          } catch {
            return null;
          }
        }),
      );
      setDrift(Object.fromEntries(driftEntries.filter((entry) => entry !== null)));
      // 活跃工作区所在仓库的 settings（按 repoPath 缓存，不重复拉取）
      const repos = [
        ...new Set(list.filter((w) => w.status === "active").map((w) => w.repoPath)),
      ];
      const entries = await Promise.all(
        repos.map(async (r) => {
          try {
            return [r, await invoke<WsSettingsDto>("workspace_settings", { repoPath: r })] as const;
          } catch {
            return null; // 无 settings.toml / 读取失败的仓库静默跳过
          }
        }),
      );
      setSettings((prev) => {
        const next = { ...prev };
        for (const e of entries) {
          // 每次刷新无条件覆盖：settings.toml 新建/修改后回到本页即生效
          if (e) next[e[0]] = e[1];
        }
        return next;
      });
      // 活跃工作区的健康度（每次刷新覆盖，ReadyToMerge 判定随提交/合并变化）
      const activeIds = list.filter((w) => w.status === "active").map((w) => w.id);
      const healthEntries = await Promise.all(
        activeIds.map(async (id) => {
          try {
            return [id, await invoke<WorkspaceHealthDto>("workspace_health", { id })] as const;
          } catch {
            return null;
          }
        }),
      );
      setHealth((prev) => {
        const next = { ...prev };
        for (const e of healthEntries) {
          if (e) next[e[0]] = e[1];
        }
        return next;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 合并回 base：archive=false 只合并（工作区保留），true 合并并归档；输出显示在行内结果条 */
  async function onMerge(ws: WorkspaceDto, archive: boolean) {
    if (
      !window.confirm(
        archive
          ? `将把 ${ws.branch} 合并进 ${ws.baseBranch} 并归档工作区（worktree 将被移除）。继续？`
          : `将把 ${ws.branch} 合并进 ${ws.baseBranch}（工作区保留，可继续干活或之后归档）。继续？`,
      )
    )
      return;
    try {
      const out = await invoke<WorkspaceMergeResultDto>("merge_workspace", { id: ws.id, archive });
      setMergeResults((prev) => ({
        ...prev,
        [ws.id]: {
          status: out.failedPhase ? "partial" : "ok",
          text: out.failedPhase ? out.message : out.output,
        },
      }));
      await refresh();
    } catch (e) {
      setMergeResults((prev) => ({ ...prev, [ws.id]: { status: "error", text: String(e) } }));
    }
  }

  /** run 脚本：开 shell 标签并立即执行命令；wsId 用于 nonconcurrent 互斥 */
  async function runScript(ws: WorkspaceDto, script: RunScriptDto) {
    const pairs = await invoke<[string, string][]>("workspace_env_for", {
      worktreePath: ws.worktreePath,
    });
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: Object.fromEntries(pairs),
      title: `run: ${script.name}`,
      prefillCommand: script.command,
      shellOnly: true,
      wsId: ws.id,
    });
    setPage("terminal");
  }

  useEffect(() => {
    if (!visible) return;
    void refresh();
    // 预热新建弹窗的仓库候选；失败保持空列表，弹窗兜底 __custom__ 手动输入
    setReposLoading(true);
    invoke<RepoDto[]>("list_repos")
      .then(setRepos)
      .catch(() => {})
      .finally(() => setReposLoading(false));
  }, [visible]);

  async function onArchive(ws: WorkspaceDto) {
    if (runningScripts[ws.id]) {
      setError("该工作区仍有 run 脚本在运行，请先停止或关闭对应终端标签");
      return;
    }
    try {
      const mergeState = await invoke<{ merging: boolean; files: string[] }>(
        "workspace_unmerged_files",
        { id: ws.id },
      );
      if (mergeState.merging || mergeState.files.length > 0) {
        setError("工作区存在未完成的合并或冲突，请先完成或中止冲突处理后再归档");
        return;
      }
    } catch (e) {
      setError(String(e));
      return;
    }
    let latestHealth: WorkspaceHealthDto;
    try {
      latestHealth = await invoke<WorkspaceHealthDto>("workspace_health", { id: ws.id });
      setHealth((prev) => ({ ...prev, [ws.id]: latestHealth }));
    } catch (e) {
      setError(String(e));
      return;
    }
    if (latestHealth.uncommitted) {
      setArchiveModal(ws);
      return;
    }
    if (!window.confirm("归档后 worktree 将被移除（分支保留，可随时恢复）。继续？"))
      return;
    try {
      await invoke("archive_workspace", { id: ws.id });
      // 清掉指向该工作区的「已创建」横幅，避免归档后残留
      setCreated((c) => (c?.id === ws.id ? null : c));
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRestore(ws: WorkspaceDto) {
    try {
      await invoke("restore_workspace", { id: ws.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(ws: WorkspaceDto) {
    if (
      !window.confirm(
        `将删除 worktree、分支 ${ws.branch} 和元数据，不可恢复。继续？`,
      )
    )
      return;
    try {
      await invoke("delete_workspace", { id: ws.id });
      // 清掉指向该工作区的「已创建」横幅，避免删除后残留
      setCreated((c) => (c?.id === ws.id ? null : c));
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRepairRemount(ws: WorkspaceDto) {
    try {
      await invoke<WorkspaceDto>("workspace_repair_remount", { id: ws.id });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onRelocate(ws: WorkspaceDto) {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    try {
      await invoke<WorkspaceDto>("workspace_relocate_repo", {
        id: ws.id,
        newRepoPath: selected,
      });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onMarkArchived(ws: WorkspaceDto) {
    if (!window.confirm("仅把 Ccode 记录标记为已归档，不删除分支。继续？")) return;
    try {
      await invoke("workspace_mark_archived", { id: ws.id });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onCleanRecord(ws: WorkspaceDto) {
    if (
      !window.confirm(
        `只清理 Ccode 中「${ws.name}」的记录并释放端口，不删除磁盘目录或 Git 分支。继续？`,
      )
    )
      return;
    try {
      await invoke("workspace_clean_record", { id: ws.id });
      setCreated((current) => (current?.id === ws.id ? null : current));
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  const active = workspaces.filter((w) => w.status === "active");
  const repoCount = new Set(workspaces.map((w) => w.repoPath)).size;
  // 按仓库分组（保持出现顺序）
  const groups = [...new Set(workspaces.map((w) => w.repoPath))].map((rp) => ({
    repoPath: rp,
    repoName: workspaces.find((w) => w.repoPath === rp)!.repoName,
    list: workspaces.filter((w) => w.repoPath === rp),
  }));

  const actionBtn = "rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5";

  return (
    <PageFrame width="standard">
      <PageHeader
        title="工作区"
        meta={`${active.length} 个活跃 · ${repoCount} 个仓库`}
        actions={
          <button
            onClick={() => setModal(true)}
            className={primaryActionClass}
          >
            + 新建工作区
          </button>
        }
      />
      {error && <p className="mb-4 text-sm text-err-text">{error}</p>}
      {created && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded bg-strip p-2 text-xs text-l2">
          <span>
            <span className="mr-1 text-okb">✓</span>
            已创建「{created.name}」（{created.branch}）— 已在终端就绪：打开终端开始使用
          </span>
          {created.setupResult &&
            (created.setupResult.ok ? (
              <span className="text-okb">setup 脚本完成</span>
            ) : (
              <span className="rounded bg-err px-1.5 py-0.5 text-err-text">
                setup 脚本失败
                <details className="mt-1">
                  <summary className="cursor-pointer">输出</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">
                    {created.setupResult.outputTail}
                  </pre>
                </details>
              </span>
            ))}
          <button
            onClick={() => {
              const ws = created;
              setCreated(null);
              void openInTerminal(ws);
            }}
            className="ml-auto shrink-0 rounded border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110"
          >
            打开终端
          </button>
          <button
            onClick={() => setCreated(null)}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-l3 hover:bg-white/5 hover:text-l1"
          >
            ×
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-l3">暂无工作区</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.repoPath} className="mb-5">
            <h2 className="mb-1 text-sm font-medium text-l1" title={g.repoPath}>
              {g.repoName}
              <span className="ml-2 text-xs font-normal text-l4">{g.repoPath}</span>
              {g.list.some((w) => w.status === "active" && health[w.id]?.mainDirty) && (
                <span
                  className="ml-2 inline-flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs font-normal text-l3"
                  title="主仓库有未提交改动——本地合并会被拒；建议先提交/stash，或新工作直接建工作区隔离"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                  主仓有改动
                </span>
              )}
            </h2>
            <ul className="divide-y divide-hairline">
              {g.list.map((ws) => (
                <li key={ws.id} className="py-2.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-l1">{ws.name}</span>
                    <span className="text-xs text-l3">
                      {ws.branch} → {ws.baseBranch}
                    </span>
                    <span className="text-xs text-l4">
                      端口 {ws.portBase}–{ws.portBase + 9}
                    </span>
                    <span className="text-xs text-l4">{relTime(ws.createdAt)}</span>
                    {ws.status === "active" ? (
                      <span className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                        <span className="h-1.5 w-1.5 rounded-full bg-okb" />
                        活跃
                      </span>
                    ) : ws.status === "creating" ? (
                      <span className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-warn-text">
                        <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                        创建未完成
                      </span>
                    ) : (
                      <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                        已归档
                      </span>
                    )}
                    {drift[ws.id] && !drift[ws.id].healthy && (
                      <span
                        className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-warn-text"
                        title={drift[ws.id].issues.map((issue) => issue.message).join("\n")}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                        状态需修复
                      </span>
                    )}
                    {ws.status === "active" && ws.mergedAt && health[ws.id]?.ahead === 0 && (
                      <span
                        className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-okb"
                        title={`已于 ${relTime(ws.mergedAt)}合并进 ${ws.baseBranch}（工作区保留）；继续提交后此标记消失`}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-okb" />
                        已合并
                      </span>
                    )}
                    {ws.status === "active" &&
                      (() => {
                        const h = health[ws.id];
                        if (!h) return null;
                        return (
                          <>
                            {h.conflict === true && (
                              <span
                                className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3"
                                title={
                                  h.conflictFiles.length
                                    ? `冲突文件：${h.conflictFiles.join("、")}——点「解决冲突」进入全屏审阅`
                                    : "与基准分支冲突——点「解决冲突」进入全屏审阅"
                                }
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-err-text" />
                                有冲突
                              </span>
                            )}
                            {h.uncommitted && (
                              <span className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                                <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                                有未提交
                              </span>
                            )}
                            {h.mainDirty && (
                              <span
                                className="flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3"
                                title="主仓库有未提交改动，本地合并会被拒；先提交或 stash"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                                主仓有改动
                              </span>
                            )}
                            {h.ahead > 0 && (
                              <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                                ↑{h.ahead}
                              </span>
                            )}
                            {h.behind > 0 && (
                              <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                                ↓{h.behind}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {drift[ws.id] && !drift[ws.id].healthy && (
                        <>
                          {drift[ws.id].canResolveMerge && (
                            <button
                              onClick={() => {
                                setWorkspaceReviewRequest({ worktreePath: ws.worktreePath });
                                setPage("terminal");
                              }}
                              className={`${actionBtn} text-warnb`}
                            >
                              继续解决
                            </button>
                          )}
                          {drift[ws.id].canRemount && (
                            <button onClick={() => void onRepairRemount(ws)} className={actionBtn}>
                              重新挂载
                            </button>
                          )}
                          {drift[ws.id].canRelocate && (
                            <button onClick={() => void onRelocate(ws)} className={actionBtn}>
                              重新定位
                            </button>
                          )}
                          {drift[ws.id].canMarkArchived && (
                            <button onClick={() => void onMarkArchived(ws)} className={actionBtn}>
                              标记归档
                            </button>
                          )}
                          {drift[ws.id].canCleanRecord && (
                            <button
                              onClick={() => void onCleanRecord(ws)}
                              className="rounded px-2 py-0.5 text-xs text-err-text hover:bg-white/5"
                            >
                              清理记录
                            </button>
                          )}
                        </>
                      )}
                      {ws.status === "active" && drift[ws.id]?.healthy === true && (
                        <>
                          {(() => {
                            const wsSettings = settings[ws.repoPath];
                            const scripts = wsSettings?.run ?? [];
                            if (scripts.length === 0) return null;
                            const defaultScript =
                              scripts.find((s) => s.default) ?? scripts[0];
                            const blocked =
                              wsSettings?.runMode === "nonconcurrent" &&
                              !!runningScripts[ws.id];
                            const blockedTip = "已有运行中的脚本（nonconcurrent）";
                            return (
                              <>
                                <button
                                  disabled={blocked}
                                  title={blocked ? blockedTip : `运行 ${defaultScript.name}：${defaultScript.command}`}
                                  onClick={() => void runScript(ws, defaultScript)}
                                  className={`${actionBtn} disabled:opacity-50`}
                                >
                                  ▶
                                </button>
                                {scripts.length > 1 && (
                                  <button
                                    disabled={blocked}
                                    title={blocked ? blockedTip : "选择脚本"}
                                    onClick={(e) => {
                                      const r = e.currentTarget.getBoundingClientRect();
                                      setRunMenu({ x: r.left, y: r.bottom + 4, ws });
                                    }}
                                    className={`${actionBtn} disabled:opacity-50`}
                                  >
                                    ▾
                                  </button>
                                )}
                              </>
                            );
                          })()}
                          <button
                            onClick={() => void openInTerminal(ws)}
                            className={actionBtn}
                          >
                            打开终端
                          </button>
                          <button
                            onClick={() => {
                              setWorkspaceReviewRequest({
                                worktreePath: ws.worktreePath,
                              });
                              setPage("terminal");
                            }}
                            title={
                              health[ws.id]?.conflict
                                ? "进入全屏冲突审阅，比较两侧内容并选择版本"
                                : "打开全宽任务审阅，完成提交与合并"
                            }
                            className={`${actionBtn} ${health[ws.id]?.conflict ? "text-warnb" : ""}`}
                          >
                            {health[ws.id]?.conflict ? "解决冲突" : "评审"}
                          </button>
                          <span className="flex shrink-0 items-center">
                            <button
                              disabled={isMerged(ws, health[ws.id]) || !health[ws.id]?.readyToMerge}
                              title={(() => {
                                const h = health[ws.id];
                                if (!h) return "健康度检查中…";
                                if (isMerged(ws, h))
                                  return `已合并进 ${ws.baseBranch}；产生新提交后可再次合并`;
                                if (h.readyToMerge)
                                  return `合并 ${ws.branch} 进 ${ws.baseBranch}（保留工作区；▾ 可选合并并归档）`;
                                // 逐条列出不可合并的原因（含主仓库状态）
                                const reasons: string[] = [];
                                if (h.ahead === 0) reasons.push("没有待合并提交");
                                if (h.uncommitted) reasons.push("分支有未提交改动");
                                if (h.conflict) reasons.push("与基准分支冲突");
                                if (h.mainDirty) reasons.push("主仓库有未提交改动");
                                if (h.mainOffBase) reasons.push(`主仓库不在 ${ws.baseBranch} 分支`);
                                return `尚不可合并：${reasons.join("；") || "检查中"}`;
                              })()}
                              onClick={() => void onMerge(ws, false)}
                              className={
                                // 可合并状态用按钮本身的强调色高亮表达（不再用单独 pill）
                                !isMerged(ws, health[ws.id]) && health[ws.id]?.readyToMerge
                                  ? "rounded-l border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110"
                                  : `${actionBtn} disabled:opacity-50`
                              }
                            >
                              {isMerged(ws, health[ws.id]) ? "已合并" : "合并"}
                            </button>
                            <button
                              disabled={isMerged(ws, health[ws.id]) || !health[ws.id]?.readyToMerge}
                              title={isMerged(ws, health[ws.id]) ? "当前没有新的待合并提交" : "合并方式"}
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setMergeMenu({ x: r.right - 176, y: r.bottom + 4, ws });
                              }}
                              className={
                                !isMerged(ws, health[ws.id]) && health[ws.id]?.readyToMerge
                                  ? "rounded-r border-y border-r border-cta-bd bg-cta px-1 py-0.5 text-xs text-cta-text hover:brightness-110"
                                  : `${actionBtn} disabled:opacity-50`
                              }
                            >
                              ▾
                            </button>
                          </span>
                          <button onClick={() => setPrModal(ws)} className={actionBtn}>
                            创建 PR
                          </button>
                          <button onClick={() => onArchive(ws)} className={actionBtn}>
                            归档
                          </button>
                        </>
                      )}
                      {ws.status === "archived" && drift[ws.id]?.healthy === true && (
                        <button onClick={() => onRestore(ws)} className={actionBtn}>
                          恢复
                        </button>
                      )}
                      <button
                        title="在会话页查看该工作区的会话"
                        onClick={() => {
                          setSessionsQuery(ws.name);
                          setPage("sessions");
                        }}
                        className={actionBtn}
                      >
                        会话
                      </button>
                      {drift[ws.id]?.healthy === true && (
                        <button
                          onClick={() => onDelete(ws)}
                          className="rounded px-2 py-0.5 text-xs text-err-text hover:bg-white/5"
                        >
                          删除
                        </button>
                      )}
                    </span>
                  </div>
                  {drift[ws.id] && !drift[ws.id].healthy && (
                    <div className="mt-1.5 rounded bg-inset px-2 py-1.5 text-xs text-warn-text">
                      {drift[ws.id].issues.map((issue) => issue.message).join(" · ")}
                    </div>
                  )}
                  {mergeResults[ws.id] && (
                    <div className="mt-1.5 flex items-start gap-2 rounded bg-strip p-2 text-xs text-l2">
                      <span
                        className={
                          mergeResults[ws.id].status === "ok"
                            ? "text-okb"
                            : mergeResults[ws.id].status === "partial"
                              ? "text-warn-text"
                              : "text-err-text"
                        }
                      >
                        {mergeResults[ws.id].status === "ok"
                          ? "✓"
                          : mergeResults[ws.id].status === "partial"
                            ? "!"
                            : "✗"}
                      </span>
                      <pre className="whitespace-pre-wrap break-all font-mono">
                        {mergeResults[ws.id].text}
                      </pre>
                      <button
                        onClick={() =>
                          setMergeResults((prev) => {
                            const n = { ...prev };
                            delete n[ws.id];
                            return n;
                          })
                        }
                        aria-label="关闭"
                        className="ml-auto shrink-0 text-l3 hover:text-l1"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {modal && (
        <NewWorkspaceModal
          repos={repos}
          reposLoading={reposLoading}
          onClose={() => setModal(false)}
          onCreated={(ws) => {
            setModal(false);
            setCreated(ws);
            void refresh();
          }}
        />
      )}
      {archiveModal && (
        <ArchiveModal
          ws={archiveModal}
          onClose={() => setArchiveModal(null)}
          onDone={() => {
            setArchiveModal(null);
            setCreated((c) => (c?.id === archiveModal.id ? null : c));
            void refresh();
          }}
        />
      )}
      {/* 「合并 ▾」下拉：只合并 / 合并并归档 */}
      {mergeMenu && (
        <ContextMenu
          x={mergeMenu.x}
          y={mergeMenu.y}
          onClose={() => setMergeMenu(null)}
          items={[
            {
              label: "合并（保留工作区）",
              onSelect: () => void onMerge(mergeMenu.ws, false),
            },
            {
              label: "合并并归档（移除工作树）",
              onSelect: () => void onMerge(mergeMenu.ws, true),
            },
          ]}
        />
      )}
      {runMenu && (
        <ContextMenu          x={runMenu.x}
          y={runMenu.y}
          onClose={() => setRunMenu(null)}
          items={(settings[runMenu.ws.repoPath]?.run ?? []).map((s) => ({
            label: `${s.name}（${s.command}）`,
            onSelect: () => void runScript(runMenu.ws, s),
          }))}
        />
      )}
      {prModal && <PrModal ws={prModal} onClose={() => setPrModal(null)} />}
    </PageFrame>
  );
}
