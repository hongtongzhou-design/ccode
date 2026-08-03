import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import ContextMenu from "../components/ContextMenu";
import type { RepoDto, RunScriptDto, WorkspaceDto, WorkspaceDiffDto, WorkspaceHealthDto, WsSettingsDto } from "../types";

/** 评审面板文件状态字母（与 GitPanel 同款小徽章） */
const STATUS_STYLE: Record<string, string> = {
  M: "bg-warn text-warn-text",
  A: "bg-ok text-ok-text",
  "??": "bg-ok text-ok-text",
  D: "bg-err text-err-text",
  R: "bg-inset text-l3",
};

/** 冲突两侧内容预览（HEAD=分支侧 / base 侧） */
interface ConflictSides {
  ours: string[];
  theirs: string[];
  /** 冲突块总数（>1 时提示预览仅为首块） */
  blocks: number;
}

/** 解析冲突文件的首个冲突块（<<<<<<< HEAD … ======= … >>>>>>> main） */
function parseConflictSides(text: string): ConflictSides | null {
  const lines = text.split("\n");
  let start = -1,
    mid = -1,
    end = -1,
    blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<<<<<<<")) {
      blocks++;
      if (start === -1) start = i;
    } else if (lines[i].startsWith("=======") && start !== -1 && mid === -1) {
      mid = i;
    } else if (lines[i].startsWith(">>>>>>>") && mid !== -1 && end === -1) {
      end = i;
      break;
    }
  }
  if (start === -1 || mid === -1 || end === -1) return null;
  return { ours: lines.slice(start + 1, mid), theirs: lines.slice(mid + 1, end), blocks };
}

/** 按钮标签里的内容摘要（超 12 字符截断） */
function short(lines: string[] | undefined, fallback: string): string {
  const s = (lines ?? []).join(" ").trim() || fallback;
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

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
      const url = await invoke<string>("create_pr", {
        id: ws.id,
        title: title.trim(),
        body: body.trim() || null,
      });
      setPrUrl(url);
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
                {busy ? "创建中…" : "创建 PR"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

export default function WorkspacesPage({ visible }: { visible: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [settings, setSettings] = useState<Record<string, WsSettingsDto>>({});
  const [health, setHealth] = useState<Record<string, WorkspaceHealthDto>>({});
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [created, setCreated] = useState<WorkspaceDto | null>(null);
  const [runMenu, setRunMenu] = useState<{ x: number; y: number; ws: WorkspaceDto } | null>(null);
  const [mergeResults, setMergeResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  // 评审面板：展开的工作区 + 任务 diff + 逐文件 diff 内容（看完再决定合并/PR/归档）
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [review, setReview] = useState<WorkspaceDiffDto | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // 并入主分支（解冲突）的进行态与结果
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 「合并 ▾」下拉（只合并 / 合并并归档）
  const [mergeMenu, setMergeMenu] = useState<{ x: number; y: number; ws: WorkspaceDto } | null>(
    null,
  );
  // 并入后的未解决冲突清单（merging=处于并入状态；逐文件选边后缩减）
  const [unmerged, setUnmerged] = useState<{ merging: boolean; files: string[] } | null>(null);
  // 各冲突文件两侧内容预览（选边按钮旁展示，解决「不知道哪个对应哪个」）
  const [sides, setSides] = useState<Record<string, ConflictSides | null>>({});
  // ◈ AI 冲突审查建议（path → 选侧+理由）
  const [aiAdvice, setAiAdvice] = useState<Record<string, { choice: string; reason: string }> | null>(null);
  const [advising, setAdvising] = useState(false);
  const [prModal, setPrModal] = useState<WorkspaceDto | null>(null);
  // 新建弹窗的仓库候选在页面可见时预热（list_repos 扫描慢，避免弹窗内空等）
  const [repos, setRepos] = useState<RepoDto[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const openInTerminal = useOpenInTerminal();
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const setSessionsQuery = useAppStore((s) => s.setSessionsQuery);
  const runningScripts = useAppStore((s) => s.runningScripts);

  async function refresh() {
    try {
      const list = await invoke<WorkspaceDto[]>("list_workspaces");
      setWorkspaces(list);
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
      const out = await invoke<string>("merge_workspace", { id: ws.id, archive });
      setMergeResults((prev) => ({ ...prev, [ws.id]: { ok: true, text: out } }));
      await refresh();
    } catch (e) {
      setMergeResults((prev) => ({ ...prev, [ws.id]: { ok: false, text: String(e) } }));
    }
  }

  /** 拉取各冲突文件的两侧内容预览（选边界面用） */
  async function loadSides(ws: WorkspaceDto, files: string[]) {
    const entries = await Promise.all(
      files.map(async (f) => {
        try {
          const p = await invoke<{ text: string }>("read_file_preview", {
            path: `${ws.worktreePath}/${f}`,
            root: ws.worktreePath,
          });
          return [f, parseConflictSides(p.text)] as const;
        } catch {
          return [f, null] as const;
        }
      }),
    );
    setSides(Object.fromEntries(entries));
  }

  /** 评审面板：展开/收起该工作区的任务改动清单 */
  async function toggleReview(ws: WorkspaceDto) {
    if (reviewId === ws.id) {
      setReviewId(null);
      setReview(null);
      setDiffFor(null);
      setFileDiff(null);
      setSyncMsg(null);
      setUnmerged(null);
      setSides({});
      setAiAdvice(null);
      return;
    }
    setReviewId(ws.id);
    setReview(null);
    setDiffFor(null);
    setFileDiff(null);
    setSyncMsg(null);
    setUnmerged(null);
    setSides({});
    setAiAdvice(null);
    setReviewLoading(true);
    try {
      setReview(await invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath: ws.worktreePath }));
      // 顺带查并入状态：之前并入到一半（冲突未解决）时直接进解决界面
      const u = await invoke<{ merging: boolean; files: string[] }>("workspace_unmerged_files", {
        id: ws.id,
      }).catch(() => null);
      if (u?.merging) {
        setUnmerged(u);
        if (u.files.length > 0) void loadSides(ws, u.files);
      }
    } catch (e) {
      setError(String(e));
      setReviewId(null);
    } finally {
      setReviewLoading(false);
    }
  }

  /** 把基准分支并入本工作区：冲突留在工作区就地解（不碰主仓库），解完提交后合并解锁 */
  async function onSyncBase(ws: WorkspaceDto) {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const out = await invoke<string>("workspace_sync_base", { id: ws.id });
      setSyncMsg({ ok: true, text: out });
      await refresh();
    } catch (e) {
      // 冲突也是预期结果之一：拉取未解决清单与两侧内容，进入逐文件选边界面
      setSyncMsg({ ok: false, text: String(e) });
      const u = await invoke<{ merging: boolean; files: string[] }>("workspace_unmerged_files", {
        id: ws.id,
      }).catch(() => null);
      if (u?.merging) {
        setUnmerged(u);
        if (u.files.length > 0) void loadSides(ws, u.files);
      }
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  /** 单边解决一个冲突文件：ours=分支版 / theirs=基准版 */
  async function resolveSide(ws: WorkspaceDto, path: string, side: "ours" | "theirs") {
    try {
      setUnmerged(
        await invoke<{ merging: boolean; files: string[] }>("workspace_resolve_file", {
          id: ws.id,
          path,
          side,
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  /** 一键全选边：全部冲突文件用同一侧版本（theirs 会放弃分支改动，先确认） */
  async function resolveAll(ws: WorkspaceDto, side: "ours" | "theirs") {
    if (
      side === "theirs" &&
      !window.confirm(
        `将用 ${ws.baseBranch} 的版本覆盖全部冲突文件，分支上的对应改动会被放弃。继续？`,
      )
    )
      return;
    setSyncing(true);
    try {
      let u = unmerged;
      for (const f of unmerged?.files ?? []) {
        u = await invoke<{ merging: boolean; files: string[] }>("workspace_resolve_file", {
          id: ws.id,
          path: f,
          side,
        });
      }
      setUnmerged(u);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  /** ◈ AI 冲突审查：逐文件给选侧建议 + 理由（建议不自动执行，由用户点「按建议」确认） */
  async function onAiAdvice(ws: WorkspaceDto) {
    setAdvising(true);
    setError(null);
    try {
      const list = await invoke<{ path: string; choice: string; reason: string }[]>(
        "ai_conflict_advice",
        { id: ws.id },
      );
      setAiAdvice(Object.fromEntries(list.map((a) => [a.path, { choice: a.choice, reason: a.reason }])));
    } catch (e) {
      setError(String(e));
    } finally {
      setAdvising(false);
    }
  }

  /** 按 AI 建议全部执行（choice=manual 的文件跳过，留人工） */
  async function applyAllAdvice(ws: WorkspaceDto) {
    setSyncing(true);
    try {
      let u = unmerged;
      for (const f of unmerged?.files ?? []) {
        const a = aiAdvice?.[f];
        if (a && (a.choice === "ours" || a.choice === "theirs")) {
          u = await invoke<{ merging: boolean; files: string[] }>("workspace_resolve_file", {
            id: ws.id,
            path: f,
            side: a.choice,
          });
        }
      }
      setUnmerged(u);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  /** 全部选完后完成并入提交，随后刷新健康度与任务 diff */
  async function finishResolve(ws: WorkspaceDto) {
    setSyncing(true);
    try {
      const out = await invoke<string>("workspace_finish_merge", { id: ws.id });
      setSyncMsg({ ok: true, text: out });
      setUnmerged(null);
      setAiAdvice(null);
      await refresh();
      setReview(
        await invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath: ws.worktreePath }).catch(
          () => review,
        ),
      );
    } catch (e) {
      setSyncMsg({ ok: false, text: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  /** 评审面板里逐文件展开/收起 diff 内容 */
  async function toggleFileDiff(ws: WorkspaceDto, path: string) {
    if (diffFor === path) {
      setDiffFor(null);
      setFileDiff(null);
      return;
    }
    setDiffFor(path);
    setFileDiff(null);
    setDiffLoading(true);
    try {
      setFileDiff(await invoke<string>("workspace_file_diff", { worktreePath: ws.worktreePath, path }));
    } catch (e) {
      setFileDiff(`加载失败：${e}`);
    } finally {
      setDiffLoading(false);
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
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-l1">工作区</h1>
          <span className="text-xs text-l3">
            {active.length} 个活跃 · {repoCount} 个仓库
          </span>
        </div>
        <button
          onClick={() => setModal(true)}
          className="rounded px-2 py-1 text-sm text-l1 hover:bg-white/5"
        >
          新建工作区
        </button>
      </div>
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
        <p className="rounded border border-dashed border-field p-4 text-sm text-l4">
          还没有工作区——新建一个，让 agent 在隔离的 worktree 里干活
        </p>
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
                    ) : (
                      <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                        已归档
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
                                    ? `冲突文件：${h.conflictFiles.join("、")}——点「评审」查看并处理`
                                    : "与基准分支冲突——点「评审」查看并处理"
                                }
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-err-text" />
                                有冲突
                              </span>
                            )}
                            {h.uncommitted > 0 && (
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
                      {ws.status === "active" && (
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
                            onClick={() => void toggleReview(ws)}
                            title={
                              health[ws.id]?.conflict
                                ? "有冲突待处理——查看任务改动详情并解决"
                                : "查看任务改动详情（逐文件 diff），审完再决定合并/PR/归档"
                            }
                            className={`${actionBtn} ${
                              reviewId === ws.id ? "bg-white/10 text-l1" : ""
                            } ${health[ws.id]?.conflict ? "text-warnb" : ""}`}
                          >
                            评审
                          </button>
                          <span className="flex shrink-0 items-center">
                            <button
                              disabled={!health[ws.id]?.readyToMerge}
                              title={(() => {
                                const h = health[ws.id];
                                if (!h) return "健康度检查中…";
                                if (h.readyToMerge)
                                  return `合并 ${ws.branch} 进 ${ws.baseBranch}（保留工作区；▾ 可选合并并归档）`;
                                // 逐条列出不可合并的原因（含主仓库状态）
                                const reasons: string[] = [];
                                if (h.uncommitted) reasons.push("分支有未提交改动");
                                if (h.conflict) reasons.push("与基准分支冲突");
                                if (h.mainDirty) reasons.push("主仓库有未提交改动");
                                if (h.mainOffBase) reasons.push(`主仓库不在 ${ws.baseBranch} 分支`);
                                return `尚不可合并：${reasons.join("；") || "检查中"}`;
                              })()}
                              onClick={() => void onMerge(ws, false)}
                              className={
                                // 可合并状态用按钮本身的强调色高亮表达（不再用单独 pill）
                                health[ws.id]?.readyToMerge
                                  ? "rounded-l border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110"
                                  : `${actionBtn} disabled:opacity-50`
                              }
                            >
                              合并
                            </button>
                            <button
                              disabled={!health[ws.id]?.readyToMerge}
                              title="合并方式"
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setMergeMenu({ x: r.right - 176, y: r.bottom + 4, ws });
                              }}
                              className={
                                health[ws.id]?.readyToMerge
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
                      {ws.status === "archived" && (
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
                      <button
                        onClick={() => onDelete(ws)}
                        className="rounded px-2 py-0.5 text-xs text-err-text hover:bg-white/5"
                      >
                        删除
                      </button>
                    </span>
                  </div>
                  {mergeResults[ws.id] && (
                    <div className="mt-1.5 flex items-start gap-2 rounded bg-strip p-2 text-xs text-l2">
                      <span
                        className={
                          mergeResults[ws.id].ok ? "text-okb" : "text-err-text"
                        }
                      >
                        {mergeResults[ws.id].ok ? "✓" : "✗"}
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
                  {/* 评审面板：任务改动清单 + 逐文件彩色 diff；审完在行上决定合并/PR/归档 */}
                  {reviewId === ws.id && ws.status === "active" && (
                    <div className="mt-1.5 rounded bg-strip p-2 text-xs">
                      {reviewLoading || !review ? (
                        <p className="text-l4">计算任务改动…</p>
                      ) : (
                        <>
                          {(health[ws.id]?.conflict || unmerged?.merging) && (
                            <div className="mb-2 rounded bg-canvas p-2">
                              {unmerged?.merging ? (
                                <>
                                  <div className="mb-1 flex items-center gap-1 text-l3">
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-err-text" />
                                    并入冲突待解决——每个文件下方列出两边内容，点对应按钮选哪边：
                                    <button
                                      onClick={() => void onAiAdvice(ws)}
                                      disabled={advising}
                                      title="AI 逐个文件审查冲突，给出选侧建议与理由（建议需你确认后执行）"
                                      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-l3 hover:bg-white/5 hover:text-l1 disabled:opacity-50 ${
                                        advising ? "animate-pulse" : ""
                                      }`}
                                    >
                                      {advising ? "◈ 分析中…" : "◈ AI 建议"}
                                    </button>
                                  </div>
                                  {aiAdvice && unmerged.files.some((f) => {
                                    const c = aiAdvice[f]?.choice;
                                    return c === "ours" || c === "theirs";
                                  }) && (
                                    <div className="mb-1">
                                      <button
                                        onClick={() => void applyAllAdvice(ws)}
                                        disabled={syncing}
                                        title="按 AI 建议逐个执行（建议人工合并的文件跳过）"
                                        className="rounded bg-inset px-1.5 py-0.5 text-l2 hover:bg-white/10 disabled:opacity-50"
                                      >
                                        全部按 AI 建议执行
                                      </button>
                                    </div>
                                  )}
                                  {unmerged.files.length > 1 && (
                                    <div className="mb-1 flex items-center gap-2">
                                      <button
                                        onClick={() => void resolveAll(ws, "ours")}
                                        disabled={syncing}
                                        title="全部冲突文件保留本工作区（分支）的版本"
                                        className="rounded bg-inset px-1.5 py-0.5 text-l2 hover:bg-white/10 disabled:opacity-50"
                                      >
                                        全部选分支版
                                      </button>
                                      <button
                                        onClick={() => void resolveAll(ws, "theirs")}
                                        disabled={syncing}
                                        title={`全部冲突文件用 ${ws.baseBranch} 的版本覆盖（放弃分支对应改动，有确认）`}
                                        className="rounded bg-inset px-1.5 py-0.5 text-l2 hover:bg-white/10 disabled:opacity-50"
                                      >
                                        全部选 {ws.baseBranch} 版
                                      </button>
                                    </div>
                                  )}
                                  {unmerged.files.map((f) => {
                                    const sd = sides[f];
                                    return (
                                      <div key={f} className="border-l-2 border-err-text py-0.5 pl-1.5">
                                        <div className="flex items-center gap-2">
                                          <span className="min-w-0 flex-1 truncate font-mono text-err-text">
                                            {f}
                                          </span>
                                          <button
                                            onClick={() => void resolveSide(ws, f, "ours")}
                                            title="保留本工作区（分支）的改动"
                                            className="shrink-0 rounded bg-inset px-1.5 py-0.5 font-mono text-l2 hover:bg-white/10"
                                          >
                                            选「{short(sd?.ours, "分支版")}」
                                          </button>
                                          <button
                                            onClick={() => void resolveSide(ws, f, "theirs")}
                                            title={`用 ${ws.baseBranch} 的版本覆盖`}
                                            className="shrink-0 rounded bg-inset px-1.5 py-0.5 font-mono text-l2 hover:bg-white/10"
                                          >
                                            选「{short(sd?.theirs, `${ws.baseBranch} 版`)}」
                                          </button>
                                        </div>
                                        {sd && (
                                          <div className="ml-1 mt-0.5 space-y-0.5 text-[11px] text-l4">
                                            <div className="flex gap-1">
                                              <span className="shrink-0">分支：</span>
                                              <span className="min-w-0 truncate font-mono text-l2">
                                                {sd.ours.join(" / ") || "（空）"}
                                              </span>
                                            </div>
                                            <div className="flex gap-1">
                                              <span className="shrink-0">{ws.baseBranch}：</span>
                                              <span className="min-w-0 truncate font-mono text-l2">
                                                {sd.theirs.join(" / ") || "（空）"}
                                              </span>
                                            </div>
                                            {sd.blocks > 1 && (
                                              <div>
                                                （共 {sd.blocks} 处冲突，以上仅第 1
                                                处预览；逐行取舍请用预览编辑器）
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        {(() => {
                                          const a = aiAdvice?.[f];
                                          if (!a) return null;
                                          if (a.choice !== "ours" && a.choice !== "theirs")
                                            return (
                                              <div className="ml-1 mt-0.5 text-[11px] text-warnb">
                                                ◈ 建议人工逐行合并：{a.reason}
                                              </div>
                                            );
                                          const label =
                                            a.choice === "ours"
                                              ? short(sd?.ours, "分支版")
                                              : short(sd?.theirs, `${ws.baseBranch} 版`);
                                          return (
                                            <div className="ml-1 mt-0.5 flex items-center gap-2 text-[11px]">
                                              <span className="text-l4">◈</span>
                                              <span className="min-w-0 flex-1 truncate text-l3">
                                                建议选「{label}」：{a.reason}
                                              </span>
                                              <button
                                                onClick={() =>
                                                  void resolveSide(ws, f, a.choice as "ours" | "theirs")
                                                }
                                                title={`按 AI 建议选「${label}」`}
                                                className="shrink-0 rounded bg-inset px-1.5 py-0.5 text-l2 hover:bg-white/10"
                                              >
                                                按建议
                                              </button>
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    );
                                  })}
                                  {unmerged.files.length === 0 && (
                                    <div className="mt-1 flex items-center gap-2">
                                      <span className="text-okb">✓ 已全部选定</span>
                                      <button
                                        onClick={() => void finishResolve(ws)}
                                        disabled={syncing}
                                        className="rounded border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110 disabled:opacity-50"
                                      >
                                        {syncing ? "提交中…" : "完成解决并提交"}
                                      </button>
                                    </div>
                                  )}
                                  <p className="mt-1 text-l4">
                                    需要逐行取舍的文件：去工作区预览编辑器手动改（文件树里标
                                    U），改完在「改动」提交即可
                                  </p>
                                </>
                              ) : (
                                <>
                                  <div className="mb-1 flex items-center gap-1 text-l3">
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-err-text" />
                                    与 {ws.baseBranch} 冲突——以下文件两边改了同一处：
                                  </div>
                                  {(health[ws.id]?.conflictFiles ?? []).map((f) => (
                                    <p key={f} className="border-l-2 border-err-text pl-1.5 font-mono text-err-text">
                                      {f}
                                    </p>
                                  ))}
                                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                    <button
                                      onClick={() => void onSyncBase(ws)}
                                      disabled={syncing}
                                      className="rounded border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110 disabled:opacity-50"
                                    >
                                      {syncing ? "并入中…" : `把 ${ws.baseBranch} 并入本工作区`}
                                    </button>
                                    <span className="text-l4">
                                      点这里开始解决：并入后此处变成逐文件选边界面（也可全部选边），选完提交即解锁「合并」；全程不碰主仓库
                                    </span>
                                  </div>
                                </>
                              )}
                              {syncMsg && (
                                <pre
                                  className={`mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-inset p-1.5 font-mono ${
                                    syncMsg.ok ? "text-l2" : "text-err-text"
                                  }`}
                                >
                                  {syncMsg.text}
                                </pre>
                              )}
                            </div>
                          )}
                          <div className="mb-1 flex items-center gap-2 text-l3">
                            <span>任务改动（基准 {review.baseBranch}）</span>
                            <span className="font-mono">
                              <span className="text-add">+{review.totalAdd}</span>{" "}
                              <span className="text-del">-{review.totalDel}</span>
                            </span>
                            <span className="text-l4">{review.files.length} 个文件</span>
                          </div>
                          {review.files.length === 0 ? (
                            <p className="text-l4">
                              相对基准无改动——确认任务已提交后再点「合并」
                            </p>
                          ) : (
                            review.files.map((f) => (
                              <div key={`${f.status}:${f.path}`}>
                                <button
                                  onClick={() => void toggleFileDiff(ws, f.path)}
                                  className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-white/5"
                                >
                                  <span
                                    className={`shrink-0 rounded px-1 font-mono ${STATUS_STYLE[f.status] ?? "bg-inset text-l3"}`}
                                  >
                                    {f.status}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate font-mono text-l2">
                                    {f.path}
                                  </span>
                                  {f.additions !== null && (
                                    <span className="shrink-0 font-mono text-add">
                                      +{f.additions}
                                    </span>
                                  )}
                                  {f.deletions !== null && f.deletions > 0 && (
                                    <span className="shrink-0 font-mono text-del">
                                      -{f.deletions}
                                    </span>
                                  )}
                                  <span className="shrink-0 text-l4">
                                    {diffFor === f.path ? "▾" : "▸"}
                                  </span>
                                </button>
                                {diffFor === f.path &&
                                  (diffLoading && !fileDiff ? (
                                    <p className="px-2 py-1 text-l4">加载 diff…</p>
                                  ) : (
                                    <pre className="mb-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-[11px] leading-4">
                                      {(fileDiff ?? "").split("\n").map((l, i) => (
                                        <div
                                          key={i}
                                          className={
                                            l.startsWith("+") && !l.startsWith("+++")
                                              ? "text-add"
                                              : l.startsWith("-") && !l.startsWith("---")
                                                ? "text-del"
                                                : l.startsWith("@@")
                                                  ? "text-l4"
                                                  : "text-l3"
                                          }
                                        >
                                          {l || " "}
                                        </div>
                                      ))}
                                    </pre>
                                  ))}
                              </div>
                            ))
                          )}
                        </>
                      )}
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
    </div>
  );
}
