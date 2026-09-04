/**
 * 把 pipeline-presets.ts 的「英文综述」模板导出给示例课题用。
 * 改 REVIEW_STEPS 后跑：
 *   node --experimental-strip-types scripts/export-review-template.ts
 * tests/pipeline-review-sync.test.ts 会核对两边一致。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

const tpl = PIPELINE_TEMPLATES.find((t) => t.id === "review");
if (!tpl) {
  throw new Error("PIPELINE_TEMPLATES 里没有 id=review 的英文综述");
}
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/resources/pipeline-review.json",
);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      id: tpl.id,
      name: tpl.name,
      projectSettings: tpl.projectSettings ?? [],
      steps: tpl.steps,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out}`);
