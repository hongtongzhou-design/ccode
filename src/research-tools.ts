import type { ProjectStepDto } from "./types";

export interface ResearchTools {
  libraryExport: "none" | "zotero" | "endnote";
  plotting: "python" | "origin";
  illustration: "none" | "blender";
  manuscript: "markdown" | "latex" | "word";
}
export const DEFAULT_RESEARCH_TOOLS: ResearchTools = {
  libraryExport: "none", plotting: "python", illustration: "none", manuscript: "markdown",
};
export const RESEARCH_TOOL_FIELDS = [
  { key: "libraryExport", label: "文献库", options: [["none", "不使用"], ["zotero", "Zotero"], ["endnote", "EndNote"]] },
  { key: "plotting", label: "数值图", options: [["python", "Python"], ["origin", "Origin（Windows）"]] },
  { key: "illustration", label: "结构 / 装置示意", options: [["none", "不需要"], ["blender", "Blender"]] },
  { key: "manuscript", label: "稿件载体", options: [["markdown", "Markdown / Quarto"], ["latex", "LaTeX（原生源码）"], ["word", "已有 Word（人工插件验收）"]] },
] as const;
export type ResearchToolField = (typeof RESEARCH_TOOL_FIELDS)[number];
const PREFIX = "科研工具/";
/** 已废除的「文献主来源」设置键：来源只认 lit_source，写回时剥掉以免双源。 */
const LITERATURE_SETTING = `${PREFIX}literature：`;
export function researchToolsFromSettings(settings: readonly string[] = []): ResearchTools {
  const result = { ...DEFAULT_RESEARCH_TOOLS };
  for (const field of RESEARCH_TOOL_FIELDS) {
    const value = settings.find((s) => s.startsWith(`${PREFIX}${field.key}：`))?.split("：").slice(1).join("：");
    if (field.options.some(([key]) => key === value)) Object.assign(result, { [field.key]: value });
  }
  return result;
}
export function settingsWithResearchTools(settings: readonly string[], tools: ResearchTools): string[] {
  return [...settings.filter((s) => !s.startsWith(LITERATURE_SETTING) && !RESEARCH_TOOL_FIELDS.some((f) => s.startsWith(`${PREFIX}${f.key}：`))),
    ...RESEARCH_TOOL_FIELDS.filter((f) => tools[f.key] !== DEFAULT_RESEARCH_TOOLS[f.key]).map((f) => `${PREFIX}${f.key}：${tools[f.key]}`)];
}
function stepTakesReading(step: Pick<ProjectStepDto, "skills">): boolean {
  return step.skills.some((s) => s === "lit-search" || s === "lit-notes");
}
function stepTakesLibraryExport(step: Pick<ProjectStepDto, "skills" | "workspaceName">): boolean {
  // 文献库是 Zotero 与 EndNote 的同一种选择，挂在有定稿交接或精读的流程上。
  if (step.skills.includes("lit-notes")) return true;
  return step.workspaceName === "submission-materials"
    || step.workspaceName === "journal-format"
    || /^rebuttal-r\d+$/.test(step.workspaceName ?? "");
}
/** 流程线只在没有精读的投稿链上问 EndNote。Zotero 进库不是设定，是检索步待获取里的「同步到 Zotero」。 */
function stepAsksLibraryExport(step: Pick<ProjectStepDto, "skills" | "workspaceName">): boolean {
  if (step.skills.includes("lit-notes")) return false;
  return step.workspaceName === "submission-materials"
    || step.workspaceName === "journal-format"
    || /^rebuttal-r\d+$/.test(step.workspaceName ?? "");
}
function stepTakesPlotting(step: Pick<ProjectStepDto, "skills">): boolean {
  return step.skills.some((s) => s === "figure-forge" || s === "data-eda");
}
function stepTakesIllustration(step: Pick<ProjectStepDto, "workspaceName">): boolean {
  return step.workspaceName === "methodology" || step.workspaceName === "exp-design";
}
function stepTakesEndnoteCite(step: Pick<ProjectStepDto, "workspaceName">): boolean {
  const name = step.workspaceName ?? "";
  return (
    name === "polish" ||
    name === "research-paper-polish" ||
    name === "thesis-final" ||
    name === "journal-format"
  );
}
function stepTakesManuscript(step: Pick<ProjectStepDto, "name" | "workspaceName">): boolean {
  return /论文|初稿|定稿|格式|投稿|回复/.test(step.name)
    || step.workspaceName === "journal-format"
    || step.workspaceName === "submission-materials"
    || /^rebuttal-r\d+$/.test(step.workspaceName ?? "");
}
/** 真正换正式稿输入/产物的步骤；综述/论文写作步只加说明，不在这里问载体。 */
function stepAsksManuscript(step: Pick<ProjectStepDto, "workspaceName">): boolean {
  return step.workspaceName === "journal-format"
    || step.workspaceName === "submission-materials"
    || /^rebuttal-r\d+$/.test(step.workspaceName ?? "");
}
/** 选定模板后只出示与这套步骤有关的工具字段；文献来源不在此列。 */
export function researchToolFieldsForSteps(steps: readonly ProjectStepDto[]): ResearchToolField[] {
  return RESEARCH_TOOL_FIELDS.filter((field) => steps.some((step) => {
    if (field.key === "libraryExport") return stepTakesLibraryExport(step);
    if (field.key === "plotting") return stepTakesPlotting(step);
    if (field.key === "illustration") return stepTakesIllustration(step);
    return stepTakesManuscript(step);
  }));
}
function stepMatchesAsk(field: ResearchToolField, step: Pick<ProjectStepDto, "name" | "workspaceName" | "skills" | "expectedArtifacts">): boolean {
  if (field.key === "libraryExport") return stepAsksLibraryExport(step);
  if (field.key === "plotting") return stepTakesPlotting(step);
  if (field.key === "illustration") return stepTakesIllustration(step);
  return stepAsksManuscript(step);
}
/** 流程线上问这一项的那一步：整条流程里第一个用得上的步骤。稿件载体只问会换正式稿的步骤。 */
export function researchToolAskFieldsForStep(
  step: Pick<ProjectStepDto, "name" | "workspaceName" | "skills" | "expectedArtifacts">,
  steps: readonly ProjectStepDto[],
): ResearchToolField[] {
  return RESEARCH_TOOL_FIELDS.filter((field) => {
    if (!stepMatchesAsk(field, step)) return false;
    const first = steps.find((s) => stepMatchesAsk(field, s));
    return first?.name === step.name;
  });
}
const START = "<!-- mesa-research-tools ";
const END = "<!-- /mesa-research-tools -->";

/** 本步合同实际要写的文件。没有工具段时返回 undefined，检查回落到技能声明。 */
export function researchToolArtifacts(brief: string): string[] | undefined {
  const start = brief.indexOf(START);
  const end = brief.indexOf(END, start);
  if (start < 0 || end < start) return undefined;
  const header = brief.indexOf(" -->", start);
  if (header < 0 || header > end) return undefined;
  try {
    const saved = JSON.parse(brief.slice(start + START.length, header)) as {
      artifacts?: string[];
    };
    return saved.artifacts ?? [];
  } catch {
    return undefined;
  }
}
interface Added {
  skills: string[]; required: string[]; artifacts: string[]; human: string[];
  replaced?: Partial<Record<"inputs" | "anyOfInputs" | "expectedArtifacts" | "run" | "skills" | "requiredSkills", { before: unknown; after: unknown }>>;
}

/** Only remove additions recorded by this function; manual skills and other brief sections survive.
 *  文献同步技能跟 `lit_source`（流程线「确定文献来源」），不跟已废除的 settings literature。 */
export function withResearchTools(source: ProjectStepDto, tools: ResearchTools, artifactDir = "artifacts", litSource = "search"): ProjectStepDto {
  const step = { ...source, skills: [...source.skills], requiredSkills: [...(source.requiredSkills ?? source.skills)], expectedArtifacts: [...source.expectedArtifacts], humanTasks: [...(source.humanTasks ?? [])] };
  const start = step.brief.indexOf(START);
  const end = step.brief.indexOf(END, start);
  if ((start >= 0) !== (end >= 0)) throw new Error("工具合同标记不完整，未覆盖原内容");
  if (start >= 0 && end >= start) {
    try {
      const header = step.brief.indexOf(" -->", start);
      const old: Added = JSON.parse(step.brief.slice(start + START.length, header));
      for (const [key, value] of Object.entries(old.replaced ?? {})) {
        if (JSON.stringify(step[key as keyof typeof step] ?? null) !== JSON.stringify(value.after ?? null)) {
          throw new Error("原生稿件交付已被手工修改，请先保留副本再切换载体");
        }
        Object.assign(step, { [key]: value.before });
      }
      step.skills = step.skills.filter((s) => !old.skills.includes(s));
      step.requiredSkills = step.requiredSkills.filter((s) => !old.required.includes(s));
      step.expectedArtifacts = step.expectedArtifacts.filter((s) => !old.artifacts.includes(s));
      step.humanTasks = step.humanTasks.filter((h) => !old.human.includes(h.title));
      step.brief = step.brief.slice(0, start).trimEnd() + step.brief.slice(end + END.length);
    } catch { throw new Error("工具合同记录损坏，请先在步骤简报中修复；未覆盖原内容"); }
  }
  const added: Added = { skills: [], required: [], artifacts: [], human: [] };
  const notes: string[] = [];
  const mount = (skill: string, artifacts: string[], note: string, human?: string, optional = false) => {
    if (!step.skills.includes(skill)) { step.skills.push(skill); added.skills.push(skill); }
    if (!step.requiredSkills.includes(skill)) { step.requiredSkills.push(skill); added.required.push(skill); }
    for (const path of artifacts) if (!step.expectedArtifacts.includes(path)) { step.expectedArtifacts.push(path); added.artifacts.push(path); }
    if (human && !step.humanTasks.some((h) => h.title === human)) {
      step.humanTasks.push({ title: human, guidance: note, target: "", timing: "after", completion: "manual", optional: optional || undefined });
      added.human.push(human);
    }
    notes.push(note);
  };
  const reading = stepTakesReading(step);
  const figures = stepTakesPlotting(step);
  const illustration = stepTakesIllustration(step);
  const lit = litSource.trim();
  if (reading && (lit === "zotero" || tools.libraryExport === "zotero")) {
    mount("zotero-sync", ["papers/zotero-sync.md"], "Zotero：导入用「从 Zotero 导入」（只读，不 POST）。用户若把 PDF 拖进 Zotero，它会检索元数据并生成条目，拖完再导入。未使用 Zotero 的项目不要走这条，题录直接写入 references.bib。同步用待获取清单「同步到 Zotero」或拖 to-fetch.ris。已有主 bib 键不改。交付在定稿，交 output/zotero.rtf。");
  }
  if (reading && (lit === "endnote" || tools.libraryExport === "endnote")) {
    mount("endnote-bridge", ["papers/endnote-import.ris"], "EndNote：导入是把导出的 XML/RIS 放进 papers/imports/，不读 .enl。同步用待获取清单「同步到 EndNote」，从 references.bib 生成导入文件。交付在定稿，交 output/endnote.docx。");
  }
  const outputRoot = artifactDir.replace(/\\/g, "/").replace(/\/+$/, "") || "artifacts";
  if ((tools.plotting === "origin" || tools.illustration === "blender") && (outputRoot.startsWith("/") || outputRoot.includes(":") || outputRoot.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error("科研工具工程文件必须写入工作区内的相对产物目录");
  }
  if (tools.plotting === "origin" && figures) {
    mount("origin-plot", ["analysis/plot_origin.py", "figures/origin-manifest.json", "figures/origin-plot.png", `${outputRoot}/origin/project.opju`], `Origin：只在 Windows + 有许可证的 Origin 执行，缺能力停止该工具工作，不偷换 matplotlib。stats-check 定统计口径，figure-forge 定图型规格，Origin 只驱动。脚本与数值结果可复算，figures/origin-plot.png 及 ${outputRoot}/origin/project.opju 工程逐项登记哈希/版本/命令。`, "重开 Origin 工程并核对数值、坐标与图形");
  }
  if (tools.illustration === "blender" && illustration) {
    mount("blender-research", ["analysis/build_scene.py", "figures/blender-manifest.json", "figures/blender-schematic.png", `${outputRoot}/blender/scene.blend`], `Blender：仅用于本步明确的结构/装置/机制示意；不把示意冒充实验观测。先确认真实尺寸、单位、来源/许可与不按比例部分。MCP 无 OS 沙箱，使用新建受控工程；交付脚本、${outputRoot}/blender/scene.blend、figures/blender-schematic.png 和 manifest，后台重建失败非零退出。`, "核对 Blender 结构、比例、来源和示意标注");
  }
  if ((tools.libraryExport === "endnote" || tools.libraryExport === "zotero") && stepTakesEndnoteCite(step) && tools.manuscript !== "latex") {
    const md =
      step.workspaceName === "research-paper-polish"
        ? "manuscript/paper-final.md"
        : step.workspaceName === "thesis-final"
          ? "manuscript/thesis-final.md"
          : step.workspaceName === "journal-format"
            ? "submission/formatted.md"
            : "manuscript/review-final.md";
    if (tools.libraryExport === "zotero") {
      mount(
        "zotero-sync",
        ["output/zotero.rtf", "papers/zotero-import.ris"],
        `Zotero 交稿：用技能 scripts/zotero_rtf.py 从 ${md} 的 [@键] 写出 output/zotero.rtf 和 papers/zotero-import.ris。未匹配键不交稿。不点 Zotero 插件。库里还没有这些文献时，先导入这份 RIS；然后对 zotero.rtf 做一次 RTF Scan，再换引用样式。`,
        "导入 RIS 并对 Zotero 稿做一次 RTF Scan",
      );
    } else {
      mount(
        "endnote-bridge",
        ["output/endnote.docx", "papers/endnote-cite-report.md"],
        `EndNote 交稿：用技能 scripts/cite_docx.py 从 ${md} 的 [@键] 写出 output/endnote.docx（真正的 ADDIN EN.CITE，带 traveling library）。未匹配键只写 papers/endnote-cite-report.md、不交 docx。不覆盖 manuscript/source.docx，不点 Word 插件。人打开域稿后 Update Citations and Bibliography，再换 Output Style。`,
        "打开 EndNote 域稿并 Update 一次",
      );
    }
  }
  if (tools.manuscript !== "markdown" && /论文|初稿|定稿|格式|投稿|回复/.test(step.name)) {
    notes.push(tools.manuscript === "latex"
      ? "稿件以 LaTeX 原生源码为最终载体：已有稿先保留来源与版本，本步 md 是内容/审查交付；定稿须通过 LaTeX 模板编译并交付源码包与图源。不得把 Markdown 的完成状态当成 TeX 版面验收。"
      : "稿件以已有 Word 原件为最终载体：本步 Markdown/Quarto 输出只作建议稿或审查材料，不覆盖 source.docx。EndNote 域稿另写 output/endnote.docx，不往 source.docx 里塞假域。由人将变更应用至原件、刷新引用插件并核对最终 PDF 后才提交。");
  }
  // 原生稿件分支有自己的正式交付；不把适配说明的 Quarto 输出当投稿稿。
  const revision = /^rebuttal-r(\d+)$/.exec(step.workspaceName ?? "");
  if (tools.manuscript !== "markdown" && (step.workspaceName === "journal-format" || revision)) {
    const replace = (key: keyof NonNullable<Added["replaced"]>, value: unknown) => {
      (added.replaced ??= {})[key] = { before: step[key] ?? null, after: value };
      Object.assign(step, { [key]: value });
    };
    const round = revision ? Number(revision[1]) : null;
    const native = tools.manuscript === "latex";
    const input = round && round > 1
      ? native ? `submission/latex-r${round - 1}/main.tex` : `manuscript/revised-r${round - 1}.docx`
      : native ? "manuscript/main.tex" : "manuscript/source.docx";
    const nativeOutput = native ? `submission/latex${round ? `-r${round}` : ""}/main.tex`
      : round ? `manuscript/revised-r${round}.docx` : "submission/formatted.docx";
    const pdf = round ? `output/revised-r${round}.pdf` : "output/formatted.pdf";
    replace("anyOfInputs", [[input]]);
    replace("expectedArtifacts", [...new Set([...step.expectedArtifacts.filter((p) => !(p.startsWith("output/") && /\.(pdf|docx)$/.test(p))), nativeOutput, pdf])]);
    replace("run", []);
    replace("skills", step.skills.filter((skill) => skill !== "quarto-render"));
    replace("requiredSkills", step.requiredSkills.filter((skill) => skill !== "quarto-render"));
    notes.push(`原生稿件正式交付：输入 ${input}；交付 ${nativeOutput} 与 ${pdf}。原简报的 Markdown 只保留修改/适配说明，不用 Quarto 将说明冒充正式稿；${native ? "将依赖的章节/bib/图按相对路径一起置于该轮源码包，使用期刊要求的 TeX 引擎编译并保存日志" : "在原 Word 稿的副本上人工应用建议并保留插件域，再由 Word 导出 PDF；未完成人工步骤就保持待审"}。不能用换后缀或重新生成普通 docx 替代。`);
    if (!step.humanTasks.some((h) => h.title === "核对原生稿件与正式 PDF")) {
      step.humanTasks.push({ title: "核对原生稿件与正式 PDF", guidance: "确认实际稿件、来源版本、图表和引用插件/TeX 引用，说明文档不是正式稿。", target: "", timing: "after", completion: "manual" });
      added.human.push("核对原生稿件与正式 PDF");
    }
  }
  if (tools.manuscript !== "markdown" && step.workspaceName === "submission-materials") {
    const native = tools.manuscript === "latex" ? "submission/latex/main.tex" : "submission/formatted.docx";
    const inputs = [...new Set([...(step.inputs ?? []), native, "output/formatted.pdf"])];
    (added.replaced ??= {}).inputs = { before: step.inputs ?? null, after: inputs };
    Object.assign(step, { inputs });
    notes.push(`投稿材料必须审阅 ${native} 和 output/formatted.pdf；submission/formatted.md 仅为适配说明，不是审稿正文。科学论断/图表/引用核对以原生稿件及实际 PDF 为准。`);
  }
  if (notes.length) step.brief = `${step.brief.trimEnd()}\n\n${START}${JSON.stringify(added)} -->\n本项目选定工具（优先于默认软件示例）：\n${notes.map((n) => `- ${n}`).join("\n")}\n${END}\n`;
  return step;
}

/** 旧 TASK 草稿优先于模板，但不能悄悄带着旧工具执行。只告警/阻止，不覆盖人写内容。 */
export function researchToolContractMatches(step: Pick<ProjectStepDto, "brief">, task: string): boolean {
  const block = (text: string) => {
    const begin = text.indexOf(START);
    if (begin < 0) return "";
    const end = text.indexOf(END, begin);
    return end < 0 ? null : text.slice(begin, end + END.length);
  };
  const expected = block(step.brief);
  return expected !== null && expected === block(task);
}
