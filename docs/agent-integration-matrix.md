# 八个 CLI Agent 适配参考（调研蒸馏版）

> 供实现 AgentAdapter 时查阅。来源：2026-07-30 对官方文档与源码的调研（多数核到源码行号）。
> 2026-08-05 补充核实各供应商 Anthropic/OpenAI 兼容端点（见 §1 附注），来源均为官方文档页面。
> 2026-08-06 新增 §7 CodeBuddy Code（v2.132.0 实机验证，含真实会话样本与 product.json 核实）。
> 标记「易漂移」的均为各 CLI 内部格式，解析必须防御式（跳过未知类型、容忍缺字段、容忍末行截断）。

## 1. Claude Code

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `claude`；`claude --version`；`claude auth status`（JSON，exit 0=已登录，适合预检） |
| 注入 env | `ANTHROPIC_BASE_URL`（中转端点）、`ANTHROPIC_AUTH_TOKEN`（Bearer，网关场景首选）、`ANTHROPIC_API_KEY`（X-Api-Key；交互模式首次使用会弹一次性确认）、`ANTHROPIC_MODEL` |
| 全局配置 | `~/.claude/settings.json`：`{"env": {...}, "model": "..."}`。**注意：settings 的 env 块会覆盖 shell env**；也可用 `--settings <file-or-json>` 注入不落地 |
| 会话存储 | `~/.claude/projects/<sanitize(cwd)>/<session-uuid>.jsonl`；目录名 = 路径中所有非字母数字字符替换为 `-` |
| 会话格式 | JSONL。envelope：`uuid/parentUuid/timestamp/sessionId/cwd/gitBranch/version/isSidechain/type`；`type=user/assistant`，assistant 的 `message` 是原始 API 响应（content blocks + usage）；另有 `ai-title`（会话标题）、`summary`、`file-history-snapshot` 等类型，未知 type 必须跳过。**易漂移** |
| 关键启动参数 | `--model`、`-p`（非交互）、`-c/-r`（续会话）、`--session-id`（固定会话 ID=文件名）、`--settings` |
| 坑 | 非官方 base URL 会禁用 Remote Control 与部分 MCP 行为；CLI 自己会给配置文件做时间戳备份（我们不是唯一写者）；`CLAUDE_CONFIG_DIR` 可整体搬迁配置目录（完全隔离方案，但会话也随之隔离）；`/model` 选择器默认只显示内置别名，Ccode 用 `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`(+`_NAME`) 注册前 4 个模型、第 5 个走 `ANTHROPIC_CUSTOM_MODEL_OPTION`，更多模型需 `/model <id>` 手输 |

**Anthropic 兼容端点（2026-08-05 核实，来源均为官方文档）**：

- **智谱 GLM**：`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` + `ANTHROPIC_AUTH_TOKEN`（国内站；国际站为 `https://api.z.ai/api/anthropic`，两站账号不通用）。官方推荐模型映射 `glm-4.7`（haiku）/ `glm-5.2[1m]`（sonnet/opus）。来源：docs.bigmodel.cn/cn/guide/develop/claude、docs.z.ai/devpack/tool/claude；实测 `POST /api/anthropic/v1/messages` 无 key 返回 401，端点存活。
- **DeepSeek**：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_AUTH_TOKEN`。官方推荐 `deepseek-v4-pro[1m]`（opus/sonnet）+ `deepseek-v4-flash`（haiku/subagent，`CLAUDE_CODE_SUBAGENT_MODEL`）；传入 claude 模型名会自动映射。来源：api-docs.deepseek.com/guides/anthropic_api、/quick_start/agent_integrations/claude_code。
- 两家兼容端点注入方式与官方一致（同一组 env），适配器无需特殊分支；注意「坑」行所述非官方 base URL 的副作用同样适用。

## 2. Codex CLI

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `codex`；`codex --version`；`codex login status`；`codex doctor` |
| 注入 env | `CODEX_API_KEY`（优先级高于 auth.json）、`OPENAI_API_KEY`。**没有 base URL / 默认模型的环境变量** |
| base URL 注入方式 | 启动参数 `-c model_providers.<id>.base_url='"https://..."'`（需同时在 config 里定义 provider）或写 `~/.codex/config.toml`：`openai_base_url` 或 `[model_providers.<id>]`（`base_url` + `env_key` = 存放 key 的环境变量名） |
| 全局配置 | `~/.codex/config.toml`（TOML）+ `~/.codex/auth.json`；`CODEX_HOME` 可整体搬迁（目录必须预先存在） |
| 会话存储 | `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`；旧文件会被后台 **zstd 压缩为 `.jsonl.zst`**（magic `28 b5 2f fd`），两者都要能读；另有 `history.jsonl`（仅用户 prompt）和 SQLite 镜像库（版本化文件名，勿依赖） |
| 会话格式 | JSONL `RolloutLine {timestamp, type, payload}`；首行 `session_meta`（含 **cwd** = 项目归属依据）；`response_item`（消息）、`event_msg`（含 token_count）、`turn_context`（每轮 model/cwd）。不按项目分目录，**项目归属靠 session_meta.cwd**。**易漂移** |
| 关键启动参数 | `-m`、`--profile`、`-c key=value`（最高优先级）、`codex exec`（非交互，`--json` 输出事件流）、`codex resume` |
| 坑 | **只支持 Responses API**（`wire_api="chat"` 已移除并报错）——中转必须实现 `/v1/responses`；`codex exec` 默认要求 git 仓库（`--skip-git-repo-check`）；凭证可能存 OS keyring 而非 auth.json；TUI `/model` 选择器的模型目录来自 `model_catalog_json` 指定的 JSON 文件（**仅启动时读取**，Ccode 已为每个 profile 生成 catalog） |

## 3. Gemini CLI

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `gemini`（npm `@google/gemini-cli`，Node ≥ 20）；`gemini --version` |
| 注入 env | `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`（设了即进入 GATEWAY 模式，官方支持中转；要求 HTTPS 或 localhost）、`GEMINI_MODEL`。env 优先级仅次于 CLI 参数 |
| 全局配置 | `~/.gemini/settings.json`（`model.name`、`security.auth.selectedType`）；`GEMINI_CLI_HOME` 可整体搬迁 |
| 会话存储 | `~/.gemini/tmp/<slug>/chats/session-<时间>-<id8>.jsonl`；**slug 映射读 `~/.gemini/projects.json` 和目录内 `.project_root` 标记，不要自己推导**（旧版是 sha256 目录，有迁移） |
| 会话格式 | JSONL。首行 metadata；消息 `{id, timestamp, content, type: user/info/error/warning/gemini}`，gemini 类型带 `toolCalls` 和 `tokens{input,output,cached,thoughts,tool,total}`；**控制记录 `$rewindTo`（截断后续消息）和 `$set`（patch 元数据）必须处理**，不能简单拼接。旧版单 JSON 文件仍需兼容。**易漂移** |
| 关键启动参数 | `-m`、`-p`（进入 headless）、`--output-format stream-json`、`-r/--resume`、`--list-sessions` |
| 坑 | **默认 30 天自动删除会话**（`general.sessionRetention`）；新目录首次运行有信任确认（`--skip-trust` 绕过）；管道 stdio 会静默进入 headless；会话文件边写边追加，末行可能残缺；**多模型切换无配置注入机制**（已核实），只能在 TUI 里 `/model set <id>` 手动切换 |

## 4. Qwen Code

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `qwen`（npm `@qwen-code/qwen-code`，Node ≥ 22；或 brew）；`qwen --version` |
| 注入 env（按协议） | openai 协议：`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`；anthropic 协议：`ANTHROPIC_*` 三件套；配合 `--auth-type openai|anthropic`。credential 优先级：CLI flags > shell env > .env > settings env |
| 全局配置 | `~/.qwen/settings.json`：`modelProviders.<协议>.models[{id, baseUrl, envKey, generationConfig}]` + `security.auth.selectedType` + `model.name`；`QWEN_HOME` 整体搬迁 |
| 会话存储 | `~/.qwen/projects/<sanitize(cwd)>/chats/<uuid>.jsonl`（sanitize 规则同 Claude）；归档在 `chats/archive/`；目录名可能碰撞，**项目归属以首条记录的 `cwd` 为准** |
| 会话格式 | JSONL `ChatRecord {uuid, parentUuid, sessionId, timestamp, type: user/assistant/tool_result/system, subtype, cwd, version, message（genai Content 格式）, usageMetadata, model}`；`custom_title` 系统记录给标题。旧版（约 <0.10，具体版本未核实）是单 JSON 文件。**易漂移** |
| 关键启动参数 | `-m`、`--auth-type`、`--openai-api-key/--openai-base-url`（仅有的凭证 flags）、`--session-id`、`--continue/--resume` |
| 坑 | Qwen OAuth 免费额度已于 2026-04 停；profile 需记录协议类型（多协议 agent）；录制可被关闭（`general.chatRecording:false`），此时无会话文件；TUI `/model` 对话框列出的就是 `modelProviders.<协议>.models` 条目（仅全局写入模式可注入多模型，注入模式单模型是 CLI 限制） |

**兼容端点（2026-08-05 核实）**：openai 协议可接智谱 GLM（`https://open.bigmodel.cn/api/paas/v4`，官方 quick-start 仍在用）；anthropic 协议（`--auth-type anthropic` + `ANTHROPIC_*` 三件套）理论上可接 §1 附注的 GLM/DeepSeek Anthropic 兼容端点，但未实测，接入前需验证。

## 5. OpenCode

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `opencode`（npm `opencode-ai`；仓库已更名 anomalyco/opencode）；`opencode --version` |
| 注入方式 | **无通用 key/baseURL env**。用 `OPENCODE_CONFIG_CONTENT`（内联配置 JSON，优先级几乎最高）+ `OPENCODE_AUTH_CONTENT`（内联凭证 JSON，未文档化但源码确认）做启动注入。provider 配置：`provider.<id>.options.{apiKey, baseURL}` + `npm: "@ai-sdk/openai-compatible"` 接任意中转 |
| 全局配置 | `~/.config/opencode/opencode.json(c)`（支持 `{env:VAR}` 插值）。**优先级坑：config > auth.json > env**，注入必须走 config 层才确定 |
| 会话存储 | **v1.2.0+：单一 SQLite** `~/.local/share/opencode/opencode.db`（WAL 模式；表：`session/message/part/project`，`message.data`/`part.data` 为 JSON 列）。更早版本是 `storage/` 目录的扁平 JSON 文件（需双解析） |
| 会话格式 | `session` 表直接有 `title/cost/tokens_*/time_*`；项目 = git 首个 commit hash，`project.worktree` 列给路径；message.data：`{role, time, model, tokens, cost, ...}`；part.data：`type: text/reasoning/tool/...` 判别联合。**drizzle 迁移频繁，易漂移** |
| 官方替代路径（推荐优先用） | `opencode export <id>`（完整 JSON）、`opencode session list --format json`、`opencode db "<sql>" --format json`、`opencode serve`（HTTP+OpenAPI）——比解析内部 DB 稳定 |
| 坑 | 自更新会在启动时替换二进制（`OPENCODE_DISABLE_AUTOUPDATE=1`）；provider SDK 运行时下载（首跑要联网）；Windows 数据路径文档与源码不一致（未核实） |

## 6. Kimi Code（注意：两个产品都叫 `kimi`）

| 项 | 新版 kimi-code（TS，0.x，现役） | 旧版 kimi-cli（Python，1.x，收缩中） |
|---|---|---|
| 检测 | `~/.kimi-code/` 存在；`kimi doctor` 可用 | `~/.kimi/` 存在；`kimi --version` 为 1.x |
| 注入 env | **故意忽略 shell env 的 API key**。唯一注入通道：合成模型 `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` + `KIMI_MODEL_BASE_URL` + `KIMI_MODEL_PROVIDER_TYPE`（kimi/anthropic/openai） | `KIMI_API_KEY`/`KIMI_BASE_URL`/`KIMI_MODEL_NAME`（最高优先级）；或 `--config-file` / `--config '<json>'` |
| 全局配置 | `~/.kimi-code/config.toml`：`[providers.x]`（type/base_url/api_key/custom_headers）+ `[models.x]` + `default_model`；也可脚本化 `kimi provider add/remove`；`KIMI_CODE_HOME` 整体搬迁 | `~/.kimi/config.toml`，同构字段；`KIMI_SHARE_DIR` 整体搬迁 |
| 会话存储 | `~/.kimi-code/session_index.jsonl`（枚举入口：sessionId/sessionDir/**workDir**）+ `sessions/<wd_*>/<id>/agents/main/wire.jsonl` | `~/.kimi/sessions/<md5(workDir)>/<uuid>/context.jsonl`（无时间戳；时间戳在 `wire.jsonl`，标题在 `state.json`）；项目映射读 `~/.kimi/kimi.json` 的 `work_dirs[]` |
| 会话格式 | wire.jsonl：版本化 record（`metadata` / `turn.prompt`（用户输入）/ `context.append_message`（assistant/tool）/ `usage.record`（token）），协议 v1.0→v1.4 有迁移 | context.jsonl：`{role, content, tool_calls, tool_call_id}`；`_` 开头的 role 是内部记录（跳过）；content 可能是字符串或 parts 数组；tool_calls.arguments 是 JSON 字符串 |
| 坑 | 密钥在 config.toml 里是明文；旧版 1.47+ 会催用户升级新版；模型选择器按 `[models.*]` 别名列出（注入模式的 KIMI_MODEL_* 合成通道是单模型设计，多模型需走全局写入） | 正在被新版替代，安装新版会迁移其数据（不改旧数据） |

**兼容端点（2026-08-05 核实）**：`KIMI_MODEL_PROVIDER_TYPE=openai` 可接任意 OpenAI 兼容端点（如智谱 `https://open.bigmodel.cn/api/paas/v4`、DeepSeek `https://api.deepseek.com/v1`）；`=anthropic` 理论上可接 §1 附注的 Anthropic 兼容端点，未实测。

## 7. CodeBuddy Code（v2.132.0 实机验证）

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `codebuddy`（别名 `cbc`，npm 包 `@tencent-ai/codebuddy-code`）；`codebuddy --version` |
| 注入 env | **`CODEBUDDY_API_KEY` / `CODEBUDDY_BASE_URL` / `CODEBUDDY_MODEL`**（`ANTHROPIC_*` 无效）；协议 Anthropic 兼容（官方 docs 有 DeepSeek 对接示例） |
| 官方端点 | 国际站 `https://www.codebuddy.ai`（product.json `endpoint`，默认）/ 中国站 `https://copilot.tencent.com`（`officialEndpoints` 同源核实） |
| 全局配置 | `~/.codebuddy/settings.json`（env 块，同 Claude 形态） |
| 会话存储 | `~/.codebuddy/projects/<slug>/<uuid>.jsonl`，slug = 项目路径 `/`→`-`（Claude 同款规则，有损不解码；项目归属读行内 `cwd`，兜底目录名） |
| 会话格式 | `{"type":"message","role":"user","content":[{"type":"input_text","text":...}],"sessionId":...,"cwd":...,"timestamp":<毫秒 epoch>}`；assistant 块为 `output_text`；`file-history-snapshot` 等事件行跳过。**与 Claude schema 不同构，独立解析器**；usage/工具调用字段未实证（防御式跳过） |
| 关键启动参数 | 交互初始 prompt = 位置参数（`codebuddy "<prompt>"`）；`-p` 无头；`-r|--resume [sessionId]` 按 ID 恢复（`-c` 续最近）；`--session-id <uuid>` 固定会话文件名 |
| 官方账号 | TUI 内 `/login`（浏览器 OAuth，分国际/中国站）；凭证 `~/.codebuddy/.credentials.json`。**env 优先压账号**（实测 401 提示），官方账号拉起必须 `env_remove CODEBUDDY_API_KEY`（连同 `CODEBUDDY_AUTH_TOKEN`） |
| 技能 | `~/.codebuddy/skills/<name>/SKILL.md`（frontmatter 与库格式兼容） |
| 安装 / 更新 | npm `@tencent-ai/codebuddy-code`；自更新 `codebuddy update`（非交互，可走行输入渠道） |

## 8. Cursor CLI（2026.08.04-aaa8809 实机验证）

| 项 | 值 |
|---|---|
| 二进制 / 检测 | **`cursor-agent`**（不要用 `agent`——太通用；cursor-agent 是 legacy symlink 但稳定）；安装到 `~/.local/share/cursor-agent/versions/<ver>/`，symlink 在 `~/.local/bin`（resolve_binary 通用候选已覆盖）；`cursor-agent --version` |
| 注入 | API key = `--api-key <key>` flag 或 env **`CURSOR_API_KEY`**；端点 = `-e/--endpoint` 或 env **`CURSOR_API_ENDPOINT`**（**Cursor 专有协议，非 OpenAI/Anthropic 兼容——第三方供应商预设无意义**）；模型 = **`--model <name>` flag（非 env）**，支持 `claude-opus-4-8[context=1m,effort=high]` bracket 参数化 |
| 关键启动参数 | 交互初始 prompt = argv 末尾位置参数；非交互 `-p/--print` + `--output-format text|json|stream-json`；`--resume <uuid>` 按 ID 恢复（必须带 id，无参会卡 Ink TUI）；`--continue` 续最近 |
| 会话存储 | `~/.cursor/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`（目录名=文件名=session id；cwd 编码=分隔符→`-`，有损不解码）。**`agent ls` 是 Ink TUI 非 TTY 会崩，会话发现只能文件扫描** |
| 会话格式 | JSONL 带 type 字段，源码枚举：`user_message`/`tool_call`/`tool_result`/`turn_ended`/`turn_id`/`message_id` 等（**完整字段样本未验证——防御式解析，未知 type 跳过**） |
| 官方账号 | `cursor-agent login`（浏览器 OAuth）；凭证**默认 macOS 钥匙串**，设 `AGENT_CLI_CREDENTIAL_STORE=file` 时落 `~/.cursor/auth.json`（检测需双通道：auth.json + 钥匙串只读查询）；官方账号拉起 `env_remove CURSOR_API_KEY` |
| 技能 | `~/.cursor/skills-cursor/`（**未验证 CLI 是否真读，分发走 copy 模式**）；`~/.cursor` 与 IDE 共享——**会话删除白名单必须限定 `projects/*/agent-transcripts/**/*.jsonl`** |
| 安装 / 更新 | 官方安装脚本（`curl -fsSL https://cursor.com/install | bash`）；自更新 `cursor-agent update`（非交互）；无 brew/npm 官方包。**Windows 安装/数据路径未验证** |

## 跨 agent 共性结论

1. **会话格式全是内部格式**——解析层统一防御式策略，并准备「原始 JSON 视图」作为降级。
2. **项目归属推导各家各样**——在各自 adapter 的 `list_sessions` 里解决，对上层统一暴露 `project_path`。
3. **注入模式没有统一三件套**——Claude/Gemini/Qwen(openai 协议）/旧 Kimi/CodeBuddy 有标准 env；Codex 靠 `-c` 参数；OpenCode 靠 `OPENCODE_CONFIG_CONTENT`；新 Kimi 靠 `KIMI_MODEL_*` 合成通道；Cursor 是 env（key/端点）+ flag（模型）混合。`launch_plan { env, args }` 抽象覆盖了全部八种情况。
4. **前六家都有整体搬迁环境变量**（`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GEMINI_CLI_HOME`/`QWEN_HOME`/`KIMI_CODE_HOME`/`KIMI_SHARE_DIR`；CodeBuddy 未核实）——可做「完全隔离 profile」的进阶功能，但会连会话历史一起隔离，MVP 不用。
5. **都支持非交互模式**——为「绕过终端直接驱动 agent」留了路。
