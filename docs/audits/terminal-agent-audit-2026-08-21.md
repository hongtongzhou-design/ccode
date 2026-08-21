# Ccode 内嵌终端与九家 Agent 全链路审计

日期：2026-08-21  
范围：macOS + Ghostty 首轮代码审计；Windows/Linux 采用同一接口的静态边界审查。  
结论：外部启动已改为“安全临时复现”路径；复制命令仍保持无密钥、只依赖全局配置的兼容路径。

## 结论摘要

此前内嵌终端走 `pty_spawn → launch_plan`，外部恢复/接力走字符串命令，二者的 profile 环境和模型参数不一致。现在恢复与提炼外部启动统一走后端临时 wrapper：前端只传 `profileId`、`model`、会话/提示词等非敏感元数据，后端从 `keys.json` 读取密钥并复用同一套 Agent 启动计划。

wrapper 的约束：

- 仅创建于 `<config>/ccode/external-launch/`，Unix 目录 0700、文件 0600；通过 `/bin/sh` 按路径执行，Windows 使用一次性 PowerShell 文件。
- 密钥、OpenCode 内联 JSON、profile `extraEnv` 只存在于 wrapper 内容，不进命令参数、剪贴板、前端 IPC 或普通日志。
- wrapper 首行自删；启动失败立即删除；未被执行时 60 秒兜底清理。
- 外部恢复/接力必须带明确的 `profileId`；profile 缺失、删除或与 Agent/provider 不兼容时 fail-closed，不静默回退到该 Agent 的第一个配置。
- 复制命令仍不携带 profile 密钥，明确属于“全局配置模式”。

## P0/P1 问题与修复

| 严重度 | 问题 | 影响 | 修复状态 |
| --- | --- | --- | --- |
| P0 | 外部恢复/接力不注入当前 profile 密钥，且 AppleScript 会把命令复制到剪贴板 | 错误账号/端点；若直接把密钥拼入命令还会泄漏 | 已修复：剪贴板只含 wrapper 路径 |
| P1 | 外部新会话不带当前模型和 Agent 特殊参数 | Codex/OpenCode/Kimi/Grok/Cursor 等外部行为与内嵌不一致 | 已修复：复用 `launch_plan` + `prepare_launch` |
| P1 | Codex 外部恢复只补 provider 定义，不补 `CODEX_API_KEY` | `ccode` provider 能解析但认证失败 | 已修复：key 进入临时 wrapper 环境 |
| P1 | 外部恢复/接力依赖全局配置 | 全局配置未同步时 profile 失效 | 已修复 API profile；官方账号仍按官方 CLI 登录态运行 |
| P1 | 外部恢复没有可靠的 profile 选择上下文 | 多 profile 时可能恢复到错误端点 | 已修复：会话页传兼容 `profileId` 与模型；后端再校验 agent/provider |

## 九家 Agent 复用矩阵

| Agent | 内嵌启动计划 | 外部安全复现 | 会话恢复参数 | 主要边界 |
| --- | --- | --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`、模型槽位 | wrapper 环境完整复用 | `-r <id>` | 官方账号不注入 API 凭证 |
| Codex | `CODEX_API_KEY`、`ccode` inline provider、`-m`、sandbox、catalog | wrapper 环境 + inline provider + catalog | `resume <id>` | catalog 为非敏感持久缓存；官方账号走自身登录 |
| Gemini | `GOOGLE_GEMINI_BASE_URL/GEMINI_API_KEY/MODEL` | wrapper 环境完整复用 | `-r <id>` | `-i` prompt 形态由注册表决定 |
| Qwen | OpenAI/Anthropic 协议 env + `--auth-type` | wrapper 环境完整复用 | `-r <id>` | 协议必须来自 profile |
| OpenCode | `OPENCODE_CONFIG_CONTENT` provider JSON + 禁止自动更新 | wrapper 内联 JSON，不落全局配置 | `--session <id>` | 使用 `--prompt` 注入提炼接力；无已核实只读参数 |
| Kimi | `KIMI_MODEL_*` 与旧版 `KIMI_*` 双通道、模型元数据 | wrapper 环境完整复用 | `-S <id>` | 新旧 CLI 变体由注册表/环境兼容 |
| CodeBuddy | `CODEBUDDY_BASE_URL/API_KEY/MODEL` | wrapper 环境完整复用 | `-r <id>` | 官方账号清理残留 API env |
| Cursor CLI | `CURSOR_API_KEY/API_ENDPOINT` + `--model` | wrapper 环境 + model flag | `--resume <id>` | 全局默认能力仍按能力表限制 |
| Grok Build | `XAI_API_KEY/GROK_MODELS_BASE_URL/DEFAULT_MODEL` + allowed model overlay | wrapper 环境 + `GROK_CONFIG` | `-r <id>` | 全局默认/MCP 写入仍是产品限制 |

## 终端能力审计

### 已具备

- xterm DOM 渲染（macOS）与 WebGL 探针/回退（Windows）、Fit、Search、WebLinks、ANSI 256 色/truecolor、CJK 字体回退。
- PTY resize、进程组终止、输出帧合并、可见/隐藏标签 backlog、scrollback 上限、Bracketed Paste 检测与多行包裹。
- Alternate Screen、鼠标报告、键盘修饰键和 CLI 自己请求的 kitty/CSI-u 序列由 xterm/适配层传递；Kimi Enter/图片粘贴有专门兼容逻辑。
- 剪贴板图片落到 Ccode 临时目录后输入已转义路径；文件拖入同样只输入路径，不自动执行。

### 与 Ghostty 的差距（P2/P3）

- 已接入 xterm Unicode 11 addon；复杂 emoji、组合字符和新 CJK 宽度仍建议在真实 TUI 中验收，字体 fallback 与 Ghostty 仍可能有细微差异。
- 没有统一的 shell integration/OSC 133 命令边界，因此无法像 Ghostty 一样可靠显示命令开始、结束和退出码。
- 没有 Kitty/iTerm2/sixel 图片协议渲染；目前“图片粘贴”是路径输入，不是终端内图像显示。
- 没有面向高吞吐输出的显式前后压（PTY 后端已有 16ms 合并和 backlog 上限，但 xterm 输入/渲染没有 Ghostty 级别的流控反馈）。
- 原生终端的选区复制、分屏布局和窗口管理由 WebView/产品层模拟，语义可用但不是 Ghostty 的 GPU 原生实现。

这些是能力差距，不是当前主流程的 P0/P1 缺陷；Alternate Screen、Bracketed Paste、鼠标和 resize 已由 xterm/PTY 路径覆盖。

## 验证记录

已通过：

- `npm test`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`（608 passed, 1 ignored）
- `cargo test --manifest-path src-tauri/Cargo.toml --lib handoff::tests::`（13 passed）
- PTY、Agent 注册表、外部 wrapper 与接力相关测试均包含在上述全量结果中

### 本机脱敏现场（macOS，2026-08-21）

仅记录二进制路径、版本和配置结构，不记录密钥值、完整 URL 或会话正文：

| Agent | 检测结果 | 外部配置现场（键名/结构） |
| --- | --- | --- |
| Claude Code | `/opt/homebrew/bin/claude` · 2.1.212 | `~/.claude/settings.json` 存在 `env.*`、`model`；它是全局状态，不能代表当前 Ccode profile |
| Codex | `~/.local/bin/codex` · 0.149.0 | `~/.codex/config.toml` 存在 `model_provider` 与 `[model_providers.custom]`；与 Ccode 的 `ccode` inline provider 不是同一命名 |
| Gemini | `/opt/homebrew/bin/gemini` · 0.46.0 | `~/.gemini/.env` 存在但当前未发现可承接 profile 的键；`settings.json` 未发现 Ccode 端点结构 |
| Qwen | `/opt/homebrew/bin/qwen` · 0.21.1 | `~/.qwen/settings.json` 只看到 UI/推理相关键，未看到当前 profile 的 provider 表 |
| OpenCode | `/opt/homebrew/bin/opencode` · 1.18.10 | `~/.config/opencode/` 当前无可用 `opencode.json(c)` 配置；复制命令仍依赖全局配置，⇗ 安全外部启动改用 wrapper 内联 `OPENCODE_CONFIG_CONTENT` |
| Kimi | `~/.kimi-code/bin/kimi` · 0.38.0 | `~/.kimi-code/config.toml` 存在多个 provider/model 表（含 `ccode`）；是否与当前选择一致不能由全局文件单独保证 |
| CodeBuddy | `~/.local/bin/codebuddy` · 2.132.0 | `~/.codebuddy/` 主要是状态/市场文件，未看到当前 Ccode profile 的明确端点注入 |
| Cursor CLI | `~/.local/bin/cursor-agent` · 2026.08.04-aaa8809 | 以 `cursor-agent` 为实际二进制名；`~/.cursor/` 存 CLI/IDE 状态，未作为 Ccode profile 的安全复现入口 |
| Grok Build | `~/.local/bin/grok` · 1.0.5 | `~/.grok/config.toml` 有 `models.default`；同时有 `auth.json`，API profile 与官方登录态不能靠全局文件混用 |

Ghostty 当前正在运行；运行中的实例现在使用 Ghostty 原生 AppleScript 字典创建新窗口，工作目录单独设置，先启动 `/bin/sh`，再通过 `initial input` 执行带 shell 引号的 wrapper 路径，避免 `Application Support` 等带空格路径被 Ghostty 的 `command` 字段错误拆分；不依赖 System Events 或剪贴板。未运行实例仍使用 `open -na`。真实九家 CLI 的 API 请求、模型目录和 TUI 行为仍不做在线验证。

最近补充的静态/本机验证：九家 CLI 均已用各自 `--help` 检查恢复/模型/提示词参数并返回版本；Qwen 的帮助输出明确使用 `-i/--prompt-interactive` 与 `-r/--resume`；OpenCode 1.18.10 确认 `--prompt`，已接入外部提炼接力；外部提炼接力对 Claude/Qwen/CodeBuddy 等固定会话 ID Agent 也会生成新的 `--session-id`；Unix wrapper 已用 `/bin/sh` 实际执行并确认启动后文件消失；wrapper 文件权限与密钥不进 argv 的单测通过；`~`/`~/子目录` 工作目录已在 wrapper 前展开；当前热更新进程为 Vite `localhost:17575` + 仓库 `target/debug/ccode`，未混入旧 bundle。

仍需在真实终端做的验收：九家 Agent 各执行真实 API/TUI 的“内嵌新建 / 外部新建 / 内嵌恢复 / 外部恢复”四组对照；Ghostty 未运行实例、原生 AppleScript 失败路径与 wrapper 清理；进程列表、wrapper 权限/清理、CJK/emoji、TUI 高速输出、Alternate Screen 和 resize。无 API 请求的版本、帮助、启动参数与 wrapper 安全核验已完成。
