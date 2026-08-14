---
name: lit-search
description: 文献检索与筛选规范。当用户要求围绕某个课题检索学术文献、做系统综述检索、制定纳入/排除标准、或把候选文献筛选成最终清单时使用。产出 papers/screening.md 与 papers/included.md 两份固定格式文件。
outputs: [papers/]
---

# 文献检索与筛选

本技能规定综述类课题「检索 → 筛选 → 定清单」阶段的操作规范与产出格式。按本规范执行可保证筛选过程可复核、清单可直接交付下一步精读。

## 何时使用

- 用户给出课题主题，要求检索相关文献、做文献调研或系统综述检索
- 用户要求制定/执行纳入与排除标准
- 综述流水线中「文献检索与筛选」一步（简报会指向本技能）

## 操作规范

### 1. 先定标准，再检索

围绕课题主题（用户给出的课题描述；未明确时按项目目录与已有资源自行判断，并把假设写进筛选记录）制定纳入/排除标准，写进 `papers/screening.md`，维度至少包括：

- **年份**（如近五年 / 不限）
- **语言**（如英文 / 中英均可）
- **来源级别**（如期刊与顶会优先、预印本标注）
- **相关性**（与课题问题的关系判定口径）

### 2. 检索候选文献

- 按学科选择来源，常用库清单：arXiv（预印本，可用官方 API 按日期排序）、OpenAlex 与 Semantic Scholar（覆盖广、可程序化检索）、Crossref（DOI 元数据核对）、PubMed（生物医学）、CNKI/知网（中文文献，手动导出题录）；
- 检索词中英文各配一组；每个库的检索式与命中数记入 `papers/screening.md`，保证检索过程可复现；
- 每篇记录：标题、作者、年份、来源、链接或 DOI。字段未知一律标「待补」，不得留空或猜测。

#### 外部 AI 检索站导出导入（人肉中转）

Elicit / Undermind / X-MOL / Google Scholar 等闭源站点无法程序化检索时，由用户在网页端检索并导出 RIS / BibTeX / CSV：

1. 导出文件放入项目 `papers/imports/`，命名「来源-日期」，如 `elicit-20260812.ris`；
2. Agent 负责解析题录、去重、合并进 `papers/screening.md` 候选池与 `references.bib`；
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

### 3. 逐条筛选

按已定标准逐条判定，结果写入 `papers/screening.md`：每篇给出纳入/排除及理由。**拿不准相关性的一律纳入，并标注「待确认」**——不允许自行裁掉。

### 4. 定稿纳入清单

纳入的文献写入 `papers/included.md`，一行一篇，格式：

```
标题 — 作者, 年份 — 来源 — 链接/DOI
```

## 产出格式

- `papers/screening.md`：纳入/排除标准 + 各库检索式与命中数 + 每篇候选文献的判定与理由（含「待确认」标注）
- `papers/included.md`：最终纳入清单（一行一篇，固定行格式）

## 完成标准

两份文件均存在，每条记录无空缺字段（未知则标「待补」）。筛选记录必须能让第三人按标准复现每条判定。`papers/imports/` 里的导出文件处理后保留原档备查，不删除。
