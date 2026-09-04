import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("示例课题用的英文综述 JSON 与 PIPELINE_TEMPLATES 同步", () => {
  const tpl = PIPELINE_TEMPLATES.find((t) => t.id === "review");
  assert.ok(tpl, "缺少英文综述模板");
  const disk = JSON.parse(
    readFileSync("src-tauri/resources/pipeline-review.json", "utf8"),
  ) as {
    id: string;
    name: string;
    projectSettings: string[];
    steps: unknown;
  };
  assert.equal(disk.id, "review");
  assert.equal(disk.name, tpl!.name);
  assert.deepEqual(disk.projectSettings, tpl!.projectSettings ?? []);
  assert.deepEqual(
    disk.steps,
    tpl!.steps,
    "改了英文综述模板后请运行：node --experimental-strip-types scripts/export-review-template.ts",
  );
});
