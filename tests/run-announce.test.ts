import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_ANNOUNCE_LINGER_MS,
  RUN_ANNOUNCE_MERGE_MS,
  announceLabel,
  announceLine,
  mergeAnnouncements,
  runFinished,
} from "../src/run-announce.ts";
import type { RunAnnouncement } from "../src/run-announce.ts";
import type { RunOverviewInput } from "../src/run-overview.ts";

function input(over: Partial<RunOverviewInput> = {}): RunOverviewInput {
  return {
    tabId: "t1",
    title: "镁硫电池 · Codex",
    agentId: "codex",
    model: "gpt-5",
    cwd: "/Users/me/proj",
    running: true,
    shell: false,
    attention: "working",
    ...over,
  };
}

function ann(over: Partial<RunAnnouncement> = {}): RunAnnouncement {
  return {
    kind: "run",
    outcome: "done",
    label: "镁硫电池",
    tabId: "t1",
    count: 1,
    at: 1000,
    ...over,
  };
}

test("播报时长与合并窗口独立于导航收起延时", () => {
  // 岛收起档位里有 0（立即），播报若跟随它就会被立刻清掉；
  // 这两个常量是内容节奏，不与导航配置挂钩。
  assert.equal(RUN_ANNOUNCE_LINGER_MS, 4000);
  assert.equal(RUN_ANNOUNCE_MERGE_MS, 1500);
  assert.ok(RUN_ANNOUNCE_LINGER_MS > RUN_ANNOUNCE_MERGE_MS);
});

test("首次上报建立基线，不播报", () => {
  assert.equal(runFinished(undefined, input({ attention: "done" })), null);
  assert.equal(runFinished(undefined, input({ running: false })), null);
});

test("working → done 播报跑完", () => {
  assert.equal(
    runFinished(input({ attention: "working" }), input({ attention: "done" })),
    "done",
  );
});

test("done 是粘性状态：重复上报只播一次", () => {
  assert.equal(
    runFinished(input({ attention: "done" }), input({ attention: "done" })),
    null,
  );
  assert.equal(
    runFinished(input({ attention: "done" }), input({ attention: null })),
    null,
  );
});

test("等确认不播报：那条走收件箱", () => {
  assert.equal(
    runFinished(input({ attention: "working" }), input({ attention: "confirm" })),
    null,
  );
});

test("运行中进程消失播报断开", () => {
  assert.equal(
    runFinished(
      input({ attention: "working", running: true }),
      input({ attention: null, running: false }),
    ),
    "failed",
  );
});

test("回落成 shell 不算断开", () => {
  assert.equal(
    runFinished(
      input({ attention: "working", running: true }),
      input({ attention: null, running: true, shell: true }),
    ),
    null,
  );
});

test("标签标题为空退回目录名", () => {
  assert.equal(announceLabel("  镁硫电池  ", "/a/b"), "镁硫电池");
  assert.equal(announceLabel("", "/Users/me/镁硫电池/"), "镁硫电池");
  assert.equal(announceLabel("", "D:\\work\\proj"), "proj");
  assert.equal(announceLabel("", ""), "终端");
});

test("同标签新播报顶掉旧的，不排队", () => {
  const first = ann({ at: 1000 });
  const second = ann({ at: 5000, count: 1 });
  assert.deepEqual(mergeAnnouncements([first], second, 5000), [second]);
});

test("窗口内同结局的不同标签合并成一条计数", () => {
  const a = ann({ tabId: "t1", at: 1000 });
  const b = ann({ tabId: "t2", at: 1200, label: "分子动力学" });
  const merged = mergeAnnouncements([a], b, 1300);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 2);
  assert.equal(merged[0].label, "分子动力学");
});

test("不同结局不互相吞并", () => {
  const done = ann({ tabId: "t1", outcome: "done", at: 1000 });
  const failed = ann({ tabId: "t2", outcome: "failed", at: 1200 });
  const merged = mergeAnnouncements([done], failed, 1300);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((m) => m.outcome), ["done", "failed"]);
  assert.equal(merged[0].count, 1);
});

test("超出合并窗口的旧条目不再被计入", () => {
  const old = ann({ tabId: "t1", at: 1000 });
  const fresh = ann({ tabId: "t2", at: 9000 });
  const merged = mergeAnnouncements([old], fresh, 9000);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].count, 1); // 旧的保持原样
  assert.equal(merged[1].count, 1);
});

test("休眠面文案：单条报名字，多条报个数", () => {
  assert.equal(announceLine(ann()), "镁硫电池 已跑完");
  assert.equal(announceLine(ann({ outcome: "failed" })), "镁硫电池 已断开");
  assert.equal(announceLine(ann({ count: 3 })), "3 个已跑完");
  assert.equal(announceLine(ann({ count: 2, outcome: "failed" })), "2 个已断开");
});
