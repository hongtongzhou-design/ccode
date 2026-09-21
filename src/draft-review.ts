/** 写作步评审：机械红线扫描 + 退回给 Agent 的提示词。不解释学术对错。 */

export interface WritingReviewHit {
  id: string;
  label: string;
}

function abstractBlock(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "");
  const start = trimmed.search(/^#{1,3}\s+abstract\b/im);
  if (start < 0) {
    const yamlEnd = trimmed.match(/^---\s*$/m);
    return trimmed.slice(0, 1200);
  }
  const after = trimmed.slice(start);
  const nl = after.indexOf("\n");
  const rest = nl < 0 ? "" : after.slice(nl + 1);
  const next = rest.search(/^#{1,3}\s+/m);
  return next < 0 ? after : after.slice(0, nl + 1 + next);
}

function bodyWithoutFramework(text: string): string {
  const i = text.search(/^#{1,3}\s*框架推演\b/m);
  return i >= 0 ? text.slice(0, i) : text;
}

export function scanWritingReview(
  text: string,
  opts?: { allowGapIds?: boolean },
): WritingReviewHit[] {
  const hits: WritingReviewHit[] = [];
  const abstract = abstractBlock(text);
  if (/\[待核实\]/.test(abstract)) {
    hits.push({ id: "abstract-unverified", label: "摘要含 [待核实]" });
  }
  const body = bodyWithoutFramework(text);
  if (!opts?.allowGapIds && /\bG\d+\b/.test(body)) {
    hits.push({ id: "gap-ids", label: "正文含空白编号（G1…）" });
  }
  const drawn = body.match(/待绘制/g)?.length ?? 0;
  if (drawn > 0) {
    hits.push({ id: "placeholder-fig", label: `${drawn} 处「待绘制」` });
  }
  if (/^#{1,6}\s+\d+(\.\d+)*[.\s]/m.test(body)) {
    hits.push({ id: "manual-numbers", label: "标题手写了序号，渲染会叠号" });
  }
  return hits;
}

/** 源稿优先；渲染稿里 Word 先于 PDF。 */
export function sortWritingPreviewPaths(paths: readonly string[]): string[] {
  const rank = (path: string) => {
    const n = path.replace(/\\/g, "/").toLowerCase();
    if (n.endsWith(".md") || n.endsWith(".qmd")) return 0;
    if (n.endsWith(".docx")) return 1;
    if (n.endsWith(".pdf")) return 2;
    return 3;
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "zh"));
}

export function writingScanSourcePath(paths: readonly string[]): string | null {
  const md = paths.filter((p) => /\.(md|qmd)$/i.test(p.replace(/\\/g, "/")));
  const draft = md.find((p) => /draft\.md$/i.test(p) || /manuscript\//i.test(p));
  if (draft) return draft;
  const outline = md.find((p) => /(^|\/)outline\.md$/i.test(p.replace(/\\/g, "/")));
  return outline ?? md[0] ?? null;
}

export function writingReturnPrompt(input: {
  notes: string;
  hits: readonly WritingReviewHit[];
  rewrite: boolean;
}): string {
  const notes = input.notes.trim();
  const lines = [
    input.rewrite
      ? "人在评审里要求按意见重写本步稿件。读 TASK.md、outline.md、notes/ 和 `.ccode/review-notes.md`。保留已核对的论点和可解析引用键，不要另起无关结构，不要凑字数。"
      : "人在评审里退回本步。读 TASK.md 和 `.ccode/review-notes.md`，按意见改现有产物，不要整篇从零重写，不要凑字数。",
  ];
  if (input.hits.length > 0) {
    lines.push(`机械红线：${input.hits.map((h) => h.label).join("；")}。`);
  }
  if (notes) {
    lines.push("意见：", notes);
  }
  lines.push("改完在本工作区提交。不要保存进项目。");
  return lines.join("\n");
}
