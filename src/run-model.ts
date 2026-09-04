/**
 * Project → Task → Run 的前端纯逻辑（与 runs.rs 双端镜像）。
 * 工作台「正在进行」只列交互活；无头不进主卡。
 */

export type RunTaskKind =
  | "pipeline_step"
  | "coding_lane"
  | "office_doc"
  | "watch"
  | "reader"
  | "scratch"
  | "login";

export function inferTaskKind(
  reuseKey: string | undefined,
  isolationPath: string,
): RunTaskKind {
  const key = reuseKey?.trim() ?? "";
  if (key.startsWith("login:")) return "login";
  if (key.startsWith("reader:")) return "reader";
  if (key.startsWith("watch:")) return "watch";
  if (key.startsWith("office:")) return "office_doc";
  if (key.startsWith("ws:")) return "pipeline_step";
  if (key.startsWith("wt:") || key.startsWith("lane:")) return "coding_lane";
  if (key.startsWith("coding:")) return "coding_lane";
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
  const key = reuseKey?.trim() ?? "";
  return (
    key.startsWith("ws:") ||
    key.startsWith("lane:") ||
    key.startsWith("wt:") ||
    key.startsWith("office:") ||
    key.startsWith("reader:") ||
    key.startsWith("custom:") ||
    key.startsWith("research:") ||
    key.startsWith("coding:")
  );
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
  const key = input.reuseKey?.trim() ?? "";
  if (key.startsWith("login:")) return false;
  if (key.startsWith("watch:") || key.startsWith("headless:")) return false;
  if (inferTaskKind(input.reuseKey, "") === "watch") return false;
  if (isTaskReuseKey(key)) return true;
  return Boolean(input.running || input.attention === "confirm");
}
