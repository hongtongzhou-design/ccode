import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeRailCwd,
  buildProjectRailSections,
  railTabIsLive,
  type RailCodingTree,
  type RailProject,
  type RailTabSummary,
  type RailWorkspace,
} from "../src/project-rail.ts";

const research: RailProject = {
  path: "/Users/me/综述文献",
  name: "综述文献",
  workMode: "research",
};
const coding: RailProject = {
  path: "/Users/me/网页设计",
  name: "网页设计",
  workMode: "coding",
};
const office: RailProject = {
  path: "/Users/me/AI应用教程",
  name: "AI应用教程",
  workMode: "office",
};

const litWs: RailWorkspace = {
  id: "w1",
  name: "lit-notes",
  repoPath: research.path,
  worktreePath: "/Users/me/综述文献/.ccode/workspaces/lit-notes",
  status: "active",
  branch: "ccode/lit-notes",
};

const codingTree: RailCodingTree = {
  repoPath: coding.path,
  path: "/Users/me/ccode/worktrees/网页设计/feature-login",
};

function tab(
  cwd: string,
  extra: Partial<RailTabSummary> = {},
): RailTabSummary {
  return { cwd, running: false, attention: null, ...extra };
}

test("活标签：正在跑或等确认才算", () => {
  assert.equal(railTabIsLive({ running: true, attention: null }), true);
  assert.equal(railTabIsLive({ running: false, attention: "confirm" }), true);
  assert.equal(railTabIsLive({ running: false, attention: "working" }), false);
  assert.equal(railTabIsLive({ running: false, attention: "done" }), false);
});

test("cwd 落在编程工作树时归到已添加项目根，而不是丢失", () => {
  assert.equal(
    attributeRailCwd(codingTree.path, {
      projects: [coding, office],
      workspaces: [],
      codingTrees: [codingTree],
    }),
    coding.path,
  );
});

test("科研工作树比项目根更长，优先归到该仓", () => {
  assert.equal(
    attributeRailCwd(litWs.worktreePath, {
      projects: [research],
      workspaces: [litWs],
      codingTrees: [],
    }),
    research.path,
  );
});

test("多个项目同时跑：办公活标签 + 编程工作树活标签都列出，当前置顶", () => {
  const sections = buildProjectRailSections({
    cwd: office.path,
    projects: [research, coding, office],
    workspaces: [],
    codingTrees: [codingTree],
    tabs: [
      tab(office.path, { running: true, attention: "working" }),
      tab(codingTree.path, { running: false, attention: "confirm" }),
      tab(research.path, { running: false, attention: null }),
    ],
  });
  assert.deepEqual(
    sections.map((s) => ({ name: s.name, current: s.current, mode: s.workMode })),
    [
      { name: "AI应用教程", current: true, mode: "office" },
      { name: "网页设计", current: false, mode: "coding" },
    ],
  );
  assert.equal(sections[0]?.ws.length, 0);
  assert.equal(sections[0]?.mainLive, "working");
  assert.equal(sections[1]?.mainLive, "confirm");
});

test("科研活跃工作区即使没有活标签也列出；工作树上的点不打在主文件夹", () => {
  const sections = buildProjectRailSections({
    cwd: "/tmp/other",
    projects: [research, office],
    workspaces: [litWs],
    tabs: [tab(litWs.worktreePath, { running: true })],
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.name, "综述文献");
  assert.equal(sections[0]?.ws.length, 1);
  assert.equal(sections[0]?.mainLive, null);
});

test("空闲标签所在项目不进列表，除非是当前目录", () => {
  const sections = buildProjectRailSections({
    cwd: office.path,
    projects: [coding, office],
    workspaces: [],
    tabs: [tab(coding.path, { running: false, attention: null })],
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.name, "AI应用教程");
  assert.equal(sections[0]?.current, true);
});

test("未添加目录的活标签不进列表", () => {
  const sections = buildProjectRailSections({
    cwd: "/tmp/scratch",
    projects: [office],
    workspaces: [],
    tabs: [tab("/tmp/scratch", { running: true })],
  });
  assert.equal(sections.length, 0);
});

test("Windows 工作树路径大小写仍归到项目", () => {
  const sections = buildProjectRailSections({
    cwd: "C:\\Users\\me\\ccode\\worktrees\\Demo\\feat",
    projects: [{ path: "c:/Users/me/Demo", name: "演示", workMode: "coding" }],
    workspaces: [],
    codingTrees: [
      { repoPath: "c:/Users/me/Demo", path: "C:\\Users\\me\\ccode\\worktrees\\Demo\\feat" },
    ],
    tabs: [
      tab("C:\\Users\\me\\ccode\\worktrees\\Demo\\feat", { running: true }),
    ],
    isWindows: true,
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.name, "演示");
  assert.equal(sections[0]?.current, true);
  assert.equal(sections[0]?.mainLive, "running");
});
