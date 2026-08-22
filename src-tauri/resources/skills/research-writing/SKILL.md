---
name: research-writing
description: Write and revise empirical research papers from an outline, study design, analysis outputs, figures, and an existing BibTeX library. Use for IMRaD manuscripts and evidence reports; do not use for literature-only reviews or rebuttal letters.
outputs: [manuscript/]
---

# 实证科研论文写作

## 适用范围

用于有研究问题、方法、结果和讨论的实证论文或分析报告。先读任务书、研究设计、结果表和现有文献笔记，再写作；不要把综述写作方式套到实验结果上。

## 核心约束

- 只使用项目已有的研究问题、方法、结果和 `references.bib`。不得编造数据、样本、显著性、实验条件或文献。
- 数字、方向和结论必须能回溯到分析表、结果章节或图表；证据不足写 `[待核实]` 或 `[待补实验]`，不要用流畅措辞掩盖缺口。
- 按 IMRaD 组织：Introduction 说明问题、研究空白和贡献；Methods 对应设计；Results 只报告观察结果；Discussion 区分解释、局限和后续工作。
- 负结果、失败实验、离群值和与假设不一致的结果必须保留并说明处理规则，不因结果不理想而事后换分析口径。
- 引用只使用 `references.bib` 已存在的键；缺条目先补齐可核验元数据并标注待核，不凭记忆生成。

## 写作流程

1. 读取 `TASK.md`、项目全局设定、研究设计、`analysis/results-table.md`、`analysis/findings.md`、图表说明和文献笔记，建立“论点—证据—来源”表。
2. 先列出每节要回答的问题与证据，再成文。每个主要结论至少绑定一个数字、表/图或可定位的文献来源。
3. 生成 `manuscript/draft.md` 或任务书指定的稿件文件；图表只引用已有文件或用明确占位，不复制或虚构图片。
4. 做一致性检查：术语、样本量、分组、指标、方向、有效数字、图表编号和引用键前后一致。
5. 另列局限、未决事项和需要人工确认的作者信息/投稿信息，不能把这些内容悄悄填成事实。

## 交付自查

- IMRaD 四部分齐全，研究问题与贡献在引言和讨论中一致。
- Results 没有混入未经分析支持的因果表述；Discussion 明确哪些是结果、哪些是解释或推测。
- 每个表/图在正文中被引用，图注说明样本、指标和条件；没有数据的图表保留占位并标注待绘制。
- 文中引用键均能在 `references.bib` 找到；不确定的事实带 `[待核实]`。
