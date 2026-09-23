---
name: lit-search
description: 文献检索与筛选规范。当用户要求围绕某个课题检索学术文献、做系统综述检索、制定纳入/排除标准、或把候选文献筛选成最终清单时使用。按深度分档（快筛/标准/系统综述）执行，检索过程全程留痕可复现。产出 papers/screening.md 与 papers/included.md 两份固定格式文件；付费墙文献列入 papers/to-fetch.md 并附 to-fetch.ris 供导入 Zotero。
outputs: [papers/]
---

# 文献检索与筛选

本技能规定综述类课题「检索 → 筛选 → 定清单」阶段的操作规范与产出格式。按本规范执行可保证筛选过程可复核、清单可直接交付下一步精读。

## 何时使用

- 用户给出课题主题，要求检索相关文献、做文献调研或系统综述（PRISMA）检索
- 用户要求制定/执行纳入与排除标准
- 综述流水线中「文献检索与筛选」一步（简报会指向本技能）

## 操作规范

### 0. 先定深度档

- 默认**标准档**；用户明说「随便查几篇 / 快速扫一眼」→ **快筛档**（候选上限约 30，一轮筛选，可不做引用扩展）；明说「系统综述 / PRISMA / meta 分析」→ **严格检索档**（强制引用扩展、标题摘要与全文分层筛选、检索披露，见「产出格式」）；严格检索不等于完整系统综述或 meta 分析；
- 选了非默认档，在筛选记录开头写明选了哪档、为什么；
- **主题词剥离**：查询里的「中科院一区 / Q1 / 顶刊 / 近五年」等是过滤条件，进纳入排除标准，**不得当主题词送进检索式**。

### 1. 先定标准，再检索

可先试检评估范围与成本；正式纳排标准由研究问题决定，不因结果方向或凑篇数而改变。记录试检与正式检索的区别、标准版本及人确认依据。

围绕课题主题（用户给出的课题描述；未明确时仅提出候选主题，写入筛选记录并等人确认；可先试检估算范围，不默认确定题目）制定纳入/排除标准，写进 `papers/screening.md`，维度至少包括：

- **年份**（如近五年 / 不限）
- **语言**（如英文 / 中英均可）
- **来源级别**（如期刊与顶会优先、预印本标注）
- **相关性**（与课题问题的关系判定口径）

### 2. 问题概念化与检索词

- 先把课题拆成 2-4 个概念块（医学干预类可用 PICO：人群/干预/对照/结局；质性研究可用 SPIDER；其余按核心概念直拆），每块列 2-5 个同义词/缩写/中英对应；检索式按**块内 OR、块间 AND** 组配；
- 概念块与同义词表写进 `papers/screening.md`，作为检索式的来源依据；
- 语言范围依研究问题与覆盖需要说明；可用中英试检，不把语言限制和期刊声望当作研究质量。改变正式范围须记录原因并经人确认。

### 3. 检索候选文献

- 按学科选择来源，常用库清单：arXiv（预印本，可用官方 API 按日期排序）、OpenAlex 与 Semantic Scholar（覆盖广、可程序化检索）、Crossref（DOI 元数据核对）、PubMed（生物医学）、DBLP（CS 会议/期刊索引，免费 API）、CNKI/知网（中文文献，手动导出题录）；
- **Consensus / Undermind MCP（挂了就必须用，2026-09-15 实测被跳过后收紧）**：开工第一件事盘点本会话可用工具——只要存在 mcp__undermind / mcp__consensus 类工具就各跑至少一轮检索（Undermind = 语义深搜补漏，围绕课题先跑一轮；Consensus = 按研究问题搜同行评议论文）。命中并进候选池，检索日志「库」写 Consensus / Undermind，去重与纳排与其他库同一套；**不替代** OpenAlex / Semantic Scholar，也不另写一份清单。**工具在而没检索 = 违规**，必须在覆盖缺口里写明原因；只有工具不存在或调用失败才允许跳过并声明，不中断检索；
- 检索日志用固定六字段表头，逐库一行记入 `papers/screening.md`：**日期 / 库 / 完整检索式 / 命中数 / 去重后数 / 筛后保留数**，保证检索过程可复现；
- 各库结果合并去重后，同一篇（DOI 或标题归一判定）被 ≥2 个库命中的，在记录上标「**多源命中**」——这是优先阅读的提示，不是纳入标准；
- 每篇记录：标题、作者（全名，一位一行）、年份、期刊全称、卷、期、页码、出版日期、文章类型、ISSN、DOI、链接。有摘要、关键词、期刊缩写一并记下。字段未知一律标「待补」，不得留空或猜测。
- **有 DOI 就用 Crossref 把上面这些字段补全再写入筛选记录和 RIS**（`https://api.crossref.org/works/<DOI>`，礼貌 User-Agent）。Crossref 没有摘要时再用 OpenAlex。期刊缩写不拿 Crossref 的 short-container-title 当缩写（它经常等于全称）：按 ISSN 查 NLM Catalog 的 `MedlineTA`（`esearch` `db=nlmcatalog` + `efetch`），目录没有再用 Semantic Scholar 的 `publicationVenue.alternate_names` 里短于全称的那条。两处都没有就标「待补」，不自己编缩写。没有期、没有独立网络出版日也标「待补」，不把卷、页或创建日期挪去填。作者以 Crossref 的 `family`/`given` 为准，写成 `姓, 名`，一人一行；来源名单被截成「前三人, et al.」或同一人重复出现时，用 Crossref 的完整名单替换，不沿用截断名单。

#### 外部 AI 检索站导出导入（人肉中转）

Elicit / Undermind / X-MOL / Google Scholar 等闭源站点无法程序化检索时，由用户在网页端检索并导出 RIS / BibTeX / CSV：

1. 导出文件放入**项目根** `papers/imports/`（见 TASK.md「项目根」），命名「来源-日期」，如 `elicit-20260812.ris`；
2. Agent 负责解析题录、去重、合并进 `papers/screening.md` 候选池与 `references.bib`；**导出文件有三处都要看**：项目根 `papers/imports/`、工作区内的 `papers/imports/`，以及 TASK.md「项目资源」段里类型为「引文」的条目、「上一步产物（提货单）」段里来自「人工交付」的条目——后两类给的是绝对路径，按路径直读、不要复制进工作区；
3. 去重口径：DOI 精确匹配优先，标题模糊匹配（忽略大小写与标点）兜底；
4. 每条记录保留来源标注（如「来源：Elicit 导出」），便于回溯检索渠道。

#### 带 key 的 API 检索

需要订阅密钥的库，key 一律走环境变量引用（`$VAR`），**禁止写进任何文件**（skills 文档、配置、脚本都不行）：

- **Web of Science**：Clarivate 官方 REST API（需机构订阅 key），用 `$WOS_API_KEY` 引用，如
  `curl -H "X-ApiKey: $WOS_API_KEY" "https://api.clarivate.com/apis/wos-starter/v1/documents?q=TS=(topic)"`；
- **Consensus**：官方 API / hosted MCP（端点 `https://mcp.consensus.app/mcp`，HTTP 传输，401 需鉴权；以官方文档为准），key 用 `$CONSENSUS_API_KEY` 引用；
- **Google Scholar 无官方 API**：首选 OpenAlex / Semantic Scholar 替代（均有免费官方 API）；确需 Scholar 走 SerpAPI（`$SERPAPI_KEY` 引用），如
  `curl "https://serpapi.com/search.json?engine=google_scholar&q=<检索词>&api_key=$SERPAPI_KEY"`。

#### 推荐 MCP（可选，去 MCP 页粘贴导入）

以下 MCP server 与文献工作流相关；配置片段为标准 `mcpServers` 条目，到 Mesa 的 MCP 页用「粘贴导入」添加（粘贴导入会列出完整命令清单，确认来源可信再导入）：

- **Consensus**（官方 hosted MCP；key 用 `$CONSENSUS_API_KEY` 环境变量引用，不落明文）：

```json
"consensus": { "type": "http", "url": "https://mcp.consensus.app/mcp", "headers": { "Authorization": "Bearer $CONSENSUS_API_KEY" } }
```

- **Playwright**（stdio；浏览器操作重型备胎——检索站反爬/需登录导出时兜底，平时不必挂载）：

```json
"playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
```

- Semantic Scholar 无权威社区 MCP，直接用其官方 REST API 即可（基础检索免 key）。

### 4. 逐条筛选

- 系统综述按方案分别记录标题摘要和全文判定，不因候选少跳过全文；普通调研可按规模合并操作，但保留逐条证据和判定；
- 每篇给出纳入/排除及理由；排除理由从固定枚举里选：**年份不符 / 语言不符 / 来源级别不符 / 主题无关 / 重复 / 非实证研究**，都不沾边才写自由理由；
- **拿不准相关性的一律保留候选，并标注「待确认」**——不允许自行裁掉，也不能冒充最终纳入；「多源命中」不等于证据更强。全文未得的判定及其对覆盖的影响单列。
- **先拍 pending，再下载全文**：`to-fetch.md` 与开放获取下载都只针对 `decision=included`。禁止把 pending 写入待获取或先下其全文。有 pending 时写入 `.ccode/help-wanted.md` 请人逐篇纳入或排除（未回复则不把 pending 当已纳入）；人改成 included 后才允许补进 to-fetch。

### 5. 引用扩展与停止

- 标准档可选、严格档强制：从已纳入清单选择能覆盖不同概念与相反结论的种子文献（数量依问题，不固定为 3-5 篇），查其参考文献（向后）与被引（向前，OpenAlex / Semantic Scholar 均可），新增候选并入筛选；
- **显式停止**：普通检索可把新增很少作为预算提示，但停止依据须对应范围和覆盖缺口；系统综述按已批准方案和来源覆盖停止，不用固定两轮或少于三篇冒充穷尽。预算不足时报告未完成范围，供人缩题或补检。用户喊停立即停，保留已有清单；
- 每轮扩展的来源种子与新增数记进 `papers/screening.md`。

### 6. 定稿纳入清单

纳入的文献写入 `papers/included.md`，一行一篇，格式：

```
标题 — 作者, 年份 — 来源 — 链接/DOI
```

### 7. 综述类型与证据集合

- 开始即区分叙述性/范围/系统综述；期刊独立、学位章只是呈现形态，不代替方法类型。叙述性综述不强制套完整系统综述。
- 系统综述先确认方案、问题与纳排、数据库/灰色文献覆盖、全文筛选、提取表、研究级去重、适用偏倚风险工具、综合方法及证据确定性评价；不能只升级检索日志。不会选择方法时寻求方法专家。
- 同一研究多个报告、预印本与正式版关联 studyId/reportId，不能计成多个独立样本或独立证据；核对核心研究更正/撤稿及版本状态，保留依据。
- 关键/主观提取和筛选分歧按所选规范安排独立复核与人工裁决；明确单人、第二人、Agent 各做了什么。两个 Agent 不等价于双人系统综述。
- 每次追加/复用检索检查日期、问题/范围/标准变化；更新纳入清单并标出受影响笔记与论断，不能因有旧 notes 就跳过。新增关键参考文献按同样纳排流程加入，不封死引文库。

## 产出格式

- `papers/screening.md`：固定结构——深度档与假设 → 纳入/排除标准 → 概念块与检索词 → 检索日志表（六字段）→ 逐条判定（含「待确认」「多源命中」标注）→ 引用扩展轮次记录 → **覆盖缺口声明**（哪些库没检、意味着什么缺失，如「未检 CNKI，中文核心期刊覆盖缺失」「WoS 无订阅未检」）
- `papers/included.md`：纳入清单（一行一篇，固定行格式；尚待确认单列，不冒充已决）
- `papers/included.json`：与 included.md 一一对应的记录数组。每条有稳定非空字符串 `id`、`title`、`decision`、`reason`。decision 为 included / pending。**pending 与 included 同一套题录，检索时一次查全**，不要等纳入后再查：`authors`（数组，`姓, 名`）、`year`、`venue`、`volume`、`issue`、`pages`、`date`、`epubDate`、`articleType`、`issn`、`journalAbbreviation`、`abstract`、`keywords`、`language`、`doi`、`url`。查不到的写「待补」。人点纳入时 Mesa 把这条原样追加进 `endnote-import.ris` 和 `to-fetch.ris`，不再另查。空清单用 `[]`。不用修改 id 隐藏旧记录。
- `papers/to-fetch.md`：仅 **已纳入（decision=included）** 且未获得全文的付费墙清单，**不得列入 pending**（2026-09-15 收紧格式——裸「标题 — DOI」堆叠没编号，用户无法对照追踪进度）：**编号列表，每行 `N. 标题 — DOI`，N 从 1 连续**，顺序与 to-fetch.ris 条目一致；补齐全文的行在编号后加 `✓`（如 `3. ✓ 标题 — DOI`），编号不重排；无待获取则注明为空
- `papers/endnote-import.ris` 与 `papers/to-fetch.ris` 字段同一套，检索时一次写全，pending 的完整题录也写在 included.json 里。人把 pending 改成纳入后，Mesa 把这条追加进两份 RIS（同一 DOI 或标题已在则不重复）。排除的不写。不在纳入这一下重新检索。
- `papers/to-fetch.ris`：to-fetch.md 的 RIS 2004 转换件（每篇 `TY  - JOUR`，CRLF，条目顺序与 to-fetch.md 编号一致）。**一位作者一条 `AU`**（`姓, 名`）；多位挤在同一条 `AU` 里，EndNote 会把整串当成一个人。有数据才写这些标签：`TI` 标题、`T2`/`JO` 期刊全称、`J2` 期刊缩写（与全称不同才写）、`PY` 四位年份、`DA` 出版日期、`ET` 网络出版日期、`VL` 卷、`IS` 期、`SP` 页、`M2` 起始页码、`EP` 结束页、`M3` 文章类型、`SN` ISSN、`DO` DOI、`KW` 关键词（一词一条）、`AB` 摘要、`UR` 链接。`N1` 只写文献本身的注释，不写筛选过程、来源库、出版商或「关键词来自 OpenAlex」这类流程说明。只给 TI/DO/UR 时，Zotero 的作者/年份/期刊列和 EndNote 的卷期页、摘要全是空的。确无数据的标签不写，不编造。与 to-fetch.md 同增删
- **严格档追加 PRISMA-S 最小披露段**（screening.md 末尾）：各库完整检索式、检索日期、命中→去重→纳入计数、去重方法——这是最低留痕，不是完整 PRISMA-S 符合声明；系统综述逐项对照官方完整规范并记录适用性。

## 验收入口

有 TASK.md 时沿用其中的验收摘要/质量状态合同，不重复建表；独立使用时，在本报告开头写：回答、关键证据入口、未验证、影响结论的问题、待人决定。状态为待审/有条件接受/证据通过（限定范围）/阻塞；推荐不等于人工批准。

## 完成标准

文件均存在，每条记录无空缺字段（未知则标「待补」）。筛选记录必须能让第三人按标准复现每条判定。深度档已声明；检索日志六字段无缺；覆盖缺口声明已写；严格档最小披露四项齐全。`papers/imports/` 里的导出文件处理后保留原档备查，不删除。

## 人工补投的命名整理

开放获取全文下载到 **TASK.md 写明的项目根 `papers/`**，不要写当前工作区（PDF 不进 git，写在工作区会在合并后丢失）。文件名「作者年份-短标题.pdf」。**人工补投的文件名随意，不改名压力不交给用户**——下一步精读（lit-notes）开工时由 agent 对照 included.md/to-fetch.md 判定归属后统一重命名，并在 to-fetch.md 勾掉已补行；拿不准归属的不改名、标注「待确认」。
