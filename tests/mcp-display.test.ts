import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpKindBadgeStyle,
  shortenCommand,
  shortenPathToken,
} from "../src/mcp-display.ts";

test("家目录前缀三形态折叠为 ~", () => {
  assert.equal(shortenPathToken("/Users/alice/bin/tool"), "~/bin/tool");
  assert.equal(shortenPathToken("/home/bob/bin/tool"), "~/bin/tool");
  assert.equal(
    shortenPathToken("C:\\Users\\carol\\AppData\\tool.exe"),
    "~/AppData/tool.exe",
  );
});

test("超过 3 段砍中段留首尾，3 段以内原样", () => {
  assert.equal(
    shortenPathToken(
      "/Users/alice/Library/Application Support/SkyComputerUseClient",
    ),
    "~/…/SkyComputerUseClient",
  );
  assert.equal(shortenPathToken("/opt/homebrew/bin/node"), "/opt/homebrew/bin/node");
  assert.equal(
    shortenPathToken("/very/long/path/with/many/segments/tool"),
    "/very/…/tool",
  );
});

test("非路径 token 与 URL 原样保留", () => {
  assert.equal(shortenPathToken("npx"), "npx");
  assert.equal(shortenPathToken("--port"), "--port");
  assert.equal(shortenPathToken("https://api.example.com/v1"), "https://api.example.com/v1");
});

test("shortenCommand 逐 token 缩略后拼接，短路径原样", () => {
  assert.equal(
    shortenCommand("/Users/alice/.bun/bin/bun", [
      "x",
      "/Users/alice/Library/Application Support/SkyComputerUseClient/index.js",
      "--stdio",
    ]),
    "~/.bun/bin/bun x ~/…/index.js --stdio",
  );
});

test("协议徽章：remote 蓝 / stdio 紫，底色 10% 混合", () => {
  assert.equal(mcpKindBadgeStyle("remote").color, "#4f8ef7");
  assert.equal(mcpKindBadgeStyle("stdio").color, "#9a6ef3");
  assert.match(mcpKindBadgeStyle("stdio").background, /color-mix/);
});
