import { WORK_MODE_LABEL, normalizeWorkMode } from "./work-mode.ts";

export type ContextPackEntry = {
  name: string;
  isDir: boolean;
};

export type AcceptedGoalPack = {
  name: string;
  outputs?: readonly string[];
  note?: string | null;
};

/** 项目技能在上下文包里的条目：digest = 库目录内容摘要（版本记录，审计 §4.9）。 */
export type ProjectSkillPack = {
  name: string;
  description?: string;
  digest?: string | null;
  inputs?: readonly string[];
  outputs?: readonly string[];
  /** true = 项目名单里有但技能库里没有（被删/未导入），如实标注不静默省略 */
  missing?: boolean;
  /** true = 本目标点名要用（新建目标时勾选）；false/缺省 = 项目技能池成员（可用但默认不用） */
  named?: boolean;
};

/** 有研究步骤的科研项目：技能以步骤挂载为准，不用项目技能池。
 *  无流程科研 / 办公 / 编程：池 + 目标点名。 */
export function projectUsesSkillPool(
  workMode?: string | null,
  stepCount = 0,
): boolean {
  return !(normalizeWorkMode(workMode) === "research" && stepCount > 0);
}

/** 「写回时跳过」是普通目标验收写回的合同。有研究步骤走评审合并，编程走工作树，界面都不展示。 */
export function projectShowsProtectedPaths(
  workMode?: string | null,
  stepCount = 0,
): boolean {
  const mode = normalizeWorkMode(workMode);
  if (mode === "coding") return false;
  return projectUsesSkillPool(mode, stepCount);
}

/** session = 项目页对话 / 问 AI（项目根，跟用户走）；goal = 隔离副本里的目标（验收后写回）。 */
export type ContextPackKind = "session" | "goal";

export function isGoalContextPack(
  kind?: ContextPackKind | null,
  writeReview?: boolean,
): boolean {
  return writeReview === true || kind !== "session";
}

export type ProjectContextInput = {
  name: string;
  path: string;
  workMode?: string | null;
  topic?: string | null;
  settings?: readonly string[];
  rulesOwned?: boolean;
  topLevel: readonly ContextPackEntry[];
  goal?: string | null;
  writeReview?: boolean;
  /** 缺省按目标包；会话入口必须显式传 session。验收后写入视为目标包。 */
  kind?: ContextPackKind;
  accepted?: readonly (string | AcceptedGoalPack)[];
  openGoals?: readonly string[];
  protectedPaths?: readonly string[];
  decisions?: readonly string[];
  feedback?: string | null;
  /** 项目长期知识（.ccode/memory.md 全文；只含人确认过的结论） */
  memory?: string | null;
  skills?: readonly ProjectSkillPack[];
};

export function projectHomeHint(
  workMode?: string | null,
  kind: ContextPackKind = "goal",
): string[] {
  if (kind === "session") {
    return [
      "这是项目里的对话，工作目录就是当前目录，不是隔离副本。",
      "按用户这次说的做；没说的不要自己开工，也不要套固定流程。",
    ];
  }
  const mode = normalizeWorkMode(workMode);
  if (mode === "office") {
    return [
      "按项目里已有的文档风格写。",
      "产出放到目标指定的路径；验收后才进项目。",
    ];
  }
  if (mode === "coding") {
    return ["只改当前工作树。", "不要切回主仓文件夹去改。"];
  }
  return [
    "按项目里已有的材料做。",
    "产出经人验收后才进项目。",
  ];
}

export function settingParts(line: string): { q: string; answer: string } {
  const src = line.trim();
  const i = src.indexOf("：");
  const j = i >= 0 ? i : src.indexOf(":");
  if (j < 0) return { q: src, answer: "" };
  return { q: src.slice(0, j).trim(), answer: src.slice(j + 1).trim() };
}

/** 「综述角度：（领域全景 / …）」这种空表格，不是已定规则。 */
export function isSettingPlaceholder(line: string): boolean {
  const { q, answer } = settingParts(line);
  if (q === line.trim()) return false;
  return (
    !answer ||
    (answer.startsWith("（") && answer.endsWith("）")) ||
    (answer.startsWith("(") && answer.endsWith(")"))
  );
}

function isFilledSettingLine(line: string): boolean {
  const { q, answer } = settingParts(line);
  return q !== line.trim() && !!answer && !isSettingPlaceholder(line);
}

/** Pack 里的「项目规则」：人改过就用档案卡；否则只带默认之外的设定。 */
export function packRuleLines(
  settings?: readonly string[] | null,
  workMode?: string | null,
  rulesOwned?: boolean,
): string[] {
  const saved = uniqueRuleLines(settings ?? []).filter(
    (line) => !isSettingPlaceholder(line),
  );
  if (rulesOwned) return saved;
  const defaults = new Set(defaultContextRules(workMode));
  return saved.filter((line) => !defaults.has(line));
}

const MODE_RULES: Record<string, string[]> = {
  research: [
    "优先使用项目里已有的文件。",
    "不要改用户没让动的文件。",
  ],
  office: ["不要删除已有文件。", "按项目里已有的文档风格写。"],
  coding: ["只改当前工作目录。", "不要切回主仓文件夹去改。"],
};

export function defaultContextRules(workMode?: string | null): string[] {
  return MODE_RULES[normalizeWorkMode(workMode)] ?? MODE_RULES.research;
}

export function uniqueRuleLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

/** 人改过规则就只用档案卡；没改过则：有流程纪律用流程的，没有才用工作方式默认条。
 *  空表格（「问题：（选项）」）不进 TASK.md / 环境包。 */
export function effectiveProjectRules(
  settings?: readonly string[] | null,
  workMode?: string | null,
  rulesOwned?: boolean,
): string[] {
  const saved = uniqueRuleLines(settings ?? []).filter(
    (line) => !isSettingPlaceholder(line),
  );
  if (rulesOwned) return saved;
  const globals = saved.filter(isFilledSettingLine);
  const custom = saved.filter((line) => !isFilledSettingLine(line));
  const base = custom.length ? custom : defaultContextRules(workMode);
  return uniqueRuleLines([...base, ...globals]);
}

export function formatAcceptedGoalLine(goal: string | AcceptedGoalPack): string {
  if (typeof goal === "string") return `- ${goal}（已接受）`;
  const name = goal.name.trim();
  const outputs = (goal.outputs ?? [])
    .map((item) => item.trim())
    .filter((item) => item && item !== ".");
  const note = goal.note?.trim() ?? "";
  if (!name && !outputs.length) return "";
  let line = name || outputs.join("、");
  if (name && outputs.length) line = `${name} → ${outputs.join("、")}`;
  line += "（已接受）";
  if (note) line += `；意见：${note}`;
  return `- ${line}`;
}

export function formatTopLevelMap(
  entries: readonly ContextPackEntry[],
  limit = 24,
): string[] {
  const visible = entries.filter(
    (entry) =>
      entry.name !== ".git" &&
      entry.name !== ".ccode" &&
      entry.name !== "node_modules" &&
      entry.name !== "target",
  );
  const shown = visible.slice(0, limit);
  const lines = shown.map((entry) =>
    entry.isDir ? `- ${entry.name}/` : `- ${entry.name}`,
  );
  if (visible.length > shown.length) {
    lines.push(`- … 还有 ${visible.length - shown.length} 项`);
  }
  return lines.length ? lines : ["- （顶层还没有文件）"];
}

const GOAL_SKILL_DISCIPLINE =
  "技能纪律：只做目标要求的事，范围以目标为准。只有「本目标点名要用的技能」才按其规范执行；项目技能池和其他技能只是可用工具，目标不需要就一个都不用。简单任务直接做完，不要自行引入额外流程、模板或重型技能（如文献检索/精读/综述流程）。";

const SESSION_SKILL_DISCIPLINE =
  "技能纪律：按用户这次说的做。技能是可用工具，没点名就不用。不要自行套文献检索、精读或综述流程。";

/** 启动注入用的项目环境说明。纯函数；有流程开工的 TASK.md 仍走 renderTaskMd。 */
export function renderProjectContextPack(input: ProjectContextInput): string {
  const mode = normalizeWorkMode(input.workMode);
  const isGoal = isGoalContextPack(input.kind, input.writeReview);
  const lines = [
    `你正在项目「${input.name.trim() || "未命名"}」中工作。`,
    `工作方式：${WORK_MODE_LABEL[mode]}`,
    `项目目录：${input.path}`,
    "",
    "项目里现有（顶层）：",
    ...formatTopLevelMap(input.topLevel),
  ];
  const topic = input.topic?.trim();
  if (topic) {
    lines.push("", "课题主题：", topic);
  }
  const home = projectHomeHint(mode, isGoal ? "goal" : "session");
  if (home.length) {
    lines.push("", "工作环境：", ...home.map((line) => `- ${line}`));
  }
  const rules = packRuleLines(input.settings, mode, input.rulesOwned);
  if (rules.length) {
    lines.push("", "项目规则：", ...rules.map((rule, index) => `${index + 1}. ${rule}`));
  }
  const decisions = uniqueRuleLines(input.decisions ?? []);
  if (decisions.length) {
    lines.push("", "人的决定：", ...decisions.map((item) => `- ${item}`));
  }
  const protectedPaths = isGoal
    ? uniqueRuleLines(input.protectedPaths ?? [])
    : [];
  if (protectedPaths.length) {
    lines.push(
      "",
      "写回时跳过：",
      ...protectedPaths.map((path) => `- ${path}`),
    );
  }
  const skills = isGoal ? (input.skills ?? []) : [];
  const namedSkills = skills.filter((skill) => skill.named);
  const poolSkills = skills.filter((skill) => !skill.named);
  const renderSkill = (skill: (typeof skills)[number]) => {
    if (skill.missing) {
      return `- ${skill.name}（未安装，可在技能页新建或导入）`;
    }
    const version = skill.digest ? `（版本 ${skill.digest.slice(0, 8)}）` : "";
    const desc = skill.description?.trim();
    const contract = [
      skill.inputs?.length ? `读取 ${skill.inputs.join("、")}` : "",
      skill.outputs?.length ? `产出 ${skill.outputs.join("、")}` : "",
    ]
      .filter(Boolean)
      .join("；");
    return `- ${skill.name}${version}${desc ? `：${desc}` : ""}${contract ? `（${contract}）` : ""}`;
  };
  if (namedSkills.length) {
    lines.push("", "本目标点名要用的技能（按其规范执行；开工时记录内容版本）：");
    for (const skill of namedSkills) lines.push(renderSkill(skill));
  }
  if (poolSkills.length) {
    lines.push("", "项目技能池（可用工具，列出 ≠ 要用；本目标没点名的默认不用）：");
    for (const skill of poolSkills) lines.push(renderSkill(skill));
  }
  // 技能分发在 CLI 全局目录里撤不掉；会话不列技能名单，只留一句别自行开工。
  lines.push("", isGoal ? GOAL_SKILL_DISCIPLINE : SESSION_SKILL_DISCIPLINE);
  const goal = isGoal ? input.goal?.trim() : undefined;
  if (goal) {
    lines.push("", "当前目标：", goal);
  }
  const memory = input.memory?.trim();
  if (memory) {
    const trimmed = memory.length > 6000 ? `${memory.slice(0, 6000)}\n…（已按最新有效知识优先；其余见 .ccode/memory.md，不应自行恢复已作废条目）` : memory;
    lines.push("", "项目长期知识（人确认过的结论，保持一致，不要与之矛盾）：", trimmed);
  }
  const accepted = (input.accepted ?? [])
    .map((item) => formatAcceptedGoalLine(item))
    .filter(Boolean);
  if (accepted.length) {
    lines.push("", "已经验收过：", ...accepted.slice(0, 8));
  }
  const openGoals = isGoal
    ? uniqueRuleLines(input.openGoals ?? []).slice(0, 8)
    : [];
  if (openGoals.length) {
    lines.push("", "尚未完成：", ...openGoals.map((item) => `- ${item}`));
  }
  const feedback = isGoal ? input.feedback?.trim() : undefined;
  if (feedback) {
    lines.push("", "上一版的修改意见：", feedback);
  }
  if (input.writeReview) {
    lines.push(
      "",
      "权限：只改当前工作目录。完成后不要修改项目原目录；改动会交给人验收再写回。",
    );
  }
  return lines.join("\n").trim();
}

export function composeLaunchPrompt(
  pack: string,
  userPrompt?: string | null,
): string {
  const body = userPrompt?.trim() ?? "";
  if (!pack.trim()) return body;
  if (!body) return pack;
  return `${pack}\n\n----\n\n${body}`;
}
