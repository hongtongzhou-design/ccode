import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import PipelineEditor from "./PipelineEditor";
import HistoryOverlay from "./HistoryOverlay";
import TemplatePicker, { type TemplatePickItem } from "./TemplatePicker";
import { Checkbox } from "./PageFrame";
import type { DirEntryDto } from "./FileTree";
import { useAppStore } from "../store";
import {
  DEFAULT_KICKOFF_PROMPT,
  RESOURCE_TYPE_LABELS,
} from "../pipeline-presets";
import type {
  ArtifactEntryDto,
  BootstrapCommitDto,
  DiscoveredResourceDto,
  EnsureGitDto,
  PipelineTemplateDto,
  ProjectConfigDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectResourceDto,
  ProjectStepDto,
  SkillDto,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
} from "../types";

const actionBtn =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-white/5 hover:text-l1";
const ctaSm =
  "inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110 disabled:opacity-50";
// 步骤胶囊内按钮与任务行操作统一为 28px 点击区。
const capsuleBtn = actionBtn;
const capsuleCta = ctaSm;
const fieldSm =
  "h-7 rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

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

/** 步骤产物面板的一行：一个预期产物条目的定位结果 */
interface ArtifactRow {
  /** 预期产物条目原文（相对根的路径） */
  entry: string;
  files: DirEntryDto[];
}

/** 步骤产物清单（RX2b）：预期产物条目逐个在 root 下定位——文件单列自身；
 *  目录列一层文件（只列文件不递归）；找不到返回空 files（UI 显示「尚未产出」）。
 *  list_dir 无根目录约束（只读列举），直接传绝对路径；仅在面板打开时调用，不进轮询 */
async function loadArtifactRows(
  entries: string[],
  root: string,
): Promise<ArtifactRow[]> {
  return Promise.all(
    entries.map(async (raw) => {
      const entry = raw.replace(/[\\/]+$/, "");
      const abs = absoluteResourcePath(root, entry);
      // 目录条目：list_dir 成功即列一层文件
      try {
        const children = await invoke<DirEntryDto[]>("list_dir", {
          path: abs,
          showHidden: false,
        });
        return { entry, files: children.filter((c) => !c.isDir) };
      } catch {
        /* 非目录或不存在，走父目录匹配 */
      }
      // 文件条目：列父目录按名称匹配，区分「文件存在」与「尚未产出」
      const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
      if (idx > 0) {
        try {
          const siblings = await invoke<DirEntryDto[]>("list_dir", {
            path: abs.slice(0, idx),
            showHidden: false,
          });
          const hit = siblings.find((s) => s.name === abs.slice(idx + 1));
          if (hit && !hit.isDir) return { entry, files: [hit] };
        } catch {
          /* 父目录也不存在 */
        }
      }
      return { entry, files: [] };
    }),
  );
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
  active: { label: "进行中", dotClass: "bg-ok-text", textClass: "text-l3" },
  review: { label: "待评审", dotClass: "bg-ok-text", textClass: "text-l2" },
  blocked: { label: "阻塞", dotClass: "bg-err-text", textClass: "text-l2" },
  done: { label: "已完成", dotClass: "bg-ok-text", textClass: "text-ok-text" },
  checking: { label: "检查中", dotClass: "bg-l4", textClass: "text-l3" },
};

function stepSegmentClass(key: StepStatusKey): string {
  if (key === "done") return "bg-ok-text";
  if (key === "blocked") return "bg-err-text";
  if (key === "review") return "bg-cta";
  if (key === "active") return "bg-cta opacity-50";
  // 待开始/检查中用 l4 灰：bg-inset 与 strip 容器底色在五套主题里同值，
  // 进度段会整条隐身；l4 同时是待开始状态点的既有颜色，语义一致
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

/** TASK.md 内容：标题 + 课题主题（非空时） + 简报 + 预期产物 + 推荐技能 + 项目资源（步骤有资源绑定时只列绑定项，一键开步落成工作区）。
 *  导出给 TerminalPage 的「整理为笔记」开步链路复用，保持两处 TASK.md 一致。
 *  artifacts 为项目根提货单（上一步产物），非空时在「项目资源」后追加提货单段。
 *  skillMeta 为技能库元数据（name → 一句话描述）：步骤 skills 非空时渲染「本步骤推荐技能」段；
 *  缺省（库读取失败）时只列技能名，不误标未安装。 */
export function renderTaskMd(
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
  projectPath: string,
  artifacts?: ArtifactEntryDto[],
  skillMeta?: Record<string, string>,
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
  // 步骤挂载技能（RX3b）：只列名称 + 一句话描述，技能本体不进 TASK.md（保持简报轻量）
  if (step.skills.length > 0) {
    lines.push("", "## 本步骤推荐技能");
    for (const name of step.skills) {
      if (!skillMeta) {
        lines.push(`- ${name}`);
      } else if (name in skillMeta) {
        const desc = skillMeta[name];
        lines.push(desc ? `- ${name}：${desc}` : `- ${name}`);
      } else {
        lines.push(`- ${name}（未安装，可在技能页新建或导入）`);
      }
    }
    lines.push("已分发到所启动 Agent 的技能自动生效；未分发可在技能页开启。");
  }
  // 资源绑定（RX1）：步骤 resources 非空时「项目资源」段只列绑定项；空/缺省保持全部（向后兼容）
  const boundPaths = step.resources ?? [];
  const resources =
    boundPaths.length > 0
      ? cfg.resources.filter((r) => boundPaths.includes(r.path))
      : cfg.resources;
  if (resources.length > 0) {
    // 资源只引用不复制：相对路径按项目根拼成绝对路径，Agent 可直接读取
    const root = projectPath.replace(/[\\/]+$/, "");
    lines.push("", "## 项目资源（只读引用，勿复制到本工作区）");
    for (const r of resources) {
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
  // 步骤产物面板（RX2b）：打开时才拉取文件清单，不进轮询
  const [artifactPanel, setArtifactPanel] = useState<number | null>(null);
  const [artifactRows, setArtifactRows] = useState<ArtifactRow[] | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  // 流水线编辑器（RX1）：步骤编辑唯一入口，覆盖旧 ⋯ 内联重命名/编辑简报/+ 步骤表单
  const [editorOpen, setEditorOpen] = useState(false);
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

  const canOpenWs = (ws: WorkspaceDto) =>
    ws.status === "active" &&
    (drift[ws.id]?.healthy === true ||
      drift[ws.id]?.canResolveMerge === true ||
      !!driftFailed[ws.id]);

  // 步骤产物面板（RX2b）：打开时按步骤状态定位根目录拉取一次清单——
  // 已完成（已合并）→ 项目根（main）；其余活跃工作区 → 工作树。状态变化不自动刷新，重新打开面板即可
  useEffect(() => {
    if (artifactPanel === null || !cfg) return;
    const step = cfg.steps[artifactPanel];
    if (!step) return;
    const st = deriveStepStatus(step, workspaces, health, drift);
    const root = st.key === "done" ? projectPath : st.ws?.worktreePath;
    if (!root) {
      setArtifactRows([]);
      return;
    }
    let stale = false;
    setArtifactsLoading(true);
    loadArtifactRows(step.expectedArtifacts, root)
      .then((rows) => {
        if (!stale) setArtifactRows(rows);
      })
      .catch(() => {
        if (!stale) setArtifactRows([]);
      })
      .finally(() => {
        if (!stale) setArtifactsLoading(false);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactPanel]);

  /** 一键开步（§11.3 机制三）：ensure git → 建工作区 → 简报落成 TASK.md → 跳终端预填启动 */
  async function startStep(index: number) {
    if (!project || !cfg) return;
    const step = cfg.steps[index];
    setStarting(index);
    try {
      await invoke<EnsureGitDto>("ensure_git_repo", { path: project.path });
      // 档案卡/gitignore 自动提交为 best-effort（沿用 TASK.md 同款模式）：
      // git init 后 .ccode 与 .gitignore 未跟踪会被工作区合并的「主文件夹里还有没保存的改动」拦截；
      // 后端只提交这两个 Ccode 自有路径，用户文件绝不纳入，失败不阻断开步
      try {
        await invoke<BootstrapCommitDto>("commit_project_bootstrap", {
          repoPath: project.path,
        });
      } catch (reason) {
        onError(`档案卡自动提交失败（不影响开步）：${String(reason)}`);
      }
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
      // 步骤挂载技能（RX3b）：skills 非空时读库元数据渲染「本步骤推荐技能」段，
      // best-effort——库读取失败只列技能名，不阻断开步
      let skillMeta: Record<string, string> | undefined;
      if (step.skills.length > 0) {
        try {
          const lib = await invoke<SkillDto[]>("list_skills");
          skillMeta = Object.fromEntries(
            lib.map((skill) => [skill.name, skill.description]),
          );
        } catch {
          /* 技能库不可读时只列技能名 */
        }
      }
      try {
        await invoke("write_workspace_task_md", {
          worktreePath: ws.worktreePath,
          content: renderTaskMd(step, cfg, project.path, artifacts, skillMeta),
        });
      } catch (reason) {
        onError(`工作区「${ws.name}」已创建，TASK.md 写入失败：${String(reason)}`);
      }
      // 步骤预设的 run 脚本（P4 quarto 渲染等）落进项目层 .ccode/settings.toml：
      // 同名覆盖、其余键保留；best-effort 失败不阻断开步。
      // 写在工作区行刷新之前，「运行脚本」菜单（workspace_settings 按 repoPath 合并）当次即可见
      if (step.run.length > 0) {
        try {
          await invoke("upsert_project_run_scripts", {
            repoPath: project.path,
            scripts: step.run,
          });
        } catch (reason) {
          onError(
            `工作区「${ws.name}」已创建，run 脚本写入失败：${String(reason)}`,
          );
        }
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
    const canViewArtifacts = st.key === "done" || !!activeWs;
    return [
      {
        label: artifactPanel === index ? "隐藏产物" : "查看产物",
        disabled: !canViewArtifacts,
        title: canViewArtifacts
          ? "查看该步骤已经产出的文件"
          : st.ws
            ? "工作区已归档，暂无产物可查"
            : "工作区尚未创建，暂无产物",
        onSelect: () => {
          setArtifactRows(null);
          setArtifactPanel(artifactPanel === index ? null : index);
        },
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
  // 课题主题从常驻小字收进项目名悬浮 title（白话双层）
  const topicTitle =
    registered && cfg?.topic?.trim() ? cfg.topic.trim() : undefined;
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
          <h2
            className="shrink-0 text-sm font-medium text-l1"
            title={topicTitle}
          >
            {displayName}
          </h2>
        )}
        {!registered && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
            <span className="h-1.5 w-1.5 rounded-full bg-l4" />
            未注册
          </span>
        )}
        {groupCountsTotal > 0 && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-l3">
            {groupCounts.active > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-ok-text" />
                {groupCounts.active} 进行中
              </span>
            )}
            {groupCounts.review > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-cta" />
                {groupCounts.review} 待评审
              </span>
            )}
            {groupCounts.blocked > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-err-text" />
                {groupCounts.blocked} 阻塞
              </span>
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
              onClick={() => setEditorOpen(true)}
            >
              编辑流水线
            </button>
          </div>
        </div>
      )}

      {/* 流水线 strip：状态从绑定工作区派生，纯展示 */}
      {registered && cfg && cfg.steps.length > 0 && (
        <div className="mb-3 rounded-md bg-strip px-3 py-2.5">
          {/* 校验提示：⚠ 徽标点击展开逐条全文浮层（WKWebView 不显示 title 悬浮）；
              进度由下方等分进度段直接表达，不再放文字计数 */}
          {cfgWarnings.length > 0 && (
            <div className="mb-2 flex items-center justify-end px-0.5">
              <div className="relative">
                <button
                  type="button"
                  aria-expanded={warnOpen}
                  title="查看全部校验提示"
                  className="shrink-0 rounded px-1 text-xs text-warn-text hover:bg-white/5"
                  onClick={() => setWarnOpen((v) => !v)}
                >
                  ⚠ {cfgWarnings.length} 条提示
                </button>
                {warnOpen && (
                  <>
                    {/* 点击浮层外任意处关闭 */}
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setWarnOpen(false)}
                    />
                    <ul className="absolute right-0 z-50 mt-1 w-72 space-y-1.5 rounded-md border border-hairline bg-raised p-2">
                      {cfgWarnings.map((w, i) => (
                        <li key={i} className="break-words text-xs text-l2">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}
          {/* 等分列网格：列宽下限 9rem 让更多步骤在常规窗口内完整可见；
              窗口过窄放不下全部步骤时保持整体横向滚动（不换行，进度线与胶囊同列对齐） */}
          <ol
            className="grid gap-2 overflow-x-auto pb-1"
            style={{
              gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
            }}
          >
            {cfg.steps.map((step, i) => {
              const st = deriveStepStatus(step, workspaces, health, drift);
              const style = STEP_STATUS_STYLE[st.key];
              const statusLabel =
                st.key === "pending" && st.ws ? "已归档" : style.label;
              // 「产物」面板只对活跃工作区开放（已归档/未创建禁用并注明）
              const activeWs =
                st.ws && st.ws.status === "active" ? st.ws : undefined;
              // 与步骤 ⋯ 菜单「查看产物」同一开放条件（已完成读主文件夹）
              const canViewArtifacts = st.key === "done" || !!activeWs;
              const last = activeWs
                ? wsLastConfig(activeWs.worktreePath)
                : {};
              const lastProfile = last.profileId
                ? profiles.find((p) => p.id === last.profileId)
                : undefined;
              // 原胶囊副行（目录尾段 · agent/profile）并入悬浮全文，一段式展示
              const capsuleTitle = [
                `${step.name} · ${statusLabel}`,
                activeWs
                  ? `目录：${activeWs.worktreePath}`
                  : st.ws
                    ? "工作区已归档"
                    : "工作区尚未创建",
                last.agentId
                  ? `Agent：${last.agentId}${lastProfile ? ` / ${lastProfile.name}` : ""}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n");
              return (
                <li key={`${i}-${step.name}`} className="min-w-0">
                  {/* 进度段：状态切换时颜色柔和过渡（transition-all）；
                      进行中/待评审段加呼吸脉冲，让「正在动」一眼可辨 */}
                  <div
                    className={`mb-2 h-1.5 rounded-full transition-all duration-500 ${stepSegmentClass(st.key)} ${
                      st.key === "active" || st.key === "review"
                        ? "animate-pulse"
                        : ""
                    }`}
                    title={`${step.name}：${statusLabel}`}
                  />
                  <div className="flex min-w-0 items-center gap-1">
                    <div
                      className="group min-w-0 flex-1 rounded bg-inset px-2 py-1.5"
                      title={capsuleTitle}
                    >
                      {/* 第一行：步骤名 + 状态 */}
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-l1">
                          {step.name}
                        </span>
                        {!(st.key === "pending" && !st.ws) && (
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 text-xs ${style.textClass}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${style.dotClass}`}
                            />
                            {statusLabel}
                          </span>
                        )}
                      </div>
                      {/* 第二行：主按钮（按状态）+ 产物 + ⋯（用户明确要求操作常驻可见） */}
                      <div className="mt-1 flex min-w-0 items-center gap-1">
                        {st.key === "pending" && !st.ws && (
                          <button
                            type="button"
                            className={`${capsuleCta} shrink-0`}
                            disabled={starting === i || !step.workspaceName}
                            title={
                              step.workspaceName
                                ? undefined
                                : "该步骤未配置工作区名，请在「编辑流水线」中补充"
                            }
                            onClick={() => void startStep(i)}
                          >
                            {starting === i ? "创建中…" : "开始"}
                          </button>
                        )}
                        {st.key === "pending" && st.ws && (
                          <button
                            type="button"
                            className={`${capsuleBtn} shrink-0`}
                            title="绑定的工作区已归档，恢复后继续"
                            onClick={() => void restoreWs(st.ws!)}
                          >
                            恢复
                          </button>
                        )}
                        {st.key === "blocked" && st.ws && canOpenWs(st.ws) && (
                          <button
                            type="button"
                            className={`${capsuleBtn} shrink-0 text-warn-text`}
                            title="两边改了同一个地方，需要你逐个文件选一边"
                            onClick={() =>
                              onOpenReview(st.ws!, "resolve-conflict")
                            }
                          >
                            解决冲突
                          </button>
                        )}
                        {st.key === "review" && st.ws && canOpenWs(st.ws) && (
                          <button
                            type="button"
                            className={`${capsuleBtn} shrink-0`}
                            title="已提交待合并，进入评审验收"
                            onClick={() => onOpenReview(st.ws!, undefined)}
                          >
                            评审
                          </button>
                        )}
                        {(st.key === "active" ||
                          st.key === "checking" ||
                          st.key === "done") &&
                          st.ws &&
                          canOpenWs(st.ws) && (
                            <button
                              type="button"
                              className={`${capsuleBtn} shrink-0`}
                              title="打开该步骤的终端"
                              onClick={() => onOpenTerminal(st.ws!)}
                            >
                              ⌨ 终端
                            </button>
                          )}
                        <button
                          type="button"
                          className={`${capsuleBtn} shrink-0`}
                          disabled={!canViewArtifacts}
                          title={
                            canViewArtifacts
                              ? "查看该步骤已经产出的文件"
                              : st.ws
                                ? "工作区已归档，暂无产物可查"
                                : "工作区尚未创建，暂无产物"
                          }
                          onClick={() => {
                            setArtifactRows(null);
                            setArtifactPanel(artifactPanel === i ? null : i);
                          }}
                        >
                          产物
                        </button>
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
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs text-l3 hover:bg-white/5 hover:text-l1"
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                    {i < cfg.steps.length - 1 && (
                      <span className="shrink-0 text-xs text-l4">→</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {/* 步骤产物面板（RX2b）：只在打开时拉取一次；已完成读项目根（main），其余读工作树 */}
          {artifactPanel !== null &&
            cfg.steps[artifactPanel] &&
            (() => {
              const step = cfg.steps[artifactPanel];
              const st = deriveStepStatus(step, workspaces, health, drift);
              const root =
                st.key === "done" ? projectPath : st.ws?.worktreePath;
              const rootLabel =
                st.key === "done" ? "主文件夹（已合并）" : "工作区";
              return (
                <div className="mt-2 rounded-md bg-strip p-2">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs text-l2">
                      「{step.name}」产物
                    </span>
                    <span
                      className="min-w-0 truncate font-mono text-[11px] text-l4"
                      title={root ?? undefined}
                    >
                      {rootLabel}
                    </span>
                    <button
                      type="button"
                      className={`${actionBtn} ml-auto shrink-0`}
                      onClick={() => setArtifactPanel(null)}
                    >
                      关闭
                    </button>
                  </div>
                  {step.expectedArtifacts.length === 0 ? (
                    <p className="text-xs text-l4">
                      该步骤未登记预期产物，可在「编辑流水线」中补充。
                    </p>
                  ) : artifactsLoading || !artifactRows ? (
                    <p className="text-xs text-l4">读取中…</p>
                  ) : (
                    <ul className="space-y-1">
                      {artifactRows.map((row) => (
                        <li key={row.entry}>
                          <div className="font-mono text-[11px] text-l3">
                            {row.entry}
                          </div>
                          {row.files.length === 0 ? (
                            <div className="pl-2 text-xs text-l4">
                              尚未产出
                            </div>
                          ) : (
                            <ul className="pl-2">
                              {row.files.map((f) => (
                                <li key={f.path}>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-l2 hover:bg-white/5 hover:text-l1"
                                    title={`在终端页预览 ${f.path}`}
                                    onClick={() => {
                                      if (!root) return;
                                      setPreviewReq({
                                        path: f.path,
                                        name: f.name,
                                        root,
                                      });
                                      setPage("terminal");
                                    }}
                                  >
                                    <span className="min-w-0 flex-1 truncate font-mono">
                                      {f.name}
                                    </span>
                                    <span className="shrink-0 text-l4">
                                      {formatSize(f.size)}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}
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
              onSelect: () => setEditorOpen(true),
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
