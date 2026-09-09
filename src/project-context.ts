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
  accepted?: readonly (string | AcceptedGoalPack)[];
  openGoals?: readonly string[];
  protectedPaths?: readonly string[];
  decisions?: readonly string[];
  feedback?: string | null;
};

export function projectHomeHint(workMode?: string | null): string[] {
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

/** 启动注入用的项目环境说明。纯函数；有流程开工的 TASK.md 仍走 renderTaskMd。 */
export function renderProjectContextPack(input: ProjectContextInput): string {
  const mode = normalizeWorkMode(input.workMode);
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
  const home = projectHomeHint(mode);
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
  const protectedPaths = uniqueRuleLines(input.protectedPaths ?? []);
  if (protectedPaths.length) {
    lines.push(
      "",
      "这些保持原样（验收写回时不改、不另存）：",
      ...protectedPaths.map((path) => `- ${path}`),
    );
  }
  const goal = input.goal?.trim();
  if (goal) {
    lines.push("", "当前目标：", goal);
  }
  const accepted = (input.accepted ?? [])
    .map((item) => formatAcceptedGoalLine(item))
    .filter(Boolean);
  if (accepted.length) {
    lines.push("", "已经验收过：", ...accepted.slice(0, 8));
  }
  const openGoals = uniqueRuleLines(input.openGoals ?? []).slice(0, 8);
  if (openGoals.length) {
    lines.push("", "尚未完成：", ...openGoals.map((item) => `- ${item}`));
  }
  const feedback = input.feedback?.trim();
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
