import assert from "node:assert/strict";
import test from "node:test";
import { renderTaskMd } from "../src/task-md.ts";
import type { ProjectConfigDto, ProjectStepDto } from "../src/types.ts";

function step(partial: Partial<ProjectStepDto> = {}): ProjectStepDto {
  return {
    name: "清洗与整理",
    workspaceName: "data-clean",
    brief: "做清洗。",
    expectedArtifacts: ["cleaning/rules.md"],
    skills: [],
    run: [],
    ...partial,
  };
}

function cfg(partial: Partial<ProjectConfigDto> = {}): ProjectConfigDto {
  return {
    artifactDir: "artifacts",
    resources: [],
    steps: [],
    ...partial,
  };
}

test("TASK.md 派生产物写本工作区、文献 PDF 直写项目根", () => {
  const md = renderTaskMd(step(), cfg(), "/Users/me/proj");
  assert.match(md, /项目根：`\/Users\/me\/proj`/);
  assert.match(md, /`\/Users\/me\/proj\/papers\/`/);
  assert.match(md, /本工作区的 `artifacts\/` 或 `output\/`（相对路径）/);
  assert.match(md, /评审合并进主仓时自动带到项目根同名目录/);
  assert.match(md, /项目根相对路径（如 artifacts\/xxx\.csv）/);
  assert.doesNotMatch(md, /`\/Users\/me\/proj\/artifacts`/);
  assert.doesNotMatch(md, /`\/Users\/me\/proj\/output\/`/);
});

test("TASK.md 收尾：派生产物走工作区，直写项目根的是未验收产物", () => {
  const md = renderTaskMd(step(), cfg(), "/tmp/p");
  assert.match(md, /派生产物只写本工作区产物目录/);
  assert.match(md, /文献 PDF 写项目根 papers\//);
  assert.doesNotMatch(md, /必须落在上方项目根对应目录/);
});

test("TASK.md 项目规则不含未填的全局设定空表", () => {
  const md = renderTaskMd(
    step(),
    cfg({
      workMode: "research",
      settings: [
        "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
        "综述角度：（领域全景 / 聚焦某个子问题）",
        "答辩时间：（倒推各章节的截止）",
        "综述角度：聚焦某个子问题",
      ],
    }),
    "/tmp/p",
  );
  assert.match(md, /不要虚构文献/);
  assert.match(md, /综述角度：聚焦某个子问题/);
  assert.doesNotMatch(md, /答辩时间/);
  assert.doesNotMatch(md, /领域全景/);
});
