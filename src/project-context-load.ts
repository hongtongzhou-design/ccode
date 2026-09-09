import { invoke } from "@tauri-apps/api/core";
import type { DirEntryDto } from "./components/FileTree";
import {
  renderProjectContextPack,
  type ContextPackEntry,
  type ProjectSkillPack,
} from "./project-context";
import { acceptedGoalOutputs, isDeclaredTask } from "./project-tasks";
import type { ProjectConfigReadDto, ProjectStatusDto, SkillDto, TaskDto } from "./types";

/** 读档案卡和顶层目录，拼启动用的环境说明。失败时仍返回能用的短包。 */
export async function loadProjectContextPack(input: {
  name: string;
  path: string;
  workMode?: string | null;
  goal?: string | null;
  writeReview?: boolean;
  feedback?: string | null;
}): Promise<string> {
  let topic: string | null = null;
  let settings: string[] = [];
  let rulesOwned = false;
  let protectedPaths: string[] = [];
  let skillNames: string[] = [];
  let topLevel: ContextPackEntry[] = [];
  try {
    const read = await invoke<ProjectConfigReadDto>("read_project_config", {
      path: input.path,
    });
    topic = read.config.topic ?? null;
    settings = read.config.settings ?? [];
    rulesOwned = read.config.rulesOwned === true;
    protectedPaths = read.config.protectedPaths ?? [];
    skillNames = read.config.skills ?? [];
  } catch {
    /* 无档案卡时仍注入名称和目录 */
  }
  try {
    const entries = await invoke<DirEntryDto[]>("list_dir", {
      path: input.path,
      showHidden: false,
    });
    topLevel = entries.map((entry) => ({
      name: entry.name,
      isDir: entry.isDir,
    }));
  } catch {
    /* 列目录失败时地图为空 */
  }
  let accepted: { name: string; outputs: string[]; note?: string }[] = [];
  let openGoals: string[] = [];
  try {
    const status = await invoke<ProjectStatusDto>("read_project_status", {
      path: input.path,
    });
    accepted = (status.accepted ?? []).slice(0, 8).map((item) => ({
      name: item.name,
      outputs: item.outputs ?? [],
      note: item.note,
    }));
  } catch {
    /* 无状态文件时从目标列表回落 */
  }
  try {
    const tasks = await invoke<TaskDto[]>("task_list", { projectRoot: input.path });
    const declared = tasks.filter((task) => isDeclaredTask(task));
    if (accepted.length === 0) {
      accepted = declared
        .filter((task) => task.status === "completed")
        .slice(0, 8)
        .map((task) => ({
          name: task.name,
          outputs: acceptedGoalOutputs(task.outputPaths, task.adoptedPaths),
        }));
    }
    openGoals = declared
      .filter((task) => task.status !== "completed")
      .slice(0, 8)
      .map((task) => task.name);
  } catch {
    /* 没有目标列表时省略已验收段 */
  }
  // 项目技能：按名单顺序出库记录，带上内容版本与接口契约；库里没有的如实标「未安装」
  let skills: ProjectSkillPack[] = [];
  if (skillNames.length > 0) {
    try {
      const library = await invoke<SkillDto[]>("list_skills");
      const byName = new Map(library.map((skill) => [skill.name, skill]));
      skills = skillNames.map((name) => {
        const skill = byName.get(name);
        if (!skill) return { name, missing: true };
        return {
          name,
          description: skill.description,
          digest: skill.contentDigest ?? null,
          inputs: skill.inputs ?? [],
          outputs: skill.outputs ?? [],
        };
      });
    } catch {
      skills = skillNames.map((name) => ({ name }));
    }
  }
  return renderProjectContextPack({
    name: input.name,
    path: input.path,
    workMode: input.workMode,
    topic,
    settings,
    rulesOwned,
    topLevel,
    goal: input.goal,
    writeReview: input.writeReview,
    accepted,
    openGoals,
    protectedPaths,
    feedback: input.feedback,
    skills,
  });
}
