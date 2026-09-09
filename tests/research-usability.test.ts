import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PIPELINE_TEMPLATES, settingsForTemplateApply, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { renderTaskMd } from "../src/task-md.ts";

const find = (id: string) => PIPELINE_TEMPLATES.find((t) => t.id === id)!;
const md = (id: string) => find(id).steps.map((s) => renderTaskMd(s, {
  resources: [], steps: find(id).steps, artifactDir: "artifacts", settings: settingsForTemplateApply(find(id)), rulesOwned: true,
}, "/pilot/project"));

test("任务书减重不靠删阶段/门禁：共用摘要一次，格式适配不重复终审", () => {
  // Measured before this optimization, same project path and renderer inputs.
  const before: Record<string, number> = { review: 15922, "research-paper": 22113, "data-processing": 9577, thesis: 22838, "submission-rebuttal": 6493, "latex-paper": 10297 };
  for (const t of PIPELINE_TEMPLATES) {
    const tasks = md(t.id);
    assert.ok(tasks.reduce((n, s) => n+s.length, 0) < before[t.id], t.id);
    for (const task of tasks) {
      assert.equal(task.split("验收摘要放在本步主要报告开头").length-1, 1);
      for (const text of ["关键证据/复现入口", "尚未验证", "影响结论的未决问题", "需要人决定", "未经重验不得复用旧结论"]) assert.ok(task.includes(text), text);
    }
    assert.ok(!t.projectRules?.some((line) => line.includes("质量状态")), "共用摘要不在项目规则重复");
  }
  const format = find("submission-rebuttal").steps[0];
  assert.doesNotMatch(format.brief, /G5 投稿就绪/);
  assert.match(format.brief, /交下一步投稿材料统一关闭/);
  assert.match(find("submission-rebuttal").steps[1].brief, /G5 投稿就绪/);
  assert.match(pipelineStepsForTemplate(find("submission-rebuttal"), "revision", 2)[0].brief, /G5 投稿就绪/);
});

test("人看决策摘要而非凭空保证；实际复现入口进入产物和下游输入", () => {
  for (const id of ["research-paper", "thesis"]) {
    const t = find(id);
    const run = t.steps.find((s) => s.expectedArtifacts.includes("results/run-manifest.json"))!;
    assert.ok(run.expectedArtifacts.includes("experiments/reproduce.py"));
    const analysis = t.steps.find((s) => s.inputs?.includes("results/run-manifest.json"))!;
    assert.ok(analysis.inputs?.includes("experiments/reproduce.py"));
    const tasks = md(id).join("\n");
    for (const token of ["决策摘要（先看方案", "可行方案", "代价/不确定性", "推荐不是批准", "--input/--output", "失败非零退出"]) assert.ok(tasks.includes(token), token);
  }
  const data = find("data-processing").steps.find((s) => s.workspaceName === "data-eda")!;
  assert.ok(data.expectedArtifacts.includes("analysis/reproduce.py"));
  for (const name of ["review-writing", "review-framework"]) {
    const text = readFileSync(`src-tauri/resources/skills/${name}/SKILL.md`, "utf8");
    assert.doesNotMatch(text, /每节要点（3-6 条）|每个主题组至少一处批判|批判词缺位|\*\*2-3 篇/);
  }
});

test("离线故障试跑与交付入口实际运行：拒绝缺证据/漂移/错数/覆盖原目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-usability-pilot-"));
  const sources = join(dir, "sources"); mkdirSync(sources);
  // Test fixtures are explicitly synthetic; real full-text trial is a separate recorded run.
  for (const name of ["cawley2010-fulltext.txt", "varma2006-fulltext.txt"]) writeFileSync(join(sources, name), "OFFLINE TEST FIXTURE, NOT PAPER CONTENT.\n".repeat(40));
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const output = join(dir, "pilot");
  const run = (args: string[]) => spawnSync(python, ["scripts/research-pilot.py", ...args], { encoding: "utf8", timeout: 60000 });
  try {
    const made = run(["create", "--sources", sources, "--literature", "tests/fixtures/research-pilot/literature.json", "--output", output]);
    assert.equal(made.status, 0, made.stderr || String(made.error));
    const results = JSON.parse(readFileSync(join(output, "pilot-results.json"), "utf8"));
    assert.equal(results.computationalRuns, 36);
    assert.equal(results.humanApproval, false);
    assert.equal(results.faults.length, 8);
    assert.ok(results.faults.every((x: {blocked:boolean}) => x.blocked));
    const rebuilt = join(dir, "rebuilt");
    const call = run(["reproduce", "--input", join(output, "computational"), "--output", rebuilt]);
    assert.equal(call.status, 0, call.stderr);
    assert.equal(readFileSync(join(rebuilt, "analysis/results-table.md"), "utf8"), readFileSync(join(output, "computational/analysis/results-table.md"), "utf8"));
    const overwrite = run(["reproduce", "--input", join(output, "computational"), "--output", rebuilt]);
    assert.notEqual(overwrite.status, 0);
    const nested = join(output, "computational", "unsafe-output");
    assert.notEqual(run(["reproduce", "--input", join(output, "computational"), "--output", nested]).status, 0);
    assert.equal(existsSync(nested), false);
    for (const [kind, name] of [["literature", "wrong-key"], ["computational", "data-drift"], ["computational", "missing-run"]]) {
      const failedOutput = join(dir, `blocked-${name}`);
      const failed = run(["reproduce", "--input", join(output, `${kind}-checks`, "faults", name), "--output", failedOutput]);
      assert.equal(failed.status, 2, failed.stderr);
      assert.equal(existsSync(failedOutput), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
