/**
 * 项目工作方式与编程状态归类纯逻辑。
 * 科研 / 编程 / 办公终身一种主界面；缺省或旧档案卡 = 科研。
 * 项目栏按方式分段见 groupByWorkMode。
 */

export type WorkMode = "research" | "coding" | "office";

export const WORK_MODES: readonly WorkMode[] = ["research", "coding", "office"];

export const WORK_MODE_LABEL: Record<WorkMode, string> = {
  research: "科研",
  coding: "编程",
  office: "办公",
};

export const WORK_MODE_HINT: Record<WorkMode, string> = {
  research: "按课题推进，可选研究流程、任务卡、文献雷达",
  coding: "按分支和工作树推进，管并行改动和合并",
  office: "处理文档和日常材料",
};

/** 项目栏分段：三种工作方式之后才是未添加仓库。 */
export type RailWorkMode = WorkMode | "unregistered";

export const RAIL_WORK_MODE_ORDER: readonly RailWorkMode[] = [
  ...WORK_MODES,
  "unregistered",
];

export const RAIL_WORK_MODE_LABEL: Record<RailWorkMode, string> = {
  ...WORK_MODE_LABEL,
  unregistered: "未添加",
};

/**
 * 项目栏按工作方式分段。组内保持传入顺序（最近打开）；空组不出现。
 * `modeOf` 返回 `"unregistered"` 表示尚未添加的仓库，沉在最下；其余走 normalizeWorkMode。
 */
export function groupByWorkMode<T>(
  items: readonly T[],
  modeOf: (item: T) => string | null | undefined,
): { mode: RailWorkMode; items: T[] }[] {
  const buckets: Record<RailWorkMode, T[]> = {
    research: [],
    coding: [],
    office: [],
    unregistered: [],
  };
  for (const item of items) {
    const raw = modeOf(item);
    const mode: RailWorkMode =
      raw === "unregistered" ? "unregistered" : normalizeWorkMode(raw);
    buckets[mode].push(item);
  }
  return RAIL_WORK_MODE_ORDER.filter((mode) => buckets[mode].length > 0).map(
    (mode) => ({ mode, items: buckets[mode] }),
  );
}

export function normalizeWorkMode(value?: string | null): WorkMode {
  const v = value?.trim();
  if (v === "coding" || v === "office" || v === "research") return v;
  return "research";
}

/** 已选定或档案卡已落盘的工作方式不可改选（终身一张主界面）。 */
export function lockWorkModeFromConfig(input: {
  existingMode?: WorkMode | null;
  fileMode?: string | null;
  stepCount?: number;
  pipelineOptOut?: boolean;
}): { mode: WorkMode; locked: boolean } {
  if (input.existingMode) {
    return { mode: input.existingMode, locked: true };
  }
  const file = normalizeWorkMode(input.fileMode);
  const persisted =
    file === "coding" ||
    file === "office" ||
    (input.stepCount ?? 0) > 0 ||
    !!input.pipelineOptOut;
  if (persisted) return { mode: file, locked: true };
  return { mode: "research", locked: false };
}

/** 编程第四行状态：git 事实 → 白话归类 */
export type CodingKind = "base" | "idle" | "dev" | "sync" | "ready" | "prune";

export const CODING_KIND_LABEL: Record<CodingKind, string> = {
  base: "基准",
  idle: "未开始",
  dev: "正在开发",
  sync: "需同步",
  ready: "等待合并",
  prune: "可清理",
};

export function deriveCodingKind(facts: {
  isBase: boolean;
  isPrimary: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasWorktree: boolean;
}): CodingKind {
  if (facts.isBase && facts.isPrimary) return "base";
  if (facts.behind > 0) return "sync";
  if (facts.dirty) return "dev";
  if (facts.ahead > 0) return "ready";
  if (facts.hasWorktree) return "idle";
  return "prune";
}

export function codingKindUrgent(kind: CodingKind): boolean {
  return kind === "sync" || kind === "ready" || kind === "dev";
}

/** 工作树/分支行上的 git 事实芯片：只亮非默认态，干净且已推送不占位。 */
export type CodingFactTone = "ok" | "warn" | "muted";

export interface CodingFactChip {
  key: string;
  label: string;
  tone: CodingFactTone;
  tip: string;
}

export function codingFactChips(facts: {
  dirty: boolean;
  dirtyCount?: number | null;
  ahead: number;
  behind: number;
  unpushed: number;
  hasUpstream: boolean;
  upstreamBehind?: number;
  baseBranch: string;
  hostKind?: "github" | "other" | null;
}): CodingFactChip[] {
  const gh = facts.hostKind === "github";
  const remoteWord = gh ? "GitHub" : "远程";
  const base = facts.baseBranch.trim() || "基准";
  const chips: CodingFactChip[] = [];
  if (facts.dirty) {
    const n = facts.dirtyCount ?? 0;
    chips.push({
      key: "dirty",
      label: n > 0 ? `${n} 个未提交` : "有改动",
      tone: "warn",
      tip: "有未提交的改动",
    });
  }
  if (facts.ahead > 0) {
    chips.push({
      key: "ahead",
      label: `待合入 ${facts.ahead}`,
      tone: "ok",
      tip: `比基准 ${base} 多 ${facts.ahead} 个提交，可以合并`,
    });
  }
  if (facts.behind > 0) {
    chips.push({
      key: "behind",
      label: `落后基准 ${facts.behind}`,
      tone: "warn",
      tip: `基准 ${base} 有 ${facts.behind} 个新提交`,
    });
  }
  const upstreamBehind = facts.upstreamBehind ?? 0;
  if (!facts.hasUpstream) {
    chips.push({
      key: "remote",
      label: "无上游",
      tone: "muted",
      tip: gh
        ? "还没推到 GitHub，第一次推送会设上游"
        : "还没推到远程，第一次推送会设上游",
    });
  } else if (facts.unpushed > 0) {
    chips.push({
      key: "remote",
      label: facts.unpushed === 1 ? "未推送" : `未推送 ${facts.unpushed}`,
      tone: "warn",
      tip: `比 ${remoteWord} 上该分支多 ${facts.unpushed} 个提交`,
    });
  } else if (facts.dirty || facts.ahead > 0) {
    chips.push({
      key: "remote",
      label: "已推送",
      tone: "muted",
      tip: gh ? "该分支已推到 GitHub" : "该分支已推到远程",
    });
  }
  if (facts.hasUpstream && upstreamBehind > 0) {
    chips.push({
      key: "upstreamBehind",
      label: `远程有更新 ${upstreamBehind}`,
      tone: "warn",
      tip: gh
        ? `GitHub 上该分支有 ${upstreamBehind} 个新提交，可拉取`
        : `远程该分支有 ${upstreamBehind} 个新提交，可拉取`,
    });
  }
  return chips;
}

/** 办公文档类型筛选（全部 / 文档 / 表格 / 幻灯 / PDF / 图片） */
export type OfficeDocKind = "doc" | "sheet" | "slide" | "pdf" | "image" | "other";

export const OFFICE_FILTERS: { id: "all" | OfficeDocKind; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "doc", label: "文档" },
  { id: "sheet", label: "表格" },
  { id: "slide", label: "幻灯" },
  { id: "pdf", label: "PDF" },
  { id: "image", label: "图片" },
];

const OFFICE_EXT: Record<string, OfficeDocKind> = {
  md: "doc",
  markdown: "doc",
  mdx: "doc",
  qmd: "doc",
  txt: "doc",
  tsv: "sheet",
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  xls: "sheet",
  xlsx: "sheet",
  xlsm: "sheet",
  ods: "sheet",
  csv: "sheet",
  ppt: "slide",
  pptx: "slide",
  odp: "slide",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
};

export function officeDocKind(path: string): OfficeDocKind {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "other";
  return OFFICE_EXT[name.slice(dot + 1).toLowerCase()] ?? "other";
}

/** 办公文档搜索：文件名或相对路径包含查询（大小写无关；空查询全过） */
export function officeDocMatchesQuery(
  name: string,
  rel: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = name.toLowerCase();
  const r = rel.replace(/\\/g, "/").toLowerCase();
  return n.includes(q) || r.includes(q);
}

/** 办公就地预览形态。csv/txt/md 走文本；xlsx 走表格；doc/rtf/幻灯请用系统应用。 */
export type OfficePreviewMode =
  | "text"
  | "pdf"
  | "image"
  | "xlsx"
  | "docx"
  | "external";

export function officePreviewMode(path: string): OfficePreviewMode {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "external";
  const ext = name.slice(dot + 1).toLowerCase();
  if (
    ext === "md" ||
    ext === "markdown" ||
    ext === "mdx" ||
    ext === "qmd" ||
    ext === "txt" ||
    ext === "tsv" ||
    ext === "csv"
  ) {
    return "text";
  }
  if (ext === "pdf") return "pdf";
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg"
  ) {
    return "image";
  }
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls" || ext === "ods") {
    return "xlsx";
  }
  if (ext === "docx") return "docx";
  return "external";
}

export function isOfficePreviewable(path: string): boolean {
  return officePreviewMode(path) !== "external";
}

export function officeRecentKey(projectPath: string): string {
  return `ccode.officeRecent.${projectPath.replace(/[\\/]+$/, "")}`;
}

/** 问 AI 标签复用键：一份文件一个标签。rel 统一 `/`。 */
export function officeFileReuseKey(repoPath: string, rel: string): string {
  return `office:${repoPath}:${rel.replace(/\\/g, "/")}`;
}

export function projectChatReuseKey(
  kind: "office" | "coding" | "research",
  repoPath: string,
): string {
  return `${kind}:${repoPath}:project`;
}

export function officeProjectReuseKey(repoPath: string): string {
  return projectChatReuseKey("office", repoPath);
}

/**
 * 文件行「进行中」：只认对着这一份文件、且还在跑/等确认的标签。
 * 项目根在跑、七日内打开过预览，都不算。
 */
export function officeFileInProgress(
  fileKey: string,
  liveReuseKeys: readonly (string | null | undefined)[],
): boolean {
  if (!fileKey) return false;
  return liveReuseKeys.some((k) => k === fileKey);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 工作台项目卡：仓里有活标签，或七日内有过文档对话。 */
export function isOfficeInProgress(opts: {
  hasLiveTab: boolean;
  lastSessionAt: string | null;
  lastOpenedAt: string | null;
  nowMs?: number;
}): boolean {
  if (opts.hasLiveTab) return true;
  const now = opts.nowMs ?? Date.now();
  for (const raw of [opts.lastSessionAt, opts.lastOpenedAt]) {
    if (!raw) continue;
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && now - t <= SEVEN_DAYS_MS) return true;
  }
  return false;
}
