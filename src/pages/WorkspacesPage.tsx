import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore, runInboxAction, type InboxItem } from "../store";
import { absTime, relTime } from "../rel-time";
import ContextMenu from "../components/ContextMenu";
import { confirmDialog } from "../components/ConfirmDialog";
import ProjectGroup from "../components/ProjectGroup";
import ArtifactChecklist from "../components/ArtifactChecklist";
import {
  EmptyState,
  fieldClass,
  PageFrame,
  PageHeader,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import { attributeToProject, buildRunOverview } from "../run-overview";
import { IS_MAC } from "../hotkeys";
import { AGENTS } from "../types";
import type {
  PortInfoDto,
  ProjectConfigReadDto,
  ProjectDto,
  RepoDto,
  RunScriptDto,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
  WsSettingsDto,
} from "../types";

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
            className={fieldClass}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">课题主题（可选）</span>
          <input
            className={fieldClass}
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

/** 重命名项目弹窗（项目导航行右键「重命名项目」）：register_project 是幂等 upsert，同名改不改都行 */
function RenameProjectModal({
  path,
  initialName,
  onClose,
  onRenamed,
}: {
  path: string;
  initialName: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke("register_project", { path, name: name.trim() });
      onRenamed();
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
        className="w-[24rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">重命名项目</h2>
        <p className="mb-3 truncate font-mono text-xs text-l3" title={path}>
          {path}
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">项目名</span>
          <input
            className={fieldClass}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
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
            {busy ? "保存中…" : "保存"}
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
            className={fieldClass}
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
              className={fieldClass}
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
            className={fieldClass}
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
      dotClass: "bg-warn-text",
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
      dotClass: "bg-warn-text",
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
        dotClass: "bg-warn-text",
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
      dotClass: "bg-warn-text",
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
      dotClass: "bg-warn-text",
      textClass: "text-l2",
      details: ["任务里还有没保存的改动，进入评审后可提交。"],
    };
  }
  if (health.readyToMerge) {
    return {
      label: "可评审",
      dotClass: "bg-ok-text",
      textClass: "text-l2",
      details: ["已有待合并提交，可在评审中完成本地合并。"],
    };
  }
  if (isMerged(workspace, health)) {
    return {
      label: "已合并",
      dotClass: "bg-ok-text",
      textClass: "text-ok-text",
      details: [`已合并进 ${workspace.baseBranch}；有新提交后可再次评审。`],
    };
  }
  return {
    label: "进行中",
    dotClass: "bg-ok-text",
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
  diagFailed,
  onRetry,
  onClose,
}: {
  x: number;
  y: number;
  workspace: WorkspaceDto;
  health: WorkspaceHealthDto | undefined;
  state: WorkspaceState;
  /** 漂移诊断/健康检查失败：行内不再放重试按钮，收进本详情层 */
  diagFailed: boolean;
  onRetry: () => void;
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
          <span className={`size-2 rounded-full ${state.dotClass}`} />
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
        {diagFailed && (
          <div className="mt-2 border-t border-hairline pt-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onRetry();
              }}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-warn-text hover:bg-white/5"
            >
              诊断失败 · 重新检查
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/** 端口运行时监控：默认折叠，首次展开才拉取，手动刷新，不轮询。
 *  归属点色：工作区/项目=绿（已认归属），段归属=琥珀（占了端口段但进程不在树内），其他=灰；
 *  列表按归属分「本应用」与「系统/其他」两段：本应用直接 SIGTERM，系统/其他终止前弹确认防误杀 */
function PortsSection() {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<PortInfoDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setPorts(await invoke<PortInfoDto[]>("list_listening_ports"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!open && ports === null) void load();
    setOpen(!open);
  }

  async function onKill(port: PortInfoDto) {
    // 只有 Ccode 之外的进程需要确认；本应用归属（工作区/项目/端口段）直接终止
    if (
      port.ownerKind === "other" &&
      !(await confirmDialog(
        `「${port.process || "未知进程"}」不是 Ccode 启动的进程（PID ${port.pid}，端口 ${port.port}）。终止它可能影响其他正在运行的应用。继续？`,
        { danger: true },
      ))
    )
      return;
    setKilling(port.pid);
    setError(null);
    try {
      await invoke("kill_port_process", { pid: port.pid });
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setKilling(null);
    }
  }

  const dotClass: Record<PortInfoDto["ownerKind"], string> = {
    workspace: "bg-ok-text",
    project: "bg-ok-text",
    range: "bg-warn-text",
    other: "bg-l4",
  };

  // 归属分层：本应用（工作区/项目/端口段）与系统/其他分两段展示
  const internalPorts = (ports ?? []).filter((p) => p.ownerKind !== "other");
  const externalPorts = (ports ?? []).filter((p) => p.ownerKind === "other");

  function renderPortRow(port: PortInfoDto) {
    return (
      <li
        key={`${port.pid}-${port.port}`}
        className="flex items-center gap-3 py-2"
      >
        <span className="w-14 shrink-0 font-mono text-[13px] text-l1">
          {port.port}
        </span>
        <span
          className="w-32 shrink-0 truncate text-xs text-l2"
          title={`PID ${port.pid}`}
        >
          {port.process || `PID ${port.pid}`}
        </span>
        <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-inset px-2 text-xs text-l2">
          <span className={`size-2 rounded-full ${dotClass[port.ownerKind]}`} />
          {port.ownerLabel}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-l4"
          title={port.cwd ?? ""}
        >
          {port.cwd ?? ""}
        </span>
        <button
          type="button"
          onClick={() => void onKill(port)}
          disabled={killing === port.pid}
          title={`终止进程（PID ${port.pid}）`}
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l2 hover:bg-white/5 hover:text-err-text disabled:opacity-50"
        >
          {killing === port.pid ? "终止中…" : "终止"}
        </button>
      </li>
    );
  }

  return (
    <section className="mt-7">
      <div
        className={`flex h-8 items-center ${open ? "border-b border-hairline" : ""}`}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-l1"
        >
          <span className="w-3 text-xs text-l4">{open ? "▾" : "▸"}</span>
          端口
          {/* 计数只在展开后显示——「有几个端口在监听」是信息不是警报，折叠态不占注意力 */}
          {open && ports !== null && (
            <span className="text-xs font-normal text-l4">
              {ports.length} 个监听中
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="mr-2 inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l2 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        )}
      </div>
      {open && (
        <div className="pb-1">
          <p className="pt-2 text-xs text-l4">
            「终止」发送退出信号（SIGTERM）；进程未退出时可稍候刷新再试。
          </p>
          {error && <p className="mt-2 text-sm text-err-text">{error}</p>}
          {ports !== null && ports.length === 0 && !loading && (
            <p className="py-3 text-xs text-l4">当前没有监听中的端口。</p>
          )}
          {ports !== null && ports.length > 0 && (
            <div className="mt-1 space-y-3">
              {(
                [
                  ["本应用", internalPorts, "本应用当前没有监听中的端口。"],
                  ["系统/其他", externalPorts, "没有系统或其他进程占用的端口。"],
                ] as const
              ).map(([title, list, empty]) => (
                <div key={title}>
                  <p className="pt-1 text-[10px] text-l4">{title}</p>
                  {list.length === 0 ? (
                    <p className="py-1.5 text-xs text-l4">{empty}</p>
                  ) : (
                    <ul className="divide-y divide-hairline">
                      {list.map(renderPortRow)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
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
  // 项目导航行右键菜单（重命名/复制路径/移除注册）与改名弹窗
  const [railMenu, setRailMenu] = useState<{
    x: number;
    y: number;
    groupKey: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  // rail 头部 + 菜单（添加项目 / 创建示例课题）
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(
    null,
  );  const [created, setCreated] = useState<WorkspaceDto | null>(null);
  // 创建成功横幅是瞬态反馈：10s 自动消退（setup 失败除外——失败详情要人看，不自动收）
  useEffect(() => {
    if (!created || (created.setupResult && !created.setupResult.ok)) return;
    const t = setTimeout(() => setCreated(null), 10_000);
    return () => clearTimeout(t);
  }, [created]);
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
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  // 任务行产物清单手风琴：按工作区 id 记忆展开态，切项目时清空
  const [artifactsOpen, setArtifactsOpen] = useState<Set<string>>(new Set());
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
  // 终端标签运行状态镜像（TerminalPage 写入，首页「待你处理」用）；跳转派发统一走 runInboxAction
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  // 收件箱条目数镜像给侧栏「工作区」徽标 + 标题栏收件箱（本页唯一写入方，签名变更才写）
  const setInboxItems = useAppStore((s) => s.setInboxItems);
  // 会话清单（启动即加载）：外部 live 会话的收件箱入口
  const sessions = useAppStore((s) => s.sessions);
  // 外部 live 会话（无终端标签可跳）的尾部注意力：后端直查 session_tail_state，
  // 补齐收件箱在终端页未挂载时的盲区；只查 live 且非内部的少量会话（上限 10 条）
  const [liveTail, setLiveTail] = useState<Record<string, string>>({});
  const liveSig = sessions
    .filter((s) => s.live && !s.internal)
    .map((s) => `${s.agent}:${s.sessionId}`)
    .join("\n");
  useEffect(() => {
    if (!visible) return;
    const targets = sessions
      .filter((s) => s.live && !s.internal)
      .slice(0, 10);
    let cancelled = false;
    void Promise.all(
      targets.map(async (s) => {
        try {
          const state = await invoke<string>("session_tail_state", {
            agent: s.agent,
            filePath: s.filePath,
          });
          return [`${s.agent}:${s.sessionId}`, state] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const e of entries) if (e) map[e[0]] = e[1];
      setLiveTail(map);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, liveSig]);

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
      !(await confirmDialog(
        `将删除 worktree、分支 ${ws.branch} 和元数据，不可恢复。继续？`,
        { danger: true },
      ))
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
    if (!(await confirmDialog("仅把 Ccode 记录标记为已归档，不删除分支。继续？")))
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
      !(await confirmDialog(
        `只清理 Ccode 中「${ws.name}」的记录并释放端口，不删除磁盘目录或 Git 分支。继续？`,
      ))
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
  const selectedGroup =
    groups.find((group) => group.key === selectedGroupKey) ?? groups[0] ?? null;
  const groupKeySignature = groups.map((group) => group.key).join("\n");
  useEffect(() => {
    if (groups.length === 0) {
      if (selectedGroupKey !== null) setSelectedGroupKey(null);
      return;
    }
    if (!groups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(groups[0].key);
    }
  }, [groupKeySignature, selectedGroupKey]);
  // 切项目（含分组表重算后的被动切换）时收起所有产物清单
  const shownGroupKey = selectedGroup?.key ?? null;
  useEffect(() => {
    setArtifactsOpen(new Set());
  }, [shownGroupKey]);

  function toggleArtifacts(wsId: string) {
    setArtifactsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  }
  const actionBtn =
    "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-white/5 hover:text-l1";
  // hover 才现的低频操作：键盘 Tab 聚焦（focus-visible）同样显示，保持可达
  const hoverReveal =
    "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";
  // 行内唯一实心主动作：普通评审 cta 实心；冲突场景 warn 色实心
  const reviewCta =
    "inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110";
  const reviewWarn =
    "inline-flex h-7 items-center justify-center rounded-md border border-warn-text/40 bg-warn px-2 text-xs text-warn-text hover:brightness-110";

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

  // 「待你处理」首页聚合（v3.39）：打开应用第一眼看到要拍板的事——
  // 工作区冲突/可合并（health 随页加载）+ 终端标签待确认（store 镜像，跨页可读）。
  // 排序：冲突 > 待确认 > 可合并；为空时整个区块不渲染（零噪音）。
  // 「已回复」不进收件箱——回合结束每轮都发生、不阻塞决策（同口径：标签/项目区/通知均不打点）。
  const runItems = buildRunOverview(terminalRunInputs).items;
  const tabLabel = (agentId: string, title: string, cwdLabel: string) =>
    `${agentId ? `${AGENTS.find((a) => a.id === agentId)?.label ?? agentId} · ` : ""}${title}（${cwdLabel}）`;
  // 收件箱条目为可序列化数据（action 描述而非闭包）：镜像进 store 供 App 标题栏收件箱共用，
  // 点击统一走 store.ts 的 runInboxAction 派发
  const inboxItems: InboxItem[] = [
    ...active
      .filter((w) => health[w.id]?.conflict)
      .map((w) => ({
        key: `conflict:${w.id}`,
        dot: "bg-warn-text",
        text: `「${w.repoName} / ${w.name}」有合并冲突`,
        actionLabel: "解决冲突",
        action: {
          type: "review" as const,
          worktreePath: w.worktreePath,
          intent: "resolve-conflict" as const,
        },
      })),
    ...runItems
      .filter((it) => it.attention === "confirm")
      .map((it) => ({
        key: `confirm:${it.tabId}`,
        dot: "bg-warn-text",
        text: `${tabLabel(it.agentId, it.title, it.cwdLabel)} 待你确认`,
        actionLabel: "去处理",
        action: { type: "tab" as const, tabId: it.tabId },
      })),
    // 外部运行（无终端标签）的会话：后端直查尾部状态，待确认时进收件箱
    ...sessions
      .filter(
        (s) =>
          s.live &&
          !s.internal &&
          liveTail[`${s.agent}:${s.sessionId}`] === "confirm",
      )
      .map((s) => ({
        key: `live:${s.agent}:${s.sessionId}`,
        dot: "bg-warn-text",
        text: `${AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent} · ${s.customTitle ?? s.title ?? "未命名对话"}（${pathBaseName(s.projectPath)}）外部运行中，待你确认`,
        actionLabel: "去查看",
        action: {
          type: "session" as const,
          agent: s.agent,
          sessionId: s.sessionId,
        },
      })),
    ...active
      .filter((w) => health[w.id]?.readyToMerge && !health[w.id]?.conflict)
      .map((w) => ({
        key: `ready:${w.id}`,
        dot: "bg-ok-text",
        text: `「${w.repoName} / ${w.name}」可以合并`,
        actionLabel: "去评审",
        action: { type: "review" as const, worktreePath: w.worktreePath },
      })),
  ];

  // 项目导航行的「待处理」分布（收件箱同款口径按项目摊开）：终端待确认 +
  // 外部 live 待确认，cwd 经最长前缀归属项目根/工作树（attributeToProject 纯逻辑）
  const projectRoots = groups.map((g) => ({
    key: g.key,
    roots: [g.repoPath, ...g.list.map((w) => w.worktreePath)],
  }));
  const navAttention = new Map<string, number>();
  const bumpAttention = (path: string) => {
    const key = attributeToProject(path, projectRoots);
    if (key) navAttention.set(key, (navAttention.get(key) ?? 0) + 1);
  };
  for (const it of runItems) {
    if (it.attention === "confirm") bumpAttention(it.cwd);
  }
  for (const s of sessions) {
    if (
      s.live &&
      !s.internal &&
      liveTail[`${s.agent}:${s.sessionId}`] === "confirm"
    )
      bumpAttention(s.projectPath);
  }

  // 收件箱条目镜像进 store（本页常驻挂载，签名变更才写，防每 render 抖动订阅方）
  const inboxLen = inboxItems.length;
  const inboxSig = inboxItems.map((it) => `${it.key}=${it.text}`).join("|");
  useEffect(() => {
    setInboxItems(inboxItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxSig, setInboxItems]);

  // 收件箱折叠 strip：默认收起只占单行，分类摘要保留第一眼信息（「2 冲突 · 1 待确认」）
  const [inboxOpen, setInboxOpen] = useState(false);
  // 空了就收回展开态；展开时 Esc 关闭
  useEffect(() => {
    if (inboxLen === 0) setInboxOpen(false);
  }, [inboxLen]);
  useEffect(() => {
    if (!inboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInboxOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inboxOpen]);
  const countBy = (...prefixes: string[]) =>
    inboxItems.filter((it) => prefixes.some((p) => it.key.startsWith(p))).length;
  const inboxBreakdown = (
    [
      [countBy("conflict:"), "冲突"],
      [countBy("confirm:", "live:"), "待确认"], // 终端标签 + 外部 live 同类合并
      [countBy("ready:"), "可合并"],
    ] as [number, string][]
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");

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

  const [demoBusy, setDemoBusy] = useState(false);
  /** 空态次入口：一键创建带演示数据的示例课题（后端幂等，重复点不重复建） */
  async function onCreateDemo() {
    setDemoBusy(true);
    try {
      const project = await invoke<ProjectDto>("create_demo_project");
      // 先落项目列表再选中分组：分组表由 projects 派生，反了会被空表 effect 重置
      setProjects(await invoke<ProjectDto[]>("list_projects"));
      setSelectedGroupKey(`p:${project.path}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDemoBusy(false);
    }
  }

  /** 项目导航行右键菜单项：重命名/复制路径/移除注册/删除目录（后两者互斥粒度不同，删除目录对未注册分组也可用） */
  function railMenuItems(group: (typeof groups)[number]) {
    return [
      {
        label: "重命名项目",
        disabled: !group.project,
        title: group.project ? undefined : "未注册项目无法重命名",
        onSelect: () =>
          group.project &&
          setRenameTarget({ path: group.repoPath, name: group.project.name }),
      },
      {
        label: "复制项目路径",
        onSelect: () => {
          void navigator.clipboard
            .writeText(group.repoPath)
            .catch(() => setError("复制项目路径失败"));
        },
      },
      {
        label: "移除项目注册",
        disabled: !group.project,
        title: group.project ? undefined : "未注册项目无法移除",
        onSelect: () => group.project && void removeRegistration(group),
      },
      {
        label: "删除项目目录…",
        danger: true,
        onSelect: () => void deleteProjectDir(group),
      },
    ];
  }

  /** 彻底删除项目：工作区 + 目录 + 注册记录（不可逆；未注册分组同样可用） */
  async function deleteProjectDir(group: (typeof groups)[number]) {
    const name = group.project?.name ?? group.repoName;
    if (
      !(await confirmDialog(
        `彻底删除项目「${name}」？\n\n目录：${group.repoPath}\n工作区：${group.list.length} 个\n\n工作区和目录将一并删除、不可恢复；请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      await invoke<string>("delete_project_dir", { path: group.repoPath });
      // 删掉的是当前选中分组时，selectedGroupKey 回落由分组表 effect 处理
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 移除项目注册（只删注册记录，不动磁盘目录与工作区） */
  async function removeRegistration(group: (typeof groups)[number]) {
    const name = group.project?.name ?? group.repoName;
    if (
      !(await confirmDialog(
        `只移除「${name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      ))
    )
      return;
    try {
      await invoke("remove_project", { path: group.repoPath });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      {/* 待你处理（全局收件箱）：文档流单行 strip（只占 32px，不顶开工作台）；
          全空不渲染。明细是 strip 下方的悬浮下拉（遮罩/Esc 关闭），不推布局也不遮挡。
          macOS 上收件箱收进自绘标题栏（Ghostty 式），页内 strip 不渲染（Windows/Linux 保留本 strip） */}
      {!IS_MAC && inboxOpen && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setInboxOpen(false)}
        />
      )}
      {!IS_MAC && inboxItems.length > 0 && (
        <section className="relative z-20 shrink-0 px-6 pt-2">
          <div className="relative mx-auto w-full max-w-[1440px]">
            <button
              type="button"
              onClick={() => setInboxOpen((v) => !v)}
              aria-expanded={inboxOpen}
              className="flex h-8 w-full items-center gap-2 rounded-md bg-strip px-3 text-xs text-l2 hover:bg-white/5"
            >
              <span className="size-2 shrink-0 rounded-full bg-warn-text" />
              <span className="font-medium text-l1">
                待你处理 {inboxItems.length}
              </span>
              <span className="min-w-0 flex-1 truncate text-left text-l4">
                {inboxBreakdown}
              </span>
              <span className="shrink-0 text-l4">{inboxOpen ? "▴" : "▾"}</span>
            </button>
            {inboxOpen && (
              <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 divide-y divide-hairline overflow-auto rounded-md border border-field bg-strip">
                {inboxItems.map((item) => (
                  <li
                    key={item.key}
                    className="flex items-center gap-2.5 px-3 py-2 text-xs"
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${item.dot}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-l2">
                      {item.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => runInboxAction(item)}
                      className={rowActionClass}
                    >
                      {item.actionLabel}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-[230px] shrink-0 flex-col border-r border-hairline bg-rail2">
        <div className="flex h-12 shrink-0 items-center gap-2 px-3">
          <span className="text-sm font-medium text-l1">项目</span>
          <span className="text-xs text-l4">{groups.length}</span>
          {/* 添加项目收进 rail 头部 + 菜单（含示例课题常驻入口）；页头实心 CTA 不变 */}
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setAddMenu({ x: rect.right - 176, y: rect.bottom + 4 });
            }}
            title="添加项目 / 创建示例课题"
            aria-label="添加项目 / 创建示例课题"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-sm text-l3 hover:bg-white/5 hover:text-l1"
          >
            +
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {groups.map((group) => {
            const groupActive = group.list.filter(
              (workspace) => workspace.status === "active",
            ).length;
            // 待处理 = 工作区冲突/可合并 + 归属本项目的终端待确认/已完成/外部 live 待确认
            const needsAttention =
              group.list.filter((workspace) => {
                const state = health[workspace.id];
                return state?.conflict || state?.readyToMerge;
              }).length + (navAttention.get(group.key) ?? 0);
            const selected = selectedGroup?.key === group.key;
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => setSelectedGroupKey(group.key)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRailMenu({ x: e.clientX, y: e.clientY, groupKey: group.key });
                }}
                title={group.repoPath}
                className={`mx-1.5 mb-1 flex w-[calc(100%-12px)] items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? "bg-rail-sel text-l1"
                    : "text-l3 hover:bg-white/5 hover:text-l2"
                }`}
              >
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${
                    needsAttention > 0
                      ? "bg-warn-text"
                      : groupActive > 0
                        ? "bg-ok-text"
                        : "bg-l4"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {group.project?.name ?? group.repoName}
                  </span>
                  {/* 副行只留「待处理」（与收件箱同口径）；活跃任务数是纯状态，不占注意力 */}
                  {needsAttention > 0 && (
                    <span className="mt-0.5 block truncate text-xs text-l4">
                      {needsAttention} 个待处理
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {groups.length === 0 && (
            <p className="px-3 py-4 text-xs text-l4">还没有项目</p>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-auto">
        <PageFrame width="wide">
      <PageHeader
        title="工作区"
        meta={
          selectedGroup
            ? `${selectedGroup.project?.name ?? selectedGroup.repoName} · ${selectedGroup.list.length} 个任务`
            : `${active.length} 个活跃 · ${projects.length} 个项目 · ${repoCount} 个仓库`
        }
        actions={
          <>
            {/* 页头唯一实心 CTA = 添加项目；新建工作区降次级描边（统一页头规格 P3） */}
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
              className={secondaryActionClass}
            >
              新建工作区
            </button>
          </>
        }
      />
      {error && <p className="mb-4 text-sm text-err-text">{error}</p>}
      {created && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-strip px-3 py-2.5 text-xs text-l2">
          <span>
            <span className="mr-1 text-ok-text">✓</span>
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
            className="ml-auto inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110"
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
        <EmptyState
          title="还没有研究项目"
          detail="先添加一个项目目录，Ccode 会为它建立流水线和隔离任务。"
          action={
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void onAddProject()}
                className={primaryActionClass}
              >
                添加项目
              </button>
              <button
                type="button"
                disabled={demoBusy}
                onClick={() => void onCreateDemo()}
                className={secondaryActionClass}
              >
                {demoBusy ? "正在创建…" : "✦ 创建示例课题（演示）"}
              </button>
            </div>
          }
        />
      ) : selectedGroup ? (
          <ProjectGroup
            key={selectedGroup.key}
            project={selectedGroup.project}
            repoPath={selectedGroup.repoPath}
            repoName={selectedGroup.repoName}
            workspaces={selectedGroup.list}
            health={health}
            drift={drift}
            refreshToken={refreshToken}
            freshGitGuide={
              !!selectedGroup.project &&
              !!freshProjectPath &&
              samePath(selectedGroup.project.path, freshProjectPath)
            }
            onDismissGitGuide={() => setFreshProjectPath(null)}
            onRefresh={refresh}
            onOpenTerminal={(ws, initialPrompt) =>
              void openInTerminal(ws, initialPrompt)
            }
            onRegisterProject={setAddProjectPath}
            onError={setError}
          >
            {selectedGroup.list.length === 0 ? (
              <p className="py-2 text-xs text-l4">
                该项目还没有工作区，从上方流水线步骤「开始」一键开步。
              </p>
            ) : (
            <ul className="divide-y divide-hairline">
              {selectedGroup.list.map((workspace) => {
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
                const merged = isMerged(workspace, workspaceHealth);
                // drift 诊断失败时降级按健康处理，行内操作不整体消失
                const canOpenWorkspace =
                  workspace.status === "active" &&
                  (workspaceDrift?.healthy === true ||
                    canResolveConflict ||
                    isDriftFailed);
                return (
                  <li key={workspace.id} className="group py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-l1">
                            {workspace.name}
                          </span>
                          {merged ? (
                            // 「已合并」是终态提示：行内小字 + ok 色小点，不占按钮位；
                            // 有新提交（ahead > 0）后恢复状态 pill 与评审入口
                            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-l4">
                              <span className="size-2 rounded-full bg-ok-text" />
                              已合并
                            </span>
                          ) : (
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
                            className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-inset px-2 text-xs ${state.textClass} hover:bg-seg-sel`}
                            title={
                              isDriftFailed || isHealthFailed
                                ? "状态诊断失败，点开查看详情并重试"
                                : "查看状态详情"
                            }
                          >
                            <span
                              className={`size-2 rounded-full ${state.dotClass}`}
                            />
                            {state.label}
                            {(isDriftFailed || isHealthFailed) && (
                              <span className="text-warn-text">⚠</span>
                            )}
                          </button>
                          )}
                        </div>
                        {/* 副行：10px 灰字，相对时间主显、悬浮给绝对时间（白话双层） */}
                        <p
                          className="mt-0.5 truncate font-mono text-[10px] text-l4"
                          title={`${workspace.worktreePath}\n创建于 ${absTime(workspace.createdAt)}`}
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
                              className={`${actionBtn} ${hoverReveal}`}
                            >
                              ⌨ 终端
                            </button>
                            {!merged && (
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
                                className={
                                  canResolveConflict || workspaceHealth?.conflict
                                    ? reviewWarn
                                    : reviewCta
                                }
                              >
                                {canResolveConflict || workspaceHealth?.conflict
                                  ? "解决冲突"
                                  : "评审"}
                              </button>
                            )}
                          </>
                        )}
                        {/* 产物核验清单入口：活跃工作区（含已合并）可用，行内手风琴就地展开；展开时保持可见 */}
                        {workspace.status === "active" && (
                          <button
                            type="button"
                            onClick={() => toggleArtifacts(workspace.id)}
                            aria-expanded={artifactsOpen.has(workspace.id)}
                            title="查看该任务已经产出的文件"
                            className={`${actionBtn} ${
                              artifactsOpen.has(workspace.id)
                                ? "text-l1"
                                : hoverReveal
                            }`}
                          >
                            产物
                          </button>
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
                          className={`flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1 ${hoverReveal}`}
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                    {/* 产物清单：已合并读项目根（main），其余读工作树 */}
                    {artifactsOpen.has(workspace.id) &&
                      workspace.status === "active" && (
                        <ArtifactChecklist
                          projectPath={selectedGroup.repoPath}
                          workspaceName={workspace.name}
                          root={
                            merged
                              ? selectedGroup.repoPath
                              : workspace.worktreePath
                          }
                          rootLabel={merged ? "主文件夹（已合并）" : "工作区"}
                        />
                      )}
                  </li>
                );
              })}
            </ul>
            )}
          </ProjectGroup>
      ) : null}
      <PortsSection />
      {addProjectPath && (
        <AddProjectModal
          path={addProjectPath}
          onClose={() => setAddProjectPath(null)}
          onRegistered={(project) => {
            setAddProjectPath(null);
            setFreshProjectPath(project.path);
            setSelectedGroupKey(`p:${project.path}`);
            void refresh();
          }}
        />
      )}
      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            { label: "添加项目…", onSelect: () => void onAddProject() },
            {
              label: demoBusy ? "正在创建…" : "✦ 创建示例课题（演示）",
              disabled: demoBusy,
              title: "在 文档/Ccode 示例课题 生成带演示数据的完整流水线项目",
              onSelect: () => void onCreateDemo(),
            },
          ]}
        />
      )}
      {railMenu &&
        (() => {          const group = groups.find((g) => g.key === railMenu.groupKey);
          if (!group) return null;
          return (
            <ContextMenu
              x={railMenu.x}
              y={railMenu.y}
              onClose={() => setRailMenu(null)}
              items={railMenuItems(group)}
            />
          );
        })()}
      {renameTarget && (
        <RenameProjectModal
          path={renameTarget.path}
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
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
          diagFailed={
            !!driftFailed[detailsPopover.ws.id] ||
            !!healthFailed[detailsPopover.ws.id]
          }
          onRetry={() => void refresh()}
          onClose={() => setDetailsPopover(null)}
        />
      )}
        </PageFrame>
      </div>
      </div>
    </div>
  );
}
