/**
 * 保存历史的白话翻译层（界面白话双层呈现：白话主文案，hash/分支名降为二级 mono）。
 * 纯逻辑，供 HistoryOverlay 渲染与 node --test 复用。
 *
 * 取舍：时间线只含当前分支 first-parent 主线——工作区分支上的过程提交不单独列出，
 * 它们的成果通过 merge commit（✓ 验收合并）体现，保持时间线简洁可读。
 */

import type { HistoryEntryDto } from "./types";

export type HistoryKind = "merge" | "auto" | "save";

export interface HistoryViewItem {
  kind: HistoryKind;
  /** 单色几何符号（✓/⚙/◔），不用彩色 emoji */
  icon: string;
  /** 白话主描述 */
  title: string;
  /** 文件数与增删摘要（无改动信息时为空串） */
  stats: string;
}

/** 工作区名 → 步骤名的映射（来自 project.toml 的 steps[].workspaceName → steps[].name） */
export type WsStepMap = Record<string, string>;

/** 「N 个文件 +x −y」；无改动信息（merge commit / 空提交）返回空串 */
function fileStats(entry: HistoryEntryDto): string {
  if (entry.files === 0) return "";
  return `${entry.files} 个文件 +${entry.additions} −${entry.deletions}`;
}

/** 单条提交 → 白话条目：验收合并 / 自动保存 / 保存 */
export function translateHistoryEntry(
  entry: HistoryEntryDto,
  wsSteps: WsStepMap,
): HistoryViewItem {
  if (entry.merge) {
    const branch = entry.mergedBranch;
    if (branch.startsWith("ccode/")) {
      const ws = branch.slice("ccode/".length);
      // 工作区名映射流水线步骤名；匹配不到（步骤已改名/删除）用工作区名
      return { kind: "merge", icon: "✓", title: `验收合并：${wsSteps[ws] ?? ws}`, stats: "" };
    }
    return {
      kind: "merge",
      icon: "✓",
      title: branch ? `合并：${branch}` : `合并：${entry.message}`,
      stats: "",
    };
  }
  if (entry.message.startsWith("Ccode:")) {
    // 后端自动提交（档案卡/gitignore 等）：去掉前缀与结尾的「（自动）提交」避免语义重复
    const rest = entry.message
      .slice("Ccode:".length)
      .trim()
      .replace(/(自动)?提交\s*$/, "")
      .trim();
    return { kind: "auto", icon: "⚙", title: `自动保存：${rest || "项目配置"}`, stats: fileStats(entry) };
  }
  return { kind: "save", icon: "◔", title: `保存：${entry.message}`, stats: fileStats(entry) };
}

export interface HistoryDayGroup<T> {
  /** 「今天」/「昨天」/「2026年8月6日」（本机时区） */
  label: string;
  entries: T[];
}

/** 本机时区的日期 key（yyyy-m-d），同一天归一组 */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 按本机日期分组：今天/昨天/具体日期；组内保持传入顺序（后端已按时间倒序） */
export function groupHistoryByDay<T extends { time: string }>(
  entries: T[],
  now: Date = new Date(),
): HistoryDayGroup<T>[] {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: HistoryDayGroup<T>[] = [];
  const byKey = new Map<string, HistoryDayGroup<T>>();
  for (const entry of entries) {
    const d = new Date(entry.time);
    const key = dayKey(d);
    let group = byKey.get(key);
    if (!group) {
      const label =
        key === today
          ? "今天"
          : key === yesterday
            ? "昨天"
            : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      group = { label, entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** 行内时间「HH:MM」（本机时区） */
export function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
