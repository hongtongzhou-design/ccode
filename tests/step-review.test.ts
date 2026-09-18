import assert from "node:assert/strict";
import test from "node:test";
import { resolveStepReviewProfile, STEP_REVIEW_PROFILES } from "../src/step-review.ts";
import { reviewSavePrimaryLabel, historyWorkspaceSaveTitle, REVIEW_SAVE } from "../src/review-save-copy.ts";

test("评审档案闭集：筛选 / 报告验收 / 默认，不按工作区名另开一页", () => {
  assert.equal(
    resolveStepReviewProfile({ workspaceName: "lit-search" }, []).kind,
    "screening",
  );
  assert.equal(
    resolveStepReviewProfile(
      { workspaceName: "exp-run" },
      ["papers/screening.md", "papers/included.md"],
    ).kind,
    "screening",
  );
  assert.equal(
    resolveStepReviewProfile({ workspaceName: "exp-run" }, ["results/a.md"]).kind,
    "acceptance",
  );
  assert.equal(resolveStepReviewProfile(null, []).kind, "default");
  assert.equal(STEP_REVIEW_PROFILES.screening.filesInDrawer, false);
  assert.equal(STEP_REVIEW_PROFILES.screening.acceptance, "none");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.filesInDrawer, false);
  assert.equal(STEP_REVIEW_PROFILES.screening.evidence, "screening");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.evidence, "report");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.showReproduction, true);
  assert.equal(STEP_REVIEW_PROFILES.screening.showReproduction, false);
});

test("科研保存链白话：有未提交 / 有提交 / 已写入 / 空", () => {
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: true, hasCommitted: false }),
    "提交并保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: true }),
    "保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: false, mergedAt: "t" }),
    "已保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: false }),
    "无待保存提交",
  );
  assert.equal(historyWorkspaceSaveTitle("文献检索与筛选"), "保存进项目：文献检索与筛选");
  assert.equal(REVIEW_SAVE.reviewNodeLabel, "你核对后，保存进项目");
});
