import type { HumanTaskDto } from "./types";

export type HumanCompletion = NonNullable<HumanTaskDto["completion"]>;

export const HUMAN_COMPLETION_LABELS: Record<HumanCompletion, string> = {
  exists: "出现即检测",
  manual: "必须人工确认",
  all: "全部目标满足",
  no_placeholders: "清除占位后完成",
};

function isSupportedWildcardTarget(target: string): boolean {
  const rel = target.replace(/\\/g, "/");
  if (!rel || rel.endsWith("/") || rel.includes("..")) return false;
  if (/^(?:[A-Za-z]:\/|\/)/.test(rel)) return false;
  const slash = rel.lastIndexOf("/");
  const directory = slash >= 0 ? rel.slice(0, slash) : "";
  const pattern = slash >= 0 ? rel.slice(slash + 1) : rel;
  // 后端只支持「目录/末段通配」，不支持跨目录的 `*`。
  return pattern.includes("*") && !directory.includes("*");
}

/**
 * 完成判定与落点的兼容关系：
 * - `all` 需要一个后端支持的末段通配落点；
 * - `no_placeholders` 需要读取单个文本文件，不能用于目录/通配；
 * - `exists` 与 `manual` 对所有落点都有效。
 */
export function isCompletionCompatible(
  target: string,
  completion: HumanCompletion,
): boolean {
  const rel = target.trim();
  if (completion === "manual") return true;
  if (completion === "exists") return rel.length > 0;
  if (completion === "all") return isSupportedWildcardTarget(rel);
  return rel.length > 0 && !rel.includes("*") && !/[\\/]$/.test(rel);
}

/** 旧配置或用户改了落点后，避免保存一个后端永远判不完的组合。 */
export function normalizeCompletion(
  target: string,
  completion: HumanCompletion | undefined,
): HumanCompletion {
  const value = completion ?? (target.trim() ? "exists" : "manual");
  return isCompletionCompatible(target, value) ? value : "exists";
}

export function completionOptionsForTarget(
  target: string,
): { value: HumanCompletion; label: string }[] {
  return (["exists", "manual", "all", "no_placeholders"] as const)
    .filter((value) => isCompletionCompatible(target, value))
    .map((value) => ({ value, label: HUMAN_COMPLETION_LABELS[value] }));
}
