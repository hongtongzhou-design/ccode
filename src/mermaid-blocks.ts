/** CommonMark 围栏：开 fence 为 3+ 反引号或波浪号。 */
function fenceOpen(line: string): { ch: "`" | "~"; len: number; info: string } | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[2];
  const ch = marker[0] as "`" | "~";
  if (ch === "`" && marker.includes("`") && m[3].includes("`")) return null;
  return { ch, len: marker.length, info: m[3].trim() };
}

function fenceClose(line: string, ch: "`" | "~", len: number): boolean {
  const m = new RegExp(`^ {0,3}\\${ch}{${len},}[ \t]*$`).exec(line);
  return Boolean(m);
}

function isMermaidInfo(info: string): boolean {
  return /^mermaid(?:$|[\s{])/i.test(info.trim());
}

/** 文档是否含 mermaid 围栏（大小写不敏感，支持 mermaid{...} 属性后缀）。 */
export function hasMermaidFence(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const open = fenceOpen(lines[i] ?? "");
    if (!open) {
      i += 1;
      continue;
    }
    i += 1;
    while (i < lines.length && !fenceClose(lines[i] ?? "", open.ch, open.len)) {
      i += 1;
    }
    if (isMermaidInfo(open.info)) return true;
    i += 1;
  }
  return false;
}
