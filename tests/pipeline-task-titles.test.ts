import assert from "node:assert/strict";
import test from "node:test";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import {
  isEndnoteTaskTitle,
  isPaywallTaskTitle,
  isPendingConfirmTaskTitle,
} from "../src/step-flow.ts";
import type { HumanTaskDto } from "../src/types.ts";

/**
 * 模板标题 ↔ 代码判据的耦合。
 *
 * StepFlow 靠 `title.includes(...)` 认出几类特殊人工事项（付费墙挂「待获取」折叠、
 * 待确认挂 pending 清单、EndNote 走同步入口）。这些标题定义在 pipeline-presets.ts 里，
 * 判据定义在 step-flow.ts 里，两者之间没有任何东西保证它们还对得上——
 * 而 `tests/step-flow.test.ts` 用的是**手写字面量**（"下载付费墙文献全文"），
 * 所以把模板里的标题改个词，手写测试照样绿，只是界面上那几个入口悄悄消失了。
 *
 * 这里遍历**真实模板**断言耦合仍在。改标题就得同时改判据，否则这条测试红。
 */

/** 模板里的全部人工事项，带出处便于失败时定位 */
function allHumanTasks(): { where: string; task: HumanTaskDto }[] {
  const out: { where: string; task: HumanTaskDto }[] = [];
  for (const tpl of PIPELINE_TEMPLATES) {
    for (const step of tpl.steps) {
      for (const task of step.humanTasks ?? []) {
        out.push({ where: `${tpl.id} / ${step.name}`, task });
      }
    }
  }
  return out;
}

const TASKS = allHumanTasks();

test("模板人工事项非空（防止结构变化导致整组断言空跑）", () => {
  assert.ok(
    TASKS.length > 20,
    `只收不到 ${TASKS.length} 条人工事项，模板结构变了或 humanTasks 改名了`,
  );
});

test("付费墙事项：每个带「付费」的模板标题都被判据认出", () => {
  const expected = TASKS.filter(({ task }) => task.title.includes("付费"));
  assert.ok(expected.length > 0, "模板里没有付费墙事项了，判据可以删");
  for (const { where, task } of expected) {
    assert.equal(
      isPaywallTaskTitle(task.title),
      true,
      `${where} 的「${task.title}」认不出来了——「待获取」折叠入口会消失`,
    );
  }
});

test("EndNote 事项：每个带 EndNote 的模板标题都被判据认出", () => {
  const expected = TASKS.filter(({ task }) => /endnote/i.test(task.title));
  assert.ok(expected.length > 0, "模板里没有 EndNote 事项了，判据可以删");
  for (const { where, task } of expected) {
    assert.equal(
      isEndnoteTaskTitle(task.title),
      true,
      `${where} 的「${task.title}」认不出来了——同步入口会消失`,
    );
  }
});

test("待确认判据：认出文献核对事项，且不误伤把「待确认」当术语的数据类事项", () => {
  const lit = TASKS.filter(({ task }) =>
    task.title.includes("待确认") && !/[「『\[【]待确认[」』\]】]/.test(task.title),
  );
  assert.ok(lit.length > 0, "找不到文献核对事项，判据与模板都变了");
  for (const { where, task } of lit) {
    assert.equal(isPendingConfirmTaskTitle(task.title), true, `${where} 的「${task.title}」漏认`);
  }

  // 这几个是 data-processing 的必办事项，把「待确认」当正文术语用。
  // 旧实现（纯 includes）会把它们判成文献篇目核对，挂上不该有的 pending 清单。
  const glossary = TASKS.filter(({ task }) => /[「『\[【]待确认[」』\]】]/.test(task.title));
  assert.ok(glossary.length > 0, "数据类模板不再用 [待确认] 术语了，这条豁免可以收掉");
  for (const { where, task } of glossary) {
    assert.equal(
      isPendingConfirmTaskTitle(task.title),
      false,
      `${where} 的「${task.title}」被误判成文献核对事项`,
    );
  }
});

test("三类判据互不串味：同一标题不会同时算付费墙与待确认", () => {
  for (const { where, task } of TASKS) {
    const n = [
      isPaywallTaskTitle(task.title),
      isPendingConfirmTaskTitle(task.title),
      isEndnoteTaskTitle(task.title),
    ].filter(Boolean).length;
    assert.ok(n <= 1, `${where} 的「${task.title}」同时命中 ${n} 类判据`);
  }
});
