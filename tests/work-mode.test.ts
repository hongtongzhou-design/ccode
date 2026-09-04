import assert from "node:assert/strict";
import test from "node:test";
import {
  codingFactChips,
  deriveCodingKind,
  isOfficeInProgress,
  isOfficePreviewable,
  officeFileInProgress,
  officeFileReuseKey,
  officeProjectReuseKey,
  projectChatReuseKey,
  lockWorkModeFromConfig,
  normalizeWorkMode,
  officeDocKind,
  officeDocMatchesQuery,
  officePreviewMode,
  WORK_MODE_LABEL,
  RAIL_WORK_MODE_LABEL,
  groupByWorkMode,
} from "../src/work-mode.ts";

test("缺省与非法值都归科研", () => {
  assert.equal(normalizeWorkMode(undefined), "research");
  assert.equal(normalizeWorkMode(null), "research");
  assert.equal(normalizeWorkMode(""), "research");
  assert.equal(normalizeWorkMode("Research"), "research");
  assert.equal(normalizeWorkMode("coding"), "coding");
  assert.equal(normalizeWorkMode("office"), "office");
  assert.equal(WORK_MODE_LABEL.research, "科研");
});

test("项目栏按科研/编程/办公分段，未添加沉底，空组不出现", () => {
  const items = [
    { id: "a", mode: "office" },
    { id: "b", mode: "research" },
    { id: "c", mode: "office" },
    { id: "d", mode: "coding" },
    { id: "e", mode: undefined },
    { id: "f", mode: "unregistered" },
  ];
  const grouped = groupByWorkMode(items, (x) => x.mode);
  assert.deepEqual(
    grouped.map((g) => [g.mode, g.items.map((i) => i.id)]),
    [
      ["research", ["b", "e"]],
      ["coding", ["d"]],
      ["office", ["a", "c"]],
      ["unregistered", ["f"]],
    ],
  );
  assert.equal(RAIL_WORK_MODE_LABEL.unregistered, "未添加");
  assert.deepEqual(
    groupByWorkMode([], () => "research"),
    [],
  );
});

test("已注册或档案卡已落盘则锁定工作方式，空档案卡不锁", () => {
  assert.deepEqual(
    lockWorkModeFromConfig({ existingMode: "coding" }),
    { mode: "coding", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ fileMode: "office" }),
    { mode: "office", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ fileMode: "research", stepCount: 2 }),
    { mode: "research", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ pipelineOptOut: true }),
    { mode: "research", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ fileMode: "research", stepCount: 0 }),
    { mode: "research", locked: false },
  );
});

test("编程状态：落后优先于脏工作区", () => {
  assert.equal(
    deriveCodingKind({
      isBase: false,
      isPrimary: false,
      dirty: true,
      ahead: 2,
      behind: 3,
      hasWorktree: true,
    }),
    "sync",
  );
});

test("编程状态：干净领先 = 等待合并；主仓基准 = 基准", () => {
  assert.equal(
    deriveCodingKind({
      isBase: false,
      isPrimary: false,
      dirty: false,
      ahead: 4,
      behind: 0,
      hasWorktree: true,
    }),
    "ready",
  );
  assert.equal(
    deriveCodingKind({
      isBase: true,
      isPrimary: true,
      dirty: false,
      ahead: 0,
      behind: 0,
      hasWorktree: true,
    }),
    "base",
  );
});

test("编程状态：有工作树的 0/0 是未开始，没工作树是可清理", () => {
  const zero = {
    isBase: false,
    isPrimary: false,
    dirty: false,
    ahead: 0,
    behind: 0,
  };
  assert.equal(deriveCodingKind({ ...zero, hasWorktree: true }), "idle");
  assert.equal(deriveCodingKind({ ...zero, hasWorktree: false }), "prune");
});

test("办公类型与预览白名单", () => {
  assert.equal(officeDocKind("notes/a.md"), "doc");
  assert.equal(officeDocKind("t.xlsx"), "sheet");
  assert.equal(officeDocKind("x.pptx"), "slide");
  assert.equal(officeDocKind("p.PDF"), "pdf");
  assert.equal(officeDocKind("a.png"), "image");
  assert.equal(officeDocKind("src/main.rs"), "other");
  assert.equal(isOfficePreviewable("a.docx"), true);
  assert.equal(isOfficePreviewable("a.pptx"), false);
  assert.equal(isOfficePreviewable("a.doc"), false);
  assert.equal(isOfficePreviewable("a.csv"), true);
  assert.equal(officePreviewMode("a.csv"), "text");
  assert.equal(officePreviewMode("a.tsv"), "text");
  assert.equal(officePreviewMode("a.docx"), "docx");
  assert.equal(officePreviewMode("a.DOC"), "external");
  assert.equal(officePreviewMode("REPORT.PDF"), "pdf");
});

test("办公搜索：文件名或相对路径，空查询全过", () => {
  assert.equal(officeDocMatchesQuery("纪要.docx", "docs/纪要.docx", ""), true);
  assert.equal(
    officeDocMatchesQuery("纪要.docx", "docs/纪要.docx", "  纪要  "),
    true,
  );
  assert.equal(
    officeDocMatchesQuery("Minutes.docx", "docs/q1/Minutes.docx", "Q1"),
    true,
  );
  assert.equal(
    officeDocMatchesQuery("a.docx", "folder\\sub\\a.docx", "folder/sub"),
    true,
  );
  assert.equal(officeDocMatchesQuery("a.docx", "docs/a.docx", "xyz"), false);
});

test("工作台办公卡进行中：运行标签或七日内会话/打开", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  assert.equal(
    isOfficeInProgress({
      hasLiveTab: true,
      lastSessionAt: null,
      lastOpenedAt: null,
      nowMs: now,
    }),
    true,
  );
  assert.equal(
    isOfficeInProgress({
      hasLiveTab: false,
      lastSessionAt: "2026-08-28T12:00:00Z",
      lastOpenedAt: null,
      nowMs: now,
    }),
    true,
  );
  assert.equal(
    isOfficeInProgress({
      hasLiveTab: false,
      lastSessionAt: "2026-08-20T12:00:00Z",
      lastOpenedAt: null,
      nowMs: now,
    }),
    false,
  );
});

test("办公文件行进行中：只认这份文件的活标签", () => {
  const file = officeFileReuseKey("/p", "流畅阅读/效果演示/演示1.gif");
  assert.equal(
    officeFileReuseKey("/p", "流畅阅读\\效果演示\\演示1.gif"),
    file,
  );
  assert.equal(
    officeFileInProgress(file, [file]),
    true,
  );
  assert.equal(
    officeFileInProgress(file, [officeProjectReuseKey("/p")]),
    false,
  );
  assert.equal(officeFileInProgress(file, [undefined, "office:/p:other.md"]), false);
  assert.equal(officeFileInProgress(file, []), false);
});

test("项目新对话复用键按工作方式分开", () => {
  assert.equal(projectChatReuseKey("office", "/p"), "office:/p:project");
  assert.equal(projectChatReuseKey("coding", "/p"), "coding:/p:project");
  assert.equal(projectChatReuseKey("research", "/p"), "research:/p:project");
  assert.equal(officeProjectReuseKey("/p"), "office:/p:project");
});

test("编程事实芯片：干净已推送不占位，只亮异常", () => {
  assert.deepEqual(
    codingFactChips({
      dirty: false,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: true,
      baseBranch: "main",
    }),
    [],
  );
  assert.deepEqual(
    codingFactChips({
      dirty: true,
      dirtyCount: 1,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: true,
      baseBranch: "main",
      hostKind: "github",
    }),
    [
      {
        key: "dirty",
        label: "1 个未提交",
        tone: "warn",
        tip: "有未提交的改动",
      },
      {
        key: "remote",
        label: "已推送",
        tone: "muted",
        tip: "该分支已推到 GitHub",
      },
    ],
  );
  assert.deepEqual(
    codingFactChips({
      dirty: false,
      ahead: 2,
      behind: 1,
      unpushed: 3,
      hasUpstream: true,
      baseBranch: "main",
      hostKind: "github",
    }),
    [
      {
        key: "ahead",
        label: "待合入 2",
        tone: "ok",
        tip: "比基准 main 多 2 个提交，可以合并",
      },
      {
        key: "behind",
        label: "落后基准 1",
        tone: "warn",
        tip: "基准 main 有 1 个新提交",
      },
      {
        key: "remote",
        label: "未推送 3",
        tone: "warn",
        tip: "比 GitHub 上该分支多 3 个提交",
      },
    ],
  );
  assert.equal(
    codingFactChips({
      dirty: false,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: false,
      baseBranch: "main",
    })[0]?.label,
    "无上游",
  );
  assert.deepEqual(
    codingFactChips({
      dirty: false,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: true,
      upstreamBehind: 2,
      baseBranch: "main",
      hostKind: "github",
    }),
    [
      {
        key: "upstreamBehind",
        label: "远程有更新 2",
        tone: "warn",
        tip: "GitHub 上该分支有 2 个新提交，可拉取",
      },
    ],
  );
});
