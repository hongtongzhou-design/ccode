/** 0 起算的列号 → Excel 列字母（0=A，25=Z，26=AA） */
export function colLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) return "";
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 单元格引用：0 行 0 列 → A1 */
export function cellRef(row: number, col: number): string {
  const letter = colLetter(col);
  if (!letter || !Number.isInteger(row) || row < 0) return "";
  return `${letter}${row + 1}`;
}

/** 工作表合并区（0 起算，含起点，rowspan/colspan ≥ 1） */
export interface SheetMerge {
  r: number;
  c: number;
  rowspan: number;
  colspan: number;
}

/** 把合并区裁进已显示的行×列窗口；1×1 或完全在窗外则丢掉 */
export function clipSheetMerge(
  m: SheetMerge,
  maxRows: number,
  maxCols: number,
): SheetMerge | null {
  if (
    !Number.isInteger(m.r) ||
    !Number.isInteger(m.c) ||
    !Number.isInteger(m.rowspan) ||
    !Number.isInteger(m.colspan) ||
    m.r < 0 ||
    m.c < 0 ||
    m.rowspan < 1 ||
    m.colspan < 1 ||
    maxRows < 1 ||
    maxCols < 1
  ) {
    return null;
  }
  if (m.r >= maxRows || m.c >= maxCols) return null;
  const rowspan = Math.min(m.rowspan, maxRows - m.r);
  const colspan = Math.min(m.colspan, maxCols - m.c);
  if (rowspan < 1 || colspan < 1) return null;
  if (rowspan === 1 && colspan === 1) return null;
  return { r: m.r, c: m.c, rowspan, colspan };
}

/** 该格被别人的合并挡住（自己不是起点）——不渲染 td */
export function sheetCellHidden(
  merges: readonly SheetMerge[],
  r: number,
  c: number,
): boolean {
  return merges.some(
    (m) =>
      !(m.r === r && m.c === c) &&
      r >= m.r &&
      r < m.r + m.rowspan &&
      c >= m.c &&
      c < m.c + m.colspan,
  );
}

export function sheetMergeAt(
  merges: readonly SheetMerge[],
  r: number,
  c: number,
): SheetMerge | undefined {
  return merges.find((m) => m.r === r && m.c === c);
}

export function sheetTruncationLabel(input: {
  shownRows: number;
  shownCols: number;
  totalRows: number;
  totalCols: number;
}): string | null {
  const { shownRows, shownCols, totalRows, totalCols } = input;
  if (totalRows <= shownRows && totalCols <= shownCols) return null;
  return `显示 ${shownRows} 行 × ${shownCols} 列（共 ${totalRows} × ${totalCols}）`;
}

export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLS = 256;

/** RFC 4180 口径：引号字段可含分隔符与换行，`""` 为字面引号。 */
export function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted || field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export function delimitedSheetPreview(
  text: string,
  delimiter: string,
  maxRows = CSV_PREVIEW_MAX_ROWS,
  maxCols = CSV_PREVIEW_MAX_COLS,
): {
  rows: string[][];
  truncated: boolean;
  totalRows: number;
  totalCols: number;
} {
  const all = parseDelimitedRows(text, delimiter);
  const totalRows = all.length;
  const totalCols = all.reduce((m, r) => Math.max(m, r.length), 0);
  const truncated = totalRows > maxRows || totalCols > maxCols;
  const rows = all.slice(0, maxRows).map((r) => {
    const next = r.slice(0, maxCols);
    while (next.length < Math.min(totalCols, maxCols)) next.push("");
    return next;
  });
  return { rows, truncated, totalRows, totalCols };
}

export function csvDelimiterForPath(path: string): "," | "\t" {
  return /\.tsv$/i.test(path) ? "\t" : ",";
}
