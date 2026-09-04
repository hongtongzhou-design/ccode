/**
 * 开步确认弹层：上一步接到的输入芯片。纯展示，不碰文件系统。
 * 计数语义：included.md = 篇；notes = 份；其余 = 个。
 */

export type KickoffInputRole = "required" | "optional" | "any";

export interface KickoffInputChip {
  pattern: string;
  role: KickoffInputRole;
  present: boolean;
  count: number;
  previewPath?: string | null;
}

export function chipFileName(pattern: string): string {
  const n = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = n.split("/").filter(Boolean);
  const base = parts.pop() ?? n;
  if (base === "*" || base.startsWith("*.")) {
    return parts.length > 0 ? `${parts[parts.length - 1]}/` : base;
  }
  return base;
}

export function formatKickoffChip(chip: KickoffInputChip): {
  label: string;
  missing: boolean;
} {
  const base = chipFileName(chip.pattern);
  if (!chip.present || chip.count <= 0) {
    return { label: `${base} · 还没有`, missing: true };
  }
  const unit = unitForPattern(chip.pattern);
  if (chip.count === 1 && unit === "个" && !chip.pattern.includes("*")) {
    return { label: base, missing: false };
  }
  return { label: `${base} · ${chip.count} ${unit}`, missing: false };
}

function unitForPattern(pattern: string): string {
  const p = pattern.replace(/\\/g, "/").toLowerCase();
  if (p.endsWith("included.md") || p.includes("papers/")) return "篇";
  if (p.includes("notes")) return "份";
  return "个";
}

export function expectedDeliverNames(expected: readonly string[]): string[] {
  return expected.map(chipFileName).filter(Boolean);
}

export function expectedDeliverLine(expected: readonly string[]): string {
  const names = expectedDeliverNames(expected);
  if (names.length === 0) return "按任务书交付本步产物";
  return `本步要交：${names.join("、")}`;
}
