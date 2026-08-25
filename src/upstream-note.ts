/**
 * 渠道间版本差提示（check_agent_updates 的 upstreamNote / upstreamPackage）：
 * brew 渠道已最新但上游 npm 已更新时，组头版本区给一枚 ⧉ 图标钮——tooltip 说明 +
 * 点击复制 npm 渠道切换命令（不常驻文字占位，见 ProfilesPage 组头）；
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

/** 提示配套的渠道切换命令（后端拼好的一体命令优先；无则按 npm 包名兜底；都没有则 null） */
export function upstreamCommand(info: {
  outdated: boolean;
  upstreamCommand?: string | null;
  upstreamPackage?: string | null;
}): string | null {
  if (info.outdated) return null;
  if (info.upstreamCommand) return info.upstreamCommand;
  if (!info.upstreamPackage) return null;
  return `npm i -g ${info.upstreamPackage}@latest`;
}
