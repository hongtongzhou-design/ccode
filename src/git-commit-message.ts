import type { GitFileDto } from "./types";

/** 空输入时使用本地规则即时生成，避免为一次提交额外启动 AI。 */
export function defaultCommitMessage(files: GitFileDto[]): string {
  const names = new Set(files.map((file) => file.path.replace(/\\/g, "/").split("/").pop() ?? ""));
  if (names.has("included.json") && (names.has("included.md") || names.has("to-fetch.md"))) {
    return "筛选判定：纳入与排除已写入清单";
  }
  if (files.length !== 1) return `chore: 更新 ${files.length} 个文件`;
  const file = files[0];
  if (file.status === "A" || file.status === "??") return `chore: 添加 ${file.path}`;
  if (file.status === "D") return `chore: 删除 ${file.path}`;
  if (file.status === "R") return `chore: 重命名 ${file.path}`;
  return `chore: 更新 ${file.path}`;
}
