/**
 * 文献雷达（lit-watch）前端纯逻辑：日分组、周趋势、PDF 直链、精读清单拼接、
 * 已读判定、关联步骤漂移提醒、收件箱候选。与 DOM/Tauri 解耦（localStorage 薄层除外），
 * 供 node --test 直接测；组件 LitWatchCard 保持薄。
 * DTO 与 src-tauri/src/lit_watch.rs 的 camelCase 序列化一一对应。
 */
import { samePath } from "./path-utils.ts";
import type { LitWatchFilterDto, ScheduleDto } from "./types.ts";

// ===== DTO（对照 lit_watch.rs；新命令的类型在本文件就近声明） =====

/** inbox.md 中的一条文献命中 */
export interface WatchEntryDto {
  /** 内容哈希 id（标题+批次日期），`w-<hex>`；仅作列表 key，不持久化 */
  id: string;
  title: string;
  /** 来源行第一段（arxiv / 期刊 / 会议名） */
  source: string;
  authors: string;
  abstractFirst: string;
  keywordsHit: string[];
  /** "推荐" | "相关" | "待确认"（缺漏一律按待确认） */
  relevance: string;
  journal: string | null;
  /** 中文一句话；旧条目为空串 */
  zhSummary: string;
  /** 链接/DOI 段；没有为空串 */
  url: string;
  /** 巡检批次日期 YYYY-MM-DD；无批次标记为 null */
  date: string | null;
  rawLineRange: [number, number];
  /** 期刊指标（JCR2025 + 中科院分区表2025 合并，按期刊名规范化匹配）；未匹配/未装表为 null */
  metrics: JournalMetricsDto | null;
}

/** 单条命中的期刊指标（对照 lit_watch.rs 序列化） */
export interface JournalMetricsDto {
  /** JCR2025 IF 原样字符串，如 "29.1"；无数据为 null */
  impactFactor: string | null;
  /** 中科院升级版大类分区 1-4；无数据为 null */
  casQuartile: number | null;
  /** 中科院 Top 期刊 */
  top: boolean;
}

/** journal_metrics_status / download_journal_metrics 返回 */
export interface JournalMetricsStatusDto {
  available: boolean;
  journalCount: number;
  /** 本地表下载时间（RFC3339；两份 CSV 取较新 mtime），未装为 null */
  downloadedAt: string | null;
}

/** check_journal_metrics_update 返回 */
export interface JournalMetricsUpdateDto {
  /** 上游 ShowJCR 数据目录最近 commit 时间（RFC3339） */
  upstreamUpdatedAt: string | null;
  /** 上游比本地表新 */
  hasUpdate: boolean;
}

/** 指标表按钮悬浮说明（纯逻辑）：表名 + 刊数 + 下载时间；上游有新版时改口「点我更新」。
 *  rel 为相对时间函数（组件传 relTime，测试可注入假值） */
export function metricsTooltip(
  status: Pick<JournalMetricsStatusDto, "journalCount" | "downloadedAt">,
  update: Pick<JournalMetricsUpdateDto, "upstreamUpdatedAt" | "hasUpdate"> | null,
  rel: (iso: string | null) => string,
): string {
  const ago = rel(status.downloadedAt);
  const base = `JCR2025 + 中科院分区表 2025 · ${status.journalCount} 种期刊${
    ago ? ` · 下载于 ${ago}` : ""
  }`;
  if (update?.hasUpdate) {
    const up = rel(update.upstreamUpdatedAt);
    return `${base}；上游已有新版${up ? `（${up}）` : ""}，点我更新`;
  }
  return `${base}；出新版时点我重新下载即更新`;
}

// ===== 雷达筛选（与 lit_watch.rs metrics_pass_filter 同口径，改动需双端同步） =====

/** 筛选是否生效（全空 = 不筛选） */
export function litWatchFilterActive(
  f: LitWatchFilterDto | null | undefined,
): boolean {
  return !!f && (f.minIf != null || f.maxCasQuartile != null || !!f.topOnly);
}

/** 条目是否通过筛选。指标未知（表未装 / 期刊未收录 / IF 不可解析）一律放行不误伤——
 *  筛选只在有数据时生效，绝不用「查不到」当「不达标」 */
export function entryPassesFilter(
  metrics: WatchEntryDto["metrics"],
  f: LitWatchFilterDto | null | undefined,
): boolean {
  // 全空筛选各条件自然全部跳过，无需单独判 active
  if (!f || !metrics) return true;
  if (f.minIf != null && metrics.impactFactor != null) {
    const v = Number(metrics.impactFactor);
    // IF 存在但不可解析 = 未知 → 放行（Number("")=0 之类不纳入：后端空串不落字段）
    if (Number.isFinite(v) && metrics.impactFactor.trim() !== "" && v < f.minIf) {
      return false;
    }
  }
  if (
    f.maxCasQuartile != null &&
    metrics.casQuartile != null &&
    metrics.casQuartile > f.maxCasQuartile
  ) {
    return false;
  }
  if (f.topOnly && !metrics.top) return false;
  return true;
}

/** 筛选摘要（按钮悬浮/提示行用）：「IF≥10 · 2 区及以上 · 仅 TOP」 */
export function litWatchFilterLabel(
  f: LitWatchFilterDto | null | undefined,
): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.minIf != null) parts.push(`IF≥${f.minIf}`);
  if (f.maxCasQuartile != null) {
    parts.push(f.maxCasQuartile === 1 ? "仅 1 区" : `${f.maxCasQuartile} 区及以上`);
  }
  if (f.topOnly) parts.push("仅 TOP");
  return parts.join(" · ");
}

/** watch-followup.md 待办（付费墙/无摘要，待人工获取全文） */
export interface WatchFollowupDto {
  title: string;
  url: string;
  note: string;
}

/** list_watch_entries 返回 */
export interface WatchInboxDto {
  entries: WatchEntryDto[];
  followups: WatchFollowupDto[];
}

/** watchlist.md 订阅行（整表读写） */
export interface WatchSubscriptionDto {
  keyword: string;
  /** 来源多选（arxiv/openalex/crossref/web）；空 = 技能缺省口径 */
  sources: string[];
  note: string;
}

/** included.md 精读清单行 */
export interface IncludedEntryDto {
  /** 行内容哈希 id，`i-<hex>`；remove 时原样回传 */
  lineId: string;
  title: string;
  /** 「作者, 年份」整段 */
  authorsYear: string;
  source: string;
  link: string;
  rawLine: string;
}

/** add_included_entry 返回：added=false = 规范化标题已存在（去重） */
export interface AddIncludedResultDto {
  added: boolean;
}

/** download_paper_pdf 返回：落盘绝对路径 + 资源登记名 */
export interface DownloadedPaperDto {
  path: string;
  name: string;
}

// ===== 日分组 =====

/** 相关性排序权重：推荐 > 相关 > 待确认/未知 */
export function relevanceRank(relevance: string): number {
  if (relevance === "推荐") return 0;
  if (relevance === "相关") return 1;
  return 2;
}

export interface DayGroup {
  key: "today" | "yesterday" | "earlier";
  label: string;
  entries: WatchEntryDto[];
}

/** "YYYY-MM-DD" 按本地时区解析（new Date 串解析走 UTC，会偏一天） */
function parseLocalDay(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日期串（分桶比较键） */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 按批次日期分「今天 / 昨天 / 更早」三桶（无 date 进「更早」），空桶不返回；
 *  组内按相关性排序（推荐>相关>待确认），同级保持原有先后（稳定序） */
export function groupEntriesByDay(
  entries: readonly WatchEntryDto[],
  now: Date = new Date(),
): DayGroup[] {
  const todayKey = localDayKey(now);
  const yesterdayKey = localDayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
  const buckets: Record<DayGroup["key"], WatchEntryDto[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const entry of entries) {
    const day = entry.date ? parseLocalDay(entry.date) : null;
    const key = day ? localDayKey(day) : null;
    if (key === todayKey) buckets.today.push(entry);
    else if (key === yesterdayKey) buckets.yesterday.push(entry);
    else buckets.earlier.push(entry);
  }
  const byRank = (a: WatchEntryDto, b: WatchEntryDto) =>
    relevanceRank(a.relevance) - relevanceRank(b.relevance);
  return (
    [
      { key: "today", label: "今天", entries: buckets.today },
      { key: "yesterday", label: "昨天", entries: buckets.yesterday },
      { key: "earlier", label: "更早", entries: buckets.earlier },
    ] as DayGroup[]
  )
    .map((g) => ({ ...g, entries: [...g.entries].sort(byRank) }))
    .filter((g) => g.entries.length > 0);
}

// ===== 关键词分组 =====

/** 无命中关键词条目的固定归属组名 */
export const UNCATEGORIZED_KEYWORD = "未分类";

export interface KeywordGroup {
  keyword: string;
  entries: WatchEntryDto[];
}

/** 按关键词分组：每条只归入 keywordsHit 的第一个关键词（多命中不重复出现），
 *  无关键词归「未分类」；组按条目数降序、同数按关键词字母序，「未分类」恒排最后；
 *  组内与日分组同口径（相关性排序 + 同级稳定序）；空组不出现 */
export function groupEntriesByKeyword(
  entries: readonly WatchEntryDto[],
): KeywordGroup[] {
  const buckets = new Map<string, WatchEntryDto[]>();
  for (const entry of entries) {
    const kw = entry.keywordsHit[0]?.trim() || UNCATEGORIZED_KEYWORD;
    const bucket = buckets.get(kw);
    if (bucket) bucket.push(entry);
    else buckets.set(kw, [entry]);
  }
  const byRank = (a: WatchEntryDto, b: WatchEntryDto) =>
    relevanceRank(a.relevance) - relevanceRank(b.relevance);
  return [...buckets.entries()]
    .map(([keyword, list]) => ({
      keyword,
      entries: [...list].sort(byRank),
    }))
    .sort((a, b) => {
      if (a.keyword === UNCATEGORIZED_KEYWORD) return 1;
      if (b.keyword === UNCATEGORIZED_KEYWORD) return -1;
      return (
        b.entries.length - a.entries.length ||
        a.keyword.localeCompare(b.keyword)
      );
    });
}

// ===== 来源展示名 =====

/** 来源 pill 展示名：剥掉末尾出版商括号尾巴（「(Wiley)」「（ACS）」，可多级）省横向空间；
 *  剥完为空视为无尾巴（原文返回）。匹配侧（journal_metrics.rs lookup_in）同口径剥尾，两处同步 */
export function sourceDisplayName(source: string): string {
  let s = source.trim();
  for (;;) {
    const m = /^(.*?)\s*[(（][^()（）]*[)）]\s*$/.exec(s);
    if (!m || !m[1].trim()) return s;
    s = m[1].trim();
  }
}

// ===== 周趋势（迷你柱状图） =====

export interface WeekBucket {
  /** 本周周一（本地零点） */
  start: Date;
  /** 「8月3日周」 */
  label: string;
  count: number;
}

/** 本地周一零点（周一 = 一周起点，中文语境惯例） */
function weekStart(d: Date): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay：周日=0…周六=6；回退到周一
  const back = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back);
}

/** 近 weeks 周每周命中计数（旧→新，含 0 计数的周；无 date 的条目不知道归哪周，不计） */
export function weeklyBuckets(
  entries: readonly WatchEntryDto[],
  weeks = 8,
  now: Date = new Date(),
): WeekBucket[] {
  const thisWeek = weekStart(now);
  const starts: Date[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    starts.push(
      new Date(
        thisWeek.getFullYear(),
        thisWeek.getMonth(),
        thisWeek.getDate() - i * 7,
      ),
    );
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.date) continue;
    const day = parseLocalDay(entry.date);
    if (!day) continue;
    const key = localDayKey(weekStart(day));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return starts.map((start) => ({
    start,
    label: `${start.getMonth() + 1}月${start.getDate()}日周`,
    count: counts.get(localDayKey(start)) ?? 0,
  }));
}

// ===== PDF 直链 =====

/** 全文 PDF 直链：arXiv abs 页 → pdf 直链；其余 http(s) 原样；非 http(s)（空串/DOI 等）返回 null */
export function pdfUrlFor(url: string): string | null {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const abs = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/([^?#]+)/i.exec(u);
  if (abs) return `https://arxiv.org/pdf/${abs[1]}`;
  return u;
}

// ===== 全文可得性 =====

/** 全文链接分类：pdf = 开放获取直链（可下载）；source = 出版商落地页/DOI（只能打开来源）；none = 无链接 */
export type FulltextLink =
  | { kind: "pdf"; url: string }
  | { kind: "source"; url: string }
  | { kind: "none" };

/** 判定命中的全文可得性，供「↓ 全文 / ↗ 来源」按钮分流：
 *  只有 arXiv abs 页与 .pdf 结尾的 URL 视为可直接下载；DOI、doi.org 及其他 http(s) 落地页
 *  一律当来源页（直链下载也过不了后端 %PDF- 魔数校验），前端直接给「来源」入口，不摆装死的下载钮 */
export function fulltextLinkFor(rawUrl: string): FulltextLink {
  const u = rawUrl.trim();
  if (/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(u)) {
    return { kind: "source", url: u };
  }
  if (!/^https?:\/\//i.test(u)) return { kind: "none" };
  if (/^https?:\/\/(?:www\.)?arxiv\.org\/abs\//i.test(u)) {
    return { kind: "pdf", url: pdfUrlFor(u)! };
  }
  if (/\.pdf([?#].*)?$/i.test(u)) return { kind: "pdf", url: u };
  return { kind: "source", url: u };
}

// ===== 精读清单 =====

/**
 * 命中条目 → add_included_entry 的参数。
 * authorsYear 口径：作者缺 → 整段「待补」；作者在 → 附年份（取批次日期的年——
 * 雷达条目多为新文献，批次年≈发表年），批次日期也没有就只留作者。
 */
export function includedLineFor(entry: WatchEntryDto): {
  title: string;
  authorsYear: string;
  source: string;
  link: string;
} {
  const authors = entry.authors.trim();
  const year = entry.date ? parseLocalDay(entry.date)?.getFullYear() : undefined;
  const authorsYear = authors
    ? year
      ? `${authors}, ${year}`
      : authors
    : "待补";
  return {
    title: entry.title,
    authorsYear,
    source: entry.source,
    link: entry.url,
  };
}

// ===== 已读判定（精读条目 × notes/ 笔记文件名） =====

/** 标题规范化：小写、标点/符号折叠为单空格（互相包含比较的统一口径） */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** 精读条目是否已读：规范化标题与任一笔记文件名（去扩展名）互相包含即已读；
 *  无 notes 目录/无笔记（空调用方传空表）→ 全部未读。诚实回落，不做模糊猜测 */
export function isRead(
  entry: { title: string },
  noteFileNames: readonly string[],
): boolean {
  const t = normalizeTitle(entry.title);
  if (!t) return false;
  return noteFileNames.some((name) => {
    const stem = name.replace(/\.[^.]*$/, "");
    const n = normalizeTitle(stem);
    if (n === "" || n === t) return n !== "";
    if (!(n.includes(t) || t.includes(n))) return false;
    // 仅允许较长、多词标题做包含匹配，避免「review」「battery」等短片段
    // 把另一篇论文误判成已读。
    const shorter = n.length < t.length ? n : t;
    return shorter.length >= 20 && shorter.split(" ").filter(Boolean).length >= 4;
  });
}

/** 精读条目对应的已下载 PDF：登记资源里 type=paper 且文件名与标题规范化互相包含 */
export function paperResourceFor(
  entry: { title: string },
  resources: readonly { path: string; type: string }[],
): string | null {
  const t = normalizeTitle(entry.title);
  if (!t) return null;
  for (const r of resources) {
    if (r.type !== "paper") continue;
    // 后端 discover 出的路径已由 norm_path_key 统一成正斜杠，但配置文件里手写的
    // resources.path 可能是 Windows 反斜杠，取文件名前先归一化，否则整条路径会被当成文件名参与匹配
    const fileName = r.path.replace(/\\/g, "/").split("/").pop() ?? r.path;
    const n = normalizeTitle(fileName.replace(/\.[^.]*$/, ""));
    if (n !== "" && (n.includes(t) || t.includes(n))) return r.path;
  }
  return null;
}

// ===== 关联步骤漂移提醒 =====

/**
 * 雷达有新命中且晚于关联步骤的最近推进 → 提醒「产物可能过期」（只提醒不阻断）。
 * stepMergedAt = 该步骤绑定工作区的 mergedAt ?? createdAt；null（还没工作区）= 没有可过期的产物，不提醒。
 */
export function staleLitHint(
  linkedStep: string | null | undefined,
  lastRunAt: string | null,
  newEntries: number | null | undefined,
  stepMergedAt: string | null,
): boolean {
  if (!linkedStep) return false;
  if (!lastRunAt || !newEntries || newEntries <= 0) return false;
  if (!stepMergedAt) return false;
  const run = Date.parse(lastRunAt);
  const merged = Date.parse(stepMergedAt);
  if (Number.isNaN(run) || Number.isNaN(merged)) return false;
  return run > merged;
}

// ===== 收件箱「文献」候选 =====

export interface LitInboxCandidate {
  scheduleId: string;
  projectRoot: string;
  /** 最近一次成功 run 的新命中数 */
  count: number;
  /** 最近运行时间（ISO） */
  at: string;
}

/** 收件箱候选：最近一次成功 run 有新命中，且最近运行时间在 24h 内（逾期不再打扰） */
export function litInboxCandidates(
  schedules: readonly ScheduleDto[],
  nowMs: number = Date.now(),
  windowMs: number = 24 * 3600 * 1000,
): LitInboxCandidate[] {
  const out: LitInboxCandidate[] = [];
  for (const s of schedules) {
    if (s.skill !== "lit-watch") continue;
    if (s.lastStatus !== "ok") continue;
    const lastOk = s.history.find((r) => r.status === "ok");
    if (!lastOk) continue;
    const at = Date.parse(lastOk.at);
    if (Number.isNaN(at) || nowMs - at >= windowMs || nowMs - at < 0) continue;
    const count = lastOk?.newEntries ?? 0;
    if (count <= 0) continue;
    out.push({
      scheduleId: s.id,
      projectRoot: s.projectRoot,
      count,
      at: lastOk.at,
    });
  }
  return out;
}

/** 收件箱只对还在注册表里的项目出文献条目。已删/已移除的项目 schedules 可能还在，不能拿文件夹名继续提示。 */
export function litInboxForRegisteredProjects(
  candidates: readonly LitInboxCandidate[],
  projectPaths: readonly string[],
  isWindows = false,
): LitInboxCandidate[] {
  return candidates.filter((c) =>
    projectPaths.some((p) => samePath(c.projectRoot, p, isWindows)),
  );
}

// ===== 条目忽略（dismiss） =====

/** 过滤掉已忽略的命中条目（id 是内容哈希，忽略即永久；内容变了 id 变，自然复现） */
export function filterLitDismissed<T extends { id: string }>(
  entries: readonly T[],
  dismissed: ReadonlySet<string>,
): T[] {
  return entries.filter((e) => !dismissed.has(e.id));
}

// ---- localStorage 薄层（以下依赖 DOM，不进 node 测试） ----

/** 命中条目忽略表的 localStorage 键：字符串数组（内容哈希 id） */
export const LIT_DISMISSED_KEY = "ccode.litDismissed";

export function loadLitDismissed(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LIT_DISMISSED_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** 记录忽略并返回新表；写入失败静默（隐私模式） */
export function dismissLitEntry(
  cur: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(cur).add(id);
  try {
    localStorage.setItem(LIT_DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    /* 写不进就只靠本次内存态 */
  }
  return next;
}
