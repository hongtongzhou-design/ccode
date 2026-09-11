export interface UpstreamAcceptance {
  stepName: string; verdict: string; conclusionScope: string; openBlockers: string[];
  createdAt: string; resultVersion: string | null; valid: boolean; changedFiles: string[];
}
export function upstreamAcceptanceNote(row: UpstreamAcceptance): string {
  return `${row.stepName}（${row.createdAt}；${row.resultVersion ?? "未记录版本"}）：${row.conclusionScope}${row.openBlockers.length ? `；未关闭：${row.openBlockers.join("；")}` : ""}`;
}
export function appendUpstreamAcceptance(text: string, rows: UpstreamAcceptance[]): string {
  const start = "<!-- mesa-upstream-acceptance -->";
  const end = "<!-- /mesa-upstream-acceptance -->";
  const at = text.indexOf(start), tail = text.indexOf(end, at);
  if (at >= 0 && tail >= at) text = text.slice(0, at).trimEnd() + text.slice(tail + end.length);
  if (!rows.length) return text;
  return `${text.trimEnd()}\n\n${start}\n## 上游科研验收（非本步自动授权）\n` + rows.map((r) =>
    `- ${r.valid ? r.verdict === "accept" ? "证据文件版本一致，认可范围" : r.verdict === "accept_with_conditions" ? "有条件接受，仅可准备" : "已退回，不可沿用结论" : "依据缺失或已变化，必须复核"}：${upstreamAcceptanceNote(r)}${r.changedFiles.length ? `；变化：${r.changedFiles.join("、")}` : ""}`
  ).join("\n") + `\n以上只带入既有人的决定与证据版本，不替代本步的问题、权限或正式执行批准。\n${end}\n`;
}
