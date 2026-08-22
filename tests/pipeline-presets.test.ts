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

test("模板追加入口对自定义模板也补齐最小步骤契约", () => {
  const [step] = pipelineStepsForTemplate({
    id: "custom",
    name: "自定义",
    description: "",
    steps: [
      {
        name: "一步",
        workspaceName: "one",
        brief: "",
        expectedArtifacts: ["result.md"],
        skills: [],
        run: [],
      },
    ],
  });
  assert.ok(step.acceptanceCriteria?.some((x) => x.includes("非空")));
  assert.deepEqual(step.requiredSkills, []);
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
          // optionalInputs 可以来自项目资源或跨模板输入，不要求一定由本模板前序步骤产出。
          // 后端对它们只做存在即读取，不把缺失当作链路错误。
          for (const input of step.optionalInputs ?? []) {
            assert.ok(input.trim(), `${template.id}/${step.name} 存在空的可选输入`);
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
          const base = source.split("/").pop()!.replace(/\.[^.\/]+$/, "");
          const artifact = `output/${base}.${format}`;
          assert.ok(step.expectedArtifacts.includes(artifact), `${template.id}/${step.name} 缺少 run 产物：${artifact}`);
        }
        if (run.command.includes("tectonic") || run.command.includes("latexmk -pdf")) {
          assert.ok(step.expectedArtifacts.includes("output/main.pdf"), `${template.id}/${step.name} 缺少 LaTeX PDF 产物`);
        }
      }
    }
  }
});

test("需要渲染的步骤必须挂载 quarto-render 技能", () => {
  const variants = PIPELINE_TEMPLATES.flatMap((template) =>
    template.id === "submission-rebuttal"
      ? [
          pipelineStepsForTemplate(template, "initial", 1),
          pipelineStepsForTemplate(template, "revision", 2),
        ]
      : [template.steps],
  );
  for (const steps of variants) {
    for (const step of steps) {
      if (step.run.some((run) => /quarto render\s+/.test(run.command))) {
        assert.ok(
          step.skills.includes("quarto-render"),
          `${step.name} 声明 Quarto run 但未挂载 quarto-render`,
        );
      }
    }
  }
});

test("lit-search 与返修步骤的核心产物契约完整且按轮次隔离", () => {
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
        if (step.skills.includes("lit-search")) {
          for (const artifact of [
            "papers/screening.md",
            "papers/included.md",
            "papers/to-fetch.md",
            "papers/to-fetch.ris",
          ]) {
            assert.ok(
              step.expectedArtifacts.includes(artifact),
              `${template.id}/${step.name} 缺少 lit-search 产物：${artifact}`,
            );
          }
        }
        if (step.name.includes("审稿意见回复")) {
          const round = step.name.match(/第(\d+)轮/)?.[1];
          assert.ok(round, `${template.id}/${step.name} 缺少轮次`);
          assert.ok(
            step.expectedArtifacts.every((artifact) =>
              artifact.includes(`-r${round}`),
            ),
            `${template.id}/${step.name} 存在未隔离的返修产物`,
          );
          assert.ok(
            !step.expectedArtifacts.some((artifact) =>
              /(?:revised|response-letter)\.md$/.test(artifact),
            ),
            `${template.id}/${step.name} 存在无轮次返修文件`,
          );
        }
      }
    }
  }
});

test("只读审查技能的报告落点已进入步骤产物契约", () => {
  const variants = PIPELINE_TEMPLATES.flatMap((template) =>
    template.id === "submission-rebuttal"
      ? [
          pipelineStepsForTemplate(template, "initial", 1),
          pipelineStepsForTemplate(template, "revision", 2),
        ]
      : [template.steps],
  );
  for (const steps of variants) {
    for (const step of steps) {
      const artifacts = step.expectedArtifacts;
      if (step.skills.includes("bib-check")) {
        assert.ok(
          artifacts.some((x) => /citation-check|format-notes|final-check/.test(x)),
          `${step.name} 挂载 bib-check 但未声明引用审查报告`,
        );
      }
      if (step.skills.includes("stats-check")) {
        assert.ok(
          artifacts.some((x) => /stats-check/.test(x)),
          `${step.name} 挂载 stats-check 但未声明统计审查报告`,
        );
      }
      if (step.skills.includes("lit-notes") && step.brief.includes("更新 to-fetch.md")) {
        assert.ok(
          artifacts.includes("papers/to-fetch.md"),
          `${step.name} 会更新 to-fetch.md 但未声明回写产物`,
        );
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
