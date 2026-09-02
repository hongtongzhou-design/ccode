import assert from "node:assert/strict";
import test from "node:test";
import type { RunOverviewInput } from "../src/run-overview.ts";
import {
  continueWorkbenchTarget,
  firstOpenStepName,
  heroStatusLine,
  namedSessionTitle,
  pickWorkbenchHero,
  type WorkbenchHero,
  type WorkbenchProject,
  type WorkbenchRepo,
  type WorkbenchWorkspaceRef,
} from "../src/workbench-hero.ts";

function run(partial: Partial<RunOverviewInput>): RunOverviewInput {
  return {
    tabId: "t1",
    title: "终端",
    agentId: "claude-code",
    model: "sonnet",
    cwd: "/repo/ccode",
    running: false,
    shell: false,
    attention: null,
    ...partial,
  };
}

const demo: WorkbenchProject = {
  path: "/Users/me/Documents/Ccode 示例课题",
  name: "示例课题（演示）",
};
const ccode: WorkbenchProject = {
  path: "/Users/me/Documents/Ccode",
  name: "Ccode",
};
const repos: WorkbenchRepo[] = [
  { path: "/Users/me/Documents/Ccode", name: "Ccode" },
  { path: "/Users/me/Documents/Ccode 示例课题", name: "Ccode 示例课题" },
  { path: "/Users/me/other", name: "学习" },
];

const demoWs: WorkbenchWorkspaceRef = {
  repoPath: demo.path,
  worktreePath: "/Users/me/Documents/Ccode 示例课题/.ccode/worktrees/lit-notes",
  name: "lit-notes",
  status: "active",
  mergedAt: null,
};

test("运行中的标签赢过上次选中的项目，名称用注册名", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [demoWs],
    runs: [run({ running: true, cwd: "/Users/me/Documents/Ccode" })],
    contextName: "示例课题（演示）",
  });
  assert.equal(hero?.path, "/Users/me/Documents/Ccode");
  assert.equal(hero?.name, "Ccode");
  assert.equal(hero?.source, "running");
  assert.equal(hero?.tabId, "t1");
  assert.equal(hero?.runningCount, 1);
  assert.equal(hero?.agentId, "claude-code");
});

test("工作树里的运行归到项目根，继续工作带该标签", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [demoWs],
    runs: [
      run({
        tabId: "ws",
        running: true,
        attention: "working",
        cwd: "/Users/me/Documents/Ccode 示例课题/.ccode/worktrees/lit-notes/notes",
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.path, demo.path);
  assert.equal(hero?.name, "示例课题（演示）");
  assert.equal(hero?.registered, true);
  assert.equal(hero?.tabId, "ws");
  assert.equal(hero?.attention, "working");
});

test("运行计数只算这张卡所属项目，不算别的仓库", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [demoWs],
    runs: [
      run({
        tabId: "a",
        running: true,
        attention: "confirm",
        cwd: "/Users/me/Documents/Ccode",
      }),
      run({
        tabId: "b",
        running: true,
        agentId: "codex",
        cwd: demo.path,
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.path, "/Users/me/Documents/Ccode");
  assert.equal(hero?.runningCount, 1);
  assert.equal(hero?.tabId, "a");
  assert.equal(hero?.attention, "confirm");
});

test("没有运行时用上次选中的已添加项目，目录名回落到注册名", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [],
    runs: [run({ cwd: "/Users/me/Documents/Ccode", running: false })],
    contextName: "Ccode 示例课题",
  });
  assert.equal(hero?.path, demo.path);
  assert.equal(hero?.name, "示例课题（演示）");
  assert.equal(hero?.source, "context");
  assert.equal(hero?.tabId, null);
  assert.equal(hero?.runningCount, 0);
});

test("没有上下文时取时间序里最近的已添加项目，不把旧注册项抬到最前", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [],
    runs: [],
    contextName: null,
  });
  assert.equal(hero?.path, ccode.path);
  assert.equal(hero?.source, "recent-registered");
});

test("未匹配任何项目的运行目录仍作为当前工作", () => {
  const hero = pickWorkbenchHero({
    projects: [demo],
    recentRepos: repos,
    workspaces: [],
    runs: [run({ tabId: "x", running: true, cwd: "/tmp/scratch" })],
    contextName: "示例课题（演示）",
  });
  assert.equal(hero?.path, "/tmp/scratch");
  assert.equal(hero?.registered, false);
  assert.equal(hero?.source, "running");
  assert.equal(hero?.tabId, "x");
});

test("Windows 路径大小写与工作树前缀仍能归到项目", () => {
  const hero = pickWorkbenchHero({
    isWindows: true,
    projects: [{ path: "C:\\Users\\me\\Demo", name: "演示" }],
    recentRepos: [{ path: "C:\\Users\\me\\Demo", name: "Demo" }],
    workspaces: [
      {
        repoPath: "C:\\Users\\me\\Demo",
        worktreePath: "C:\\Users\\me\\Demo\\.ccode\\worktrees\\search",
        name: "search",
        status: "active",
        mergedAt: null,
      },
    ],
    runs: [
      run({
        running: true,
        cwd: "c:/users/me/demo/.ccode/worktrees/search",
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.name, "演示");
  assert.equal(hero?.registered, true);
});

test("继续工作：有标签去终端，已添加去项目详情，否则真进入", () => {
  const running: WorkbenchHero = {
    name: "Ccode",
    path: ccode.path,
    registered: true,
    tabId: "t9",
    agentId: "codex",
    model: "",
    attention: "working",
    runningCount: 1,
    source: "running",
  };
  assert.deepEqual(continueWorkbenchTarget(running), {
    kind: "terminal",
    tabId: "t9",
  });
  assert.deepEqual(
    continueWorkbenchTarget({ ...running, tabId: null, source: "context" }),
    { kind: "project", path: ccode.path },
  );
  assert.deepEqual(
    continueWorkbenchTarget({
      ...running,
      tabId: null,
      registered: false,
      path: "/tmp/scratch",
      source: "recent",
    }),
    { kind: "enter-cwd", path: "/tmp/scratch" },
  );
});

test("firstOpenStepName 取第一个未合并步骤，全完成回末步", () => {
  const steps = [
    { name: "文献检索与筛选", workspaceName: "lit-search" },
    { name: "精读与研究空白", workspaceName: "lit-notes" },
  ];
  assert.equal(firstOpenStepName(steps, []), "文献检索与筛选");
  assert.equal(
    firstOpenStepName(steps, [
      {
        name: "lit-search",
        status: "active",
        mergedAt: "2026-09-01",
      },
    ]),
    "精读与研究空白",
  );
  assert.equal(
    firstOpenStepName(steps, [
      { name: "lit-search", status: "active", mergedAt: "a" },
      { name: "lit-notes", status: "active", mergedAt: "b" },
    ]),
    "精读与研究空白",
  );
  assert.equal(firstOpenStepName([], []), null);
});

test("heroStatusLine 只描述这张卡上的 Agent", () => {
  assert.equal(
    heroStatusLine({
      runningCount: 1,
      agentLabel: "Claude Code",
      attention: "confirm",
      registered: true,
    }),
    "Claude Code 在等你确认",
  );
  assert.equal(
    heroStatusLine({
      runningCount: 2,
      agentLabel: "Codex",
      attention: "working",
      registered: true,
    }),
    "Codex 正在工作",
  );
  assert.equal(
    heroStatusLine({
      runningCount: 0,
      agentLabel: "Claude Code",
      attention: null,
      registered: true,
    }),
    "准备好从上次位置继续",
  );
  assert.equal(
    heroStatusLine({
      runningCount: 0,
      agentLabel: null,
      attention: null,
      registered: false,
    }),
    "可从最近位置继续",
  );
});

test("namedSessionTitle 丢掉未命名对话", () => {
  assert.equal(namedSessionTitle({ customTitle: "方向", title: "hi" }), "方向");
  assert.equal(namedSessionTitle({ customTitle: null, title: "  " }), null);
  assert.equal(namedSessionTitle({ customTitle: null, title: null }), null);
});
