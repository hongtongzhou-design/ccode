/**
 * 文献检索/筛选步骤的评审主面纯逻辑。
 * 步骤卡上核对纳入/排除；审阅看要进课题的文件并保存。默认 included.md，JSON 进过程组。
 */

export type ReviewFileGroupId = "list" | "fetch" | "other" | "machine";

export const REVIEW_FILE_GROUP_LABEL: Record<ReviewFileGroupId, string> = {
  list: "清单",
  fetch: "待获取",
  other: "其他改动",
  machine: "过程",
};

export const REVIEW_FILE_GROUP_ORDER: ReviewFileGroupId[] = [
  "list",
  "fetch",
  "other",
  "machine",
];

const PREFERRED_REVIEW_FILES = [
  "papers/included.md",
  "papers/screening.md",
  "papers/to-fetch.md",
] as const;

const PREFERRED_DIFF_FILES = [
  "papers/to-fetch.md",
  "papers/screening.md",
] as const;

export function normReviewPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function fileName(path: string): string {
  const p = normReviewPath(path);
  return p.split("/").pop() ?? p;
}

export function isScreeningReviewStep(step: {
  workspaceName?: string | null;
  expectedArtifacts?: readonly string[] | null;
}): boolean {
  const name = step.workspaceName ?? "";
  if (name === "lit-search" || name === "lit-survey-search") return true;
  const arts = step.expectedArtifacts ?? [];
  return (
    arts.includes("papers/included.json") &&
    arts.some(
      (p) =>
        p === "papers/screening.md" ||
        p.endsWith("/screening.md") ||
        p === "papers/included.md",
    )
  );
}

/** 改动列表同时出现筛选记录与纳入清单时，按筛选审阅排文件，不必等步骤上下文。 */
export function shouldPrioritizeScreeningFiles(paths: readonly string[]): boolean {
  const n = paths.map(normReviewPath);
  const hasScreening = n.some((p) => p.endsWith("papers/screening.md"));
  const hasIncluded = n.some(
    (p) => p.endsWith("papers/included.md") || p.endsWith("papers/included.json"),
  );
  return hasScreening && hasIncluded;
}

export function reviewFileGroup(path: string): ReviewFileGroupId {
  const p = normReviewPath(path);
  const base = fileName(p);
  if (base === "included.md" || base === "screening.md") return "list";
  if (base === "to-fetch.md" || base === "to-fetch.ris") return "fetch";
  if (
    base === "included.json" ||
    base === "help-wanted.md" ||
    base === "zotero-sync.md" ||
    p === ".ccode" ||
    p.startsWith(".ccode/") ||
    p.includes("/.ccode/") ||
    p === "scripts" ||
    p.startsWith("scripts/") ||
    p.includes("/scripts/")
  ) {
    return "machine";
  }
  return "other";
}

export function isScreeningListFile(path: string): boolean {
  const base = fileName(path);
  return base === "included.md" || base === "included.json";
}

export function preferredReviewPath(paths: readonly string[]): string | null {
  if (!paths.length) return null;
  const normalized = paths.map((p) => ({ raw: p, n: normReviewPath(p) }));
  for (const want of PREFERRED_REVIEW_FILES) {
    const hit = normalized.find((p) => p.n === want || p.n.endsWith(`/${want}`));
    if (hit) return hit.raw;
  }
  const list = normalized.filter((p) => reviewFileGroup(p.n) === "list");
  if (list.length) return list[0].raw;
  return paths[0];
}

/** 纳入表已经覆盖清单，diff 默认打开待获取或筛选记录，避免和表重复。 */
export function preferredDiffPath(paths: readonly string[]): string | null {
  const rest = paths.filter((p) => !isScreeningListFile(p));
  if (!rest.length) return null;
  const normalized = rest.map((p) => ({ raw: p, n: normReviewPath(p) }));
  for (const want of PREFERRED_DIFF_FILES) {
    const hit = normalized.find((p) => p.n === want || p.n.endsWith(`/${want}`));
    if (hit) return hit.raw;
  }
  return rest[0];
}

export function stackedReviewPaths(paths: readonly string[], activePath: string | null): string[] {
  const rest = sortReviewPaths(
    paths.filter((p) => !isScreeningListFile(p) || p === activePath),
  );
  const preferred = preferredDiffPath(rest);
  if (!preferred) return rest;
  return [preferred, ...rest.filter((p) => p !== preferred)];
}

function preferredRank(path: string): number {
  const n = normReviewPath(path);
  const idx = PREFERRED_REVIEW_FILES.findIndex(
    (want) => n === want || n.endsWith(`/${want}`),
  );
  return idx < 0 ? 99 : idx;
}

export function sortReviewPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const ga = REVIEW_FILE_GROUP_ORDER.indexOf(reviewFileGroup(a));
    const gb = REVIEW_FILE_GROUP_ORDER.indexOf(reviewFileGroup(b));
    if (ga !== gb) return ga - gb;
    const pa = preferredRank(a);
    const pb = preferredRank(b);
    if (pa !== pb) return pa - pb;
    return normReviewPath(a).localeCompare(normReviewPath(b), "zh");
  });
}

export function groupReviewFiles<T extends { path: string }>(
  files: readonly T[],
): { id: ReviewFileGroupId; label: string; files: T[] }[] {
  const buckets: Record<ReviewFileGroupId, T[]> = {
    list: [],
    fetch: [],
    other: [],
    machine: [],
  };
  for (const file of files) buckets[reviewFileGroup(file.path)].push(file);
  for (const id of REVIEW_FILE_GROUP_ORDER) {
    const order = sortReviewPaths(buckets[id].map((f) => f.path));
    const map = new Map(buckets[id].map((f) => [f.path, f]));
    buckets[id] = order.map((p) => map.get(p)!);
  }
  return REVIEW_FILE_GROUP_ORDER
    .map((id) => ({
      id,
      label: REVIEW_FILE_GROUP_LABEL[id],
      files: buckets[id],
    }))
    .filter((g) => g.files.length > 0);
}

export interface IncludedRecord {
  id: string;
  title: string;
  decision: string;
  reason: string;
  authors: string;
  year: string;
  source: string;
  url: string;
}

function stringField(rec: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function authorsOf(rec: Record<string, unknown>): string {
  const direct = stringField(rec, ["authors", "author"]);
  if (direct) return direct;
  const list = rec.authors;
  if (Array.isArray(list)) {
    return list
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          return stringField(row, ["name", "literal"]) || [row.family, row.given].filter((p) => typeof p === "string").join(" ");
        }
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function yearOf(rec: Record<string, unknown>): string {
  const value = rec.year ?? rec.date ?? rec.published;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const m = value.match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : value.trim();
  }
  return "";
}

function urlOf(rec: Record<string, unknown>, id: string): string {
  const direct = stringField(rec, ["url", "link", "doi"]);
  if (/^https?:\/\//i.test(direct)) return direct;
  if (direct.startsWith("10.")) return `https://doi.org/${direct}`;
  const doi = id.startsWith("doi:") ? id.slice(4) : /^10\.\d{4,}/.test(id) ? id : "";
  return doi ? `https://doi.org/${doi}` : "";
}

function asRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const rec = data as Record<string, unknown>;
  for (const key of ["items", "records", "rows"]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

export function parseIncludedRecords(text: string): IncludedRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: IncludedRecord[] = [];
  for (const row of asRows(data)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const title = typeof rec.title === "string" ? rec.title : "";
    if (!title) continue;
    out.push({
      id,
      title,
      decision: typeof rec.decision === "string" ? rec.decision : "",
      reason: typeof rec.reason === "string" ? rec.reason : "",
      authors: authorsOf(rec),
      year: yearOf(rec),
      source: stringField(rec, ["source", "venue", "journal", "container"]),
      url: urlOf(rec, id),
    });
  }
  return out;
}

export interface ScreeningCounts {
  total: number;
  included: number;
  pending: number;
  toFetch: number;
}

export function screeningCounts(
  records: readonly IncludedRecord[],
  toFetch: number,
): ScreeningCounts {
  return {
    total: records.length,
    included: records.filter((r) => r.decision === "included").length,
    pending: records.filter((r) => r.decision === "pending").length,
    toFetch,
  };
}

export function screeningCountLine(counts: ScreeningCounts): string {
  const parts = [`纳入 ${counts.included}`, `待确认 ${counts.pending}`];
  if (counts.toFetch > 0) parts.push(`待获取 ${counts.toFetch}`);
  parts.push(`共 ${counts.total} 篇`);
  return parts.join(" · ");
}

export function extraDecisionsFromSummary(summaryText: string): string[] {
  const out: string[] = [];
  for (const raw of summaryText.split(/\r?\n/)) {
    const line = raw.trim();
    const m =
      /^(?:\d+\.\s*)?(?:\*\*)?(?:需要人决定|待人决定)(?:\*\*)?[：:]\s*(.+)$/.exec(
        line,
      );
    if (!m) continue;
    for (const part of m[1].split(/[；;]/)) {
      const t = part.trim().replace(/[。．]$/, "");
      if (t) out.push(t);
    }
  }
  return out;
}

function coveredByCounts(text: string, counts: ScreeningCounts): boolean {
  const n = text.toLowerCase();
  if (counts.pending > 0 && /pending|待确认/.test(n)) return true;
  if (counts.toFetch > 0 && /付费|全文|待获取|to-fetch/.test(n)) return true;
  return false;
}

export function screeningDecisionLines(
  counts: ScreeningCounts,
  extras: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (counts.pending > 0) lines.push(`确认 ${counts.pending} 篇 pending 是否纳入`);
  if (counts.toFetch > 0) lines.push(`获取 ${counts.toFetch} 篇付费全文`);
  for (const extra of extras) {
    const t = extra.trim();
    if (!t || coveredByCounts(t, counts)) continue;
    if (lines.includes(t)) continue;
    lines.push(t);
  }
  return lines;
}

/** 这一屏唯一的当前动作；付费全文和库授权不是现在的事。 */
export function screeningNowLine(counts: ScreeningCounts): string {
  if (counts.pending > 0) return `现在：核对 ${counts.pending} 篇待确认`;
  if (counts.total === 0) return "现在：清单是空的，先看筛选记录";
  return "现在：看完纳入清单，记下筛选决定";
}

export function screeningReviewNote(counts: ScreeningCounts): string {
  if (counts.pending > 0) {
    return `下面是要进课题的文件。还有 ${counts.pending} 篇待确认，先回步骤卡核对。`;
  }
  return "下面是要进课题的文件。看过就点右上角保存进项目。";
}

export function screeningLaterLines(
  counts: ScreeningCounts,
  extras: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (counts.toFetch > 0) {
    lines.push(`${counts.toFetch} 篇付费全文，保存进项目后再获取`);
  }
  for (const extra of extras) {
    const t = extra.trim();
    if (!t || coveredByCounts(t, counts)) continue;
    if (lines.includes(t)) continue;
    lines.push(t);
  }
  return lines;
}

export function blockerPrimaryText(
  blockers: readonly { text: string }[],
): string {
  if (!blockers.length) return "";
  if (blockers.length === 1) return blockers[0].text;
  return `${blockers[0].text}（另有 ${blockers.length - 1} 项）`;
}

export function decisionBadge(decision: string): {
  label: string;
  tone: "ok" | "warn" | "muted";
} {
  if (decision === "included") return { label: "纳入", tone: "ok" };
  if (decision === "pending") return { label: "待确认", tone: "warn" };
  if (decision === "excluded") return { label: "排除", tone: "muted" };
  return { label: decision || "未标", tone: "muted" };
}

export type ScreeningTableFilter = "pending" | "included" | "all";

export function defaultScreeningTableFilter(
  counts: ScreeningCounts,
): ScreeningTableFilter {
  if (counts.pending > 0) return "pending";
  if (counts.included > 0) return "included";
  return "all";
}

export function filterIncludedRecords(
  records: readonly IncludedRecord[],
  filter: ScreeningTableFilter,
): IncludedRecord[] {
  if (filter === "all") return [...records];
  return records.filter((row) => row.decision === filter);
}

export function includedRecordMeta(row: IncludedRecord): string {
  return [row.year, row.authors, row.source].filter(Boolean).join(" · ");
}

export function includedRecordKey(row: Pick<IncludedRecord, "id" | "title">): string {
  return row.id || row.title;
}

export function doiToken(id: string, url: string): string {
  const m = `${id} ${url}`.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return m ? m[0].replace(/[.,;]+$/, "") : "";
}

function alnum(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function pdfNameFromReason(reason: string): string | null {
  const labeled = reason.match(/已有(?:项目)?PDF[：:]\s*(.+?\.pdf)/i);
  if (labeled) return labeled[1].trim();
  return null;
}

/** 项目 papers/ 里已有 PDF 时配对：理由里的文件名 > DOI > 标题与文件名互相包含。 */
export function matchPaperPdf(
  record: Pick<IncludedRecord, "title" | "id" | "url" | "reason">,
  files: readonly { name: string; path: string }[],
  papersDir?: string,
): string | null {
  const named = pdfNameFromReason(record.reason ?? "");
  if (named) {
    const want = alnum(named);
    const exact = files.find((file) => file.name.toLowerCase() === named.toLowerCase());
    if (exact) return exact.path;
    const fuzzy = files.find((file) => alnum(file.name) === want);
    if (fuzzy) return fuzzy.path;
    if (papersDir) return `${papersDir.replace(/[\\/]+$/, "")}/${named}`;
  }
  const doi = doiToken(record.id, record.url).toLowerCase();
  const doiKey = doi.replace(/[/:]/g, "_");
  const want = alnum(record.title);
  let best: { score: number; path: string } | null = null;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pdf")) continue;
    const stem = name.slice(0, -4);
    const stemKey = alnum(stem);
    let score = 0;
    if (doi && (name.includes(doi) || stem.includes(doiKey) || stem.replace(/-/g, "_").includes(doiKey))) {
      score = 1000 + doi.length;
    } else if (want.length >= 12 && stemKey.length >= 8 && (want.includes(stemKey) || stemKey.includes(want.slice(0, 24)))) {
      score = Math.min(want.length, stemKey.length);
    }
    if (score > 0 && (!best || score > best.score)) best = { score, path: file.path };
  }
  return best?.path ?? null;
}

/** 待获取只认 DOI 对上文件名；标题模糊命中不能当成已经有全文。 */
export function paperHasDoiPdf(
  record: Pick<IncludedRecord, "id" | "url">,
  files: readonly { name: string }[],
): boolean {
  const doi = doiToken(record.id, record.url).toLowerCase();
  if (!doi) return false;
  const doiKey = doi.replace(/[/:]/g, "_");
  return files.some((file) => {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pdf")) return false;
    const stem = name.slice(0, -4).replace(/-/g, "_");
    return name.includes(doi) || stem.includes(doiKey);
  });
}

export function confirmReason(decision: "included" | "excluded", previous: string): string {
  const prefix = decision === "included" ? "纳入：评审确认" : "排除：评审确认";
  const rest = previous.replace(/^(纳入|排除|待确认)[：:].*/, "").trim();
  return rest ? `${prefix}。${rest}` : prefix;
}

export function patchIncludedJson(
  text: string,
  key: string,
  decision: string,
  reason: string,
): string {
  const data = JSON.parse(text) as unknown;
  const rows = asRows(data);
  let found = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const title = typeof rec.title === "string" ? rec.title : "";
    if (id !== key && title !== key) continue;
    rec.decision = decision;
    rec.reason = reason;
    found = true;
  }
  if (!found) throw new Error("清单里找不到这篇");
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function includedMdLine(row: Pick<IncludedRecord, "title" | "authors" | "year" | "source" | "url" | "id">): string {
  const who = [row.authors, row.year].filter(Boolean).join(", ");
  const tail = row.url || row.id;
  return [row.title, who, row.source, tail].filter(Boolean).join(" — ");
}

export function patchIncludedMd(
  md: string,
  title: string,
  decision: string,
  line: string,
): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((row) => !row.includes(title));
  if (decision === "excluded") return kept.join("\n");
  const heading = decision === "included"
    ? /^(#{1,3}\s*)(纳入|Included)\b/i
    : /^(#{1,3}\s*).*pending/i;
  let at = kept.findIndex((row) => heading.test(row.trim()));
  if (at < 0) {
    const block = decision === "included"
      ? ["", "## 纳入清单", line]
      : ["", "## Pending 清单", line];
    return [...kept, ...block].join("\n").replace(/^\n+/, "");
  }
  at += 1;
  while (at < kept.length && kept[at].trim() === "") at += 1;
  kept.splice(at, 0, line);
  return kept.join("\n");
}

export function alreadyInToFetch(
  md: string,
  row: Pick<IncludedRecord, "title" | "id" | "url">,
): boolean {
  const doi = doiToken(row.id, row.url);
  if (doi && md.includes(doi)) return true;
  return Boolean(row.title) && md.includes(row.title);
}

export function appendToFetchEntry(md: string, row: IncludedRecord): string {
  if (alreadyInToFetch(md, row)) return md;
  const numbered = md.match(/^\s*\d+\.\s/gm);
  const n = (numbered?.length ?? 0) + 1;
  const doi = doiToken(row.id, row.url) || row.url || row.id;
  const line = `${n}. ${row.title} — ${doi}`;
  if (!md.trim()) return `# 待获取全文\n\n${line}\n`;
  return `${md.replace(/\s*$/, "")}\n${line}\n`;
}
