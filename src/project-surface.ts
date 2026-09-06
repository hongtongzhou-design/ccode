export type ProjectSurfaceTab = "tasks" | "files" | "agents";

export function projectTaskLabel(workMode: string | null | undefined): string {
  if (workMode === "coding") return "编程任务";
  if (workMode === "office") return "工作任务";
  return "科研任务";
}

export function projectSurfaceTabsForMode(
  _workMode: string | null | undefined,
): ProjectSurfaceTab[] {
  return ["tasks", "files", "agents"];
}

export function normalizeProjectSurfaceTab(
  value: string | null | undefined,
  workMode?: string | null,
): ProjectSurfaceTab {
  const tabs = projectSurfaceTabsForMode(workMode);
  return tabs.includes(value as ProjectSurfaceTab)
    ? (value as ProjectSurfaceTab)
    : tabs[0];
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
    return projectSurfaceTabsForMode(workMode)[0];
  }
}
