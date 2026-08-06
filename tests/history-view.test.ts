import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTimeOfDay,
  groupHistoryByDay,
  translateHistoryEntry,
} from "../src/history-view.ts";
import type { HistoryEntryDto } from "../src/types.ts";

function entry(partial: Partial<HistoryEntryDto>): HistoryEntryDto {
  return {
    hash: "abc1234",
    time: "2026-08-06T10:30:00+08:00",
    author: "t",
    message: "一些改动",
    files: 0,
    additions: 0,
    deletions: 0,
    merge: false,
    mergedBranch: "",
    ...partial,
  };
}

test("ccode 工作区 merge commit → 验收合并：步骤名优先，匹配不到用工作区名", () => {
  const steps = { "lit-notes": "文献笔记" };
  assert.deepEqual(
    translateHistoryEntry(
      entry({ merge: true, mergedBranch: "ccode/lit-notes", message: "Merge branch 'ccode/lit-notes'" }),
      steps,
    ),
    { kind: "merge", icon: "✓", title: "验收合并：文献笔记", stats: "" },
  );
  // 步骤改名/删除后匹配不到：回落工作区名
  assert.equal(
    translateHistoryEntry(
      entry({ merge: true, mergedBranch: "ccode/old-ws", message: "Merge branch 'ccode/old-ws'" }),
      steps,
    ).title,
    "验收合并：old-ws",
  );
});

test("非 ccode 分支的 merge → 合并：分支名；解析不到分支名回落提交信息", () => {
  assert.equal(
    translateHistoryEntry(
      entry({ merge: true, mergedBranch: "feature-x", message: "Merge branch 'feature-x'" }),
      {},
    ).title,
    "合并：feature-x",
  );
  assert.equal(
    translateHistoryEntry(
      entry({ merge: true, mergedBranch: "", message: "合并上游改动" }),
      {},
    ).title,
    "合并：合并上游改动",
  );
});

test("Ccode: 前缀 → 自动保存：去掉结尾「（自动）提交」避免语义重复", () => {
  const item = translateHistoryEntry(
    entry({
      message: "Ccode: 项目档案卡与 gitignore 自动提交",
      files: 2,
      additions: 5,
      deletions: 0,
    }),
    {},
  );
  assert.equal(item.kind, "auto");
  assert.equal(item.icon, "⚙");
  assert.equal(item.title, "自动保存：项目档案卡与 gitignore");
  assert.equal(item.stats, "2 个文件 +5 −0");
  // 去掉前缀后为空 → 兜底文案
  assert.equal(
    translateHistoryEntry(entry({ message: "Ccode: 提交" }), {}).title,
    "自动保存：项目配置",
  );
});

test("普通提交 → 保存：提交信息首行 + 文件摘要；零文件时省略摘要", () => {
  const withStats = translateHistoryEntry(
    entry({ message: "补充实验数据", files: 3, additions: 120, deletions: 8 }),
    {},
  );
  assert.deepEqual(withStats, {
    kind: "save",
    icon: "◔",
    title: "保存：补充实验数据",
    stats: "3 个文件 +120 −8",
  });
  assert.equal(
    translateHistoryEntry(entry({ message: "空提交", files: 0 }), {}).stats,
    "",
  );
});

test("按本机日期分组：今天/昨天/具体日期，组内保持倒序", () => {
  const now = new Date(2026, 7, 6, 15, 0, 0); // 本机时区 2026-08-06 15:00
  const entries = [
    { time: new Date(2026, 7, 6, 10, 0).toISOString() },
    { time: new Date(2026, 7, 6, 9, 0).toISOString() },
    { time: new Date(2026, 7, 5, 22, 0).toISOString() },
    { time: new Date(2026, 6, 30, 8, 0).toISOString() },
  ];
  const groups = groupHistoryByDay(entries, now);
  assert.deepEqual(
    groups.map((g) => [g.label, g.entries.length]),
    [
      ["今天", 2],
      ["昨天", 1],
      ["2026年7月30日", 1],
    ],
  );
  // 跨天前后顺序不打乱
  assert.equal(groups[0].entries[0], entries[0]);
});

test("行内时间格式 HH:MM", () => {
  const iso = new Date(2026, 7, 6, 9, 5).toISOString();
  assert.equal(formatTimeOfDay(iso), "09:05");
});
