import assert from "node:assert/strict";
import test from "node:test";
import {
  codexNewThreadDeeplink,
  codexThreadDeeplink,
} from "../src/codex-client.ts";

test("会话深链是 codex://threads/<id>", () => {
  assert.equal(
    codexThreadDeeplink("019abc-thread"),
    "codex://threads/019abc-thread",
  );
});

test("项目深链把绝对路径放进 path 查询参数", () => {
  const href = codexNewThreadDeeplink("/Users/me/综述文献");
  const url = new URL(href);
  assert.equal(url.protocol, "codex:");
  assert.equal(url.host, "threads");
  assert.equal(url.pathname, "/new");
  assert.equal(url.searchParams.get("path"), "/Users/me/综述文献");
});

test("Windows 路径原样进 path，由客户端把反斜杠换成正斜杠", () => {
  const href = codexNewThreadDeeplink("C:\\Users\\me\\Demo");
  const url = new URL(href);
  assert.equal(url.searchParams.get("path"), "C:\\Users\\me\\Demo");
});
