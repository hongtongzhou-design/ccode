# Ccode 架构方案 v0.2

> 一个「AI 科研工作台」：底层是九个 Agent CLI 的统一控制台（启动器 + 配置中心 + 会话监控台），
> 表面是科研流水线（读文献 → 整数据 → 做图 → 写论文）——AI 负责干活，Ccode 负责管活，人负责拍板（2026-08 定稿，§11）。
> 本文档是项目的总体逻辑架构，配合 `docs/agent-integration-matrix.md`（九个 CLI 的适配细节）使用。
> 所有关于各 CLI 的事实均来自 2026-07-30 对官方文档/源码的调研，标注「易漂移」的字段需防御式处理。
> v0.2：固化五项产品决策（命名 Ccode、项目自动聚合、终端↔对话联动、token 统计留在 P3、三平台同步）。
> v3.4：定位演进为 AI 科研工作台（§11 演进线）；通用控制台架构（§1–§10）作为其底层继续成立。

## 1. 产品定位与核心概念

> 2026-08 起定位演进为「AI 科研工作台」（§11）；本节三项能力是其底层控制台，继续成立。

让用户在一个桌面应用里：

1. 为多个终端 AI agent（Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI）管理**多套 API 配置**（端点 + 密钥 + 模型），一键切换；
2. 在**内嵌终端**里一键拉起任意 agent + 任意配置 + 任意项目目录；
3. **可视化浏览**各 agent 的历史会话（按项目自动聚合组织），并与内嵌终端联动，实时观看进行中的对话。

三个核心领域概念：

- **Agent**：一种 CLI 程序（如 Claude Code）。每种 agent 对应一个「适配器」。
- **Profile（配置档）**：属于某个 agent 的一套 API 配置：`{ base_url, api_key, model, 额外参数 }`。一个 agent 下可有多个 profile（如「官方」「中转 A」「中转 B」）。
- **Session（会话）**：某 agent 在某项目目录下的一次对话，数据来源于该 CLI 自己落盘的会话文件（只读解析，零侵入）。

## 2. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 应用名称 | **Ccode** |
| 技术栈 | Tauri v2（Rust 后端）+ React + TypeScript + Vite 前端 |
| MVP 范围 | 配置中心 + 内嵌终端一键启动 + 历史会话浏览 |
| 会话数据源 | 解析各 CLI 本地会话文件（只读），文件监听实现准实时 |
| 切换机制 | 双模式：默认**启动时注入环境变量**（零污染），另提供「设为全局默认」写入 CLI 配置文件 |
| 终端形态 | 内嵌终端（xterm.js + Rust PTY），**与会话视图联动** |
| 项目来源 | **从各 agent 历史会话自动聚合「常用项目」并分类**，辅以手动添加 |
| Agent 范围 | 六个全部进 MVP，通过适配器接口隔离差异（v3.23/v3.24 起八家，v3.80 起九家） |
| 分发 | **三平台（macOS / Windows / Linux）同步**，代码从第一天起保持跨平台 |
| token/费用统计 | P3 顺带做（usage 字段已确认可解析） |
| 实现方式 | 主要由 AI 编码，架构保持简单直接 |

## 3. 总体架构

```
┌────────────────────────────────────────────────────────┐
│ 前端 React + TS（Tauri WebView）                        │
│  ├─ ProfilesPage    配置中心：agent × profile 增删改查  │
│  ├─ LauncherPage    启动面板：选 agent/profile/项目     │
│  ├─ WorkspaceView   工作区：终端 + 结构化对话双栏联动   │
│  │    ├─ TerminalView  内嵌终端标签页（xterm.js）       │
│  │    └─ SessionView   当前会话的结构化对话（准实时）   │
│  ├─ ProjectsPage    常用项目（自动聚合 + 分类 + 置顶）  │
│  ├─ SessionsPage    会话浏览：项目 → 会话 → 对话回放    │
│  └─ (后期) FilesPage / 编辑器 / 统计面板                │
├────────────────── Tauri IPC（commands + events）────────┤
│ Rust 核心                                               │
│  ├─ ProfileStore    profile 持久化（JSON + 系统钥匙串） │
│  ├─ AgentAdapter    trait，九个实现（见 §4）            │
│  ├─ PtyManager      portable-pty 拉起/管理 CLI 进程     │
│  ├─ SessionIndexer  扫描各 agent 会话目录 → 统一索引    │
│  ├─ SessionParser   每种格式一个 parser（防御式）       │
│  ├─ ProjectAggregator 跨 agent 聚合/分类项目列表        │
│  ├─ SessionLink     终端标签 ↔ 新会话文件关联           │
│  ├─ FileWatcher     notify 监听会话目录，增量推送       │
│  └─ ConfigWriter    「设为全局默认」写各 CLI 配置文件   │
└────────────────────────────────────────────────────────┘
```

模块职责与边界：

- **前端不直接碰文件系统**，一切经 Tauri command；终端字节流和会话增量更新走 Tauri event/channel 推送。
- **AgentAdapter 是唯一的差异隔离层**。新增 agent = 新增一个 adapter 实现，其他模块不动。
- **SessionIndexer 只做索引**（session 列表 + 元数据），**SessionParser 按需解析**单个会话全文，避免启动时全量解析几百 MB 历史。
- 解析全部**只读**。我们永远不写各 CLI 的会话目录；唯一写操作是用户显式点「设为全局默认」时的配置文件改写（先备份）。

## 4. AgentAdapter 接口设计

```rust
trait AgentAdapter {
    fn id(&self) -> AgentId;                    // "claude-code" | "codex" | ...
    fn detect(&self) -> DetectResult;           // 是否安装、版本、二进制路径
    /// 注入模式：把 profile 翻译成启动环境变量 + 额外 CLI 参数
    fn launch_plan(&self, p: &Profile) -> LaunchPlan;  // { env: Map, args: Vec, cwd }
    /// 全局模式：把 profile 写入该 CLI 的配置文件（先备份原文件）
    fn apply_global(&self, p: &Profile) -> Result<BackupHandle>;
    fn session_roots(&self) -> Vec<PathBuf>;    // 会话目录（可能多个/不存在）
    fn list_sessions(&self, project: Option<&Path>) -> Vec<SessionMeta>;
    fn parse_session(&self, id: &SessionId) -> Conversation;
    /// 联动支持：能否在启动时指定会话 ID（见 §6.7）
    fn supports_session_id_flag(&self) -> bool;
}
```

九个 agent 的关键适配结论（细节见 matrix 文档，此处只列**影响架构的事实**）：

| Agent | 注入模式可行？ | 注意点 |
|---|---|---|
| Claude Code | ✅ `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` | settings.json 里的 `env` 块会**覆盖** shell env；`--session-id` 可固定会话文件名 |
| Codex | ⚠️ 有 `CODEX_API_KEY`，但**没有 base URL 环境变量** | base URL 只能走 `-c model_providers.x.base_url=...` 启动参数或写 config.toml；且只支持 Responses API 协议的中转 |
| Gemini CLI | ✅ `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_MODEL` | env 优先级仅次于 CLI 参数，注入干净 |
| Qwen Code | ✅ `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` + `--auth-type openai` | 多协议（openai/anthropic/gemini），profile 需记录协议类型；`--session-id` 可用 |
| OpenCode | ⚠️ **无通用 key/baseURL 环境变量** | 用 `OPENCODE_CONFIG_CONTENT`（内联配置 JSON）+ `OPENCODE_AUTH_CONTENT`（内联凭证）注入，优先级足够高且确定 |
| Kimi Code | ⚠️ **新版故意忽略 shell env 里的 API key** | 新版只能用 `KIMI_MODEL_NAME/API_KEY/BASE_URL/PROVIDER_TYPE` 合成模型通道，或写 config.toml；旧版（Python）可直接 `KIMI_API_KEY`/`KIMI_BASE_URL`。两个产品命令都叫 `kimi`，检测时必须区分 |

结论：注入模式**不能假设「每个 agent 都有统一的 env 三件套」**，`launch_plan` 返回 `env + args` 组合正是为了吸收这种差异（Codex/OpenCode 主要靠 args/env 内联配置）。

## 5. 核心数据模型

```rust
struct Profile {
    id: Uuid,
    agent: AgentId,
    name: String,              // "官方" / "中转A"
    protocol: Option<String>,  // qwen/opencode 需要: "openai" | "anthropic" | ...
    base_url: Option<String>,
    key_ref: Option<KeyRef>,   // 密钥本体进系统钥匙串，这里只存引用
    key_hint: Option<String>,  // 密钥尾号提示（"···abc1"），仅界面区分用
    models: Vec<String>,       // 可用模型列表，首个为默认；启动时在终端页下拉选择
    extra_env: Map<String,String>, // 附加环境变量，注入优先级高于 adapter 内置 env
    extra: JsonValue,          // agent 特有字段（透传给 adapter）
}

struct Project {               // 聚合后的项目条目
    path: PathBuf,             // 展示与启动用的工作目录
    git_root: Option<PathBuf>, // 用于跨目录归并
    agents: Vec<AgentId>,      // 哪些 agent 在此有过会话
    session_count: u32,
    last_active: DateTime,
    pinned: bool, hidden: bool, tags: Vec<String>,  // 用户可整理
}

struct Workspace {             // 任务工作区（借鉴 Conductor，§6.10）
    id: Uuid,
    repo_path: PathBuf,        // 所属 git 仓库（主工作树）
    name: String,              // 任务名（目录名 <repo>/<name>）
    branch: String,            // ccode/<name>，评审与合并单元
    worktree_path: PathBuf,    // ~/ccode/workspaces/<repo>/<name>
    base_branch: String,       // 创建时的基准分支名（如 main；起点固定为本地分支，不用 origin）
    port_base: u16,            // 分配的端口段起点（CCODE_PORT..+9）
    status: Active | ReadyToMerge | Archived,
    created_at: DateTime, archived_at: Option<DateTime>,
}

struct SessionMeta {           // 索引条目，列表页用
    agent: AgentId,
    session_id: String,
    project_path: PathBuf,     // 统一的项目维度（各 agent 推导方式不同，见下）
    title: Option<String>,
    created_at: DateTime, updated_at: DateTime,
    file_path: PathBuf,        // 源文件（opencode 则是 db 路径 + 行 id）
    token_usage: Option<TokenUsage>,
    cli_version: Option<String>,
}

struct Conversation { messages: Vec<ChatMessage> }
struct ChatMessage {
    role: User | Assistant | ToolCall | ToolResult | System,
    blocks: Vec<ContentBlock>, // text / thinking / tool_use(name,args) / tool_result
    timestamp: Option<DateTime>,
    usage: Option<TokenUsage>,
}
```

「项目」维度的统一是解析层最麻烦的部分，各 agent 推导方式不同（全部已核实）：

- Claude Code：目录名即 sanitize 后的项目路径，**可逆解码**
- Codex：读每个 session 首行 `session_meta.cwd`
- Gemini CLI：读 `~/.gemini/projects.json` 映射 + slug 目录里的 `.project_root` 标记文件，**不要自己推导 slug**
- Qwen Code：读 session 首条记录的 `cwd` 字段（目录名有碰撞可能）
- OpenCode：SQLite `project` 表的 `worktree` 列
- Kimi Code：新版读 `session_index.jsonl` 的 `workDir`；旧版读 `kimi.json` 的 `work_dirs[]`

## 6. 关键机制设计

### 6.1 配置切换（双模式）

- **注入模式（默认）**：`PtyManager` 拉起 CLI 时注入 `launch_plan` 的 env/args。不改用户任何全局文件，多个 profile 并存无冲突。
- **全局模式**：`ConfigWriter` 改写目标 CLI 的配置文件（如 `~/.claude/settings.json` 的 `env` 块、`~/.codex/config.toml` 的 `[model_providers]`）。同一 agent 的全部目标文件按事务批次处理：先生成并验证内容 → 建同批备份清单 → 写入并同步全部临时文件 → 统一替换；任一步失败回滚整批。恢复选择最近一个完整批次，恢复前再备份当前状态，原恢复点不消耗。每类备份保留最近 5 份。UI 上必须明示「这会修改该 CLI 的全局配置，影响你在其他终端里的使用」。
- **Profile 可用性验证**：保存与可用分离。`profile_validation` 返回三层结构化结果：本地字段及活配置解析 → CLI doctor/启动预检 → 最小 API 请求（协议、鉴权、模型存在性、延迟）。密钥只在 Rust 层读取并参与请求，所有回传文本先脱敏。「设为全局」成功后至少自动执行前两层，避免写入成功却留下 CLI 无法解析的配置。

### 6.2 密钥存储

- 密钥本体存 `<平台配置目录>/ccode/keys.json`，文件权限 0600（与 Codex `auth.json`、Claude Code 在 Linux 的 `.credentials.json` 同一威胁模型）；`profiles.json` 里只存尾号提示（`key_hint`）。
- **不用系统钥匙串**（v0.1 曾用，已废弃）：macOS 钥匙串 ACL 与代码签名绑定，未签名的开发构建每次热重编译产生新 cdhash，旧条目即失配读不到，表现为「密钥消失」；Linux 的 Secret Service 在无桌面环境下也不可用。读取时保留从钥匙串的一次性迁移，兼容旧版本数据。
- 注入时从 `keys.json` 读出，只存在于子进程环境变量中，不进日志、不前端回显（UI 只显示尾号掩码）。

### 6.3 内嵌终端

- Rust 侧 `portable-pty` 创建 PTY 并 spawn CLI（带上 launch_plan 的 env/args/cwd）；输出字节流经 Tauri channel 推给前端 xterm.js；前端输入/resize 反向 command。Windows 走 ConPTY（portable-pty 已封装）。
- 支持多标签：每个标签一个 PTY 实例，`PtyManager` 按 id 管理。
- 每个终端标签记录 `(agent, profile, project_dir, linked_session_id)` 元数据，供工作区面板展示与联动。
- 应用重启只恢复**可重新启动的标签元数据**：label/cwd/agent/profile/model/sessionId 白名单写入 localStorage；PTY id、scrollback、密钥、环境变量、run 脚本命令均不持久化。重开后是明确的非运行占位标签，用户点击才创建新 PTY；目录/profile 失效时停在可编辑启动栏，不自动换目标。

### 6.4 会话索引与准实时监控

- 首次扫描 + 增量监听（`notify` crate 监听各 agent 会话根目录）。
- 索引结果缓存到 app 自己的 SQLite（app 数据目录），启动秒开列表；源文件 mtime/大小变化才重解析。
- 解析器防御式规则（调研确认各家格式都是**内部格式、随版本漂移**）：逐行解析、跳过未知 type、容忍最后一行截断、不依赖单一字段存在。Claude/Qwen 每行带 `version` 字段，可用于问题定位。
- 已知特殊处理：Codex 旧 rollout 会被 **zstd 压缩**成 `.jsonl.zst`；Gemini 有 `$rewindTo`/`$set` 控制记录（不能简单拼接）；OpenCode v1.2+ 是 **SQLite（WAL 模式只读打开）**，更早版本是 JSON 文件。

### 6.5 会话分类与保留（借鉴 Wave Terminal）

会话文件的两大风险：会被 CLI 自动清除（Gemini 默认 30 天）、格式会被迁移压缩（Codex zstd、OpenCode 换存储）。因此「分类」和「保留」必须由 Ccode 自己的存储承担：

- **整理数据存 app.db，源文件只读**：`session_meta` 表以 `(agent, session_id)` 为键，存 `{ pinned, archived, custom_title, tags[], note, pinned_at }`。借鉴 Wave 的 namespaced meta 思路——语义全在我们这边演进，不碰 CLI 任何文件。
- **pin 即保留（快照拷贝）**：借鉴 Wave「named = saved」的零按钮理念——用户点 pin 时，Ccode 把会话源文件**拷贝**为 `<app-data>/ccode/snapshots/<agent>/<session_id>.jsonl`（OpenCode 则导出该会话的消息行）。此后 CLI 端无论自动清除还是迁移，回放都走快照；未 pin 的会话源文件消失时，仅在列表标注「已失效」。
- **分类三个维度**：① 自动——按项目聚合（§6.6 的 ProjectAggregator）；② 手动——tags + custom_title；③ 状态——pinned / archived / 默认。列表页支持按 agent、tag、时间范围过滤与标题搜索（Wave 恰恰没有全局搜索，这是我们可以做透的空白）。
- **注意力标记（后续）**：Wave 用 Claude Code hooks + badge 做「哪个会话需要输入」的优先级汇总，P3 可借鉴，配合 SessionLink 在终端标签上显示状态。

### 6.6 项目聚合与分类（ProjectAggregator）

- 数据源：各 adapter 的 `list_sessions` 产出的 `project_path` 集合，跨 agent 归并。
- **归并规则**：路径规范化（resolve `~`、符号链接、尾部斜杠、大小写按平台）→ 若同属一个 git root（向上找 `.git`）则合并为一个项目，展示名取 git root 目录名。
- **分类**：自动标注每个项目「哪些 agent 用过 / 会话数 / 最近活跃时间」；默认按最近活跃排序；支持用户置顶（pinned）、隐藏（hidden）、打标签（tags）。这些用户整理数据存 app 自己的 `app.db`，不参与归并逻辑。
- 也支持手动添加一个尚无会话的目录。

### 6.7 终端 ↔ 会话联动（SessionLink）

工作区双栏：左边终端，右边该会话的结构化对话（随文件监听准实时刷新）。关联策略：

1. **优先确定性关联**：对支持 `--session-id` 的 agent（Claude Code、Qwen Code），启动时由 Ccode 生成 UUID 并传入，会话文件名即可预测，启动即锁定。
2. **兜底探测关联**：其余 agent 在启动时记录 `(agent, project_dir, launch_time)`，FileWatcher 在该 agent 会话根目录下发现 `mtime > launch_time` 且项目归属匹配的新文件，即关联到该终端标签；多个候选取最新。
3. 关联失败不阻塞终端使用，右栏显示「等待会话文件产生」；会话结束后仍可回放。

### 6.8 App 自身数据

```
<平台 app-data 目录>/ccode/
├── profiles.json          # profile 定义（无密钥明文）
├── keys.json              # API 密钥（0600）
├── catalogs/              # codex model catalog（按 profile 生成）
├── snapshots/             # pin 的会话快照
├── app.db                 # 会话索引缓存 + session_meta（SQLite）
└── backups/               # 全局模式改写前的配置文件备份
```

### 6.9 工作区：工作树与并行可视化（借鉴 VS Code）

VS Code 的五区布局（活动栏/侧栏/编辑器区/面板/状态栏）映射到 Ccode 的产品逻辑——核心对象是「(agent, profile, 项目) 的并行会话」：

- **工作树（Explorer）**：终端页左侧可折叠栏，根目录 = 活动终端标签的 cwd，切标签即切根。借鉴 VS Code Explorer 的懒加载（展开才读子目录，`list_dir` command）与单击预览（右侧预览面板，只读、文本上限 256KB、二进制拒绝，`read_file_preview` command，路径限制在项目根内）。刷新：切回标签自动 + 手动按钮；文件监听自动刷新留 P4。
- **运行中总览**：工作树下方固定面板，列出全部终端标签（借鉴 VS Code 终端标签列表）：状态点（绿=agent 运行 / 蓝=shell / 灰=已退出）、agent、profile、模型、项目 basename、启动时长；点击激活标签。这是并行工作的可视化入口；P3 接 hooks badge 后叠加「等待输入」标记（Wave 思路）。
- **布局**：终端页三带 `[上下文（项目/工作区/文件树） | Agent 终端 | 成果工作台（对话 / 文件 / 改动）]`，左栏可折叠，成果工作台默认可见并显示当前目录上下文。终端启动栏不再提供重复的「对话」按钮，右侧工作台是实时对话、文件预览编辑和 Git 改动的唯一常驻切换入口；任务审阅仍从改动页进入既有全宽覆盖层。右侧宽度可拖拽并记忆，宽屏动作只隐藏工作树、不杀终端。App 主区与终端三带均以 `h-full/min-h-0` 约束，外层裁切溢出，滚动只落在文件树、对话、diff 等具体内容区；避免页面级滚动或无约束 flex 子项在窗口缩放、拖动或长内容后留下黑屏/空白。
- **改动面板（借鉴 VS Code Source Control 与 Codex 环境信息）**：右栏第三页签，量化 agent 的工作成果——当前分支、领先/落后远程、对比 HEAD 的 `+/-` 行数（含未跟踪文件）、文件级列表。普通仓库默认不选择文件，`git_commit(paths)` 与 `ai_commit_message(paths)` 使用 `--literal-pathspecs` 且重新校验当前 status，只暂存/读取用户勾选项；工作区任务维持全量提交语义。提交信息非空时按原文执行「提交 / 提交并推送」，留空时同一按钮切为「快速提交 / 快速提交并推送」，前端按所选文件状态或数量即时生成中性默认信息，不启动 AI。Git 失败保留默认信息。独立 ◈ 仍可按需生成更完整的信息。8 秒轮询刷新，非 git 仓库明确提示；git 写操作始终只由用户点击触发，命令输出与错误回显。
- **明确不借鉴**：VS Code 服务化 workbench 架构（过重）；文件树 git 装饰（标改动）留 P4；真正的编辑器留 P4 Monaco，预览只读先行。

### 6.10 任务工作区编排（借鉴 Conductor，全量整合）

Conductor 的核心模型「工作区 = git worktree + 分支」解决我们的并行冲突隐患：现在多个终端标签在同一目录跑 agent 会共享文件与 git 状态。整合方案：

**工作区模型与位置**
- 位置：`~/ccode/workspaces/<repo名>/<任务名>/`（worktree 实体）；元数据存 `app.db` 的 `workspaces` 表
- 一个工作区 = 一条 `ccode/<任务名>` 分支 + 一个 worktree；分支是评审与合并单元
- worktree 与主仓库共享对象库，创建是秒级；归档只移除 worktree 不删分支，可恢复（含会话历史）

**生命周期**
1. **创建**：SQLite `BEGIN IMMEDIATE` 原子预留端口并写 `status=creating` → 从**本地基准分支**拉 `ccode/<name>`（含未推送提交，镜像本地项目现状；曾从 `origin/<base>` 拉导致未推送工作丢失，已改）→ `git worktree add` → **files-to-copy**（`.env*` 等 gitignored 文件按 `.ccode/settings.toml` 的 `files_to_copy` 复制进 worktree）→ 激活记录 → **setup 脚本** → 自动开终端标签（cwd = worktree，注入端口段 `CCODE_PORT..CCODE_PORT+9`）。worktree/复制/激活失败执行补偿事务：移除 worktree、prune、删除分支和 creating 行并释放端口；复制错误必须中断并点名文件。setup 失败沿用非阻断语义，保留工作区供修复
2. **工作**：现有三带工作区全部适用；git 面板的 diff 基准从 HEAD 改为 `merge-base(base, branch)`，能看到任务累计改动
3. **合并**：改动面板扩展——提交后可选「合并回 `<base>`」（本地 merge）或「创建 PR」（复用机器上的 `gh` CLI 认证，不做应用内 GitHub 登录）；冲突时提示让 agent 解决
4. **归档**：先拒绝 merge 进行中、未提交改动和仍运行的 agent/run 脚本；脏工作区提供「提交并归档」→ 跑 archive 脚本 → `git worktree remove`（不带 `--force`，保留分支）→ 状态 Archived；恢复 = 从分支重新 `worktree add`。`--force` 仅用于用户明确确认的删除操作

**一致性与修复**：`workspace_drift` 对 DB、仓库、分支、worktree 注册和 merge 状态做显式对账。异常时普通危险动作停用，只暴露与问题匹配的修复：重新挂载/修复 worktree 链接、重新定位仓库、元数据标记归档、元数据清理记录，或进入统一冲突审阅。标记归档与清理记录不得删除磁盘/分支。`ReadyToMerge` 必须同时满足 `ahead > 0`、无未提交、无冲突、主仓在基准分支且干净；空工作区不能合并。

**操作呈现**：工作区列表是任务索引，只保留任务、状态详情和「终端 / 评审」主路径；PR、归档及其确认都定位到全宽评审内执行，避免在列表页形成第二套完成流程。唯一高频例外是已进入 merge 的冲突工作区：列表直接显示「解决冲突」，但仍只进入同一全宽审阅覆盖层。

**项目级配置**（三层合并：用户级 `~/.config/ccode/settings.toml` → 仓库 `.ccode/settings.toml`（可提交共享）→ `.ccode/settings.local.toml`（本地覆盖））：
```toml
files_to_copy = [".env", ".env.local"]
run_mode = "concurrent"            # nonconcurrent 时 run 按钮互斥
[scripts]
setup = "pnpm install"
archive = "docker compose down"
[scripts.run]
web = { command = "pnpm dev", default = true }
test = { command = "pnpm test" }
```
run 脚本在终端页以按钮呈现（在工作区上下文时），run_mode=nonconcurrent 保证单实例。

**与现有架构的咬合点**
- ProjectAggregator：worktree 路径（`~/ccode/workspaces/...`）的会话归并到「仓库 + 工作区名」标签下，不散落成独立项目
- 终端标签：携带 workspace 徽标；「运行中」面板可按工作区分组
- 会话/pin/回放：无变化（路径自然落进 worktree 目录的会话记录里）
- 端口注入走 pty 的 spawn env，与 profile env 叠加

**分阶段实施**
- **阶段 A（核心闭环）**：Workspace 模型与 app.db 表、创建/归档/恢复/删除、files-to-copy、端口注入、ProjectAggregator 归并、新「工作区」页面（仓库 → 工作区列表 + 状态 + 打开终端）
- **阶段 B（自动化）**：`.ccode/settings.toml` 三层合并、setup/archive 脚本执行、run 脚本按钮
- **阶段 C（评审流）**：diff 基准改 merge-base、合并回 base、gh PR 创建、状态机（ReadyToMerge 判定：`ahead > 0`、无未提交改动、与 base 无冲突、主仓位置与状态正确）

**明确不做**：云工作区、多人协作、应用内 GitHub 登录、城市命名游戏化、agent 系统提示注入（后续按需）。

### 6.11 P3 设计：OpenCode 解析、用量统计、注意力标记

**页面结构**：侧栏由四页扩为五页——配置 / 工作区 / 终端 / 会话 / **统计**。

**OpenCode 会话解析（补齐第六个 agent）**
- 数据源：`~/.local/share/opencode/opencode.db`（v1.2+ SQLite，WAL 只读打开，`busy_timeout`）；旧版（<v1.2）`storage/` 扁平 JSON 做兼容回退
- 表映射：`session`（id/title/cost/tokens_*/time_*/directory）→ SessionMetaDto；`message`（data JSON：role/model/tokens/cost）+ `part`（data JSON：text/reasoning/tool 判别联合）→ ChatMessageDto；项目归属：`project.worktree` 列
- 解析策略：只读查询 + JSON 列防御式解析；drizzle schema 随版本迁移，列缺失时降级而非报错；优先用官方 `opencode export`？否——用户机器上 opencode 未装时仍需能读库，直读 SQLite 为主

**用量与费用统计（新「统计」页）**
- 数据模型：解析层为 usage 事件产出 `{ agent, model, project_path, day, input, output, cache_read, cache_write, source, internal }`，按本机日期聚合存 app.db（避免每次全量重算；扫描增量更新）。普通 JSONL 与 Codex zstd 会话逐行流式解析，峰值内存由单条记录决定，不得以整个会话文件大小为由丢弃用量。普通会话默认为 `source=cli/internal=false`；Ccode 的 ◈ 无头调用在进程启动前写 `usage_provenance(agent, exact_project_path)`，重建索引时精确关联为 `source=ccode-ai/internal=true`。项目/模型 DTO 保留该维度，同一模型的普通和内部用量不能混行。路径与模型名只允许做跨平台规范化，不得参与内部活动判定；用户在 `/tmp` 主动运行仍是普通活动
- 定价表：内置 `model_pricing.json`（模型名/前缀 → 每百万 token 输入/输出价，参照 cc-switch `model_pricing.rs` 与 models.dev，允许用户在设置里覆盖）；中转模型价格不明时只显示 token 数，费用标「~」
- 页面结构：顶部卡片（今日/本周/本月 token 与估算费用）→ agent 分布 → 项目排行 → 模型明细表
- 边界：codex/gemini 的非累计 per-turn 用量按行聚合求和；claude cache_read 单列（它的计费大头）

**注意力标记（哪个 agent 需要你）**
- v1 启发式（零侵入，覆盖全部 agent）：终端标签有进程在跑 + 会话文件最后一条是「assistant 文本收尾（无待执行工具）」→ 「已完成/等待输入」蓝点；最后一条是「工具调用待结果」或进程高速输出 → 「工作中」绿点；权限请求类提示 → 「待确认」琥珀点。数据源：SessionLink 已有的轮询 + PTY 输出速率
- v2 精确化（后续）：Claude Code hooks（`~/.claude/settings.json` 的 hooks 字段，Notification/Stop 事件 → 写临时状态文件供 Ccode 读）——写入用户配置需备份与用户授权，单独评估
- 展示位：终端标签圆点、运行中面板状态、工作区行

**实施顺序**：OpenCode 解析 → 用量统计 → 注意力标记 v1。

### 6.12 跨模块闭环功能（会话 ↔ 终端 ↔ 工作区 ↔ 配置）

四个模块不再是孤岛，通过五条连接形成闭环：

- **A. 会话一键恢复到终端**：会话行/回放页「在终端恢复」→ 开终端标签：cwd = 会话项目目录、agent 对应、profile 取该 agent 上次使用的、并把恢复参数传给 CLI（claude `-r`、codex `resume`、qwen `-r`、kimi `-S`、gemini `-r`、opencode `--session`）。`pty_spawn` 加 `resume_session_id` 参数：注入恢复参数、跳过 `--session-id`（恢复的是已有会话）、hint 直接用该 id，SessionLink 确定性联动
- **B. 会话「进行中」标记 + 反向跳转**：终端标签 SessionLink 关联成功后，在 zustand 注册 `liveSessions`（sessionId → tabId）；会话页显示 🟢「进行中」，点击 → `setPage("terminal")` + 激活对应标签（`focusTabId` 桥）
- **C. 工作区记住上次配置**：localStorage 按 worktreePath 存 `{agentId, profileId}`；「打开终端」预填
- **D. 工作区行 → 查看会话**：会话页搜索字段加入 workspace 名；工作区行「会话」按钮 → `setPage("sessions")` + 预设搜索词
- **E. profile 上次使用时间**：`Profile.last_used_at`（启动时更新），配置页行显示相对时间，识别死配置

### 6.13 技能管理（Skills，借鉴 cc-switch 与 Agent Skills 开放标准）

侧栏第五页「技能」（配置/工作区/终端/会话/**技能**）。技能 = 目录 + `SKILL.md`（开放标准，frontmatter `name`/`description` 必填，各 CLI 扩展字段防御式忽略）。

**模型：技能库（SSOT）+ 分发**
- 库位置：`<config>/ccode/skills/<name>/`；元数据存 `skills.json`（name、description、source、apps 六 agent 布尔、installed_at）
- **应用到 agent** = 把库里的技能分发到各 CLI 的技能目录：
  - claude-code → `~/.claude/skills/`；codex → `~/.codex/skills/`；gemini → `~/.gemini/skills/`；qwen → `~/.qwen/skills/`；opencode → `~/.config/opencode/skills/`；kimi → `~/.kimi-code/skills/`
  - 分发方式 Auto（symlink 优先，失败回退 copy；Windows 无权限时自动 copy）
  - 嵌套技能目录（`skills/doc/docx/`）拍平为单段目录名；判定单位 = 含 SKILL.md 的目录，找到不下钻，跳过 `.` 开头目录
- 卸载自动备份（`<config>/ccode/skill-backups/`，保留 5 份）

**导入（四路）**
1. **本地目录**：选一个目录，递归扫描含 SKILL.md 的子目录批量入库
2. **ZIP 文件**：扫描 ZIP 内含 SKILL.md 的条目；安全三件套（解压预算 ≤128MB/10000 条、路径穿越校验、symlink 物化为副本）
3. **GitHub 仓库**：`owner/repo[/subdir]`，下载 `archive/refs/heads/<branch>.zip`（main→master 回退）后按 ZIP 流程；预设 anthropics/skills 等常用源
4. **从应用目录发现**：扫描六 CLI 技能目录 + `~/.agents/skills/` 里未纳管的技能，一键收编入库

同名导入返回结构化 `added/updated/skipped/conflicts`；用户可选择跳过、备份后覆盖或另存为。覆盖先备份旧库，ZIP 先完整解压到 staging，元数据保存失败回滚库目录。GitHub 来源额外持久化 repo/ref/subdir/revision，`check_skill_updates` 提示 revision 变化；`apply_skill_update` 一键应用更新——按记录的 repo/ref/subdir 重下 zipball，`import_zip_impl` 加 `only` 过滤只覆盖同名技能（其余不新增不覆盖，走同一覆盖+备份路径），成功后刷新 revision 基线；上游改名/移动时明确报错并引导手动重新导入（仍走冲突确认）。

**内置技能种子（v3.64）**：14 个内置技能内容单一出处在 `src-tauri/resources/skills/<name>/SKILL.md`，经 `include_str!` 编进二进制（dev 与打包行为一致，不配 bundle resources）；启动时 `seed_builtin_skills` 幂等播种——只补库里没有的同名项，**永不覆盖用户已有/改过的技能**；库目录下 `.builtin-seed-version` marker 记录已播种版本，集合有新增时 `BUILTIN_SEED_VERSION` +1 触发补播，用户删掉的内置技能不会被复活。元数据 `source = "builtin"`，更新检测只对 github 来源生效、天然不碰内置技能。

**导出**：单个/多个技能打包为 ZIP（系统保存对话框）。

**页面**：技能行（名称 + description + 六个 agent 的应用开关徽标）+ 操作（查看 SKILL.md、重新应用、导出、删除）；顶部 导入/导出 按钮。查看用只读预览复用现有组件。

**后续（v2）**：来源更新检测（content_hash 比对）、SKILL.md 在线编辑、自定义命令（commands/prompts）管理。

### 6.14 诊断包与 Windows 后台进程边界

设置页「诊断」提供一键导出 `ccode-diagnostics-<时间>.zip`，固定写入下载目录的 `ccode-exports/`。诊断包由 Rust 层统一组装，包含：

- Windows 版本、WebView2 版本、显卡与驱动；前端补充 WebView user agent、语言、屏幕和 WebGL vendor/renderer；
- 当前文化、用户语言、默认与活动输入法布局，以及 CTF/TextInputHost 活动；
- 应用功能开关的脱敏快照（不输出 profile id、密钥或环境变量）；
- `logbuf` 最近 500 条应用日志；
- 自 Ccode 启动后的进程生命周期：程序、脱敏参数、PID/父 PID、开始/结束/最后观察时间、CPU/内存、类别、采集方式与时间是否估算。

直接经 `process::background_command` 启动的后台命令在 spawn/wait 边界精确登记程序、参数、PID、父 PID 与退出码；250ms
进程扫描补齐 WebView2、conhost、命令包装器的子孙进程和 CPU/内存，扫描拿不到创建时间时明确标记为估算。记录采用内存环形缓冲
（上限 2000），只覆盖 Ccode 子孙进程；系统级例外仅观察
`ctfmon.exe` / `TextInputHost.exe`，避免采集无关应用命令行。诊断包不读取任何子进程环境变量，命令参数和日志写入 ZIP 前必须经过
Rust 层密钥脱敏；路径与普通参数仍保留，README 明示发送前可先解压检查。ZIP 只使用 UTF-8 JSON/TXT，目标是 Windows 现场采集后
带回 macOS 离线分析，不依赖注册表导出、事件查看器格式、Ccode 或 Windows 专用查看器。

Windows release 构建使用 `windows_subsystem = "windows"`，没有可继承的父控制台。后台 console 程序若直接
`Command::new` 会创建可见 `conhost.exe`，终端右栏 Git 的 8 秒轮询因此表现为周期性闪黑窗。所有非交互后台命令统一走
`process::background_command` 加 `CREATE_NO_WINDOW` 并登记生命周期；这些包装与进程扫描均由 `cfg(windows)` 隔离，macOS/Linux
仍直接使用标准 `Command` 且不启动监控线程。用户明确打开的外部终端是唯一可见窗口例外。

### 6.15 MCP server 清单与分发

MCP 页（第八页，⌘6）：Ccode 自有统一清单（`<config>/ccode/mcp-servers.json`，`mcp.rs`），按开关分发到各 CLI 的**用户级** MCP 配置（grok 首版只读清单、不分发，见 matrix §10.1）。规格与调研结论的单一出处是 `docs/agent-integration-matrix.md` §10（分发通道总表 / schema 映射 / 密钥插值 / 共性红线），改映射前先读它。

要点：

- **统一模型**：name（各家交集 `[A-Za-z0-9-]`，下划线禁——gemini policy 引擎按下划线切分）+ kind（stdio/remote）+ command/args/cwd/env + url/headers；env 与 header 的值允许 `$VAR`/`${VAR}` 引用形式。
- **映射层**：codex 走 TOML `[mcp_servers.<name>]`（toml_edit 保格式；引用转 `env_vars`/`env_http_headers`/`bearer_token_env_var`，内联 bearer 会被 codex 显式拒绝）；opencode 顶层键是 `mcp` 且 command 为数组、env 叫 `environment`、引用语法 `{env:VAR}`；gemini/qwen 的 remote 写 `httpUrl`（url=SSE 已 legacy）；kimi 无插值（header 的 Bearer 引用转 `bearerTokenEnvVar`，env 引用直接拒写报错）；claude/codex/gemini/qwen 的目标文件是混合状态文件，只读-改-写一个键/段。
- **分发纪律**：只写用户级（项目级在 claude/qwen/cursor/codebuddy 有审批闸）；写前备份 + 原子写 + 读回校验；JSONC 容错读（注释/尾逗号 stripper 自实现）；claude 的 managed-mcp.json 存在即拒写；cursor 配置与 IDE 共享（UI 明示）。
- **不用 CLI 自带 mcp 命令分发**：各家语义不一（gemini 默认 project scope、codebuddy 默认 local、codex add 命中 OAuth server 会弹浏览器登录、kimi/cursor 没有可脚本化命令），直写文件八家统一且可批量。
- **编辑重投放**：save 时先重写到所有已开启 agent、全部成功才落库（防「清单说已分发但 agent 侧没写成」的假状态）；删除先逐 agent 移除条目再出清单。
- **安全闸**：清单文件 0600（对齐 keys.json）；明文密钥拦截——env/header 值命中常见密钥前缀且非 `$VAR` 引用时，保存/粘贴导入报 `PLAINDETECT:` 由前端二次确认；移除/删除前比对 agent 侧条目与当前映射产物，外部改过的报 `EXTMOD:` 确认后才强删；粘贴导入两阶段（预览命令清单 → 确认落库），stdio 命令等于任意执行必须明示。

## 7. 技术选型清单

| 层 | 选型 | 理由 |
|---|---|---|
| 壳 | Tauri v2 | 已确认；体积小，Rust 层适合文件/进程/PTY |
| 前端 | React 19 + TypeScript + Vite + Tailwind | Tauri 标配，生态熟 |
| 终端 | `@xterm/xterm` + `addon-fit`；Rust `portable-pty` | 事实标准组合，Windows 走 ConPTY |
| 文件监听 | `notify` | 跨平台 |
| SQLite | `rusqlite`（bundled） | 读 OpenCode db + 自身索引缓存 |
| 压缩 | `zstd` crate | Codex `.jsonl.zst` |
| 密钥 | `keyring` crate | 三平台系统钥匙串抽象 |
| 路径 | `dirs` crate | 三平台 app-data / home 目录 |
| 状态管理 | zustand | 轻量，够用 |
| TOML/JSON | `toml` / `serde_json` | 写各 CLI 配置文件 |
| CI | GitHub Actions 三平台构建矩阵 | 三平台同步的保障，P1 接入 |

刻意不做的事（MVP 阶段）：无后端服务、无账号体系、无云同步、无插件系统、不自研编辑器（后期直接嵌 Monaco）。

## 8. 分阶段路线图

> 以下为通用控制台阶段的原始规划（P0–W3 已全部完成）；2026-08 起的新阶段见 §11 演进线。

- **P0 — 骨架跑通**：Tauri 工程 + Profile CRUD（含钥匙串）+ Claude Code / Codex 两个 adapter 的 detect + 注入式 launch + 单标签内嵌终端。验收：在 app 里用「中转 profile」拉起 claude 并对话。
- **P1 — 配置中心完整**：其余四个 adapter 的 detect + launch；全局写入模式（含备份/恢复）；多标签终端；启动面板；**接入 GitHub Actions 三平台构建**。
- **P2 — 会话可视化**：SessionIndexer + 四个 jsonl 系 parser（Claude/Codex/Gemini/Qwen）+ **ProjectAggregator** + 项目 → 会话 → 回放三级页面 + **会话分类与保留（session_meta 表 + pin 快照，§6.5）** + 全局搜索 + 文件监听准实时刷新 + **SessionLink 终端联动**。
- **P3 — 会话可视化补全**：OpenCode（SQLite + legacy JSON 双解析）、Kimi 双版本 wire 协议解析（**已提前完成**）、**token/费用统计面板**。
- **P4 — IDE 形态**：项目文件树、Monaco 编辑器、（可选）本地 API 代理用于精确计费/实时结构化对话。
- **W1 — 任务工作区核心闭环（§6.10 阶段 A）**：Workspace 模型、创建/归档/恢复、files-to-copy、端口注入、工作区页面、ProjectAggregator 归并。
- **W2 — 工作区自动化（阶段 B）**：`.ccode/settings.toml` 三层配置、setup/archive/run 脚本。
- **W3 — 评审流（阶段 C）**：merge-base diff、合并回 base、gh PR 创建、工作区状态机。

## 9. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 各 CLI 会话格式是内部格式，随版本漂移（调研已确认六家都漂移） | 防御式解析；每行带 version 时记录；解析失败降级为「原始视图」而不是报错 |
| Codex 中转必须讲 Responses API，很多 Anthropic 系中转不支持 | UI 上对该 profile 类型给出协议提示；不强推 Codex + 任意中转的组合 |
| Gemini 会话默认 30 天自动清除 | 列表页容忍会话消失；重要会话提供「导出快照」 |
| 新旧 Kimi 命令同名、格式完全不同 | detect 时按版本号 + 数据目录区分，UI 显示为两个 agent 条目或标注版本 |
| 全局模式写坏用户配置 | 多文件事务批次 + 失败整批回滚 + 恢复前再备份当前状态 + UI 明示影响范围 |
| 三平台差异（路径大小写、ConPTY、keyring 后端、会话目录） | `dirs`/`keyring`/`portable-pty` 均已封装；P0 在 macOS 开发但禁写平台特定代码，P1 起 CI 三平台构建验证 |
| Windows 上 Gemini/Qwen/Kimi 依赖 Node 或 Git Bash 环境 | detect 结果里给出缺失依赖提示，不静默失败 |

## 10. 决策记录

| 版本 | 决策 |
|---|---|
| v0.1 | 技术栈 Tauri + React；MVP = 配置中心 + 启动 + 历史浏览；数据源 = 解析本地会话文件；双模式切换；内嵌终端；六 agent 全进 MVP；AI 主导编码 |
| v0.2 | 命名 **Ccode**；项目列表 = 从各 agent 历史自动聚合 + 分类（§6.5）；终端 ↔ 结构化对话联动（§6.6）；token/费用统计保持 P3；三平台同步分发，CI 矩阵 P1 接入 |
| v0.3 | 密钥存储弃用系统钥匙串，改 0600 `keys.json`（macOS 钥匙串 ACL 与未签名开发构建冲突导致密钥丢失）；借鉴 CC Switch 落地：原子写入（tmp+rename）、内置端点预设（只收官方/公开端点）、profile 导入导出（不含密钥）；Claude 多模型经 `ANTHROPIC_DEFAULT_*_MODEL` 别名槽注册进 `/model` 选择器（最多 5 槽） |
| v0.4 | 借鉴 Wave Terminal 细化会话设计（§6.5）：pin 即保留（快照拷贝到自家目录，对抗 CLI 自动清除/格式迁移）；整理数据（pinned/tags/custom_title）存 app.db 不碰源文件；分类 = 项目聚合 + tags + 状态三维度；全局搜索作为差异化做透。明确不借鉴：序列化终端缓冲区快照（与解析路线重复）、AI 会话内存存储（不可靠） |
| v0.5 | 参考实现扩展为三个（+ VS Code，长期有效）；新增 §6.9 工作区设计：工作树（懒加载+只读预览）+ 运行中总览面板 + 终端页三带布局；多模型切换按各 CLI 机制实现（claude 别名槽 / codex model_catalog_json / qwen modelProviders / kimi [models.*] / opencode provider.models / gemini 手输）；会话删除为用户显式指令的只读原则例外 |
| v0.6 | 全站暖黑主题（Conductor 风，令牌集中 `src/App.css` @theme，禁蓝色系，用户否决浅色+渐变方案（浅色否决已于 v3.44 作废））；安装/更新命令必须 PTY 执行（管道块缓冲坑）；brew 走 TUNA 镜像；**全量采纳 Conductor 工作区编排**（§6.10）：任务工作区 = git worktree + 分支，分 A/B/C 三阶段实施（W1/W2/W3）；明确不做云工作区/多人协作/应用内 GitHub 登录；重大改变沉淀规则到 AGENTS.md + 本节（用户指令） |
| v0.7 | P3 设计定稿（§6.11）：侧栏扩为五页（+统计）；OpenCode 直读 SQLite（WAL 只读 + 防御式）；用量按天聚合入 app.db、内置定价表可覆盖、中转不明价只显 token；注意力标记 v1 走零侵入启发式（会话尾态+输出速率），Claude Code hooks 精确化留 v2 单独评估（需写用户配置）；功能增改必须同步 `docs/user-guide.md` |
| v0.8 | 跨模块闭环 A-E 实施（§6.12）：会话一键恢复（pty_spawn resumeSessionId）、进行中标记 + 反向跳转、工作区记住配置、工作区→会话筛选、profile 上次使用；**主题二次定稿为沉浸冷黑**（四层浮起结构，保留绿 CTA，暖棕色系被用户否决）；配置页按用户详版规格重构（折叠分组 + 五列网格 + 筛选搜索）；图标按钮点击区 ≥28px |
| v0.9 | 新增技能管理模块（§6.13）：SSOT 技能库 + 六 CLI 分发（Auto symlink/copy），四路导入（本地/ZIP/GitHub 仓库/应用目录发现），ZIP 导出，卸载备份；采纳 Agent Skills 开放标准（SKILL.md 防御式解析）；更新检测与在线编辑留 v2；git 推送改走 SSH:443 通道 + repo deploy key（HTTPS 网络不稳） |
| v1.0 | P3/P4 完成后迭代：费用统一官方价口径（27 项定价、供应商前缀剥离、部分估算标 ≥）+ $/¥ 一键换算；**工作树逻辑统一**（当前项目锚点=tab cwd、最近项目真进入、操作边界=树当前根、运行中默认折叠、搜索范围明示）；文件操作加重要路径删除保护（系统目录/关键用户目录/CLI 配置/.git）；预览按扩展名语法高亮；安全原则重申：删除保护只覆盖 UI 操作，agent 权限依赖各 CLI 自身机制 |
| v1.1 | 设置页 + 主题系统：七套深色主题（实测色板融合，各带独立强调色，[data-theme] CSS 变量运行时切换；删除暖夜/墨绿/深紫）；「活跃」「可合并」pill 用 cta-pill 同步强调色，其余状态保持语义色（干净优先）；**AI headless 层**（ai.rs，复用 launch_plan 注入，六 CLI print 模式，profile 按 last_used_at 解析）；profile 用量按模型近似归属（悬浮卡展示）；侧栏可折叠为图标栏；符号语言统一（◈=AI、⚑=pin，禁彩色 emoji）；WKWebView 不支持 window.prompt——输入一律内联 |
| v1.2 | 终端会话回路补全：shell 回落提示语义化（「会话已保存，可一键恢复」）；收缩状态行加「⟳恢复」（resumeSessionId 直接续聊）与「⤴对话」（跳会话页打开回放做整理）；确立「进程一次性、会话永久」的展示语义；终端字形回调清瘦（400/600、行高 1.2、零字距，向 Ghostty 锐利度靠） |
| v1.3 | v0.1.0 发版：性能一轮（终端页 memo 化、SessionLink 轮询文件签名门控、页签保持挂载消切换迟滞、工作树收缩 xterm 重 fit）；终端字体打包 JetBrains Mono woff2 + 设置页字体/调色板可配；**安全**：删除保护 canonicalize 双校验（堵符号链接绕过）、codex 默认沙箱（交互 workspace-write / AI 无头 read-only）；应用图标全套（emerald-mint）；**CI 发布流水线**：tag/手动 dispatch → 三平台 cargo test → tauri build → Release 草稿（workflow 配 contents:write；CI 测试禁墙钟时序断言、unix 语义门控、路径断言 Path 比较）；**macOS 签名公证暂缓**（用户拍板，未签名包首开需右键打开；后续办 Apple Developer 会员后在 CI 配 6 个 APPLE_* secrets 即可补） |
| v1.4 | 设置页「AI 专用配置」：◈ 三功能（提交信息/摘要/PR）profile 解析顺序改为 显式 id > 设置专用 > 最近使用（settings.ai_profile_id，空串清空回自动；专用被删明确报错不静默回落）；动因：自动落大模型导致生成慢，小任务应走快模型。**工作区起点改为本地基准分支**（create/base_ref/git_info 三处，原从 origin/<base> 拉导致用户未推送提交不进工作区；工作区语义 = 本地项目现状） |
| v1.5 | CLI 二进制解析加 GUI 短 PATH 兜底：`agents::resolve_binary` 统一入口（先 which 继承 PATH，miss 查平台候选目录——macOS `/opt/homebrew/bin`·`/usr/local/bin`·`~/.npm-global/bin` 等，Linux `~/.local/bin`，Windows `%LOCALAPPDATA%\Programs`·`%APPDATA%\npm`）；detect/终端启动/AI 无头/更新安装（含 brew/npm 工具检测与 PTY spawn）/gh PR 全部改走它 |
| v1.6 | 优化一批：list_repos 60s 进程内缓存（create 后失效）；**前端分包**（页面 React.lazy + visited 保挂载语义、Monaco/xterm vendor chunk，首屏 4.7MB→224KB，monaco 3.9MB 固有体积按需加载）；终端 Cmd+F 搜索（SearchAddon，按活跃标签隔离）；会话导出 Markdown（~/Downloads/ccode-exports/）；诊断日志面板（logbuf 环形 500 条 + 前端 onerror/unhandledrejection 上报 + 设置页分区）；**Tauri updater**（plugin-updater + minisign 密钥，私钥 ~/.tauri/ccode-updater.key 不进 git，CI 配 TAURI_SIGNING_* secrets，设置页「更新」分区手动/自动检查） |
| v1.7 | 评审闭环与预览/用色规范：评审面板（任务 diff + 逐文件彩色 diff + 冲突区——并入主分支、两侧内容预览、逐文件/一键选边、◈ AI 选侧建议 `ai_conflict_advice`，AI 只建议不执行）；合并拆分「合并（保留工作区，落 `merged_at` 列显示已合并 pill）/ 合并并归档」，`ws-archived` 广播让滞留终端自动 cd 回主仓库；合并健康检查前置主仓库状态（main_dirty/main_off_base）；**预览编辑器 = 稳定文档**（禁「预览跟随」——同名文件跨仓库静默切换曾致误改主仓库，教训入 AGENTS.md），主仓库文件保存警示色 + 二次确认，外部改写自动刷新；真实 cwd 跟踪（`pty_get_cwd`：macOS lsof / Linux /proc）；专注模式重构（标签与 ⋯ 动作菜单 portal 到 App 侧栏插槽，navCollapsed 入 store）；用色规范：强调色只给可操作状态、纯状态 pill 灰底 + 语义色小圆点、结果横幅灰底 + ✓/✗ 文字；会话 ⇗ 外部恢复 / ⧉ 复制恢复命令不带 profile env（密钥不进剪贴板/外部 shell）；kimi 检测补 `~/.kimi-code/bin` 候选目录 |
| v1.8 | 外部拉起与更新渠道修正：⇗ 外部恢复命令改用**二进制绝对路径** + shell `-l -i` 交互登录（非交互 `zsh -l -c` 不加载 `.zshrc`，官方安装器目录如 `~/.kimi-code/bin` 只写在交互 rc——Ghostty failed to launch 的根因）；**候选目录用户目录优先于系统目录**（`~/.local/bin` > `/opt/homebrew/bin`，与用户交互终端 PATH 解析一致，防止检测到同名旧副本）；**npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**（同机多份 node/npm 装错 prefix）；brew 安装的 opencode 走 `brew upgrade`（自更新 TUI 交互无法行输入应答）；kimi-k3 定价按官方 ¥20/¥100 修正（缓存命中一折口径与 cost_of 0.1 系数一致） |
| v1.9 | 工作台界面收敛：配置/工作区/技能/统计/设置统一页面框架、标题与主操作层级；终端展开态固定“agent → profile → 模型 → 目录 → 启动”主流程，辅助动作独立，启动后收缩和标签常驻语义不变；会话树响应式压缩、列表明确当前/搜索/总量，运行态改语义色点；统计默认归并 `ccode-ai-*`、临时目录与 `<synthetic>` 内部记录，提供本机记忆的“显示内部活动”。**会话敏感信息边界**：已保存密钥与常见密钥前缀必须在 Rust 层统一脱敏后，才允许进入列表 DTO、结构化回放、AI 摘要响应或 Markdown 导出；六 CLI 会话源文件仍保持只读。 |
| v2.0 | 工作区创作闭环收敛：新增终端全宽任务审阅覆盖层，工作区「评审」（无冲突）与终端「改动 → 审阅」共用；按文件树定位并连续懒加载双栏 diff，在同屏完成 AI 提交信息、提交与本地合并。默认「提交并合并」保留工作区且不推送，次级动作保留「仅提交 / 合并并归档」；操作前后都复用 `workspace_health`，提交后重新检查再合并。终端标签/PTY 在覆盖层下保持挂载；原改动面板「提交 / 提交并推送」及工作区「合并 / PR / 归档 / 会话」不删。有冲突时复用工作区既有逐文件选边与 AI 建议，不建立冲突处理分叉。 |
| v2.1 | 文件树与预览同步规则调整：切换项目、工作区、终端标签 cwd 或手动树根时清空旧预览，不自动映射新根下的同相对路径文件；若预览有未保存改动则确认，取消同时阻止树根切换。保留当前根内稳定文档与外部改写刷新语义，兼顾切换反馈和跨工作区误编辑防护。 |
| v2.2 | 工作区合并状态与冲突闭环：保留工作区合并后，`merged_at && ahead == 0` 时行内合并按钮显示禁用的「已合并」，新提交令 `ahead > 0` 后恢复普通合并动作。冲突入口使用「开始解决冲突」而非暴露“把 main 并入工作区”；底层仍在隔离工作树内同步和选边，默认完成动作串联 `workspace_finish_merge → workspace_health → merge_workspace(archive=false)`，把 Git 必需的解决提交隐藏为内部步骤；保留「仅保存解决结果」。若解决提交成功而最终合并失败，明确报告部分成功并刷新为普通可恢复状态，禁止自动重建 merge commit。 |
| v2.3 | 改动面板提交摩擦收敛：保留手写提交信息与独立 ◈ 生成入口；消息为空时，按钮变为「快速提交 / 快速提交并推送」，前端根据单文件状态（添加/更新/删除/重命名）或多文件数量同步生成中性默认信息后直接调用 `git_commit`，不额外启动 AI。Git 阶段失败回填默认信息供重试；成功 toast 展示实际提交标题。终端与会话页复用同一 `GitPanel`，行为一致。 |
| v2.4 | 开发预览与正式应用隔离：新增 `npm run tauri:dev`，合并 `tauri.dev.conf.json` 后以 **Ccode Dev** / `com.ccode.dev.hmr` /「Ccode Dev - 热更新」启动 Vite HMR 窗口。正式版、打包调试版和热更新开发版不再依赖同一个应用名定位；自动化验收禁止模糊匹配 `Ccode`，必须使用开发窗口标题或产物绝对路径。 |
| v2.5 | P0 数据安全闭环：归档改为无损语义——merge 中、脏工作树、agent/run 脚本运行中均拒绝，脏工作区提供「提交并归档」，非删除流程禁用 `worktree remove --force`；最终本地 merge 失败自动 `merge --abort` 保持主仓干净。commit/push、merge/archive、push/PR 改为结构化分阶段结果，后阶段失败只重试该阶段。全局 CLI 配置升级为 agent 级事务批次：完整备份清单、全部临时文件预写与同步、失败整批回滚；恢复前备份当前状态且不消耗原恢复点。 |
| v2.6 | 冲突审阅视觉闭环：工作区「解决冲突」与普通「评审」统一进入终端全宽覆盖层，删除原工作区行内冲突面板及跨页面回跳状态。新增只读 `workspace_conflict_content`，从 Git index stage 2/3 读取任务分支/基准分支原始内容并生成全文件双栏 diff；冲突文件连续浏览、右栏定位、逐文件/全部选边、◈ AI 建议、完成解决并合并均在同屏完成。底层继续只在隔离 worktree 执行 `workspace_sync_base → workspace_resolve_file → workspace_finish_merge`，不改主仓库冲突处理边界。 |
| v2.7 | 评审工作台视觉重构：保持 v2.6 的 Git 与冲突状态机不变，将完成动作固定到顶部，第二工具行承载分支统计、提交信息、批量选边和 AI 建议；右侧收敛为可搜索文件树与进度。主区继续多文件连续双栏审阅，新增文件标题吸顶、长段未修改内容折叠、滚动与右树选中同步。冲突选边改为每个文件标题下的紧凑双侧控件，AI 理由单行呈现并要求用户显式执行。 |
| v2.8 | 冲突基准一致性：工作区「解决冲突」在工作树干净时自动执行 `workspace_sync_base`，同步完成前不展示普通 merge-base diff，避免把累计任务 diff 误认成当前 main。`UnmergedDto.stale_base` 比较 `MERGE_HEAD` 与当前基准分支 tip；基准在冲突处理中前进时，冲突内容读取、选边和完成提交全部拒绝，UI 隐藏旧对照并要求用户确认后执行 `merge --abort → merge <latest-base>`。回归测试覆盖旧 main 冲突生成后 main 再推进、重启冲突后 stage 3 等于最新 main。 |
| v2.9 | P1/P2 可靠性闭环：工作区创建引入 `creating` 状态、SQLite 原子端口预留与 worktree/分支/DB 补偿回滚，空分支要求 `ahead>0` 才可合并，并提供 DB↔Git 状态漂移诊断与显式非破坏修复；Profile 增加本地解析、CLI 预检、最小 API 三层验证，全局写入后自动复检；普通仓库提交支持安全 pathspec 勾选，工作区仍全量提交；技能同名导入结构化冲突、覆盖备份/另存为与 GitHub revision 更新检测。终端重启仅恢复白名单元数据占位，不恢复 PTY 或敏感运行态；usage 内部活动改为后端启动前登记的精确 provenance，事件和项目/模型 DTO 显式携带 `source/internal`，彻底移除 `/tmp`、目录名和模型名启发式。 |
| v3.0 | 统计长会话与本地日期修复：usage 索引从“整文件读入 + 超过 10 MB 跳过”改为普通 JSONL / zstd 逐行流式解析，活跃的超长 Codex/Kimi 会话不再导致今日统计为空；事件日期和今日/近 7 天/近 30 天截止日统一按本机时区计算。索引 schema 升级为 v3，首次加载自动清空旧日桶并从只读会话源重建。 |
| v3.1 | 对话与改动信息架构收敛：终端右栏统一称“对话”，只轮询最近 50 条，增加会话头部、精确完整回放和仅近底部跟随滚动；无固定 ID 的 CLI 改为启动前 claim、同项目并发排他分配，所有运行态与跳转使用 agent+sessionId 复合键。会话页长回放改为有界尾窗 + 向前分页，标题拒绝占位值并回落首条真实用户消息；内部 AI 会话按后端 provenance 归并，归档开关统一左栏计数。Git 改动文件支持安全展开单文件 diff；会话页仅只读展示“当前项目改动”，明确不是历史快照，提交/推送回到终端处理。 |
| v3.2 | 终端信息密度与首开稳定性：最近项目由后端按仓库最大会话 updated_at 聚合排序，前端启动预取并缓存上次成功结果，终端最多显示 4 个且排除当前项目，无缓存时用固定骨架避免异步弹出造成布局跳动。紧凑单文件 diff 取消整行绿/红背景，只保留语义色文字、细边和 hunk 轻底色。右侧对话/预览/改动采用可拖拽且记忆宽度的分栏，并提供“隐藏工作树但保留终端”的宽屏展开/还原；不新增与任务审阅冲突的普通内容全屏路由。 |
| v3.3 | 全站信息层级收敛：管理列表行只保留识别、状态与主路径，低频操作统一进「⋯」；工作区 PR/归档收口到唯一全宽评审内确认，进行中的 merge 冲突保留直接「解决冲突」入口但不新增第二套界面。终端/App 布局固定 `h-full/min-h-0` 与局部滚动边界，避免窗口缩放、拖动或长内容后出现底部黑屏/空白。 |
| v3.4 | **定位转向（2026-08 定稿，§11）**：从「通用 Agent 控制台」演进为 **AI 科研工作台**（底层六 CLI 统一控制台 + 表面科研流水线；AI 干活、Ccode 管活、人拍板）。理由：harness（启动/配置/监控外壳）随 CLI 厂商自带工具成熟而贬值，验收层（人工评审才合并）反而升值；科研流水线是控制台能力的深水用法，能把工作区/评审/技能/统计串成完整链路。同步定稿三条纪律（科研语义进模板不进逻辑 / 验收层是护城河 / 跨厂商中立 API+官方账号双轨）、量化目标（开步 ≤3 次点击、产物传递 0 次手动复制路径）与五个核心机制（project.toml 档案卡 / Pipeline 模板 / 一键开步 / 接力包 / artifacts.yaml 提货单），新阶段 P0–P5 见 §11.4 |
| v3.5 | 否决 AI 自动拆任务 / Agent 编排引擎：等于自造 meta-agent，复杂度与责任边界失控，与「人负责拍板」定位冲突；流水线步骤由模板预设 + 人工开步驱动 |
| v3.6 | 否决 MCP 协议接入 / 自建协议：Ccode 无 tool-call 循环，接入 MCP 属概念错位；**MCP 配置分发 ≠ 接入**，分发仅列 backlog 调研项 |
| v3.7 | 否决智能路由引擎（按任务自动选 agent/模型）：只做使用数据展示（统计页），不替用户做路由决策，避免黑盒归因与厂商中立性争议 |
| v3.8 | 否决 Docker/VM 沙箱、daemon 化、手机同步：均属贬值层，投入大、与桌面控制台形态不符，安全边界依赖各 CLI 自身机制（codex 沙箱等）即可 |
| v3.9 | 否决 Zotero 式文献库 / 数据表格查看器：别人的战场；文献与数据只做流水线产物（笔记/bib/提货单），不做专业管理工具 |
| v3.10 | 否决 AI 全自动写论文绕过评审：触碰「验收层是护城河」底线——每步成果必须人工评审才合并进入下一步 |
| v3.11 | 否决 keyring 回退：macOS 钥匙串对未签名开发构建因 cdhash 失配丢条目（v0.3 已定论），0600 `keys.json` 不动摇 |
| v3.12 | 否决「无缝继续」表述：跨 Agent 交接在技术上不存在真正的上下文无缝迁移，一律称「接力」（结构化简报 + 显式接力链，AI 摘要仅可选增强） |
| v3.13 | 适配器注册表（§11.4 P1d）：「添加新 agent」澄清为新增 CLI 厂商（第七八个终端工具），要求降低接入成本——agents.rs / skills.rs / updater.rs / profiles / 官方账号字段等 per-agent 硬编码 match 收敛为中央声明式 AgentSpec 注册表（一个 CLI 一张规格），各模块从注册表读规格；**边界：会话解析器与 usage 提取器不可纯数据化**（各家格式本质不同），保持每 CLI 一个解析器文件，注册表只做分发入口。效果：加新 CLI = 一张规格表（纯数据）+ 一个解析器文件 + 测试。P1d 先行或与 P1a 背靠背（官方账号字段正是规格表字段，先注册表后填数据避免改两遍），250 个既有测试兜底重构安全；P5 的「适配层标准路径文档」随之撤销 |
| v3.14 | P2a PDF 内嵌预览落地：**直接上 pdf.js**（跳过 WKWebView spike——原生渲染拿不到选区文本且三平台行为不齐，选段问 AI 是硬需求）；pdfjs-dist 精确 pin，渲染器随 PdfPreview 组件动态 import 拆独立 chunk，worker 走 `?url` 资产；canvas + textLayer 只渲染当前页 ±1。新增 `read_pdf_bytes` command：**四类白名单**（注册项目登记资源 / 注册项目根 / 工作区·仓库根 / 终端标签 cwd hint）之外拒绝，canonicalize 防符号链接绕过，单文件 100 MB 上限；**传输走 base64 字符串而非 raw bytes**——macOS/iOS 的 Raw 响应会退化为逐字节 JSON 数字数组（tauri protocol.rs 实测），大 PDF 下不可用。选段问 AI = pty_write 逐字注入活跃标签输入框，不自动回车 |
| v3.15 | P3 接力 v1 落地（§11.3 机制四，handoff.rs）：`build_handoff_brief` 复用有界尾窗组装结构化简报（任务信息 / 最近 5 条用户要点 + 最后助手回复 / 当前 git 状态 / 接力说明），全文脱敏 + 64KB 上限后原子写 `cwd/.ccode/handoff-<时间>.md`（自定义路径限项目根内，父目录取最近已存在祖先 canonicalize 校验）；v1 不调 AI，AI 摘要保持可选增强。接力链两阶段：发起时按 agent+cwd 登记 `handoff_links` 小表（目标会话尚不存在），列表扫描到「登记后有活动的最新同目录会话」时固化进 `session_meta.handoff_from_*` 并**消费登记**（同目录后续新会话不再误标）；前端「◈ 接力到…」入口 = 终端专注栏 ⋯ 与对话页回放头部 ⋯，目标清单由注册表 prompt_inject + resolve_binary 合成（kimi/opencode 标注需手动并复制简报路径），接力会话在对话页显示「⇄ 接自 <Agent>」 |
| v3.16 | RX2a 笔记阅读模式：md 文件预览默认「阅读版式」——marked 渲染（pin 版本，静态 import 随 FilePreviewEditor 懒加载 chunk，不进主包）；渲染源为 read_file_preview 根约束内的本地可信文件，**不引 sanitize 重库**。排版样式集中 App.css `.md-body`（全主题令牌），v1 代码块不做语法高亮。「阅读/编辑」切换时 Monaco 保持挂载仅隐藏（脏内容/undo 不丢）；「⛶ 沉浸阅读」为 `fixed inset-0 z-30` 全宽覆盖层（与评审覆盖层同形态，终端/PTY 保持挂载，Esc 退出）；外部写盘自动刷新沿用既有 watcher 链路，编辑中（dirty）不覆盖语义不变 |
| v3.17 | P1a 官方账号 + P1d 适配器注册表落地：profile 双类型（API/官方账号，第一批 Claude/Codex/Gemini），连接走终端内 CLI 登录命令、断开引导 CLI 自己的 logout（auth 文件只读）；拉起不注入 API env 且 `env_remove` 同协议残留密钥变量；状态行检测 CLI 配置文件残留 API 密钥并黄色提示「N 项配置冲突」。per-agent 硬编码 match 收敛为 `agent_specs.rs` 中央声明式 AgentSpec 注册表（一个 CLI 一张规格：detect/launch_plan/resume/env、技能分发、安装更新、协议与密钥 env 名、官方账号 login/auth/env_remove）；**边界守住**：会话解析器与 usage 提取器不数据化，注册表只做分发入口 |
| v3.18 | P1b 流水线骨架 + RX1 落地：`.ccode/project.toml` 档案卡（资源清单 + 流水线定义，跟 git 走）与项目注册；工作区页按项目分组 + 步骤胶囊概览（状态从绑定工作区派生，无双状态机；分段进度条收敛为「研究流程 d/t」文字计数）；一键开步 = ensure_git_repo → `commit_project_bootstrap`（只提交 `.ccode`/`.gitignore` 两个自有路径，literal pathspec）→ 建工作区 → TASK.md → 终端预填；**TASK.md 自动加入 `.git/info/exclude`**（脚手架非产物，防全量提交带进分支污染主项目根）；资源面板只登记路径 + 自动发现候选；首启引导做轻量版（空流水线走模板选择器），演示数据完整版留 backlog。RX1：`PipelineEditor` 全宽编辑器为步骤编辑唯一入口（撤销步骤 ⋯ 内联编辑与 + 步骤表单），步骤资源绑定 `resources?: string[]`（空/缺省 = 全部资源，renderTaskMd 只在非空时过滤） |
| v3.19 | P2b 整理为笔记 + RX2b/RX3a 落地：`pdf_owner_project` 归属反查只在后端（登记资源 canonical 精确命中 → 项目根最长前缀，前端不做路径猜测）；写入只走 `append_workspace_inbox`（固定 `notes/inbox.md`、≤64KB、读-改-原子写、canonicalize 双校验防 symlink 逃逸）；无活跃工作区复用一键开步链路。RX2b：跨页「文件树切根」走 store 一次性 `enterCwdReq`；步骤产物面板打开时 `list_dir` 拉取一次（不进轮询；已完成读项目根 main，其余读工作树）。RX3a：会话步骤化——`session_meta` 附流水线步骤名（工作区名命中档案卡 steps[].workspaceName），对话页 badge/搜索/项目内分组统一走该映射 |
| v3.20 | P3 数据 + 接力落地：提货单 `artifacts.yaml` v1 务实版（手动登记 + 流式 md5/大小，已 git 跟踪文件拒绝登记，重复登记更新；大产物不进 git、清单随分支提交，下一步 TASK.md 自动带「上一步产物」段）；图片评审 `ImagePairView` 双栏看图（评审与改动面板共用，>20MB 回落提示）；长任务 OS 通知（注意力状态跃迁 + 窗口未聚焦 + 同标签 30s 去抖，设置页可关）；接力 v1 见 v3.15。RX3b：技能新建/编辑（create_skill/update_skill_content，重名拒绝、覆盖前备份、辅助文件保留）+「◈ 优化」开终端让 Agent 直改库文件；步骤可挂 `skills = [...]`，TASK.md 落「本步骤推荐技能」段（技能本体不进简报） |
| v3.21 | P4 论文 + RX4a + P5 打磨落地：科研论文/毕业论文模板自带 `quarto render` 脚本（开步写入项目 `.ccode/settings.toml`，run 菜单出现 render-draft/render-final；RX4a 追加 export-docx 同 md 导出 docx）；docx 走 mammoth 阅读版式（只读，>50MB 不渲染）；提货单登记的根外产物按精确路径纳入 PDF 白名单（P4 白名单扩展）；bib 联动以模板简报引用 references.bib 的务实形式落地。**逐 hunk 验收 v1 边界 = 仅未提交改动**：hunks 一律取未暂存 diff（工作树 vs 暂存区），丢弃 = `git apply -R`、暂存 = `git apply --cached`（补丁再经 `patch_targets_single_file` 校验只指向该文件）；勾选提交遇部分暂存走临时索引提交（`commit_selected_with_index`，提交后按路径 `git reset -q HEAD --` 同步真实索引）；已提交的累计 diff 禁止逐 hunk；新文件整文件算一块。**订阅口径**：官方账号用量显示「订阅」不计费（usage schema v6）；任务成本按工作区归因（schema v5）；跨标签聚合视图 `run-overview.ts` 纯逻辑按「要你管」排序 |
| v3.22 | 界面白话双层 + 精简收敛：主文案一律白话（保存到历史 / 多出 N 个保存点 / 改动说明 / 相对主分支），git 技术信息降二级（小字 mono、悬浮 title、详情 popover），**不加任何模式开关**；纯逻辑集中 `git-status-groups.ts`。管理列表只保留识别信息、状态与一到两个高频动作，低频项进「⋯」；工作区 PR/归档收口到统一全宽评审内确认执行（唯一例外：进行中的 merge 冲突保留行内「解决冲突」入口，仍进同一覆盖层）。Monaco 预览关闭 unicode 高亮（WKWebView locale 不命中致全角标点被黄框套住，中文笔记纯噪音） |
| v3.23 | 接入第七个 agent **CodeBuddy Code**（v2.132.0 实机验证，matrix §7）：注入只认 `CODEBUDDY_API_KEY/BASE_URL/MODEL`（ANTHROPIC_* 无效），协议 Anthropic 兼容；prompt_inject=位置参数、`-p` 无头、`-r <id>` 恢复、`--session-id` 固定会话名（pty 复用既有固定 ID 链路）。会话 `~/.codebuddy/projects/<slug>/<uuid>.jsonl`（slug 规则同 Claude；行 schema 与 Claude 不同构故独立解析器，时间戳为毫秒 epoch；usage 字段未实证，提取器尽力而为待真账号补全）。官方账号 TUI `/login`（浏览器 OAuth），env 优先压账号（实测 401）故拉起必须 env_remove；设为全局写 `~/.codebuddy/settings.json` env 块。落地形态验证 v3.13 注册表设计：新 CLI = 一张 AgentSpec（纯数据）+ 独立会话/usage 解析器 + 测试，agents/pty/updater/skills 零改动 |
| v3.24 | 接入第八个 agent **Cursor CLI**（2026.08.04-aaa8809 实机验证，matrix §8）：二进制用 `cursor-agent`（不用太通用的 `agent`）；**首个 env+flag 混合注入**——key/端点走 env（`CURSOR_API_KEY`/`CURSOR_API_ENDPOINT`），模型只能走 `--model` flag（bracket 参数化原样透传），注册表新增 `SpecialLaunch::CursorFlags` 变体（api/official 两路径同形，official 不注入 key 但保留模型 flag）。端点是 **Cursor 专有协议**（非 OpenAI/Anthropic 兼容）：不设供应商预设（presets.ts 注释说明），profile 三层验证的第三层标记「不支持云端验证」只给本地两层（不硬套 ApiKind）。会话 `~/.cursor/projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`（目录名=文件名=session id；`agent ls` 是 Ink TUI 非 TTY 会崩，发现只能文件扫描；type 枚举已知但完整字段样本未验证——独立防御式解析器，未知 type 跳过，文本/时间戳/会话 id 按候选字段名提取）。`~/.cursor` 与 IDE 共享：**会话删除不走目录级白名单**，由 `cursor_deletable` 精确限定 `projects/*/agent-transcripts/**/*.jsonl`（同根 auth.json/IDE 文件拒绝）；凭证默认 macOS 钥匙串（`AGENT_CLI_CREDENTIAL_STORE=file` 才落 auth.json），检测说明标注双通道；技能 `~/.cursor/skills-cursor` 未验证 CLI 是否真读，**强制 copy 分发**（`allow_symlink_for`）；无 brew/npm 包，安装走官方脚本、更新走非交互自更新 `cursor-agent update`；Windows 路径未验证（注释标注）。usage 提取器按字段名候选尽力而为，待真账号样本补全 |
| v3.25 | 全站界面确立“科研工作台优先”的信息架构：侧栏保留全部页面但按 **工作（工作区/终端/对话）→ 能力（配置/技能）→ 管理（统计/设置）** 分层，首次启动默认进入工作区；不把配置中心继续当首页。视觉借鉴高密度桌面工作台的对象列表、上下文栏和三栏结构，但不照搬 Git 客户端导航；工作区流水线、Agent 执行与人工评审仍是产品主轴。常规页统一使用 `PageFrame/PageHeader/PageToolbar`，标题栏只放当前上下文与唯一主动作，筛选进入独立工具栏；终端、对话和技能预览保留各自分栏与挂载语义。全站继续使用七套沉浸深色主题、零阴影、hairline 分隔与单一 CTA，不新增浅色或彩色图标（浅色否决已于 v3.44 作废）。 |
| v3.26 | 工作台布局进一步按对象规模收敛：工作区页从“所有项目纵向堆叠”改为 **左侧项目导航 + 右侧当前项目流水线/任务详情**，项目状态点直接表达活跃与待处理数量；技能页取消“一个 Agent 一列”的横向矩阵，主列表固定为技能/来源/应用计数/操作，选中后在右侧详情以自动换行网格管理 Agent 分发和阅读 SKILL.md，新增 Agent 不再改变主表列数。终端模块的文件树、标签、启动栏及右侧面板 UI 字号统一提高一级，xterm 新用户默认字号由 13 调为 14（仍尊重设置页 11–18 的用户选择）。 |
| v3.27 | 工作区、终端、对话三类高频工作页确立两级控件尺寸：标题栏与终端启动表单统一 32px，任务行、步骤胶囊、回放头部和图标操作统一 28px；可点击状态项同样保证 28px 点击区。主次操作只通过 CTA 填充、边框和文字色区分，不再通过同一操作组内的高度差制造层级。终端工作区外层与 xterm 画布共用主题 canvas 背景，避免空终端出现突兀色块。 |
| v3.28 | 全站页面建立统一留白节拍：常规页标题区、工具栏和主体内边距统一提升一级；工作区项目头、流水线步骤带和任务行增加适度垂直空间，低对象数量时保留连续主题画布，不用额外卡片或说明填空。 |
| v3.29 | 工作区项目详情建立单一职责入口：流水线步骤条改为等分列，每个步骤上方进度线与下方胶囊一一对应，窄窗口整体横向滚动而不换行。流程仅保留「开始 / 恢复 / 解决冲突」这类推进步骤的动作；未创建步骤只显示「开始」，不再重复显示同义的「待开始」，已归档步骤显示「已归档 + 恢复」。终端与普通评审统一由下方工作区任务行执行，产物查看与目录定位收进步骤「⋯」。编辑流水线、模板替换等项目级操作统一进入项目头「⋯」，不在流程末尾重复。已合并且无新提交的任务行只保留左侧「已合并」状态，不再显示语义冲突的「评审」；新提交后评审入口恢复。底层终端、评审覆盖层、产物读取与 Git 状态机均不变。 |
| v3.30 | 终端工作台参照 Codex/Review 的稳定三段结构：左侧只负责上下文（项目、工作区、文件树），中间只负责 Agent 终端执行，右侧成果工作台固定为「对话 / 文件 / 改动」三模式并默认可见。启动栏删除重复的「对话」按钮，右侧工作台增加统一标题、当前目录上下文和唯一入口；「文件」包含文本/PDF/docx 预览编辑，「改动」包含 Git 状态、提交和任务审阅入口。保留右侧拖拽宽度、宽屏隐藏工作树、PTY/会话挂载和全宽评审覆盖层，不改变底层进程与 Git 语义。 |
| v3.31 | 端口运行时监控（portwatch.rs，工作区页尾部默认折叠区）：列出本机 LISTEN 端口并标注归属——cwd 最长前缀命中工作区 worktree / 注册项目优先（项目嵌套归内层，组件级前缀比较防 myrepo2 误命中 myrepo），回落**活跃**工作区 CCODE_PORT 段（仅 active，与端口 env 下发口径一致），其余「系统/其他」；归属数据源（app.db 工作区/项目表）读取失败降级为空标注，不阻断端口列表本身。「终止」v1 只发 SIGTERM（进程不退由用户稍候重试，不自动升级 KILL），kill 前重新列举确认该 pid 仍在监听，防 pid 复用误杀；unix 走 lsof（resolve_binary → /usr/sbin 等固定候选，GUI 短 PATH 兜底），cwd 批量取 `lsof -a -p <pids> -d cwd -Fn`；Windows 走 netstat -ano + tasklist（无 cwd 轻量接口，cwd 归属不可用、段归属仍可用）。前端展开才拉取 + 手动刷新，不轮询 |
| v3.32 | Claude Code hooks 精确注意力标记落地（v0.7 留 v2 的评估项，ruflo 实证 hooks→状态文件链路可行）：设置页开关显式开启后才写 `~/.claude/settings.json` 的 hooks 段（UserPromptSubmit/Stop/Notification 三事件，命令把事件 JSON 加 unix 秒前缀追加到 `<config>/ccode/hooks-state/claude-hooks.jsonl`），写入遵守备份+原子写、只动 hooks 键、用户已有 hooks 合并不覆盖、移除只删含状态日志路径的条目、配置损坏拒绝写。`session_tail_state` 对 claude-code 优先读事件日志按 session_id 取最新事件（UserPromptSubmit→working / Stop→done / Notification→confirm），缺失或超 10 分钟无更新回落尾部推断；消费侧（终端注意力点/运行中聚合/OS 通知）零改动。备份文件命名用纳秒后缀防同秒开关覆盖 |
| v3.33 | 走查去层级冗余：终端右栏页签行与对话头部**合并为一行**（撤销 v3.30 的「统一标题 + 当前目录」行——标题/agent/会话 ID/状态/完整回放收进页签行右侧小字，文件/改动上下文由各自内容头部承担），终端三带头部同为 h-9 对齐；左栏「打开的标签」「最近项目」改一行式折叠（默认收起，三区标题统一 10px 灰字、点击区 ≥28px），项目区+文件树为常驻主体——评估过「打开的标签并入项目区」方案后否决：聚合视图是跨项目「要你管」排序，项目区只覆盖当前项目，合并会丢跨项目总览且增加项目区噪音（工作区注意力点项目区已有）。对话页分类筛选展开后 agent 节点直接平铺项目，去掉 agent 层二次折叠（计数/右键删除不变）。默认主题 hairline 自 #2d3448 调柔至 #282e42（用户反馈“亮线生硬”；其余六主题 hairline-vs-inset 对比度实测在同一档，不动）；对话页列表栏标题对齐 PageHeader 的 16px semibold 档 |
| v3.34 | 对话页分类筛选改**左右主从栏**（撤销 v3.33 的「agent 平铺项目」——全平铺导致项目一多就要长滚动找目标）：展开后左栏固定列出 全部对话/Ccode 内部 AI/各 agent 及计数（一眼看全，无需滚动），点 agent 即筛选并在右栏列出其项目（顶部「全部项目」回到 agent 整体），再点项目精确筛选，两击到位、无嵌套折叠；两栏各自 max-h 滚动互不挤压。评估过 pill 行筛选方案后否决：8 个 agent × N 项目的胶囊行换行不可控，照样吃纵向空间且项目计数无法同屏。右栏聚焦 agent 独立 state（显式点选优先，失效回落当前筛选/列表第一家）；项目行右键批量删除、计数口径与归档开关联动不变；agent 行由 div 改 button，键盘 Tab 可达 |
| v3.35 | 界面线条语言批次（用户反馈"看着像一个个格子区域"）：确立**去格子化**规则——内联内容容器（工具栏/分区/面板/卡片式列表）一律去 1px 描边，靠底色明暗差 + 统一圆角 + hairline 分隔线分层；边框只保留给浮层（弹窗/浮出菜单）与控件（按钮/输入框）；PageToolbar、设置页 Section、端口区、流水线 strip、资源/产物/模板面板、PipelineEditor 步骤卡、历史时间线列表、终端搜索条等全站收敛。七主题浮起梯度校准（ayu/mocha/neutral/dracula/shadcn 的 strip=inset 塌陷全部拉开，默认主题 strip→inset→raised 步进匀开）；新增 `--color-editor-bg/fg/line` 令牌（各主题独立取值），Monaco 编辑器经 MutationObserver 监听 data-theme 实时换肤（原焊死默认主题色）。共享控件收敛进 PageFrame.tsx（rowActionClass/ghostActionClass/fieldClass/searchFieldClass/hoverRevealClass + SegTabs 组件，约 100 处散落复制替换），删除配置页专属别名令牌 pg/grp/hl2/pl1/pl2/okb/warnb。对话页分类筛选修正主从交互（修 v3.34 的"点 agent 即筛选"）：左栏点 agent 只聚焦右栏、不再立即筛选并关闭回放，右栏才落筛选，选中自动收起 |
| v3.36 | 改动面板改**主从分栏**（用户给外部 Git GUI 参考图：左 diff 右文件列表）：点文件行从「行内展开」改为左栏 diff 主区 + 右栏 176px 紧凑文件列（状态徽标 + 文件名，勾选框保留，选中行浅填充，再点当前行或 × 收起回全宽列表）；diff 主区承接原展开区全部能力（逐 hunk 丢弃/暂存、部分暂存提示、图片双栏、截断标记），取消行内展开的 max-h 高度帽（分栏后由主区自滚动）。WKWebView 不显示 title 悬浮——diff 入口改 hover 才现的可见「diff」小字提示。随后用户拍板两处视觉校准：紧凑 diff 增删行**整行铺语义深底**（bg-ok/bg-err，推翻 v3.2 的禁铺色约定，参考图即整行铺色更清晰）；**全局字体去"发白发飘"**——body 去掉 `-webkit-font-smoothing: antialiased` 恢复次像素渲染（macOS 深色下 antialiased 把笔画削薄），diff 正文 11px→12px 档（终端工作台内实际 13px） |
| v3.37 | 线框二次收敛（用户 Dracula 主题截图走查"还是像格子"）：**六套非默认主题 hairline/field 全部调柔**（v3.33 只调过默认主题；实测 Dracula hairline 与底色亮度差 ≈40 远硬于默认主题 ≈12，六主题统一压到默认档位）；终端左栏「打开的标签/最近项目/项目」区标题与工作区 rail 底部横线**去线改留白分层**（错位横线是最强的格子感来源）；搜索框去描边化（searchFieldClass 改 inset 底色 + 聚焦加深，不再画框）。对话页分类筛选**改回单列纵向手风琴**（用户反馈左右主从栏"一横一竖难受"，取代 v3.34/v3.35）：点 agent 只展开/收起项目子列表（左侧缩进线表达层级），「全部项目」/单项目行落筛选并自动收起，点 agent 不再动筛选/关回放的语义保持。同批**侧栏向 Codex 看齐**：品牌区去渐变去下线、工作区 rail/终端工作树/对话列表栏的头部横线全拆，侧栏只留全高竖分界 + 底部管理区一根横线，分区间一律留白 |
| v3.38 | 侧栏按页面自动收展（用户提出「移到顶端」，评估后否决全局顶栏：垂直空间全页征税、与 macOS 标题栏叠罗汉、专注模式插槽与运行徽标需重设计；多列宽度压力其实只在终端/对话页）：进入终端/对话页自动收成 56px 图标栏，离开恢复 localStorage 手动偏好；手动折叠/展开置 `navManual`（session 级）停止自动跟随；`setNavCollapsedAuto` 不写 localStorage，防自动行为污染手动偏好。同批**全站线条细化**（用户反馈"线条再细一点"）：App.css 统一把 border/border-t/b/l/r 与 divide-x/y 覆写为 0.5px（Retina 出真发丝线，1x 屏浏览器兜底 1 物理像素；focus-visible outline 保持 1px 不动）；侧栏底部管理区横线改 5% 白隐约细线（用户否决全拆），常规页 PageHeader 底线同批拆除（标题栏靠留白分层） |
| v3.39 | **首页注意力收件箱**（第一性原理讨论后用户拍板做第①条）：工作区首页顶部新增「待你处理」区——聚合工作区冲突/可合并（health 页内已有）+ 终端标签待确认/已完成，排序 冲突 > 待确认 > 可合并 > 已完成，为空整块不渲染（零噪音）；每条 = 状态点 + 一句话 + 直达按钮（复用 openReview / resolve-conflict intent）。数据管道：TerminalPage 的 run-overview inputs 镜像进 store（`terminalRunInputs`，不新增轮询），跳转走一次性 `focusTabReq`（终端页可见时消费 → activateTab；已关闭标签静默忽略） |
| v3.40 | 键盘流与唤回闭环（第一性原理建议③④⑤落地）：**⌘K 命令面板**（`CommandPalette.tsx` 浮层 + `command-palette.ts` 过滤纯逻辑，命令 = 七页跳转 / 七主题切换 / 侧栏显隐；↑↓+Enter+Esc）；**⌘1–⌘7 页切**（顺序同侧栏分层）；**⌘\\ 执行态隐藏侧栏**（store `chromeHidden`，session 级不持久化；⌘K 与 xterm 无冲突——清屏是模拟器键位本应用未实现，⌘F 已被终端搜索占用）。**通知唤回闭环**：注册 `ccode.attention` 通知动作类型（「去处理」按钮），`onAction` → 聚焦窗口 + 回首页收件箱；macOS 横幅样式不显按钮（系统设置决定），正文点击走系统默认激活，收件箱双通道接住。主题清单抽 `src/themes.ts` 单一出处（设置页/命令面板共用） |
| v3.41 | **快捷键自定义**（设置页「快捷键」分区）：命令面板/隐藏侧栏两个绑定支持点击录制新组合键（`hotkeys.ts` 组合串纯逻辑："mod+shift+key"，mod=⌘/Ctrl，空串=禁用，冲突拒绝），⌘1–⌘7 页切整组开关；三个字段入 settings.rs（hotkeyPalette/hotkeyHideChrome/hotkeyPageSwitch，patch 语义 Some 覆盖含空串）。**通知直达**（补 v3.40 的半步）：通知 extra 携带 tabId/cwd/kind，onAction 分级路由——已完成且 cwd 命中任务工作区（`list_workspaces` 精确比对）→ 直达评审覆盖层；待确认/其余 → 聚焦对应终端标签；无 extra → 首页收件箱。**收件箱后端直查**：外部 live 会话（无终端标签可跳）经 `session_tail_state` 直查（live 且非内部、上限 10 条），待确认条目进收件箱，点击走 `openSessionReq` 打开对话页回放——终端页未挂载不再是收件箱盲区 |
| v3.42 | **科研操作流去摩擦批**（第一性原理走查后用户拍板全做，六件）：①产物微循环——步骤产物面板升级**核验清单**（✓/— + mtime + 10 分钟「刚更新」+ 手动刷新不轮询），md/PDF 选段浮动条加「↵ 直接发送」（pty_write 一次拼接 \r）；②**沉淀为技能**——选段「✦ 沉淀为技能」→ `ai_distill_skill`（脱敏+8KB+JSON 容错）→ 技能页新建弹窗预填（`skillDraftReq` 一次性请求）；③结构归位——收件箱上提**横跨两栏**（全局事项不嵌单项目详情栏），终端左栏两段化（删「打开的标签」区，「最近项目」收进搜索行 ⌄ 浮层）；④启动栏模型改 **combo-box**（可输可选，`ccode.modelHistory.<agent>` 历史上限 10，「新增模型」概念消失）；⑤对话筛选 chip 行并入「分类筛选」行尾（当前口径 + × 同行）；⑥**评审合并成功一键开下一步**——开步链路抽 `src/pipeline-start.ts` 单一出处（renderTaskMd/startPipelineStep/buildWorkspaceTerminalRequest），合并成功横幅挂「▶ 开始下一步」（下一步 = 当前步按 workspaceName 命中后第一个无同名工作区的步骤；合并并归档成功即关覆盖层不出入口） |
| v3.43 | **16 条走查批**（用户逐条反馈）：①侧栏自动收展删除（收展全手动）；②统计归入「能力」组、底部只留设置，组标题 11px；③侧栏品牌/图标尺寸随宽度优化；④胶囊/菜单重复入口去重（终端/评审只留任务行，产物只留胶囊按钮）；⑤端口区分本应用/系统其他两段 + 外部进程终止二次确认；⑥ok 绿改深色兼容哑光绿 #4cc38a；⑦「已合并」改行内小字状态；⑧状态点全局统一 size-2；⑨左栏 « 收起态删除；⑩修 chromeHidden 下专注渲染失败（portal 机制随专注收敛整体删除）；⑪专注内容遮罩去模糊；⑫专注收敛为「专注终端/专注内容」双模式 + Esc 退出；⑬筛选选中不再自动收起面板；⑭profile ⋯ 菜单「复制到其他 agent…」（后端 `copy_profile_to_agent` 密钥不出站，同协议族校验，双份口径前端禁用/后端强制）；⑮GitHub 导入技能自动分类（默认仓库名）+ 来源列可点跳原地址（plugin-opener）；⑯修快捷键录制（WKWebView 点击 button 不给焦点 → 改 window capture 监听 + `captureDecision` 纯逻辑） |
| v3.44 | **五件走查批**：①流水线 strip 收敛（删列间 → 箭头、待开始列也渲染灰点状态补齐五列结构、⚠ 提示改 strip 右上角浮贴不独占行）；②修专注内容"终端黑了"（遮罩 bg-black/50→25 且不遮顶部标签条）；③对话筛选：浏览筛选不收起、**选中具体会话才自动收起**；④技能列表加「分类」列、技能列只显名称（描述收进详情面板）；⑤**主题系统扩容**：七套深色文本对比度按阅读上调一档 + **新增七套对应浅色**（方向翻转配方：rail 略暗于 canvas、面板向白浮起、cta 加深保对比；Catppuccin 浅色直接用官方 Latte、shadcn 用官方浅色骨架；白色半透明 hover/缩进线/滚动条在浅色下统一翻转为黑色半透明；Monaco editor-* 令牌与 xterm bg/fg 表同步补齐；主题清单 themes.ts/settings.rs KNOWN_THEMES/XTERM_BG_FG 三处同步）。「浅色模式否决」就此作废 |
| v3.45 | **流水线胶囊状态分层 + 产物入口搬家**（用户明确规格）：胶囊只突出当前步骤，全部状态文字（已完成/进行中/待开始）从胶囊撤下——已完成/已合并 = ✓ + 步骤名；当前步骤（进行中/待评审/阻塞/已归档待恢复）= cta 描边高亮 + 第二行按状态展开动作（待评审无动作显示「到下方任务行操作」小字）；未开始 = 编号 + 名称降对比，「开始」hover/focus 才现；步骤 ⋯ 收胶囊右上角 hover 才现；进度段不动。产物核验清单从胶囊移到**任务行行内手风琴**（抽共享组件 `ArtifactChecklist.tsx`，步骤按 workspaceName 反查 project.toml；已合并行保留入口读项目根/main，其余读工作树；打开拉取一次 + 手动 ⟳ 刷新语义不变；展开态按工作区 id 记忆、切项目清空）。开步/评审/合并逻辑零改动 |
| v3.46 | **流水线大圆步进器**（取代 v3.45 胶囊分层与进度段）：名称带与步进器带两个同列网格；虚线为**真实 flex 块节律**（`StepperCell`：5px 块 + 5px 间隙全是真实元素，块数按列宽 ResizeObserver 现算，与圆心同轴、跨列连续，永无渐变相位残段/双块）；**大圆 24px 纯色实心（内无字符）= 状态色 + 唯一主推进点击**（done=ok、进行中/checking=cta pulse、待评审=cta-pill、阻塞=warn、pending=实心灰；点击按状态 startStep / 恢复归档 / 跳终端——进行中/待评审/阻塞圆均跳终端 / done 开主仓 shell 终端，状态与目录/agent/profile 收进悬浮 title）；**圆前/圆后小方块 = 节律中的普通虚线块 + 28px 透明热区**，视觉混在虚线里、hover/focus 提亮才现——圆前 = 打开流水线编辑器并定位该步骤卡片（聚焦简报框），圆后 = strip 下方就地展开 ArtifactChecklist 产物手风琴（root 口径同任务行：done 读项目根、其余读工作树、无工作区禁用）；解决冲突/评审/合并仍归下方任务行，步进器不再放第二行动作 |
| v3.47 | 走查零碎批 + 按功能 AI 配置：技能页三修（来源列显示 owner/repo[/subdir] 具体地址并可点跳原地址；详情面板只钉名称行、其余随内容滚动——修"上半部分被挡住"；SKILL.md「◈ 翻译为中文」复用 ai_prompt 一次性调用、译文随会话缓存不写库）；课题主题从悬浮提示改为项目头常驻小字（悬浮只放补充信息的规则确立）；配置页模型列全量展示（`·` 连排）；工作区项目栏右键菜单（重命名/复制路径/移除注册）+ rail 底部占位删除（添加入口收进栏头 + 钮）；**内置 AI 按功能独立配 profile**（`settings.aiProfiles` map：commit/summarize/pr/distill/conflict/translate 六键，解析顺序 显式 > 功能专属 > 全局专用 > 最近使用，专属失效回落）——动因：翻译等轻任务落到大模型太慢；**步进器完成色独立为 `--color-done`**（14 主题各配低饱和绿，与 ok 状态绿解耦，用户反馈亮绿突兀） |
| v3.48 | **长时工作色彩校准**（用户反馈沉浸黑实为墨蓝、不适合长时间编码/阅读）：默认主题去蓝化——基底从深蓝黑改暖中性炭黑（rail #0a0b0e/canvas #101218），文字从冷白灰蓝改暖纸白（l1 #e9e6e2/l2 #bdbab4），folder/tabline/editor 面同步去蓝；shadcn 深色同步减蓝；midnight-light canvas 调暖（#f4f4f1）；xterm midnight bg/fg 跟随。原则：不纯黑、低蓝光、文字不刺眼 |
| v3.49 | **macOS 对话框与关窗链路收口**：wry 0.55 的 WKWebView 未实现原生 JS `confirm/alert/prompt` 委托，确认、提示与输入一律使用应用内组件，禁再引入原生 JS 对话框；全局 promise 版 `ConfirmDialog.tsx` 宿主挂 App 根部，覆盖普通页面与全屏评审层。终端 `onCloseRequested` 仍只对存活 Agent 统一确认，但 Tauri 前端封装会调用 `window.destroy()`，确认后还会调用 `window.close()`，因此主窗口 capability 必须同时保留 `core:window:allow-destroy` 与 `core:window:allow-close`，否则进入终端页挂载监听后无法退出 |
| v3.50 | **Release 触发去重**：SSH:443 的 tag push 是否自动触发 Actions 以 GitHub 实际 run 为准，不再假定 deploy key 一定不触发；推 tag 后先检查对应 SHA/tag 的 push run，存在则复用，30 秒内不存在才手动 workflow_dispatch。两个入口不得并行打包同一 tag，避免 tauri-action 竞争创建或上传同一个 Release |
| v3.51 | **Windows 闪窗修复 + 一键诊断包**：正式版无父控制台时，终端页 Git 状态轮询会让每个 `git.exe` 创建 `conhost.exe`，开发版因继承控制台而无法复现；所有非交互后台命令统一经 `process.rs` 加 `CREATE_NO_WINDOW`，外部终端保持可见。设置页诊断升级为 ZIP 支持包：系统/WebView2/GPU/WebGL、语言/输入法、功能开关、应用日志和有界进程生命周期；不采集环境变量，参数与日志 Rust 层脱敏，系统级只额外观察 CTF/TextInputHost。后台命令包装与 250ms 扫描由 `cfg(windows)` 隔离，macOS/Linux 继续使用标准 `Command` 且无监控线程。 |
| v3.52 | **诊断包驱动的收尾修复**（Windows 现场包 `ccode-diagnostics-2026-08-09` 离线分析结论）：① git 仓库探测风暴——改动面板 8s×挂载标签轮询使非仓库 cwd 每轮真 spawn git（实测 85 秒 73 次同目录 `rev-parse`），`git_info::probe_is_work_tree` 增加 30s 负缓存（只缓存否定结果，init 后主动失效）；② `list_repos` home 排除被 `canonicalize` 的 `\\?\` 前缀绕过，home 改同口径规范化后再比；③ WebGL 探针「renderer 不明保守回退」收窄为仅 Windows，避免 WKWebView 屏蔽 debug renderer 信息时误伤 macOS WebGL 渲染。spawn-hook/扫描辅助函数全部 `cfg(windows)` 门控，非 Windows 构建零警告。 |
| v3.53 | **技能一键应用更新**（§6.13 收尾）：`apply_skill_update` 按安装时记录的 repo/ref/subdir 重下 zipball，`import_zip_impl` 新增 `only` 过滤保证只覆盖同名技能（同仓库其他技能不新增不覆盖），复用覆盖+备份路径并刷新 revision 基线；下载循环与版本回写抽为 `download_github_zipball`/`record_github_revision` 供导入与更新共用。上游改名/移动时明确报错引导手动重新导入。前端在详情面板「GitHub 可更新」旁与行 ⋯ 菜单各加一处一键入口，确认走 confirmDialog。 |
| v3.54 | **步进器信息可达性 + 原生控件主题同步**：① 大圆悬浮信息从原生 title 改应用内 tooltip（`useHoverTip`/`HoverTip`：fixed 定位、横向钳制、滚动/缩放/点击即关，事件挂包裹 span 禁用态可用）——原生 title 在 WKWebView 不渲染或残留串到相邻控件；圆与小方块统一，禁回退原生 title。② 大圆右上角注意力角标（待确认=warn/已完成=done，confirm 优先），只读消费 `terminalRunInputs` 镜像不新增轮询。③ 切主题同步原生窗口外观（`applyTheme` → `setTheme`），修复深色主题下原生 `<select>` 弹出系统浅色列表；capabilities 加 `core:window:allow-set-theme`。 |
| v3.55 | **官方账号检测不再把 API Key 模式算成「已连接」**：codex `auth.json` 顶层 `OPENAI_API_KEY` 从凭证字段表移除，改由 `OfficialAccountSpec.api_key_fields` 单独识别——官方 `--api-key` 与第三方中转（cc-switch 等）写出的文件形状相同，无法区分，状态行如实显示「API Key 配置，不是官方账号登录」（`AuthProbe::ApiKeyMode`，优先级在损坏之下、未识别之上）。同批：**脉冲动画有界化**——新增 `animate-pulse-brief`（App.css，3 周期≈6s 后静止，状态复归重播），步进器进行中圆与项目区工作区状态点从无限 `animate-pulse` 换用；骨架屏等加载态保持无限脉冲不变。 |
| v3.56 | **MCP server 统一清单与分发**（matrix §10 调研落地，§6.15）：新增第八页 MCP（⌘6，能力组技能与统计之间）——统一清单 + 按 agent 开关直写八家用户级配置（读-改-写一个键/段 + 备份 + 原子写 + 读回校验）；codex 走 TOML、四家 JSONC 容错读、密钥引用转各家间接引用字段不落明文；不用各家 CLI 的 mcp 命令分发（语义不一且 codex add 有 OAuth 弹窗副作用）；server 名取交集禁下划线。同批：自定义定价改表格编辑（pricing.json 格式与后端校验不变，存量 `_rate` 保留）；技能分类存量批量回填（`backfill_skill_categories`，GitHub 来源无分类补仓库名）；技能页未分类组固定沉底。 |
| v3.57 | **提炼接力（◈ AI 蒸馏简报续作）**：补 resume（全量上下文带回，长会话污染）与 v3.15 快速简报（仅尾窗摘录）之间的空档——`build_session_digest` 读全会话文本（DTO 层已脱敏，`cap_text_middle` 24KB）经无头 AI（新功能键 `digest`，进设置页按功能 AI 配置）蒸馏成结构化简报（任务目标/关键决策/已完改动/状态待办/下一步/环境约束），AI 输出再过 `redact_and_cap` 落盘 `.ccode/handoff-<时间>.md`；失败行内报错可重试，不免 AI 静默降级。消费三路径：内部同 Agent 新会话（DigestPicker 目标列表来源 agent 置顶，不走 resume）/ 内部跨 Agent（复用接力链登记）/ 外部（`digest_command_line` 按注册表 prompt_inject 拼「新会话 + 读简报首条指令」——**非 resume**，⧉ 复制命令 / ⇗ 外部终端；kimi/opencode 无注入参数复制指令文本手动发送）。入口：对话页回放头部「恢复 ▾」与行内 ⋯、终端标签 ⋯ 与状态条 ⋯。 |
| v3.58 | **页切快捷键逐页可自定义**（取代 v3.41 的整组开关单控）：页切清单抽 `hotkeys.ts` `PAGE_HOTKEY_DEFS` 单一出处（id/名称/默认 mod+1..8，App.tsx 全局监听与设置页录制 UI 同源）；settings.json 新增 `hotkeyPages` map（键 = 页面 id，缺省回落默认，整图覆盖同 ai_profiles 口径），整组总开关 `hotkeyPageSwitch` 保留。`captureDecision` 冲突判定从单一冲突方改为多冲突方数组（八页切 + 面板 + 侧栏互判）。 |
| v3.59 | **收件箱顶部悬浮化 + 按项目摊开 + 侧栏徽标 + done 态文案纠偏**（用户三连反馈："N 条事项把工作区页顶下去"、"没看到收件箱在哪"、"只是回合结束就提示已完成"）：① 收件箱改**顶部悬浮 pill**（absolute 覆盖不占布局，pill 带总数 + 分类摘要「2 冲突 · 1 待确认」，点按向下展开明细浮层，遮罩/Esc 收起，为空不渲染）；② 导航行「待处理」扩到收件箱全口径（`run-overview.ts attributeToProject` 纯逻辑：分隔符归一 + 段边界防 /repo/a2 误中 /repo/a，嵌套根取最长）；③ 条目数镜像进 store（`inboxCount`，WorkspacesPage 唯一写入方），侧栏「工作区」图标挂 warn 色计数徽标（复用终端运行数徽标模式，任意页面可见、有事才出现）；④ **注意力 done 态用户面文案从「已完成」改「已回复」**（收件箱/标签悬浮/通知正文/步进器角标/设置页）——尾部推断只能看到「回合结束等你输入」，看不到任务完成，文案必须如实。三层分工：徽标报数 → 悬浮收件箱列事 → 导航行给分布。走查续批（用户五连反馈）：⑤ 步进器大圆「已回复」绿点角标移除（每回合结束都亮，噪音大于信号），只留待确认黄点；⑥ 侧栏徽标三轮后**全删**（数字胶囊突兀 → 圆点与项目行状态点撞语义 → 裸数字仍嫌吵；用户拍板三平台一个不留，计数只留悬浮 title 与标题栏胶囊/页内 strip），nav 保留 overflow-x-hidden 兜底；⑦ MCP 页 PageFrame standard→wide 对齐技能页；⑧ 收件箱悬浮 pill 遮挡内容被否决 → **文档流单行 strip（32px）+ 展开明细悬浮下拉**（不推布局不遮挡）；⑨ **macOS 收件箱收进自绘标题栏**（用户要 Ghostty 式：`titleBarStyle: Overlay` + `hiddenTitle`，App.tsx 渲染 40px 拖拽区 + 窗口标题 + 标题后收件箱胶囊/下拉；条目改可序列化 `InboxItem` 镜像进 store，`runInboxAction` 统一派发；capabilities 加 `core:window:allow-title`；⌘\ 执行态随 chrome 一起隐藏）。Windows/Linux 保留原生标题栏 + 页内 strip（Overlay 仅 macOS 生效，功能不裁剪、仅 chrome 集成随平台能力）。 |
| v3.62 | **任务卡层：对话的文件夹 + 定稿简报的收集夹**（核心哲学：对话是日志、简报是记忆，卡片是两者的容器）——卡片挂在项目 `.ccode/project.toml` 旁（projects.rs task_cards，写操作过 `ensure_task_project_root` 门槛，list 对非项目返回空表），可挂流水线步骤；**无独立状态机**（卡片自身没有任何状态，进度仍从绑定工作区/会话派生），不碰工作区与评审流程。会话归置存 `session_meta.task_id`（`assign_session_task`，删卡自动清归置，SessionMetaDto 回填 taskName/taskId）。**简报与 TASK.md 的分工**：步骤简报是合同（做什么、交付什么，写死在模板/档案卡），定稿简报是进度与思想快照（做到哪、为什么这么决策）；TASK.md 不预存——开步时三来源现拼（步骤简报 + 项目资源/提货单 + 卡片最新定稿简报全文，`startPipelineStep` 加可选 `briefPath`，读取走 `read_file_preview` 根约束、best-effort 不阻断开步）。**提炼简报升级八段**（原六段 + 思路与理由 + 已否决方向，用户消息原文锚定防 AI 自由发挥），且 DigestPicker 变两段（定稿页 → 发送页）：AI 初稿进可编辑文本框，**人工定稿后才落盘钉卡**（`save_task_brief` → `.ccode/brief-<时间>.md`；定稿简报是项目文档，不走 handoff-*.md 的 gitignore 规则；发送一律用定稿路径 `digestJob.finalized`，AI 初稿留盘不再用；「暂不发送」= 仅定稿落盘钉卡）。工作区页步进器下方新增卡片区（`TaskCardsSection`，按步骤分桶、失效步骤并入「未挂步骤」桶）：「开工」= 开步链路注入最新定稿简报，「继续」= pendingTerminal 预填「阅读简报并继续任务」（kimi/opencode 无注入由 promptDropped 既有处理兜底）。对话页项目筛选下**从按步骤分组升级为按卡分组**（「未归置」恒最前，同原「无工作区会话排最前」口径），meta 行「▤ 卡片名」chip 经一次性 `selectProjectReq` 跳工作区页，⋯「移到卡片…」仅项目筛选下出现。**评审「沉淀到下一步」**：合并成功横幅旁次级入口，评审结论 → 下一步步骤首张卡片（无则以步骤名 `create_task_card`）→ `save_task_brief` 钉入，供下次开工/继续注入。前端纯逻辑集中 `src/task-cards.ts`（分桶/排序/分组/简报时间解析，tests 同步），store 按项目根缓存 `taskCards`、删卡/归置顺带刷新会话列表。 |
| v3.63 | **评审可信度证据 + 上游漂移提醒 + 沉淀触点统一**：① 评审覆盖层顶部新增「可信度」行——`check_citation_health`（新模块 citation.rs，纯 Rust 无 AI）扫工作树 .md 的 Quarto/Pandoc 引用键（`[@key]`/`[@k1; @k2]`/`[-@key]`，保守口径：项必须以 `[-]@key` 起头，带前缀的 `[cf. @k]` 不收）对照 references.bib（根目录优先、其次 `manuscript/`），同行附「产物 X/Y 已产出」摘要（复用 ArtifactChecklist 的 list_dir 定位机制，不另造请求）；路径白名单同 pdf.rs（注册项目根 + 工作区工作树/主仓，canonicalize 后判定）；无 bib/全文无引用/无预期产物时不渲染，进评审一次性读取不轮询，失败静默降级。② **上游漂移提醒（启发式非硬状态）**：`stale_upstream_for` 纯逻辑——步骤 k 的任一上游步骤（序号更小，按 project.toml steps[].workspace_name 绑定工作区）晚于本步「最后推进时间」（已合并取 merged_at、未合并取 created_at；均为 now_iso 定宽 UTC 串，字典序即时间序）发生合并 → WorkspaceDto 附 `staleUpstream`（最晚合并的上游步骤名，仅 list_workspaces 计算）；本步再次合并后 merged_at 推进、自然恢复新鲜，无需额外状态位。前端三处同文案警告色提醒（步进器悬浮卡/任务行状态详情/评审覆盖层顶部），只提醒不阻断。③ **定稿触点统一为「AI 起草 → 人定稿 → 落盘钉卡」**：评审「沉淀到下一步」编辑区加「◈ AI 起草」（`ai_distill_review`，上下文 = 本步提交清单 + diff numstat + TASK.md 全文，**功能键复用 `digest`** 不新增设置项，设置页该行标签改「提炼接力 / 评审沉淀」），输出过 `redact_sensitive_text` 返回、落盘仍走 save_task_brief 的 redact_and_cap 兜底；失败行内报错可重试，不静默降级。沉淀编辑区说明行与 DigestPicker 定稿页措辞统一（「AI 初稿，改完定稿后才会落盘」）。 |
| v3.64 | **开工确认弹层（「开工」改两步：点开工 → 确认弹层 → 确认开工）**：统一承载三诉求——① TASK.md 全文预览（所见即所得：弹层预览与实际落盘共用 `pipeline-start.ts` 的 `renderTaskMd`/新抽取的 `gatherTaskMdExtras`+`readTaskBriefs`，禁复制拼装逻辑；只读 mono 预览）；② 多卡简报融入——本步骤含简报的卡片逐个勾选（纯逻辑 `briefSourcesForStep`/`defaultCheckedSources`/`checkedBriefRefs` 进 task-cards.ts），`renderTaskMd` 的 `finalBrief` 参数改 `briefs: TaskBriefInput[]`（单份直排、多份按卡片名分小节），`startPipelineStep` 的 `briefPath` 改 `briefs: TaskBriefRef[]`；勾选 ≥2 张出现「◈ 融合所选简报」→ 新 command `ai_fuse_briefs`（逐份 canonicalize 根校验 + 每份 8KB/总量 24KB cap，**功能键复用 `digest`**，prompt 要求保留各来源关键决策/思路理由/已否决方向、冲突显式呈现不擅自裁决、末尾注明融合来源）→ 弹层内定稿态（与 DigestPicker/评审沉淀同一措辞）→ `save_task_brief` 钉目标卡（默认出处卡，可换卡或新建）→ TASK.md 改用融合简报；③ 主仓改动协同——弹层顶部与卡片区标题行各一条警告色提醒「主仓 N 个未提交改动」（复用 `git_status`，进项目详情读一次 + 弹层打开刷新，不轮询；非 git 不渲染；**只提醒不阻断**，想法期实验性改动留主仓合法），卡片区提醒点击经 `PendingTerminal.rightTab: "git"` 一次性交接直达终端页改动面板。入口口径：弹层只挂步进器大圆与卡片「开工」两处；评审「开始下一步」保留直开（连续流，简报已沉淀到下一步卡）；「继续」不经弹层。 |
| v3.65 | **项目移除加中间档「清除 Ccode 痕迹（保留文件夹）」**（用户原话：只保留没建项目时的文件夹，其余都删掉）——新 command `purge_project_traces`（projects.rs，结构仿 delete_project_dir_impl）：canonicalize + `guard_project_dir` 防护复用 → `delete_workspaces_for_repo` 清全部工作区（worktree/分支彻底删，同删除项目目录口径）→ `.ccode/` 走 `trash::delete` 系统回收站（可反悔）→ `remove_project_at` 摘注册（未注册容忍）；三者皆无报「没有 Ccode 痕迹」。**不自动 git rm/提交**（自动提交用户仓库违反既有纪律）：.ccode 若被跟踪过，删除显在改动面板由用户自行提交，后端摘要与前端确认框均提示。前端：项目导航右键菜单在「移除注册」与「删除项目目录…」之间加红色项，确认框写清三档命运（文件夹与用户文件保留 / .ccode 入回收站 / 工作区与注册彻底删）；至此三档 = 移除注册（只摘登记）/ 清除痕迹（回未建项目状态）/ 删除目录（连文件夹入回收站）。 |
| v3.66 | **开工确认弹层实测修复批（四件）**：① 勾选区来源范围 bug——`briefSourcesForStep` 原只按 `card.step === stepName` 精确匹配，未挂步骤卡（step=null）与步骤改名后失效的卡永远落选，且来源为空时整个区域不渲染；修复：范围 = 本步骤卡 + 未挂步骤/失效步骤卡（与 bucketCardsByStep 的「未挂步骤」桶同口径），空来源也渲染引导语「还没有定稿简报——对话页 ◈ 提炼接力定稿后会自动钉到卡片」。② 步骤级只读预览：任务卡桶头部「预览 TASK.md」（无卡无工作区也可预览），走 `buildTaskMdPreview`（gatherTaskMdExtras + readTaskBriefs + renderTaskMd 同一出处）。③ **想法期只读保护（软硬两道 + 可切换）**：软 = 聊想法预填指令带「只讨论不动文件」约束；硬 = `AgentSpec.readonly_args` 注册表 + `agents::readonly_launch_args`（codex 剔除 `-s workspace-write` 再追加 `-s read-only`，重复 -s 生效顺序未文档化不赌）→ `PendingTerminal.readonly` → pty_spawn 注入（仅全新会话）。支持矩阵（2026-08-12 本机 --help 实测，录入 matrix 跨 agent 共性结论 §6）：claude/codebuddy `--permission-mode plan`、codex `-s read-only`、gemini `--approval-mode plan`、kimi/cursor `--plan` 为硬保护，qwen 0.21.1 与 opencode 只有软约束。**用户拍板不焊死**：settings.json `discussReadonly`（默认开）由卡片区标题行就地开关（设置页不加行），卡片 ⋯「聊想法（允许改文件）」为单次豁免（开关关时不渲染）。④ **TASK.md 从拼接升级为融合**：弹层预览区改可编辑（状态机 `taskMdEditorReduce`，dirty 后重拼不覆盖人编辑/融合稿，可「恢复默认拼装」），「◈ 融合为连贯 TASK.md」→ `ai_fuse_task_md`（模板简报为主干、卡片思想融入对应段落、去重复与过程性描述、已否决方向保留为约束、冲突显式列出、提货单段由 Rust 按 renderTaskMd 同款格式渲染并要求 AI 逐字照抄到结尾；功能键复用 digest，脱敏不落盘）→ 确认开工落盘 = 编辑区最终内容（`startPipelineStep.taskMdOverride`，写盘仍 write_workspace_task_md 单一路径）。 |
| v3.67 | **文献检索第二层（人肉中转）+ 步骤技能区前置到预览界面**：① lit-search 技能扩写（include_str! 内嵌种子，只影响新播种不覆盖用户副本）——「外部 AI 检索站导出导入」节（Elicit/Undermind/X-MOL/Scholar 网页端导出 RIS/BibTeX/CSV → `papers/imports/`（来源-日期命名）→ Agent 解析去重合并进 screening.md 与 references.bib，DOI 优先标题模糊兜底，保留来源标注，原档备查不删）+「带 key 的 API 检索」节（WoS `$WOS_API_KEY`、Consensus `$CONSENSUS_API_KEY`、Scholar 走 OpenAlex/S2 替代或 SerpAPI `$SERPAPI_KEY`，curl 示例 key 全走环境变量）。② **MCP 预设不造机制**：MCP 页无预设/模板机制，不为三个条目新建预设系统——推荐配置（Consensus hosted MCP `https://mcp.consensus.app/mcp`（实测 401 鉴权在，HTTP 传输，以官方文档为准）+ Playwright `npx @playwright/mcp@latest`（官方仓库核实））写进 lit-search 技能「推荐 MCP」节，用户去 MCP 页走既有粘贴导入（含安全清单确认）；Semantic Scholar 无权威社区 MCP 不加，用官方 REST API 替代。③ **步骤技能区进预览界面**：`StepSkillsChips` 共享组件——步骤级「预览 TASK.md」弹层只读（chip 点击展开一句话描述），开工确认弹层可编辑（× 移除 + ＋ 下拉添加）；增删经新 command `update_step_skills(project_root, step_name, skills)`（项目门槛 + 步骤存在校验 + 读-改-原子写 project.toml，不走整份 write_project_config 往返）**写回步骤定义**（影响以后所有开工），成功后重读档案卡同步弹层与父级 cfg，TASK.md 预览即时联动。 |

| v3.68 | **人工事项（人机分工清单）+ agent 人工请求 + 收件箱分类胶囊**：① 步骤获一等属性 `[[steps.human_tasks]]`（title/guidance/target/timing=before·during·after），引擎不识语义（科研语义只进模板），编辑唯一入口 PipelineEditor，五套内置模板补齐声明（guidance 只告知渠道选项不替用户选择）。**状态派生无状态机**：done = 手动勾选（app.db `human_task_checks`，行在=人勾了）|| 落点检测（`human_target_hit`：目录递归限量/「目录/通配」末段通配/精确文件；检测根 = 项目根 + 绑定工作区工作树），**手动优先**——勾了系统不再追问，取消删行回到检测口径。提交交付 = `import_human_deliverable`（复制进落点 + best-effort 登记提货单 produced_by=人工交付，登记失败不否决复制），入口 = 卡片 checklist 行「提交产物」/ 拖拽文件到行。三触点告知全部只提醒不阻断：开工弹层人工事项区（before 档未完成警告色提示仍要开始也可以）、卡片行 badge「N 件事等你做」+ 展开 checklist（共享 `HumanTasksList`）、评审可信度行「收尾事项 N 件待做」（仅 after 档）。② **agent 动态人工请求**：约定文件 `.ccode/help-wanted.md`（工作树/主仓），每条必带兜底句「若未回复则按 ×× 继续」，**统一非阻断**（否决阻断式请求——agent 写完按兜底继续，偏差靠评审兜底）；`list_help_requests` 扫活跃工作区 + 主仓 → 收件箱「人工请求」类（可 ✕ dismiss，localStorage 签名口径，内容变自动复现；新来源 edge-trigger + 30s 去抖 OS 通知，复用「长任务 OS 通知」开关不新增设置项）；TASK.md 在步骤有人工事项时自动带该约定说明。③ **收件箱分类胶囊**：单一「待你处理 N」拆为按类别胶囊（点胶囊展开该类条目），类别推导/分组纯逻辑 `src/inbox.ts`（key 前缀即类别，未知前缀回落待确认防静默丢失）。④ **待拍板问题零新存储**：简报 `## 待拍板` 小节在卡片展开态渲染成列表（`extractOpenQuestions`），点了带问题去聊想法（沿用只读保护）；讨论在终端、结论靠提炼定稿钉卡，卡片只做索引。演示课题第一步预置两条人工事项（补充已知文献 before / 下载付费墙文献 after）。**否决项**：卡片不内置产物清单（ArtifactChecklist 已有，不重复造）；不内嵌浏览器/不做文献库（v3.9 口径延续）；人工事项不给独立状态机。 |


| v3.69 | **人工事项迁到步骤级 + 讨论种子 + 当前步骤条**（v3.68 上线后用户走查修正「乱」）：① **人工事项是步骤级不是卡片级**——卡片是想法容器，一步多卡时步骤级清单在每张卡重复渲染属挂错层；卡片展开与卡片行 badge 中的人工事项全部移除，步骤级唯一展示位 = 步骤 ⋯「人工事项（N 件待做）」展开的 strip 下手风琴（与产物核验同位单开，共享 `HumanTasksList`）；开工弹层与评审收尾提醒两触点保留不动。卡片回归纯净：展开只剩待拍板 + 简报。② **讨论种子（`discussion_seeds`）**——「卡片里聊什么不该靠用户凭空想」：模板按步骤预置开工前建议想清楚的拍板点（与人工事项分工 = 种子「要商量的」/ 人工事项「要动手做的」），卡片区步骤桶内「开工前聊聊：」chips 点击即聊（以问题为名自动建卡、同名续聊、只读保护照走），手动「＋ 添加想法」保留为种子覆盖不到的口子；纯执行步骤不给种子；种子不进 TASK.md（给人的入口，不是给 agent 的合同）。③ **当前步骤条**（步进器下方一行）=「现在该干嘛」的单一答案：第一个未完成步骤的白话状态 + 「等你做 N 件」（点击展开人工事项）+ 唯一主按钮（待开始=开始 / 待评审=去评审 / 阻塞=去处理冲突 / 进行中=去终端；评审类直达评审覆盖层不绕终端）；全部完成则不渲染，保持安静。演示课题第一步预置 3 条种子 + 既有 2 条人工事项。 |

| v3.70 | **大圆 = 步骤聚焦（删终端入口）+ 顺序引导情境化**（用户走查拍板：圆的跳终端/开步语义删除，界面信息按步骤收敛）：① 点大圆 = 卡片区只看该步骤（种子 + 卡片 + 人工事项清单一屏内），选中圆中性高亮环，未选过默认聚焦当前步骤，「显示全部步骤」还原；推进动作归位——开步=当前步骤条/卡片行「开始」，跳终端=当前步骤条「去终端」/任务行，恢复已归档=任务行；步骤 ⋯「人工事项」从 strip 下手风琴改为同效聚焦入口。② 当前步骤条情境化（顺序引导 A 案）：待开始按本步骤是否有定稿简报分「建议先点下方种子聊聊」/「想法已就位，可以开始」；应用模板成功给一次性引导带（可关，组件态不持久化）指向第 1 步种子。③ 术语：界面与用户手册「流水线」→「研究流程」（科研视角），代码标识符与开发文档沿用 pipeline——映射说明见 conventions/pipeline.md 文头；课题主题两入口（注册弹窗/模板区）合一：模板区回显同一字段，消除"第三样东西"错觉。 |

| v3.71 | **步骤内协同流程线（StepFlow）**：用户直指「元素堆一块、没有可视化流程」——聚焦视图顶部新增有序节点链：讨论种子 → before 人工事项 → agent 执行 → during 人工事项（并行段）→ after 人工事项 → 评审合并；当前节点 = 第一个未完成（高亮 + 就地操作区：种子 chips/提交产物/开始/去终端/去评审），回答「谁先谁后、轮到谁、在哪操作」。纯逻辑 `src/step-flow.ts`（buildStepFlow；runStatus 四态由 ProjectGroup 从 deriveStepStatus 映射，blocked 并入 review）；人工事项状态/勾选/交付/拖拽逻辑抽 `useHumanTasks`（HumanTasksList 导出）供平铺清单（开工弹层）与流程线共用。时机语义按用户拍板排序：聊想法 → 补已知文献（before）→ agent 检索 → 补付费文献（after）。 |

| v3.72 | **任务书草稿：拆除「讨论→合同」中间层**（用户第一性原理追问：想法既然服务于 TASK.md，就该直接在 agent 里聊、直接改它）：每步骤一份 `.ccode/drafts/<workspace_name>.md`（项目根、随 .ccode 进 git；路径单一出处 `draft_rel_path`）。聊任务书 = 非只读启动 + 指令约束只许写草稿文件（种子点击同口径，仍建卡归档）；开工弹层草稿优先于模板拼装（编辑区初始 = 草稿，「恢复默认拼装」可回）；评审「沉淀到下一步」从钉卡改为 `append_step_draft` 追加进下一步草稿。简报/钉卡/◈ 提炼机制保留（长会话接力场景仍成立）但撤出主路径；卡片退位为纯对话归档夹。流程线 discuss 节点改名「任务书」（完成口径 = 草稿已起草 || 有定稿简报，兼容旧项目），节点内嵌「跟 Agent 聊任务书」+「预览/编辑草稿」+ 种子；agent 节点内嵌「预览 TASK.md」。 |

| v3.73 | **工作区页信息架构重组：删「当前步骤条」**（用户拍板：当前步骤被步骤条/流程线/桶头三层重复表达，「等你做 N 件」「显示全部步骤」点击无感）：① 步骤条整段删除，功能不丢——状态短语并入**聚焦头部**（步骤名 + describeStep 白话状态 + 右侧「总览全部步骤」），主推进入口并入流程线节点：开始/恢复工作区（归档时替代开始）在 agent 节点、去评审/去处理冲突（带 resolve-conflict 意图）在评审节点、去终端看看在 agent 节点进行中态。② 「等你做」从计数按钮改为**流程线 human 节点橙点**（口径仍是 `actionableHumanTasks`：after 档 agent 完成前不计；ProjectGroup 算好标题列表经 props 传入），点橙点 scrollIntoView 定位 + 1.5s 高亮。③ 「总览全部步骤」真切换：总览态桶强制展开，无卡无种子桶占位「该步骤还没开始」；聚焦态桶头去重（步骤名/预览 TASK.md 不重复，**预览 TASK.md 全页唯一入口 = agent 节点**）。④ 工作区列表跟随聚焦步骤过滤（归属 = `steps[].workspaceName` === 工作区名；ProjectGroup children 改 render prop 回传 focusStepName/steps/showAll/onToggleShowAll），标题「{步骤名} · 工作区（N）」+「全部/按步骤」切换，空态区分「该步骤还没有」与「项目还没有」。大圆步进器 strip 一行未动（硬约束）。 |

| v3.74 | **资源提醒时机 + papers/imports/ 人肉中转入口**（用户拍板：资源发现不做全局 banner，只在两个决策点出现；闭源检索站导出靠人搬）：① **开工确认弹层资源提醒**：打开弹层时 `discover_resources` 只读扫描一次，有未登记候选才在简报勾选区下方出小节（默认不勾选不打扰），「登记选中」= resources 数组整体写回 project.toml（与资源面板同一口径），成功后小节消失。② **人工交付导入后的登记追问**：交付落在项目根时提示「要登记为项目资源吗 [登记]」（工作区落点不追问——临时目录登记没意义），关掉不纠缠。③ **「导入检索结果」两入口**：StepFlow 落点在 `papers/` 的人工节点旁 + 资源面板「发现资源」旁；`import_human_deliverable` 最小扩展（`step`/`title` 转可选 + 新增 `target_override`）：无步骤语境 = 纯导入落主仓 `papers/imports/`、不登记提货单；lit-search 协议 = agent 开工时自动解析、去重、合并进筛选清单；文件命名「来源-日期」只在 title 里提示，不强制。 |

| v3.64 | **内置技能种子机制落地**（backlog 项提前，用户拍板）：14 个内置技能（原 9 个本机技能补强 + 新内化 5 个：rebuttal-crafter 返修回复 / stats-check 统计审查 / figure-forge 投稿级出图 / slides-deck 汇报幻灯片 / proposal-writer 开题基金），内容经 16 个外部技能仓库调研后按 Ccode 工作流中文重写（MIT/Apache 源可借鉴并致谢，无许可/CC BY-NC 源只借机制不取内容）；补强点 = bib-check 可选外部元数据核验（Crossref/arXiv）、data-eda 统计结论先过 stats-check、lit-search 多库检索清单。机制见 §6.13：include_str! 内嵌 + 版本 marker 幂等播种、不覆盖用户同名技能、不复活用户已删技能。五套流水线模板按步骤挂载技能（简报同步「（按 X 技能）」口径）；技能页来源列新增「内置」标签 |

| v3.75 | **定时雷达（每日/每周自动巡检）+ lit-watch 技能升级**：① **lit-watch 多源精选化**（对照 xuezheng627/daily-literature-digest 等外部技能后补强）：检索从「arXiv API + WebSearch 兜底」升级为 arXiv/OpenAlex/Crossref 三路官方 API 确定性检索（web 仅订阅行显式声明才用、标低置信）；DOI 优先跨源去重合并；新增精选档——新命中按「标题命中 > 摘要命中 > 主题相关」排序取 Top 3–5 标「推荐」，条目相关性三档（推荐/相关/待确认）；无摘要/付费墙进 `papers/watch-followup.md` 跟进队列；订阅行备注 `+bib` 时推荐条目生成 BibTeX 追加 references.bib（替代 Zotero 的原生口径）；watchlist 来源列支持 `arxiv,openalex` 多选与窗口备注。**不抄的**：Gmail 推送（走收件箱+OS 通知）、静态 HTML 文献库（Ccode 自身即工作台）、config.json 替代 watchlist.md。② **调度器 `scheduler.rs`**：app 级 `schedules.json`（config_dir/ccode/，原子写 + 进程内锁），任务 = 项目根 + 技能 + profile（可空走自动回落）+ 每日/每周+时分（本地时区，不引 cron 表达式）；60s tick 判定 due（「最近应跑时刻 > last_run」），**启动补跑天然覆盖睡眠漏跑、多次漏跑 coalesce 只补一次**；执行复用 ai.rs 无头链路（`run_agent_task`：resolve_binary + 拉起瞬间 get_key 注入 + launch_plan + background_command），唯二差异 = cwd 用项目根（不隔离临时目录，token 归因给项目）与 `headless_task_args`（codex 用 `-s workspace-write`，只读跑不了巡检）；10 分钟超时、历史留 20 条、简报/错误出站前 redact_sensitive_text；跑完发 `scheduler-run-done` 事件 → App.tsx 全局监听弹 OS 通知（复用 notificationsEnabled 开关不新增设置项）。③ UI = 工作区页项目分组「◔ 定时任务」区块（ScheduleSection）：列表/启停/立即跑/历史/删除 + 新建弹层；**不做独立「任务中心」页**（任务必绑项目，全局页是过早抽象）。风险遗留：各家 CLI 无头模式的写权限/工具放行行为未经全量实测（matrix 无记录），qwen 无头参数为位置参数兜底——首批用户验证后按 matrix 校准。 |

| v3.76 | **内置技能更新检测 + 一键更新**（播种器「永不覆盖」的配套出口：种子后续增强时老用户库内旧副本永远拿不到更新，本批治本）：`check_builtin_skill_updates` 库内 SKILL.md 与 include_str! 种子**逐字节比对**，只提示 skills.json 里 source == "builtin" 的项（同名用户自建不算；用户在内置技能上的自改照样提示，更不换由人拍板），库目录缺失/读失败跳过（缺失归播种器管）；`apply_builtin_skill_update` 校验名在内置表 → 原文件备份为同目录 `SKILL.md.bak-<yyyymmdd>`（同日重名追加 -2/-3）→ 种子内容原子写入（复用 profiles::atomic_write）→ skills.json 描述按新文件重解析。UI = 技能页顶部提示条（PageHeader 下方，bg-inset）：列出待更新技能名 + 逐个「更新」按钮，成功移出提示条并刷新列表、失败行内报错；检测 best-effort 失败静默。 |

| v3.77 | **任务书沉淀统一走草稿：砍掉「提炼定稿 → 钉卡 → 开工勾选/融合」中间层**（v3.72 主路径切换的收尾，中间层残留整体拆除）：① 后端删 `save_task_brief`/`attach_brief_to_card`/`ai_fuse_briefs`/`ai_fuse_task_md` 四命令，TaskCardDto 去 briefs 字段；旧 project.toml 的 `briefs = [...]` 解析忽略、写回丢弃，旧 `.ccode/brief-*.md` 文件留盘不删。② 结论单一出口 = 步骤草稿 `.ccode/drafts/<步骤>.md`：种子/自定义话题/挂步骤卡片的「聊想法」全部走草稿口径（非只读、指令约束只许动草稿这一个文件）；未挂步骤卡片维持只读纯聊归档（「想法期只读保护」开关只服务这一路）。③ **开聊自动带开草稿预览**：种子/话题/「聊任务书」进终端时自动在右侧打开草稿预览（FilePreviewEditor 目录监听外部变化自动重载，agent 写入实时可见；想法期无工作树，讨论与草稿都在项目根）。④ 待拍板问题数据源从简报换草稿：`extractOpenQuestions` 从草稿文本提取「## 待拍板」，卡片展开按需读草稿，讨论指令要求 agent 把未定问题记进该小节；discuss 完成口径收为纯草稿（hasDraft）。⑤ 开工确认弹层：删简报勾选区与「◈ 融合所选简报」「◈ 融合为连贯 TASK.md」两按钮，编辑区保持草稿优先；无草稿且存在旧简报时显示一行提示 +「并入草稿」（`list_legacy_briefs` + `append_step_draft`，一次性兜底不恢复勾选区）；技能区加归处标记——SkillDto 新增 `mentionsMcp`，含「推荐 MCP」的技能显示标记并可跳 MCP 页。⑥ **DigestPicker 单页化**：AI 初稿就绪后同页「初稿编辑框 + 发送目标列表」，不再强制两段定稿；点目标直接发送（零改动用 AI 初稿 handoff-*.md；有改动先 `finalize_digest_brief` 写回——校验 `.ccode/` 内 + `handoff-` 前缀 + `redact_and_cap` + atomic_write——再发）；「暂不发送」= 有改动才落盘 + 关闭；不再有「钉入任务卡」；三条发送路径（内部新会话/⧉ 复制外部命令/⇗ 外部终端）与收件箱「待发送」胶囊不变。⑦ 卡片回归纯归档（claim 认领 + 按卡分组 + 开工入口，不再有简报 meta/简报列表），示例课题播种改播示范草稿。 |

| v3.78 | **五套内置流水线模板内容重设计 + 模板接壤 + 「从模板追加」**：① **模板内容重设计**（src/pipeline-presets.ts）：准绳 =「讨论种子 → 草稿 → TASK.md → 执行」全链相辅相成——种子逐条对准 TASK.md/执行中的真实拍板点（删空洞种子、补缺口种子；纯执行步骤不给种子，沿用 v3.69 口径）；简报坚持输入/决策/交付写死，expectedArtifacts 精确化；技能挂载按 14 个内置技能核对（research-paper 首步 +lit-notes、结果分析/毕业论文实验步 +stats-check、毕业论文初稿/定稿 +quarto-render、data-eda 步 +stats-check；submission-rebuttal 摘除不存在的假技能 pre-submission-reviewer，投稿前自查口径内联进简报）；MCP 归处——lit-search 链路步骤新增 before 人工事项「（可选）配置学术检索 MCP」（MCP 页预设导入 Consensus/Undermind，key 走环境变量引用；不配也能跑：OpenAlex/Semantic Scholar 免 key 兜底），付费墙文献全程有人工事项接应（落点 `papers/*.pdf`）。② **模板接壤**：五套 = 同一条科研流水线的相邻段，产物路径固定对齐——综述末步产 `manuscript/review-final.md`、科研论文末步产 `manuscript/paper-final.md`，投稿与返修首步输入精确指向两者 + `references.bib`；综述的 `notes/`+`references.bib` 可被科研论文/毕业论文首步复用，数据处理的 `analysis/` 可接科研论文实验段；每套模板首步简报带双口径输入说明（接自上游随仓库合并自带 / 独立启动先放入对应目录或资源面板绑定上游项目目录），投稿与返修首步另有 before 人工事项「放入成稿与 references.bib」（落点 `manuscript/`）。③ **「＋ 从模板追加」**（PipelineEditor 工具区「+ 添加步骤」旁）：区别于「使用模板 = 整体替换 steps」，把选定模板（内置五套 + 用户另存）的步骤追加到当前项目 steps 末尾——步骤链/提货单/资源机制对新步骤天然生效；后端新 command `append_pipeline_steps`（projects.rs：`ensure_task_project_root` 写门槛；读-改-原子写；name 或非空 workspace_name 重名跳过——撞已有步骤或撞本批次刚追加的都跳过，避免覆盖已有工作区绑定；全跳过不落盘、空批次拒绝；返回 `{appended, skipped}` 供行内提示「已追加 N 步；跳过 N 步（同名）」）；追加直接写盘不经编辑器未保存草稿（dirty 先弹确认），成功后前端重读 `read_project_config` 刷新步骤卡与脏检查基准（`onConfigReload` 回推父组件）。典型用法：科研论文写完 → 追加「投稿与返修」三步 → 同一项目续走。 |
| v3.79 | **技能挂载产物冲突检测**：技能内容是 markdown 指导文件，内容级「职责重叠」无法自动判定，但产物路径相撞可检测——14 个内置技能 SKILL.md frontmatter 新增 `outputs` 声明（YAML 行内/多行列表均容忍，目录带尾斜杠、文件写全路径，只声明会写的主要产物；老用户库内旧副本经既有 check_builtin_skill_updates 逐字节比对检出、走一键更新）；`parse_skill_md` 扩展解析 outputs 进 `SkillDto.outputs`（list 时现算不入库，compose_skill_md 不写——自建技能不参与）；前端纯逻辑 `src/skill-conflicts.ts`（skillOutputConflicts：两两比对，路径相同或互为目录前缀即相交，同一对技能多处相交只报一次）；StepSkillsChips 加可选 `skillLib` prop，有冲突时 chips 下方逐行 ⚠ 提示「确认步骤简报里写明了分工」——只提醒不拦截，只读/可编辑两态都显示（KickoffConfirmDialog/TaskCardsSection 两处调用方传入）。 |
| v3.80 | **接入第九个 agent Grok Build**（xAI 官方终端编码 agent，xai-org/grok-build 源码调研 2026-08，标注「待实机验证」处未经实机核对，matrix §9）：纯 env 注入三件套（`XAI_API_KEY` / `GROK_CLI_CHAT_PROXY_BASE_URL`（CLI chat 代理端点覆盖，作第三方端点注入通道**待实机验证**）/ `GROK_DEFAULT_MODEL`），归 OpenAI 兼容族（官方端点 https://api.x.ai/v1，presets 设官方预设行；`[model.*]` 的 `api_backend` 另支持 responses/messages）。官方账号 `grok login`（OAuth，凭证 `~/.grok/auth.json`，拉起 env_remove 两个 XAI key 变量；TOML 配置无冲突探测，detection_note 写明）。会话 `~/.grok/sessions/<url编码cwd>/<uuidv7>/`：`updates.jsonl` 为权威日志（ACP session/update 通知流，防御式解析跳过未知类型），`summary.json` 供 meta（info.cwd 比解码目录名可靠）；`session_search.sqlite` 只是 FTS 索引，扫描只收文件名恰为 `updates.jsonl` 的。usage 从 updates 内 `_meta.usage`（`params._meta` 与 `params.update._meta` 两层兼容探测）。聊想法只读 = `--permission-mode dontAsk --sandbox read-only`（`--permission-mode plan` 门控链路未确认不用）。headless `-p`（不读 stdin，prompt 走参数），scheduler 任务追加 `--yolo`（headless 默认权限行为未确认，防请求被 Cancelled 静默失败，照 codex `-s workspace-write` 先例）。**两个首版不做**：「设为全局默认」显式不支持（config.toml 是 `[model.<name>]` 段结构且默认模型指针机制未确认，学 cursor 落到显式报错）；MCP 只读清单不分发（`[mcp_servers.*]` TOML 段与 model/hooks 同文件属高危混合状态文件，且 grok 自带 `grok mcp add` 做读改写，不硬造 TOML 原子写管线；前端 `MCP_DISTRIBUTE_UNSUPPORTED` 显示「只读」）。技能 `~/.grok/skills` 强制 copy（未实机验证，仿 cursor，`allow_symlink_for` 改集合判断）。安装走官方脚本（`~/.grok/bin` 进 resolve_binary 三平台候选）/ npm `@xai-official/grok`，更新自更新 `grok update` 优先。matrix 重编号：MCP 调研节 §9→§10（Grok 占 §9），代码与文档全部引用同步 |
| v3.81 | **浅色主题 diff 铺底修复 + 改动面板文件类型徽标**：① diff 增删行从复用 `bg-ok/bg-err`（深底浅字 pill 口径）拆出专用令牌 `--color-diff-add-bg/fg`、`--color-diff-del-bg/fg`（App.css @theme；深色主题值不变），`[data-theme$="-light"]` 统一覆写为 GitHub 式浅底深字（add #d9f2e2/#177245、del #fbe3e6/#b02a42）——ok/err 深底整行铺在浅底上会显黑（用户反馈）。改动面板 `diffLineClass` 与审阅视图 `DiffSide` 同换新令牌（审阅行 fg 从 text-add/del 并入，深色下略有加深，口径统一）；状态字母 pill 等小块用法不动。② 改动面板文件名前加**文件类型小徽标**（`src/file-icons.ts` 纯逻辑：扩展名 → 短标签 + 固定识别色不随主题，未收录类型留空槽位对齐；GitPanel 全宽行与紧凑行均接入，tests/file-icons.test.ts） |
| v3.82 | **改动面板改跟左栏文件树的根**（用户拍板：原「跟随聚焦终端标签 cwd」口径下，工作区页点了项目但终端标签停在别处（典型：停在已归档工作区的死路径）时面板错位显示「不是 git 仓库」，心智负担大）：FileTree 新增 `onRootNavigated` 回调（nav 与 cwd 同步两个 setRoot 出口都上报，与 onRootChange 守卫配对只在真切换后触发）；TerminalPage 记 `treeRoot`，GitPanel 改吃 `treeRoot ?? activeCwd`；activeCwd 变化时 TerminalPage 主动清空 treeRoot 兜底（专注终端等树未挂载场景无人上报）。对话页签与文件预览口径不动。配套：git_status_sync 对不存在的目录先报「目录不存在（可能已被归档或删除）」（与误判「不是仓库」区分，含 Rust 测试） |
| v3.83 | **标签条变更芯片（Codex 式）+ 隐藏 GitPanel 实例保轮询**：用户诉求「不用点进改动页再保存」——标签条右侧（可合并 pill 前）新增变更芯片：`⑂ 分支 +N -M`（仅 isRepo 且有未提交改动时出现），点数字打开「改动」页签，「✓ 保存」全量快速提交（defaultCommitMessage 本地生成说明；工作区视图 paths=null，与面板留空「快速保存到历史」同口径；行内 保存中/已保存/失败 2.5s 复位）。GitPanel `onTotals` 从 `{add,del}` 扩展为 `GitSummary`（+isRepo/branch/inWorkspace/files），TerminalPage 侧按内容签名比较免空转重渲染。**关键配套**：右栏关闭/专注终端时改动面板随右栏整体卸载、8s 轮询停止，芯片会无数据——故在 TerminalPage 挂 display:none 的隐藏 GitPanel 实例持续轮询（与右栏内实例按 `(!rightOpen || focusMode)` 互斥），页签 +N 徽标顺带也变成常驻准确 |
| v3.84 | **删流程线「等你做」行内标签**（用户拍板）：human 节点旁的醒目色「等你做」标签与整条 props 链（ProjectGroup `focusHumanPending` → TaskCardsSection → StepFlow `humanPending`）连同 `actionableHumanTasks` 纯逻辑与测试一并移除。人工事项告知触点收敛为两处（开工确认弹层 / 评审可信度行「收尾事项 N 件待做」）；流程线 human 节点只保留勾选框、落点操作与「← 当前」高亮，步骤 ⋯「人工事项（N 件待做）」计数口径（`pendingHumanTasks`）不动。 |
| v3.85 | **浅色补完 + 去线条化（全站优化第 1 批）**：① **终端 ANSI 调色板深浅成对**——v3.44 上了七套浅色主题，但四套 ANSI 预设全是深色向的，`buildXtermTheme` 把它们直接铺在近白底上：`white #e5e5e5` 对比度 ≈1.05:1、`brightWhite #ffffff` 全隐形、`yellow #e5e510` ≈1.4:1，加上写死的 `cursor #aeafad`（≈1.9:1）与 `selectionBackground #264f78`（深底压深字，选中即不可读）——即用户报的「浅色模式下终端字体显示不清楚」。代码原注释让用户「去设置页另选调色板」，但根本没有浅色调色板可选。新增四套 twin（light-plus / solarized-light / one-light / latte，取各家官方浅色板，仅对近白底上 <1.5:1 的槽位加深并注明），`cursor`/`selectionBackground` 从写死改为入表；`resolvePaletteId(paletteId, isLightTheme(themeId))` 按主题亮暗解析、不符自动换 twin，设置页只列匹配当前亮暗的四套并在自动切换时给一行说明。**三处同步点**：`PALETTE_LIST` ↔ `settings.rs KNOWN_PALETTES`（原白名单只认四套深色，漏改会让新调色板被静默丢弃）↔ `XTERM_BG_FG`；主题亮暗判定收敛为 `themes.ts isLightTheme()` 单一出处。顺带修掉 `mocha-light` 主题 App chrome 早已用官方 Latte、终端却仍是 Mocha 深色的不一致。② **浅色语义色令牌补齐**——`[data-theme$="-light"]` 原先只覆写 hover 与 diff 四色，`--color-ok/err/warn`（`#10331f`/`#381e24`/`#37300f`）保持深底口径，导致全站 69 处 `bg-ok/bg-err/bg-warn` 在浅色下是白页上的深色块（与 v3.81 已为 diff 行做过的浅底深字修正自相矛盾）；补 ok/err/warn/add/del 八个令牌为浅底深字，组件零改动。**确立 `--color-*` 只作 pill 底色、`--color-*-text` 供 pill 文字与一切实心圆点/圆形使用的硬分工**，并据此修掉三处误用底色档铺实心形状（步进器 blocked 大圆、大圆注意力角标、任务卡主仓改动点——浅色下是浅黄铺在近白 canvas 上，等于消失；且同为实心圆的 done 本就用 `-text` 档，原先自相矛盾）。`.ccode-float-surface` 的白色内高光在白底不可见，浅色改为极淡内暗边 + `0 0 0 0.5px` 外描线（零偏移零模糊，不违反零阴影）。③ **去线条化**（用户反馈「工作区界面有点线条化」）——v3.35/v3.37 拆掉描边与横线后变成一堆等高细条，反而更像线；确立三条规则：同屏最多 2 条横向带（工作区页只留大圆步进器带）、页面级对象列表用卡片 + 卡间留白（禁 `divide-y`）而块内密集行用 `space-y` + hover 高亮、块间用 ≥16px 留白且禁画分隔横线。落地：工作区列表 `divide-y` 细行改 `bg-strip` 卡片（卡内状态 pill 顺势升到 `bg-raised`——用 inset 做卡会让 pill 无处可去，浅色主题 inset/raised 已接近纯白），项目身份行与端口折叠区标题的横线拆除，任务卡/想法卡/定时任务三处行分隔线改留白。④ 新增**跨页视觉三原则**（同权重元素 ≤5 必分级 / 一屏容器边界 ≤4 / 每屏一个「现在该干嘛」的答案），后续每批 UI 改动自查。⑤ **实机截图走查补两处**（用户给浅色主题截图）：**开关渲染成白底黑疙瘩**——`Toggle` 滑块用 `bg-l1`、轨道用 `bg-inset`，浅色主题下 l1 是近黑 `#171a26`、inset 是近白，滑块与轨道明暗全反；改走专用令牌 `--color-switch-off`/`--color-switch-knob`（深色值保持原样、外观不变，浅色为白滑块 + 可见灰轨道）。**七套浅色浮起阶梯塌陷**——`canvas→strip→inset→raised` 实测亮度差只有 1–4（ayu/shadcn 最差到 0.9），已直接违反本文档「strip/inset/raised 三级梯度七套主题必须可分辨」，表现为整页发平、③ 新做的卡片与页面底糊在一起；浅色「浮起 = 更亮」在 raised = 白处到顶，只能靠压深 canvas 换空间，故按「从白往下每档降约 4.5 亮度」统一重排七套（保各主题色相；midnight 家族随 v3.48 去蓝一并转暖；mocha-light 不再照搬 Latte 官方 base/mantle/crust——那套是「越深越低」，方向相反）。同批把梯度步进、浮起次序、选中/线条深度、语义色浅底深字 + WCAG AA、开关明暗写成可执行断言 `tests/theme-contrast.test.ts`（直接解析 App.css），把原先只存在于文档里的口径变成会失败的测试。 |
| v3.86 | **工作区与项目管理（全站优化第 2 批）**：① **项目详情页固定三段**——身份段 / 流程段 / 工作段，段间只用留白。核心是新增**「当前步骤卡」**：v3.73 删掉「当前步骤条」后，「现在该干嘛」被摊薄到聚焦头（白话状态）、大圆步进器（状态色）、流程线（动作）三条独立细带上，信息都在但没有一处给出单一答案——这正是「详情页不够清楚」与「线条化」的共同来源。现在聚焦头与 `StepFlow` 并进同一张 `bg-inset` 卡（`StepFlow` 加 `bare` 去掉自带底色由外层承载，卡内再浮一层改 `bg-raised`）；**大圆步进器规格一行未动**（用户明确要求保留）。身份段项目名提到 16px semibold，课题主题为空时给可点占位。② **步骤字段激进精简 + 高级折叠**——一个步骤 10 个可编辑字段、一屏放不下一张卡；常驻收到 4 项（步骤名 / 简报 / 预期产物 / 推荐技能，即决定 TASK.md 全部内容的合同本体），其余分「人机分工」（人工事项 · 决策项 · 讨论种子，按 v3.69「要商量的 / 要动手做的」同源归组）与「高级」（工作区名 · run 脚本 · 资源绑定）两折叠区；**字段一个不删**，折叠区标题带「已填 N 项」且已填默认展开。推荐技能补进编辑器（复用 `StepSkillsChips` 可编辑态）。**顺带修一处静默数据丢失**：`toStep` 漏传 `humanTasks[].optional`，编辑器一保存就把内置模板标「不做也能跑」的事项升级为必办，同批补「可选」勾选框。③ **项目级配置收进「项目设置」右侧抽屉**（不是页面、不进侧栏、不占路由）：基本 / 研究流程 / 文献与数据 / 定时巡检四组，资源面板与 ScheduleSection 整体搬入——详情页少两条常驻带，项目 `⋯` 从八项收到四项（编辑研究流程 · 项目设置… · 历史 · 移除项目注册；清除痕迹与删除目录仍只在项目栏右键菜单，不做第二套删除入口）。**模板库实例随之住进抽屉**，所有打开模板库的入口必须连抽屉一起开。④ **全局「快速开聊」**（用户拍板）：侧栏「工作」组首位 + ⌘K 命令 → 弹层只问 agent/配置/目录 → 开标签并自动启动（新增 `PendingTerminal.autoStart`，无可用配置降级为只预填）。回答「进软件想随便聊聊」——原先所有入口都是项目/流程优先。明确不建项目/工作区、不写 `.ccode`、不注册、不落 TASK.md；默认落脚 `~/ccode/scratch`（新 command `ensure_scratch_dir` 只 create_dir_all，**不 git init**）。转正走终端标签 ⋯「转为项目…」= 仅 `register_project`，会话历史跟 cwd 走自动归属，无需迁移。⑤ **走查续批**：步骤卡折叠区默认值纠偏——原按「已填就展开」处理，但模板步骤个个都带 `workspace_name`（保存时自动派生的机械字段）与 `human_tasks`（模板内容），两档在每张卡上全是展开的，等于没折叠；改为**一律默认收起**，标题从含糊的「已填 N 项」换成真明细（如「人工事项 2 · 决策项 3」，空则「未设置」），「自定义工作区名」只在与派生值不同时才计入。**步骤 ⋯ 菜单 6 → 1~3 项**：删「人工事项」（`onSelect` 就是 `focusByIndex`，与点大圆完全同效，且「N 件待做」是 v3.84 已删的「等你做」计数的最后残留）、「复制工作区名」（近零频次）、「删除步骤」（结构性编辑归编辑器，破坏性动作不该紧挨大圆悬停即出）；「产物核验 / 定位目录」改为无工作区时**不渲染**而非禁用（原 6 项里常年 2 项是灰的）。菜单至此只剩非破坏性动作，并顺带清掉只为那条计数存在的 `list_human_task_states` 调用与 `humanStates` 状态（清单本体在 `useHumanTasks` 里自取自刷）。 |
| v3.87 | **「输入准备」独立成块：文献来源从四处收敛到一处**（用户实测提出：人工事项落点写 `papers/` 但 Zotero 导入不往那儿写，担心流程走不通）。查证结论先立此存照：`zotero_import` 是**只读适配器**——`references.bib` 写项目根、PDF **按绝对路径登记为资源且不复制**，这是 §11.3 机制一「资料只记位置不复制」的既定设计；人工事项落点检测根是「项目根 + 绑定的活跃工作树」，两个都查，所以 `papers/` 放项目文件夹是认的，**但 Zotero 路径本就不经过 `papers/`**，那条事项因此不会自动打勾。**流程不断**（TASK.md「项目资源」段带绝对路径、PDF 预览白名单含登记资源、`lit_source` 让检索步降级为盘点+查漏），是体验裂缝：模板 guidance 写着「到『文献与数据』导入即可」，暗示会自动完成，与行为矛盾——已改成明说「Zotero 导入不会进 papers/，导完手动勾一下」。**根因是同一个问题被问了四遍**（设置抽屉的文献来源开关、Zotero 导入按钮、决策项、人工事项）且互不通气。收敛方案：新增步骤级模板声明 `steps[].asks_lit_source`（引擎只透传；**评估过按 `skills` 含 `lit-search` 推断后否决**——隐式魔法，用户删个技能功能就没了），为真时流程线「定方向」出现「输入 · 文献从哪来」三选一 + **选中即就地出现导入按钮**；抽屉里只留只读回显与跳转指引，导入动作保留为二级入口。**与决策项刻意分块**（用户拍板「不是同一类」）：决策项答案写草稿、纯记录、答的是「这一步怎么做」；输入准备答案写 `config.lit_source`、带动作、答的是「输入从哪来」。`setLitSource` 由两档特判（「已是 zotero 就不降级」）改为三值显式。配套：`PipelineEditor` 的 `StepDraft` 透传新字段（漏传即为 `humanTasks[].optional` 同类静默丢失，已加 Rust 往返测试守住），「高级」折叠区给出开关。**同批走查续修三处（用户实测）**：①「刚喊完单一触点就自造第二处」——初版在流程线又摆了一套导入按钮，撤回为「去『文献与数据』导入 →」链接，**导入动作全局只此一处**，分工定为「输入准备管从哪来、文献与数据管有什么+进料」；② 冗余人工事项「补充你已知的关键文献」整条删除（与输入准备完全重合，且 `papers/` 落点对 Zotero 路径永不成立，是个打不上的勾；仅影响新建项目，存量 project.toml 需用户自行删）；③ 修 v3.85 引入的回归——新项目「已自动扫描到 N 个资源」反馈随「文献与数据」面板搬进抽屉后变成「在关着的抽屉里展开」，用户看不见，改为直接显示在详情页的新项目提示条上并带「查看 / 补充」直达。**编辑器补「改了会不会上流程线」说明**（用户第二问的落地）：展开「人机分工」写明三项都会成为流程线节点/定方向内容，展开「高级」写明均为幕后生效并提示改工作区名会让该步失去绑定。**Q1 正面修复（A 案，用户拍板）**：新增 `lit_library_hit`——`lit_source` 为 zotero/folder 时，登记资源中存在 PDF 类条目即视为 `papers/` 系落点满足，与落点文件检测、手动勾选三者取或；`search` 模式一字不变，非 `papers/` 落点不放宽，只有 bib/csv 不算全文到位。此前只删掉了矛盾最刺眼的那条事项（治标），剩余 4 条付费墙类事项无法删（真人工活）故必须正面修。同批修掉自己的漏删：示例课题 `demo_project_config` 里还有第二份「补充你已知的关键文献」且为必办，连同守它的断言一并更正。 |
| v3.88 | **全站优化收尾（批次 3/4/5/6 + 配置页缺口）**：① **模型切换可靠性**（真 bug 面）——抽 `src/model-switch.ts` 单一出处（能力表原本只活在配置页表单里），修四个成因：换 profile 静默清掉手填模型（`modelOnProfileSwitch`：手填值不在新表里则保留并提示「仍按原样注入」）、`models` 为空时后端完全不注入而界面无提示（`pty.rs` 的静默陷阱）、各 CLI 多模型能力差异只写在文档里（`launchModelNote` 挪到启动栏下拉）、手填模型零校验（失焦软提示不拦截——中转模型名千奇百怪）；保存配置后若该 agent 有标签在跑追加「要重开标签才生效」横幅。② **profile 的「启用/停用」按注入语义落地**——**不加 `enabled` 布尔**（会与「配置只在启动那一刻注入」打架，且和「设为全局」形成两套激活概念），改为 `settings.defaultProfiles`（每 agent 默认，启动栏预选顺序 默认 > 上次 > 首个）+ `settings.hiddenProfiles`（隐藏项沉到启动栏下拉「更多」optgroup 且预选跳过，不删数据不改行为）+ 行内「⌨ 在终端使用」（配置页原本没有任何通往终端的路）。③ **统计趋势线**：`UsageStatsDto.daily` 按天聚合（数据本就按天存），手绘 SVG 不引图表库。④ **终端标签条 13 类 → 5 类**：布局三开关（分屏/工作台/专注）合成分段控件，git 芯片/✓保存/可合并 pill 下移中带底部状态条（结果不是入口，v3.83 行为语义一字未改），`⋯` 改常驻并合并原先分散的两套菜单。⑤ **对话页筛选**：抽 `src/session-filter.ts`——一行 chip 快筛（保留/进行中/今天/近7天/内部/归档，这些维度早在 DTO 里却一个都没进 UI）+ 搜索给结构化建议落成可叠加 scope chip（同类取或、异类取与），取代手风琴三次钻取；补对话↔工作区双向链接（新增 `sessionScopeReq` 一次性请求）。⑥ **收件箱通用忽略**：`filterDismissed` 把 `help:` 独有的屏蔽推广到七类，签名变化即复现。⑦ **顶栏升为全局上下文栏**：左项目·步骤（`contextLabel` 镜像）+ 中 ⌘K 搜索 + 右运行数/收件箱；不冲突 v3.38（那条否决新增垂直占用，此处是利用 Overlay 模式已恒占且不可省的 40px）。⑧ 配置页缺口：gemini/cursor 的空预设下拉改为说明文案（`NO_PRESET_REASON`），grok 补 OpenAI 兼容端点预设。**走查后补齐**：顶栏中间的 ⌘K 假输入框**撤除**（用户否决「顶栏摆输入框不好看」，命令面板入口不设第二处）；对话行操作分级（⚑ 保留提行内、已保留时状态标记自身可点取消，⋯ 由 11 项平铺改「整理/继续/危险」三组，外部恢复两项并为「在外部继续 · 打开终端 / 复制命令」）；技能详情「哪些步骤在用」反查（纯前端扫已注册项目 `steps[].skills`，删技能前知道影响谁）；`mcp_distribution_status` 只读命令把后端早有的 `entry_modified_externally` 透到界面上（三态点：已写入/被外部改过/未开启——此前只在删除时用来拦假状态，用户不知道 agent 侧手改会被覆盖）；设置页「数据与存储」（`app_storage_usage` 递归求大小，符号链接不跟随、2 万条目预算上限）与「想法期只读保护」补行。**明确暂缓**：技能+MCP pill 合一（要重构两套菜单，收益低于风险）、收件箱生产者搬进 store（130 行、8 个数据依赖，回归风险高于收益，现耦合可用是因 WorkspacesPage 恒挂载）、工作树 `.*`/`⟳` 改 hover（`⟳` 常用，藏起来是负优化）。 |

## 11. 演进线（2026-08 定稿）

定位从「通用 Agent 控制台」演进为 **AI 科研工作台**：底层仍是九个 Agent CLI（Claude Code / Codex / Gemini / Qwen / OpenCode / Kimi / CodeBuddy / Cursor / Grok Build）的统一控制台，表面是科研流水线（读文献 → 整数据 → 做图 → 写论文）。一句话：**AI 负责干活，Ccode 负责管活，人负责拍板。**

### 11.1 三条纪律

1. **科研语义进模板和数据，不进逻辑**：流水线步骤、任务简报、技能包都是可编辑预设；引擎保持通用，不认识「文献」「论文」这些概念。
2. **验收层是护城河**：每一步成果必须人工评审才合并进入下一步（沿用 §6.10 评审流与全宽评审覆盖层）。
3. **跨厂商中立是生存线**：九个 CLI 平等支持；API 与官方账号双轨并行（§11.4 P1a）。

### 11.2 量化目标

- 任何一步从「想做」到「Agent 在跑」≤ 3 次点击。
- 步骤间产物传递 0 次手动复制路径。

### 11.3 五个核心机制

1. **项目档案卡 `.ccode/project.toml`**：资源清单 + 流水线定义，跟着 git 走；资料只记位置不复制。
2. **流水线 Pipeline**：内置可编辑模板（默认英文综述路径：文献检索与筛选 → 文献精读与笔记 → 综述大纲 → 综述初稿 → 润色与定稿），每步预设工作区名/任务简报/技能/run 脚本/预期产物。
3. **一键开步**：点「开始」= 建工作区 + 启 Agent + 注入简报 + 落成 TASK.md，一次点击；是既有工作区创建与终端启动能力的组合调用，不破坏手动启动栏主流程。
4. **接力包**：跨 Agent 交接——从当前会话生成结构化简报（目标/结论/进展/git 状态）落成文件，新 Agent 带简报启动，记录接力链；明示是**接力不是记忆转移**（v1 结构化模板，AI 摘要可选增强）。
5. **提货单 `artifacts.yaml`**：大产物（数据/图/PDF）不进 git，清单进 git（名称/路径/hash/来源），随合并传给下一步。

### 11.4 阶段表（新 P0–P5）

| 阶段 | 内容 |
|---|---|
| **P0** | 收尾当前批次：全量文档同步 → 走查 → `[skip ci]` 提交 → 可选发版 |
| **P1a ✅** | 官方账号：profile 双类型（API / 官方账号）；终端内跑 CLI 登录命令连接；只读检测 auth 文件显示已连接 + 冲突配置黄色警告；拉起不注入 API env 且 `env_remove` 残留密钥变量；统计页官方账号显示「订阅」不计费；第一批 Claude / Codex / Gemini（随 P1d 注册表落地，v3.17） |
| **P1b ✅** | 流水线骨架（v3.18）：project.toml 读写 + 项目注册；工作区页按项目分组 + 步骤胶囊概览（状态从工作区派生，无双状态机；进度条收敛为「研究流程 d/t」文字；后演进为大圆步进器，v3.46）；一键开步（含 bootstrap 自动提交、TASK.md 进 `.git/info/exclude`）；资源面板登记 + 自动发现；非 git 目录引导 init（默认 .gitignore 含 `*.pdf`）；首启引导为轻量版（模板选择器），演示数据完整版留 backlog；工作区类型驱动默认值（数据类跳端口）未做，留 backlog |
| **P1c ✅** | 供应商预设补齐：claude-code 补 DeepSeek/智谱 Anthropic 兼容端点、codex/qwen/kimi/opencode 补 DeepSeek/智谱等；此后加供应商 = `src/presets.ts` 预设表加一行 |
| **P1d ✅** | 适配器注册表（v3.17）：per-agent 硬编码 match 收敛为 `agent_specs.rs` 中央声明式 AgentSpec 注册表（一个 CLI 一张规格）；会话解析器与 usage 提取器保持每 CLI 一个解析器文件，注册表只做分发入口；加新 CLI = 一张规格表 + 一个解析器文件 + 测试 |
| **P2 ✅** | 文献：PDF 预览（P2a 直接 pdf.js，WKWebView spike 跳过，`read_pdf_bytes` 白名单，v3.14）；选段问 AI（pty_write 注入活跃标签输入框不自动回车）；整理为笔记（P2b，`pdf_owner_project` + `append_workspace_inbox`，v3.19）；文献技能包（lit-search/lit-notes/review-framework/review-writing） |
| **P3 ✅** | 数据 + 接力（v3.15/v3.20）：数据处理模板 + 技能包（data-clean/data-eda）；提货单 artifacts.yaml v1（手动登记 + md5/大小，下一步 TASK.md 自动带提货单段）；图片评审双栏看图；长任务 OS 通知；接力包 + 接力链对话页可回溯 |
| **P4 ✅** | 论文（v3.21）：manuscript 模板（科研论文/毕业论文）+ quarto render 脚本（RX4a 追加 export-docx）+ quarto-render 技能；提货单登记的根外 PDF 产物纳入预览白名单；bib 联动以模板简报引用 references.bib 务实落地 |
| **P5 部分 ✅** | 通用层打磨（v3.21/v3.22）：逐 hunk 验收 ✅（v1 边界=仅未提交）、跨标签聚合视图 ✅、成本按工作区归因 ✅（任务成本）、订阅口径 ✅、历史时间线视图 ✅（first-parent 主线 + 白话翻译）；批量验收、云端会话双源调研留 backlog |

**Backlog（记录不动手）**：SSH 远程执行（数据集在实验室服务器时启动）、MCP 配置分发调研、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（P2 验证后评估）、批量验收、云端会话双源调研、首启引导完整版（示例课题带演示数据 + 示例 PDF）、工作区类型驱动默认值（数据类跳端口）。

#### Backlog 细目：定时任务与研究流程的结合（待做，2026-08-15 记）

**先定一条边界：不给每个步骤配定时任务。** 研究步骤绝大多数是一次性的（检索一次、精读一次、写一次），逐步挂调度属过早抽象，与 v3.75「不做独立任务中心页——任务必绑项目，全局页是过早抽象」同源（方向相反的同一类错误）。定时任务的正确形态是**跨步骤的后台哨兵**。

真正的缺口是**产出与流程脱节**：`lit-watch` 把新文献写进 `notes/inbox.md`，流程里没有任何地方消费它，用户得自己想起来去看。结合点应是「产出回流」而非「配置下沉」，且尽量复用既有机制：

1. **产出进收件箱**：定时任务发现新条目 → 进「待你处理」（`inbox.ts` 已有分类体系），而不是新造一套提醒。
2. **关联步骤**：定时任务增加可选的「关联步骤」字段（如 lit-watch → 文献检索与筛选），产出挂到那一步，而不是浮在项目层。
3. **复用上游漂移语义**：已完成的步骤收到新输入，与 `staleUpstream`（「上游 X 有更新，产物可能过期」）是同一个概念——不新造第二套「有新发现」提醒，直接沿用该口径与文案。
4. **落点收敛**：定时任务的技能简报统一写死「只允许新建/追加 `notes/inbox.md`、`papers/watch-*.md`，其余文件一律不动」（lit-watch 已基本如此，推广为通用约定）。语义进模板不进引擎，符合纪律一。

**同时记录三条已确认的风险**（`ai.rs:60-90`、v3.75 风险遗留）：

- **写权限边界九家不齐**：仅 codex 有沙箱（`-s workspace-write`）；grok 用 `--yolo`（全放行、无沙箱，且注释自陈「默认权限模式未确认」）；claude-code/gemini/kimi/codebuddy/cursor/opencode 不带权限参数、依赖各自默认；**qwen 是纯位置参数兜底，能否无头跑都未验证**。定时任务是唯一在用户不在场时写项目文件的路径，却验证最少。
- **绕过验收层**：`cwd` = 项目根而非 worktree，产出直接落主文件夹，无 diff、无隔离、不经评审——与纪律二「验收层是护城河」存在张力。v3.75 是有意取舍（token 归因给项目），但这是全产品唯一不受评审约束的写入路径，应在文档与 UI 上明示。彻底解法是让定时任务跑进 `ccode/watch-<日期>` 工作区、走正常评审合并；代价是每次建工作区（重），属定位决策。
- **超时状态不可分**：10 分钟超时记为 `error`，用户分不清「真失败」与「没跑完」（订阅行多时 lit-watch 跑三路 API + 去重可能偏紧）。超时应单列状态。

**优先级建议**：先做能力标注（`DetectResult` 加 `headlessVerified`，新建定时任务时 qwen 禁选、grok 标「无沙箱」、其余标「权限未实测」——不默默降级，与「只读保护」标注同一口径）与落点收敛（第 4 条）；产出回流（1–3）次之；跑进工作区记为定位决策待拍板。


### 11.5 明确不做（附理由，否决记录见 §10 v3.5–v3.12）

- AI 自动拆任务 / Agent 编排引擎（造 meta-agent）
- MCP 协议接入 / 自建协议（Ccode 无 tool-call 循环，概念错位；MCP 配置分发 ≠ 接入）
- 智能路由引擎（只做使用数据展示）
- Docker/VM 沙箱、daemon 化、手机同步（贬值层）
- Zotero 式文献库 / 数据表格查看器（别人的战场）
- AI 全自动写论文绕过评审（底线）
- keyring 回退（cdhash 坑，v0.3 已定论）
- 会话「无缝继续」表述（技术不存在，一律称接力）

### 11.6 主要风险

- **PDF 预览已落地（v3.14）**：WKWebView spike 跳过，直接 pdf.js + `read_pdf_bytes` 白名单；docx（RX4a）复用同一白名单通道，后续新增二进制预览类型沿用同一模式。
- **官方账号 env 净化需按 matrix 逐家核实**：各 CLI 账号登录与 API env 的优先级关系不同，以 `docs/agent-integration-matrix.md` 源码级结论为准，勿凭印象。
- **quarto/latex 可用性**：经 `agents::resolve_binary` 兜底解析，缺失时明示引导安装，不静默失败。
- **一键开步触碰旧约定**（终端手动启动主流程、工作区创建语义）：以新约定为准——开步是预设参数的组合调用，手动启动栏主流程不变。

### 11.7 新增约定

- 流水线开步 = 预设参数的组合调用（建工作区 + 启 Agent + 注入简报 + 落成 TASK.md），全部复用既有能力；手动启动栏「Agent → profile → 模型 → 目录 → 启动」主流程不变。
- 官方账号的 CLI auth 文件只读检测「已连接」；断开引导用户用 CLI 自己的 logout，Ccode 不删 auth 文件。
- 官方账号拉起不注入 API env，且必须 `env_remove` 同协议残留 API 密钥变量（防静默覆盖账号登录）。
- 「接力」是唯一的跨 Agent 交接表述，禁用「无缝继续」。
- 科研语义只进模板/数据/技能包，不进引擎逻辑。
