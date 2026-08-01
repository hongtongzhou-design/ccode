# Ccode 架构方案 v0.2

> 一个「AI 编码 Agent 统一启动器 + 配置中心 + 会话监控台」。
> 本文档是项目的总体逻辑架构，配合 `docs/agent-integration-matrix.md`（六个 CLI 的适配细节）使用。
> 所有关于各 CLI 的事实均来自 2026-07-30 对官方文档/源码的调研，标注「易漂移」的字段需防御式处理。
> v0.2：固化五项产品决策（命名 Ccode、项目自动聚合、终端↔对话联动、token 统计留在 P3、三平台同步）。

## 1. 产品定位与核心概念

让用户在一个桌面应用里：

1. 为多个终端 AI agent（Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code）管理**多套 API 配置**（端点 + 密钥 + 模型），一键切换；
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
| Agent 范围 | 六个全部进 MVP，通过适配器接口隔离差异 |
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
│  ├─ AgentAdapter    trait，六个实现（见 §4）            │
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

六个 agent 的关键适配结论（细节见 matrix 文档，此处只列**影响架构的事实**）：

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
    base_branch: String,       // 创建时的基准分支（如 origin/main）
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
- **全局模式**：`ConfigWriter` 改写目标 CLI 的配置文件（如 `~/.claude/settings.json` 的 `env` 块、`~/.codex/config.toml` 的 `[model_providers]`），**写前自动备份**（时间戳副本，保留最近 5 份），用户可随时「恢复备份」。UI 上必须明示「这会修改该 CLI 的全局配置，影响你在其他终端里的使用」。

### 6.2 密钥存储

- 密钥本体存 `<平台配置目录>/ccode/keys.json`，文件权限 0600（与 Codex `auth.json`、Claude Code 在 Linux 的 `.credentials.json` 同一威胁模型）；`profiles.json` 里只存尾号提示（`key_hint`）。
- **不用系统钥匙串**（v0.1 曾用，已废弃）：macOS 钥匙串 ACL 与代码签名绑定，未签名的开发构建每次热重编译产生新 cdhash，旧条目即失配读不到，表现为「密钥消失」；Linux 的 Secret Service 在无桌面环境下也不可用。读取时保留从钥匙串的一次性迁移，兼容旧版本数据。
- 注入时从 `keys.json` 读出，只存在于子进程环境变量中，不进日志、不前端回显（UI 只显示尾号掩码）。

### 6.3 内嵌终端

- Rust 侧 `portable-pty` 创建 PTY 并 spawn CLI（带上 launch_plan 的 env/args/cwd）；输出字节流经 Tauri channel 推给前端 xterm.js；前端输入/resize 反向 command。Windows 走 ConPTY（portable-pty 已封装）。
- 支持多标签：每个标签一个 PTY 实例，`PtyManager` 按 id 管理。
- 每个终端标签记录 `(agent, profile, project_dir, linked_session_id)` 元数据，供工作区面板展示与联动。

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
- **布局**：终端页三带 `[工作树+运行中 | 终端标签区 | 右侧面板（会话联动 / 文件预览 / 改动，页签切换）]`，左栏可折叠。
- **改动面板（借鉴 VS Code Source Control 与 Codex 环境信息）**：右栏第三页签，量化 agent 的工作成果——当前分支、领先/落后远程、对比 HEAD 的 `+/-` 行数（含未跟踪文件）、文件级列表；提交信息输入 + 「提交」「提交并推送」一键操作（`git add -A`），8 秒轮询刷新，非 git 仓库明确提示。git 写操作只由用户点击触发，命令输出与错误回显。
- **明确不借鉴**：VS Code 服务化 workbench 架构（过重）；文件树 git 装饰（标改动）留 P4；真正的编辑器留 P4 Monaco，预览只读先行。

### 6.10 任务工作区编排（借鉴 Conductor，全量整合）

Conductor 的核心模型「工作区 = git worktree + 分支」解决我们的并行冲突隐患：现在多个终端标签在同一目录跑 agent 会共享文件与 git 状态。整合方案：

**工作区模型与位置**
- 位置：`~/ccode/workspaces/<repo名>/<任务名>/`（worktree 实体）；元数据存 `app.db` 的 `workspaces` 表
- 一个工作区 = 一条 `ccode/<任务名>` 分支 + 一个 worktree；分支是评审与合并单元
- worktree 与主仓库共享对象库，创建是秒级；归档只移除 worktree 不删分支，可恢复（含会话历史）

**生命周期**
1. **创建**：选仓库（项目聚合列表或手选）→ `git fetch`（best effort）→ 从 `origin/<base>` 拉分支 `ccode/<name>` → `git worktree add` → **files-to-copy**（`.env*` 等 gitignored 文件按 `.ccode/settings.toml` 的 `files_to_copy` 复制进 worktree）→ **setup 脚本** → 自动开终端标签（cwd = worktree，注入端口段 `CCODE_PORT..CCODE_PORT+9`）
2. **工作**：现有三带工作区全部适用；git 面板的 diff 基准从 HEAD 改为 `merge-base(base, branch)`，能看到任务累计改动
3. **合并**：改动面板扩展——提交后可选「合并回 `<base>`」（本地 merge）或「创建 PR」（复用机器上的 `gh` CLI 认证，不做应用内 GitHub 登录）；冲突时提示让 agent 解决
4. **归档**：跑 archive 脚本 → `git worktree remove --force`（保留分支）→ 状态 Archived；恢复 = 从分支重新 `worktree add`

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
- **阶段 C（评审流）**：diff 基准改 merge-base、合并回 base、gh PR 创建、状态机（ReadyToMerge 判定：无未提交改动且与 base 无冲突）

**明确不做**：云工作区、多人协作、应用内 GitHub 登录、城市命名游戏化、agent 系统提示注入（后续按需）。

### 6.11 P3 设计：OpenCode 解析、用量统计、注意力标记

**页面结构**：侧栏由四页扩为五页——配置 / 工作区 / 终端 / 会话 / **统计**。

**OpenCode 会话解析（补齐第六个 agent）**
- 数据源：`~/.local/share/opencode/opencode.db`（v1.2+ SQLite，WAL 只读打开，`busy_timeout`）；旧版（<v1.2）`storage/` 扁平 JSON 做兼容回退
- 表映射：`session`（id/title/cost/tokens_*/time_*/directory）→ SessionMetaDto；`message`（data JSON：role/model/tokens/cost）+ `part`（data JSON：text/reasoning/tool 判别联合）→ ChatMessageDto；项目归属：`project.worktree` 列
- 解析策略：只读查询 + JSON 列防御式解析；drizzle schema 随版本迁移，列缺失时降级而非报错；优先用官方 `opencode export`？否——用户机器上 opencode 未装时仍需能读库，直读 SQLite 为主

**用量与费用统计（新「统计」页）**
- 数据模型：解析层已为每个 ChatMessage 产出 usage（input/output/cache），聚合成 `UsageStat { agent, model, project_path, day, input, output, cache_read, cache_write, sessions }`，按天聚合存 app.db 新表（避免每次全量重算；扫描增量更新）
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

**导出**：单个/多个技能打包为 ZIP（系统保存对话框）。

**页面**：技能行（名称 + description + 六个 agent 的应用开关徽标）+ 操作（查看 SKILL.md、重新应用、导出、删除）；顶部 导入/导出 按钮。查看用只读预览复用现有组件。

**后续（v2）**：来源更新检测（content_hash 比对）、SKILL.md 在线编辑、自定义命令（commands/prompts）管理。

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
| 全局模式写坏用户配置 | 写前备份 + 一键恢复 + UI 明示影响范围 |
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
| v0.6 | 全站暖黑主题（Conductor 风，令牌集中 `src/App.css` @theme，禁蓝色系，用户否决浅色+渐变方案）；安装/更新命令必须 PTY 执行（管道块缓冲坑）；brew 走 TUNA 镜像；**全量采纳 Conductor 工作区编排**（§6.10）：任务工作区 = git worktree + 分支，分 A/B/C 三阶段实施（W1/W2/W3）；明确不做云工作区/多人协作/应用内 GitHub 登录；重大改变沉淀规则到 AGENTS.md + 本节（用户指令） |
| v0.7 | P3 设计定稿（§6.11）：侧栏扩为五页（+统计）；OpenCode 直读 SQLite（WAL 只读 + 防御式）；用量按天聚合入 app.db、内置定价表可覆盖、中转不明价只显 token；注意力标记 v1 走零侵入启发式（会话尾态+输出速率），Claude Code hooks 精确化留 v2 单独评估（需写用户配置）；功能增改必须同步 `docs/user-guide.md` |
| v0.8 | 跨模块闭环 A-E 实施（§6.12）：会话一键恢复（pty_spawn resumeSessionId）、进行中标记 + 反向跳转、工作区记住配置、工作区→会话筛选、profile 上次使用；**主题二次定稿为沉浸冷黑**（四层浮起结构，保留绿 CTA，暖棕色系被用户否决）；配置页按用户详版规格重构（折叠分组 + 五列网格 + 筛选搜索）；图标按钮点击区 ≥28px |
| v0.9 | 新增技能管理模块（§6.13）：SSOT 技能库 + 六 CLI 分发（Auto symlink/copy），四路导入（本地/ZIP/GitHub 仓库/应用目录发现），ZIP 导出，卸载备份；采纳 Agent Skills 开放标准（SKILL.md 防御式解析）；更新检测与在线编辑留 v2；git 推送改走 SSH:443 通道 + repo deploy key（HTTPS 网络不稳） |
| v1.0 | P3/P4 完成后迭代：费用统一官方价口径（27 项定价、供应商前缀剥离、部分估算标 ≥）+ $/¥ 一键换算；**工作树逻辑统一**（当前项目锚点=tab cwd、最近项目真进入、操作边界=树当前根、运行中默认折叠、搜索范围明示）；文件操作加重要路径删除保护（系统目录/关键用户目录/CLI 配置/.git）；预览按扩展名语法高亮；安全原则重申：删除保护只覆盖 UI 操作，agent 权限依赖各 CLI 自身机制 |
| v1.1 | 设置页 + 主题系统：七套深色主题（实测色板融合，各带独立强调色，[data-theme] CSS 变量运行时切换；删除暖夜/墨绿/深紫）；「活跃」「可合并」pill 用 cta-pill 同步强调色，其余状态保持语义色（干净优先）；**AI headless 层**（ai.rs，复用 launch_plan 注入，六 CLI print 模式，profile 按 last_used_at 解析）；profile 用量按模型近似归属（悬浮卡展示）；侧栏可折叠为图标栏；符号语言统一（◈=AI、⚑=pin，禁彩色 emoji）；WKWebView 不支持 window.prompt——输入一律内联 |
| v1.2 | 终端会话回路补全：shell 回落提示语义化（「会话已保存，可一键恢复」）；收缩状态行加「⟳恢复」（resumeSessionId 直接续聊）与「⤴对话」（跳会话页打开回放做整理）；确立「进程一次性、会话永久」的展示语义；终端字形回调清瘦（400/600、行高 1.2、零字距，向 Ghostty 锐利度靠） |
| v1.3 | v0.1.0 发版：性能一轮（终端页 memo 化、SessionLink 轮询文件签名门控、页签保持挂载消切换迟滞、工作树收缩 xterm 重 fit）；终端字体打包 JetBrains Mono woff2 + 设置页字体/调色板可配；**安全**：删除保护 canonicalize 双校验（堵符号链接绕过）、codex 默认沙箱（交互 workspace-write / AI 无头 read-only）；应用图标全套（emerald-mint）；**CI 发布流水线**：tag/手动 dispatch → 三平台 cargo test → tauri build → Release 草稿（deploy key 推送不触发 Actions 故发版走 gh api dispatches；workflow 配 contents:write；CI 测试禁墙钟时序断言、unix 语义门控、路径断言 Path 比较）；**macOS 签名公证暂缓**（用户拍板，未签名包首开需右键打开；后续办 Apple Developer 会员后在 CI 配 6 个 APPLE_* secrets 即可补） |
| v1.4 | 设置页「AI 专用配置」：◈ 三功能（提交信息/摘要/PR）profile 解析顺序改为 显式 id > 设置专用 > 最近使用（settings.ai_profile_id，空串清空回自动；专用被删明确报错不静默回落）；动因：自动落大模型导致生成慢，小任务应走快模型 |
