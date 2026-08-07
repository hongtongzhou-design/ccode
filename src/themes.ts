/** 七套深色主题清单（设置页色卡与 ⌘K 命令面板共用，单一出处） */
export const THEMES = [
  { id: "midnight", name: "沉浸黑" },
  { id: "terracotta", name: "陶土" },
  { id: "ayu", name: "Ayu 琥珀" },
  { id: "mocha", name: "Catppuccin" },
  { id: "neutral", name: "极简灰蓝" },
  { id: "dracula", name: "Dracula" },
  { id: "shadcn", name: "灰蓝正红" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
