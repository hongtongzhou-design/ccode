import assert from "node:assert/strict";
import test from "node:test";
import {
  QUICK_FILTERS,
  applySessionFilters,
  buildScopeSuggestions,
  sessionTime,
  type QuickFilterId,
  type ScopeChip,
} from "../src/session-filter.ts";
import type { SessionMetaDto } from "../src/types.ts";

const DAY = 86_400_000;
/** 固定「现在」= 2026-08-15 12:00 本地，避免跨日抖动 */
const NOW = new Date(2026, 7, 15, 12, 0, 0).getTime();
const at = (offsetDays: number) =>
  new Date(NOW - offsetDays * DAY).toISOString();

function s(over: Partial<SessionMetaDto> = {}): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: Math.random().toString(36).slice(2),
    projectPath: "/w/alpha",
    title: null,
    createdAt: at(0),
    updatedAt: at(0),
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: true,
    chainCount: 1,
    workspace: null,
    stepName: null,
    summary: null,
    live: false,
    source: "cli",
    internal: false,
    handoffFromAgent: null,
    handoffFromSession: null,
    taskId: null,
    taskName: null,
    ...over,
  };
}

const NO_LIVE = new Set<string>();
const q = (...ids: QuickFilterId[]) => new Set(ids);

test("默认口径：排除归档与内部会话", () => {
  const rows = [s(), s({ archived: true }), s({ internal: true })];
  assert.equal(applySessionFilters(rows, q(), [], NO_LIVE, NOW).length, 1);
});

test("archived 是放宽不是只看归档", () => {
  const rows = [s(), s({ archived: true })];
  assert.equal(
    applySessionFilters(rows, q("archived"), [], NO_LIVE, NOW).length,
    2,
  );
});

test("internal 是收窄：只看内部 AI", () => {
  const rows = [s(), s({ internal: true }), s({ internal: true })];
  const out = applySessionFilters(rows, q("internal"), [], NO_LIVE, NOW);
  assert.equal(out.length, 2);
  assert.ok(out.every((x) => x.internal));
});

test("pinned 只看已保留", () => {
  const rows = [s({ pinned: true }), s()];
  assert.equal(applySessionFilters(rows, q("pinned"), [], NO_LIVE, NOW).length, 1);
});

test("live 认后端标记，也认终端标签镜像", () => {
  const a = s({ live: true });
  const b = s({ agent: "codex", sessionId: "S9" });
  const c = s();
  const liveKeys = new Set(["codex\nS9"]);
  const out = applySessionFilters([a, b, c], q("live"), [], liveKeys, NOW);
  assert.equal(out.length, 2);
});

test("今天 / 近 7 天按本机日界，week 覆盖 today", () => {
  const rows = [s({ updatedAt: at(0) }), s({ updatedAt: at(3) }), s({ updatedAt: at(30) })];
  assert.equal(applySessionFilters(rows, q("today"), [], NO_LIVE, NOW).length, 1);
  assert.equal(applySessionFilters(rows, q("week"), [], NO_LIVE, NOW).length, 2);
  // 同时勾选取更宽的
  assert.equal(
    applySessionFilters(rows, q("today", "week"), [], NO_LIVE, NOW).length,
    2,
  );
});

test("没有时间戳的会话不进时间筛选结果", () => {
  const rows = [s({ updatedAt: null, createdAt: null })];
  assert.equal(applySessionFilters(rows, q("today"), [], NO_LIVE, NOW).length, 0);
  // 不加时间筛选时仍然列出
  assert.equal(applySessionFilters(rows, q(), [], NO_LIVE, NOW).length, 1);
});

test("updatedAt 缺失时回落 createdAt", () => {
  assert.equal(sessionTime(s({ updatedAt: null, createdAt: at(1) })) !== null, true);
  assert.equal(sessionTime(s({ updatedAt: null, createdAt: "坏时间" })), null);
});

test("作用域 chip：同类取或、异类取与", () => {
  const rows = [
    s({ projectPath: "/w/alpha", stepName: "检索" }),
    s({ projectPath: "/w/beta", stepName: "检索" }),
    s({ projectPath: "/w/alpha", stepName: "写作" }),
  ];
  const p = (v: string): ScopeChip => ({ kind: "project", value: v, label: v });
  const st = (v: string): ScopeChip => ({ kind: "step", value: v, label: v });
  // 两个项目 chip = 并集
  assert.equal(
    applySessionFilters(rows, q(), [p("/w/alpha"), p("/w/beta")], NO_LIVE, NOW).length,
    3,
  );
  // 项目 + 步骤 = 交集
  assert.equal(
    applySessionFilters(rows, q(), [p("/w/alpha"), st("检索")], NO_LIVE, NOW).length,
    1,
  );
});

test("搜索建议按项目/步骤/卡片/agent 分类去重", () => {
  const rows = [
    s({ projectPath: "/w/lit-review", stepName: "文献检索与筛选", taskName: "检索策略" }),
    s({ projectPath: "/w/lit-review", stepName: "文献精读", taskName: null }),
  ];
  const out = buildScopeSuggestions(rows, "检索");
  const kinds = out.map((c) => c.kind);
  assert.ok(kinds.includes("step"), "应命中步骤名");
  assert.ok(kinds.includes("task"), "应命中卡片名");
  // 同一值不重复出现
  assert.equal(new Set(out.map((c) => `${c.kind}:${c.value}`)).size, out.length);
  // 空查询不给建议
  assert.deepEqual(buildScopeSuggestions(rows, "  "), []);
});

test("建议每类有条数上限", () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    s({ projectPath: `/w/proj-${i}` }),
  );
  const out = buildScopeSuggestions(rows, "proj", 4);
  assert.equal(out.filter((c) => c.kind === "project").length, 4);
});

test("快筛清单 id 唯一", () => {
  assert.equal(new Set(QUICK_FILTERS.map((f) => f.id)).size, QUICK_FILTERS.length);
});
