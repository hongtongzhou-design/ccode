---
name: endnote-bridge
description: EndNote 格式桥接规范。当用户必须把项目文献导入 EndNote 库、收尾存量「Word + EndNote」稿件、或组内流程绑定 EndNote 时使用。本项目不依赖 EndNote 桌面端自动化 API，本技能只做格式桥接（references.bib → EndNote XML/RIS 供一键导入；EndNote 导出 → 解析回流 references.bib）与人工步骤指引；禁止 CWYW 无人值守 hack（Word COM/域代码触发，脆弱易卡）。新稿写作可按需选择 Zotero 线（zotero-sync），两者互补不互斥。
inputs: [references.bib]
outputs: [papers/endnote-report.json]
---

# EndNote 格式桥接（endnote-bridge）

本技能规定「项目 references.bib ⇄ EndNote 库」的桥接口径。本项目明确采用文件交换，不从 API 门户缺项推断桌面端绝无自动化能力。本技能只做两件事：**生成 EndNote 可一键导入的文件**、**解析 EndNote 导出文件回流**；
库内操作与 Word 插入引用始终是人工步骤。

## 何时使用

- 存量稿件用「Word + EndNote（CWYW）」写到一半，需要收尾或继续
- 组内/合作方流程绑定 EndNote，文献库必须交付到 EndNote
- 用户明确要求把 references.bib 导入 EndNote
- 不存在上述约束时可按需选择 Zotero 线（zotero-sync 仍须遵守用户意图与授权门槛）；本技能是兼容桥，不是默认主路

## 红线（不可逾越）

- **禁止 CWYW 无人值守**：不用 Word COM/VBA 触发「插入引文 / Update Citations」，不生成 `ADDIN EN.CITE` 域代码伪装已插入——
  这类 hack 绑定 Word/EndNote 版本组合、无人值守易卡对话框，出了错用户看不出来
- **不做 EndNote 界面自动化**（模拟点击/键鼠脚本），理由同上
- 人工步骤就明说人工步骤，写清操作指引即可（见 §3），不假装自动化

## 随包离线转换器

`scripts/bridge.py` 支持 UTF-8 BibTeX / EndNote XML / RIS，使用 Python 标准库，不访问个人库或网络。
运行 `python3 <技能目录>/scripts/bridge.py --input <源文件> --output <新候选.xml|.ris|.bib> --report <新报告.json>`。
回流时加 `--existing references.bib`：保留匹配条目的既有键、报告新增/字段差异，只写候选，不修改主库。
输出必须是新路径；遇到未展开 BibTeX 宏、损坏记录或空标题失败，不静默丢记录。先在项目 `papers/imports/` 交付候选，
人审阅报告后才合并，完成后保留报告为 `papers/endnote-report.json`。复杂 BibTeX 扩展先由可信解析器展开，不降低保真要求。

## 操作规范

### 1. 出库桥接（references.bib → EndNote）

- 产出 `papers/endnote-import.xml`（EndNote XML 格式，EndNote 首选导入格式，字段保真最好；这是本技能主产物）：
  - 最小字段集：ref-type（Journal Article=17，其余类型按 EndNote XML 对照表）、authors（`姓, 名` 逐作者一个 author 元素；「名 姃」无逗号源串（OpenAlex 等）自动翻转为末词作姓，末词为缩写（PubMed 风格 `Smith JM`）时首词作姓，已带逗号者不动；回流 .bib 输出保持源格式）、
    title、secondary-title（期刊名）、year、volume/number/pages、electronic-resource-num（DOI）、urls
  - 附件：项目 `papers/` 下已配对的 PDF 写进 `pdf-urls`（用 absolute file URL），导入后人工核对附件是否成功绑定，不能假定每个版本/路径都自动成功
  - 生成脚本放 `analysis/`（可复现、`main()` 入口）；bib 解析用现成库（如 Python bibtexparser），缺字段留空不编造
- 最小骨架（字段名和层级不可省略；每条记录按此结构生成）：
  ```xml
  <xml><records><record>
    <ref-type name="Journal Article">17</ref-type>
    <contributors><authors><author><style>Doe, Jane</style></author></authors></contributors>
    <titles><title>Example title</title><secondary-title>Example Journal</secondary-title></titles>
    <dates><year>2026</year></dates>
    <electronic-resource-num>10.0000/example</electronic-resource-num>
    <urls><pdf-urls><url>file:///C:/project/papers/example.pdf</url></pdf-urls></urls>
  </record></records></xml>
  ```
- 备选：用户环境导不进 XML 时改产 `papers/endnote-import.ris`（TY/AU/TI/JO/PY/DO/UR，RIS 2004 口径）
- 导入动作本身是人工：报告里写清指引——双击文件或 EndNote「File → Import」，XML 选「EndNote generated XML / EndNote XML」、RIS 选「Reference Manager (RIS)」；具体名称与附件解析须在实际版本验证

### 2. Word 侧人工步骤（供人工事项引用）

- 插入引文：Word → EndNote 插件栏 → Insert Citation（GUI 操作）
- 成稿刷新：Update Citations and Bibliography
- 换期刊格式：插件栏切换 Output Style 后刷新
- 这三步不进 agent 产物，只在报告/人工事项里指路

### 3. 回流（EndNote → references.bib）

- 触发：用户把 EndNote 导出文件（EndNote XML）放入 `papers/imports/` 或指定路径
- agent 解析后与 references.bib 对账：**逐条列差异**（新增条目 / 字段变更：旧值→新值），未经用户确认不写回
- 确认后合并：新增条目追加（bib 键按项目既有命名规则生成）；**既有条目的键不改**（正文引用靠它，改键 = 断链）；
  EndNote 侧 Record Number 不当键用，只在对账期内做匹配依据
- 合并后按 bib-check 口径跑一次引用闭环自查，断键立即报告

## 产出格式

- `papers/endnote-import.xml`（或 `.ris`）：EndNote 一键导入文件，条目数与 references.bib 一致
- `analysis/<转换脚本>`：可复现，重跑产出一致
- 报告：转换计数（成功 N / 缺字段 M 逐条列出）、附件挂接计数、回流对账差异清单（如有）

## 完成标准

导入文件条数与 references.bib 对得上、缺字段逐条列出；人工步骤指引写清（导入 / 插入 / 刷新三处）；
回流走「列差异 → 用户确认 → 合并」，无静默覆盖；全程未触碰 CWYW 与 EndNote 界面。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：EndNote 官方导入过滤器库（endnote.com/downloads/filters/，含 BibTeX/RIS）、Zotero 官方 KB 对 EndNote XML 的口径佐证
（zotero.org/support/kb/importing_standardized_formats）。内容为按 Ccode 科研工作流编写。
