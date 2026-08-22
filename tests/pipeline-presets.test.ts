import assert from "node:assert/strict";
import test from "node:test";
import {
  PIPELINE_TEMPLATES,
  pipelineStepsForTemplate,
} from "../src/pipeline-presets.ts";

test("内置模板的 workspaceName 全局唯一，避免追加时互相覆盖", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const names = template.steps
      .map((s) => s.workspaceName)
      .filter(Boolean);
    assert.equal(new Set(names).size, names.length, template.name);
  }
});

test("投稿模板首投/返修是真正的不同步骤链，返修产物按轮次隔离", () => {
  const template = PIPELINE_TEMPLATES.find(
    (t) => t.id === "submission-rebuttal",
  );
  assert.ok(template);
  const initial = pipelineStepsForTemplate(template, "initial");
  assert.deepEqual(initial.map((s) => s.name), ["期刊格式适配", "投稿材料"]);
  const revision = pipelineStepsForTemplate(template, "revision", 2);
  assert.equal(revision.length, 1);
  assert.equal(revision[0].workspaceName, "rebuttal-r2");
  assert.ok(revision[0].expectedArtifacts.includes("manuscript/revised-r2.md"));
  assert.ok(
    revision[0].expectedArtifacts.includes(
      "submission/resubmission-checklist-r2.md",
    ),
  );
  assert.ok(revision[0].brief.includes("reviews/round-2.md"));
  assert.ok(!revision[0].expectedArtifacts.some((x) => x === "manuscript/revised.md"));
});

test("投稿返修第 1 轮兼容综述定稿与科研论文定稿两种上游稿件", () => {
  const template = PIPELINE_TEMPLATES.find(
    (t) => t.id === "submission-rebuttal",
  );
  assert.ok(template);
  const [revision] = pipelineStepsForTemplate(template, "revision", 1);
  assert.deepEqual(revision.inputs, ["reviews/round-1.md", "references.bib"]);
  assert.deepEqual(revision.anyOfInputs, [["manuscript/paper-final.md", "manuscript/review-final.md"]]);
  assert.ok(revision.brief.includes("manuscript/paper-final.md 或 manuscript/review-final.md"));
  assert.ok(revision.expectedArtifacts.includes("manuscript/revised-r1.md"));
});

test("内置模板的后续步骤输入都能接到上游产物", () => {
  const covers = (artifact: string, input: string) =>
    artifact === input || artifact.startsWith(input) || input.startsWith(artifact);
  for (const template of PIPELINE_TEMPLATES) {
    const variants =
      template.id === "submission-rebuttal"
        ? [
            pipelineStepsForTemplate(template, "initial", 1),
            pipelineStepsForTemplate(template, "revision", 2),
          ]
        : [template.steps];
    for (const steps of variants) {
      const prior: string[] = [];
      for (const step of steps) {
        if (prior.length) {
          for (const input of step.inputs ?? []) {
            assert.ok(
              prior.some((artifact) => covers(artifact, input)),
              `${template.id}/${step.name} 的输入未接到上游：${input}`,
            );
          }
          for (const input of step.optionalInputs ?? []) {
            assert.ok(
              prior.some((artifact) => covers(artifact, input)),
              `${template.id}/${step.name} 的可选输入未接到上游：${input}`,
            );
          }
          for (const group of step.anyOfInputs ?? []) {
            assert.ok(
              group.some((input) => prior.some((artifact) => covers(artifact, input))),
              `${template.id}/${step.name} 的任一输入组未接到上游：${group.join(" 或 ")}`,
            );
          }
        }
        prior.push(...step.expectedArtifacts);
      }
    }
  }
});

test("空落点人工事项必须使用 manual，且推荐技能存在于内置技能集合", () => {
  const builtin = new Set([
    "bib-check", "data-clean", "data-eda", "figure-forge", "lit-notes",
    "lit-search", "lit-watch", "proposal-writer", "quarto-render",
    "rebuttal-crafter", "research-writing", "review-framework", "review-writing",
    "slides-deck", "stats-check",
  ]);
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      for (const task of step.humanTasks ?? []) {
        if (!task.target.trim()) assert.equal(task.completion ?? "manual", "manual", `${template.id}/${step.name}/${task.title}`);
      }
      for (const skill of step.skills) assert.ok(builtin.has(skill), `${template.id}/${step.name} 使用未播种技能：${skill}`);
    }
  }
});

test("run 声明的 Quarto/LaTeX 正式输出均进入 expectedArtifacts", () => {
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      for (const run of step.run) {
        const matches = [...run.command.matchAll(/quarto render\s+([^\s]+)\s+--to\s+(pdf|docx)/g)];
        for (const [, source, format] of matches) {
          const artifact = source.replace(/\.[^.\/]+$/, `.${format}`);
          assert.ok(step.expectedArtifacts.includes(artifact), `${template.id}/${step.name} 缺少 run 产物：${artifact}`);
        }
        if (run.command.includes("tectonic main.tex") || run.command.includes("latexmk -pdf")) {
          assert.ok(step.expectedArtifacts.includes("manuscript/main.pdf"), `${template.id}/${step.name} 缺少 LaTeX PDF 产物`);
        }
      }
    }
  }
});

test("内置模板不再用空目录作为预期产物", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const variants =
      template.id === "submission-rebuttal"
        ? [
            pipelineStepsForTemplate(template, "initial", 1),
            pipelineStepsForTemplate(template, "revision", 2),
          ]
        : [template.steps];
    for (const steps of variants) {
      for (const step of steps) {
        assert.ok(
          step.expectedArtifacts.every((artifact) => !artifact.endsWith("/")),
          `${template.id}/${step.name} 仍有过宽目录产物`,
        );
      }
    }
  }
});
