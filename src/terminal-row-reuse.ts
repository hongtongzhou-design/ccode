/**
 * DOM 渲染器滚动时按行挪位（滚轮 / 触控板同一条路径）。
 *
 * xterm 只要视口行号变了就 `refresh(0, rows-1)`，DOM 渲染器对每一行
 * `replaceChildren`。鼠标滚轮一格通常只有一枚事件，合帧省不掉这次整屏重建，
 * 所以滚轮和触控板一样会顿一下。
 *
 * 视口只平移、且平移不到一整屏时，还留在屏幕上的行文字没变：把已有行节点挪到
 * 新位置，只让 xterm 重画新进入的那几行。对不上（整屏被改写、行数变了、平移
 * 超过一屏）就整屏重画，避免把旧内容留在屏幕上。
 *
 * WebGL 渲染器没有逐行 DOM，探测不到行节点就是空操作。
 */

export interface ScrollReuseTerminal {
  rows: number;
  buffer: {
    active: {
      viewportY: number;
      /** 光标所在缓冲区行 = baseY + cursorY；缺了就不补画光标行 */
      baseY?: number;
      cursorY?: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

export interface RowSlot {
  textContent: string | null;
  childNodes: ArrayLike<unknown>;
  replaceChildren: (...nodes: unknown[]) => void;
}

export interface DomRowRenderer {
  renderRows: (start: number, end: number) => void;
  _rowElements?: RowSlot[];
}

/** 整屏刷新且平移行数在 1..rows-1 之间时，返回仍需重画的视口行（含端点） */
export function planScrollRowReuse(
  delta: number,
  rowCount: number,
  start: number,
  end: number,
): { renderStart: number; renderEnd: number } | null {
  if (!Number.isInteger(delta) || delta === 0) return null;
  if (!Number.isInteger(rowCount) || rowCount <= 1) return null;
  if (Math.abs(delta) >= rowCount) return null;
  if (start !== 0 || end < rowCount - 1) return null;
  if (delta > 0) return { renderStart: rowCount - delta, renderEnd: rowCount - 1 };
  return { renderStart: 0, renderEnd: -delta - 1 };
}

/** 平移后仍可见的行：新视口下标 ← 旧视口下标 */
export function keptRowMap(
  rowCount: number,
  delta: number,
): Array<{ dest: number; source: number }> | null {
  if (!Number.isInteger(delta) || delta === 0) return null;
  if (!Number.isInteger(rowCount) || Math.abs(delta) >= rowCount) return null;
  const pairs: Array<{ dest: number; source: number }> = [];
  if (delta > 0) {
    for (let dest = 0; dest < rowCount - delta; dest++) {
      pairs.push({ dest, source: dest + delta });
    }
  } else {
    const drop = -delta;
    for (let dest = drop; dest < rowCount; dest++) {
      pairs.push({ dest, source: dest - drop });
    }
  }
  return pairs;
}

/** 和缓冲区译文对齐：不换行空格当普通空格，去掉行尾空白 */
export function rowTextKey(text: string | null | undefined): string {
  // replaceAll \u8981 lib es2021\uff08tsconfig \u662f ES2020\uff09\uff0c\u7528\u5168\u5c40\u6b63\u5219\u7b49\u4ef7\u66ff\u6362
  return (text ?? "").replace(/\u00a0/gu, " ").replace(/\s+$/u, "");
}

export function keptRowsMatch(
  stamps: readonly string[],
  expected: readonly string[],
  pairs: readonly { dest: number; source: number }[],
): boolean {
  for (const { dest, source } of pairs) {
    const stamp = stamps[source];
    const want = expected[dest];
    if (stamp === undefined || want === undefined || stamp !== want) return false;
  }
  return true;
}

/** 把旧行的子节点挪到新视口位置。调用前先拍下 childNodes，避免边挪边读被掏空 */
export function shiftRowChildren(rows: readonly RowSlot[], delta: number): void {
  const pairs = keptRowMap(rows.length, delta);
  if (!pairs) return;
  const saved = rows.map((row) => Array.from(row.childNodes));
  for (const { dest, source } of pairs) {
    rows[dest].replaceChildren(...saved[source]);
  }
}

const WRAP_MARK = Symbol.for("mesa.domScrollRowReuse");

type MarkedRender = DomRowRenderer["renderRows"] & { [WRAP_MARK]?: boolean };

/** 新进入的行之外，还要重画的视口行：当前光标行，以及仍带着旧光标类名的行 */
export function cursorRowsToRepaint(
  term: ScrollReuseTerminal,
  rows: readonly RowSlot[],
  viewportY: number,
  renderStart: number,
  renderEnd: number,
): number[] {
  const out: number[] = [];
  const seen = (i: number) => (i >= renderStart && i <= renderEnd) || out.includes(i);
  const buf = term.buffer.active;
  if (typeof buf.baseY === "number" && typeof buf.cursorY === "number") {
    const visual = buf.baseY + buf.cursorY - viewportY;
    if (visual >= 0 && visual < rows.length && !seen(visual)) out.push(visual);
  }
  for (let i = 0; i < rows.length; i++) {
    if (seen(i)) continue;
    const el = rows[i] as RowSlot & { querySelector?: (sel: string) => unknown };
    if (typeof el?.querySelector === "function" && el.querySelector(".xterm-cursor")) out.push(i);
  }
  return out;
}

function lineKey(term: ScrollReuseTerminal, y: number): string | undefined {
  const line = term.buffer.active.getLine(y);
  if (!line) return undefined;
  return rowTextKey(line.translateToString(true));
}

/**
 * 包住 DOM 渲染器的 renderRows。渲染器还不是 DOM（没有 `_rowElements`）时空操作。
 * 返回拆除函数。
 */
export function installDomScrollRowReuse(term: ScrollReuseTerminal): () => void {
  const renderer = domRowRendererOf(term);
  if (!renderer || !renderer._rowElements) return () => {};
  return attachDomScrollRowReuse(term, renderer);
}

export function attachDomScrollRowReuse(
  term: ScrollReuseTerminal,
  renderer: DomRowRenderer,
): () => void {
  const current = renderer.renderRows as MarkedRender;
  if (current[WRAP_MARK]) return () => {};
  if (!renderer._rowElements) return () => {};
  // 类方法靠 this 找行节点；拆下来直接调用会丢 this，整屏刷新直接抛
  const orig = current.bind(renderer) as MarkedRender;

  let lastY: number | null = null;
  let stamps: string[] = [];

  const fillStamps = (start: number, end: number) => {
    const rows = renderer._rowElements;
    if (!rows || stamps.length !== term.rows) return;
    const hi = Math.min(end, term.rows - 1);
    for (let i = Math.max(0, start); i <= hi; i++) {
      stamps[i] = rowTextKey(rows[i]?.textContent);
    }
  };

  const captureAll = () => {
    const rows = renderer._rowElements;
    const n = term.rows;
    if (!rows || rows.length < n) {
      stamps = [];
      return;
    }
    stamps = [];
    for (let i = 0; i < n; i++) stamps.push(rowTextKey(rows[i]?.textContent));
  };

  const wrapped: MarkedRender = (start, end) => {
    const rowCount = term.rows;
    const y = term.buffer.active.viewportY;
    const rows = renderer._rowElements;
    const delta = lastY === null ? 0 : y - lastY;
    const pairs =
      lastY !== null && stamps.length === rowCount && rows && rows.length >= rowCount
        ? keptRowMap(rowCount, delta)
        : null;
    const plan = pairs ? planScrollRowReuse(delta, rowCount, start, end) : null;
    if (pairs && plan && rows) {
      const expected: string[] = new Array(rowCount);
      let complete = true;
      for (const { dest } of pairs) {
        const key = lineKey(term, y + dest);
        if (key === undefined) {
          complete = false;
          break;
        }
        expected[dest] = key;
      }
      if (complete && keptRowsMatch(stamps, expected, pairs)) {
        const visible = rows.slice(0, rowCount);
        shiftRowChildren(visible, delta);
        const next = new Array<string>(rowCount);
        for (const { dest, source } of pairs) next[dest] = stamps[source];
        stamps = next;
        lastY = y;
        orig(plan.renderStart, plan.renderEnd);
        fillStamps(plan.renderStart, plan.renderEnd);
        // 光标类名跟着行节点走。滚出旧光标行、或光标还停在保留行上时，只补画那一行，
        // 避免行尾换行后屏幕上留下两个光标。
        for (const i of cursorRowsToRepaint(term, visible, y, plan.renderStart, plan.renderEnd)) {
          orig(i, i);
          fillStamps(i, i);
        }
        return;
      }
    }
    lastY = y;
    orig(start, end);
    if (start === 0 && end >= rowCount - 1) captureAll();
    else fillStamps(start, end);
  };
  wrapped[WRAP_MARK] = true;
  renderer.renderRows = wrapped;
  return () => {
    if (renderer.renderRows === wrapped) renderer.renderRows = current;
  };
}

function domRowRendererOf(term: ScrollReuseTerminal): DomRowRenderer | null {
  const core = (term as ScrollReuseTerminal & {
    _core?: { _renderService?: { _renderer?: { value?: DomRowRenderer } } };
  })._core;
  const renderer = core?._renderService?._renderer?.value;
  if (!renderer || typeof renderer.renderRows !== "function") return null;
  if (!Array.isArray(renderer._rowElements)) return null;
  return renderer;
}
