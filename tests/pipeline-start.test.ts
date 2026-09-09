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

test("TASK.md 写出项目根绝对路径与产物目录绝对路径", () => {
  const md = renderTaskMd(step(), cfg(), "/Users/me/proj");
  assert.match(md, /项目根：`\/Users\/me\/proj`/);
  assert.match(md, /`\/Users\/me\/proj\/artifacts`/);
  assert.match(md, /`\/Users\/me\/proj\/papers\/`/);
  assert.match(md, /`\/Users\/me\/proj\/output\/`/);
  assert.match(md, /不要写本工作区/);
  assert.doesNotMatch(md, /相对项目根/);
});

test("TASK.md 收尾要求大文件落在项目根", () => {
  const md = renderTaskMd(step(), cfg(), "/tmp/p");
  assert.match(md, /必须落在上方项目根对应目录/);
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
