import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import PipelineEditor from "./PipelineEditor";
import HistoryOverlay from "./HistoryOverlay";
import TemplatePicker, { type TemplatePickItem } from "./TemplatePicker";
import ArtifactChecklist, {
  absoluteResourcePath,
  formatSize,
} from "./ArtifactChecklist";
import TaskCardsSection from "./TaskCardsSection";
import KickoffConfirmDialog from "./KickoffConfirmDialog";
import { Checkbox, hoverRevealClass } from "./PageFrame";
import { useAppStore } from "../store";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import { startPipelineStep, type TaskBriefRef } from "../pipeline-start";
import { normSep } from "../path-utils";
import type { RunOverviewInput } from "../run-overview";
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
/** 步进器带级整条虚线链：真实 6×6px 方块按 12px 等距（6px 块 + 6px 间隙）铺满整个带宽。
 *  块位以圆心为锚分段计算（圆是列中心，列等宽，段长相等）——每个圆两侧的断口、
 *  每个步骤之间的块数与间隙严格一致（按全局相位铺排时圆会随机截断方块，用户反馈不规则）。
 *  段内余数（<12px）：步骤间段落对称均分、首段沉到最左端、尾段沉到末圆旁——
 *  末端方块贴齐链尾，菱形前保持 6px 标准间隙（余数若沉菱形前，该间隙最大 17px，用户反馈过远）。
 *  完成列区间内的块亮灰白（l2）、其余暗（hairline），300ms 颜色过渡 */
const NODE_HALF = 17; // 圆遮罩半宽：22px 视觉圆（半径 11）+ 6px 语义空档——与块间间隙精确相等
function StepperChain({
  dones,
  children,
}: {
  dones: boolean[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const nSteps = dones.length;
  const blocks: { left: number; done: boolean }[] = [];
  if (width > 0 && nSteps > 0) {
    // 与下方 grid 完全相同的列几何：列间隙 6px，列 i 圆心 = i*(列宽+6) + 列宽/2
    const colW = (width - 6 * (nSteps - 1)) / nSteps;
    const center = (i: number) => i * (colW + 6) + colW / 2;
    for (let seg = 0; seg <= nSteps; seg++) {
      const start = seg === 0 ? 0 : center(seg - 1) + NODE_HALF;
      const end = seg === nSteps ? width : center(seg) - NODE_HALF;
      const len = end - start;
      const m = Math.max(0, Math.floor((len + 6) / 12));
      if (m === 0) continue;
      // 段内余数：首段贴圆（余数落左带缘）、尾段贴菱形（余数落末圆旁，末端方块贴齐链尾），
      // 中间段对称均分——中间段布局完全相同
      const extra = len - (12 * m - 6);
      const offset =
        seg === 0 || seg === nSteps ? extra : Math.floor(extra / 2);
      for (let b = 0; b < m; b++) {
        const left = start + offset + b * 12;
        const xCenter = left + 3;
        const col = Math.min(
          nSteps - 1,
          Math.max(0, Math.floor(xCenter / (colW + 6))),
        );
        blocks.push({ left, done: dones[col] });
      }
    }
  }
  return (
    <div ref={ref} className="relative min-w-0 flex-1 self-stretch">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {blocks.map((b, i) => (
          <span
            key={i}
            className={`absolute top-1/2 block h-1.5 w-1.5 -translate-y-1/2 rounded-[1px] transition-colors duration-300 ${
              b.done ? "bg-l2" : "bg-hairline"
            }`}
            style={{ left: b.left }}
          />
        ))}
      </div>
      {children}
    </div>
  );
}

/** 步进器悬浮提示（应用内 tooltip）：fixed 定位不随滚动容器走，滚动/缩放即关。
 *  WKWebView 的原生 title 悬浮有平台差异（不渲染或移开后残留数秒），圆的悬浮统一走这里；
 *  事件一律挂在包裹 span 上，禁用按钮也能悬浮查看。 */
function useHoverTip(ref: React.RefObject<HTMLElement | null>) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip]);
  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 横向钳制在窗口内（tooltip max-w-72 半宽 144 + 边距）
    const x = Math.min(
      Math.max(r.left + r.width / 2, 150),
      window.innerWidth - 150,
    );
    setTip({ x, y: r.bottom + 8 });
  };
  return { tip, show, hide: () => setTip(null) };
}

function HoverTip({
  tip,
  text,
  warn,
}: {
  tip: { x: number; y: number } | null;
  text: string;
  /** 警告色小字行（如上游漂移提醒），附加在正文之后 */
  warn?: string | null;
}) {
  if (!tip) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-72 -translate-x-1/2 whitespace-pre-line rounded-md border border-hairline bg-raised px-2.5 py-1.5 text-left text-xs leading-5 text-l2"
      style={{ left: tip.x, top: tip.y }}
    >
      {text}
      {warn && <div className="text-warn-text">{warn}</div>}
    </div>
  );
}

/** 步进器单元格：只剩大圆节点（虚线链由 StepperChain 在带级统一铺满）。
 *  圆的包裹 span 带 strip 底色 + 两侧 6px 内边距形成遮罩，链条在圆处整齐断开。
 *  大圆的悬浮信息走应用内 tooltip（useHoverTip，fixed 定位、滚动即关、点击即关）：
 *  原生 title 在 WKWebView 上行为不稳定（不渲染或移开后残留数秒串到相邻控件），
 *  状态/目录/agent/点击动作提示必须可见，且禁用按钮也能触发（事件挂在包裹 span 上）。 */
function StepperCell({
  circleClass,
  circleTitle,
  circleWarn,
  circleLabel,
  circleDisabled,
  pulsing,
  attention,
  onCircleClick,
}: {
  circleClass: string;
  circleTitle: string;
  /** 悬浮卡内的警告色小字行（上游漂移提醒等），null/缺省不显示 */
  circleWarn?: string | null;
  circleLabel: string;
  circleDisabled: boolean;
  pulsing: boolean;
  /** 终端注意力点：confirm=待确认（warn 点）；null/缺省不显示 */
  attention?: "confirm" | "done" | null;
  onCircleClick: () => void;
}) {
  const circleRef = useRef<HTMLButtonElement>(null);
  const { tip, show: showTip, hide: hideTip } = useHoverTip(circleRef);
  // 进行中/checking 的圆加 cta 外环锁定焦点
  const active = circleClass.split(" ").includes("bg-cta");
  return (
    <li className="flex min-w-0 items-center justify-center">
      <span
        className="relative shrink-0 bg-strip px-[3px]"
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
      >
        <button
          ref={circleRef}
          type="button"
          disabled={circleDisabled}
          aria-label={circleLabel}
          className="group/circle flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed"
          onClick={() => {
            // 点击即关 tooltip：跳转终端/开覆盖层后不留残留悬浮
            hideTip();
            onCircleClick();
          }}
        >
          {/* 视觉圆 22px，按钮保持 28px 热区 */}
          <span
            className={`block h-[22px] w-[22px] rounded-full transition-[filter,color,background-color] duration-300 group-hover/circle:brightness-110 ${circleClass} ${
              active || pulsing ? "animate-pulse-brief" : ""
            } ${active ? "ring-2 ring-cta/50" : ""}`}
          />
        </button>
        {attention === "confirm" && (
          <span
            className="pointer-events-none absolute right-0 top-0 size-2 rounded-full bg-warn"
          />
        )}
        <HoverTip tip={tip} text={circleTitle} warn={circleWarn} />
      </span>
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

/** 步骤的终端注意力（步进器大圆角标）：cwd 落在工作区内的运行标签，confirm（待确认）优先于 done（已完成） */
function stepAttention(
  ws: WorkspaceDto | undefined,
  inputs: RunOverviewInput[],
): "confirm" | "done" | null {
  if (!ws) return null;
  const root = normSep(ws.worktreePath).replace(/\/+$/, "");
  let found: "confirm" | "done" | null = null;
  for (const input of inputs) {
    const cwd = normSep(input.cwd).replace(/\/+$/, "");
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (input.attention === "confirm") return "confirm";
    if (input.attention === "done") found = "done";
  }
  return found;
}

/** 步骤状态：从绑定工作区（steps[].workspaceName 匹配工作区名）的 health/drift 派生，纯展示无双状态机 */
type StepStatusKey =
  | "pending"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "checking";

/** 状态文字只进悬浮 tooltip（白话双层），圆上不再直接显示 */
const STEP_STATUS_LABEL: Record<StepStatusKey, string> = {
  pending: "待开始",
  active: "进行中",
  review: "待评审",
  blocked: "阻塞",
  done: "已完成",
  checking: "检查中",
};

/** 大圆步进器的圆填色：纯实心无字符，状态只靠颜色区分；进行中/检查中的脉冲用
 *  有界的 animate-pulse-brief（App.css，3 个周期后静止），不用无限 animate-pulse */
function stepCircleClass(key: StepStatusKey): string {
  // done 用随主题走的低饱和完成绿（--color-done），与状态 ok 绿解耦（用户反馈亮绿突兀）
  if (key === "done") return "bg-done";
  if (key === "blocked") return "bg-warn";
  if (key === "review") return "bg-cta-pill";
  if (key === "active" || key === "checking") return "bg-cta";
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

  // 主仓脏检查：进项目详情读一次 + 页面刷新时重读，不轮询（开工弹层打开时会再刷新一次）
  useEffect(() => {
    if (!project) {
      setMainDirty(null);
      return;
    }
    let stale = false;
    invoke<{ isRepo: boolean; files: unknown[] }>("git_status", {
      cwd: project.path,
    })
      .then((status) => {
        if (!stale) setMainDirty(status.isRepo ? status.files.length : null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [project, refreshToken]);

  /** 全量写回 resources/steps（后端保留未知键）；失败只报错不回滚本地状态 */  async function saveConfig(next: ProjectConfigDto): Promise<boolean> {
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
      !(await confirmDialog(
        `只移除「${project.name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      ))
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
  // 开工确认弹层（v3.64）：步进器大圆与卡片「开工」的唯一开工入口
  const [kickoff, setKickoff] = useState<{
    index: number;
    originCardId: string | null;
  } | null>(null);
  // 主仓未提交改动数（null = 非 git 仓库/读取失败）：卡片区提醒行用，进项目详情读一次不轮询
  const [mainDirty, setMainDirty] = useState<number | null>(null);
  const [stepMenu, setStepMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  // 流水线编辑器（RX1）：步骤编辑唯一入口，覆盖旧 ⋯ 内联重命名/编辑简报/+ 步骤表单
  const [editorOpen, setEditorOpen] = useState(false);
  // 步骤 ⋯「编辑步骤」：打开编辑器并定位到该步骤卡片（null = 从项目菜单进入，不定位）
  const [editorFocus, setEditorFocus] = useState<number | null>(null);
  // 步骤 ⋯「产物核验」手风琴：strip 下方就地展开 ArtifactChecklist，记展开的步骤 index（单开）
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

  /** 一键开步（§11.3 机制三）：invoke 链路在 pipeline-start.ts 与评审「开始下一步」共用，此处只管组件态。
   *  v3.64 起「开工」为两步：先开 KickoffConfirmDialog（TASK.md 预览 + 简报来源勾选 + 融合），
   *  确认后本函数才执行建工作区链路；briefs = 弹层确认（或融合定稿）的简报引用 */
  async function runStartStep(
    index: number,
    briefs?: TaskBriefRef[],
    taskMdOverride?: string,
  ) {
    if (!project || !cfg) return;
    const step = cfg.steps[index];
    setStarting(index);
    try {
      await startPipelineStep({
        projectPath: project.path,
        step,
        cfg,
        briefs,
        taskMdOverride,
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

  /** 「开工」第一步：打开确认弹层（originCardId = 卡片开工的出处卡；步进器大圆为 null） */
  function startStep(index: number, originCardId: string | null = null) {
    if (!project || !cfg) return;
    setKickoff({ index, originCardId });
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
      !(await confirmDialog(
        `更换模板「${item.name}」？现有 ${cfg.steps.length} 个步骤会被替换，绑定的工作区与资源不受影响。继续？`,
        { danger: true },
      ))
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
        !(await confirmDialog(`已存在同名模板「${name}」，保存将覆盖。继续？`, {
          danger: true,
        }))
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
      !(await confirmDialog(`删除步骤「${step.name}」？绑定的工作区不受影响。继续？`, {
        danger: true,
      }))
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
        label: "编辑步骤",
        title: "打开流水线编辑器并定位到该步骤",
        onSelect: () => openEditor(index),
      },
      {
        label: artifactsStep === index ? "收起产物核验" : "产物核验",
        disabled: !st.ws,
        title: !st.ws
          ? "工作区尚未创建，暂无产物可核验"
          : "查看该步骤的预期产物",
        onSelect: () =>
          setArtifactsStep((v) => (v === index ? null : index)),
      },
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
  // 步进器大圆的注意力点：终端运行状态镜像（TerminalPage 唯一写入方，只读消费）
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
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
  // 产物核验手风琴展开项（单开）：无绑定工作区不渲染（菜单项本身已禁用，此处兜底）
  const artStep =
    cfg && artifactsStep !== null ? (cfg.steps[artifactsStep] ?? null) : null;
  const artSt = artStep
    ? deriveStepStatus(artStep, workspaces, health, drift)
    : null;
  const artWs = artSt?.ws;
  const artMerged = artSt?.key === "done";
  // 每步完成态（带级虚线链按列区间着色）+ 末端菱形：全部步骤完成才点亮（与完成圆同一 done 绿）
  const stepDoneFlags =
    cfg?.steps.map(
      (s) => deriveStepStatus(s, workspaces, health, drift).key === "done",
    ) ?? [];
  const allStepsDone =
    stepDoneFlags.length > 0 && stepDoneFlags.every(Boolean);
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
            {/* 进行中/待评审是纯状态（不阻塞决策），用灰点；只有「阻塞」够格用语义色 */}
            {groupCounts.active > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-l4" />
                {groupCounts.active} 进行中
              </span>
            )}
            {groupCounts.review > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-l4" />
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
          大圆 = 状态色 + 主推进点击；编辑步骤/产物核验收进步骤 ⋯ 菜单（原圆前/圆后小方块
          伪装成虚线块可发现性为零，入口删除、视觉块保留为普通虚线块）；末端菱形 = 流水线终点，
          全部步骤完成后点亮（与完成圆同一 done 绿）。
          结构 = 名称带 + 步进器带两个同列网格；虚线链由 StepperChain 在带级一次铺满
          （块位以圆心为锚分段等距计算，跨列无边界、各圆两侧断口一致），圆以 strip 底色遮罩压在链上 */}
      {registered && cfg && cfg.steps.length > 0 && (
        <div className="mb-3 rounded-md bg-strip px-3 py-2.5">
          {/* 等分列网格：列宽下限 9rem 让更多步骤在常规窗口内完整可见；
              窗口过窄放不下全部步骤时保持整体横向滚动（不换行，虚线与各列大圆同轴） */}
          {/* 横向滚动容器必须显式 overflow-y-clip：overflow-x:auto 会把 y 轴也算成 auto，
              圆的 28px 热区/tooltip 溢出纵向就会冒出滚动条，宽度变化又触发链重算（左右晃动） */}
          <div className="overflow-x-auto overflow-y-clip pb-1">
            <div
              className="min-w-full"
              style={{
                minWidth: `calc(${cfg.steps.length} * 9rem + ${cfg.steps.length - 1} * 0.375rem + 20px)`,
              }}
            >
              {/* 名称带：居中截断（悬浮全称）；⋯ 步骤菜单 hover/聚焦才现。
                  末尾占位与步进器带的终点菱形同宽（10px），两条带的列严格对齐 */}
              <div className="flex items-center gap-1.5">
                <ol
                  className="grid min-w-0 flex-1 gap-1.5"
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
                <span className="w-3.5 shrink-0" aria-hidden />
              </div>
              {/* 步进器带：StepperChain 在带级把虚线链一次铺满（6px 块 + 6px 间隙，跨列连续无边界），
                  圆用 strip 底色遮罩压在链上；与名称带同列同隙。
                  末端菱形 = 流水线终点符号（装饰，无点击），全部步骤完成后点亮 */}
              <div className="flex items-center gap-1.5">
                <StepperChain dones={stepDoneFlags}>
                  <ol
                    className="relative grid gap-1.5"
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
                    // 注意力角标：cwd 落在工作区内的终端标签有待确认/已完成时上点（confirm 优先）
                    const attention = stepAttention(activeWs, terminalRunInputs);
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
                      attention === "confirm" ? "终端：待你确认" : null,
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
                    return (
                      <StepperCell
                        key={`${i}-${step.name}`}
                        circleClass={stepCircleClass(st.key)}
                        circleTitle={
                          circleDisabled && !step.workspaceName
                            ? "该步骤未配置工作区名，请在「编辑流水线」中补充"
                            : circleTitle
                        }
                        circleWarn={
                          st.ws?.staleUpstream
                            ? `上游「${st.ws.staleUpstream}」有更新，产物可能过期`
                            : null
                        }
                        circleLabel={`${step.name}：${statusLabel}`}
                        circleDisabled={circleDisabled}
                        pulsing={starting === i}
                        attention={attention}
                        onCircleClick={() => onCircleClick(i, st)}
                      />
                    );
                  })}
                  </ol>
                </StepperChain>
                <span
                  className="flex h-7 w-3.5 shrink-0 items-center justify-center"
                  role="img"
                  aria-label={
                    allStepsDone ? "流水线终点：全部步骤已完成" : "流水线终点"
                  }
                >
                  {/* 实心菱形终点（9px 旋转 45°），与虚线块同轴、同 6px 间隙接上链条；
                      明暗跟随完成态：未完成与未完成链条同暗（hairline），全部完成点亮 done 绿 */}
                  <span
                    aria-hidden
                    className={`block size-[9px] rotate-45 rounded-[1px] transition-colors duration-300 ${
                      allStepsDone ? "bg-done" : "bg-hairline"
                    }`}
                  />
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 产物核验手风琴（步骤 ⋯ 菜单触发）：strip 下方就地展开（单开）；root 口径同任务行——已合并读项目根，其余读工作树 */}
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

      {/* 任务卡区（流水线步进器下方）：对话的文件夹 + 定稿简报收集夹；无独立状态机，不碰工作区/评审流程 */}
      {registered && cfg && (
        <TaskCardsSection
          projectPath={projectPath}
          steps={cfg.steps}
          cfg={cfg}
          workspaces={workspaces}
          refreshToken={refreshToken}
          mainDirty={mainDirty}
          onStartStep={(index, originCardId) => startStep(index, originCardId)}
        />
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
      {/* 开工确认弹层：确认后才走建工作区链路（runStartStep） */}
      {kickoff && project && cfg && cfg.steps[kickoff.index] && (
        <KickoffConfirmDialog
          projectPath={project.path}
          step={cfg.steps[kickoff.index]}
          cfg={cfg}
          originCardId={kickoff.originCardId}
          busy={starting !== null}
          onCancel={() => setKickoff(null)}
          onConfirm={(briefs, taskMd) => {
            const index = kickoff.index;
            setKickoff(null);
            void runStartStep(index, briefs, taskMd);
          }}
        />
      )}
    </section>
  );
}
