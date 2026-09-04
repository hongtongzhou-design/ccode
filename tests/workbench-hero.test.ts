import assert from "node:assert/strict";
import test from "node:test";
import type { RunOverviewInput } from "../src/run-overview.ts";
import {
  continueWorkbenchTarget,
  firstOpenStepName,
  heroStatusLine,
  namedSessionTitle,
  pickWorkbenchHero,
  pickWorkbenchNow,
  taskLabelForRun,
  workbenchRecentRows,
  workbenchRecentSessions,
  WORKBENCH_RECENT_LIMIT,
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

test("前缀路径不会把 /repo/ccode2 归到 /repo/ccode", () => {
  const hero = pickWorkbenchHero({
    projects: [
      { path: "/repo/ccode", name: "Ccode" },
      { path: "/repo/ccode2", name: "Ccode2", workMode: "coding" },
    ],
    recentRepos: [],
    workspaces: [],
    runs: [run({ running: true, cwd: "/repo/ccode2/src" })],
    contextName: null,
  });
  assert.equal(hero?.path, "/repo/ccode2");
  assert.equal(hero?.name, "Ccode2");
  assert.equal(hero?.workMode, "coding");
});

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
    projects: [{ ...demo, workMode: "office" }, ccode],
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
  assert.equal(hero?.workMode, "office");
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
    runs: [
      {
        tabId: "t9",
        agentId: "codex",
        attention: "working",
        taskLabel: "Ccode",
      },
    ],
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
  assert.equal(
    firstOpenStepName(
      [
        {
          name: "文献检索与筛选",
          workspaceName: "lit-search",
          seedComplete: true,
        },
        { name: "文献精读与笔记", workspaceName: "lit-notes" },
      ],
      [],
    ),
    "文献精读与笔记",
  );
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
    "2 个 Agent 在跑",
  );
  assert.equal(
    heroStatusLine({
      runningCount: 2,
      agentLabel: "Codex",
      attention: "confirm",
      registered: true,
    }),
    "2 个 Agent 在跑 · Codex 在等你确认",
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

test("最近项目：已添加用注册名，外部仓库标未添加", () => {
  const rows = workbenchRecentRows({
    recentRepos: [
      { path: "/Users/me/Documents/Ccode", name: "Ccode", lastActive: "2026-09-03" },
      { path: "/Users/me/codex-playground", name: "codex-playground", lastActive: "2026-09-02" },
      { path: "/Users/me/Documents/Ccode 示例课题", name: "Ccode 示例课题" },
    ],
    projects: [ccode, { ...demo, name: "示例课题（演示）" }],
    excludePaths: [ccode.path],
  });
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, registered: r.registered, path: r.path })),
    [
      {
        name: "codex-playground",
        registered: false,
        path: "/Users/me/codex-playground",
      },
      {
        name: "示例课题（演示）",
        registered: true,
        path: "/Users/me/Documents/Ccode 示例课题",
      },
    ],
  );
});

test("最近项目 Windows 路径按同一仓库认已添加", () => {
  const rows = workbenchRecentRows({
    recentRepos: [{ path: "C:\\Users\\me\\Demo", name: "Demo" }],
    projects: [{ path: "c:/Users/me/Demo", name: "演示项目" }],
    isWindows: true,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "演示项目");
  assert.equal(rows[0]?.registered, true);
});

test("最近项目包含没有会话的已添加项目，新建排在前面", () => {
  const rows = workbenchRecentRows({
    recentRepos: [
      { path: "/old-session", name: "old-session", lastActive: "2026-01-01T00:00:00Z" },
    ],
    projects: [
      {
        path: "/Users/me/Desktop/AI应用教程",
        name: "AI应用教程",
        lastOpenedAt: "2026-09-03T10:00:00Z",
      },
    ],
  });
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, registered: r.registered })),
    [
      { name: "AI应用教程", registered: true },
      { name: "old-session", registered: false },
    ],
  );
});

test("最近项目和最近对话默认最多 10 条", () => {
  assert.equal(WORKBENCH_RECENT_LIMIT, 10);
  const projects = Array.from({ length: 12 }, (_, i) => ({
    path: `/p/${String(i).padStart(2, "0")}`,
    name: `项目${i}`,
    lastOpenedAt: `2026-09-03T00:00:${String(i).padStart(2, "0")}Z`,
  }));
  const rows = workbenchRecentRows({ recentRepos: [], projects });
  assert.equal(rows.length, 10);
  assert.equal(rows[0]?.name, "项目11");
  assert.equal(rows[9]?.name, "项目2");

  const sessions = Array.from({ length: 12 }, (_, i) => ({
    customTitle: i === 0 ? null : `对话${i}`,
    title: i === 0 ? "  " : `对话${i}`,
  }));
  const listed = workbenchRecentSessions(sessions);
  assert.equal(listed.length, 10);
  assert.equal(listed[0]?.customTitle, "对话1");
});

test("正在进行：确认优先，并行项目都在，安静项目不进", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: demo.path,
        name: demo.name,
        registered: true,
        workMode: "research",
        subtitle: "文献检索",
        needsYou: true,
      },
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: "payment 需同步",
        needsYou: true,
        extraRoots: ["/Users/me/ccode/worktrees/Ccode/payment"],
      },
      {
        path: "/Users/me/docs",
        name: "材料",
        registered: true,
        workMode: "office",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "pay",
        running: true,
        attention: "confirm",
        cwd: "/Users/me/ccode/worktrees/Ccode/payment",
      }),
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.path, ccode.path);
  assert.equal(items[0]?.tabId, "pay");
  assert.equal(items[0]?.workMode, "coding");
  assert.equal(items[1]?.path, demo.path);
  assert.equal(items[1]?.subtitle, "文献检索");
  assert.equal(items[0]?.runningCount, 1);
  assert.equal(items[0]?.attention, "confirm");
  assert.equal(items[0]?.runs.length, 1);
  assert.equal(items[0]?.runs[0]?.tabId, "pay");
});

test("正在进行：还开着的阅读标签算干活，无头不算", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: demo.path,
        name: demo.name,
        registered: true,
        workMode: "research",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "read",
        reuseKey: `reader:${demo.path}`,
        running: false,
        shell: true,
        cwd: demo.path,
        title: "阅读 · paper",
      }),
      run({
        tabId: "watch",
        reuseKey: "watch:1:/p",
        running: true,
        cwd: demo.path,
      }),
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.runs[0]?.tabId, "read");
});

test("正在进行：登录标签不算干活", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "login",
        reuseKey: "login:codex",
        running: true,
        cwd: ccode.path,
      }),
    ],
  });
  assert.equal(items.length, 0);
});

test("taskLabelForRun：占位「终端」回落到目录尾段", () => {
  assert.equal(
    taskLabelForRun({ title: "feature/login", cwd: "/repo/wt" }),
    "feature/login",
  );
  assert.equal(
    taskLabelForRun({ title: "终端", cwd: "/Users/me/ccode/worktrees/app/login" }),
    "login",
  );
});

test("正在进行：同一项目两次 Run 都挂在卡上，待确认排前面", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
        extraRoots: [
          "/Users/me/ccode/worktrees/Ccode/login-ui",
          "/Users/me/ccode/worktrees/Ccode/login-api",
        ],
      },
    ],
    runs: [
      run({
        tabId: "ui",
        title: "feature/login-ui",
        agentId: "claude-code",
        running: true,
        attention: "working",
        cwd: "/Users/me/ccode/worktrees/Ccode/login-ui",
      }),
      run({
        tabId: "api",
        title: "feature/login-api",
        agentId: "codex",
        running: true,
        attention: "confirm",
        cwd: "/Users/me/ccode/worktrees/Ccode/login-api",
      }),
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.runningCount, 2);
  assert.equal(items[0]?.tabId, "api");
  assert.equal(items[0]?.agentId, "codex");
  assert.equal(items[0]?.attention, "confirm");
  assert.deepEqual(
    items[0]?.runs.map((r) => r.tabId),
    ["api", "ui"],
  );
  assert.equal(items[0]?.runs[0]?.taskLabel, "feature/login-api");
});
