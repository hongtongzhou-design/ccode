---
name: zotero-sync
description: Zotero 文献库同步规范。当用户要求把检索/筛选结果导入 Zotero 库、从 Zotero 同步 references.bib、给库条目挂 PDF 附件，或文献流水线（检索/精读步骤）需要在 Zotero 与项目文件之间往返时使用。经 Zotero 桌面端本地 API（localhost:23119）与 Better BibTeX 的 JSON-RPC 直连，无需 MCP；Zotero 未运行或未装 Better BibTeX 时回落纯文件口径（产出 RIS/bib 供人工导入），不报错不阻塞。
inputs: [papers/included.md, papers/to-fetch.md]
outputs: [references.bib]
---

# Zotero 文献库同步（zotero-sync）

本技能规定「项目文献文件 ⇄ Zotero 库」的同步通道：agent 经本机 HTTP 接口直接读写 Zotero，让「检索命中 → 进库 → references.bib 自动最新」整条链不需要人手工导入导出。Word 插件插引用是 GUI 人工操作，不在本技能射程。

## 何时使用

- 流水线文献检索/精读步骤：included.md、to-fetch.ris 进库，references.bib 保持最新
- 用户要求查/加/改 Zotero 库条目、挂附件、导出指定 collection 的 bib
- 用户不用 Zotero（用 EndNote 或纯文件）时不要主动启用；EndNote 场景见 endnote-bridge

## 前置检测（开工先做）

- 探活：`curl -s http://127.0.0.1:23119/api/users/me`——不通 = Zotero 未运行，回落纯文件口径
- Better BibTeX：`POST http://127.0.0.1:23119/better-bibtex/json-rpc`，body `{"jsonrpc":"2.0","method":"user.groups","id":1}`——
  不通 = 未装 BBT，只能走 Zotero 本地 API（读免鉴权；Zotero 8+ 写请求需用户事先授予 local API key）
- JSON-RPC 方法名与参数以实机 BBT 版本为准（官方方法表：retorque.re/zotero-better-bibtex/exporting/json-rpc/），
  动手前先核对实装版本，不凭记忆拼参数
- **回落口径**：任一检测不过时，按 lit-search 原路径产出 RIS/bib 文件，并在报告注明「Zotero 通道未启用，产物请人工导入」——这是正常分支，不是失败

## 操作规范

### 1. 进库（项目 → Zotero）

- 来源：`papers/included.md` 纳入清单、`papers/to-fetch.md`/`to-fetch.ris` 付费墙待获取清单
- **查重先行**：每条先按 DOI（无 DOI 按标题）经 `item.search` 查库，已在库的不重复建，只在报告标注「已在库」
- 建条目：优先 BBT `item.import`（从 RIS/BibTeX 文件导入）；不可用时走本地 API 建 item JSON；字段缺则留空，不编造
- 附件：`papers/` 已有 PDF 挂到对应条目（本地 API attachment 或 BBT `item.attachments` 口径）
- 付费墙条目归入一个固定 collection（如「待获取全文」），便于用户后续人工补全文
- **批量写先报数**：入库条目 >20 条时先把「共 N 条待进库、其中 M 条已在库」写进 .ccode/help-wanted.md 报数
  （附兜底：未回复按全量执行），不停工

### 2. 出库（Zotero → 项目）

- 首选 BBT 自动导出：配置一次 autoexport（`autoexport.add`，路径 = 项目根 `references.bib`，translator 用 biblatex/bibtex 按项目口径），之后库变更自动落盘
- 一次性导出：BBT `item.export` 或 pull export（`curl http://127.0.0.1:23119/better-bibtex/export/...`），结果写 references.bib
- **键口径（写死）**：新条目用 BBT citation key；references.bib 中已存在条目的键**一律不改**（正文 [@键] 引用靠它，改键 = 断链）；与 lit-notes 手工键冲突时保留既有键，新键在条目注释注明
- 导出后对照项目正文引用跑一次键解析自查（bib-check 口径），断键立即报告

### 3. 边界

- Word/LibreOffice 里插入与刷新引用走 Zotero 官方插件，**是人工 GUI 操作**；本技能不做无人值守插 Word
- Zotero 库是用户的库：删除、合并重复、批量改字段这类破坏性/大批量操作不自动做，先列清单经 help-wanted.md 问用户
- 库里条目的笔记/标签体系不动；只按本技能声明的范围读写

## 产出格式

- `references.bib`：经 BBT 导出/合并的最新版本，键口径如 §2
- 同步报告（写入当前步骤报告或 `papers/zotero-sync.md`）：通道状态（本地 API / BBT 可用性）、进库 N 条（新建/已在库分列）、
  附件挂接计数、出库键冲突处理清单、回落原因（如有）

## 完成标准

通道检测结果记录在案；进库条目逐条有「新建/已在库/失败+原因」结论；references.bib 键解析自查通过；
无静默覆盖、无重复条目；通道不可用时已按回落口径交付等价的 RIS/bib 文件。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：Zotero 官方本地 API（zotero.org/support/dev/web_api/v3/basics，桌面端 127.0.0.1:23119）、Better BibTeX 官方文档
（retorque.re/zotero-better-bibtex/：JSON-RPC 方法表、pull export、自动导出）。内容为按 Ccode 科研工作流编写。
