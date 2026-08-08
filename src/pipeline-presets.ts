import type { ProjectStepDto } from "./types";

/**
 * 内置流水线模板库（§11.3 机制二、§11.4 P1b 首启引导轻量版）：
 * 步骤是写在 project.toml 里的可编辑预设，引擎不识别「文献/论文」语义。
 * 五套内置模板覆盖综述/科研论文/数据处理/毕业论文/投稿与返修，新增场景 = PIPELINE_TEMPLATES 加一项；
 * 用户另存的模板由后端 list/save/delete_pipeline_template 管理，选择器中与本库合并展示。
 *
 * 简报写作约定（auto 权限模式可无人值守执行）：
 * - 输入写死：明确引用上一步产物路径（合并进 main 后新工作区自带），不让 Agent 猜；
 * - 决策写死：拿不准的场景给出确定规则（一律纳入/标注待确认），不留"自行判断"；
 * - 交付写死：产物路径、格式、完成标准逐项列出，与 expectedArtifacts 对应。
 * v1 只写模板骨架；演示数据与示例 PDF 属完整版首启引导，本批不做。
 */
export interface PipelineTemplateDef {
  id: string;
  name: string;
  description: string;
  steps: ProjectStepDto[];
}

/** 英文综述（review）：文献检索 → 精读笔记 → 大纲 → 初稿 → 润色定稿 */
const REVIEW_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    workspaceName: "lit-search",
    brief:
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进筛选记录）执行：\n" +
      "1. 制定纳入/排除标准（年份、语言、来源级别、相关性），写进 papers/screening.md；\n" +
      "2. 检索候选文献（学术数据库/网络），每篇记录标题、作者、年份、来源、链接或 DOI；\n" +
      "3. 按标准逐条筛选，结果写入 papers/screening.md（含每篇的纳入/排除及理由）；拿不准相关性的一律纳入并标注「待确认」；\n" +
      "4. 纳入的文献清单写入 papers/included.md（一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI）；\n" +
      "5. 全文获取分两类：开放获取（arXiv/PMC/开放期刊/作者主页 preprint）的用 WebFetch/curl 直接下载到 papers/ 目录（文件名规范化：作者年份-短标题.pdf）；付费墙的不得尝试绕过，在 included.md 该行末尾标注「需自行获取」，并汇总写入 papers/to-fetch.md（标题 — DOI），等用户提供全文。\n" +
      "完成标准：papers/screening.md、papers/included.md、papers/to-fetch.md 均存在（无付费文献则 to-fetch.md 注明为空），每条记录无空缺字段（未知则标「待补」）。",
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
      "2. 全文来源优先级：项目资源/papers/ 已有 PDF → 开放获取补下 → 仍缺（papers/to-fetch.md 中的付费文献）按摘要+可见元数据写笔记，并在笔记开头标注「仅摘要·待全文」；\n" +
      "3. 每篇产出 notes/<序号-短标题>.md，固定结构：研究问题 / 方法 / 主要结果 / 局限 / 可引用点（原文关键句+页码或段落位置）；\n" +
      "4. 每篇在 references.bib 追加一条 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）；\n" +
      "5. 若 notes/ 中「仅摘要」笔记对应的全文已出现在项目资源或 papers/（用户已补），重读全文并更新该笔记、去掉标记。\n" +
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

/** 科研论文（research-paper）：选题调研 → 实验设计 → 实验执行 → 结果分析 → 初稿 → 投稿准备 */
const RESEARCH_PAPER_STEPS: ProjectStepDto[] = [
  {
    name: "选题与文献调研",
    workspaceName: "lit-survey",
    brief:
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进调研报告）执行：\n" +
      "1. 检索并精读相关文献，按主题归纳研究现状，写入 survey/literature.md（每篇：研究问题 / 方法 / 主要结果 / 局限）；\n" +
      "2. 提炼 2-3 个候选研究问题，逐一分析现有工作的 gap（未解决的问题、方法的不足、数据的空白），写入 survey/gap-analysis.md；\n" +
      "3. 从候选中选定一个研究问题：优先选 gap 明确且数据/方法可支撑的；拿不准时选文献支撑最多的，并在报告中记录取舍理由；\n" +
      "4. 每条引用在 references.bib 追加 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）。\n" +
      "完成标准：survey/literature.md 与 survey/gap-analysis.md 均存在，研究问题明确唯一，references.bib 条目无空缺字段。",
    expectedArtifacts: ["survey/", "references.bib"],
    skills: [],
    run: [],
  },
  {
    name: "实验设计",
    workspaceName: "exp-design",
    brief:
      "输入：survey/gap-analysis.md 确定的研究问题（已随 main 合并在本工作区内）。\n" +
      "1. 产出 design.md，逐项写死：研究方法（技术路线与关键假设）、数据来源（名称/规模/获取方式）、对比基线（至少 2 个，注明出处）、评价指标（主指标+辅指标，给出计算公式或出处）、实验矩阵（变量 × 取值的完整组合表）；\n" +
      "2. 每个设计决策给出依据；依赖的资源（数据集/预训练模型）不可获取时换用公开替代品并标注，不留「待定」；\n" +
      "3. 估算每项实验的计算开销，超出本机条件的组合在矩阵中标注「裁剪」并说明裁剪规则；\n" +
      "4. design.md 末尾附风险清单：最可能失败的环节与备选方案。\n" +
      "完成标准：design.md 覆盖方法/数据/基线/指标/实验矩阵五项，无「待定」项，实验矩阵可逐项直接执行。",
    expectedArtifacts: ["design.md"],
    skills: [],
    run: [],
  },
  {
    name: "实验执行",
    workspaceName: "exp-run",
    brief:
      "输入：design.md 的实验矩阵（已随 main 合并在本工作区内）。\n" +
      "1. 按 design.md 实现实验代码，放入 experiments/（脚本可重复执行，参数集中在文件头或配置文件）；\n" +
      "2. 逐项跑实验矩阵；标「裁剪」的组合跳过并在结果记录中说明；\n" +
      "3. 原始结果与日志写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不要提交进 git；工作区内只提交代码与 results/summary.md（每行一项实验：配置、主指标数值、产物目录中的结果路径）；\n" +
      "4. 失败的实验不删除日志：在 results/summary.md 标注「失败」与原因，按 design.md 风险清单的备选方案重跑一次，仍失败则记录后继续下一项。\n" +
      "完成标准：矩阵中每项都有明确结果或失败记录，experiments/ 与 results/summary.md 已提交，原始数据全部落在产物目录。",
    expectedArtifacts: ["experiments/", "results/summary.md"],
    skills: [],
    run: [],
  },
  {
    name: "结果分析",
    workspaceName: "exp-analysis",
    brief:
      "输入：results/summary.md 与产物目录中的原始结果（路径见 summary.md 逐行记录）。\n" +
      "1. 汇总各实验主指标，与基线逐项对比，产出 analysis/results-table.md（表格：方法 × 指标，最优值加粗）；\n" +
      "2. 关键对比生成图表写入 figures/（矢量图优先，图题含指标与实验条件）；\n" +
      "3. 逐项解读：哪些假设被验证/证伪、与基线差异的可能原因；下结论只用表格中的数字，没有数据支撑的解读标 [推测]；\n" +
      "4. 异常结果（失败/离群）单独一节说明，不删除不美化；\n" +
      "5. 分析结论写入 analysis/findings.md：3-5 条，每条对应 results-table.md 中的具体数字。\n" +
      "完成标准：analysis/results-table.md、figures/、analysis/findings.md 均存在，每条结论可回溯到表格数字。",
    expectedArtifacts: ["analysis/", "figures/"],
    skills: [],
    run: [],
  },
  {
    name: "论文初稿",
    workspaceName: "paper-draft",
    brief:
      "输入：survey/、design.md、analysis/、figures/、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 按 IMRaD 结构用规范学术英文撰写初稿，产出 manuscript/draft.md：Introduction（研究问题+gap+贡献）、Methods（对应 design.md）、Results（对应 analysis/，引用 figures/ 图表）、Discussion（findings 的意义与局限）；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献；\n" +
      "3. 数字与结论必须与 analysis/results-table.md 一致，不得新造实验结果；缺少的数据在文中标 [待补实验]；\n" +
      "4. 图表引用用占位形式（「Figure 1: …」），图片文件不复制进 manuscript/。\n" +
      "完成标准：manuscript/draft.md 覆盖 IMRaD 四节，引用键全部可在 references.bib 解析，数字与 analysis/ 一致。",
    expectedArtifacts: ["manuscript/"],
    skills: [],
    // P4 quarto 渲染：产物为 manuscript/draft.md，渲染输出 draft.pdf 落在同目录（工作区内，PDF 预览白名单覆盖）；
    // RX4a 追加 export-docx：同一份 md 导出 draft.docx，与 render-draft 并存互不冲突
    run: [
      {
        name: "render-draft",
        command: "quarto render manuscript/draft.md --to pdf",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/draft.md --to docx",
        default: true,
      },
    ],
  },
  {
    name: "润色与投稿准备",
    workspaceName: "polish",
    brief:
      "输入：manuscript/draft.md、analysis/results-table.md、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 语言润色：语法、用词、句式与段落衔接，保持学术语气；只改表达，不改学术观点与数据；\n" +
      "2. 一致性核对：每个论断有引用、每个 bib 条目都被引用（未用的在报告中列出）、图表编号连续、数字与 results-table.md 一致；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "3. 产出 manuscript/paper-final.md 定稿与 manuscript/changelog.md（逐条列出主要修改点）；\n" +
      "4. 投稿材料清单写入 submission/checklist.md：目标期刊/会议（按主题匹配给出 2-3 个候选及理由）、cover letter 要点、图表源文件清单、作者信息与利益声明占位；未知信息一律占位「待填」，不编造。\n" +
      "完成标准：paper-final.md 引用闭环、changelog.md 与 submission/checklist.md 已提交；[待补实验] 全部清除，确无法完成的列入 checklist 投稿前必办项。",
    expectedArtifacts: ["manuscript/paper-final.md", "submission/"],
    skills: [],
    // P4 quarto 渲染：定稿 paper-final.md → paper-final.pdf；RX4a 追加 export-docx → paper-final.docx
    run: [
      {
        name: "render-final",
        command: "quarto render manuscript/paper-final.md --to pdf",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/paper-final.md --to docx",
        default: true,
      },
    ],
  },
];

/** 数据处理（data-processing）：登记检查 → 清洗整理 → 探索性分析 → 分析报告 */
const DATA_PROCESSING_STEPS: ProjectStepDto[] = [
  {
    name: "数据登记与检查",
    workspaceName: "data-inspect",
    brief:
      "输入：项目已登记的数据资源（见下方「项目资源」段；无登记资源时扫描项目目录中的 CSV/parquet/JSON 等数据文件，并把扫描依据写进报告）。\n" +
      "1. 逐数据集记录：来源、获取时间、规模（行数/大小）、格式与编码、字段清单，写入 data-dictionary.md；\n" +
      "2. 字段逐个标注类型/含义/取值范围/缺失比例；含义不明的字段标「待确认」，不猜测含义；\n" +
      "3. 质量问题单列一节：缺失、重复、异常取值、口径不一致，逐项给出样例行号或计数；\n" +
      "4. 数据不可读或格式损坏时在报告中说明并停止，不自行修复原始数据。\n" +
      "完成标准：data-dictionary.md 覆盖全部数据集与字段，质量问题逐项有证据（行号/计数）。",
    expectedArtifacts: ["data-dictionary.md"],
    skills: [],
    run: [],
  },
  {
    name: "清洗与整理",
    workspaceName: "data-clean",
    brief:
      "输入：data-dictionary.md（已随 main 合并在本工作区内）。\n" +
      "1. 清洗规则逐项写死再动手：缺失值处理（删除/填充及填充值）、去重键、异常值边界、类型转换，写入 cleaning/rules.md，每条规则注明依据；\n" +
      "2. 清洗脚本放入 cleaning/（可重复执行；输入只读原始数据，不原地修改）；\n" +
      "3. 处理后的数据写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不进 git；\n" +
      "4. 清洗报告 cleaning/cleaning-report.md：每条规则影响的行数、丢弃数据的清单与原因、清洗前后规模对比。\n" +
      "完成标准：rules.md 无「视情况而定」项，脚本可重复跑通，报告数字与产物目录中的结果一致。",
    expectedArtifacts: ["cleaning/"],
    skills: [],
    run: [],
  },
  {
    name: "探索性分析",
    workspaceName: "data-eda",
    brief:
      "输入：产物目录中清洗后的数据与 cleaning/rules.md（已随 main 合并在本工作区内）。\n" +
      "1. 分布分析：各字段分布（直方图/统计量），图表写入 figures/，并在 eda-report.md 中逐个解读；\n" +
      "2. 相关分析：字段间相关矩阵，强相关对（|r|≥0.7）全部列出并解读，不挑选；\n" +
      "3. 异常分析：按 rules.md 的口径复查残留异常，新发现的异常标 [待确认] 并给出样例；\n" +
      "4. 结论写入 eda-report.md：3-5 条可用于后续决策的发现，每条附对应图表或统计量。\n" +
      "完成标准：figures/ 与 eda-report.md 存在，每条发现可回溯到具体图表/数字，无主观臆断。",
    expectedArtifacts: ["figures/", "eda-report.md"],
    skills: [],
    run: [],
  },
  {
    name: "分析报告",
    workspaceName: "data-report",
    brief:
      "输入：eda-report.md、figures/、data-dictionary.md（已随 main 合并在本工作区内）。\n" +
      "1. 围绕课题主题（见上方「课题主题」段；未填写时按 eda-report.md 的发现自行归纳，并在报告开头说明）组织结论；\n" +
      "2. 产出 analysis-report.md：背景与数据口径 → 主要发现（引用 eda-report.md 条目）→ 结论 → 可执行建议（每条建议对应一条发现，给出优先级）；\n" +
      "3. 数字一律引用 eda-report.md 中的值，不重新计算、不引入新数据；证据不足的结论标 [待验证]；\n" +
      "4. 局限单列一节：数据质量、样本偏差、方法局限，不回避。\n" +
      "完成标准：analysis-report.md 结构完整，建议与发现一一对应；[待确认] 全部清除，确无法核实的列入局限。",
    expectedArtifacts: ["analysis-report.md"],
    skills: [],
    run: [],
  },
];

/** 毕业论文（thesis）：开题与综述 → 研究方法 → 实验与结果 → 全文初稿 → 格式与定稿 */
const THESIS_STEPS: ProjectStepDto[] = [
  {
    name: "开题与文献综述",
    workspaceName: "proposal",
    brief:
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进开题报告）执行：\n" +
      "1. 检索并精读相关文献，每篇产出 notes/<序号-短标题>.md（研究问题 / 方法 / 结果 / 局限 / 可引用点），并在 references.bib 追加 BibTeX（缺字段标「待补」）；\n" +
      "2. 产出 proposal/proposal.md 开题报告：研究背景与意义、研究问题、研究内容与技术路线、进度安排、预期成果；\n" +
      "3. 产出 chapters/literature-review.md 综述章节草稿：按主题聚类组织，只引用 references.bib 中存在的键，不为综述新造引用；\n" +
      "4. 拿不准相关性的文献一律纳入并标注「待确认」，不自行剔除。\n" +
      "完成标准：proposal.md 五节齐全、literature-review.md 引用键全部可解析、notes/ 与 references.bib 已提交。",
    expectedArtifacts: ["proposal/", "chapters/literature-review.md", "references.bib"],
    skills: [],
    run: [],
  },
  {
    name: "研究方法",
    workspaceName: "methodology",
    brief:
      "输入：proposal/proposal.md 的研究内容与技术路线（已随 main 合并在本工作区内）。\n" +
      "1. 产出 chapters/methodology.md 方法章节草稿：方法原理、实现步骤、数据来源与预处理、评价指标，逐节对应开题报告的研究内容；\n" +
      "2. 产出 design.md 实验设计：对比基线（注明出处）、实验矩阵（变量 × 取值完整组合）、预期结果与分析方式；\n" +
      "3. 每个方法选择给出依据；与开题报告不一致的改动在 methodology.md 末尾「变更说明」记录原因，不静默改方案；\n" +
      "4. 依赖的资源不可获取时换用公开替代品并标注，不留「待定」。\n" +
      "完成标准：methodology.md 覆盖开题全部研究内容，design.md 实验矩阵可直接执行，无「待定」项。",
    expectedArtifacts: ["chapters/methodology.md", "design.md"],
    skills: [],
    run: [],
  },
  {
    name: "实验与结果",
    workspaceName: "thesis-exp",
    brief:
      "输入：design.md 的实验矩阵（已随 main 合并在本工作区内）。\n" +
      "1. 实验代码放入 experiments/（可重复执行），逐项跑实验矩阵；\n" +
      "2. 原始结果与日志写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不进 git；results/summary.md 逐项记录：配置、指标数值、产物目录路径；\n" +
      "3. 失败实验在 summary.md 标注原因并重跑一次，仍失败则记录后继续；\n" +
      "4. 产出 chapters/results.md 结果章节草稿：表格汇总（方法 × 指标，最优值加粗）+ 关键图表（figures/）+ 逐项解读；解读只用 summary.md 中的数字，推测性内容标 [推测]。\n" +
      "完成标准：矩阵每项有结果或失败记录，results.md 数字与 summary.md 一致，figures/ 已提交。",
    expectedArtifacts: ["experiments/", "results/summary.md", "chapters/results.md"],
    skills: [],
    run: [],
  },
  {
    name: "论文初稿",
    workspaceName: "thesis-draft",
    brief:
      "输入：chapters/ 各章草稿、references.bib、figures/（已随 main 合并在本工作区内）。\n" +
      "1. 按学校论文模板结构（封面/摘要/目录/正文各章/参考文献/致谢；项目内无模板文件时用通用学位论文结构并在 manuscript/README.md 注明）组装全文初稿 manuscript/thesis-draft.md；\n" +
      "2. 补齐缺失章节：引言（研究背景+问题+贡献，对应开题报告）、结论与展望（对应结果章节）；\n" +
      "3. 统一各章术语、符号与图表编号；引用一律 [@bib键] 且只能引用 references.bib 已有键——严禁编造文献；\n" +
      "4. 图表引用占位（「图 3-1：…」），数字与 chapters/results.md 一致，不一致处以结果章节为准并在修订记录标注；\n" +
      "5. 产出 manuscript/revision-notes.md：组装过程中的取舍与待确认项。\n" +
      "完成标准：thesis-draft.md 章节齐全、引用闭环、revision-notes.md 已提交。",
    expectedArtifacts: ["manuscript/"],
    skills: [],
    // P4 quarto 渲染：产物为 manuscript/thesis-draft.md → thesis-draft.pdf；RX4a 追加 export-docx → thesis-draft.docx
    run: [
      {
        name: "render-draft",
        command: "quarto render manuscript/thesis-draft.md --to pdf",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/thesis-draft.md --to docx",
        default: true,
      },
    ],
  },
  {
    name: "格式与定稿",
    workspaceName: "thesis-final",
    brief:
      "输入：manuscript/thesis-draft.md、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 格式核对：按学校格式规范（项目内有规范文件则逐条对照，没有则按通用学位论文规范并把依据写进报告）检查字体/页边距/图表编号/参考文献格式/页眉页码，问题清单写入 manuscript/format-check.md；\n" +
      "2. 语言润色：语法与表达，只改表达不改观点与数据；内容性错误标 [待核实]；\n" +
      "3. 查重降重建议写入 manuscript/plagiarism-advice.md：标出高重复风险段落（术语定义、公知表述、综述常见句式）并给出改写建议，不直接代写；\n" +
      "4. 产出 manuscript/thesis-final.md 定稿与 manuscript/changelog.md（逐条列出修改点）；\n" +
      "5. 参考文献列表按 references.bib 生成，逐条核对字段齐全（缺字段标「待补」）。\n" +
      "完成标准：format-check.md 问题逐条有处理结论，thesis-final.md 引用闭环，changelog.md 已提交。",
    expectedArtifacts: ["manuscript/thesis-final.md"],
    skills: [],
    // P4 quarto 渲染：定稿 thesis-final.md → thesis-final.pdf；RX4a 追加 export-docx → thesis-final.docx
    run: [
      {
        name: "render-final",
        command: "quarto render manuscript/thesis-final.md --to pdf",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/thesis-final.md --to docx",
        default: true,
      },
    ],
  },
];

/** 投稿与返修（submission-rebuttal）：期刊格式适配 → 投稿材料 → 审稿意见逐条回复 */
const SUBMISSION_REBUTTAL_STEPS: ProjectStepDto[] = [
  {
    name: "期刊格式适配",
    workspaceName: "journal-format",
    brief:
      "输入：manuscript/paper-final.md 或 manuscript/review-final.md（已随 main 合并在本工作区内；两者都不存在时在报告中说明并停止，不自行改用其他草稿）。\n" +
      "1. 确定目标期刊：项目根已有 submission/target-journal.md 时从其约定；没有则按课题主题给出 2-3 个候选期刊及理由，写入 submission/target-journal.md，选第一个执行并标注「待用户确认」；\n" +
      "2. 获取目标期刊官方作者指南（WebFetch 期刊官网 Guide for Authors；获取失败时按通用 IMRaD 与 APA 引用格式执行，并在 format-notes.md 说明依据）；\n" +
      "3. 按指南逐项适配：章节结构、引用与文献列表格式、图表规范、字数与摘要长度；产出 submission/formatted.md，只改格式与表达，不改学术观点与数据；\n" +
      "4. 引用完整性自查（按 bib-check 技能）：正文引用键全部可在 references.bib 解析、bib 条目字段齐全，问题清单写入 submission/format-notes.md；\n" +
      "5. 作者单位/基金号/通讯邮箱等未知信息一律占位「待填」，不编造；所有未决项汇总进 submission/format-notes.md。\n" +
      "完成标准：submission/formatted.md 与 submission/target-journal.md、submission/format-notes.md 均已提交；format-notes.md 逐项给出处理结论。",
    expectedArtifacts: ["submission/"],
    skills: ["bib-check"],
    run: [],
  },
  {
    name: "投稿材料",
    workspaceName: "submission-materials",
    brief:
      "输入：submission/formatted.md、submission/target-journal.md（已随 main 合并在本工作区内）。\n" +
      "1. 产出 submission/cover-letter.md：编辑称呼占位、研究问题与 3 条亮点、与期刊读者群的契合点、原创性与未一稿多投声明（占位「待填」处不编造）；\n" +
      "2. 产出 submission/highlights.md：3-5 条期刊格式要点的 highlights（目标期刊无此要求时在该文件注明并跳过）；\n" +
      "3. 投稿前自查（按 pre-submission-reviewer 技能）formatted.md，问题按 CRITICAL/MAJOR/MINOR 写入 submission/pre-review.md：CRITICAL/MAJOR 逐条处理或写明不处理的理由，MINOR 列出即可；\n" +
      "4. 产出 submission/checklist.md 投稿清单：投稿系统入口（未知标「待填」）、需上传文件清单、作者信息与利益声明占位、推荐审稿人 2-4 位（只给研究领域与选择理由，具体姓名标「待填」）。\n" +
      "完成标准：cover-letter.md、highlights.md、pre-review.md、checklist.md 均已提交；pre-review.md 中 CRITICAL/MAJOR 全部有处理结论。",
    expectedArtifacts: ["submission/cover-letter.md", "submission/checklist.md"],
    skills: ["pre-submission-reviewer"],
    run: [],
  },
  {
    name: "审稿意见回复",
    workspaceName: "rebuttal",
    brief:
      "输入：reviews/round-1.md 审稿意见全文（用户把编辑来信粘贴保存为该文件；文件缺失时提示用户提供并停止，不得编造审稿意见）；submission/formatted.md（已随 main 合并在本工作区内）。\n" +
      "1. 逐条拆分审稿意见并编号（R1.1、R1.2…，多位审稿人分节），不遗漏任何一条；\n" +
      "2. 产出 rebuttal/response-letter.md，逐条回应：意见摘要 → 回应（接受修改 / 部分接受并说明限制 / 礼貌反驳并给依据）→ 稿件修改位置（节+段落）；语气先谢后答；拿不准如何回应的一律按「部分接受+说明限制」写，并标 [待确认]；\n" +
      "3. 能改的直接改进稿件，产出 manuscript/revised.md（在 formatted.md 基础上修改，标注各修改对应的意见编号）；无法靠修改解决的（需补实验/补数据）在回应中给出计划并标 [待补实验]；\n" +
      "4. 产出 rebuttal/revisions.md 修改对照表：每条意见 → 修改点 → revised.md 中的位置，逐条可核对。\n" +
      "完成标准：response-letter.md 覆盖全部意见编号、revisions.md 与 revised.md 一一对应、均已提交；[待确认]/[待补实验] 在文件末尾汇总。",
    expectedArtifacts: ["rebuttal/", "manuscript/revised.md"],
    skills: [],
    run: [],
  },
];

/** 内置模板清单：选择器按此顺序展示，用户模板列在其后 */
export const PIPELINE_TEMPLATES: PipelineTemplateDef[] = [
  {
    id: "review",
    name: "英文综述",
    description:
      "文献检索与筛选 → 精读笔记 → 大纲 → 初稿 → 润色定稿，规范英文学术综述的常规路径",
    steps: REVIEW_STEPS,
  },
  {
    id: "research-paper",
    name: "科研论文",
    description:
      "选题与 gap 分析 → 实验设计/执行/分析 → IMRaD 初稿 → 润色与投稿材料清单",
    steps: RESEARCH_PAPER_STEPS,
  },
  {
    id: "data-processing",
    name: "数据处理",
    description:
      "数据登记与质量检查 → 清洗整理 → 探索性分析 → 结论与建议报告，原始数据与结果全程入产物目录",
    steps: DATA_PROCESSING_STEPS,
  },
  {
    id: "thesis",
    name: "毕业论文",
    description:
      "开题与综述 → 研究方法 → 实验与结果 → 全文初稿 → 格式与定稿，按学位论文结构逐章产出",
    steps: THESIS_STEPS,
  },
  {
    id: "submission-rebuttal",
    name: "投稿与返修",
    description:
      "期刊格式适配 → cover letter 与投稿清单 → 审稿意见逐条回复与修订稿，覆盖定稿之后的投稿全流程",
    steps: SUBMISSION_REBUTTAL_STEPS,
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

/** P2b「整理为笔记」开步预填指令：指向本流程写入的 notes/inbox.md */
export const ORGANIZE_NOTES_PROMPT =
  "读 TASK.md，并把 notes/inbox.md 里的选段整理成结构化文献笔记";
