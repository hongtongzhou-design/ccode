/**
 * 编程车道覆盖层纯逻辑：有树无 Lane 时按分支名现算；按 theme 分组。
 */
import { pathWithin, samePath } from "./path-utils.ts";

export interface LaneOverlay {
  id: string | null;
  name: string;
  theme: string | null;
  branch: string;
  worktreePath: string;
}

export function overlayLanes<
  T extends { path: string; branch: string; isPrimary: boolean },
>(
  trees: readonly T[],
  lanes: readonly {
    id: string;
    name: string;
    theme: string | null;
    branch: string;
    worktreePath: string;
  }[],
  isWindows = false,
): (T & { lane: LaneOverlay })[] {
  return trees.map((t) => {
    const hit = lanes.find((l) => samePath(l.worktreePath, t.path, isWindows));
    return {
      ...t,
      lane: hit
        ? {
            id: hit.id,
            name: hit.name || t.branch,
            theme: hit.theme,
            branch: hit.branch || t.branch,
            worktreePath: hit.worktreePath,
          }
        : {
            id: null,
            name: t.branch || "（无分支）",
            theme: null,
            branch: t.branch,
            worktreePath: t.path,
          },
    };
  });
}

export function groupLanesByTheme<T extends { isPrimary: boolean; lane: LaneOverlay }>(
  items: readonly T[],
): { theme: string | null; label: string; items: T[] }[] {
  const primary = items.filter((i) => i.isPrimary);
  const rest = items.filter((i) => !i.isPrimary);
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const item of rest) {
    const key = item.lane.theme?.trim() || "";
    if (!buckets.has(key)) {
      order.push(key);
      buckets.set(key, []);
    }
    buckets.get(key)!.push(item);
  }
  const groups: { theme: string | null; label: string; items: T[] }[] = [];
  if (primary.length > 0) {
    groups.push({ theme: null, label: "主仓", items: primary });
  }
  for (const key of order) {
    groups.push({
      theme: key || null,
      label: key || "未分组",
      items: buckets.get(key) ?? [],
    });
  }
  return groups;
}

export function lastLaneTheme(
  lanes: readonly { theme: string | null }[],
): string {
  for (let i = lanes.length - 1; i >= 0; i--) {
    const t = lanes[i]?.theme?.trim();
    if (t) return t;
  }
  return "";
}

/** 这棵树上是否有正在跑 / 等确认的 Agent；否则「空闲」。 */
export function laneActivityLabel(
  worktreePath: string,
  runs: readonly {
    cwd: string;
    agentId: string;
    running: boolean;
    attention?: "done" | "working" | "confirm" | null;
  }[],
  isWindows = false,
): string {
  const hit = runs.find(
    (r) =>
      (r.running || r.attention === "confirm") &&
      (samePath(r.cwd, worktreePath, isWindows) ||
        pathWithin(r.cwd, worktreePath, isWindows)),
  );
  const id = hit?.agentId?.trim();
  return id || "空闲";
}
