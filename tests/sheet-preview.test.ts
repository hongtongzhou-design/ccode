import assert from "node:assert/strict";
import test from "node:test";
import {
  cellRef,
  colLetter,
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
