import { normSep, stripVerbatim } from "./path-utils.ts";

export type TaskPermission = "discuss" | "write_tree";

/** 人声明的资料范围：空副本 / 勾选路径 / 整个项目。禁止静默默认成整个项目。 */
export type TaskMaterialScope = "none" | "selected" | "whole";

export function pruneNestedPaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  for (const raw of paths) {
    const path = normSep(raw).replace(/^\/+|\/+$/g, "");
    if (!path || unique.includes(path)) continue;
    unique.push(path);
  }
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const path of unique) {
    if (path === ".") return ["."];
    const covered = kept.some(
      (parent) => parent === "." || path === parent || path.startsWith(`${parent}/`),
    );
    if (!covered) kept.push(path);
  }
  return kept;
}

export function pathCoveredBySelection(
  relative: string,
  selected: readonly string[],
): boolean {
  const path = normSep(relative).replace(/\/+$/, "");
  if (!path) return selected.includes(".");
  return selected.some((item) => {
    const parent = normSep(item).replace(/\/+$/, "");
    return parent === "." || path === parent || path.startsWith(`${parent}/`);
  });
}

export function toggleTaskMaterialPath(
  selected: readonly string[],
  relative: string,
  checked: boolean,
): string[] {
  const path = normSep(relative).replace(/^\/+|\/+$/g, "");
  if (!path || path === ".") return [...selected];
  if (checked) {
    const withoutDescendants = selected.filter(
      (item) => item !== path && !normSep(item).startsWith(`${path}/`),
    );
    if (pathCoveredBySelection(path, withoutDescendants)) return withoutDescendants;
    return pruneNestedPaths([...withoutDescendants, path]);
  }
  return selected.filter((item) => item !== path);
}

export function taskPathsForScope(
  scope: TaskMaterialScope,
  selectedPaths: readonly string[],
  permission: TaskPermission,
): { inputPaths: string[]; outputPaths: string[]; error: string | null } {
  const outputPaths = permission === "write_tree" ? ["."] : [];
  if (scope === "none") {
    return { inputPaths: [], outputPaths, error: null };
  }
  if (scope === "whole") {
    return { inputPaths: ["."], outputPaths, error: null };
  }
  const inputPaths = pruneNestedPaths(selectedPaths.filter((path) => path !== "."));
  if (inputPaths.length === 0) {
    return {
      inputPaths: [],
      outputPaths: [],
      error: "请勾选要带入这一步的文件或目录",
    };
  }
  return { inputPaths, outputPaths, error: null };
}

export function canSubmitDeclaredTask(input: {
  name: string;
  scope: TaskMaterialScope;
  selectedPaths: readonly string[];
  profileId: string;
  permission: TaskPermission;
}): boolean {
  if (!input.name.trim() || !input.profileId) return false;
  return taskPathsForScope(input.scope, input.selectedPaths, input.permission).error === null;
}

/** 会话/开步自动登记的 Task 常用绝对路径当名称；人声明的步骤不会。 */
export function isDeclaredTaskName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  if (trimmed.startsWith("\\\\")) return false;
  return true;
}

export function isDeclaredTask(task: { declared?: boolean; name: string }): boolean {
  if (task.declared === true) return true;
  if (task.declared === false) return false;
  return isDeclaredTaskName(task.name);
}

export function visibleDeclaredTasks<T extends { kind: string; name: string; declared?: boolean }>(
  tasks: readonly T[],
  kinds: ReadonlySet<string>,
): T[] {
  return tasks.filter((task) => kinds.has(task.kind) && isDeclaredTask(task));
}

export function declaredTaskKindsForMode(
  workMode: string | null | undefined,
): Set<string> {
  if (workMode === "office") return new Set(["office_doc"]);
  if (workMode === "research") return new Set(["free_research"]);
  return new Set();
}

export function taskStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "进行中";
    case "pending_review":
      return "待审核";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
    default:
      return "待开始";
  }
}

export function isTaskMaterialNoise(name: string, isSystem?: boolean): boolean {
  if (isSystem) return true;
  return name === ".git" || name === ".ccode" || name === "node_modules" || name === "target";
}

export function taskInputLabel(paths: readonly string[]): string {
  if (paths.includes(".")) return "整个项目";
  return paths.length ? paths.join("、") : "不带入现有文件";
}

export function taskOutputLabel(
  paths: readonly string[],
  reviewRequired: boolean,
): string {
  if (!reviewRequired) return "只讨论，不改项目文件";
  if (paths.includes(".")) return "审核后写回项目";
  return paths.length ? `审核后写回 ${paths.join("、")}` : "审核后写回项目";
}

export function taskChangeKindLabel(kind: string): string {
  if (kind === "added") return "新增";
  if (kind === "modified") return "修改";
  return kind;
}

export function selectedChangePaths(
  changes: readonly { path: string }[],
  selected: ReadonlySet<string>,
): string[] {
  return changes.filter((change) => selected.has(change.path)).map((change) => change.path);
}

export function relativeProjectPath(root: string, path: string): string {
  const normalizedRoot = normSep(stripVerbatim(root)).replace(/\/+$/, "");
  const normalizedPath = normSep(stripVerbatim(path));
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return "";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  const rootKey = normalizedRoot.toLowerCase();
  const pathKeyValue = normalizedPath.toLowerCase();
  if (pathKeyValue.startsWith(`${rootKey}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

export function taskFileBadge(
  outputPaths: readonly string[],
  relativeFile: string,
): string | null {
  if (!relativeFile || outputPaths.includes(".")) return null;
  const file = normSep(relativeFile).replace(/\/+$/, "");
  return (
    outputPaths.find((output) => {
      const normalized = normSep(output).replace(/\/+$/, "");
      return file === normalized || file.startsWith(`${normalized}/`);
    }) ?? null
  );
}

export function joinRunPath(root: string, relative: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const rest = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  return rest ? `${base}/${rest}` : base;
}
