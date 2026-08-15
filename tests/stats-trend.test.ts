import { test } from "node:test";
import assert from "node:assert/strict";
import { axisLabels, spanDays } from "../src/stats-trend.ts";

test("spanDays：同日为 0，跨月为实际天数", () => {
  assert.equal(spanDays("2026-08-01", "2026-08-01"), 0);
  assert.equal(spanDays("2026-08-01", "2026-09-15"), 45);
});

test("axisLabels：短跨度按 MM-DD 标注，含首尾", () => {
  const days = Array.from(
    { length: 10 },
    (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`,
  );
  const labels = axisLabels(days);
  assert.equal(labels[0].label, "08-01");
  assert.equal(labels[labels.length - 1].label, "08-10");
  assert.ok(labels.length <= 8); // maxLabels 7 + 可能追加的末位
  // 单调递增且都在范围内
  for (const l of labels) {
    assert.ok(l.index >= 0 && l.index < 10);
  }
});

test("axisLabels：长跨度降为按月标注", () => {
  const days: string[] = [];
  const start = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < 120; i++)
    days.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const labels = axisLabels(days);
  // 1月/2月/3月/4月 四个月，全在（未超 maxLabels）
  assert.deepEqual(
    labels.map((l) => l.label),
    ["1月", "2月", "3月", "4月"],
  );
  // 每月标在该月第一个有数据的点上
  assert.equal(days[labels[1].index].slice(0, 7), "2026-02");
});

test("axisLabels：跨年时月份标签带年份", () => {
  const days: string[] = [];
  const start = Date.parse("2025-10-01T00:00:00Z");
  for (let i = 0; i < 120; i++)
    days.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const labels = axisLabels(days);
  assert.ok(labels[0].label.includes("年"));
  assert.equal(labels[0].label, "25年10月");
});

test("axisLabels：月份过多时抽稀到上限内", () => {
  const days: string[] = [];
  const start = Date.parse("2020-01-01T00:00:00Z");
  for (let i = 0; i < 800; i++)
    days.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const labels = axisLabels(days);
  assert.ok(labels.length <= 7);
});

test("axisLabels：空输入", () => {
  assert.deepEqual(axisLabels([]), []);
});
