/** 沉浸式阅读区的纯逻辑：分栏百分比钳制/像素换算、阅读会话复用键、
 *  PDF 选段注入格式（B1）；圈选矩形映射/命中判定、md 图片与相对链接判定、截图注入格式（B2）；
 *  划词翻译 prompt、生词本表格契约、段落边界提取、术语匹配、进度/护眼存储键（B3）。
 *  布局常量与换算全部集中这里，组件（ReaderOverlay/PdfContinuousView/FilePreviewEditor）只做绑定。 */

import { escapeShellPath } from "./terminal-input.ts";

export const READER_SPLIT_L_KEY = "ccode.readerSplitL";
export const READER_SPLIT_R_KEY = "ccode.readerSplitR";
/** 侧栏宽度百分比的可拖范围（相对三栏总宽） */
export const READER_PCT_MIN = 12;
export const READER_PCT_MAX = 40;
/** 侧栏（笔记/Agent）最小像素宽：窗口再小也不压缩到不可用 */
export const READER_SIDE_MIN_PX = 240;
/** PDF 栏保底宽度：两侧合计不得把它压到这条线以下 */
export const READER_PDF_MIN_PX = 280;
/** 侧栏缺省百分比（笔记栏窄些、Agent 栏宽些——对话内容比笔记目录长） */
export const READER_PCT_DEFAULT_L = 22;
export const READER_PCT_DEFAULT_R = 28;

/** 栏宽百分比钳制：非有限数/非正数回落 fallback，其余夹到 [min, max] */
export function clampReaderPct(pct: number, fallback: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return fallback;
  return Math.min(READER_PCT_MAX, Math.max(READER_PCT_MIN, pct));
}

/** 打开时读本地记忆的栏宽百分比（坏值/缺省回落 fallback；localStorage 不可用时静默回落） */
export function loadReaderPct(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? clampReaderPct(v, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** 三栏像素换算：侧栏按百分比取整后保底 240px；两侧合计超出「总宽 − PDF 保底」时按比例压缩；
 *  窗口窄到 PDF 保底都拿不出时侧栏归零让位（PDF 全宽） */
export function readerColumnWidths(
  totalPx: number,
  pctL: number,
  pctR: number,
): { left: number; right: number } {
  const budget = totalPx - READER_PDF_MIN_PX;
  if (budget <= 0) return { left: 0, right: 0 };
  const left = Math.max(READER_SIDE_MIN_PX, Math.round((pctL / 100) * totalPx));
  const right = Math.max(READER_SIDE_MIN_PX, Math.round((pctR / 100) * totalPx));
  if (left + right <= budget) return { left, right };
  const k = budget / (left + right);
  return { left: Math.floor(left * k), right: Math.floor(right * k) };
}

/** 阅读会话终端标签的复用键：退出再进接着聊（TerminalPage 与覆盖层同一出处） */
export function readerReuseKey(projectRoot: string): string {
  return `reader:${projectRoot}`;
}

/** PDF 选段「◈ 问 AI」的注入格式（与 TerminalPage.askAiFromPdf 同一出处，勿分叉）：
 *  `> 「≤60 字摘要」（file，第 N 页）` + 空行 + 正文（>6000 截断） */
export function formatPdfExcerptPrompt(
  text: string,
  page: number,
  fileName: string,
): string {
  // 注入上限保护：选段过长时截断正文，避免把整页灌进输入框
  const body = text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
  const brief = text.replace(/\s+/g, " ").slice(0, 60);
  return `> 「${brief}${text.length > 60 ? "…" : ""}」（${fileName}，第 ${page} 页）\n\n${body}`;
}

// ===== 批次 B2：圈选截图、md 图片/相对链接 =====

/** 圈选矩形（CSS px；命中判定与 canvas 映射都在同一坐标系内做） */
export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 小于 8×8 CSS px 视为误触，不成框 */
export const CAPTURE_MIN_PX = 8;

/** 两个指针点归一化成矩形（任意方向拖拽） */
export function normCaptureRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CaptureRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** 矩形是否达到成框尺寸（误触过滤） */
export function captureRectUsable(r: CaptureRect): boolean {
  return r.w >= CAPTURE_MIN_PX && r.h >= CAPTURE_MIN_PX;
}

/** 页槽/页 canvas 的包围盒（page 为页号；坐标与 CaptureRect 同一坐标系） */
export interface PageBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesIntersect(a: CaptureRect, b: CaptureRect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

export type CaptureHit =
  | { kind: "ok"; page: number }
  | { kind: "cross" }
  | { kind: "none" };

/** 圈选命中判定（页槽为判定口径，含页间分隔带）：
 *  与 ≥2 个页槽相交 → cross（拒绝跨页）；恰好 1 个 → ok；0 个 → none（空白处松手） */
export function hitTestCapture(rect: CaptureRect, slots: PageBox[]): CaptureHit {
  const hit = slots.filter((s) => boxesIntersect(rect, s));
  if (hit.length === 0) return { kind: "none" };
  if (hit.length > 1) return { kind: "cross" };
  return { kind: "ok", page: hit[0].page };
}

/** CSS px 圈选矩形 → 页 canvas 像素矩形（DPR/缩放换算：比例 = canvas 像素宽 / CSS 宽）。
 *  先与 canvas 的 CSS 包围盒求交（出圈部分裁掉），再按比例换算；交集为空返回 null。 */
export function captureRectToCanvasPixels(
  rect: CaptureRect,
  canvasCss: CaptureRect,
  canvasW: number,
  canvasH: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const ix = Math.max(rect.x, canvasCss.x);
  const iy = Math.max(rect.y, canvasCss.y);
  const ir = Math.min(rect.x + rect.w, canvasCss.x + canvasCss.w);
  const ib = Math.min(rect.y + rect.h, canvasCss.y + canvasCss.h);
  if (canvasCss.w <= 0 || canvasCss.h <= 0) return null;
  const ratioX = canvasW / canvasCss.w;
  const ratioY = canvasH / canvasCss.h;
  const sx = Math.max(0, Math.round((ix - canvasCss.x) * ratioX));
  const sy = Math.max(0, Math.round((iy - canvasCss.y) * ratioY));
  // 右/下缘按像素边界换算后再与 canvas 尺寸取小，round 出界由这里兜底
  const ex = Math.min(canvasW, Math.round((ir - canvasCss.x) * ratioX));
  const ey = Math.min(canvasH, Math.round((ib - canvasCss.y) * ratioY));
  if (ex - sx < 1 || ey - sy < 1) return null;
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

/** 圈选截图「发给 agent」的注入格式：转义路径（终端粘贴图片同一口径）+ 预填 prompt 与出处 */
export function formatReaderCapturePrompt(
  absPath: string,
  page: number,
  fileName: string,
): string {
  return `${escapeShellPath(absPath)}\n这张图/这段讲了什么？请结合论文解释。（${fileName}，第 ${page} 页圈选）`;
}

/** Uint8Array → base64（分块 btoa，避免大参数上限；btoa 只接受 latin1 串） */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export type MdHrefKind = "anchor" | "external" | "other" | "local";

/** md 链接分类：# 锚点 / http(s) 与协议相对 // 外链 / mailto: 等其它协议 / 本地路径（相对与绝对） */
export function classifyMdHref(href: string): MdHrefKind {
  const t = href.trim();
  if (t.startsWith("#")) return "anchor";
  if (/^https?:\/\//i.test(t) || t.startsWith("//")) return "external";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return "other";
  return "local";
}

/** 去掉 href 的 ?query/#fragment 并 URI 解码（解码失败保留原样） */
export function stripMdHrefSuffix(href: string): string {
  const cut = href.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(cut);
  } catch {
    return cut;
  }
}

function isAbsPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/** 折叠 . 与 ..（绝对路径口径：.. 到根/盘符为止不再上爬） */
function foldPathSegments(segs: string[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      // 盘符段不可被 .. 弹掉（C:/.. 仍在盘符根）
      const min = out.length > 0 && /^[A-Za-z]:$/.test(out[0]) ? 1 : 0;
      if (out.length > min && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/** 相对当前 md 文件目录把 href 解析成绝对路径（分隔符归一为 /） */
export function resolveMdPath(fromFile: string, href: string): string {
  const target = stripMdHrefSuffix(href.replace(/\\/g, "/"));
  if (isAbsPath(target)) {
    const segs = foldPathSegments(target.split("/"));
    return `/${segs.join("/")}`.replace(/^\/(?=[A-Za-z]:\/)/, "");
  }
  const dirSegs = fromFile.replace(/\\/g, "/").split("/").slice(0, -1);
  const joined = foldPathSegments([...dirSegs, ...target.split("/")]);
  const prefix = fromFile.startsWith("/") ? "/" : "";
  return `${prefix}${joined.join("/")}`;
}

/** 目标绝对路径 → 相对 fromFile 所在目录的 md 链接路径（../ 回退；跨盘/不同根给绝对路径） */
export function relMdLinkPath(fromFile: string, targetAbs: string): string {
  const normTarget = targetAbs.replace(/\\/g, "/");
  const dir = fromFile.replace(/\\/g, "/").split("/").slice(0, -1);
  const tgt = normTarget.split("/");
  // 前导空段（/ 开头）对齐剔除，盘符段保留用于比较
  const dirSegs = dir.filter((s) => s !== "");
  const tgtSegs = tgt.filter((s) => s !== "");
  if (
    dirSegs.length > 0 &&
    tgtSegs.length > 0 &&
    dirSegs[0] !== tgtSegs[0] &&
    (/^[A-Za-z]:$/.test(dirSegs[0]) || /^[A-Za-z]:$/.test(tgtSegs[0]))
  ) {
    return normTarget; // Windows 跨盘符无法相对
  }
  let i = 0;
  while (i < dirSegs.length && i < tgtSegs.length && dirSegs[i] === tgtSegs[i]) {
    i += 1;
  }
  const ups = dirSegs.length - i;
  const parts = [...Array(ups).fill(".."), ...tgtSegs.slice(i)];
  return parts.length > 0 ? parts.join("/") : normTarget;
}

// ===== 批次 B3：划词翻译 / 生词本 / 段落对照 / 进度记忆 =====

/** 划词/段落翻译的统一 prompt（ai_prompt fnKey="translate"，设置页可配专用小模型） */
export function buildReaderTranslatePrompt(text: string): string {
  return `把以下学术文献内容翻译为中文。要求：学术语境直译，专业术语保留原词（必要时括注原文），不增减内容，只输出译文，不要任何解释：\n\n${text}`;
}

/** 保存译段成功的 toast 口径：笔记栏停在编辑态且有未保存改动时 watcher 停订、
 *  界面不会回显刚写入的译段——文案里明说，否则看起来像「没反应」 */
export function translationSavedToast(noteDirty: boolean): string {
  return noteDirty
    ? "已存到笔记「译段」（笔记栏有未保存改动，保存后可见）"
    : "已存到笔记「译段」";
}

export type ReaderTranslateResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** 生词本条目（与 Rust GlossaryEntryDto 同形，camelCase 直出） */
export interface GlossaryEntry {
  term: string;
  meaning: string;
  source: string;
}

// ----- 进度记忆与护眼（localStorage，按文件记忆） -----

export const READER_PROGRESS_PREFIX = "ccode.readerProgress.";
export const READER_DARK_PREFIX = "ccode.readerDark.";

export function readerProgressKey(pdfPath: string): string {
  return `${READER_PROGRESS_PREFIX}${pdfPath}`;
}

export function readerDarkKey(pdfPath: string): string {
  return `${READER_DARK_PREFIX}${pdfPath}`;
}

/** 读取记忆的页码（坏值/缺省/localStorage 不可用 → null） */
export function loadReaderProgress(pdfPath: string): number | null {
  try {
    const v = Number(localStorage.getItem(readerProgressKey(pdfPath)));
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

export function saveReaderProgress(pdfPath: string, page: number): void {
  try {
    localStorage.setItem(readerProgressKey(pdfPath), String(page));
  } catch {
    /* 隐私模式等写不进就静默 */
  }
}

export function loadReaderDark(pdfPath: string): boolean {
  try {
    return localStorage.getItem(readerDarkKey(pdfPath)) === "1";
  } catch {
    return false;
  }
}

export function saveReaderDark(pdfPath: string, on: boolean): void {
  try {
    localStorage.setItem(readerDarkKey(pdfPath), on ? "1" : "0");
  } catch {
    /* 同上静默 */
  }
}

// ----- 生词本表格格式（notes/glossary.md） -----
// 格式契约与 src-tauri/src/reader.rs 双端镜像（Rust 负责落盘读写），改动需同步；
// 前端不直接写文件，这组函数是格式的单一可读规格 + 测试锚点。

export const GLOSSARY_HEADER = "| 术语 | 释义 | 出处 |";
export const GLOSSARY_SEP = "| --- | --- | --- |";

/** 单元格转义：| → \|、换行折成空格（表格单行约束） */
export function escapeGlossaryCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
}

/** 按未转义的 | 切分行（\| 还原为 |），单元格 trim；非 | 起头的行返回空数组 */
export function splitGlossaryRow(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("|")) return [];
  const cells: string[] = [];
  let cur = "";
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  // 行尾 | 会多收一个空尾单元，去掉
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** 分隔行判定：所有单元格只由 - : 空格组成且至少含一个 - */
export function isGlossarySepRow(cells: readonly string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((c) => c.length > 0 && c.includes("-") && /^[-: ]+$/.test(c))
  );
}

/** 解析 glossary.md 表格行（容错：非表行/表头/分隔行/不足 3 列/空术语一律跳过） */
export function parseGlossaryTable(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const line of text.split("\n")) {
    const cells = splitGlossaryRow(line);
    if (cells.length < 3 || cells[0] === "") continue;
    if (cells[0] === "术语" || isGlossarySepRow(cells.slice(0, 3))) continue;
    out.push({ term: cells[0], meaning: cells[1], source: cells[2] });
  }
  return out;
}

/** 整表渲染（表头 + 分隔 + 数据行，末尾换行收尾） */
export function renderGlossaryTable(entries: readonly GlossaryEntry[]): string {
  const rows = entries.map(
    (e) =>
      `| ${escapeGlossaryCell(e.term)} | ${escapeGlossaryCell(e.meaning)} | ${escapeGlossaryCell(e.source)} |`,
  );
  return `${[GLOSSARY_HEADER, GLOSSARY_SEP, ...rows].join("\n")}\n`;
}

// ----- 段落对照：textLayer 行分组与段边界提取 -----

/** 一条视觉行（top/height 为渲染坐标，text 为该同行文本片拼接） */
export interface PdfTextLine {
  top: number;
  height: number;
  text: string;
}

/** textLayer 原始文本片（left 参与同行内排序） */
export interface RawTextSpan extends PdfTextLine {
  left: number;
}

/** 同一视觉行的 top 容差（px） */
export const LINE_GROUP_TOLERANCE_PX = 2;
/** 行间垂直间隙 > 行高 × 此倍数视为段界 */
export const PARAGRAPH_GAP_RATIO = 1.4;

/** 文本片 → 视觉行：按 top 分组（容差 2px），组内按 left 顺序拼接 */
export function groupTextLines(spans: readonly RawTextSpan[]): PdfTextLine[] {
  const sorted = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: PdfTextLine[] = [];
  for (const s of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(s.top - last.top) <= LINE_GROUP_TOLERANCE_PX) {
      last.text += s.text;
      last.top = Math.min(last.top, s.top);
      last.height = Math.max(last.height, s.height);
    } else {
      lines.push({ top: s.top, height: s.height, text: s.text });
    }
  }
  return lines;
}

/** 相邻两行是否构成段界（垂直间隙 > 1.4 × 较小行高；负间隙 = 行重叠，不算段界） */
export function isParagraphBreak(a: PdfTextLine, b: PdfTextLine): boolean {
  const gap = b.top - (a.top + a.height);
  return gap > PARAGRAPH_GAP_RATIO * Math.min(a.height, b.height);
}

/** 从点击行向上下扩展出段边界（返回闭区间行号） */
export function paragraphBounds(
  lines: readonly PdfTextLine[],
  index: number,
): { start: number; end: number } {
  if (lines.length === 0) return { start: 0, end: -1 };
  const i = Math.min(Math.max(index, 0), lines.length - 1);
  let start = i;
  let end = i;
  while (start > 0 && !isParagraphBreak(lines[start - 1], lines[start])) {
    start--;
  }
  while (end < lines.length - 1 && !isParagraphBreak(lines[end], lines[end + 1])) {
    end++;
  }
  return { start, end };
}

/** 点击 y 坐标命中的行：含则命中，否则取垂直距离最近的行 */
export function nearestLineIndex(lines: readonly PdfTextLine[], y: number): number {
  let best = 0;
  let bestDist = Infinity;
  lines.forEach((l, i) => {
    const dist =
      y < l.top ? l.top - y : y > l.top + l.height ? y - (l.top + l.height) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** 段内视觉行拼成段落全文（行间换行，行尾空白收掉） */
export function joinParagraphLines(lines: readonly PdfTextLine[]): string {
  return lines
    .map((l) => l.text.replace(/\s+$/u, ""))
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
}

// ----- 术语高亮匹配 -----

export interface GlossaryMatch {
  start: number;
  end: number;
  meaning: string;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在一段文本里找术语命中（大小写不敏感）：
 *  词首/尾是英文单词字符的术语要求整词边界（相邻不得是单词字符）；
 *  CJK 术语无单词边界概念，按子串命中。长术语优先，命中不重叠。 */
export function findGlossaryMatches(
  text: string,
  terms: readonly Pick<GlossaryEntry, "term" | "meaning">[],
): GlossaryMatch[] {
  if (!text || terms.length === 0) return [];
  // 小写去重（先来的赢）+ 长按降：交替匹配长词优先
  const byLower = new Map<string, string>();
  for (const t of terms) {
    const term = t.term.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, t.meaning);
  }
  if (byLower.size === 0) return [];
  const words = [...byLower.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  const out: GlossaryMatch[] = [];
  let lastEnd = -1;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const hit = m[0];
    const start = m.index;
    const end = start + hit.length;
    const headOk =
      !WORD_CHAR.test(hit[0]) || start === 0 || !WORD_CHAR.test(text[start - 1]);
    const tailOk =
      !WORD_CHAR.test(hit[hit.length - 1]) ||
      end === text.length ||
      !WORD_CHAR.test(text[end]);
    if (headOk && tailOk && start >= lastEnd) {
      out.push({ start, end, meaning: byLower.get(hit.toLowerCase()) ?? "" });
      lastEnd = end;
    }
    if (hit.length === 0) re.lastIndex++; // 空词防死循环（正常到不了这里）
  }
  return out;
}
