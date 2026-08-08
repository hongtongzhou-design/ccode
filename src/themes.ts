/** 主题清单（设置页色卡与 ⌘K 命令面板共用，单一出处）。
 *  七套深色 + 七套同名浅色（light 标记），浅色在设置页排在对应深色正下方。 */
export const THEMES = [
  { id: "midnight", name: "沉浸黑" },
  { id: "terracotta", name: "陶土" },
  { id: "ayu", name: "Ayu 琥珀" },
  { id: "mocha", name: "Catppuccin" },
  { id: "neutral", name: "极简灰蓝" },
  { id: "dracula", name: "Dracula" },
  { id: "shadcn", name: "灰蓝正红" },
  { id: "midnight-light", name: "沉浸黑 · 浅", light: true },
  { id: "terracotta-light", name: "陶土 · 浅", light: true },
  { id: "ayu-light", name: "Ayu 琥珀 · 浅", light: true },
  { id: "mocha-light", name: "Latte · 浅", light: true },
  { id: "neutral-light", name: "极简灰蓝 · 浅", light: true },
  { id: "dracula-light", name: "Dracula · 浅", light: true },
  { id: "shadcn-light", name: "灰蓝正红 · 浅", light: true },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
