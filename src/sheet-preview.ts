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
