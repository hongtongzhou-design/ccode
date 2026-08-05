import type { ProjectStepDto } from "./types";

/**
 * 默认科研流水线模板（§11.3 机制二、§11.4 P1b 首启引导轻量版）：
 * 步骤是写在 project.toml 里的可编辑预设，引擎不识别「文献/论文」语义。
 * 当前默认路径为英文综述（review）的常规写作流程；用户可在界面上逐步增删改。
 *
 * 简报写作约定（auto 权限模式可无人值守执行）：
 * - 输入写死：明确引用上一步产物路径（合并进 main 后新工作区自带），不让 Agent 猜；
 * - 决策写死：拿不准的场景给出确定规则（一律纳入/标注待确认），不留"自行判断"；
 * - 交付写死：产物路径、格式、完成标准逐项列出，与 expectedArtifacts 对应。
 * v1 只写模板骨架；演示数据与示例 PDF 属完整版首启引导，本批不做。
 */
export const DEFAULT_PIPELINE_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    workspaceName: "lit-search",
    brief:
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进筛选记录）执行：\n" +
      "1. 制定纳入/排除标准（年份、语言、来源级别、相关性），写进 papers/screening.md；\n" +
      "2. 检索候选文献（学术数据库/网络），每篇记录标题、作者、年份、来源、链接或 DOI；\n" +
      "3. 按标准逐条筛选，结果写入 papers/screening.md（含每篇的纳入/排除及理由）；拿不准相关性的一律纳入并标注「待确认」；\n" +
      "4. 纳入的文献清单写入 papers/included.md（一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI）。\n" +
      "完成标准：papers/screening.md 与 papers/included.md 均存在，每条记录无空缺字段（未知则标「待补」）。",
    expectedArtifacts: ["papers/"],
    skills: [],
    run: [],
  },
  {
    name: "文献精读与笔记",
    workspaceName: "lit-notes",
    brief:
      "输入：上一步产物 papers/included.md（已随 main 合并在本工作区内）。\n" +
      "1. 按 included.md 清单逐篇精读（先读「待确认」之外的纳入项；清单缺失或为空时在报告中说明并停止，不要自行换题）；\n" +
      "2. 每篇产出 notes/<序号-短标题>.md，固定结构：研究问题 / 方法 / 主要结果 / 局限 / 可引用点（原文关键句+页码或段落位置）；\n" +
      "3. 每篇在 references.bib 追加一条 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）；\n" +
      "4. 全文不可得时按摘要+可见元数据写笔记，并在笔记开头标注「仅摘要」。\n" +
      "完成标准：included.md 每篇都有对应笔记与 bib 条目；notes/ 与 references.bib 均已提交。",
    expectedArtifacts: ["notes/", "references.bib"],
    skills: [],
    run: [],
  },
  {
    name: "综述大纲",
    workspaceName: "outline",
    brief:
      "输入：notes/ 全部笔记与 references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 通读笔记，按主题聚类归纳研究现状的主要线索（方法/问题/结论的异同）；\n" +
      "2. 产出 outline.md：章节结构（引言 / 背景 / 主题各节 / 讨论 / 结论）、每节要点（3-6 条）、每节拟引用的 bib 键、分类框架的一句话说明；\n" +
      "3. 分类框架优先按主题聚类；主题过于发散时改按时间线；有分歧时选覆盖文献最多的框架，并在 outline.md 末尾记录取舍理由；\n" +
      "4. 只引用 references.bib 中存在的键，不为大纲新造引用。\n" +
      "完成标准：outline.md 结构完整、每节要点与引用键齐全、取舍理由已记录。",
    expectedArtifacts: ["outline.md"],
    skills: [],
    run: [],
  },
  {
    name: "综述初稿",
    workspaceName: "draft",
    brief:
      "输入：outline.md、notes/、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 按 outline.md 用规范学术英文撰写综述初稿，产出 manuscript/draft.md（目标 6000-8000 词，课题主题段另有约定时从其约定）；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献；\n" +
      "3. 图表以占位形式给出（「图 1：…（待绘制）」「表 1：…」），不虚构数据；\n" +
      "4. 没有文献支撑的论断不得下；必须保留的判断在句末标 [待核实]。\n" +
      "完成标准：manuscript/draft.md 覆盖大纲全部章节，引用键全部可在 references.bib 中解析。",
    expectedArtifacts: ["manuscript/"],
    skills: [],
    run: [],
  },
  {
    name: "润色与定稿",
    workspaceName: "polish",
    brief:
      "输入：manuscript/draft.md、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 语言润色：语法、用词、句式与段落衔接，保持学术语气；只改表达，不改学术观点；\n" +
      "2. 一致性核对：每个论断都有引用、每个 bib 条目都被引用（未用的在报告中列出）、图表占位编号连续；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "3. 产出 manuscript/review-final.md 定稿，并附 manuscript/changelog.md（逐条列出主要修改点）；\n" +
      "4. 文末 References 节按 references.bib 生成完整文献列表。\n" +
      "完成标准：review-final.md 无语法硬伤、引用闭环、changelog.md 已提交。",
    expectedArtifacts: ["manuscript/review-final.md"],
    skills: [],
    run: [],
  },
];

/** 资源类型中文标签（后端 type 值 → UI 文案） */
export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  paper: "论文",
  dataset: "数据",
  reference: "引文",
  other: "其他",
};

/** 一键开步预填的首条指令（TerminalPage 启动栏可编辑，留空不注入） */
export const DEFAULT_KICKOFF_PROMPT = "读 TASK.md，按简报开始执行";
