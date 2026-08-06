import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import ContextMenu from "../components/ContextMenu";
import ProjectGroup from "../components/ProjectGroup";
import {
  PageFrame,
  PageHeader,
  primaryActionClass,
} from "../components/PageFrame";
import type {
  ProjectConfigReadDto,
  ProjectDto,
  RepoDto,
  RunScriptDto,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
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
function isMerged(
  ws: WorkspaceDto,
  health: WorkspaceHealthDto | undefined,
): boolean {
  return ws.status === "active" && !!ws.mergedAt && health?.ahead === 0;
}

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
function sanitizeBranch(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** 项目注册路径为 canonical 绝对路径；与工作区 repoPath 比较前统一去尾部斜杠 */
function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
}

function pathBaseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 添加项目（§11.4 P1b）：目录已在弹窗外经系统对话框选定，这里只内联命名（WKWebView 无 window.prompt） */
function AddProjectModal({
  path,
  onClose,
  onRegistered,
}: {
  path: string;
  onClose: () => void;
  onRegistered: (project: ProjectDto) => void;
}) {
  const [name, setName] = useState(pathBaseName(path));
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await invoke<ProjectDto>("register_project", {
        path,
        name: name.trim(),
      });
      const topicText = topic.trim();
      if (topicText) {
        // 课题主题落进档案卡：先读后写，保留目录里已有的 resources/steps
        try {
          const read = await invoke<ProjectConfigReadDto>(
            "read_project_config",
            { path },
          );
          await invoke("write_project_config", {
            path,
            config: { ...read.config, topic: topicText },
          });
        } catch (reason) {
          // 注册已成功：留在弹窗内报错，重试/取消由用户决定（重注册是幂等 upsert）
          setError(
            `项目已注册，但课题主题写入 project.toml 失败：${String(reason)}`,
          );
          return;
        }
      }
      onRegistered(project);
    } catch (reason) {
      setError(String(reason));
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
        <h2 className="mb-4 text-base font-semibold text-l1">添加项目</h2>
        <p
          className="mb-3 truncate font-mono text-xs text-l3"
          title={path}
        >
          {path}
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">项目名</span>
          <input
            className={field}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">课题主题（可选）</span>
          <input
            className={field}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="如 GLP-1 受体激动剂的心血管结局"
          />
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
            disabled={busy || !name.trim()}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "注册中…" : "注册"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 工作区 → 终端的交接：取端口段 env，交给终端页开新标签；预填该目录上次使用的配置（W3-C）。
 *  initialPrompt：一键开步的首条指令，启动时注入 CLI（一次性） */
function useOpenInTerminal() {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  return async (ws: WorkspaceDto, initialPrompt?: string) => {
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
      initialPrompt,
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

type WorkspaceState = {
  label: string;
  dotClass: string;
  textClass: string;
  details: string[];
};

function workspaceState(
  workspace: WorkspaceDto,
  health: WorkspaceHealthDto | undefined,
  drift: WorkspaceDriftDto | undefined,
  healthFailed = false,
): WorkspaceState {
  if (workspace.status === "creating") {
    return {
      label: "创建未完成",
      dotClass: "bg-warnb",
      textClass: "text-warn-text",
      details: ["工作区创建流程尚未完成，请在更多操作中修复或清理记录。"],
    };
  }
  // 未完成 merge 是可继续的冲突流程，不应被泛化成“需要修复”而藏进更多菜单。
  if (drift?.canResolveMerge) {
    return {
      label: "有冲突",
      dotClass: "bg-err-text",
      textClass: "text-l2",
      details:
        health?.conflictFiles.length
          ? [`冲突文件：${health.conflictFiles.join("、")}`]
          : drift.issues.map((issue) => issue.message),
    };
  }
  if (drift && !drift.healthy) {
    return {
      label: "需要修复",
      dotClass: "bg-warnb",
      textClass: "text-warn-text",
      details: drift.issues.map((issue) => issue.message),
    };
  }
  if (workspace.status === "archived") {
    return {
      label: "已归档",
      dotClass: "bg-l4",
      textClass: "text-l3",
      details: ["工作树已移除，分支仍保留，可恢复后继续工作。"],
    };
  }
  if (!health) {
    if (healthFailed) {
      return {
        label: "检查失败",
        dotClass: "bg-warnb",
        textClass: "text-warn-text",
        details: ["无法读取工作区与主仓库状态，请重试。"],
      };
    }
    return {
      label: "检查中",
      dotClass: "bg-l4",
      textClass: "text-l3",
      details: ["正在读取工作区与主仓库状态。"],
    };
  }
  // 冲突判定优先于主仓脏/偏离：行内主按钮按冲突展示，pill 不能把它掩盖成「需要处理」
  if (health.conflict === true) {
    return {
      label: "有冲突",
      dotClass: "bg-err-text",
      textClass: "text-l2",
      details: [
        ...(health.conflictFiles.length
          ? [`冲突文件：${health.conflictFiles.join("、")}`]
          : [`与 ${workspace.baseBranch} 改了同一处内容，进入评审后选一边保留。`]),
        // 主仓问题与冲突并存时一并列出，避免漏掉合并阻塞项
        ...(health.mainDirty
          ? ["主文件夹里还有没保存的改动，提交保存后才能合并。"]
          : []),
        ...(health.mainOffBase
          ? [`主文件夹当前不在 ${workspace.baseBranch} 分支上。`]
          : []),
      ],
    };
  }
  if (health.mainDirty || health.mainOffBase) {
    return {
      label: "需要处理",
      dotClass: "bg-warnb",
      textClass: "text-warn-text",
      details: [
        ...(health.mainDirty
          ? ["主文件夹里还有没保存的改动，提交保存后才能合并。"]
          : []),
        ...(health.mainOffBase
          ? [`主文件夹当前不在 ${workspace.baseBranch} 分支上。`]
          : []),
      ],
    };
  }
  if (health.uncommitted) {
    return {
      label: "待提交",
      dotClass: "bg-warnb",
      textClass: "text-l2",
      details: ["任务里还有没保存的改动，进入评审后可提交。"],
    };
  }
  if (health.readyToMerge) {
    return {
      label: "可评审",
      dotClass: "bg-okb",
      textClass: "text-l2",
      details: ["已有待合并提交，可在评审中完成本地合并。"],
    };
  }
  if (isMerged(workspace, health)) {
    return {
      label: "已合并",
      dotClass: "bg-okb",
      textClass: "text-ok-text",
      details: [`已合并进 ${workspace.baseBranch}；有新提交后可再次评审。`],
    };
  }
  return {
    label: "进行中",
    dotClass: "bg-okb",
    textClass: "text-l3",
    details: ["当前没有待提交或待合并的改动。"],
  };
}

function WorkspaceDetailsPopover({
  x,
  y,
  workspace,
  health,
  state,
  onClose,
}: {
  x: number;
  y: number;
  workspace: WorkspaceDto;
  health: WorkspaceHealthDto | undefined;
  state: WorkspaceState;
  onClose: () => void;
}) {
  // 每行可带白话悬浮 title：↑↓ 等技术记号 hover 时给「保存点」解释（双层呈现，不删技术信息）
  const rows: [string, string, string?][] = [
    ["分支", `${workspace.branch} → ${workspace.baseBranch}`],
    ["工作树", workspace.worktreePath],
    ["端口", `${workspace.portBase}–${workspace.portBase + 9}`],
    ...(health
      ? ([
          [
            "提交",
            `↑${health.ahead} ↓${health.behind}`,
            `比主分支多出 ${health.ahead} 个保存点；主分支新增 ${health.behind} 个保存点`,
          ],
        ] as [string, string, string][])
      : []),
  ];
  const panelRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(x, window.innerWidth - 328)),
    top: y,
  }));
  // 与 ContextMenu 一致：Escape / 任意滚动即关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);
  // 详情长度不固定，按实测尺寸钳制，避免锚点靠下时溢出屏幕底部
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y, state, health]);
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <section
        ref={panelRef}
        className="absolute w-80 rounded border border-field bg-strip p-3 text-xs"
        style={pos}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${state.dotClass}`} />
          <span className={`font-medium ${state.textClass}`}>
            {state.label}
          </span>
        </div>
        <dl className="space-y-1.5 border-t border-hairline pt-2 text-l3">
          {rows.map(([label, value, hint]) => (
            <div
              key={label}
              className="grid grid-cols-[42px_minmax(0,1fr)] gap-2"
            >
              <dt className="text-l4">{label}</dt>
              <dd className="truncate font-mono text-l2" title={hint ?? value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {state.details.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-hairline pt-2 text-l3">
            {state.details.map((detail) => (
              <li key={detail}>• {detail}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function WorkspacesPage({ visible }: { visible: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [settings, setSettings] = useState<Record<string, WsSettingsDto>>({});
  const [health, setHealth] = useState<Record<string, WorkspaceHealthDto>>({});
  const [drift, setDrift] = useState<Record<string, WorkspaceDriftDto>>({});
  // 逐工作区记录诊断/健康检查失败：失败时降级展示并给出重试入口，不静默吞掉
  const [driftFailed, setDriftFailed] = useState<Record<string, boolean>>({});
  const [healthFailed, setHealthFailed] = useState<Record<string, boolean>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [created, setCreated] = useState<WorkspaceDto | null>(null);
  // P1b 项目分组：注册项目列表 + 每次刷新自增的令牌（触发各分组重读 project.toml）
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [addProjectPath, setAddProjectPath] = useState<string | null>(null);
  // 刚注册的项目路径：对应分组显示一次性 git 初始化引导
  const [freshProjectPath, setFreshProjectPath] = useState<string | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    x: number;
    y: number;
    ws: WorkspaceDto;
  } | null>(null);
  const [detailsPopover, setDetailsPopover] = useState<{
    x: number;
    y: number;
    ws: WorkspaceDto;
  } | null>(null);
  // 新建弹窗的仓库候选在页面可见时预热（list_repos 扫描慢，避免弹窗内空等）
  const [repos, setRepos] = useState<RepoDto[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const openInTerminal = useOpenInTerminal();
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setSessionsQuery = useAppStore((s) => s.setSessionsQuery);
  const runningScripts = useAppStore((s) => s.runningScripts);

  async function refresh() {
    try {
      const list = await invoke<WorkspaceDto[]>("list_workspaces");
      setWorkspaces(list);
      // 项目注册表：失败不阻断工作区列表，分组退化为仅按 repo 归组
      invoke<ProjectDto[]>("list_projects")
        .then(setProjects)
        .catch(() => {});
      setRefreshToken((t) => t + 1);
      const driftFailures: Record<string, boolean> = {};
      const driftEntries = await Promise.all(
        list.map(async (workspace) => {
          try {
            return [
              workspace.id,
              await invoke<WorkspaceDriftDto>("workspace_drift", {
                id: workspace.id,
              }),
            ] as const;
          } catch {
            driftFailures[workspace.id] = true;
            return null;
          }
        }),
      );
      setDrift(
        Object.fromEntries(driftEntries.filter((entry) => entry !== null)),
      );
      setDriftFailed(driftFailures);
      // 活跃工作区所在仓库的 settings（按 repoPath 缓存，不重复拉取）
      const repos = [
        ...new Set(
          list.filter((w) => w.status === "active").map((w) => w.repoPath),
        ),
      ];
      const entries = await Promise.all(
        repos.map(async (r) => {
          try {
            return [
              r,
              await invoke<WsSettingsDto>("workspace_settings", {
                repoPath: r,
              }),
            ] as const;
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
      const activeIds = list
        .filter((w) => w.status === "active")
        .map((w) => w.id);
      const healthFailures: Record<string, boolean> = {};
      const healthEntries = await Promise.all(
        activeIds.map(async (id) => {
          try {
            return [
              id,
              await invoke<WorkspaceHealthDto>("workspace_health", { id }),
            ] as const;
          } catch {
            healthFailures[id] = true;
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
      setHealthFailed(healthFailures);
      setError(null);
    } catch (e) {
      setError(String(e));
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
    if (!window.confirm("仅把 Ccode 记录标记为已归档，不删除分支。继续？"))
      return;
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

  const active = workspaces.filter(
    (workspace) => workspace.status === "active",
  );
  const repoCount = new Set(workspaces.map((workspace) => workspace.repoPath))
    .size;
  // 分组 = 注册项目（last_opened 降序）∪ 未注册的工作区 repo 组；注册项目没有工作区也显示
  const repoPaths = [...new Set(workspaces.map((w) => w.repoPath))];
  const groups: {
    key: string;
    project: ProjectDto | null;
    repoPath: string;
    repoName: string;
    list: WorkspaceDto[];
  }[] = [
    ...projects.map((project) => ({
      key: `p:${project.path}`,
      project,
      repoPath: project.path,
      repoName: project.name,
      list: workspaces.filter((w) => samePath(w.repoPath, project.path)),
    })),
    ...repoPaths
      .filter((rp) => !projects.some((p) => samePath(p.path, rp)))
      .map((repoPath) => ({
        key: `r:${repoPath}`,
        project: null,
        repoPath,
        repoName: workspaces.find((w) => w.repoPath === repoPath)!.repoName,
        list: workspaces.filter((w) => w.repoPath === repoPath),
      })),
  ];
  const actionBtn =
    "rounded px-2 py-1 text-xs text-l2 hover:bg-white/5 hover:text-l1";

  function openReview(
    workspace: WorkspaceDto,
    action?: "pr" | "archive" | "resolve-conflict",
  ) {
    setWorkspaceReviewRequest({
      worktreePath: workspace.worktreePath,
      action,
      requestId: crypto.randomUUID(),
    });
    setPage("terminal");
  }

  function workspaceMenuItems(workspace: WorkspaceDto) {
    const workspaceHealth = health[workspace.id];
    const workspaceDrift = drift[workspace.id];
    // drift 诊断失败时降级按 healthy 处理，行内另有「诊断失败」提示与重试
    const healthy =
      workspaceDrift?.healthy === true || !!driftFailed[workspace.id];
    const healthUnknown =
      !!healthFailed[workspace.id] && !workspaceHealth;
    const items: {
      label: string;
      onSelect?: () => void;
      disabled?: boolean;
      title?: string;
    }[] = [];

    if (workspace.status === "active" && healthy) {
      const workspaceSettings = settings[workspace.repoPath];
      const scripts = workspaceSettings?.run ?? [];
      const scriptsBlocked =
        workspaceSettings?.runMode === "nonconcurrent" &&
        !!runningScripts[workspace.id];
      if (scriptsBlocked) {
        // nonconcurrent 互斥时渲染禁用项并说明原因，不静默消失
        items.push(
          ...scripts.map((script) => ({
            label: `运行：${script.name}`,
            disabled: true,
            title: "已有运行中的脚本（nonconcurrent 模式）",
          })),
        );
      } else {
        items.push(
          ...scripts.map((script) => ({
            label: `运行：${script.name}`,
            onSelect: () => void runScript(workspace, script),
          })),
        );
      }
      // 健康检查失败导致 ahead 未知时也保留入口，由评审视图按实际状态处理
      if ((workspaceHealth?.ahead ?? 0) > 0 || healthUnknown) {
        items.push({
          label: "在评审中创建 PR",
          onSelect: () => openReview(workspace, "pr"),
        });
      }
      if (!workspaceHealth?.conflict) {
        items.push({
          label: "在评审中归档",
          onSelect: () => openReview(workspace, "archive"),
        });
      }
    }

    if (workspaceDrift && !workspaceDrift.healthy) {
      if (workspaceDrift.canRemount) {
        items.push({
          label: "重新挂载工作树",
          onSelect: () => void onRepairRemount(workspace),
        });
      }
      if (workspaceDrift.canRelocate) {
        items.push({
          label: "重新定位仓库",
          onSelect: () => void onRelocate(workspace),
        });
      }
      if (workspaceDrift.canMarkArchived) {
        items.push({
          label: "标记为已归档",
          onSelect: () => void onMarkArchived(workspace),
        });
      }
      if (workspaceDrift.canCleanRecord) {
        items.push({
          label: "清理 Ccode 记录",
          onSelect: () => void onCleanRecord(workspace),
        });
      }
    }

    if (workspace.status === "archived" && healthy) {
      items.push({
        label: "恢复",
        onSelect: () => void onRestore(workspace),
      });
    }

    items.push(
      {
        label: "查看对话",
        onSelect: () => {
          setSessionsQuery(workspace.name);
          setPage("sessions");
        },
      },
      {
        label: "复制工作树路径",
        onSelect: () => {
          void navigator.clipboard
            .writeText(workspace.worktreePath)
            .catch(() => {
              setError("复制工作树路径失败");
            });
        },
      },
    );
    if (healthy) {
      items.push({
        label: "删除工作区",
        onSelect: () => void onDelete(workspace),
      });
    }
    return items;
  }

  /** 添加项目主操作：系统对话框选目录 → 弹窗内联命名 → register_project */
  async function onAddProject() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    setAddProjectPath(selected);
  }

  return (
    <div className="h-full overflow-auto">
      <PageFrame width="standard">
      <PageHeader
        title="工作区"
        meta={`${active.length} 个活跃 · ${projects.length} 个项目 · ${repoCount} 个仓库`}
        actions={
          <>
            <button
              type="button"
              onClick={() => void onAddProject()}
              className={primaryActionClass}
            >
              + 添加项目
            </button>
            <button
              type="button"
              onClick={() => setModal(true)}
              className="rounded border border-field px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
            >
              + 新建工作区
            </button>
          </>
        }
      />
      {error && <p className="mb-4 text-sm text-err-text">{error}</p>}
      {created && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded bg-strip p-2 text-xs text-l2">
          <span>
            <span className="mr-1 text-okb">✓</span>
            工作区「{created.name}」已创建 · 分支 {created.branch}
          </span>
          {created.setupResult?.ok && (
            <span className="text-l3">setup 脚本执行成功</span>
          )}
          {created.setupResult && !created.setupResult.ok && (
            <details className="text-err-text">
              <summary className="cursor-pointer">setup 脚本失败</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-l3">
                {created.setupResult.outputTail}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={() => {
              const workspace = created;
              setCreated(null);
              void openInTerminal(workspace);
            }}
            className="ml-auto shrink-0 rounded border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110"
          >
            打开终端
          </button>
          <button
            type="button"
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
          <p className="mt-1 text-xs text-l4">
            「添加项目」注册课题目录并获得流水线骨架，或直接「新建工作区」。
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <ProjectGroup
            key={group.key}
            project={group.project}
            repoPath={group.repoPath}
            repoName={group.repoName}
            workspaces={group.list}
            health={health}
            drift={drift}
            driftFailed={driftFailed}
            refreshToken={refreshToken}
            freshGitGuide={
              !!group.project &&
              !!freshProjectPath &&
              samePath(group.project.path, freshProjectPath)
            }
            onDismissGitGuide={() => setFreshProjectPath(null)}
            onRefresh={refresh}
            onOpenTerminal={(ws, initialPrompt) =>
              void openInTerminal(ws, initialPrompt)
            }
            onOpenReview={openReview}
            onRegisterProject={setAddProjectPath}
            onError={setError}
          >
            {group.list.length === 0 ? (
              <p className="py-2 text-xs text-l4">
                该项目还没有工作区，从上方流水线步骤「开始」一键开步。
              </p>
            ) : (
            <ul className="divide-y divide-hairline">
              {group.list.map((workspace) => {
                const workspaceHealth = health[workspace.id];
                const workspaceDrift = drift[workspace.id];
                const isDriftFailed = !!driftFailed[workspace.id];
                const isHealthFailed = !!healthFailed[workspace.id];
                const state = workspaceState(
                  workspace,
                  workspaceHealth,
                  workspaceDrift,
                  isHealthFailed,
                );
                const canResolveConflict =
                  workspace.status === "active" &&
                  workspaceDrift?.canResolveMerge === true;
                // drift 诊断失败时降级按健康处理，行内操作不整体消失
                const canOpenWorkspace =
                  workspace.status === "active" &&
                  (workspaceDrift?.healthy === true ||
                    canResolveConflict ||
                    isDriftFailed);
                return (
                  <li key={workspace.id} className="py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-l1">
                            {workspace.name}
                          </span>
                          <button
                            type="button"
                            onClick={(event) => {
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              setDetailsPopover({
                                x: rect.left,
                                y: rect.bottom + 4,
                                ws: workspace,
                              });
                            }}
                            className={`inline-flex shrink-0 items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs ${state.textClass} hover:bg-seg-sel`}
                            title="查看状态详情"
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${state.dotClass}`}
                            />
                            {state.label}
                          </button>
                          {(isDriftFailed || isHealthFailed) && (
                            <button
                              type="button"
                              onClick={() => void refresh()}
                              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-warn-text hover:bg-white/5"
                              title="状态诊断失败，点击重新检查"
                            >
                              诊断失败 · 重试
                            </button>
                          )}
                        </div>
                        <p
                          className="mt-0.5 truncate font-mono text-xs text-l4"
                          title={workspace.worktreePath}
                        >
                          {workspace.branch} · {relTime(workspace.createdAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canOpenWorkspace && (
                          <>
                            <button
                              type="button"
                              onClick={() => void openInTerminal(workspace)}
                              className={actionBtn}
                            >
                              ⌨ 终端
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                openReview(
                                  workspace,
                                  canResolveConflict || workspaceHealth?.conflict
                                    ? "resolve-conflict"
                                    : undefined,
                                )
                              }
                              title={
                                canResolveConflict || workspaceHealth?.conflict
                                  ? "两边改了同一个地方，需要你逐个文件选一边"
                                  : "审阅任务改动并合并回主文件夹"
                              }
                              className={`${actionBtn} ${
                                canResolveConflict || workspaceHealth?.conflict
                                  ? "text-warn-text"
                                  : ""
                              }`}
                            >
                              {canResolveConflict || workspaceHealth?.conflict
                                ? "解决冲突"
                                : "评审"}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setWorkspaceMenu({
                              x: rect.right,
                              y: rect.bottom + 4,
                              ws: workspace,
                            });
                          }}
                          title="更多操作"
                          aria-label={`更多操作：${workspace.name}`}
                          className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            )}
          </ProjectGroup>
        ))
      )}
      {addProjectPath && (
        <AddProjectModal
          path={addProjectPath}
          onClose={() => setAddProjectPath(null)}
          onRegistered={(project) => {
            setAddProjectPath(null);
            setFreshProjectPath(project.path);
            void refresh();
          }}
        />
      )}
      {modal && (
        <NewWorkspaceModal
          repos={repos}
          reposLoading={reposLoading}
          onClose={() => setModal(false)}
          onCreated={(workspace) => {
            setModal(false);
            setCreated(workspace);
            void refresh();
          }}
        />
      )}
      {workspaceMenu && (
        <ContextMenu
          x={workspaceMenu.x}
          y={workspaceMenu.y}
          alignRight
          onClose={() => setWorkspaceMenu(null)}
          items={workspaceMenuItems(workspaceMenu.ws)}
        />
      )}
      {detailsPopover && (
        <WorkspaceDetailsPopover
          x={detailsPopover.x}
          y={detailsPopover.y}
          workspace={detailsPopover.ws}
          health={health[detailsPopover.ws.id]}
          state={workspaceState(
            detailsPopover.ws,
            health[detailsPopover.ws.id],
            drift[detailsPopover.ws.id],
            !!healthFailed[detailsPopover.ws.id],
          )}
          onClose={() => setDetailsPopover(null)}
        />
      )}
      </PageFrame>
    </div>
  );
}
