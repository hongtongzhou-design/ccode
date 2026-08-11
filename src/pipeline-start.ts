import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_KICKOFF_PROMPT,
  RESOURCE_TYPE_LABELS,
} from "./pipeline-presets";
import type { PendingTerminal } from "./store";
import type {
  ArtifactEntryDto,
  BootstrapCommitDto,
  EnsureGitDto,
  ProjectConfigDto,
  ProjectStepDto,
  SkillDto,
  WorkspaceDto,
} from "./types";

/** TASK.md 内容：标题 + 课题主题（非空时） + 简报 + 任务简报（定稿，可选） + 预期产物 + 推荐技能 + 项目资源（步骤有资源绑定时只列绑定项，一键开步落成工作区）。
 *  一键开步（ProjectGroup / 评审「开始下一步」）与 TerminalPage 的「整理为笔记」开步链路共用，保持各处 TASK.md 一致。
 *  artifacts 为项目根提货单（上一步产物），非空时在「项目资源」后追加提货单段。
 *  skillMeta 为技能库元数据（name → 一句话描述）：步骤 skills 非空时渲染「本步骤推荐技能」段；
 *  缺省（库读取失败）时只列技能名，不误标未安装。
 *  finalBrief 为任务卡定稿简报全文（卡片「开工」带入）；缺省时零变化 */
export function renderTaskMd(
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
  projectPath: string,
  artifacts?: ArtifactEntryDto[],
  skillMeta?: Record<string, string>,
  finalBrief?: string,
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
  // 任务卡定稿简报（对话→记忆）：全文嵌入，步骤简报之后、预期产物之前
  if (finalBrief?.trim()) {
    lines.push("", "## 任务简报（定稿）", finalBrief.trim());
  }
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

/** 一键开步共享链路（§11.3 机制三）：ensure git → bootstrap 提交 → 建工作区 → 简报落成 TASK.md →
 *  run 脚本写入 → onOpenTerminal 预填启动。工作区页流水线胶囊与评审覆盖层「开始下一步」共用；
 *  组件态（starting/刷新）由调用方自持。硬失败抛错，best-effort 子步骤失败只经 onError 提示 */
export async function startPipelineStep({
  projectPath,
  step,
  cfg,
  briefPath,
  onError,
  onOpenTerminal,
}: {
  projectPath: string;
  step: ProjectStepDto;
  cfg: ProjectConfigDto;
  /** 任务卡「开工」带入的定稿简报（相对项目根）；非空时全文读入 TASK.md「任务简报（定稿）」段 */
  briefPath?: string;
  onError: (msg: string) => void;
  /** 开步完成后的终端交接；实现负责跳终端页并预填首条指令 */
  onOpenTerminal: (
    ws: WorkspaceDto,
    initialPrompt?: string,
  ) => void | Promise<void>;
}): Promise<void> {
  await invoke<EnsureGitDto>("ensure_git_repo", { path: projectPath });
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
  // 命令就绪前失败不阻断开步，简报仍可在 project.toml 与步骤「编辑简报」中查看
  // 提货单：项目根已有上一步产物清单时带进 TASK.md（读取失败同样不阻断）
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
  // 任务卡定稿简报：best-effort 读入全文（简报在项目根内，read_file_preview 根约束放行）；
  // 读取失败不阻断开步，TASK.md 只少定稿段
  let finalBrief: string | undefined;
  if (briefPath) {
    try {
      const abs = `${projectPath.replace(/[\\/]+$/, "")}/${briefPath}`;
      const preview = await invoke<{ text: string; truncated: boolean }>(
        "read_file_preview",
        { path: abs, root: projectPath },
      );
      finalBrief = preview.text;
    } catch (reason) {
      onError(`定稿简报读取失败（不影响开步）：${String(reason)}`);
    }
  }
  try {
    await invoke("write_workspace_task_md", {
      worktreePath: ws.worktreePath,
      content: renderTaskMd(step, cfg, projectPath, artifacts, skillMeta, finalBrief),
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
 *  （与工作区页 useOpenInTerminal 同一语义；`ccode.wsLast.<worktreePath>` 为共享键） */
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
  return {
    cwd: ws.worktreePath,
    extraEnv: Object.fromEntries(pairs),
    title: ws.name,
    agentId: last.agentId,
    profileId: last.profileId,
    model: last.model,
    initialPrompt,
  };
}
