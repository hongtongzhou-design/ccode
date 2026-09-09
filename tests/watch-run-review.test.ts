import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

// 在内存中编译组件；仅模拟 Tauri 边界，不打开桌面应用或真实用户目录。
test("定时评审：冻结证据、当前目录标注、采纳确认和旧记录保护", async () => {
  const built = await build({
    stdin: {
      contents: `export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { default as Review } from './src/components/WatchRunReview'; export { ConfirmDialogHost } from './src/components/ConfirmDialog';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, requestAnimationFrame: (fn: () => void) => { fn(); return 0; }, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls: string[] = [];
  let legacy = false;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    calls.push(command);
    if (command === "watch_run_snapshot") {
      if (legacy) throw new Error("本次运行没有冻结产物证据");
      return { runId: "r", files: [{ path: "notes/inbox.md", before: "old", initial: "old", after: '<img src=x onerror="alert(1)">' }] };
    }
    if (command === "adopt_watch_run") return ["notes/inbox.md"];
    throw new Error(command);
  } } });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, Review, ConfirmDialogHost } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const buttons = () => Array.from(host.querySelectorAll("button"));
  const button = (text: string) => buttons().find((item) => item.textContent === text)!;
  const render = (id: string, status = "completed") => act(async () => {
    root.render(h("div", null, h(Review, { key: id, run: { id, status }, onClose: () => {}, currentDirectory: h("p", null, "实时目录内容") }), h(ConfirmDialogHost)));
  });
  try {
    await render("first");
    assert.match(host.textContent!, /冻结产物评审/);
    assert.match(host.textContent!, /<img src=x/);
    assert.equal(host.querySelector("img"), null, "证据以文本呈现，不执行 HTML");
    assert.ok(host.firstElementChild?.firstElementChild?.classList.contains("absolute"));
    await act(async () => button("查看当前工作目录").click());
    assert.match(host.textContent!, /不是这次运行的历史快照/);
    assert.match(host.textContent!, /实时目录内容/);
    assert.equal(button("采纳进主仓"), undefined);
    await act(async () => button("回到冻结产物").click());
    await act(async () => button("采纳进主仓").click());
    assert.equal(calls.filter((x) => x === "adopt_watch_run").length, 0);
    await act(async () => button("取消").click());
    assert.equal(calls.filter((x) => x === "adopt_watch_run").length, 0);
    await act(async () => button("采纳进主仓").click());
    await act(async () => buttons().filter((b) => b.textContent === "采纳进主仓").at(-1)!.click());
    assert.equal(calls.filter((x) => x === "adopt_watch_run").length, 1);
    assert.ok(button("已采纳").disabled);
    await render("failed", "failed");
    assert.ok(button("采纳进主仓").disabled);
    legacy = true;
    await render("legacy");
    assert.match(host.textContent!, /没有冻结产物证据/);
    assert.ok(button("采纳进主仓").disabled);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
