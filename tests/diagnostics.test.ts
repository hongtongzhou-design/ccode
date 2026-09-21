import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isCancellationRejection,
  isSoftwareRendererName,
  webglUsable,
} from "../src/diagnostics.ts";

test("识别常见软件 WebGL renderer", () => {
  assert.ok(isSoftwareRendererName("Google SwiftShader"));
  assert.ok(isSoftwareRendererName("Microsoft Basic Render Driver"));
  assert.ok(isSoftwareRendererName("llvmpipe (LLVM 18.1)"));
  assert.ok(!isSoftwareRendererName("ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)"));
});

test("webglUsable：renderer 不明时仅 Windows 回退 canvas", () => {
  const hardware = {
    supported: true,
    debugRendererInfoAvailable: true,
    renderer: "ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)",
    software: false,
  };
  assert.ok(webglUsable(hardware, true));
  assert.ok(webglUsable(hardware, false));

  const software = { ...hardware, renderer: "Google SwiftShader", software: true };
  assert.ok(!webglUsable(software, true));
  assert.ok(!webglUsable(software, false));

  // 拿不到 debug renderer 信息（probe 把这种情况标成 software=true）：Windows 保守回退，其他平台不误伤
  const unknown = {
    supported: true,
    debugRendererInfoAvailable: false,
    renderer: "",
    software: true,
  };
  assert.ok(!webglUsable(unknown, true));
  assert.ok(webglUsable(unknown, false));

  const noContext = { ...unknown, supported: false };
  assert.ok(!webglUsable(noContext, true));
  assert.ok(!webglUsable(noContext, false));
});

test("monaco CancellationError 视为预期取消", () => {
  const canceled = new Error("Canceled");
  canceled.name = "Canceled";
  assert.ok(isCancellationRejection(canceled));
  assert.ok(isCancellationRejection({ name: "Canceled", message: "Canceled" }));
  assert.ok(!isCancellationRejection(new Error("Canceled")));
  assert.ok(!isCancellationRejection(new Error("boom")));
  assert.ok(
    !isCancellationRejection(
      new DOMException("The operation was aborted", "AbortError"),
    ),
  );
  assert.ok(!isCancellationRejection("Canceled"));
  assert.ok(!isCancellationRejection(undefined));
});

test("monaco 剪贴板 workaround 仍是已知 cancel 形态", () => {
  const src = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../node_modules/monaco-editor/esm/vs/platform/clipboard/browser/clipboardService.js",
    ),
    "utf8",
  );
  assert.ok(src.includes("installWebKitWriteTextWorkaround"));
  assert.ok(src.includes("this.webKitPendingClipboardWritePromise.cancel();"));
});
