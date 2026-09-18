import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveStepReviewProfile,
  STEP_REVIEW_PROFILES,
  type StepReviewKind,
} from "../src/step-review.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { reviewSavePrimaryLabel, historyWorkspaceSaveTitle, REVIEW_SAVE } from "../src/review-save-copy.ts";

test("评审档案闭集：筛选 / 文件交付 / 报告验收 / 默认，不按工作区名另开一页", () => {
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
    resolveStepReviewProfile(
      {
        workspaceName: "lit-notes",
        expectedArtifacts: ["notes/*.md", "notes/index.json", "references.bib"],
      },
      ["notes/a.md"],
    ).kind,
    "files",
  );
  assert.equal(
    resolveStepReviewProfile(
      {
        workspaceName: "exp-run",
        expectedArtifacts: ["results/summary.md", "experiments/reproduce.py"],
      },
      ["results/a.md"],
    ).kind,
    "acceptance",
  );
  assert.equal(
    resolveStepReviewProfile({ workspaceName: "exp-run" }, ["results/a.md"]).kind,
    "files",
  );
  assert.equal(resolveStepReviewProfile(null, []).kind, "default");
  assert.equal(STEP_REVIEW_PROFILES.screening.filesInDrawer, false);
  assert.equal(STEP_REVIEW_PROFILES.files.groupFiles, true);
  assert.equal(STEP_REVIEW_PROFILES.files.acceptance, "none");
  assert.equal(STEP_REVIEW_PROFILES.files.showReproduction, false);
  assert.equal(STEP_REVIEW_PROFILES.screening.acceptance, "none");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.filesInDrawer, false);
  assert.equal(STEP_REVIEW_PROFILES.screening.evidence, "screening");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.evidence, "report");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.showReproduction, true);
  assert.equal(STEP_REVIEW_PROFILES.screening.showReproduction, false);
});

const KIND_BY_WORKSPACE: Record<string, StepReviewKind> = {
  "lit-search": "screening",
  "lit-survey-search": "screening",
  "lit-notes": "files",
  outline: "files",
  draft: "files",
  polish: "files",
  "lit-survey-gap": "files",
  "exp-design": "files",
  "exp-run": "acceptance",
  "exp-analysis": "acceptance",
  "paper-draft": "files",
  "research-paper-polish": "files",
  "data-inspect": "files",
  "data-clean": "acceptance",
  "data-eda": "acceptance",
  "data-report": "files",
  proposal: "files",
  methodology: "files",
  "thesis-exp-run": "acceptance",
  "thesis-exp-analysis": "acceptance",
  "thesis-draft": "files",
  "thesis-final": "files",
  "journal-format": "files",
  "submission-materials": "files",
  "latex-skeleton": "files",
  "latex-writing": "files",
  "latex-compile": "files",
  "latex-final": "files",
};

test("六套模板步骤评审档案按产物分流", () => {
  for (const tpl of PIPELINE_TEMPLATES) {
    for (const step of tpl.steps) {
      const ws = step.workspaceName ?? "";
      assert.ok(
        KIND_BY_WORKSPACE[ws],
        `未登记评审档案：${tpl.id}/${step.name} (${ws})`,
      );
      assert.equal(
        resolveStepReviewProfile(step, []).kind,
        KIND_BY_WORKSPACE[ws],
        `${tpl.id}/${step.name}`,
      );
    }
  }
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
