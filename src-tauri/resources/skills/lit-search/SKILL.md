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

- 默认**标准档**；用户明说「随便查几篇 / 快速扫一眼」→ **快筛档**（候选上限约 30，一轮筛选，可不做引用扩展）；明说「系统综述 / PRISMA / meta 分析」→ **严格档**（强制引用扩展、两轮筛选、PRISMA-S 最小披露，见「产出格式」）；
- 选了非默认档，在筛选记录开头写明选了哪档、为什么；
- **主题词剥离**：查询里的「中科院一区 / Q1 / 顶刊 / 近五年」等是过滤条件，进纳入排除标准，**不得当主题词送进检索式**。

### 1. 先定标准，再检索

围绕课题主题（用户给出的课题描述；未明确时按项目目录与已有资源自行判断，并把假设写进筛选记录）制定纳入/排除标准，写进 `papers/screening.md`，维度至少包括：

- **年份**（如近五年 / 不限）
- **语言**（如英文 / 中英均可）
- **来源级别**（如期刊与顶会优先、预印本标注）
- **相关性**（与课题问题的关系判定口径）

### 2. 问题概念化与检索词

- 先把课题拆成 2-4 个概念块（医学干预类可用 PICO：人群/干预/对照/结局；质性研究可用 SPIDER；其余按核心概念直拆），每块列 2-5 个同义词/缩写/中英对应；检索式按**块内 OR、块间 AND** 组配；
- 概念块与同义词表写进 `papers/screening.md`，作为检索式的来源依据；
- 语言空间一律默认中英都检，未明确时自行判断并把假设写进筛选记录，不为此中断去问用户。

### 3. 检索候选文献

- 按学科选择来源，常用库清单：arXiv（预印本，可用官方 API 按日期排序）、OpenAlex 与 Semantic Scholar（覆盖广、可程序化检索）、Crossref（DOI 元数据核对）、PubMed（生物医学）、DBLP（CS 会议/期刊索引，免费 API）、CNKI/知网（中文文献，手动导出题录）；
- 检索日志用固定六字段表头，逐库一行记入 `papers/screening.md`：**日期 / 库 / 完整检索式 / 命中数 / 去重后数 / 筛后保留数**，保证检索过程可复现；
- 各库结果合并去重后，同一篇（DOI 或标题归一判定）被 ≥2 个库命中的，在记录上标「**多源命中**」——这是优先阅读的提示，不是纳入标准；
- 每篇记录：标题、作者、年份、来源、链接或 DOI。字段未知一律标「待补」，不得留空或猜测。

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

以下 MCP server 与文献工作流相关；配置片段为标准 `mcpServers` 条目，到 Ccode 的 MCP 页用「粘贴导入」添加（粘贴导入会列出完整命令清单，确认来源可信再导入）：

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

- 候选 >30 条时分两轮：第一轮仅按标题/摘要排除明显无关；第二轮对剩余逐条判定。≤30 条可一轮到底；
- 每篇给出纳入/排除及理由；排除理由从固定枚举里选：**年份不符 / 语言不符 / 来源级别不符 / 主题无关 / 重复 / 非实证研究**，都不沾边才写自由理由；
- **拿不准相关性的一律纳入，并标注「待确认」**——不允许自行裁掉；「多源命中」不等于纳入。

### 5. 引用扩展与停止

- 标准档可选、严格档强制：从已纳入清单挑最相关的 3-5 篇，查其参考文献（向后）与被引（向前，OpenAlex / Semantic Scholar 均可），新增候选并入筛选；
- **显式停止**：扩展一轮后新增纳入 <3 篇即停；最多两轮。用户中途喊停立即停，已产出的四件套照常交付；
- 每轮扩展的来源种子与新增数记进 `papers/screening.md`。

### 6. 定稿纳入清单

纳入的文献写入 `papers/included.md`，一行一篇，格式：

```
标题 — 作者, 年份 — 来源 — 链接/DOI
```

## 产出格式

- `papers/screening.md`：固定结构——深度档与假设 → 纳入/排除标准 → 概念块与检索词 → 检索日志表（六字段）→ 逐条判定（含「待确认」「多源命中」标注）→ 引用扩展轮次记录 → **覆盖缺口声明**（哪些库没检、意味着什么缺失，如「未检 CNKI，中文核心期刊覆盖缺失」「WoS 无订阅未检」）
- `papers/included.md`：最终纳入清单（一行一篇，固定行格式）
- `papers/to-fetch.md`：付费墙等未获得全文的待获取清单（一行一篇：`标题 — DOI`；无待获取则注明为空）
- `papers/to-fetch.ris`：to-fetch.md 的 RIS 2004 转换件（每篇 `TY - JOUR` + `TI`/`DO`/`UR` 尽力而为，字段缺则留空不编造），供用户一键导入 Zotero/EndNote 建成待获取列表；与 to-fetch.md 同增删
- **严格档追加 PRISMA-S 最小披露段**（screening.md 末尾）：各库完整检索式、检索日期、命中→去重→纳入计数、去重方法——四项齐全即可直接改写进综述 Methods 的「文献检索策略」段。

## 完成标准

文件均存在，每条记录无空缺字段（未知则标「待补」）。筛选记录必须能让第三人按标准复现每条判定。深度档已声明；检索日志六字段无缺；覆盖缺口声明已写；严格档最小披露四项齐全。`papers/imports/` 里的导出文件处理后保留原档备查，不删除。

## 人工补投的命名整理

开放获取全文下载到 **TASK.md 写明的项目根 `papers/`**，不要写当前工作区（PDF 不进 git，写在工作区会在合并后丢失）。文件名「作者年份-短标题.pdf」。**人工补投的文件名随意，不改名压力不交给用户**——下一步精读（lit-notes）开工时由 agent 对照 included.md/to-fetch.md 判定归属后统一重命名，并在 to-fetch.md 勾掉已补行；拿不准归属的不改名、标注「待确认」。
