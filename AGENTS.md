# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（硬约束、本机环境档案）或对应
> `docs/conventions/*.md` 主题文件，以及 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是
> 操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：功能增改时必须同步更新 `docs/user-guide.md`（用户操作手册）；发版本时同步更新 `CHANGELOG.md`（版本更新日志）。

> **跨平台换行约定**：仓库文本文件统一以 LF 形式存储，规则见 `.gitattributes`。Windows 本地可保留
> `core.autocrlf=true`，但提交前不得把换行转换造成的全文件差异带入变更。

## 项目简介

Ccode 是一个「AI 科研工作台」桌面应用（Tauri v2 + React/TS）——底层是九个 Agent CLI 的统一控制台（启动器 + 配置中心 +
会话监控台），表面是科研流水线（读文献→整数据→做图→写论文）：AI 负责干活，Ccode 负责管活，人负责拍板。
为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI、Grok Build 管理多套 API 配置
（端点/密钥/模型），内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

**设计文档即规格**：改架构/适配逻辑前先读 `docs/architecture.md`（总体设计）和 `docs/agent-integration-matrix.md`
（九个 CLI 的 env/配置/会话格式，源码级调研结论，勿凭印象写 env 变量名）。

**参考实现（长期有效）**：`.reference/` 下三个开源项目浅克隆，实现新功能前先查有没有成熟方案可借鉴：

- `.reference/cc-switch`（Tauri2+React+SQLite）：provider 预设/一键导入、双向同步回写保护、本地代理与故障转移、原子写入、测速、托盘速切、导入导出
- `.reference/waveterm`（Electron+Go+SQLite）：block/workspace 对象模型与持久化、"named = saved" 留存语义、badge 注意力标记与 hooks 联动、滚动缓冲区序列化恢复、namespaced meta 键体系
- `.reference/vscode`（blobless 浅克隆）：Explorer 文件树、编辑器 tab 与 split、面板布局、终端标签列表；目录索引在 `src/vs/workbench/contrib/`

借鉴原则：学机制和取舍，不抄代码；冲突时以 `docs/architecture.md` 为准（不走本地代理主线、会话解析坚持只读）。镜像可随时 `git -C .reference/<repo> pull` 更新。

**已确认的产品决策**（用户拍板，勿擅自更改）：

- 应用名 **Ccode**；九个 agent 全部支持（CodeBuddy Code、Cursor CLI、Grok Build 见 matrix §7/§8/§9；grok 首版：「设为全局默认」不支持、MCP 只读不分发、技能强制 copy）
- 配置切换**双模式**：默认启动注入环境变量（零污染），另提供「设为全局默认」（写配置文件，先备份）
- 终端为内嵌形态，且**与结构化会话视图联动**（同一会话双栏观看）
- 项目列表**从各 agent 历史会话自动聚合并分类**，辅以手动添加
- token/费用统计随 P3 顺带做，不提前
- **三平台（macOS/Windows/Linux）同步**支持，功能不得以平台为由裁剪

## 构建与运行

```bash
# Rust 不在默认 PATH，每个新 shell 都要先 export
export PATH="$HOME/.cargo/bin:$PATH"

npm run tauri:dev      # 开发（独立 Ccode Dev 窗口；前端 HMR + Rust 改动自动重启）
npm run build          # 前端构建（tsc + vite）
npm test               # 前端测试（node --test，CI test job 同步执行）
cd src-tauri && cargo build / cargo test
npm run tauri build    # 打包
```

环境：Node 22 + npm（无 pnpm）；Rust stable（minimal profile）；crates 走 rsproxy 镜像（`~/.cargo/config.toml`）。

开发预览必须使用 `npm run tauri:dev`：独立产品名 **Ccode Dev**、窗口标题 **Ccode Dev - 热更新**、bundle ID
`com.ccode.dev.hmr`（`src-tauri/tauri.dev.conf.json`）。界面验证必须按该窗口标题或明确 `.app` 绝对路径定位，禁止用模糊应用名 `Ccode`。
**界面核验不得混入旧打包前端**：`/Applications/Ccode.app`、`target/release`、普通 `com.ccode.dev` 与历史 `target/debug/bundle`
均不可作为验收依据；只能验收 `tauri dev --config src-tauri/tauri.dev.conf.json` 启动、连接 17575 的热更新窗口。无法唯一确认窗口归属时停止界面操作，改报“未验收”，不得拿旧窗口截图或状态代替。

## 本机环境档案（踩坑记录，新会话必读）

- **网络：访问 GitHub/raw/formulae.brew.sh 很慢**。必须用镜像：crates → rsproxy（已配）；rustup → TUNA；brew → `HOMEBREW_API_DOMAIN`/`HOMEBREW_BOTTLE_DOMAIN` 指 TUNA（已在 updater.rs 内置）；npm 如变慢 → `registry.npmmirror.com`。
- **brew 异常先 `brew doctor`**，别先怀疑应用代码。
- **macOS 钥匙串对未签名开发构建会因 cdhash 失配丢条目**——密钥存储弃用钥匙串，改 0600 `keys.json`（勿改回）。
- **管道输出块缓冲**：brew/npm 检测到非 TTY 会块缓冲导致"无输出"假象——安装/更新命令必须在 PTY 里跑（别退回管道）。
- **GUI 应用 PATH 很短**：打包应用可能找不到 npm 装的 CLI（开发模式不受影响）；统一经 `agents::resolve_binary` 候选目录兜底解析。
- **Windows 正式版没有父控制台**：后台 `git/cmd/netstat/tasklist/CLI --version` 等若直接 `Command::new` 会反复创建
  `conhost.exe` 闪窗；所有不需要独立可见窗口的命令必须走 `process::background_command`，统一加 `CREATE_NO_WINDOW`
  并在 spawn/wait 边界登记脱敏参数与生命周期。该包装和 250ms 进程扫描只在 Windows 生效；macOS/Linux 直接返回标准
  `Command`、不启动诊断监控线程。只有用户明确打开的外部终端允许保留可见窗口。
  Windows 外部终端由设置页二选一：`cmd`（默认）走 `start cmd.exe /K <binary> <args>`，密钥在父进程
  环境块经 start 继承，不经 PowerShell；`powershell` 走 `start powershell.exe -NoExit -File wrapper`。
  复合 start 行必须 `raw_arg` 直投。启动热路径禁止同步跑 icacls。
- **本机 CLI 安装情况**：claude/codex/gemini/qwen/opencode/codebuddy 均已装（brew 或 npm，检测见 updater.rs 报告）；kimi 为新版（~/.kimi-code）。
- **Windows npm 系 CLI 是 .cmd 批处理 shim**：CreateProcess/ConPTY 直接起报 os error 193；同目录还有同名无扩展名
  shell 脚本，`find_in_dirs` 必须 exe/cmd 优先于裸名（裸名只兜底）。且 ConPTY 里 npm 会发 DSR 光标位置查询
  （ESC[6n）并读 stdin 等回答，无人应答永久挂起——`run_streaming_pty` 的 reader 代答 ESC[24;120R。
  shim 深化（解析 JS 入口改 node 直启）统一在 `process.rs`：`pty_command`（PTY）与 `background_command`（后台）
  双入口同一口径，npm.cmd 自身走固定布局 special case。
- **Windows PDF 预览白屏**：WebView2 + 全局 `color-scheme:dark` 下，pdf.js 默认不透明 2d canvas 与
  `.textLayer { color-scheme:only light }` 会合成整页白块；经典滚动条改 clientWidth 再叠加
  `key={renderKey}` 会拆掉 canvas 振荡闪白。渲染前必须先绑 `alpha:true` 上下文，页宿主锁定 light
  color-scheme，适配宽度走 `nextFitScale` + `scrollbar-gutter: stable`，Windows 关掉 ImageDecoder。
  细则见 `docs/conventions/terminal.md`，勿退回 `page.render({ canvas })` 不预绑上下文、勿把
  ResizeObserver 当强制重挂信号。
- **dev 端口为 17575**（`vite.config.ts` + `tauri.conf.json` devUrl 两处同步；勿改回 1420——Codex 桌面版 NetworkService 占用）。vite 撞已占端口静默退出；**stdin EOF 也自杀**——后台拉起必须 `tail -f /dev/null | npm run tauri:dev`。
  **agent 不得自行改端口、加 `--port`/`--strictPort` 参数或另起配置外的 dev 实例**；17575 被占时先报出占用方（Windows 用
  `netstat -ano | findstr :17575`）交用户处理，不静默换端口。
  **双 clone 并行开发的第二实例**：已入库 `src-tauri/tauri.dev.17576.conf.json`（`npm run tauri:dev:17576`，devUrl
  127.0.0.1:17576，窗口标题带「 :17576」后缀；identifier 与主实例相同、共享配置目录）。验收三锚点缺一不可：
  用户指定的**仓库路径**（两个 clone 内容相同，开工先 `git rev-parse --show-toplevel` 自报并与用户指定路径对照）+
  **窗口标题**（17575 实例 = 「Ccode Dev - 热更新」，17576 实例 = 「Ccode Dev - 热更新 :17576」）+ **devUrl 端口**。
  用户指定了哪个实例就只核验哪个，其余窗口不算数；还要第三实例时照此加 conf 文件（端口连续顺延），不即兴改配置。
- **git 提交**：常规提交加 `[skip ci]`，里程碑提交才跑三平台 CI。
- **git 分支纪律**：未经用户明确指令，禁止 checkout/switch/merge/rebase/stash/删分支等任何改动 HEAD 或分支指向的操作；
  开工先 `git branch --show-current` 确认在用户指定的分支上，不符就停下报告，不自行切换；任务收尾报告分支名 + `git status` 结果。
- **git 推送走 SSH:443 + repo deploy key**；发版推 tag 后先用 `gh run list --workflow build.yml` 确认是否已产生该 tag 的 push run，已触发则只保留该 run；30 秒内未触发才执行 `gh api repos/hongtongzhou-design/ccode/actions/workflows/build.yml/dispatches -f ref=<tag>`。禁止让 tag push 与 workflow_dispatch 两个打包 run 并行写同一 Release。workflow 已配 `permissions: contents: write`（tauri-action 建 Release 草稿必需）。**仓库 owner 与 tauri.conf 升级端点绑定**（同为 `hongtongzhou-design/ccode`）：仓库若转移，本命令、updater endpoint、README 链接三处必须同步改。
- **CI 测试**：禁墙钟时序硬断言（runner 调度延迟不可控；只留内容语义断言 + 防挂死宽松兜底）；unix 专属语义（symlink/PTY/脚本）测试加 `#[cfg(unix)]`；路径断言用 `Path::ends_with`（Windows `\`）。

## 代码结构

```
docs/                        # 架构方案 + 九 CLI 适配参考（规格）
  conventions/               # 主题化约定细则（改动对应领域前必读，见「关键约定」索引）
src/                         # 前端 React + TS + Tailwind v4（vite 插件接入）
  pages/                     # 八页：配置⇄ 项目⛁（workspaces，v3.92 起 UI 页名「项目」） 终端⌨ 对话◔ 技能✦ MCP⌗ 统计◫ 设置⛭
  components/                # WorkspaceReviewView、PipelineEditor（含「＋ 从模板追加」）、ProjectGroup/ProjectRail、ArtifactChecklist（文本类产物就地预览层 +
                             # md 笔记「⛶ 沉浸阅读」入口（v3.98：pdf_for_note 配对后发 readerReq 带 notePath 进阅读区）+
                             # ⠿ 拖出手柄经 tauri-plugin-drag 做 OS 级文件拖出——WebView HTML5 拖拽出不了窗口）、TaskCardsSection、FileTree、
                             # FilePreviewEditor、PdfPreview/DocxPreview/ImagePairView、GitPanel、HandoffPicker/DigestPicker、
                             # KickoffConfirmDialog（开工确认弹层：TASK.md 预览/编辑（草稿优先）+ 旧简报并入兜底 + 技能区（含 MCP 归处标记）+ 人工事项区 + 主仓提醒 +
                             # 上一步收尾软门：紧邻上一步非可选 after 事项未勾 → 「确认开始」二击变「仍要开工」才开，只确认不阻断）、
                             # StepSkillsChips（步骤推荐技能 chip 区：只读/可编辑两态 + 产物冲突/跨步骤链路 ⚠ 警告行）、
                             # HumanTasksList（人工事项清单 + useHumanTasks 共享逻辑）、StepFlow（步骤内协同流程线）、
                             # ScheduleSection（项目分组「◔ 定时任务」区块）、
                             # LitWatchCard（「◔ 文献雷达」卡片：新命中/精读清单双页签 + 近 8 周趋势 + →精读/◈解读/↓全文 +
                             #   期刊徽章（IF/中科院分区/TOP，数据源 journal_metrics.rs）+ 新命中按日期/按关键词分组切换 +
                             #   卡头期刊指标表入口常驻（未装=↓下载 / 已装=↻重下即更新）+ 卡头「筛选」弹层
                             #   （litWatchFilter：IF/分区/TOP 三条件，被筛掉条目「查看全部」临时态），挂项目详情工作段 TaskCardsSection 之后）、
                             # ReaderOverlay（沉浸阅读区全屏覆盖层，v3.96：三栏「笔记｜PDF｜Agent 终端」，fixed inset-0 z-40，
                             #   Esc 退出级联最优先，底下终端/PTY 保持挂载；右栏 = 阅读会话标签 xterm 宿主搬移，注入由 TerminalPage 供给）+
                             #   PdfContinuousView（连续滚动 PDF 栏：±2 页虚拟化懒渲染、选段浮动条（译/◈问 AI/＋生词/⋯）、▦ 圈选截图、
                             #   ⌘+点击段落对照（结果进同款浮卡）、进度记忆/护眼反色/术语淡高亮）、
                             # TemplatePickModal（注册成功后的研究流程模板选择层：五套内置模板 +
                             # 「不使用研究流程」（写 pipeline_opt_out 标记）/「稍后再选」（不留痕）两出口）、
                             # FuseDraftModal（「◈ 融合进任务书」预览编辑弹层：AI 融合稿可改后确认才写草稿）、
                             # TerminalStatusBar（终端底部常驻状态栏：模型/思考档可点切 + 📂 胶囊浮层改目录（仅未启动）+
                             #   git 芯片/保存/推送 + 状态点/时长/本会话 token，吸收旧中带底条） 等
  components/CommandPalette.tsx # ⌘K 面板
  components/QuickChatHistoryMenu.tsx # 侧栏「快速开聊」右键的随手聊历史浮层（命令面板式行：色点+标题+时间；
                             # 勾了「下次直接开聊」的用户左键直达终端看不到弹层历史，右键是回看口）
                             # 行样式与弹层「随手聊历史」一致：品牌胶囊 + 标题 + 归属 · 时间
  components/GatewayLibrary.tsx # 连接页网关库：五槽/密钥/获取模型/按槽体检/逐模型策略三态
  components/HoverTip.tsx      # 应用内 tooltip 共享件（v3.93 提取自 ProjectGroup）：useHoverTip + HoverTip，
                             # portal 到 body（免疫祖先 opacity/transform 的 fixed 包含块问题）、滚动/缩放即关、
                             # up 参数支持锚点上方弹出（行内动作栏 tooltip 专用）；PageFrame 的 RowAction 内置上方 tooltip
  pipeline-presets.ts        # 内置流水线模板 PIPELINE_TEMPLATES（六套，含 v3.97「LaTeX 论文」）
  pipeline-start.ts          # 一键开步共享链路（renderTaskMd/gatherTaskMdExtras 单一出处，弹层预览与落盘共用）；
                             # 工作区→终端交接单一出处 buildWorkspaceTerminalRequest（reuseKey 找回同工作区标签 +
                             # 无 prompt 时 resume 最近会话）
  workspace-resume.ts        # 「去终端」resume 挑选纯逻辑（workspace 名 + 仓库路径匹配，排除归档/内部/live，
                             # tests/workspace-resume.test.ts）
  presets.ts                 # Base URL 供应商预设表（加供应商 = 加一行）
  mcp-presets.ts             # MCP 内置预设表（加预设 = 加一条；密钥一律 ${VAR} 引用）
  mcp-display.ts             # MCP 页展示纯逻辑：协议徽章固定识别色（stdio 紫/remote 蓝）+ 命令路径智能缩略
                             # （家目录折 ~、段数>3 且 >28 字符才砍中段留首尾，tests/mcp-display.test.ts）
  run-overview.ts            # 运行中聚合视图纯逻辑（按「要你管」排序）
  lit-watch.ts               # 文献雷达纯逻辑：日分组/关键词分组（groupEntriesByKeyword，取 keywordsHit 首词、
                             # 未分类恒末）/趋势/直链转换/全文可得性分流（fulltextLinkFor：arxiv abs 与 .pdf 直链=可下载，
                             # DOI/落地页=来源，不再摆禁用下载钮）/已读判定/漂移提醒/雷达筛选（entryPassesFilter
                             # 与 lit_watch.rs 双端镜像，指标未知放行不误伤，tests/lit-watch.test.ts）
  reader.ts                  # 沉浸阅读区纯逻辑：分栏钳制与像素换算/圈选命中与 canvas 映射/截图注入格式/
                             # glossary 表格契约（与 reader.rs 双端镜像，改动需同步）/段落边界提取/术语匹配/
                             # 进度与护眼存储键/翻译面板高度键（readerSplitT，未拖过不落键 = 内容自适应）/
                             # PDF 适配宽度 nextFitScale（亚像素门槛，防滚动条槽振荡闪白，
                             # tests/reader.test.ts）
  md-math.ts                 # md 阅读版式公式渲染（批次 E）：marked 扩展按 Pandoc 口径切分 $/$$
                             # （边界规则/转义/代码块不渲染/货币不误判）+ renderMathInto 懒加载
                             # katex+CSS（独立 chunk 不进主包，失败回落原文，tests/md-math.test.ts 25 例）
  task-cards.ts              # 任务卡纯逻辑：按步骤分桶/卡片排序/会话按卡分组/卡片 kind（idea 想法卡 / draft 讨论卡）过滤
                             # （tests/task-cards.test.ts）
  step-flow.ts               # 步骤内协同流程线纯逻辑：种子→before→agent→during→after→评审节点链
                             # （v3.97 起 after 档一律进主干，可选项带徽标但不抢当前节点；tests/step-flow.test.ts）
  skill-conflicts.ts         # 技能接口对账纯逻辑：产物冲突（skillOutputConflicts，outputs 两两相交）+
                             # 跨步骤链路（skillChainWarnings：inputs 找供给/outputs 对账预期产物，
                             # 支持 * 通配与目录/文件互含，推断接口打标；tests/skill-conflicts.test.ts）
  schedule-tasks.ts          # 定时任务纯逻辑：周期白话/相对时间/按 projectRoot 过滤（tests/schedule-tasks.test.ts）
  schedule-skill.ts          # 定时巡检「技能」下拉与默认任务名跟随纯逻辑（lit-watch 恒最前/默认「文献雷达」、
                             # 手改不覆盖、空库兜底，tests/schedule-skill.test.ts）
  inbox.ts                   # 收件箱分类胶囊纯逻辑：key 前缀→类别、分组、help dismiss 签名、人工请求通知 edge-trigger（tests/inbox.test.ts）
  notify.ts                  # 长任务 OS 通知（仅「待确认」跃迁 + 未聚焦 + 30s 去抖；「已回复」不通知）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑
  file-icons.ts              # 文件类型小徽标纯逻辑：扩展名 → 短标签 + 固定识别色（tests/file-icons.test.ts）
  editor-languages.ts        # monaco 语言注册（批次 E）：monaco-editor 0.56 ESM 不带 latex，
                             # 自带紧凑 Monarch 定义覆盖 .tex/.sty/.cls/.bib（tests/editor-languages.test.ts）
  workspace-visibility.ts    # 聚焦步骤工作区可见性过滤纯逻辑（不匹配任何步骤的手动工作区始终可见，
                             # tests/workspace-visibility.test.ts）
  git-commit-message.ts      # 空提交信息的本地默认信息生成
  terminal-input.ts          # 终端输入侧纯逻辑：shell 路径转义 escapeShellPath、拖入多路径拼接 joinDroppedPaths、
                             # 剪贴板图片条目判定/MIME→扩展名/粘贴反馈文案（tests/terminal-input.test.ts）
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  tab-drag.ts                # 标签条拖拽排序纯逻辑：位移钳制 + 目标槽位判定（>= 中线守末槽边界，
                             # tests/tab-drag.test.ts）
  terminal-palettes.ts       # 终端调色板共享表（设置页与终端同源）：四套深色 + 四套配对浅色 twin，
                             # ANSI 16 色 + 光标 + 选区全在表内；resolvePaletteId 按主题亮暗自动换 twin
                             # （新增调色板须同步 settings.rs KNOWN_PALETTES，否则被静默丢弃，tests/terminal-palettes.test.ts）
  upstream-note.ts           # brew 最新但上游 npm 更高版本的提示
  quick-chat.ts              # 快速开聊弹层「随手聊历史」纯逻辑：pickQuickChatSessions（不落工作区/注册项目，
                             # 且排除归档/内部/live/源文件已删——列了也恢复不了的）+ 标题展示（tests/quick-chat.test.ts）
  command-palette.ts         # 命令面板过滤纯逻辑
  stats-insight.ts           # 统计页花费环比 / 缓存命中率 / 会话标题回落纯逻辑（tests/stats-insight.test.ts）
  hotkeys.ts                 # 快捷键组合串纯逻辑
  themes.ts                  # 主题清单单一出处 + isLightTheme() 亮暗判定单一出处（禁另造判定）
  profile-copy.ts            # profile 跨 agent 复制纯逻辑
  resume-profile.ts          # 恢复会话的 profile 挑选纯逻辑：codex 内联 provider 会话（rollout 记
                             # model_provider="ccode" 或派生名 ccode-<网关短id>）按网关挑绑定；软停用（hiddenProfiles）
                             # 跳过停用项——wishedId 指向停用项同样跳过，全停用时回落含停用项池不拦死
                             # （tests/resume-profile.test.ts）
  combo-field.ts             # 网关库逐模型策略三态（edit/readonly/hidden）纯逻辑（tests/combo-field.test.ts）
  store.ts                   # zustand 状态
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表：一个 CLI 一张规格（detect/launch_plan/env/技能分发/安装更新/官方账号 login/readonly_args 只读模式参数/
                             #   model_switch 运行中切模型（claude/gemini 直切、codex/kimi/opencode 唤选择器）与
                             #   effort_levels 思考档槽位（本期仅 claude /effort 实证，kimi/codex 待实机）；
                             #   能力表三字段 fail-loud（原因即用户可见文案，后端报错与前端置灰同源）：
                             #   set_global（cursor/grok 不支持）/ mcp_write（grok 只读，请用 grok mcp add）/
                             #   skill_dist（cursor/grok 强制 copy）——global_config/mcp.rs/skills.rs 全部改查表，
                             #   前端经 agent_capabilities command 读表置灰）；
                             #   请求策略通道表 request_policy_support（逐字段 supported/unsupported/unknown，
                             #   只认二进制/配置 schema 实证，调研录 matrix §9 第 8 条；agents.rs
                             #   apply_request_policy_env 按表注入启动 env，未实证一律不注）；
                             #   resolve_binary 兜底候选目录 binary_candidate_dirs 同在本模块（macOS 含 /Library/TeX/texbin）
  agents.rs                  # 适配器分发入口 + resolve_binary 二进制解析（GUI 短 PATH 兜底）+ readonly_launch_args（聊想法只读注入）；
                             # codex 内联 provider 参数 codex_inline_provider_args 单一出处（启动注入与外部恢复命令共用：
                             #   新会话 provider 名 ccode-<网关短id>；旧 rollout 仍记 model_provider="ccode"，外部恢复缺 -c 定义报 provider not found；定义只含
                             #   base_url/env_key 引用不含密钥）；
                             # 选择器显示名统一「配置名 · 模型」（claude _NAME 槽 / codex catalog display_name /
                             #   kimi KIMI_MODEL_DISPLAY_NAME / opencode provider+models name）
  model_registry.rs          # 模型能力注册表：逐字段查询链 = 用户覆盖 > 网关实测缓存（fetch_models 顺带沉淀
                             # OpenRouter 风格 /models 元数据）> 公共能力库（配置页 ⋯ 下载，models.dev 优先
                             # OpenRouter 回落，download_model_db/model_db_status）> 内置前缀表 > 关键词兜底；
                             # 字段 thinking/context/output/vision 全 Option（这层不知道就继续向下找，
                             # 显式 false 只在数据源如实给出时生效）；kimi capabilities/max_context_size、
                             # codex catalog、opencode reasoning/limit/modalities 全从这条链出；
                             # limit.output 兜底 8192（1.18 起 schema 必填）；宁缺毋滥（收错比漏报有害）；
                             # 文件型加载器 cfg!(test) 下不读本机真实缓存（链语义由 chain_field 单测覆盖）
  profiles.rs                # 网关+绑定：gateways.json / bindings.json；keys.json 键=网关 id（0600）；
                             # list 物化成 Profile 视图（binding id 复用旧 profile id）；删除绑定=解绑不清密钥；
                             # 有绑定的网关禁删；导出/导入 v2；见 docs/conventions/profiles.md
  combo.rs                   # Agent×模型×槽×体检求交器，DTO 下发；网关库走多 Agent 并集
  drift.rs                   # 全局配置漂移：只比对 Ccode 写入键的子集，无关字段不算漂移
  gateway_store.rs           # 网关/绑定落盘与迁移；每槽体检摘要 latest-per-slot
  provider_id.rs             # provider 名 ccode-<网关短id> 单一出处；LEGACY="ccode" 仅旧 rollout
  tray.rs                    # 系统托盘：按 Agent 列绑定一键设为全局；选中态 dry-run 子集比对；不改启动栏默认
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（脱敏）；
                             # 网关体检探针 probe_gateway（绕过 CLI 直连端点发 max_tokens=16 最小请求：
                             # 基础鉴权/裸流式 SSE 检测/带策略参数对比降级定位/自定义 Header 接受度，
                             # matrix §9 第 8 条）；请求策略字段校验（范围、claude effort 闭集、
                             # Header 名禁引号冒号、环境变量名 POSIX 字符集）
  global_config.rs           # 「设为全局」：agent 级事务批次写入（备份/回滚/恢复）；写成功即记
                             # settings.active_global_profiles（配置页「全局生效」徽标数据源），恢复备份后清除；
                             # 恢复分两档——恢复备份（最近批次，每 tag 轮换留 5 份）与恢复初始状态
                             #   （backups/<agent>/original/ 永久快照，首次 apply 时落、不参与轮换，
                             #   has_original_backup/restore_original_backup）；
                             # codex provider 带 requires_openai_auth=true（auth.json 直供密钥，外部终端零 export；
                             #   旧写入遗留的 env_key 行随下次写入清除）；
                             # gemini 双文件：.env 之外必须加写 settings.json 的 selectedType=gemini-api-key
                             #   （v3.147 审计：缺它 gemini ≥0.46 headless auth 报错起不来，JSONC 容错读）；
                             # kimi 的 [models.*] 随写 display_name（配置名·模型，选择器 label 优先它）
                             # 与 capabilities（按注册表组合 tool_use/thinking/image_in，仅新版变体）
  projects.rs                # 项目档案卡（§11.3）：project.toml 读写、注册、资源登记/发现、一键开步、append_workspace_inbox、
                             # update_step_skills（步骤推荐技能读-改-原子写）、append_pipeline_steps（从模板追加：重名跳过、全跳过不落盘、
                             # 追加成功自动清 pipeline_opt_out）、set_pipeline_opt_out（「不使用研究流程」显式标记读-改-原子写）、
                             # 任务书草稿（read_task_draft/append_step_draft，
                             # .ccode/drafts/）、旧简报一次性并入草稿（list_legacy_briefs）、
                             # 任务卡 kind（idea/draft，旧卡按 step 推断）、fuse_card_into_draft（想法卡会话 ×
                             # 当前步骤草稿 → AI 融合稿，出站 redact_and_cap 不写盘）+ write_task_draft（确认后整份落盘）、
                             # update_lit_watch_filter（雷达筛选读-改-原子写，全空归一 None）、
                             # 项目移除三档（移除注册 / purge_project_traces 清除 Ccode 痕迹保留文件夹 / delete_project_dir）
  pty.rs                     # PtyManager：spawn_tracked 公共拉起，agent/shell 复用；
                             # pty_report_terminal_colors = Windows 底色告知（win32-input-mode 记录逐条投递，
                             #   条间 2ms；ConPTY 双向吞 OSC 的实测结论见 conventions/terminal.md，别改回 OSC）
  clipboard.rs               # 剪贴板图片落盘（save_clipboard_image）：<config>/ccode/tmp/paste-* 白名单扩展名 +
                             # 50MB 上限 + 每次顺带清理 7 天前残留（机制约定见 conventions/terminal.md「输入侧」）
  sessions.rs                # 会话浏览：九 agent 会话扫描/解析（Codex .zst、OpenCode SQLite/JSON）、session_meta、pin 快照、
                             # 会话删除、注意力分类（session_tail_state）、步骤名映射（RX3a）、
                             # codex rollout 元信息 model_provider 记进 SessionMetaDto.provider（恢复按它挑兼容 profile，
                             #   前端 pickResumeProfile 单一出处：ccode 或 ccode-<短id> 前缀按网关挑绑定）、
                             # sessions_for_card（融合进任务书的按卡取会话：与列表同一归属口径）
  skills.rs                  # 技能库（§6.13）：SSOT 库 + symlink/copy 分发（cursor/grok 固定 copy）、四路导入、ZIP 导出、卸载备份、
                             # 漂移检测 resync、create_skill/update_skill_content；apps 表是创建时快照，
                             #   list 时现算补齐注册表新 agent 的缺键（否则一键应用永远漏新 agent，不写盘）；内置技能种子（seed_builtin_skills：
                             # include_str! 内嵌 src-tauri/resources/skills/ 14 个技能，启动幂等播种，不覆盖/不复活用户改动）、
                             # 内置技能更新（check_builtin_skill_updates 种子逐字节比对 + apply_builtin_skill_update
                             # 覆盖前备份 SKILL.md.bak-<yyyymmdd> 后原子写入）、技能接口契约（frontmatter inputs/outputs
                             # 解析进 SkillDto，list 时现算；外部技能未声明时 infer_interface_from_body 正文推断兜底、
                             #   打 interface_inferred 标不回写；前端 skill-conflicts.ts 判定产物冲突 + 跨步骤链路
                             #   （skillChainWarnings：inputs 找供给/outputs 对账预期产物）+ StepSkillsChips 警告行）；
                             # ◈ 适配到流水线（adapt_skill_to_pipeline 出稿 FN_DISTILL + build_adapt_prompt 规范路径表
                             #   单一出处 → write_skill_md 确认落盘，name 强制沿用库中条目；update_content_impl
                             #   interface=None 时保留已声明 inputs/outputs 不静默丢弃）；
                             # 技能内容红线（2026-08-20 社区对标批量升级后确立）：单文件轻量规范（~100 行内，禁脚本/JSON 中间件/lint 体系）、
                             #   产出文件名与流水线接口（TASK.md 内联口径）不动、升级后同步 cp 进技能库（种子改完库不追平，见种子更新机制）
  mcp.rs                     # MCP 清单与分发（§6.15，规格 matrix §10）：统一模型→八家映射（grok 只读）、读-改-写一个键/段 + 备份 +
                             # 原子写 + 读回校验、JSONC 容错读、密钥引用转写（不落明文）、stdio 裸命令名 resolve_binary
                             #   绝对化 + node shim 深化、相对路径命令拒写（跨 agent 必挂，报错引导改绝对路径）；
                             #   全局启用开关（enabled 字段：停用=移除各 agent 条目但保留 apps 映射，重开按原样重投）+
                             #   连通性检测 check_mcp_server（stdio 拉起 initialize 握手 / remote POST 探活，8s 上限，
                             #   env/header 的 $VAR 引用检测时按宿主环境展开）
  usage.rs                   # 用量统计（§6.11）：usage 事件提取、usage_daily 按天聚合、任务成本归因、订阅口径、
                             # session_usage 单会话聚合（终端状态栏 token 段，先增量索引再按 session_id 汇总）；
                             # usage_trend / top_sessions：花费折线与最贵会话均跟随页顶范围，官方账号与 internal 不计费不进榜，
                             # 自定义标题出站前过 redact_sensitive_text
  pricing.rs                 # 内置定价表 + pricing.json 覆盖（写入校验）
  settings.rs                # 应用设置（settings.json）：字体/scrollback/汇率/镜像/主题/OS 通知/精确注意力
                             # （hooks_attention 按 agent map，旧 claude_hooks_attention 仅反序列化兼容迁移）/想法期只读保护
                             # /聊天页状态栏开关（status_bar_in_chat 默认开；关 = 聊天页 invisible 占位，切层不改终端行列数）；
                             # terminal_color_report 默认开（Windows：ConPTY 吞掉 OSC 底色查询，浅色主题下
                             # 主动把前景/底色推给 gemini/qwen；白名单外的 agent 推了会变输入框乱码，
                             # 见 docs/conventions/terminal.md）；
                             # hidden_profiles = 软停用（自动路径跳过、手动可用；v3.142 起不再是纯展示偏好）；
                             # active_global_profiles = 「设为全局」追踪（agent→profile id，record/clear_active_global
                             # 维护、不走 patch、clear_profile_refs 同步清引用；只代表「上次由 Ccode 写入」非绝对生效态）
  hooks.rs                   # 精确注意力标记（七家 hooks 桥接）：BRIDGE_SPECS 每 agent 一张桥接规格（claude/qwen/
                             # codebuddy/gemini/kimi/grok/codex；cursor 无「等待确认」等价事件、opencode 无 shell hooks
                             #   形态，两家未接入），写各家 hooks 配置（备份留 10 份 + 原子写 + marker 合并/移除 +
                             #   损坏拒写；grok 整文件归 Ccode、外来文件拒覆盖），机制调研录 matrix §12；
                             # 事件日志解析双信封（snake_case/camelCase）+ 事件名去下划线小写归一 + grok Stop 只认
                             #   reason=end_turn + 会话归属双键匹配（session_id==文件主名 或 transcript_path==完整路径），
                             #   10 分钟 TTL 回落尾部推断不变；settings 字段 hooks_attention: map<agent,bool>
                             #   （旧 claude_hooks_attention 仅保留反序列化兼容迁移）；
                             #   session_confirm_detail（2026-08-24）：confirm 时从 payload 提取「在等什么」摘要
                             #   （message/tool_name/title 尽力而为），聊天层审批卡片用
  fonts.rs                   # 终端字体打包与 brew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层：一次性 prompt + 提交信息/摘要/PR 描述/冲突建议/提炼接力简报/评审沉淀起草生成；
                             # headless_task_args/run_agent_task 供 scheduler 复用（定时任务要写项目文件，codex 用 -s workspace-write）
  scheduler.rs               # 定时雷达（v3.75；v3.79 起技能可选）：schedules.json（每日/每周+时分，本地时区）、60s tick + 启动补跑
                             # （漏跑 coalesce 只补一次）、无头拉起 agent 在项目根跑技能（默认 lit-watch，prompt 按技能分派：
                             # lit-watch 专用文案不动、其他技能通用模板，10 分钟超时）、
                             # 历史留 20 条、跑完发 scheduler-run-done 事件（App.tsx 全局监听弹 OS 通知，复用长任务通知开关）；
                             # v3.95 起 Schedule.linkedStep 关联步骤（可空，update 空串归 None）+ RunRecord.newEntries 新命中计数
                             # （跑 lit-watch 前后数 inbox.md `## ` 标题数取差，超时/失败不记；项目配了雷达筛选时
                             # 前后各数一次过滤后条目取差，推送/收件箱胶囊只算符合筛选的）
  lit_watch.rs               # 文献雷达应用层（v3.95）：巡检产物解析 DTO（notes/inbox.md 有效文献块含 watch-run 批次标记日期、上限 500 条；
                             # papers/watch-followup.md 付费墙待办、watchlist.md 订阅读写整表写回保留注释行、included.md 精读清单
                             # 增删去重）+ download_paper_pdf 白名单下载（仅 http/https、60MB 流式上限、%PDF- 魔数校验、
                             # 落 papers/ 自动登记 project.toml 资源）+ attach_paper_pdf 关联本地 PDF（付费墙手动下载后
                             # 一步复制进 papers/ 并登记，源文件同口径校验、复制非移动）；门槛 = 注册项目根 + canonicalize + 读-改-原子写；
                             # 雷达筛选判定 metrics_pass_filter / count_inbox_entries_matching（scheduler 推送计数用，
                             # 口径见 conventions/pipeline.md「雷达筛选」）
  journal_metrics.rs         # 期刊指标表（雷达徽章数据源）：config_dir/ccode/journal-metrics/ 下 JCR2025-UTF8.csv +
                             # FQBJCR2025-UTF8.csv（来源 github.com/hitfyd/ShowJCR，用户本机下载、禁内置分发）合并成
                             # HashMap（normalize_title 规范化精确匹配，miss 时剥末尾出版商括号尾巴（「(Wiley)」「（ACS）」可多级）
                             # 重试，仍 miss = None 不虚构；前端 lit-watch.ts sourceDisplayName 同口径剥尾，两处同步），RwLock 进程内缓存；
                             # list_watch_entries 出口 enrichment 进 WatchEntryDto.metrics（展示时现算不落 inbox.md，
                             # 旧条目装表即生效）；download_journal_metrics（jsDelivr→raw 回落、.tmp 原子落盘、完清缓存）+
                             # journal_metrics_status（含 downloadedAt：两份 CSV 取较新 mtime）+ check_journal_metrics_update
                             # （GitHub commits API 按数据目录查最近 commit，与本地 mtime 比对出 hasUpdate，前端静默失败）
  reader.rs                  # 沉浸阅读区后端（v3.96）：ensure_paper_note 建档 notes/<slug>.md（精读八小节对齐 lit-notes 技能口径 + 机管「译段」「我的想法」两节，已存在不覆盖；
                             # 建档前先扫 notes/ 头部「来源行」配对已有精读笔记，命中即复用不另建，空模板 slug 笔记顺带清回收站；
                             # pdf_for_note 笔记→配对 PDF（来源行锚点优先；无锚点回落笔记 stem × type=paper 资源 stem
                             # 做 normalize_title 互相包含，多命中取最长，无命中返回 None；lit_watch.rs normalize_title 提 pub(crate) 复用）+
                             # reader_for_note 归属反查版（注册项目根直含 / 工作区 worktree 映射主仓副本，未合并明确报错）+
                             # read_image_bytes 图片通道（png/jpg/jpeg/gif/webp/svg、20MB，白名单判定复用 pdf.rs 内核）+
                             # save_reader_capture 圈选截图落 notes/assets/（PNG 魔数 + 同秒重名 -2/-3）/ append_note_image
                             # （追加进「我的想法」小节）+ 生词本 notes/glossary.md（list/append 术语小写去重/remove）+
                             # append_note_translation（「译段」小节）；门槛 = gated_root 注册项目根 + canonicalize + 原子写
  citation.rs                # 引用健康检查：.md 引用键（[@key]/多键/[-@key]）对照 references.bib（白名单同 pdf.rs 口径）
  handoff.rs                 # 接力（§11.3 机制四）：简报生成（脱敏+64KB）、提炼接力（build_session_digest AI 蒸馏全会话 +
                             # finalize_digest_brief 初稿写回）、handoff_links 接力链登记/固化
  workspaces.rs              # 任务工作区（§6.10）：worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT、
                             # setup/archive 钩子、评审合并（health/merge/PR）、artifacts.yaml、
                             # 人工事项状态（human_task_checks 勾选 + human_target_hit 落点检测 + human_target_count 命中计数/to-fetch 清单计数）、import_human_deliverable
                             # 交付导入（复制落点 + 登记提货单；v3.74 起 step/title 可选 + target_override 固定落点，
                             # 无步骤语境 = papers/imports/ 检索结果导入落主仓）、list_help_requests（.ccode/help-wanted.md 人工请求扫描）
  portwatch.rs               # 端口监控：LISTEN 列表、归属标注（cwd 最长前缀，回落 CCODE_PORT 段）、校验后 SIGTERM
  ws_settings.rs             # .ccode/settings.toml 三层合并（用户→仓库→local）；开步自动写 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk/勾选提交临时索引
  fs_tree.rs                 # 文件树与文件操作（删除走系统回收站 trash；重要路径删除保护，canonicalize 双校验；
                             #   家目录直下系统目录标 isSystem 供前端置灰）
  pdf.rs                     # PDF/docx 字节读取：read_pdf_bytes 白名单 + canonicalize + 上限，base64 传输
  updater.rs                 # CLI 安装/更新（brew TUNA、npm_for 同目录 npm、Windows winget 渠道：claude/codex/opencode/kimi/grok 五家有官方包）+ 应用自身 Tauri updater
  logbuf.rs                  # 诊断日志环形缓冲
  diagnostics.rs             # 诊断包：系统/WebView/GPU/输入法、功能开关、日志、进程生命周期采集与 ZIP 导出
  config_dump.rs             # 生效配置自省（只读，不建/不改任何用户配置文件）：dump_effective_config /
                             # export_effective_config（落 ~/Downloads/ccode-exports/ccode-effective-config-<时间戳>.json）——
                             # 快照含 generatedAt/appVersion/appSettings（with_defaults 完整 DTO）/profiles（仅 keyHint 尾号、
                             # 剔除 extra_env，绝无密钥）/hooksAttention/capabilities（复用 agent_capabilities）/
                             # workspaceSettings（传 root 时 ws_settings 三层合并终值 + 每键来源层标注）；
                             # 整份出站前过 sessions::redact_sensitive_text；设置页「诊断」区「生效配置快照」卡片消费
  process.rs                 # 后台子进程统一创建（Windows CREATE_NO_WINDOW 防 conhost 闪窗）+
                             # pty_command（Windows .cmd/.bat shim 深化：npm 系 CLI 解析出 JS 入口改 node 直启，
                             #   npm.cmd 走固定布局 special case，解析失败回落 cmd /c call；updater 与终端拉起共用）
  models.rs                  # 共享 DTO
  lib.rs                     # 模块与 Tauri command 注册
```

## 关键约定

以下硬约束**任何会话都必须遵守**；各领域的细则（评审覆盖层交互、流水线开步参数、步进器视觉规格、MCP 字段映射等）
已按主题迁入 `docs/conventions/`，改动对应领域前必读对应文件，日常会话不必加载。

- **密钥绝不回显/进 shell**：存 0600 `keys.json`（键=网关 id），只在拉起瞬间注入子进程 env；绑定/网关 JSON 只存尾号 key_hint；
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Ccode` 必须显式设置。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作（设为全局默认、hooks 精确注意力开关（七家，见 hooks.rs）、会话删除、工作树文件删除——
  工作树文件删除走系统回收站（trash crate）可反悔，四类均有备份/白名单防护口径，见 `docs/conventions/safety.md`）。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底；新增 CLI/工具调用点一律
  用它，禁直接 `which::which` 或裸名 spawn（候选目录清单见 `docs/conventions/safety.md` 对应实现 `agents.rs`）。
- **路径比较与文件名统一走方言层**（2026-08-29 Windows 协作批确立）：后端跨来源路径比较一律 `paths::same_path` /
  `path_within` / `path_key`（禁字符串 == / starts_with / 拼 `/` 前缀），落盘与显示先 `strip_verbatim`；前端同口径在
  `src/path-utils.ts`。新建/重命名文件（夹）名走 `paths::validate_fs_name`（报错），自动生成走 `sanitize_fs_name`
  （清洗）——全平台同一套规则，护跨机同步。纯逻辑模块的平台分支（如 escapeShellPath/pickQuickChatSessions）必须
  `isWindows` 显式传参，禁模块内隐式读平台（否则单测随宿主机器变）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象；unix 专属函数加
  `#[cfg_attr(not(any(unix, test)), allow(dead_code))]` 或 cfg 门控（Windows 编译不过就是漏了）；起子进程统一
  `process::background_command`（后台）/ `process::pty_command`（PTY），超时终止用 `kill_process_tree` +
  `join_with_timeout`，禁裸 kill + 无限 join。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。

### 主题约定索引（改动前必读对应文件）

| 领域 | 文件 | 覆盖内容 |
|---|---|---|
| 安全与数据防护 | `docs/conventions/safety.md` | 密钥/脱敏细节、git 提交与逐 hunk 验收、多阶段 Git、profile 三层验证、会话/配置写操作口径、诊断包、MCP 分发与技能导入导出、CLI 更新、PDF/笔记白名单 |
| 终端与工作台 | `docs/conventions/terminal.md` | PTY 回落 shell、标签持久化白名单、评审/冲突覆盖层、改动面板、收件箱与注意力规则、键盘流、分屏、关窗守卫、WebGL 探针、输入侧（图片粘贴/文件拖入/右键菜单/链接点击）、沉浸阅读区 |
| 流水线与项目域 | `docs/conventions/pipeline.md` | 工作区创建/漂移/归档/删除、流水线开步/模板/编辑器、接力与提炼接力、任务卡、人工事项与讨论种子、agent 人工请求（help-wanted）、收件箱分类胶囊、示例课题、白话双层 |
| 步骤工作面板 | `docs/conventions/step-panel.md` | **新增步骤/模板前必读**：七条硬规则（顺序即语义、空节点不出现、同一事实只说一次、孤立按钮、主路径唯一不设门控、角色标注）、问题该在什么时刻与层级出现（项目层/决策项/按需问/种子/人工事项五选一）、文案与术语、新增模板检查清单 |
| 主题与设计系统 | `docs/conventions/design-system.md` | 主题令牌、字体栈、线条语言、控件密度、页面框架、对话页三栏、步进器规格、已否决设计 |
| 网关与绑定（配置模型层） | `docs/conventions/profiles.md` | **改配置/注入/设为全局/模型能力/托盘前必读（已落地）**：网关×绑定拆层、binding id 复用、provider 派生名、relay 缓存键、求交器、体检与通道表不对称、迁移合并 |

## 路线图（见 docs/architecture.md §11 演进线）

- 通用控制台阶段 P0–W3 ✅（六 agent 适配器、双模式配置、多标签终端、会话可视化、统计页、IDE 形态、任务工作区与评审流）
  ——2026-08 起演进为「AI 科研工作台」。
- **P1 四条并行线 ✅**：P1a 官方账号（profile 双类型、终端内 CLI 登录、只读检测 auth 文件 + 冲突配置黄色警告、拉起不注入
  API env 且 env_remove 残留密钥变量、统计页「订阅」不计费）；P1b 流水线骨架（`.ccode/project.toml` 档案卡 + 项目注册、
  工作区页按项目分组 + 流水线步进器概览（v3.46 起大圆步进器：状态从工作区派生、大圆状态色表达进度、校验提示收进 ⚠ 浮层）、一键开步（bootstrap
  自动提交 + TASK.md exclude）、资源面板与自动发现、非 git 目录引导 init；首启引导完整版与工作区类型驱动默认值留 backlog）；
  P1c 供应商预设补齐（各 agent 补 DeepSeek/智谱等端点；加供应商 = `src/presets.ts` 加一行）；P1d 适配器注册表
  （`agent_specs.rs` 中央声明式注册表，一个 CLI 一张规格；解析器与 usage 提取器保持每 CLI 一个文件，注册表只做分发入口）
- **P2 文献 ✅**：PDF 预览 + 选段问 AI（P2a）、整理为笔记（P2b）、文献技能包（lit-search/lit-notes/review-framework/
  review-writing，notes/*.md + references.bib 规范）
- **P3 数据 + 接力 ✅**：数据处理模板 + 技能包（data-clean/data-eda）、提货单 artifacts.yaml v1（手动登记 + md5/大小，下一步
  TASK.md 自动带提货单段）、图片评审（ImagePairView 双栏看图）、长任务 OS 通知（notify.ts）、接力包 + 接力链可回溯
  （handoff.rs，对话页「⇄ 接自」badge）
- **P4 论文 ✅**：科研论文/毕业论文 manuscript 模板 + quarto render 脚本（render-draft/render-final，RX4a 追加 export-docx）、
  quarto-render 技能、提货单登记的 PDF 产物纳入预览白名单（根外产物按精确路径放行）；bib 联动以模板简报引用 references.bib 落地
- **RX 体验批 ✅**：RX1 流水线编辑器 + 步骤资源绑定；RX2a md 阅读版式/沉浸、RX2b 步骤胶囊对照（◫ 切根 + 产物面板）；RX3a
  对话步骤化（步骤名 badge/分组/搜索）、RX3b 技能新建/编辑/◈ 优化 + 步骤挂载技能；RX4a docx 预览 + export-docx；笔记对话式
  批改（选段「◈ 讨论/改写此段」）；界面白话双层 + 工作区页/列表精简
- **P5 通用层打磨（部分 ✅）**：逐 hunk 验收 ✅、跨标签聚合视图 ✅、成本按工作区归因 ✅、历史时间线视图 ✅（first-parent
  主线 + 白话翻译：✓ 验收合并/⚙ 自动保存/◔ 保存）、**hooks 精确注意力标记 ✅**（设置页按 agent 显式开关，
  hooks.rs 七家桥接；v3.32 Claude 首发，v3.99 推广到七家，见架构 v3.32/v3.99）、**内置技能种子 ✅**（v3.64：14 个内置技能 = 9 个原有补强 + 5 个外部仓库内化，include_str! 播种、不覆盖不复活，
  五套流水线模板按步骤挂载）、**定时雷达 ✅**（v3.75：scheduler.rs 每日/每周无头巡检 + lit-watch 多源精选升级，
  约定见 conventions/pipeline.md「定时雷达」）、**模板重设计与接壤 ✅**（v3.78：五套模板内容重设计（种子对准拍板点/技能挂载核对/
  学术 MCP 人工事项）+ 产物路径接壤（投稿与返修接综述/科研论文成稿）+ 编辑器「＋ 从模板追加」）；批量验收、云端会话双源调研留 backlog
- **Backlog（记录不动手）**：SSH 远程执行、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（✅ 已落地为
  沉浸阅读区，v3.96）、批量验收、云端会话双源调研、首启引导完整版（示例课题最小版已落地：工作区空态「✦ 创建示例课题（演示）」→
  `create_demo_project`，演示 PDF/引文/综述流水线齐备；完整版引导的更丰富演示数据留 backlog）、工作区类型驱动默认值（数据类跳端口）

**当前待办**：

- P0 收尾当前批次：批次 A（文献雷达应用层，v3.95）、批次 B（沉浸阅读区，v3.96）与批次 E（LaTeX 支持，v3.97）
  均已落地待走查；全量文档同步 → 走查 → [skip ci] 提交 → 可选发版。
  批次顺序为用户拍板：E 先行，批次 C（实验数据分析）/D（表征分析）转待办；场景 4（agent 辅助做图）整批不做、
  已移出路线（「只做场景必需、不做扩展性功能」原则，见架构 v3.97）
- **定时任务与研究流程结合（部分落地 v3.95，细目见架构 §11.4 Backlog 细目）**：边界已定——不给每步配定时任务，
  结合点是「产出回流」而非「配置下沉」。产出回流三件套已上线（v3.95：lit_watch.rs 解析巡检产物 + LitWatchCard
  雷达卡片 + 收件箱 lit: 文献胶囊 / Schedule.linkedStep 关联步骤 + RunRecord.newEntries / staleLitHint 复用
  staleUpstream 口径只提醒不阻断）。
  三条已确认风险不变：写权限九家不齐（仅 codex 有沙箱、grok 用 --yolo、qwen 未验证）、
  产出绕过验收层（cwd 是项目根不是 worktree）、10 分钟超时与真失败不可分。
  落点收敛 + 能力标注仍未做，跑进工作区属定位决策待拍板
- macOS 签名公证（暂缓，需 Apple Developer 会员 + CI 配 6 个 APPLE_* secrets，见架构 v1.3）
- Intel macOS 安装包（暂缓：CI macos-latest 只出 aarch64；加 `x86_64-apple-darwin` target 构建时间翻倍，真有 Intel 用户再加，
  见架构 v1.3 / README 安装节）
- OpenCode Windows 数据路径 ✅：`sessions.rs` 依次探测 `OPENCODE_DB` / `%LOCALAPPDATA%\opencode` / `%APPDATA%\opencode` / `~/.local/share/opencode`（2026-08-31）
- Skills 一键更新 ✅：更新检测（check_skill_updates）+ 检测后一键应用更新（apply_skill_update，v3.53）均已落地
