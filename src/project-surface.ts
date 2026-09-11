export type ProjectSurfaceTab =
  | "chats"
  | "tasks"
  | "schedules"
  | "files"
  | "agents";

export const DEFAULT_PROJECT_SURFACE_TAB: ProjectSurfaceTab = "tasks";

export function projectTaskLabel(workMode: string | null | undefined): string {
  if (workMode === "coding") return "编程任务";
  if (workMode === "office") return "工作任务";
  return "科研任务";
}

export function projectSurfaceTabsForMode(
  _workMode: string | null | undefined,
): ProjectSurfaceTab[] {
  return ["chats", "tasks", "schedules", "files", "agents"];
}

export function normalizeProjectSurfaceTab(
  value: string | null | undefined,
  workMode?: string | null,
): ProjectSurfaceTab {
  const tabs = projectSurfaceTabsForMode(workMode);
  return tabs.includes(value as ProjectSurfaceTab)
    ? (value as ProjectSurfaceTab)
    : DEFAULT_PROJECT_SURFACE_TAB;
}

export function projectSurfaceStorageKey(projectPath: string): string {
  return `ccode.projectSurface.${projectPath}`;
}

export function readProjectSurfaceTab(
  projectPath: string,
  storage?: Pick<Storage, "getItem">,
  workMode?: string | null,
): ProjectSurfaceTab {
  try {
    return normalizeProjectSurfaceTab(
      (storage ?? window.localStorage).getItem(projectSurfaceStorageKey(projectPath)),
      workMode,
    );
  } catch {
    return DEFAULT_PROJECT_SURFACE_TAB;
  }
}
