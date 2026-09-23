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
} | null {
  const base = chipFileName(chip.pattern);
  if (!chip.present || chip.count <= 0) {
    if (chip.role !== "required") return null;
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

/** 这一步自己要交的文件，不是上一步该已经有的输入。 */
export function isOwnDeliverable(pattern: string, expected: readonly string[]): boolean {
  const name = chipFileName(pattern);
  return expectedDeliverNames(expected).includes(name);
}

/** 文件是否已经是本步骤声明要读的输入（含可选 / 任一组）。
 *  开工弹层「未登记」提醒不该再把这些文件当成陌生发现——上面「上一步接到」已经点过名。 */
export function isDeclaredStepInput(
  relPath: string,
  step: {
    inputs?: string[];
    optionalInputs?: string[];
    anyOfInputs?: string[][];
  },
): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) return false;
  const patterns = [
    ...(step.inputs ?? []),
    ...(step.optionalInputs ?? []),
    ...((step.anyOfInputs ?? []).flat()),
  ]
    .map((x) => x.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const base = path.split("/").pop() ?? path;
  return patterns.some(
    (pattern) =>
      matchesInputPattern(path, pattern) || matchesInputPattern(base, pattern),
  );
}

function matchesInputPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    const dir = pattern.replace(/\/+$/, "");
    return value === dir || value.startsWith(`${dir}/`);
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
}

/** 文件是否被流水线任一步骤接管过（声明输入 或 预期产物）。
 *  「未登记」提醒只该抓陌生文件：检索步按技能直写 papers/ 的开放获取 PDF 不写档案卡，
 *  只在精读步声明为可选输入——排除口径若只看本步骤，到综述大纲这类后续步骤会整批
 *  重新冒出来当「陌生发现」（2026-09-19 由「本步骤声明输入」延伸为全流水线口径）。 */
export function isFlowDeclaredPath(
  relPath: string,
  steps: readonly {
    inputs?: string[];
    optionalInputs?: string[];
    anyOfInputs?: string[][];
    expectedArtifacts?: string[];
  }[],
): boolean {
  const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) return false;
  const base = path.split("/").pop() ?? path;
  for (const step of steps) {
    if (isDeclaredStepInput(relPath, step)) return true;
    for (const pattern of step.expectedArtifacts ?? []) {
      const p = pattern.trim().replace(/\\/g, "/");
      if (p && (matchesInputPattern(path, p) || matchesInputPattern(base, p))) {
        return true;
      }
    }
  }
  return false;
}
