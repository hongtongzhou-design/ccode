/**
 * 科研步骤评审档案：一张审阅壳，按类型拼区块。
 * 闭集 screening / acceptance / default，禁止每步一张独立评审页。
 */

import {
  isScreeningReviewStep,
  shouldPrioritizeScreeningFiles,
} from "./screening-review.ts";

export type StepReviewKind = "screening" | "acceptance" | "default";

export interface StepReviewProfile {
  kind: StepReviewKind;
  /** 顶栏文件行附注；空则走 Git 分支统计 */
  headerHint: string | null;
  groupFiles: boolean;
  hideListDiffs: boolean;
  /** 改动对照不占主面底下，从右侧拉出对照窗 */
  filesInDrawer: boolean;
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
    filesInDrawer: false,
    evidence: "screening",
    acceptance: "none",
    showReproduction: false,
    showReportDisclaimer: false,
  },
  acceptance: {
    kind: "acceptance",
    headerHint: null,
    groupFiles: false,
    hideListDiffs: false,
    filesInDrawer: false,
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
    filesInDrawer: false,
    evidence: "none",
    acceptance: "none",
    showReproduction: false,
    showReportDisclaimer: true,
  },
};

export function resolveStepReviewProfile(
  step: {
    workspaceName?: string | null;
    expectedArtifacts?: readonly string[] | null;
  } | null,
  filePaths: readonly string[] = [],
): StepReviewProfile {
  if (
    (step && isScreeningReviewStep(step)) ||
    shouldPrioritizeScreeningFiles(filePaths)
  ) {
    return STEP_REVIEW_PROFILES.screening;
  }
  if (step) return STEP_REVIEW_PROFILES.acceptance;
  return STEP_REVIEW_PROFILES.default;
}
