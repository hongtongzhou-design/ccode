/** 步骤卡上的报告自述：质量状态和未决标记计数。不是系统认证。 */

export interface StepEvidenceSummary {
  status: string | null;
  unverified: number;
  pending: number;
}

const STATUS =
  /质量状态[：:\s]*\**\s*(已生成待审|有条件接受(?:（[^）]*）)?|证据通过(?:（[^）]*）)?|阻塞)/;

export function stepEvidenceSummary(text: string): StepEvidenceSummary {
  return {
    status: text.match(STATUS)?.[1] ?? null,
    unverified: text.match(/\[待核实\]/g)?.length ?? 0,
    pending: text.match(/\[待确认\]/g)?.length ?? 0,
  };
}

export function stepEvidenceLabel(summary: StepEvidenceSummary): string | null {
  const parts: string[] = [];
  if (summary.status) parts.push(summary.status);
  if (summary.unverified > 0) parts.push(`待核实 ${summary.unverified}`);
  if (summary.pending > 0) parts.push(`待确认 ${summary.pending}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
