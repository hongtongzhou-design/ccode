import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import PipelineEditor from "./PipelineEditor";
import HistoryOverlay from "./HistoryOverlay";
import TemplatePicker, { type TemplatePickItem } from "./TemplatePicker";
import ArtifactChecklist, {
  absoluteResourcePath,
  formatSize,
} from "./ArtifactChecklist";
import { Checkbox, hoverRevealClass } from "./PageFrame";
import { useAppStore } from "../store";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import { startPipelineStep } from "../pipeline-start";
import type {
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
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-white/5 hover:text-l1";
const ctaSm =
  "inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110 disabled:opacity-50";
const fieldSm =
  "h-7 rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";
/** 步进器虚线块：严格 5×5px 实心正方形，真实元素而非渐变。
 *  完成列亮灰白（l2）、未完成列暗（hairline）——链条不用绿色，绿色只给完成圆（--color-done）；
 *  列 hover 微亮一档（表达整列是一个可交互单元）；300ms 颜色过渡 */
function DashBlock({ k, done }: { k: string; done: boolean }) {
  return (
    <span
      key={k}
      aria-hidden
      className={`block h-[5px] w-[5px] shrink-0 rounded-[1px] transition-colors duration-300 ${
        done ? "bg-l2 group-hover:brightness-110" : "bg-hairline group-hover:bg-l3"
      }`}
    />
  );
}

/** 功能小方块（圆前=编辑简报 / 圆后=产物核验）：平时与虚线段等大混在线里（5px），
 *  hover/聚焦时那一块提亮 cta 并略放大（scale-150，容器已 overflow-y-clip 不会触发滚动条晃动）；
 *  28px 透明热区（绝对定位子元素撑开，不占布局）保证好按；完成列亮色（l2）、未完成列暗（hairline），
 *  方块不用绿色——绿色只给链条与完成圆；功能名只在 title 悬浮 */
function SquareButton({
  title,
  label,
  disabled,
  expanded,
  done,
  onClick,
}: {
  title: string;
  label: string;
  disabled?: boolean;
  expanded?: boolean;
  /** 完成列：方块亮色（l2）；未完成列暗（hairline） */
  done?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={`relative block h-[5px] w-[5px] shrink-0 cursor-pointer rounded-[1px] transition-[transform,background-color] duration-300 hover:scale-150 hover:bg-cta focus-visible:scale-150 focus-visible:bg-cta disabled:cursor-not-allowed ${
        done ? "bg-l2 group-hover:brightness-110" : "bg-hairline group-hover:bg-l3"
      }`}
    >
      <span className="absolute left-1/2 top-1/2 size-[28px] -translate-x-1/2 -translate-y-1/2" />
    </button>
  );
}

/** 步进器单元格：真实 flex 块拼出的方块节律线（5px 块 + 5px 间隙）。
 *  虚线块数按列宽用 ResizeObserver 现算（每块含隙占 10px），任何列宽/步骤数下尺寸与间隔严格一致，
 *  圆与方块都是节律中的节点（圆前后各一道 5px 间隙），不存在渐变相位残段。 */
function StepperCell({
  circleClass,
  circleTitle,
  circleLabel,
  circleDisabled,
  pulsing,
  onCircleClick,
  briefTitle,
  briefLabel,
  onBriefClick,
  artifactsTitle,
  artifactsLabel,
  artifactsDisabled,
  artifactsExpanded,
  onArtifactsClick,
}: {
  circleClass: string;
  circleTitle: string;
  circleLabel: string;
  circleDisabled: boolean;
  pulsing: boolean;
  onCircleClick: () => void;
  briefTitle: string;
  briefLabel: string;
  onBriefClick: () => void;
  artifactsTitle: string;
  artifactsLabel: string;
  artifactsDisabled: boolean;
  artifactsExpanded: boolean;
  onArtifactsClick: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [dashCount, setDashCount] = useState(0);
  const [slack, setSlack] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      // 固定件 = 圆 24 + 两方块 10 + 间隙（节点与块数 N 共 N+2 道 5px 间隙）；
      // 每个虚线块含隙占 10px：链长 = 10N + 44。除不尽的余数 r(<10px) 均分到圆两侧间隙
      // （参考图里圆周围的空档本来就大于虚线间隙，余数藏在语义空档里，方块永远 5×5 等大）
      const w = el.clientWidth;
      const n = Math.max(0, Math.floor((w - 44) / 10));
      setDashCount(n);
      setSlack(Math.max(0, w - 44 - 10 * n));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const left = Math.ceil(dashCount / 2);
  const right = Math.floor(dashCount / 2);
  // done 列整条链变绿（已打通）；进行中/checking 的圆加 cta 外环锁定焦点
  const done = circleClass.includes("bg-done");
  const active = circleClass.includes("bg-cta ");
  return (
    <li
      ref={ref}
      className="group flex min-w-0 items-center justify-center gap-[5px]"
    >
      {Array.from({ length: left }, (_, k) => (
        <DashBlock key={`l${k}`} k={`l${k}`} done={done} />
      ))}
      <SquareButton
        title={briefTitle}
        label={briefLabel}
        done={done}
        onClick={onBriefClick}
      />
      <span
        className="shrink-0"
        style={{ marginInline: slack / 2 }}
      >
        <button
          type="button"
          disabled={circleDisabled}
          title={circleTitle}
          aria-label={circleLabel}
          className={`block h-[24px] w-[24px] shrink-0 cursor-pointer rounded-full transition-[filter,color,background-color] duration-300 hover:brightness-110 disabled:cursor-not-allowed ${circleClass} ${
            pulsing ? "animate-pulse" : ""
          } ${active ? "ring-2 ring-cta/50" : ""}`}
          onClick={onCircleClick}
        />
      </span>
      <SquareButton
        title={artifactsTitle}
        label={artifactsLabel}
        disabled={artifactsDisabled}
        expanded={artifactsExpanded}
        done={done}
        onClick={onArtifactsClick}
      />
      {Array.from({ length: right }, (_, k) => (
        <DashBlock key={`r${k}`} k={`r${k}`} done={done} />
      ))}
    </li>
  );
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 工作区记住的上次启动配置（与终端页 `ccode.wsLast.<worktreePath>` 同一键） */
function wsLastConfig(
  worktreePath: string,
): Partial<{ agentId: string; profileId: string; model: string }> {
  try {
    return JSON.parse(
      localStorage.getItem(`ccode.wsLast.${worktreePath}`) ?? "{}",
    );
  } catch {
    return {};
  }
}

/** 步骤状态：从绑定工作区（steps[].workspaceName 匹配工作区名）的 health/drift 派生，纯展示无双状态机 */
type StepStatusKey =
  | "pending"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "checking";

/** 状态文字只进悬浮 title（白话双层），胶囊上不再直接显示 */
const STEP_STATUS_LABEL: Record<StepStatusKey, string> = {
  pending: "待开始",
  active: "进行中",
  review: "待评审",
  blocked: "阻塞",
  done: "已完成",
  checking: "检查中",
};

/** 大圆步进器的圆填色：纯实心无字符，状态只靠颜色区分；进行中/检查中带呼吸脉冲表达「正在动」 */
function stepCircleClass(key: StepStatusKey): string {
  // done 用随主题走的低饱和完成绿（--color-done），与状态 ok 绿解耦（用户反馈亮绿突兀）
  if (key === "done") return "bg-done";
  if (key === "blocked") return "bg-warn";
  if (key === "review") return "bg-cta-pill";
  if (key === "active" || key === "checking") return "bg-cta animate-pulse";
  // 待开始：实心灰圆
  return "bg-l4";
}

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
  refreshToken,
  freshGitGuide,
  onDismissGitGuide,
  onRefresh,
  onOpenTerminal,
  onRegisterProject,
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
  /** 页面每次刷新自增，触发档案卡重读（用户可能在页外改了 project.toml） */
  refreshToken: number;
  /** 刚通过「添加项目」注册：显示一次性 git 初始化引导 */
  freshGitGuide: boolean;
  onDismissGitGuide: () => void;
  onRefresh: () => Promise<void>;
  /** initialPrompt：一键开步时预填的首条指令；步进器大圆「跳终端」也经此回调（不传 prompt） */
  onOpenTerminal: (ws: WorkspaceDto, initialPrompt?: string) => void;
  /** 未注册分组的「注册项目」：打开与页头「+ 添加项目」相同的注册弹窗（预选该 repo 路径） */
  onRegisterProject: (repoPath: string) => void;
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

  // ===== 分组头：重命名 / 移除注册 =====
  const [renamingProject, setRenamingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 课题主题：存 project.toml 顶层 topic，一键开步写进 TASK.md
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");

  // 保存历史（白话时间线）：全宽覆盖层，同 PipelineEditor 形态
  const [historyOpen, setHistoryOpen] = useState(false);
  // 工作区名 → 步骤名：merge commit 的「验收合并」优先显示步骤名
  const wsStepMap = Object.fromEntries(
    (cfg?.steps ?? []).map((s) => [s.workspaceName, s.name]),
  );

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
  // 流水线编辑器（RX1）：步骤编辑唯一入口，覆盖旧 ⋯ 内联重命名/编辑简报/+ 步骤表单
  const [editorOpen, setEditorOpen] = useState(false);
  // 圆前小方块（编辑简报）：打开编辑器并定位到该步骤卡片（null = 从项目菜单进入，不定位）
  const [editorFocus, setEditorFocus] = useState<number | null>(null);
  // 圆后小方块（产物）手风琴：strip 下方就地展开 ArtifactChecklist，记展开的步骤 index（单开）
  const [artifactsStep, setArtifactsStep] = useState<number | null>(null);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  // 「使用科研流水线模板」旁的可选课题主题输入，随模板一并落进 project.toml
  const [templateTopic, setTemplateTopic] = useState("");
  // 模板选择器：首启引导与「更换模板」共用，列出内置 + 用户模板
  const [pickerOpen, setPickerOpen] = useState(false);
  // 校验提示浮层：⚠ 徽标点击展开逐条全文（WKWebView 不显示 title 悬浮）
  const [warnOpen, setWarnOpen] = useState(false);
  // 另存为模板：内联表单（WKWebView 无 window.prompt），同名覆盖先 confirm
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [tplNameDraft, setTplNameDraft] = useState("");
  const [tplDescDraft, setTplDescDraft] = useState("");
  const [tplSaving, setTplSaving] = useState(false);
  const [tplSavedMsg, setTplSavedMsg] = useState<string | null>(null);

  /** 一键开步（§11.3 机制三）：invoke 链路在 pipeline-start.ts 与评审「开始下一步」共用，此处只管组件态 */
  async function startStep(index: number) {
    if (!project || !cfg) return;
    const step = cfg.steps[index];
    setStarting(index);
    try {
      await startPipelineStep({
        projectPath: project.path,
        step,
        cfg,
        onError,
        // 刷新先于跳终端：run 脚本写入在工作区行刷新之前，「运行脚本」菜单当次即可见
        onOpenTerminal: async (ws, initialPrompt) => {
          await onRefresh();
          onOpenTerminal(ws, initialPrompt);
        },
      });
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

  function openEditor(focus: number | null = null) {
    setEditorFocus(focus);
    setEditorOpen(true);
  }

  /** 大圆点击 = 主推进动作（按状态唯一语义）：待开始开步/已归档恢复/进行中跳工作区终端/已合并开主仓终端 */
  function onCircleClick(
    index: number,
    st: { key: StepStatusKey; ws?: WorkspaceDto },
  ) {
    if (st.key === "pending") {
      if (st.ws) void restoreWs(st.ws);
      else void startStep(index);
      return;
    }
    if (st.key === "done") {
      setPendingTerminal({
        cwd: projectPath,
        extraEnv: {},
        title: displayName,
        shellOnly: true,
      });
      setPage("terminal");
      return;
    }
    if (st.ws) onOpenTerminal(st.ws);
  }

  async function applyTemplate(item: TemplatePickItem) {
    if (!cfg) return;
    // 已有步骤时视为「更换模板」：提示覆盖，绑定的工作区与资源不受影响
    if (
      cfg.steps.length > 0 &&
      !window.confirm(
        `更换模板「${item.name}」？现有 ${cfg.steps.length} 个步骤会被替换，绑定的工作区与资源不受影响。继续？`,
      )
    )
      return;
    setApplyingTemplate(true);
    // 模板只填 steps（+ 可选课题主题）；resources/artifactDir 保持现状，
    // 更换模板时模板输入框不渲染，topic 为空则保留既有课题主题
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

  /** 编辑器保存：整体写回 steps 后重读配置，刷新资源绑定等校验警告并关闭编辑器 */
  async function savePipeline(steps: ProjectStepDto[]) {
    if (!project || !cfg) return;
    setPipelineSaving(true);
    const ok = await saveConfig({ ...cfg, steps });
    if (ok) {
      try {
        const read = await invoke<ProjectConfigReadDto>(
          "read_project_config",
          { path: project.path },
        );
        setCfg(read.config);
        setCfgWarnings(read.warnings);
      } catch {
        /* 重读失败保留刚写入的本地配置 */
      }
      setEditorOpen(false);
    }
    setPipelineSaving(false);
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

  function stepMenuItems(index: number) {
    if (!cfg) return [];
    const step = cfg.steps[index];
    // 「◫ 定位目录」与胶囊原 ◫ 按钮同一语义：仅活跃工作区可定位
    const st = deriveStepStatus(step, workspaces, health, drift);
    const activeWs =
      st.ws && st.ws.status === "active" ? st.ws : undefined;
    return [
      {
        label: "◫ 定位目录",
        disabled: !activeWs,
        title: activeWs
          ? "跳到终端页，文件树定位到该工作区目录"
          : st.ws
            ? "工作区已归档，无法定位目录"
            : "工作区尚未创建",
        onSelect: () => {
          setEnterCwdReq(activeWs!.worktreePath);
          setPage("terminal");
        },
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
  // RX2b：步骤胶囊的「◫」切根交接与产物面板的 agent/profile 显示
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const profiles = useAppStore((s) => s.profiles);
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
  // 分组头状态聚合（CAO 风格小圆点计数）：只统计活跃工作区，全零不显示
  const groupCounts = { active: 0, review: 0, blocked: 0 };
  for (const ws of workspaces) {
    if (ws.status !== "active") continue;
    const h = health[ws.id];
    const d = drift[ws.id];
    if (d?.canResolveMerge === true || h?.conflict === true) {
      groupCounts.blocked += 1;
    } else if (h?.readyToMerge === true) {
      groupCounts.review += 1;
    } else {
      groupCounts.active += 1;
    }
  }
  const groupCountsTotal =
    groupCounts.active + groupCounts.review + groupCounts.blocked;
  // 课题主题直接显示在项目名旁（v3.47：只挂悬浮提示等于不存在——用户反馈看不到）
  const topicText =
    registered && cfg?.topic?.trim() ? cfg.topic.trim() : undefined;
  // 圆后小方块（产物）手风琴展开项（单开）：无绑定工作区不渲染（方块本身已禁用，此处兜底）
  const artStep =
    cfg && artifactsStep !== null ? (cfg.steps[artifactsStep] ?? null) : null;
  const artSt = artStep
    ? deriveStepStatus(artStep, workspaces, health, drift)
    : null;
  const artWs = artSt?.ws;
  const artMerged = artSt?.key === "done";
  return (
    // 分组卡片收敛掉外框/底色：hairline 分隔 + 左侧缩进线分层，strip 底只保留给流水线等必要块
    <section className="mb-5">
      <div className="flex min-h-12 min-w-0 items-center gap-2 border-b border-hairline px-4 py-2.5">
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
        {topicText && (
          <span
            className="min-w-0 max-w-72 truncate text-xs text-l3"
            title={topicText}
          >
            {topicText}
          </span>
        )}
        {!registered && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
            <span className="size-2 rounded-full bg-l4" />
            未注册
          </span>
        )}
        {groupCountsTotal > 0 && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-l3">
            {groupCounts.active > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-ok-text" />
                {groupCounts.active} 进行中
              </span>
            )}
            {groupCounts.review > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-cta" />
                {groupCounts.review} 待评审
              </span>
            )}
            {groupCounts.blocked > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-err-text" />
                {groupCounts.blocked} 阻塞
              </span>
            )}
          </span>
        )}
        {/* 校验提示（项目配置级，属于项目头而非流水线条）：⚠ 徽标点开展开逐条全文浮层 */}
        {cfgWarnings.length > 0 && (
          <span className="relative shrink-0">
            <button
              type="button"
              aria-expanded={warnOpen}
              title="查看全部校验提示"
              className="rounded px-1 text-xs text-warn-text hover:bg-white/5"
              onClick={() => setWarnOpen((v) => !v)}
            >
              ⚠ {cfgWarnings.length}
            </button>
            {warnOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setWarnOpen(false)}
                />
                <ul className="absolute left-0 z-50 mt-1 w-72 space-y-1.5 rounded-md border border-hairline bg-raised p-2">
                  {cfgWarnings.map((w, i) => (
                    <li key={i} className="break-words text-xs text-l2">
                      {w}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </span>
        )}
        <span
          className="min-w-0 truncate font-mono text-xs text-l4 opacity-70"
          title={projectPath}
        >
          {projectPath}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!registered && (
            <button
              type="button"
              className={actionBtn}
              title="注册该项目目录，获得流水线骨架与资源面板"
              onClick={() => onRegisterProject(repoPath)}
            >
              注册项目
            </button>
          )}
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

      {/* 分组主体：左侧 1px 缩进线 + 透明度分层，保持原 p-4 留白节奏 */}
      <div className="border-l border-white/5 p-4">
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
            <span className="mr-1 text-ok-text">✓</span>
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
              <span className="mr-1 text-ok-text">✓</span>
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
        <div className="mb-2 rounded-md bg-strip p-3">
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
              title="打开流水线编辑器，从头手动添加步骤"
              onClick={() => openEditor()}
            >
              编辑流水线
            </button>
          </div>
        </div>
      )}

      {/* 流水线 strip（大圆步进器，v3.46）：状态从绑定工作区派生；
          大圆 = 状态色 + 主推进点击，圆前小方块 = 编辑简报，圆后小方块 = 产物核验。
          结构 = 名称带 + 步进器带两个同列网格；虚线只有一条（步进器带级单层渐变），
          列缝无双块、相位一致；圆与方块各自带 strip 色遮断，虚线只在其间穿行 */}
      {registered && cfg && cfg.steps.length > 0 && (
        <div className="mb-3 rounded-md bg-strip px-3 py-2.5">
          {/* 等分列网格：列宽下限 9rem 让更多步骤在常规窗口内完整可见；
              窗口过窄放不下全部步骤时保持整体横向滚动（不换行，虚线与各列大圆同轴） */}
          {/* 横向滚动容器必须显式 overflow-y-clip：overflow-x:auto 会把 y 轴也算成 auto，
              方块的 28px 透明热区/hover 放大溢出纵向就会冒出滚动条，宽度变化又触发链重算（左右晃动） */}
          <div className="overflow-x-auto overflow-y-clip pb-1">
            <div
              className="min-w-full"
              style={{
                minWidth: `calc(${cfg.steps.length} * 9rem + ${cfg.steps.length - 1} * 0.5rem)`,
              }}
            >
              {/* 名称带：居中截断（悬浮全称）；⋯ 步骤菜单 hover/聚焦才现 */}
              <ol
                className="grid gap-[5px]"
                style={{
                  gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
                }}
              >
                {cfg.steps.map((step, i) => (
                  <li key={`${i}-${step.name}`} className="group relative min-w-0">
                    <div className="relative flex h-7 items-center px-7">
                      <span
                        className="min-w-0 flex-1 truncate text-center text-xs text-l2"
                        title={step.name}
                      >
                        {step.name}
                      </span>
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
                        className={`absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-xs text-l3 hover:bg-white/5 hover:text-l1 ${hoverRevealClass}`}
                      >
                        ⋯
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              {/* 步进器带：StepperCell 真实块节律线（5px 块 + 5px 间隙，跨列连续）；与名称带同列同隙 */}
              <div>
                <ol
                  className="grid gap-[5px]"
                  style={{
                    gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
                  }}
                >
                  {cfg.steps.map((step, i) => {
                    const st = deriveStepStatus(step, workspaces, health, drift);
                    const statusLabel =
                      st.key === "pending" && st.ws
                        ? "已归档"
                        : STEP_STATUS_LABEL[st.key];
                    const activeWs =
                      st.ws && st.ws.status === "active" ? st.ws : undefined;
                    const last = activeWs
                      ? wsLastConfig(activeWs.worktreePath)
                      : {};
                    const lastProfile = last.profileId
                      ? profiles.find((p) => p.id === last.profileId)
                      : undefined;
                    // 状态/目录/agent + 点击动作提示并入悬浮全文（白话双层），圆上只留状态色
                    const circleTitle = [
                      `${step.name} · ${statusLabel}`,
                      activeWs
                        ? `目录：${activeWs.worktreePath}`
                        : st.ws
                          ? "工作区已归档"
                          : "工作区尚未创建",
                      last.agentId
                        ? `Agent：${last.agentId}${lastProfile ? ` / ${lastProfile.name}` : ""}`
                        : null,
                      st.key === "pending"
                        ? st.ws
                          ? "点击恢复工作区"
                          : "点击开始该步骤"
                        : st.key === "done"
                          ? "点击打开主文件夹终端"
                          : "点击打开该工作区终端",
                    ]
                      .filter(Boolean)
                      .join("\n");
                    // 待开始且缺工作区名时禁止开步（原「开始」按钮的 disabled 口径）
                    const circleDisabled =
                      st.key === "pending" &&
                      !st.ws &&
                      (starting === i || !step.workspaceName);
                    // 圆后小方块（产物）：无绑定工作区时禁用；root 口径同任务行——已合并读项目根，其余读工作树
                    const artifactsDisabled = !st.ws;
                    return (
                      <StepperCell
                        key={`${i}-${step.name}`}
                        circleClass={stepCircleClass(st.key)}
                        circleTitle={
                          circleDisabled && !step.workspaceName
                            ? "该步骤未配置工作区名，请在「编辑流水线」中补充"
                            : circleTitle
                        }
                        circleLabel={`${step.name}：${statusLabel}`}
                        circleDisabled={circleDisabled}
                        pulsing={starting === i}
                        onCircleClick={() => onCircleClick(i, st)}
                        briefTitle="编辑简报"
                        briefLabel={`编辑简报：${step.name}`}
                        onBriefClick={() => openEditor(i)}
                        artifactsTitle={
                          artifactsDisabled
                            ? "工作区尚未创建，暂无产物可核验"
                            : artifactsStep === i
                              ? "收起产物核验"
                              : "查看该步骤的预期产物"
                        }
                        artifactsLabel={`产物核验：${step.name}`}
                        artifactsDisabled={artifactsDisabled}
                        artifactsExpanded={artifactsStep === i}
                        onArtifactsClick={() =>
                          setArtifactsStep((v) => (v === i ? null : i))
                        }
                      />
                    );
                  })}
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 圆后小方块（产物）手风琴：strip 下方就地展开（单开）；root 口径同任务行——已合并读项目根，其余读工作树 */}
      {artStep && artWs && (
        <div className="mb-3">
          <ArtifactChecklist
            projectPath={projectPath}
            workspaceName={artStep.workspaceName}
            root={artMerged ? repoPath : artWs.worktreePath}
            rootLabel={artMerged ? "主文件夹（已合并）" : "工作区"}
          />
        </div>
      )}

      {/* 模板库选择器：项目菜单与空流水线「选择流水线模板」共用的唯一实例 */}
      {registered && cfg && pickerOpen && (
        <div className="mb-2 rounded-md bg-strip p-2">
          <TemplatePicker
            applying={applyingTemplate}
            onApply={(item) => void applyTemplate(item)}
            onError={onError}
          />
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
            <div className="mt-1 rounded-md bg-strip p-2">
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
                        className="min-w-0 truncate text-xs text-l2"
                        title={r.note ? `${r.name}\n${r.note}` : r.name}
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
                              <span className="flex min-w-0 items-center gap-1.5 text-xs text-l4">
                                <span className="shrink-0 text-ok-text">✓</span>
                                <span className="min-w-0 truncate font-mono" title={d.path}>
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
                                    <span
                                      className="min-w-0 truncate font-mono text-l2"
                                      title={d.path}
                                    >
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
      </div>

      {projectMenu && project && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          alignRight
          onClose={() => setProjectMenu(null)}
          items={[
            {
              label: "编辑流水线",
              disabled: !cfg,
              title: cfg
                ? "编辑步骤名称、简报、预期产物和脚本"
                : "project.toml 尚未加载完成",
              onSelect: () => openEditor(),
            },
            {
              label: pickerOpen ? "收起模板库" : "更换模板",
              disabled: !cfg,
              title: cfg
                ? "打开模板库另选一个模板；写入时现有步骤被替换，绑定的工作区与资源不受影响"
                : "project.toml 尚未加载完成",
              onSelect: () => setPickerOpen((v) => !v),
            },
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
              label: "历史",
              title: "项目的白话保存时间线（只读）",
              onSelect: () => setHistoryOpen(true),
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
      {editorOpen && project && cfg && (
        <PipelineEditor
          projectName={displayName}
          config={cfg}
          warnings={cfgWarnings}
          saving={pipelineSaving}
          focusStep={editorFocus}
          onSave={(steps) => void savePipeline(steps)}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {historyOpen && project && (
        <HistoryOverlay
          projectName={displayName}
          repoPath={project.path}
          wsSteps={wsStepMap}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </section>
  );
}
