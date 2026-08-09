import assert from "node:assert/strict";
import test from "node:test";
import { isSoftwareRendererName } from "../src/diagnostics.ts";

test("识别常见软件 WebGL renderer", () => {
  assert.ok(isSoftwareRendererName("Google SwiftShader"));
  assert.ok(isSoftwareRendererName("Microsoft Basic Render Driver"));
  assert.ok(isSoftwareRendererName("llvmpipe (LLVM 18.1)"));
  assert.ok(!isSoftwareRendererName("ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)"));
});
