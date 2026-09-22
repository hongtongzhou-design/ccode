import assert from "node:assert/strict";
import test from "node:test";
import {
  attachDomScrollRowReuse,
  cursorRowsToRepaint,
  keptRowMap,
  keptRowsMatch,
  planScrollRowReuse,
  rowTextKey,
  shiftRowChildren,
  type RowSlot,
  type ScrollReuseTerminal,
} from "../src/terminal-row-reuse.ts";

test("整屏平移不到一屏才裁重画范围", () => {
  assert.deepEqual(planScrollRowReuse(3, 40, 0, 39), { renderStart: 37, renderEnd: 39 });
  assert.deepEqual(planScrollRowReuse(-1, 40, 0, 39), { renderStart: 0, renderEnd: 0 });
  assert.equal(planScrollRowReuse(0, 40, 0, 39), null);
  assert.equal(planScrollRowReuse(40, 40, 0, 39), null);
  assert.equal(planScrollRowReuse(-40, 40, 0, 39), null);
  assert.equal(planScrollRowReuse(1, 40, 2, 2), null);
});

test("保留行的来源下标", () => {
  assert.deepEqual(keptRowMap(5, 2), [
    { dest: 0, source: 2 },
    { dest: 1, source: 3 },
    { dest: 2, source: 4 },
  ]);
  assert.deepEqual(keptRowMap(5, -2), [
    { dest: 2, source: 0 },
    { dest: 3, source: 1 },
    { dest: 4, source: 2 },
  ]);
  assert.equal(keptRowMap(5, 0), null);
  assert.equal(keptRowMap(5, 5), null);
});

test("行文比对：不换行空格与行尾空白不算差异", () => {
  assert.equal(rowTextKey("a\u00a0b  "), "a b");
  assert.equal(
    keptRowsMatch(["a", "b", "c"], ["b", "c", ""], [
      { dest: 0, source: 1 },
      { dest: 1, source: 2 },
    ]),
    true,
  );
  assert.equal(
    keptRowsMatch(["a", "b"], ["x", ""], [{ dest: 0, source: 0 }]),
    false,
  );
});

function slot(text: string): RowSlot & { nodes: string[] } {
  const row = {
    nodes: [text],
    get textContent() {
      return row.nodes.join("");
    },
    get childNodes() {
      return row.nodes;
    },
    replaceChildren(...nodes: unknown[]) {
      row.nodes = nodes.map(String);
    },
  };
  return row;
}

test("子节点按视口平移挪走，不复制", () => {
  const rows = [slot("a"), slot("b"), slot("c"), slot("d")];
  const token = rows[2].nodes[0];
  shiftRowChildren(rows, 2);
  assert.equal(rows[0].nodes[0], token);
  assert.equal(rows[0].textContent, "c");
  assert.equal(rows[1].textContent, "d");
});

function fakeTerm(lines: string[], viewportY: () => number): ScrollReuseTerminal {
  return {
    rows: 4,
    buffer: {
      active: {
        get viewportY() {
          return viewportY();
        },
        getLine(y: number) {
          const text = lines[y];
          if (text === undefined) return undefined;
          return { translateToString: () => text };
        },
      },
    },
  };
}

test("向下滚两行只重画底部两行，上面的节点是挪过去的", () => {
  const lines = ["0", "1", "2", "3", "4", "5", "6"];
  let y = 0;
  const term = fakeTerm(lines, () => y);
  const rows = [slot("0"), slot("1"), slot("2"), slot("3")];
  const paints: Array<[number, number]> = [];
  const renderer = {
    _rowElements: rows,
    renderRows(start: number, end: number) {
      paints.push([start, end]);
      for (let i = start; i <= end; i++) rows[i].replaceChildren(lines[y + i] ?? "");
    },
  };
  attachDomScrollRowReuse(term, renderer);
  renderer.renderRows(0, 3);
  const kept = rows[2].nodes[0];
  assert.deepEqual(paints, [[0, 3]]);

  paints.length = 0;
  y = 2;
  renderer.renderRows(0, 3);
  assert.deepEqual(paints, [[2, 3]]);
  assert.equal(rows[0].nodes[0], kept);
  assert.equal(rows[0].textContent, "2");
  assert.equal(rows[2].textContent, "4");
  assert.equal(rows[3].textContent, "5");
});

test("行文已被改写时不挪位，整屏重画", () => {
  const lines = ["0", "1", "2", "3", "4"];
  let y = 0;
  const term = fakeTerm(lines, () => y);
  const rows = [slot("0"), slot("1"), slot("2"), slot("3")];
  const paints: Array<[number, number]> = [];
  const renderer = {
    _rowElements: rows,
    renderRows(start: number, end: number) {
      paints.push([start, end]);
      for (let i = start; i <= end; i++) rows[i].replaceChildren(lines[y + i] ?? "");
    },
  };
  attachDomScrollRowReuse(term, renderer);
  renderer.renderRows(0, 3);
  lines[1] = "改过";
  paints.length = 0;
  y = 1;
  renderer.renderRows(0, 3);
  assert.deepEqual(paints, [[0, 3]]);
  assert.equal(rows[0].textContent, "改过");
});

test("光标还在保留行上、或旧光标类名还在，就补画那一行", () => {
  const rows = [slot("a"), slot("b"), slot("c")];
  rows[0].querySelector = (sel: string) => (sel === ".xterm-cursor" ? {} : null);
  const term: ScrollReuseTerminal = {
    rows: 3,
    buffer: { active: { viewportY: 4, baseY: 5, cursorY: 1, getLine: () => undefined } },
  };
  // 新进入的是底部第 2 行；光标视口行 = 5+1-4 = 2，已在重画范围内。
  // 第 0 行仍带着旧光标类名，要补画。
  assert.deepEqual(cursorRowsToRepaint(term, rows, 4, 2, 2), [0]);
});

test("光标行这种局部重画不打乱后续挪位", () => {
  const lines = ["0", "1", "2", "3", "4"];
  let y = 0;
  const term = fakeTerm(lines, () => y);
  const rows = [slot("0"), slot("1"), slot("2"), slot("3")];
  const paints: Array<[number, number]> = [];
  const renderer = {
    _rowElements: rows,
    renderRows(start: number, end: number) {
      paints.push([start, end]);
      for (let i = start; i <= end; i++) rows[i].replaceChildren(lines[y + i] ?? "");
    },
  };
  attachDomScrollRowReuse(term, renderer);
  renderer.renderRows(0, 3);
  lines[3] = "3b";
  renderer.renderRows(3, 3);
  paints.length = 0;
  y = 1;
  renderer.renderRows(0, 3);
  assert.deepEqual(paints, [[3, 3]]);
  assert.equal(rows[2].textContent, "3b");
  assert.equal(rows[3].textContent, "4");
});
