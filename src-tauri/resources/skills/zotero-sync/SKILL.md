---
name: zotero-sync
description: Zotero 文献库同步规范。当用户明确要求把检索结果写入 Zotero，或按需从 Zotero 导出项目文献时使用。内核 zotero_import 仍是只读进料口；本技能的写库通道必须有用户意图并通过实机授权探测。不可用时回落纯文件口径，不阻塞文献流程。
outputs: [papers/zotero-sync.md]
---

# Zotero 文献库同步（zotero-sync）

本技能是可选的项目 ↔ Zotero 通道。内核的 `zotero_import` 只读 `zotero.sqlite` 快照并写入项目，绝不写回个人库；本技能才允许写库，但必须有用户明确意图。Word 插件插引用是 GUI 人工操作，不在本技能射程。

## 何时使用

- `lit_source = zotero`：用户已用内核「从 Zotero 导入」把库落到项目；本技能只盘点并补检索缺口，禁止覆盖已有 `references.bib`
- `lit_source = search`（默认）：Zotero 仅是可选导出目标；未开、未授权或用户未明确要求时只交付文件
- `lit_source = folder`：只处理项目文件，禁止访问或写入 Zotero
- 用户明确要求把清单、PDF 或指定 collection 写入 Zotero

## 前置检测（开工先做）

- 探活：`curl -i --max-time 3 http://127.0.0.1:23119/api/`；连接失败 = 未运行，HTTP 403 = 本机通信未开启（读取与写入授权分开），两者都不得直接写库
- 官方本地用户路径用 `/api/users/0/items` 或真实数字 ID；不使用 users/me。读取可用不等于写入可用；Zotero 10+ 的本地写入需 `/api/local/authorize` 用户确认，本机较旧版本不得照搬该流程。
- Better BibTeX：向 `/better-bibtex/json-rpc` 发送 `user.groups` 探测；方法名、参数和写入能力以实机版本及官方方法表为准，不凭记忆拼参数
- 未取得写入授权时只读或导出；不得把“本地 API 可探活”误判为“可以写库”。写入前记录用户意图、授权状态和拟写入条数
- **回落口径**：`lit_source = search` 下通道不可用或用户未授权时，只产出 `papers/to-fetch.ris` 等文件；这是正常分支，不是失败

## 操作规范

### 1. 进库（项目 → Zotero，必须用户明确要求）

- 来源：`papers/included.md`、`papers/to-fetch.md`/`papers/to-fetch.ris`；每条先按 DOI（无 DOI 按标题）查重
- 优先 BBT `item.import`；不可用时按实机 API 口径建 item。已在库的不重复建，逐条报告「已在库」
- `papers/` 已有 PDF 才挂附件；付费墙条目可归入用户确认的「待获取全文」collection
- 逐批在 `.ccode/help-wanted.md` 列条目、collection、附件及拟写操作，取得该批明确确认后才写；未回复只导出文件，不执行写库

### 2. 出库（Zotero → 项目，仅精读/用户明确要求时）

- 默认使用一次性 BBT `item.export` 或 pull export；**不要默认调用 `autoexport.add`**，不得悄然修改用户 BBT 配置
- 只有用户明确要求持续自动导出时，才说明会持久修改 BBT 配置并获得确认
- 出库结果写 `references.bib` 仅限精读步骤/用户明确要求；检索步骤不得写它
- 已有 bib 键一律不改；与 lit-notes 冲突时保留既有键并在报告列出

### 3. 边界与报告

- 不删除、合并重复或批量改用户库；先列清单并经用户确认
- 报告 `papers/zotero-sync.md`：模式、API/BBT/授权状态、进库新建/已在库/失败、附件计数、回落原因与键冲突

## 完成标准

检测结果记录在案；进库条目逐条有结论；检索步骤不写 `references.bib`；已有 bib 不覆盖、不改键；通道不可用时交付 RIS/BibTeX 文件。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：Zotero 官方本地 API与 Better BibTeX 官方文档。方法与参数必须先对实机。
