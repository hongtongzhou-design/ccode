/**
 * 科研步骤评审档案：一张审阅壳，按类型拼区块。
 * 闭集 screening / files / acceptance / default，禁止每步一张独立评审页。
 */

import {
  isScreeningReviewStep,
  shouldPrioritizeScreeningFiles,
} from "./screening-review.ts";
import { deliveryFileGroup, manuscriptPreviewRank } from "./review-file-groups.ts";

export type StepReviewKind = "screening" | "files" | "acceptance" | "default";

export interface StepReviewProfile {
  kind: StepReviewKind;
  /** 顶栏文件行附注；空则走 Git 分支统计 */
  headerHint: string | null;
  groupFiles: boolean;
  hideListDiffs: boolean;
  evidence: "screening" | "report" | "none";
  acceptance: "screening" | "default" | "none";
  showReproduction: boolean;
  showReportDisclaimer: boolean;
}

export const STEP_REVIEW_PROFILES: Record<StepReviewKind, StepReviewProfile> = {
  screening: {
    kind: "screening",
    headerHint: null,
    groupFiles: true,
    hideListDiffs: false,
    evidence: "screening",
    acceptance: "none",
    showReproduction: false,
    showReportDisclaimer: false,
  },
  files: {
    kind: "files",
    headerHint: null,
    groupFiles: true,
    hideListDiffs: false,
    evidence: "none",
    acceptance: "none",
    showReproduction: false,
    showReportDisclaimer: true,
  },
  acceptance: {
    kind: "acceptance",
    headerHint: null,
    groupFiles: true,
    hideListDiffs: false,
    evidence: "report",
    acceptance: "default",
    showReproduction: true,
    showReportDisclaimer: true,
  },
  default: {
    kind: "default",
    headerHint: null,
    groupFiles: false,
    hideListDiffs: false,
    evidence: "none",
    acceptance: "none",
    showReproduction: false,
    showReportDisclaimer: true,
  },
};

/** 实验执行 / 结果分析 / 清洗 / EDA：本步产出复现入口或质量报告，才走科研验收壳。
 *  只看 expectedArtifacts，不看 inputs——写作步会把 findings.md 当输入，不能因此变成验收页。 */
export function isAcceptanceReviewStep(step: {
  expectedArtifacts?: readonly string[] | null;
} | null): boolean {
  if (!step) return false;
  return (step.expectedArtifacts ?? []).some(isAcceptanceReviewPath);
}

function isAcceptanceReviewPath(path: string): boolean {
  const n = path.replace(/\\/g, "/").toLowerCase();
  const base = n.split("/").pop() ?? "";
  return (
    base === "reproduce.py" ||
    base === "run-manifest.json" ||
    base === "implementation-check.md" ||
    base === "findings.md" ||
    base === "results-table.md" ||
    base === "eda-report.md" ||
    base === "cleaning-report.md" ||
    n === "chapters/results.md" ||
    n.endsWith("/chapters/results.md")
  );
}

export function resolveStepReviewProfile(
  step: {
    workspaceName?: string | null;
    expectedArtifacts?: readonly string[] | null;
    inputs?: readonly string[] | null;
  } | null,
  filePaths: readonly string[] = [],
): StepReviewProfile {
  if (
    (step && isScreeningReviewStep(step)) ||
    shouldPrioritizeScreeningFiles(filePaths)
  ) {
    return STEP_REVIEW_PROFILES.screening;
  }
  if (isAcceptanceReviewStep(step)) return STEP_REVIEW_PROFILES.acceptance;
  if (step) return STEP_REVIEW_PROFILES.files;
  return STEP_REVIEW_PROFILES.default;
}

export type ReviewPane = "content" | "process" | "files";

/** 各步骤同一套顶栏页签。Git 对照只在「文件」。 */
export function reviewPaneTabs(
  kind: StepReviewKind,
  filePaths: readonly string[] = [],
): { id: ReviewPane; label: string }[] | null {
  if (kind === "default") return null;
  if (kind === "screening") {
    return [
      { id: "content", label: "清单" },
      { id: "process", label: "过程" },
      { id: "files", label: "文件" },
    ];
  }
  if (kind === "acceptance") {
    return [
      { id: "content", label: "结果" },
      { id: "process", label: "过程" },
      { id: "files", label: "文件" },
    ];
  }
  const groups = new Set(filePaths.map((path) => deliveryFileGroup(path)));
  const hasArticle = filePaths.some((path) => manuscriptPreviewRank(path) === 0);
  return [
    { id: "content", label: hasArticle || !groups.has("notes") ? "稿件" : "笔记" },
    { id: "process", label: "过程" },
    { id: "files", label: "文件" },
  ];
}
