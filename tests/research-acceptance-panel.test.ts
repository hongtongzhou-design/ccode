import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("科研验收：传来源版本，未重看变更不得确认", async () => {
  const compiled = await build({ stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Panel} from './src/components/ResearchAcceptancePanel';`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react-dom/client", "react/jsx-runtime"] });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) { restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  const calls: any[] = []; let revision = "file-v1";
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    if (command === "research_source") return { root: "/tree", projectId: "p", resultVersion: "run:2", revision: "source-v1", warnings: [] };
    if (command === "research_get_acceptance") { assert.equal(args.resultVersion, "run:2"); assert.equal(args.sourceRevision, "source-v1"); return null; }
    if (command === "read_file_preview") return { text: "## 验收摘要\n结论与局限", revision, truncated: false };
    if (command === "research_save_acceptance") { calls.push(args); return args.record; }
    throw new Error(command);
  } } });
  const mod = { exports: {} as Record<string, any> }; new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Panel } = mod.exports;
  const host = dom.window.document.getElementById("root")!; const root = createRoot(host);
  const click = async (text: string) => act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!.click());
  try {
    await act(async () => root.render(h(Panel, { workspace: { id: "goal", repoPath: "/project", worktreePath: "/tree", status: "active" }, step: { name: "分析", expectedArtifacts: ["report.md"], skills: [], run: [] }, sourceRunId: "run" })));
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "accept"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    const text = host.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(text, "仅接受此批样本"); text.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    revision = "file-v2"; await click("记下验收决定"); assert.equal(calls.length, 0); assert.match(host.textContent!, /无法绑定完整版本/);
    revision = "file-v1"; await click("记下验收决定");
    assert.equal(calls.length, 1); assert.equal(calls[0].record.sourceRevision, "source-v1"); assert.equal(calls[0].record.resultVersion, "run:2"); assert.equal(calls[0].record.sourceRunId, "run");
  } finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of restore) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
});
