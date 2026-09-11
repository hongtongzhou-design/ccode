import test from "node:test";
import assert from "node:assert/strict";
import {
  codingReviewHint,
  companionPdfPath,
  resultReadinessLabel,
  goalReviewCopy,
  goalReviewFacts,
  goalReviewMode,
  groupReviewChanges,
  researchReviewGroup,
} from "../src/goal-review.ts";

test("coding does not share the goal-review modal", () => {
  assert.equal(goalReviewMode("coding"), null);
  assert.match(codingReviewHint(), /合进基准/);
});

test("research review groups literature notes data and papers", () => {
  assert.equal(researchReviewGroup("papers/a.pdf"), "literature");
  assert.equal(researchReviewGroup("notes/a.md"), "notes");
  assert.equal(researchReviewGroup("数据/raw.csv"), "data");
  assert.equal(researchReviewGroup("论文/综述.md"), "paper");
  const groups = groupReviewChanges("research", [
    { path: "papers/a.pdf", kind: "added" },
    { path: "notes/a.md", kind: "modified" },
    { path: "论文/综述.md", kind: "added" },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.length]),
    [
      ["文献", 1],
      ["笔记", 1],
      ["论文", 1],
    ],
  );
});

test("office review groups by document kind", () => {
  const groups = groupReviewChanges("office", [
    { path: "周报.docx", kind: "added" },
    { path: "预算.xlsx", kind: "modified" },
    { path: "汇报.pptx", kind: "added" },
  ]);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["文档", "表格", "幻灯"],
  );
});

test("review copy and facts stay scene-specific", () => {
  assert.equal(goalReviewCopy("research").cardAction, "验收产物");
  assert.equal(goalReviewCopy("office").cardAction, "验收文档");
  assert.equal(goalReviewCopy("research").pickLabel, "写进项目");
  assert.match(goalReviewCopy("research").hint, /勾选/);
  assert.match(goalReviewCopy("research").continueLabel, /再出一版/);
  assert.match(goalReviewCopy("research").rememberLine, /下次开工/);
  const research = goalReviewFacts({
    workMode: "research",
    agentLabel: "Codex",
    runCount: 2,
    changes: [{ path: "papers/a.pdf", kind: "added" }, { path: "notes/a.md", kind: "modified" }],
    feedback: "引用太少",
  }).join("\n");
  assert.match(research, /文献 1 · 笔记 1/);
  assert.doesNotMatch(research, /改动 2 个文件/);
  const office = goalReviewFacts({
    workMode: "office",
    runCount: 1,
    changes: [{ path: "周报.docx", kind: "added" }],
  }).join("\n");
  assert.match(office, /文档 1/);
  assert.doesNotMatch(office, /文献/);
});

test("review generation is distinct from execution count and paired PDF is same result", () => {
  const facts = goalReviewFacts({ runCount: 4, resultSeq: 2, changes: [] }).join("\n");
  assert.match(facts, /冻结版本：2/);
  assert.doesNotMatch(facts, /第 4 版/);
  assert.equal(companionPdfPath("slides/deck.pptx", [{ path: "slides/deck.pdf", kind: "added" }]), "slides/deck.pdf");
  assert.equal(companionPdfPath("slides/deck.pptx", [{ path: "old/deck.pdf", kind: "added" }]), null);
  assert.equal(companionPdfPath("slides/deck.pptx", [{ path: "slides/deck.pdf", kind: "added", tooLarge: true }]), null);
});

test("result readiness describes acceptance rather than process completion", () => {
  assert.match(resultReadinessLabel("reviewable"), /不代表目标已完成/);
  assert.match(resultReadinessLabel("blocked"), /不可写回/);
  assert.match(resultReadinessLabel("applied"), /接受记录/);
  assert.match(resultReadinessLabel("ledger_pending"), /待补记/);
});
