/**
 * git 状态的分组与白话文案（界面白话化：白话主展示，字母徽标降为二级 mono + 悬浮中文）。
 * 纯逻辑，供改动面板分组渲染与徽标悬浮 title 复用。
 */

export type StatusGroupKey = "modified" | "added" | "deleted";

/** 中文组名（改动面板文件列表的分组标题） */
export const STATUS_GROUP_LABEL: Record<StatusGroupKey, string> = {
  modified: "修改的",
  added: "新增的",
  deleted: "删除的",
};

/** 状态字母 → 白话说明（徽标悬浮 title 用「字母 · 白话」双层呈现） */
export const STATUS_WORD: Record<string, string> = {
  M: "已修改",
  A: "新文件（待提交）",
  "??": "新文件",
  D: "已删除",
  R: "已重命名",
};

/** 徽标悬浮 title：保留字母供程序员扫读，附白话说明 */
export function statusBadgeTitle(status: string): string {
  return `${status} · ${STATUS_WORD[status] ?? status}`;
}

/** 状态字母归入三组之一；M/R 及未知状态兜底进「修改的」 */
export function statusGroupKey(status: string): StatusGroupKey {
  if (status === "A" || status === "??") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

export interface StatusGroup<T> {
  key: StatusGroupKey;
  label: string;
  files: T[];
}

/** 按状态分组，组内保持原顺序，组序固定为 修改 → 新增 → 删除，空组不返回 */
export function groupFilesByStatus<T extends { status: string }>(
  files: T[],
): StatusGroup<T>[] {
  const buckets = new Map<StatusGroupKey, T[]>();
  for (const file of files) {
    const key = statusGroupKey(file.status);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(file);
    else buckets.set(key, [file]);
  }
  const order: StatusGroupKey[] = ["modified", "added", "deleted"];
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({
      key,
      label: STATUS_GROUP_LABEL[key],
      files: buckets.get(key)!,
    }));
}
