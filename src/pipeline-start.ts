import { invoke } from "@tauri-apps/api/core";
import { isGitMissingError } from "./dep-check";
import { orderedAnswers, parseDecisions } from "./step-decisions";
import { pickWorkspaceResume } from "./workspace-resume";
import { DEFAULT_KICKOFF_PROMPT } from "./pipeline-presets";
import { renderTaskMd } from "./task-md";
export { renderTaskMd };
import type { PendingTerminal } from "./store";
import type {
  ArtifactEntryDto,
  BootstrapCommitDto,
  EnsureGitDto,
  ProjectConfigDto,
  ProjectStepDto,
  SessionMetaDto,
  SkillDto,
  WorkspaceDto,
} from "./types";

/** TASK.md 的提货单/技能元数据收集（best-effort，失败回落空）：开工确认弹层预览与实际开工共用 */
export async function gatherTaskMdExtras(
  projectPath: string,
  step: ProjectStepDto,
): Promise<{
  artifacts: ArtifactEntryDto[];
  skillMeta: Record<string, string> | undefined;
  decisions: { q: string; answer: string }[];
}> {
  // 提货单：项目根已有上一步产物清单时带进 TASK.md（读取失败不阻断）
  let artifacts: ArtifactEntryDto[] = [];
  try {
    artifacts = await invoke<ArtifactEntryDto[]>("read_artifacts_manifest", {
      repoPath: projectPath,
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
  // 已定方向：答案存在任务书草稿里，拼装时读出来渲染成一段（读失败只是不带这段，不阻断开步）
  let decisions: { q: string; answer: string }[] = [];
  try {
    const d = await invoke<{ relPath: string; text: string | null }>(
      "read_task_draft",
      { projectRoot: projectPath, stepName: step.name },
    );
    decisions = orderedAnswers(
      step.decisions ?? [],
      parseDecisions(d?.text ?? ""),
    );
  } catch {
    /* 草稿不可读时跳过「已定方向」段 */
  }
  return { artifacts, skillMeta, decisions };
}

/** 只读预览用的一步到位拼装（步骤级「预览 TASK.md」入口）：与开工落盘同一出处
 *  （gatherTaskMdExtras + renderTaskMd），禁复制第二份拼装逻辑 */
export async function buildTaskMdPreview(
  projectPath: string,
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
): Promise<string> {
  const { artifacts, skillMeta, decisions } = await gatherTaskMdExtras(
    projectPath,
    step,
  );
  return renderTaskMd(step, cfg, projectPath, artifacts, skillMeta, decisions);
}

/** 一键开步共享链路（§11.3 机制三）：ensure git → bootstrap 提交 → 建工作区 → 简报落成 TASK.md →
 *  run 脚本写入 → onOpenTerminal 预填启动。开工确认弹层与评审覆盖层「开始下一步」共用；
 *  组件态（starting/刷新）由调用方自持。硬失败抛错，best-effort 子步骤失败只经 onError 提示 */
export async function startPipelineStep({
  projectPath,
  step,
  cfg,
  taskMdOverride,
  onError,
  onOpenTerminal,
}: {
  projectPath: string;
  step: ProjectStepDto;
  cfg: ProjectConfigDto;
  /** 开工确认弹层编辑区的最终内容（人编辑后的定稿）：非空时覆盖默认拼装，
      写盘仍是 write_workspace_task_md 单一路径 */
  taskMdOverride?: string;
  onError: (msg: string) => void;
  /** 开步完成后的终端交接；实现负责跳终端页并预填首条指令 */
  onOpenTerminal: (
    ws: WorkspaceDto,
    initialPrompt?: string,
  ) => void | Promise<void>;
}): Promise<void> {
  try {
    await invoke<EnsureGitDto>("ensure_git_repo", { path: projectPath });
  } catch (reason) {
    // git 缺失（如 macOS 新机未装 CLT）：走调用方既有错误面提示后中止开步，
    // 不再抛——错误串原样透出（isGitMissingError 可识别，诊断区/改动面板有一键安装）
    const msg = String(reason);
    if (isGitMissingError(msg)) {
      onError(msg);
      return;
    }
    throw reason;
  }
  // 档案卡/gitignore 自动提交为 best-effort（沿用 TASK.md 同款模式）：
  // git init 后 .ccode 与 .gitignore 未跟踪会被工作区合并的「主文件夹里还有没保存的改动」拦截；
  // 后端只提交这两个 Ccode 自有路径，用户文件绝不纳入，失败不阻断开步
  try {
    await invoke<BootstrapCommitDto>("commit_project_bootstrap", {
      repoPath: projectPath,
    });
  } catch (reason) {
    onError(`档案卡自动提交失败（不影响开步）：${String(reason)}`);
  }
  const ws = await invoke<WorkspaceDto>("create_workspace", {
    repoPath: projectPath,
    name: step.workspaceName,
  });
  // TASK.md 为 best-effort：write_workspace_task_md 是 P1b 的最小后端补充，
  // 命令就绪前失败不阻断开步，简报仍可在 project.toml 与步骤「编辑简报」中查看。
  // taskMdOverride（开工确认弹层编辑区定稿）非空时覆盖默认拼装；否则按模板现拼
  let content: string;
  if (taskMdOverride?.trim()) {
    content = taskMdOverride;
  } else {
    const { artifacts, skillMeta, decisions } = await gatherTaskMdExtras(
      projectPath,
      step,
    );
    content = renderTaskMd(
      step,
      cfg,
      projectPath,
      artifacts,
      skillMeta,
      decisions,
    );
  }
  try {
    await invoke("write_workspace_task_md", {
      worktreePath: ws.worktreePath,
      content,
    });
  } catch (reason) {
    onError(`工作区「${ws.name}」已创建，TASK.md 写入失败：${String(reason)}`);
  }
  // 步骤预设的 run 脚本（P4 quarto 渲染等）落进项目层 .ccode/settings.toml：
  // 同名覆盖、其余键保留；best-effort 失败不阻断开步
  if (step.run.length > 0) {
    try {
      await invoke("upsert_project_run_scripts", {
        repoPath: projectPath,
        scripts: step.run,
      });
    } catch (reason) {
      onError(
        `工作区「${ws.name}」已创建，run 脚本写入失败：${String(reason)}`,
      );
    }
  }
  // 预填首条指令：跳到终端后用户确认配置点「启动」即自动注入，无需手动打字
  await onOpenTerminal(ws, DEFAULT_KICKOFF_PROMPT);
}

/** 工作区 → 终端的交接 payload：取端口段 env + 预填该目录上次使用的配置
 *  （与工作区页 useOpenInTerminal 同一语义；`ccode.wsLast.<worktreePath>` 为共享键）。
 *  始终带 reuseKey：同一工作区永远回到同一个终端标签（开工起的标签之后「去终端」能找回）。
 *  无 initialPrompt（「去终端看看」等纯查看入口）时自动 resume 该工作区最近会话——
 *  保持一个对话，而不是每次新开；有 prompt（开工/整理笔记）时是明确的新任务，不 resume */
export async function buildWorkspaceTerminalRequest(
  ws: WorkspaceDto,
  initialPrompt?: string,
): Promise<PendingTerminal> {
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
  const resume = initialPrompt ? null : await latestWorkspaceSession(ws);
  return {
    cwd: ws.worktreePath,
    extraEnv: Object.fromEntries(pairs),
    title: ws.name,
    // resume 命中时以会话的 agent 为准（TerminalPage 的 resume 分支会自选 profile/model）；
    // 未命中按该目录上次使用的配置预填
    agentId: resume?.agentId ?? last.agentId,
    profileId: resume ? undefined : last.profileId,
    model: resume ? undefined : last.model,
    resume: resume ?? undefined,
    initialPrompt,
    reuseKey: workspaceReuseKey(ws),
  };
}

/** 工作区终端的复用键：开工/去终端/评审「开始下一步」共用同一口径 */
export function workspaceReuseKey(ws: WorkspaceDto): string {
  return `ws:${ws.worktreePath}`;
}

/** 该工作区最近一次的会话（resume 用）：纯筛选逻辑在 workspace-resume.ts（可测）。
 *  列表失败降级为不 resume（仍新开标签），不阻断「去终端」 */
async function latestWorkspaceSession(
  ws: WorkspaceDto,
): Promise<{ agentId: string; sessionId: string } | null> {
  try {
    const sessions = await invoke<SessionMetaDto[]>("list_sessions");
    return pickWorkspaceResume(sessions, ws.name, ws.repoPath);
  } catch {
    return null;
  }
}
