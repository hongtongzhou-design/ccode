import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISIONS_HEADING,
  isDecisionsOnly,
  orderedAnswers,
  parseDecisions,
  recommendedAnswers,
  stripDecisions,
  unansweredDecisions,
  upsertDecisions,
} from "../src/step-decisions.ts";
import type { StepDecisionDto } from "../src/types.ts";

const DECISIONS: StepDecisionDto[] = [
  { q: "综述角度怎么收", options: ["领域全景铺开", "聚焦某个子问题"] },
  { q: "纳入标准定多严", options: ["只要高质量期刊/顶会", "含预印本"] },
];

test("空草稿：新建小节并写入答案", () => {
  const out = upsertDecisions("", [{ q: "综述角度怎么收", answer: "领域全景铺开" }]);
  assert.match(out, /^## 已定方向\n\n- 综述角度怎么收：领域全景铺开\n/);
  assert.deepEqual([...parseDecisions(out)], [["综述角度怎么收", "领域全景铺开"]]);
});

test("已有草稿：小节插在一级标题之后，正文不动", () => {
  const draft = "# 任务书草稿：检索筛选\n\n## 背景\n\n这里是正文。\n";
  const out = upsertDecisions(draft, [
    { q: "综述角度怎么收", answer: "聚焦某个子问题" },
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "# 任务书草稿：检索筛选");
  assert.ok(
    lines.indexOf(DECISIONS_HEADING) < lines.indexOf("## 背景"),
    `已定方向应在正文小节之前:\n${out}`,
  );
  assert.ok(out.includes("这里是正文。"), "原正文必须保留");
});

test("重复拍板同一题 = 覆盖，不产生第二行", () => {
  let out = upsertDecisions("", [{ q: "综述角度怎么收", answer: "领域全景铺开" }]);
  out = upsertDecisions(out, [{ q: "综述角度怎么收", answer: "聚焦某个子问题" }]);
  assert.equal(parseDecisions(out).get("综述角度怎么收"), "聚焦某个子问题");
  assert.equal(out.match(/- 综述角度怎么收：/g)?.length, 1, out);
});

test("小节内已有答案 + 新答案：保序追加，原答案保留", () => {
  let out = upsertDecisions("", [{ q: "综述角度怎么收", answer: "领域全景铺开" }]);
  out = upsertDecisions(out, [{ q: "纳入标准定多严", answer: "含预印本" }]);
  assert.deepEqual(
    [...parseDecisions(out)],
    [
      ["综述角度怎么收", "领域全景铺开"],
      ["纳入标准定多严", "含预印本"],
    ],
  );
});

test("小节被后续二级标题终止：不吃下面的内容", () => {
  const draft = `${DECISIONS_HEADING}\n\n- 综述角度怎么收：领域全景铺开\n\n## 其他\n\n- 纳入标准定多严：不该被解析\n`;
  const got = parseDecisions(draft);
  assert.equal(got.get("综述角度怎么收"), "领域全景铺开");
  assert.equal(got.has("纳入标准定多严"), false, "小节外的同形行不该算数");
});

test("小节只由空行与答案行组成：遇到任何别的内容即终止（不吞正文）", () => {
  // 已定方向后面直接跟没有标题的正文——旧口径（吃到下一个 ## 或文件尾）会把正文
  // 一并算进小节，重写时删掉它。这里断言正文既不被解析、也不被吞掉
  const draft = `${DECISIONS_HEADING}\n\n- 综述角度怎么收：领域全景铺开\n\n这是人写的正文，不能丢。\n`;
  assert.equal(parseDecisions(draft).get("综述角度怎么收"), "领域全景铺开");
  assert.equal(stripDecisions(draft), "这是人写的正文，不能丢。");
  const out = upsertDecisions(draft, [
    { q: "纳入标准定多严", answer: "只要顶刊" },
  ]);
  assert.ok(out.includes("这是人写的正文，不能丢。"), `正文必须保留:\n${out}`);
  assert.equal(parseDecisions(out).size, 2);
});

test("没有小节 / 空答案：解析为空、写入为 no-op", () => {
  assert.equal(parseDecisions("# 只有标题\n\n正文").size, 0);
  const draft = "# 任务书草稿\n";
  assert.equal(upsertDecisions(draft, []), draft);
  assert.equal(upsertDecisions(draft, [{ q: " ", answer: "x" }]), draft);
  assert.equal(upsertDecisions(draft, [{ q: "x", answer: " " }]), draft);
});

test("未答项与推荐值：已答的不被一键覆盖", () => {
  const answered = new Map([["综述角度怎么收", "聚焦某个子问题"]]);
  assert.deepEqual(
    unansweredDecisions(DECISIONS, answered).map((d) => d.q),
    ["纳入标准定多严"],
  );
  assert.deepEqual(recommendedAnswers(DECISIONS, answered), [
    { q: "纳入标准定多严", answer: "只要高质量期刊/顶会" },
  ]);
  assert.deepEqual(recommendedAnswers(DECISIONS, new Map()), [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
    { q: "纳入标准定多严", answer: "只要高质量期刊/顶会" },
  ]);
});

test("无选项的决策项不参与推荐值", () => {
  assert.deepEqual(recommendedAnswers([{ q: "空题", options: [] }], new Map()), []);
});

test("CRLF 草稿也能解析", () => {
  const draft = `${DECISIONS_HEADING}\r\n\r\n- 综述角度怎么收：领域全景铺开\r\n`;
  assert.equal(parseDecisions(draft).get("综述角度怎么收"), "领域全景铺开");
});

// ===== 开工口径：只点了选项的草稿不该顶掉模板拼装 =====

test("只有已定方向的草稿 = 决策项-only（开工走模板拼装）", () => {
  const draft = upsertDecisions("", [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
  ]);
  assert.equal(isDecisionsOnly(draft), true);
  assert.equal(stripDecisions(draft), "");
});

test("只剩标题行也算没有正文", () => {
  const draft = upsertDecisions("# 任务书草稿：检索筛选\n", [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
  ]);
  assert.equal(isDecisionsOnly(draft), true, draft);
});

test("有正文的草稿不是决策项-only（保持 v3.72 草稿优先）", () => {
  const draft = upsertDecisions("# 任务书草稿\n\n先做预调研，再定检索式。\n", [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
  ]);
  assert.equal(isDecisionsOnly(draft), false, draft);
  assert.equal(stripDecisions(draft), "# 任务书草稿\n\n先做预调研，再定检索式。");
});

test("空草稿 / 无已定方向段：都不是决策项-only", () => {
  assert.equal(isDecisionsOnly(""), false);
  assert.equal(isDecisionsOnly("   "), false);
  assert.equal(isDecisionsOnly("# 任务书草稿\n\n正文"), false);
});

test("orderedAnswers：按模板顺序排，人手写的条目排在后面不丢", () => {
  const decisions = [
    { q: "综述角度怎么收", options: ["领域全景铺开"] },
    { q: "纳入标准定多严", options: ["只要顶刊"] },
  ];
  const answered = new Map([
    ["纳入标准定多严", "只要顶刊"],
    ["手写的题", "手写的答案"],
    ["综述角度怎么收", "领域全景铺开"],
  ]);
  assert.deepEqual(orderedAnswers(decisions, answered), [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
    { q: "纳入标准定多严", answer: "只要顶刊" },
    { q: "手写的题", answer: "手写的答案" },
  ]);
});
