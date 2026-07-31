# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（关键约定、主题与设计系统、本机环境档案）和 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：功能增改时必须同步更新 `docs/user-guide.md`（用户操作手册）。

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

npm run tauri dev      # 开发（前端 HMR + Rust 改动自动重启）
npm run build          # 前端构建（tsc + vite）
cd src-tauri && cargo build / cargo test
npm run tauri build    # 打包
```

环境：Node 22 + npm（无 pnpm）；Rust stable（minimal profile）；crates 走 rsproxy 镜像（`~/.cargo/config.toml`）。

## 本机环境档案（踩坑记录，新会话必读）

- **网络：访问 GitHub/raw/formulae.brew.sh 很慢**。必须用镜像：crates → rsproxy（已配）；rustup → TUNA；brew → `HOMEBREW_API_DOMAIN`/`HOMEBREW_BOTTLE_DOMAIN` 指 TUNA（已在 updater.rs 内置）；npm 如变慢 → `registry.npmmirror.com`。
- **brew 曾整体损坏**（卡在拉 `formulae.brew.sh` 内部 API 元数据）：重装 brew 后恢复。遇到 brew 异常先 `brew doctor`，别先怀疑应用代码。
- **macOS 钥匙串对未签名开发构建会因 cdhash 失配丢条目**——密钥存储因此弃用钥匙串，改 0600 `keys.json`（勿改回）。
- **管道输出块缓冲**：brew/npm 等检测到非 TTY 会块缓冲导致"无输出"假象——安装/更新命令必须在 PTY 里跑（updater.rs 已如此，别退回管道）。
- **GUI 应用 PATH 很短**：Finder 启动的打包应用可能找不到 npm 装的 CLI；开发模式（`npm run tauri dev`）继承终端 PATH 不受影响。
- **本机 CLI 安装情况**：claude/codex/gemini/qwen 为 brew 或 npm 安装（检测见 updater.rs 报告）；opencode 未装；kimi 为新版（~/.kimi-code）。
- **git 提交**：用户要求 CI 耗时久，常规提交加 `[skip ci]`，里程碑提交才跑三平台 CI。

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
  skills.rs                  # 技能库（§6.13）：SSOT 库 + 六 CLI symlink/copy 分发、四路导入（目录/ZIP/GitHub/发现）、ZIP 导出、卸载备份
  usage.rs                   # 用量统计（§6.11）：六 agent usage 事件提取、usage_daily 按天聚合、内置定价表 + pricing.json 覆盖
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
- **Profile 的 extra_env 排在 adapter 内置 env 之后注入**，供用户覆盖内置值（CommandBuilder 后者生效）。
- **终端行为**（用户明确要求）：
  - 终端配色使用 VS Code Dark+ 风格调色板，集中在 `TerminalPage.tsx` 的 `theme` 一处，换主题只改这里；
  - 「停止」或 agent 自行退出后，终端必须**自动回落到用户登录 shell**（`$SHELL -l`，同工作目录），
    不允许死在最终画面；用户手动 `exit` shell 不自动重开；
  - 回落的 shell 不携带任何 profile 环境变量（密钥只在 agent 进程内）；
  - agent 与 shell 共用 `pty.rs` 的 `spawn_tracked`，退出事件按 PTY 类型区分处理。
- **各 CLI 会话/配置目录一律只读**；例外只有两处：「设为全局默认」（写前必须备份）和用户显式发起的会话删除（delete_session/delete_project_sessions，且路径必须落在已知会话根目录内）。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。

## 主题与设计系统

- 全站**沉浸冷黑主题**，令牌集中在 `src/App.css` 的 `@theme`（`bg-rail`/`bg-rail2`/`bg-canvas`/`text-l2` 等语义类），**改主题只动这一个文件**；不要在组件里散落 hex。
- 四层「浮起」结构：应用侧栏 `#08090D`（最暗）→ 页面左栏 `#0D0F15` → 内容区 `#11131A` → 内嵌层 `#181C27`；文字冷白→灰蓝四档（`#EEF2FA/#AEB6C6/#767E90/#525A6B`）；每视图仅一个绿色 CTA（`#16A349`，保留色）；状态用「深底浅字」pill 对；零阴影、隐式 hairline `#202532`；交互蓝 `#7EA2E8` 只给链接/可点提示，**其他一律无高饱和色**。
- 用户明确否决过的设计：多栏嵌套的会话页（三栏 → 两栏树+列表/回放）、浅色 + 蓝紫渐变侧边栏、按钮排排坐的 profile 行、**暖棕色系（红棕/暖灰阶梯）**。不要改回去。
- 配置页结构（用户详版规格）：可折叠 agent 分组（有配置默认展开）+ 五列网格行（名称/endpoint/模型/密钥/操作）+ 顶部筛选与搜索 + 无大面积虚线空状态；图标按钮点击区 ≥28px。

## 路线图（见 docs/architecture.md §8）

- P0 ✅ 骨架：Profile CRUD + Claude/Codex 适配 + 单标签终端 + shell 回落
- P1 ✅ 六 agent 适配器（Gemini/Qwen/OpenCode/Kimi 双协议）、全局写入模式（备份/恢复）、
  多标签终端、三平台 CI 工作流（.github/workflows/build.yml）
- P2 ✅ 会话可视化：Claude/Codex/Gemini/Qwen 解析器、resume 链合并、项目聚合、
  pin 快照保留、tags/归档/搜索、SessionLink 终端↔会话联动（--session-id + 探测）
- P3 OpenCode/Kimi 会话解析（SQLite/wire 协议，**Kimi 已完成**）、token/费用统计、注意力标记（badge 思路）
- P4 IDE 形态（文件树、Monaco）、本地 API 代理（可选）
- W1 任务工作区核心闭环 ✅（worktree 创建/归档/恢复、files-to-copy、端口注入、工作区页面、会话归并；用户验收通过）
- W2 工作区自动化 ✅（.ccode/settings.toml 三层合并、setup/archive 脚本钩子、run 脚本按钮 + nonconcurrent 互斥）
- W3 评审流 ✅（merge-base 任务 diff、workspace_health 状态机、本地合并+归档、gh PR 创建）
