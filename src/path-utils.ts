/**
 * 纯路径工具（无依赖，可直接被 node --test 单测）。
 * 跨平台注意：Windows 下各后端接口返回的路径分隔符不统一——
 * list_dir 经 read_dir 得到全 `\`，git_status_map 用 Path::join 拼出混合分隔符
 * （cwd 里的 `\` + porcelain 相对路径的 `/`），前端匹配前必须先归一。
 */

/** 统一路径分隔符为 /（只做等价规范化，不改变路径语义） */
export function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/** git 装饰表键归一：后端混合分隔符的键统一成 /，与归一后的 entry.path 同口径匹配 */
export function normalizeStatusKeys(
  map: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[normSep(key)] = value;
  return out;
}

/** 目录内是否有变更文件（文件夹装饰点）；gitMap 键须已用 normalizeStatusKeys 归一 */
export function hasChangedInside(
  gitMap: Record<string, string>,
  dirPath: string,
): boolean {
  const prefix = `${normSep(dirPath)}/`;
  return Object.keys(gitMap).some((p) => p.startsWith(prefix));
}

/** 上一级目录；已到文件系统根（或无法再上）时返回 null */
export function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null; // 形如 "~" 或 "C:"，无法再上
  if (idx === 0) return trimmed[0] === "/" ? "/" : null;
  // Windows 盘符：C:\foo（或 C:/foo）的上一级是盘符根 C:\（保留原分隔符）
  if (idx === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, idx);
}
