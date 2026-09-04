import assert from "node:assert/strict";
import test from "node:test";
import {
  cellRef,
  clipSheetMerge,
  colLetter,
  sheetCellHidden,
  sheetMergeAt,
  sheetTruncationLabel,
} from "../src/sheet-preview.ts";

test("colLetter 0=A、25=Z、26=AA、701=ZZ", () => {
  assert.equal(colLetter(0), "A");
  assert.equal(colLetter(25), "Z");
  assert.equal(colLetter(26), "AA");
  assert.equal(colLetter(27), "AB");
  assert.equal(colLetter(701), "ZZ");
  assert.equal(colLetter(702), "AAA");
  assert.equal(colLetter(-1), "");
});

test("cellRef 行列合成 A1 风格", () => {
  assert.equal(cellRef(0, 0), "A1");
  assert.equal(cellRef(11, 1), "B12");
  assert.equal(cellRef(0, 26), "AA1");
  assert.equal(cellRef(-1, 0), "");
});

test("sheetTruncationLabel 未截断为 null，截断写清已显示/总共", () => {
  assert.equal(
    sheetTruncationLabel({
      shownRows: 10,
      shownCols: 4,
      totalRows: 10,
      totalCols: 4,
    }),
    null,
  );
  assert.equal(
    sheetTruncationLabel({
      shownRows: 200,
      shownCols: 40,
      totalRows: 800,
      totalCols: 40,
    }),
    "显示 200 行 × 40 列（共 800 × 40）",
  );
  assert.equal(
    sheetTruncationLabel({
      shownRows: 12,
      shownCols: 256,
      totalRows: 12,
      totalCols: 400,
    }),
    "显示 12 行 × 256 列（共 12 × 400）",
  );
});

test("clipSheetMerge：窗外丢掉，贴边裁切，1×1 不算合并", () => {
  assert.equal(
    clipSheetMerge({ r: 0, c: 0, rowspan: 1, colspan: 1 }, 10, 10),
    null,
  );
  assert.deepEqual(
    clipSheetMerge({ r: 0, c: 0, rowspan: 2, colspan: 3 }, 10, 10),
    { r: 0, c: 0, rowspan: 2, colspan: 3 },
  );
  assert.deepEqual(
    clipSheetMerge({ r: 8, c: 8, rowspan: 5, colspan: 5 }, 10, 10),
    { r: 8, c: 8, rowspan: 2, colspan: 2 },
  );
  assert.equal(
    clipSheetMerge({ r: 10, c: 0, rowspan: 2, colspan: 2 }, 10, 10),
    null,
  );
  assert.equal(clipSheetMerge({ r: -1, c: 0, rowspan: 2, colspan: 2 }, 10, 10), null);
});

test("sheetCellHidden / sheetMergeAt：只挡非起点", () => {
  const merges = [{ r: 1, c: 2, rowspan: 2, colspan: 3 }];
  assert.equal(sheetMergeAt(merges, 1, 2)?.colspan, 3);
  assert.equal(sheetMergeAt(merges, 1, 3), undefined);
  assert.equal(sheetCellHidden(merges, 1, 2), false);
  assert.equal(sheetCellHidden(merges, 1, 3), true);
  assert.equal(sheetCellHidden(merges, 2, 4), true);
  assert.equal(sheetCellHidden(merges, 0, 2), false);
  assert.equal(sheetCellHidden(merges, 3, 2), false);
});
