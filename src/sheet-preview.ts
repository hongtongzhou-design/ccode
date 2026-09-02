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
