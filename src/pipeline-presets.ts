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
      "输入：课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源推断一个最可能的主题，写进 papers/screening.md 开头「检索主题假设」一节，并按该假设执行到底，不留「待定」）。全程按 lit-search 技能执行：\n" +
      "1. 制定纳入/排除标准（年份、语言、来源级别、相关性口径），写进 papers/screening.md；\n" +
      "2. 先解析人工导入的题录（RIS/BibTeX/CSV），两处都要看：① 工作区内 papers/imports/ 目录；② 本文件「项目资源」段中类型为「引文」的条目、以及「上一步产物（提货单）」段中来自「人工交付」的条目——这两类给的是绝对路径，按路径直读、勿复制进工作区（开工前导入的题录多半在这里，工作区不含主仓未提交的文件）。两处都没有才跳过。解析后按 lit-search 技能口径去重合并进候选池，每条保留来源标注；\n" +
      "3. 检索候选文献：OpenAlex / Semantic Scholar / arXiv / Crossref 官方 API 免 key 直连（WebFetch/curl），每个库的检索式与命中数记入 papers/screening.md；人工事项若已配 Consensus/Undermind MCP 可直接调用；WoS/SerpAPI 等付费 key 一律用 $VAR 环境变量引用，禁止写进任何文件；\n" +
      "4. 按标准逐条筛选，每篇给出纳入/排除及理由；拿不准相关性的一律纳入并标注「待确认」，不允许自行裁掉；\n" +
      "5. 纳入清单写入 papers/included.md（一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI）；\n" +
      "6. 全文获取分两类：开放获取（arXiv/PMC/开放期刊/作者主页 preprint）直接下载到 papers/（文件名规范化：作者年份-短标题.pdf）；付费墙不得尝试绕过，在 included.md 该行末尾标注「需自行获取」，并汇总写入 papers/to-fetch.md（标题 — DOI），等用户提供全文。\n" +
      "完成标准：papers/screening.md、papers/included.md、papers/to-fetch.md 均存在（无付费文献则 to-fetch.md 注明为空），每条记录无空缺字段（未知则标「待补」），筛选记录能让第三人按标准复现每条判定。",
    expectedArtifacts: [
      "papers/screening.md",
      "papers/included.md",
      "papers/to-fetch.md",
    ],
    skills: ["lit-search"],
    run: [],
    humanTasks: [
      {
        title: "补充你已知的关键文献",
        guidance:
          "agent 会系统检索 OpenAlex / Semantic Scholar 等可程序化库并按 DOI 去重；你补的是它搜不到的那部分——Undermind / Google Scholar / Elicit 等网页端的语义发现结果，或你读过、认定必须纳入的文献。到「文献与数据」导入即可（支持 Zotero 库、RIS/BibTeX 题录）。不补也能跑。",
        target: "papers/",
        timing: "before",
        optional: true,
      },
      {
        title: "下载付费墙文献全文",
        guidance:
          "agent 筛完会把拿不到全文的列进 papers/to-fetch.md。渠道自选：机构图书馆、作者邮件索取 preprint 等。拿到后加进你的文献库或项目目录再导入；不补的话 agent 按摘要写笔记并标注「仅摘要」。",
        target: "papers/*.pdf",
        timing: "after",
        optional: true,
      },
    ],
    decisions: [
      {
        q: "综述角度怎么收",
        options: ["领域全景铺开", "聚焦某个子问题/结局"],
      },
      {
        q: "纳入标准定多严",
        options: ["只要高质量期刊/顶会", "含观察性研究与预印本"],
      },
      {
        q: "检索范围铺多广",
        options: [
          "免 key 的 OpenAlex/S2/arXiv 够用",
          "另加机构订阅库（需你提供 key）",
        ],
      },
    ],
  },
  {
    name: "文献精读与笔记",
    workspaceName: "lit-notes",
    brief:
      "输入：上一步产物 papers/included.md 与 papers/to-fetch.md（已随 main 合并在本工作区内）。全程按 lit-notes 技能执行。\n" +
      "1. 按 included.md 清单逐篇精读（先读「待确认」之外的纳入项；清单缺失或为空时在报告中说明并停止，不要自行换题或自行补清单）；\n" +
      "2. 全文来源优先级（写死）：papers/ 已有 PDF（含人工补投）→ 开放获取补下（arXiv/PMC/作者主页 preprint）→ 仍缺（papers/to-fetch.md 中的付费文献）按摘要+可见元数据写笔记，并在笔记开头标注「仅摘要·待全文」，不得装作读过全文；\n" +
      "3. 每篇产出 notes/<序号-短标题>.md，固定结构：研究问题 / 方法 / 主要结果 / 局限 / 可引用点（原文关键句+页码或段落位置）；\n" +
      "4. 每篇在 references.bib 追加一条 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」，不得编造）；\n" +
      "5. 收尾前复查：notes/ 中「仅摘要」笔记对应的全文若已出现在 papers/（人工补投），重读全文并更新该笔记、去掉标记；仍未补的保持标注并在报告末尾计数说明。\n" +
      "完成标准：included.md 每篇都有对应笔记与 bib 条目；notes/ 与 references.bib 均已提交。",
    expectedArtifacts: ["notes/", "references.bib"],
    skills: ["lit-notes"],
    run: [],
    humanTasks: [
      {
        title: "继续补投付费全文",
        guidance:
          "上一步 papers/to-fetch.md 列出的付费文献，拿到后到「文献与数据」导入；agent 收尾前会重读全文、更新对应「仅摘要」笔记。",
        target: "papers/*.pdf",
        timing: "during",
        optional: true,
      },
    ],
    decisions: [
      {
        q: "精读力度怎么分",
        options: ["核心文献精读、其余按摘要记", "全部全文精读"],
      },
    ],
  },
  {
    name: "综述大纲",
    workspaceName: "outline",
    brief:
      "输入：notes/ 全部笔记、papers/included.md 与 references.bib（已随 main 合并在本工作区内）。框架构造全程按 review-framework 技能执行（空白清单 → 范式卡片 → 融合）：\n" +
      "1. 提炼研究空白清单：通读 notes/ 各笔记的「局限」与「可引用点」，最新一批精读文献回到原文前言核对作者自述的 gap（优先级最高）；每条空白标注来源笔记/bib 键，多条指向同一空白时合并；仅凭单篇文献主观抱怨的标「孤证」；\n" +
      "2. 拆解范式卡片：从 papers/included.md 选 2-3 篇权威综述类文献（期刊级别/被引优先；清单里没有综述类文献时如实说明并跳过本步，不虚构范式），每篇拆「结构逻辑 / 详略配比 / 论证顺序」三项；\n" +
      "3. 融合构造框架：以覆盖空白最多的范式做骨架，每条空白落到具体章节；范式冲突时选覆盖空白更多的，落选范式的局部优点吸收为节内参考；不新造与空白无关的章节；空白无处安放时允许新增章节并在该节标注「空白驱动新增」；\n" +
      "4. 产出 outline.md：章节结构（引言 / 背景 / 主题各节 / 讨论 / 结论），每节给要点（3-6 条）、拟引用 bib 键、回应空白编号；末尾固定附「## 框架推演」段（空白清单 / 范式卡片 / 融合理由三块）；\n" +
      "5. 只引用 references.bib 中存在的键，不为大纲新造引用。\n" +
      "完成标准：outline.md 结构完整，每节要点/引用键/回应空白齐全，「框架推演」段三块内容齐备。",
    expectedArtifacts: ["outline.md"],
    skills: ["review-framework"],
    run: [],
    humanTasks: [
      {
        title: "审阅 outline.md 再开初稿",
        guidance:
          "重点看末尾「框架推演」段的取舍理由与空白-章节对应；框架不合意时回任务书草稿改，比初稿写完再返工便宜",
        target: "",
        timing: "after",
        optional: true,
      },
    ],
    discussionSeeds: [
      "范式锚点：你读过、欣赏的综述里，哪一篇的结构值得借来做骨架？",
      "这篇综述的卖点是什么：想让读者读完记住哪一句话？",
    ],
  },
  {
    name: "综述初稿",
    workspaceName: "draft",
    brief:
      "输入：outline.md（含「框架推演」段）、notes/、references.bib（已随 main 合并在本工作区内）。写作规范全程按 review-writing 技能执行。\n" +
      "1. 按 outline.md 用规范学术英文撰写综述初稿，产出 manuscript/draft.md（目标 6000-8000 词，课题主题段另有约定时从其约定）；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献、严禁新造键；\n" +
      "3. 图表以占位形式给出（「图 1：…（待绘制）」「表 1：…」），不虚构数据；\n" +
      "4. 没有文献支撑的论断不得下；必须保留的判断在句末标 [待核实]。\n" +
      "完成标准：manuscript/draft.md 覆盖大纲全部章节，引用键全部可在 references.bib 中解析。",
    expectedArtifacts: ["manuscript/draft.md"],
    skills: ["review-writing"],
    run: [],
    decisions: [
      { q: "目标篇幅", options: ["6000-8000 词", "4000 词以内", "1 万词以上"] },
      { q: "读者与文风", options: ["偏同行专家", "偏入门科普"] },
      {
        q: "这篇综述的去向",
        options: ["投期刊", "毕业论文的一章", "课程作业"],
      },
    ],
  },
  {
    name: "润色与定稿",
    workspaceName: "polish",
    brief:
      "输入：manuscript/draft.md 与 references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 先按 bib-check 技能对 draft.md 做引用完整性校验，产出 manuscript/citation-check.md（该技能只读不改稿：未解析引用/字段缺失/元数据存疑逐条列出，联网可用时加做 Crossref/arXiv 外部核验）；\n" +
      "2. 按报告修正（修稿由本步执行，不是 bib-check 的职责）：未解析引用键改为 references.bib 中正确键或补条目（补条目缺字段标「待补」）；「疑似编造」条目不得自行删除对应论断，句末标 [待核实] 并在 changelog 记录；「未引用条目」只在报告列出、不删；\n" +
      "3. 语言润色按 review-writing 技能阶段三：语法、用词、句式与段落衔接，保持学术语气；只改表达，不改学术观点；图表占位编号连续；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "4. 产出 manuscript/review-final.md 定稿（文末 References 节按 references.bib 生成完整文献列表）与 manuscript/changelog.md（逐条列出主要修改点及对应 citation-check.md 条目）；\n" +
      "5. 收尾再按 bib-check 复核 review-final.md，结论追加进 citation-check.md。\n" +
      "完成标准：review-final.md 无语法硬伤、引用键全部可解析；citation-check.md 结论为通过（遗留问题均已标 [待核实] 并列入 changelog）；changelog.md 已提交。",
    expectedArtifacts: [
      "manuscript/review-final.md",
      "manuscript/changelog.md",
      "manuscript/citation-check.md",
    ],
    skills: ["review-writing", "bib-check"],
    run: [],
    humanTasks: [
      {
        title: "核对定稿中的 [待核实] 与存疑条目",
        guidance:
          "review-final.md 的 [待核实] 与 citation-check.md 的「疑似编造/元数据存疑」只有你能对照原始文献拍板；逐条确认或改正后再算定稿",
        target: "",
        timing: "after",
      },
    ],
  },
];

/** 科研论文（research-paper）：选题调研 → 实验设计 → 实验执行 → 结果分析 → 初稿 → 投稿准备 */
const RESEARCH_PAPER_STEPS: ProjectStepDto[] = [
  {
    name: "选题与文献调研",
    workspaceName: "lit-survey",
    brief:
      "输入：英文综述模板的 notes/ 与 references.bib、数据处理模板的 analysis/ 分析报告与清洗后数据（接自上游模板时随仓库合并自带；独立启动本项目时，先把上游产物放入对应目录，或在资源面板绑定上游项目目录；没有上游产物时按下面流程自行检索补齐）。\n" +
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进 papers/screening.md 开头）执行：\n" +
      "1. 检索与筛选按 lit-search 技能：先定纳入/排除标准（年份、语言、来源级别、相关性），检索候选并逐条判定，产出 papers/screening.md（标准 + 各库检索式与命中数 + 每篇判定理由；拿不准相关性的一律纳入并标注「待确认」）与 papers/included.md（纳入清单，一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI）；用户导入的检索结果先解析去重、并入 screening.md 候选池再筛选——两处都要看：工作区内 papers/imports/ 目录，以及本文件「项目资源」段的「引文」条目与「上一步产物（提货单）」段中「人工交付」条目给出的绝对路径（按路径直读，勿复制进工作区）；\n" +
      "2. 全文获取：开放获取（arXiv/PMC/开放期刊/作者主页 preprint）的直接下载到 papers/（文件名：作者年份-短标题.pdf）；付费墙的不得尝试绕过，汇总写入 papers/to-fetch.md（标题 — DOI），等用户提供；\n" +
      "3. 精读按 lit-notes 技能：对 included.md 每篇产出 notes/<序号-短标题>.md（研究问题/方法/主要结果/局限/可引用点五段）；全文缺失（to-fetch.md 中的付费文献）按摘要+可见元数据写笔记，开头标注「仅摘要」；每篇在 references.bib 追加一条 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）；\n" +
      "4. 按主题归纳研究现状写入 survey/literature.md（主要线索、方法与结论的异同）；提炼 2-3 个候选研究问题，逐一分析现有工作的 gap（未解决的问题、方法的不足、数据的空白），写入 survey/gap-analysis.md；\n" +
      "5. 从候选中选定一个研究问题：优先选 gap 明确且数据/方法可支撑的；拿不准时选文献支撑最多的，并在 gap-analysis.md 记录取舍理由。\n" +
      "完成标准：papers/screening.md、papers/included.md、papers/to-fetch.md（无付费文献则注明为空）、notes/、survey/literature.md、survey/gap-analysis.md 均存在，研究问题明确唯一，references.bib 条目无空缺字段。",
    expectedArtifacts: ["papers/", "notes/", "survey/", "references.bib"],
    skills: ["lit-search", "lit-notes"],
    run: [],
    humanTasks: [
      {
        title: "补充你已知的关键文献",
        guidance:
          "agent 会系统检索 OpenAlex / Semantic Scholar 等可程序化库并按 DOI 去重；你补的是它搜不到的那部分——Undermind / Google Scholar / Elicit 等网页端的语义发现结果，或你读过、认定必须纳入的文献。到「文献与数据」导入即可（支持 Zotero 库、RIS/BibTeX 题录）。不补也能跑。",
        target: "papers/",
        timing: "before",
        optional: true,
      },
      {
        title: "确认研究问题",
        guidance:
          "agent 会从候选中选定一个并把取舍理由写进 survey/gap-analysis.md；方向性决策建议过目后再进入实验设计",
        target: "",
        timing: "after",
        optional: true,
      },
      {
        title: "下载付费墙文献全文",
        guidance:
          "渠道自选：机构图书馆/作者邮件索取 preprint 等；缺权限清单见 papers/to-fetch.md（agent 筛完会列出）；补齐后让 agent 重读全文、更新对应「仅摘要」笔记",
        target: "papers/*.pdf",
        timing: "after",
        optional: true,
      },
    ],
    decisions: [
      {
        q: "课题边界收多宽",
        options: ["只盯准备做的那条线", "铺满整个方向"],
      },
      {
        q: "研究问题怎么选",
        options: ["追热点求稳妥", "押高风险高回报的 gap"],
      },
      { q: "数据从哪来", options: ["公开数据集够用", "自己采集/申请"] },
    ],
  },
  {
    name: "实验设计",
    workspaceName: "exp-design",
    brief:
      "输入：survey/gap-analysis.md 确定的研究问题、notes/ 文献笔记与 references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 产出 design.md，逐项写死：研究方法（技术路线与关键假设）、数据来源（名称/规模/获取方式）、对比基线（至少 2 个，注明出处）、评价指标（主指标+辅指标，给出计算公式或出处）、实验矩阵（变量 × 取值的完整组合表）；\n" +
      "2. 每个设计决策给出依据（文献支撑处引用 notes/ 笔记或 bib 键）；依赖的资源（数据集/预训练模型）不可获取时换用公开替代品并标注，不留「待定」；\n" +
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
        optional: true,
      },
    ],
    decisions: [
      {
        q: "实验规模怎么定",
        options: ["先跑最小可行集", "只跑核心组合", "矩阵全跑"],
      },
    ],
    discussionSeeds: [
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
    decisions: [
      { q: "算力怎么排", options: ["本机跑", "上集群/云"] },
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
    decisions: [
      {
        q: "结果不如预期怎么办",
        options: ["阴性结果如实写进论文", "换方向补实验"],
      },
    ],
  },
  {
    name: "论文初稿",
    workspaceName: "paper-draft",
    brief:
      "输入：survey/、notes/、design.md、analysis/、figures/、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 按 IMRaD 结构用规范学术英文撰写初稿，产出 manuscript/draft.md：Introduction（研究问题+gap+贡献，现状综述引用 survey/ 与 notes/）、Methods（对应 design.md）、Results（对应 analysis/，引用 figures/ 图表）、Discussion（findings 的意义与局限）；目标篇幅：已初定投稿目标时按其惯常篇幅，未定目标时正文 6000-8000 词；\n" +
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
      "3. 统计报告自查（按 stats-check 技能的投稿前口径）：p 值给具体值并附效应量与置信区间、多重比较校正已说明、图注中的检验方法与显著性标记同正文一致；结果写入 analysis/stats-check.md，只列问题不改稿；\n" +
      "4. 产出 manuscript/paper-final.md 定稿与 manuscript/changelog.md（逐条列出主要修改点）；\n" +
      "5. 投稿材料清单写入 submission/checklist.md：目标期刊/会议（按主题匹配给出 2-3 个候选及理由）、cover letter 要点、图表源文件清单、作者信息与利益声明占位；未知信息一律占位「待填」，不编造。\n" +
      "完成标准：paper-final.md 引用闭环、changelog.md 与 submission/checklist.md 已提交、analysis/stats-check.md 问题清零或逐条列入 checklist 投稿前必办项；[待补实验] 全部清除，确无法完成的列入 checklist 投稿前必办项。",
    expectedArtifacts: [
      "manuscript/paper-final.md",
      "analysis/stats-check.md",
      "submission/",
    ],
    skills: ["bib-check", "stats-check"],
    humanTasks: [
      {
        title: "填写作者信息并初定投稿目标",
        guidance:
          "submission/checklist.md 中的作者信息/利益声明「待填」占位逐条补齐；目标期刊候选 2-3 个已附理由，可改选",
        target: "submission/checklist.md",
        timing: "after",
      },
    ],
    decisions: [
      { q: "目标期刊怎么定", options: ["冲高一档", "求稳妥投"] },
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
      "输入：项目已登记的数据资源（见下方「项目资源」段；无登记资源时扫描项目目录中的 CSV/parquet/JSON 等数据文件，并把扫描依据写进报告）。全程只读：原始数据一个字节都不改。\n" +
      "1. 逐数据集记录：来源、获取时间、规模（行数/大小）、格式与编码、字段清单，写入 data-dictionary.md；\n" +
      "2. 字段逐个标注类型/含义/取值范围/缺失比例；含义不明的字段标「待确认」，不猜测含义；\n" +
      "3. 质量问题单列一节：缺失、重复、异常取值、口径不一致，逐项给出样例行号或计数；\n" +
      "4. 敏感字段单列清单：疑似个人标识/隐私的字段只列字段名与判断依据，不复制内容样例；脱敏口径不写死，留人拍板（开工前的讨论种子已就此提问）；\n" +
      "5. 数据不可读或格式损坏时在报告中说明并停止，不自行修复原始数据。\n" +
      "完成标准：data-dictionary.md 覆盖全部数据集与字段，质量问题逐项有证据（行号/计数），敏感字段清单无内容样例。",
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
    decisions: [
      {
        q: "敏感字段怎么处理",
        options: ["先脱敏再分析", "无敏感字段，照常处理", "敏感字段整列排除"],
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
      "输入：data-dictionary.md（已随 main 合并在本工作区内；其中「待确认」字段若已由人补全口径，以补全值为准）。全程按 data-clean 技能执行：规则先行、原始数据只读。\n" +
      "1. 清洗规则逐项写死再动手：缺失值处理（删除/填充及填充值）、去重键、异常值边界、类型转换，写入 cleaning/rules.md，每条规则注明依据，不允许「视情况而定」项；\n" +
      "2. 粒度/合并拿不准时按确定规则办：保持原始粒度不聚合、多表不合并，在 rules.md 标 [待确认] 后继续其余规则，不停工等待；\n" +
      "3. 清洗脚本放入 cleaning/（可重复执行；输入只读原始数据，不原地修改）；\n" +
      "4. 处理后的数据写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不进 git；\n" +
      "5. 清洗报告 cleaning/cleaning-report.md：每条规则影响的行数、丢弃数据的清单与原因、清洗前后规模对比，[待确认] 规则单列一节。\n" +
      "完成标准：rules.md 无「视情况而定」项，脚本可重复跑通，报告数字与产物目录中的结果一致，原始数据字节级未被改动。",
    expectedArtifacts: ["cleaning/"],
    skills: ["data-clean"],
    run: [],
    humanTasks: [
      {
        title: "拍板 [待确认] 清洗规则",
        guidance:
          "cleaning/rules.md 与 cleaning-report.md 中标注 [待确认] 的条目（多为粒度/合并与拿不准的填充值）逐条拍板；可直接改 rules.md，agent 会按新口径重跑清洗",
        target: "",
        timing: "after",
      },
    ],
    decisions: [
      { q: "缺失值怎么处理", options: ["能填就填", "直接删除缺失行"] },
      { q: "分析粒度", options: ["保持原始粒度不聚合", "按人聚合", "按天聚合"] },
      { q: "多表要不要先合并", options: ["不合并，保持多表", "合并成一张宽表"] },
    ],
  },
  {
    name: "探索性分析",
    workspaceName: "data-eda",
    brief:
      "输入：产物目录中清洗后的数据与 cleaning/rules.md（已随 main 合并在本工作区内）。全程按 data-eda 技能执行：分布/相关/异常全覆盖不挑选、图表可复现、发现可回溯。\n" +
      "1. 分析与出图脚本放入 analysis/（main() 入口，从 main 重跑产出一致；只读产物目录数据，路径集中在模块顶部常量）；\n" +
      "2. 分布分析：各字段分布（直方图/统计量）逐个解读，不跳过「看起来正常」的字段；图表写入 figures/（英文标注，文件名与报告引用一一对应）；\n" +
      "3. 相关分析：全字段相关矩阵，强相关对（|r|≥0.7）全部列出并解读，不挑选；\n" +
      "4. 异常分析：按 rules.md 的口径复查残留异常，新发现的异常标 [待确认] 并给出样例行号；\n" +
      "5. 结论写入 eda-report.md：3-5 条可用于后续决策的发现，每条附对应图表或统计量；含统计检验/显著性表述的结论先按 stats-check 技能口径自查（检验方法与数据匹配、p 值给具体值、附效应量与置信区间）。\n" +
      "完成标准：analysis/ 脚本、figures/ 与 eda-report.md 均存在，每条发现可回溯到具体图表/数字，无主观臆断。",
    expectedArtifacts: ["analysis/", "figures/", "eda-report.md"],
    skills: ["data-eda", "stats-check"],
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
      "2. 产出 analysis-report.md：背景与数据口径 → 主要发现（引用 eda-report.md 条目）→ 结论 → 可执行建议（每条建议对应一条发现，优先级按确定规则排序：有直接数据支撑的排前，间接推断的排后并注明）；\n" +
      "3. 数字一律引用 eda-report.md 中的值，不重新计算、不引入新数据；证据不足的结论标 [待验证]；\n" +
      "4. 局限单列一节：数据质量、样本偏差、方法局限，不回避。\n" +
      "完成标准：analysis-report.md 结构完整，建议与发现一一对应且优先级有据；[待确认] 全部清除，确无法核实的列入局限。",
    expectedArtifacts: ["analysis-report.md"],
    skills: [],
    run: [],
    decisions: [
      {
        q: "报告给谁看",
        options: ["决策层：结论先行", "技术读者：细节可复核"],
      },
    ],
  },
];

/** 毕业论文（thesis）：开题与综述 → 研究方法 → 实验与结果 → 全文初稿 → 格式与定稿 */
const THESIS_STEPS: ProjectStepDto[] = [
  {
    name: "开题与文献综述",
    workspaceName: "proposal",
    brief:
      "输入：综述线产出的 notes/ 文献笔记与 references.bib（接自上游英文综述/科研论文模板时随仓库合并自带；独立启动本项目时，先把上游产物放入对应目录，或在资源面板绑定上游项目目录；没有上游产物时按下面第 1-3 条自行检索补齐）。\n" +
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源推断，并把推断写进 papers/screening.md 与开题报告）执行：\n" +
      "1. 检索与筛选按 lit-search 技能执行：先定纳入/排除标准（年份、语言、来源级别、相关性）写入 papers/screening.md，逐条判定后纳入清单写入 papers/included.md；拿不准相关性的一律纳入并标注「待确认」，不自行剔除；用户人工导入的题录先解析去重并进候选池——两处都要看：工作区内 papers/imports/ 目录，以及本文件「项目资源」段的「引文」条目与「上一步产物（提货单）」段中「人工交付」条目给出的绝对路径（按路径直读，勿复制进工作区）；\n" +
      "2. 全文获取：开放获取（arXiv/PMC/开放期刊/作者主页 preprint）的直接下载到 papers/（文件名：作者年份-短标题.pdf）；付费墙的不绕过，在 included.md 该行标注「需自行获取」并汇总到 papers/to-fetch.md（等人工补全文）；\n" +
      "3. 精读与笔记按 lit-notes 技能执行：included.md 逐篇产出 notes/<序号-短标题>.md（研究问题 / 方法 / 主要结果 / 局限 / 可引用点），每篇在 references.bib 追加 BibTeX（缺字段标「待补」）；全文未得的按摘要+可见元数据写笔记并在开头标注「仅摘要·待全文」，人工补齐全文后重读更新；\n" +
      "4. 产出 proposal/proposal.md 开题报告（按 proposal-writer 技能）：选题依据、研究内容、研究目标与创新点、技术路线、可行性与进度安排，引用只用 references.bib 已有键；\n" +
      "5. 产出 chapters/literature-review.md 综述章节草稿：按主题聚类组织，只引用 references.bib 中存在的键，不为综述新造引用。\n" +
      "完成标准：papers/screening.md 与 included.md 每条记录无空缺字段（未知标「待补」）；proposal.md 五节齐全；literature-review.md 引用键全部可解析；notes/ 与 references.bib 已提交。",
    expectedArtifacts: [
      "papers/",
      "notes/",
      "references.bib",
      "proposal/",
      "chapters/literature-review.md",
    ],
    skills: ["lit-search", "lit-notes", "proposal-writer"],
    run: [],
    humanTasks: [
      {
        title: "补充你已知的关键文献",
        guidance:
          "agent 会系统检索 OpenAlex / Semantic Scholar 等可程序化库并按 DOI 去重；你补的是它搜不到的那部分——Undermind / Google Scholar / Elicit 等网页端的语义发现结果，或你读过、认定必须纳入的文献。到「文献与数据」导入即可（支持 Zotero 库、RIS/BibTeX 题录）。不补也能跑。",
        target: "papers/",
        timing: "before",
        optional: true,
      },
      {
        title: "下载付费墙文献全文",
        guidance:
          "渠道自选：机构图书馆/作者邮件索取 preprint 等；缺权限清单见 papers/to-fetch.md（agent 检索后会列出）；补进 papers/ 后告诉 agent 重读全文、更新对应「仅摘要」笔记",
        target: "papers/*.pdf",
        timing: "during",
        optional: true,
      },
      {
        title: "开题报告送导师评阅",
        guidance:
          "proposal/proposal.md 可直接发导师；导师意见自行记录，可追加到该文件末尾供后续步骤参考",
        target: "proposal/",
        timing: "after",
        optional: true,
      },
    ],
    decisions: [
      { q: "检索年限", options: ["近五年", "近十年", "不限年限"] },
      { q: "文献语言", options: ["中英文都要", "只要英文"] },
      { q: "预印本要不要纳入", options: ["纳入并标注", "不纳入"] },
    ],
    discussionSeeds: [
      "研究问题聚焦到哪：导师给的大方向里，切哪一块是你真能做完的？",
    ],
  },
  {
    name: "研究方法",
    workspaceName: "methodology",
    brief:
      "输入：proposal/proposal.md 的研究内容与技术路线、chapters/literature-review.md（已随 main 合并在本工作区内）。\n" +
      "1. 产出 chapters/methodology.md 方法章节草稿：方法原理、实现步骤、数据来源与预处理、评价指标，逐节对应开题报告的研究内容；\n" +
      "2. 产出 design.md 实验设计：对比基线（注明出处）、实验矩阵（变量 × 取值完整组合）、预期结果与分析方式；统计设计按 stats-check 技能的实验设计口径自查（主要结局指标唯一明确、样本量有依据、剔除标准事先定义），涉及统计检验的写明检验方法与多重比较校正口径；\n" +
      "3. 每个方法选择给出依据；与开题报告不一致的改动在 methodology.md 末尾「变更说明」记录原因，不静默改方案；\n" +
      "4. 依赖的资源（数据集/预训练模型）不可获取时换用公开替代品并标注，不留「待定」。\n" +
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
        optional: true,
      },
    ],
    decisions: [
      { q: "技术路线押哪条", options: ["成熟方案保毕业", "新方法冲创新点"] },
    ],
    discussionSeeds: [
      "基线与评价指标怎么定：跟谁比、比到什么程度算达到预期？",
    ],
  },
  {
    name: "实验与结果",
    workspaceName: "thesis-exp",
    brief:
      "输入：design.md 的实验矩阵、chapters/methodology.md（已随 main 合并在本工作区内）。\n" +
      "1. 实验代码放入 experiments/（可重复执行，参数集中在文件头或配置文件），逐项跑实验矩阵；\n" +
      "2. 原始结果与日志写入项目产物目录（见下方「产物目录」段；未配置时用项目根 artifacts/），不进 git；results/summary.md 逐项记录：配置、指标数值、产物目录路径；\n" +
      "3. 失败实验在 summary.md 标注原因并按 design.md 的备选方案重跑一次，仍失败则记录后继续；\n" +
      "4. 产出 chapters/results.md 结果章节草稿：表格汇总（方法 × 指标，最优值加粗）+ 关键图表（figures/，出图按 figure-forge 技能）+ 逐项解读；解读只用 summary.md 中的数字，推测性内容标 [推测]；涉及统计显著性的表述按 stats-check 技能口径（p 值给具体值、附效应量与置信区间）。\n" +
      "完成标准：矩阵每项有结果或失败记录，results.md 数字与 summary.md 一致，figures/ 已提交。",
    expectedArtifacts: [
      "experiments/",
      "results/summary.md",
      "chapters/results.md",
      "figures/",
    ],
    skills: ["figure-forge", "stats-check"],
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
    decisions: [
      {
        q: "实验做到什么程度收手",
        options: ["核心结果出来就转写作", "矩阵全跑完"],
      },
      {
        q: "结果不如预期怎么办",
        options: ["阴性结果如实写进论文", "换方向补实验"],
      },
    ],
  },
  {
    name: "论文初稿",
    workspaceName: "thesis-draft",
    brief:
      "输入：chapters/ 各章草稿、references.bib、figures/、proposal/proposal.md（已随 main 合并在本工作区内）。\n" +
      "1. 按学校论文模板结构（封面/摘要/目录/正文各章/参考文献/致谢；项目内无模板文件时用通用学位论文结构、语种默认中文，并在 manuscript/README.md 注明所依据的结构）组装全文初稿 manuscript/thesis-draft.md；\n" +
      "2. 补齐缺失章节：引言（研究背景+问题+贡献，对应开题报告）、结论与展望（对应结果章节）；\n" +
      "3. 统一各章术语、符号与图表编号；引用一律 [@bib键] 且只能引用 references.bib 已有键——严禁编造文献；\n" +
      "4. 图表引用占位（「图 3-1：…」），数字与 chapters/results.md 一致，不一致处以结果章节为准并在修订记录标注；\n" +
      "5. 产出 manuscript/revision-notes.md：组装过程中的取舍与待确认项；\n" +
      "6. 渲染验证：用本步骤 run 脚本渲染 PDF/docx（环境检查与产物登记按 quarto-render 技能），渲染报错先按技能指引补依赖，不绕路。\n" +
      "完成标准：thesis-draft.md 章节齐全、引用闭环、revision-notes.md 已提交、run 脚本渲染通过。",
    expectedArtifacts: ["manuscript/"],
    skills: ["quarto-render"],
    decisions: [{ q: "论文语种", options: ["中文", "英文"] }],
    discussionSeeds: [
      "章节权重怎么分：哪几章是答辩老师最看重、要重点打磨的？",
      "学校的字数与章节要求是什么：有没有硬性模板要对齐？",
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
      "4. 引用闭环核对按 bib-check 技能执行：正文引用键逐条对照 references.bib，参考文献列表按 bib 生成、逐条核对字段齐全（缺字段标「待补」）；\n" +
      "5. 产出 manuscript/thesis-final.md 定稿与 manuscript/changelog.md（逐条列出修改点）；\n" +
      "6. 渲染验证：用本步骤 run 脚本渲染 PDF/docx（环境检查与产物登记按 quarto-render 技能）。\n" +
      "完成标准：format-check.md 问题逐条有处理结论，thesis-final.md 引用闭环，changelog.md 已提交，run 脚本渲染通过。",
    expectedArtifacts: [
      "manuscript/thesis-final.md",
      "manuscript/format-check.md",
      "manuscript/plagiarism-advice.md",
      "manuscript/changelog.md",
    ],
    skills: ["bib-check", "quarto-render"],
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
    decisions: [
      {
        q: "查重目标",
        options: ["按学校红线即可", "压到 15% 以下", "压到 10% 以下"],
      },
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
      "输入：manuscript/paper-final.md 或 manuscript/review-final.md、references.bib（接自上游科研论文/英文综述模板时随仓库合并自带；独立启动本项目时，先把上游成稿与 references.bib 放入对应目录，或在资源面板绑定上游项目目录；两个稿件都不存在时在报告中说明并停止，不自行改用其他草稿）。\n" +
      "1. 确定目标期刊：项目根已有 submission/target-journal.md 时从其约定；没有则按课题主题给出 2-3 个候选期刊及理由，写入 submission/target-journal.md，选第一个执行并标注「待用户确认」；\n" +
      "2. 获取目标期刊官方作者指南（WebFetch 期刊官网 Guide for Authors；获取失败时按通用 IMRaD 与 APA 引用格式执行，并在 format-notes.md 说明依据）；\n" +
      "3. 按指南逐项适配：章节结构、引用与文献列表格式、图表规范、字数与摘要长度；产出 submission/formatted.md，只改格式与表达，不改学术观点与数据；\n" +
      "4. 字数或摘要超限时不得自行删内容：在 formatted.md 原位标注超出量，把可选裁剪方案（砍哪节、砍多少）逐条写进 submission/format-notes.md 由用户定夺；\n" +
      "5. 引用完整性自查（按 bib-check 技能）：正文引用键全部可在 references.bib 解析、bib 条目字段齐全，问题清单写入 submission/format-notes.md；\n" +
      "6. 作者单位/基金号/通讯邮箱等未知信息一律占位「待填」，不编造；所有未决项汇总进 submission/format-notes.md。\n" +
      "完成标准：submission/formatted.md 与 submission/target-journal.md、submission/format-notes.md 均已提交；format-notes.md 逐项给出处理结论。",
    expectedArtifacts: ["submission/"],
    skills: ["bib-check"],
    run: [],
    humanTasks: [
      {
        title: "放入成稿与 references.bib",
        guidance:
          "独立启动本模板时，把上游模板产出的成稿（manuscript/paper-final.md 或 manuscript/review-final.md）与 references.bib 放入项目对应目录；接自上游模板时随仓库合并自带，可跳过",
        target: "manuscript/",
        timing: "before",
      },
      {
        title: "写下已定目标期刊（如已确定）",
        guidance:
          "已确定期刊时在 submission/target-journal.md 写明刊名与理由；没有则 agent 会给 2-3 个候选并标注「待用户确认」",
        target: "submission/target-journal.md",
        timing: "before",
        optional: true,
      },
      {
        title: "拍板目标期刊、字数裁剪方案并补齐「待填」信息",
        guidance:
          "期刊候选与字数超限裁剪方案（如有）见 submission/target-journal.md 与 format-notes.md；作者单位/基金号/通讯邮箱等占位在 formatted.md 与 format-notes.md 中汇总",
        target: "submission/",
        timing: "after",
      },
    ],
    decisions: [
      { q: "目标期刊怎么选", options: ["冲高一档", "求稳保一档"] },
      {
        q: "字数超标先砍哪部分",
        options: ["砍讨论", "砍方法细节", "砍文献量", "换更长篇幅的刊"],
      },
    ],
  },
  {
    name: "投稿材料",
    workspaceName: "submission-materials",
    brief:
      "输入：submission/formatted.md、submission/target-journal.md（已随 main 合并在本工作区内）。\n" +
      "1. 产出 submission/cover-letter.md：编辑称呼占位、研究问题与 3 条亮点、与期刊读者群的契合点、原创性与未一稿多投声明（占位「待填」处不编造）；\n" +
      "2. 产出 submission/highlights.md：3-5 条期刊格式要点的 highlights（目标期刊无此要求时在该文件注明并跳过）；\n" +
      "3. 投稿前自查 formatted.md（模拟审稿人视角逐项过）：摘要与结论自洽、正文数字与表格一致、图表 standalone 可读、方法节可复现、局限有交代；问题按 CRITICAL（不处理大概率被拒，如数据不一致）/ MAJOR（影响评审印象）/ MINOR（措辞格式）三级写入 submission/pre-review.md：CRITICAL/MAJOR 逐条处理或写明不处理的理由，MINOR 列出即可；\n" +
      "4. 产出 submission/checklist.md 投稿清单：投稿系统入口（未知标「待填」）、需上传文件清单、作者信息与利益声明占位、推荐审稿人 2-4 位（只给研究领域与选择理由，具体姓名标「待填」）。\n" +
      "完成标准：cover-letter.md、highlights.md、pre-review.md、checklist.md 均已提交；pre-review.md 中 CRITICAL/MAJOR 全部有处理结论。",
    expectedArtifacts: [
      "submission/cover-letter.md",
      "submission/pre-review.md",
      "submission/checklist.md",
    ],
    skills: [],
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
      "给编辑讲什么故事：cover letter 押哪三条亮点，期刊读者群最吃哪一套？",
      "推荐审稿人怎么圈：避开利益冲突又要懂行，从哪些组里挑？",
    ],
  },
  {
    name: "审稿意见回复",
    workspaceName: "rebuttal",
    brief:
      "输入：reviews/round-1.md 审稿意见全文（用户把编辑来信粘贴保存为该文件；文件缺失时提示用户提供并停止，不得编造审稿意见）；submission/formatted.md（已随 main 合并在本工作区内）。\n" +
      "全程按 rebuttal-crafter 技能执行；本步骤明确要求产出修订稿（技能默认不改稿件正文，此处以本简报为准）。\n" +
      "1. 逐条拆分审稿意见并编号（R1.1、R1.2…，多位审稿人分节，编辑意见单列 E.1…），不遗漏任何一条；\n" +
      "2. 产出 rebuttal/response-letter.md，逐条回应：意见摘要 → 回应（接受修改 / 部分接受并说明限制 / 礼貌反驳并给依据）→ 稿件修改位置（节+段落）；语气先谢后答；拿不准如何回应的一律按「部分接受+说明限制」写，并标 [待确认]；\n" +
      "3. 能改的直接改进稿件，产出 manuscript/revised.md（在 formatted.md 基础上修改，标注各修改对应的意见编号）；无法靠修改解决的（需补实验/补数据）在回应中给出可执行的补做计划并标 [待补实验]，不开空头支票；\n" +
      "4. 产出 rebuttal/revisions.md 修改对照表：每条意见 → 修改点 → revised.md 中的位置，逐条可核对；\n" +
      "5. 第二轮起的返修：意见保存为 reviews/round-2.md（依此类推），在本轮 revised.md 基础上继续修订，产物命名加轮次后缀（response-letter-r2.md 等）。\n" +
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
          "response-letter.md 中标注 [待确认] 的条目是 agent 拿不准的回应，逐条拍板",
        target: "rebuttal/response-letter.md",
        timing: "after",
      },
      {
        title: "补做审稿人要求的实验（如有）",
        guidance:
          "response-letter.md 中 [待补实验] 条目逐条安排；新结果按项目产物目录口径存放，改稿与对照表对应位置由你或在下一轮让 agent 更新",
        target: "",
        timing: "after",
      },
      {
        title: "返修定稿后到投稿系统提交",
        guidance:
          "response-letter.md 与 manuscript/revised.md 定稿后自行到投稿系统上传；提交前用 rebuttal/revisions.md 逐条核对一遍",
        target: "",
        timing: "after",
      },
    ],
    decisions: [
      {
        q: "回复策略怎么定",
        options: ["意见尽量接受修改", "该反驳的坚决反驳"],
      },
    ],
    discussionSeeds: [
      "补实验的底线在哪：审稿人要的新实验哪些做哪些拒，时间与资源预算卡在哪？",
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
