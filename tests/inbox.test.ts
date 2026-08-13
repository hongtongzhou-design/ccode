import assert from "node:assert/strict";
import test from "node:test";
import {
  groupInbox,
  helpNotifyKeys,
  helpPreview,
  helpSignature,
  inboxCategoryOf,
  inboxCategoryLabel,
  isHelpDismissed,
  parseHelpDismissed,
} from "../src/inbox.ts";

test("inboxCategoryOf：key 前缀推导类别，confirm: 与 live: 合并为待确认", () => {
  assert.equal(inboxCategoryOf("conflict:ws-1"), "conflict");
  assert.equal(inboxCategoryOf("confirm:tab-1"), "confirm");
  assert.equal(inboxCategoryOf("live:claude:s-1"), "confirm");
  assert.equal(inboxCategoryOf("ready:ws-2"), "ready");
  assert.equal(inboxCategoryOf("artifacts:ws-3"), "artifacts");
  assert.equal(inboxCategoryOf("digest"), "digest");
  assert.equal(inboxCategoryOf("profile:p-1"), "profile");
  assert.equal(inboxCategoryOf("help:/repo/root"), "help");
});

test("inboxCategoryOf：未知前缀回落待确认（不静默丢失）", () => {
  assert.equal(inboxCategoryOf("whatever"), "confirm");
});

test("inboxCategoryLabel：七类中文标签齐备", () => {
  assert.deepEqual(
    [
      "conflict",
      "confirm",
      "ready",
      "artifacts",
      "digest",
      "profile",
      "help",
    ].map((c) => inboxCategoryLabel(c as Parameters<typeof inboxCategoryLabel>[0])),
    ["冲突", "待确认", "可合并", "待核验", "待发送", "配置失效", "人工请求"],
  );
});

test("groupInbox：固定顺序、空类不返回、类内保持原顺序", () => {
  const items = [
    { key: "ready:ws-2" },
    { key: "conflict:ws-1" },
    { key: "confirm:tab-1" },
    { key: "help:/r1" },
    { key: "live:claude:s-1" },
    { key: "ready:ws-3" },
  ];
  const groups = groupInbox(items);
  assert.deepEqual(
    groups.map((g) => [g.category, g.label, g.items.map((it) => it.key)]),
    [
      ["conflict", "冲突", ["conflict:ws-1"]],
      ["confirm", "待确认", ["confirm:tab-1", "live:claude:s-1"]],
      ["ready", "可合并", ["ready:ws-2", "ready:ws-3"]],
      ["help", "人工请求", ["help:/r1"]],
    ],
  );
});

test("groupInbox：全空返回空数组", () => {
  assert.deepEqual(groupInbox([]), []);
});

test("helpSignature：join 口径稳定，内容变化签名即变", () => {
  assert.equal(helpSignature(["甲", "乙"]), "甲|乙");
  assert.notEqual(helpSignature(["甲", "乙"]), helpSignature(["甲", "乙丙"]));
  assert.equal(helpSignature([]), "");
});

test("isHelpDismissed：签名一致才算屏蔽；内容变了自动复现", () => {
  const dismissed = { "/repo": "甲|乙" };
  assert.equal(isHelpDismissed(dismissed, "/repo", "甲|乙"), true);
  assert.equal(isHelpDismissed(dismissed, "/repo", "甲|乙|丙"), false);
  assert.equal(isHelpDismissed(dismissed, "/other", "甲|乙"), false);
});

test("parseHelpDismissed：坏 JSON / 非对象 / 非字符串值容错为空表", () => {
  assert.deepEqual(parseHelpDismissed(null), {});
  assert.deepEqual(parseHelpDismissed(""), {});
  assert.deepEqual(parseHelpDismissed("not json"), {});
  assert.deepEqual(parseHelpDismissed('["/a"]'), {});
  assert.deepEqual(parseHelpDismissed('{"a":"sig","b":1,"c":null}'), {
    a: "sig",
  });
});

test("helpPreview：40 字截断，超出加省略号", () => {
  assert.equal(helpPreview("短句"), "短句");
  const exact = "字".repeat(40);
  assert.equal(helpPreview(exact), exact);
  assert.equal(helpPreview(`${exact}多`), `${exact}…`);
});

test("helpNotifyKeys：首轮基线不通知（prev null）", () => {
  assert.deepEqual(helpNotifyKeys(null, ["help:/a"], new Map(), 1000), []);
});

test("helpNotifyKeys：新 root edge-trigger，已存在的不重复通知", () => {
  const prev = new Set(["help:/a"]);
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/a", "help:/b"], new Map(), 1000),
    ["help:/b"],
  );
});

test("helpNotifyKeys：同一 root 30 秒去抖，窗口外放行", () => {
  const prev = new Set<string>();
  const lastSentAt = new Map([["help:/a", 10_000]]);
  // 10s 后再出现：去抖抑制
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/a"], lastSentAt, 20_000),
    [],
  );
  // 恰好满 30s：放行
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/a"], lastSentAt, 40_000),
    ["help:/a"],
  );
  // 从未通知过的 root：立即放行
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/b"], lastSentAt, 20_000),
    ["help:/b"],
  );
});
