import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultScheduleName,
  followSkillName,
  scheduleSkillOptions,
} from "../src/schedule-skill.ts";

const skills = [
  { id: "lit-watch", name: "文献监控" },
  { id: "data-clean", name: "数据清洗" },
  { id: "review-writing", name: "综述写作" },
];

test("技能下拉：lit-watch 恒在最前，其余按库顺序", () => {
  const opts = scheduleSkillOptions(skills);
  assert.deepEqual(
    opts.map((o) => o.id),
    ["lit-watch", "data-clean", "review-writing"],
  );
  assert.equal(opts[0].name, "文献监控");
});

test("空技能库兜底：仍给出 lit-watch 选项，默认名不崩", () => {
  const opts = scheduleSkillOptions([]);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].id, "lit-watch");
  assert.equal(defaultScheduleName("lit-watch", []), "文献雷达");
  assert.equal(defaultScheduleName("data-clean", []), "data-clean");
});

test("默认任务名跟随技能", () => {
  assert.equal(defaultScheduleName("lit-watch", skills), "文献雷达");
  assert.equal(defaultScheduleName("data-clean", skills), "数据清洗");
  // 库里没有的技能兜底 id
  assert.equal(defaultScheduleName("ghost", skills), "ghost");
});

test("切换技能：未手改的名称跟随新默认，手改过的不覆盖", () => {
  // 未手改（仍是 lit-watch 默认名）→ 跟随
  assert.equal(
    followSkillName("文献雷达", "lit-watch", "data-clean", skills),
    "数据清洗",
  );
  // 空名 = 未手改 → 跟随
  assert.equal(followSkillName("", "lit-watch", "data-clean", skills), "数据清洗");
  // 手改过 → 保留
  assert.equal(
    followSkillName("我的雷达", "lit-watch", "data-clean", skills),
    "我的雷达",
  );
  // 从自定义技能切回 lit-watch：未手改 → 回到「文献雷达」
  assert.equal(
    followSkillName("数据清洗", "data-clean", "lit-watch", skills),
    "文献雷达",
  );
});
