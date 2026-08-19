import assert from "node:assert/strict";
import test from "node:test";
import {
  filterLitDismissed,
  groupEntriesByDay,
  includedLineFor,
  isRead,
  litInboxCandidates,
  normalizeTitle,
  paperResourceFor,
  pdfUrlFor,
  relevanceRank,
  staleLitHint,
  weeklyBuckets,
} from "../src/lit-watch.ts";
import type { WatchEntryDto } from "../src/lit-watch.ts";
import type { ScheduleDto } from "../src/types.ts";

let seq = 0;
function entry(patch: Partial<WatchEntryDto>): WatchEntryDto {
  seq += 1;
  return {
    id: `w-${seq}`,
    title: `Paper ${seq}`,
    source: "arxiv",
    authors: "",
    abstractFirst: "",
    keywordsHit: [],
    relevance: "待确认",
    journal: null,
    zhSummary: "",
    url: "",
    date: null,
    rawLineRange: [1, 1],
    ...patch,
  };
}

// 固定「现在」为 2026-08-18（周二）本地正午，避开日界抖动
const NOW = new Date(2026, 7, 18, 12, 0, 0);

test("relevanceRank：推荐 > 相关 > 待确认/未知", () => {
  assert.ok(relevanceRank("推荐") < relevanceRank("相关"));
  assert.ok(relevanceRank("相关") < relevanceRank("待确认"));
  assert.equal(relevanceRank("未知值"), relevanceRank("待确认"));
});

test("groupEntriesByDay：今天/昨天/更早三桶，无 date 进更早，空桶不返回", () => {
  const groups = groupEntriesByDay(
    [
      entry({ id: "a", date: "2026-08-18", relevance: "待确认" }),
      entry({ id: "b", date: "2026-08-17", relevance: "推荐" }),
      entry({ id: "c", date: "2026-08-01", relevance: "相关" }),
      entry({ id: "d", date: null, relevance: "推荐" }),
      entry({ id: "e", date: "2026-08-18", relevance: "推荐" }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.entries.map((e) => e.id)]),
    [
      ["today", "今天", ["e", "a"]], // 组内按相关性：推荐排前
      ["yesterday", "昨天", ["b"]],
      ["earlier", "更早", ["d", "c"]], // 推荐排前；无 date 进更早
    ],
  );
});

test("groupEntriesByDay：坏日期串诚实落「更早」，不抛错", () => {
  const groups = groupEntriesByDay([entry({ date: "not-a-date" })], NOW);
  assert.deepEqual(groups.map((g) => g.key), ["earlier"]);
});

test("weeklyBuckets：近 8 周计数，周一起点，无 date 不计", () => {
  // 2026-08-18 所在周周一 = 2026-08-17；上周周一 = 2026-08-10
  const buckets = weeklyBuckets(
    [
      entry({ date: "2026-08-18" }),
      entry({ date: "2026-08-17" }),
      entry({ date: "2026-08-10" }),
      entry({ date: null }),
    ],
    8,
    NOW,
  );
  assert.equal(buckets.length, 8);
  assert.deepEqual(
    buckets.map((b) => b.count),
    [0, 0, 0, 0, 0, 0, 1, 2],
  );
  assert.equal(buckets[7].label, "8月17日周");
  // 桶首必为周一
  assert.equal(buckets[7].start.getDay(), 1);
});

test("pdfUrlFor：arXiv abs 转 pdf 直链，其余 http 原样，非 http(s) 为 null", () => {
  assert.equal(
    pdfUrlFor("https://arxiv.org/abs/2301.01234"),
    "https://arxiv.org/pdf/2301.01234",
  );
  assert.equal(
    pdfUrlFor("http://arxiv.org/abs/2301.01234v2"),
    "https://arxiv.org/pdf/2301.01234v2",
  );
  assert.equal(
    pdfUrlFor("https://arxiv.org/abs/2301.01234?utm=1"),
    "https://arxiv.org/pdf/2301.01234",
  );
  assert.equal(
    pdfUrlFor("https://arxiv.org/pdf/2301.01234"),
    "https://arxiv.org/pdf/2301.01234",
  );
  assert.equal(
    pdfUrlFor("https://doi.org/10.1000/xyz"),
    "https://doi.org/10.1000/xyz",
  );
  assert.equal(pdfUrlFor("10.1000/xyz"), null);
  assert.equal(pdfUrlFor(""), null);
  assert.equal(pdfUrlFor("  "), null);
});

test("includedLineFor：作者在附年份（批次年），作者缺整段「待补」", () => {
  assert.deepEqual(
    includedLineFor(
      entry({
        title: "T",
        authors: "Vaswani et al.",
        source: "arxiv",
        url: "https://arxiv.org/abs/1",
        date: "2026-08-18",
      }),
    ),
    {
      title: "T",
      authorsYear: "Vaswani et al., 2026",
      source: "arxiv",
      link: "https://arxiv.org/abs/1",
    },
  );
  assert.equal(
    includedLineFor(entry({ authors: "  ", date: "2026-08-18" })).authorsYear,
    "待补",
  );
  assert.equal(
    includedLineFor(entry({ authors: "Vaswani et al.", date: null }))
      .authorsYear,
    "Vaswani et al.",
  );
});

test("normalizeTitle：小写、标点折叠为单空格", () => {
  assert.equal(
    normalizeTitle("Attention Is All You Need!"),
    "attention is all you need",
  );
  assert.equal(normalizeTitle("Deep-Residual  Learning"), "deep residual learning");
  assert.equal(normalizeTitle("  "), "");
});

test("isRead：规范化标题与笔记文件名互相包含即已读；无笔记全未读", () => {
  const e = entry({ title: "Attention Is All You Need" });
  assert.equal(isRead(e, ["attention-is-all-you-need.md"]), true);
  assert.equal(isRead(e, ["Attention is all you need.md"]), true);
  // 笔记名更短但互相包含（笔记是标题的一段）也算
  assert.equal(isRead(e, ["attention-is-all-you-need-精读.md"]), true);
  assert.equal(isRead(e, ["another-paper.md"]), false);
  assert.equal(isRead(e, []), false);
  assert.equal(isRead(entry({ title: "  " }), ["a.md"]), false);
});

test("paperResourceFor：paper 类资源按文件名规范化匹配；非 paper 不参与", () => {
  const e = entry({ title: "Attention Is All You Need" });
  const resources = [
    { path: "papers/attention-is-all-you-need.pdf", type: "paper" },
    { path: "papers/notes.md", type: "reference" },
  ];
  assert.equal(
    paperResourceFor(e, resources),
    "papers/attention-is-all-you-need.pdf",
  );
  assert.equal(
    paperResourceFor(entry({ title: "别的标题" }), resources),
    null,
  );
  assert.equal(
    paperResourceFor(e, [{ path: "papers/attention-is-all-you-need.pdf", type: "dataset" }]),
    null,
  );
});

test("staleLitHint：有关联步骤 + 新命中 + 巡检晚于步骤推进才提醒", () => {
  assert.equal(
    staleLitHint("文献检索", "2026-08-18T09:00:00Z", 3, "2026-08-10T10:00:00Z"),
    true,
  );
  // 巡检早于步骤推进：产物是新的，不提醒
  assert.equal(
    staleLitHint("文献检索", "2026-08-10T09:00:00Z", 3, "2026-08-18T10:00:00Z"),
    false,
  );
  // 无关联步骤 / 无新命中 / 步骤还没工作区（无可过期产物）
  assert.equal(staleLitHint(null, "2026-08-18T09:00:00Z", 3, "2026-08-10T10:00:00Z"), false);
  assert.equal(staleLitHint("文献检索", "2026-08-18T09:00:00Z", 0, "2026-08-10T10:00:00Z"), false);
  assert.equal(staleLitHint("文献检索", "2026-08-18T09:00:00Z", null, "2026-08-10T10:00:00Z"), false);
  assert.equal(staleLitHint("文献检索", "2026-08-18T09:00:00Z", 3, null), false);
  // 坏时间串不提醒（诚实回落）
  assert.equal(staleLitHint("文献检索", "bad", 3, "2026-08-10T10:00:00Z"), false);
});

function schedule(patch: Partial<ScheduleDto>): ScheduleDto {
  return {
    id: "s-1",
    name: "文献雷达",
    projectRoot: "/repo",
    skill: "lit-watch",
    profileId: null,
    frequency: "daily",
    weekday: null,
    hour: 9,
    minute: 0,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    history: [],
    ...patch,
  };
}

test("litInboxCandidates：最近一次成功 run 有新命中且 24h 内才入选", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const fresh = schedule({
    id: "s-1",
    lastRunAt: "2026-08-18T09:00:00Z",
    lastStatus: "ok",
    history: [{ at: "2026-08-18T09:00:00Z", status: "ok", summary: "", newEntries: 3 }],
  });
  assert.deepEqual(litInboxCandidates([fresh], now), [
    {
      scheduleId: "s-1",
      projectRoot: "/repo",
      count: 3,
      at: "2026-08-18T09:00:00Z",
    },
  ]);
  // 超过 24h 不再打扰
  const stale = schedule({
    id: "s-2",
    lastRunAt: "2026-08-16T09:00:00Z",
    lastStatus: "ok",
    history: [{ at: "2026-08-16T09:00:00Z", status: "ok", summary: "", newEntries: 3 }],
  });
  assert.deepEqual(litInboxCandidates([stale], now), []);
  // 最近一次成功 run 没有新命中（或老记录缺 newEntries）
  const zero = schedule({
    id: "s-3",
    lastRunAt: "2026-08-18T09:00:00Z",
    lastStatus: "ok",
    history: [{ at: "2026-08-18T09:00:00Z", status: "ok", summary: "", newEntries: 0 }],
  });
  const legacy = schedule({
    id: "s-4",
    lastRunAt: "2026-08-18T09:00:00Z",
    lastStatus: "ok",
    history: [{ at: "2026-08-18T09:00:00Z", status: "ok", summary: "" }],
  });
  assert.deepEqual(litInboxCandidates([zero, legacy], now), []);
  // 最近失败、上一次成功有新命中：仍按最近一次成功 run 计
  const failThenOk = schedule({
    id: "s-5",
    lastRunAt: "2026-08-18T10:00:00Z",
    lastStatus: "error",
    history: [
      { at: "2026-08-18T10:00:00Z", status: "error", summary: "超时" },
      { at: "2026-08-18T09:00:00Z", status: "ok", summary: "", newEntries: 2 },
    ],
  });
  assert.deepEqual(
    litInboxCandidates([failThenOk], now).map((c) => [c.scheduleId, c.count]),
    [["s-5", 2]],
  );
});

test("filterLitDismissed：忽略表内的条目被过滤", () => {
  const entries = [entry({ id: "w-1" }), entry({ id: "w-2" })];
  assert.deepEqual(
    filterLitDismissed(entries, new Set(["w-1"])).map((e) => e.id),
    ["w-2"],
  );
  assert.deepEqual(filterLitDismissed(entries, new Set()).length, 2);
});
