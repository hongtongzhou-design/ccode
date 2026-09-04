/**
 * 项目页状态行、工作区排序、笔记过滤、办公继续上次 / 路径展示 / 问 AI 建议等纯逻辑。
 * 与 DOM/Tauri 解耦，供 node --test 直接测。
 */
import { pathWithin, samePath } from "./path-utils.ts";
import { sessionExcludedFromProjectList } from "./session-filter.ts";
import { deriveCodingKind, officeDocKind, type OfficeDocKind } from "./work-mode.ts";
import { namedSessionTitle } from "./workbench-hero.ts";

export function codingStatusLine(input: {
  worktrees: readonly {
    isBase: boolean;
    isPrimary: boolean;
    dirty: boolean;
    ahead: number;
    behind: number;
    merging?: boolean;
  }[];
  merging?: boolean;
}): string {
  const n = input.worktrees.length;
  let ready = 0;
  let sync = 0;
  for (const w of input.worktrees) {
    const kind = deriveCodingKind({
      isBase: w.isBase,
      isPrimary: w.isPrimary,
      dirty: w.dirty,
      ahead: w.ahead,
      behind: w.behind,
      hasWorktree: true,
    });
    if (kind === "ready") ready += 1;
    if (kind === "sync") sync += 1;
  }
  const parts = [`${n} 个工作树`];
  if (input.merging || input.worktrees.some((w) => w.merging)) {
    parts.push("有冲突");
  }
  if (ready > 0) parts.push(`${ready} 个待合并`);
  if (sync > 0) parts.push(`${sync} 个需同步`);
  return parts.join(" · ");
}

export function officeStatusLine(input: {
  total: number;
  touchedYesterday: number;
}): string {
  if (input.total === 0) return "还没有文档";
  if (input.touchedYesterday > 0) {
    return `文档 ${input.total} · 昨天动过 ${input.touchedYesterday} 篇`;
  }
  return `文档 ${input.total}`;
}

export function countTouchedSince(
  docs: readonly { modified?: string | null; lastOpenedAt?: string | null }[],
  sinceMs: number,
): number {
  let n = 0;
  for (const d of docs) {
    for (const raw of [d.lastOpenedAt, d.modified]) {
      if (!raw) continue;
      const t = Date.parse(raw);
      if (!Number.isNaN(t) && t >= sinceMs) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

export function startOfYesterdayMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - 24 * 60 * 60 * 1000;
}

/** 冲突 / 等你验收排最前；同档保持原序。 */
export function workspaceAttentionRank(input: {
  status: string;
  mergedAt: string | null;
  ahead?: number;
  conflict?: boolean | null;
  canResolveMerge?: boolean;
  readyToMerge?: boolean;
}): number {
  if (input.canResolveMerge || input.conflict) return 0;
  if (input.readyToMerge) return 1;
  if (input.status === "active" && !input.mergedAt && (input.ahead ?? 0) > 0) {
    return 1;
  }
  return 2;
}

export function sortWorkspacesByAttention<
  T extends { status: string; mergedAt: string | null },
>(
  list: readonly T[],
  info: (item: T) => {
    ahead?: number;
    conflict?: boolean | null;
    canResolveMerge?: boolean;
    readyToMerge?: boolean;
  },
): T[] {
  return [...list]
    .map((item, index) => ({ item, index, rank: workspaceAttentionRank({ ...item, ...info(item) }) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((row) => row.item);
}

const DATA_EXT = /\.(csv|tsv|txt|xls|xlsx|xlsm|ods|parquet|sav|dta)$/i;
const PAPER_EXT = /\.(pdf|bib|ris|enw)$/i;

export function isDataFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  return DATA_EXT.test(name);
}

export function isPaperFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  return PAPER_EXT.test(name);
}

/** 文献：论文 PDF / 引文；数据：表格与实验文本。同名两套规则时数据优先。 */
export function partitionResources<T extends { path: string; type?: string }>(
  resources: readonly T[],
): { papers: T[]; data: T[] } {
  const papers: T[] = [];
  const data: T[] = [];
  for (const r of resources) {
    if (isDataFile(r.path) || r.type === "dataset") data.push(r);
    else if (isPaperFile(r.path) || r.type === "paper" || r.type === "reference") {
      papers.push(r);
    }
  }
  return { papers, data };
}

export function isProjectNotesPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return n === "notes" || n.startsWith("notes/");
}

/** notes/ 下给人看的 md：去掉 glossary 等机管文件。inbox.md 是产出，留下。 */
export function isUserNoteFile(name: string, isDir: boolean): boolean {
  if (isDir) return false;
  if (!/\.md$/i.test(name)) return false;
  const n = name.toLowerCase();
  if (n === "glossary.md") return false;
  if (n.startsWith(".")) return false;
  return true;
}

export function officeKindCounts(
  paths: readonly string[],
): Record<OfficeDocKind | "all", number> {
  const out: Record<OfficeDocKind | "all", number> = {
    all: paths.length,
    doc: 0,
    sheet: 0,
    slide: 0,
    pdf: 0,
    image: 0,
    other: 0,
  };
  for (const p of paths) {
    out[officeDocKind(p)] += 1;
  }
  return out;
}

export function officeContinueItems<T extends { path: string }>(
  docs: readonly T[],
  recentMap: Record<string, string>,
  limit = 3,
): T[] {
  const ranked = docs
    .map((d) => ({ d, at: Date.parse(recentMap[d.path] ?? "") }))
    .filter((x) => !Number.isNaN(x.at))
    .sort((a, b) => b.at - a.at);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of ranked) {
    if (seen.has(row.d.path)) continue;
    seen.add(row.d.path);
    out.push(row.d);
    if (out.length >= limit) break;
  }
  return out;
}

/** 文件少时不单独出「继续上次」卡，避免和列表同一份文件打两遍。 */
export const OFFICE_CONTINUE_MIN_DOCS = 4;

export function officeShowContinueCard(
  totalDocs: number,
  continueCount: number,
): boolean {
  return totalDocs >= OFFICE_CONTINUE_MIN_DOCS && continueCount > 0;
}

export function officeRecentPath(
  docs: readonly { path: string }[],
  recentMap: Record<string, string>,
): string | null {
  return officeContinueItems(docs, recentMap, 1)[0]?.path ?? null;
}

/** 只在有子目录时回目录段；根目录文件与文件名重复的相对路径不展示。 */
export function officeDirLabel(name: string, rel: string): string | null {
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === name) return null;
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return null;
  const dir = normalized.slice(0, slash).trim();
  return dir || null;
}

export interface OfficePromptChip {
  label: string;
  prompt: string;
  filePath: string;
  fileName: string;
}

function officeStem(name: string): string {
  const n = name.trim();
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(0, dot) : n;
}

function officeShortStem(name: string, max = 10): string {
  const stem = officeStem(name);
  if (stem.length <= max) return stem;
  return `${stem.slice(0, max)}…`;
}

function quoteOfficePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** 空对话时针对最近一份文件给 1–2 条可点建议；无文件则空。 */
export function officePromptSuggestions(
  docs: readonly { path: string; name: string }[],
  recentMap: Record<string, string>,
  limit = 2,
): OfficePromptChip[] {
  const primary =
    officeContinueItems(docs, recentMap, 1)[0] ?? docs[0] ?? null;
  if (!primary || limit <= 0) return [];
  const quoted = quoteOfficePath(primary.path);
  const short = officeShortStem(primary.name);
  const kind = officeDocKind(primary.path);
  const chips: OfficePromptChip[] = [];
  if (kind === "sheet") {
    chips.push({
      label: `分析「${short}」`,
      prompt: `请分析这份表格：${quoted}\n提取核心数据、对比维度和值得注意的数字。`,
      filePath: primary.path,
      fileName: primary.name,
    });
    chips.push({
      label: "提取核心数据",
      prompt: `请从这份表格提取核心数据：${quoted}\n用简洁条目列出关键数字和对比结论。`,
      filePath: primary.path,
      fileName: primary.name,
    });
  } else if (kind === "doc" || kind === "pdf") {
    chips.push({
      label: `提炼「${short}」`,
      prompt: `请提炼这份文件的要点：${quoted}`,
      filePath: primary.path,
      fileName: primary.name,
    });
    chips.push({
      label: "整理成摘要",
      prompt: `请把这份文件整理成一段摘要：${quoted}`,
      filePath: primary.path,
      fileName: primary.name,
    });
  } else if (kind === "slide") {
    chips.push({
      label: `梳理「${short}」`,
      prompt: `请梳理这份幻灯的结构和要点：${quoted}`,
      filePath: primary.path,
      fileName: primary.name,
    });
  } else if (kind === "image") {
    chips.push({
      label: `说明「${short}」`,
      prompt: `请说明这张图片里的内容：${quoted}`,
      filePath: primary.path,
      fileName: primary.name,
    });
  } else {
    chips.push({
      label: `看「${short}」`,
      prompt: `请看这份文件：${quoted}`,
      filePath: primary.path,
      fileName: primary.name,
    });
  }
  return chips.slice(0, limit);
}

/** 办公「对话」徽标：问 AI 时标签标题用的是文件名，会话标题对得上才标。对不上不猜。 */
export function sessionMentionsFile(
  session: {
    customTitle: string | null;
    title: string | null;
  },
  fileName: string,
): boolean {
  const name = fileName.trim();
  if (!name) return false;
  const shown = namedSessionTitle(session) ?? session.title?.trim() ?? "";
  if (!shown) return false;
  return shown === name || shown.startsWith(`${name} `) || shown.endsWith(` ${name}`);
}

/** 本项目会话：主仓 + 工作树路径都算；置顶在前，其余保持原序。
 *  雷达解读 / 定时巡检 / 问 AI / 阅读区注入不进此列表。 */
export function filterProjectSessions<
  T extends {
    projectPath: string;
    pinned?: boolean;
    internal?: boolean;
    source?: string;
    title?: string | null;
    customTitle?: string | null;
  },
>(
  sessions: readonly T[],
  projectPath: string,
  extraRoots: readonly string[] = [],
  opts?: { limit?: number; isWindows?: boolean },
): T[] {
  const isWindows = opts?.isWindows ?? false;
  const limit = opts?.limit ?? 40;
  const matched: T[] = [];
  for (const session of sessions) {
    if (sessionExcludedFromProjectList(session)) continue;
    if (samePath(session.projectPath, projectPath, isWindows)) {
      matched.push(session);
      continue;
    }
    if (
      extraRoots.some(
        (root) =>
          samePath(session.projectPath, root, isWindows) ||
          pathWithin(session.projectPath, root, isWindows),
      )
    ) {
      matched.push(session);
    }
  }
  const pinned = matched.filter((s) => s.pinned);
  const rest = matched.filter((s) => !s.pinned);
  return [...pinned, ...rest].slice(0, limit);
}

export function filterPortsForRepo<T extends { cwd: string | null }>(
  ports: readonly T[],
  roots: readonly string[],
  isWindows = false,
): T[] {
  if (roots.length === 0) return [];
  return ports.filter((p) => {
    if (!p.cwd) return false;
    return roots.some((root) => pathWithin(p.cwd!, root, isWindows));
  });
}
