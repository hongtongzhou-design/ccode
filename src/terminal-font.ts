/**
 * 终端字体族单一出处：设置页字体下拉与 xterm 建链都从这里取，禁止页面各自拼字体串。
 *
 * 为什么要整条回退链：xterm 的 `fontFamily` 就是一段 CSS 字体列表——用户选的族名排最前，
 * 后面接应用等宽回退链（App.css `--font-mono`，与全局 `font-mono` 工具类同一出处）。
 * TerminalPage 里曾另拼过一份缺 `ui-monospace` 的串，与 App.css 漂移，见下条。
 *
 * macOS 的坑（2026-09-21 实测）：公开家族名 `SF Mono` 在 macOS 上并不存在——
 * `/System/Library/Fonts/SFNSMono.ttf` 的 family 是私有名 `.SF NS Mono`（name 表实测），
 * native 程序（Terminal.app 等）靠 CoreText 的「系统等宽 UI 字体」拿到它，网页侧
 * 只有 CSS 关键字 `ui-monospace` 才映射到同一支。回退链若把 Menlo 排在 ui-monospace
 * 之前，网页永远落 Menlo（同一字号下笔画更细、密实度更差）。故 ui-monospace 必须在 Menlo 之前；
 * 但**它不是 Ghostty 的默认字体**——Ghostty 空配置默认 `font-family = JetBrains Mono, font-size = 13`，
 * 而该字体本机未系统安装、只由 Ghostty 自带。要与 Ghostty 对齐观感，选本文件打包的 JetBrains Mono，
 * 不是 ui-monospace。
 *
 * 实测数据（13px，Safari/WKWebView，真实加载 webfont）：`JetBrains Mono` advance = narrow = 7.8
 * （真等宽）；`ui-monospace` 8.0361（真等宽，SF Mono）；`Menlo` 7.8267。窄字与宽字步进相等才算拿到
 * 等宽字体，若窄字远小于宽字（如 3.61 vs 10.11）说明该族名不存在、已回退到比例字体。
 */

/** 默认终端字体（打包进应用的 JetBrains Mono，见 App.css @font-face） */
export const DEFAULT_TERMINAL_FONT = "JetBrains Mono";

/** 应用等宽回退链兜底字面量：正常路径读 App.css 的 `--font-mono`（monoFallbackStack()），
 *  此串只在没有 DOM（测试/非浏览器）或变量读空时使用；测试比对两处一致，防漂移。 */
export const MONO_FALLBACK_STACK =
  '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "Microsoft YaHei", monospace';

/** 终端字体下拉选项（value = CSS 族名，label = 设置页文案）。加字体 = 加一条。
 *  `ui-monospace` 是 macOS 上唯一能拿到系统等宽 SF Mono 的写法（不含 Ghostty——Ghostty 默认
 *  自带 JetBrains Mono）；`SF Mono` 族名需用户自行装 Apple 的字体包才存在，故标注清楚，
 *  不让它冒充「系统自带」。 */
export const TERMINAL_FONT_CHOICES = [
  { value: "JetBrains Mono", label: "JetBrains Mono（内置，与 Ghostty 默认同款）" },
  { value: "ui-monospace", label: "系统等宽（macOS 即 SF Mono）" },
  { value: "Maple Mono NF CN", label: "Maple Mono NF CN（中文+Nerd Font）" },
  { value: "Sarasa Mono SC", label: "Sarasa Mono SC（中文）" },
  { value: "Iosevka", label: "Iosevka" },
  { value: "SF Mono", label: "SF Mono（需自行安装）" },
  { value: "Menlo", label: "Menlo（macOS）" },
  { value: "Consolas", label: "Consolas" },
] as const;

/** 设置页用：这条记录是否就是下拉里的某一项（否则进「自定义…」态） */
export function isKnownTerminalFont(value?: string | null): boolean {
  const v = (value ?? "").trim();
  return TERMINAL_FONT_CHOICES.some((c) => c.value === v);
}

/** 族名归一：去首尾空白与引号（用户自定义输入可能带引号，拼进 CSS 串会破链） */
export function normalizeTerminalFontFamily(family?: string | null): string {
  const v = (family ?? "").replace(/["']/g, "").trim();
  return v || DEFAULT_TERMINAL_FONT;
}

/** 取回退链：优先读 App.css 的 `--font-mono`（与全局等宽同一出处），读不到用字面量。
 *  读 CSS 变量而非写死第二份串，是为了字体链只改一处就全局生效（见 App.css @theme 注释）。 */
export function monoFallbackStack(): string {
  if (typeof document === "undefined") return MONO_FALLBACK_STACK;
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim();
    return v || MONO_FALLBACK_STACK;
  } catch {
    return MONO_FALLBACK_STACK;
  }
}

/** 把回退链里与已选族名重复的条目去掉（选了 JetBrains Mono 时链首不再出现两次），
 *  末位通用族 `monospace` 永不去掉——它是 Windows 落位图字体前的最后一道兜底。 */
function dropDuplicate(stack: string, chosen: string): string {
  const key = chosen.toLowerCase();
  return stack
    .split(",")
    .map((s) => s.trim())
    .filter((part) => {
      const name = part.replace(/["']/g, "").trim().toLowerCase();
      if (!name) return false;
      if (name === "monospace") return true;
      return name !== key;
    })
    .join(", ");
}

/** 生成 xterm 的 fontFamily：已选族名排最前，其余走共享回退链 */
export function terminalFontStack(
  family?: string | null,
  fallbackStack: string = MONO_FALLBACK_STACK,
): string {
  const chosen = normalizeTerminalFontFamily(family);
  return `'${chosen}', ${dropDuplicate(fallbackStack, chosen)}`;
}