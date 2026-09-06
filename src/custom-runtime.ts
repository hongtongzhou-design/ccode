/** 自定义运行时工作目录解析（tests/custom-runtime.test.ts）。
 *  默认目录只在标签 cwd 为空或随手聊 scratch 时启用，不覆盖项目根/工作树。 */
import { isScratchCwd } from "./quick-chat.ts";

export function resolveCustomRuntimeCwd(
  tabCwd: string,
  defaultCwd: string | null | undefined,
  isWindows = false,
): string {
  const tab = tabCwd.trim();
  const fallback = defaultCwd?.trim() ?? "";
  if (!tab) return fallback;
  if (fallback && isScratchCwd(tab, isWindows)) return fallback;
  return tab;
}
