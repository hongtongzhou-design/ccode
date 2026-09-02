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
