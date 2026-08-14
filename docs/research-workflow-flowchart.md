# 科研操作流程图

基于 Ccode 五套内置流水线模板（`src/pipeline-presets.ts`）绘制的科研操作流程。
核心分工：**AI 负责干活，Ccode 负责管活，人负责拍板**。

## 一、总览：五套流水线与接壤关系

```mermaid
flowchart TB
    subgraph 综述线
        A1[英文综述<br/>检索筛选 → 精读笔记 → 大纲 → 初稿 → 润色定稿]
    end
    subgraph 论文线
        B1[科研论文<br/>选题调研 → 实验设计 → 实验执行 → 结果分析 → 初稿 → 投稿准备]
    end
    subgraph 数据线
        C1[数据处理<br/>登记检查 → 清洗整理 → 探索性分析 → 分析报告]
    end
    subgraph 学位线
        D1[毕业论文<br/>开题与综述 → 研究方法 → 实验与结果 → 全文初稿 → 格式与定稿]
    end
    subgraph 投稿线
        E1[投稿与返修<br/>期刊格式适配 → 投稿材料 → 审稿意见逐条回复]
    end
    W[◔ 定时雷达<br/>lit-watch 每日/每周巡检新文献]

    C1 -->|analysis/ 报告与清洗后数据| B1
    A1 -->|notes/ 与 references.bib| B1
    A1 -->|notes/ 与 references.bib| D1
    B1 -->|paper-final.md| E1
    A1 -->|review-final.md| E1
    W -.->|新文献命中 → notes/inbox.md| A1
    W -.->|新文献命中| D1
```

## 二、单个步骤的执行闭环（所有步骤通用）

每一步都是「开工确认 → agent 干活 → 人拍板 → 评审合并」的闭环：

```mermaid
flowchart LR
    K[＋ 一键开步<br/>KickoffConfirmDialog<br/>预览/编辑 TASK.md] --> T[终端拉起 agent<br/>注入简报 + 挂载技能<br/>工作区 worktree 隔离]
    H1([人工事项 before<br/>如：补文献/配 MCP/备数据]) -.-> T
    T --> X{agent 执行}
    H2([人工事项 during<br/>如：补投付费全文]) -.-> X
    X -->|产出 expectedArtifacts| R[评审合并<br/>改动面板逐 hunk 验收]
    H3([人工事项 after<br/>如：审阅大纲/拍板待确认项]) -.-> R
    R -->|✓ 验收合并进 main| N[下一步开工]
    R -.->|打回修改| X
```

关键规则：

- 简报三写死：输入路径写死、决策规则写死（拿不准一律纳入标「待确认」）、交付标准写死
- 拿不准的不裁掉：标 `[待确认]` / `[待核实]` / `[待补实验]`，留人拍板
- 原始数据与原始结果全程只读 / 进产物目录，不进 git
- 引用只用 `references.bib` 已有键，严禁编造文献

## 三、各流水线步骤链

### 英文综述

```mermaid
flowchart LR
    S1[文献检索与筛选<br/>lit-search<br/>→ papers/screening·included·to-fetch] --> S2[文献精读与笔记<br/>lit-notes<br/>→ notes/ + references.bib]
    S2 --> S3[综述大纲<br/>review-framework<br/>→ outline.md]
    S3 --> S4[综述初稿<br/>review-writing<br/>→ manuscript/draft.md]
    S4 --> S5[润色与定稿<br/>review-writing + bib-check<br/>→ review-final.md + changelog]
    S3 -.->|人工：审阅大纲再开初稿| S4
    S5 -.->|人工：核对 [待核实] 条目| S5
```

### 科研论文

```mermaid
flowchart LR
    P1[选题与文献调研<br/>lit-search + lit-notes<br/>→ survey/gap-analysis.md] --> P2[实验设计<br/>stats-check<br/>→ design.md]
    P2 --> P3[实验执行<br/>→ experiments/ + results/summary.md]
    P3 --> P4[结果分析<br/>stats-check + figure-forge<br/>→ analysis/ + figures/]
    P4 --> P5[论文初稿 IMRaD<br/>→ manuscript/draft.md<br/>quarto render PDF/docx]
    P5 --> P6[润色与投稿准备<br/>bib-check + stats-check<br/>→ paper-final.md + submission/checklist]
    P1 -.->|人工：确认研究问题| P2
    P2 -.->|人工：审阅实验设计| P3
```

### 数据处理

```mermaid
flowchart LR
    D1[数据登记与检查<br/>→ data-dictionary.md<br/>原始数据全程只读] --> D2[清洗与整理<br/>data-clean<br/>规则先行 → cleaning/]
    D2 --> D3[探索性分析<br/>data-eda + stats-check<br/>→ figures/ + eda-report.md]
    D3 --> D4[分析报告<br/>→ analysis-report.md<br/>建议与发现一一对应]
    D2 -.->|人工：拍板 [待确认] 清洗规则| D2
```

### 毕业论文

```mermaid
flowchart LR
    T1[开题与文献综述<br/>lit-search + lit-notes + proposal-writer<br/>→ proposal.md + 综述章节] --> T2[研究方法<br/>stats-check<br/>→ methodology.md + design.md]
    T2 --> T3[实验与结果<br/>figure-forge + stats-check<br/>→ results.md + figures/]
    T3 --> T4[全文初稿<br/>quarto-render<br/>→ thesis-draft.md 渲染 PDF/docx]
    T4 --> T5[格式与定稿<br/>bib-check + quarto-render<br/>→ thesis-final.md + 格式/查重报告]
    T1 -.->|人工：开题送导师评阅| T2
    T2 -.->|人工：与导师确认技术路线| T3
    T5 -.->|人工：定稿送导师 + 学校查重| T5
```

### 投稿与返修

```mermaid
flowchart LR
    E1[期刊格式适配<br/>bib-check<br/>→ submission/formatted.md] --> E2[投稿材料<br/>→ cover-letter + pre-review + checklist]
    E2 --> E3[审稿意见回复<br/>rebuttal-crafter<br/>→ response-letter + revisions + revised.md]
    E3 -.->|新一轮意见 reviews/round-N.md| E3
    E1 -.->|人工：拍板期刊与字数裁剪| E2
    E3 -.->|人工：补实验/投稿系统提交| E3
```
