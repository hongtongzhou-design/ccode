import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_CAPS_FORM,
  capsFormFromOverride,
  capsFormIsEmpty,
  parseCapsOverrideForm,
} from "../src/model-caps-override.ts";

test("合法表单解析为覆盖字段（null = 未声明，不挡查询链）", () => {
  const r = parseCapsOverrideForm({
    context: " 1048576 ",
    thinking: "true",
    vision: "false",
  });
  assert.ok(r.ok);
  assert.deepEqual(r.fields, {
    thinking: true,
    context: 1048576,
    vision: false,
  });
});

test("非正整数被拒（与后端校验同口径）", () => {
  for (const bad of ["0", "-5", "3.5", "abc"]) {
    const r = parseCapsOverrideForm({ ...EMPTY_CAPS_FORM, context: bad });
    assert.ok(!r.ok, bad);
    assert.equal(r.error, "上下文窗口必须为正整数");
  }
});

test("全空表单＝清除信号", () => {
  assert.ok(capsFormIsEmpty(EMPTY_CAPS_FORM));
  assert.ok(!capsFormIsEmpty({ ...EMPTY_CAPS_FORM, vision: "false" }));
  assert.ok(!capsFormIsEmpty({ ...EMPTY_CAPS_FORM, context: "1" }));
});

test("覆盖条目往返表单初值", () => {
  const form = capsFormFromOverride({
    thinking: false,
    context: 262144,
    vision: true,
  });
  assert.deepEqual(form, {
    context: "262144",
    thinking: "false",
    vision: "true",
  });
  // 显式 false（声明不支持）不丢——它要挡查询链继续向下
  const back = parseCapsOverrideForm(form);
  assert.ok(back.ok);
  assert.equal(back.fields.thinking, false);
  assert.equal(back.fields.vision, true);
});
