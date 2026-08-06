# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（关键约定、主题与设计系统、本机环境档案）和 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：功能增改时必须同步更新 `docs/user-guide.md`（用户操作手册）；发版本时同步更新 `CHANGELOG.md`（版本更新日志）。

## 项目简介

Ccode 是一个「AI 科研工作台」桌面应用（Tauri v2 + React/TS）——底层是八个 Agent CLI 的统一控制台
（启动器 + 配置中心 + 会话监控台），表面是科研流水线（读文献→整数据→做图→写论文）：
AI 负责干活，Ccode 负责管活，人负责拍板。
为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI 管理多套 API 配置（端点/密钥/模型），
内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

**设计文档即规格**：改架构/适配逻辑前先读 `docs/architecture.md`（总体设计）和
`docs/agent-integration-matrix.md`（八个 CLI 的 env/配置/会话格式，源码级调研结论，勿凭印象写 env 变量名）。

**参考实现（长期有效）**：`.reference/` 下有三个开源项目的浅克隆，实现新功能前先查它们有没有成熟方案可借鉴：

- `.reference/cc-switch`（farion1231/cc-switch，Tauri2+React+SQLite）：provider 预设与一键导入、双向同步/回写保护（写活文件 vs 编辑时回填）、本地代理与故障转移、原子写入、测速、托盘速切、导入导出
- `.reference/waveterm`（wavetermdev/waveterm，Electron+Go+SQLite）：block/workspace 对象模型与持久化、"named = saved" 留存语义、badge 注意力标记与 Claude Code hooks 联动、滚动缓冲区序列化恢复、namespaced meta 键体系
- `.reference/vscode`（microsoft/vscode，Electron+TS，blobless 浅克隆，读文件会按需拉取）：Explorer 文件树（懒加载/预览 vs 固定打开）、编辑器区 tab 与 split、面板布局（活动栏/侧栏/编辑器区/面板/状态栏）、终端标签列表。目录索引在 `src/vs/workbench/contrib/`

借鉴原则：学机制和取舍，不抄代码；与我们架构冲突时以 `docs/architecture.md` 为准（例：不走本地代理主线、会话解析坚持只读）。三个镜像可随时 `git -C .reference/<repo> pull` 更新。

**已确认的产品决策**（用户拍板，勿擅自更改）：

- 应用名 **Ccode**；MVP 六个 agent 全部支持（此后接入第七个 CodeBuddy Code、第八个 Cursor CLI，见 matrix §7/§8）
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
npm test               # 前端测试（node --test，CI test job 同步执行）
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
docs/                        # 架构方案 + 八 CLI 适配参考（规格）
src/                         # 前端 React + TS + Tailwind v4（无 tailwind.config，vite 插件接入）
  pages/                     # 七个页面：配置 ⇄ / 工作区 ⛁ / 终端 ⌨ / 对话 ◔ / 技能 ✦ / 统计 ◫ / 设置 ⛭
  components/                # 共享组件：评审覆盖层 WorkspaceReviewView、流水线编辑器 PipelineEditor、
                             # 项目组 ProjectGroup、项目树 ProjectRail、文件树 FileTree、预览编辑 FilePreviewEditor、
                             # PdfPreview/DocxPreview/ImagePairView、改动面板 GitPanel、接力 HandoffPicker 等
  pipeline-presets.ts        # 内置流水线模板库 PIPELINE_TEMPLATES（新增场景 = 数组加一项）
  presets.ts                 # Base URL 供应商预设表（加供应商 = 加一行）
  run-overview.ts            # 运行中聚合视图（P5）：全部终端标签按「要你管」排序的纯逻辑
  notify.ts                  # 长任务 OS 通知（注意力状态跃迁 + 窗口未聚焦 + 30s 去抖）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑
  git-commit-message.ts      # 空提交信息的本地中性默认信息生成
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  terminal-palettes.ts       # 终端调色板共享表（设置页色卡与终端生效色同源）
  upstream-note.ts           # brew 渠道最新但上游 npm 更高版本的提示逻辑
  store.ts                   # zustand 状态
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表（P1d）：一个 CLI 一张规格——detect/launch_plan/env 规则、
                             # 技能分发目录、安装更新方式、协议与密钥 env 名、官方账号 login/auth/env_remove
  agents.rs                  # 适配器分发入口 + resolve_binary 统一二进制解析（GUI 短 PATH 候选目录兜底）
  profiles.rs                # ProfileStore：profiles.json + 0600 keys.json 存密钥（不用钥匙串，cdhash 坑）
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（结果脱敏）
  global_config.rs           # 「设为全局」：agent 级事务批次写入 CLI 配置（备份/回滚/恢复）
  projects.rs                # 项目档案卡（§11.3）：.ccode/project.toml 读写、项目注册、模板写回、资源登记/发现、
                             # 一键开步（commit_project_bootstrap + TASK.md 落盘 + .git/info/exclude）、append_workspace_inbox
  pty.rs                     # PtyManager：spawn_tracked 公共拉起逻辑，agent/shell 复用
  sessions.rs                # 会话浏览：扫描/解析全部八个 agent 会话（含 Codex .zst、OpenCode SQLite/legacy JSON）、app.db session_meta、pin 快照、用户发起的删除、注意力状态分类（session_tail_state）、流水线步骤名映射（RX3a）
  skills.rs                  # 技能库（§6.13）：SSOT 库 + 八 CLI symlink/copy 分发（cursor 固定 copy）、四路导入（目录/ZIP/GitHub/发现）、ZIP 导出、卸载备份、copy 漂移检测与 resync、新建/编辑（create_skill/update_skill_content，覆盖前备份）
  usage.rs                   # 用量统计（§6.11）：六 agent usage 事件提取、usage_daily 按天聚合、任务成本按工作区归因、官方账号「订阅」口径、内置定价表 + pricing.json 覆盖
  pricing.rs                 # 内置定价表 + pricing.json 覆盖（写入校验）
  settings.rs                # 应用设置（settings.json）：字体/scrollback/汇率/brew 镜像/主题/OS 通知，get/update 两个 command
  fonts.rs                   # 终端字体打包与 Homebrew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层：一次性 prompt（launch_plan 注入）+ 提交信息/会话摘要/PR 描述/冲突建议生成
  handoff.rs                 # 接力（§11.3 机制四）：结构化简报生成（脱敏 + 64KB）落 .ccode/handoff-<时间>.md、handoff_links 接力链登记/固化
  workspaces.rs              # 任务工作区（§6.10）：git worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT 端口段、setup/archive 脚本钩子、评审合并（health/merge/PR）、提货单 artifacts.yaml
  ws_settings.rs             # 项目级 .ccode/settings.toml 三层合并（用户→仓库→local）：files_to_copy/run_mode/scripts；开步自动写入 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk（git_file_hunks/apply_hunk）/勾选提交临时索引（commit_selected_with_index）
  fs_tree.rs                 # 文件树与文件操作（重要路径删除保护，canonicalize 双校验）
  pdf.rs                     # PDF/docx 字节读取（§11.4 P2a/RX4a）：read_pdf_bytes 白名单 + canonicalize 校验 + 上限，base64 传输
  updater.rs                 # CLI 安装/更新（brew TUNA 镜像、npm_for 同目录 npm）+ 应用自身 Tauri updater
  logbuf.rs                  # 诊断日志环形缓冲（设置页「诊断」分区）
  models.rs                  # 共享 DTO
  lib.rs                     # 模块与 Tauri command 注册
```

## 关键约定

- **密钥绝不回显/进 shell**：存储用 0600 权限的 `keys.json`（与 Codex auth.json 同一威胁模型；
  不用 macOS 钥匙串——未签名开发构建热重编译会因 cdhash 失配导致旧条目读不到），
  只在拉起瞬间读出注入子进程 env；`profiles.json` 里只允许存尾号提示（key_hint）；
  `NO_COLOR` 必须 `env_remove`，
  `TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Ccode` 必须显式设置（否则 CLI 输出黑白）。
  由此推论：**外部恢复/复制恢复命令不携带 profile env**（`agents::resume_command_line`，
  对话页 ⇗/⧉ 两个入口共用）——密钥不进剪贴板、不进外部 shell，恢复时用的是用户全局 CLI 配置。
  **⇗ 外部拉起的两个硬要求**：CLI 用绝对路径（`resolve_binary` 结果，⧉ 复制命令才用裸名）；
  shell 必须 `-l -i` 交互登录模式——非交互 `zsh -l -c` 不加载 `.zshrc`（`~/.kimi-code/bin` 这类
  官方安装器 PATH 只写在交互 rc 里，裸名/非交互都会 command not found，Ghostty 报 failed to launch）。
  **Ghostty 单实例约束**：`open -n` 每次开新实例（程序坞堆图标）、`open` 不带 `-n` 不投递 `--args`
  （实测）；Ghostty 已在运行时改走 AppleScript——激活 → ⌘N 新窗 → 剪贴板粘贴命令 + 回车
  （keystroke 逐字输入对中文路径/键盘布局不可靠，故走剪贴板且用后还原；首次需用户同意
  「控制 System Events」自动化授权一次）。
- **会话文本出站前必须在 Rust 层脱敏**：标题/自定义标题/摘要、结构化回放、AI 摘要响应、
  Markdown 导出均不得把已保存的完整密钥或常见密钥前缀送到 React；脱敏只作用于 DTO/导出副本，
  不得回写八个 CLI 的会话源文件。前端遮盖不能作为安全边界。
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
    前进，立即停止展示和选边，必须经用户确认 `merge --abort` 后重新同步最新基准。评审入口以 intent 区分
    （store 的 `WorkspaceReviewRequest.action`：`pr` / `archive` / `resolve-conflict`）：普通「审阅」入口**不**自动准备冲突两侧，
    只有「解决冲突」入口（`resolve-conflict`）才允许评审层自动同步基准分支、准备冲突两侧。
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
  当前累计任务 diff 中的路径；未跟踪文件按全新增展示，二进制只提示，单次文本读取/展示设上限并明确截断。对话页只读展示
  “当前项目改动”，必须声明它不是历史快照，禁止在对话页提交或推送。紧凑 diff 禁止整行使用 ok/err 背景铺色，增删只用
  语义色文字与细边标识，hunk 标题才允许轻量 inset 背景。
- **逐 hunk 验收只覆盖未提交改动，hunks 一律取未暂存 diff（工作树 vs 暂存区）**：丢弃 = `git apply -R` 回工作树、
  暂存 = `git apply --cached` 上暂存区（`git_file_hunks`/`apply_hunk`，白名单同单文件 diff；补丁必须再经
  `patch_targets_single_file` 校验只指向该文件，防传入指向他文件的补丁绕过路径白名单）；已提交的累计 diff
  （评审覆盖层 merge-base diff）禁止做逐 hunk。新文件整个文件算一个块（/dev/null 新文件补丁：暂存 = 跟踪，
  丢弃 = 删文件）。**勾选提交遇部分暂存文件必须走临时索引提交**（`commit_selected_with_index`：`commit -- paths`
  是工作树语义会把未暂存块一起带走；提交成功后按路径 `git reset -q HEAD --` 同步真实索引消幻影 MM），
  未暂存块保持未暂存，未勾选文件的暂存内容不得被波及。
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
  新建/编辑走 `create_skill`/`update_skill_content`：重名拒绝并引导改用「编辑内容」；编辑经临时目录走既有覆盖路径
  （覆盖前备份、辅助文件保留、source/repo 不改写）；◈ 优化开终端让 Agent 直改库文件，备份兜底仍靠保存/覆盖路径。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作：「设为全局默认」（写前必须备份）、会话删除（delete_session/delete_project_sessions，canonicalize 根校验之上再限定**已知会话数据子目录 + 会话后缀白名单**，同根的 auth.json/settings.json 等一律拒绝；**Cursor 因 ~/.cursor 与 IDE 共享，不走目录级白名单**，由 `cursor_deletable` 精确限定 `projects/*/agent-transcripts/**/*.jsonl`；OpenCode 走事务删库行且 db 路径必须等于已知 opencode.db；Codex resume 链删除连带成员文件）、工作树文件删除（限定树当前根目录 + 重要路径黑名单兜底：系统目录/关键用户目录/CLI 配置/.git 一律拒绝；黑名单判断必须 canonicalize 双校验，堵符号链接绕过）。
- **codex 默认沙箱**：交互启动注入 `-s workspace-write`（只能写当前目录），AI 无头调用 `-s read-only`；用户可用 extra_env/参数覆盖。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底（macOS 用户目录 `~/.npm-global/bin`/`~/.local/bin`/`~/bin`/`~/.kimi-code/bin` **先于** `/opt/homebrew/bin`——与用户交互终端的 PATH 解析习惯一致，防止检测到系统目录里的同名旧副本；Linux `~/.local/bin`，Windows `%LOCALAPPDATA%\Programs`/`%APPDATA%\npm`）——打包版 GUI 短 PATH 下检测/启动/更新/安装不再失灵；新增 CLI/工具调用点一律用它，禁直接 `which::which` 或裸名 spawn。
- **npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**：同机多份 node/npm 时用错 npm 会把包装进另一个 prefix、目标副本不变；brew 安装的 CLI 一律走 `brew upgrade`（opencode 自更新是交互 TUI，行输入无法应答）。
- **交互式 TUI 自更新不走 run_streaming_pty**：kimi/opencode 的 `upgrade` 是方向键选择界面，行输入无法应答——
  规格标 `PackagingSpec.interactive_tui`，`check_agent_updates` 按与 update_agent 同一套渠道判定
  （`updater::interactive_self_update`，首条命令是自更新渠道才命中）带出预填命令；配置页「新版/更新」命中时
  改走 `setPendingTerminal`（shellOnly + prefillCommand，同官方账号登录机制）开完整终端让用户方向键操作，普通渠道零变化。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。
- **流水线开步是预设参数的组合调用**（见架构 §11）：点「开始」= 建工作区 + 启 Agent + 注入简报 + 落成 TASK.md，
  全部复用既有工作区创建与终端启动能力；不破坏手动启动栏「Agent → profile → 模型 → 目录 → 启动」主流程。
  开步在 ensure_git_repo 之后先走 `commit_project_bootstrap`（best-effort）：只把 `.ccode` 与 `.gitignore`
  两个 Ccode 自有路径提交进主仓库（add 与 commit 都带 literal pathspec，用户自行暂存的文件也绝不带走），
  避免评审合并被「主文件夹里还有没保存的改动」（主仓脏）拦截；ensure_git_at 生成的默认 .gitignore 含 `*.pdf`（大文件登记为资源引用）。
  **TASK.md 不进 git**：落盘时自动把 `TASK.md` 追加进仓库共享的 `.git/info/exclude`（projects.rs `exclude_task_md`，
  对全部 worktree 与主仓生效，best-effort 不阻断）——TASK.md 是开步脚手架而非任务产物，防止工作区全量提交
  把它带进分支、合并后旧 TASK.md 污染主项目根目录误导后续 Agent。
- **流水线模板库**：内置模板集中在 `src/pipeline-presets.ts` 的 `PIPELINE_TEMPLATES`（综述/科研论文/数据处理/毕业论文），
  新增场景 = 数组加一项，简报必须遵守输入写死/决策写死/交付写死约定（auto 模式无歧义）；用户模板走后端
  `list/save/delete_pipeline_template`，选择器（TemplatePicker）合并展示，后端命令未就绪时优雅降级为仅内置模板。
- **流水线编辑器（RX1）是步骤编辑唯一入口**：`src/components/PipelineEditor.tsx` 全宽覆盖层（fixed inset-0 z-30，
  与评审覆盖层同级），每步一张卡片（名称/工作区名/简报/预期产物/run 脚本/资源绑定），整体写回 steps；
  旧的步骤 ⋯ 内联重命名/编辑简报/+ 步骤表单已移除，新增步骤相关编辑一律进编辑器，不再开第二套入口。
  `ProjectStepDto.resources?: string[]` = 资源绑定（`[[resources]]` 条目的 path），**空/缺省 = 全部资源**；
  `renderTaskMd` 只在绑定非空时过滤「项目资源」段（两处调用 ProjectGroup/TerminalPage 共用函数，无需各自过滤）。
- **官方账号 profile 只读检测 + env 净化**：CLI auth 文件只读探测「已连接」，断开引导用户用 CLI 自己的 logout；
  官方账号拉起不注入 API env，且必须 `env_remove` 同协议残留 API 密钥变量（防静默覆盖账号登录）；
  统计页官方账号显示「订阅」不计费。
- **「接力」是唯一的跨 Agent 交接表述**：接力 = 结构化简报落成文件 + 新 Agent 带简报启动 + 记录接力链，
  明示不是记忆转移；禁用「无缝继续」。v1 机制（handoff.rs）：简报全文过 `redact_sensitive_text` 脱敏 +
  64KB 上限后原子写 `cwd/.ccode/handoff-<时间>.md`（自定义路径不得出项目根）；接力链先按 agent+cwd 登记
  `handoff_links`，新会话被扫描到时固化进 `session_meta.handoff_from_*` 并消费登记（防同目录后续会话误标）；
  kimi/opencode 无启动注入参数，走复制简报路径 + 手动发送，不得伪造注入成功。
- **科研语义只进模板/数据/技能包**：流水线步骤、任务简报、技能包都是可编辑预设；引擎保持通用，
  不在逻辑里写死「文献/数据/论文」概念。
- **界面白话双层呈现（双语义）**：主定位科研工作台，UI 主文案一律白话（保存到历史 / 相对主分支 /
  多出 N 个保存点 / 改动说明），git 技术信息不删除、降为二级呈现（小字 mono、悬浮 title、详情
  popover、⋯ 菜单），**不加任何模式开关**；状态分组等纯逻辑集中放 `src/git-status-groups.ts`，
  新增 git 相关 UI 必须遵守同一双层规则。

## 主题与设计系统

- 全站**沉浸冷黑主题**，令牌集中在 `src/App.css` 的 `@theme` + `[data-theme]` 变体（**七套深色**：沉浸黑(默认)/陶土/Ayu琥珀/Catppuccin/极简灰蓝/Dracula/灰蓝正红），运行时 `document.documentElement.dataset.theme` 切换，**改主题只动这一个文件**；不要在组件里散落 hex。
- 四层「浮起」结构（rail/rail2/canvas/inset 逐级变亮）；文字冷白→灰四档；每主题有独立 CTA 强调色（按钮/选中用 `cta`；可操作状态如「可合并」用**按钮本身的 cta 高亮**表达，不另挂 pill；纯状态 pill 如「活跃」「有冲突」用 inset 灰底 + 语义色小圆点，不用强调色，避免页面花哨）；**状态语义色独立于主题**（ok/err/warn 不随主题变）；**结果横幅（成功/失败）一律 bg-strip/inset 底 + ✓/✗ 语义色文字**，不用整块 bg-ok/bg-err（bg-err 仅保留给需交互警惕的小 pill，如 setup 失败）；零阴影、隐式 hairline。
- **符号语言统一**：导航与图标用单色几何符号（⚙⛁⌨◔✦◫⛭⇄），◈=AI 功能、⚑=pin/保留；**禁用彩色 emoji**（✨📌 已清除）。
- 用户明确否决过的设计：多栏嵌套的对话页、浅色 + 蓝紫渐变侧边栏、按钮排排坐的 profile 行、暖棕色系整体主题、**浅色模式**、emoji 图标。不要改回去。
- 配置页结构（用户详版规格）：可折叠 agent 分组 + 五列网格行 + 顶部筛选与搜索 + 无大面积虚线空状态；图标按钮点击区 ≥28px；**WKWebView 不支持 window.prompt**——一切输入用内联输入框。
- 常规管理页统一使用共享页面框架、标题层级、主操作样式、主题化开关/复选框与稳定加载骨架；
  页面最大宽度必须显式选择，禁在同一节点叠加互相冲突的 `max-w-*`。
- 终端展开态主流程固定为 Agent → profile → 模型 → 目录 → 启动，辅助动作视觉分组；启动后自动收缩、
  PTY shell 回落、专注模式和所有终端标签保持挂载的语义不得因布局优化改变。
- **统计内部活动只认后端 provenance**：Ccode 无头 AI 启动前登记精确 agent+项目路径，usage 事件与项目/模型 DTO 显式携带
  `source/internal`；禁止再按 `/tmp`、`ccode-ai-*` 名称、空模型或 `<synthetic>` 猜测。跨平台路径处理只能做等价规范化，不能
  产生分类。统计页默认归并 `internal=true`，并提供“显示内部活动”开关；开关只改变展示分组，不得改写原始用量索引。
- **会话整理与长回放口径统一**：对话页默认从普通项目树排除 `internal=true`，归并为单一“Ccode 内部 AI”入口；“显示已归档”
  必须同时作用于全部/agent/项目/内部入口计数。标题先折叠空白并拒绝通用占位值，再回落首条真实用户消息，最终使用
  “未命名对话 · 短 ID”。长会话首次只读有界尾窗，向前分页时保持滚动位置；终端不得用全量回放接口做轮询。
- **usage 长会话必须流式解析并按本机日期聚合**：普通 JSONL 与 Codex zstd 会话逐行消费，禁止因整个文件超过固定大小而跳过；
  “今日/近 7 天/近 30 天”及事件日桶都使用系统本地时区。改变解析或日桶语义时必须升级 usage schema 并自动重建旧索引。
- **最近项目采用 stale-while-revalidate**：后端按仓库聚合各 Agent 会话的最大 updated_at、canonical 去重并降序返回；前端启动即预取、
  本地缓存上次成功结果，首次无缓存时用固定骨架占位。终端最多展示 4 个且排除当前项目，缓存路径在进入前仍必须重新验证。
- **管理列表只展示状态与主路径**：配置、工作区、技能和对话列表的行内只保留识别信息、状态与一到两个高频动作；导入/导出、删除、
  诊断、恢复等低频项进入「⋯」。工作区的 PR 与归档必须在统一全宽评审内确认和执行，避免列表页另起一套完成流程；唯一例外是
  正在进行的 merge 冲突，必须在工作区行保留直接的「解决冲突」入口，且仍进入同一评审覆盖层。
- **终端布局必须有明确高度与滚动边界**：App 容器、页面主区、终端三带均维持 `h-full/min-h-0`，外层裁切溢出；只有文件树、对话、
  diff 等内容区各自滚动。禁止把页面级滚动或无约束 flex 子项带回终端，以免窗口缩放、拖动或长内容后出现底部黑屏/空白。
- **PDF 预览（P2a）**：pdf.js 渲染器必须随 PdfPreview 组件动态 import 拆独立 chunk（禁进主包）；`read_pdf_bytes` 只放行
  四类白名单（注册项目登记资源/注册项目根/工作区·仓库根/终端标签 cwd hint），canonicalize 后判定，传输用 base64 字符串
  （macOS 的 Raw 响应会退化为逐字节 JSON 数组，禁改 raw bytes）；选段问 AI 只 pty_write 注入活跃标签输入框，不自动回车。
- **md 阅读模式（RX2a）**：md 文件预览默认「阅读版式」（marked 渲染，pin 版本、随 FilePreviewEditor 懒加载 chunk，
  禁进主包；本地可信内容不引 sanitize 重库），排版样式集中在 App.css `.md-body`（全主题令牌）；「阅读/编辑」切换时
  Monaco 保持挂载仅隐藏（未保存改动/undo 不丢）；「⛶ 沉浸阅读」为 `fixed inset-0 z-30` 全宽覆盖层（Esc 退出，
  终端/PTY 保持挂载）；外部写盘自动刷新沿用现有 watcher 链路，编辑中（dirty）不覆盖。
- **「整理为笔记」（P2b）**：归属判定只在后端 `pdf_owner_project`（登记资源 canonical 精确命中 → 项目根最长前缀命中，
  都未命中由前端提示去登记，前端不做路径归属猜测）；写入只走 `append_workspace_inbox`——目标固定为工作区根内
  `notes/inbox.md`（不接受外部子路径），单次 ≤ 64KB、读-改-原子写、已存在文件 canonicalize 双校验防 symlink 逃逸；
  笔记步骤定位规则 = `workspaceName === "lit-notes"` 优先、回落流水线第二步；无活跃工作区时复用一键开步链路
  （ensure_git_repo → create_workspace → TASK.md best-effort → 追加 inbox → pendingTerminal + ORGANIZE_NOTES_PROMPT 预填）。
- **步骤胶囊对照（RX2b）**：跨页「文件树切根」走 store 一次性 `enterCwdReq`（终端页消费后复用 enterCwd/externalCwd
  「真进入」机制，文件树根随活动标签 cwd）；`previewReq` 可带可选 `root`（文本预览的后端根约束，缺省回落活动标签
  cwd）。步骤产物面板只在打开时用 `list_dir` 拉取一次（无根约束，目录列一层文件、父目录匹配区分文件/未产出），
  不进轮询；已完成步骤读项目根（main），其余读工作树。胶囊悬浮信息（目录/agent/profile）读终端页同一键
  `ccode.wsLast.<worktreePath>`。

## 路线图（见 docs/architecture.md §11 演进线）

- 通用控制台阶段 P0–W3 ✅（六 agent 适配器、双模式配置、多标签终端、会话可视化、统计页、IDE 形态、任务工作区与评审流）——2026-08 起演进为「AI 科研工作台」，以下为科研线新阶段。
- **P1 四条并行线 ✅**：
  - P1a 官方账号 ✅：profile 双类型（API/官方账号，第一批 Claude/Codex/Gemini）；终端内跑 CLI 登录命令连接；只读检测 auth 文件 + 冲突配置黄色警告；拉起不注入 API env 且 env_remove 残留密钥变量；统计页显示「订阅」不计费
  - P1b 流水线骨架 ✅：`.ccode/project.toml` 档案卡 + 项目注册、工作区页按项目分组 + 流水线胶囊概览（状态从工作区派生；分段进度条已收敛为「研究流程 d/t」文字）、一键开步（含 bootstrap 自动提交 + TASK.md exclude）、资源面板与自动发现、非 git 目录引导 init；首启引导为轻量版（空流水线走模板选择器），完整版（演示数据 + 示例 PDF）留 backlog；工作区类型驱动默认值（数据类跳端口）未做，留 backlog
  - P1c 供应商预设补齐 ✅：claude-code 补 DeepSeek/智谱 Anthropic 兼容端点、codex/qwen/kimi/opencode 补 DeepSeek/智谱等；此后加供应商 = `src/presets.ts` 加一行
  - P1d 适配器注册表 ✅：per-agent 硬编码 match 收敛为 `agent_specs.rs` 中央声明式 AgentSpec 注册表（一个 CLI 一张规格）；解析器与 usage 提取器保持每 CLI 一个解析器文件，注册表只做分发入口
- **P2 文献 ✅**：PDF 预览 + 选段问 AI（P2a：pdf.js 懒加载 chunk + `read_pdf_bytes` 白名单）、整理为笔记（P2b：`pdf_owner_project` 归属反查 + `append_workspace_inbox` 写 `notes/inbox.md` + 无工作区走一键开步）、文献技能包（lit-search/lit-notes/review-framework/review-writing，notes/*.md + references.bib 规范）
- **P3 数据 + 接力 ✅**：数据处理模板 + 技能包（data-clean/data-eda）、提货单 artifacts.yaml v1（手动登记 + md5/大小，下一步 TASK.md 自动带提货单段）、图片评审（ImagePairView 双栏看图）、长任务 OS 通知（notify.ts）、接力包 + 接力链可回溯（handoff.rs，对话页「⇄ 接自」badge）
- **P4 论文 ✅**：科研论文/毕业论文 manuscript 模板 + quarto render 脚本（render-draft/render-final，RX4a 追加 export-docx）、quarto-render 技能、提货单登记的 PDF 产物纳入预览白名单（根外产物按精确路径放行）；bib 联动以模板简报引用 references.bib 的务实形式落地
- **RX 体验批 ✅**：RX1 流水线编辑器 + 步骤资源绑定；RX2a md 阅读版式/沉浸、RX2b 步骤胶囊对照（◫ 切根 + 产物面板）；RX3a 对话步骤化（步骤名 badge/分组/搜索）、RX3b 技能新建/编辑/◈ 优化 + 步骤挂载技能；RX4a docx 预览 + export-docx；笔记对话式批改（选段「◈ 讨论/改写此段」）；界面白话双层 + 工作区页/列表精简
- **P5 通用层打磨（部分 ✅）**：逐 hunk 验收 ✅、跨标签聚合视图 ✅、成本按工作区归因 ✅（任务成本）、历史时间线视图 ✅（first-parent 主线 + 白话翻译：✓ 验收合并/⚙ 自动保存/◔ 保存）；批量验收、云端会话双源调研留 backlog
- **Backlog（记录不动手）**：SSH 远程执行、MCP 配置分发调研、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（P2 验证后评估）、批量验收、云端会话双源调研、首启引导完整版（示例课题带演示数据 + 示例 PDF）、工作区类型驱动默认值（数据类跳端口）、内置技能种子机制（**等用户把现有技能优化完善后再做**：目前六个技能只在本机库，应用无内置/首启导入机制）

**当前待办**：

- P0 收尾当前批次：全量文档同步 → 走查 → [skip ci] 提交 → 可选发版；历史时间线视图待并行组合入后补手册条目
- macOS 签名公证（暂缓，需 Apple Developer 会员 + CI 配 6 个 APPLE_* secrets，见架构 v1.3）
- Intel macOS 安装包（暂缓：CI macos-latest 只出 aarch64；加 `x86_64-apple-darwin` target 构建时间翻倍，真有 Intel 用户再加，见架构 v1.3 / README 安装节）
- OpenCode Windows 数据路径未核实（matrix 标注「文档与源码不一致」），Windows 用户验证会话/用量统计后修正
- Skills 更新检测与在线编辑（v2 口子，见架构 v0.9 / §6.13）
- Claude Code hooks 精确化注意力标记（v2 评估项，需写用户配置，见架构 v0.7）
