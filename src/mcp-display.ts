/** MCP 页展示纯逻辑：协议徽章固定识别色 + 命令/路径智能缩略。
 *  颜色固定 hex（同 file-icons / agent-colors 先例：识别色不随主题换色相），
 *  底色走 color-mix 10% 混合，深浅主题自动跟随。 */

/** 协议类型徽章：stdio 紫 / remote 蓝（传输层架构一眼可辨） */
export function mcpKindBadgeStyle(kind: string): {
  color: string;
  background: string;
} {
  const c = kind === "remote" ? "#4f8ef7" : "#9a6ef3";
  return {
    color: c,
    background: `color-mix(in srgb, ${c} 10%, transparent)`,
  };
}

/** 单个 token 的路径缩略：家目录前缀折成 ~，段数 >3 且折后仍 >28 字符才砍中段留首尾
 *  （短路径如 /opt/homebrew/bin/node、~/.bun/bin/bun 原样保留——缩了反而丢信息）。
 *  非路径形态（无分隔符、URL、短相对名）原样返回。 */
export function shortenPathToken(token: string): string {
  // URL 不缩（:// 会被路径分段逻辑切碎）
  if (token.includes("://")) return token;
  // 统一分隔符（Windows 反斜杠）再判断
  let t = token.replace(/\\/g, "/");
  // 家目录前缀折叠：macOS / Linux / Windows 三形态
  t = t
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\/Users\/[^/]+/i, "~");
  if (!t.includes("/")) return token;
  const leadingSlash = t.startsWith("/");
  const segs = t.split("/").filter(Boolean);
  if (segs.length <= 3 || t.length <= 28) return t;
  const head = segs[0];
  const tail = segs[segs.length - 1];
  return `${leadingSlash ? "/" : ""}${head}/…/${tail}`;
}

/** 完整启动命令的展示缩略：逐 token（空格分隔）缩略路径形态 token，普通参数原样。
 *  展示用；完整命令始终在悬浮提示里给全文 */
export function shortenCommand(command: string, args: string[]): string {
  const raw = [command, ...args].filter((s) => s.length > 0);
  return raw.map(shortenPathToken).join(" ");
}
