import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeShellPath,
  joinDroppedPaths,
  firstImageItem,
  imageExtFromMime,
  pasteImageFeedback,
} from "../src/terminal-input.ts";

test("escapeShellPath 安全字符路径原样返回", () => {
  assert.equal(escapeShellPath("/tmp/a.png"), "/tmp/a.png");
  // 非 ASCII（中文名）不在安全字符集内：保守包裹（各 shell 对单引号内 UTF-8 都安全）
  assert.equal(escapeShellPath("/Users/u/截图-1.png"), "'/Users/u/截图-1.png'");
});

test("escapeShellPath 含空格/引号/反斜杠整体单引号包裹", () => {
  assert.equal(escapeShellPath("/tmp/my pic.png"), "'/tmp/my pic.png'");
  assert.equal(escapeShellPath("C:\\Users\\a b\\x.png"), "'C:\\Users\\a b\\x.png'");
  assert.equal(escapeShellPath("it's.png"), "'it'\\''s.png'");
});

test("joinDroppedPaths 多路径转义后空格拼接", () => {
  assert.equal(
    joinDroppedPaths(["/tmp/a.png", "/tmp/b c.png", "/tmp/d'e.txt"]),
    "/tmp/a.png '/tmp/b c.png' '/tmp/d'\\''e.txt'",
  );
  assert.equal(joinDroppedPaths([]), "");
  assert.equal(joinDroppedPaths(["/tmp/a.png", ""]), "/tmp/a.png");
});

test("firstImageItem 挑出第一个 image/* 条目", () => {
  assert.equal(
    firstImageItem([{ type: "text/plain" }, { type: "image/png" }]),
    1,
  );
  assert.equal(firstImageItem([{ type: "text/plain" }]), -1);
  assert.equal(
    firstImageItem([{ type: "image/png" }, { type: "image/jpeg" }]),
    0,
  );
});

test("imageExtFromMime 白名单映射与兜底 png", () => {
  assert.equal(imageExtFromMime("image/png"), "png");
  assert.equal(imageExtFromMime("image/jpeg"), "jpg");
  assert.equal(imageExtFromMime("image/gif"), "gif");
  assert.equal(imageExtFromMime("image/webp"), "webp");
  assert.equal(imageExtFromMime("image/bmp"), "png");
  assert.equal(imageExtFromMime("IMAGE/JPEG"), "jpg");
});

test("pasteImageFeedback 长文件名截断", () => {
  assert.equal(
    pasteImageFeedback("/cfg/ccode/tmp/paste-20260817-110000-ab12.png"),
    "已粘贴图片路径：paste-20260817-110000-ab12.png",
  );
  const long = `/tmp/${"x".repeat(60)}.png`;
  const out = pasteImageFeedback(long);
  assert.ok(out.startsWith("已粘贴图片路径："), out);
  assert.ok(out.endsWith("…"), out);
});
