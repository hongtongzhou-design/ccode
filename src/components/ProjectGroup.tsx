import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import TemplatePicker, { type TemplatePickItem } from "./TemplatePicker";
import { Checkbox } from "./PageFrame";
import { useAppStore } from "../store";
import {
  DEFAULT_KICKOFF_PROMPT,
  RESOURCE_TYPE_LABELS,
} from "../pipeline-presets";
import type {
  ArtifactEntryDto,
  DiscoveredResourceDto,
  EnsureGitDto,
  PipelineTemplateDto,
  ProjectConfigDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectResourceDto,
  ProjectStepDto,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
} from "../types";

const actionBtn =
  "rounded px-2 py-1 text-xs text-l2 hover:bg-white/5 hover:text-l1";
const ctaSm =
  "rounded border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50";
const fieldSm =
  "rounded border border-field bg-canvas px-1.5 py-0.5 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
function sanitizeWsName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 资源登记的路径多为相对项目根；复制时拼成绝对路径，绝对路径原样返回 */
function absoluteResourcePath(projectPath: string, resourcePath: string): string {
  if (resourcePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resourcePath)) {
    return resourcePath;
  }
  return `${projectPath.replace(/[\\/]+$/, "")}/${resourcePath}`;
}

/** 步骤状态：从绑定工作区（steps[].workspaceName 匹配工作区名）的 health/drift 派生，纯展示无双状态机 */
type StepStatusKey =
  | "pending"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "checking";

const STEP_STATUS_STYLE: Record<
  StepStatusKey,
  { label: string; dotClass: string; textClass: string }
> = {
  pending: { label: "待开始", dotClass: "bg-l4", textClass: "text-l3" },
  active: { label: "进行中", dotClass: "bg-okb", textClass: "text-l3" },
  review: { label: "待评审", dotClass: "bg-okb", textClass: "text-l2" },
  blocked: { label: "阻塞", dotClass: "bg-err-text", textClass: "text-l2" },
  done: { label: "已完成", dotClass: "bg-okb", textClass: "text-ok-text" },
  checking: { label: "检查中", dotClass: "bg-l4", textClass: "text-l3" },
};

function deriveStepStatus(
  step: ProjectStepDto,
  workspaces: WorkspaceDto[],
  health: Record<string, WorkspaceHealthDto>,
  drift: Record<string, WorkspaceDriftDto>,
): { key: StepStatusKey; ws?: WorkspaceDto } {
  const ws = workspaces.find((w) => w.name === step.workspaceName);
  // 归档工作区视为待开始：行内给出「恢复」入口
  if (!ws || ws.status === "archived") return { key: "pending", ws };
  const h = health[ws.id];
  const d = drift[ws.id];
  if (d?.canResolveMerge === true || h?.conflict === true) {
    return { key: "blocked", ws };
  }
  // 衔接工作区「已合并」规则：merged_at 置位且没有新的待合并提交
  if (ws.status === "active" && ws.mergedAt && h?.ahead === 0) {
    return { key: "done", ws };
  }
  if (!h) return { key: "checking", ws };
  if (h.uncommitted) return { key: "active", ws };
  if (h.ahead > 0) return { key: "review", ws };
  return { key: "active", ws };
}

/** TASK.md 内容：标题 + 课题主题（非空时） + 简报 + 预期产物（一键开步落成工作区）。
 *  导出给 TerminalPage 的「整理为笔记」开步链路复用，保持两处 TASK.md 一致。
 *  artifacts 为项目根提货单（上一步产物），非空时在「项目资源」后追加提货单段。 */
export function renderTaskMd(
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
  projectPath: string,
  artifacts?: ArtifactEntryDto[],
): string {
  const lines = [`# ${step.name}`, ""];
  // 课题主题放在简报之前：auto 模式的 Agent 据此明确综述主题
  const topic = cfg.topic?.trim();
  if (topic) {
    lines.push("## 课题主题", topic, "");
  }
  lines.push(
    step.brief.trim() ||
      "（在 .ccode/project.toml 的 steps.brief 中补充本步骤任务简报）",
  );
  if (step.expectedArtifacts.length > 0) {
    lines.push(
      "",
      "## 预期产物",
      ...step.expectedArtifacts.map((a) => `- ${a}`),
    );
  }
  if (cfg.resources.length > 0) {
    // 资源只引用不复制：相对路径按项目根拼成绝对路径，Agent 可直接读取
    const root = projectPath.replace(/[\\/]+$/, "");
    lines.push("", "## 项目资源（只读引用，勿复制到本工作区）");
    for (const r of cfg.resources) {
      const abs = /^([a-zA-Z]:[\\/]|\/)/.test(r.path)
        ? r.path
        : `${root}/${r.path}`;
      const label = RESOURCE_TYPE_LABELS[r.type] ?? r.type;
      lines.push(
        `- [${label}] ${r.name}：${abs}${r.readonly ? "（只读）" : ""}`,
      );
    }
  }
  if (artifacts && artifacts.length > 0) {
    // 提货单（§11.3 机制五）：上一步产物按路径直读，产物本体不进 git
    lines.push("", "## 上一步产物（提货单）");
    for (const a of artifacts) {
      lines.push(
        `- ${a.name}：${a.path}（md5 ${a.hash.slice(0, 8)}，来自「${a.producedBy}」）`,
      );
    }
    lines.push(
      "产物文件按路径直接读取，勿复制；新产物请通过改动面板登记进提货单。",
    );
  }
  if (cfg.artifactDir?.trim()) {
    lines.push(
      "",
      "## 产物目录",
      `大型产物（数据/图/PDF）放入项目产物目录 \`${cfg.artifactDir}\`（相对项目根），不要提交进本分支。`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 工作区页的项目分组（§11.4 P1b）：分组头 + 流水线 strip + 资源面板。
 * 工作区行列表由 WorkspacesPage 作为 children 传入，本组件只管项目层 chrome。
 */
export default function ProjectGroup({
  project,
  repoPath,
  repoName,
  workspaces,
  health,
  drift,
  driftFailed,
  refreshToken,
  freshGitGuide,
  onDismissGitGuide,
  onRefresh,
  onOpenTerminal,
  onOpenReview,
  onError,
  children,
}: {
  /** null = 未注册分组（仅按工作区 repo 归组） */
  project: ProjectDto | null;
  repoPath: string;
  repoName: string;
  workspaces: WorkspaceDto[];
  health: Record<string, WorkspaceHealthDto>;
  drift: Record<string, WorkspaceDriftDto>;
  driftFailed: Record<string, boolean>;
  /** 页面每次刷新自增，触发档案卡重读（用户可能在页外改了 project.toml） */
  refreshToken: number;
  /** 刚通过「添加项目」注册：显示一次性 git 初始化引导 */
  freshGitGuide: boolean;
  onDismissGitGuide: () => void;
  onRefresh: () => Promise<void>;
  /** initialPrompt：一键开步时预填的首条指令；「⌨ 终端」等普通入口不传 */
  onOpenTerminal: (ws: WorkspaceDto, initialPrompt?: string) => void;
  onOpenReview: (
    ws: WorkspaceDto,
    action?: "pr" | "archive" | "resolve-conflict",
  ) => void;
  onError: (msg: string) => void;
  children: ReactNode;
}) {
  const registered = project !== null;
  const projectPath = project?.path ?? repoPath;
  const displayName = project?.name ?? repoName;

  // ===== 档案卡（仅注册项目） =====
  const [cfg, setCfg] = useState<ProjectConfigDto | null>(null);
  const [cfgWarnings, setCfgWarnings] = useState<string[]>([]);
  useEffect(() => {
    if (!project) {
      setCfg(null);
      return;
    }
    let stale = false;
    // 后端保证不 reject（坏配置回落空配置 + warnings），catch 兜底防抖
    invoke<ProjectConfigReadDto>("read_project_config", { path: project.path })
      .then((read) => {
        if (stale) return;
        setCfg(read.config);
        setCfgWarnings(read.warnings);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [project, refreshToken]);

  /** 全量写回 resources/steps（后端保留未知键）；失败只报错不回滚本地状态 */
  async function saveConfig(next: ProjectConfigDto): Promise<boolean> {
    if (!project) return false;
    try {
      await invoke("write_project_config", { path: project.path, config: next });
      setCfg(next);
      return true;
    } catch (reason) {
      onError(String(reason));
      return false;
    }
  }

  // ===== 分组头：重命名 / 注册 / 移除注册 =====
  const [renamingProject, setRenamingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerName, setRegisterName] = useState(repoName);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 课题主题：存 project.toml 顶层 topic，一键开步写进 TASK.md
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");

  async function submitRenameProject(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    try {
      await invoke("register_project", {
        path: project.path,
        name: projectName.trim(),
      });
      setRenamingProject(false);
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function submitTopic(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    // 留空 = 清除课题主题（渲染时移除 topic 行）
    const topic = topicDraft.trim();
    if (await saveConfig({ ...cfg, topic: topic || null })) {
      setEditingTopic(false);
    }
  }

  async function submitRegister(e: React.FormEvent) {
    e.preventDefault();
    try {
      await invoke("register_project", {
        path: repoPath,
        name: registerName.trim(),
      });
      setRegistering(false);
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function removeRegistration() {
    if (!project) return;
    if (
      !window.confirm(
        `只移除「${project.name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      )
    )
      return;
    try {
      await invoke("remove_project", { path: project.path });
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  function copyText(text: string, failMsg: string) {
    void navigator.clipboard.writeText(text).catch(() => onError(failMsg));
  }

  // ===== git 初始化引导（新注册项目一次性横幅） =====
  const [gitMsg, setGitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  async function ensureGit() {
    setGitBusy(true);
    try {
      const res = await invoke<EnsureGitDto>("ensure_git_repo", {
        path: projectPath,
      });
      setGitMsg(
        res.initialized
          ? `已初始化 git 仓库${res.gitignoreWritten ? "，并生成 .gitignore" : ""}`
          : "已是 git 仓库，无需初始化",
      );
    } catch (reason) {
      onError(String(reason));
    } finally {
      setGitBusy(false);
    }
  }

  // ===== 流水线 strip =====
  const [starting, setStarting] = useState<number | null>(null);
  const [stepMenu, setStepMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const [renamingStep, setRenamingStep] = useState<{
    index: number;
    name: string;
    workspaceName: string;
  } | null>(null);
  const [briefEditing, setBriefEditing] = useState<{
    index: number;
    text: string;
  } | null>(null);
  const [addingStep, setAddingStep] = useState(false);
  const [newStepName, setNewStepName] = useState("");
  const [newStepWsName, setNewStepWsName] = useState("");
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  // 「使用科研流水线模板」旁的可选课题主题输入，随模板一并落进 project.toml
  const [templateTopic, setTemplateTopic] = useState("");
  // 模板选择器：首启引导与「重置为模板」共用，列出内置 + 用户模板
  const [pickerOpen, setPickerOpen] = useState(false);
  // 另存为模板：内联表单（WKWebView 无 window.prompt），同名覆盖先 confirm
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [tplNameDraft, setTplNameDraft] = useState("");
  const [tplDescDraft, setTplDescDraft] = useState("");
  const [tplSaving, setTplSaving] = useState(false);
  const [tplSavedMsg, setTplSavedMsg] = useState<string | null>(null);

  const canOpenWs = (ws: WorkspaceDto) =>
    ws.status === "active" &&
    (drift[ws.id]?.healthy === true ||
      drift[ws.id]?.canResolveMerge === true ||
      !!driftFailed[ws.id]);

  /** 一键开步（§11.3 机制三）：ensure git → 建工作区 → 简报落成 TASK.md → 跳终端预填启动 */
  async function startStep(index: number) {
    if (!project || !cfg) return;
    const step = cfg.steps[index];
    setStarting(index);
    try {
      await invoke<EnsureGitDto>("ensure_git_repo", { path: project.path });
      const ws = await invoke<WorkspaceDto>("create_workspace", {
        repoPath: project.path,
        name: step.workspaceName,
      });
      // TASK.md 为 best-effort：write_workspace_task_md 是 P1b 的最小后端补充，
      // 命令就绪前失败不阻断开步，简报仍可在 project.toml 与步骤「编辑简报」中查看
      // 提货单：项目根已有上一步产物清单时带进 TASK.md（读取失败同样不阻断）
      let artifacts: ArtifactEntryDto[] = [];
      try {
        artifacts = await invoke<ArtifactEntryDto[]>("read_artifacts_manifest", {
          repoPath: project.path,
        });
      } catch {
        /* 清单缺失或后端未就绪时跳过提货单段 */
      }
      try {
        await invoke("write_workspace_task_md", {
          worktreePath: ws.worktreePath,
          content: renderTaskMd(step, cfg, project.path, artifacts),
        });
      } catch (reason) {
        onError(`工作区「${ws.name}」已创建，TASK.md 写入失败：${String(reason)}`);
      }
      await onRefresh();
      // 预填首条指令：跳到终端后用户确认配置点「启动」即自动注入，无需手动打字
      onOpenTerminal(ws, DEFAULT_KICKOFF_PROMPT);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setStarting(null);
    }
  }

  async function restoreWs(ws: WorkspaceDto) {
    try {
      await invoke("restore_workspace", { id: ws.id });
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function applyTemplate(item: TemplatePickItem) {
    if (!cfg) return;
    // 已有步骤时视为「重置为模板」：提示覆盖，绑定的工作区与资源不受影响
    if (
      cfg.steps.length > 0 &&
      !window.confirm(
        `重置为模板「${item.name}」？现有 ${cfg.steps.length} 个步骤会被替换，绑定的工作区与资源不受影响。继续？`,
      )
    )
      return;
    setApplyingTemplate(true);
    // 模板只填 steps（+ 可选课题主题）；resources/artifactDir 保持现状，
    // 重置为模板时模板输入框不渲染，topic 为空则保留既有课题主题
    const topic = templateTopic.trim();
    const ok = await saveConfig({
      ...cfg,
      topic: topic || cfg.topic || null,
      steps: item.steps.map((s) => ({ ...s })),
    });
    setApplyingTemplate(false);
    if (ok) setPickerOpen(false);
  }

  /** 另存为模板：当前 steps 存入用户模板库（后端同名覆盖，先查重 confirm） */
  async function submitSaveTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg || cfg.steps.length === 0) return;
    const name = tplNameDraft.trim();
    if (!name) return;
    setTplSaving(true);
    try {
      // 后端未就绪时列表回落为空，保存本身会报错提示，不阻断内置流程
      const existing = await invoke<PipelineTemplateDto[]>(
        "list_pipeline_templates",
      ).catch(() => [] as PipelineTemplateDto[]);
      if (
        existing.some((t) => t.name === name) &&
        !window.confirm(`已存在同名模板「${name}」，保存将覆盖。继续？`)
      )
        return;
      const saved = await invoke<PipelineTemplateDto>(
        "save_pipeline_template",
        { name, description: tplDescDraft.trim(), steps: cfg.steps },
      );
      setSavingTemplate(false);
      setTplNameDraft("");
      setTplDescDraft("");
      setTplSavedMsg(`已保存模板「${saved.name}」，可在模板库中选择使用。`);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setTplSaving(false);
    }
  }

  async function submitRenameStep(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg || !renamingStep) return;
    const { index, name, workspaceName } = renamingStep;
    const steps = cfg.steps.map((s, i) =>
      i === index
        ? {
            ...s,
            name: name.trim() || s.name,
            workspaceName: workspaceName.trim(),
          }
        : s,
    );
    if (await saveConfig({ ...cfg, steps })) setRenamingStep(null);
  }

  async function submitBrief(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg || !briefEditing) return;
    const steps = cfg.steps.map((s, i) =>
      i === briefEditing.index ? { ...s, brief: briefEditing.text } : s,
    );
    if (await saveConfig({ ...cfg, steps })) setBriefEditing(null);
  }

  async function removeStep(index: number) {
    if (!cfg) return;
    const step = cfg.steps[index];
    if (
      !window.confirm(`删除步骤「${step.name}」？绑定的工作区不受影响。继续？`)
    )
      return;
    await saveConfig({
      ...cfg,
      steps: cfg.steps.filter((_, i) => i !== index),
    });
  }

  async function submitAddStep(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg || !newStepName.trim()) return;
    const workspaceName =
      newStepWsName.trim() ||
      sanitizeWsName(newStepName) ||
      `step-${cfg.steps.length + 1}`;
    const steps = [
      ...cfg.steps,
      {
        name: newStepName.trim(),
        workspaceName,
        brief: "",
        expectedArtifacts: [],
        skills: [],
        run: [],
      },
    ];
    if (await saveConfig({ ...cfg, steps })) {
      setAddingStep(false);
      setNewStepName("");
      setNewStepWsName("");
    }
  }

  function stepMenuItems(index: number) {
    if (!cfg) return [];
    const step = cfg.steps[index];
    return [
      {
        label: "重命名步骤",
        onSelect: () =>
          setRenamingStep({
            index,
            name: step.name,
            workspaceName: step.workspaceName,
          }),
      },
      {
        label: "编辑简报",
        onSelect: () => setBriefEditing({ index, text: step.brief }),
      },
      {
        label: "复制工作区名",
        onSelect: () =>
          copyText(step.workspaceName, "复制工作区名失败"),
      },
      { label: "删除步骤", onSelect: () => void removeStep(index) },
    ];
  }

  // ===== 资源面板 =====
  const [resOpen, setResOpen] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverState, setDiscoverState] = useState<{
    items: DiscoveredResourceDto[];
    selected: Set<string>;
  } | null>(null);
  const [resourceMenu, setResourceMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const [gitignoreHint, setGitignoreHint] = useState(false);

  async function discoverResources() {
    if (!project) return;
    setDiscoverLoading(true);
    try {
      const items = await invoke<DiscoveredResourceDto[]>(
        "discover_resources",
        { path: project.path },
      );
      // 默认全选未登记项，用户按需取消勾选
      setDiscoverState({
        items,
        selected: new Set(
          items.filter((d) => !d.exists).map((d) => d.path),
        ),
      });
    } catch (reason) {
      onError(String(reason));
    } finally {
      setDiscoverLoading(false);
    }
  }

  async function addSelectedResources() {
    if (!project || !cfg || !discoverState) return;
    const additions = discoverState.items
      .filter((d) => discoverState.selected.has(d.path) && !d.exists)
      .map((d) => ({
        name: baseName(d.path),
        path: d.path,
        type: d.type,
        readonly: false,
        note: "",
      }));
    if (additions.length === 0) {
      setDiscoverState(null);
      return;
    }
    if (
      await saveConfig({
        ...cfg,
        resources: [...cfg.resources, ...additions],
      })
    ) {
      setDiscoverState(null);
      // 一次性提示：repo 内数据资源建议加入 .gitignore，避免大文件进 git 历史
      const key = `ccode.resGitignoreHint.${project.path}`;
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, "1");
        setGitignoreHint(true);
      }
    }
  }

  async function removeResource(index: number) {
    if (!cfg) return;
    await saveConfig({
      ...cfg,
      resources: cfg.resources.filter((_, i) => i !== index),
    });
  }

  // PDF 资源「查看」：拼绝对路径交给终端页预览（后端按登记资源白名单放行，可选段问 AI）
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPage = useAppStore((s) => s.setPage);
  function viewPdfResource(r: ProjectResourceDto) {
    setPreviewReq({
      path: absoluteResourcePath(projectPath, r.path),
      name: r.name || baseName(r.path),
    });
    setPage("terminal");
  }

  function resourceMenuItems(index: number) {
    if (!cfg) return [];
    const r = cfg.resources[index];
    return [
      {
        label: "复制路径",
        onSelect: () =>
          copyText(
            absoluteResourcePath(projectPath, r.path),
            "复制资源路径失败",
          ),
      },
      { label: "移除资源", onSelect: () => void removeResource(index) },
    ];
  }

  // ===== 渲染 =====
  return (
    <section className="mb-5">
      <div className="mb-1 flex min-w-0 items-center gap-2">
        {renamingProject ? (
          <form
            onSubmit={submitRenameProject}
            className="flex shrink-0 items-center gap-1"
          >
            <input
              className={fieldSm}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              autoFocus
              required
            />
            <button type="submit" className={actionBtn}>
              确定
            </button>
            <button
              type="button"
              className={actionBtn}
              onClick={() => setRenamingProject(false)}
            >
              取消
            </button>
          </form>
        ) : (
          <h2 className="shrink-0 text-sm font-medium text-l1">
            {displayName}
          </h2>
        )}
        {registered && cfg?.topic?.trim() && (
          <span
            className="min-w-0 max-w-xs truncate text-xs text-l3"
            title={cfg.topic ?? ""}
          >
            {cfg.topic}
          </span>
        )}
        {!registered && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
            <span className="h-1.5 w-1.5 rounded-full bg-l4" />
            未注册
          </span>
        )}
        <span
          className="min-w-0 truncate font-mono text-xs text-l4"
          title={projectPath}
        >
          {projectPath}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!registered &&
            (registering ? (
              <form
                onSubmit={submitRegister}
                className="flex items-center gap-1"
              >
                <input
                  className={fieldSm}
                  value={registerName}
                  onChange={(e) => setRegisterName(e.target.value)}
                  placeholder="项目名"
                  autoFocus
                />
                <button type="submit" className={ctaSm}>
                  注册
                </button>
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => setRegistering(false)}
                >
                  取消
                </button>
              </form>
            ) : (
              <button
                type="button"
                className={actionBtn}
                onClick={() => {
                  setRegisterName(repoName);
                  setRegistering(true);
                }}
              >
                注册项目
              </button>
            ))}
          {registered && (
            <button
              type="button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setProjectMenu({ x: rect.right, y: rect.bottom + 4 });
              }}
              title="项目操作"
              aria-label={`项目操作：${displayName}`}
              className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
            >
              ⋯
            </button>
          )}
        </div>
      </div>

      {editingTopic && cfg && (
        <form onSubmit={submitTopic} className="mb-2 flex items-center gap-1">
          <input
            className={`${fieldSm} min-w-0 flex-1`}
            value={topicDraft}
            onChange={(e) => setTopicDraft(e.target.value)}
            placeholder="课题主题：一键开步时写进 TASK.md；留空清除"
            autoFocus
          />
          <button type="submit" className={ctaSm}>
            保存
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() => setEditingTopic(false)}
          >
            取消
          </button>
        </form>
      )}

      {savingTemplate && cfg && (
        <form
          onSubmit={submitSaveTemplate}
          className="mb-2 flex flex-wrap items-center gap-1"
        >
          <input
            className={fieldSm}
            value={tplNameDraft}
            onChange={(e) => setTplNameDraft(e.target.value)}
            placeholder="模板名，如 我的综述流程"
            autoFocus
            required
          />
          <input
            className={`${fieldSm} min-w-0 flex-1`}
            value={tplDescDraft}
            onChange={(e) => setTplDescDraft(e.target.value)}
            placeholder="描述（可选）：适用场景说明"
          />
          <button type="submit" className={ctaSm} disabled={tplSaving}>
            {tplSaving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() => setSavingTemplate(false)}
          >
            取消
          </button>
        </form>
      )}

      {tplSavedMsg && (
        <div className="mb-2 flex items-center gap-2 rounded bg-strip p-2 text-xs text-l2">
          <span className="min-w-0 flex-1">
            <span className="mr-1 text-okb">✓</span>
            {tplSavedMsg}
          </span>
          <button
            type="button"
            className={`${actionBtn} shrink-0`}
            onClick={() => setTplSavedMsg(null)}
          >
            知道了
          </button>
        </div>
      )}

      {registered && freshGitGuide && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded bg-strip p-2 text-xs text-l2">
          <span>新项目：若目录还不是 git 仓库，初始化后才能创建工作区。</span>
          {gitMsg && (
            <span>
              <span className="mr-1 text-okb">✓</span>
              {gitMsg}
            </span>
          )}
          <button
            type="button"
            className={ctaSm}
            disabled={gitBusy}
            onClick={() => void ensureGit()}
          >
            {gitBusy ? "初始化中…" : "初始化 git"}
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={onDismissGitGuide}
          >
            知道了
          </button>
        </div>
      )}

      {/* 首启引导（轻量版）：注册项目且 steps 为空 → 从模板库选择写入流水线 */}
      {registered && cfg && cfg.steps.length === 0 && (
        <div className="mb-2 rounded border border-hairline bg-strip p-3">
          <p className="mb-2 text-xs text-l3">
            该项目还没有流水线步骤。从模板库选择（英文综述 / 科研论文 / 数据处理 /
            毕业论文，以及已另存的自定义模板）写入 .ccode/project.toml，之后可逐步编辑。
          </p>
          <input
            className={`${fieldSm} mb-2 w-full`}
            value={templateTopic}
            onChange={(e) => setTemplateTopic(e.target.value)}
            placeholder="课题主题（可选）：随模板写进 project.toml，开步时进入 TASK.md"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={ctaSm}
              onClick={() => setPickerOpen((v) => !v)}
            >
              {pickerOpen ? "收起模板库" : "选择流水线模板"}
            </button>
            <button
              type="button"
              className={actionBtn}
              onClick={() => setAddingStep((v) => !v)}
            >
              + 手动添加步骤
            </button>
          </div>
          {pickerOpen && (
            <TemplatePicker
              applying={applyingTemplate}
              onApply={(item) => void applyTemplate(item)}
              onError={onError}
            />
          )}
          {addingStep && renderAddStepForm()}
        </div>
      )}

      {/* 流水线 strip：状态从绑定工作区派生，纯展示 */}
      {registered && cfg && cfg.steps.length > 0 && (
        <div className="mb-2 rounded border border-hairline bg-strip p-2">
          <ol className="flex flex-wrap items-center gap-y-2">
            {cfg.steps.map((step, i) => {
              const st = deriveStepStatus(step, workspaces, health, drift);
              const style = STEP_STATUS_STYLE[st.key];
              return (
                <li key={`${i}-${step.name}`} className="flex items-center">
                  {i > 0 && <span className="mx-1.5 text-xs text-l4">→</span>}
                  <div className="flex items-center gap-1.5 rounded bg-inset px-2 py-1">
                    {renamingStep?.index === i ? (
                      <form
                        onSubmit={submitRenameStep}
                        className="flex items-center gap-1"
                      >
                        <input
                          className={fieldSm}
                          value={renamingStep.name}
                          onChange={(e) =>
                            setRenamingStep({
                              ...renamingStep,
                              name: e.target.value,
                            })
                          }
                          placeholder="步骤名"
                          autoFocus
                        />
                        <input
                          className={`${fieldSm} font-mono`}
                          value={renamingStep.workspaceName}
                          onChange={(e) =>
                            setRenamingStep({
                              ...renamingStep,
                              workspaceName: e.target.value,
                            })
                          }
                          placeholder="工作区名（英文）"
                        />
                        <button type="submit" className={actionBtn}>
                          确定
                        </button>
                        <button
                          type="button"
                          className={actionBtn}
                          onClick={() => setRenamingStep(null)}
                        >
                          取消
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs font-medium text-l1">
                        {step.name}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 text-xs ${style.textClass}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${style.dotClass}`}
                      />
                      {style.label}
                    </span>
                    {st.key === "pending" && !st.ws && (
                      <button
                        type="button"
                        className={ctaSm}
                        disabled={starting === i || !step.workspaceName}
                        title={
                          step.workspaceName
                            ? undefined
                            : "该步骤未配置工作区名，请先在 ⋯ 中补充"
                        }
                        onClick={() => void startStep(i)}
                      >
                        {starting === i ? "创建中…" : "开始"}
                      </button>
                    )}
                    {st.key === "pending" && st.ws && (
                      <button
                        type="button"
                        className={actionBtn}
                        title="绑定的工作区已归档，恢复后继续"
                        onClick={() => void restoreWs(st.ws!)}
                      >
                        恢复
                      </button>
                    )}
                    {st.ws && canOpenWs(st.ws) && (
                      <>
                        <button
                          type="button"
                          className={actionBtn}
                          onClick={() => onOpenTerminal(st.ws!)}
                        >
                          ⌨ 终端
                        </button>
                        <button
                          type="button"
                          className={`${actionBtn} ${
                            st.key === "blocked" ? "text-warn-text" : ""
                          }`}
                          onClick={() =>
                            onOpenReview(
                              st.ws!,
                              st.key === "blocked"
                                ? "resolve-conflict"
                                : undefined,
                            )
                          }
                        >
                          {st.key === "blocked" ? "解决冲突" : "评审"}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setStepMenu({
                          x: rect.right,
                          y: rect.bottom + 4,
                          index: i,
                        });
                      }}
                      title="步骤操作"
                      aria-label={`步骤操作：${step.name}`}
                      className="flex h-6 w-6 items-center justify-center rounded text-xs text-l3 hover:bg-white/5 hover:text-l1"
                    >
                      ⋯
                    </button>
                  </div>
                </li>
              );
            })}
            <li className="flex items-center">
              <span className="mx-1.5 text-xs text-l4">→</span>
              <button
                type="button"
                className={actionBtn}
                onClick={() => setAddingStep((v) => !v)}
              >
                + 步骤
              </button>
              <button
                type="button"
                className={actionBtn}
                title="从模板库选择模板替换现有步骤（工作区与资源不受影响）"
                onClick={() => setPickerOpen((v) => !v)}
              >
                {pickerOpen ? "收起模板库" : "重置为模板"}
              </button>
            </li>
          </ol>
          {pickerOpen && (
            <TemplatePicker
              applying={applyingTemplate}
              onApply={(item) => void applyTemplate(item)}
              onError={onError}
            />
          )}
          {addingStep && renderAddStepForm()}
          {briefEditing && (
            <form
              onSubmit={submitBrief}
              className="mt-2 border-t border-hairline pt-2"
            >
              <span className="mb-1 block text-xs text-l3">
                简报：{cfg.steps[briefEditing.index].name}
                （一键开步时落成工作区 TASK.md）
              </span>
              <textarea
                className="w-full rounded border border-field bg-canvas px-2 py-1.5 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                rows={4}
                value={briefEditing.text}
                onChange={(e) =>
                  setBriefEditing({ ...briefEditing, text: e.target.value })
                }
                placeholder="本步骤的目标、背景与交付物要求"
                autoFocus
              />
              <div className="mt-1 flex justify-end gap-1">
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => setBriefEditing(null)}
                >
                  取消
                </button>
                <button type="submit" className={ctaSm}>
                  保存简报
                </button>
              </div>
            </form>
          )}
          {cfgWarnings.length > 0 && (
            <p
              className="mt-1 text-xs text-warn-text"
              title={cfgWarnings.join("\n")}
            >
              project.toml 有 {cfgWarnings.length} 条字段警告（悬停查看）
            </p>
          )}
        </div>
      )}

      {/* 资源面板：默认折叠，管理列表只展示状态与主路径 */}
      {registered && cfg && (
        <div className="mb-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
              onClick={() => setResOpen((v) => !v)}
              aria-expanded={resOpen}
            >
              <span>{resOpen ? "▾" : "▸"}</span>
              资源（{cfg.resources.length}）
            </button>
            {resOpen && (
              <button
                type="button"
                className={actionBtn}
                disabled={discoverLoading}
                onClick={() => void discoverResources()}
              >
                {discoverLoading ? "扫描中…" : "发现资源"}
              </button>
            )}
          </div>
          {resOpen && (
            <div className="mt-1 rounded border border-hairline bg-strip p-2">
              {cfg.resources.length === 0 && !discoverState && (
                <p className="text-xs text-l4">
                  还没有登记资源。点「发现资源」扫描项目目录（PDF / CSV /
                  parquet / bib 等），勾选后一键登记。
                </p>
              )}
              {cfg.resources.length > 0 && (
                <ul className="divide-y divide-hairline">
                  {cfg.resources.map((r, i) => (
                    <li
                      key={`${i}-${r.path}`}
                      className="flex min-w-0 items-center gap-2 py-1.5"
                    >
                      <span className="shrink-0 rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                        {RESOURCE_TYPE_LABELS[r.type] ?? "其他"}
                      </span>
                      <span
                        className="shrink-0 text-xs text-l2"
                        title={r.note || undefined}
                      >
                        {r.name}
                      </span>
                      {r.readonly && (
                        <span className="shrink-0 text-xs text-l4">只读</span>
                      )}
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-xs text-l4"
                        title={r.path}
                      >
                        {r.path}
                      </span>
                      {/\.pdf$/i.test(r.path) && (
                        <button
                          type="button"
                          onClick={() => viewPdfResource(r)}
                          title="在终端页内嵌预览（可选中文字问 AI）"
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-l3 hover:bg-white/5 hover:text-l1"
                        >
                          查看
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          const rect =
                            e.currentTarget.getBoundingClientRect();
                          setResourceMenu({
                            x: rect.right,
                            y: rect.bottom + 4,
                            index: i,
                          });
                        }}
                        title="资源操作"
                        aria-label={`资源操作：${r.name}`}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs text-l3 hover:bg-white/5 hover:text-l1"
                      >
                        ⋯
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {discoverState && (
                <div className="mt-2 border-t border-hairline pt-2">
                  {discoverState.items.length === 0 ? (
                    <p className="text-xs text-l4">
                      未扫描到 PDF / CSV / parquet / bib 等资源文件。
                    </p>
                  ) : (
                    <>
                      <span className="mb-1 block text-xs text-l3">
                        扫描到 {discoverState.items.length}
                        个候选资源，勾选后登记到 project.toml：
                      </span>
                      <ul className="max-h-48 space-y-1 overflow-auto">
                        {discoverState.items.map((d) => (
                          <li key={d.path}>
                            {d.exists ? (
                              <span className="flex items-center gap-1.5 text-xs text-l4">
                                <span className="text-okb">✓</span>
                                <span className="truncate font-mono">
                                  {d.path}
                                </span>
                                <span className="shrink-0">已登记</span>
                              </span>
                            ) : (
                              <Checkbox
                                checked={discoverState.selected.has(d.path)}
                                onChange={(checked) => {
                                  const selected = new Set(
                                    discoverState.selected,
                                  );
                                  if (checked) selected.add(d.path);
                                  else selected.delete(d.path);
                                  setDiscoverState({
                                    ...discoverState,
                                    selected,
                                  });
                                }}
                                label={
                                  <span className="flex min-w-0 items-center gap-2 text-xs">
                                    <span className="shrink-0 rounded bg-inset px-1 py-0.5 text-l3">
                                      {RESOURCE_TYPE_LABELS[d.type] ??
                                        "其他"}
                                    </span>
                                    <span className="truncate font-mono text-l2">
                                      {d.path}
                                    </span>
                                    <span className="shrink-0 text-l4">
                                      {formatSize(d.size)}
                                    </span>
                                  </span>
                                }
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 flex justify-end gap-1">
                        <button
                          type="button"
                          className={actionBtn}
                          onClick={() => setDiscoverState(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className={ctaSm}
                          disabled={discoverState.selected.size === 0}
                          onClick={() => void addSelectedResources()}
                        >
                          添加选中（{discoverState.selected.size}）
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {gitignoreHint && (
                <div className="mt-2 flex items-center gap-2 rounded bg-inset p-2 text-xs text-l2">
                  <span className="min-w-0 flex-1">
                    提示：数据/产物类大文件建议加入 .gitignore，避免进入 git
                    历史（git init 生成的 .gitignore 已含常见目录注释）。
                  </span>
                  <button
                    type="button"
                    className={`${actionBtn} shrink-0`}
                    onClick={() => setGitignoreHint(false)}
                  >
                    知道了
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {children}

      {projectMenu && project && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          alignRight
          onClose={() => setProjectMenu(null)}
          items={[
            {
              label: "重命名项目",
              onSelect: () => {
                setProjectName(project.name);
                setRenamingProject(true);
              },
            },
            {
              label: "编辑课题主题",
              disabled: !cfg,
              title: cfg ? undefined : "project.toml 尚未加载完成",
              onSelect: () => {
                setTopicDraft(cfg?.topic ?? "");
                setEditingTopic(true);
              },
            },
            {
              label: "另存为模板",
              disabled: !cfg || cfg.steps.length === 0,
              title:
                cfg && cfg.steps.length > 0
                  ? undefined
                  : "没有可保存的流水线步骤",
              onSelect: () => {
                setTplSavedMsg(null);
                setSavingTemplate(true);
              },
            },
            {
              label: "复制项目路径",
              onSelect: () => copyText(project.path, "复制项目路径失败"),
            },
            {
              label: "移除项目注册",
              onSelect: () => void removeRegistration(),
            },
          ]}
        />
      )}
      {stepMenu && (
        <ContextMenu
          x={stepMenu.x}
          y={stepMenu.y}
          alignRight
          onClose={() => setStepMenu(null)}
          items={stepMenuItems(stepMenu.index)}
        />
      )}
      {resourceMenu && (
        <ContextMenu
          x={resourceMenu.x}
          y={resourceMenu.y}
          alignRight
          onClose={() => setResourceMenu(null)}
          items={resourceMenuItems(resourceMenu.index)}
        />
      )}
    </section>
  );

  function renderAddStepForm() {
    return (
      <form
        onSubmit={submitAddStep}
        className="mt-2 flex flex-wrap items-center gap-1 border-t border-hairline pt-2"
      >
        <input
          className={fieldSm}
          value={newStepName}
          onChange={(e) => setNewStepName(e.target.value)}
          placeholder="步骤名，如 文献综述"
          autoFocus
          required
        />
        <input
          className={`${fieldSm} font-mono`}
          value={newStepWsName}
          onChange={(e) => setNewStepWsName(e.target.value)}
          placeholder={
            sanitizeWsName(newStepName) ||
            `step-${(cfg?.steps.length ?? 0) + 1}`
          }
          title="绑定工作区名（英文）；留空自动派生"
        />
        <button type="submit" className={ctaSm} disabled={!newStepName.trim()}>
          添加
        </button>
        <button
          type="button"
          className={actionBtn}
          onClick={() => setAddingStep(false)}
        >
          取消
        </button>
      </form>
    );
  }
}
