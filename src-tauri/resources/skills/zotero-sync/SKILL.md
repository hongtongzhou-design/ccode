---
name: zotero-sync
description: Zotero 文献库同步规范。当用户明确要求把检索结果写入 Zotero，或按需从 Zotero 导出项目文献时使用。内核 zotero_import 仍是只读进料口。Zotero 7–9 本地 /api/ 只读，进库走 RIS/BibTeX 原生导入（清单「同步到 Zotero」或拖文件），禁止 POST 假装写库。不可用时回落纯文件口径，不阻塞文献流程。
outputs: [papers/zotero-sync.md]
---

# Zotero 文献库同步（zotero-sync）

本技能是可选的项目 ↔ Zotero **规范与报告**，不是清单上的「同步到 Zotero」按钮。

- 按钮：打开 `papers/to-fetch.ris`，走 Zotero 原生导入（RIS/BibTeX/CSL JSON）。
- 内核「从 Zotero 导入」：只读 sqlite 快照进项目，绝不写回个人库。
- 本技能：检索时盘点已有库，定稿时把 `[@键]` 写成 Zotero 能扫描的 RTF。不点 Zotero 的 Word 插件。

## 何时使用

- `lit_source = zotero`：用户已用内核「从 Zotero 导入」把库落到项目；本技能只盘点并补检索缺口，禁止覆盖已有 `references.bib`
- `lit_source = search`（默认）：Zotero 仅是可选导出目标；用户未明确要求进库时只交付文件
- `lit_source = folder`：只处理项目文件，禁止访问或写入 Zotero
- 用户明确要求把清单写入 Zotero

## 前置检测（开工先做）

- 探活：`curl -i --max-time 3 http://127.0.0.1:23119/api/users/0/items?limit=1`（不要用 `/api` 根路径，无尾斜杠会 404）
- 连接失败 = Zotero 未运行；HTTP 403 = 未开本机通信。两者都不得假装已写库
- GET 通不等于能写。Zotero 7–9 的 `/api/` **只读**（POST 回纯文本 `Endpoint does not support method`）。**禁止 POST `/api/users/0/items`**，禁止对着非 JSON 正文 `.json()`
- Better BibTeX 不是进库前提，也挂不了 PDF。未装不得当成失败
- **回落口径**：通道不可用或用户未要求进库时，只产出 `papers/to-fetch.ris` 等文件；这是正常分支，不是失败

## 操作规范

### 1. 进库（项目 → Zotero，必须用户明确要求）

- 交付 `papers/to-fetch.ris`（RIS 2004，CRLF，与 to-fetch.md 同序）。字段与 EndNote 的 `papers/endnote-import.ris` 同一套：一位作者一条 `AU`（`姓, 名`），有数据才写 `TI`、`T2` 期刊全称、`J2` 缩写、`PY`、`DA` 日期、`ET` 网络出版日期、`VL` 卷、`IS` 期、`SP` 页、`M2` 起始页码、`EP` 结束页、`M3` 文章类型、`SN` ISSN、`DO`、`KW`、`AB` 摘要、`UR`。检索时一次查全，含当时还在待确认的篇目；人纳入后追加，不再另查。Zotero 原生导入 RIS/BibTeX/CSL JSON，不需要插件
- 告诉用户用清单「同步到 Zotero」或把 RIS 拖进 Zotero。不要另开一条 API/BBT 写库
- 不要代点按钮、不要循环导入。库里已有条目再导会重复——界面会按 DOI 提示
- **PDF：** 用户不用 Zotero 时，不要要求把 PDF 拖进 Zotero。题录由检索/精读按 PDF 里的 DOI 写入 `references.bib`。用户自己在用 Zotero、且库里还没有这些篇时，可以把 `papers/` 的 PDF 拖进 Zotero：确认「自动检索 PDF 元数据」开着、「自动重命名附件文件」关着，它会读前几页并生成父条目。拖完再用「从 Zotero 导入」。已有条目时，拖进去一般会按元数据对上；对不上再拖到那一条上。禁止声称 Mesa 已自动建条目或挂附件。
- 未明确要求进库：只留 RIS，报告写明「未进库，文件已交」

### 2. 出库（Zotero → 项目，仅精读/用户明确要求时）

- 默认请用户用内核「从 Zotero 导入」（文献与数据）。检索步骤不得写 `references.bib`
- 不要默认调用 Better BibTeX `autoexport.add`，不得悄然修改用户 BBT 配置
- 已有 bib 键一律不改；与 lit-notes 冲突时保留既有键并在报告列出

### 3. 定稿交稿（与 EndNote 域稿同一位置）

项目设置「文献库」选了 Zotero，并且这一步是定稿或期刊格式时：

```bash
python3 <技能目录>/scripts/zotero_rtf.py --input manuscript/review-final.md --bib references.bib --rtf output/zotero.rtf --ris papers/zotero-import.ris --report papers/zotero-cite-report.md
```

科研论文改 `manuscript/paper-final.md`，学位论文用 `manuscript/thesis-final.md`，期刊格式用 `submission/formatted.md`。

未匹配的 `[@键]` 不写 rtf。人先把 `papers/zotero-import.ris` 拖进 Zotero（库里已有就跳过），再对 `output/zotero.rtf` 做一次 **RTF Scan**，然后在 Zotero 里换引用样式。不点插件，不生成 EndNote 域。

### 4. 边界与报告

- 不删除、合并重复或批量改用户库
- 报告 `papers/zotero-sync.md`：模式（search/zotero/folder）、Zotero 是否在跑、进库方式（按钮/拖 RIS/未进库）、RIS 路径、未挂 PDF 的说明、键冲突

## 完成标准

检测结果记录在案；未要求进库或写不了时交付 RIS 并如实报告；检索步骤不写 `references.bib`；已有 bib 不覆盖、不改键；不把只读 API 或未装插件写成故障。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：Zotero 原生导入格式（RIS/BibTeX/CSL JSON）与官方本地 API 只读边界。方法与参数必须先对实机。
