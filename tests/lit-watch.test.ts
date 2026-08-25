import assert from "node:assert/strict";
import test from "node:test";
import {
  entryPassesFilter,
  filterLitDismissed,
  fulltextLinkFor,
  groupEntriesByDay,
  groupEntriesByKeyword,
  includedLineFor,
  isRead,
  litInboxCandidates,
  litWatchFilterActive,
  litWatchFilterLabel,
  metricsTooltip,
  normalizeTitle,
  paperResourceFor,
  pdfUrlFor,
  relevanceRank,
  sourceDisplayName,
  staleLitHint,
  UNCATEGORIZED_KEYWORD,
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
    metrics: null,
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

test("groupEntriesByKeyword：每条只归第一个关键词，多命中不重复出现", () => {
  const groups = groupEntriesByKeyword([
    entry({ id: "a", keywordsHit: ["moe", "llm"] }),
    entry({ id: "b", keywordsHit: ["llm", "moe"] }),
  ]);
  const flat = groups.flatMap((g) => g.entries.map((e) => e.id));
  assert.deepEqual(flat.sort(), ["a", "b"]);
  assert.equal(
    groups.find((g) => g.keyword === "moe")?.entries.map((e) => e.id).join(),
    "a",
  );
  assert.equal(
    groups.find((g) => g.keyword === "llm")?.entries.map((e) => e.id).join(),
    "b",
  );
});

test("groupEntriesByKeyword：无关键词归「未分类」且恒排最后", () => {
  const groups = groupEntriesByKeyword([
    entry({ id: "u", keywordsHit: [] }),
    entry({ id: "w", keywordsHit: ["  "] }), // 空白关键词同样算未分类
    entry({ id: "a", keywordsHit: ["moe"] }),
    entry({ id: "b", keywordsHit: ["moe"] }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.keyword, g.entries.map((e) => e.id)]),
    [
      ["moe", ["a", "b"]],
      [UNCATEGORIZED_KEYWORD, ["u", "w"]],
    ],
  );
  // 未分类即使条目最多也排最后
  const lastHeavy = groupEntriesByKeyword([
    entry({ keywordsHit: [] }),
    entry({ keywordsHit: [] }),
    entry({ keywordsHit: ["moe"] }),
  ]);
  assert.deepEqual(
    lastHeavy.map((g) => g.keyword),
    ["moe", UNCATEGORIZED_KEYWORD],
  );
});

test("groupEntriesByKeyword：组按条目数降序、同数按关键词字母序", () => {
  const groups = groupEntriesByKeyword([
    entry({ keywordsHit: ["beta"] }),
    entry({ keywordsHit: ["gamma"] }),
    entry({ keywordsHit: ["alpha"] }),
    entry({ keywordsHit: ["alpha"] }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.keyword, g.entries.length]),
    [
      ["alpha", 2],
      ["beta", 1],
      ["gamma", 1],
    ],
  );
});

test("groupEntriesByKeyword：组内按相关性排序（推荐>相关>待确认），同级稳定序", () => {
  const groups = groupEntriesByKeyword([
    entry({ id: "a", keywordsHit: ["moe"], relevance: "待确认" }),
    entry({ id: "b", keywordsHit: ["moe"], relevance: "推荐" }),
    entry({ id: "c", keywordsHit: ["moe"], relevance: "相关" }),
    entry({ id: "d", keywordsHit: ["moe"], relevance: "待确认" }),
  ]);
  assert.deepEqual(
    groups[0].entries.map((e) => e.id),
    ["b", "c", "a", "d"],
  );
});

test("groupEntriesByKeyword：空输入返回空表，无空组", () => {
  assert.deepEqual(groupEntriesByKeyword([]), []);
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
  assert.equal(pdfUrlFor("doi:10.1000/xyz"), null);
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
  assert.equal(isRead(entry({ title: "Battery" }), ["battery-review.md"]), false);
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
  assert.deepEqual(litInboxCandidates([failThenOk], now), []);
  // 最新一次成功运行后，随后失败不应刷新时间窗口或制造新的候选。
  const okThenFail = schedule({
    id: "s-6",
    lastRunAt: "2026-08-18T10:00:00Z",
    lastStatus: "ok",
    history: [
      { at: "2026-08-18T10:00:00Z", status: "ok", summary: "", newEntries: 2 },
      { at: "2026-08-17T09:00:00Z", status: "ok", summary: "", newEntries: 1 },
    ],
  });
  assert.deepEqual(litInboxCandidates([okThenFail], now).map((c) => [c.scheduleId, c.count]), [["s-6", 2]]);
});

test("filterLitDismissed：忽略表内的条目被过滤", () => {
  const entries = [entry({ id: "w-1" }), entry({ id: "w-2" })];
  assert.deepEqual(
    filterLitDismissed(entries, new Set(["w-1"])).map((e) => e.id),
    ["w-2"],
  );
  assert.deepEqual(filterLitDismissed(entries, new Set()).length, 2);
});

test("sourceDisplayName：剥出版商括号尾巴", () => {
  assert.equal(
    sourceDisplayName("Advanced Functional Materials (Wiley)"),
    "Advanced Functional Materials",
  );
  assert.equal(
    sourceDisplayName("Industrial & Engineering Chemistry Research (ACS)"),
    "Industrial & Engineering Chemistry Research",
  );
  // 全角括号、多级尾巴
  assert.equal(sourceDisplayName(" Advanced Materials（Wiley） "), "Advanced Materials");
  assert.equal(sourceDisplayName("2D Materials (IOP) (UK)"), "2D Materials");
  // 无尾巴原样返回；整串就是括号（剥完为空）不剥
  assert.equal(sourceDisplayName("arxiv"), "arxiv");
  assert.equal(sourceDisplayName("(Wiley)"), "(Wiley)");
});

test("fulltextLinkFor：全文可得性分流", () => {
  // arXiv abs 页 → pdf 直链（可免费下载）
  assert.deepEqual(fulltextLinkFor("https://arxiv.org/abs/2401.12345"), {
    kind: "pdf",
    url: "https://arxiv.org/pdf/2401.12345",
  });
  // .pdf 结尾的直链 → 可下载（带 query 也算）
  assert.deepEqual(fulltextLinkFor("https://example.com/paper.pdf?x=1"), {
    kind: "pdf",
    url: "https://example.com/paper.pdf?x=1",
  });
  // 裸 DOI / doi.org / 出版商落地页 → 来源页（不摆装死的下载钮）
  assert.equal(fulltextLinkFor("10.1002/adma.74773").kind, "source");
  assert.equal(fulltextLinkFor("doi: 10.1002/adma.74773").kind, "source");
  assert.equal(
    fulltextLinkFor("https://doi.org/10.1002/adma.74773").kind,
    "source",
  );
  assert.equal(
    fulltextLinkFor("https://www.nature.com/articles/s41586-026-00001").kind,
    "source",
  );
  // 空串 / 无链接 → none
  assert.equal(fulltextLinkFor("").kind, "none");
  assert.equal(fulltextLinkFor("   ").kind, "none");
});

test("metricsTooltip：刊数 + 下载时间 + 上游新版提示", () => {
  const rel = (iso: string | null) => (iso ? `<${iso}>` : "");
  const status = { journalCount: 20000, downloadedAt: "2025-06-20" };
  // 常规：带下载时间 + 更新口径说明
  assert.equal(
    metricsTooltip(status, null, rel),
    "JCR2025 + 中科院分区表 2025 · 20000 种期刊 · 下载于 <2025-06-20>；出新版时点我重新下载即更新",
  );
  // 查过上游但无新版：同口径
  assert.equal(
    metricsTooltip(
      status,
      { upstreamUpdatedAt: "2025-06-01", hasUpdate: false },
      rel,
    ),
    "JCR2025 + 中科院分区表 2025 · 20000 种期刊 · 下载于 <2025-06-20>；出新版时点我重新下载即更新",
  );
  // 有新版：改口「点我更新」并带上游时间
  assert.equal(
    metricsTooltip(
      status,
      { upstreamUpdatedAt: "2025-07-01", hasUpdate: true },
      rel,
    ),
    "JCR2025 + 中科院分区表 2025 · 20000 种期刊 · 下载于 <2025-06-20>；上游已有新版（<2025-07-01>），点我更新",
  );
  // 下载时间缺失（异常态）不拼「下载于」
  assert.equal(
    metricsTooltip({ journalCount: 5, downloadedAt: null }, null, rel),
    "JCR2025 + 中科院分区表 2025 · 5 种期刊；出新版时点我重新下载即更新",
  );
  // 有新版但上游时间缺失：不给空括号
  assert.equal(
    metricsTooltip(status, { upstreamUpdatedAt: null, hasUpdate: true }, rel),
    "JCR2025 + 中科院分区表 2025 · 20000 种期刊 · 下载于 <2025-06-20>；上游已有新版，点我更新",
  );
});

test("雷达筛选：active 判定 / 条目过滤 / 摘要文案（与 Rust 同口径）", () => {
  // active：全空 / null = 不筛选
  assert.equal(litWatchFilterActive(null), false);
  assert.equal(litWatchFilterActive({}), false);
  assert.equal(litWatchFilterActive({ topOnly: false }), false);
  assert.equal(litWatchFilterActive({ minIf: 10 }), true);
  assert.equal(litWatchFilterActive({ maxCasQuartile: 2 }), true);
  assert.equal(litWatchFilterActive({ topOnly: true }), true);

  // 指标未知一律放行不误伤
  assert.equal(entryPassesFilter(null, { minIf: 10, topOnly: true }), true);
  const met = (
    impactFactor: string | null,
    casQuartile: number | null,
    top: boolean,
  ): WatchEntryDto["metrics"] => ({ impactFactor, casQuartile, top });

  // IF 门槛：低于阈值排除；恰好等于通过；缺失/不可解析放行
  assert.equal(entryPassesFilter(met("3.9", 3, false), { minIf: 10 }), false);
  assert.equal(entryPassesFilter(met("29.1", 3, false), { minIf: 10 }), true);
  assert.equal(entryPassesFilter(met("10", 3, false), { minIf: 10 }), true);
  assert.equal(entryPassesFilter(met(null, 3, false), { minIf: 10 }), true);
  assert.equal(entryPassesFilter(met("N/A", 3, false), { minIf: 10 }), true);

  // 分区：超过 N 区排除；未知放行
  assert.equal(entryPassesFilter(met(null, 3, false), { maxCasQuartile: 2 }), false);
  assert.equal(entryPassesFilter(met(null, 1, false), { maxCasQuartile: 2 }), true);
  assert.equal(entryPassesFilter(met(null, null, false), { maxCasQuartile: 2 }), true);

  // TOP：已知非 TOP 排除；未知放行；条件之间是「且」
  assert.equal(entryPassesFilter(met(null, null, false), { topOnly: true }), false);
  assert.equal(entryPassesFilter(met(null, null, true), { topOnly: true }), true);
  assert.equal(
    entryPassesFilter(met("19.9", 1, true), { minIf: 10, maxCasQuartile: 2, topOnly: true }),
    true,
  );
  assert.equal(
    entryPassesFilter(met("19.9", 3, true), { minIf: 10, maxCasQuartile: 2, topOnly: true }),
    false,
  );

  // 摘要文案
  assert.equal(litWatchFilterLabel(null), "");
  assert.equal(litWatchFilterLabel({ minIf: 10 }), "IF≥10");
  assert.equal(litWatchFilterLabel({ maxCasQuartile: 1 }), "仅 1 区");
  assert.equal(
    litWatchFilterLabel({ minIf: 10, maxCasQuartile: 2, topOnly: true }),
    "IF≥10 · 2 区及以上 · 仅 TOP",
  );
});
