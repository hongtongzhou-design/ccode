# 九个 CLI Agent 适配参考（调研蒸馏版）

> 供实现 AgentAdapter 时查阅。来源：2026-07-30 对官方文档与源码的调研（多数核到源码行号）。
> 2026-08-05 补充核实各供应商 Anthropic/OpenAI 兼容端点（见 §1 附注），来源均为官方文档页面。
> 2026-08-06 新增 §7 CodeBuddy Code（v2.132.0 实机验证，含真实会话样本与 product.json 核实）。
> 2026-08 新增 §9 Grok Build（xai-org/grok-build 源码调研；标注「待实机验证」处未经实机核对）。
> 2026-08-20 新增 §12 精确注意力 hooks 桥接调研（九家，实现 = hooks.rs 的 BRIDGE_SPECS；cursor/opencode 未接入结论同记）。
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
| 坑 | 非官方 base URL 会禁用 Remote Control 与部分 MCP 行为；CLI 自己会给配置文件做时间戳备份（我们不是唯一写者）；`CLAUDE_CONFIG_DIR` 可整体搬迁配置目录（完全隔离方案，但会话也随之隔离）；`/model` 选择器默认只显示内置别名，Ccode 用 `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`(+`_NAME`) 注册前 4 个模型、第 5 个走 `ANTHROPIC_CUSTOM_MODEL_OPTION`，更多模型需 `/model <id>` 手输；`_NAME` 是选择器显示名（Ccode 填「配置名 · 模型」）。运行中切换（2026-08-17 v2.1.212 strings 实证，终端状态栏用）：`/model <name>` 带参直切（session 级）、`/effort <low\|medium\|high\|xhigh\|max>` 带参直切 |

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
| 会话存储 | `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`；旧文件会被后台 **zstd 压缩为 `.jsonl.zst`**（magic `28 b5 2f fd`），两者都要能读；另有 `history.jsonl`（仅用户 prompt）和 SQLite 镜像库（版本化文件名，勿依赖）。Ccode 观察到会话关联成功后，会在自己的 `app.db` 记录 profile 归属，历史/外部会话可能为空。 |
| 会话格式 | JSONL `RolloutLine {timestamp, type, payload}`；首行 `session_meta`（含 **cwd** = 项目归属依据）；`response_item`（消息）、`event_msg`（含 token_count）、`turn_context`（每轮 model/cwd）。不按项目分目录，**项目归属靠 session_meta.cwd**。**易漂移** |
| 关键启动参数 | `-m`、`--profile`、`-c key=value`（最高优先级）、`codex exec`（非交互，`--json` 输出事件流）、`codex resume` |
| 坑 | **只支持 Responses API**（`wire_api="chat"` 已移除并报错）——中转必须实现 `/v1/responses`；`codex exec` 默认要求 git 仓库（`--skip-git-repo-check`）；凭证可能存 OS keyring 而非 auth.json；auth.json 顶层只有 `OPENAI_API_KEY` = API Key 模式（官方 `--api-key` 与第三方中转同一形状，**不算官方账号登录**，检测见 v3.55）；TUI `/model` 选择器的模型目录来自 `model_catalog_json` 指定的 JSON 文件（**仅启动时读取**，Ccode 已为每条绑定生成 catalog：display_name = 「配置名 · 模型」，context_window/max_context_window 取自 model_registry；reasoning levels 全量模板 [low/medium/high]，与 cc-switch 同口径——模型不支持时端点忽略 effort） |

## 3. Gemini CLI

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `gemini`（npm `@google/gemini-cli`，Node ≥ 20）；`gemini --version` |
| 注入 env | `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`（设了即进入 GATEWAY 模式，官方支持中转；要求 HTTPS 或 localhost）、`GEMINI_MODEL`。env 优先级仅次于 CLI 参数 |
| 全局配置 | `~/.gemini/settings.json`（`model.name`、`security.auth.selectedType`）；`GEMINI_CLI_HOME` 可整体搬迁 |
| 会话存储 | `~/.gemini/tmp/<slug>/chats/session-<时间>-<id8>.jsonl`；**slug 映射读 `~/.gemini/projects.json` 和目录内 `.project_root` 标记，不要自己推导**（旧版是 sha256 目录，有迁移） |
| 会话格式 | JSONL。首行 metadata；消息 `{id, timestamp, content, type: user/info/error/warning/gemini}`，gemini 类型带 `toolCalls` 和 `tokens{input,output,cached,thoughts,tool,total}`；**控制记录 `$rewindTo`（截断后续消息）和 `$set`（patch 元数据）必须处理**，不能简单拼接。旧版单 JSON 文件仍需兼容。若多个落盘文件声明同一 `sessionId`，按最新文件作为唯一会话代表。**易漂移** |
| 关键启动参数 | `-m`、`-p`（进入 headless）、`--output-format stream-json`、`-r/--resume`、`--list-sessions` |
| 坑 | **默认 30 天自动删除会话**（`general.sessionRetention`）；新目录首次运行有信任确认（`--skip-trust` 绕过）；管道 stdio 会静默进入 headless；会话文件边写边追加，末行可能残缺；**多模型切换无配置注入机制**（已核实），只能在 TUI 里 `/model set <id>` 手动切换。**0.46 实机核实补充**：`/model` 的「Select Model」选择器列表**硬编码**（main 视图 Auto/Manual 两项 + Manual 子视图官方模型），`GEMINI_MODEL` env 的值不进列表（优先级 `--model` > `GEMINI_MODEL` > settings `model.name`）；`/model set <id>` 零校验任意 id 当场生效。自定义模型进选择器的官方机制：`experimental.dynamicModelConfiguration: true` + `modelConfigs.modelDefinitions`（与内置表 merge，`tier:"custom"` + `isVisible:true` 进 Manual 子视图；实验开关，requiresRestart）。**闪烁**：inline 模式 UI 高度超终端行数即整区重绘（内置 useFlickerDetector 检测；上游已知问题簇，官方 Epic google-gemini/gemini-cli#10673，与终端种类无关，维护者背书 alternate buffer 可根治），缓解 = settings `ui.useAlternateBuffer: true`（默认 false；开了之后 `ui.incrementalRendering`（默认 true）才生效），可叠加 `ui.showSpinner: false` / `ui.loadingPhrases: "off"` |

## 4. Qwen Code

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `qwen`（npm `@qwen-code/qwen-code`，Node ≥ 22；或 brew）；`qwen --version` |
| 注入 env（按协议） | openai 协议：`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`；anthropic 协议：`ANTHROPIC_*` 三件套；配合 `--auth-type openai|anthropic`。credential 优先级：CLI flags > shell env > .env > settings env |
| 全局配置 | `~/.qwen/settings.json`：`modelProviders.<协议>.models[{id, baseUrl, envKey, generationConfig}]` + `security.auth.selectedType` + `model.name`；`QWEN_HOME` 整体搬迁 |
| 会话存储 | `~/.qwen/projects/<sanitize(cwd)>/chats/<uuid>.jsonl`（sanitize 规则同 Claude）；归档在 `chats/archive/`；目录名可能碰撞，**项目归属以首条记录的 `cwd` 为准** |
| 会话格式 | JSONL `ChatRecord {uuid, parentUuid, sessionId, timestamp, type: user/assistant/tool_result/system, subtype, cwd, version, message（genai Content 格式）, usageMetadata, model}`；`custom_title` 系统记录给标题。旧版（约 <0.10，具体版本未核实）是单 JSON 文件。**易漂移** |
| 关键启动参数 | `-m`、`--auth-type`、`--openai-api-key/--openai-base-url`（仅有的凭证 flags）、`--session-id`、`--continue/--resume` |
| 坑 | Qwen OAuth 免费额度已于 2026-04 停；绑定需记录协议类型（多协议 agent）；录制可被关闭（`general.chatRecording:false`），此时无会话文件；TUI `/model` 对话框列出的就是 `modelProviders.<协议>.models` 条目（仅全局写入模式可注入多模型，注入模式单模型是 CLI 限制） |

**兼容端点（2026-08-05 核实）**：openai 协议可接智谱 GLM（`https://open.bigmodel.cn/api/paas/v4`，官方 quick-start 仍在用）；anthropic 协议（`--auth-type anthropic` + `ANTHROPIC_*` 三件套）理论上可接 §1 附注的 GLM/DeepSeek Anthropic 兼容端点，但未实测，接入前需验证。

## 5. OpenCode

| 项 | 值 |
|---|---|
| 二进制 / 检测 | `opencode`（npm `opencode-ai`；仓库已更名 anomalyco/opencode）；`opencode --version` |
| 注入方式 | **无通用 key/baseURL env**。用 `OPENCODE_CONFIG_CONTENT`（内联配置 JSON，优先级几乎最高）+ `OPENCODE_AUTH_CONTENT`（内联凭证 JSON，未文档化但源码确认）做启动注入。provider 配置：`provider.<id>.options.{apiKey, baseURL}` + `npm: "@ai-sdk/openai-compatible"` 接任意中转；provider 级 `name` 与 models 条目 `name`/`reasoning`/`limit.context` 是 models.dev 覆盖语义（官方文档 2026-08-17 核实），Ccode 填显示名（配置名 · 模型）+ 思考模型 `reasoning: true` + 上下文 limit（model_registry） |
| 全局配置 | `~/.config/opencode/opencode.json(c)`（支持 `{env:VAR}` 插值）。**优先级坑：config > auth.json > env**，注入必须走 config 层才确定 |
| 会话存储 | **v1.2.0+：单一 SQLite**。Unix：`~/.local/share/opencode/opencode.db`；Windows：优先 `%LOCALAPPDATA%\opencode\opencode.db`，回落 `%APPDATA%\opencode` 与 unix 形态路径（`OPENCODE_DB` 环境变量仍优先）。WAL 模式；表：`session/message/part/project`，`message.data`/`part.data` 为 JSON 列。更早版本是 `storage/` 目录的扁平 JSON 文件（需双解析） |
| 会话格式 | `session` 表直接有 `title/cost/tokens_*/time_*`；项目 = git 首个 commit hash，`project.worktree` 列给路径；message.data：`{role, time, model, tokens, cost, ...}`；part.data：`type: text/reasoning/tool/...` 判别联合。**drizzle 迁移频繁，易漂移** |
| 官方替代路径（推荐优先用） | `opencode export <id>`（完整 JSON）、`opencode session list --format json`、`opencode db "<sql>" --format json`、`opencode serve`（HTTP+OpenAPI）——比解析内部 DB 稳定 |
| 关键启动参数 | `-m/--model`、`--prompt`（交互会话首条指令）、`-s/--session`（按 ID 继续） |
| 坑 | 自更新会在启动时替换二进制（`OPENCODE_DISABLE_AUTOUPDATE=1`）；provider SDK 运行时下载（首跑要联网）；Windows 数据路径已按 `%LOCALAPPDATA%\opencode` 优先探测（2026-08-31） |

## 6. Kimi Code（注意：两个产品都叫 `kimi`）

| 项 | 新版 kimi-code（TS，0.x，现役） | 旧版 kimi-cli（Python，1.x，收缩中） |
|---|---|---|
| 检测 | `~/.kimi-code/` 存在；`kimi doctor` 可用 | `~/.kimi/` 存在；`kimi --version` 为 1.x |
| 注入 env | **故意忽略 shell env 的 API key**。唯一注入通道：合成模型 `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` + `KIMI_MODEL_BASE_URL` + `KIMI_MODEL_PROVIDER_TYPE`（kimi/anthropic/openai）。合成通道另有元数据字段（2026-08-17 二进制 strings 实证）：`KIMI_MODEL_CAPABILITIES`（逗号分隔小写，如 `tool_use,thinking`；缺省时 kimi 协议默认 `["image_in","thinking"]`、openai/anthropic 兼容通道默认 `["tool_use"]`——不含 thinking 时 TUI 显示「不支持思考」）、`KIMI_MODEL_DISPLAY_NAME`（选择器 label 优先它）、`KIMI_MODEL_MAX_CONTEXT_SIZE`、`KIMI_MODEL_THINKING_EFFORT`/`ADAPTIVE_THINKING`/`REASONING_KEY` 等；Ccode 注入 display_name=配置名·模型、max_context_size 与 capabilities 判定统一走 model_registry（内置表 + model-capabilities.json 覆盖 + 关键词推断兜底，思考模型才声明） | `KIMI_API_KEY`/`KIMI_BASE_URL`/`KIMI_MODEL_NAME`（最高优先级）；或 `--config-file` / `--config '<json>'` |
| 全局配置 | `~/.kimi-code/config.toml`：`[providers.x]`（type/base_url/api_key/custom_headers）+ `[models.x]` + `default_model`；也可脚本化 `kimi provider add/remove`；`KIMI_CODE_HOME` 整体搬迁 | `~/.kimi/config.toml`，同构字段；`KIMI_SHARE_DIR` 整体搬迁 |
| 会话存储 | `~/.kimi-code/session_index.jsonl`（枚举入口：sessionId/sessionDir/**workDir**）+ `sessions/<wd_*>/<id>/agents/main/wire.jsonl` | `~/.kimi/sessions/<md5(workDir)>/<uuid>/context.jsonl`（无时间戳；时间戳在 `wire.jsonl`，标题在 `state.json`）；项目映射读 `~/.kimi/kimi.json` 的 `work_dirs[]` |
| 会话格式 | wire.jsonl：版本化 record（`metadata` / `turn.prompt`（用户输入）/ `context.append_message`（assistant/tool）/ `usage.record`（token）），协议 v1.0→v1.4 有迁移 | context.jsonl：`{role, content, tool_calls, tool_call_id}`；`_` 开头的 role 是内部记录（跳过）；content 可能是字符串或 parts 数组；tool_calls.arguments 是 JSON 字符串 |
| 坑 | 密钥在 config.toml 里是明文；旧版 1.47+ 会催用户升级新版；模型选择器按 `[models.*]` 别名列出（注入模式的 KIMI_MODEL_* 合成通道是单模型设计，多模型需走全局写入）。运行中切换（0.36.1 pty 探针实证）：`/model <别名>` 与 `/effort <档>` 带参直切（/model 吃的是别名不是模型 id；档位随模型，K3 等布尔模型只有 on/off）；**kitty 键盘协议坑**：TUI 启动 push flags（`\x1b[>7u`）后只认 CSI-u 的 Enter（`\x1b[13u`），普通 `\r` 不提交——xterm.js 不支持该协议，Ccode 在 xterm 键盘层与写入链路两处改写（注册表 `submit_csi_u`） | 正在被新版替代，安装新版会迁移其数据（不改旧数据） |

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

## 9. Grok Build（xai-org/grok-build 源码调研，2026-08；标注「待实机验证」处未经实机核对）

| 项 | 值 |
|---|---|
| 二进制 / 检测 | **`grok`**（xAI 官方终端编码 agent，二进制也叫 grok）；`grok --version` 单行输出 `grok 0.2.180 (abc1234)`（非 stable 频道追加 ` [alpha]`）；`grok version --json` 给 `{"currentVersion":"X.Y.Z (commit)","channel":"stable"}`。官方安装落 `~/.grok/bin/grok`（另尝试 `~/.local/bin`、`/usr/local/bin` symlink；resolve_binary 已把 `~/.grok/bin` 收进三平台候选目录） |
| 注入 env | **`XAI_API_KEY`**（别名 `GROK_CODE_XAI_API_KEY`）、模型 **`GROK_DEFAULT_MODEL`**、base url 覆盖 **`GROK_MODELS_BASE_URL`**（1.0.5 实机核实，自带 user-guide 11-custom-models.md：模型目录从 `{base_url}/models` 拉取、推理同走该 base，`XAI_API_KEY` 作 Bearer；另可用 `GROK_MODELS_LIST_URL` 单独覆盖列表地址）。**`GROK_DEFAULT_MODEL` 只是「偏好」**：与可用模型目录比对，不在目录里走 `preferred model not in available models, falling back` 静默回退默认——第三方模型必须配 `GROK_MODELS_BASE_URL` 让目录来自网关自身。勿用 `GROK_CLI_CHAT_PROXY_BASE_URL`（xAI 内部 CLI chat API 代理覆盖口，非推理端点，第三方端点注进去模型流量不走它）。**模型列表收敛（1.0.5 实机核实）**：`GROK_CONFIG` env 是 JSON overlay 深合并进 config.toml（白名单含 `models` 表），注入 `{"models":{"allowed_models":[...]}}` 可把选择器/`-m` 可选范围收敛到绑定模型列表（不注则网关全量目录进选择器；空列表勿注——fail-closed 全不匹配），选中模型兜底并入。凭证优先级：config.toml `api_key` > `env_key` > 登录 session token > `XAI_API_KEY` |
| 官方端点 | xAI 官方 API 是 OpenAI chat_completions 兼容：`https://api.x.ai/v1`；config.toml `[model.<name>]` 的 `api_backend` 支持 chat_completions/responses/messages 三种 |
| 全局配置 | `$GROK_HOME`（缺省 `~/.grok`，三平台同）下 `config.toml`（主配置 TOML：`[model.<name>]` 段 + `[mcp_servers.<name>]` 段）；项目级 `<cwd>/.grok/config.toml` 只贡献 `[mcp_servers]` 等少数段。**「设为全局默认」首版不支持**（TOML `[model.<name>]` 段结构 + 设为默认的字段未核实，风险高于收益；仅启动注入） |
| 官方账号 | `grok login`（浏览器 OAuth，auth.x.ai）/ `grok login --device-auth` / `grok logout`；凭证落 `~/.grok/auth.json`（0600，顶层 map：scope → GrokAuth{key, auth_mode, refresh_token, expires_at}，grok 自己原子重写——我们只读）。官方账号拉起必须 `env_remove XAI_API_KEY`/`GROK_CODE_XAI_API_KEY` |
| 会话存储 | `~/.grok/sessions/<encoded-cwd>/<session-id-uuidv7>/` 目录式会话（目录 0700）：`summary.json`（info{id,cwd}、generated_title、created_at/updated_at、num_messages、current_model_id）+ **`updates.jsonl`（权威对话日志，append-only）** + `chat_history.jsonl` 等；`<encoded-cwd>` 是 cwd 的 URL 编码（超长则 slug+hash 且目录内有 `.cwd` 元数据文件）。**`~/.grok/sessions/session_search.sqlite` 只是 FTS 索引不是会话本体**，扫描须排除。项目归属以 `summary.json` 的 `info.cwd` 为准（比解码目录名可靠） |
| 会话格式 | `updates.jsonl` 每行 `{"timestamp": <unix秒>, "method": "session/update", "params": <ACP SessionNotification>}`；消费方式 = `params.update.sessionUpdate`：`user_message_chunk`/`agent_message_chunk`（content 为 ACP ContentBlock，text 在 `content.text`）/`tool_call`/`tool_call_update`/`plan` 等，另有 `_x.ai/` 前缀扩展通知；未识别类型跳过（防御式）。token usage 在 turn 结束的 ACP 通知 `_meta.usage`（PromptUsage）：`input_tokens`/`output_tokens`/`total_tokens`/`cached_read_tokens` + `modelUsage{<model>:{...}}`（可能在 `params._meta` 或 `params.update._meta`，两层都探） |
| 关键启动参数 | `-p/--print`（headless，**不读 stdin**，prompt 必须走参数）+ `--output-format plain\|json\|streaming-json`；`-m/--model`、`--cwd`、`-r/--resume [ID_OR_TITLE]`、`-c/--continue`、`-s/--session-id <UUID>`（仅新建会话，固定会话关联）、`--max-turns`、`--yolo`、`--tools/--disallowed-tools`、`--permission-mode <default\|acceptEdits\|auto\|dontAsk\|bypassPermissions\|plan>`、`--sandbox <off\|workspace\|read-only\|strict>` |
| 只读模式 | headless 已验证语义最硬的组合：**`--permission-mode dontAsk`（CI 严格白名单，非白名单工具请求直接 Cancelled）+ `--sandbox read-only`（OS 级只读，只能写 ~/.grok 和临时目录）**。`--permission-mode plan` 的值被接受但主会话门控链路**未确认**，不要用 |
| 技能 | `~/.grok/skills/<name>/SKILL.md`（目录+SKILL.md，与 Ccode SSOT 同构；另兼容读 `~/.claude/skills`、`~/.cursor/skills`）。首版未经实机验证，分发**强制 copy**（同 cursor 口径） |
| MCP | `~/.grok/config.toml` 的 **`[mcp_servers.<name>]` 段（TOML，不是 JSON）**——stdio = `command`+`args[]`+`env{}`+`cwd`；远程 = `url`+`type`("http"/"sse"，省略时 url 以 /sse 结尾即 sse)+`headers{}`+`bearer_token_env_var`（env 读 token 注入 Authorization: Bearer，密钥不落盘）；通用 `enabled`/`startup_timeout_sec`/`tool_timeout_sec`；headers/env 值支持 `${VAR}` 引用。grok 另兼容读 `~/.claude.json`/`.mcp.json`/`~/.cursor/mcp.json`（可在 config 关）。**Ccode 首版：MCP 页只读清单（解析 TOML 段）+ 分发/写入不支持**（grok 自带 `grok mcp add` CLI；不为首版硬造 TOML 原子写管线） |
| 安装 / 更新 | 官方脚本 `curl -fsSL https://x.ai/cli/install.sh \| bash`（mac/Linux/Git Bash）→ `~/.grok/bin/grok`；Windows `irm https://x.ai/cli/install.ps1 \| iex` → `%USERPROFILE%\.grok\bin\grok.exe`；**npm 官方包 `@xai-official/grok`**（postinstall 解压到 `~/.grok/bin/`）。自更新 `grok update`（非交互；`grok update --check --json` 机器可读）。Windows 支持官方称 best-effort |
| 坑 | `auth.json` grok 自己原子重写（0600），我们只读；`session_search.sqlite` 不是会话本体；headless 不读 stdin；`--permission-mode plan` 门控链路未确认别用；base url 注入必须走 `GROK_MODELS_BASE_URL`（见「注入 env」行），`GROK_CLI_CHAT_PROXY_BASE_URL` 是 xAI 内部代理口勿用；`GROK_DEFAULT_MODEL` 不在目录即静默回退 |

## 跨 agent 共性结论

1. **会话格式全是内部格式**——解析层统一防御式策略，并准备「原始 JSON 视图」作为降级。
2. **项目归属推导各家各样**——在各自 adapter 的 `list_sessions` 里解决，对上层统一暴露 `project_path`。
3. **注入模式没有统一三件套**——Claude/Gemini/Qwen(openai 协议）/旧 Kimi/CodeBuddy 有标准 env；Codex 靠 `-c` 参数；OpenCode 靠 `OPENCODE_CONFIG_CONTENT`；新 Kimi 靠 `KIMI_MODEL_*` 合成通道；Cursor 是 env（key/端点）+ flag（模型）混合；Grok 是 `XAI_API_KEY`+`GROK_*` env 三件套（base url 注入待实机验证）。`launch_plan { env, args }` 抽象覆盖了全部九种情况。
4. **前六家都有整体搬迁环境变量**（`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GEMINI_CLI_HOME`/`QWEN_HOME`/`KIMI_CODE_HOME`/`KIMI_SHARE_DIR`；CodeBuddy 未核实；Grok 有 `GROK_HOME`）——可做「完全隔离 profile」的进阶功能，但会连会话历史一起隔离，MVP 不用。
5. **都支持非交互模式**——为「绕过终端直接驱动 agent」留了路。
6. **只读/计划模式参数（2026-08-12 本机 `--help` 实测，「聊想法」想法期只读保护用）**：claude `--permission-mode plan`、
   codex `-s read-only`（替换 Ccode 默认注入的 `-s workspace-write`，重复 -s 生效顺序未文档化故先剔除）、
   gemini `--approval-mode plan`、kimi（新版）`--plan`、cursor `--plan`（= `--mode plan`）、codebuddy `--permission-mode plan`；
   **qwen 0.21.1 无 approval/plan 类参数**（`--safe-mode` 只是禁用自定义配置，非只读）；opencode 1.18.10 有 `--prompt` 但没有已核实的只读/计划参数，因此只读保护仍只有 prompt 软约束。
   grok（源码调研，待实机验证）：`--permission-mode dontAsk --sandbox read-only`（CI 严格白名单 + OS 级只读；
   `--permission-mode plan` 门控链路未确认，不用）。
   注册表落点：`agent_specs.rs` 的 `AgentSpec.readonly_args`，应用逻辑 `agents::readonly_launch_args`。
7. **模型能力元数据统一走 `model_registry.rs`**（2026-08-17 起；2026-08-26 扩为分层数据源）：**逐字段**查询链 =
   用户覆盖文件（model-capabilities.json）> **网关实测缓存**（model-capabilities-relay.json，
   「获取模型」时 fetch_models 顺带解析 OpenRouter 风格 /models 元数据落盘，最准）> **公共能力库**
   （model-capabilities-db.json，配置页 ⋯ 菜单主动下载：models.dev 优先、OpenRouter 回落——
   models.dev 本机直连超时实证）> 内置前缀表 > 关键词推断兜底。能力字段四项：thinking/context/output/vision，
   **全 Option——「这层不知道」继续向下找，显式 false 只在数据源如实给出时生效**（网关只报上下文不挡公共库的推理声明）。
   kimi 的 capabilities/max_context_size、codex catalog、opencode 的 reasoning/limit/modalities 全从这条链出；
   内置表宁缺毋滥（收错比漏报有害）。
   有能力声明通道的只有 kimi/codex/opencode/claude；gemini/qwen/codebuddy/cursor/grok 无此机制（2026-08-25 逐家核实）。
   各通道声明面（2026-08-25 补齐）：codex catalog = context_window + effective_context_window_percent(95) +
   input_modalities（`model_supports_vision`）+ supports_search_tool(false) + reasoning levels；kimi = max_context_size +
   capabilities（tool_use + thinking/image_in 按需，兼容协议通道才注入/写盘；官方协议通道 CLI 缺省已合理）；
   opencode = limit.context/output + reasoning + modalities（视觉模型 input 加 image；tool_call 缺省即开，实测请求带全量
   工具）；claude = 显示名槽 + CLAUDE_CODE_MAX_CONTEXT_TOKENS（注册表 >200K 才写，不需要时清旧值）。
   注意边界：streaming/function calling/结构化输出是协议层能力（声明补不了）；web search/file search/code interpreter
   等 hosted tools 是第一方服务端能力，第三方中继没有对应物，声明了等于摆死工具——如实不写。

8. **请求策略不是通用请求代理**（2026-08-27；2026-08-30 拆层后载体改到网关模型行）：
   可迁移声明仍是 `temperature`、`top_p`、`max_output_tokens`、`reasoning_effort`，以及 Header 名到环境变量名的引用。
   Header 存在**网关**；思考档/温度/输出上限存在**网关的每个模型**。启动只取当时选中模型上、且求交允许的字段。
   扁平 `Profile.requestPolicy` 是物化视图，不是落盘形状。Ccode 当前在启动计划中只注入各 Agent 已核实的环境变量/命令行参数，不重写 HTTP body；能力未知或不支持时保留配置、
   在校验结果提示并跳过强制注入。Header 值必须由用户在运行环境提供，网关不落密文。真实请求级注入若以后实现，
   必须按「Agent + protocol」建立逐字段适配和测试矩阵，不能把 `max_output_tokens` 直接等同为所有 CLI 的 `max_tokens`。

   逐字段通道实证（2026-08-28，Windows 本机安装二进制 strings/配置 schema；实现见 `agent_specs.rs`
   `request_policy_support`，"supported" = 存在实证的用户可及通道能让该值进入真实请求，协议支持但 CLI
   无入口记 "unsupported"）：
   - **claude-code**（v2.x exe，全五项 supported）：temperature/top_p 经 `CLAUDE_CODE_EXTRA_BODY`
     （env 解析为 JSON 对象后展开进 API 请求体，反编译实证）；`CLAUDE_CODE_MAX_OUTPUT_TOKENS`；
     `CLAUDE_CODE_EFFORT_LEVEL`（同 `/effort`，档位闭集 low/medium/high/xhigh/max，保存期校验）；
     `ANTHROPIC_CUSTOM_HEADERS`（`Name: value` 逐行）。
   - **codebuddy**（claude-code fork，env 前缀独立，无 EXTRA_BODY/EFFORT 入口）：
     `CODEBUDDY_CODE_MAX_OUTPUT_TOKENS`、`CODEBUDDY_CUSTOM_HEADERS` 实证 → supported；
     temperature/top_p → unsupported；effort → unknown。
   - **codex**：temperature/top_p 仅存在于 wire schema（ModelPreferences），config 无键；
     二进制里的 `max_output_tokens` 全部是 exec pragma（工具输出截断）非模型请求 → unsupported；
     `model_reasoning_effort`（config 键）与 provider `http_headers`/`env_http_headers` 实证 → supported。
   - **gemini / qwen**：settings schema chunk 内 temperature/topP/maxOutputTokens 零命中
     （generationConfig 仅出现在 API 请求构造路径）→ unsupported；effort/headers 未核实 → unknown。
   - **opencode**：config schema 实证 agent/model options 含 temperature/topP/maxOutputTokens/
     reasoningEffort（枚举），provider options 支持 headers → 全 supported。
   - **kimi**（2026-08-28 二进制反编译实证）：`KIMI_MODEL_THINKING_EFFORT` 原样透传 + 小写归一，
     env 路径无闭集校验（合法值随模型 catalog 漂移：low/medium/high/xhigh/max/on/off），但**仅
     kimi 协议通道读取**，anthropic/openai 兼容通道静默忽略 → reasoning_effort supported；余 unknown。
     配套：`KIMI_MODEL_ADAPTIVE_THINKING` 是布尔开关（true/false/1/0/yes/no/on/off），
     `KIMI_MODEL_REASONING_KEY` 是 dialect 键名（known：reasoning_content/reasoning_details/reasoning）。
   - **grok**（v1.0.5 二进制 + 随附 README 双实证，全五项 supported）：config.toml `[model.*]` 表
     temperature/top_p/max_completion_tokens（注意键名非 max_output_tokens）/reasoning_effort
     （档位 none/minimal/low/medium/high/xhigh/max，另有 CLI flag `--reasoning-effort`）；
     headers 走 `[model.*].extra_headers`（静态值）/ `env_http_headers`（环境变量引用）。通道走
     config/flag 不走 env（GROK_* 无此类变量）——Ccode 侧 GROK_CONFIG overlay 白名单是否含
     `model` 表未经实机验证，接线留待实证。
   - **cursor**：本机未安装（2026-08-28），无法 strings 实证——保持全 unknown，装机后补。
   - cursor/grok 之外汇总：claude-code 全五项、codebuddy 两条、codex effort+headers、
     gemini/qwen 前三项 unsupported、opencode 全五项、kimi effort。

   接线状态（2026-08-28 第二批）：`launch_plan` 已接 claude-code（EXTRA_BODY 合并
   temperature/top_p + MAX_OUTPUT_TOKENS + EFFORT_LEVEL + CUSTOM_HEADERS）、codebuddy
   （CODEBUDDY_ 前缀两条）、codex（`-c model_reasoning_effort` + provider `env_http_headers`，
   无 base_url 时 headers 无处挂载不注）、opencode（OPENCODE_CONFIG_CONTENT 的 model options 四项
   + provider options.headers，headers 值拉起瞬间从进程环境解析——只在 env 内联合并不进
   opencode_provider_json，防全局写入路径把密文落盘）、kimi（KIMI_MODEL_THINKING_EFFORT，仅
   kimi 协议通道）。只注用户填了的字段；extra_env 仍最后注入可覆盖；官方账号拉起不注策略。
   grok overlay 接线留待白名单实机验证。

   网关体检探针（2026-08-28，`profile_validation.rs probe_gateway`）：绕过 CLI 直连端点发
   max_tokens=16 的最小请求，观测裸响应回答「网关把请求怎么了」——① 基础请求（鉴权+模型存在）
   ② 裸 stream:true 看回不回 SSE ③ 带请求策略参数再发流式（对比②定位「加参数就不流式」的降级）
   ④ 自定义 Header 接受度（值从进程环境解析，未设置的变量名在结果里点名）。鉴权镜像 CLI 真实
   形态（claude/codebuddy 走 Bearer 同 ANTHROPIC_AUTH_TOKEN 口径）；cursor 专有协议与 gemini
   协议暂不支持探针。出站文案统一过 redact_sensitive_text。

   配套防护（2026-08-28）：Anthropic 通道 Base URL 以 `/v1` 结尾会被 SDK 拼成 `/v1/v1/messages` 404
   （实测），且「获取模型」走 OpenAI 风格 `{base}/models` 照样成功、极具迷惑性——profile 校验给提醒
   （不阻断保存），配置弹层 Base URL 行内同步警示。

## 10. MCP 配置分发调研（2026-08-10，八家经官方文档/源码/本机实测核实；grok 为 2026-08 源码调研，首版只读不分发）

**目标**：Ccode 维护一份 MCP server 清单，一键分发进各 CLI 自己的配置文件。本节是实现规格的单一出处——写字段/路径前以此为准，不要凭印象。

### 10.1 分发通道总表

| CLI | 用户级配置落点 | 顶层键 | 格式 | 分发主通道 | 备选通道 |
|---|---|---|---|---|---|
| claude-code | `~/.claude.json`（**高频共享状态文件，高危**） | `mcpServers` | JSON | 项目级 `<repo>/.mcp.json`（独立单用途文件，最安全；交互会话有审批闸） | `claude mcp add --scope user`（CLI 自己做读改写） |
| codex | `~/.codex/config.toml`（与 model/notice/trust 同文件） | `[mcp_servers.<name>]`（下划线） | TOML | `codex mcp add/remove`（原子写；add 命中 OAuth server 会弹浏览器登录，注意） | 读-改-原子写 config.toml 只动 `mcp_servers` 段 |
| gemini | `~/.gemini/settings.json`（混合状态文件） | `mcpServers` | JSONC（容忍注释） | `gemini mcp add/remove -s user`（**scope 默认 project，必须显式 user**） | 读-改-合并写 settings.json 只动 `mcpServers` 键 |
| qwen | `~/.qwen/settings.json`（Ccode「设为全局」已写同文件） | `mcpServers` | JSONC | **直接写用户级 settings.json**（免审批 + 运行时热加载；JSON 损坏会被 CLI 清空重置，必须原子写+备份） | `qwen mcp add`（scope 默认 user，逐条无批量） |
| opencode | `~/.config/opencode/opencode.json(c)`（三个文件合并加载：config.json→opencode.json→opencode.jsonc，写已存在者） | `mcp` | JSONC | 直接写文件（纯用户设置文件，最友好；`mcp add` 只能写全局且无 remove） | `opencode mcp add`（非交互，保注释） |
| kimi | `~/.kimi-code/mcp.json`（`KIMI_CODE_HOME` 可搬迁；**MCP 专用纯声明文件，引擎只读不写**） | `mcpServers` | JSON | **直接写文件**（无可脚本化 CLI 命令，TUI `/mcp-config` 不算） | —（只能写文件；写后新会话生效） |
| codebuddy | `~/.codebuddy/.mcp.json`（MCP 专用文件，回退链 mcp.json→.codebuddy.json） | `mcpServers` + 并列 `disabledMcpServers` | JSONC | `codebuddy mcp add-json -s user`（默认 scope 是 local，寄生全局状态文件，禁用） | 直写 user 级 .mcp.json（保留 disabledMcpServers 键；有 watch 热生效） |
| cursor | `~/.cursor/mcp.json`（**CLI 与 IDE 共享**，写入同时改变 IDE 行为） | `mcpServers` | JSON | **直接写文件**（CLI 无 add/remove 子命令；`agent mcp list` 是交互 TUI 不能用于校验） | —（全局 server 免审批，项目级逐工作区批准） |
| grok | `$GROK_HOME/config.toml`（缺省 `~/.grok/config.toml`，与 model/hooks 同文件） | `[mcp_servers.<name>]`（**TOML 段**，非 JSON） | TOML | `grok mcp add`（CLI 自己做读改写；**Ccode 首版只读清单、不分发**——TOML 段结构独立，不硬造原子写管线） | 手工编辑 config.toml（grok 兼容读 `~/.claude.json`/`.mcp.json`/`~/.cursor/mcp.json`，可在 config 关） |

### 10.2 条目 schema 映射（Ccode 统一模型 → 各家字段）

Ccode 清单模型只收公共子集：stdio（command/args/env/cwd）+ remote（url/headers）+ enabled（v3.93 已落地：
清单级全局开关，停用 = 从各 agent 移除条目但保留 apps 映射，重开按原样重投——各家条目 schema 无原生禁用字段，
故不停用各家配置表达，codebuddy 的 `disabledMcpServers` / grok 的 `enabled` 暂不接入）。映射表：

| Ccode 字段 | claude | codex (TOML) | gemini | qwen | opencode | kimi | codebuddy | cursor | grok (TOML，首版只读) |
|---|---|---|---|---|---|---|---|---|---|
| stdio | `command/args/env`（显式 `type:"stdio"`） | `command/args/env/cwd`（有 command 即 stdio） | `command/args/env/cwd` | 同 gemini | `type:"local"`，**command 是数组**（命令+参数合一），env 叫 `environment` | `command/args/env/cwd`（无 transport 自动推断） | `type:"stdio"` + command/args/env | command/args/env（type 可省略） | `command/args/env/cwd`（有 command 即 stdio；通用 `enabled`/`startup_timeout_sec`/`tool_timeout_sec`） |
| remote | `type:"http"` + url/headers | `url` + `http_headers`（SSE 不支持） | **`httpUrl`**（url=SSE 已 legacy） | 同 gemini（httpUrl） | `type:"remote"` + url/headers | url/headers（http；SSE 须显式 transport） | `type:"http"` + url/headers | url/headers（自动协商 transport） | `url` + `type`("http"/"sse"，省略时 /sse 结尾即 sse) + `headers`/`bearer_token_env_var` |
| cwd | 未核实，**不写** | `cwd` | `cwd` | `cwd` | `cwd` | `cwd` | 未核实，**不写** | 未核实，**不写** | `cwd` |

### 10.3 密钥与插值（防明文落盘口径）

- claude/codebuddy：`${VAR}` / `${VAR:-default}` 插值（codebuddy **只认全大写变量名**）；codex：**无通用插值**，用 `bearer_token_env_var`/`env_http_headers`/`env_vars` 按名引用环境变量（内联 `bearer_token` 会被显式拒绝）；gemini/qwen：`$VAR`/`${VAR}` 全文件插值（gemini 有出站 env 脱敏，密钥必须在 env 块显式声明）；opencode：`{env:VAR}` 语法；kimi：`bearerTokenEnvVar` 间接引用；cursor：`${VAR}` 与 `${env:NAME}`；grok：headers/env 值支持 `${VAR}` 引用 + `bearer_token_env_var`（env 读 token 注入 `Authorization: Bearer`，密钥不落盘）。
- 结论：Ccode 清单里密钥一律存「环境变量名引用」，各家映射成各自的间接引用字段，不落明文。

### 10.4 共性红线

- **绝不整文件覆盖**：claude/codex/gemini/qwen 的目标文件都是混合状态文件（存登录态/信任记录/model 选择等），只读-改-写一个键/段，写前备份 + 原子写（复用 global_config.rs 的 agent 级事务批次模式）。
- **企业管理层探测**：claude（managed-mcp.json 三系统路径）/opencode（managed 目录）存在即放弃分发并提示。
- **项目级都有审批闸**（claude/qwen/cursor/codebuddy 逐工作区批准，gemini/qwen 未信任目录整层忽略）——默认只写用户级。
- **校验手段**：claude `mcp get`（不要 `mcp list`，会真连 server）、codex `mcp list --json`（脱敏）、cursor 没有非交互校验命令（只能解析文件）。
- **stdio 命令解析**（Ccode 侧分发义务）：裸命令名必须经 `resolve_binary` 落绝对路径（GUI/打包环境 PATH 短）；node 系 shim（`#!/usr/bin/env node` shebang 的脚本/symlink，如 npx）要再换成 node 绝对路径 + shim 真实路径首参，否则宿主 PATH 无 node 时 spawn ENOENT（实机踩坑：npx symlink → npx-cli.js，shebang 依赖 PATH 里的 node）。**相对路径命令（`./` `../` 开头）直接拒写报错**——基准是来源 CLI 的运行语境（如 codex 插件目录），分发到别家必 ENOENT，引导改绝对路径（2026-08-17 实机案例：codex 插件的 computer-use 以 `./…` 收编后分发 kimi 连不上）。
- **kimi `/mcp-config` 交互编辑器实测坑**：曾把启动参数整体写进 `cwd` 字段（`"cwd": "-y <pkg> <dir>"`），spawn 时目录不存在报 ENOENT——报错文案指向 command 路径，极具迷惑性。遇到 kimi MCP ENOENT 先查 cwd 是否合法目录，再查命令路径。
- **server 命名**：统一 `[A-Za-z0-9_-]`；gemini 额外要求**不含下划线**（policy 引擎按下划线切分 FQN，含下划线安全策略静默失效）。

## 11. 图片输入实测表（2026-08-17 调研）

九家 CLI **全部内建图片输入**，且「把图片/文件的绝对路径文本写进输入框」九家通吃——这是 Ccode 终端
图片/文件输入的实现基础（paste 事件拦图片 → 落盘 → 路径写 PTY；macOS Ctrl+V 透传 `\x16` 由 CLI 自读剪贴板）。

| CLI | 粘贴剪贴板图片（键位 + 机制） | 拖入图片 | @路径引用图片 | 模型能力门控 | 来源 |
|---|---|---|---|---|---|
| claude | macOS **Ctrl+V**（CLI 收到按键后自读系统剪贴板；Cmd+V 只在新版终端部分支持） | 拖入 = 路径文本，发送时升级为真附件 | 支持，自动升级为真附件 | 多模态模型才消费（当前默认模型均可） | [docs](https://docs.anthropic.com/en/docs/claude-code/interactive-mode) |
| codex | macOS Ctrl+V（TUI 自读剪贴板）；Windows/Linux Alt+V | 路径文本 → 真附件 | 支持 | 取决于所配模型是否多模态 | [repo](https://github.com/openai/codex) |
| gemini | macOS Ctrl+V；Windows Alt+V | 路径文本 | 路径原文进上下文，模型经工具读图 | 同左 | [repo](https://github.com/google-gemini/gemini-cli) |
| qwen | 同 gemini（fork 同源键位） | 路径文本 | 路径原文 + 工具读图 | 同左 | [repo](https://github.com/QwenLM/qwen-code) |
| opencode | macOS Ctrl+V；Windows Alt+V | 路径文本 → 真附件 | 支持 | 同左 | [docs](https://opencode.ai/docs/tui/) |
| kimi | macOS Ctrl+V；Windows Alt+V | 路径文本 | 路径原文 + 工具读图 | 同左 | [repo](https://github.com/MoonshotAI/kimi-cli) |
| codebuddy | macOS **Ctrl+V 与 Cmd+V 都认**；Windows Alt+V | 路径文本 | 路径原文 + 工具读图 | 同左 | [官网](https://www.codebuddy.ai) |
| cursor | 剪贴板图片键位同上口径；路径引用为主 | 路径文本 | 路径原文 + 工具读图 | 同左 | [docs](https://cursor.com/docs/cli) |
| grok | Ctrl+V（**另认 Cmd+V**，九家中仅 codebuddy/grok 两家） | 路径文本 → 真附件 | 支持 | 同左 | [repo](https://github.com/xai-org/grok-build) |

要点：

- **macOS 的网页侧坑**：Ctrl+V 在 WKWebView 里不产生 paste 事件也不进 PTY，Ccode 在键盘层改写为
  `\x16` 透传（kimi 因 kitty 键盘协议改写为 CSI-u `\x1b[118;5u`，待实机验证）；Cmd+V / Chromium 的 Ctrl+V
  走 paste 事件，有图片时拦下落盘转路径。Windows 各家贴图用 **Alt+V**（本就透传为 ESC+v，无需处理）。
- **路径文本的升级行为分两派**：claude/codex/qwen/grok/opencode 会把输入框里的图片路径升级为真附件
  （多模态直读）；gemini/kimi/codebuddy/cursor 是路径原文进上下文、模型经工具读图。两派用户体验等价，
  Ccode 只需保证写进去的是**转义后的绝对路径**。
- 临时落盘文件在 `<config>/ccode/tmp/paste-*`，保存时顺带清理 7 天前残留（clipboard.rs）。

## 12. 精确注意力 hooks 桥接调研（2026-08-20；实现 = hooks.rs 的 BRIDGE_SPECS，写字段/事件名前以本节为准）

**目标**：注意力标记从「会话尾部文本推断」升级为「CLI 原生事件实时驱动」——向各家 CLI 的 hooks 配置写入三个事件
（用户提交→工作中 / 轮次结束→已回复 / 等待确认→待确认）的命令条目，事件触发时 CLI 把原始 payload（加 unix 秒前缀）
追加到 `<config>/ccode/hooks-state/<tag>-hooks.jsonl`；注意力分类对已开启的 agent 优先读该日志，缺失或超 10 分钟
无更新回落尾部推断（消费侧零改动）。

### 12.1 桥接总表

| CLI | 配置文件 | 格式/写入形态 | 三事件映射（工作中 / 已回复 / 待确认） | 生效门槛 | 证据与版本 | Ccode 状态 |
|---|---|---|---|---|---|---|
| claude-code | `~/.claude/settings.json` hooks 键 | JSON | UserPromptSubmit / Stop / Notification | 无 | 原有落地（v3.32） | ✅ 已接入 |
| qwen | `~/.qwen/settings.json` hooks 键 | JSONC 容错读 | UserPromptSubmit / Stop / Notification（matcher `permission_prompt\|idle_prompt`） | 无 | 本机包源码核实 0.21.1 | ✅ 已接入 |
| codebuddy | `~/.codebuddy/settings.json` hooks 键 | JSON | UserPromptSubmit / Stop / Notification（matcher `permission_prompt\|idle_prompt`）——与 Claude 完全同名同语义 | **启动快照 hooks 配置**：运行中外部改文件需在 /hooks 面板 review 才生效（该行为未实测） | 官方文档+本机包源码核实 2.132.0 | ✅ 已接入 |
| gemini | `~/.gemini/settings.json` hooks 键 | JSONC 容错读 | **BeforeAgent / AfterAgent / Notification（matcher `*`，仅 ToolPermission 型）** | 无 | 本机包源码核实 0.46.0（官方 migrate 命令映射表确认事件对应） | ✅ 已接入 |
| kimi | `~/.kimi-code/config.toml` `[[hooks]]` | TOML strict 四字段（event/matcher/command/timeout，多写字段整个配置加载失败） | UserPromptSubmit / Stop / **PermissionRequest**（kimi 的 Notification 是后台任务通知，陷阱勿用） | 无 | 二进制内嵌源码+官方文档核实 0.37.2 | ✅ 已接入 |
| grok | `~/.grok/hooks/ccode.json`（整文件归 Ccode，全局目录免 folder trust） | JSON 整文件形态（开启=写文件，关闭=删文件，不含 marker 的外来文件拒绝覆盖） | UserPromptSubmit / Stop（**payload reason=end_turn 才算**，teardown 会以 shutdown/channel_closed 重发）/ Notification（matcher `permission_prompt\|idle_prompt`） | 无 | **实机验证 1.0.5** | ✅ 已接入 |
| codex | `~/.codex/hooks.json` | JSON，handler 带 `async: true` | UserPromptSubmit / Stop / **PermissionRequest** | **非托管 hook 需在 TUI /hooks 面板审核信任后才执行**（按 hook 定义 hash 记信任，改命令失效需重审） | 本机 0.148.0 实测 features stable + 官方仓库源码核实 | ✅ 已接入 |
| cursor | `~/.cursor/hooks.json`（扁平结构 `{version:1, hooks:{事件:[{command}]}}`） | JSON | beforeSubmitPrompt / stop / **无「等待确认」等价事件** | CLI 逐事件触发与 conversation_id↔会话文件映射未实机验证（未登录） | bundle 调用链+官方文档核实 2026.08.04 | ❌ 未接入（无等待确认等价事件 + 机制未实机验证） |
| opencode | 无 shell hooks 形态 | — | —（仅进程内 JS 插件：`~/.config/opencode/plugins/*.ts`，事件 session.idle/permission.asked 等，事件名 v2 重构中不稳定） | — | 官方文档+SDK 类型核实 1.18.18，本机未装未实测 | ❌ 未接入（无 shell hooks 形态） |

### 12.2 各家全事件集要点与陷阱（挂钩前核对）

- **qwen（0.21.1）**：共 21 事件，含 idle_prompt/PermissionRequest/StopFailure；**UserPromptSubmit 语义比 Claude 宽**
  （工具续轮也触发，`submitted_prompt` 才是纯用户提交）——桥接仍挂 UserPromptSubmit，多报的 working 会被后续 Stop 纠正。
- **gemini（0.46.0）**：共 11 事件；**AfterModel 每 chunk 触发，勿挂**；SessionEnd 不等待 hook 完成（不能用于同步收尾）；
  官方 migrate 命令的映射表确认 Claude→Gemini 对应（UserPromptSubmit→BeforeAgent / Stop→AfterAgent / Notification→Notification）。
- **kimi（0.37.2）**：另有 SessionHeartbeat 每 60s 活性信号（本批未用）；`[[hooks]]` 是 TOML strict——event/matcher/command/timeout
  四字段多写一个整个配置加载失败，写入走 toml_edit 保格式、只增删条目。
- **codex（0.148.0）**：共 11 事件；另有 legacy `notify` 配置项（仅 agent-turn-complete 一个事件、payload 走 argv）——桥接不用它。
- **grok（1.0.5）**：envelope 键是 camelCase（sessionId/hookEventName/transcriptPath）、事件值是 snake_case
  （user_prompt_submit/stop/notification）；Stop 在会话 teardown 时会以 reason=shutdown/channel_closed 重复 fire。

### 12.3 日志解析与写入防护统一口径（hooks.rs）

- **双信封兼容**：claude/qwen/codebuddy/gemini/codex/kimi 的 payload 键是 snake_case，grok 是 camelCase——解析时两键都探。
- **事件名归一化**：去下划线 + 全小写（grok 的 snake_case 值与其余各家的 PascalCase 归到同一判定表）。
- **grok Stop 去重**：只认 reason 缺失或 `end_turn` 的记录，shutdown/channel_closed 跳过不更新状态。
- **会话归属双键匹配**：`session_id == 会话文件主名` 或 `transcript_path == 会话文件完整路径`（grok 会话文件主名恒为
  `updates`，必须靠 transcript_path 命中；kimi 无 transcript_path 自然只用前者）。
- **写入防护**（同 global_config 约定）：写前备份（同前缀留 10 份）+ 原子写 + 只动 hooks 段/键 + 用户已有 hooks 合并
  而非覆盖 + 移除只删含状态日志路径（marker 子串，匹配前反斜杠归一化为正斜杠）的条目并回收空壳键 + 配置损坏拒绝写入；
  **grok 整文件形态例外**（文件归 Ccode，外来文件拒绝覆盖）。
