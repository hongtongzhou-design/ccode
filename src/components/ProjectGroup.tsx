import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
import ScheduleSection from "./ScheduleSection";
import KickoffConfirmDialog from "./KickoffConfirmDialog";
import { Checkbox, hoverRevealClass, NoticeBar } from "./PageFrame";
import { useAppStore } from "../store";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import { startPipelineStep } from "../pipeline-start";
import { normSep } from "../path-utils";
import type { RunOverviewInput } from "../run-overview";
import type {
  DiscoveredResourceDto,
  ZoteroLibraryDto,
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
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1";
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
      className="pointer-events-none fixed z-50 max-w-72 -translate-x-1/2 whitespace-pre-line rounded-md border border-hairline ccode-float-surface px-2.5 py-1.5 text-left text-xs leading-5 text-l2"
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
  selected,
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
  /** 聚焦选中（v3.70：点圆 = 下方只看这一步）：中性高亮环 */
  selected?: boolean;
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
            // 点击即关 tooltip：聚焦后不留残留悬浮
            hideTip();
            onCircleClick();
          }}
        >
          {/* 视觉圆 22px，按钮保持 28px 热区 */}
          <span
            className={`block h-[22px] w-[22px] rounded-full transition-[filter,color,background-color] duration-300 group-hover/circle:brightness-110 ${circleClass} ${
              active || pulsing ? "animate-pulse-brief" : ""
            } ${active ? "ring-2 ring-cta/50" : ""} ${selected ? "ring-2 ring-l1/70" : ""}`}
          />
        </button>
        {attention === "confirm" && (
          <span
            className="pointer-events-none absolute right-0 top-0 size-2 rounded-full bg-warn-text"
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
  // 阻塞用 warn 的「文字/圆点」档而非底色档：底色档在浅色主题是浅黄（#fdf1cd），
  // 铺成 22px 实心圆会在近白 canvas 上消失；且同为实心圆的 done 本就用 -text 档口径
  if (key === "blocked") return "bg-warn-text";
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
 * 工作区页的项目分组（§11.4 P1b）：分组头 + 研究流程 strip + 资源面板。
 * 工作区行列表由 WorkspacesPage 作为 children（render prop）传入：本组件把聚焦步骤名
 * 与步骤表回传给父级，工作区列表按聚焦步骤过滤（归属口径 = steps[].workspaceName === 工作区名）。
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
  /** 工作区列表渲染（render prop）：回传聚焦视图上下文，父级按步骤过滤列表 */
  children: (wsView: {
    /** 聚焦步骤名（null = 项目无研究步骤：显示项目全量工作区） */
    focusStepName: string | null;
    /** 项目步骤表（归属判定用；未注册/未加载 = 空表） */
    steps: ProjectStepDto[];
  }) => ReactNode;
}) {
  const registered = project !== null;
  const projectPath = project?.path ?? repoPath;
  const displayName = project?.name ?? repoName;

  // ===== 档案卡（仅注册项目） =====
  const [cfg, setCfg] = useState<ProjectConfigDto | null>(null);
  const [cfgWarnings, setCfgWarnings] = useState<string[]>([]);
  /** 从磁盘重读档案卡并同步本地状态：档案卡的唯一读入口。
   *  原先四处各写一遍「read → setCfg + setCfgWarnings」，漏掉 warnings 的那处会让
   *  ⚠ 徽标停在上一次的结果；收成一个函数后本地与磁盘只有这一条同步路径。
   *  后端保证不 reject（坏配置回落空配置 + warnings），失败时保留现有本地配置。 */
  async function reloadCfg(path: string): Promise<ProjectConfigDto | null> {
    try {
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path,
      });
      setCfg(read.config);
      setCfgWarnings(read.warnings);
      return read.config;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (!project) {
      setCfg(null);
      return;
    }
    let stale = false;
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

  // ===== 研究流程 strip =====
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
  // 研究流程编辑器（RX1）：步骤编辑唯一入口，覆盖旧 ⋯ 内联重命名/编辑简报/+ 步骤表单
  const [editorOpen, setEditorOpen] = useState(false);
  // 步骤 ⋯「编辑步骤」：打开编辑器并定位到该步骤卡片（null = 从项目菜单进入，不定位）
  const [editorFocus, setEditorFocus] = useState<number | null>(null);
  // 步骤 ⋯「产物核验」手风琴：strip 下方就地展开 ArtifactChecklist，记展开的步骤 index（单开）
  const [artifactsStep, setArtifactsStep] = useState<number | null>(null);
  // 步骤聚焦（v3.70）：null = 跟随当前步骤（第一个未完成，全部完成则落最后一步）；其余 = 指定步骤。
  // 大圆点击与卡片区头部 ‹ › 箭头设置；卡片区恒为单步骤聚焦视图（v3.81 起无总览态）
  /** 聚焦步骤名（存名字而非索引）：索引在流水线编辑器里重排/改名后会指向另一个步骤，
   *  而下游全部按名字找回。名字对不上时 focusIndex 回落到当前步骤，不静默跳错 */
  const [focusStepKey, setFocusStepKey] = useState<string | null>(null);
  // 人工事项派生状态原本只喂步骤 ⋯ 菜单的「N 件待做」计数，该菜单项已随 v3.86 精简删除
  // （清单本体在 useHumanTasks 里自取自刷），这里连同 list_human_task_states 一次调用一并去掉
  // 聚焦步骤的任务书草稿（v3.72）：聚焦头部「待开始」情境文案（describeStep）与卡片区流程线
  // 共用这一份加载（TaskCardsSection 经 focusDraft prop 接收，不重复请求）；effect 在 focusStepName 之后
  const [focusDraft, setFocusDraft] = useState<{
    stepName: string;
    relPath: string;
    text: string | null;
  } | null>(null);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  // 「使用研究流程模板」旁的可选课题主题输入，随模板一并落进 project.toml；
  // 与「添加项目」弹窗的课题主题是同一字段：回显既有值（templateTopic 为空才回填，不盖用户输入）
  const [templateTopic, setTemplateTopic] = useState("");
  // 应用模板成功的一次性引导条（组件态，切项目自然消失；不持久化——应用模板不是高频动作）
  const [tplApplied, setTplApplied] = useState(false);
  useEffect(() => {
    if (cfg?.topic?.trim()) {
      setTemplateTopic((cur) => (cur.trim() ? cur : cfg.topic!.trim()));
    }
  }, [cfg]);
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
   *  v3.64 起「开工」为两步：先开 KickoffConfirmDialog（TASK.md 预览编辑，任务书草稿优先），
   *  确认后本函数才执行建工作区链路；taskMdOverride = 弹层编辑区的最终内容 */
  async function runStartStep(
    index: number,
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

  /** 按索引聚焦（大圆 / 步骤 ⋯ 菜单 / 卡片区 ‹ › 箭头共用）：落库存的是步骤名 */
  function focusByIndex(index: number) {
    const name = cfg?.steps[index]?.name;
    if (name) setFocusStepKey(name);
  }

  /** 大圆点击 = 步骤聚焦（v3.70，用户拍板：圆的终端入口语义删除——跳终端/开步/恢复分别由
   *  流程线节点、卡片行、任务行承担）：点圆 = 下方卡片区只看这一步（种子/卡片/人工事项）；
   *  与卡片区头部 ‹ › 箭头同一切换口径 */
  function onCircleClick(index: number) {
    focusByIndex(index);
  }

  async function applyTemplate(item: TemplatePickItem) {
    if (!cfg) return;
    // 空流程（含「不使用研究流程」后从 ⋯ 菜单回流）：走追加——后端顺带清 pipeline_opt_out
    if (cfg.steps.length === 0) {
      setApplyingTemplate(true);
      try {
        await invoke("append_pipeline_steps", {
          projectRoot: projectPath,
          steps: item.steps,
        });
        // 与编辑器「＋ 从模板追加」同一口径：重读配置刷新本地状态（含清掉的 opt-out 标记）
        const fresh = await reloadCfg(projectPath);
        // 首启横幅里的可选课题主题：append 不碰 topic，变了才单独写回
        const topic = templateTopic.trim();
        if (fresh && topic && topic !== (fresh.topic ?? "")) {
          await saveConfig({ ...fresh, topic });
        }
        setPickerOpen(false);
        // 模板选完就该看到步进器，别把抽屉留在前面挡着
        setSettingsOpen(false);
        // 顺序引导（一次性提示条，可关）：把视线引到第 1 步与种子
        setTplApplied(true);
      } catch (reason) {
        onError(String(reason));
      } finally {
        setApplyingTemplate(false);
      }
      return;
    }
    // 已有步骤时视为「更换模板」：提示覆盖，绑定的工作区与资源不受影响
    if (
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
    if (ok) {
      setPickerOpen(false);
      setSettingsOpen(false);
      // 顺序引导（一次性提示条，可关）：把视线引到第 1 步与种子
      setTplApplied(true);
    }
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
        await reloadCfg(project.path);
      } catch {
        /* 重读失败保留刚写入的本地配置 */
      }
      setEditorOpen(false);
    }
    setPipelineSaving(false);
  }

  /**
   * 步骤 ⋯ 菜单（v3.86 精简 6 → 1~3）。删掉的三项与理由：
   * - **人工事项**：`onSelect` 就是 `focusByIndex`，与「点大圆 = 只看这一步」完全同效；
   *   清单本身在聚焦后的当前步骤卡流程线里直接可见。标签上的「N 件待做」是 v3.84
   *   已删的「等你做」计数的最后残留，同一噪音不再从菜单里冒出来。
   * - **复制工作区名**：近乎零频次；工作区名在「编辑步骤 → 高级」里可见，
   *   任务行 ⋯ 另有更有用的「复制工作树路径」。
   * - **删除步骤**：结构性编辑，按约定归编辑器（每张步骤卡自带删除），
   *   且不该把破坏性动作放在悬停即出的菜单里紧挨着步进器大圆。
   * 余下两项**不再渲染禁用态**：没有工作区时「产物核验 / 定位目录」本就无事可做，
   * 灰着占位只是噪音（原菜单 6 项里有 2 项常年是灰的）。
   */
  function stepMenuItems(index: number) {
    if (!cfg) return [];
    // 「◫ 定位目录」与胶囊原 ◫ 按钮同一语义：仅活跃工作区可定位
    const st = statusAt(index)!;
    const activeWs =
      st.ws && st.ws.status === "active" ? st.ws : undefined;
    return [
      {
        label: "编辑步骤",
        title: "打开研究流程编辑器并定位到该步骤",
        onSelect: () => openEditor(index),
      },
      ...(st.ws
        ? [
            {
              label: artifactsStep === index ? "收起产物核验" : "产物核验",
              title: "查看该步骤的预期产物",
              onSelect: () =>
                setArtifactsStep((v) => (v === index ? null : index)),
            },
          ]
        : []),
      ...(activeWs
        ? [
            {
              label: "◫ 定位目录",
              title: "跳到终端页，文件树定位到该工作区目录",
              onSelect: () => {
                setEnterCwdReq(activeWs.worktreePath);
                setPage("terminal");
              },
            },
          ]
        : []),
    ];
  }

  // ===== 资源面板 =====
  // 资源面板展开态：新注册的项目默认展开——注册时自动扫过一遍，
  // 不展开的话用户既不知道扫到了什么，也看不到还能从哪儿补
  const [resOpen, setResOpen] = useState(freshGitGuide);
  // 「项目设置」抽屉（v3.85）：项目级低频配置的单一落点。原先资源面板与定时任务
  // 各占详情页一条常驻带，配置项还散在 ⋯ 菜单八项里；收进抽屉后详情页少两条带、
  // ⋯ 菜单收到四项，项目级配置也终于有了一个能一眼看全的地方。
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 全局设定编辑（抽屉内）：textarea 一行一条，失焦即存
  const [globalsDraft, setGlobalsDraft] = useState("");
  useEffect(() => {
    setGlobalsDraft((cfg?.settings ?? []).join("\n"));
  }, [cfg?.settings]);
  /** 失焦即存：静默保存等于「我改了但不知道存没存」（用户实测反馈），
   *  故给一次性「已保存」反馈（2s 自动消退）；失败走 onError 横幅 */
  const [globalsSaved, setGlobalsSaved] = useState(false);
  async function saveGlobals() {
    if (!cfg) return;
    const next = globalsDraft
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (next.join("\n") === (cfg.settings ?? []).join("\n")) return;
    if (await saveConfig({ ...cfg, settings: next })) {
      setGlobalsSaved(true);
      window.setTimeout(() => setGlobalsSaved(false), 2000);
    }
  }
  // 「文献与数据」落点聚焦：从流程线按所选来源跳过来时高亮对应进料入口，2.5s 后自动消退。
  // 落点统一是这一处面板（导入只此一处），高亮解决「到了之后点哪个」
  const [resFocus, setResFocus] = useState<"zotero" | "files" | null>(null);
  /** 「文献与数据」面板锚点：流程线里的「到「文献与数据」导入」展开后滚到这里 */
  const resPanelRef = useRef<HTMLDivElement>(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  // Zotero 进料口（只读适配器；不做文献库，见 zotero.rs 头注）：探测 → 选分类 → 导入
  const [zoteroBusy, setZoteroBusy] = useState(false);
  const [zoteroLib, setZoteroLib] = useState<ZoteroLibraryDto | null>(null);
  /** 手动指定过的 Zotero 数据目录（自定义目录的用户不必每次重选） */
  const [zoteroDir, setZoteroDir] = useState<string | null>(null);
  const [zoteroMsg, setZoteroMsg] = useState<string | null>(null);
  const [litBusy, setLitBusy] = useState(false);

  /** 切换文献来源：只改 project.toml 的 lit_source，不动任何文件。
   *  v3.86 起改为**显式三值**（search / zotero / folder）——原先是两档开关，
   *  「我已有文献库」无法表达 zotero 与 folder 的区别，才需要「已是 zotero 就不降级」的特判；
   *  流程线「输入准备」三个选项一一对应后，特判不再需要，选什么就是什么。 */
  async function setLitSource(next: string) {
    if (!cfg || litBusy) return;
    const target = ["search", "zotero", "folder"].includes(next)
      ? next
      : "search";
    if (target === (cfg.litSource?.trim() || "search")) return;
    setLitBusy(true);
    try {
      await saveConfig({ ...cfg, litSource: target });
    } finally {
      setLitBusy(false);
    }
  }

  /** 打开 Zotero 分类选择：探测失败（没装/自定义数据目录）时把后端原因显示出来，
   *  并给一个手动选目录的入口——报错文案说了「可手动指定」，就得真有这个入口 */
  async function openZotero(dataDir?: string) {
    setZoteroBusy(true);
    setZoteroMsg(null);
    try {
      const lib = await invoke<ZoteroLibraryDto>("zotero_inspect", {
        dataDir: dataDir ?? zoteroDir ?? null,
      });
      if (dataDir) setZoteroDir(dataDir);
      setZoteroLib(lib);
    } catch (reason) {
      setZoteroMsg(String(reason));
    } finally {
      setZoteroBusy(false);
    }
  }

  /** 手动指定 Zotero 数据目录（Zotero 里可改数据目录，默认 ~/Zotero 找不到时走这条） */
  async function pickZoteroDir() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Zotero 数据目录（含 zotero.sqlite）",
    });
    if (typeof picked === "string") await openZotero(picked);
  }

  /** 导入选定分类：生成 references.bib + 登记 PDF 为资源；顺带把 lit_source 置为 zotero，
   *  TASK.md 据此把检索步骤降级为「盘点 + 查漏补缺」（renderTaskMd 的「文献来源」段） */
  async function importZotero(collectionId: number | null) {
    if (!project) return;
    setZoteroBusy(true);
    setZoteroMsg(null);
    try {
      const out = await invoke<{
        bibRel: string;
        itemCount: number;
        pdfCount: number;
        missingPdf: number;
      }>("zotero_import", {
        projectRoot: project.path,
        dataDir: zoteroDir ?? null,
        collectionId,
      });
      if (cfg && cfg.litSource !== "zotero") {
        await saveConfig({ ...cfg, litSource: "zotero" });
      }
      setZoteroLib(null);
      setZoteroMsg(
        `已导入 ${out.itemCount} 条 → ${out.bibRel}` +
          (out.pdfCount > 0 ? `，${out.pdfCount} 篇 PDF 已登记为项目资源` : "") +
          (out.missingPdf > 0 ? `；${out.missingPdf} 条无本地 PDF（agent 会列进待获取）` : ""),
      );
      await onRefresh();
    } catch (reason) {
      setZoteroMsg(String(reason));
    } finally {
      setZoteroBusy(false);
    }
  }
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
  // 检索结果导入（papers/imports/ 人肉中转入口）的行内提示：换掉或手动关掉即消
  const [importMsg, setImportMsg] = useState<string | null>(null);

  /** 导入检索结果：多选 RIS/BibTeX/CSV/TXT 复制进项目根的 papers/imports/
   *  （import_human_deliverable 无步骤语境 = 纯导入落主仓，不登记提货单） */
  async function importSearchResults() {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择导出的检索结果文件",
      filters: [
        {
          name: "检索结果（RIS / BibTeX / CSV / TXT）",
          extensions: ["ris", "bib", "csv", "txt"],
        },
      ],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (paths.length === 0) return;
    let ok = 0;
    for (const p of paths) {
      try {
        await invoke("import_human_deliverable", {
          projectRoot: projectPath,
          step: null,
          title: null,
          sourcePath: p,
          targetOverride: "papers/imports/",
        });
        ok++;
      } catch (reason) {
        onError(String(reason));
      }
    }
    if (ok > 0) {
      setImportMsg(
        `已放入 papers/imports/（${ok} 个文件），agent 开工时会自动解析、去重并合并进筛选清单`,
      );
    }
  }

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
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
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
  // 步骤状态表：每步算一次，下面各处派生共用同一份快照。
  // 原先 7 处各调一次 deriveStepStatus，每次都遍历 workspaces——N 步项目每渲染要跑 2N+ 次
  // find（describeStep 与 currentStep 还会互相嵌套调用）。纯派生无副作用，
  // 依赖变了整表重算，行为与逐处现算完全一致。
  const stepStatuses = useMemo(
    () =>
      (cfg?.steps ?? []).map((s) =>
        deriveStepStatus(s, workspaces, health, drift),
      ),
    [cfg, workspaces, health, drift],
  );
  /** 按索引取状态；越界回落现算（artifactsStep 等可能指向已删步骤） */
  const statusAt = (i: number) =>
    stepStatuses[i] ??
    (cfg?.steps[i]
      ? deriveStepStatus(cfg.steps[i], workspaces, health, drift)
      : null);
  /** 资源构成一句话（折叠态也让人知道里面有什么）：按类型计数，零资源时明说扫过了 */
  /** 已真正填写的全局设定：模板预填的是「综述角度：（领域全景 / 聚焦某个子问题）」这种
   *  带括号占位的空答案——原样显示会让项目头挂一串没意义的问号，用户还以为是已定的结论。
   *  判定：冒号后去掉括号内容还剩字才算填过 */
  const filledSettings = (cfg?.settings ?? []).filter((line) => {
    const ans = line.split(/[：:]/).slice(1).join(":");
    return ans.replace(/[（(].*?[）)]/g, "").trim().length > 0;
  });

  const resourceSummary = (() => {
    const rs = cfg?.resources ?? [];
    if (rs.length === 0) return "还没有登记文献/数据";
    const by = new Map<string, number>();
    for (const r of rs) by.set(r.type, (by.get(r.type) ?? 0) + 1);
    return [...by.entries()]
      .map(([t, n]) => `${n} 个${RESOURCE_TYPE_LABELS[t] ?? t}`)
      .join(" · ");
  })();
  // 课题主题直接显示在项目名旁（v3.47：只挂悬浮提示等于不存在——用户反馈看不到）
  const topicText =
    registered && cfg?.topic?.trim() ? cfg.topic.trim() : undefined;
  // 产物核验手风琴展开项（单开）：无绑定工作区不渲染（菜单项本身已禁用，此处兜底）
  const artStep =
    cfg && artifactsStep !== null ? (cfg.steps[artifactsStep] ?? null) : null;
  const artSt = artifactsStep !== null ? statusAt(artifactsStep) : null;
  const artWs = artSt?.ws;
  const artMerged = artSt?.key === "done";
  // 每步完成态（带级虚线链按列区间着色）+ 末端菱形：全部步骤完成才点亮（与完成圆同一 done 绿）
  const stepDoneFlags = stepStatuses.map((st) => st.key === "done");
  const allStepsDone =
    stepDoneFlags.length > 0 && stepDoneFlags.every(Boolean);
  /** 步骤状态快照：白话状态短语 + 主推进动作（聚焦头部与流程线节点入口共用口径；
   *  待评审/阻塞时直达评审覆盖层，比跳终端少一步）。done 步骤无动作 */
  const describeStep = (i: number) => {
    if (!cfg) return null;
    const step = cfg.steps[i];
    const st = statusAt(i)!;
    const goReview = (intent?: "resolve-conflict") => () => {
      if (!st.ws) return;
      setWorkspaceReviewRequest({
        worktreePath: st.ws.worktreePath,
        action: intent,
        requestId: crypto.randomUUID(),
      });
      setPage("terminal");
    };
    const base = { index: i, step, st };
    switch (st.key) {
      case "pending":
        return st.ws
          ? {
              ...base,
              statusText: "工作区已归档",
              actionLabel: "恢复工作区",
              action: (() => void restoreWs(st.ws!)),
            }
          : {
              ...base,
              // 情境化引导（顺序引导 A）：任务书草稿已起草 = 想法聊透了；
              // 没有则建议先点种子——不阻断，「开始」始终可用。
              // （草稿只加载聚焦步骤那一份；statusText 仅经 focusDesc 展示，即聚焦步骤）
              statusText:
                focusDraft?.stepName === step.name && focusDraft.text?.trim()
                  ? "任务书草稿已就位，可以开始"
                  : "待开始",
              actionLabel: "开始",
              action: (() => void startStep(i)),
            };
      case "review":
        return {
          ...base,
          statusText: "agent 做完了，待你评审",
          actionLabel: "去评审",
          action: goReview(),
        };
      case "blocked":
        return {
          ...base,
          statusText: "有合并冲突待处理",
          actionLabel: "去处理冲突",
          action: goReview("resolve-conflict"),
        };
      case "checking":
        return {
          ...base,
          statusText: "状态检查中",
          actionLabel: "去终端",
          action: (() => {
            if (st.ws) onOpenTerminal(st.ws);
          }),
        };
      case "done":
        return {
          ...base,
          statusText: "已完成",
          actionLabel: null,
          action: null,
        };
      default:
        return {
          ...base,
          statusText: "agent 进行中",
          actionLabel: "去终端",
          action: (() => {
            if (st.ws) onOpenTerminal(st.ws);
          }),
        };
    }
  };
  // 当前步骤 = 第一个未完成步骤（步进器亮环回落与默认聚焦用；全部完成 → null）
  const currentStep = (() => {
    if (!cfg) return null;
    for (let i = 0; i < cfg.steps.length; i++) {
      const d = describeStep(i)!;
      if (d.st.key === "done") continue;
      return d;
    }
    return null;
  })();
  // 步骤聚焦：显式选择（按名字核对身份）> 跟随当前步骤 > 全部完成时落最后一步；
  // 名字在流程里找不到（被改名/删除）时不认这次聚焦，回落当前步骤——避免静默指向另一个步骤
  const focusIndex = (() => {
    if (!cfg || cfg.steps.length === 0) return null;
    if (focusStepKey !== null) {
      const i = cfg.steps.findIndex((s) => s.name === focusStepKey);
      if (i >= 0) return i;
    }
    return currentStep?.index ?? cfg.steps.length - 1;
  })();
  const focusStepName = (() => {
    if (!cfg || focusIndex === null) return null;
    return cfg.steps[focusIndex]?.name ?? null;
  })();
  // 聚焦步骤草稿加载（state 声明在上方 describeStep 之前）：进项目详情/切聚焦/页面刷新时重读，不轮询；
  // 「◈ 沉淀进任务书」落盘后经 onDraftChanged 回调即刻重读（不等页面刷新）
  function loadFocusDraft() {
    if (!project || !focusStepName) {
      setFocusDraft(null);
      return;
    }
    invoke<{ relPath: string; text: string | null }>("read_task_draft", {
      projectRoot: project.path,
      stepName: focusStepName,
    })
      .then((d) => setFocusDraft({ stepName: focusStepName, ...d }))
      .catch(() => setFocusDraft(null));
  }
  useEffect(() => {
    loadFocusDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, focusStepName, refreshToken]);
  // 聚焦步骤的执行状态（流程线 agent/评审节点用）：deriveStepStatus 六态映射到流程线四态
  const focusRunStatus = (() => {
    if (!cfg || !focusStepName) return undefined;
    const i = cfg.steps.findIndex((s) => s.name === focusStepName);
    const st = i >= 0 ? stepStatuses[i] : undefined;
    if (!st) return undefined;
    if (st.key === "done") return "done" as const;
    if (st.key === "review" || st.key === "blocked") return "review" as const;
    if (st.key === "active" || st.key === "checking") return "active" as const;
    return "pending" as const;
  })();
  // 聚焦步骤的完整快照：聚焦头部状态短语 + 流程线动作入口（恢复工作区/冲突意图）共用
  const focusDesc = (() => {
    if (!cfg || !focusStepName) return null;
    const i = cfg.steps.findIndex((s) => s.name === focusStepName);
    return i >= 0 ? describeStep(i) : null;
  })();
  // 聚焦步骤的已归档工作区（pending + ws）：流程线 agent 节点此时主入口是「恢复工作区」而非「开始」
  const focusArchivedWs =
    focusDesc && focusDesc.st.key === "pending" ? (focusDesc.st.ws ?? null) : null;
  return (
    // 分组卡片收敛掉外框/底色：hairline 分隔 + 左侧缩进线分层，strip 底只保留给研究流程等必要块
    <section className="mb-5">
      {/* 项目身份行：区间分隔一律用留白，不画横线（去线条化，v3.85；同 PageHeader 口径） */}
      <div className="flex min-h-12 min-w-0 items-center gap-2 px-4 pb-3 pt-2.5">
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
          <h2 className="shrink-0 text-base font-semibold text-l1">
            {displayName}
          </h2>
        )}
        {topicText ? (
          <span
            className="min-w-0 max-w-72 truncate text-xs text-l3"
            title={topicText}
          >
            {topicText}
          </span>
        ) : (
          // 课题主题是给 Agent 看的（随 TASK.md 走），空着时给个能点的占位，
          // 别让它只存在于 ⋯ 菜单深处
          registered &&
          cfg && (
            <button
              type="button"
              onClick={() => {
                setTopicDraft("");
                setEditingTopic(true);
              }}
              className="shrink-0 text-xs text-l4 hover:text-l2"
              title="课题主题会写进每次开工的 TASK.md，给 Agent 交代研究背景"
            >
              ＋ 写一句课题主题
            </button>
          )
        )}
        {/* 全局设定（v3.89）：贯穿全程的决定摆在项目头，与课题主题并排——
            它们决定后面每一步，躲在第 1 步的折叠区里属层级错配（用户实测反馈）。
            点击进项目设置抽屉编辑 */}
        {registered && filledSettings.length > 0 && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={filledSettings.join("\n")}
            className="min-w-0 shrink truncate rounded-sm px-1 text-xs text-l4 hover:bg-hover hover:text-l2"
          >
            {filledSettings.join(" · ")}
          </button>
        )}
        {!registered && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l3">
            <span className="size-2 rounded-full bg-l4" />
            未添加
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
        {/* 校验提示（项目配置级，属于项目头而非研究流程条）：⚠ 徽标点开展开逐条全文浮层 */}
        {cfgWarnings.length > 0 && (
          <span className="relative shrink-0">
            <button
              type="button"
              aria-expanded={warnOpen}
              title="查看全部校验提示"
              className="rounded-sm px-1 text-xs text-warn-text hover:bg-hover"
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
                <ul className="absolute left-0 z-50 mt-1 w-72 space-y-1.5 rounded-md border border-hairline ccode-float-surface p-2">
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
              title="添加到 Ccode，获得研究流程与资源面板"
              onClick={() => onRegisterProject(repoPath)}
            >
              添加到 Ccode
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
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
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
        <NoticeBar className="mb-2" onDismiss={() => setTplSavedMsg(null)}>
          {tplSavedMsg}
        </NoticeBar>
      )}

      {registered && freshGitGuide && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-sm bg-strip p-2 text-xs text-l2">
          <span>还不是 git 仓库的话，初始化后才能建工作区。</span>
          {/* 注册时已自动扫过一遍资源，结果要在**详情页**说出来（v3.87 修）：
              原先只在「文献与数据」面板的折叠头里显示，而那个面板 v3.85 搬进了设置抽屉，
              新项目自动展开变成「在关着的抽屉里展开」——用户根本看不到扫描发生过 */}
          {cfg && (
            <span className="text-l3">
              已扫到 {resourceSummary}
              <button
                type="button"
                onClick={() => {
                  setSettingsOpen(true);
                  setResOpen(true);
                  requestAnimationFrame(() =>
                    resPanelRef.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    }),
                  );
                }}
                className="ml-1 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                查看 / 补充
              </button>
            </span>
          )}
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

      {/* 首启引导（轻量版）：注册项目且 steps 为空 → 从模板库选择写入研究流程；
          「不使用研究流程」（pipelineOptOut）显式隐藏本横幅，回流入口在 ⋯ 菜单 */}
      {registered && cfg && cfg.steps.length === 0 && !cfg.pipelineOptOut && (
        <div className="mb-2 rounded-md bg-strip p-3">
          <p className="mb-2 text-xs text-l3">还没有研究步骤。从模板库选一套，之后可以逐步改。</p>
          <input
            className={`${fieldSm} mb-2 w-full`}
            value={templateTopic}
            onChange={(e) => setTemplateTopic(e.target.value)}
            placeholder="课题主题（给 Agent 看，随 TASK.md 走）：添加项目时填过会显示在这里，可改可留空"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={ctaSm}
              onClick={() => {
                // 模板库实例住在项目设置抽屉里（v3.85），这里必须连抽屉一起开，
                // 否则只翻了 pickerOpen、界面上什么都不会发生
                setPickerOpen(true);
                setSettingsOpen(true);
              }}
            >
              选择研究流程模板
            </button>
            <button
              type="button"
              className={actionBtn}
              title="打开研究流程编辑器，从头手动添加步骤"
              onClick={() => openEditor()}
            >
              编辑研究流程
            </button>
          </div>
        </div>
      )}

      {/* 研究流程 strip（大圆步进器，v3.46）：状态从绑定工作区派生；
          大圆 = 状态色 + 主推进点击；编辑步骤/产物核验收进步骤 ⋯ 菜单（原圆前/圆后小方块
          伪装成虚线块可发现性为零，入口删除、视觉块保留为普通虚线块）；末端菱形 = 流程终点，
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
                        className="flex min-w-0 flex-1 items-center justify-center gap-1 truncate text-center text-xs text-l2"
                        title={
                          step.role === "you"
                            ? `${step.name}（这一步主要靠你）`
                            : step.role === "both"
                              ? `${step.name}（你和 AI 一起定）`
                              : step.name
                        }
                      >
                        <span className="min-w-0 truncate">{step.name}</span>
                        {/* 「轮到我」的一眼扫描（v3.89）：名称带列宽只有 9rem，
                            塞文字徽标会挤掉步骤名，故只用一个点；完整说明在 title 与流程线里 */}
                        {(step.role === "you" || step.role === "both") && (
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${
                              step.role === "you" ? "bg-cta" : "bg-l4"
                            }`}
                          />
                        )}
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
                        className={`absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
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
                  末端菱形 = 流程终点符号（装饰，无点击），全部步骤完成后点亮 */}
              <div className="flex items-center gap-1.5">
                <StepperChain dones={stepDoneFlags}>
                  <ol
                    className="relative grid gap-1.5"
                    style={{
                      gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
                    }}
                  >
                  {cfg.steps.map((step, i) => {
                    const st = statusAt(i)!;
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
                    // 点击 = 聚焦该步骤（下方卡片区只看这一步）；推进动作归流程线节点/卡片行/任务行
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
                      "点击在下方只看这一步",
                    ]
                      .filter(Boolean)
                      .join("\n");
                    // 聚焦选中态：显式选择优先；未选过时当前步骤（第一个未完成）亮环
                    const selected = focusIndex === i;
                    return (
                      <StepperCell
                        key={`${i}-${step.name}`}
                        circleClass={stepCircleClass(st.key)}
                        circleTitle={circleTitle}
                        circleWarn={
                          st.ws?.staleUpstream
                            ? `上游「${st.ws.staleUpstream}」有更新，产物可能过期`
                            : null
                        }
                        circleLabel={`${step.name}：${statusLabel}`}
                        circleDisabled={false}
                        pulsing={starting === i}
                        attention={attention}
                        selected={selected}
                        onCircleClick={() => onCircleClick(i)}
                      />
                    );
                  })}
                  </ol>
                </StepperChain>
                <span
                  className="flex h-7 w-3.5 shrink-0 items-center justify-center"
                  role="img"
                  aria-label={
                    allStepsDone ? "流程终点：全部步骤已完成" : "流程终点"
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

      {/* 应用模板成功的一次性引导条（顺序引导的入口提示）：把视线引到第 1 步与种子，可关 */}
      {tplApplied && (
        <NoticeBar
          tone="info"
          className="mb-3"
          onDismiss={() => setTplApplied(false)}
        >研究流程已就位。先到第 1 步「定方向」答几道选择题，再点「开始」。</NoticeBar>
      )}

      {/* 人工事项清单已并入聚焦视图（TaskCardsSection 聚焦步骤时顶部渲染）；原 ⋯ 手风琴面板删除 */}

      {/* 产物核验手风琴（步骤 ⋯ 菜单触发）：strip 下方就地展开（单开）；root 口径同任务行——已合并读项目根，其余读工作树 */}
      {artStep && artWs && (
        <div className="mb-4">
          <ArtifactChecklist
            projectPath={projectPath}
            workspaceName={artStep.workspaceName}
            root={artMerged ? repoPath : artWs.worktreePath}
            rootLabel={artMerged ? "主文件夹（已合并）" : "工作区"}
          />
        </div>
      )}

      {/* 任务卡区（研究流程步进器下方）：对话的归档文件夹（任务书沉淀统一走草稿）；无独立状态机，不碰工作区/评审流程。
          v3.70 起按 focusStep 聚焦：恒为单步骤视图，点大圆或卡片区头部 ‹ › 箭头切步骤（v3.81 起无总览态） */}
      {registered && cfg && (
        <TaskCardsSection
          projectPath={projectPath}
          steps={cfg.steps}
          cfg={cfg}
          workspaces={workspaces}
          refreshToken={refreshToken}
          mainDirty={mainDirty}
          focusStep={focusStepName}
          focusStatusText={focusDesc?.statusText ?? null}
          focusRunStatus={focusRunStatus}
          focusDraft={
            focusDraft && focusDraft.stepName === focusStepName
              ? focusDraft
              : null
          }
          onDraftChanged={loadFocusDraft}
          onOpenResources={(focus) => {
            // 资源面板已搬进项目设置抽屉（v3.85）：开抽屉 + 展开该区，
            // 再滚到它（抽屉里内容多时它不一定在首屏）；focus 高亮对应进料入口
            setSettingsOpen(true);
            setResOpen(true);
            setResFocus(focus ?? null);
            if (focus) window.setTimeout(() => setResFocus(null), 2500);
            requestAnimationFrame(() =>
              resPanelRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "center",
              }),
            );
          }}
          // 输入准备（v3.86）：文献来源与两个导入入口直接放到流程线「定方向」里，
          // 不必再进抽屉找。Zotero 选择器本就是根级弹层，任何地方都能拉起
          onSetLitSource={setLitSource}
          litBusy={litBusy}
          reviewConflict={focusDesc?.st.key === "blocked"}
          onRestoreWorkspace={
            focusArchivedWs ? () => void restoreWs(focusArchivedWs) : undefined
          }
          onFocusIndex={focusByIndex}
          onStartStep={(index, originCardId) => startStep(index, originCardId)}
        />
      )}

      {/* ───── 项目设置抽屉（右侧滑出，不是页面、不进侧栏、不占路由） ─────
          容纳全部项目级低频配置：基本 / 研究流程模板 / 文献与数据 / 定时巡检。
          内部各块沿用原有的 state 与 handler，只是从详情页的常驻带搬进抽屉。 */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-black/40 ccode-fade"
          onClick={() => setSettingsOpen(false)}
        >
          <aside
            className="flex h-full w-[34rem] max-w-[92vw] flex-col bg-canvas"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex h-12 shrink-0 items-center gap-2 px-5">
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-l1">
                项目设置
              </h2>
              <button
                type="button"
                className={actionBtn}
                onClick={() => setSettingsOpen(false)}
                aria-label="关闭项目设置"
              >
                ✕
              </button>
            </header>
            <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 pb-6">
              {project && (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-l3">基本</h3>
                  <div className="rounded-lg bg-strip p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="w-20 shrink-0 text-xs text-l3">
                        项目名
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-l1">
                        {displayName}
                      </span>
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => {
                          setProjectName(project.name);
                          setRenamingProject(true);
                          setSettingsOpen(false);
                        }}
                      >
                        重命名
                      </button>
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="w-20 shrink-0 text-xs text-l3">
                        课题主题
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-l2">
                        {cfg?.topic?.trim() || (
                          <span className="text-l4">未填写</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className={actionBtn}
                        disabled={!cfg}
                        onClick={() => {
                          setTopicDraft(cfg?.topic ?? "");
                          setEditingTopic(true);
                          setSettingsOpen(false);
                        }}
                      >
                        编辑
                      </button>
                    </div>
                    {/* 全局设定编辑（v3.89）：一行一条「问题：答案」，随 TASK.md 下发每一步 */}
                    <div className="mb-2 flex items-start gap-2">
                      <span className="w-20 shrink-0 pt-1 text-xs text-l3">
                        全局设定
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        {/* fieldSm 自带 h-7（单行高），会把 rows={3} 压成一行——
                            多行输入必须去掉那个固定高度（v3.89 修：4 条设定只看得见 1 条） */}
                        <textarea
                          className={`${fieldSm.replace("h-7 ", "")} min-w-0 flex-1 resize-y py-1 leading-5`}
                          rows={4}
                          value={globalsDraft}
                          onChange={(e) => setGlobalsDraft(e.target.value)}
                          onBlur={() => void saveGlobals()}
                          placeholder={"综述角度：聚焦储能应用\n目标篇幅：8000 词"}
                        />
                        <span className="flex items-center gap-2 text-micro text-l4">
                          一行一条，写成「问题：答案」；每一步开工时都会带给 AI
                          {globalsSaved && (
                            <span className="text-ok-text">✓ 已保存</span>
                          )}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-xs text-l3">
                        项目路径
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-micro text-l4"
                        title={project.path}
                      >
                        {project.path}
                      </span>
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() =>
                          copyText(project.path, "复制项目路径失败")
                        }
                      >
                        复制
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {registered && cfg && (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-l3">研究流程</h3>
                  <div className="rounded-lg bg-strip p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-xs text-l4">
                        当前 {cfg.steps.length} 个步骤
                      </span>
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => setPickerOpen((v) => !v)}
                        title={
                          cfg.steps.length === 0
                            ? "打开模板库选一套研究流程写入项目"
                            : "另选一个模板；写入时现有步骤被替换，绑定的工作区与资源不受影响"
                        }
                      >
                        {pickerOpen
                          ? "收起模板库"
                          : cfg.steps.length === 0
                            ? "选择模板"
                            : "更换模板"}
                      </button>
                      <button
                        type="button"
                        className={actionBtn}
                        disabled={cfg.steps.length === 0}
                        title={
                          cfg.steps.length > 0 ? undefined : "没有可保存的研究步骤"
                        }
                        onClick={() => {
                          setTplSavedMsg(null);
                          setSavingTemplate(true);
                          setSettingsOpen(false);
                        }}
                      >
                        另存为模板
                      </button>
                    </div>
                  </div>
                </section>
              )}

      {/* 模板库选择器：项目菜单与空研究流程「选择研究流程模板」共用的唯一实例 */}
      {registered && cfg && pickerOpen && (
        <div className="mb-4 rounded-md bg-strip p-2">
          <TemplatePicker
            applying={applyingTemplate}
            onApply={(item) => void applyTemplate(item)}
            onError={onError}
          />
        </div>
      )}

      {/* 文献与数据（原「资源面板」）：三个进料口收在一处——注册时已自动扫过一遍，
          这里回答「扫到了什么」+「还能从哪儿补」。新注册的项目自动展开：
          原先提示挂在页面底部、又被模板选择层挡住，用户根本看不到扫描发生过 */}
      {registered && cfg && (
        <div className="mb-4" ref={resPanelRef}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
              onClick={() => setResOpen((v) => !v)}
              aria-expanded={resOpen}
            >
              <span>{resOpen ? "▾" : "▸"}</span>
              文献与数据（{cfg.resources.length}）
            </button>
            {/* 折叠态也要说清「有什么」和「还能补」：只在新注册或零资源时才提示，
                等于对老项目和已有资源的项目永远沉默——那正是用户看不到扫描发生过的原因 */}
            {!resOpen && (
              <span className="min-w-0 truncate text-micro text-l4">
                {resourceSummary}
                <span className="text-l4"> · 展开可从 Zotero / 检索结果补充</span>
              </span>
            )}
          </div>
          {resOpen && (
            <div className="mt-1 rounded-md bg-strip p-2">
              {/* 「文献来源」选择器已移到流程线「定方向」的输入准备块（v3.86）——
                  它是开工前必须拍板的事，藏在抽屉三层下面本身就是错的位置，
                  而且当时与决策项、人工事项一起把同一个问题问了四遍。
                  这里只留当前值的只读回显 + 跳转，导入动作两处都保留（这里是二级入口）。 */}
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-micro text-l4">文献来源</span>
                <span className="rounded-full bg-inset px-2 py-0.5 text-micro text-l2">
                  {{
                    search: "让 agent 检索",
                    zotero: "我有 Zotero 库",
                    folder: "我有一堆 PDF / 题录",
                  }[cfg.litSource?.trim() || "search"] ?? "让 agent 检索"}
                </span>
                <span className="text-micro text-l4" title="在流程线的「定方向 → 输入」里更改">
                  在流程线里改
                </span>
              </div>
              {(cfg.litSource?.trim() || "search") !== "search" && (
                <p className="mb-2 text-micro leading-5 text-l4">
                  检索步骤已改为「盘点已有 + 查漏补缺」，筛选这一步不会跳过。
                </p>
              )}
              {/* 进料口三选一：agent 自己扫 / 你已有的库 / 你手动检索的结果。
                  一行摆齐，用户不必在界面里找第二处入口 */}
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-micro text-l4">从哪儿补</span>
                <button
                  type="button"
                  className={`${actionBtn} ${resFocus === "zotero" ? "ring-2 ring-cta" : ""}`}
                  disabled={zoteroBusy}
                  title="从本机 Zotero 库导入：生成 references.bib，已下载的 PDF 按绝对路径登记为资源（只读引用，不复制）。你的 Zotero 库只读不改"
                  onClick={() => void openZotero()}
                >
                  {zoteroBusy ? "读取中…" : "从 Zotero 导入"}
                </button>
                <button
                  type="button"
                  className={`${actionBtn} ${resFocus === "files" ? "ring-2 ring-cta" : ""}`}
                  title="你在 Undermind / Google Scholar / Elicit 等网页端检索后，把结果导出成 RIS / BibTeX / CSV 文件，点这里导入（可多选）。开工时 agent 会自动解析、按 DOI 去重、并进筛选清单——省掉你手抄一遍"
                  onClick={() => void importSearchResults()}
                >
                  导入 RIS / BibTeX
                </button>
                <button
                  type="button"
                  className={actionBtn}
                  disabled={discoverLoading}
                  title="重新扫描项目目录（PDF / CSV / parquet / bib 等，深度 3）；注册时已自动扫过一次，往目录里放了新文件再点"
                  onClick={() => void discoverResources()}
                >
                  {discoverLoading ? "扫描中…" : "重新扫描目录"}
                </button>
              </div>
              {cfg.resources.length === 0 && !discoverState && (
                <p className="text-xs text-l4">没扫到 PDF / CSV / bib。用上面的入口导入，或放进项目目录后重新扫描。</p>
              )}
              {cfg.resources.length > 0 && (
                <ul className="divide-y divide-hairline">
                  {cfg.resources.map((r, i) => (
                    <li
                      key={`${i}-${r.path}`}
                      className="flex min-w-0 items-center gap-2 py-1.5"
                    >
                      <span className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l3">
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
                          className="shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
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
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                      >
                        ⋯
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {discoverState && (
                <div className="mt-3">
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
                                    <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-l3">
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
              {importMsg && (
                <NoticeBar className="mt-2" onDismiss={() => setImportMsg(null)}>
                  {importMsg}
                </NoticeBar>
              )}
              {zoteroMsg && (
                <div className="mt-2 flex items-start gap-2 rounded-md bg-strip px-3 py-2.5 text-xs leading-5 text-l2">
                  <span className="min-w-0 flex-1">{zoteroMsg}</span>
                  {zoteroMsg.includes("没找到") && (
                    <button
                      type="button"
                      onClick={() => void pickZoteroDir()}
                      className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
                    >
                      选择目录
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setZoteroMsg(null)}
                    className="shrink-0 rounded-sm px-1 py-0.5 text-l4 hover:bg-hover hover:text-l1"
                  >
                    知道了
                  </button>
                </div>
              )}
              {gitignoreHint && (
                <NoticeBar
                  tone="info"
                  className="mt-2"
                  onDismiss={() => setGitignoreHint(false)}
                >数据与产物类大文件建议加进 .gitignore。</NoticeBar>
              )}
            </div>
          )}
        </div>
      )}

      {/* 定时任务区块（scheduler.rs）：只显示 projectRoot 命中本项目的任务，运行完成走 scheduler-run-done 事件刷新；
          技能可选后不再科研专属，「不使用研究流程」的项目也照常显示 */}
      {registered && <ScheduleSection projectRoot={projectPath} />}
            </div>
          </aside>
        </div>
      )}
      {/* ───── 项目设置抽屉结束 ───── */}

      {children({
        focusStepName,
        steps: cfg?.steps ?? [],
      })}
      </div>

      {projectMenu && project && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          alignRight
          onClose={() => setProjectMenu(null)}
          items={[
            {
              label: "编辑研究流程",
              disabled: !cfg,
              title: cfg
                ? "编辑步骤名称、简报、预期产物和脚本"
                : "project.toml 尚未加载完成",
              onSelect: () => openEditor(),
            },
            {
              // 项目级低频配置的单一入口（v3.85）：原先「重命名 / 课题主题 / 更换模板 /
              // 另存为模板 / 复制路径」五项平铺在这里，加上详情页两条常驻带，
              // 项目配置散在四处；现在统一进抽屉
              label: "项目设置…",
              title: "项目名 / 课题主题 / 研究流程模板 / 文献与数据 / 定时巡检",
              onSelect: () => setSettingsOpen(true),
            },
            {
              label: "历史",
              title: "项目的白话保存时间线（只读）",
              onSelect: () => setHistoryOpen(true),
            },
            {
              label: "从 Ccode 移除",
              title:
                "只把项目从 Ccode 列表里摘掉，不动磁盘文件；清除痕迹与删除目录在左侧项目栏右键菜单里",
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
          projectPath={project.path}
          config={cfg}
          warnings={cfgWarnings}
          saving={pipelineSaving}
          focusStep={editorFocus}
          onSave={(steps) => void savePipeline(steps)}
          onClose={() => setEditorOpen(false)}
          onConfigReload={(read) => {
            setCfg(read.config);
            setCfgWarnings(read.warnings);
          }}
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
      {/* Zotero 分类选择：只读适配器的唯一交互点——选一个分类（或整库）导入 */}
      {zoteroLib && (
        <div
          className="ccode-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setZoteroLib(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ccode-float-surface flex max-h-[70vh] w-[30rem] flex-col rounded-md border border-field p-5"
          >
            <h2 className="shrink-0 text-base font-semibold text-l1">
              从 Zotero 导入
            </h2>
            <p className="mt-1 shrink-0 text-xs text-l3">生成 references.bib；PDF 只登记位置，不复制。<span className="text-l4">你的 Zotero 库只读不改。</span>
            </p>
            <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
              {zoteroLib.collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={zoteroBusy || c.count === 0}
                  onClick={() => void importZotero(c.id)}
                  className="flex w-full items-center gap-2 rounded-md bg-inset px-2.5 py-2 text-left hover:bg-hover disabled:opacity-40"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-l1">
                    {c.name}
                  </span>
                  <span className="shrink-0 text-micro text-l4">
                    {c.count} 条
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled={zoteroBusy}
                onClick={() => void importZotero(null)}
                className="flex w-full items-center gap-2 rounded-md border border-dashed border-field px-2.5 py-2 text-left hover:bg-hover disabled:opacity-40"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-l2">
                  整个库（含未分类）
                </span>
                <span className="shrink-0 text-micro text-l4">
                  {zoteroLib.total} 条
                </span>
              </button>
            </div>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-l4">
                {zoteroLib.dbPath}
              </span>
              <button
                type="button"
                onClick={() => setZoteroLib(null)}
                className="shrink-0 rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              >
                取消
              </button>
            </div>
          </div>
        </div>
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
          onConfirm={(taskMd) => {
            const index = kickoff.index;
            setKickoff(null);
            void runStartStep(index, taskMd);
          }}
          onCfgChange={(next) => setCfg(next)}
        />
      )}
    </section>
  );
}
