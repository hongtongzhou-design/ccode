import { litSourceSectionLines } from "./task-md-sections.ts";
import { RESOURCE_TYPE_LABELS } from "./pipeline-presets.ts";
import type {
  ArtifactEntryDto,
  ProjectConfigDto,
  ProjectStepDto,
} from "./types.ts";

/** TASK.md 拼装单一出处：弹层预览与开工落盘共用。纯函数，不碰文件系统。 */
export function renderTaskMd(
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
  projectPath: string,
  artifacts?: ArtifactEntryDto[],
  skillMeta?: Record<string, string>,
  decisions?: { q: string; answer: string }[],
): string {
  const projectRoot = projectPath.replace(/[\\/]+$/, "");
  const lines = [`# ${step.name}`, "", `项目根：\`${projectRoot}\``, ""];
  const topic = cfg.topic?.trim();
  if (topic) {
    lines.push("## 课题主题", topic, "");
  }
  const globals = (cfg.settings ?? []).map((x) => x.trim()).filter(Boolean);
  if (globals.length > 0) {
    lines.push("## 全局设定", ...globals.map((x) => `- ${x}`), "");
  }
  const litLines = litSourceSectionLines(cfg.litSource);
  if (litLines) {
    lines.push(...litLines, "");
  }
  if (decisions && decisions.length > 0) {
    lines.push(
      "## 已定方向",
      ...decisions.map((d) => `- ${d.q}：${d.answer}`),
      "",
      "以上为人已拍板的口径，按此执行；与简报冲突时以本节为准。",
      "",
    );
  }
  const inputs = (step.inputs ?? []).map((x) => x.trim()).filter(Boolean);
  const optionalInputs = (step.optionalInputs ?? [])
    .map((x) => x.trim())
    .filter(Boolean);
  const anyOfInputs = (step.anyOfInputs ?? [])
    .map((group) => group.map((x) => x.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
  if (inputs.length > 0 || optionalInputs.length > 0 || anyOfInputs.length > 0) {
    lines.push(
      "## 本步骤输入",
      ...inputs.map((input) => `- 必需：${input}`),
      ...optionalInputs.map((input) => `- 可选：${input}`),
      ...anyOfInputs.map((group) => `- 任一：${group.join(" 或 ")}`),
      "按上述规则读取上游产物或项目资源；必需输入缺失时先在 .ccode/help-wanted.md 说明，不要猜测替代输入；可选输入缺失可继续，任一组满足一项即可。",
      "",
    );
  }
  lines.push(
    step.brief.trim() ||
      "（在 .ccode/project.toml 的 steps.brief 中补充本步骤任务简报）",
  );
  if (step.expectedArtifacts.length > 0) {
    lines.push(
      "",
      "## 预期产物",
      ...step.expectedArtifacts.map((a) => `- ${a}`),
    );
  }
  const acceptanceCriteria = (step.acceptanceCriteria ?? [])
    .map((x) => x.trim())
    .filter(Boolean);
  if (acceptanceCriteria.length > 0) {
    lines.push(
      "",
      "## 验收条件",
      ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
      "逐条核对上述条件；仅文件存在不代表内容合格。无法核对的项标记为待人工确认。",
    );
  }
  const humanTasks = step.humanTasks ?? [];
  if (humanTasks.length > 0) {
    lines.push("", "## 人工事项（由人完成，不要代做）");
    for (const h of humanTasks) {
      const when =
        h.timing === "before"
          ? "开始前"
          : h.timing === "after"
            ? "收尾"
            : "进行中";
      lines.push(
        `- [${when}] ${h.title}${h.target ? ` → 交付落点 \`${h.target}\`` : ""}` +
          `${h.optional ? "（可选）" : "（必办）"}` +
          ` · 完成判定：${
            h.completion === "manual"
              ? "人工确认"
              : h.completion === "all"
                ? `全部目标满足${h.expectedCount != null ? `（${h.expectedCount} 项）` : ""}`
                : h.completion === "no_placeholders"
                  ? "清除占位后完成"
                  : "落点出现"
          }`,
      );
    }
    lines.push(
      "上述事项由人完成，交付物会出现在对应落点路径；落点为空前请按既有内容推进可推进的部分。",
      "执行中若另需人协助（如补检索词、缺权限全文），把请求逐条写进 .ccode/help-wanted.md" +
        "（每条一行「- 」开头，附「若未回复则按 ×× 继续」的兜底方案），写完按兜底继续，不要停工等待。",
    );
  }
  if (step.skills.length > 0) {
    const required = new Set(step.requiredSkills ?? step.skills);
    lines.push("", "## 本步骤技能");
    for (const name of step.skills) {
      const prefix = required.has(name) ? "必需" : "可选";
      if (!skillMeta) {
        lines.push(`- ${prefix}：${name}`);
      } else if (name in skillMeta) {
        const desc = skillMeta[name];
        lines.push(desc ? `- ${prefix}：${name}：${desc}` : `- ${prefix}：${name}`);
      } else {
        lines.push(`- ${prefix}：${name}（未安装，可在技能页新建或导入）`);
      }
    }
    lines.push(
      "必需技能缺失时先记录帮助请求；可选技能缺失可继续，但不得假装已执行其检查。",
      "技能正文里的读取/产出路径若与本文件（预期产物、项目资源、验收条件）不一致，一律以本文件为准。",
    );
  }
  const boundPaths = step.resources ?? [];
  const resources =
    boundPaths.length > 0
      ? cfg.resources.filter((r) => boundPaths.includes(r.path))
      : cfg.resources;
  if (resources.length > 0) {
    lines.push("", "## 项目资源（只读引用，勿复制到本工作区）");
    for (const r of resources) {
      const abs = /^([a-zA-Z]:[\\/]|\/)/.test(r.path)
        ? r.path
        : `${projectRoot}/${r.path}`;
      const label = RESOURCE_TYPE_LABELS[r.type] ?? r.type;
      lines.push(
        `- [${label}] ${r.name}：${abs}${r.readonly ? "（只读）" : ""}`,
      );
    }
  }
  const inputPatterns = [
    ...(step.inputs ?? []),
    ...(step.optionalInputs ?? []),
    ...((step.anyOfInputs ?? []).flat()),
  ]
    .map((x) => x.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const wildcardMatches = (value: string, pattern: string) => {
    if (pattern.endsWith("/")) {
      const dir = pattern.replace(/\/+$/, "");
      return value === dir || value.startsWith(`${dir}/`);
    }
    const escaped = pattern.replace(/[.+^${}()|[\\]\\\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
  };
  const scopedArtifacts =
    inputPatterns.length === 0
      ? artifacts ?? []
      : (artifacts ?? []).filter((artifact) => {
          const path = artifact.path.replace(/\\/g, "/");
          const root = projectRoot.replace(/\\/g, "/");
          const relative = path.startsWith(`${root}/`)
            ? path.slice(root.length + 1)
            : path;
          const base = relative.split("/").pop() ?? relative;
          return inputPatterns.some(
            (pattern) =>
              wildcardMatches(relative, pattern) || wildcardMatches(base, pattern),
          );
        });
  if (scopedArtifacts && scopedArtifacts.length > 0) {
    lines.push("", "## 上一步产物（提货单）");
    for (const a of scopedArtifacts) {
      lines.push(
        `- ${a.name}：${a.path}（md5 ${a.hash.slice(0, 8)}，来自「${a.producedBy}」）`,
      );
    }
    lines.push(
      "产物文件按路径直接读取，勿复制；新产物请通过改动面板登记进提货单。",
    );
  }
  if (cfg.artifactDir?.trim()) {
    const artifactAbs = `${projectRoot}/${cfg.artifactDir.replace(/^[/\\]+/, "")}`;
    lines.push(
      "",
      "## 产物目录",
      `大型产物（清洗后数据、实验原始结果、渲染 PDF）写入 \`${artifactAbs}\`，文献 PDF 写入 \`${projectRoot}/papers/\`，渲染成品写入 \`${projectRoot}/output/\`。`,
      "这些路径都在项目根下，不要写本工作区、不要提交进 git。本工作区只提交源稿、脚本与清单。",
    );
  }
  lines.push(
    "",
    "## 收尾",
    "完成时把本步源稿、脚本与清单全部 git 提交——不提交，系统会认为这一步仍在进行中。",
    "PDF / 数据 / 渲染成品必须落在上方项目根对应目录；写在本工作区的，合并后下一步看不见。",
  );
  return `${lines.join("\n")}\n`;
}
