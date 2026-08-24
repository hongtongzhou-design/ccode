import { test } from "node:test";
import assert from "node:assert/strict";
import { imagePathFromLine, splitImagePaths } from "../src/chat-image.ts";

test("整行绝对路径识别为图片", () => {
  assert.equal(imagePathFromLine("/Users/x/pic/a.png"), "/Users/x/pic/a.png");
  assert.equal(imagePathFromLine("~/shots/a.jpeg"), "~/shots/a.jpeg");
  assert.equal(imagePathFromLine("C:\\shots\\a.webp"), "C:\\shots\\a.webp");
});

test("带空格的路径 + shell 单引号包裹", () => {
  assert.equal(
    imagePathFromLine(
      "'/Users/x/Library/Application Support/PixPin/Temp/a.png'",
    ),
    "/Users/x/Library/Application Support/PixPin/Temp/a.png",
  );
});

test("单引号回转 '\\'' 还原", () => {
  assert.equal(imagePathFromLine("'/tmp/it'\\''s.png'"), "/tmp/it's.png");
});

test("相对路径（含分隔符）识别，裸文件名不识别", () => {
  assert.equal(imagePathFromLine("figures/plot.svg"), "figures/plot.svg");
  assert.equal(imagePathFromLine("plot.png"), null);
});

test("URL / 正文短语 / 非图片扩展名不识别", () => {
  assert.equal(imagePathFromLine("https://example.com/a.png"), null);
  assert.equal(imagePathFromLine("结果保存在 figures/plot.png 里"), null);
  assert.equal(imagePathFromLine("/tmp/notes.md"), null);
  assert.equal(imagePathFromLine(""), null);
});

test("splitImagePaths 剥离图片行并保持顺序", () => {
  const { text, images } = splitImagePaths(
    "看一下这两张图\n/tmp/a.png\n中间说明\nfigures/b.jpg\n",
  );
  assert.deepEqual(images, ["/tmp/a.png", "figures/b.jpg"]);
  assert.equal(text, "看一下这两张图\n中间说明");
});

test("整条消息就是图片路径时正文为空", () => {
  const { text, images } = splitImagePaths("/tmp/a.png");
  assert.equal(text, "");
  assert.deepEqual(images, ["/tmp/a.png"]);
});
