import { statusGroupKey } from "./git-status-groups.ts";
import type { GitFileDto } from "./types.ts";

/** 一键「存进历史」不能处理冲突/空列表；应改走改动面板。 */
export function historySaveBlockedReason(
  files: readonly GitFileDto[],
  merging = false,
): string | null {
  if (merging) return "正在合并，请打开改动处理后再存";
  if (files.length === 0) return "没有可存入历史的改动";
  if (files.some((file) => statusGroupKey(file.status) === "unmerged")) {
    return "有冲突文件，请打开改动处理后再存";
  }
  return null;
}

/** 科研步骤卡一键保存用的白话说明；不走 chore: 前缀。 */
export function historySaveMessage(
  stepName: string | null | undefined,
  files: readonly GitFileDto[],
): string {
  const n = files.length;
  const step = stepName?.trim() ?? "";
  if (step) return n <= 1 ? step : `${step}（${n} 处）`;
  if (n === 1) return files[0]?.path?.trim() || "1 处改动";
  return `${n} 处改动`;
}

export function historySavePaths(files: readonly GitFileDto[]): string[] {
  return files.map((file) => file.path).filter((path) => path.trim());
}
