---
name: quarto-render
description: Quarto 稿件渲染规范。当用户要求把 manuscript/ 下的 .md/.qmd 渲染为 PDF/docx/html，或论文流水线中「渲染成稿」一步时使用。先 quarto check 确认环境，渲染产物写入产物目录（不进 git），缺依赖按序引导安装，报错按归属处理并走修复-验证闭环，渲染成功后验收产物并在 Ccode 改动面板「登记产物」记入提货单。
outputs: [output/]
---

# Quarto 稿件渲染

本技能规定 `manuscript/` 下的 `.md`/`.qmd` 稿件渲染成稿的操作规范与产出格式。渲染产物（PDF/docx/html）体积大且可再生，**一律写入产物目录、不进 git**；git 里只保留源稿与配置。

拿不准的语法或选项，以本机 `quarto --version` 对应版本的 quarto.org 官方文档为准，不要凭记忆写过时选项。

## 何时使用

- 用户要求把 `manuscript/` 下的 `.md`/`.qmd` 渲染为 PDF、docx 或 html
- 论文流水线中「渲染成稿」一步（简报会指向本技能）
- 渲染失败需要排查环境与依赖问题时

## 操作规范

### 1. 先确认环境

动手渲染前先跑：

```bash
quarto check
```

逐项确认 quarto、pandoc 与目标格式引擎（PDF 需要 tinytex 或其他 LaTeX 发行版）都就绪。任何一项缺失或版本异常，**先按第 3 节引导安装，再继续**——不要带病渲染。

### 2. 渲染命令与产物路径约定

```bash
quarto render manuscript/<稿件>.md --to pdf      # 或 .qmd / docx / html
```

- 渲染产物统一归入产物目录（如 `output/`），通过 `_quarto.yml` 的 `output-dir` 或命令行 `--output-dir` 指定；产物目录必须在 `.gitignore` 中，**产物不进 git**。
- 缺产物目录约定时，先在工作区根建立 `output/` 并补 `.gitignore`，再渲染。
- 源稿、`_quarto.yml`、`references.bib` 等源文件照常随 git 管理。

### 3. 缺失依赖的安装引导顺序

依赖缺失时按以下顺序引导（逐条执行，装完一条再验一条）：

1. quarto CLI 缺失 → 按官方安装包安装（macOS 可 `brew install quarto`），装后 `quarto --version` 验证。
2. pandoc 缺失 → quarto 通常自带；单独缺失时 `brew install pandoc`。
3. PDF 引擎缺失 → `quarto install tinytex`（优先 tinytex，轻量可自动补 LaTeX 包）；tinytex 不可用时再引导完整 TeX Live / MacTeX。

### 4. 常见报错处理

总原则：**环境/依赖类问题直接修**；**内容类问题（引用键、交叉引用、源稿语法）修源稿本身，不在命令行上加参数掩盖**；拿不准归属的标注后报告，不静默跳过。

- **YAML 头错**（解析失败、缩进错乱）：打开对应源稿修 YAML front matter 本身，不要在命令行上加参数掩盖。
- **引用键缺失**（`citation not found: @xxx`）：回 `references.bib` 补条目或改源稿中的引用键，**不得删除引用来消错**。
- **LaTeX 包缺失**（`! LaTeX Error: File 'xxx.sty' not found`）：用 `tlmgr install xxx`（tinytex）或让 tinytex 自动补装，**先装不绕路**——禁止删图表、改格式、去掉公式来回避报错。
- **中文缺字/豆腐块**（PDF 里中文乱码或方框）：用 `fc-list :lang=zh family` 找本机中文字体，在 YAML 设 `mainfont`/`CJKmainfont`；不要靠换引擎来回避。

### 5. 修复-验证闭环

每轮修复后完整重渲染，并比较报错数量：

- 变少 → 继续修剩余问题；
- 不变 → **禁止重复同一修法**，换思路排查；
- 变多 → 回滚本轮改动，再换方案；
- 最多 3 轮仍不干净 → 停止，带剩余错误摘要与已试方案报告，不硬试。

注意假阳性：交叉引用与引用类 warning 常在补跑完整渲染后自愈，只有重渲后仍在的才当真错处理；`citation not found` 是要回 `references.bib` 处理的真错。

### 6. 报错看不懂时拿更多信息

- `quarto render --verbose` 看详细过程；
- `keep-tex: true`（或 `--to latex`）留中间 .tex，定位 LaTeX 层问题；
- `--keep-md` 看中间 markdown。

### 7. 渲染成功后验收与登记

先验收，再登记：

- 产物文件存在且非零字节；
- 统计残留 undefined citation/reference 类 warning 条数，写进渲染说明。

验收通过后，建议用户经 **Ccode 改动面板「登记产物」** 把 PDF 记入工作区提货单（`artifacts.yaml`）——产物本体不进 git，清单随分支传给下一步。Agent 本身不直接改 `artifacts.yaml`。

## 产出格式

- **渲染产物**：产物目录下的 PDF/docx/html（路径明确、可打开）
- **渲染说明**（一句话级）：渲染命令、产物路径、警告摘要（`quarto check` 遗留警告、渲染 warning 条数与要点，含 undefined citation/reference 计数；无警告写明「无警告」）

## 完成标准

- 产物在产物目录且验收通过（存在、非零字节、残留 warning 已计数）；
- 渲染说明齐全（命令/路径/警告摘要）；
- 修复改动最小且可解释，不含任何删内容操作。
