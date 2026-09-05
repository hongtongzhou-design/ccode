/**
 * Project → Task → Run 的前端纯逻辑（与 runs.rs 双端镜像）。
 * 工作台「正在进行」只列交互活；无头不进主卡。
 */
import { pathWithin, samePath } from "./path-utils.ts";
import type { RunDto } from "./types.ts";

export type RunTaskKind =
  | "pipeline_step"
  | "coding_lane"
  | "office_doc"
  | "watch"
  | "reader"
  | "scratch"
  | "login";

export type RunPermission = "discuss" | "write_tree";

/** 入口幂等键闭集：旧 `wt:` 升格为 `lane:`。 */
export function canonicalizeReuseKey(key: string | undefined): string {
  const t = key?.trim() ?? "";
  if (t.startsWith("wt:")) return `lane:${t.slice(3)}`;
  return t;
}

export function inferTaskKind(
  reuseKey: string | undefined,
  isolationPath: string,
): RunTaskKind {
  const key = canonicalizeReuseKey(reuseKey);
  if (key.startsWith("login:")) return "login";
  if (key.startsWith("reader:")) return "reader";
  if (key.startsWith("watch:")) return "watch";
  if (key.startsWith("office:")) return "office_doc";
  if (key.startsWith("ws:")) return "pipeline_step";
  if (key.startsWith("lane:") || key.startsWith("coding:")) return "coding_lane";
  if (key.startsWith("headless:")) return "scratch";
  const path = isolationPath.replace(/\\/g, "/");
  if (path.includes("/ccode/scratch") || path.includes("/ccode\\scratch")) {
    return "scratch";
  }
  if (path.includes("/ccode/workspaces/") || path.includes("/ccode/workspaces\\")) {
    return "pipeline_step";
  }
  if (path.includes("/ccode/worktrees/") || path.includes("/ccode/worktrees\\")) {
    return "coding_lane";
  }
  return "scratch";
}

/** 用户点开的任务标签（关了还想找回来）；登录 / 无头巡检不算。 */
export function isTaskReuseKey(reuseKey: string | undefined): boolean {
  const key = canonicalizeReuseKey(reuseKey);
  return (
    key.startsWith("ws:") ||
    key.startsWith("lane:") ||
    key.startsWith("office:") ||
    key.startsWith("reader:") ||
    key.startsWith("custom:") ||
    key.startsWith("research:") ||
    key.startsWith("coding:")
  );
}

export function isDiscussPermission(
  permission?: RunPermission | string | null,
  readonly?: boolean | null,
): boolean {
  if (permission === "discuss") return true;
  if (permission === "write_tree") return false;
  return Boolean(readonly);
}

/** 关标签后仍可从会话恢复的交互 Run：有 session、非 internal、非巡检。 */
export function pickRecoverableRun(
  runs: readonly Pick<
    RunDto,
    | "id"
    | "internal"
    | "closedAt"
    | "taskKind"
    | "sessionId"
    | "runtime"
    | "capabilities"
    | "projectRoot"
    | "isolationPath"
  >[],
  projectPath: string,
  isWindows = false,
): (typeof runs)[number] | null {
  const path = projectPath.trim();
  if (!path) return null;
  for (const run of runs) {
    if (run.internal) continue;
    if (!run.closedAt) continue;
    if (run.taskKind === "login" || run.taskKind === "watch") continue;
    if (run.runtime === "custom" || !run.capabilities.canResume) continue;
    if (!run.sessionId) continue;
    const root = run.projectRoot?.trim();
    if (root && samePath(root, path, isWindows)) return run;
    if (pathWithin(run.isolationPath, path, isWindows)) return run;
  }
  return null;
}

/**
 * 工作台「正在进行」白名单：开步 / 工作树 / 普通终端 / 还开着的阅读标签。
 * 登录、定时巡检、无头、空闲未命名 shell 不算。
 */
export function isWorkbenchSurfaceRun(input: {
  reuseKey?: string;
  shell?: boolean;
  running?: boolean;
  attention?: "done" | "working" | "confirm" | null;
}): boolean {
  const key = canonicalizeReuseKey(input.reuseKey);
  if (key.startsWith("login:")) return false;
  if (key.startsWith("watch:") || key.startsWith("headless:")) return false;
  if (inferTaskKind(key, "") === "watch") return false;
  if (isTaskReuseKey(key)) return true;
  return Boolean(input.running || input.attention === "confirm");
}
