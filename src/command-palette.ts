/**
 * ⌘K 命令面板的过滤纯逻辑：与 DOM 解耦，node --test 直接单测。
 * 命令清单（页面/主题/侧栏显隐 + 各自动作）由 App.tsx 组装后传入。
 */

export interface PaletteCommand {
  id: string;
  /** 主标题（列表行主显） */
  title: string;
  /** 右侧弱化提示（如快捷键 ⌘1） */
  hint?: string;
  /** 面板中的低权重分组标题；不参与过滤语义。 */
  group?: string;
  /** 额外匹配词（英文别名、拼音等），大小写不敏感子串匹配 */
  keywords: string[];
}

/**
 * 命令过滤：空查询原样返回（面板打开时的全量列表）；
 * 非空时 title 或任一 keywords 命中查询子串（大小写不敏感）即保留，保持原顺序。
 */
export function filterCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}
