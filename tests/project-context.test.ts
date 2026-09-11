import test from "node:test";
import assert from "node:assert/strict";
import {
  composeLaunchPrompt,
  defaultContextRules,
  effectiveProjectRules,
  formatTopLevelMap,
  isGoalContextPack,
  isSettingPlaceholder,
  projectHomeHint,
  projectShowsProtectedPaths,
  projectUsesSkillPool,
  renderProjectContextPack,
} from "../src/project-context.ts";

test("research pack names the project, lists files, and states write-review", () => {
  const pack = renderProjectContextPack({
    name: "AI Agent 研究",
    path: "/Users/me/AI Agent 研究",
    workMode: "research",
    topic: "Agent 在软件工程中的应用",
    settings: ["引用必须可追溯"],
    topLevel: [
      { name: "papers", isDir: true },
      { name: "notes", isDir: true },
      { name: "README.md", isDir: false },
      { name: ".git", isDir: true },
    ],
    goal: "根据项目里的文献写综述",
    writeReview: true,
  });
  assert.match(pack, /AI Agent 研究/);
  assert.match(pack, /科研/);
  assert.match(pack, /papers\//);
  assert.doesNotMatch(pack, /\.git/);
  assert.match(pack, /课题主题/);
  assert.match(pack, /工作环境/);
  assert.match(pack, /按项目里已有的材料做/);
  assert.match(pack, /根据项目里的文献写综述/);
  assert.match(pack, /验收再写回/);
});

test("pack lists accepted goals and previous review notes", () => {
  const pack = renderProjectContextPack({
    name: "AI Agent 研究",
    path: "/p",
    workMode: "research",
    topLevel: [{ name: "papers", isDir: true }],
    goal: "补 Agentic Coding",
    accepted: [
      { name: "研究综述", outputs: ["论文/综述.md"] },
      "数据清洗",
    ],
    openGoals: ["设计实验"],
    protectedPaths: ["数据/raw"],
    feedback: "引用太少",
    writeReview: true,
  });
  assert.match(pack, /已经验收过/);
  assert.match(pack, /研究综述 → 论文\/综述.md（已接受）/);
  assert.match(pack, /尚未完成/);
  assert.match(pack, /设计实验/);
  assert.match(pack, /写回时跳过/);
  assert.match(pack, /数据\/raw/);
  assert.match(pack, /上一版的修改意见/);
  assert.match(pack, /引用太少/);
});

test("owned rules replace defaults instead of stacking them", () => {
  assert.match(
    effectiveProjectRules(["目标读者：专家"], "research", false).join("\n"),
    /不要改用户没让动的文件/,
  );
  assert.deepEqual(effectiveProjectRules(["只写中文"], "research", true), ["只写中文"]);
});

test("empty template forms are not rules", () => {
  assert.equal(
    isSettingPlaceholder("综述角度：（领域全景 / 聚焦某个子问题）"),
    true,
  );
  assert.equal(isSettingPlaceholder("优先使用项目里已有的文件。"), false);
  assert.equal(isSettingPlaceholder("综述角度：聚焦子问题"), false);
});

test("unanswered forms do not enter TASK.md rules", () => {
  const lines = effectiveProjectRules(
    [
      "综述角度：（领域全景 / 聚焦某个子问题）",
      "答辩时间：（倒推各章节的截止）",
      "数据敏感级别：（含个人信息 / 已脱敏 / 公开数据）",
    ],
    "research",
    false,
  );
  assert.deepEqual(lines, defaultContextRules("research"));
  assert.doesNotMatch(lines.join("\n"), /答辩时间/);
  assert.doesNotMatch(lines.join("\n"), /虚构文献/);
});

test("pipeline rules replace work-mode defaults instead of stacking every template", () => {
  const lines = effectiveProjectRules(
    [
      "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
      "引用必须能追溯到项目中的来源。",
      "综述角度：聚焦某个子问题",
      "查重目标：（如 ≤10%）",
    ],
    "research",
    false,
  );
  assert.deepEqual(lines, [
    "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
    "引用必须能追溯到项目中的来源。",
    "综述角度：聚焦某个子问题",
  ]);
});

test("non-pipeline research rules do not assume a literature review", () => {
  const lines = defaultContextRules("research");
  assert.deepEqual(lines, [
    "优先使用项目里已有的文件。",
    "不要改用户没让动的文件。",
  ]);
});

test("formatTopLevelMap caps long lists and marks empty trees", () => {
  assert.deepEqual(formatTopLevelMap([]), ["- （顶层还没有文件）"]);
  const many = Array.from({ length: 30 }, (_, index) => ({
    name: `f${index}`,
    isDir: false,
  }));
  const lines = formatTopLevelMap(many, 24);
  assert.equal(lines.length, 25);
  assert.match(lines[24], /还有 6 项/);
});

test("composeLaunchPrompt keeps pack and user text apart", () => {
  assert.equal(composeLaunchPrompt("PACK", ""), "PACK");
  assert.equal(composeLaunchPrompt("", "hello"), "hello");
  assert.equal(composeLaunchPrompt("PACK", "hello"), "PACK\n\n----\n\nhello");
});

test("pack splits named goal skills from project skill pool", () => {
  const pack = renderProjectContextPack({
    name: "数据分析",
    path: "/tmp/p",
    workMode: "research",
    topLevel: [],
    skills: [
      {
        name: "data-clean",
        description: "数据清洗规范",
        digest: "a1b2c3d4e5f6",
        inputs: ["data/"],
        outputs: ["artifacts/"],
        named: true,
      },
      { name: "lit-search", digest: "ff00ff00", named: false },
      { name: "ghost-skill", missing: true, named: false },
    ],
  });
  assert.match(pack, /本目标点名要用的技能（按其规范执行/);
  assert.match(pack, /data-clean（版本 a1b2c3d4）：数据清洗规范（读取 data\/；产出 artifacts\/）/);
  assert.match(pack, /项目技能池（可用工具，列出 ≠ 要用；本目标没点名的默认不用）/);
  assert.match(pack, /ghost-skill（未安装，可在技能页新建或导入）/);
  // 纪律线：只有点名的才执行
  assert.match(pack, /只有「本目标点名要用的技能」才按其规范执行/);
});

test("research pipeline does not use the project skill pool", () => {
  assert.equal(projectUsesSkillPool("research", 0), true);
  assert.equal(projectUsesSkillPool("research", 3), false);
  assert.equal(projectUsesSkillPool(undefined, 2), false);
  assert.equal(projectUsesSkillPool("office", 4), true);
  assert.equal(projectUsesSkillPool("coding", 0), true);
});

test("protected paths stay on goal-review surfaces only", () => {
  assert.equal(projectShowsProtectedPaths("research", 0), true);
  assert.equal(projectShowsProtectedPaths("research", 3), false);
  assert.equal(projectShowsProtectedPaths("office", 0), true);
  assert.equal(projectShowsProtectedPaths("coding", 0), false);
});

test("pack always carries skill discipline line against over-engineering", () => {
  const pack = renderProjectContextPack({
    name: "p",
    path: "/tmp/p",
    workMode: "research",
    topLevel: [],
  });
  // 没选技能也要有纪律线：技能分发在 CLI 全局目录，Agent 看得见
  assert.match(pack, /技能纪律：只做目标要求的事/);
  assert.match(pack, /不要自行引入额外流程、模板或重型技能/);
});

test("session pack follows the user instead of a goal brief", () => {
  const pack = renderProjectContextPack({
    name: "综述文献",
    path: "/Users/me/综述文献",
    workMode: "research",
    settings: ["优先使用项目里已有的文件，不要虚构文献。"],
    topLevel: [
      { name: "manuscript", isDir: true },
      { name: "notes", isDir: true },
    ],
    kind: "session",
    goal: "写一篇综述",
    openGoals: ["补实验设计"],
    protectedPaths: ["数据/raw"],
    skills: [{ name: "lit-search", named: false }],
    feedback: "引用太少",
    accepted: [{ name: "研究综述", outputs: ["论文/综述.md"] }],
  });
  assert.match(pack, /综述文献/);
  assert.match(pack, /这是项目里的对话/);
  assert.match(pack, /按用户这次说的做/);
  assert.match(pack, /技能纪律：按用户这次说的做/);
  assert.match(pack, /已经验收过/);
  assert.doesNotMatch(pack, /产出经人验收后才进项目/);
  assert.doesNotMatch(pack, /当前目标/);
  assert.doesNotMatch(pack, /尚未完成/);
  assert.doesNotMatch(pack, /写回时跳过/);
  assert.doesNotMatch(pack, /本目标点名/);
  assert.doesNotMatch(pack, /项目技能池/);
  assert.doesNotMatch(pack, /上一版的修改意见/);
  assert.doesNotMatch(pack, /只做目标要求的事/);
});

test("writeReview session still uses the goal pack", () => {
  const pack = renderProjectContextPack({
    name: "p",
    path: "/tmp/p",
    workMode: "research",
    topLevel: [],
    kind: "session",
    writeReview: true,
    goal: "落成稿",
  });
  assert.match(pack, /产出经人验收后才进项目/);
  assert.match(pack, /当前目标：/);
  assert.match(pack, /验收再写回/);
  assert.equal(isGoalContextPack("session", true), true);
  assert.equal(isGoalContextPack("session"), false);
  assert.equal(isGoalContextPack("goal"), true);
  assert.equal(isGoalContextPack(), true);
});

test("coding rules warn against writing the primary tree", () => {
  assert.match(defaultContextRules("coding").join("\n"), /主仓/);
  assert.match(projectHomeHint("office").join("\n"), /文档风格/);
});
