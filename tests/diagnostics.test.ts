import assert from "node:assert/strict";
import test from "node:test";
import { isSoftwareRendererName, webglUsable } from "../src/diagnostics.ts";

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
