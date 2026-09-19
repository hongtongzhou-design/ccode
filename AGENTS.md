# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（硬约束、本机环境档案）或对应
> `docs/conventions/*.md` 主题文件，以及 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是
> 操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：`docs/user-guide.md` 是面向使用者的**产品说明书**。只要改了入口、步骤、按钮文案或默认行为，必须改对应章节。写法（2026-09-18 用户拍板，否决无小标题长文）：写给干活的人；对「你」说话；保留小标题（如「安装时可能碰到的唯一拦路虎（Mac）」）；每节尽量同一口气——解决什么问题、打开会看见什么、一步一步怎么点、怎样才算做成、常见卡在哪；内部词第一次出现用白话带过。不要功能清单，不要文首流水账，不要把步骤揉进没有小标题的长段落。文中 `【配图】` / `【配视频】` 是后补素材位，改用法时同步改说明。版本叙事写 `CHANGELOG.md`（发版本时更新）。

> **跨平台换行约定**：仓库文本文件统一以 LF 形式存储，规则见 `.gitattributes`。Windows 本地可保留
> `core.autocrlf=true`，但提交前不得把换行转换造成的全文件差异带入变更。

## 项目简介

Mesa 是一个「AI 科研工作台」桌面应用（Tauri v2 + React/TS）——底层是九个 Agent CLI 的统一控制台（启动器 + 配置中心 +
会话监控台），表面是科研流水线（读文献→整数据→做图→写论文）：AI 负责干活，Mesa 负责管活，人负责拍板。
展示名 **Mesa**；内部身份仍是 `ccode`（bundle ID `com.ccode.dev`、项目 `.ccode/`、`~/ccode/`、Codex provider `ccode`/`ccode-<短id>`）。禁止把内部路径/安装身份跟着展示名一起改。
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

- 应用展示名 **Mesa**（内部身份仍 `ccode`，见上）；九个 agent 全部支持（CodeBuddy Code、Cursor CLI、Grok Build 见 matrix §7/§8/§9；grok：MCP 只读不分发、技能强制 copy；「设为全局默认」2026-09-01 起支持，写 ~/.grok/config.toml）
- 配置切换**双模式**：默认启动注入环境变量（零污染），另提供「设为全局默认」（写配置文件，先备份）
- 终端为内嵌形态，且**与结构化会话视图联动**（同一会话双栏观看）
- **会话标题**（2026-09-10）：展示格式 `MMDD|类型|主题`；日期用会话创建日、上海时区。类型闭集功能/设计/修复/优化/发布/探索/文档/研究。主题 8–28 字、至少 4 个汉字，写成对象+动作，须能区分同类工作（禁止「优化界面」「架构调整」这类空标题）。开头用第一条真正的用户问题写临时标题；Agent 退出后再用用户原话（首条/纠正/定题）校正，不送助手回复。写入 `custom_title` 且 `title_source=auto`，不写回 CLI 源文件。人手改过的标题（`title_source=user`）不覆盖；内容不足或无创建日保持原标题。内部无头会话不起名。已占用的「类型|主题」不得重复（提示模型改写，仍撞车则加 `·2`）。Grok compact/继续链与 Codex resume 链合并为一条，列表不出现分身。配置复用会话摘要 profile
- 项目列表**从各 agent 历史会话自动聚合并分类**，辅以手动添加
- token/费用统计随 P3 顺带做，不提前
- **三平台（macOS/Windows/Linux）同步**支持，功能不得以平台为由裁剪
- **Agent Workspace（v3.221 / v3.235）**：以 Project 为家。人负责目标，系统给环境（文件地图、规则、上下文）和验收门；Agent 自己规划。CLI 是第一种 Runtime。用户不面对 Run。并行只来自人声明或模板，禁止自动拆任务 / 智能路由。科研/编程两套 worktree 库不合并。工作台「正在进行」只列交互活；关标签后按 `runId` 找回。定时隔离产物经评审才进主仓。改工作台/目标/验收前必读 `docs/conventions/agent-workbench.md`

## 构建与运行

> **审计收口硬约束（2026-09-08）**：配置读改写持进程锁＋OS 文件锁，失败不得无锁继续；拆层迁移以 pending 恢复日志最终删除为完成，私有临时文件创建即 0600。PTY 全局锁内禁止阻塞写入，诊断输出不得同步落库卡回显。新建/恢复都兑现 discuss 权限，缺能力拒绝；原生退出负责进程回收。生产 CSP 不得因调试置空，Vite 脚本显式选择 `vite.config.ts`。细则与未验收范围见 safety.md / terminal.md / `docs/audit-remediation.md`。

```bash
# Rust 不在默认 PATH，每个新 shell 都要先 export
export PATH="$HOME/.cargo/bin:$PATH"

npm run tauri:dev      # 开发（独立 Mesa Dev 窗口；前端 HMR + Rust 改动自动重启）
npm run build          # 前端构建（tsc + vite）
npm test               # 前端测试（node --test，CI test job 同步执行）
cd src-tauri && cargo build / cargo test
npm run tauri build    # 打包
```

环境：Node 22 + npm（无 pnpm）；Rust stable（minimal profile）；crates 走 rsproxy 镜像（`~/.cargo/config.toml`）。

开发预览必须使用 `npm run tauri:dev`：独立产品名 **Mesa Dev**、窗口标题 **Mesa Dev - 热更新**、bundle ID
`com.ccode.dev.hmr`（`src-tauri/tauri.dev.conf.json`）。界面验证必须按该窗口标题或明确 `.app` 绝对路径定位，禁止用模糊应用名 `Mesa` / 旧名 `Ccode`。
**界面核验不得混入旧打包前端**：`/Applications/Ccode.app`、`/Applications/Mesa.app`、`target/release`、普通 `com.ccode.dev` 与历史 `target/debug/bundle`
均不可作为验收依据；只能验收 `tauri dev --config src-tauri/tauri.dev.conf.json` 启动、连接 17575 的热更新窗口。无法唯一确认窗口归属时停止界面操作，改报“未验收”，不得拿旧窗口截图或状态代替。

## 本机环境档案（踩坑记录，新会话必读）

- **网络：访问 GitHub/raw/formulae.brew.sh 很慢**。必须用镜像：crates → rsproxy（已配）；rustup → TUNA；brew 元数据 → `HOMEBREW_API_DOMAIN` 指 TUNA（仍有效）；brew bottle → **平铺镜像已死**（TUNA/中科大/腾讯/阿里 2026-09-19 实测 403/404，`HOMEBREW_BOTTLE_DOMAIN` 形同虚设），改 `HOMEBREW_ARTIFACT_DOMAIN=https://ghcr.nju.edu.cn`（南大 ghcr 代理，bottle 实测 6.7MB/s vs ghcr 直连 73KB/s；非 ghcr URL 代理 404 后 brew 自动回落原地址，已在 updater.rs 内置）；npm 如变慢 → `registry.npmmirror.com`。ghcr/GitHub Release 直连仅 ~73KB/s，tap/cask 大包（如 opencode 46MB）直连仍要十几分钟——注意：**CLI 子进程（curl/brew/npm）不读 macOS 系统代理，只认环境变量**，Mesa 下载侧已按设置页「出网代理」注入（`download_proxy_env`），镜像主机进 NO_PROXY 直连；更新超时改「10 分钟无输出闲置判死 + 30 分钟硬上限」（PTY 实测慢下载时 curl 进度条持续出字，不会误杀活下载）。
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
- **macOS 的 `/usr/bin/git` 是 CLT stub**：没装 Xcode 命令行工具时 which 也能命中它，直接跑会弹系统安装窗、
  还会被版本探测的 5s 超时杀掉——判定必须先用 `xcode-select -p`（background_command）探 CLT 在不在，
  stub 场景禁跑 `git --version`（dep_check.rs 的 clt_stub 三态就是这么来的，别退回直接探测）。
- **Xcode 许可未同意会让热更新窗口消失**：`xcode-select -p` 指向 `/Applications/Xcode.app` 时，未 `sudo xcodebuild -license` 则 `xcrun --sdk macosx --show-sdk-path` 失败、Rust 链接退出 69，`tauri:dev` 只剩 Vite 占 17575、Mesa Dev 窗口没了。本机已装 CLT 时开发编译改 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`，不要改端口、不要另起配置外实例。用户同意 Xcode 许可后可去掉该变量。
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
  **窗口标题**（17575 实例 = 「Mesa Dev - 热更新」，17576 实例 = 「Mesa Dev - 热更新 :17576」）+ **devUrl 端口**。
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
  pages/                     # 侧栏九页：工作台▣ 项目⛁（workspaces，v3.92 起 UI 页名「项目」） 运行⌨（terminal） 对话◔ 连接⇄（profiles） 技能✦ MCP⌗ 用量◫（stats） 设置⛭
                             # 定时任务不是侧栏页（2026-09-13 用户移除）：只是项目「定时任务」页签；
                             #   页切快捷键（hotkeys.ts PAGE_HOTKEY_DEFS）、设置页「启动时进入」与 settings.rs KNOWN_PAGES 同为九页清单，
                             #   全局 page id schedules 仅作旧值重定向（App.tsx 转项目定时任务页签），SchedulesPage.tsx 已删
  components/                # WorkspaceReviewView、PipelineEditor（含「＋ 从模板追加」）、ProjectGroup/ProjectRail、ArtifactChecklist（文本类产物就地预览层 +
                             # md 笔记「⛶ 沉浸阅读」入口（v3.98：pdf_for_note 配对后发 readerReq 带 notePath 进阅读区）+
                             # ⠿ 拖出手柄经 tauri-plugin-drag 做 OS 级文件拖出——WebView HTML5 拖拽出不了窗口）、TaskCardsSection、FileTree、
                             # FilePreviewEditor、PdfPreview/DocxPreview/XlsxPreview/ImagePreview、ImagePairView、GitPanel、HandoffPicker/DigestPicker、
                             # KickoffConfirmDialog（开工确认弹层：TASK.md 预览/编辑（草稿优先）+ 旧简报并入兜底 + 技能区（含 MCP 归处标记）+ 人工事项区 + 主仓提醒 +
                             # 上一步收尾软门：紧邻上一步非可选 after 事项未勾 → 「确认开始」二击变「仍要开工」才开，只确认不阻断）、
                             # StepSkillsChips（步骤推荐技能 chip 区：只读/可编辑两态 + 产物冲突/跨步骤链路 ⚠ 警告行）、
                             # HumanTasksList（人工事项清单 + useHumanTasks 共享逻辑）、StepFlow（步骤内协同流程线）、
                             # ScheduleSection（定时任务：有流程在项目设置抽屉；无流程主区雷达下；编程/办公右侧会话栏）、
                             # LitWatchCard（「◔ 文献雷达」卡片：新命中/精读清单双页签 + 近 8 周趋势 + →精读/◈解读/↓全文 +
                             #   新命中默认两行对齐精读清单密度（摘要点开才见）+
                             #   期刊徽章（IF/中科院分区/TOP，数据源 journal_metrics.rs）+ 新命中按日期/按关键词分组切换 +
                             #   卡头期刊指标表入口常驻（未装=↓下载 / 已装=↻重下即更新）+ 卡头「筛选」弹层
                             #   （litWatchFilter：IF/分区/TOP 三条件，被筛掉条目「查看全部」临时态），挂科研任务步进器与当前步骤卡之间、默认收起）、
                             # ReaderOverlay（沉浸阅读区全屏覆盖层，v3.96：三栏「笔记｜PDF｜Agent 终端」，fixed inset-0 z-40，
                             #   Esc 退出级联最优先，底下终端/PTY 保持挂载；右栏 = 阅读会话标签 xterm 宿主搬移，注入由 TerminalPage 供给）+
                             #   PdfContinuousView（连续滚动 PDF 栏：±2 页虚拟化懒渲染、选段浮动条（译/◈问 AI/＋生词/⋯）、▦ 圈选截图、
                             #   ⌘+点击段落对照（结果进同款浮卡）、进度记忆/护眼反色/术语淡高亮、
                             #   ⌘/Ctrl+滚轮与触控板双指捏合对准指针缩放）、
                             # TemplatePickModal（科研项目注册成功后的研究流程模板选择层：顶部课题主题 +
                             # 六套内置模板 + 「不使用研究流程」（写 pipeline_opt_out 标记；只读文献走这条）/
                             # 「稍后再选」（不留痕，已填主题仍落盘）两出口）、
                             # CodingProjectView / OfficeProjectView（编程左工作树右会话可收；工作树事后分组、行内图标动作 / 办公左文档右对话+定时同款可收）、
                             # FuseDraftModal（「◈ 融合进任务书」预览编辑弹层：AI 融合稿可改后确认才写草稿）、
                             # TerminalStatusBar（终端底部常驻状态栏：未启动只留状态点 + 📂 目录胶囊；
                             #   进程起来后才有模型/思考档可点切 + git 芯片/保存/推送 + 时长/token） 等
  components/CommandPalette.tsx # ⌘K 面板
  components/QuickChatHistoryMenu.tsx # 侧栏「快速开聊」右键的 scratch 历史浮层（继续上次）
                             # 记住选择后左键直达、右键回看；行样式与弹层「继续上次」一致
  components/GatewayLibrary.tsx # 连接页网关库：五槽/密钥/获取模型/按槽体检/逐模型策略三态；
                             # Base URL 主输入（2026-08-31）：空槽与仍等于旧主值的槽跟随主输入、手改即脱离；
                             # 全部测速按 URL 去重（同址只探一次，摘要前端镜像给同址槽）
  components/HoverTip.tsx      # 应用内 tooltip 共享件（v3.93 提取自 ProjectGroup）：useHoverTip + HoverTip，
                             # portal 到 body（免疫祖先 opacity/transform 的 fixed 包含块问题）、滚动/缩放即关、
                             # up 参数支持锚点上方弹出（行内动作栏 tooltip 专用）；PageFrame 的 RowAction 内置上方 tooltip
  pipeline-presets.ts        # 内置流水线模板 PIPELINE_TEMPLATES（六套，含 v3.97「LaTeX 论文」）；
                             #   每套 projectRules 纪律不同，settingsForTemplateApply 不落空表格
  lit-project.ts             # 文献-only 项目：建议添加目录 / 家目录禁入 / 无流程时 inbox 落点
  task-md.ts                 # TASK.md 拼装纯函数（项目根/产物目录绝对路径）；pipeline-start 再导出
  pipeline-start.ts          # 一键开步共享链路（renderTaskMd/gatherTaskMdExtras 单一出处，弹层预览与落盘共用）；
                             # 工作区→终端交接单一出处 buildWorkspaceTerminalRequest（reuseKey 找回同工作区标签 +
                             # 无 prompt 时 resume 最近会话）
  goal-run.ts                # 普通目标/「验收后写入」共享启动链（审计 §4.10）：prepareGoalRun 先拼上下文
                             # （packGoal/goalLine 可覆盖）再 task_prepare_run（contextText 冻结快照）；
                             # goalRunTerminalFields 出终端请求公共字段；页面只补 model/预览等自有字段
  workspace-resume.ts        # 「去终端」resume 挑选纯逻辑（workspace 名 + 仓库路径匹配，排除归档/内部/live，
                             # tests/workspace-resume.test.ts）
  presets.ts                 # 端点预设表（provider 级一份多槽：PROVIDER_PRESETS 各协议槽端点 + 推荐模型 ≤3 + 适用 Agent；
                             #   presetsForAgent 按 Agent 协议槽派生下拉；加供应商 = 加一条；仍只收官方/公开端点）
  preset-flow.ts             # 一键接入纯逻辑：推荐模型与目录求交（intersectCatalog，不整目录预填）、「同时绑到」
                             #   协议兼容目标推导（extraBindTargets，复用 apiKindOf；多协议 Agent 优先 openai）、
                             #   多 Agent 槽位拼装（gatewayDraftSlots：主槽=表单地址，预设分槽值优先于同址回落）
                             #   （tests/preset-flow.test.ts；约定见 conventions/profiles.md「一键接入」）
  mcp-presets.ts             # MCP 内置预设表（加预设 = 加一条；密钥一律 ${VAR} 引用；
                             #   remote 填 url/headers，stdio 填 command/args，`{home}` 打开表单时展开为家目录；
                             #   需本机安装的用 setup 步骤引导，不代装）
  mcp-display.ts             # MCP 页展示纯逻辑：协议徽章固定识别色（stdio 紫/remote 蓝）+ 命令路径智能缩略
                             # （家目录折 ~、段数>3 且 >28 字符才砍中段留首尾）+ 收编条目判定与删除影响面
                             # （isAdoptedMcp/mcpDeleteImpact/mcpOriginLabel，tests/mcp-display.test.ts）+
                             # 分发状态徽标 mcpDistBadge（modified/missing/disabled_externally 三异常态文案与识别色）+
                             # 命令路径告警徽标 mcpCmdPathBadge（relative/missing）与收编解析附注 mcpPathResolveNote
  run-overview.ts            # 运行中聚合视图纯逻辑（按「要你管」排序）
  run-model.ts               # Project→Task→Run 前端镜像：inferTaskKind / 工作台白名单 isWorkbenchSurfaceRun
                             # （登录/无头/空闲 shell 不进「正在进行」；阅读标签还开着则进）/
                             # pickRecoverableRun 找回可恢复 Run（排除 internal/login/watch/reader——阅读关掉就离开，
                             # 不进找回链）/ isRunProcessLive 活进程判定（保留标签不算运行中）（tests/run-model.test.ts）
  project-tasks.ts           # 人声明任务：资料范围（不带入/勾选/整个项目）/ 嵌套路径剪枝 /
                             # 声明步骤过滤（不含会话自动登记）/ 审核回流文案 /
                             # 保护文件夹勾选（验收写回保持原样，不是另存副本；tests/project-tasks.test.ts）
  project-agents.ts          # 项目 Agents 名册：每家默认配置 / 项目默认 / 声明步骤归属
                             # （不自动分派；tests/project-agents.test.ts）
  project-context.ts         # 项目环境包：名称/规则/顶层文件地图（启动注入）；
                             #   会话包 = 身份+目录+规则+跟用户走；目标包才带当前目标/技能/尚未完成/验收写回；
                             #   空表格不进规则，有流程用模板纪律、无流程用工作方式默认条
                             # （tests/project-context.test.ts）
  coding-lanes.ts            # 编程车道覆盖层：有树无行按分支现算、theme 分组、空闲/Agent
                             # （tests/coding-lanes.test.ts）
  agent-caps.ts              # 能力表前端消费：定时任务禁选未验证无头、grok 无沙箱附注
                             # （tests/agent-caps.test.ts）
  work-mode.ts               # 项目工作方式（科研/编程/办公）与编程状态归类、办公文档类型/预览形态；
                             # 文件行「进行中」只认 officeFileReuseKey 对上的活标签（仓级仍 isOfficeInProgress）；
                             # 顶栏课题主题可见性 headerShowsTopic（科研项目含无流程都展示，身份四件套之一）
                             # （lockWorkModeFromConfig / codingFactChips / codingDivergenceBar /
                             #   groupByWorkMode 项目栏分段；tests/work-mode.test.ts）
  session-title.ts           # 会话列表展示标题清洗（去 URL/绝对路径/中断/resume/未命名，取首句；不写回源文件）
                             # （tests/session-title.test.ts）
  project-status.ts          # 项目页状态行 / 工作区要你管排序 / 笔记过滤 / 办公继续上次与问 AI 建议
                             # / 本项目会话过滤（filterProjectSessions，排除无头 AI / 问 AI / 阅读注入 / 已归档；默认全部列出）
                             # （tests/project-status.test.ts）
  mac-titlebar.ts            # macOS Overlay 顶栏左边距：窗口态红绿灯让 78px，全屏取消
                             # （macOverlayPadClass / useMacFullscreen；tests/mac-titlebar.test.ts）
  folder-groups.ts           # 项目页分级文件夹树（本层文件与子夹并列；可剥 papers/notes/data）
                             # 展开路径 persist（默认全收起，跟随上次；tests/folder-groups.test.ts）
  project-rail.ts            # 运行页左栏项目区：活标签已添加项目 ∪ 科研活跃工作区 ∪ 当前项
                             # （attributeRailCwd / buildProjectRailSections；tests/project-rail.test.ts）
  workbench-hero.ts          # 工作台主卡纯逻辑：当前工作按运行标签归属（注册名优先；隔离目标副本按
                             # runId/taskId 归属表归回真实项目，不按 cwd 拆卡；同名项目按 contextPath 路径选，名字只作唯一命中回落）、
                             # 步骤取流水线第一个未合并步、「继续工作」有标签则聚焦，否则按 runId 找回原 Run，再回落进项目/真进入；
                             # pickWorkbenchNow = 正在进行列表（大卡 + 紧凑行）；runningCount 只算活进程
                             # （isRunProcessLive，已退出/未启动的保留标签留在 runs 里可继续但不冒充「正在工作」）；
                             # 副行优先待验收/进行中目标；最近对话先按可见范围过滤（归档/内部无头/问 AI/阅读注入不列，
                             # 与 filterProjectSessions 同口径）再与项目侧栏同一套清洗，未命名不列；
                             # workbenchRecentRows = 已添加项目 ∪ 会话扫仓库（办公/新建无会话也列出），
                             # 与最近对话默认最多 10 条（tests/workbench-hero.test.ts）
  lit-watch.ts               # 文献雷达纯逻辑：日分组/关键词分组（groupEntriesByKeyword，取 keywordsHit 首词、
                             # 未分类恒末）/趋势/直链转换/全文可得性分流（fulltextLinkFor：arxiv abs 与 .pdf 直链=可下载，
                             # DOI/落地页=来源，不再摆禁用下载钮）/已读判定/漂移提醒/雷达筛选（entryPassesFilter
                             # 与 lit_watch.rs 双端镜像，指标未知放行不误伤；快筛解读 watchExplainPrompt /
                             # parseWatchExplain 五节学术口径；卡片展开按项目记忆（默认收起）；
                             # tests/lit-watch.test.ts）
  md-image-hydrate.ts        # md 阅读/聊天图片占位水合：每次 layout 扫 data-md-src，本地图缓存
  reader.ts                  # 沉浸阅读区纯逻辑：分栏钳制与像素换算/圈选命中与 canvas 映射/截图注入格式/
                             # glossary 表格契约（与 reader.rs 双端镜像，改动需同步）/段落边界提取/术语匹配/
                             # 进度与护眼存储键/翻译面板高度键（readerSplitT，未拖过不落键 = 内容自适应）/
                             # PDF 适配宽度 nextFitScale（亚像素门槛，防滚动条槽振荡闪白）/
                             # 手势缩放 clampPdfScale、pdfWheelZoomFactor（组件绑定共享在
                             # components/use-pdf-zoom.ts：布局倍率即时重排、渲染倍率 renderScale 延迟重绘、
                             # 锚点实测修正不用公式，连续滚动与单页预览同一套；对齐官方 pdf.js viewer，
                             # 勿退回整层 transform 跟手）/
                             # 画布像素上限 pdfCanvasOutputScale（tests/reader.test.ts）
  md-math.ts                 # md 阅读版式公式渲染（批次 E）：marked 扩展按 Pandoc 口径切分 $/$$
                             # （边界规则/转义/代码块不渲染/货币不误判）+ renderMathInto 懒加载
                             # katex+CSS（独立 chunk 不进主包，失败回落原文，tests/md-math.test.ts 25 例）
  task-cards.ts              # 任务卡纯逻辑：按步骤分桶/卡片排序/会话按卡分组/卡片 kind（idea 想法卡 / draft 讨论卡）过滤
                             # （tests/task-cards.test.ts）
  step-flow.ts               # 步骤内协同流程线纯逻辑：种子→before→agent→during→after→评审节点链
                             # （v3.97 起 after 档一律进主干，可选项带徽标但不抢当前节点；
                             #   demoReadPaperResource：「开读这一篇」仅示例课题精读步，普通模板只显示「开始」；
                             #   tests/step-flow.test.ts）
  skill-conflicts.ts         # 技能接口对账纯逻辑：产物冲突（skillOutputConflicts，outputs 两两相交）+
                             # 跨步骤链路（skillChainWarnings：inputs 找供给/outputs 对账预期产物，
                             # 支持 * 通配与目录/文件互含，推断接口打标；tests/skill-conflicts.test.ts）
  schedule-tasks.ts          # 定时任务纯逻辑：周期白话/相对时间/按 projectRoot 过滤（tests/schedule-tasks.test.ts）
  schedule-skill.ts          # 定时巡检种类：文献雷达 + 分类「巡检」的技能；新建种子 prompt / 草稿路径
                             # （value 用目录名不是 UUID；tests/schedule-skill.test.ts）
  inbox.ts                   # 收件箱分类胶囊纯逻辑：key 前缀→类别、分组、help dismiss 签名、人工请求通知 edge-trigger（tests/inbox.test.ts）
  app-update.ts              # 应用自更新展示纯逻辑：收件箱字段/合并、检查失败文案、http(s) 代理、下载进度
                             # （tests/app-update.test.ts）；真正 check()/安装在 store.ts
  chat-handoff.ts            # 聊天⇄终端交接表：chat_ok / peek / must_switch、等待态文案、斜杠是否要窥视 TUI、
                             # 聊天头状态 chatHeaderStatus（未开始不写「等待会话文件」，tests/chat-handoff.test.ts）
  slash-commands.ts          # 聊天斜杠命令保守常用集（未全量调研的 agent 只给 /help；tests/slash-commands.test.ts）
  ime-guard.ts               # 聊天 Enter 是否处于输入法组词（WKWebView 确认候选时 isComposing 已假；tests/ime-guard.test.ts）
  notify.ts                  # 长任务 OS 通知（仅「待确认」跃迁 + 未聚焦 + 30s 去抖；「已回复」不通知）；
                             #   注意：通知插件桌面端无动作按钮/正文点击回调（App.tsx registerActionTypes/onAction 仅移动端生效，
                             #   2026-09-15 核对插件源码）——桌面点通知只激活窗口，「待确认」跳转由 App.tsx 窗口获焦时的
                             #   右下角提醒条补位（点「去处理」直达终端标签，按待确认集合去重）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑（含冲突 unmerged 组）
  file-icons.ts              # 文件类型小徽标纯逻辑：扩展名 → 短标签 + 固定识别色；
                             # isPreviewableImagePath（png/jpg/gif/webp/svg，tests/file-icons.test.ts）
  sheet-preview.ts           # Excel 预览纯逻辑：列字母 / 单元格引用 / 截断文案 /
                             #   合并区 clipSheetMerge / sheetCellHidden（tests/sheet-preview.test.ts）
  editor-languages.ts        # monaco 语言注册（批次 E）：monaco-editor 0.56 ESM 不带 latex，
                             # 自带紧凑 Monarch 定义覆盖 .tex/.sty/.cls/.bib（tests/editor-languages.test.ts）
  workspace-visibility.ts    # 聚焦步骤工作区可见性过滤纯逻辑（不匹配任何步骤的手动工作区始终可见，
                             # tests/workspace-visibility.test.ts）
  git-commit-message.ts      # 空提交信息的本地默认信息生成
  main-history-save.ts       # 科研步骤卡一键「存进历史」：冲突拦截 / 白话说明 / 路径（tests/main-history-save.test.ts）
  terminal-input.ts          # 终端输入侧纯逻辑：shell 路径转义 escapeShellPath、拖入多路径拼接 joinDroppedPaths、
                             # 聊天拖入 joinDroppedChatPaths、dropHitsRect、Kimi CSI-u 序列、
                             # 剪贴板图片条目判定/MIME→扩展名/粘贴反馈文案（tests/terminal-input.test.ts）
  terminal-welcome.ts        # 终端未启动空态：isTerminalIdle / 卡上「将在 … 启动」目录文案
                             # （tests/terminal-welcome.test.ts）
  tab-working.ts             # 终端标签「生成中」虚线圆：PTY 出字才转；启动注入等回复期间 TUI 开屏不熄灭；会话已落完助手正文；PTY 仍出字时 Codex 中途 done 不得停转圈
                             # 立刻停，sticky working 不得续命；armed 回合不因 PTY 2s 静默熄灭（推理思考间隙≠回合结束，
                             # armed 只由会话层收尾/确认/退出清，未 armed 的 working 仍 2s 静默熄灭兜底——2026-09-15 修正
                             # 「终端还在出字、标签与聊天层却无运行态」）；完全静默 120s 硬上限熄灭转圈但保留 armed（PTY
                             # 再出字即复亮，2026-09-19：思考/执行期间 TUI 动画仍在出字，完全无声=回合已结束或链路冻结）；
                             # 收尾判定被 ptyLive（8s 窗）推迟时 scheduleSettleRetry 保证 PTY_LIVE_MS+1s 后强制重判一次
                             # ——否则会话文件再无新写入时签名门拦住轮询、转圈永久冻结（2026-09-19 综述大纲跑完实测）；
                             # 出字时间戳记任意 agent 输出（焦点重绘抑制窗内也记，
                             # 防切聊天瞬间被静默计时器误杀）；动画禁 CSS rotate（WKWebView 转轴圆心晃）、也禁 dashoffset
                             # 关键帧（主线程重绘，xterm 出字满载时一卡一卡）——8 段虚线按相位差闪 opacity（合成器线程，
                             # 2026-09-15 实测重做）（tests/tab-working.test.ts）
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  tab-drag.ts                # 标签条拖拽排序纯逻辑：位移钳制 + 目标槽位判定（>= 中线守末槽边界，
                             # tests/tab-drag.test.ts）
  terminal-palettes.ts       # 终端调色板共享表（设置页与终端同源）：四套深色 + 四套配对浅色 twin，
                             # ANSI 16 色 + 光标 + 选区全在表内；resolvePaletteId 按主题亮暗自动换 twin
                             # （新增调色板须同步 settings.rs KNOWN_PALETTES，否则被静默丢弃，tests/terminal-palettes.test.ts）
  upstream-note.ts           # brew 最新但上游 npm 更高版本的提示
  quick-chat.ts              # 快速开聊弹层「随手聊历史」纯逻辑：只列 ~/ccode/scratch（isScratchCwd），
                             # 排除工作区/已注册项目/其他仓库/归档/内部/live/源文件已删；
                             # pickQuickChatHistory 用 store 会话列表现算；sidebarLaunchesDirect
                             # 侧栏记住选择后直达；pickRememberedProfileId 直达只认记住的那条
                             # （tests/quick-chat.test.ts）
  confirm-dialog.ts          # 确认框键盘语义：Esc 取消，Enter 激活当前焦点钮；设为全局挡路可 focusCancel（tests/confirm-dialog.test.ts）
  custom-runtime.ts          # 自定义运行时默认 cwd：仅空目录/scratch 启用（tests/custom-runtime.test.ts）
  gateway-slot.ts            # Agent→协议槽与目录刷新优先槽（与 slot_for_agent 双端镜像，tests/gateway-slot.test.ts）
  command-palette.ts         # 命令面板过滤纯逻辑
  stats-insight.ts           # 统计页花费环比 / 缓存命中率 / 会话标题回落纯逻辑（tests/stats-insight.test.ts）
  hotkeys.ts                 # 快捷键组合串纯逻辑
  themes.ts                  # 主题清单单一出处 + isLightTheme() 亮暗判定单一出处（禁另造判定；
                             #   custom / custom-light 不进十四套清单）
  theme-swatch.ts            # 设置页主题色卡预览色：从 App.css 源文本抽 rail/canvas/cta/l1，
                             #   禁止临时切 data-theme 再 getComputedStyle（tests/theme-swatch.test.ts）
  custom-theme.ts            # 自定义主题：三色种子派生全套令牌 + 另存色卡列表
                             # （tests/custom-theme.test.ts）
  profile-copy.ts            # profile 跨 agent 复制纯逻辑
  resume-profile.ts          # 恢复会话的 profile 挑选纯逻辑：codex 内联 provider 会话（rollout 记
                             # model_provider="ccode" 或派生名 ccode-<网关短id>）按网关挑绑定；
                             # openai→官方账号（未登录改网关）；其他名字（客户端 custom 等）只挑网关、不掉进官方；
                             # 软停用（hiddenProfiles）跳过停用项——wishedId 指向停用项同样跳过，全停用时回落含停用项池不拦死
                             # （tests/resume-profile.test.ts）
  combo-field.ts             # 网关库逐模型策略三态（edit/readonly/hidden）纯逻辑（tests/combo-field.test.ts）
  ask-ai.ts                  # 项目区「问 AI」：选 Agent/配置/模型，可设为默认（tests/ask-ai.test.ts）
  conversation-tools.ts      # 对话回放：连续工具调用聚合成一条执行记录（tests/conversation-tools.test.ts）
  dep-check.ts               # 依赖体检前端镜像：DTO 判定与 DOM/Tauri 解耦（tests 同名）
  gateway-draft.ts           # 网关库槽位纯逻辑：effectiveSlotUrl 主输入跟随/脱离、slotsFollowMaster、firstProbeableSlot
  goal-review.ts             # 目标验收弹层分组与文案：科研按文献/笔记/数据/论文、工作按文档/表格/幻灯（tests/goal-review.test.ts）
  history-view.ts            # 历史时间线白话翻译层（✓保存进项目/⚙自动保存/◔保存，hash/分支名降为二级）
  step-review.ts             # 科研步骤评审档案闭集 screening/files/acceptance/default；一张审阅壳按类型拼区块（tests/step-review.test.ts）
  review-save-copy.ts        # 科研保存链白话：保存进项目；不是编程合进基准、不是科研验收决定
  kickoff-inputs.ts          # 开步确认弹层「上一步接到的输入」芯片；isDeclaredStepInput 排除已声明输入，不进未登记列表
  lit-list.ts                # 无流程科研文献/笔记列表：展示名、编号、状态与过滤纯逻辑
  model-switch.ts            # 各 CLI 多模型注入能力表 + 启动栏提示纯逻辑（对应 agent_specs.model_switch）
  nav-capsule.ts             # 侧栏可配置胶囊入口（恢复侧栏始终保留，不在此列）
  project-context-load.ts    # 启动环境说明拼装：读档案卡和顶层目录，失败仍返回能用的短包
  research-report.ts         # 研究报告节抽取/相对路径解析（只认显式报告节，不认 TASK 指令或推断结论）
  screening-review.ts        # 检索/筛选评审主面：计数/待拍板/筛选决定、表默认 pending、文件分组；included.md/json 不与表并列摊 diff（tests/screening-review.test.ts）
  review-file-groups.ts      # 精读/写作评审文件分组：笔记/稿件/引文/待获取/过程（tests/review-file-groups.test.ts）
  research-tools.ts          # 科研工具注入 withResearchTools；旧「文献主来源」设置键写回时剥除——来源只认 lit_source
  academic-mcp.ts            # 检索步「配置学术检索 MCP」：预设名、登录注入（tests/academic-mcp.test.ts）
  session-filter.ts          # 对话页筛选纯逻辑（tests/session-filter.test.ts）
  session-search.ts          # 对话搜索纯逻辑：分词、元数据即时过滤、正文命中合并排序
  session-transfer.ts        # 会话导入向导纯逻辑：状态文案、目标目录预填、可否执行
  step-decisions.ts          # 决策项：答案落任务书草稿固定小节；isTaskMdStub = 空/仅决策/仅评审沉淀不算可执行正文，resolveTaskMdSource 走模板拼装并接沉淀（decisionGate/orderedAnswers/parseDecisions，tests/step-decisions.test.ts）
  terminal-resume.ts         # 终端会话恢复的标签复用与配置挑选纯逻辑（2026-09-08 审计修复）
  store.ts                   # zustand 状态
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表：一个 CLI 一张规格（detect/launch_plan/env/技能分发/安装更新/官方账号 login/readonly_args 只读模式参数/
                             #   model_switch 运行中切模型（claude/gemini/kimi/grok 带参直切；codex/opencode 唤选择器——两家 CLI 无带参直切：
                             #   codex /model 无内联参数（源码 supports_inline_args 不含 Model）、opencode /models run 无参，2026-09-15 实证；
                             #   状态栏 picker 档点芯片即唤选择器、不摆模型假菜单）与
                             #   effort_levels 思考档槽位（claude /effort 五档、kimi on/off、qwen 0.22.0
                             #   /effort 五档实证；codex 待实机）；
                             #   能力表三字段 fail-loud（原因即用户可见文案，后端报错与前端置灰同源）：
                             #   set_global（cursor 不支持）/ mcp_write（grok 只读，请用 grok mcp add）/
                             #   skill_dist（cursor/grok 强制 copy）——global_config/mcp.rs/skills.rs 全部改查表，
                             #   前端经 agent_capabilities command 读表置灰）；
                             #   请求策略通道表 request_policy_support（逐字段按入口记账：
                             #   inject=启动注入 / persist=仅设为全局 / tui=仅会话内命令 / unsupported / unknown；
                             #   只认二进制/配置 schema 实证，调研录 matrix §9 第 8 条；agents.rs
                             #   apply_request_policy_env 按表注入启动 env，未实证一律不注）；
                             #   resolve_binary 兜底候选目录 binary_candidate_dirs 同在本模块（macOS 含 /Library/TeX/texbin）
  agents.rs                  # 适配器分发入口 + resolve_binary 二进制解析（GUI 短 PATH 兜底）+ readonly_launch_args（聊想法只读注入）；
                             # 官方账号 Codex：apply_official_inject 必带 -c model_provider="openai"（内置 ChatGPT 渠道；磁盘
                             #   config.toml 的网关默认会盖过订阅，不得省略；只影响本进程、不写 model_providers 块）；
                             #   login_cmd = login --device-auth（CLI 自带设备码，不抄 cc-switch 的 in-app OAuth）；
                             # codex 内联 provider 参数 codex_inline_provider_args 单一出处（启动注入与外部恢复命令共用：
                             #   新会话 provider 名 ccode-<网关短id>；旧 rollout 仍记 model_provider="ccode"，外部恢复缺 -c 定义报 provider not found；定义只含
                             #   base_url/env_key 引用不含密钥）；
                             #   网关启动另加 -c web_search="disabled" 与 service_tier="auto"（盖 ChatGPT
                             #   登录默认；官方账号不注；不写 config.toml）；不注 features.apps=false（0.154 会把
                             #   Consensus/Undermind 收成 mcp__<名> 占位，unsupported call）；内置 codex_apps 改关
                             #   plugins.codex-app-tools@openai-bundled.enabled=false（mcp_servers.codex_apps.enabled=false
                             #   报 invalid transport）；禁止 enable_mcp_apps；
                             # grok GROK_CONFIG overlay 单一出处 grok_config_overlay：白名单（grok-build OVERLAY_ALLOW_PATHS，
                             #   fail-closed）只放行 [models] 全局块——allowed_models 收敛 + 请求策略五项全局默认（headers 走
                             #   $VAR 引用不落密文）；[model.<id>] 不在白名单，api_backend/context_window 由中转 /models 目录
                             #   条目 apiBackend/contextWindow 或 config.toml 提供（调研录 matrix §9 第 8 条）；
                             # 选择器显示名统一「配置名 · 模型」（claude _NAME 槽 / codex catalog display_name /
                             #   kimi KIMI_MODEL_DISPLAY_NAME / opencode provider+models name）；
                             # claude 不写 CLAUDE_CODE_SUBAGENT_MODEL（保留 Task 参数/frontmatter/inherit 原生选择链），
                             #   用 --settings 只覆盖本次连接的非敏感模型选择；
                             # claude 长上下文声明 CLAUDE_CODE_MAX_CONTEXT_TOKENS + CLAUDE_CODE_AUTO_COMPACT_WINDOW
                             #   同值成对（启动注入与设为全局同键同条件；注册链确知 >200K 才注，防第三方模型被按 200K 提前 compact）
  model_registry.rs          # 模型能力注册表：逐字段查询链 = 用户覆盖 > 网关实测缓存（fetch_models 顺带沉淀
                             # OpenRouter 风格 /models 元数据）> 公共能力库（配置页 ⋯ 下载，models.dev 优先
                             # OpenRouter 回落，download_model_db/model_db_status）> 内置前缀表 > 关键词兜底；
                             # 字段 thinking/context/output/vision 全 Option（这层不知道就继续向下找，
                             # 显式 false 只在数据源如实给出时生效）；kimi capabilities/max_context_size、
                             # codex catalog、opencode reasoning/limit/modalities 全从这条链出；
                             # limit.output 兜底 8192（1.18 起 schema 必填）；宁缺毋滥（收错比漏报有害）；
                             # 字段新增 api_backend（grok 目录 apiBackend，闭集只收 chat_completions/responses/
                             #   messages；仅权威层有值，model_api_backend_for 供预览说实话）；
                             # fetch 沉淀解析兼容 grok 目录别名（contextWindow/context_window/_meta.totalContextTokens）；
                             # 文件型加载器 cfg!(test) 下不读本机真实缓存（链语义由 chain_field 单测覆盖）；
                             # model_context_size_authoritative_for = 仅权威层（用户覆盖+网关实测）的 context
                             #   访问器——grok 设为全局写 [model.*].context_window 专用（估值层不配覆盖中转目录）；
                             # 用户覆盖层有写入通道（2026-09-19）：网关库模型行「能力声明」编辑 →
                             #   set/clear/list_model_capability_override（原子写、前缀归一小写、api_backend
                             #   不进 UI 但往返保留；细则 conventions/profiles.md §6.1）；
                             # 下载公共库顺带提取定价（models.dev cost / OpenRouter pricing → 条目 cost 字段），
                             #   db_price_table 供 usage.rs 定价链消费
  profiles.rs                # 网关+绑定：gateways.json / bindings.json；keys.json 键=网关 id（0600）；
                             # list 物化成 Profile 视图（binding id 复用旧 profile id）；删除绑定=解绑不清密钥；
                             # 绑定级 api_backend 字段（grok 专用，仅设为全局写 [model.*] 消费；闭集校验 +
                             #   导出/导入 v2 随绑定走、非 grok 导入丢弃）；
                             # 有绑定的网关禁删；导出/导入 v2；见 docs/conventions/profiles.md
  combo.rs                   # Agent×模型×槽×体检求交器，DTO 下发；网关库走多 Agent 并集；
                             # 逐字段通道种类 channel_*（inject>persist>tui>unsupported>unknown 并集）随 DTO 下发，
                             #   inject_*_allowed 只认 inject，apply_to_profile 保留 persist 字段（设为全局要写）；
                             #   协议维度门控 channel_status_for（kimi effort 仅 kimi 协议通道，非 kimi 协议绑定按 unknown 计）；
                             #   混注提示覆盖思考与采样两种不一致（换模不重注）；
                             # policy_channel_note 通道形态说明（qwen 仅设为全局 / grok overlay 边界）随 DTO 下发
  drift.rs                   # 全局配置漂移：只比对 Mesa 写入键的子集，无关字段不算漂移
  gateway_store.rs           # 网关/绑定落盘与迁移；每槽体检摘要 latest-per-slot
  provider_id.rs             # provider 名 ccode-<网关短id> 单一出处；LEGACY="ccode" 仅旧 rollout
  tray.rs                    # 系统托盘：按 Agent 列绑定一键设为全局；选中态 dry-run 子集比对；不改启动栏默认
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（脱敏）；
                             # 网关体检探针 probe_gateway（绕过 CLI 直连端点发 max_tokens=16 最小请求：
                             # 基础鉴权/裸流式 SSE 检测/带策略参数对比降级定位/自定义 Header 接受度，
                             # matrix §9 第 8 条）；请求策略字段校验（范围、claude effort 闭集、
                             # Header 名禁引号冒号、环境变量名 POSIX 字符集）
  global_config.rs           # 「设为全局默认」：agent 级事务批次写入（备份/回滚/恢复）；写成功即记
                             # settings.active_global_profiles（配置页「全局生效」徽标数据源），恢复后清除；
                             # 恢复分两档——撤销上次写入（UI 名；最近批次，每 tag 轮换留 5 份）与恢复初始状态
                             #   （backups/<agent>/original/ 永久快照，首次 apply 时落、不参与轮换，
                             #   has_original_backup/restore_original_backup）；
                             # codex 轻量注册 codex_register_client_provider：只写 config.toml provider 定义块
                             #   （顶层 model_provider/model 不动、不记 active_global）；认证与「设为全局」
                             #   共用 experimental_bearer_token（ChatGPT 自带 Codex 的 ModelProviderInfo 认这个字段），
                             #   **不写 auth.json**，也不写 http_headers（MCP 字段，写在 provider 上客户端加载失败报 not found）；
                             #   requires_openai_auth = false；写块时清掉旧 env_key / http_headers；
                             #   逆操作只删定义块；codex_client_registered_profiles 供连接页菜单同位状态化；
                             # gemini 双文件：.env 之外必须加写 settings.json 的 selectedType=gemini-api-key
                             #   （v3.147 审计：缺它 gemini ≥0.46 headless auth 报错起不来，JSONC 容错读），
                             #   并登记 modelConfigs.modelDefinitions 让自定义模型进 /model 选择器
                             #   （experimental.dynamicModelConfiguration 开关，requiresRestart，只写不删）；
                             # qwen 条目级 generationConfig.samplingParams（snake_case 线格式，逐模型取值；
                             #   配了就跳过 CLI 的 max_tokens 自动钳制）；
                             # kimi 的 [models.*] 随写 display_name（配置名·模型，选择器 label 优先它）
                             # 与 capabilities（按注册表组合 tool_use/thinking/image_in，仅新版变体）；
                             # grok（2026-09-01 起）写 ~/.grok/config.toml：顶层 api_key + [endpoints].models_base_url +
                             #   [models].default 与请求策略全局默认（通用键只设不删，防误清用户手写值）；
                             #   绑定设了「API 后端」或权威层确知上下文时逐模型写 [model.<id>] 段
                             #   （api_backend/context_window/name；段键 = 目录模型 id 自动加引号）——api_backend
                             #   在 Mesa 侧的唯一通道（overlay 白名单不放行 [model.*]）
  projects.rs                # 项目档案卡（§11.3）：project.toml 读写、注册、资源登记/发现、一键开步、append_workspace_inbox、
                             # 稳定项目身份（档案卡顶层 `id` 跟随文件夹；register_at 同一 id 新路径 = 移动重连
                             # 改路径不建新行；write_config_at 保证卡片带 id；list 回填旧行）、
                             # update_step_skills（步骤推荐技能读-改-原子写）、append_pipeline_steps（从模板追加：重名跳过、全跳过不落盘、
                             # 追加成功自动清 pipeline_opt_out）、set_pipeline_opt_out（「不使用研究流程」显式标记读-改-原子写）、
                             # 任务书草稿（read_task_draft/append_step_draft，
                             # .ccode/drafts/）、旧简报一次性并入草稿（list_legacy_briefs）、
                             # 任务卡 kind（idea/draft，旧卡按 step 推断）、fuse_card_into_draft（想法卡会话 ×
                             # 当前步骤草稿 → AI 融合稿，出站 redact_and_cap 不写盘）+ write_task_draft（确认后整份落盘）、
                             # update_lit_watch_filter（雷达筛选读-改-原子写，全空归一 None）、
                             # 验收接受账本（.ccode/acceptance-log.jsonl append-only，按 run_id 去重幂等；
                             #   目标页只读展示最近若干条；task_list 默认不含归档，task_unarchive 恢复）
                             # project-status.json 只是其「最近摘要」投影；目标删除不动账本与摘要）、
                             # 项目移除三档（移除注册 / purge_project_traces 清除 Mesa 痕迹保留文件夹 / delete_project_dir）
  project_memory.rs          # 项目知识 .ccode/memory.md：结构化块只记人工确认（revision 比对 + active/superseded/revoked 状态机；
                             # 作废/替代条目不注入，Agent 结论不自动采纳；原文历史保留并留备份）
  pty.rs                     # PtyManager：spawn_tracked 公共拉起，agent/shell 复用；
                             # pty_report_terminal_colors = Windows 底色告知（win32-input-mode 记录逐条投递，
                             #   条间 2ms；ConPTY 双向吞 OSC 的实测结论见 conventions/terminal.md，别改回 OSC）
  pty_input.rs               # 每个终端独立的有界输入队列：一个不读 stdin 的 CLI 不得占住 PTY 全局锁
  clipboard.rs               # 剪贴板图片落盘（save_clipboard_image）：<config>/ccode/tmp/paste-* 白名单扩展名 +
                             # 50MB 上限 + 每次顺带清理 7 天前残留（机制约定见 conventions/terminal.md「输入侧」）
  sessions.rs                # 会话浏览：九 agent 会话扫描/解析（Codex .zst、OpenCode SQLite/JSON）、session_meta、pin 快照、
                             # 会话删除、注意力分类（session_tail_state）、步骤名映射（RX3a）、
                             # codex rollout 元信息 model_provider 记进 SessionMetaDto.provider（恢复按它挑兼容 profile，
                             #   前端 pickResumeProfile 单一出处：ccode 或 ccode-<短id> 前缀按网关挑绑定）、
                             # sessions_for_card（融合进任务书的按卡取会话：与列表同一归属口径）；
                             # 无头 AI 按 session id 标 session_meta.internal（雷达解读/定时巡检不进本项目会话，
                             # 禁止把项目路径写入 usage_provenance.internal）
  session_search.rs          # 会话正文搜索：多关键词按「命中多少 + 落在哪」打分、同分按更新时间；正文不进前端
  session_transfer.rs        # 会话包导出/导入（.ccode-sessions.zip，八家不含 opencode）：原文打包装、导入时改写 cwd 并按 B 机
                             #   目录重建落位；zip-slip/大小/后缀/白名单；同 id 跳过不覆盖；Mesa 元数据写 app.db；
                             #   kimi 新版 wd_<basename>_<sha256[:12]> + session_index.jsonl；grok URL 编码 cwd
  skills.rs                  # 技能库（§6.13）：SSOT 库 + symlink/copy 分发（cursor/grok 固定 copy）、四路导入、ZIP 导出、卸载备份、
                             # 漂移检测 resync、create_skill/update_skill_content；apps 表是创建时快照，
                             #   list 时现算补齐注册表新 agent 的缺键（否则一键应用永远漏新 agent，不写盘）；
                             #   contentDigest = 库目录清单哈希（与漂移检测同口径），项目上下文/执行快照按它记技能版本；内置技能种子（seed_builtin_skills：
                             # include_str! 内嵌 src-tauri/resources/skills/ 18 个技能，启动幂等播种，不覆盖/不复活用户改动；
                             #   删除内置技能先落逐技能墓碑 .builtin-skill-tombstones（删除失败也不留「删了没记」），
                             #   种子版本升级补播跳过墓碑项——墓碑机制前的老删除靠 skill-backups 同名备份回填墓碑）、
                             # 内置技能更新（check_builtin_skill_updates 种子逐字节比对 + apply_builtin_skill_update
                             # 覆盖前备份 SKILL.md.bak-<yyyymmdd> 后原子写入）、技能接口契约（frontmatter inputs/outputs
                             # 解析进 SkillDto，list 时现算；外部技能未声明时 infer_interface_from_body 正文推断兜底、
                             #   打 interface_inferred 标不回写；前端 skill-conflicts.ts 判定产物冲突 + 跨步骤链路
                             #   （skillChainWarnings：inputs 找供给/outputs 对账预期产物）+ StepSkillsChips 警告行）；
                             # ◈ 适配到流水线（adapt_skill_to_pipeline 出稿 FN_DISTILL + build_adapt_prompt 规范路径表
                             #   单一出处 → write_skill_md 确认落盘，name 强制沿用库中条目；update_content_impl
                             #   interface=None 时保留已声明 inputs/outputs 不静默丢弃）；
                             # 技能内容红线（2026-08-20 社区对标批量升级后确立）：单文件轻量规范（~100 行内，禁脚本/JSON 中间件/lint 体系）、
                             #   产出文件名与流水线接口（TASK.md 内联口径）不动、升级后同步 cp 进技能库（种子改完库不追平，见种子更新机制）；
                             # 删除保护（2026-09-03）：来源口径 = source 字段单一出处（builtin/ccode/local/zip/github/discovered，
                             #   ccode 为 create_skill 后加，旧自建记 local 无法区分、前端 fail-safe 按非自建提示）；
                             #   删除弹层（SkillsPage DeleteSkillModal）列影响面 + 内置不复活警告 + 导入来源，
                             #   delete_impl 先备份库目录进 skill-backups（留 5 份）再卸载；纯逻辑在 src/skill-delete.ts
                             #   （tests/skill-delete.test.ts）
  mcp_blender.rs             # Blender 官方 MCP 本机安装探测（只读：Blender 版本/插件文件/uv/仓库/TCP 9876）
  mcp.rs                     # MCP 清单与分发（§6.15，规格 matrix §10）：统一模型→八家映射（grok 只读）、读-改-写一个键/段 + 备份 +
                             # 原子写 + 读回校验、JSONC 容错读、密钥引用转写（不落明文；引用值可存 mcp-keys.json，启动/体检注入）、stdio 裸命令名 resolve_binary
                             #   绝对化 + node shim 深化、相对路径命令拒写（跨 agent 必挂，报错引导改绝对路径）；
                             #   全局启用开关（enabled 字段：停用=移除各 agent 条目但保留 apps 映射，重开按原样重投；
                             #   停用期间编辑/拨开单 agent 开关只更新清单记意图，不动 agent 配置）+
                             #   连通性检测 check_mcp_server（stdio 拉起 initialize 握手 / remote POST 探活，每次尝试 8s 上限；
                             #   stdio 帧格式自适应：先发规范的 NDJSON 换行帧，server 秒退/首帧非法/超时再换
                             #   Content-Length 头帧重试一次，回包读取器两种帧都认；
                             #   env/header 的 $VAR 引用检测时先查 mcp-keys.json 再查宿主环境（scan_env_refs 整值+内嵌同口径）；
                             #   结果带 status 细分闭集 handshake/reachable/auth/not_found/error——401/403/404 判失败）；
                             #   明文密钥安全闸（审计收口 2026-09-08）：保存/粘贴导入/分发一律拒绝，只接受 $VAR 引用，
                             #   历史明文条目不删不崩但编辑/分发被拦至改成引用，移除方向不拦；
                             #   重命名受保护迁移（新名写好后移除各 agent 旧名条目）；
                             #   codex stdio env 改名引用（TARGET=${SOURCE}）明确拒写；
                             #   origin 来源标记（ccode/imported:<agent>/imported:json，空串=未知按收编对待；
                             #   收编条目删除默认仅从清单移除 keep_agent_configs，不动 agent 配置）；
                             #   外部状态同步 mcp_distribution_status 五态（off/ok/modified/missing/disabled_externally，只读、
                             #   探测失败按 ok 不报警；disabled_externally 仅 codex/grok 的 enabled 键与 codebuddy
                             #   disabledMcpServers 三家实证产出，codebuddy 分发/移除时顺带自清名单本条目）；
                             #   批量体检 check_all_mcp_servers（分波并发每波 4 个、一次性返回）+ 结果沉淀 last_check
                             #   （读-改-写只动该字段、编辑保留旧值）+ stdio 启动超时 startup_timeout_ms
                             #   （clamp 8s–30s 只被体检消费，收编 codex/grok startup_timeout_sec 带入）+
                             #   $VAR 预检 mcp_missing_env_refs（只读，前端保存/分发前非阻断警告）；
                             #   相对路径命令（./ ../ 开头）先解后拦（resolve_relative_candidates：基准序 = 条目绝对
                             #   cwd → 来源 agent 配置家目录 → 实证插件目录（仅 codex computer-use/plugins），收编/导入
                             #   命中存绝对路径 + cwd 规范化、不命中 fail-open 收进清单，分发试解失败才拒写）+
                             #   命令路径探测 mcp_command_path_status（ok/relative/missing 闭集，$VAR 引用不判）+
                             #   resolve_mcp_command_fix 一键修复候选（origin 推断来源 agent）
  usage.rs                   # 用量统计（§6.11）：usage 事件提取、usage_daily 按天聚合、任务成本归因、订阅口径、
                             # session_usage 单会话聚合（终端状态栏 token 段，先增量索引再按 session_id 汇总）；
                             # usage_trend / top_sessions：花费折线与最贵会话均跟随页顶范围，官方账号与 internal 不计费不进榜，
                             # 自定义标题出站前过 redact_sensitive_text；总额卡与折线/榜单同一计费范围，
                             # 官方/internal 的 token 量单列展示不计费（v3.255）；
                             # provenance v7 起按会话级登记（official 用启动 hint/恢复目标写 session_id 行，
                             #   启动时不知 id 的 agent 由重建索引按 session_meta.profile_id 解析认证方式兜底；
                             #   旧项目级行只回填 created_at 之前已存在的会话，不粘住新会话）；
                             #   session_meta.internal（无头 AI/定时巡检按会话 id 登记）纳入用量索引；
                             # 定价链 PriceChain 三层：用户 pricing.json > 公共能力库 cost > 内置表 BUILTIN_PRICING
                             #   （高层任意前缀命中即胜、同层最长前缀优先——用户写短前缀即覆盖低层细分代；
                             #   内置表口径 2026-08-31 各官方页，跨代改价给新代加更长前缀、旧价留给老会话归属）
  subscription_quota.rs      # 订阅余量查询（用量页「订阅余量」卡，多供应商一张卡可切换，2026-09-19）：
                             #   智谱 / Kimi For Coding / MiniMax 三家（火山方舟未接——控制面 OpenAPI 需 IAM AK/SK
                             #   签名，与网关单密钥模型不符，待网关加 AK/SK 字段后单批做）。
                             #   智谱额度 GET /api/monitor/usage/quota/limit（limits[] type∈TOKENS_LIMIT|CREDIT_LIMIT、
                             #   unit 3=5h/6=周锚定禁按重置时间排序、percentage=已用；cc-switch/CodingPlanQuota 口径）+
                             #   重置卡 GET|POST /api/biz/customer-package-reset/{list,use}（OmniRoute 口径：信封
                             #   success+code∈{0,200} fail-closed、双桶截断不当 0 张、code 1001=密钥失效、
                             #   卡条目多别名 + status consumed/redeemed/… 不可用 + 无时区时间戳分区域：bigmodel.cn 北京时间 +8（用户官网比对实测修正）、z.ai UTC；
                             #   DTO 暴露每类最早过期时间（临期提示 + use 优先消费最早过期的卡））；
                             #   Kimi GET api.kimi.com/coding/v1/usages（limits[] 多模型 5h 窗取 utilization 最紧、
                             #   usage=周窗、used=limit-remaining）；MiniMax GET /v1/api/openplatform/coding_plan/remains
                             #   （general 条目、字段是剩余百分比要反转、周桶仅 current_weekly_status==1）；
                             #   重置卡仅智谱支持（DTO reset_cards_supported，其余家不渲染该行）；
                             #   团队版 = 网关 headerEnv 带 bigmodel-organization/project 隐式识别（?type=2 + 两头）；
                             #   Bearer 鉴权（裸 key 亦通，智谱两者都认）；密钥只在 Rust 层出 keys.json 绝不进 DTO；
                             #   用卡（plan_use_reset_card）是消费性写操作——显式命令 + 前端确认弹窗，成功作废缓存；
                             #   2 分钟进程内缓存（对齐用量页可见期自动轮询，页面不可见即停）+ 瞬时失败回落上次成功值
                             #   标 fromCache；无后台轮询；不注出网代理
  pricing.rs                 # pricing.json 读写与校验（定价链最高层，原子写）
  settings.rs                # 应用设置（settings.json）：字体/scrollback/渲染器（terminal_renderer：auto/dom/webgl，Mac 默认清晰、Windows 默认流畅，读时闭集过滤）/汇率/镜像/主题/OS 通知/精确注意力
                             # （hooks_attention 按 agent map，旧 claude_hooks_attention 仅反序列化兼容迁移）/想法期只读保护
                             # /底部状态栏统一开关（status_bar 默认开，终端/聊天两层同进退；关 = 都不渲染，
                             #   切层不改终端行列数，invisible 占位机制退役；旧 status_bar_in_chat=false 读时迁移为关）；
                             # terminal_color_report 默认开（Windows：ConPTY 吞掉 OSC 底色查询，浅色主题下
                             # 主动把前景/底色推给 gemini/qwen；白名单外的 agent 推了会变输入框乱码，
                             # 见 docs/conventions/terminal.md）；
                             # hidden_profiles = 软停用（自动路径跳过、手动可用；v3.142 起不再是纯展示偏好）；
                             # active_global_profiles = 「设为全局」追踪（agent→profile id，record/clear_active_global
                             # 维护、不走 patch、clear_profile_refs 同步清引用；只代表「上次由 Mesa 写入」非绝对生效态）；
                             # outbound_proxy = 出网代理（注入官方账号启动与组头登录；2026-09-19 起下载侧同源注入——
                             #   agent 安装/更新、依赖安装、字体下载走 download_proxy_env（大小写成对，curl 只认小写 http_proxy），
                             #   更新检查的 npm view/brew info 同注；国内镜像主机（TUNA/南大 ghcr）并入 NO_PROXY 直连不绕代理；
                             #   用户环境已带任一代理变量时不覆盖。网关启动仍不走；extra_env 同名键覆盖；校验 http(s)/socks5，空串清除）
  hooks.rs                   # 精确注意力标记（七家 hooks 桥接）：BRIDGE_SPECS 每 agent 一张桥接规格（claude/qwen/
                             # codebuddy/gemini/kimi/grok/codex；cursor 无「等待确认」等价事件、opencode 无 shell hooks
                             #   形态，两家未接入），写各家 hooks 配置（备份留 10 份 + 原子写 + marker 合并/移除 +
                             #   损坏拒写；grok 整文件归 Mesa、外来文件拒覆盖），机制调研录 matrix §12；
                             # 事件日志解析双信封（snake_case/camelCase）+ 事件名去下划线小写归一 + grok Stop 只认
                             #   reason=end_turn + 会话归属双键匹配（session_id==文件主名 或 transcript_path==完整路径），
                             #   10 分钟 TTL 回落尾部推断不变；settings 字段 hooks_attention: map<agent,bool>
                             #   （旧 claude_hooks_attention 仅保留反序列化兼容迁移）；
                             #   session_confirm_detail（2026-08-24）：confirm 时从 payload 提取「在等什么」摘要
                             #   （message/tool_name/title 尽力而为），聊天层审批卡片用
  inst_access.rs             # 机构访问通道（2026-09-16）：人登录一次、系统复用会话——登录窗（Tauri WebviewWindow
                             #   label=inst-login）Cookie 落 0600 inst-session.json（值绝不出站，状态 DTO 只有
                             #   域名/条数/时间）；EZproxy/OpenAthens 前缀 ?url= 改写（settings institutional_prefix，
                             #   书签式前缀自动剥尾部 url=）；DOI→合法开放副本查证（Unpaywall best_oa_location
                             #   .url_for_pdf 优先、OpenAlex 回落）；落地页 citation_pdf_url meta + 常见 PDF 链接
                             #   形态提取；fetch_via_session 手动逐跳跟重定向（每跳按 host 重算 Cookie 头）。
                             #   硬边界：不存机构账号密码/不做无人值守自动登录；scheduler/无头不携带会话；
                             #   只由人 UI 逐篇触发（lit_watch::fetch_paper_fulltext 阶梯调用），不做批量。
                             #   登录窗轮询走独立线程（Windows cookie API 在主线程同步调用会死锁）。
                             #   窗内 PDF 落盘走**单一下载漏斗**（2026-09-16 终局，勿再加拦截层/页→本机回传）：
                             #   builder 注册 on_download（Requested 把落点改写 <config>/ccode/tmp/inst-dl/、
                             #   Finished 按 url→落点 map 对账读文件 → %PDF- 魔数校验 → 多槽暂存（唯一文件名，
                             #   inst-pdf-relayed → App 层 inst_save_relayed_pdf 落 papers/）；页侧 LOGIN_INIT_SCRIPT
                             #   常驻 ⤓ 胶囊（2s 周期重检直链）+ __mesaGrab（a[download] 按钮 → 合成
                             #   a[download] 走 WKDownload → fetch 魔数校验）；点 /doi/pdf/ 拦住改保存
                             #   （WKWebView 内联 PDF 无保存入口）；/doi/epdf/ 放行（Wiley/ACS 阅读页）；
                             #   直链存成网页则改开阅读页。on_navigation 拦 pdfish 后 Rust 用窗口会话直拉（绕过
                             #   页内 CORS，MDPI 的 mdpi-res.com 等 CDN），失败再回落页侧 grab；about:blank
                             #   document-start 刷浅底防开窗黑屏。wry：download 属性走下载委托、application/pdf
                             #   主框架导航被内联渲染——结论记 pipeline.md「机构访问通道」。
                             #   ScienceDirect（2026-09-16 晚）：不放 citation_pdf_url、PDF 链接是 PII 路径不含
                             #   DOI（通用探测两条路全落空）、View PDF 是 JS 弹层按钮——mesaSdPdfUrl 三级
                             #   （#pdfLink href → 内嵌 JSON pdfDownload.urlMetadata token 直链 → 按 PII 构造
                             #   /pdfft?download=true）；**SD 终局（三形态实测 + wry 源码）**：下载式请求
                             #   （a[download]/WKDownload action）被回 HTML、普通导航被 wry 内联渲染白屏
                             #   （wry navigation_policy_response 只看 canShowMIMEType、无视 Content-Disposition）、
                             #   blob 下载 Finished 挂起——唯一通道 = 页内 fetch 取字节 + mesaChunkRelay
                             #   分片回传（块长 61440=3 的倍数——65536 时非末块 btoa 自带 == 填充、拼接
                             #   解码必挂；先 mesa-chunk://b/{total} begin 握手、Rust 只收握手后 60s 内
                             #   块数吻合的分片，逐块解码；mesa-chunk://c/{seq}/{total}/{b64} 合成锚点导航，
                             #   Rust on_navigation 收片取消导航，不受 CSP/混合内容限制；收齐解码校验走既有
                             #   inst-pdf-relayed 入库链；Zotero Connector 页内取字节带外送回的 webview 等价物）；
                             #   胶囊创建即上文案（空胶囊=黑圈）；View PDF 命中后 closest('a[href]') 沿祖先找
                             #   href、未检出直链 1.5s 宽限重测。SD 交互终态（用户拍板「进 View PDF 再下载」）：
                             #   SD 页面不拦 View PDF（mesaIsSdPage）、grab 不点站方下载控件——让站方阅读器
                             #   打开，mesaPdfUrl 内嵌扫描（iframe/object/embed）取 PDF 地址走分片回传。
                             #   页侧通用分型层（同日深夜，按清单出版商收口，只加失败救援不动已通路）：
                             #   mesaVerifiedGrab 验证式抓取（同源 pdfish 先 fetch 验明正身，验明后对真实 URL
                             #   合成 a[download] 走 WKDownload——**禁 blob→a[download] 落盘**：macOS 上
                             #   Requested 后 Finished 挂死（20:33 实测），__mesaDownloading 有 90s 看门狗；
                             #   HTML 中间页由 mesaIntermediaryNext 解析 meta refresh/redirect-message/
                             #   iframe·embed·object 内嵌 pdfish 再取，≤3 跳；Wiley/ACS 型 /doi/pdf/ 经
                             #   mesaViewerUrl 非空跳过）；mesaPdfUrl 第二遍单链采用（RSC articlepdf 只带
                             #   DOI 后缀/IEEE arnumber 不含 DOI 前缀——文章页全页唯一 PDF 链才用）；
                             #   Rust got-html 回救 __mesaGrabVerified（拿到网页时页侧解析重试，Wiley 型仍走 epdf）。
                             #   出版商分型纪律（用户指令，勿顾此失彼）：每家期刊 PDF 供给形态不同（已实证
                             #   通用meta/DOI内链/Wiley-epdf/MDPI-CDN直拉/编号链(RSC·IEEE)/中间页(SD·IEEE)/
                             #   SD复合/签名直链八型），为一家修问题只动该家命中的最窄分支、禁改通用路径，
                             #   收尾逐一回归各型——细则见 pipeline.md「机构访问通道」⑦。
                             #   收货通道 A/B/C（同日深夜用户定稿「让真实浏览器干浏览器的事」，Mesa 只收货）：
                             #   A download_inbox.rs 监听 ~/Downloads 收 PDF（inst_browser_open 调起系统浏览器
                             #   + 登记归属，六层过滤链收货进既有入库链——高置信命中收完进回收站、
                             #   兜底关联（文件名没对上号）原件留在下载夹并弹 inst-pdf-attention 横幅；
                             #   终端只印启动/失败/收货结果，不去重跳过刷屏——macOS 一次落盘连发多条
                             #   FSEvent）；B 浏览器会话复用
                             #   （设置页「学校图书馆」主路径「登录学校账号」，内嵌窗留回落）；C extension/（MV3，ID 固定
                             #   dmjplopfhbdamkihimfllomdmkfainnn）+ bin/mesa_helper.rs（native messaging，读 helper-context.json
                             #   当前项目+打开篇标题/DOI 调 ccode_lib::helper_ingest；PDF 阅读器空标题不得落 paper-5.pdf；
                             #   工具栏图标优先走页内「存到 Mesa」，chrome.downloads 只作无 content script 末路）
                             #   + browser_bridge.rs（装 NativeMessagingHosts
                             #   清单）。内嵌窗漏斗保留为过渡，通道 C 稳定后退役——细则见 pipeline.md ⑧
  fonts.rs                   # 终端字体打包与 brew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层：一次性 prompt + 提交信息/摘要/PR 描述/冲突建议/提炼接力简报/评审沉淀起草生成；
                             # resolve_profile_from 最近使用回落跳过官方账号（OAuth 过期会甩 CLI 日志；显式/专用仍尊重）；
                             # 失败走 summarize_headless_error，不把 stderr 整段回给前端；401 invalid_api_key 按
                             #   「报错 URL host × 绑定 base_url host」细分：发去 api.openai.com 而配置是网关 = 渠道路由错
                             #   （引导重设全局默认），网关自己拒 = 密钥错（引导重填），该判定必须先于 401+unauthorized
                             #   归官方账号失效的笼统分支；
                             # headless_task_args/run_agent_task 供 scheduler 复用（定时任务要写项目文件，codex 用 -s workspace-write）
  scheduler.rs               # 定时雷达（v3.75；v3.79 起技能可选；v3.218 新建巡检技能：草稿 .ccode/drafts/watch-*，确认才入库分发）：
                             # schedules.json（每日/每周+时分，本地时区）、60s tick + 启动补跑
                             # （漏跑 coalesce 只补一次）、无头拉起 agent 在任务隔离 worktree 跑技能（先从主仓播种订阅/台账；项目根只用于归属与采纳；非 Git 项目明确失败；显式 sentinel 才允许主仓写入；人点「采纳进主仓」才拷产出；默认 lit-watch，prompt 按技能分派：
                             # lit-watch 专用文案不动、其他技能通用模板，非 lit-watch 跑前检查已分发，10 分钟超时）、
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
                             # 口径见 conventions/pipeline.md「雷达筛选」）；
                             # 快筛解读落 `.ccode/watch-explains.json`（规范化标题去重，list 出口挂 WatchEntryDto.explain，
                             # 不写 inbox.md）
  journal_metrics.rs         # 期刊指标表（雷达徽章数据源）：config_dir/ccode/journal-metrics/ 下 JCR2025-UTF8.csv +
                             # FQBJCR2025-UTF8.csv（来源 github.com/hitfyd/ShowJCR，用户本机下载、禁内置分发）合并成
                             # HashMap（normalize_title 规范化精确匹配，miss 时剥末尾出版商括号尾巴（「(Wiley)」「（ACS）」可多级）
                             # 重试，仍 miss = None 不虚构；前端 lit-watch.ts sourceDisplayName 同口径剥尾，两处同步），RwLock 进程内缓存；
                             # list_watch_entries 出口 enrichment 进 WatchEntryDto.metrics（展示时现算不落 inbox.md，
                             # 旧条目装表即生效）；download_journal_metrics（jsDelivr→raw 回落、.tmp 原子落盘、完清缓存）+
                             # journal_metrics_status（含 downloadedAt：两份 CSV 取较新 mtime）+ check_journal_metrics_update
                             # （GitHub commits API 按数据目录查最近 commit，与本地 mtime 比对出 hasUpdate，前端静默失败）
  research_quality.rs        # 科研复现运行记录与验收决定：独立输出 ~/ccode/reproductions/；验收写 .ccode/research-acceptance.json，不替代 Git 合并
  research_tools.rs          # 科研外部工具开工 preflight（research_tool_preflight）：Zotero 本地通道 / Origin 平台门槛
                             #   （只做 Windows 实机，非 Windows 必需技能=阻塞）/ Blender 探测 / EndNote 桥；
                             #   只探测，不安装、不写个人库、不启动 GUI
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
  runs.rs                    # 一次干活身份（app.db runs 表）：交互 pty_spawn 必有 id，无头 internal；
                             # 关标签不删行；收件箱 action.run 可恢复；登录标签不建行；
                             # Run 可以没有 Goal（2026-09-09，§4.7）：scratch/reader/办公文件闲聊
                             # task_id 落 NULL，不再 ensure_task_at 强制登记；自动登记只留
                             # pipeline_step/coding_lane/watch（run_needs_task）；
                             # 普通目标开工写评审基线（写失败即开工失败）、收尾触发冻结、
                             # 预览/采纳绑定冻结快照（失败清理只删本次新建目录 cleanup_failed_prepare）
  runs/goal_storage.rs       # 普通目标副本的显式清理：归档、项目成果与接受账本不在删除范围（两步各需确认）
  task_review.rs             # 普通目标评审证据（规格 conventions/review-freeze.md）：开工基线哈希、
                             # 收尾冻结 payload 副本（拒绝改写）、采纳三向判定（项目现读 vs 基线 vs 冻结内容，
                             # 删除永不写回、>64MB 不自动采纳）；纯文件事实不碰数据库，编排在 runs.rs
  custom_runtime.rs          # 自定义 Runtime：用户登记命令，直接在已校验的隔离目录中运行；相对路径拒写；无密钥/会话/MCP；不支持恢复
  coding.rs                  # 编程项目 git 原语：worktree list / 从基准或已有本地·远程分支建树（~/ccode/worktrees）、
                             # origin 身份 + 相对上游 behind、fetch / pull --ff-only / push、合并进基准、
                             # Desktop CLI 打开该树 / gh --web 开 PR（CodingOpDto；不走科研工作区库）；overview 按树/分支并行 git
  workspaces.rs              # 任务工作区（§6.10）：worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT、
                             # setup/archive 钩子、评审合并（health/merge/PR）、artifacts.yaml、
                             # 人工事项状态（human_task_checks 勾选 + human_target_hit 落点检测 + human_target_count 命中计数/to-fetch 清单计数——
                             # 计数口径与前端 step-flow.ts parseToFetchItems 双端镜像：编号/列表行都算，裸行须带「 — DOI」尾巴，说明行与「待补」不算）、import_human_deliverable
                             # 交付导入（复制落点 + 登记提货单；v3.74 起 step/title 可选 + target_override 固定落点，
                             # 无步骤语境 = papers/imports/ 检索结果导入落主仓）、list_help_requests（.ccode/help-wanted.md 人工请求扫描）
  portwatch.rs               # 端口监控：LISTEN 列表、归属标注（cwd 最长前缀，回落 CCODE_PORT 段）、校验后 SIGTERM
  ws_settings.rs             # .ccode/settings.toml 三层合并（用户→仓库→local）；开步自动写 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk/勾选提交临时索引；
                             # MERGE_HEAD → merging + git_abort_merge；porcelain 冲突码归 U
  fs_tree.rs                 # 文件树与文件操作（删除走系统回收站 trash；重要路径删除保护，canonicalize 双校验；
                             #   家目录直下系统目录标 isSystem 供前端置灰）
  pdf.rs                     # PDF/docx 字节读取：read_pdf_bytes 白名单 + canonicalize + 上限，base64 传输
  sheet_preview.rs           # Excel/ODS 预览：同一套白名单读字节，calamine 抽指定工作表（200×256）+
                             #   xlsx 合并区（load_merged_regions，裁进窗口）
  storage.rs                 # 本机文件持久化原语：跨进程读改写锁、私有临时文件（0600）、安全替换
  updater.rs                 # CLI 安装/更新（brew TUNA、npm_for 同目录 npm、Windows winget 渠道：claude/codex/opencode/kimi/grok 五家有官方包）+ 应用自身 Tauri updater；
                             #   run_streaming_pty/run_streaming/emit_done/winget_args 为 pub(crate)，dep_check 复用同一管线
  watch_review.rs            # 定时巡检产物评审：工作目录可复用，但评审和采纳只读每次执行冻结的副本
                             #   （基线文件 + 技能产出契约，与 task_review.rs 同构不合并）
  dep_check.rs               # 依赖体检 + 一键安装（git/node，非九 CLI 本身）：check_dependencies（git 三态 ok/missing/
                             #   clt_stub + node + 渠道 brew/winget/xcode/none，启动时前端拉一次进 store）+ install_dependency
                             #   （macOS brew 优先、无 brew 时 git 触发 xcode-select --install 系统弹窗不等待；Windows winget
                             #   Git.Git/OpenJS.NodeJS.LTS；Linux 只给指引）；缺 git 走收件箱 dep: 类别常驻提醒（不造横幅）
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
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Mesa` 必须显式设置。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。
- **gitignored 科研产物最终落点是项目根，但分两类走法**（2026-09-09 口径 C）：文献 PDF 与人工导入属**原始资料**，直写项目根 `papers/`；清洗后数据、实验结果、渲染成品等 **Agent 派生产物**写工作区产物目录或 `output/`（不进 git），评审时经 `workspace_review_deliverables` 冻结非 Git 文件，合并只由 `apply_delivery_review` 带回所审副本（同名冲突点名交人、保护路径跳过；有未接收产物不得归档）。派生产物直写项目根 = 未验收产物。TASK.md 必须给出项目根绝对路径（读提货单、写 papers/）。
- **Codex 全局写入不碰 `~/.codex/auth.json`**（v3.249 / v3.250）：「设为全局」与「注册到客户端」都只写 `config.toml` 的 provider 块，认证用 `experimental_bearer_token`（ChatGPT 自带 Codex 认这个字段）。禁止写 `http_headers`（MCP 字段，写在 provider 上客户端加载失败报 Model provider not found）。禁止退回 `requires_openai_auth=true` + 改 auth.json。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作（设为全局默认、hooks 精确注意力开关（七家，见 hooks.rs）、会话删除、工作树文件删除、**会话导入**——
  工作树文件删除走系统回收站（trash crate）可反悔；五类均有备份/白名单防护口径，见 `docs/conventions/safety.md`）。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底；新增 CLI/工具调用点一律
  用它，禁直接 `which::which` 或裸名 spawn（候选目录清单见 `docs/conventions/safety.md` 对应实现 `agents.rs`）。
- **发版版本号三处同步**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 的 `version` 必须与
  git tag `vX.Y.Z` 的 `X.Y.Z` 一致（CI package job 会拦）。Tauri updater 只比较 `tauri.conf.json` 版本与
  `latest.json`，不认 git tag / architecture 决策号；不 bump 则已安装用户永远看不到「可更新」。内部决策记录
  （v3.x）不是应用版本。有可用更新时提示走收件箱 `update:`（不造顶部横幅、侧栏不挂徽标），设置页「更新」分区
  是安装入口。
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
| 编程 Git / GitHub | `docs/conventions/coding-git.md` | **改编程页 git 前必读**：工作树 vs 主仓 vs GitHub Desktop、从基准开工、远程身份、PR 环、不做任意 git 命令框 |
| 多 Agent 工作台对象 | `docs/conventions/agent-workbench.md` | **改工作台/并行/无头/Runtime 前必读（v3.221 定稿；第 0–3 期核心路径已落地）**：Project→Task→Run、编程车道、RuntimeKind、禁止自动拆工；定时任务默认隔离 worktree；非 Git 项目失败 |
| 步骤工作面板 | `docs/conventions/step-panel.md` | **新增步骤/模板前必读**：七条硬规则（顺序即语义、空节点不出现、同一事实只说一次、孤立按钮、主路径唯一、显式决策契约门控、角色标注）、问题该在什么时刻与层级出现（项目层/决策项/按需问/种子/人工事项五选一）、文案与术语、新增模板检查清单 |
| 主题与设计系统 | `docs/conventions/design-system.md` | 主题令牌、字体栈、线条语言、控件密度、页面框架、对话页三栏、步进器规格、已否决设计 |
| 网关与绑定（配置模型层） | `docs/conventions/profiles.md` | **改配置/注入/设为全局/模型能力/托盘前必读（已落地）**：网关×绑定拆层、binding id 复用、provider 派生名、relay 缓存键、求交器、体检与通道表不对称、迁移合并 |
| 普通目标评审冻结 | `docs/conventions/review-freeze.md` | **改普通目标开工/收尾/评审/采纳前必读（2026-09-09 落地）**：开工基线哈希、收尾冻结 payload、采纳三向判定与删除/大文件/旧 Run 口径 |

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
  主线 + 白话翻译：✓ 保存进项目/⚙ 自动保存/◔ 保存）、**hooks 精确注意力标记 ✅**（设置页按 agent 显式开关，
  hooks.rs 七家桥接；v3.32 Claude 首发，v3.99 推广到七家，见架构 v3.32/v3.99）、**内置技能种子 ✅**（当前 18 个内置技能，include_str! 播种、不覆盖不复活，
  六套流水线模板按步骤挂载）、**定时雷达 ✅**（v3.75：scheduler.rs 每日/每周无头巡检 + lit-watch 多源精选升级，
  约定见 conventions/pipeline.md「定时雷达」）、**模板重设计与接壤 ✅**（v3.78：六套模板内容重设计（种子对准拍板点/技能挂载核对/
  学术 MCP 人工事项）+ 产物路径接壤（投稿与返修接综述/科研论文成稿）+ 编辑器「＋ 从模板追加」）；批量验收、云端会话双源调研留 backlog
- **Backlog（记录不动手）**：SSH 远程执行、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（✅ 已落地为
  沉浸阅读区，v3.96）、批量验收、云端会话双源调研、首启引导完整版（示例课题最小版已落地：工作区空态「✦ 创建示例课题（演示）」→
  `create_demo_project`，演示 PDF/引文/综述流水线齐备；完整版引导的更丰富演示数据留 backlog）、工作区类型驱动默认值（数据类跳端口）

**当前待办**：

- **架构审计基线（2026-09-09）**：`docs/audits/architecture-audit-2026-09-09.md` 记录了
  「执行/结果/验收/项目状态未分离」十大问题清单。**P0 全部落地**：§4.3 复用目录误删修复、
  §4.2 评审冻结（开工基线 + 收尾冻结 + 采纳三向判定，`docs/conventions/review-freeze.md`）、
  §4.5 接受记录长期化（`.ccode/acceptance-log.jsonl` 账本）、§4.1 写入政策统一为口径 C
  （派生产物写工作区、评审合并带回主仓、冲突点名；文献 PDF/人工导入直写项目根；编程合并补
  protected_paths 检查，见 pipeline.md「合并带回」）。P1 已推进：§4.4 验收入口与进程退出状态解绑
  （冻结证据存在即可审可采纳，失败/停止 Run 有可审成果时目标提升待验收）；§4.7 前半
  「Run 可以没有 Goal」（scratch/reader/办公闲聊不再强制登记 Task，task_id 可空）；
  §4.8 普通目标侧有效上下文快照（`context.json` 冻结实际下发文本，评审可核对）；
  §4.10 普通目标启动链收口进 `src/goal-run.ts`（页面只补自有终端字段）；
  §4.9 前半（`SkillDto.contentDigest` + 档案卡 `skills` 名单 + 规则面板「项目技能」勾选，
  版本随快照记录）；§4.6 首期稳定 ProjectId（档案卡顶层 `id` 跟随文件夹，移动后重新添加即认回，
  路径降为当前位置；tasks/runs/会话等按路径的关联迁移留下一期）。
  内核契约（2026-09-10 拍板并落地）：`review_contract.rs` + 四条回流写同一账本；
  科研流程保留。Result Readiness 为派生枚举不改 Run 状态列；session_meta 本波只双写。
  第二波已落地（2026-09-09）：TaskCard 改名「话题」、目标删除即归档（archived_at，数据全保留）、
  Memory Proposal 最小闭环（.ccode/memory.md 只进人确认内容、进上下文包）、定时巡检采纳契约
  扩展（四类基线 + 技能声明产出）、tasks/runs 双写 project_id + 回填。
  同日优化：目标页「已归档」可恢复 + 验收账本只读展示；`task_list` 默认不含归档行；
  沉淀知识失败与账本同口径 fail-closed（按 run_id 幂等）。
- P0 收尾当前批次：批次 A（文献雷达应用层，v3.95）、批次 B（沉浸阅读区，v3.96）与批次 E（LaTeX 支持，v3.97）
  均已落地；后续只保留文档/回归走查与发布动作，不把历史批次重复列为功能未完成。
  批次顺序为用户拍板：E 先行，批次 C（实验数据分析）/D（表征分析）转待办；场景 4（agent 辅助做图）不做独立产品能力，改由按需挂载的 origin-plot 技能承接、
  已移出独立路线（「只做场景必需、不做扩展性功能」原则，见架构 v3.97）
- **科研工具交付合同（2026-09-11；2026-09-12 收口来源）**：六套模板不另扩编排；库交付、Origin 数值图、Blender 示意和稿件载体由人选择，统一补进现有步骤技能/产物/人工事项。**文献从哪来只在检索步 `lit_source`**，不在创建弹层或 `科研工具/literature` 再问一遍；选 Zotero 才挂 `zotero-sync`。设定屏只填全局设定。稿件载体问在会换正式稿的步骤；Zotero 进库只走检索步待获取「同步到 Zotero」，精读流程线不问文献库交付；EndNote 交差在项目设置（无精读才问投稿适配）；Origin/Blender 问在用得上的那一步且不挡主动作。综述大纲不问 Blender。种子 v5 加 `blender-research` 及随包脚本；已有技能只经差异预览确认升级。模板同名但交付不同不可跳过。Zotero 只读在线内存快照、增量独立候选、来源+资源一起保存；外部 PDF 仅精确登记只读路径可配对阅读。复现合同与面板统一；上游验收引用不自动批准本步。细则见 `docs/conventions/pipeline.md` 末节。
- **科研外部工具三线（2026-09-05 已融入）**：`origin-plot` / `zotero-sync` / `endnote-bridge` 已注册为内置技能并随种子版本 4 播种；仅 `zotero-sync` 默认挂到英文综述、科研论文、毕业论文的文献检索步骤。Origin 仍只作 Windows + Origin 2021+ 的可选外部工具驱动，EndNote 仍只作 XML/RIS 格式桥接，二者不默认进入模板，也不做 CWYW 无人值守自动化。Zotero 通道需按实机版本/授权探测，失败时回落 RIS/BibTeX 文件流程，不阻塞检索。
  Origin 只做 Windows 实机（Mac 虚拟机方案否决）、EndNote 只走格式桥接（CWYW 无人值守否决）、Zotero 写库只走技能或 UI 显式动作且必须有用户意图（2026-09-16 放宽：to-fetch 清单「同步到 Zotero」按钮即用户意图——zotero.rs zotero_attach_fulltexts 直连本地 API 按 DOI 挂 linked_file 附件，引用 papers/ 绝对路径不复制；Zotero 须运行中并允许本机通信，首次写入授权）；场景 4 以 origin-plot 技能形态重新纳入。
- **定时任务与研究流程结合（核心路径已落地，细目见架构 §11.4 历史记录）**：边界已定——不给每步配定时任务，
  结合点是「产出回流」而非「配置下沉」。产出回流三件套已上线（v3.95：lit_watch.rs 解析巡检产物 + LitWatchCard
  雷达卡片 + 收件箱 lit: 文献胶囊 / Schedule.linkedStep 关联步骤 + RunRecord.newEntries / staleLitHint 复用
  staleUpstream 口径只提醒不阻断）。
  当前规则：默认定时任务进入隔离 worktree，无法创建或校验失败则 fail-closed；启动前登记 Run，启动失败也保留 failed Run 记录；超时与真失败分列。成功产物经只读评审，人点「采纳进主仓」才拷回项目根，不自动合并。当前没有主仓 sentinel 配置入口，不能把定时成功理解为已写入主仓。不同 Agent 的无头权限差异仍以能力表和实机验证为准。关标签后交互 Run 按 `runId` 从工作台「继续」或收件箱找回。
- macOS 签名公证（暂缓，需 Apple Developer 会员 + CI 配 6 个 APPLE_* secrets，见架构 v1.3）
- Intel macOS 安装包（暂缓：CI macos-latest 只出 aarch64；加 `x86_64-apple-darwin` target 构建时间翻倍，真有 Intel 用户再加，
  见架构 v1.3 / README 安装节）
- OpenCode Windows 数据路径 ✅：`sessions.rs` 依次探测 `OPENCODE_DB` / `%LOCALAPPDATA%\opencode` / `%APPDATA%\opencode` / `~/.local/share/opencode`（2026-08-31）
- Skills 一键更新 ✅：更新检测（check_skill_updates）+ 检测后一键应用更新（apply_skill_update，v3.53）均已落地

## 模型配置约定（2026-09-05）

- Claude Code 启动必须用 `--settings` 覆盖本次连接的模型选择，避免用户级 `settings.json.env` 覆盖 Mesa；不得写 `CLAUDE_CODE_SUBAGENT_MODEL`，以保留 Task 参数、frontmatter 和主模型继承链。
- Anthropic 兼容槽只接受基础 URL；保存时拒绝以 `/messages` 结尾的完整资源地址。
- CodeBuddy 的 `reasoning_effort` 通过当前 CLI 的 `--effort` 启动参数注入；Grok 的模型/思考档通过 `-m`/`--reasoning-effort` 注入。
- Grok 的 `api_backend`、`context_window` 不得通过受限 `GROK_CONFIG` 猜测注入；若绑定声明非 `chat_completions`，必须先在 Grok `[model.<id>]` 配置中登记，否则启动和无头调用均 fail-closed。
- Codex 网关端点必须实现 `/responses`（CLI 已移除 `wire_api="chat"`）：智谱专用端点是 `https://open.bigmodel.cn/api/v1`，`/api/paas/v4` 只有 `chat/completions`，Codex 打过去 404；且 api/v1 **不提供 `/models` 目录**（智谱把错误包成 HTTP 200），目录只有 `paas/v4/models` 有——网关库正确填法 = Base URL/OpenAI 槽 `paas/v4` + Responses 槽 `api/v1` 分槽填（预设与网关库告警已对齐；fetch_models 用 `gateway_error_envelope` 识别 200 包错误体，不误报「0 个模型」；qwen/kimi/opencode/grok 走 openai 槽用 `paas/v4` 不受影响；2026-09-15 实证）。
- Codex 从步骤工作区启动时，pty_spawn 把主仓 `papers/` 预授权进沙箱（`-c sandbox_workspace_write.writable_roots=[...]`，`workspaces::papers_dir_for_worktree` 映射）：口径 C 允许原始文献直写主仓 papers/，不预授权则每写一篇 PDF 都停下等提权（2026-09-15 用户实测「总是让我授权」）。**只加 papers/ 子目录**——派生产物仍必须走工作区 + 评审合并，不得放宽到整个主仓。
- 配置页查询模型能力必须带 `gatewayId`，网关级能力声明优先于公共/内置能力库；写 Grok 逐模型上下文时只使用显式声明值，不使用通用估值。
- 思考档注入优先级（2026-09-15）：开工弹层的本次覆盖（`KickoffLaunch.effort` → PendingTerminal → Tab → `pty_spawn` 的 `effortOverride`）> 绑定逐模型策略（网关库 `reasoningEffort`）> 端点默认。弹层选择器按 `combo_surface.injectEffortAllowed` 判定显示（不给调不了的东西）；值只影响本次进程不写回绑定；运行中调整仍在状态栏（起点/运行两层同源 combo）。执行权限不做成弹层选项——步骤执行固定 write_tree + 沙箱，只读讨论走聊想法/商量（弹层只有一行权限边界可见性文案）。
- **能力声明与能力通道（2026-09-19，对照 cc-switch 补口）**：Claude 长上下文 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` **同值成对**注入/清除（启动 + 设为全局；只抬上限不抬压缩窗口会把压缩触发点留在旧档，勿拆对）。Codex catalog **不写** `apply_patch_tool_type`（freeform=custom 工具会被原生 /responses 与 Anthropic 网关拒/丢，编辑走 `shell_type: "shell_command"`）。模型能力注册链四层全 miss 时用户可经网关库「能力声明」写覆盖（`model-capabilities.json` 最高层；表单只收 context/思考/视觉——output 的旋钮是策略字段 max output，能力层 output 只喂 opencode limit.output，与策略并排摆两个输出框属重复），`input_modalities` 等按注册链如实声明（宁缺毋滥）+ 覆盖层补口的口径不变。

- **项目页视图（2026-09-06；2026-09-10 加「对话」页）**：项目页顶栏是当前项目身份（名称、工作方式、课题主题、路径），添加项目在左侧列表 +。已注册项目页签顺序为「对话 → 科研任务 / 工作任务 / 编程任务 → 定时任务 → 文件 → Agents」。**对话**只看当前项目的记录（默认铺开列表，点一条才回放；展开后列表不显示 Agent 标签，关闭在右上角，方向键换会话；思考/工具调用默认折成一条过程；可继续/归档、＋新对话），不是侧栏那份全局历史；打开项目默认仍进任务页。＋新对话注入**会话包**（项目是谁、顶层有什么、规则、跟这次说的做），不把目标说明、技能名单、「尚未完成」或「验收后才进项目」塞进对话；勾「验收后写入」才改走目标包。任务页是该工作方式的主面（有流程科研=步骤/工作区，无流程科研=目标，办公=人声明任务，编程=工作树），**不再放右侧对话栏**。文献雷达和定时任务在「定时任务」页签。规则和验收记录收进顶栏 ⋯「项目设置」抽屉。文献/笔记/数据/图像只在「文件」页，任务页不预留空块。文件页：点文件才弹出右侧预览；预览有上下切换，窗口预览时方向键也换文件；顶栏类型图标（空类型不占位）+ 搜索 + 刷新；行悬停图标（问 AI / 显示 / 沉浸阅读），不挤文件名；可切窗口预览。规则面板无说明句。**有研究步骤的科研不展示技能和「写回时跳过」**（技能以步骤挂载为准；写回时跳过是目标验收不覆盖的路径）。无流程科研 / 办公才用技能 + 目标点名，以及写回时跳过；编程用技能、不展示写回时跳过。办公文档筛选与文件页同一套图标。本项目对话未命名显示「对话」。有进行中/待验收目标时雷达默认收起。Agents 页是这个项目的 Agent 名册（点配置名换该项目绑定、＋新对话 / 跟 AI 商量 / 聊想法默认、本项目继续该家会话也用这份绑定、正在负责哪些目标），点目标回任务页；不是连接页的模型配置表单。项目内新会话不沿用上次终端连接。继续会话启动栏必须显示该绑定，不能因 Codex 渠道兼容池静默换回上次的网关；渠道不同时预填绑定、不自动启动，确认后点运行。没有目标时不逐家重复空状态。不自动分派，密钥仍在连接页。编程工作树 ⋯ 可事后分组。侧栏「对话」仍是跨项目全局历史；定时任务在项目「定时任务」页签创建，后台不进正在进行、不进本项目对话。**侧栏没有定时任务页**（2026-09-13 用户移除）：侧栏九页 = 工作台/项目/运行/对话/连接/技能/MCP/用量/设置，页切快捷键、启动页选项、导航胶囊、settings.rs KNOWN_PAGES 都按这九页对齐；全局 page id `schedules` 只作旧持久化值的重定向（App.tsx 转到项目定时任务页签），不得再把定时任务加回侧栏或九页清单。
- **绑定与网关命名（2026-09-06）**：Gateway.name 是共享端点/网关名称，Binding.name 是单个 Agent 配置名称，必须分开存储；旧 Binding 缺 name 时展示回退 Gateway.name。修改 profile 名称只更新 Binding.name，不得改共享 Gateway.name 或其他 Binding。相同 Agent + 网关允许不同模型选择，完全相同的模型/协议/附加环境变量仍拒绝重复。
- **模型越强，产品越管环境和验收（2026-09-07）**：不跟 Codex/Claude 比「我也能执行」。闲聊用＋新对话（项目根直接改）；成稿用新建目标（隔离 + 人验收 + 项目记住）。Agent 弱时科研步骤仍可当护栏；Agent 强时把引导撤掉。禁止靠更强编排/自动拆任务来对抗更强模型。
- **有流程科研的决定、复现与验收（2026-09-08）**：硬暂停认决定状态，不认非空文字。状态闭集为批准指定范围／仅允许准备／待补证据／不批准，与说明分开写；旧纯文本不自动批准，不用关键词猜授权。批准绑定当时报告指纹，指纹变了要重确认。复现只认脚本约定（`MESA_REPRODUCE` 或 `reproduce` 子命令），输出必须独立于输入项目，落 `~/ccode/reproductions/`，界面只读本次运行输出。科研验收决定（接受／有条件接受／退回）写 `.ccode/research-acceptance.json`，不替代也不禁止 Git 合并。运行结束、计算检查、人工验收三层状态不得合成一个绿灯。不得把报告里的「通过」自动当成质量通过。
- **目标与验收（2026-09-06；2026-09-10 会话包/目标包拆开）**：无流程科研和工作的「新建目标」写一句话即可，可先记下再开始；默认把整个项目复制进隔离副本，人验收后写回。可选用指定资料或不带入。＋新对话默认直接改项目根；开聊可选「验收后写入」。列表只显示 `user:` 声明目标，按尚未开始 / 进行中 / 待验收 / 已完成分组，时间线是生成→意见→下一版→已接受。验收不满意写意见，同一目标沿用上一版隔离目录再跑。文件页待验收文件打标。**目标** Context Pack 带工作环境、项目规则、保护路径、已验收产出与意见、未完成目标；**会话**只带身份、目录、规则和「按这次说的做」，不把目标当对话任务。验收接受写入 `.ccode/project-status.json`。任务页头部「项目现在」。项目规则可编辑（未改过补工作方式默认条）。**「写回时跳过」和技能只给无流程目标 / 办公**（勾上的路径验收写回不覆盖；技能 = 名单 + 点名）；编程用技能、不展示写回时跳过。有研究流程的科研只用步骤挂载，不设技能名单，也不展示写回时跳过。科研目标验收按文献/笔记/数据/论文分组并可预览；工作目标按文档/表格/幻灯分组并可预览；编程验收仍是工作树改动面板、合进基准、PR，不套目标验收弹层。有流程科研走步骤/工作区。禁止自动拆任务、智能路由、创建时空目录、人设 Agent 槽。普通目标副本清理分两步、各需确认（先工作副本，再历史冻结）；清理后任务与接受记录保留，不能从已删副本续跑。不得删除仍被其他项目或运行引用的目录；中断后待删目录被外部改过则拒绝继续删除。归档不等于清理副本；待验收可归档，未完成接受或未完成清理不得归档，清理未完成也不得恢复。
- **确认框与自动路径（2026-09-06）**：`confirmDialog` 默认焦点在确认钮，Enter 激活当前焦点按钮（焦点在取消则取消）。「设为全局」本机有 cc-switch 时挡路（Codex 另认 live custom/catalog），焦点在取消（`focusCancel`）。快速开聊直达只接受记住的那条 profile，失效退回弹层。Custom Runtime 不是隔离工作树任务；写盘必须离开主仓只约束 pipeline/coding/watch。网关目录按槽刷新。交互 `pty_write`（含选段问 AI）失败必须可见。
