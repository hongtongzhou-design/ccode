---
name: endnote-bridge
description: EndNote 格式桥接规范。当用户必须把项目文献导入 EndNote 库、收尾存量「Word + EndNote」稿件、或组内流程绑定 EndNote 时使用。本项目不依赖 EndNote 桌面端自动化 API，本技能只做格式桥接（references.bib → EndNote XML/RIS 供一键导入；定稿 Markdown [@键] → 带 ADDIN EN.CITE 域的 Word；EndNote 导出 → 解析回流 references.bib）与人工步骤指引；禁止 CWYW 无人值守（不点 Word 插件、不写假花括号引用）。新稿写作可按需选择 Zotero 线（zotero-sync），两者互补不互斥。
inputs: [references.bib]
outputs: [papers/endnote-report.json, output/endnote.docx, papers/endnote-cite-report.md]
---

# EndNote 格式桥接（endnote-bridge）

本技能规定「项目 references.bib ⇄ EndNote 库」以及「定稿 Markdown → 可换样式的 Word 域稿」的桥接口径。采用文件交换：生成导入 XML、从 `[@键]` 写出真正的 `ADDIN EN.CITE` 域（traveling library，不依赖记录号）、解析 EndNote 导出回流。
**禁止** Word COM / 模拟点击 Insert Citation；**禁止**把 `{Author, Year}` 写进可见正文（EndNote 会弹「Select Matching Reference」）。人只打开域稿点一次 Update Citations and Bibliography。

## 何时使用

- 存量稿件用「Word + EndNote（CWYW）」写到一半，需要收尾或继续
- 组内/合作方流程绑定 EndNote，文献库必须交付到 EndNote
- 用户明确要求把 references.bib 导入 EndNote
- 不存在上述约束时可按需选择 Zotero 线（zotero-sync 仍须遵守用户意图与授权门槛）；本技能是兼容桥，不是默认主路

## 红线（不可逾越）

- **禁止 CWYW 无人值守**：不用 Word COM/VBA 点「插入引文 / Update Citations」，不写 `{Author, Year}` 假临时引用。域稿只走 `scripts/cite_docx.py` 写出真正的 `ADDIN EN.CITE`（带 traveling library），人再点一次 Update。
- **不做 EndNote 界面自动化**（模拟点击/键鼠脚本）
- 人工步骤就明说人工步骤（导入库、Update 一次、换 Style），不假装已经刷新过

## 随包离线转换器

`scripts/bridge.py` 支持 UTF-8 BibTeX / EndNote XML / RIS，使用 Python 标准库，不访问个人库或网络。
运行 `python3 <技能目录>/scripts/bridge.py --input <源文件> --output <新候选.xml|.ris|.bib> --report <新报告.json>`。
回流时加 `--existing references.bib`：保留匹配条目的既有键、报告新增/字段差异，只写候选，不修改主库。
输出必须是新路径；遇到未展开 BibTeX 宏、损坏记录或空标题失败，不静默丢记录。先在项目 `papers/imports/` 交付候选，
人审阅报告后才合并，完成后保留报告为 `papers/endnote-report.json`。复杂 BibTeX 扩展先由可信解析器展开，不降低保真要求。

## 操作规范

### 1. 出库桥接（references.bib → EndNote）

- 产出 `papers/endnote-import.xml`（EndNote XML，字段保真最好；本技能主产物）和同内容的 `papers/endnote-import.ris`。Mesa 的「同步到 EndNote」交的是这份 RIS：拖到 EndNote 图标上，选 Reference Manager (RIS)。XML 仍给 File → Import → EndNote XML。
  - bib 里有的字段都要写进导入文件，没有的留空，不编造。期刊文献对应 EndNote 里这些格子：作者（`姓, 名`，一位一个 author / 一条 `AU`；「名 姓」无逗号源串翻转为末词作姓，末词为缩写如 `Smith JM` 时首词作姓）、年份、标题、期刊（secondary-title / `T2`+`JO`）、卷、期、页、起始页码、日期、网络出版日期（RIS 的 `ET`；XML 的 `edition`）、文章类型、其他形式的期刊名（与全称不同才写：`periodical/abbr-1` 与 `titles/alt-title`，RIS 为 `J2`）、ISSN、DOI、关键词（一词一条）、摘要、URL。注释只写文献本身的内容，不写筛选过程、来源库或出版商。
  - 附件：项目 `papers/` 下已配对的 PDF 写进 `pdf-urls`（用 absolute file URL），导入后人工核对附件是否成功绑定，不能假定每个版本/路径都自动成功
  - 转换用随包 `scripts/bridge.py`。bib 里的 `journalabbreviation`、`issn`、`abstract`、`keywords`、`date`、`epubdate`、`language`、`note` 会进上面这些格子。回流 .bib 保持源作者格式。
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
- RIS 与 XML 一起生成（`TY`/`ID`/`AU`/`TI`/`T2`/`J2`/`PY`/`DA`/`ET`/`VL`/`IS`/`SP`/`M2`/`EP`/`M3`/`SN`/`DO`/`KW`/`AB`/`N1`/`UR`，CRLF，无 BOM）。`ID` 载 citation key。对照 EndNote 2025 的 RefMan RIS 过滤器：期刊全称 `T2`，其他形式的期刊名 `J2`，页 `SP`，起始页码 `M2`，文章类型 `M3`，网络出版日期 `ET`（XML 写在 `edition`）。写文件时一次查全：有 DOI 就向 Crossref 取正式字段，摘要和关键词缺了再问 OpenAlex，期刊缩写按 ISSN 查 NLM Catalog 的 Medline 缩写，没有再用 Semantic Scholar 的期刊别名。两处都没有就留空，不让 Agent 现编缩写。点「同步到 EndNote」只把这份已经写好的 RIS 交给 EndNote，不再重新检索。
- 导入动作本身是人工：报告里写清指引——双击文件或 EndNote「File → Import」，XML 选「EndNote generated XML / EndNote XML」、RIS 选「Reference Manager (RIS)」；具体名称与附件解析须在实际版本验证

### 2. Word 侧人工步骤（供人工事项引用）

- 插入引文：Word → EndNote 插件栏 → Insert Citation（GUI 操作）
- 成稿刷新：Update Citations and Bibliography
- 换期刊格式：插件栏切换 Output Style 后刷新
- 这三步不进 agent 产物，只在报告/人工事项里指路

### 3. 定稿域稿（Markdown [@键] → output/endnote.docx）

只在定稿 / 期刊格式适配（不是初稿每一轮）。源稿仍是 `[@键]`。

```bash
python3 <技能目录>/scripts/cite_docx.py \
  --input manuscript/review-final.md \
  --bib references.bib \
  --output output/endnote.docx \
  --report papers/endnote-cite-report.md
```

科研论文用 `manuscript/paper-final.md`，学位论文用 `manuscript/thesis-final.md`。输出必须是新路径，不覆盖 `manuscript/source.docx` 和 Quarto 的 `output/*.docx`。

- 每个 `[@键]` / `[@a; @b]` 写成一条 Word 域：`ADDIN EN.CITE` + traveling library `<record>`（作者/年/题/DOI）。未匹配键 **fail-closed**：写报告、不写 docx、退出码非 0。
- 可见文字用 `(Author, year)`，禁止花括号临时引用。
- 文末放空的 `ADDIN EN.REFLIST`，等人点 Update 填参考文献。
- 报告零未匹配后，人工事项：打开 `output/endnote.docx` → EndNote 工具栏 **Update Citations and Bibliography** → 换 Output Style。合意另存 `manuscript/source.docx`。

### 4. 把人在 Word 里的增删写回源稿

人点过 Update、在 EndNote 里增删引用或另存 `manuscript/source.docx` 之后，Agent 读这份 Word，不改源稿，先写报告：

```bash
python3 <技能目录>/scripts/sync_docx.py --root <项目根> --markdown manuscript/review-final.md
```

科研论文改 `--markdown manuscript/paper-final.md`，学位论文用 `manuscript/thesis-final.md`，期刊格式用 `submission/formatted.md`。优先读 `manuscript/source.docx`，没有才读 `output/endnote.docx`。

报告在 `papers/endnote-sync-report.md`。人把每条决定写成接受或拒绝。然后：

```bash
python3 <技能目录>/scripts/sync_docx.py --root <项目根> --markdown manuscript/review-final.md --apply
```

接受的删除才从源稿去掉 `[@键]`。接受的新文献才追加进 `references.bib`，缺字段标待补。正文里要新加的引用等人指出位置再写。拒绝的不改。

Export Traveling Library 在 Word 的 EndNote 菜单里：把嵌在这篇 Word 里的文献抄进你指定的 EndNote 库。Agent 不代点。只排这一篇时不必做。

### 5. 回流（EndNote → references.bib）

- 触发：用户把 EndNote 导出文件（EndNote XML）放入 `papers/imports/` 或指定路径
- agent 解析后与 references.bib 对账：**逐条列差异**（新增条目 / 字段变更：旧值→新值），未经用户确认不写回
- 确认后合并：新增条目追加（bib 键按项目既有命名规则生成）；**既有条目的键不改**（正文引用靠它，改键 = 断链）；
  EndNote 侧 Record Number 不当键用，只在对账期内做匹配依据
- 合并后按 bib-check 口径跑一次引用闭环自查，断键立即报告

## 产出格式

- `papers/endnote-import.xml`（或 `.ris`）：EndNote 一键导入文件，条目数与 references.bib 一致
- `output/endnote.docx`：带 `ADDIN EN.CITE` 的域稿（未匹配则为无此文件）
- `papers/endnote-cite-report.md`：引用处/唯一键/未匹配清单
- 报告：转换计数（成功 N / 缺字段 M 逐条列出）、附件挂接计数、回流对账差异清单（如有）

## 完成标准

导入文件条数与 references.bib 对得上、缺字段逐条列出；域稿要么零未匹配且含 `ADDIN EN.CITE`，要么不交 docx；
人工步骤指引写清（导入 / Update 一次 / 换 Style）；回流走「列差异 → 用户确认 → 合并」，无静默覆盖；未点 Word 插件、未写花括号临时引用。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：EndNote 官方导入过滤器库（endnote.com/downloads/filters/，含 BibTeX/RIS）、Zotero 官方 KB 对 EndNote XML 的口径佐证
（zotero.org/support/kb/importing_standardized_formats）。内容为按 Ccode 科研工作流编写。
