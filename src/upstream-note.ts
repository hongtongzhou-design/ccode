/**
 * 渠道间版本差提示（check_agent_updates 的 upstreamNote）：
 * brew 渠道已最新但上游 npm 已更新时给组头小字文案；
 * 有 brew 更新可升（outdated）或查不到上游版本时不提示。
 */
export function upstreamNoteText(info: {
  latest: string | null;
  outdated: boolean;
  upstreamNote: string | null;
}): string | null {
  if (info.outdated || !info.latest || !info.upstreamNote) return null;
  return `brew 渠道最新；上游 npm 已到 ${info.upstreamNote}（渠道通常滞后）`;
}
