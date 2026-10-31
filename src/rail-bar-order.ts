/**
 * 侧栏底部资源段（连接 / 设置 / 技能 / MCP / 用量）的图标顺序（2026-10-31 用户：五个图标可拖动自定义排序；tests/rail-bar-order.test.ts）。
 * 一份顺序管两种侧栏：展开态前 RAIL_BAR_VISIBLE 个常显、其余收进悬停滑出的抽屉；图标态竖排五个。
 * 记本机（localStorage RAIL_BAR_ORDER_KEY，存 id 数组）。
 */

export const RAIL_BAR_ORDER_KEY = "ccode.railBarOrder";
export const RAIL_BAR_DEFAULT_ORDER: readonly string[] = ["profiles", "settings", "skills", "mcp", "stats"];
/** 展开态平时露在外面的个数，其余进抽屉 */
export const RAIL_BAR_VISIBLE = 2;

/** 存档读回：只认这几页、去重，存档里没有的（坏值 / 以后新加的页）按默认顺序补在后面 */
export function parseRailBarOrder(raw: string | null, ids: readonly string[] = RAIL_BAR_DEFAULT_ORDER): string[] {
  let saved: unknown = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  const out: string[] = [];
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === "string" && ids.includes(id) && !out.includes(id)) out.push(id);
    }
  }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** 把 from 位的挪到 to 位，其余顺移 */
export function moveRailBarItem(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
