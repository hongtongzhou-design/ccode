import assert from "node:assert/strict";
import test from "node:test";
import { resolveCustomRuntimeCwd } from "../src/custom-runtime.ts";

test("自定义运行时 cwd：空标签用默认目录，scratch 也用默认", () => {
  assert.equal(resolveCustomRuntimeCwd("", "/proj"), "/proj");
  assert.equal(
    resolveCustomRuntimeCwd("/Users/u/ccode/scratch", "/proj"),
    "/proj",
  );
  assert.equal(
    resolveCustomRuntimeCwd("C:\\Users\\u\\ccode\\scratch", "D:\\work", true),
    "D:\\work",
  );
});

test("自定义运行时 cwd：项目根和工作树不覆盖", () => {
  assert.equal(resolveCustomRuntimeCwd("/Users/u/papers/p", "/proj"), "/Users/u/papers/p");
  assert.equal(
    resolveCustomRuntimeCwd("/Users/u/ccode/worktrees/p/feat", "/proj"),
    "/Users/u/ccode/worktrees/p/feat",
  );
  assert.equal(resolveCustomRuntimeCwd("/Users/u/papers/p", ""), "/Users/u/papers/p");
});
