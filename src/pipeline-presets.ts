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
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进筛选记录），按 lit-search 技能执行：\n" +
      "1. 制定纳入/排除标准（年份、语言、来源级别、相关性），写进 papers/screening.md；\n" +
      "2. 检索候选文献（学术数据库/网络），每篇记录标题、作者、年份、来源、链接或 DOI；\n" +
      "3. 按标准逐条筛选，结果写入 papers/screening.md（含每篇的纳入/排除及理由）；拿不准相关性的一律纳入并标注「待确认」；\n" +
      "4. 纳入的文献清单写入 papers/included.md（一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI）；\n" +
      "5. 全文获取分两类：开放获取（arXiv/PMC/开放期刊/作者主页 preprint）的用 WebFetch/curl 直接下载到 papers/ 目录（文件名规范化：作者年份-短标题.pdf）；付费墙的不得尝试绕过，在 included.md 该行末尾标注「需自行获取」，并汇总写入 papers/to-fetch.md（标题 — DOI），等用户提供全文。\n" +
      "完成标准：papers/screening.md、papers/included.md、papers/to-fetch.md 均存在（无付费文献则 to-fetch.md 注明为空），每条记录无空缺字段（未知则标「待补」）。",
    expectedArtifacts: ["papers/"],
    skills: ["lit-search"],
    run: [],
    humanTasks: [
      {
        title: "补充你已知的关键文献",
        guidance:
          "分工：agent 负责系统检索（OpenAlex / Semantic Scholar 等可程序化库）与 DOI 去重合并；你负责语义发现补漏——在 Undermind / Google Scholar / Elicit 网页端检索（哪篇重要你判断更快），导出 RIS / BibTeX / CSV 后点本行「导入检索结果」（落 papers/imports/），开工时 agent 自动解析、去重并合并进 papers/screening.md；你自己读过、认为必须纳入的 PDF 也可直接放进 papers/",
        target: "papers/",
        timing: "before",
      },
      {
        title: "下载付费墙文献全文",
        guidance:
          "渠道自选：机构图书馆/作者邮件索取 preprint 等；缺权限清单见 papers/to-fetch.md（agent 筛完会列出）",
        target: "papers/*.pdf",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "综述角度怎么收：领域全景铺开，还是聚焦某个子问题/结局？",
      "纳入排除标准定多严：只要高质量研究，还是观察性/预印本也要？",
      "检索哪几个数据库：结合你自己的机构权限和课题领域",
    ],
  },
  {
    name: "文献精读与笔记",
    workspaceName: "lit-notes",
    brief:
      "输入：上一步产物 papers/included.md（已随 main 合并在本工作区内）。全程按 lit-notes 技能执行。\n" +
      "1. 按 included.md 清单逐篇精读（先读「待确认」之外的纳入项；清单缺失或为空时在报告中说明并停止，不要自行换题）；\n" +
      "2. 全文来源优先级：项目资源/papers/ 已有 PDF → 开放获取补下 → 仍缺（papers/to-fetch.md 中的付费文献）按摘要+可见元数据写笔记，并在笔记开头标注「仅摘要·待全文」；\n" +
      "3. 每篇产出 notes/<序号-短标题>.md，固定结构：研究问题 / 方法 / 主要结果 / 局限 / 可引用点（原文关键句+页码或段落位置）；\n" +
      "4. 每篇在 references.bib 追加一条 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）；\n" +
      "5. 若 notes/ 中「仅摘要」笔记对应的全文已出现在项目资源或 papers/（用户已补），重读全文并更新该笔记、去掉标记。\n" +
      "完成标准：included.md 每篇都有对应笔记与 bib 条目；notes/ 与 references.bib 均已提交。",
    expectedArtifacts: ["notes/", "references.bib"],
    skills: ["lit-notes"],
    run: [],
    discussionSeeds: [
      "精读力度怎么分：全部全文精读，还是核心文献精读、其余按摘要记？",
    ],
  },
  {
    name: "综述大纲",
    workspaceName: "outline",
    brief:
      "输入：notes/ 全部笔记与 references.bib（已随 main 合并在本工作区内）。框架构造按 review-framework 技能执行（空白清单 + 范式卡片 + 融合理由）。\n" +
      "1. 通读笔记，按主题聚类归纳研究现状的主要线索（方法/问题/结论的异同）；\n" +
      "2. 产出 outline.md：章节结构（引言 / 背景 / 主题各节 / 讨论 / 结论）、每节要点（3-6 条）、每节拟引用的 bib 键、分类框架的一句话说明；\n" +
      "3. 分类框架优先按主题聚类；主题过于发散时改按时间线；有分歧时选覆盖文献最多的框架，并在 outline.md 末尾记录取舍理由；\n" +
      "4. 只引用 references.bib 中存在的键，不为大纲新造引用。\n" +
      "完成标准：outline.md 结构完整、每节要点与引用键齐全、取舍理由已记录。",
    expectedArtifacts: ["outline.md"],
    skills: ["review-framework"],
    run: [],
    discussionSeeds: [
      "分类框架按什么组织：主题聚类、方法路线还是时间线？",
      "这篇综述的卖点是什么：想让读者读完记住哪一句话？",
    ],
  },
  {
    name: "综述初稿",
    workspaceName: "draft",
    brief:
      "输入：outline.md、notes/、references.bib（已随 main 合并在本工作区内）。写作规范按 review-writing 技能执行。\n" +
      "1. 按 outline.md 用规范学术英文撰写综述初稿，产出 manuscript/draft.md（目标 6000-8000 词，课题主题段另有约定时从其约定）；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献；\n" +
      "3. 图表以占位形式给出（「图 1：…（待绘制）」「表 1：…」），不虚构数据；\n" +
      "4. 没有文献支撑的论断不得下；必须保留的判断在句末标 [待核实]。\n" +
      "完成标准：manuscript/draft.md 覆盖大纲全部章节，引用键全部可在 references.bib 中解析。",
    expectedArtifacts: ["manuscript/"],
    skills: ["review-writing"],
    run: [],
    discussionSeeds: [
      "目标篇幅和读者怎么定：写多长、文风偏入门科普还是偏同行专家？",
    ],
  },
  {
    name: "润色与定稿",
    workspaceName: "polish",
    brief:
      "输入：manuscript/draft.md、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 语言润色：语法、用词、句式与段落衔接，保持学术语气；只改表达，不改学术观点；\n" +
      "2. 一致性核对（引用闭环部分按 bib-check 技能）：每个论断都有引用、每个 bib 条目都被引用（未用的在报告中列出）、图表占位编号连续；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "3. 产出 manuscript/review-final.md 定稿，并附 manuscript/changelog.md（逐条列出主要修改点）；\n" +
      "4. 文末 References 节按 references.bib 生成完整文献列表。\n" +
      "完成标准：review-final.md 无语法硬伤、引用闭环、changelog.md 已提交。",
    expectedArtifacts: ["manuscript/review-final.md"],
    skills: ["review-writing", "bib-check"],
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
      "1. 检索并精读相关文献（检索与记录口径按 lit-search 技能），按主题归纳研究现状，写入 survey/literature.md（每篇：研究问题 / 方法 / 主要结果 / 局限）；\n" +
      "2. 提炼 2-3 个候选研究问题，逐一分析现有工作的 gap（未解决的问题、方法的不足、数据的空白），写入 survey/gap-analysis.md；\n" +
      "3. 从候选中选定一个研究问题：优先选 gap 明确且数据/方法可支撑的；拿不准时选文献支撑最多的，并在报告中记录取舍理由；\n" +
      "4. 每条引用在 references.bib 追加 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）。\n" +
      "完成标准：survey/literature.md 与 survey/gap-analysis.md 均存在，研究问题明确唯一，references.bib 条目无空缺字段。",
    expectedArtifacts: ["survey/", "references.bib"],
    skills: ["lit-search"],
    run: [],
    humanTasks: [
      {
        title: "补充你已知的关键文献",
        guidance:
          "分工：agent 负责系统检索（OpenAlex / Semantic Scholar 等可程序化库）与 DOI 去重合并；你负责语义发现补漏——在 Undermind / Google Scholar / Elicit 网页端检索（哪篇重要你判断更快），导出 RIS / BibTeX / CSV 后点本行「导入检索结果」（落 papers/imports/），agent 解析去重后并入文献库；你自己读过的 PDF 也可直接放进 papers/",
        target: "papers/",
        timing: "before",
      },
      {
        title: "确认研究问题",
        guidance:
          "agent 会从候选中选定一个并把取舍理由写进 survey/gap-analysis.md；方向性决策建议过目后再进入实验设计",
        target: "",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "研究问题怎么选：追热点求稳妥，还是押高风险高回报的 gap？",
      "数据从哪来：公开数据集够用吗，还是要自己采/申请？",
    ],
  },
  {
    name: "实验设计",
    workspaceName: "exp-design",
    brief:
      "输入：survey/gap-analysis.md 确定的研究问题（已随 main 合并在本工作区内）。\n" +
      "1. 产出 design.md，逐项写死：研究方法（技术路线与关键假设）、数据来源（名称/规模/获取方式）、对比基线（至少 2 个，注明出处）、评价指标（主指标+辅指标，给出计算公式或出处）、实验矩阵（变量 × 取值的完整组合表）；\n" +
      "2. 每个设计决策给出依据；依赖的资源（数据集/预训练模型）不可获取时换用公开替代品并标注，不留「待定」；\n" +
      "3. 估算每项实验的计算开销，超出本机条件的组合在矩阵中标注「裁剪」并说明裁剪规则；\n" +
      "4. design.md 末尾附风险清单：最可能失败的环节与备选方案；\n" +
      "5. 统计设计自查（按 stats-check 技能的实验设计口径）：主要结局指标唯一明确、样本量有功效估算依据、剔除标准事先定义；涉及统计检验的实验在 design.md 中写明检验方法与多重比较校正口径。\n" +
      "完成标准：design.md 覆盖方法/数据/基线/指标/实验矩阵五项，无「待定」项，实验矩阵可逐项直接执行。",
    expectedArtifacts: ["design.md"],
    skills: ["stats-check"],
    run: [],
    humanTasks: [
      {
        title: "审阅实验设计",
        guidance:
          "design.md 的实验矩阵与计算开销估算直接决定下一步的执行成本；确认或修改后再开「实验执行」",
        target: "",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "实验规模怎么定：算力/时间预算内，矩阵砍到哪些组合必须跑？",
      "主指标押哪个：论文卖点挂在哪个指标上，辅指标留哪些？",
    ],
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
    humanTasks: [
      {
        title: "准备数据集与算力访问",
        guidance:
          "design.md 所列数据集/模型若需申请或登录（公开数据集协议、机构集群账号等），开工前完成授权",
        target: "",
        timing: "before",
      },
    ],
    discussionSeeds: [
      "算力怎么排：本机跑还是上集群/云，排队和花费接受多少？",
    ],
  },
  {
    name: "结果分析",
    workspaceName: "exp-analysis",
    brief:
      "输入：results/summary.md 与产物目录中的原始结果（路径见 summary.md 逐行记录）。\n" +
      "1. 汇总各实验主指标，与基线逐项对比，产出 analysis/results-table.md（表格：方法 × 指标，最优值加粗）；\n" +
      "2. 关键对比生成图表写入 figures/（出图按 figure-forge 技能：可复现脚本、矢量优先、色盲友好、图题含指标与实验条件）；\n" +
      "3. 逐项解读：哪些假设被验证/证伪、与基线差异的可能原因；下结论只用表格中的数字，没有数据支撑的解读标 [推测]；涉及统计显著性的表述按 stats-check 技能口径报告（p 值给具体值、附效应量与置信区间）；\n" +
      "4. 异常结果（失败/离群）单独一节说明，不删除不美化；\n" +
      "5. 分析结论写入 analysis/findings.md：3-5 条，每条对应 results-table.md 中的具体数字。\n" +
      "完成标准：analysis/results-table.md、figures/、analysis/findings.md 均存在，每条结论可回溯到表格数字。",
    expectedArtifacts: ["analysis/", "figures/"],
    skills: ["stats-check", "figure-forge"],
    run: [],
    discussionSeeds: [
      "结果不如预期怎么办：阴性结果如实写进论文，还是换方向补实验？",
    ],
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
    discussionSeeds: [
      "卖点怎么讲：贡献的三句话电梯陈述怎么定，Introduction 往哪个方向带？",
    ],
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
      "2. 一致性核对（引用闭环部分按 bib-check 技能）：每个论断有引用、每个 bib 条目都被引用（未用的在报告中列出）、图表编号连续、数字与 results-table.md 一致；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "3. 产出 manuscript/paper-final.md 定稿与 manuscript/changelog.md（逐条列出主要修改点）；\n" +
      "4. 投稿材料清单写入 submission/checklist.md：目标期刊/会议（按主题匹配给出 2-3 个候选及理由）、cover letter 要点、图表源文件清单、作者信息与利益声明占位；未知信息一律占位「待填」，不编造。\n" +
      "完成标准：paper-final.md 引用闭环、changelog.md 与 submission/checklist.md 已提交；[待补实验] 全部清除，确无法完成的列入 checklist 投稿前必办项。",
    expectedArtifacts: ["manuscript/paper-final.md", "submission/"],
    skills: ["bib-check"],
    humanTasks: [
      {
        title: "填写作者信息并初定投稿目标",
        guidance:
          "submission/checklist.md 中的作者信息/利益声明「待填」占位逐条补齐；目标期刊候选 2-3 个已附理由，可改选",
        target: "submission/checklist.md",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "投哪里：冲高一档还是求稳，毕业/评职时间线上来得及吗？",
    ],
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
    humanTasks: [
      {
        title: "采集/导出原始数据",
        guidance:
          "渠道自选：业务系统导出/问卷平台下载/公开数据集；放入项目目录即可，agent 会扫描并逐数据集登记",
        target: "",
        timing: "before",
      },
      {
        title: "解答「待确认」字段的业务含义",
        guidance:
          "data-dictionary.md 中标注「待确认」的字段逐条回复含义与口径；可直接改文件，或在对话中说明",
        target: "data-dictionary.md",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "数据口径以哪份为准：多来源数据冲突时听谁的？",
      "这份数据最终要回答什么问题：决定了哪些字段是重点？",
    ],
  },
  {
    name: "清洗与整理",
    workspaceName: "data-clean",
    brief:
      "输入：data-dictionary.md（已随 main 合并在本工作区内）。\n" +
      "1. 清洗规则逐项写死再动手（全程按 data-clean 技能：规则先行、原始数据只读）：缺失值处理（删除/填充及填充值）、去重键、异常值边界、类型转换，写入 cleaning/rules.md，每条规则注明依据；\n" +
      "2. 清洗脚本放入 cleaning/（可重复执行；输入只读原始数据，不原地修改）；\n" +
      "3. 处理后的数据写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不进 git；\n" +
      "4. 清洗报告 cleaning/cleaning-report.md：每条规则影响的行数、丢弃数据的清单与原因、清洗前后规模对比。\n" +
      "完成标准：rules.md 无「视情况而定」项，脚本可重复跑通，报告数字与产物目录中的结果一致。",
    expectedArtifacts: ["cleaning/"],
    skills: ["data-clean"],
    run: [],
    discussionSeeds: [
      "清洗尺度怎么定：缺失值删还是填，丢掉多少数据能接受？",
    ],
  },
  {
    name: "探索性分析",
    workspaceName: "data-eda",
    brief:
      "输入：产物目录中清洗后的数据与 cleaning/rules.md（已随 main 合并在本工作区内）。\n" +
      "1. 分布分析（按 data-eda 技能的全覆盖口径）：各字段分布（直方图/统计量），图表写入 figures/，并在 eda-report.md 中逐个解读；\n" +
      "2. 相关分析：字段间相关矩阵，强相关对（|r|≥0.7）全部列出并解读，不挑选；\n" +
      "3. 异常分析：按 rules.md 的口径复查残留异常，新发现的异常标 [待确认] 并给出样例；\n" +
      "4. 结论写入 eda-report.md：3-5 条可用于后续决策的发现，每条附对应图表或统计量。\n" +
      "完成标准：figures/ 与 eda-report.md 存在，每条发现可回溯到具体图表/数字，无主观臆断。",
    expectedArtifacts: ["figures/", "eda-report.md"],
    skills: ["data-eda"],
    run: [],
    discussionSeeds: [
      "EDA 要支撑什么决策：这份分析最后要帮谁拍什么板？",
    ],
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
    discussionSeeds: [
      "报告给谁看：决策层要结论先行，还是技术读者要细节可复核？",
    ],
  },
];

/** 毕业论文（thesis）：开题与综述 → 研究方法 → 实验与结果 → 全文初稿 → 格式与定稿 */
const THESIS_STEPS: ProjectStepDto[] = [
  {
    name: "开题与文献综述",
    workspaceName: "proposal",
    brief:
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进开题报告）执行：\n" +
      "1. 检索并精读相关文献（检索按 lit-search、笔记按 lit-notes 技能），每篇产出 notes/<序号-短标题>.md（研究问题 / 方法 / 结果 / 局限 / 可引用点），并在 references.bib 追加 BibTeX（缺字段标「待补」）；\n" +
      "2. 产出 proposal/proposal.md 开题报告（按 proposal-writer 技能）：研究背景与意义、研究问题、研究内容与技术路线、进度安排、预期成果；\n" +
      "3. 产出 chapters/literature-review.md 综述章节草稿：按主题聚类组织，只引用 references.bib 中存在的键，不为综述新造引用；\n" +
      "4. 拿不准相关性的文献一律纳入并标注「待确认」，不自行剔除。\n" +
      "完成标准：proposal.md 五节齐全、literature-review.md 引用键全部可解析、notes/ 与 references.bib 已提交。",
    expectedArtifacts: ["proposal/", "chapters/literature-review.md", "references.bib"],
    skills: ["lit-search", "lit-notes", "proposal-writer"],
    run: [],
    humanTasks: [
      {
        title: "补充你已知的关键文献",
        guidance:
          "分工：agent 负责系统检索（OpenAlex / Semantic Scholar 等可程序化库）与 DOI 去重合并；你负责语义发现补漏——在 Undermind / Google Scholar / Elicit 网页端检索（哪篇重要你判断更快），导出 RIS / BibTeX / CSV 后点本行「导入检索结果」（落 papers/imports/），agent 解析去重后并入文献库；你自己读过的 PDF 也可直接放进 papers/",
        target: "papers/",
        timing: "before",
      },
      {
        title: "开题报告送导师评阅",
        guidance:
          "proposal/proposal.md 可直接发导师；导师意见自行记录，可追加到该文件末尾供后续步骤参考",
        target: "proposal/",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "研究问题聚焦到哪：导师给的大方向里，切哪一块是你真能做完的？",
    ],
  },
  {
    name: "研究方法",
    workspaceName: "methodology",
    brief:
      "输入：proposal/proposal.md 的研究内容与技术路线（已随 main 合并在本工作区内）。\n" +
      "1. 产出 chapters/methodology.md 方法章节草稿：方法原理、实现步骤、数据来源与预处理、评价指标，逐节对应开题报告的研究内容；\n" +
      "2. 产出 design.md 实验设计（统计设计口径按 stats-check 技能）：对比基线（注明出处）、实验矩阵（变量 × 取值完整组合）、预期结果与分析方式；\n" +
      "3. 每个方法选择给出依据；与开题报告不一致的改动在 methodology.md 末尾「变更说明」记录原因，不静默改方案；\n" +
      "4. 依赖的资源不可获取时换用公开替代品并标注，不留「待定」。\n" +
      "完成标准：methodology.md 覆盖开题全部研究内容，design.md 实验矩阵可直接执行，无「待定」项。",
    expectedArtifacts: ["chapters/methodology.md", "design.md"],
    skills: ["stats-check"],
    run: [],
    humanTasks: [
      {
        title: "与导师确认方法与技术路线",
        guidance:
          "methodology.md 与开题报告不一致的改动见文末「变更说明」，建议逐条与导师过一遍",
        target: "",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "技术路线押哪条：成熟方案保毕业，还是新方法冲创新点？",
    ],
  },
  {
    name: "实验与结果",
    workspaceName: "thesis-exp",
    brief:
      "输入：design.md 的实验矩阵（已随 main 合并在本工作区内）。\n" +
      "1. 实验代码放入 experiments/（可重复执行），逐项跑实验矩阵；\n" +
      "2. 原始结果与日志写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不进 git；results/summary.md 逐项记录：配置、指标数值、产物目录路径；\n" +
      "3. 失败实验在 summary.md 标注原因并重跑一次，仍失败则记录后继续；\n" +
      "4. 产出 chapters/results.md 结果章节草稿：表格汇总（方法 × 指标，最优值加粗）+ 关键图表（figures/，出图按 figure-forge 技能）+ 逐项解读；解读只用 summary.md 中的数字，推测性内容标 [推测]。\n" +
      "完成标准：矩阵每项有结果或失败记录，results.md 数字与 summary.md 一致，figures/ 已提交。",
    expectedArtifacts: ["experiments/", "results/summary.md", "chapters/results.md"],
    skills: ["figure-forge"],
    run: [],
    humanTasks: [
      {
        title: "准备数据集与算力访问",
        guidance:
          "design.md 所列数据集/模型若需申请或登录（公开数据集协议、机构集群账号等），开工前完成授权",
        target: "",
        timing: "before",
      },
    ],
    discussionSeeds: [
      "实验做到什么程度收手：矩阵全跑完，还是核心结果出来就转写作？",
    ],
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
    discussionSeeds: [
      "章节权重怎么分：哪几章是答辩老师最看重、要重点打磨的？",
    ],
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
      "5. 参考文献列表按 references.bib 生成，逐条核对字段齐全（缺字段标「待补」），核对口径按 bib-check 技能。\n" +
      "完成标准：format-check.md 问题逐条有处理结论，thesis-final.md 引用闭环，changelog.md 已提交。",
    expectedArtifacts: ["manuscript/thesis-final.md"],
    skills: ["bib-check"],
    humanTasks: [
      {
        title: "放入学校格式规范与论文模板",
        guidance:
          "学校官网/研究生院下载的格式规范与模板文件，放到项目目录即可；没有时 agent 按通用学位论文规范执行并注明依据",
        target: "",
        timing: "before",
      },
      {
        title: "定稿送导师审阅并按学校要求查重",
        guidance:
          "thesis-final.md 渲染后送导师；查重渠道以学校要求为准，高重复风险段落见 manuscript/plagiarism-advice.md",
        target: "",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "查重红线留多少余量：学校要求多少以下，定稿前自己先压到多少？",
    ],
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
    humanTasks: [
      {
        title: "写下已定目标期刊（如已确定）",
        guidance:
          "已确定期刊时在 submission/target-journal.md 写明刊名与理由；没有则 agent 会给 2-3 个候选并标注「待用户确认」",
        target: "submission/target-journal.md",
        timing: "before",
      },
      {
        title: "拍板目标期刊并补齐「待填」信息",
        guidance:
          "期刊候选见 submission/target-journal.md；作者单位/基金号/通讯邮箱等占位在 formatted.md 与 format-notes.md 中汇总",
        target: "submission/",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "投哪里：候选期刊里冲一档还是保一档，时间成本怎么权衡？",
    ],
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
    humanTasks: [
      {
        title: "补齐投稿清单「待填」项并选定推荐审稿人",
        guidance:
          "checklist.md 中投稿系统入口、作者信息与利益声明逐条补齐；推荐审稿人只给了研究领域与选择理由，具体姓名由你定",
        target: "submission/checklist.md",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "推荐审稿人怎么圈：避开利益冲突又要懂行，从哪些组里挑？",
    ],
  },
  {
    name: "审稿意见回复",
    workspaceName: "rebuttal",
    brief:
      "输入：reviews/round-1.md 审稿意见全文（用户把编辑来信粘贴保存为该文件；文件缺失时提示用户提供并停止，不得编造审稿意见）；submission/formatted.md（已随 main 合并在本工作区内）。\n" +
      "1. 逐条拆分审稿意见并编号（按 rebuttal-crafter 技能：R1.1、R1.2…，多位审稿人分节），不遗漏任何一条；\n" +
      "2. 产出 rebuttal/response-letter.md，逐条回应：意见摘要 → 回应（接受修改 / 部分接受并说明限制 / 礼貌反驳并给依据）→ 稿件修改位置（节+段落）；语气先谢后答；拿不准如何回应的一律按「部分接受+说明限制」写，并标 [待确认]；\n" +
      "3. 能改的直接改进稿件，产出 manuscript/revised.md（在 formatted.md 基础上修改，标注各修改对应的意见编号）；无法靠修改解决的（需补实验/补数据）在回应中给出计划并标 [待补实验]；\n" +
      "4. 产出 rebuttal/revisions.md 修改对照表：每条意见 → 修改点 → revised.md 中的位置，逐条可核对。\n" +
      "完成标准：response-letter.md 覆盖全部意见编号、revisions.md 与 revised.md 一一对应、均已提交；[待确认]/[待补实验] 在文件末尾汇总。",
    expectedArtifacts: ["rebuttal/", "manuscript/revised.md"],
    skills: ["rebuttal-crafter"],
    run: [],
    humanTasks: [
      {
        title: "保存审稿意见全文",
        guidance:
          "把编辑来信/审稿意见粘贴保存为 reviews/round-1.md（多位审稿人合在一个文件即可，agent 会分节编号）；缺该文件 agent 会停止",
        target: "reviews/round-1.md",
        timing: "before",
      },
      {
        title: "确认 [待确认] 回应口径",
        guidance:
          "response-letter.md 中标注 [待确认] 的条目是 agent 拿不准的回应，逐条拍板；[待补实验] 需你安排补做",
        target: "",
        timing: "after",
      },
    ],
    discussionSeeds: [
      "回复策略怎么定：意见尽量接受修改，还是该反驳的坚决反驳？",
    ],
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
