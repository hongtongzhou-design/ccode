# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（关键约定、主题与设计系统、本机环境档案）和 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：功能增改时必须同步更新 `docs/user-guide.md`（用户操作手册）；发版本时同步更新 `CHANGELOG.md`（版本更新日志）。

## 项目简介

Ccode 是一个「AI 编码 Agent 统一启动器 + 配置中心 + 会话监控台」桌面应用（Tauri v2 + React/TS）。
为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code 管理多套 API 配置（端点/密钥/模型），
内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

**设计文档即规格**：改架构/适配逻辑前先读 `docs/architecture.md`（总体设计）和
`docs/agent-integration-matrix.md`（六个 CLI 的 env/配置/会话格式，源码级调研结论，勿凭印象写 env 变量名）。

**参考实现（长期有效）**：`.reference/` 下有三个开源项目的浅克隆，实现新功能前先查它们有没有成熟方案可借鉴：

- `.reference/cc-switch`（farion1231/cc-switch，Tauri2+React+SQLite）：provider 预设与一键导入、双向同步/回写保护（写活文件 vs 编辑时回填）、本地代理与故障转移、原子写入、测速、托盘速切、导入导出
- `.reference/waveterm`（wavetermdev/waveterm，Electron+Go+SQLite）：block/workspace 对象模型与持久化、"named = saved" 留存语义、badge 注意力标记与 Claude Code hooks 联动、滚动缓冲区序列化恢复、namespaced meta 键体系
- `.reference/vscode`（microsoft/vscode，Electron+TS，blobless 浅克隆，读文件会按需拉取）：Explorer 文件树（懒加载/预览 vs 固定打开）、编辑器区 tab 与 split、面板布局（活动栏/侧栏/编辑器区/面板/状态栏）、终端标签列表。目录索引在 `src/vs/workbench/contrib/`

借鉴原则：学机制和取舍，不抄代码；与我们架构冲突时以 `docs/architecture.md` 为准（例：不走本地代理主线、会话解析坚持只读）。三个镜像可随时 `git -C .reference/<repo> pull` 更新。

**已确认的产品决策**（用户拍板，勿擅自更改）：

- 应用名 **Ccode**；MVP 六个 agent 全部支持
- 配置切换**双模式**：默认启动注入环境变量（零污染），另提供「设为全局默认」（写配置文件，先备份）
- 终端为内嵌形态，且**与结构化会话视图联动**（同一会话双栏观看，P2 实现）
- 项目列表**从各 agent 历史会话自动聚合并分类**，辅以手动添加（P2 实现）
- token/费用统计随 P3 顺带做，不提前
- **三平台（macOS/Windows/Linux）同步**支持，功能不得以平台为由裁剪

## 构建与运行

```bash
# Rust 不在默认 PATH，每个新 shell 都要先 export
export PATH="$HOME/.cargo/bin:$PATH"

npm run tauri:dev      # 开发（独立 Ccode Dev 窗口；前端 HMR + Rust 改动自动重启）
npm run build          # 前端构建（tsc + vite）
cd src-tauri && cargo build / cargo test
npm run tauri build    # 打包
```

环境：Node 22 + npm（无 pnpm）；Rust stable（minimal profile）；crates 走 rsproxy 镜像（`~/.cargo/config.toml`）。

开发预览必须使用 `npm run tauri:dev`：它通过 `src-tauri/tauri.dev.conf.json` 使用独立产品名 **Ccode Dev**、
窗口标题 **Ccode Dev - 热更新** 和 bundle ID `com.ccode.dev.hmr`，避免自动化或人工验收误连同名的正式/打包调试版。
界面验证必须按该窗口标题或明确 `.app` 绝对路径定位，禁止再用模糊应用名 `Ccode`。

## 本机环境档案（踩坑记录，新会话必读）

- **网络：访问 GitHub/raw/formulae.brew.sh 很慢**。必须用镜像：crates → rsproxy（已配）；rustup → TUNA；brew → `HOMEBREW_API_DOMAIN`/`HOMEBREW_BOTTLE_DOMAIN` 指 TUNA（已在 updater.rs 内置）；npm 如变慢 → `registry.npmmirror.com`。
- **brew 曾整体损坏**（卡在拉 `formulae.brew.sh` 内部 API 元数据）：重装 brew 后恢复。遇到 brew 异常先 `brew doctor`，别先怀疑应用代码。
- **macOS 钥匙串对未签名开发构建会因 cdhash 失配丢条目**——密钥存储因此弃用钥匙串，改 0600 `keys.json`（勿改回）。
- **管道输出块缓冲**：brew/npm 等检测到非 TTY 会块缓冲导致"无输出"假象——安装/更新命令必须在 PTY 里跑（updater.rs 已如此，别退回管道）。
- **GUI 应用 PATH 很短**：Finder 启动的打包应用可能找不到 npm 装的 CLI；开发模式（`npm run tauri dev`）继承终端 PATH 不受影响。打包版统一经 `agents::resolve_binary` 候选目录兜底解析（见关键约定）。
- **本机 CLI 安装情况**：claude/codex/gemini/qwen 为 brew 或 npm 安装（检测见 updater.rs 报告）；opencode 未装；kimi 为新版（~/.kimi-code）。
- **Codex 桌面版的 NetworkService 会占用 1420**（Tauri 惯例端口，本机实测）：vite 与已占端口碰撞后静默退出；且 **vite 检测 stdin EOF 也会自杀**（后台拉起必须 `tail -f /dev/null | npm run tauri dev`）。dev 端口因此从 1420 改为 **17575**（`vite.config.ts` 默认端口 + `tauri.conf.json` devUrl 两处同步）。
- **git 提交**：用户要求 CI 耗时久，常规提交加 `[skip ci]`，里程碑提交才跑三平台 CI。
- **git 推送走 SSH:443 + repo deploy key**（HTTPS 网络不稳）；**deploy key 推送不触发 GitHub Actions**——发版必须 `gh api repos/hongtongzhou-design/ccode/actions/workflows/build.yml/dispatches -f ref=<tag>` 手动触发；workflow 已配 `permissions: contents: write`（tauri-action 建 Release 草稿必需，缺了报 Resource not accessible by integration）。**仓库 owner 与 tauri.conf 升级端点绑定**（同为 `hongtongzhou-design/ccode`）：仓库若转移，本命令、tauri.conf.json 的 updater endpoint、README 链接三处必须同步改。
- **CI 测试教训**：单元测试禁墙钟时序硬断言（共享 runner 调度延迟不可控，只留内容语义断言 + 防挂死宽松兜底）；unix 专属语义（symlink/PTY 交互/脚本）测试加 `#[cfg(unix)]`；路径断言用 `Path::ends_with` 不用字符串相等（Windows `\`）。

## 代码结构

```
docs/                        # 架构方案 + 六 CLI 适配参考（规格）
src/                         # 前端 React + TS + Tailwind v4（无 tailwind.config，vite 插件接入）
  pages/ProfilesPage.tsx     # 配置中心：agent × profile CRUD
  pages/SessionsPage.tsx     # 会话浏览：左栏分类树（agent→项目）+ 右栏列表/回放，5s 轮询刷新
  pages/TerminalPage.tsx     # 内嵌终端（xterm.js），agent 退出自动回落登录 shell
  store.ts                   # zustand 状态
src-tauri/src/
  profiles.rs                # ProfileStore：profiles.json + 系统钥匙串存密钥（service "ccode"）
  agents.rs                  # 适配器：detect + launch_plan（env/args 注入规则，差异全在这里）
  pty.rs                     # PtyManager：spawn_tracked 公共拉起逻辑，agent/shell 复用
  sessions.rs                # 会话浏览：扫描/解析全部六个 agent 会话（含 Codex .zst、OpenCode SQLite/legacy JSON）、app.db session_meta、pin 快照、用户发起的删除、注意力状态分类（session_tail_state）
  skills.rs                  # 技能库（§6.13）：SSOT 库 + 六 CLI symlink/copy 分发、四路导入（目录/ZIP/GitHub/发现）、ZIP 导出、卸载备份、copy 漂移检测与 resync
  usage.rs                   # 用量统计（§6.11）：六 agent usage 事件提取、usage_daily 按天聚合、内置定价表 + pricing.json 覆盖
  settings.rs                # 应用设置（settings.json）：字体/scrollback/汇率/brew 镜像/主题，get/update 两个 command
  ai.rs                      # 无头 AI 调用层：一次性 prompt（launch_plan 注入）+ 提交信息/会话摘要/PR 描述生成
  workspaces.rs              # 任务工作区（§6.10）：git worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT 端口段、setup/archive 脚本钩子、评审合并（health/merge/PR）
  ws_settings.rs             # 项目级 .ccode/settings.toml 三层合并（用户→仓库→local）：files_to_copy/run_mode/scripts
  lib.rs                     # 模块与 Tauri command 注册
```

## 关键约定

- **密钥绝不回显/进 shell**：存储用 0600 权限的 `keys.json`（与 Codex auth.json 同一威胁模型；
  不用 macOS 钥匙串——未签名开发构建热重编译会因 cdhash 失配导致旧条目读不到），
  只在拉起瞬间读出注入子进程 env；`profiles.json` 里只允许存尾号提示（key_hint）；
  `NO_COLOR` 必须 `env_remove`，
  `TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Ccode` 必须显式设置（否则 CLI 输出黑白）。
  由此推论：**外部恢复/复制恢复命令不携带 profile env**（`agents::resume_command_line`，
  会话页 ⇗/⧉ 两个入口共用）——密钥不进剪贴板、不进外部 shell，恢复时用的是用户全局 CLI 配置。
  **⇗ 外部拉起的两个硬要求**：CLI 用绝对路径（`resolve_binary` 结果，⧉ 复制命令才用裸名）；
  shell 必须 `-l -i` 交互登录模式——非交互 `zsh -l -c` 不加载 `.zshrc`（`~/.kimi-code/bin` 这类
  官方安装器 PATH 只写在交互 rc 里，裸名/非交互都会 command not found，Ghostty 报 failed to launch）。
  **Ghostty 单实例约束**：`open -n` 每次开新实例（程序坞堆图标）、`open` 不带 `-n` 不投递 `--args`
  （实测）；Ghostty 已在运行时改走 AppleScript——激活 → ⌘N 新窗 → 剪贴板粘贴命令 + 回车
  （keystroke 逐字输入对中文路径/键盘布局不可靠，故走剪贴板且用后还原；首次需用户同意
  「控制 System Events」自动化授权一次）。
- **会话文本出站前必须在 Rust 层脱敏**：标题/自定义标题/摘要、结构化回放、AI 摘要响应、
  Markdown 导出均不得把已保存的完整密钥或常见密钥前缀送到 React；脱敏只作用于 DTO/导出副本，
  不得回写六个 CLI 的会话源文件。前端遮盖不能作为安全边界。
- **Profile 的 extra_env 排在 adapter 内置 env 之后注入**，供用户覆盖内置值（CommandBuilder 后者生效）。
- **终端行为**（用户明确要求）：
  - 终端配色使用 VS Code Dark+ 风格调色板，集中在 `TerminalPage.tsx` 的 `theme` 一处，换主题只改这里；
  - 「停止」或 agent 自行退出后，终端必须**自动回落到用户登录 shell**（`$SHELL -l`，同工作目录），
    不允许死在最终画面；用户手动 `exit` shell 不自动重开；
  - 回落的 shell 不携带任何 profile 环境变量（密钥只在 agent 进程内）；
  - agent 与 shell 共用 `pty.rs` 的 `spawn_tracked`，退出事件按 PTY 类型区分处理。
  - **应用重启只恢复终端标签元数据，不恢复 PTY**：持久化白名单限 label/cwd/agent/profile/model/sessionId；禁止保存
    PTY id、scrollback、密钥、profile env、workspace extra env 或 run 脚本命令。重开后必须是「上次任务，可恢复」占位，
    由用户点击才创建新 PTY；目录/profile 失效时留在可编辑启动栏明确提示，禁止自动换目标。
  - **预览编辑器不映射同名文件**：同一文件树根内保持已打开文件；切换项目、工作区、标签 cwd 或树根时清空旧预览，
    由用户在新根重新选文件，禁止自动打开新根下的同相对路径文件（曾因此误改主仓库）。预览有未保存改动时先确认，
    取消则根目录也不切换；主仓库文件的保存按钮必须警示色 + 保存前二次确认。
  - **任务审阅 = 终端全宽覆盖层**：工作区行「评审」（无冲突）与终端右侧「改动 → 审阅」进入同一视图，
    连续浏览累计 diff，并可「提交并合并 / 仅提交 / 合并并归档」；覆盖层底下的终端标签与 PTY 必须保持挂载。
    默认合并只落本地主分支并保留工作区，不自动推送。原「提交 / 提交并推送」及工作区行的合并、创建 PR、
    归档、会话操作继续保留；保留的工作区在 `merged_at && ahead == 0` 时，合并按钮必须显示禁用的「已合并」，
    新提交令 `ahead > 0` 后恢复「合并」。**普通审阅与冲突审阅必须共用同一个终端全宽覆盖层**：冲突模式直接读取 Git
    index stage 2/3，把任务分支与基准分支按文件连续双栏展示，右侧冲突清单可定位，逐文件/全部选边与 ◈ AI 建议均在同屏完成；
    禁止退回工作区行内小面板或维护第二套冲突解决器。入口使用「开始解决冲突」等任务语言，不把“把 main 并入工作区”作为
    主按钮文案。全部选边后的默认动作必须串联「提交解决结果 → 健康检查 → 合并（保留工作区）」并保留「仅保存解决结果」。
    提交成功而最终合并失败时必须明确提示部分成功，且不得自动重做 merge commit。工作区行点「解决冲突」后，干净工作区必须
    自动以**当前基准分支 tip** 准备冲突两侧，准备完成前禁止把普通 merge-base diff 冒充当前基准内容；若冲突处理中基准分支再次
    前进，立即停止展示和选边，必须经用户确认 `merge --abort` 后重新同步最新基准。
  - **评审覆盖层以代码为中心**：顶部固定任务/分支/增删统计与唯一主动作，提交信息和批量冲突操作放在第二工具行；
    右侧只做文件搜索、树形定位和简短进度，不再堆叠提交/合并说明。文件 diff 连续浏览、标题吸顶、长段未修改内容折叠，
    右侧选中项必须随主区滚动同步；冲突选边使用文件标题下的紧凑双侧控件，AI 理由单行展示并由用户显式执行。
  - **改动面板空信息走本地快速提交**：提交信息非空时原样提交；为空时按文件状态/数量即时生成中性默认信息，直接执行
    原 `git_commit`，不得为了默认提交额外启动 AI。Git 阶段失败时保留默认信息供重试。独立 ◈ 生成按钮与手动输入继续保留，
    仅在用户主动点 ◈ 时调用 AI。
  - **终端右栏统一称“对话”并采用有界实时视图**：仅展示最近 50 条，头部必须显示标题、agent、会话 ID 与识别/同步/结束状态，
    并提供精确的「完整回放」入口。用户在底部附近时才自动跟随；向上阅读后禁止强制滚动，改显示“有新消息”入口。
  - **终端右栏是可调分栏，不新增普通内容全屏路由**：左边缘拖拽调整宽度并记忆普通宽度；顶部宽屏动作暂时隐藏工作树但保留终端，
    再次执行恢复原布局，双击对话/预览/改动页签同义。宽度变化必须触发 xterm 重新 fit；任务评审仍使用既有全宽覆盖层，禁止混用。
  - **运行中会话关联必须排他且使用复合键**：固定 session id 的 CLI 精确锁定；其余 CLI 在进程启动前按 agent+归并后项目登记 claim，
    同批并发启动统一排序分配，已分配过的会话在本次应用进程内不得转给另一标签。前端 live/open 请求一律以 agent+sessionId 为键，
    禁止只用 sessionId，完整回放跳转前先刷新索引。
- **普通仓库与工作区提交语义分开**：普通仓库默认不选文件，`git_commit(paths)` 与 AI 提交信息只处理用户勾选且仍在
  当前 status 的安全相对路径（literal pathspec）；工作区任务始终提交全部任务改动，禁止把选择提交扩散到 worktree 流程。
- **Git 改动列表的单文件 diff 必须安全且可展开**：普通仓库只允许读取当前 status 中经过安全校验的相对路径，工作区只允许读取
  当前累计任务 diff 中的路径；未跟踪文件按全新增展示，二进制只提示，单次文本读取/展示设上限并明确截断。会话页只读展示
  “当前项目改动”，必须声明它不是历史快照，禁止在会话页提交或推送。紧凑 diff 禁止整行使用 ok/err 背景铺色，增删只用
  语义色文字与细边标识，hunk 标题才允许轻量 inset 背景。
- **工作区创建是补偿事务**：先以 SQLite `BEGIN IMMEDIATE` 原子预留端口并写 `creating`，再创建 worktree/复制文件/激活；
  worktree、复制或激活任一步失败必须移除 worktree、prune、删分支、删 creating 行并释放端口。复制错误不得忽略；setup 失败
  维持非阻断语义。`ready_to_merge` 必须要求 `ahead > 0`，空工作区禁止合并。
- **工作区漂移修复必须显式且非破坏**：仓库/分支/worktree 缺失、注册不一致、归档记录与磁盘冲突、merge 进行中都由
  `workspace_drift` 先诊断并暂停普通危险动作；重新挂载/重新定位可修复实体，标记归档/清理记录只改元数据，不得删目录或分支。
- **工作区归档是无损操作，删除才允许强制**：归档前必须重新检查 merge 状态、未提交改动和该工作区内仍运行的
  agent/run 脚本；任一存在即拒绝。脏工作区只允许走「提交并归档」，提交成功而归档失败后只能重试归档，禁止重复提交。
  归档移除 worktree 禁用 `--force`；`git worktree remove --force` 只允许用于用户明确确认的「删除工作区」。最终合并失败必须
  自动 `git merge --abort`，不得把主仓库留在冲突状态。
- **多阶段 Git 操作必须返回结构化阶段结果**：commit/push、merge/archive、push/PR 任一后阶段失败时，前阶段成功事实必须保留并
  明示；UI 只重试失败阶段，禁止把部分成功显示成整体失败或诱导用户重复提交、重复合并。
- **全局配置写入/恢复按 agent 整批事务处理**：先生成并验证全部目标内容，再为同批目标建立清单备份、写完并同步全部临时文件，
  最后替换；中途失败自动回滚整批。恢复必须选择最近一个完整批次，恢复前先备份当前状态，且不得移动/消耗原恢复点。
- **Profile“保存成功”不等于“可用”**：验证固定分三层——本地字段/活配置解析、CLI doctor/启动预检、最小 API 请求；
  密钥仅在 Rust 层参与验证，结果统一脱敏。「设为全局」成功后必须自动执行本地与 CLI 配置复检。
- **技能同名导入不得静默跳过**：导入返回 added/updated/skipped/conflicts；覆盖前备份、另存为校验单段安全名称，ZIP 先
  staging，元数据保存失败回滚。GitHub 来源保存 repo/ref/subdir/revision，更新检测只提示，重新导入仍走冲突确认。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作：「设为全局默认」（写前必须备份）、会话删除（delete_session/delete_project_sessions，路径必须落在已知会话根内）、工作树文件删除（限定树当前根目录 + 重要路径黑名单兜底：系统目录/关键用户目录/CLI 配置/.git 一律拒绝；黑名单判断必须 canonicalize 双校验，堵符号链接绕过）。
- **codex 默认沙箱**：交互启动注入 `-s workspace-write`（只能写当前目录），AI 无头调用 `-s read-only`；用户可用 extra_env/参数覆盖。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底（macOS 用户目录 `~/.npm-global/bin`/`~/.local/bin`/`~/bin`/`~/.kimi-code/bin` **先于** `/opt/homebrew/bin`——与用户交互终端的 PATH 解析习惯一致，防止检测到系统目录里的同名旧副本；Linux `~/.local/bin`，Windows `%LOCALAPPDATA%\Programs`/`%APPDATA%\npm`）——打包版 GUI 短 PATH 下检测/启动/更新/安装不再失灵；新增 CLI/工具调用点一律用它，禁直接 `which::which` 或裸名 spawn。
- **npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**：同机多份 node/npm 时用错 npm 会把包装进另一个 prefix、目标副本不变；brew 安装的 CLI 一律走 `brew upgrade`（opencode 自更新是交互 TUI，行输入无法应答）。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。

## 主题与设计系统

- 全站**沉浸冷黑主题**，令牌集中在 `src/App.css` 的 `@theme` + `[data-theme]` 变体（**七套深色**：沉浸黑(默认)/陶土/Ayu琥珀/Catppuccin/极简灰蓝/Dracula/灰蓝正红），运行时 `document.documentElement.dataset.theme` 切换，**改主题只动这一个文件**；不要在组件里散落 hex。
- 四层「浮起」结构（rail/rail2/canvas/inset 逐级变亮）；文字冷白→灰四档；每主题有独立 CTA 强调色（按钮/选中用 `cta`；可操作状态如「可合并」用**按钮本身的 cta 高亮**表达，不另挂 pill；纯状态 pill 如「活跃」「有冲突」用 inset 灰底 + 语义色小圆点，不用强调色，避免页面花哨）；**状态语义色独立于主题**（ok/err/warn 不随主题变）；**结果横幅（成功/失败）一律 bg-strip/inset 底 + ✓/✗ 语义色文字**，不用整块 bg-ok/bg-err（bg-err 仅保留给需交互警惕的小 pill，如 setup 失败）；零阴影、隐式 hairline。
- **符号语言统一**：导航与图标用单色几何符号（⚙⛁⌨◔✦◫⛭⇄），◈=AI 功能、⚑=pin/保留；**禁用彩色 emoji**（✨📌 已清除）。
- 用户明确否决过的设计：多栏嵌套的会话页、浅色 + 蓝紫渐变侧边栏、按钮排排坐的 profile 行、暖棕色系整体主题、**浅色模式**、emoji 图标。不要改回去。
- 配置页结构（用户详版规格）：可折叠 agent 分组 + 五列网格行 + 顶部筛选与搜索 + 无大面积虚线空状态；图标按钮点击区 ≥28px；**WKWebView 不支持 window.prompt**——一切输入用内联输入框。
- 常规管理页统一使用共享页面框架、标题层级、主操作样式、主题化开关/复选框与稳定加载骨架；
  页面最大宽度必须显式选择，禁在同一节点叠加互相冲突的 `max-w-*`。
- 终端展开态主流程固定为 Agent → profile → 模型 → 目录 → 启动，辅助动作视觉分组；启动后自动收缩、
  PTY shell 回落、专注模式和所有终端标签保持挂载的语义不得因布局优化改变。
- **统计内部活动只认后端 provenance**：Ccode 无头 AI 启动前登记精确 agent+项目路径，usage 事件与项目/模型 DTO 显式携带
  `source/internal`；禁止再按 `/tmp`、`ccode-ai-*` 名称、空模型或 `<synthetic>` 猜测。跨平台路径处理只能做等价规范化，不能
  产生分类。统计页默认归并 `internal=true`，并提供“显示内部活动”开关；开关只改变展示分组，不得改写原始用量索引。
- **会话整理与长回放口径统一**：会话页默认从普通项目树排除 `internal=true`，归并为单一“Ccode 内部 AI”入口；“显示已归档”
  必须同时作用于全部/agent/项目/内部入口计数。标题先折叠空白并拒绝通用占位值，再回落首条真实用户消息，最终使用
  “未命名对话 · 短 ID”。长会话首次只读有界尾窗，向前分页时保持滚动位置；终端不得用全量回放接口做轮询。
- **usage 长会话必须流式解析并按本机日期聚合**：普通 JSONL 与 Codex zstd 会话逐行消费，禁止因整个文件超过固定大小而跳过；
  “今日/近 7 天/近 30 天”及事件日桶都使用系统本地时区。改变解析或日桶语义时必须升级 usage schema 并自动重建旧索引。
- **最近项目采用 stale-while-revalidate**：后端按仓库聚合各 Agent 会话的最大 updated_at、canonical 去重并降序返回；前端启动即预取、
  本地缓存上次成功结果，首次无缓存时用固定骨架占位。终端最多展示 4 个且排除当前项目，缓存路径在进入前仍必须重新验证。

## 路线图（见 docs/architecture.md §8）

- P0 ✅ 骨架：Profile CRUD + Claude/Codex 适配 + 单标签终端 + shell 回落
- P1 ✅ 六 agent 适配器（Gemini/Qwen/OpenCode/Kimi 双协议）、全局写入模式（备份/恢复）、
  多标签终端、三平台 CI 工作流（.github/workflows/build.yml）
- P2 ✅ 会话可视化：Claude/Codex/Gemini/Qwen 解析器、resume 链合并、项目聚合、
  pin 快照保留、tags/归档/搜索、SessionLink 终端↔会话联动（--session-id + 探测）
- P3 OpenCode/Kimi 会话解析（SQLite/wire 协议，**全部完成**）✅、token/费用统计（统计页）✅、注意力标记（终端标签/运行中面板）✅
- P4 IDE 形态 ✅（Monaco 编辑器可编辑保存、文件树 git 装饰、notify 文件监听自动刷新）；本地 API 代理（可选，未做）
- W1 任务工作区核心闭环 ✅（worktree 创建/归档/恢复、files-to-copy、端口注入、工作区页面、会话归并；用户验收通过）
- W2 工作区自动化 ✅（.ccode/settings.toml 三层合并、setup/archive 脚本钩子、run 脚本按钮 + nonconcurrent 互斥）
- W3 评审流 ✅（merge-base 任务 diff、workspace_health 状态机、本地合并+归档、gh PR 创建）

**当前待办（backlog）**：

- macOS 签名公证（暂缓，需 Apple Developer 会员 + CI 配 6 个 APPLE_* secrets，见架构 v1.3）
- Intel macOS 安装包（暂缓：CI macos-latest 只出 aarch64；加 `x86_64-apple-darwin` target 构建时间翻倍，真有 Intel 用户再加，见架构 v1.3 / README 安装节）
- OpenCode Windows 数据路径未核实（matrix 标注「文档与源码不一致」），Windows 用户验证会话/用量统计后修正
- Skills 更新检测与在线编辑（v2 口子，见架构 v0.9 / §6.13）
- Claude Code hooks 精确化注意力标记（v2 评估项，需写用户配置，见架构 v0.7）
- 本地 API 代理（P4 可选项，未做）
