import assert from "node:assert/strict";
import test from "node:test";
import {
  codingStatusLine,
  countTouchedSince,
  filterPortsForRepo,
  filterProjectSessions,
  isProjectNotesPath,
  isUserNoteFile,
  officeContinueItems,
  officeDirLabel,
  officePromptSuggestions,
  officeRecentPath,
  officeShowContinueCard,
  partitionResources,
  officeKindCounts,
  officeStatusLine,
  sessionMentionsFile,
  sortWorkspacesByAttention,
  startOfYesterdayMs,
  workspaceAttentionRank,
} from "../src/project-status.ts";

test("编程状态行：工作树数 + 待合并 + 需同步", () => {
  assert.equal(
    codingStatusLine({
      worktrees: [
        { isBase: true, isPrimary: true, dirty: false, ahead: 0, behind: 0 },
        { isBase: false, isPrimary: false, dirty: false, ahead: 2, behind: 0 },
        { isBase: false, isPrimary: false, dirty: false, ahead: 0, behind: 1 },
      ],
    }),
    "3 个工作树 · 1 个待合并 · 1 个需同步",
  );
});

test("办公状态行与昨天动过计数", () => {
  assert.equal(officeStatusLine({ total: 0, touchedYesterday: 0 }), "还没有文档");
  assert.equal(
    officeStatusLine({ total: 47, touchedYesterday: 3 }),
    "文档 47 · 昨天动过 3 篇",
  );
  const since = Date.parse("2026-09-02T00:00:00Z");
  assert.equal(
    countTouchedSince(
      [
        { modified: "2026-09-03T01:00:00Z" },
        { lastOpenedAt: "2026-09-01T01:00:00Z" },
        { modified: "2026-09-02T08:00:00Z" },
      ],
      since,
    ),
    2,
  );
  assert.ok(startOfYesterdayMs(Date.parse("2026-09-03T12:00:00Z")) < Date.parse("2026-09-03T00:00:00Z"));
});

test("工作区排序：冲突最先，等你验收其次", () => {
  assert.equal(
    workspaceAttentionRank({
      status: "active",
      mergedAt: null,
      canResolveMerge: true,
    }),
    0,
  );
  assert.equal(
    workspaceAttentionRank({
      status: "active",
      mergedAt: null,
      ahead: 2,
    }),
    1,
  );
  const sorted = sortWorkspacesByAttention(
    [
      { id: "a", status: "active", mergedAt: null },
      { id: "b", status: "active", mergedAt: null },
      { id: "c", status: "active", mergedAt: "x" },
    ],
    (w) =>
      w.id === "b"
        ? { canResolveMerge: true }
        : w.id === "a"
          ? { ahead: 3 }
          : {},
  );
  assert.deepEqual(
    sorted.map((w) => w.id),
    ["b", "a", "c"],
  );
});

test("资源拆成文献与数据", () => {
  const { papers, data } = partitionResources([
    { path: "papers/a.pdf", type: "paper" },
    { path: "data/t.csv", type: "dataset" },
    { path: "notes/x.md", type: "other" },
    { path: "raw.xlsx", type: "other" },
    { path: "refs.bib", type: "reference" },
  ]);
  assert.deepEqual(
    papers.map((r) => r.path),
    ["papers/a.pdf", "refs.bib"],
  );
  assert.deepEqual(
    data.map((r) => r.path),
    ["data/t.csv", "raw.xlsx"],
  );
  assert.equal(isProjectNotesPath("notes/a.md"), true);
  assert.equal(isProjectNotesPath("data/a.csv"), false);
});

test("笔记过滤：glossary 去掉，inbox 留下", () => {
  assert.equal(isUserNoteFile("inbox.md", false), true);
  assert.equal(isUserNoteFile("glossary.md", false), false);
  assert.equal(isUserNoteFile("notes", true), false);
  assert.equal(isUserNoteFile("a.txt", false), false);
});

test("办公筛选计数与继续上次", () => {
  const counts = officeKindCounts(["a.md", "b.pdf", "c.xlsx", "d.PDF"]);
  assert.equal(counts.all, 4);
  assert.equal(counts.doc, 1);
  assert.equal(counts.pdf, 2);
  assert.equal(counts.sheet, 1);
  const docs = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
  assert.deepEqual(
    officeContinueItems(docs, { "/c": "2026-09-03", "/a": "2026-09-01" }, 2).map(
      (d) => d.path,
    ),
    ["/c", "/a"],
  );
  assert.equal(officeRecentPath(docs, { "/c": "2026-09-03" }), "/c");
  assert.equal(officeShowContinueCard(1, 1), false);
  assert.equal(officeShowContinueCard(3, 1), false);
  assert.equal(officeShowContinueCard(4, 1), true);
  assert.equal(officeShowContinueCard(8, 0), false);
});

test("办公相对路径只在有子目录时展示", () => {
  assert.equal(officeDirLabel("价格.xlsx", "价格.xlsx"), null);
  assert.equal(officeDirLabel("价格.xlsx", "./价格.xlsx"), null);
  assert.equal(officeDirLabel("价格.xlsx", "财务/价格.xlsx"), "财务");
  assert.equal(officeDirLabel("价格.xlsx", "a\\b\\价格.xlsx"), "a/b");
});

test("办公空对话建议跟最近打开的表格走", () => {
  const docs = [
    { path: "/p/国内外AI模型价格.xlsx", name: "国内外AI模型价格.xlsx" },
    { path: "/p/说明.md", name: "说明.md" },
  ];
  const chips = officePromptSuggestions(
    docs,
    { "/p/国内外AI模型价格.xlsx": "2026-09-03" },
    2,
  );
  assert.equal(chips.length, 2);
  assert.equal(chips[0].label, "分析「国内外AI模型价格」");
  assert.equal(chips[1].label, "提取核心数据");
  assert.match(chips[0].prompt, /请分析这份表格/);
  assert.deepEqual(officePromptSuggestions([], {}, 2), []);
});

test("会话标题对得上文件名才算对话徽标", () => {
  assert.equal(
    sessionMentionsFile({ customTitle: "报告.docx", title: "hi" }, "报告.docx"),
    true,
  );
  assert.equal(
    sessionMentionsFile({ customTitle: null, title: "别的" }, "报告.docx"),
    false,
  );
});

test("端口按仓库根过滤，前缀路径不算", () => {
  const ports = [
    { cwd: "/repo/ccode/apps" },
    { cwd: "/repo/ccode2" },
    { cwd: null },
  ];
  assert.deepEqual(
    filterPortsForRepo(ports, ["/repo/ccode"]).map((p) => p.cwd),
    ["/repo/ccode/apps"],
  );
});

test("本项目会话：工作树路径算进去，置顶提前，截断上限", () => {
  const rows = filterProjectSessions(
    [
      { projectPath: "/other", pinned: true, id: "x" },
      { projectPath: "/repo", pinned: false, id: "a" },
      { projectPath: "/repo/wt", pinned: true, id: "b" },
      { projectPath: "/repo", pinned: false, id: "c" },
    ],
    "/repo",
    ["/repo/wt"],
    { limit: 2 },
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["b", "a"],
  );
});

test("本项目会话不收雷达解读和无头 AI", () => {
  const rows = filterProjectSessions(
    [
      { projectPath: "/repo", id: "real", title: "继续写实验" },
      {
        projectPath: "/repo",
        id: "explain",
        title: "你是科研文献快筛助手。根据下面给出的题录写解读",
      },
      {
        projectPath: "/repo",
        id: "radar",
        title: "请使用 lit-watch 技能执行一次文献巡检：按 papers/watchlist.md",
      },
      { projectPath: "/repo", id: "flag", internal: true, title: "普通提问" },
      { projectPath: "/repo", id: "src", source: "ccode-ai", title: "普通提问" },
      { projectPath: "/repo", id: "ask", title: '请看这份文件："Addressing …"' },
      {
        projectPath: "/repo",
        id: "read",
        title: "【阅读上下文】我在沉浸阅读区读",
      },
      {
        projectPath: "/repo",
        id: "handoff",
        title: "读 .ccode/handoff-20260822T021523Z.md 分叉简",
      },
    ],
    "/repo",
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["real"],
  );
});
