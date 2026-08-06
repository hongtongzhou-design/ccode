import assert from "node:assert/strict";
import test from "node:test";
import { upstreamNoteText } from "../src/upstream-note.ts";

test("渠道版本差提示：brew 已最新且上游更新时才给文案", () => {
  // 典型场景：brew 0.46 已是最新，上游 npm 到 0.53
  assert.equal(
    upstreamNoteText({ latest: "0.46.0", outdated: false, upstreamNote: "0.53.0" }),
    "brew 渠道最新；上游 npm 已到 0.53.0（渠道通常滞后）",
  );
});

test("渠道版本差提示：有 brew 更新可升时不显示", () => {
  assert.equal(
    upstreamNoteText({ latest: "0.47.0", outdated: true, upstreamNote: "0.53.0" }),
    null,
  );
});

test("渠道版本差提示：查不到渠道最新版或上游版本时静默", () => {
  // latest 为 null（查不到 brew 最新版）→ 组头回退普通「更新」按钮，不挂提示
  assert.equal(
    upstreamNoteText({ latest: null, outdated: false, upstreamNote: "0.53.0" }),
    null,
  );
  // 上游查询失败（npm view 失败）→ upstreamNote 为 null，静默
  assert.equal(
    upstreamNoteText({ latest: "0.46.0", outdated: false, upstreamNote: null }),
    null,
  );
});
