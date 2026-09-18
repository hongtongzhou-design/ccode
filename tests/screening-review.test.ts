import assert from "node:assert/strict";
import test from "node:test";
import {
  blockerPrimaryText,
  extraDecisionsFromSummary,
  groupReviewFiles,
  isScreeningReviewStep,
  appendToFetchEntry,
  matchPaperPdf,
  paperHasDoiPdf,
  pdfNameFromReason,
  parseIncludedRecords,
  patchIncludedJson,
  patchIncludedMd,
  defaultScreeningTableFilter,
  filterIncludedRecords,
  isScreeningListFile,
  preferredDiffPath,
  preferredReviewPath,
  reviewFileGroup,
  stackedReviewPaths,
  screeningCountLine,
  screeningCounts,
  screeningDecisionLines,
  screeningLaterLines,
  screeningNowLine,
  shouldPrioritizeScreeningFiles,
  sortReviewPaths,
} from "../src/screening-review.ts";

test("检索步按工作区名或产物识别", () => {
  assert.equal(isScreeningReviewStep({ workspaceName: "lit-search" }), true);
  assert.equal(isScreeningReviewStep({ workspaceName: "lit-survey-search" }), true);
  assert.equal(isScreeningReviewStep({ workspaceName: "exp-run" }), false);
  assert.equal(
    isScreeningReviewStep({
      workspaceName: "custom",
      expectedArtifacts: ["papers/screening.md", "papers/included.json"],
    }),
    true,
  );
  assert.equal(
    isScreeningReviewStep({
      workspaceName: "lit-notes",
      expectedArtifacts: ["notes/*.md", "papers/included.json"],
    }),
    false,
  );
});

test("同时有 screening 与 included 时按筛选排文件", () => {
  const paths = [
    "papers/included.json",
    "scripts/build_outputs.py",
    "papers/to-fetch.md",
    "papers/included.md",
    "papers/screening.md",
    "papers/zotero-sync.md",
  ];
  assert.equal(shouldPrioritizeScreeningFiles(paths), true);
  assert.equal(shouldPrioritizeScreeningFiles(["notes/a.md", "papers/included.json"]), false);
  assert.deepEqual(sortReviewPaths(paths), [
    "papers/included.md",
    "papers/screening.md",
    "papers/to-fetch.md",
    "papers/included.json",
    "papers/zotero-sync.md",
    "scripts/build_outputs.py",
  ]);
  assert.equal(preferredReviewPath(paths), "papers/included.md");
  assert.equal(preferredDiffPath(paths), "papers/to-fetch.md");
  assert.equal(preferredDiffPath(["papers/included.md", "papers/included.json"]), null);
  assert.deepEqual(stackedReviewPaths(paths, null), [
    "papers/to-fetch.md",
    "papers/screening.md",
    "papers/zotero-sync.md",
    "scripts/build_outputs.py",
  ]);
  assert.equal(stackedReviewPaths(paths, "papers/included.md")[0], "papers/to-fetch.md");
  assert.ok(stackedReviewPaths(paths, "papers/included.md").includes("papers/included.md"));
  assert.equal(isScreeningListFile("papers/included.md"), true);
  assert.equal(isScreeningListFile("papers/screening.md"), false);
  assert.equal(preferredReviewPath(["papers/included.json", "scripts/a.py"]), "papers/included.json");
  assert.equal(reviewFileGroup("papers/included.json"), "machine");
  assert.equal(reviewFileGroup("scripts/rename_downloads.py"), "machine");
  const groups = groupReviewFiles(paths.map((path) => ({ path })));
  assert.deepEqual(
    groups.map((g) => [g.id, g.files.map((f) => f.path)]),
    [
      ["list", ["papers/included.md", "papers/screening.md"]],
      ["fetch", ["papers/to-fetch.md"]],
      ["machine", ["papers/included.json", "papers/zotero-sync.md", "scripts/build_outputs.py"]],
    ],
  );
});

test("纳入 JSON 计数与待拍板去重", () => {
  const records = parseIncludedRecords(JSON.stringify({
    items: [
      { id: "doi:1", title: "A", decision: "included", reason: "对题" },
      { id: "doi:2", title: "B", decision: "pending", reason: "相邻体系" },
      { id: "skip" },
    ],
  }));
  assert.equal(records.length, 2);
  const counts = screeningCounts(records, 3);
  assert.equal(screeningCountLine(counts), "纳入 1 · 待确认 1 · 待获取 3 · 共 2 篇");
  const extras = extraDecisionsFromSummary(
    "1. 回答了什么：完成筛选。\n5. 需要人决定：确认 pending 项；获取付费全文；如需写 Zotero 库须另行明确授权。",
  );
  assert.deepEqual(extras, [
    "确认 pending 项",
    "获取付费全文",
    "如需写 Zotero 库须另行明确授权",
  ]);
  assert.deepEqual(screeningDecisionLines(counts, extras), [
    "确认 1 篇 pending 是否纳入",
    "获取 3 篇付费全文",
    "如需写 Zotero 库须另行明确授权",
  ]);
  assert.equal(screeningNowLine(counts), "现在：核对 1 篇待确认");
  assert.deepEqual(screeningLaterLines(counts, extras), [
    "3 篇付费全文，保存进项目后再获取",
    "如需写 Zotero 库须另行明确授权",
  ]);
  assert.equal(
    screeningNowLine({ total: 2, included: 2, pending: 0, toFetch: 0 }),
    "现在：看完纳入清单，记下筛选决定",
  );
  assert.deepEqual(parseIncludedRecords("not json"), []);
  assert.equal(
    matchPaperPdf(
      { title: "Bridging Fundamentals", id: "doi:10.1000/xyz", url: "https://doi.org/10.1000/xyz" },
      [{ name: "author-10.1000_xyz.pdf", path: "/p/a.pdf" }],
    ),
    "/p/a.pdf",
  );
  assert.equal(
    matchPaperPdf(
      { title: "Bridging Fundamentals and Practice", id: "", url: "" },
      [{ name: "bridging-fundamentals-and-practice.pdf", path: "/p/b.pdf" }],
    ),
    "/p/b.pdf",
  );
  assert.equal(
    matchPaperPdf({ title: "No Match Paper", id: "", url: "" }, [{ name: "other.pdf", path: "/p/c.pdf" }]),
    null,
  );
  assert.equal(
    paperHasDoiPdf({ id: "doi:10.1000/xyz", url: "" }, [{ name: "author-10.1000_xyz.pdf" }]),
    true,
  );
  assert.equal(
    paperHasDoiPdf({ id: "doi:10.1000/xyz", url: "" }, [{ name: "bridging-fundamentals.pdf" }]),
    false,
  );
  const named =
    "Selenium sulfide cathode with copper foam interlayer for promising magnesium electrochemistry..pdf";
  assert.equal(
    pdfNameFromReason(`待确认：已有项目PDF：${named}`),
    named,
  );
  assert.equal(
    matchPaperPdf(
      {
        title: "Selenium sulfide cathode",
        id: "",
        url: "",
        reason: `已有项目PDF：${named}`,
      },
      [{ name: named, path: "/p/papers/" + named }],
    ),
    "/p/papers/" + named,
  );
  const fetchMd = appendToFetchEntry("# 待获取全文\n\n1. Old — 10.0/aaa\n", {
    id: "doi:10.0/bbb",
    title: "New Paper",
    decision: "included",
    reason: "",
    authors: "",
    year: "",
    source: "",
    url: "https://doi.org/10.0/bbb",
  });
  assert.match(fetchMd, /2\. New Paper — /);
  assert.equal(
    appendToFetchEntry(fetchMd, {
      id: "doi:10.0/bbb",
      title: "New Paper",
      decision: "included",
      reason: "",
      authors: "",
      year: "",
      source: "",
      url: "https://doi.org/10.0/bbb",
    }),
    fetchMd,
  );
  const patched = patchIncludedJson(
    JSON.stringify([{ id: "doi:2", title: "B", decision: "pending", reason: "相邻" }]),
    "doi:2",
    "included",
    "纳入：评审确认",
  );
  assert.match(patched, /"decision": "included"/);
  const md = patchIncludedMd(
    "# 筛选\n\n## Pending 清单\nB — 2026 — doi:2\n",
    "B",
    "included",
    "B — 2026 — doi:2",
  );
  assert.match(md, /## 纳入清单\nB —/);
  assert.equal((md.match(/B —/g) ?? []).length, 1);
  assert.equal(defaultScreeningTableFilter(counts), "pending");
  assert.deepEqual(
    filterIncludedRecords(records, "pending").map((r) => r.title),
    ["B"],
  );
  assert.equal(defaultScreeningTableFilter({ total: 2, included: 2, pending: 0, toFetch: 0 }), "included");
});

test("Git 拦截直接写原因，不报问题计数", () => {
  assert.equal(blockerPrimaryText([]), "");
  assert.equal(
    blockerPrimaryText([{ text: "主文件夹里还有没保存的改动" }]),
    "主文件夹里还有没保存的改动",
  );
  assert.equal(
    blockerPrimaryText([
      { text: "主文件夹里还有没保存的改动" },
      { text: "与主分支存在冲突" },
    ]),
    "主文件夹里还有没保存的改动（另有 1 项）",
  );
});
