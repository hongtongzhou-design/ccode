import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TERMINAL_FONT,
  MONO_FALLBACK_STACK,
  TERMINAL_FONT_CHOICES,
  isKnownTerminalFont,
  normalizeTerminalFontFamily,
  terminalFontStack,
} from "../src/terminal-font.ts";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

/** App.css 里 `--font-mono` 的值（空白归一后用于逐字比对） */
function cssMonoStack(): string {
  const m = /--font-mono:\s*([^;]+);/.exec(css);
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

test("兜底回退链与 App.css 的 --font-mono 逐字一致（单一出处不许漂移）", () => {
  assert.equal(MONO_FALLBACK_STACK, cssMonoStack());
});

test("回退链里 ui-monospace 排在 Menlo 之前（macOS 才拿得到 SF Mono）", () => {
  const stack = MONO_FALLBACK_STACK;
  assert.ok(stack.includes("ui-monospace"), "缺 ui-monospace");
  assert.ok(
    stack.indexOf("ui-monospace") < stack.indexOf("Menlo"),
    "Menlo 排在 ui-monospace 之前会让网页永远落 Menlo",
  );
  assert.ok(stack.trimEnd().endsWith("monospace"), "通用族兜底必须在末位");
});

test("已选族名排最前，其余走共享回退链", () => {
  const stack = terminalFontStack("Maple Mono NF CN");
  assert.ok(stack.startsWith("'Maple Mono NF CN', "));
  assert.ok(stack.includes("ui-monospace"));
  assert.ok(stack.includes("Microsoft YaHei"));
});

test("未选/空白/仅引号都落默认字体", () => {
  for (const v of [undefined, null, "", "   ", "''"]) {
    assert.equal(
      terminalFontStack(v),
      terminalFontStack(DEFAULT_TERMINAL_FONT),
    );
    assert.ok(terminalFontStack(v).startsWith(`'${DEFAULT_TERMINAL_FONT}'`));
  }
});

test("族名与回退链重复时只保留链首那一份，通用族 monospace 不被去掉", () => {
  const stack = terminalFontStack("JetBrains Mono");
  assert.equal(
    stack.split("JetBrains Mono").length - 1,
    1,
    "JetBrains Mono 在链里出现了两次",
  );
  assert.ok(stack.trimEnd().endsWith("monospace"));
  // 选了 Menlo 时链里的 Menlo 同样只留链首
  const menlo = terminalFontStack("Menlo");
  assert.equal(menlo.split("Menlo").length - 1, 1);
});

test("自定义族名里的引号被剥掉，不破坏 CSS 串", () => {
  const stack = terminalFontStack(`Fira "Code"`);
  assert.ok(stack.startsWith("'Fira Code', "));
  assert.equal(stack.split("'").length - 1, 2, "只允许链首一对引号");
});

test("归一函数空值回落默认字体", () => {
  assert.equal(normalizeTerminalFontFamily("  Menlo  "), "Menlo");
  assert.equal(normalizeTerminalFontFamily(undefined), DEFAULT_TERMINAL_FONT);
});

test("字体选项表：值唯一、含 mac 系统等宽、与已知判定一致", () => {
  const values = TERMINAL_FONT_CHOICES.map((c) => c.value);
  assert.equal(new Set(values).size, values.length, "字体 value 有重复");
  assert.ok(values.includes("ui-monospace"));
  assert.ok(values.includes(DEFAULT_TERMINAL_FONT));
  for (const c of TERMINAL_FONT_CHOICES) {
    assert.ok(c.label.trim().length > 0, `${c.value} 缺 label`);
    assert.ok(isKnownTerminalFont(c.value));
  }
  assert.equal(isKnownTerminalFont("Fira Code"), false);
  assert.equal(isKnownTerminalFont(undefined), false);
});