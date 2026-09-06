import { WORK_MODE_LABEL, normalizeWorkMode } from "./work-mode.ts";

export type ContextPackEntry = {
  name: string;
  isDir: boolean;
};

export type ProjectContextInput = {
  name: string;
  path: string;
  workMode?: string | null;
  topic?: string | null;
  settings?: readonly string[];
  topLevel: readonly ContextPackEntry[];
  goal?: string | null;
  writeReview?: boolean;
};

const MODE_RULES: Record<string, string[]> = {
  research: [
    "优先使用项目里已有的文件，不要虚构文献。",
    "引用必须能追溯到项目中的来源。",
    "不要改用户没让动的原始数据。",
  ],
  office: ["不要删除已有文件。", "按项目里已有的文档风格写。"],
  coding: ["只改当前工作目录。", "不要切回主仓文件夹去改。"],
};

export function defaultContextRules(workMode?: string | null): string[] {
  return MODE_RULES[normalizeWorkMode(workMode)] ?? MODE_RULES.research;
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
  const settings = (input.settings ?? []).map((item) => item.trim()).filter(Boolean);
  const rules = [...defaultContextRules(mode), ...settings];
  if (rules.length) {
    lines.push("", "项目规则：", ...rules.map((rule, index) => `${index + 1}. ${rule}`));
  }
  const goal = input.goal?.trim();
  if (goal) {
    lines.push("", "当前目标：", goal);
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
