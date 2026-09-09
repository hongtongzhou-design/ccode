import { officeDocKind, normalizeWorkMode } from "./work-mode.ts";
import { normSep } from "./path-utils.ts";

export type GoalReviewMode = "research" | "office";

export type ReviewChange = { path: string; kind: string };

export type ReviewGroup = {
  id: string;
  label: string;
  items: ReviewChange[];
};

export type GoalReviewCopy = {
  modalTitle: string;
  pickLabel: string;
  hint: string;
  empty: string;
  continueLabel: string;
  continuePlaceholder: string;
  acceptEmpty: string;
  acceptSome: (count: number) => string;
  cardAction: string;
  writeTab: string;
  bucketReview: string;
  outputWriteback: string;
  chatWriteReview: string;
  workbenchWaiting: string;
  timelineAccepted: string;
  fileMark: string;
  rememberLine: string;
};

const RESEARCH: GoalReviewCopy = {
  modalTitle: "验收产物",
  pickLabel: "写进项目",
  hint: "勾选要留下的",
  empty: "没有新的产物。",
  continueLabel: "带着意见再出一版",
  continuePlaceholder: "例如：引用太少，补上 Agentic Coding。",
  acceptEmpty: "不带回产物，完成",
  acceptSome: (count) => `接受 ${count} 项`,
  cardAction: "验收产物",
  writeTab: "写入并验收产物",
  bucketReview: "待验收产物",
  outputWriteback: "验收后写入项目",
  chatWriteReview: "验收后写入",
  workbenchWaiting: "等待验收产物",
  timelineAccepted: "已接受",
  fileMark: "待验收产物",
  rememberLine: "接受后，下次开工会带上这些路径。",
};

const OFFICE: GoalReviewCopy = {
  modalTitle: "验收文档",
  pickLabel: "写进项目",
  hint: "勾选要留下的文档",
  empty: "没有新的文档。",
  continueLabel: "带着意见再出一版",
  continuePlaceholder: "例如：改成公司模板，数字放到附件。",
  acceptEmpty: "不带回文档，完成",
  acceptSome: (count) => `采纳 ${count} 份`,
  cardAction: "验收文档",
  writeTab: "写入并验收文档",
  bucketReview: "待验收文档",
  outputWriteback: "验收后写入文档",
  chatWriteReview: "验收后写入",
  workbenchWaiting: "等待验收文档",
  timelineAccepted: "已采纳",
  fileMark: "待验收文档",
  rememberLine: "接受后，下次开工会带上这些文档。",
};

export function goalReviewMode(workMode?: string | null): GoalReviewMode | null {
  const mode = normalizeWorkMode(workMode);
  if (mode === "coding") return null;
  return mode === "office" ? "office" : "research";
}

export function goalReviewCopy(workMode?: string | null): GoalReviewCopy {
  return goalReviewMode(workMode) === "office" ? OFFICE : RESEARCH;
}

const RESEARCH_GROUP_ORDER = [
  "literature",
  "notes",
  "data",
  "paper",
  "cite",
  "other",
] as const;

const RESEARCH_GROUP_LABEL: Record<(typeof RESEARCH_GROUP_ORDER)[number], string> = {
  literature: "文献",
  notes: "笔记",
  data: "数据",
  paper: "论文",
  cite: "引用",
  other: "其他",
};

function firstSegment(path: string): string {
  return normSep(path).replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
}

export function researchReviewGroup(
  path: string,
): (typeof RESEARCH_GROUP_ORDER)[number] {
  const relative = normSep(path).toLowerCase();
  const top = firstSegment(relative);
  if (["papers", "文献", "paper"].includes(top)) return "literature";
  if (["notes", "笔记"].includes(top)) return "notes";
  if (["data", "数据", "cleaning", "results", "figures"].includes(top)) {
    return "data";
  }
  if (["manuscript", "论文", "output", "outputs"].includes(top)) return "paper";
  if (relative.endsWith(".bib") || relative.endsWith(".ris") || top === "references") {
    return "cite";
  }
  if (relative.endsWith(".pdf")) return "literature";
  if (relative.endsWith(".tex") || relative.endsWith(".qmd")) return "paper";
  return "other";
}

const OFFICE_GROUP_ORDER = ["doc", "sheet", "slide", "pdf", "image", "other"] as const;

const OFFICE_GROUP_LABEL: Record<(typeof OFFICE_GROUP_ORDER)[number], string> = {
  doc: "文档",
  sheet: "表格",
  slide: "幻灯",
  pdf: "PDF",
  image: "图片",
  other: "其他",
};

export function groupReviewChanges(
  workMode: string | null | undefined,
  changes: readonly ReviewChange[],
): ReviewGroup[] {
  if (goalReviewMode(workMode) === "office") {
    const buckets: Record<string, ReviewChange[]> = {};
    for (const id of OFFICE_GROUP_ORDER) buckets[id] = [];
    for (const change of changes) {
      buckets[officeDocKind(change.path)].push(change);
    }
    return OFFICE_GROUP_ORDER.filter((id) => buckets[id].length > 0).map((id) => ({
      id,
      label: OFFICE_GROUP_LABEL[id],
      items: buckets[id],
    }));
  }
  const buckets: Record<string, ReviewChange[]> = {};
  for (const id of RESEARCH_GROUP_ORDER) buckets[id] = [];
  for (const change of changes) {
    buckets[researchReviewGroup(change.path)].push(change);
  }
  return RESEARCH_GROUP_ORDER.filter((id) => buckets[id].length > 0).map((id) => ({
    id,
    label: RESEARCH_GROUP_LABEL[id],
    items: buckets[id],
  }));
}

export function goalReviewFacts(input: {
  workMode?: string | null;
  agentLabel?: string | null;
  runCount: number;
  changes: readonly ReviewChange[];
  feedback?: string | null;
}): string[] {
  const lines: string[] = [];
  const agent = input.agentLabel?.trim();
  if (agent) lines.push(`Agent：${agent}`);
  if (input.runCount > 1) lines.push(`第 ${input.runCount} 版`);
  else if (input.runCount === 1) lines.push("第一次生成");
  const groups = groupReviewChanges(input.workMode, input.changes);
  if (groups.length === 0) {
    lines.push(goalReviewMode(input.workMode) === "office" ? "没有文档改动" : "没有产物改动");
  } else {
    lines.push(groups.map((group) => `${group.label} ${group.items.length}`).join(" · "));
  }
  const feedback = input.feedback?.trim();
  if (feedback) lines.push(`上一版意见：${feedback}`);
  return lines;
}

/** 编程不走目标验收弹层，验收是改动面板 / 合进基准 / PR。 */
export function codingReviewHint(): string {
  return "编程的验收在工作树：查看改动，合进基准或开 Pull Request。";
}

export function isCodingWorkMode(workMode?: string | null): boolean {
  return normalizeWorkMode(workMode) === "coding";
}
