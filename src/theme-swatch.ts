/** 设置页主题色卡预览色：左栏 / 画布 / 强调 / 标题字。
 *  色值只从 App.css 的 @theme 与行首 `[data-theme]` 块读取，禁止临时改 :root
 *  的 data-theme 再 getComputedStyle——十四套各逼一次整页回流，初次进设置会卡一下。 */

export type ThemeSwatch = {
  rail: string;
  canvas: string;
  accent: string;
  ink: string;
};

export const EMPTY_THEME_SWATCH: ThemeSwatch = {
  rail: "transparent",
  canvas: "transparent",
  accent: "transparent",
  ink: "inherit",
};

function swatchFromBody(body: string | undefined): ThemeSwatch | null {
  if (!body) return null;
  const grab = (token: string) => {
    const m = body.match(
      new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`),
    );
    return m?.[1] ?? "";
  };
  const rail = grab("rail");
  const canvas = grab("canvas");
  const accent = grab("cta");
  const ink = grab("l1");
  if (!rail || !canvas || !accent || !ink) return null;
  return { rail, canvas, accent, ink };
}

/** 从 App.css 源文本抽十四套预览色。沉浸黑在 `@theme`，其余在行首 `[data-theme="id"]`。
 *  不收 `[data-platform][data-theme]` 平台覆写，也不收 `[data-theme$="-light"]` 共享段。 */
export function parseThemeSwatchesFromCss(
  css: string,
): Record<string, ThemeSwatch> {
  const out: Record<string, ThemeSwatch> = {};
  const midnight = swatchFromBody(/@theme\s*\{(.*?)\n\}/s.exec(css)?.[1]);
  if (midnight) out.midnight = midnight;
  const re = /(?:^|\n)\[data-theme="([^"]+)"\]\s*\{([^]*?)\n\}/g;
  for (const m of css.matchAll(re)) {
    const sw = swatchFromBody(m[2]);
    if (sw) out[m[1]] = sw;
  }
  return out;
}

export function themeSwatchFor(
  id: string,
  colors: Record<string, ThemeSwatch>,
): ThemeSwatch {
  return colors[id] ?? EMPTY_THEME_SWATCH;
}
