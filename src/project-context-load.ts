import { invoke } from "@tauri-apps/api/core";
import type { DirEntryDto } from "./components/FileTree";
import {
  renderProjectContextPack,
  type ContextPackEntry,
} from "./project-context";
import type { ProjectConfigReadDto } from "./types";

/** 读档案卡和顶层目录，拼启动用的环境说明。失败时仍返回能用的短包。 */
export async function loadProjectContextPack(input: {
  name: string;
  path: string;
  workMode?: string | null;
  goal?: string | null;
  writeReview?: boolean;
}): Promise<string> {
  let topic: string | null = null;
  let settings: string[] = [];
  let topLevel: ContextPackEntry[] = [];
  try {
    const read = await invoke<ProjectConfigReadDto>("read_project_config", {
      path: input.path,
    });
    topic = read.config.topic ?? null;
    settings = read.config.settings ?? [];
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
  return renderProjectContextPack({
    name: input.name,
    path: input.path,
    workMode: input.workMode,
    topic,
    settings,
    topLevel,
    goal: input.goal,
    writeReview: input.writeReview,
  });
}
