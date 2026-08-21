/** 目录错误统一为可恢复的人话，底层 ENOENT 不直接暴露在工作树里。 */
export function directoryUnavailableMessage(path: string): string {
  return `目录不存在或已移动：${path}`;
}

export function directoryErrorMessage(error: unknown, path: string): string {
  if (isDirectoryUnavailableError(error)) return directoryUnavailableMessage(path);
  const text = String(error).replace(/^读取目录失败:\s*/u, "");
  return `目录不可用：${text}`;
}

export function isDirectoryUnavailableError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("no such file or directory") ||
    text.includes("目录不存在") ||
    text.includes("目录不可用") ||
    text.includes("not found")
  );
}
