---
name: lit-watch
description: 文献监控规范。当用户要求跟踪某个课题的最新文献、订阅 arXiv/期刊关键词、做每日/每周新文献巡检，或流水线中配置了文献监控步骤时使用。按 papers/watchlist.md 的关键词检索新文献，去重后把命中追加到 notes/inbox.md。
---

# 文献监控（lit-watch）

本技能规定「订阅关键词 → 检索新文献 → 去重 → 落成笔记收件箱」的操作规范。目标是让新文献主动汇到 `notes/inbox.md`，而不是每次从零检索。

## 何时使用

- 用户要求「跟踪/盯一下某方向的最新论文」「每天看看 arXiv 有没有新命中」
- 项目流水线中配置了文献监控步骤（简报会指向本技能）

## 输入与文件约定

- **订阅清单 `papers/watchlist.md`**：一行一条，格式 `关键词 — 来源 — 备注`，例如 `GLP-1 cardiovascular outcomes — arxiv — 每周`。文件缺失时在报告中提示用户先建清单并停止，不自行编造关键词。
- **已见记录 `papers/watch-seen.md`**：本技能维护的去重台账，一行一条已处理文献的唯一标识（arXiv id / DOI），首次运行时创建。
- **产出 `notes/inbox.md`**：新命中逐条追加，格式与「整理为笔记」链路兼容。

## 操作规范

### 1. 读订阅清单

逐条读取 `papers/watchlist.md` 的关键词与来源；跳过注释行（`#` 开头）与空行。

### 2. 检索新文献

- arXiv 来源用官方 API（`curl 'https://export.arxiv.org/api/query?search_query=all:<关键词>&sortBy=submittedDate&sortOrder=descending&max_results=25'`），只保留最近 7 天（用户另指定窗口时从其约定）的条目；
- 其他开放来源用 WebFetch/WebSearch 检索同一关键词；
- 检索失败的来源在报告中标注「本次未达」，不跳过不伪造结果；
- 付费墙内容只记录题录（标题/作者/来源/DOI），不得尝试绕过。

### 3. 去重

每篇命中的唯一标识（arXiv id / DOI / 规范化标题）与 `papers/watch-seen.md` 比对，已见过的跳过；新命中的标识追加进台账。

### 4. 落成收件箱

每条新命中追加到 `notes/inbox.md`，固定结构：

```
## <标题>
- 来源：<arxiv/期刊/会议> — <日期> — <链接或 DOI>
- 作者：<前 3 位 et al.>
- 摘要首句：<原文第一句>
- 命中关键词：<watchlist 中的关键词>
- 相关性：相关 / 待确认
```

拿不准相关性的一律收录并标「待确认」，不允许自行丢弃。

### 5. 报告

结束时输出一段简报：本次检索了几条关键词、新命中几篇、几篇「待确认」、哪些来源未达。

## 完成标准

`notes/inbox.md` 只增不改（既有条目不动）；`papers/watch-seen.md` 台账同步更新；重复运行同一窗口不产生重复条目。
