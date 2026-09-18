---
name: zotero-sync
description: Zotero 文献库同步规范。当用户明确要求把检索结果写入 Zotero，或按需从 Zotero 导出项目文献时使用。内核 zotero_import 仍是只读进料口。Zotero 7–9 本地 /api/ 只读，进库走 RIS/BibTeX 原生导入（清单「同步到 Zotero」或拖文件），禁止 POST 假装写库。不可用时回落纯文件口径，不阻塞文献流程。
outputs: [papers/zotero-sync.md]
---

# Zotero 文献库同步（zotero-sync）

本技能是可选的项目 ↔ Zotero **规范与报告**，不是清单上的「同步到 Zotero」按钮。

- 按钮：打开 `papers/to-fetch.ris`，走 Zotero 原生导入（RIS/BibTeX/CSL JSON）。
- 内核「从 Zotero 导入」：只读 sqlite 快照进项目，绝不写回个人库。
- 本技能：检索/精读时盘点通道、产出 RIS、写 `papers/zotero-sync.md`。Word 插件插引用是 GUI 人工操作，不在本技能射程。

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

- 交付 `papers/to-fetch.ris`（RIS 2004，与 to-fetch.md 同序：TI/AU/PY/T2/DO/UR）。Zotero 原生导入 RIS/BibTeX/CSL JSON，不需要插件
- 告诉用户用清单「同步到 Zotero」或把 RIS 拖进 Zotero。不要另开一条 API/BBT 写库
- 不要代点按钮、不要循环导入。库里已有条目再导会重复——界面会按 DOI 提示
- **PDF：** 有全文的把 `papers/` 里的文件直接拖进 Zotero，客户端一般会按元数据对上已有条目。对不上再拖到那一条上。禁止声称 Mesa 已自动挂附件
- 未明确要求进库：只留 RIS，报告写明「未进库，文件已交」

### 2. 出库（Zotero → 项目，仅精读/用户明确要求时）

- 默认请用户用内核「从 Zotero 导入」（文献与数据）。检索步骤不得写 `references.bib`
- 不要默认调用 Better BibTeX `autoexport.add`，不得悄然修改用户 BBT 配置
- 已有 bib 键一律不改；与 lit-notes 冲突时保留既有键并在报告列出

### 3. 边界与报告

- 不删除、合并重复或批量改用户库
- 报告 `papers/zotero-sync.md`：模式（search/zotero/folder）、Zotero 是否在跑、进库方式（按钮/拖 RIS/未进库）、RIS 路径、未挂 PDF 的说明、键冲突

## 完成标准

检测结果记录在案；未要求进库或写不了时交付 RIS 并如实报告；检索步骤不写 `references.bib`；已有 bib 不覆盖、不改键；不把只读 API 或未装插件写成故障。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：Zotero 原生导入格式（RIS/BibTeX/CSL JSON）与官方本地 API 只读边界。方法与参数必须先对实机。
