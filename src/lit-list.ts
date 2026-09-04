/**
 * 无流程科研文献/笔记列表：展示名、编号、状态与过滤纯逻辑。
 */

const DISPLAY_EXT = /\.(pdf|md|markdown|mdx|qmd|ris|bib|txt|csv|tsv|docx|xlsx)$/i;

/** 行上隐去类型后缀（左侧已有 PDF / M↓ 识别），完整文件名留给 title */
export function displayFileTitle(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const stripped = base.replace(DISPLAY_EXT, "");
  return stripped.trim() ? stripped : base;
}

/** 笔记 `01-标题.md` / `100_标题`：前缀数字单独成列 */
export function splitNoteSeq(name: string): { seq: string | null; title: string } {
  const title = displayFileTitle(name);
  const m = title.match(/^(\d+)[-_.\s]+(.+)$/u);
  if (!m) return { seq: null, title };
  return { seq: m[1], title: m[2] };
}

export function compareNotesBySeq(a: string, b: string): number {
  const aa = splitNoteSeq(a);
  const bb = splitNoteSeq(b);
  const an = aa.seq ? Number(aa.seq) : Number.POSITIVE_INFINITY;
  const bn = bb.seq ? Number(bb.seq) : Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  return aa.title.localeCompare(bb.title, "zh");
}

export type LitReadState = "read" | "queued" | "unread";

export function litReadState(hasNote: boolean, included: boolean): LitReadState {
  if (hasNote) return "read";
  if (included) return "queued";
  return "unread";
}

export const LIT_STATUS_FILTERS: {
  id: "all" | LitReadState;
  label: string;
}[] = [
  { id: "all", label: "全部" },
  { id: "read", label: "已读" },
  { id: "queued", label: "精读" },
  { id: "unread", label: "未读" },
];

export function litRowMatches(
  title: string,
  path: string,
  state: LitReadState,
  query: string,
  filter: "all" | LitReadState,
): boolean {
  if (filter !== "all" && state !== filter) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = title.toLowerCase();
  const p = path.replace(/\\/g, "/").toLowerCase();
  return n.includes(q) || p.includes(q);
}

export type NoteSort = "seq" | "recent";

export function compareNotes(
  a: { name: string; modified?: string | null },
  b: { name: string; modified?: string | null },
  sort: NoteSort,
): number {
  if (sort === "recent") {
    const ta = Date.parse(a.modified || "") || 0;
    const tb = Date.parse(b.modified || "") || 0;
    if (tb !== ta) return tb - ta;
  }
  return compareNotesBySeq(a.name, b.name);
}

/** 未搜索时文献/笔记/数据先露这么多，底部「显示全部」 */
export const LIST_PREVIEW_CAP = 10;

/** 预览条按钮文案：展开后改「收起」，单位默认「篇」（文献/笔记），会话/雷达用「条」 */
export function listPreviewToggleLabel(
  revealed: boolean,
  hidden: number,
  unit = "篇",
): string {
  return revealed ? "收起" : `显示全部（还有 ${hidden} ${unit}）`;
}
