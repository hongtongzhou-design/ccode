# AGENTS.md

> **规则沉淀（用户指令）**：每次重大改变，把由此确立的**规则/约定/决策**记录到本文件（关键约定、主题与设计系统、本机环境档案）和 `docs/architecture.md` §10 决策记录。**不记操作流水账**——代码和 git 历史本身就是操作记录，这里只留"以后必须遵守什么"。
>
> **文档同步（用户指令）**：功能增改时必须同步更新 `docs/user-guide.md`（用户操作手册）；发版本时同步更新 `CHANGELOG.md`（版本更新日志）。

## 项目简介

Ccode 是一个「AI 科研工作台」桌面应用（Tauri v2 + React/TS）——底层是八个 Agent CLI 的统一控制台（启动器 + 配置中心 +
会话监控台），表面是科研流水线（读文献→整数据→做图→写论文）：AI 负责干活，Ccode 负责管活，人负责拍板。
为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI 管理多套 API 配置
（端点/密钥/模型），内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

**设计文档即规格**：改架构/适配逻辑前先读 `docs/architecture.md`（总体设计）和 `docs/agent-integration-matrix.md`
（八个 CLI 的 env/配置/会话格式，源码级调研结论，勿凭印象写 env 变量名）。

**参考实现（长期有效）**：`.reference/` 下三个开源项目浅克隆，实现新功能前先查有没有成熟方案可借鉴：

- `.reference/cc-switch`（Tauri2+React+SQLite）：provider 预设/一键导入、双向同步回写保护、本地代理与故障转移、原子写入、测速、托盘速切、导入导出
- `.reference/waveterm`（Electron+Go+SQLite）：block/workspace 对象模型与持久化、"named = saved" 留存语义、badge 注意力标记与 hooks 联动、滚动缓冲区序列化恢复、namespaced meta 键体系
- `.reference/vscode`（blobless 浅克隆）：Explorer 文件树、编辑器 tab 与 split、面板布局、终端标签列表；目录索引在 `src/vs/workbench/contrib/`

借鉴原则：学机制和取舍，不抄代码；冲突时以 `docs/architecture.md` 为准（不走本地代理主线、会话解析坚持只读）。镜像可随时 `git -C .reference/<repo> pull` 更新。

**已确认的产品决策**（用户拍板，勿擅自更改）：

- 应用名 **Ccode**；八个 agent 全部支持（CodeBuddy Code、Cursor CLI 见 matrix §7/§8）
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
docs/                        # 架构方案 + 八 CLI 适配参考（规格）
src/                         # 前端 React + TS + Tailwind v4（vite 插件接入）
  pages/                     # 七页：配置⇄ 工作区⛁ 终端⌨ 对话◔ 技能✦ 统计◫ 设置⛭
  components/                # WorkspaceReviewView、PipelineEditor、ProjectGroup/ProjectRail、ArtifactChecklist、FileTree、
                             # FilePreviewEditor、PdfPreview/DocxPreview/ImagePairView、GitPanel、HandoffPicker 等
  components/CommandPalette.tsx # ⌘K 面板
  pipeline-presets.ts        # 内置流水线模板 PIPELINE_TEMPLATES
  pipeline-start.ts          # 一键开步共享链路（三处 TASK.md 同一出处）
  presets.ts                 # Base URL 供应商预设表（加供应商 = 加一行）
  run-overview.ts            # 运行中聚合视图纯逻辑（按「要你管」排序）
  notify.ts                  # 长任务 OS 通知（跃迁 + 未聚焦 + 30s 去抖）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑
  git-commit-message.ts      # 空提交信息的本地默认信息生成
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  terminal-palettes.ts       # 终端调色板共享表（设置页与终端同源）
  upstream-note.ts           # brew 最新但上游 npm 更高版本的提示
  command-palette.ts         # 命令面板过滤纯逻辑
  hotkeys.ts                 # 快捷键组合串纯逻辑
  themes.ts                  # 主题清单单一出处
  profile-copy.ts            # profile 跨 agent 复制纯逻辑
  store.ts                   # zustand 状态
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表：一个 CLI 一张规格（detect/launch_plan/env/技能分发/安装更新/官方账号 login）
  agents.rs                  # 适配器分发入口 + resolve_binary 二进制解析（GUI 短 PATH 兜底）
  profiles.rs                # ProfileStore：profiles.json + 0600 keys.json 存密钥
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（脱敏）
  global_config.rs           # 「设为全局」：agent 级事务批次写入（备份/回滚/恢复）
  projects.rs                # 项目档案卡（§11.3）：project.toml 读写、注册、资源登记/发现、一键开步、append_workspace_inbox
  pty.rs                     # PtyManager：spawn_tracked 公共拉起，agent/shell 复用
  sessions.rs                # 会话浏览：八 agent 会话扫描/解析（Codex .zst、OpenCode SQLite/JSON）、session_meta、pin 快照、
                             # 会话删除、注意力分类（session_tail_state）、步骤名映射（RX3a）
  skills.rs                  # 技能库（§6.13）：SSOT 库 + symlink/copy 分发（cursor 固定 copy）、四路导入、ZIP 导出、卸载备份、
                             # 漂移检测 resync、create_skill/update_skill_content
  usage.rs                   # 用量统计（§6.11）：usage 事件提取、usage_daily 按天聚合、任务成本归因、订阅口径
  pricing.rs                 # 内置定价表 + pricing.json 覆盖（写入校验）
  settings.rs                # 应用设置（settings.json）：字体/scrollback/汇率/镜像/主题/OS 通知/精确注意力
  claude_hooks.rs            # 精确注意力标记：写/移除 ~/.claude/settings.json hooks 段；事件日志按 session_id 取最新
  fonts.rs                   # 终端字体打包与 brew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层：一次性 prompt + 提交信息/摘要/PR 描述/冲突建议生成
  handoff.rs                 # 接力（§11.3 机制四）：简报生成（脱敏+64KB）、handoff_links 接力链登记/固化
  workspaces.rs              # 任务工作区（§6.10）：worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT、
                             # setup/archive 钩子、评审合并（health/merge/PR）、artifacts.yaml
  portwatch.rs               # 端口监控：LISTEN 列表、归属标注（cwd 最长前缀，回落 CCODE_PORT 段）、校验后 SIGTERM
  ws_settings.rs             # .ccode/settings.toml 三层合并（用户→仓库→local）；开步自动写 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk/勾选提交临时索引
  fs_tree.rs                 # 文件树与文件操作（重要路径删除保护，canonicalize 双校验）
  pdf.rs                     # PDF/docx 字节读取：read_pdf_bytes 白名单 + canonicalize + 上限，base64 传输
  updater.rs                 # CLI 安装/更新（brew TUNA、npm_for 同目录 npm）+ 应用自身 Tauri updater
  logbuf.rs                  # 诊断日志环形缓冲
  diagnostics.rs             # 诊断包：系统/WebView/GPU/输入法、功能开关、日志、进程生命周期采集与 ZIP 导出
  process.rs                 # 后台子进程统一创建（Windows CREATE_NO_WINDOW 防 conhost 闪窗）
  models.rs                  # 共享 DTO
  lib.rs                     # 模块与 Tauri command 注册
```

## 关键约定

- **密钥绝不回显/进 shell**：存 0600 `keys.json`，只在拉起瞬间注入子进程 env；`profiles.json` 只存尾号 key_hint；
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Ccode` 必须显式设置。
  **外部恢复/复制恢复命令不携带 profile env**（`agents::resume_command_line`，⇗/⧉ 共用）；⇗ 拉起：CLI 用绝对路径
  （`resolve_binary`，⧉ 复制命令才用裸名）、shell 必须 `-l -i` 交互登录（非交互不加载 `.zshrc` 的安装器 PATH）。
  **Ghostty** 走 AppleScript（`open -n` 堆实例、不带 `-n` 不投递 `--args`）：激活 → ⌘N → 剪贴板粘贴命令 + 回车
  （用后还原；首次需用户授权自动化）。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。
- **Profile 的 extra_env 排在 adapter 内置 env 之后注入**，供用户覆盖内置值（CommandBuilder 后者生效）。
- **终端行为**（用户明确要求；配色 = VS Code Dark+ 调色板，集中在 `TerminalPage.tsx` 的 `theme` 一处）：
  - 「停止」或 agent 退出后必须**自动回落用户登录 shell**（`$SHELL -l`，同 cwd），不死在最终画面；手动 `exit` 不自动
    重开；回落 shell 不带 profile env；agent/shell 共用 `pty.rs` 的 `spawn_tracked`，退出事件按 PTY 类型区分。
  - **重启只恢复标签元数据，不恢复 PTY**：白名单限 label/cwd/agent/profile/model/sessionId，禁存 PTY id/scrollback/密钥/
    env/run 脚本；重开后为「上次任务，可恢复」占位，点击才建新 PTY；目录/profile 失效留在可编辑启动栏提示，禁自动换目标。
  - **预览编辑器不映射同名文件**：切项目/工作区/标签 cwd/树根时清空旧预览，由用户在新根重选，禁自动打开新根同相对路径
    文件；有未保存改动先确认，取消则不切根；主仓库文件保存按钮警示色 + 二次确认。
  - **任务审阅 = 终端全宽覆盖层**：工作区行「评审」与终端「改动 → 审阅」同一视图，连续浏览累计 diff，可「提交并合并 /
    仅提交 / 合并并归档」；底下终端标签与 PTY 保持挂载。默认合并只落本地主分支并保留工作区，不自动推送；原「提交 /
    提交并推送」与工作区行合并/PR/归档/会话操作保留。`merged_at && ahead == 0` 时合并按钮禁用显示「已合并」，`ahead > 0` 恢复。
  - **冲突审阅与普通审阅共用同一覆盖层**：冲突模式读 Git index stage 2/3，任务/基准分支按文件连续双栏，右侧冲突清单可
    定位，逐文件/全部选边与 ◈ AI 建议同屏；禁第二套冲突解决器；入口用「开始解决冲突」任务语言。全部选边默认串联「提交
    解决结果 → 健康检查 → 合并（保留工作区）」，另保留「仅保存解决结果」；提交成功而合并失败必须提示部分成功，不自动
    重做 merge commit。「解决冲突」后干净工作区必须自动以**当前基准 tip** 准备两侧（完成前禁以 merge-base diff 冒充）；
    处理中基准前进立即停止展示和选边，经用户确认 `merge --abort` 后重新同步。评审入口以 intent 区分
    （`WorkspaceReviewRequest.action`：pr/archive/resolve-conflict）：仅 `resolve-conflict` 允许自动同步基准、准备冲突两侧。
  - **评审覆盖层以代码为中心**：顶部固定任务/分支/增删统计与唯一主动作，提交信息和批量冲突操作在第二工具行；右侧只做
    文件搜索/树形定位/简短进度；diff 连续浏览、标题吸顶、长段未修改折叠，右侧选中随主区滚动同步；冲突选边用文件标题下
    紧凑双侧控件，AI 理由单行展示、用户显式执行。
  - **改动面板空信息走本地快速提交**：非空原样提交；为空按文件状态/数量即时生成中性默认信息直接执行 `git_commit`，不
    为此启动 AI；失败保留默认信息供重试；◈ 按钮与手动输入保留，仅主动点 ◈ 才调 AI。
  - **终端右栏统一称“对话”，有界实时视图**：仅最近 50 条；标题/agent/会话 ID/状态与「完整回放」入口收进右栏页签行右侧
    （页签行与对话头部合并为一行）；在底部附近才自动跟随，向上阅读后禁强制滚动，改显示“有新消息”。
  - **终端左栏两段化（v3.42）**：常驻 = 项目区（ProjectRail）+ 文件树；「打开的标签」折叠区已删除（runInputs 镜像保留）；
    「最近项目」收进文件树搜索行 ⌄ 浮层（真进入/↗ 新标签语义不变）；区间靠留白分层。**项目区固定列出所有建有活跃
    工作区的项目**（每仓一小节：组头 + 主文件夹节点 + 活跃工作区行），cwd 命中的当前项目置顶标注「当前」、无活跃
    工作区也保留；行内交互（真进入/悬浮/size-2 状态点）不变。
  - **右栏可调分栏，不新增普通内容全屏路由**：左缘拖拽调宽并记忆；宽屏动作暂隐工作树但保留终端，再执行恢复，双击
    对话/预览/改动页签同义；宽度变化必须触发 xterm 重新 fit；任务评审仍用全宽覆盖层。
  - **WebGL 渲染器加载前必须过 `isSoftwareWebGL` 探针**（TerminalPage.tsx）：Windows/WebView2 GPU 被拉黑时退回
    SwiftShader 软件渲染，上下文能建但终端持续闪烁，try/catch 拦不住；探测失败同样不用 WebGL，勿删此兜底。
  - **运行中会话关联排他 + 复合键**：固定 session id 的 CLI 精确锁定；其余 CLI 启动前按 agent+归并后项目登记 claim，同批
    并发统一排序分配，已分配会话进程内不得转给另一标签；前端 live/open 一律以 agent+sessionId 为键，完整回放跳转前先刷新索引。
- **首页「待你处理」收件箱（v3.39；v3.42 起横跨项目导航与详情两栏之上）**：聚合工作区冲突/可合并 + 终端注意力（待确认/
  已完成），排序 冲突 > 待确认 > 可合并 > 已完成，为空整块不渲染；终端运行状态经 `terminalRunInputs` 镜像进 store 跨页
  只读（TerminalPage 唯一写入方，不新增轮询）；跳终端激活标签走一次性 `focusTabReq`（已关闭标签静默忽略）。
- **产物核验清单（v3.42；v3.45 起从胶囊移到任务行；v3.46 起步进器圆后小方块同面板）**：共享组件 `src/components/ArtifactChecklist.tsx`（步骤按 workspaceName 反查
  project.toml，定位根由调用方给：已合并读项目根/main，其余读工作树）；任务行「产物」按钮（hover 才现，与 ⌨ 终端同档）在行下方
  就地手风琴展开，展开态按工作区 id 记忆在 WorkspacesPage、切项目清空；步进器圆后小方块在 strip 下方就地展开，展开态记步骤 index（单开）；面板 = 已产出 ✓/未产出 — + mtime 相对时间 + 10 分钟内
  「刚更新」标记 + 手动 ⟳ 刷新（打开时拉取一次，不进轮询）；选段反馈浮动条带「↵ 直接发送」（pty_write 一次拼接 \r，同帧到达防半截输入）。
- **沉淀为技能（v3.42）**：md/PDF 选段浮动条「✦ 沉淀为技能」→ `ai_distill_skill`（脱敏 + 8KB 截断 + JSON 容错解析）→
  `skillDraftReq` 一次性请求 → 技能页新建弹窗预填，保存走既有 create_skill（重名拒绝）。
- **模型 combo-box（v3.42）**：启动栏模型 = 可输可选（profile 预设 + `ccode.modelHistory.<agent>` 历史去重，上限 10 条），
  启动成功即记历史；「新增模型」不再是配置概念。
- **评审一键开下一步（v3.42）**：开步链路单一出处 `src/pipeline-start.ts`；评审覆盖层合并成功且保留工作区时，成功横幅
  给出「▶ 开始下一步：步骤名」——下一步 = 同名步骤之后第一个无同名工作区（含已归档）的步骤；无下一步/未注册/无流水线
  只显示合并成功横幅；「合并并归档」成功即关覆盖层，不出此入口。
- **键盘流（v3.40/v3.41）**：⌘K 命令面板（过滤纯逻辑在 `command-palette.ts`）、⌘1–⌘7 页切（顺序同侧栏）、⌘\ 执行态隐藏
  侧栏（`chromeHidden`，session 级）；⌘F 已被终端搜索占用。主题清单单一出处 `src/themes.ts`。绑定可自定义（设置页录制，
  `hotkeys.ts` 组合串，空串=禁用，settings.json 三字段）。通知动作 `ccode.attention` → 聚焦窗口 + 回首页收件箱；通知
  extra 带 tabId/cwd/kind，已完成且 cwd 命中工作区直达评审覆盖层，其余聚焦标签；收件箱经 `session_tail_state` 直查外部
  live 会话（≤10 条）。
  - **终端分屏（SplitView）只是显隐与排序变化**：全部标签仍在同一容器保持挂载，靠 flex order 把活跃标签（左）与对照标签
    （右）排到分隔条两侧，禁止把标签移进第二棵子树（会重挂载杀 PTY）；右栏/文件树/改动跟随「活跃 pane」（点击切换，
    focusedId），分屏时两个 pane 的 PTY 都推流；分屏状态不进持久化白名单，仅分隔比例本地记忆。
  - **关标签/关窗进程守卫**：仅 `running && ptyId` 的 agent 标签弹确认（shell/已退出一律不弹），存活判定以后端
    `pty_has_running_process` 为准，命令不存在/报错时静默跳过不阻塞关闭；关窗前对全部在跑标签统一确认一次，确认后放行
    （allowWindowCloseRef 防 onCloseRequested 重入）。Tauri 的 `onCloseRequested` 前端封装最终调用 `window.destroy()`，且确认后
    会调用 `window.close()`；`src-tauri/capabilities/default.json` 必须同时保留 `core:window:allow-destroy` 与
    `core:window:allow-close`，否则进入终端页挂载监听后窗口无法关闭。
- **普通仓库与工作区提交语义分开**：普通仓库默认不选文件，`git_commit(paths)` 与 AI 提交信息只处理用户勾选且仍在当前
  status 的安全相对路径（literal pathspec）；工作区任务始终提交全部任务改动，禁止把选择提交扩散到 worktree 流程。
- **Git 改动列表的单文件 diff 必须安全且可展开**：普通仓库只读当前 status 中经安全校验的相对路径，工作区只读当前累计
  任务 diff 中的路径；未跟踪文件按全新增展示，二进制只提示，单次读取/展示设上限并明确截断。对话页只读展示“当前项目
  改动”，必须声明它不是历史快照，禁止提交或推送。紧凑 diff 增删行**整行铺语义深底**（bg-ok/bg-err，v3.36 定稿），hunk
  标题 inset 底。**改动面板主从分栏（v3.36）**：点文件行 = 左栏 diff 主区 + 右栏紧凑文件列（右栏保持勾选框与状态徽标）；
  WKWebView 不显示 title 悬浮，操作入口用可见提示（hover 才现小字）。
- **逐 hunk 验收只覆盖未提交改动，hunks 一律取未暂存 diff（工作树 vs 暂存区）**：丢弃 = `git apply -R` 回工作树、暂存 =
  `git apply --cached` 上暂存区（`git_file_hunks`/`apply_hunk`，白名单同单文件 diff；补丁必须再经
  `patch_targets_single_file` 校验只指向该文件）；已提交的累计 diff（评审 merge-base diff）禁止逐 hunk。新文件整个算一个
  块（暂存 = 跟踪，丢弃 = 删文件）。**勾选提交遇部分暂存文件必须走临时索引提交**（`commit_selected_with_index`：
  `commit -- paths` 是工作树语义会把未暂存块一起带走；提交成功后按路径 `git reset -q HEAD --` 同步真实索引消幻影 MM），
  未暂存块保持未暂存，未勾选文件的暂存内容不得被波及。
- **工作区创建是补偿事务**：先以 SQLite `BEGIN IMMEDIATE` 原子预留端口并写 `creating`，再创建 worktree/复制文件/激活；
  任一步失败必须移除 worktree、prune、删分支、删 creating 行并释放端口。复制错误不得忽略；setup 失败维持非阻断。
  `ready_to_merge` 必须要求 `ahead > 0`，空工作区禁止合并。
- **工作区漂移修复必须显式且非破坏**：仓库/分支/worktree 缺失、注册不一致、归档记录与磁盘冲突、merge 进行中都由
  `workspace_drift` 先诊断并暂停普通危险动作；重新挂载/重新定位可修复实体，标记归档/清理记录只改元数据，不得删目录或分支。
- **工作区归档是无损操作，删除才允许强制**：归档前必须重新检查 merge 状态、未提交改动和该工作区内仍运行的 agent/run
  脚本；任一存在即拒绝。脏工作区只允许走「提交并归档」，提交成功而归档失败后只能重试归档，禁止重复提交。归档移除
  worktree 禁用 `--force`；`git worktree remove --force` 只允许用于用户明确确认的「删除工作区」。最终合并失败必须自动
  `git merge --abort`，不得把主仓库留在冲突状态。
- **项目目录彻底删除（delete_project_dir）防护口径**：必须是 Ccode 项目（`.ccode/project.toml`、注册记录、工作区记录
  三者有其一）才允许删；拒绝 home/document_dir 本身、少于两级的浅层路径与 fs_tree 重要路径黑名单；该 repo 全部工作区
  逐个走删除实现（允许 force 移除 worktree），任一失败即中止且已删不回滚（错误说明已删哪些），再删目录与注册记录。
- **多阶段 Git 操作必须返回结构化阶段结果**：commit/push、merge/archive、push/PR 任一后阶段失败时，前阶段成功事实必须
  保留并明示；UI 只重试失败阶段，禁止把部分成功显示成整体失败或诱导重复提交、重复合并。
- **全局配置写入/恢复按 agent 整批事务处理**：先生成并验证全部目标内容，再为同批目标建清单备份、写完并同步全部临时文件，
  最后替换；中途失败自动回滚整批。恢复必须选最近一个完整批次，恢复前先备份当前状态，且不得移动/消耗原恢复点。
- **Profile“保存成功”不等于“可用”**：验证固定三层——本地字段/活配置解析、CLI doctor/启动预检、最小 API 请求；密钥仅在
  Rust 层参与验证，结果统一脱敏。「设为全局」成功后必须自动执行本地与 CLI 配置复检。
- **技能同名导入不得静默跳过**：导入返回 added/updated/skipped/conflicts；覆盖前备份、另存为校验单段安全名称，ZIP 先
  staging，元数据保存失败回滚。GitHub 来源保存 repo/ref/subdir/revision；**一键应用更新**（`apply_skill_update`）按记录的
  repo/ref/subdir 重下并只覆盖同名技能（`import_zip_impl` 的 `only` 过滤，同仓库其他技能不新增不覆盖，走同一覆盖+备份
  路径），上游改名/移动时明确报错并引导手动重新导入；手动重新导入仍走冲突确认。新建/编辑
  走 `create_skill`/`update_skill_content`：重名拒绝并引导改用「编辑内容」；编辑经临时目录走既有覆盖路径（覆盖前备份、
  辅助文件保留、source/repo 不改写）；◈ 优化开终端让 Agent 直改库文件，备份兜底仍靠保存/覆盖路径。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作：
  1. 「设为全局默认」（写前必须备份）；
  2. **精确注意力标记开关**（claude_hooks.rs 写 ~/.claude/settings.json hooks 段：写前备份 + 原子写、只动 hooks 键、已有
     hooks 追加不覆盖、关闭只删含 `hooks-state/claude-hooks.jsonl` 的条目并回收空壳键、配置损坏拒绝写；开关走
     `set_claude_hooks_attention` 单命令落应用设置，失败回滚，禁前端单独 patch `claudeHooksAttention`）；
  3. 会话删除（delete_session/delete_project_sessions：canonicalize 根校验 + **已知会话数据子目录 + 会话后缀白名单**，
     同根 auth.json/settings.json 等一律拒绝；**Cursor 不走目录级白名单**（~/.cursor 与 IDE 共享），由 `cursor_deletable`
     限定 `projects/*/agent-transcripts/**/*.jsonl`；OpenCode 事务删库行且 db 必须等于已知 opencode.db；Codex resume 链删除
     连带成员文件）；
  4. 工作树文件删除（限定树当前根 + 重要路径黑名单：系统目录/关键用户目录/CLI 配置/.git 一律拒绝；黑名单 canonicalize
     双校验堵 symlink 绕过）。
- **codex 默认沙箱**：交互启动注入 `-s workspace-write`（只能写当前目录），AI 无头调用 `-s read-only`；用户可用
  extra_env/参数覆盖。
- **二进制解析统一走 `agents::resolve_binary`**：先 which（继承 PATH），miss 时按平台候选目录兜底（macOS 用户目录
  `~/.npm-global/bin`/`~/.local/bin`/`~/bin`/`~/.kimi-code/bin` **先于** `/opt/homebrew/bin`；Linux `~/.local/bin`，
  Windows `%LOCALAPPDATA%\Programs`/`%APPDATA%\npm`）；新增 CLI/工具调用点一律用它，禁直接 `which::which` 或裸名 spawn。
- **诊断包是脱敏的有界快照**：设置页一键导出到 `~/Downloads/ccode-exports/`，包含 Windows/WebView2/GPU/WebGL、
  语言与输入法、当前功能开关、应用日志及自应用启动后的子进程生命周期；进程记录为内存环形缓冲，不读取环境变量，命令参数
  与日志在导出前必须经 Rust 层脱敏。ZIP 内只放 UTF-8 JSON/TXT，保证从 Windows 带回 macOS 后无需 Ccode 或 Windows 工具
  即可离线分析。系统级活动只额外观察 CTF/TextInputHost，禁止借诊断之名采集无关应用的命令行。
- **「是否 git 仓库」探测带 30s 负缓存**（`git_info::probe_is_work_tree`）：轮询入口（git_status/git_status_map）对非仓库
  cwd 不得每轮真 spawn git（诊断包实测 Windows 安装版 85 秒 73 次同目录探测）；只缓存否定结果，应用内 `git init` 成功后
  必须调 `invalidate_repo_probe` 主动失效。**跨路径比较先统一 canonicalize 口径**：Windows 上 `canonicalize` 带 `\\?\`
  前缀，与 `dirs::home_dir()` 等未规范化路径直接比较会静默失效（recent_repos 的 home 排除曾因此被绕过）。
- **WebGL 探针的「renderer 不明」保守回退仅限 Windows**：`diagnostics.ts webglUsable`——WKWebView 等平台可能屏蔽
  debug renderer 信息但 GPU 正常，不得全局按软件渲染处理。
- **npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**（用错 npm 会把包装进另一个 prefix）；brew 安装的 CLI 一律
  走 `brew upgrade`。
- **交互式 TUI 自更新不走 run_streaming_pty**：kimi/opencode 的 `upgrade` 是方向键选择界面，行输入无法应答——规格标
  `PackagingSpec.interactive_tui`，`check_agent_updates` 按与 update_agent 同一套渠道判定（`updater::interactive_self_update`）
  带出预填命令；配置页「新版/更新」命中时改走 `setPendingTerminal`（shellOnly + prefillCommand，同官方账号登录机制）开
  完整终端让用户方向键操作，普通渠道零变化。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- 三平台兼容：禁写平台特定路径，用 `dirs`/`keyring`/`portable-pty` 的抽象。
- UI 文案用中文；代码注释用中文、只在非显而易见处写（参照现有文件风格）。
- 前端不直接碰文件系统，一切经 Tauri command；流式输出走 `pty-output-<id>` 等事件。
- **流水线开步是预设参数的组合调用**（架构 §11）：点「开始」= 建工作区 + 启 Agent + 注入简报 + 落 TASK.md，复用既有
  工作区创建与终端启动；不破坏手动启动栏「Agent → profile → 模型 → 目录 → 启动」主流程。**invoke 链路单一出处
  `src/pipeline-start.ts` 的 `startPipelineStep`**（ensure git → bootstrap 提交 → 建工作区 → 提货单/技能元数据 → TASK.md →
  run 脚本 → 终端交接），工作区页步进器大圆与评审「开始下一步」共用，组件态由调用方回调注入。开步在 ensure_git_repo 后先走
  `commit_project_bootstrap`（best-effort）：只把 `.ccode` 与 `.gitignore` 提交进主仓（literal pathspec，用户暂存文件
  绝不带走），防评审合并被主仓脏拦截；默认 .gitignore 含 `*.pdf`。**TASK.md 不进 git**：落盘时自动追加进
  `.git/info/exclude`（`exclude_task_md`，全 worktree 与主仓生效，best-effort 不阻断）——TASK.md 是开步脚手架而非任务产物。
- **流水线模板库**：内置模板集中在 `src/pipeline-presets.ts` 的 `PIPELINE_TEMPLATES`（综述/科研论文/数据处理/毕业论文/投稿与返修），
  新增场景 = 数组加一项，简报必须遵守输入写死/决策写死/交付写死约定（auto 模式无歧义）；用户模板走后端
  `list/save/delete_pipeline_template`，选择器（TemplatePicker）合并展示，后端命令未就绪时优雅降级为仅内置模板。
- **流水线编辑器（RX1）是步骤编辑唯一入口**：`src/components/PipelineEditor.tsx` 全宽覆盖层（fixed inset-0 z-30，与评审
  覆盖层同级），每步一张卡片（名称/工作区名/简报/预期产物/run 脚本/资源绑定），整体写回 steps；新增步骤相关编辑一律进
  编辑器，不再开第二套入口。`ProjectStepDto.resources?: string[]` = 资源绑定（`[[resources]]` 条目的 path），**空/缺省 =
  全部资源**；`renderTaskMd` 只在绑定非空时过滤「项目资源」段（单一出处在 `pipeline-start.ts`）。
- **官方账号 profile 只读检测 + env 净化**：CLI auth 文件只读探测「已连接」，断开引导用户用 CLI 自己的 logout；官方账号
  拉起不注入 API env，且必须 `env_remove` 同协议残留 API 密钥变量（防静默覆盖账号登录）；统计页官方账号显示「订阅」不计费。
  **API Key 模式不算官方账号**：凭证字段表只认 OAuth token 字段；`OfficialAccountSpec.api_key_fields`（codex =
  `OPENAI_API_KEY`）命中时显示「API Key 配置」而非「已连接」——官方 `--api-key` 与第三方中转（cc-switch 等）写出的
  auth.json 形状相同，文件层面无法区分，不得冒充官方账号。
- **技能分类批量回填**：`backfill_skill_categories` 只给「GitHub 来源 + 无分类」的技能补仓库名分类（自动分类 #15 之前的存量导入），已有分类一律不动、幂等；入口在技能页顶部 ⋯。
- **「接力」是唯一的跨 Agent 交接表述**：接力 = 结构化简报落成文件 + 新 Agent 带简报启动 + 记录接力链，明示不是记忆转移；
  禁用「无缝继续」。v1 机制（handoff.rs）：简报全文过 `redact_sensitive_text` 脱敏 + 64KB 上限后原子写
  `cwd/.ccode/handoff-<时间>.md`（自定义路径不得出项目根）；接力链先按 agent+cwd 登记 `handoff_links`，新会话被扫描到时
  固化进 `session_meta.handoff_from_*` 并消费登记（防同目录后续会话误标）；kimi/opencode 无启动注入参数，走复制简报路径 +
  手动发送，不得伪造注入成功。
- **科研语义只进模板/数据/技能包**：流水线步骤、任务简报、技能包都是可编辑预设；引擎保持通用，不在逻辑里写死「文献/数据/
  论文」概念。
- **示例课题（首启引导最小版）**：`projects::create_demo_project` 在「文档/Ccode 示例课题」幂等生成演示项目（英文综述五步
  档案卡 + `build_demo_pdf` 手工拼 xref 的单页示例 PDF + references.bib + README）；已注册直接返回现有 project，目录已存在
  但未注册时**只注册、不补建不覆盖**；git 初始化失败报错、bootstrap 提交 best-effort。前端入口 = 工作区空态「添加项目」旁
  次级按钮；侧栏底部「设置」上方另有常驻「⌘K 命令面板」发现入口（键位标签随自定义绑定）。
- **界面白话双层呈现（双语义）**：UI 主文案一律白话（保存到历史 / 相对主分支 / 多出 N 个保存点 / 改动说明），git 技术信息
  不删除、降为二级呈现（小字 mono、悬浮 title、详情 popover、⋯ 菜单），**不加任何模式开关**；状态分组等纯逻辑集中放
  `src/git-status-groups.ts`，新增 git 相关 UI 必须遵守同一双层规则。

## 主题与设计系统

- 全站主题令牌集中在 `src/App.css` 的 `@theme` + `[data-theme]` 变体（**七套深色 + 七套对应浅色**，v3.44 起：
  沉浸黑(默认)/陶土/Ayu琥珀/Catppuccin/极简灰蓝/Dracula/灰蓝正红，各配一套同性格浅色；浅色方向翻转——rail 比 canvas
  略暗、面板向白浮起、hairline/field 为深灰线、cta 加深保白底对比，状态语义色共享深色值；白色半透明 hover/缩进线/
  滚动条拇指在浅色下由 App.css 统一翻转为黑色半透明），运行时切 `document.documentElement.dataset.theme`，
  **改主题只动这一个文件**，组件里禁散落 hex。主题清单单一出处 `src/themes.ts`（settings.rs KNOWN_THEMES 与
  TerminalPage XTERM_BG_FG 需同步）。**切主题同时同步原生窗口外观**（`applyTheme` 调 `setTheme(light/dark)`，
  浅色判定走 themes.ts 的 `light` 标记）——原生 `<select>` 下拉、滚动条等按 NSWindow appearance 渲染，
  只改 CSS 变量时深色主题下弹出系统浅色列表；capabilities 需保留 `core:window:allow-set-theme`。
  默认主题 CTA 粉 `#faa8d4`（cta-text 近黑）；`--color-raised`（浮起面板/pill 底）、
  `--color-bubble`（用户消息气泡）、`--color-nav-accent`（侧栏选中左条+选中图标，默认靛蓝、其余取各自 CTA 色）。
- 四层「浮起」结构（rail/rail2/canvas/inset 逐级变亮）；文字冷白→灰四档；每主题独立 CTA 强调色（按钮/选中用 `cta`；可操作
  状态如「可合并」用**按钮本身的 cta 高亮**，不另挂 pill；纯状态 pill 用 inset 灰底 + 语义色小圆点）；**状态语义色独立于
  主题**（ok/err/warn 不随主题变）；**结果横幅一律 bg-strip/inset 底 + ✓/✗ 语义色文字**，不用整块 bg-ok/bg-err（bg-err
  仅留给需警惕的小 pill）；零阴影、隐式 hairline。
- **线条语言（去格子化，v3.35/v3.37 定稿）**：内联内容容器一律**不加 1px 描边**，靠底色差 + 圆角 + hairline 分层；边框只给
  浮层与控件。strip/inset/raised 三级梯度七套主题必须可分辨；hairline/field 与底色对比度七主题同档。**区间分隔优先留白**
  （折叠区标题、rail 底部、PageHeader 均不画横线）。搜索框无描边（inset 底 + 聚焦加深），输入框保留 field 边。**全站线宽
  0.5px**（App.css 覆写 border/divide；focus outline 不动）。**侧栏只保留全高竖分界 + 底部管理区一根横线**。**共享控件集中
  `PageFrame.tsx`**（primary/secondary/rowAction/ghostAction/field/searchField/hoverReveal + SegTabs），禁各页复制本地类，
  一律用通用语义令牌。编辑器面走 `--color-editor-bg/fg/line`，Monaco 经 MutationObserver 随主题换肤。
- **符号语言统一**：导航与图标用单色几何符号（⚙⛁⌨◔✦◫⛭⇄），◈=AI 功能、⚑=pin/保留；**禁用彩色 emoji**。
- 用户明确否决过的设计：多栏嵌套的对话页、浅色 + 蓝紫渐变侧边栏、按钮排排坐的 profile 行、暖棕色系整体主题、
  emoji 图标。不要改回去。（浅色模式曾是否决项，v3.44 用户主动要求并已落地七套浅色，该否决作废。）
- 配置页结构（用户详版规格）：可折叠 agent 分组 + 五列网格行 + 顶部筛选与搜索 + 无大面积虚线空状态；图标按钮点击区 ≥28px；
  **WKWebView 不支持 window.prompt/confirm/alert 等原生 JS 对话框**（macOS wry 未实现对话框委托，confirm 恒返回 false、prompt/alert 静默无效）——
  一切输入用内联输入框，确认走 `src/components/ConfirmDialog.tsx` 的 `confirmDialog`、提示走 `alertDialog`（promise 版，宿主已挂 App 根部），禁再引入原生 JS 对话框。
- 常规管理页统一共享页面框架/标题层级/主操作样式/主题化开关复选框/加载骨架；页面最大宽度必须显式选择，禁叠加冲突的
  `max-w-*`。**控件尺寸固定两级**：标题栏主/次操作与终端启动栏 32px；任务行、步进器圆/小方块热区、对话列表/回放头部及图标按钮 28px
  （可点击就不得小于 28px；层级靠填充色/边框/文字色区分，不靠按钮忽大忽小）。**留白节拍固定**：统一标题呼吸区/工具栏
  间距/主体内边距；空状态与低对象数量时允许保留连续画布，不为填满窗口堆料；工作区流水线与任务行可增加垂直间距，但不
  改变步骤顺序和操作语义。
- **全站导航按工作流分层**：侧栏顺序固定为工作（工作区/终端/对话）→ 能力（配置/技能/统计）→ 底部只留设置，首启默认进
  工作区；保留全部路由和 visited 保挂载。常规页必须复用 `PageFrame/PageHeader/PageToolbar` 的“上下文标题栏 + 独立筛选
  工具栏 + 主体”结构，标题栏只保留唯一主动作；工作台页面可维持自身分栏，但分隔、密度和状态语言必须与共享框架一致。
  借鉴外部工作台只学对象列表/上下文栏/三栏机制，不得把配置中心重新设为首页。**侧栏收展完全手动**（品牌区点击，
  localStorage 记忆；v3.38 的按页面自动收展被用户否决，v3.43 删除）。
- **对话页三栏固定（P1a）**：应用导航 ｜ 会话列表栏（375px，rail2 底：标题+「当前 N · 总计 M」副题 + 深色次按钮 + 搜索框 +
  折叠分类筛选——v3.37 定稿单列纵向手风琴：点 agent 只展开/收起项目子列表（左侧缩进线表达层级），「全部项目」/单项目行
  落筛选且面板保持展开（v3.43：边筛边浏览，选中不收起），计数保持）｜回放区（canvas 底，常驻，未选中为空态）；列表与回放并列常驻，禁止恢复“列表/回放二选一”
  整列切换。会话行双行（标题行带相对时间 + meta 行），选中行 bg-rail-sel 浅填充。`ConversationView`：用户消息右对齐气泡
  （bg-bubble，max-w 70%）、AI 直接排版、``` 围栏代码块 inset+hairline 带 ⧉ 复制、连续 tool_use/tool_result 折叠为「▸ N 次
  工具调用」行；底部为只读展示态圆角输入条（chip 显示 agent 名）。有界尾窗/向前分页保持滚动位置（scrollRef 必须挂在滚动
  容器上）。
- **对象数量不得撑坏主布局**：工作区页用“项目导航 rail + 当前项目详情”，禁止恢复全部项目纵向长页；技能主列表禁止按 Agent
  数量永久加列，只展示稳定字段与应用计数，Agent 分发在右侧详情用自动换行网格管理；新增 Agent 只能增加详情项。终端模块 UI
  小字基准 13px，xterm 新用户默认 14px；状态点等微型符号可更小，但文件树、标签、启动栏、对话/改动正文不得退回 11–12px。
- 终端展开态主流程固定为 Agent → profile → 模型 → 目录 → 启动，辅助动作视觉分组；启动后自动收缩、PTY shell 回落、
  所有终端标签保持挂载的语义不得因布局优化改变。**专注双模式（v3.43）**：中带「⤢ 专注终端」（藏左右栏，标签条
  留在中带顶部，portal 机制已删）与右栏「⇱ 专注内容」（右栏铺满、中带不加遮罩），Esc 退出；左栏不再有 « 收起态。
  状态点全局统一 `size-2 rounded-full`；端口区分「本应用/系统其他」两段，终止外部进程必须二次确认。
- **统计内部活动只认后端 provenance**：Ccode 无头 AI 启动前登记精确 agent+项目路径，usage 事件与项目/模型 DTO 显式携带
  `source/internal`；禁止再按 `/tmp`、`ccode-ai-*` 名称、空模型或 `<synthetic>` 猜测。统计页默认归并 `internal=true`，并提供
  “显示内部活动”开关；开关只改变展示分组，不得改写原始用量索引。
- **会话整理与长回放口径统一**：对话页默认从普通项目树排除 `internal=true`，归并为单一“Ccode 内部 AI”入口；“显示已归档”
  必须同时作用于全部/agent/项目/内部入口计数。标题先折叠空白并拒绝通用占位值，再回落首条真实用户消息，最终使用“未命名
  对话 · 短 ID”。长会话首次只读有界尾窗，向前分页保持滚动位置；终端不得用全量回放接口做轮询。
- **usage 长会话必须流式解析并按本机日期聚合**：普通 JSONL 与 Codex zstd 会话逐行消费，禁止因整个文件超过固定大小而跳过；
  “今日/近 7 天/近 30 天”及事件日桶都使用系统本地时区。改变解析或日桶语义时必须升级 usage schema 并自动重建旧索引。
- **最近项目采用 stale-while-revalidate**：后端按仓库聚合各 Agent 会话的最大 updated_at、canonical 去重并降序返回；前端启动
  即预取、本地缓存上次成功结果，首次无缓存时用固定骨架占位。终端最多展示 4 个且排除当前项目，缓存路径在进入前仍必须重新验证。
- **管理列表只展示状态与主路径**：配置、工作区、技能和对话列表的行内只保留识别信息、状态与一到两个高频动作；导入/导出、
  删除、诊断、恢复等低频项进入「⋯」。工作区的 PR 与归档必须在统一全宽评审内确认和执行；唯一例外是正在进行的 merge 冲突，
  必须在工作区行保留直接的「解决冲突」入口，且仍进入同一评审覆盖层。
- **列表行内操作分两级显隐**：每行最多一个常驻主按钮（编辑 / 应用开关 / 评审 / 组头「新版」），其余低频按钮（行内 ⋯、⧉ 复制
  等）统一 hover 才现——行挂 `group`，按钮 `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`；状态聚合成 ●N 计数
  （明细进悬浮 title），无状态不渲染状态点；次级信息 10px 灰字、时间相对主显（`rel-time`，悬浮 `absTime`）；分组层级靠
  hairline + 左侧缩进线（`border-l border-white/5`），不再套卡片外框。工作区/终端/配置/技能/设置五页同一手法。
- **工作区项目详情按对象职责分层**：流水线步进器只表达状态与推进（大圆点击 = 开始/恢复/跳终端，见「流水线大圆步进器」条）；终端与
  普通评审统一由下方工作区任务行执行，产物核验在任务行行内手风琴与步进器圆后小方块两处同一面板，目录定位进入步骤「⋯」。编辑流水线、模板替换等项目级操作统一进入项目头
  「⋯」。已合并且没有新提交的任务行只显示左侧「已合并」状态，
  不再重复显示「评审」；新提交后评审入口恢复。
- **流程进度与步骤固定对齐**：流水线使用等分列（minmax(9rem,1fr)），每个步骤一个大圆一一对应；窄窗口整体横向滚动，禁止
  自由换行；进度不再画独立进度线段，由大圆状态色直接表达。
- **终端布局必须有明确高度与滚动边界**：App 容器、页面主区、终端三带均维持 `h-full/min-h-0`，外层裁切溢出；只有文件树、
  对话、diff 等内容区各自滚动。禁止把页面级滚动或无约束 flex 子项带回终端（防窗口缩放/长内容后底部黑屏空白）。
- **终端工作台信息架构固定为三段**：左侧只负责项目/工作区/文件树上下文，中间只负责 Agent 终端执行，右侧成果工作台固定为
  「对话 / 文件 / 改动」三模式并默认可见。终端启动栏不再放重复的「对话」入口；实时对话、预览编辑、Git 改动统一从右侧工作台
  切换，任务审阅仍从改动进入既有全宽覆盖层。右侧可拖拽记忆宽度，宽屏只隐藏工作树，不得杀终端或改变 PTY/会话挂载语义。
- **PDF 预览（P2a）**：pdf.js 渲染器必须随 PdfPreview 组件动态 import 拆独立 chunk（禁进主包）；`read_pdf_bytes` 只放行四类
  白名单（注册项目登记资源/注册项目根/工作区·仓库根/终端标签 cwd hint），canonicalize 后判定，传输用 base64 字符串（macOS
  Raw 响应会退化为逐字节 JSON 数组，禁改 raw bytes）；选段问 AI 只 pty_write 注入活跃标签输入框，不自动回车。
- **md 阅读模式（RX2a）**：md 文件预览默认「阅读版式」（marked 渲染，pin 版本、随 FilePreviewEditor 懒加载 chunk，禁进主包；
  本地可信内容不引 sanitize 重库），排版样式集中在 App.css `.md-body`（全主题令牌）；「阅读/编辑」切换时 Monaco 保持挂载仅
  隐藏（未保存改动/undo 不丢）；「⛶ 沉浸阅读」为 `fixed inset-0 z-30` 全宽覆盖层（Esc 退出，终端/PTY 保持挂载）；外部写盘
  自动刷新沿用现有 watcher 链路，编辑中（dirty）不覆盖。
- **「整理为笔记」（P2b）**：归属判定只在后端 `pdf_owner_project`（登记资源 canonical 精确命中 → 项目根最长前缀命中，都未
  命中由前端提示去登记，前端不做路径归属猜测）；写入只走 `append_workspace_inbox`——目标固定为工作区根内 `notes/inbox.md`
  （不接受外部子路径），单次 ≤ 64KB、读-改-原子写、已存在文件 canonicalize 双校验防 symlink 逃逸；笔记步骤定位 =
  `workspaceName === "lit-notes"` 优先、回落流水线第二步；无活跃工作区时复用一键开步链路（ensure_git_repo → create_workspace
  → TASK.md best-effort → 追加 inbox → pendingTerminal + ORGANIZE_NOTES_PROMPT 预填）。
- **步骤对照（RX2b）**：跨页「文件树切根」走 store 一次性 `enterCwdReq`（终端页消费后复用 enterCwd/externalCwd「真进入」
  机制，文件树根随活动标签 cwd）；`previewReq` 可带可选 `root`（文本预览的后端根约束，缺省回落活动标签 cwd）。产物核验已移到
  任务行手风琴与步进器圆后小方块（见「产物核验清单」条）；大圆悬浮信息（目录/agent/profile）读终端页同一键 `ccode.wsLast.<worktreePath>`。
- **流水线大圆步进器（v3.46，取代 v3.45 胶囊分层与进度段）**：名称带与步进器带两个同列网格；虚线为**真实 flex 块节律**
  （`StepperCell`：5px 块 + 5px 间隙全是真实元素，块数按列宽 ResizeObserver 现算——任何列宽/步骤数下尺寸与间隔严格一致，
  永不出现渐变相位残段/双块），与圆心同轴，跨列连续（两条带 grid 均 gap-[5px]）。
  **大圆（h-6 w-6，24px）= 纯色实心圆（内部无字符）+ 唯一主推进点击**：done=bg-ok-text；进行中/checking=bg-cta（脉冲用有界
  `animate-pulse-brief`：App.css 自定义 3 周期≈6s 后静止，状态复归重播；无限 animate-pulse 是注意力消耗，项目区工作区状态点同口径）；
  待评审=bg-cta-pill；阻塞=bg-warn；pending=bg-l4 实心灰。点击语义按状态：
  pending 无工作区=startStep、已归档=restoreWs、进行中/待评审/阻塞=onOpenTerminal(ws)、done=setPendingTerminal 开主仓 shell 终端。
  状态/目录/agent/profile + 点击动作提示收进**应用内 tooltip**（`useHoverTip`/`HoverTip`，fixed 定位、横向钳制、滚动/缩放/点击即关）：
  原生 title 在 WKWebView 上行为不稳定（不渲染或残留数秒串到相邻控件），圆与小方块的悬浮提示**一律走应用内 tooltip，禁再回退原生 title**；
  事件挂包裹 span，禁用态也可悬浮。**大圆右上角注意力角标**（size-2 圆点）：cwd 落在工作区内的终端标签有待确认=bg-warn /
  已完成=bg-done（confirm 优先），数据只读消费 `terminalRunInputs` 镜像，不新增轮询。**圆前/圆后小方块 = 节律中的普通虚线块（SquareButton：
  bg-hairline 5px 与虚段同色等大、无字符、无衬底、无状态区分）+ 28px 透明热区（绝对定位子元素，不占布局）**：
  视觉混在虚线里，仅 hover/focus 提亮 bg-cta 表明可点，功能名在应用内 tooltip 出现；圆前=openEditor(i) 打开流水线编辑器并定位该步骤卡片（PipelineEditor `focusStep` prop 滚动 +
  聚焦简报框）；圆后=strip 下方就地展开 ArtifactChecklist（单开手风琴记步骤 index；root 口径同任务行：done 读项目根、其余读工作树、
  无工作区禁用）。步骤 ⋯ 收名称行右侧 hover 才现（hoverRevealClass）；解决冲突/评审/合并统一在下方任务行，步进器不再放第二行动作。

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
  见架构 v3.32）；批量验收、云端会话双源调研留 backlog
- **Backlog（记录不动手）**：SSH 远程执行、MCP 配置分发调研、团队协作 2.0、PDF 批注系统（永远不做）、深度阅读器（P2 验证后
  评估）、批量验收、云端会话双源调研、首启引导完整版（示例课题最小版已落地：工作区空态「✦ 创建示例课题（演示）」→
  `create_demo_project`，演示 PDF/引文/综述流水线齐备；完整版引导的更丰富演示数据留 backlog）、工作区类型驱动默认值（数据类跳端口）、
  内置技能种子机制（**等用户把现有技能优化完善后再做**：目前六个技能只在本机库，应用无内置/首启导入机制）

**当前待办**：

- P0 收尾当前批次：全量文档同步 → 走查 → [skip ci] 提交 → 可选发版
- macOS 签名公证（暂缓，需 Apple Developer 会员 + CI 配 6 个 APPLE_* secrets，见架构 v1.3）
- Intel macOS 安装包（暂缓：CI macos-latest 只出 aarch64；加 `x86_64-apple-darwin` target 构建时间翻倍，真有 Intel 用户再加，
  见架构 v1.3 / README 安装节）
- OpenCode Windows 数据路径未核实（matrix 标注「文档与源码不一致」），Windows 用户验证会话/用量统计后修正
- Skills 一键更新 ✅：更新检测（check_skill_updates）+ 检测后一键应用更新（apply_skill_update，v3.53）均已落地
