import type { HumanTaskDto, ProjectStepDto } from "./types";

/**
 * 内置流水线模板库（§11.3 机制二、§11.4 P1b 首启引导轻量版）：
 * 步骤是写在 project.toml 里的可编辑预设，引擎不识别「文献/论文」语义。
 * 六套内置模板覆盖综述/科研论文/数据处理/毕业论文/投稿与返修/LaTeX 论文，新增场景 = PIPELINE_TEMPLATES 加一项；
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
  /** 全局设定的建议项（v3.89）：贯穿全程的决定——应用模板时预填进项目层，
   *  而不是塞进某一步的决策项（那属层级错配：它们决定后面每一步）。
   *  形如「综述角度：」的空答案，用户在项目设置里补全 */
  projectSettings?: string[];
}

export type SubmissionMode = "initial" | "revision";

const LIT_SEARCH_ARTIFACTS = [
  "papers/screening.md",
  "papers/included.md",
  "papers/to-fetch.md",
  "papers/to-fetch.ris",
];

const MANUSCRIPT_FINALS = [
  "manuscript/paper-final.md",
  "manuscript/review-final.md",
  "manuscript/thesis-final.md",
];

function mcpLitSearchTask(): HumanTaskDto {
  return {
    title: "（可选）配置学术检索 MCP",
    guidance:
      "到 MCP 页用预设导入 Consensus / Undermind（密钥走环境变量引用，不落明文）。不配也能跑：OpenAlex / Semantic Scholar / arXiv / Crossref 免 key。",
    target: "",
    timing: "before",
    optional: true,
    completion: "manual",
  };
}

function paywallPdfTask(timing: "after" | "during" = "after"): HumanTaskDto {
  return {
    title: "下载付费墙文献全文",
    guidance:
      "拿到全文后导入文献与数据，或直接拖到这一行——文件会落到**项目根 papers/**，不是当前工作区。\n\n" +
      "agent 筛完会把拿不到全文的列进 papers/to-fetch.md，并附 papers/to-fetch.ris——拖进 Zotero 会自动建成待获取列表。渠道自选：机构图书馆、作者邮件索取 preprint 等。拿到后：把 PDF 拖到这一行，或拷进项目 papers/ 目录，或放进你的文献库后到「文献与数据」重新导入（进库的导完回来手动勾一下）。文件名随意，下一步 agent 会统一改成 作者年份-短标题.pdf；不补的话 agent 按摘要写笔记并标注「仅摘要」。",
    target: "papers/*.pdf",
    timing,
    optional: true,
  };
}

/** 英文综述（review）：文献检索 → 精读笔记 → 大纲 → 初稿 → 润色定稿 */
const REVIEW_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    role: "both",
    workspaceName: "lit-search",
    brief:
      "输入：课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源推断一个最可能的主题，写进 papers/screening.md 开头「检索主题假设」一节，并按该假设执行到底，不留「待定」）。全程按 lit-search 技能执行。全局设定若写了「综述深度：严格档」，按技能严格档（引用扩展强制、screening 末尾 PRISMA-S 最小披露）；未写或标准档则按技能默认标准档。本文仍是单人筛选，不是双人系统综述，Methods 里如实声明。\n" +
      "1. 制定纳入/排除标准（年份、语言、来源级别、相关性口径），写进 papers/screening.md。" +
      "**先粗检一轮报数再定标准**：用主题词在 OpenAlex 粗查命中量，把「命中约 N 篇」与你建议的标准写进 " +
      ".ccode/help-wanted.md 问用户一句（附兜底：若未回复则按你建议的标准继续），写完不要停工、按兜底往下做。" +
      "——标准松紧取决于命中量，开工前问用户等于让他在没有数字的时候猜；\n" +
      "2. 先解析人工导入的题录（RIS/BibTeX/CSV），三处都要看：① 本文件「项目根」下 papers/imports/；② 工作区内 papers/imports/；③ 「项目资源」段类型为「引文」的条目、以及「上一步产物（提货单）」段中来自「人工交付」的条目——后两类给绝对路径，按路径直读、勿复制。都没有才跳过。解析后按 lit-search 技能口径去重合并进候选池，每条保留来源标注；\n" +
      "3. 检索候选文献：OpenAlex / Semantic Scholar / arXiv / Crossref 官方 API 免 key 直连（WebFetch/curl），每个库的检索式、检索日期与命中数记入 papers/screening.md；人工事项若已配 Consensus/Undermind MCP 可直接调用；WoS/SerpAPI 等付费 key 一律用 $VAR 环境变量引用，禁止写进任何文件；末尾写覆盖缺口声明（哪些库没检）；\n" +
      "4. 按标准逐条筛选，每篇给出纳入/排除及理由；拿不准相关性的一律纳入并标注「待确认」，不允许自行裁掉；\n" +
      "5. 纳入清单写入 papers/included.md（一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI）；\n" +
      "6. 全文获取分两类：开放获取（arXiv/PMC/开放期刊/作者主页 preprint）直接下载到**项目根 papers/**（见上方「项目根」，文件名规范化：作者年份-短标题.pdf），不要下载到本工作区；付费墙不得尝试绕过，在 included.md 该行末尾标注「需自行获取」，并汇总写入 papers/to-fetch.md（标题 — DOI）等用户提供全文，同时把 to-fetch.md 转成 papers/to-fetch.ris（RIS 2004：每篇 TY - JOUR + TI/DO/UR 尽力而为，缺字段留空不编造），供用户一键导入 Zotero 建成待获取列表。\n" +
      "完成标准：papers/screening.md、papers/included.md、papers/to-fetch.md、papers/to-fetch.ris 均存在（无付费文献则 to-fetch 两个文件注明为空），每条记录无空缺字段（未知则标「待补」），筛选记录含检索日期与覆盖缺口、能让第三人按标准复现每条判定。",
    expectedArtifacts: [...LIT_SEARCH_ARTIFACTS],
    skills: ["lit-search"],
    asksLitSource: true,
    run: [],
    humanTasks: [mcpLitSearchTask(), paywallPdfTask("after")],
    decisions: [],
  },
  {
    name: "文献精读与笔记",
    role: "both",
    workspaceName: "lit-notes",
    brief:
      "输入：上一步产物 papers/included.md 与 papers/to-fetch.md（已随 main 合并在本工作区内）。全程按 lit-notes 技能执行。\n" +
      "1. 先整理人工补投：项目根 papers/（见上方「项目根」，含未进本工作区的文件，按绝对路径读）中命名不符「作者年份-短标题.pdf」的 PDF，对照 included.md/to-fetch.md 判定归属后重命名规范，并在 to-fetch.md 勾掉已补行（拿不准归属的不改名、标注「待确认」）；再按 included.md 清单逐篇精读（先读「待确认」之外的纳入项；清单缺失或为空时在报告中说明并停止，不要自行换题或自行补清单）；\n" +
      "2. 精读力度按需问（v3.97）：力度取决于清单规模与全文到位率，开工前问等于让人盲猜。**先粗读 included.md 全部条目的标题与摘要，把「共 N 篇、全文到位 M 篇、我建议核心精读 K 篇（列篇目）其余按摘要记」写进 .ccode/help-wanted.md 问用户一句**（附兜底：若未回复则按你建议的分配继续），写完不要停工、按兜底往下做；\n" +
      "3. 全文来源优先级（写死）：项目根 papers/ 已有 PDF（含人工补投）→ 开放获取补下到项目根 papers/（arXiv/PMC/作者主页 preprint）→ 仍缺（papers/to-fetch.md 中的付费文献）按摘要+可见元数据写笔记，并在笔记开头标注「仅摘要·待全文」，不得装作读过全文；\n" +
      "4. 每篇产出 notes/<序号-短标题>.md，开头先记来源锚点行「> 来源 PDF：<项目内相对路径>.pdf」（沉浸阅读区靠它认回笔记不另建重复），固定结构按 lit-notes 技能八段：一句话总结（≤50字）/ 研究问题 / 方法（附可复现细节）/ 主要结果（区分实验证明与作者推测，注页码+表/图编号）/ 局限（作者自述与本笔记识别分开列）/ 可引用点（原文关键句+页码或段落位置）/ 与本课题的关系 / 疑问与待跟进（待跟进引用同时追加 papers/to-fetch.md）；\n" +
      "5. 每篇在 references.bib 追加一条 BibTeX（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」、未经权威源核对标「待核」，不得编造）；\n" +
      "6. 收尾前复查：notes/ 中「仅摘要」笔记对应的全文若已出现在项目根 papers/（人工补投），重读全文并更新该笔记、去掉标记；仍未补的保持标注并在报告末尾计数说明。\n" +
      "完成标准：included.md 每篇都有对应笔记与 bib 条目；notes/ 与 references.bib 均已提交。",
    inputs: ["papers/included.md", "papers/to-fetch.md"],
    optionalInputs: ["papers/*.pdf"],
    expectedArtifacts: ["notes/*.md", "references.bib", "papers/to-fetch.md"],
    skills: ["lit-notes"],
    run: [],
    humanTasks: [
      {
        title: "继续精读笔记（沉浸阅读区）",
        guidance:
          "验收后想补读或修正哪篇笔记：项目详情的产物清单、或终端页文件树里点开 notes/ 中那份 md →「⛶ 沉浸阅读」进三栏阅读区（笔记｜PDF｜Agent 并排，笔记可直接改，右栏 agent 也能改同一份）。改的是主仓里的笔记本身——改完到「改动」面板提交一下，后面的大纲/初稿步骤读到的就是你的修改版（主仓未提交的改动不进下一步工作区，开工弹层也会提醒）。",
        target: "",
        timing: "after",
        optional: true,
      },
    ],
    // 「精读力度怎么分」卡片已移除（v3.97，用户拍板）：力度要看到清单规模和全文到位率才定得了，
    // 开工前点卡片等于让人盲猜——与 v3.89 移除「纳入标准定多严」同一道理。
    // 改为 agent 粗读清单后带着数字经 help-wanted.md 按需问（见上方简报第 2 条）。
    decisions: [],
  },
  {
    name: "综述大纲",
    role: "you",
    workspaceName: "outline",
    brief:
      "输入：notes/ 全部笔记、papers/included.md 与 references.bib（已随 main 合并在本工作区内）。框架构造全程按 review-framework 技能执行（空白清单 → 范式卡片 → 融合）：\n" +
      "1. 提炼研究空白清单：通读 notes/ 各笔记的「局限」与「可引用点」，最新一批精读文献回到原文前言核对作者自述的 gap（优先级最高）；每条空白标注来源笔记/bib 键，多条指向同一空白时合并；仅凭单篇文献主观抱怨的标「孤证」；\n" +
      "2. 拆解范式卡片：从 papers/included.md 选 2-3 篇权威综述类文献（期刊级别/被引优先；清单里没有综述类文献时如实说明并跳过本步，不虚构范式），每篇拆「结构逻辑 / 详略配比 / 论证顺序」三项；\n" +
      "3. **先报候选再融合**：把拆出的范式卡片连同「我建议以哪篇为骨架（按覆盖空白数给理由）+ 建议的综述卖点（想让读者读完记住的一句话）」写进 .ccode/help-wanted.md 问用户一句（附兜底：若未回复则按建议执行），写完不要停工、按兜底往下做。——骨架与卖点是全篇最贵的返工点，但开工前问等于让用户在没看到候选时盲选；\n" +
      "4. 融合构造框架：以覆盖空白最多的范式做骨架（用户已拍板时从用户选择），每条空白落到具体章节；范式冲突时选覆盖空白更多的，落选范式的局部优点吸收为节内参考；不新造与空白无关的章节；空白无处安放时允许新增章节并在该节标注「空白驱动新增」；\n" +
      "5. 产出 outline.md：章节结构（引言 / 背景 / 主题各节 / 讨论 / 结论），每节给要点（3-6 条）、拟引用 bib 键、回应空白编号；末尾固定附「## 框架推演」段（空白清单 / 范式卡片 / 融合理由三块）；\n" +
      "6. 只引用 references.bib 中存在的键，不为大纲新造引用。\n" +
      "完成标准：outline.md 结构完整，每节要点/引用键/回应空白齐全，「框架推演」段三块内容齐备。",
    expectedArtifacts: ["outline.md"],
    inputs: ["notes/", "papers/included.md", "references.bib"],
    skills: ["review-framework"],
    run: [],
    humanTasks: [
      {
        title: "审阅 outline.md 再开初稿",
        guidance:
          "重点看末尾「框架推演」段的取舍理由与空白-章节对应；框架不合意时回任务书草稿改，比初稿写完再返工便宜",
        target: "",
        timing: "after",
        // 非可选（用户拍板）：大纲是全流水线返工最贵的点，不合意时初稿整篇白写——
        // 进主干流程线 + 评审收尾提醒 + 下一步开工弹层二次确认，三处一起提醒
      },
    ],
    // 讨论种子已移除（用户拍板，与 v3.89 检索步移除决策项同一道理）：范式锚点/卖点
    // 要看到候选范式卡片才定得了，开工前点卡片等于盲猜；且只读想法卡聊完要手动
    // 「◈ 沉淀」、只追加草稿末尾，对「定任务书参数」类问题是绕路。改为简报第 3 条
    // 带候选经 help-wanted 按需问；「跟 AI 商量一下」开场本就逐条问拿不准的点。
  },
  {
    name: "综述初稿",
    workspaceName: "draft",
    brief:
      "输入：outline.md（含「框架推演」段）、notes/、references.bib（已随 main 合并在本工作区内）。写作规范全程按 review-writing 技能执行。\n" +
      "1. 按 outline.md 用规范学术英文撰写综述初稿，产出 manuscript/draft.md（目标 6000-8000 词，课题主题段另有约定时从其约定）；全局设定为严格档时，Methods 须写检索策略（库、日期、式、筛选流程），并声明本文为单人筛选、不是双人系统综述；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献、严禁新造键；\n" +
      "3. 对照表用 markdown 真表，不假装已绘图；概念图/流程图可占位「图 N：…（待绘制）」，不虚构数据；\n" +
      "4. 没有文献支撑的论断不得下；必须保留的判断在句末标 [待核实]；\n" +
      "5. 用本步骤 run 脚本渲染 PDF/docx（环境检查与产物登记按 quarto-render 技能），产物写入项目根 output/。\n" +
      "完成标准：manuscript/draft.md 覆盖大纲全部章节，引用键全部可在 references.bib 中解析，run 脚本渲染通过。",
    expectedArtifacts: ["manuscript/draft.md", "output/draft.pdf", "output/draft.docx"],
    inputs: ["outline.md", "notes/", "references.bib"],
    skills: ["review-writing", "quarto-render"],
    run: [
      { name: "render-draft", command: "quarto render manuscript/draft.md --to pdf --output-dir output", default: true },
      { name: "export-docx", command: "quarto render manuscript/draft.md --to docx --output-dir output", default: true },
    ],
  },
  {
    name: "润色与定稿",
    role: "you",
    workspaceName: "polish",
    brief:
      "输入：manuscript/draft.md 与 references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 先按 bib-check 技能对 draft.md 做引用完整性校验，产出 manuscript/citation-check.md（该技能只读不改稿：未解析引用/字段缺失/元数据存疑逐条列出，联网可用时加做 Crossref/arXiv 外部核验）；\n" +
      "2. 按报告修正（修稿由本步执行，不是 bib-check 的职责）：未解析引用键改为 references.bib 中正确键或补条目（补条目缺字段标「待补」）；「疑似编造」条目不得自行删除对应论断，句末标 [待核实] 并在 changelog 记录；「未引用条目」只在报告列出、不删；\n" +
      "3. 语言润色按 review-writing 技能阶段三：语法、用词、句式与段落衔接，保持学术语气；只改表达，不改学术观点；图表占位编号连续；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "4. 产出 manuscript/review-final.md 定稿（文末 References 节按 references.bib 生成完整文献列表）与 manuscript/changelog.md（逐条列出主要修改点及对应 citation-check.md 条目；未补的「待绘制」占位列入 changelog，不得假装已绘）；\n" +
      "5. 收尾再按 bib-check 复核 review-final.md，结论追加进 citation-check.md；\n" +
      "6. 用本步骤 run 脚本渲染 PDF/docx（按 quarto-render 技能），产物写入项目根 output/。\n" +
      "完成标准：review-final.md 无语法硬伤、引用键全部可解析；citation-check.md 结论为通过（遗留问题均已标 [待核实] 并列入 changelog）；changelog.md 已提交；run 脚本渲染通过。",
    expectedArtifacts: [
      "manuscript/review-final.md",
      "manuscript/changelog.md",
      "manuscript/citation-check.md",
      "output/review-final.pdf",
      "output/review-final.docx",
    ],
    inputs: ["manuscript/draft.md", "references.bib"],
    skills: ["review-writing", "bib-check", "quarto-render"],
    run: [
      { name: "render-final", command: "quarto render manuscript/review-final.md --to pdf --output-dir output --output review-final.pdf", default: true },
      { name: "export-docx", command: "quarto render manuscript/review-final.md --to docx --output-dir output --output review-final.docx", default: true },
    ],
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

/** 科研论文（research-paper）：检索筛选 → 精读与研究空白 → 实验设计 → 实验执行 → 结果分析 → 初稿 → 投稿准备 */
const RESEARCH_PAPER_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    role: "both",
    workspaceName: "lit-survey-search",
    brief:
      "输入：英文综述模板的 notes/ 与 references.bib（接自上游模板时随仓库合并自带；独立启动本项目时，先把上游产物放入对应目录，或在资源面板绑定上游项目目录）。\n" +
      "若项目根已有 notes/ 或 papers/included.md：**查漏补缺，不覆盖已有笔记**——盘点已有清单与笔记，按本课题的实证问题补检索、补纳入；旧笔记只追加不改写。没有上游产物时按下面流程全量检索。\n" +
      "围绕课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源自行判断，并把假设写进 papers/screening.md 开头）执行：\n" +
      "1. 检索与筛选按 lit-search 技能：**先粗检一轮报数再定标准**（OpenAlex 命中约 N 篇与建议标准写入 .ccode/help-wanted.md，附兜底不停工）；产出 papers/screening.md（标准 + 各库检索式、检索日期与命中数 + 每篇判定理由；拿不准相关性的一律纳入并标注「待确认」）与 papers/included.md；用户导入的检索结果先解析去重——看项目根 papers/imports/、工作区 papers/imports/、以及「项目资源」「提货单」里的绝对路径；\n" +
      "2. 全文获取：开放获取直接下载到**项目根 papers/**（文件名：作者年份-短标题.pdf），不要下载到本工作区；付费墙不得绕过，汇总写入 papers/to-fetch.md 并转 papers/to-fetch.ris。\n" +
      "完成标准：四件套均已提交（无付费文献则 to-fetch 注明为空），筛选记录含检索日期与覆盖缺口、可复现。",
    optionalInputs: ["notes/", "references.bib", "papers/included.md"],
    expectedArtifacts: [...LIT_SEARCH_ARTIFACTS],
    skills: ["lit-search"],
    asksLitSource: true,
    run: [],
    humanTasks: [mcpLitSearchTask(), paywallPdfTask("after")],
    decisions: [],
  },
  {
    name: "精读与研究空白",
    role: "both",
    workspaceName: "lit-survey-gap",
    brief:
      "输入：上一步的 papers/included.md、papers/to-fetch.md 与 references.bib。按 lit-notes 技能完成精读与笔记：先整理项目根 papers/ 里的人工补投并更新 to-fetch.md；已有 notes/ 时只补缺篇、不覆盖旧笔记。全文缺失时按摘要+可见元数据写笔记并标注「仅摘要·待全文」。\n" +
      "**先粗读 included.md 全部条目的标题与摘要，把「共 N 篇、全文到位 M 篇、我建议核心精读 K 篇」写进 .ccode/help-wanted.md 问用户一句**（附兜底不停工）。\n" +
      "在笔记基础上按主题归纳研究现状写入 survey/literature.md，提炼 2-3 个候选研究问题并逐一分析现有工作的 gap，写入 survey/gap-analysis.md。先把候选、每个 gap 的证据与我建议的研究问题写入 .ccode/help-wanted.md 问用户一句（若未回复则按证据最充分且数据/方法可支撑的方案继续），写完不要停工。\n" +
      "完成标准：included.md 每篇都有对应笔记与 references.bib 条目；survey/literature.md 与 survey/gap-analysis.md 齐全；研究问题唯一且取舍理由可追溯。",
    inputs: ["papers/included.md", "papers/to-fetch.md"],
    optionalInputs: ["references.bib", "papers/*.pdf", "notes/"],
    expectedArtifacts: [
      "notes/*.md",
      "survey/literature.md",
      "survey/gap-analysis.md",
      "references.bib",
      "papers/to-fetch.md",
    ],
    skills: ["lit-notes"],
    run: [],
    humanTasks: [
      {
        title: "确认研究问题",
        guidance: "候选研究问题与证据见 survey/gap-analysis.md；确认后再进入实验设计",
        target: "",
        timing: "after",
        completion: "manual",
      },
    ],
    decisions: [
    ],
  },
  {
    name: "实验设计",
    role: "both",
    workspaceName: "exp-design",
    brief:
      "输入：survey/gap-analysis.md 确定的研究问题、notes/ 文献笔记与 references.bib（已随 main 合并在本工作区内）。本模板默认计算实验（脚本、矩阵、算力）；全局设定若写了其他研究形态，按该形态改写实验矩阵，不要假装跑了没做的计算。\n" +
      "1. 产出 design.md，逐项写死：可检验假设（H1/H2，主结局唯一）、研究方法（技术路线与关键假设）、数据来源（名称/规模/获取方式）、对比基线（至少 2 个，注明出处）、评价指标（主指标+辅指标，给出计算公式或出处）、实验矩阵（变量 × 取值的完整组合表）、停止规则（什么情况下不再加实验、不改主指标）；\n" +
      "2. 每个设计决策给出依据（文献支撑处引用 notes/ 笔记或 bib 键）；依赖的资源（数据集/预训练模型）不可获取时换用公开替代品并标注，不留「待定」；\n" +
      "3. 估算每项实验的计算开销，超出本机条件的组合在矩阵中标注「裁剪」并说明裁剪规则；\n" +
      "4. design.md 末尾附风险清单：最可能失败的环节与备选方案；伦理批件/数据许可若需要，列入人工事项，不编造已获批；\n" +
      "5. 统计设计自查（按 stats-check 技能的实验设计口径）：主要结局指标唯一明确、样本量有功效估算依据、剔除标准事先定义；涉及统计检验的实验在 design.md 中写明检验方法与多重比较校正口径；问题清单写入 analysis/stats-check-design.md。\n" +
      "完成标准：design.md 覆盖假设/方法/数据/基线/指标/实验矩阵/停止规则，无「待定」项；analysis/stats-check-design.md 各节齐全；实验矩阵可逐项直接执行。",
    expectedArtifacts: ["design.md", "analysis/stats-check-design.md"],
    inputs: ["survey/gap-analysis.md", "notes/", "references.bib"],
    optionalInputs: ["analysis-report.md", "artifacts/"],
    skills: ["stats-check"],
    run: [],
    humanTasks: [
      {
        title: "审阅实验设计",
        guidance:
          "design.md 的假设、主结局、实验矩阵与计算开销直接决定下一步成本；不合意时改设计，比跑完再返工便宜",
        target: "",
        timing: "after",
      },
    ],
    decisions: [
      { q: "数据从哪来", options: ["公开数据集够用", "自己采集/申请"] },
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
      "1. 按 design.md 实现实验代码，放入 experiments/（脚本可重复执行，参数集中在文件头或配置文件）。先试跑一组估算单次耗时与显存/内存占用，若整个矩阵在本机跑不完（估算 >8 小时或内存不足），把估算值与建议写进 .ccode/help-wanted.md 问用户要不要上集群（附兜底：先按可跑的子集跑，不停工）；\n" +
      "2. 逐项跑实验矩阵；标「裁剪」的组合跳过并在结果记录中说明；\n" +
      "3. 原始结果与日志写入项目根产物目录（见上方「产物目录」绝对路径），不要写本工作区、不要提交进 git；工作区内只提交代码与 results/summary.md（每行一项实验：配置、主指标数值、产物目录中的绝对路径）；\n" +
      "4. 失败的实验不删除日志：在 results/summary.md 标注「失败」与原因，按 design.md 风险清单的备选方案重跑一次，仍失败则记录后继续下一项。遵守 design.md 的停止规则，不得看到结果后改主指标。\n" +
      "完成标准：矩阵中每项都有明确结果或失败记录，experiments/ 与 results/summary.md 已提交，原始数据全部落在项目根产物目录。",
    expectedArtifacts: ["experiments/*", "results/summary.md"],
    inputs: ["design.md"],
    optionalInputs: ["analysis-report.md", "artifacts/"],
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
      {
        title: "伦理批件或数据许可（如需）",
        guidance:
          "涉及人/动物/敏感数据时，把批件或许可说明放到项目目录并在 design.md 记录编号；不需要的勾掉即可",
        target: "",
        timing: "before",
        optional: true,
      },
    ],
    decisions: [],
  },
  {
    name: "结果分析",
    role: "both",
    workspaceName: "exp-analysis",
    brief:
      "输入：results/summary.md 与产物目录中的原始结果（路径见 summary.md 逐行记录）。\n" +
      "1. 汇总各实验主指标，与基线逐项对比，产出 analysis/results-table.md（表格：方法 × 指标，最优值加粗）；\n" +
      "2. 关键对比生成图表写入 figures/（出图按 figure-forge 技能：可复现脚本、主交付 SVG 或 PNG 以便进 git，投稿用 PDF 副本写入项目根 output/figures/；色盲友好、图题含指标与实验条件）；\n" +
      "3. 逐项解读：哪些假设被验证/证伪、与基线差异的可能原因；下结论只用表格中的数字，没有数据支撑的解读标 [推测]；涉及统计显著性的表述按 stats-check 技能口径报告（p 值给具体值、附效应量与置信区间）；统计审查问题另写入 analysis/stats-check-results.md。\n" +
      "4. 异常结果（失败/离群）单独一节说明，不删除不美化；结果不如预期时，先基于实际异常、补实验成本与 design.md 的停止规则写入 .ccode/help-wanted.md 问用户，不得事后改主指标；\n" +
      "5. 分析结论写入 analysis/findings.md：3-5 条，每条对应 results-table.md 中的具体数字。\n" +
      "完成标准：analysis/results-table.md、analysis/findings.md、analysis/stats-check-results.md 与 figures/ 均存在，每条结论可回溯到表格数字。",
    inputs: ["results/summary.md"],
    optionalInputs: ["artifacts/"],
    expectedArtifacts: [
      "analysis/results-table.md",
      "analysis/findings.md",
      "analysis/stats-check-results.md",
      "figures/*",
    ],
    skills: ["stats-check", "figure-forge"],
    run: [],
    humanTasks: [
      {
        title: "审阅 findings 再开初稿",
        guidance:
          "analysis/findings.md 的结论口径锁定后再写论文；不合意时改分析，不要带到 Discussion 里改口",
        target: "",
        timing: "after",
      },
    ],
    decisions: [],
  },
  {
    name: "论文初稿",
    workspaceName: "paper-draft",
    brief:
      "输入：survey/、notes/、design.md、analysis/、figures/、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 按 IMRaD 结构用规范学术英文撰写初稿，产出 manuscript/draft.md：Introduction（研究问题+gap+贡献，现状综述引用 survey/ 与 notes/）、Methods（对应 design.md）、Results（对应 analysis/，引用 figures/ 图表）、Discussion（findings 的意义与局限）；目标篇幅：已初定投稿目标时按其惯常篇幅，未定目标时正文 6000-8000 词；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献；\n" +
      "3. 数字与结论必须与 analysis/results-table.md 一致，不得新造实验结果；缺少的数据在文中标 [待补实验]；\n" +
      "4. 图表引用已有 figures/ 文件（「Figure 1: …」），图片文件不复制进 manuscript/；缺图用占位并在文中标明待补；\n" +
      "5. 用本步骤 run 脚本渲染 PDF/docx（按 quarto-render 技能），产物写入项目根 output/。\n" +
      "完成标准：manuscript/draft.md 覆盖 IMRaD 四节，引用键全部可在 references.bib 解析，数字与 analysis/ 一致，run 脚本渲染通过。",
    inputs: [
      "survey/",
      "notes/",
      "design.md",
      "analysis/results-table.md",
      "analysis/findings.md",
      "figures/*",
      "references.bib",
    ],
    expectedArtifacts: ["manuscript/draft.md", "output/draft.pdf", "output/draft.docx"],
    skills: ["research-writing", "quarto-render"],
    discussionSeeds: [
      "卖点怎么讲：贡献的三句话电梯陈述怎么定，Introduction 往哪个方向带？",
    ],
    // Quarto 可再生产物统一写入 output/，源稿仍留在 manuscript/；
    // RX4a 追加 export-docx：同一份 md 导出 draft.docx，与 render-draft 并存互不冲突
    run: [
      {
        name: "render-draft",
        command: "quarto render manuscript/draft.md --to pdf --output-dir output",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/draft.md --to docx --output-dir output",
        default: true,
      },
    ],
  },
  {
    name: "润色与投稿准备",
    role: "you",
    workspaceName: "research-paper-polish",
    brief:
      "输入：manuscript/draft.md、analysis/results-table.md、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 语言润色：语法、用词、句式与段落衔接，保持学术语气；只改表达，不改学术观点与数据；\n" +
      "2. 一致性核对（按 bib-check 技能）：产出 manuscript/citation-check.md；每个论断有引用、每个 bib 条目都被引用（未用的在报告中列出）、图表编号连续、数字与 results-table.md 一致；发现内容性错误标 [待核实]，不得自行改写事实；\n" +
      "3. 统计报告自查（按 stats-check 技能的投稿前口径）：p 值给具体值并附效应量与置信区间、多重比较校正已说明、图注中的检验方法与显著性标记同正文一致；结果写入 analysis/stats-check.md，只列问题不改稿；\n" +
      "4. 产出 manuscript/paper-final.md 定稿与 manuscript/changelog.md（逐条列出主要修改点）；\n" +
      "5. 投稿前清单写入 submission/pre-submission-checklist.md：目标期刊/会议（按主题匹配给出 2-3 个候选及理由）、cover letter 要点、图表源文件清单、代码/数据可用性占位、作者信息与利益声明占位；未知信息一律占位「待填」，不编造；\n" +
      "6. 用本步骤 run 脚本渲染 PDF/docx（按 quarto-render 技能），产物写入项目根 output/。\n" +
      "完成标准：paper-final.md 引用闭环；manuscript/citation-check.md 与 analysis/stats-check.md 各节齐全，问题清零或逐条列入预清单；changelog.md 与 submission/pre-submission-checklist.md 已提交；[待补实验] 全部清除，确无法完成的列入预清单。",
    expectedArtifacts: [
      "manuscript/paper-final.md",
      "manuscript/citation-check.md",
      "output/paper-final.pdf",
      "output/paper-final.docx",
      "analysis/stats-check.md",
      "submission/pre-submission-checklist.md",
      "manuscript/changelog.md",
    ],
    inputs: ["manuscript/draft.md", "analysis/results-table.md", "references.bib"],
    skills: ["bib-check", "stats-check", "quarto-render"],
    humanTasks: [
      {
        title: "填写作者信息并初定投稿目标",
        guidance:
          "submission/pre-submission-checklist.md 中的作者信息/利益声明「待填」占位逐条补齐；目标期刊候选 2-3 个已附理由，可改选",
        target: "submission/pre-submission-checklist.md",
        timing: "after",
      },
    ],
    decisions: [
      
    ],
    // P4 quarto 渲染：定稿 paper-final.md → paper-final.pdf；RX4a 追加 export-docx → paper-final.docx
    run: [
      {
        name: "render-final",
        command: "quarto render manuscript/paper-final.md --to pdf --output-dir output",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/paper-final.md --to docx --output-dir output",
        default: true,
      },
    ],
  },
];

/** 数据处理（data-processing）：登记检查 → 清洗整理 → 探索性分析 → 分析报告 */
const DATA_PROCESSING_STEPS: ProjectStepDto[] = [
  {
    name: "数据登记与检查",
    role: "both",
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
    ],
  },
  {
    name: "清洗与整理",
    workspaceName: "data-clean",
    brief:
      "输入：data-dictionary.md（已随 main 合并在本工作区内；其中「待确认」字段若已由人补全口径，以补全值为准）。全程按 data-clean 技能执行：规则先行、原始数据只读。\n" +
      "1. **先报数再定规则**：统计各字段缺失率、重复行数、表间关系与行数量级，把「缺失率 Top5 字段 / 建议的处理方式 / 建议的分析粒度 / 要不要合表」写进 .ccode/help-wanted.md 问用户一句（附兜底：若未回复则按你建议的规则继续），写完不要停工、按兜底往下做。——这几件事要看到数据长什么样才定得了，开工前问等于让用户猜；\n" +
      "2. 清洗规则逐项写死再动手：缺失值处理（删除/填充及填充值）、去重键、异常值边界、类型转换，写入 cleaning/rules.md，每条规则注明依据，不允许「视情况而定」项；\n" +
      "3. 清洗脚本放入 cleaning/（可重复执行；输入只读原始数据，不原地修改）；\n" +
      "4. 处理后的数据写入项目根产物目录（见上方「产物目录」绝对路径），不进 git、不要写本工作区；同时产出 cleaning/cleaned-data-manifest.md，记录源文件、字节数/hash、输出文件绝对路径、行列数与生成命令；\n" +
      "5. 清洗报告 cleaning/cleaning-report.md：每条规则影响的行数、丢弃数据的清单与原因、清洗前后规模对比，[待确认] 规则单列一节。\n" +
      "完成标准：rules.md 无「视情况而定」项，脚本可重复跑通，manifest 与报告数字和产物目录结果一致，原始数据字节级未被改动。",
    expectedArtifacts: [
      "cleaning/rules.md",
      "cleaning/cleaning-report.md",
      "cleaning/cleaned-data-manifest.md",
      "cleaning/*",
    ],
    inputs: ["data-dictionary.md"],
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

    ],
  },
  {
    name: "探索性分析",
    role: "both",
    workspaceName: "data-eda",
    brief:
      "输入：cleaning/cleaned-data-manifest.md、项目根产物目录中清洗后的数据与 cleaning/rules.md（已随 main 合并在本工作区内）。全程按 data-eda 技能执行：分布/相关/异常全覆盖不挑选、图表可复现、发现可回溯。\n" +
      "1. 分析与出图脚本放入 analysis/（可重复执行入口，从项目根重跑产出一致；只读产物目录数据，路径用绝对路径或模块顶部常量）；\n" +
      "2. 分布分析：各字段分布（直方图/统计量）逐个解读，不跳过「看起来正常」的字段；图表写入 figures/（英文标注，文件名与报告引用一一对应）；\n" +
      "3. 相关分析：全字段相关矩阵，强相关对（|r|≥0.7）全部列出并解读，不挑选；\n" +
      "4. 异常分析：按 rules.md 的口径复查残留异常，新发现的异常标 [待确认] 并给出样例行号；\n" +
      "5. 结论写入 eda-report.md：3-5 条可用于后续决策的发现，每条附对应图表或统计量；含统计检验/显著性表述的结论先按 stats-check 技能口径自查（检验方法与数据匹配、p 值给具体值、附效应量与置信区间）；问题清单写入 analysis/stats-check-eda.md。\n" +
      "完成标准：analysis/ 脚本、analysis/stats-check-eda.md、figures/ 与 eda-report.md 均存在，每条发现可回溯到具体图表/数字，无主观臆断。",
    expectedArtifacts: ["analysis/*", "analysis/stats-check-eda.md", "figures/*", "eda-report.md"],
    inputs: ["cleaning/rules.md", "cleaning/cleaned-data-manifest.md"],
    optionalInputs: ["artifacts/"],
    skills: ["data-eda", "stats-check"],
    run: [],
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
      "完成标准：analysis-report.md 结构完整，建议与发现一一对应且优先级有据；本报告中的 [待验证] 已核实或列入局限。清洗步残留的 [待确认] 不在本步清除。",
    expectedArtifacts: ["analysis-report.md"],
    inputs: ["eda-report.md", "figures/*", "data-dictionary.md"],
    skills: [],
    run: [],
    decisions: [],
  },
];

/** 毕业论文（thesis）：检索 → 精读 → 开题与综述 → 研究方法 → 实验 → 分析 → 初稿 → 定稿 */
const THESIS_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    role: "both",
    workspaceName: "lit-search",
    brief:
      "输入：课题主题（见上方「课题主题」段；未填写时按项目目录与已有资源推断，写进 papers/screening.md 开头）。接自上游英文综述/科研论文时 notes/ 与 included.md 随仓库自带，按查漏补缺做、不覆盖已有笔记；没有上游时全量检索。全程按 lit-search 技能。\n" +
      "1. **先粗检一轮报数再定标准**：OpenAlex 命中约 N 篇与建议标准写入 .ccode/help-wanted.md（附兜底不停工）；纳入/排除标准（年份、语言、来源级别、相关性）写入 papers/screening.md；\n" +
      "2. 解析人工导入题录（项目根 papers/imports/、工作区 papers/imports/、项目资源与提货单绝对路径），去重进候选池；\n" +
      "3. 检索候选并逐条判定，产出 papers/screening.md 与 papers/included.md；拿不准一律纳入并标「待确认」；检索日期与覆盖缺口写入 screening.md；\n" +
      "4. 开放获取全文下载到**项目根 papers/**；付费墙写入 papers/to-fetch.md 与 papers/to-fetch.ris。\n" +
      "完成标准：四件套存在（无付费文献则 to-fetch 注明为空），每条记录无空缺字段，筛选可复现。",
    optionalInputs: ["notes/", "references.bib", "papers/included.md"],
    expectedArtifacts: [...LIT_SEARCH_ARTIFACTS],
    skills: ["lit-search"],
    asksLitSource: true,
    run: [],
    humanTasks: [mcpLitSearchTask(), paywallPdfTask("after")],
    decisions: [
      { q: "检索年限", options: ["近五年", "近十年", "不限年限"] },
      { q: "文献语言", options: ["中英文都要", "只要英文"] },
      { q: "预印本要不要纳入", options: ["纳入并标注", "不纳入"] },
    ],
  },
  {
    name: "文献精读与笔记",
    role: "both",
    workspaceName: "lit-notes",
    brief:
      "输入：papers/included.md 与 papers/to-fetch.md。全程按 lit-notes 技能。已有 notes/ 时只补缺篇、不覆盖旧笔记。\n" +
      "1. 整理项目根 papers/ 人工补投并更新 to-fetch.md；\n" +
      "2. **先报清单规模与全文到位率，建议核心精读篇目**，写入 .ccode/help-wanted.md（附兜底不停工）；\n" +
      "3. 逐篇产出 notes/<序号-短标题>.md（lit-notes 八段）并追加 references.bib；全文未得按摘要写并标「仅摘要·待全文」。\n" +
      "完成标准：included.md 每篇都有对应笔记与 bib 条目。",
    inputs: ["papers/included.md", "papers/to-fetch.md"],
    optionalInputs: ["papers/*.pdf", "notes/", "references.bib"],
    expectedArtifacts: ["notes/*.md", "references.bib", "papers/to-fetch.md"],
    skills: ["lit-notes"],
    run: [],
    humanTasks: [
      {
        title: "继续精读笔记（沉浸阅读区）",
        guidance:
          "验收后想补读或修正哪篇笔记：点开 notes/ 中那份 md →「⛶ 沉浸阅读」。改的是主仓笔记，改完到改动面板提交。",
        target: "",
        timing: "after",
        optional: true,
      },
    ],
    decisions: [],
  },
  {
    name: "开题报告与综述",
    role: "both",
    workspaceName: "proposal",
    brief:
      "输入：notes/、papers/included.md 与 references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 产出 proposal/proposal.md 开题报告（按 proposal-writer 技能）：选题依据、研究内容、研究目标与创新点、技术路线、可行性与进度安排，引用只用 references.bib 已有键；\n" +
      "2. 产出 chapters/literature-review.md 综述章节草稿：框架构造按 review-framework 技能（空白清单 → 范式卡片 → 融合），只引用 references.bib 中存在的键，不为综述新造引用。\n" +
      "完成标准：proposal.md 五节齐全；literature-review.md 引用键全部可解析，含框架推演或等价取舍说明。",
    inputs: ["notes/", "papers/included.md", "references.bib"],
    expectedArtifacts: ["proposal/proposal.md", "chapters/literature-review.md"],
    skills: ["proposal-writer", "review-framework"],
    run: [],
    humanTasks: [
      {
        title: "开题报告送导师评阅",
        guidance:
          "proposal/proposal.md 可直接发导师；导师意见自行记录，可追加到该文件末尾供后续步骤参考",
        target: "",
        timing: "after",
        optional: true,
        completion: "manual",
      },
      {
        title: "开题答辩（如培养方案有）",
        guidance:
          "有开题答辩的把评委意见记进 proposal/proposal.md 末尾；培养方案没有这一环就跳过",
        target: "",
        timing: "after",
        optional: true,
        completion: "manual",
      },
    ],
    discussionSeeds: [
      "研究问题聚焦到哪：导师给的大方向里，切哪一块是你真能做完的？",
    ],
  },
  {
    name: "研究方法",
    role: "both",
    workspaceName: "methodology",
    brief:
      "输入：proposal/proposal.md 的研究内容与技术路线、chapters/literature-review.md（已随 main 合并在本工作区内）。\n" +
      "1. 产出 chapters/methodology.md 方法章节草稿：方法原理、实现步骤、数据来源与预处理、评价指标，逐节对应开题报告的研究内容；\n" +
      "2. 产出 design.md 实验设计：对比基线（注明出处）、实验矩阵（变量 × 取值完整组合）、预期结果与分析方式；统计设计按 stats-check 技能的实验设计口径自查（主要结局指标唯一明确、样本量有依据、剔除标准事先定义），涉及统计检验的写明检验方法与多重比较校正口径，问题清单写入 analysis/methodology-stats-check.md；\n" +
      "3. 每个方法选择给出依据；与开题报告不一致的改动在 methodology.md 末尾「变更说明」记录原因，不静默改方案；\n" +
      "4. 依赖的资源（数据集/预训练模型）不可获取时换用公开替代品并标注，不留「待定」。\n" +
      "完成标准：methodology.md 覆盖开题全部研究内容，design.md 实验矩阵可直接执行；analysis/methodology-stats-check.md 各节齐全，无「待定」项。",
    expectedArtifacts: ["chapters/methodology.md", "design.md", "analysis/methodology-stats-check.md"],
    inputs: ["proposal/proposal.md", "chapters/literature-review.md"],
    skills: ["stats-check"],
    run: [],
    humanTasks: [
      {
        title: "与导师确认方法与技术路线",
        guidance:
          "methodology.md 与开题报告不一致的改动见文末「变更说明」，逐条与导师过一遍再开实验",
        target: "",
        timing: "after",
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
    name: "实验执行",
    workspaceName: "thesis-exp-run",
    brief:
      "输入：design.md 的实验矩阵、chapters/methodology.md（已随 main 合并在本工作区内）。\n" +
      "1. 实验代码放入 experiments/（可重复执行，参数集中在文件头或配置文件），逐项跑实验矩阵；\n" +
      "2. 原始结果与日志写入项目根产物目录（见上方「产物目录」绝对路径），不进 git、不要写本工作区；results/summary.md 逐项记录：配置、指标数值、产物目录绝对路径；\n" +
      "3. 失败实验在 summary.md 标注原因并按 design.md 的备选方案重跑一次，仍失败则记录后继续；\n" +
      "完成标准：矩阵每项都有结果或失败记录，experiments/ 与 results/summary.md 已提交，原始结果全部落在项目根产物目录。",
    expectedArtifacts: ["experiments/*", "results/summary.md"],
    inputs: ["design.md", "chapters/methodology.md"],
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
      {
        q: "实验做到什么程度收手",
        options: ["核心结果出来就转写作", "矩阵全跑完"],
      },
    ],
  },
  {
    name: "结果分析与章节",
    role: "both",
    workspaceName: "thesis-exp-analysis",
    brief:
      "输入：上一步 results/summary.md 与项目根产物目录中的原始结果（路径见 summary.md）。\n" +
      "1. 汇总各实验主指标，与基线逐项对比，产出 chapters/results.md：表格（方法 × 指标，最优值加粗）+ 关键图表（figures/ 主交付 SVG 或 PNG，投稿用 PDF 副本写项目根 output/figures/，出图按 figure-forge 技能）+ 逐项解读；\n" +
      "2. 只用 summary.md 中的数字下结论，推测性内容标 [推测]；失败/离群结果单独说明，不删除不美化；涉及统计显著性的表述按 stats-check 技能口径（p 值给具体值、附效应量与置信区间），问题清单写入 analysis/thesis-results-stats-check.md；\n" +
      "3. 对照 proposal/proposal.md 的创新点：哪些被结果支撑、哪些要降级或改口，写进 chapters/results.md 末尾；结果不如预期时，先基于实际异常、补实验成本与 design.md 的停止规则写入 .ccode/help-wanted.md 问用户；不得在看到结果前预设换方向。\n" +
      "完成标准：chapters/results.md、analysis/thesis-results-stats-check.md、figures/ 已提交，每条结论可追溯到 summary.md 的数字。",
    inputs: ["results/summary.md", "proposal/proposal.md"],
    optionalInputs: ["artifacts/"],
    expectedArtifacts: ["chapters/results.md", "analysis/thesis-results-stats-check.md", "figures/*"],
    skills: ["figure-forge", "stats-check"],
    run: [],
    decisions: [],
  },
  {
    name: "论文初稿",
    workspaceName: "thesis-draft",
    brief:
      "输入：chapters/ 各章草稿、references.bib、figures/、proposal/proposal.md（已随 main 合并在本工作区内）。\n" +
      "1. 按学校论文模板结构（封面/摘要/目录/正文各章/参考文献/致谢；项目内无模板文件时用通用学位论文结构、语种默认中文，并在 manuscript/README.md 注明所依据的结构）组装全文初稿 manuscript/thesis-draft.md；学校要求独立讨论章则保留讨论章，不要并进结论；\n" +
      "2. 补齐缺失章节：引言（研究背景+问题+贡献，对应开题报告）、结论与展望（对应结果章节）；\n" +
      "3. 统一各章术语、符号与图表编号；引用一律 [@bib键] 且只能引用 references.bib 已有键——严禁编造文献；\n" +
      "4. 图表引用占位（「图 3-1：…」），数字与 chapters/results.md 一致，不一致处以结果章节为准并在修订记录标注；\n" +
      "5. 产出 manuscript/revision-notes.md：组装过程中的取舍与待确认项；\n" +
      "6. 渲染验证：用本步骤 run 脚本渲染 PDF/docx（环境检查与产物登记按 quarto-render 技能），渲染报错先按技能指引补依赖，不绕路。\n" +
      "完成标准：thesis-draft.md 章节齐全、引用闭环、revision-notes.md 已提交、run 脚本渲染通过。",
    expectedArtifacts: [
      "manuscript/thesis-draft.md",
      "manuscript/revision-notes.md",
      "output/thesis-draft.pdf",
      "output/thesis-draft.docx",
    ],
    inputs: ["chapters/", "references.bib", "figures/*", "proposal/proposal.md"],
    skills: ["quarto-render"],
    discussionSeeds: [
      "章节权重怎么分：哪几章是答辩老师最看重、要重点打磨的？",
      "学校的字数与章节要求是什么：有没有硬性模板要对齐？",
    ],
    humanTasks: [
      {
        title: "放入学校格式规范与论文模板",
        guidance:
          "学校官网/研究生院下载的格式规范与模板文件，放到项目目录即可；没有时 agent 按通用学位论文规范执行并注明依据。越早放入，初稿结构越少返工。",
        target: "",
        timing: "before",
      },
    ],
    // Quarto 渲染：源稿留在 manuscript/，PDF/DOCX 统一落到 output/。
    run: [
      {
        name: "render-draft",
        command: "quarto render manuscript/thesis-draft.md --to pdf --output-dir output",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/thesis-draft.md --to docx --output-dir output",
        default: true,
      },
    ],
  },
  {
    name: "格式与定稿",
    role: "you",
    workspaceName: "thesis-final",
    brief:
      "输入：manuscript/thesis-draft.md、references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 格式核对：按学校格式规范（项目内有规范文件则逐条对照，没有则按通用学位论文规范并把依据写进报告）检查字体/页边距/图表编号/参考文献格式/页眉页码，问题清单写入 manuscript/format-check.md；\n" +
      "2. 语言润色：语法与表达，只改表达不改观点与数据；内容性错误标 [待核实]；\n" +
      "3. 查重降重建议写入 manuscript/plagiarism-advice.md：标出高重复风险段落（术语定义、公知表述、综述常见句式）并给出改写建议，不直接代写；\n" +
      "4. 引用闭环核对按 bib-check 技能执行，产出 manuscript/citation-check.md：正文引用键逐条对照 references.bib，参考文献列表按 bib 生成、逐条核对字段齐全（缺字段标「待补」）；\n" +
      "5. 产出 manuscript/thesis-final.md 定稿与 manuscript/changelog.md（逐条列出修改点）；\n" +
      "6. 渲染验证：用本步骤 run 脚本渲染 PDF/docx（环境检查与产物登记按 quarto-render 技能）。\n" +
      "完成标准：format-check.md 与 citation-check.md 问题逐条有处理结论，thesis-final.md 引用闭环，changelog.md 已提交，run 脚本渲染通过。",
    expectedArtifacts: [
      "manuscript/thesis-final.md",
      "manuscript/citation-check.md",
      "manuscript/format-check.md",
      "manuscript/plagiarism-advice.md",
      "manuscript/changelog.md",
      "output/thesis-final.pdf",
      "output/thesis-final.docx",
    ],
    inputs: ["manuscript/thesis-draft.md", "references.bib"],
    skills: ["bib-check", "quarto-render"],
    humanTasks: [
      {
        title: "定稿送导师审阅并按学校要求查重",
        guidance:
          "thesis-final.md 渲染后送导师；查重渠道以学校要求为准，高重复风险段落见 manuscript/plagiarism-advice.md；查重目标见项目层全局设定",
        target: "",
        timing: "after",
      },
    ],
    decisions: [],
    // Quarto 渲染：定稿源稿留在 manuscript/，PDF/DOCX 统一落到 output/。
    run: [
      {
        name: "render-final",
        command: "quarto render manuscript/thesis-final.md --to pdf --output-dir output",
        default: true,
      },
      {
        name: "export-docx",
        command: "quarto render manuscript/thesis-final.md --to docx --output-dir output",
        default: true,
      },
    ],
  },
];

/** 投稿与返修（submission-rebuttal）：期刊格式适配 → 投稿材料 → 审稿意见逐条回复 */
const SUBMISSION_INITIAL_STEPS: ProjectStepDto[] = [
  {
    name: "期刊格式适配",
    role: "both",
    workspaceName: "journal-format",
    brief:
      "输入：manuscript/paper-final.md 或 manuscript/review-final.md 或 manuscript/thesis-final.md、references.bib（接自上游模板时随仓库合并自带；独立启动本项目时，先把上游成稿与 references.bib 放入对应目录，或在资源面板绑定上游项目目录；这些稿件都不存在时在报告中说明并停止，不自行改用其他草稿）。\n" +
      "1. 确定目标期刊：项目根已有 submission/target-journal.md 时从其约定；没有则按课题主题给出 2-3 个候选期刊及理由，写入 submission/target-journal.md，选第一个执行并标注「待用户确认」；\n" +
      "2. 获取目标期刊官方作者指南（WebFetch 期刊官网 Guide for Authors；获取失败时按通用 IMRaD 与 APA 引用格式执行，并在 format-notes.md 说明依据）；\n" +
      "3. 按指南逐项适配：章节结构、引用与文献列表格式、图表规范、字数与摘要长度；产出 submission/formatted.md，只改格式与表达，不改学术观点与数据；\n" +
      "4. 字数或摘要超限时不得自行删内容：在 formatted.md 原位标注超出量，把可选裁剪方案（砍哪节、砍多少）逐条写进 submission/format-notes.md 由用户定夺；\n" +
      "5. 引用完整性自查（按 bib-check 技能）：报告写入 submission/citation-check.md；并把需要用户处理的摘要同步写入 submission/format-notes.md；\n" +
      "6. 作者单位/基金号/通讯邮箱等未知信息一律占位「待填」，不编造；所有未决项汇总进 submission/format-notes.md；\n" +
      "7. 用本步骤 run 脚本渲染 PDF/docx（按 quarto-render 技能），产物写入项目根 output/formatted.pdf 与 formatted.docx。\n" +
      "完成标准：submission/formatted.md、submission/target-journal.md、submission/citation-check.md 与 submission/format-notes.md 均已提交；format-notes.md 逐项给出处理结论；run 脚本渲染通过。",
    expectedArtifacts: [
      "submission/formatted.md",
      "submission/target-journal.md",
      "submission/format-notes.md",
      "submission/citation-check.md",
      "output/formatted.pdf",
      "output/formatted.docx",
    ],
    inputs: ["references.bib"],
    anyOfInputs: [MANUSCRIPT_FINALS],
    skills: ["bib-check", "quarto-render"],
    run: [
      {
        name: "render-formatted",
        command:
          "quarto render submission/formatted.md --to pdf --output-dir output --output formatted.pdf",
        default: true,
      },
      {
        name: "export-docx",
        command:
          "quarto render submission/formatted.md --to docx --output-dir output --output formatted.docx",
        default: true,
      },
    ],
    humanTasks: [
      {
        title: "放入成稿与 references.bib",
        guidance:
          "独立启动本模板时，把上游成稿（manuscript/paper-final.md、review-final.md 或 thesis-final.md）与 references.bib 放入项目对应目录；接自上游模板时随仓库合并自带，可跳过",
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
        target: "",
        timing: "after",
        completion: "manual",
      },
    ],
    // 「目标期刊怎么选」提到项目层（它是这条流程的前提，不是第 1 步的战术问题）；
    // 「字数超标先砍哪部分」改按需问——得先知道超了多少（见简报）
    decisions: [
    ],
  },
  {
    name: "投稿材料",
    role: "you",
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
      "submission/highlights.md",
      "submission/pre-review.md",
      "submission/checklist.md",
    ],
    inputs: ["submission/formatted.md", "submission/target-journal.md"],
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
];

/** 投稿模板的返修分支：每一轮都使用轮次化输入/产物，避免第二轮覆盖第一轮的证据链。 */
function submissionRevisionSteps(round: number): ProjectStepDto[] {
  const r = Math.max(1, Math.floor(round));
  const previous = r === 1 ? "manuscript/paper-final.md" : `manuscript/revised-r${r - 1}.md`;
  const previousLabel =
    r === 1
      ? "submission/formatted.md，否则 manuscript/paper-final.md / review-final.md / thesis-final.md"
      : previous;
  const previousInputs =
    r === 1
      ? ["submission/formatted.md", ...MANUSCRIPT_FINALS]
      : [previous];
  return [
    {
      name: `审稿意见回复（第${r}轮）`,
      role: "you",
      workspaceName: `rebuttal-r${r}`,
      brief:
        `输入：reviews/round-${r}.md 审稿意见全文（用户把编辑来信保存为该文件；缺失时提示用户提供并停止，不得编造审稿意见）；${previousLabel}（上一版成稿）。\n` +
        "全程按 rebuttal-crafter 技能执行；本步骤采用「允许直接生成修订稿」模式：只允许在本步骤 TASK.md 明确的上一版稿件上修改，并将每处修改绑定审稿意见编号；若用户撤回授权，则退回仅生成回复信/对照表模式，不改正文。\n" +
        "1. 逐条拆分审稿意见并编号（R1.1、R1.2…，多位审稿人分节，编辑意见单列 E.1…），不遗漏任何一条；\n" +
        `2. 产出 rebuttal/response-letter-r${r}.md，逐条回应：意见摘要 → 回应（接受修改 / 部分接受并说明限制 / 礼貌反驳并给依据）→ 稿件修改位置；拿不准的一律标 [待确认]；\n` +
        `3. 在 ${previousLabel} 基础上修改，产出 manuscript/revised-r${r}.md，并在修改处标注对应意见编号；需要补实验/补数据的只写可执行计划并标 [待补实验]，不开空头支票；\n` +
        `4. 产出 rebuttal/revisions-r${r}.md：每条意见 → 修改点 → revised-r${r}.md 位置，逐条可核对；\n` +
        `5. 按 bib-check 技能核对 revised-r${r}.md 与 references.bib，报告写入 rebuttal/citation-check-r${r}.md；\n` +
        `6. 产出 submission/resubmission-checklist-r${r}.md：上传文件、回复信/修订稿版本、逐项确认项与未决事项；提交前由人核对，不能把「已生成」当作「已提交」。\n` +
        `完成标准：round-${r} 的回复信、修改对照表、citation-check 报告、修订稿、再投稿清单均存在且一一对应；[待确认]/[待补实验] 在清单末尾汇总。`,
      inputs: [`reviews/round-${r}.md`, "references.bib"],
      anyOfInputs: [previousInputs],
      expectedArtifacts: [
        `rebuttal/response-letter-r${r}.md`,
        `rebuttal/revisions-r${r}.md`,
        `rebuttal/citation-check-r${r}.md`,
        `manuscript/revised-r${r}.md`,
        `submission/resubmission-checklist-r${r}.md`,
      ],
      skills: ["rebuttal-crafter", "bib-check"],
      run: [],
      humanTasks: [
        {
          title: `保存第${r}轮审稿意见全文`,
          guidance: `把编辑来信/审稿意见保存为 reviews/round-${r}.md；缺该文件 agent 会停止`,
          target: `reviews/round-${r}.md`,
          timing: "before",
        },
        {
          title: "确认 [待确认] 回应口径并安排补实验",
          guidance:
            `response-letter-r${r}.md 中标注 [待确认]/[待补实验] 的条目逐条拍板；处理结论写回再投稿清单`,
          target: "",
          timing: "after",
          completion: "manual",
        },
        {
          title: `返修第${r}轮定稿后提交`,
          guidance: `用 submission/resubmission-checklist-r${r}.md 逐项核对后，到投稿系统上传修订稿与回复信`,
          target: "",
          timing: "after",
          completion: "manual",
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
}

/** 选择模板实际要追加的步骤；投稿模板必须先选首投/返修分支。 */
export function pipelineStepsForTemplate(
  template: PipelineTemplateDef,
  mode: SubmissionMode = "initial",
  round = 1,
): ProjectStepDto[] {
  if (template.id !== "submission-rebuttal") return contractizeSteps(template.steps);
  return mode === "revision"
    ? contractizeSteps(submissionRevisionSteps(round))
    : contractizeSteps(SUBMISSION_INITIAL_STEPS);
}

/** LaTeX 论文（latex-paper）：搭建骨架 → 章节写作 → 编译与排错 → 定稿导出（批次 E）。
 *  编译脚本 render-pdf 四步共用：优先 tectonic（轻量、自动下载宏包），缺则 latexmk，
 *  都没有则非零退出并打印安装引导——应用内不做安装器，检测引导就放在脚本里 */
const LATEX_RENDER_PDF_CMD =
  'mkdir -p output && cd manuscript && if command -v tectonic >/dev/null 2>&1; then tectonic --outdir ../output main.tex; ' +
  'elif command -v latexmk >/dev/null 2>&1; then latexmk -pdf -interaction=nonstopmode -outdir=../output -auxdir=../output main.tex; ' +
  'else echo "未检测到 LaTeX 编译环境：macOS 可用 brew install tectonic，Windows 安装 MiKTeX 或 TeX Live，并保证 tectonic 或 latexmk 在 PATH；' +
  '也可安装 MacTeX/TeXLive 获得 latexmk"; exit 1; fi';

const LATEX_PAPER_STEPS: ProjectStepDto[] = [
  {
    name: "搭建骨架",
    role: "both",
    workspaceName: "latex-skeleton",
    brief:
      "输入：课题主题（见上方「课题主题」段）。若存在成稿（manuscript/paper-final.md、review-final.md、thesis-final.md 或 draft.md），本步是排版后端：按成稿转成 LaTeX 骨架与章节文件，**不改学术观点与数据**。没有成稿时从 notes/ 与 references.bib 从零搭（没有则空库起步，在 manuscript/README.md 注明）。\n" +
      "1. 文档类按开工前定下的选择（见任务书草稿决策段；未选则按项目层「目标期刊或学校」推断：中文正文用 ctexart，Elsevier 系用 elsarticle，IEEE 用 IEEEtran，ACS 系用 achemso，学位论文用通用学位架；都套不上就用 article 并在 manuscript/README.md 说明依据）。elsarticle/IEEEtran/achemso/ctexart 这些类 TeXLive 自带，tectonic 也会按需自动下载，不要自己去找 .cls 文件；\n" +
      "2. 若 manuscript/template/ 目录存在（人工事项放入的期刊官方模板），先读其中的 README/说明与示例 .tex，以模板文件为底做适配（documentclass、宏包、章节命令都按模板口径），不要从零另起一套；\n" +
      "3. 产出 manuscript/main.tex（文档类 + 宏包 + \\input 各章）与 manuscript/chapters/ 下每章一个 .tex。有成稿时按成稿切章，每章放入对应正文；无成稿时每章先放节标题骨架与一句话要点；\n" +
      "4. 参考文献沿用 references.bib：natbib 或 biblatex 二选一（开工前决策；未选定则按文档类惯常搭配——elsarticle/IEEEtran 配 natbib 系，其余配 biblatex），在 main.tex 接好；已有 figures/ 时用 \\includegraphics 引用，不要把图复制进 manuscript/；\n" +
      "5. 冒烟编译：骨架必须能编译出 PDF（用本步骤 run 脚本 render-pdf；本机没装编译环境时把脚本打印的安装提示写进 .ccode/help-wanted.md 提醒用户，装好前不卡在等待）。\n" +
      "完成标准：manuscript/main.tex 与 chapters/ 各章文件存在且能编译出 PDF；references.bib 已接入；manuscript/README.md 记录文档类、宏包与是否从成稿转写。",
    expectedArtifacts: ["manuscript/main.tex", "manuscript/chapters/*.tex", "output/main.pdf", "manuscript/README.md"],
    optionalInputs: [
      "notes/",
      "references.bib",
      "manuscript/template/",
      "figures/*",
      "design.md",
      "analysis/",
      "manuscript/draft.md",
      ...MANUSCRIPT_FINALS,
    ],
    skills: [],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    humanTasks: [
      {
        title: "（可选）把期刊官方模板解压到 manuscript/template/",
        guidance:
          "目标期刊官网下载的 LaTeX 模板 zip，解压到项目 manuscript/template/ 目录；agent 开工时会先读模板说明再搭骨架。没有指定模板就跳过，agent 按开工前选的文档类从零搭",
        target: "manuscript/template/",
        timing: "before",
        optional: true,
      },
    ],
    decisions: [
      {
        q: "文档类选哪个",
        options: ["elsarticle", "IEEEtran", "achemso", "ctexart", "学位论文通用架"],
      },
      { q: "参考文献宏包", options: ["natbib", "biblatex"] },
    ],
    discussionSeeds: [
      "目标期刊/学校有没有官方模板：有就先拿到手再搭骨架（见人工事项），别搭完再返工？",
    ],
  },
  {
    name: "章节写作",
    workspaceName: "latex-writing",
    brief:
      "输入：manuscript/main.tex 骨架与 chapters/ 各章文件；notes/ 与 references.bib 若已随 main 合并则读取，缺失时沿用骨架 README 的空库约定并在 citation-check.md 标出待核实项。\n" +
      "若 README 写明从成稿转写：只补全结构、交叉引用与引用纪律，**不改学术观点与数据**。从零写时按实证 IMRaD 用 research-writing 技能（综述体裁则按项目层说明改用综述口径）。引用一律 \\cite{bib键}。\n" +
      "1. 按骨架逐章充实或校对内容：每节成文，学术语气，目标篇幅按项目层设定（未设定时每章 800-1500 词）；\n" +
      "2. 引用键必须存在于 references.bib——严禁编造文献、严禁新造键；确需引用而库里没有的文献，先在 references.bib 补条目（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）再引用；\n" +
      "3. 已有 figures/ 用 \\includegraphics 引用；没有的图用 figure 环境占位「（待绘制）」，不虚构数据；\n" +
      "4. 没有文献支撑的论断不得下；必须保留的判断在该行行尾加 % TODO 待核实 注释；\n" +
      "5. 每写完一章跑一次本步骤 run 脚本 render-pdf 确认可编译，报错立即读 manuscript/main.log 定位修掉，不攒到最后；按 bib-check 技能输出 manuscript/citation-check.md。\n" +
      "完成标准：chapters/ 各章内容成文，全文编译通过，citation-check.md 各节齐全且 \\cite 键全部可在 references.bib 解析。",
    expectedArtifacts: ["manuscript/chapters/*.tex", "output/main.pdf", "manuscript/citation-check.md"],
    inputs: ["manuscript/main.tex", "manuscript/chapters/*.tex"],
    optionalInputs: ["notes/", "references.bib", "figures/*"],
    skills: ["research-writing", "bib-check"],
    requiredSkills: ["bib-check"],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    discussionSeeds: [
      "卖点怎么讲：贡献的三句话电梯陈述怎么定，Introduction 往哪个方向带？",
    ],
  },
  {
    name: "编译与排错",
    workspaceName: "latex-compile",
    brief:
      "输入：manuscript/ 全文（已随 main 合并在本工作区内）。\n" +
      "1. 用本步骤 run 脚本 render-pdf 编译：脚本优先 tectonic（缺则 latexmk），两个都没有会打印安装提示并以非零退出；本机缺环境时把提示原样写进 .ccode/help-wanted.md 转给用户，不要自己下载安装编译器；\n" +
      "2. 编译报错先读 manuscript/main.log 定位（缺宏包/未闭合环境/引用未解析），对症改源码，禁止绕路——不删报错的命令、不换文档类、不把整段注释掉；\n" +
      "3. 缺宏包：tectonic 会自动下载；latexmk 依赖本机 TeXLive 完整安装，遇到缺失包错误优先换用 TeXLive 自带的等价宏包，换不了的在 compile-notes.md 说明；\n" +
      "4. 警告分级处理：Citation/Reference undefined（PDF 里的 ??）必须清零；明显超版的 Overfull \\hbox 逐处调整；其余警告记录进 manuscript/compile-notes.md，不逐个纠缠；\n" +
      "5. 产出 output/main.pdf 与 manuscript/compile-notes.md（编译口径、清零项、遗留警告清单）。\n" +
      "完成标准：render-pdf 退出码为 0，main.pdf 页数与结构符合骨架；Citation/Reference undefined 为零。",
    expectedArtifacts: ["output/main.pdf", "manuscript/compile-notes.md"],
    inputs: ["manuscript/"],
    optionalInputs: ["references.bib"],
    skills: [],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    humanTasks: [
      {
        title: "（可选）安装 LaTeX 编译环境",
        guidance:
          "macOS：brew install tectonic（轻量，编译时自动下载宏包），或安装 MacTeX/TeXLive。Windows：安装 MiKTeX 或 TeX Live，并确保 tectonic 或 latexmk 在 PATH 里。已装过就跳过，run 脚本会自动识别",
        target: "",
        timing: "before",
        optional: true,
      },
    ],
  },
  {
    name: "定稿导出",
    role: "you",
    workspaceName: "latex-final",
    brief:
      "输入：manuscript/ 全文与 output/main.pdf（已随 main 合并在本工作区内）；references.bib 若存在则用于引用闭环核对，缺失时在 final-check.md 明确记录。\n" +
      "1. 通读定稿：语法、用词与段落衔接，只改表达不改学术观点与数据；发现内容性错误在该行行尾加 % TODO 待核实 注释，不自行改写事实；\n" +
      "2. 引用闭环核对按 bib-check 技能：全文 \\cite 键逐条对照 references.bib，未解析键与未被引用条目清单写入 manuscript/final-check.md（未使用条目只列出、不删）；\n" +
      "3. 版面终检：图表编号连续、交叉引用无 ??、无残留「（待绘制）」占位；问题一并写入 final-check.md 并逐项处理；\n" +
      "4. 终编译：跑本步骤 run 脚本 render-pdf 产出定稿 output/main.pdf；\n" +
      "5. 产出 manuscript/changelog.md，逐条记录定稿阶段的修改点。\n" +
      "完成标准：final-check.md 逐项有处理结论，main.pdf 终编译通过，changelog.md 已提交。",
    expectedArtifacts: [
      "output/main.pdf",
      "manuscript/final-check.md",
      "manuscript/changelog.md",
    ],
    inputs: ["manuscript/"],
    optionalInputs: ["references.bib", "figures/*"],
    skills: ["bib-check"],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    humanTasks: [
      {
        title: "核对 % TODO 待核实 处并拍板定稿",
        guidance:
          "定稿里的 % TODO 待核实 只有你能对照原始文献确认；逐条处理后再算定稿，导出投稿用最终 PDF",
        target: "",
        timing: "after",
      },
    ],
  },
];

/** 为旧模板补上统一的最小验收契约；模板可额外声明更具体的条件。 */
function contractizeSteps(steps: ProjectStepDto[]): ProjectStepDto[] {
  return steps.map((step) => {
    const artifacts = step.expectedArtifacts;
    const criteria = [...(step.acceptanceCriteria ?? [])];
    if (!criteria.some((x) => x.includes("非空"))) {
      criteria.unshift("所有必需预期产物均已生成且非空；目录/通配条目至少命中一个非空文件。");
    }
    if (artifacts.some((x) => /references\.bib|citation|bib/i.test(x))) {
      criteria.push("正文引用键均能在 references.bib 解析；未解析键与待补元数据已列出。");
    }
    if (artifacts.some((x) => /figures?\//i.test(x))) {
      criteria.push("图表文件与报告/章节中的引用一一对应，图注包含样本、指标和条件。");
    }
    if (artifacts.some((x) => /(^|\/)analysis\//.test(x) || /(^|\/)experiments\//.test(x) || /(^|\/)cleaning\//.test(x))) {
      criteria.push("脚本包含可重复执行入口，运行参数、数据版本/哈希与失败记录可追溯。");
    }
    if (artifacts.some((x) => /\.(pdf|docx|html)$/.test(x))) {
      criteria.push("渲染命令成功且再生产物为非零字节；渲染警告已记录。");
    }
    return {
      ...step,
      acceptanceCriteria: [...new Set(criteria)],
      // undefined = legacy config, preserve historical “all mounted skills required”;
      // [] is an explicit opt-out and must keep every mounted skill optional.
      requiredSkills:
        step.requiredSkills === undefined
          ? [...step.skills]
          : [...step.requiredSkills],
    };
  });
}

/** 内置模板清单：选择器按此顺序展示，用户模板列在其后 */
const BUILTIN_PIPELINE_TEMPLATES: PipelineTemplateDef[] = [
  {
    id: "review",
    name: "英文综述",
    description:
      "文献检索与筛选 → 精读笔记 → 大纲 → 初稿 → 润色定稿",
    steps: REVIEW_STEPS,
    projectSettings: [
      "综述角度：（领域全景 / 聚焦某个子问题）",
      "目标篇幅：（如 6000-8000 词）",
      "读者与文风：（偏同行专家 / 偏入门科普）",
      "去向：（投期刊 / 毕业论文一章 / 课程作业）",
      "综述深度：（标准档 / 严格档·PRISMA-S）",
    ],
  },
  {
    id: "research-paper",
    name: "科研论文",
    description:
      "计算实验向实证论文：文献检索与筛选 → 精读与研究空白 → 实验设计 → 执行 → 分析 → IMRaD 初稿 → 投稿准备（湿实验/问卷需自改实验步）",
    steps: RESEARCH_PAPER_STEPS,
    projectSettings: [
      "课题边界：（只盯一条线 / 铺满一个方向）",
      "研究问题：（追热点求稳 / 押高风险高回报的 gap）",
      "目标期刊：（冲高一档 / 求稳妥投；决定字数与格式）",
      "语种：（中文 / 英文）",
      "研究形态：（计算实验 / 其他需自改实验步）",
    ],
  },
  {
    id: "data-processing",
    name: "数据处理",
    description:
      "数据登记与质量检查 → 清洗整理 → 探索性分析 → 结论与建议报告",
    steps: DATA_PROCESSING_STEPS,
    projectSettings: [
      "报告给谁看：（业务方 / 同行 / 自己留档）",
      "数据敏感级别：（含个人信息 / 已脱敏 / 公开数据）",
    ],
  },
  {
    id: "thesis",
    name: "毕业论文",
    description:
      "文献检索与筛选 → 精读笔记 → 开题报告与综述 → 研究方法 → 实验执行 → 结果分析与章节 → 全文初稿 → 格式与定稿",
    steps: THESIS_STEPS,
    projectSettings: [
      "论文语种：（中文 / 英文）",
      "学位类型与学校模板：（如 硕士 / 校内 LaTeX 模板）",
      "查重目标：（如 ≤10%）",
      "答辩时间：（倒推各章节的截止）",
    ],
  },
  {
    id: "submission-rebuttal",
    name: "投稿与返修",
    description:
      "首投：期刊格式适配 → 投稿材料；返修：按轮次回复审稿意见 → 修订稿 → 再投稿清单",
    steps: SUBMISSION_INITIAL_STEPS,
    projectSettings: [
      "目标期刊：（决定格式、字数与文风，是这条流程的前提）",
    ],
  },
  {
    id: "latex-paper",
    name: "LaTeX 论文",
    description:
      "把已有成稿转成 LaTeX（也可从笔记从零写）：搭骨架 → 章节写作 → 编译排错 → 定稿导出 PDF",
    steps: LATEX_PAPER_STEPS,
    projectSettings: [
      "目标期刊或学校：（决定文档类与排版格式，是骨架的前提）",
      "篇幅与语种：（如 英文双栏 10 页 / 中文学位论文）",
    ],
  },
];

export const PIPELINE_TEMPLATES: PipelineTemplateDef[] = BUILTIN_PIPELINE_TEMPLATES.map(
  (template) => ({ ...template, steps: contractizeSteps(template.steps) }),
);

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
