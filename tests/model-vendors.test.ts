import test from "node:test";
import assert from "node:assert/strict";
import { vendorOf, groupModelsByVendor } from "../src/model-vendors.ts";

test("vendorOf：斜杠风格取前段", () => {
  assert.equal(vendorOf("openai/gpt-5"), "openai");
  assert.equal(vendorOf("Qwen/Qwen3-32B"), "qwen");
});

test("vendorOf：横线风格取字母+数字前缀", () => {
  assert.equal(vendorOf("gpt-5.6-sol"), "gpt");
  assert.equal(vendorOf("gemini-3.5-flash"), "gemini");
  assert.equal(vendorOf("claude-sonnet-4"), "claude");
  assert.equal(vendorOf("o3-pro"), "o3");
  assert.equal(vendorOf("Qwen3-32B"), "qwen3");
});

test("vendorOf：不匹配与空值归「其他」", () => {
  assert.equal(vendorOf(""), "其他");
  assert.equal(vendorOf("  "), "其他");
  assert.equal(vendorOf("-weird"), "其他");
  assert.equal(vendorOf("/leading-slash"), "其他");
});

test("groupModelsByVendor：分组排序，其他恒末", () => {
  const groups = groupModelsByVendor([
    "gemini-3.5-flash",
    "-odd",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "claude-opus-4",
  ]);
  assert.deepStrictEqual(
    groups.map((g) => g.vendor),
    ["claude", "gemini", "gpt", "其他"],
  );
  const gpt = groups.find((g) => g.vendor === "gpt")!;
  assert.deepStrictEqual(gpt.models, ["gpt-5.6-luna", "gpt-5.6-sol"]);
});

test("groupModelsByVendor：筛选大小写不敏感、空组不产出", () => {
  const groups = groupModelsByVendor(
    ["gpt-5.6-sol", "gemini-3.5-flash"],
    "GEMINI",
  );
  assert.deepStrictEqual(groups, [
    { vendor: "gemini", models: ["gemini-3.5-flash"] },
  ]);
});
