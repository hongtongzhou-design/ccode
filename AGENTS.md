# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（硬约束、本机环境档案）或对应
> `docs/conventions/*.md` 主题文件，以及 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是
> 操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：功能增改时必须同步更新 `docs/user-guide.md`（用户操作手册）；发版本时同步更新 `CHANGELOG.md`（版本更新日志）。

## 项目简介

Ccode 是一个「AI 科研工作台」桌面应用（Tauri v2 + React/TS）——底层是九个 Agent CLI 的统一控制台（启动器 + 配置中心 +
会话监控台），表面是科研流水线（读文献→整数据→做图→写论文）：AI 负责干活，Ccode 负责管活，人负责拍板。
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

- 应用名 **Ccode**；九个 agent 全部支持（CodeBuddy Code、Cursor CLI、Grok Build 见 matrix §7/§8/§9；grok 首版：「设为全局默认」不支持、MCP 只读不分发、技能强制 copy）
- 配置切换**双模式**：默认启动注入环境变量（零污染），另提供「设为全局默认」（写配置文件，先备份）
- 终端为内嵌形态，且**与结构化会话视图联动**（同一会话双栏观看）
- 项目列表**从各 agent 历史会话自动聚合并分类**，辅以手动添加
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

开发预览必须使用 `npm run tauri:dev`：独立产品名 **Ccode Dev**、窗口标题 **Ccode Dev - 热更新**、bundle ID
`com.ccode.dev.hmr`（`src-tauri/tauri.dev.conf.json`）。界面验证必须按该窗口标题或明确 `.app` 绝对路径定位，禁止用模糊应用名 `Ccode`。

## 本机环境档案（踩坑记录，新会话必读）

- **网络：访问 GitHub/raw/formulae.brew.sh 很慢**。必须用镜像：crates → rsproxy（已配）；rustup → TUNA；brew → `HOMEBREW_API_DOMAIN`/`HOMEBREW_BOTTLE_DOMAIN` 指 TUNA（已在 updater.rs 内置）；npm 如变慢 → `registry.npmmirror.com`。
- **brew 异常先 `brew doctor`**，别先怀疑应用代码。
- **macOS 钥匙串对未签名开发构建会因 cdhash 失配丢条目**——密钥存储弃用钥匙串，改 0600 `keys.json`（勿改回）。
- **管道输出块缓冲**：brew/npm 检测到非 TTY 会块缓冲导致"无输出"假象——安装/更新命令必须在 PTY 里跑（别退回管道）。
- **GUI 应用 PATH 很短**：打包应用可能找不到 npm 装的 CLI（开发模式不受影响）；统一经 `agents::resolve_binary` 候选目录兜底解析。
- **Windows 正式版没有父控制台**：后台 `git/cmd/netstat/tasklist/CLI --version` 等若直接 `Command::new` 会反复创建
  `conhost.exe` 闪窗；所有不需要独立可见窗口的命令必须走 `process::background_command`，统一加 `CREATE_NO_WINDOW`
  并在 spawn/wait 边界登记脱敏参数与生命周期。该包装和 250ms 进程扫描只在 Windows 生效；macOS/Linux 直接返回标准
  `Command`、不启动诊断监控线程。只有用户明确打开的外部终端允许保留可见窗口。
- **本机 CLI 安装情况**：claude/codex/gemini/qwen 为 brew 或 npm 安装（检测见 updater.rs 报告）；opencode 未装；kimi 为新版（~/.kimi-code）。
- **dev 端口为 17575**（`vite.config.ts` + `tauri.conf.json` devUrl 两处同步；勿改回 1420——Codex 桌面版 NetworkService 占用）。vite 撞已占端口静默退出；**stdin EOF 也自杀**——后台拉起必须 `tail -f /dev/null | npm run tauri:dev`。
- **git 提交**：常规提交加 `[skip ci]`，里程碑提交才跑三平台 CI。
- **git 推送走 SSH:443 + repo deploy key**；发版推 tag 后先用 `gh run list --workflow build.yml` 确认是否已产生该 tag 的 push run，已触发则只保留该 run；30 秒内未触发才执行 `gh api repos/hongtongzhou-design/ccode/actions/workflows/build.yml/dispatches -f ref=<tag>`。禁止让 tag push 与 workflow_dispatch 两个打包 run 并行写同一 Release。workflow 已配 `permissions: contents: write`（tauri-action 建 Release 草稿必需）。**仓库 owner 与 tauri.conf 升级端点绑定**（同为 `hongtongzhou-design/ccode`）：仓库若转移，本命令、updater endpoint、README 链接三处必须同步改。
- **CI 测试**：禁墙钟时序硬断言（runner 调度延迟不可控；只留内容语义断言 + 防挂死宽松兜底）；unix 专属语义（symlink/PTY/脚本）测试加 `#[cfg(unix)]`；路径断言用 `Path::ends_with`（Windows `\`）。

## 代码结构

```
docs/                        # 架构方案 + 九 CLI 适配参考（规格）
  conventions/               # 主题化约定细则（改动对应领域前必读，见「关键约定」索引）
src/                         # 前端 React + TS + Tailwind v4（vite 插件接入）
  pages/                     # 八页：配置⇄ 工作区⛁ 终端⌨ 对话◔ 技能✦ MCP⌗ 统计◫ 设置⛭
  components/                # WorkspaceReviewView、PipelineEditor（含「＋ 从模板追加」）、ProjectGroup/ProjectRail、ArtifactChecklist、TaskCardsSection、FileTree、
                             # FilePreviewEditor、PdfPreview/DocxPreview/ImagePairView、GitPanel、HandoffPicker/DigestPicker、
                             # KickoffConfirmDialog（开工确认弹层：TASK.md 预览/编辑（草稿优先）+ 旧简报并入兜底 + 技能区（含 MCP 归处标记）+ 人工事项区 + 主仓提醒）、
                             # StepSkillsChips（步骤推荐技能 chip 区：只读/可编辑两态）、
                             # HumanTasksList（人工事项清单 + useHumanTasks 共享逻辑）、StepFlow（步骤内协同流程线）、
                             # ScheduleSection（项目分组「◔ 定时任务」区块）、
                             # TemplatePickModal（注册成功后的研究流程模板选择层：五套内置模板 +
                             # 「不使用研究流程」（写 pipeline_opt_out 标记）/「稍后再选」（不留痕）两出口）、
                             # FuseDraftModal（「◈ 融合进任务书」预览编辑弹层：AI 融合稿可改后确认才写草稿）、
                             # TerminalStatusBar（终端底部常驻状态栏：模型/思考档可点切 + 📂 胶囊浮层改目录（仅未启动）+
                             #   git 芯片/保存/推送 + 状态点/时长/本会话 token，吸收旧中带底条） 等
  components/CommandPalette.tsx # ⌘K 面板
  pipeline-presets.ts        # 内置流水线模板 PIPELINE_TEMPLATES
  pipeline-start.ts          # 一键开步共享链路（renderTaskMd/gatherTaskMdExtras 单一出处，弹层预览与落盘共用）
  presets.ts                 # Base URL 供应商预设表（加供应商 = 加一行）
  mcp-presets.ts             # MCP 内置预设表（加预设 = 加一条；密钥一律 ${VAR} 引用）
  run-overview.ts            # 运行中聚合视图纯逻辑（按「要你管」排序）
  task-cards.ts              # 任务卡纯逻辑：按步骤分桶/卡片排序/会话按卡分组/卡片 kind（idea 想法卡 / draft 讨论卡）过滤
                             # （tests/task-cards.test.ts）
  step-flow.ts               # 步骤内协同流程线纯逻辑：种子→before→agent→during→after→评审节点链（tests/step-flow.test.ts）
  schedule-tasks.ts          # 定时任务纯逻辑：周期白话/相对时间/按 projectRoot 过滤（tests/schedule-tasks.test.ts）
  schedule-skill.ts          # 定时巡检「技能」下拉与默认任务名跟随纯逻辑（lit-watch 恒最前/默认「文献雷达」、
                             # 手改不覆盖、空库兜底，tests/schedule-skill.test.ts）
  inbox.ts                   # 收件箱分类胶囊纯逻辑：key 前缀→类别、分组、help dismiss 签名、人工请求通知 edge-trigger（tests/inbox.test.ts）
  notify.ts                  # 长任务 OS 通知（仅「待确认」跃迁 + 未聚焦 + 30s 去抖；「已回复」不通知）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑
  file-icons.ts              # 文件类型小徽标纯逻辑：扩展名 → 短标签 + 固定识别色（tests/file-icons.test.ts）
  workspace-visibility.ts    # 聚焦步骤工作区可见性过滤纯逻辑（不匹配任何步骤的手动工作区始终可见，
                             # tests/workspace-visibility.test.ts）
  git-commit-message.ts      # 空提交信息的本地默认信息生成
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  terminal-palettes.ts       # 终端调色板共享表（设置页与终端同源）：四套深色 + 四套配对浅色 twin，
                             # ANSI 16 色 + 光标 + 选区全在表内；resolvePaletteId 按主题亮暗自动换 twin
                             # （新增调色板须同步 settings.rs KNOWN_PALETTES，否则被静默丢弃，tests/terminal-palettes.test.ts）
  upstream-note.ts           # brew 最新但上游 npm 更高版本的提示
  command-palette.ts         # 命令面板过滤纯逻辑
  hotkeys.ts                 # 快捷键组合串纯逻辑
  themes.ts                  # 主题清单单一出处 + isLightTheme() 亮暗判定单一出处（禁另造判定）
  profile-copy.ts            # profile 跨 agent 复制纯逻辑
  store.ts                   # zustand 状态
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表：一个 CLI 一张规格（detect/launch_plan/env/技能分发/安装更新/官方账号 login/readonly_args 只读模式参数/
                             #   model_switch 运行中切模型（claude/gemini 直切、codex/kimi/opencode 唤选择器）与
                             #   effort_levels 思考档槽位（本期仅 claude /effort 实证，kimi/codex 待实机））
  agents.rs                  # 适配器分发入口 + resolve_binary 二进制解析（GUI 短 PATH 兜底）+ readonly_launch_args（聊想法只读注入）；
                             # 选择器显示名统一「配置名 · 模型」（claude _NAME 槽 / codex catalog display_name /
                             #   kimi KIMI_MODEL_DISPLAY_NAME / opencode provider+models name）
  model_registry.rs          # 模型能力注册表（同 pricing.rs 口径）：内置前缀表 + model-capabilities.json 覆盖 +
                             # 关键词推断兜底；kimi capabilities/max_context_size、codex context_window、
                             #   opencode reasoning/limit 共用；内置表宁缺毋滥（收错比漏报有害）
  profiles.rs                # ProfileStore：profiles.json + 0600 keys.json 存密钥
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（脱敏）
  global_config.rs           # 「设为全局」：agent 级事务批次写入（备份/回滚/恢复）；
                             # kimi 的 [models.*] 随写 display_name（配置名·模型，选择器 label 优先它）
                             # 与 capabilities（仅推断为思考模型时写，仅新版变体）
  projects.rs                # 项目档案卡（§11.3）：project.toml 读写、注册、资源登记/发现、一键开步、append_workspace_inbox、
                             # update_step_skills（步骤推荐技能读-改-原子写）、append_pipeline_steps（从模板追加：重名跳过、全跳过不落盘、
                             # 追加成功自动清 pipeline_opt_out）、set_pipeline_opt_out（「不使用研究流程」显式标记读-改-原子写）、
                             # 任务书草稿（read_task_draft/append_step_draft，
                             # .ccode/drafts/）、旧简报一次性并入草稿（list_legacy_briefs）、
                             # 任务卡 kind（idea/draft，旧卡按 step 推断）、fuse_card_into_draft（想法卡会话 ×
                             # 当前步骤草稿 → AI 融合稿，出站 redact_and_cap 不写盘）+ write_task_draft（确认后整份落盘）、
                             # 项目移除三档（移除注册 / purge_project_traces 清除 Ccode 痕迹保留文件夹 / delete_project_dir）
  pty.rs                     # PtyManager：spawn_tracked 公共拉起，agent/shell 复用
  sessions.rs                # 会话浏览：九 agent 会话扫描/解析（Codex .zst、OpenCode SQLite/JSON）、session_meta、pin 快照、
                             # 会话删除、注意力分类（session_tail_state）、步骤名映射（RX3a）、
                             # sessions_for_card（融合进任务书的按卡取会话：与列表同一归属口径）
  skills.rs                  # 技能库（§6.13）：SSOT 库 + symlink/copy 分发（cursor/grok 固定 copy）、四路导入、ZIP 导出、卸载备份、
                             # 漂移检测 resync、create_skill/update_skill_content；apps 表是创建时快照，
                             #   list 时现算补齐注册表新 agent 的缺键（否则一键应用永远漏新 agent，不写盘）；内置技能种子（seed_builtin_skills：
                             # include_str! 内嵌 src-tauri/resources/skills/ 14 个技能，启动幂等播种，不覆盖/不复活用户改动）、
                             # 内置技能更新（check_builtin_skill_updates 种子逐字节比对 + apply_builtin_skill_update
                             # 覆盖前备份 SKILL.md.bak-<yyyymmdd> 后原子写入）、产物冲突检测（frontmatter outputs
                             # 解析进 SkillDto，list 时现算；前端 skill-conflicts.ts 判定 + StepSkillsChips 警告行）
  mcp.rs                     # MCP 清单与分发（§6.15，规格 matrix §10）：统一模型→八家映射（grok 只读）、读-改-写一个键/段 + 备份 +
                             # 原子写 + 读回校验、JSONC 容错读、密钥引用转写（不落明文）、stdio 裸命令名 resolve_binary
                             #   绝对化 + node shim 深化、相对路径命令拒写（跨 agent 必挂，报错引导改绝对路径）
  usage.rs                   # 用量统计（§6.11）：usage 事件提取、usage_daily 按天聚合、任务成本归因、订阅口径、
                             # session_usage 单会话聚合（终端状态栏 token 段，先增量索引再按 session_id 汇总）
  pricing.rs                 # 内置定价表 + pricing.json 覆盖（写入校验）
  settings.rs                # 应用设置（settings.json）：字体/scrollback/汇率/镜像/主题/OS 通知/精确注意力/想法期只读保护
  claude_hooks.rs            # 精确注意力标记：写/移除 ~/.claude/settings.json hooks 段；事件日志按 session_id 取最新
  fonts.rs                   # 终端字体打包与 brew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层：一次性 prompt + 提交信息/摘要/PR 描述/冲突建议/提炼接力简报/评审沉淀起草生成；
                             # headless_task_args/run_agent_task 供 scheduler 复用（定时任务要写项目文件，codex 用 -s workspace-write）
  scheduler.rs               # 定时雷达（v3.75；v3.79 起技能可选）：schedules.json（每日/每周+时分，本地时区）、60s tick + 启动补跑
                             # （漏跑 coalesce 只补一次）、无头拉起 agent 在项目根跑技能（默认 lit-watch，prompt 按技能分派：
                             # lit-watch 专用文案不动、其他技能通用模板，10 分钟超时）、
                             # 历史留 20 条、跑完发 scheduler-run-done 事件（App.tsx 全局监听弹 OS 通知，复用长任务通知开关）
  citation.rs                # 引用健康检查：.md 引用键（[@key]/多键/[-@key]）对照 references.bib（白名单同 pdf.rs 口径）
  handoff.rs                 # 接力（§11.3 机制四）：简报生成（脱敏+64KB）、提炼接力（build_session_digest AI 蒸馏全会话 +
                             # finalize_digest_brief 初稿写回）、handoff_links 接力链登记/固化
  workspaces.rs              # 任务工作区（§6.10）：worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT、
                             # setup/archive 钩子、评审合并（health/merge/PR）、artifacts.yaml、
                             # 人工事项状态（human_task_checks 勾选 + human_target_hit 落点检测）、import_human_deliverable
                             # 交付导入（复制落点 + 登记提货单；v3.74 起 step/title 可选 + target_override 固定落点，
                             # 无步骤语境 = papers/imports/ 检索结果导入落主仓）、list_help_requests（.ccode/help-wanted.md 人工请求扫描）
  portwatch.rs               # 端口监控：LISTEN 列表、归属标注（cwd 最长前缀，回落 CCODE_PORT 段）、校验后 SIGTERM
  ws_settings.rs             # .ccode/settings.toml 三层合并（用户→仓库→local）；开步自动写 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk/勾选提交临时索引
  fs_tree.rs                 # 文件树与文件操作（删除走系统回收站 trash；重要路径删除保护，canonicalize 双校验；
                             #   家目录直下系统目录标 isSystem 供前端置灰）
  pdf.rs                     # PDF/docx 字节读取：read_pdf_bytes 白名单 + canonicalize + 上限，base64 传输
  updater.rs                 # CLI 安装/更新（brew TUNA、npm_for 同目录 npm）+ 应用自身 Tauri updater
  logbuf.rs                  # 诊断日志环形缓冲
  diagnostics.rs             # 诊断包：系统/WebView/GPU/输入法、功能开关、日志、进程生命周期采集与 ZIP 导出
  process.rs                 # 后台子进程统一创建（Windows CREATE_NO_WINDOW 防 conhost 闪窗）
  models.rs                  # 共享 DTO
  lib.rs                     # 模块与 Tauri command 注册
```

## 关键约定

以下硬约束**任何会话都必须遵守**；各领域的细则（评审覆盖层交互、流水线开步参数、步进器视觉规格、MCP 字段映射等）
已按主题迁入 `docs/conventions/`，改动对应领域前必读对应文件，日常会话不必加载。

- **密钥绝不回显/进 shell**：存 0600 `keys.json`，只在拉起瞬间注入子进程 env；`profiles.json` 只存尾号 key_hint；
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Ccode` 必须显式设置。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作（设为全局默认、Claude hooks 注意力开关、会话删除、工作树文件删除——
  工作树文件删除走系统回收站（trash crate）可反悔，四类均有备份/白名单防护口径，见 `docs/conventions/safety.md`）。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底；新增 CLI/工具调用点一律
  用它，禁直接 `which::which` 或裸名 spawn（候选目录清单见 `docs/conventions/safety.md` 对应实现 `agents.rs`）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。

### 主题约定索引（改动前必读对应文件）

| 领域 | 文件 | 覆盖内容 |
|---|---|---|
| 安全与数据防护 | `docs/conventions/safety.md` | 密钥/脱敏细节、git 提交与逐 hunk 验收、多阶段 Git、profile 三层验证、会话/配置写操作口径、诊断包、MCP 分发与技能导入导出、CLI 更新、PDF/笔记白名单 |
| 终端与工作台 | `docs/conventions/terminal.md` | PTY 回落 shell、标签持久化白名单、评审/冲突覆盖层、改动面板、收件箱与注意力规则、键盘流、分屏、关窗守卫、WebGL 探针 |
| 流水线与项目域 | `docs/conventions/pipeline.md` | 工作区创建/漂移/归档/删除、流水线开步/模板/编辑器、接力与提炼接力、任务卡、人工事项与讨论种子、agent 人工请求（help-wanted）、收件箱分类胶囊、示例课题、白话双层 |
| 步骤工作面板 | `docs/conventions/step-panel.md` | **新增步骤/模板前必读**：七条硬规则（顺序即语义、空节点不出现、同一事实只说一次、孤立按钮、主路径唯一不设门控、角色标注）、问题该在什么时刻与层级出现（项目层/决策项/按需问/种子/人工事项五选一）、文案与术语、新增模板检查清单 |
| 主题与设计系统 | `docs/conventions/design-system.md` | 主题令牌、字体栈、线条语言、控件密度、页面框架、对话页三栏、步进器规格、已否决设计 |

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
  主线 + 白话翻译：✓ 验收合并/⚙ 自动保存/◔ 保存）、**Claude Code hooks 精确注意力标记 ✅**（设置页显式开关，claude_hooks.rs，
  见架构 v3.32）、**内置技能种子 ✅**（v3.64：14 个内置技能 = 9 个原有补强 + 5 个外部仓库内化，include_str! 播种、不覆盖不复活，
  五套流水线模板按步骤挂载）、**定时雷达 ✅**（v3.75：scheduler.rs 每日/每周无头巡检 + lit-watch 多源精选升级，
  约定见 conventions/pipeline.md「定时雷达」）、**模板重设计与接壤 ✅**（v3.78：五套模板内容重设计（种子对准拍板点/技能挂载核对/
  学术 MCP 人工事项）+ 产物路径接壤（投稿与返修接综述/科研论文成稿）+ 编辑器「＋ 从模板追加」）；批量验收、云端会话双源调研留 backlog
- **Backlog（记录不动手）**：SSH 远程执行、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（P2 验证后
  评估）、批量验收、云端会话双源调研、首启引导完整版（示例课题最小版已落地：工作区空态「✦ 创建示例课题（演示）」→
  `create_demo_project`，演示 PDF/引文/综述流水线齐备；完整版引导的更丰富演示数据留 backlog）、工作区类型驱动默认值（数据类跳端口）

**当前待办**：

- P0 收尾当前批次：全量文档同步 → 走查 → [skip ci] 提交 → 可选发版
- **定时任务与研究流程结合（细目见架构 §11.4 Backlog 细目）**：边界已定——不给每步配定时任务，
  结合点是「产出回流」（进收件箱 / 关联步骤 / 复用 staleUpstream 口径）而非「配置下沉」。
  同时记了三条已确认风险：写权限九家不齐（仅 codex 有沙箱、grok 用 --yolo、qwen 未验证）、
  产出绕过验收层（cwd 是项目根不是 worktree）、10 分钟超时与真失败不可分。
  先做能力标注 + 落点收敛，跑进工作区属定位决策待拍板
- macOS 签名公证（暂缓，需 Apple Developer 会员 + CI 配 6 个 APPLE_* secrets，见架构 v1.3）
- Intel macOS 安装包（暂缓：CI macos-latest 只出 aarch64；加 `x86_64-apple-darwin` target 构建时间翻倍，真有 Intel 用户再加，
  见架构 v1.3 / README 安装节）
- OpenCode Windows 数据路径未核实（matrix 标注「文档与源码不一致」），Windows 用户验证会话/用量统计后修正
- Skills 一键更新 ✅：更新检测（check_skill_updates）+ 检测后一键应用更新（apply_skill_update，v3.53）均已落地
