import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * z 轴台账的可执行闸门。
 *
 * design-system.md 的「弹层规格台账」早就写着「新弹层按档入座，禁造新档」，
 * 但它只是一句话——盘点时源码里躺着 13 种写法、120 处，其中 z-39/44 两个外壳档
 * 连文档都没提过，`z-[N]` 与 `z-N` 两种拼法并存（同一个 1 同时写作 z-1 和 z-[1]）。
 * 文档没人守着，测试有人守着，所以把台账搬进测试（同 tests/token-lint.test.ts 的思路）。
 *
 * 这里冻结的是**已入座的值**，不是「只准用这几个数字」——值本身是有理由的，
 * 每个都在下面标了用途。改这份清单意味着动层叠语义，必须同时改文档。
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const CSS = fileURLToPath(new URL("../src/App.css", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);

/**
 * 全局档：参与整窗排序，加新值就是「造新档」，必须走文档评审。
 *  20  sticky 页头（基准）
 *  40  页面模态——必须压过页头，用 z-10 会被页头白底戳穿遮罩
 *  50  右键菜单 / 命令面板 / 下拉
 *  60  评审内弹层
 *  70  确认框（ConfirmDialog）
 *  100 顶栏档：toast 区与「待确认跳转提醒条」——结果回执，要在确认框未处理时也可见
 *  39/44 外壳档：标题栏与导航岛哨兵，与岛自身（z-1）同层叠上下文
 */
const GLOBAL = new Set([20, 39, 40, 44, 50, 60, 70, 100]);

/**
 * 局部档：只在 `relative`/`sticky`/`absolute` 父级内自层叠，不参与整窗排序。
 * 加新值不算造新档——步进器里多一列、表格多一个粘性列都会新增数值。
 *  1   导航岛本体；评审栏 sticky 首行
 *  2   评审栏第二层 sticky
 *  3   标题栏右侧按钮组（在岛之上）
 *  10  槽位内遮面 / 点击捕获层
 *  30  页内 rail 与预览抽屉
 *  31  展开态的评审 rail
 */
const LOCAL = new Set([1, 2, 3, 10, 30, 31]);

const SANCTIONED = new Set([...GLOBAL, ...LOCAL]);

/** App.css 里出现的正数层叠值（-1 是伪元素铺底负档）+ 未入座的行，一次扫描两用 */
function scanCss(): { values: Set<number>; bad: string[] } {
  const values = new Set<number>();
  const bad: string[] = [];
  readFileSync(CSS, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const m = /z-index:\s*(-?\d+)/.exec(line);
      if (!m) return;
      const value = Number(m[1]);
      if (value === -1) return;
      values.add(value);
      if (!SANCTIONED.has(value)) bad.push(`App.css:${i + 1}: z-index: ${value}`);
    });
  return { values, bad };
}

const CSS_SCAN = scanCss();

/** 行号 + 原文，报错时能直接跳过去 */
function hitsIn(files: string[], re: RegExp, base: string): string[] {
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) found.push(`${file.slice(base.length + 1)}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

/**
 * 抓 `z-<n>` 类名。
 *
 * 前置 `(?<![\w-])` 是关键：Tailwind v4 有 translate-z / rotate-z / scale-z 这类
 * 三维变换工具，不加这个否后顾会在 `translate-z-4` 里匹配到 `z-4`，把变换当成层叠。
 * 变体前缀（`md:z-50`、`hover:z-40`）不受影响，因为 `:` 不在否后顾集合里。
 */
const Z_CLASS = /(?<![\w-])-?z-(\d+)\b/g;

test("扫描范围非空（防止路径写错导致永久空跑）", () => {
  assert.ok(FILES.length > 50, `只扫到 ${FILES.length} 个源文件，路径不对`);
});

test("z 类只用已入座的值，禁造新档", () => {
  const bad: string[] = [];
  const used = new Set<number>();
  for (const file of FILES) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(Z_CLASS)) {
          const value = Number(m[1]);
          used.add(value);
          if (!SANCTIONED.has(value)) {
            bad.push(`${rel(file)}:${i + 1}: z-${value} — ${line.trim()}`);
          }
        }
      });
  }
  assert.deepEqual(
    bad,
    [],
    `未入座的 z 档。全局层请从 ${[...GLOBAL].sort((a, b) => a - b).join("/")} 里选，` +
      `局部自层叠请从 ${[...LOCAL].sort((a, b) => a - b).join("/")} 里选；` +
      `确实需要新档就同时改 design-system.md 的台账与本文件的集合：\n${bad.join("\n")}`,
  );
  // 反过来也钉一下：集合里的值必须真的有人用，否则台账会慢慢长出幽灵档。
  // 判据是「源码 ∪ CSS」——39/44 这类外壳档只写在 App.css 里，没有 className 引用。
  for (const value of SANCTIONED) {
    if (!used.has(value) && !CSS_SCAN.values.has(value)) {
      assert.fail(`z-${value} 在台账里但源码与 CSS 里都已无人使用，请从测试与文档中移除`);
    }
  }
});

test("禁用 z-[N] 括号写法——v4 里裸整数等价，两种拼法并存只会让人以为有区别", () => {
  const found = hitsIn(FILES, /(?<![\w-])-?z-\[\d+\]/, SRC);
  assert.deepEqual(
    found,
    [],
    `裸整数与括号写法等价（Tailwind v4 的 z 走 handleBareValue），统一写 z-N：\n${found.join("\n")}`,
  );
});

test("App.css 的 z-index 声明也在同一套台账内", () => {
  assert.deepEqual(
    CSS_SCAN.bad,
    [],
    `CSS 里出现未入座的层叠值：\n${CSS_SCAN.bad.join("\n")}`,
  );
});
