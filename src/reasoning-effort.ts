/** 网关思考档：逗号多选，`@` 后是开场默认。单词旧值视为只开这一档。 */

const KNOWN = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
  "on",
  "off",
]);

export function parseReasoningEffort(raw: string | null | undefined): {
  levels: string[];
  launch: string | null;
} {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { levels: [], launch: null };
  const at = trimmed.lastIndexOf("@");
  const list = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const marked = at >= 0 ? trimmed.slice(at + 1).trim().toLowerCase() : null;
  const levels: string[] = [];
  for (const part of list.split(",")) {
    const level = part.trim().toLowerCase();
    if (!KNOWN.has(level) || levels.includes(level)) continue;
    levels.push(level);
  }
  if (!levels.length) return { levels: [], launch: null };
  const launch = marked && levels.includes(marked) ? marked : levels[0];
  return { levels, launch };
}

export function reasoningEffortValue(levels: string[], launch: string | null): string | null {
  const unique = levels.filter((level, index) => KNOWN.has(level) && levels.indexOf(level) === index);
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0];
  const start = launch && unique.includes(launch) ? launch : unique[0];
  return `${unique.join(",")}@${start}`;
}
