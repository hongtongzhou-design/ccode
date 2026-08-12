---
name: quarto-render
description: Quarto 稿件渲染规范。当用户要求把 manuscript/*.qmd 渲染为 PDF/docx/html，或论文流水线中「渲染成稿」一步时使用。先 quarto check 确认环境，渲染产物写入产物目录（不进 git），缺依赖按序引导安装，报错先装依赖不绕路，渲染成功后在 Ccode 改动面板「登记产物」记入提货单。
---

# Quarto 稿件渲染

本技能规定 `manuscript/*.qmd` 渲染成稿的操作规范与产出格式。渲染产物（PDF/docx/html）体积大且可再生，**一律写入产物目录、不进 git**；git 里只保留 `.qmd` 源稿与配置。

## 何时使用

- 用户要求把 `manuscript/*.qmd` 渲染为 PDF、docx 或 html
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
quarto render manuscript/<稿件>.qmd --to pdf      # 或 docx / html
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

- **YAML 头错**（解析失败、缩进错乱）：打开对应 `.qmd` 修 YAML front matter 本身，不要在命令行上加参数掩盖。
- **引用键缺失**（`citation not found: @xxx`）：回 `references.bib` 补条目或改 `.qmd` 中的引用键，**不得删除引用来消错**。
- **LaTeX 包缺失**（`! LaTeX Error: File 'xxx.sty' not found`）：用 `tlmgr install xxx`（tinytex）或让 tinytex 自动补装，**先装不绕路**——禁止删图表、改格式、去掉公式来回避报错。

### 5. 渲染成功后登记产物

渲染成功、产物确认可打开后，建议用户经 **Ccode 改动面板「登记产物」** 把 PDF 记入工作区提货单（`artifacts.yaml`）——产物本体不进 git，清单随分支传给下一步。Agent 本身不直接改 `artifacts.yaml`。

## 产出格式

- **渲染产物**：产物目录下的 PDF/docx/html（路径明确、可打开）
- **渲染说明**（一句话级）：渲染命令、产物路径、警告摘要（`quarto check` 遗留警告、渲染 warning 条数与要点；无警告写明「无警告」）
