/* 聊天层阅读体验：字号档 / 字体 / 行内代码强调色 / 滚动条。
   各表必须与 src-tauri/src/settings.rs 的 KNOWN_CHAT_* 一致——那边是存真值的白名单，
   不在表里的值会被静默落回默认，前端加选项而 Rust 没跟上就是「选了没反应」。

   只写成壳上的 CSS 变量 / data 属性，真正的样子留在 App.css（深浅两套强调色在那边按主题分）；
   JS 不持有颜色。「标准 / 系统」两档不写变量，保证没调过的人和改版前同一个样子。 */

export const CHAT_FONT_SIZES = ["small", "normal", "large", "xlarge"] as const;
export type ChatFontSize = (typeof CHAT_FONT_SIZES)[number];

/** sans（现代黑体）只在 Windows 的设置页列出：Mac 的系统档本来就是苹方，不需要（2026-10-31） */
export const CHAT_FONT_FAMILIES = ["system", "serif", "kai", "mono", "sans"] as const;
export type ChatFontFamily = (typeof CHAT_FONT_FAMILIES)[number];

export const CHAT_ACCENTS = ["off", "warm", "amber", "teal", "violet"] as const;
export type ChatAccent = (typeof CHAT_ACCENTS)[number];

export const CHAT_SCROLLBARS = ["auto", "always"] as const;
export type ChatScrollbar = (typeof CHAT_SCROLLBARS)[number];

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = "normal";
export const DEFAULT_CHAT_FONT_FAMILY: ChatFontFamily = "system";
export const DEFAULT_CHAT_ACCENT: ChatAccent = "warm";
export const DEFAULT_CHAT_SCROLLBAR: ChatScrollbar = "auto";

function pick<T extends string>(
  table: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return table.includes(value as T) ? (value as T) : fallback;
}

export const normalizeChatFontSize = (v: unknown) =>
  pick(CHAT_FONT_SIZES, v, DEFAULT_CHAT_FONT_SIZE);
export const normalizeChatFontFamily = (v: unknown) =>
  pick(CHAT_FONT_FAMILIES, v, DEFAULT_CHAT_FONT_FAMILY);
export const normalizeChatAccent = (v: unknown) =>
  pick(CHAT_ACCENTS, v, DEFAULT_CHAT_ACCENT);
export const normalizeChatScrollbar = (v: unknown) =>
  pick(CHAT_SCROLLBARS, v, DEFAULT_CHAT_SCROLLBAR);

/** 字号档 → 正文像素。标准档返回 null = 不写变量，沿用 --chat-base（14px，2026-10-28 起 Mac 与 Windows 同）。
 *  Windows 取整数像素（半像素在 DirectWrite 下发糊，2026-10-31）；Mac 照旧 */
export function chatFontSizePx(v: unknown, isWindows = false): number | null {
  switch (normalizeChatFontSize(v)) {
    case "small":
      return isWindows ? 13 : 12.5;
    case "large":
      return isWindows ? 16 : 15.5;
    case "xlarge":
      return isWindows ? 18 : 17.5;
    default:
      return null;
  }
}

/** 字体 → font-family 栈。系统档返回 null = 继承全局栈。
   中文字体不随包（一套几十 MB）：按「装了就用、没装落下一个」排，每条链最后都有系统预装的那一个。
   衬线：思源宋体 → 宋体-简 / 宋体，西文跟着中文字体走。中文衬线排在 Georgia 前面：混排时汉字不会掉回黑体。
   不用 ui-serif 取 New York：WKWebView 里它会把汉字整段换成苹方、后面的宋体全失效；按名字或 @font-face local()
   也取不到 New York（2026-11-01 真 WKWebView 实测）。
   楷体：霞鹜文楷（屏幕版在前）→ Mac 楷体-简（随系统预装）→ Windows 楷体；文楷自带西文，没装时西文跟楷体走。
   等宽栈直接复用 App.css 的 --font-mono（JetBrains Mono + CJK 兜底）。
   Windows 两处不同（2026-10-31）：衬线不落宋体（SimSun 在屏幕正文字号下又细又虚），没装思源宋体时
   汉字回落微软雅黑、西文仍是 Georgia；现代黑体按「装了就用」排 HarmonyOS Sans → MiSans → 思源黑体 → 等线，
   中文黑体放在 Segoe 前面，让西文也用同一款的字形，都没装落回系统档那套（Segoe UI + 微软雅黑 UI）。 */
export function chatFontFamilyStack(v: unknown, isWindows = false): string | null {
  switch (normalizeChatFontFamily(v)) {
    case "serif":
      return isWindows
        ? `"Source Han Serif SC", "Noto Serif SC", "思源宋体", Georgia, "Times New Roman", "Microsoft YaHei UI", "Microsoft YaHei", serif`
        : `"Source Han Serif SC", "Source Han Serif SC VF", "Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", Georgia, "Times New Roman", serif`;
    case "kai":
      return `"LXGW WenKai Screen", "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "楷体", serif`;
    case "mono":
      return "var(--font-mono)";
    case "sans":
      return isWindows
        ? `"HarmonyOS Sans SC", "MiSans", "MiSans VF", "Source Han Sans SC", "Noto Sans SC", "Noto Sans CJK SC", "思源黑体", "DengXian", "等线", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`
        : null;
    default:
      return null;
  }
}

/** 壳上要写的内联变量：只含「不是默认」的那几个，没调过时返回空对象 */
export function chatStyleVars(
  settings: {
    chatFontSize?: unknown;
    chatFontFamily?: unknown;
  },
  isWindows = false,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const px = chatFontSizePx(settings.chatFontSize, isWindows);
  if (px !== null) vars["--ccode-chat-fs"] = `${px}px`;
  const ff = chatFontFamilyStack(settings.chatFontFamily, isWindows);
  if (ff !== null) vars["--ccode-chat-ff"] = ff;
  return vars;
}

export const CHAT_FONT_SIZE_LABEL: Record<ChatFontSize, string> = {
  small: "小",
  normal: "标准",
  large: "大",
  xlarge: "特大",
};
export const CHAT_FONT_FAMILY_LABEL: Record<ChatFontFamily, string> = {
  system: "系统",
  serif: "衬线",
  kai: "楷体",
  mono: "等宽",
  sans: "现代黑体",
};
export const CHAT_ACCENT_LABEL: Record<ChatAccent, string> = {
  off: "墨色",
  warm: "陶红",
  amber: "琥珀",
  teal: "青绿",
  violet: "紫",
};
export const CHAT_SCROLLBAR_LABEL: Record<ChatScrollbar, string> = {
  auto: "闲置淡出",
  always: "常显",
};
