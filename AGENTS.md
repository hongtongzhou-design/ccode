# AGENTS.md

## 项目简介

Ccode 是一个「AI 编码 Agent 统一启动器 + 配置中心 + 会话监控台」桌面应用（Tauri v2 + React/TS）。
为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code 管理多套 API 配置（端点/密钥/模型），
内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

**设计文档即规格**：改架构/适配逻辑前先读 `docs/architecture.md`（总体设计）和
`docs/agent-integration-matrix.md`（六个 CLI 的 env/配置/会话格式，源码级调研结论，勿凭印象写 env 变量名）。

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
  sessions.rs                # 会话浏览：扫描/解析 Claude+Codex+Gemini+Qwen 会话（含 .zst）、app.db session_meta、pin 快照
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
- **各 CLI 会话/配置目录一律只读**；唯一允许的写操作是「设为全局默认」，且写前必须备份。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。

## 路线图（见 docs/architecture.md §8）

- P0 ✅ 骨架：Profile CRUD + Claude/Codex 适配 + 单标签终端 + shell 回落
- P1 ✅ 六 agent 适配器（Gemini/Qwen/OpenCode/Kimi 双协议）、全局写入模式（备份/恢复）、
  多标签终端、三平台 CI 工作流（.github/workflows/build.yml）
- P2 ✅ 会话可视化：Claude/Codex/Gemini/Qwen 解析器、resume 链合并、项目聚合、
  pin 快照保留、tags/归档/搜索、SessionLink 终端↔会话联动（--session-id + 探测）
- P3 OpenCode/Kimi 会话解析（SQLite/wire 协议）、token/费用统计、注意力标记（badge 思路）
- P4 IDE 形态（文件树、Monaco）、本地 API 代理（可选）
