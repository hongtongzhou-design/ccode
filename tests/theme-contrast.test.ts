import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 主题令牌的结构性约束（design-system.md「主题令牌」「线条语言」）。
 * 这些规则以前只写在文档里，v3.85 因浅色主题浮起梯度塌陷（strip/inset/raised
 * 亮度差只有 1–4，整页发平、卡片看不见）而补成可执行断言。
 */
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

/** 感知亮度近似值：只用于「谁比谁浅」的排序与阶梯步进，不用于对比度判定 */
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 相对亮度：必须先把 sRGB 线性化，直接拿 0–255 加权会严重高估暗色、低算对比度 */
function relLum(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取某个主题块里的令牌值；@theme 默认块用 themeId=null */
function tokens(themeId: string | null): Record<string, string> {
  const src =
    themeId === null
      ? /@theme \{(.*?)\n\}/s.exec(css)?.[1]
      : new RegExp(`\\[data-theme="${themeId}"\\] \\{(.*?)\\n\\}`, "s").exec(
          css,
        )?.[1];
  assert.ok(src, `找不到主题块 ${themeId ?? "@theme"}`);
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g))
    out[m[1]] = m[2];
  return out;
}

const LIGHT_THEMES = [
  "midnight-light", "terracotta-light", "ayu-light", "mocha-light",
  "neutral-light", "dracula-light", "shadcn-light",
];

test("七套浅色主题都存在", () => {
  for (const id of LIGHT_THEMES) assert.ok(Object.keys(tokens(id)).length > 0);
});

test("浅色浮起梯度每一档都可分辨（canvas→strip→inset→raised 亮度差 ≥4）", () => {
  for (const id of LIGHT_THEMES) {
    const t = tokens(id);
    const ladder = ["canvas", "strip", "inset", "raised"];
    for (let i = 0; i < ladder.length - 1; i++) {
      const step = lum(t[ladder[i + 1]]) - lum(t[ladder[i]]);
      assert.ok(
        step >= 4,
        `${id}: ${ladder[i]}→${ladder[i + 1]} 只差 ${step.toFixed(1)}，梯度塌陷（页面会发平、卡片看不见）`,
      );
    }
  }
});

test("浅色浮起次序：rail < canvas < rail2 < strip < inset < raised", () => {
  for (const id of LIGHT_THEMES) {
    const t = tokens(id);
    const order = ["rail", "canvas", "rail2", "strip", "inset", "raised"];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        lum(t[order[i]]) < lum(t[order[i + 1]]),
        `${id}: ${order[i]} 不比 ${order[i + 1]} 暗，浮起方向反了`,
      );
    }
  }
});

test("浅色选中态与线条必须比所在底色深", () => {
  for (const id of LIGHT_THEMES) {
    const t = tokens(id);
    assert.ok(lum(t["rail-sel"]) < lum(t.rail), `${id}: 侧栏选中行不比侧栏深`);
    assert.ok(lum(t["seg-sel"]) < lum(t["rail-sel"]), `${id}: 分段选中不够深`);
    assert.ok(lum(t.hairline) < lum(t.canvas), `${id}: hairline 在 canvas 上看不见`);
    assert.ok(lum(t.field) < lum(t.hairline), `${id}: field 边不比 hairline 明显`);
    assert.ok(lum(t.bubble) < lum(t.canvas), `${id}: 消息气泡不比 canvas 深`);
  }
});

test("浅色状态语义色是浅底深字（pill 底比文字浅）", () => {
  const t = tokens("midnight-light"); // 语义色在 [data-theme$="-light"] 统一覆写，取任一浅色主题解析不到则回落
  const shared = /\[data-theme\$="-light"\] \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const get = (k: string) =>
    new RegExp(`--color-${k}:\\s*(#[0-9a-fA-F]{6})`).exec(shared)?.[1] ??
    t[k];
  for (const [bg, fg] of [
    ["ok", "ok-text"],
    ["err", "err-text"],
    ["warn", "warn-text"],
    ["diff-add-bg", "diff-add-fg"],
    ["diff-del-bg", "diff-del-fg"],
  ]) {
    const b = get(bg);
    const f = get(fg);
    assert.ok(b && f, `缺令牌 ${bg}/${fg}`);
    assert.ok(
      lum(b) > lum(f),
      `浅色 ${bg}(${b}) 应比 ${fg}(${f}) 浅——深底浅字只在深色主题成立`,
    );
    // 文字要读得出来：WCAG AA 正文档 4.5:1
    const ratio = contrast(b, f);
    assert.ok(ratio >= 4.5, `浅色 ${bg}/${fg} 对比度仅 ${ratio.toFixed(2)}:1`);
  }
});

test("开关令牌深浅都成立：滑块必须比轨道浅", () => {
  const dark = tokens(null);
  assert.ok(
    lum(dark["switch-knob"]) > lum(dark["switch-off"]),
    "深色：滑块不比轨道浅",
  );
  const shared = /\[data-theme\$="-light"\] \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const get = (k: string) =>
    new RegExp(`--color-${k}:\\s*(#[0-9a-fA-F]{6})`).exec(shared)![1];
  assert.ok(
    lum(get("switch-knob")) > lum(get("switch-off")),
    "浅色：滑块不比轨道浅",
  );
  // 轨道要能从页面底色里看出来（对比任一浅色主题的 canvas）
  for (const id of LIGHT_THEMES) {
    assert.ok(
      lum(tokens(id).canvas) - lum(get("switch-off")) >= 8,
      `${id}: 关闭态开关轨道与 canvas 太接近，开关会看不见`,
    );
  }
});

test("原生表单控件配色跟随主题，浅色下不被全局 dark 覆盖", () => {
  assert.match(
    css,
    /:root\s*\{[\s\S]*?color-scheme:\s*dark;/,
    "默认原生控件仍保持深色配色",
  );
  assert.match(
    css,
    /\[data-platform="windows"\]\[data-theme\$="-light"\]\s*\{\s*color-scheme:\s*light;/,
    "Windows 浅色主题必须覆盖为 light color-scheme",
  );
  assert.doesNotMatch(
    css,
    /:root:not\(\[data-theme\$="-light"\]\)/,
    "不要通过改变根节点选择器影响 macOS/Linux 的其它主题变量",
  );
});

/** 取平台覆写块里的令牌值：[data-platform="mac"][data-theme="id"] { ... } */
function platformTokens(
  platform: string,
  themeId: string,
): Record<string, string> {
  const src = new RegExp(
    `\\[data-platform="${platform}"\\]\\[data-theme="${themeId}"\\] \\{(.*?)\\n\\}`,
    "s",
  ).exec(css)?.[1];
  assert.ok(src, `找不到平台覆写块 ${platform}/${themeId}`);
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g))
    out[m[1]] = m[2];
  return out;
}

test("macOS 浅色中间档：l3 过 AA 正文线、l4 过 AA 大字线", () => {
  for (const id of LIGHT_THEMES) {
    const base = tokens(id);
    const mac = platformTokens("mac", id);
    const win = platformTokens("windows", id);
    // 中间档必须落在「原值 < mac < Windows 值」的压深方向上
    for (const k of ["l3", "l4"]) {
      assert.ok(
        lum(mac[k]) < lum(base[k]) && lum(mac[k]) > lum(win[k]),
        `${id}: mac ${k} 不在原值与 Windows 值之间`,
      );
    }
    // l3 ≥ 4.5:1（WCAG AA 正文）；l4 ≥ 3:1（AA 大字线，最浅辅助档的设计底线）
    const c3 = contrast(mac.l3, base.canvas);
    const c4 = contrast(mac.l4, base.canvas);
    assert.ok(c3 >= 4.5, `${id}: mac l3/canvas 对比度仅 ${c3.toFixed(2)}:1`);
    assert.ok(c4 >= 3.0, `${id}: mac l4/canvas 对比度仅 ${c4.toFixed(2)}:1`);
  }
});
