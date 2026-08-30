# 约定：安全与数据防护

> 适用范围：密钥、会话/配置读写、文件与仓库的删除/提交、诊断包、CLI 安装更新。从 AGENTS.md 迁入（原文照录，未做语义改动）。

- **密钥绝不回显/进 shell**：存 0600 `keys.json`，只在拉起瞬间注入子进程 env；`profiles.json` 只存尾号 key_hint；
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Ccode` 必须显式设置。
  **外部恢复/复制恢复命令不携带 profile env**（`agents::resume_command_line`，⇗/⧉ 共用）；⇗ 拉起：CLI 用绝对路径
  （`resolve_binary`，⧉ 复制命令才用裸名）、shell 必须 `-l -i` 交互登录（非交互不加载 `.zshrc` 的安装器 PATH）。
  **Ghostty** 走 AppleScript（`open -n` 堆实例、不带 `-n` 不投递 `--args`）：激活 → ⌘N → 剪贴板粘贴命令 + 回车
  （用后还原；首次需用户授权自动化）。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。**AI 提交信息（ai_commit_message）
  的 git status/numstat/diff 同样先过 redact_sensitive_text 再进 prompt**（v3.92 补齐——diff 可能含误提交的 .env/密钥）。
- **Profile 的 extra_env 排在 adapter 内置 env 之后注入**，供用户覆盖内置值（CommandBuilder 后者生效）。
- **RequestPolicy 先声明、后适配**：temperature/topP/maxOutputTokens/reasoningEffort/Header 引用先保存并校验，
  只有 AgentSpec 能力表明确支持时才允许后续注入；未知/不支持字段不得伪造 HTTP 请求体，必须在验证结果中提示。
  Header 只保存环境变量名引用，不保存 Header 密文。
  **拆层已落地**（`docs/conventions/profiles.md`）：Header 跟网关，思考档/温度/输出上限跟网关内每个模型；
  启动按选中模型求交后注入。
- **跨平台文本换行统一**：仓库文本文件以 LF 存储，由 `.gitattributes` 固定 `eol=lf`；Windows 工作区可因
  `core.autocrlf` 显示为 CRLF，但不得提交仅由换行转换造成的全文件差异。
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
- **多阶段 Git 操作必须返回结构化阶段结果**：commit/push、merge/archive、push/PR 任一后阶段失败时，前阶段成功事实必须
  保留并明示；UI 只重试失败阶段，禁止把部分成功显示成整体失败或诱导重复提交、重复合并。
- **全局配置写入/恢复按 agent 整批事务处理**：先生成并验证全部目标内容，再为同批目标建清单备份、写完并同步全部临时文件，
  最后替换；中途失败自动回滚整批。恢复分两档：「恢复备份」选最近一个完整批次（每 tag 轮换留 5 份），恢复前先备份当前状态、
  不得移动/消耗原恢复点；「恢复初始状态」走 `backups/<agent>/original/` 永久快照（首次 apply 时落、不参与轮换——
  轮换窗口会被连续写入烧穿，见架构 v3.146），快照里不存在的文件恢复即删除。
- **Profile“保存成功”不等于“可用”**：验证固定三层——本地字段/活配置解析、CLI doctor/启动预检、最小 API 请求；密钥仅在
  Rust 层参与验证，结果统一脱敏。「设为全局」成功后必须自动执行本地与 CLI 配置复检。
- **官方账号 profile 只读检测 + env 净化**：CLI auth 文件只读探测「已连接」，断开引导用户用 CLI 自己的 logout；官方账号
  拉起不注入 API env，且必须 `env_remove` 同协议残留 API 密钥变量（防静默覆盖账号登录）；统计页官方账号显示「订阅」不计费。
  **API Key 模式不算官方账号**：凭证字段表只认 OAuth token 字段；`OfficialAccountSpec.api_key_fields`（codex =
  `OPENAI_API_KEY`）命中时显示「API Key 配置」而非「已连接」——官方 `--api-key` 与第三方中转（cc-switch 等）写出的
  auth.json 形状相同，文件层面无法区分，不得冒充官方账号。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作：
  1. 「设为全局默认」（写前必须备份）；
  2. **精确注意力标记开关**（hooks.rs 按 agent 写七家 hooks 配置——claude `~/.claude/settings.json`、
     qwen `~/.qwen/settings.json`、codebuddy `~/.codebuddy/settings.json`、gemini `~/.gemini/settings.json`
     （qwen/gemini 走 JSONC 容错读）、kimi `~/.kimi-code/config.toml`（`[[hooks]]` 表，toml_edit 保格式）、
     grok `~/.grok/hooks/ccode.json`、codex `~/.codex/hooks.json`；统一防护口径：写前备份（同前缀留 10 份）+
     原子写、只动 hooks 键/段、已有 hooks 追加不覆盖、关闭只删含 `hooks-state/<tag>-hooks.jsonl` marker 的条目
     并回收空壳键、配置损坏拒绝写；**grok 为整文件形态特例**——该文件整份归 Ccode（开启=写文件、关闭=删文件），
     不含 marker 的外来文件拒绝覆盖；开关走 `set_hooks_attention(agent, enabled)` 单命令（先改各家配置，
     成功后才落应用设置 hooks_attention map 逐键），失败回滚，禁前端单独 patch `hooksAttention`）；
  3. 会话删除（delete_session/delete_project_sessions：canonicalize 根校验 + **已知会话数据子目录 + 会话后缀白名单**，
     同根 auth.json/settings.json 等一律拒绝；**Cursor 不走目录级白名单**（~/.cursor 与 IDE 共享），由 `cursor_deletable`
     限定 `projects/*/agent-transcripts/**/*.jsonl`；OpenCode 事务删库行且 db 必须等于已知 opencode.db；Codex resume 链删除
     连带成员文件）；
  4. 工作树文件删除（限定树当前根 + 重要路径黑名单：系统目录/关键用户目录/CLI 配置/.git 一律拒绝；黑名单 canonicalize
     双校验堵 symlink 绕过）。
- **「设为全局」/MCP 写入/技能分发的各家支持面统一查 AgentSpec 能力表**（agent_specs.rs 的 set_global/mcp_write/
  skill_dist 三字段，fail-loud：不支持必须带用户可见原因，后端报错与前端置灰同源），不再散写硬编码名单
  （mcp.rs 的 grok 只读、skills.rs 的 allow_symlink_for 等旧硬编码均已改查表）。
- **codex 默认沙箱**：交互启动注入 `-s workspace-write`（只能写当前目录）+ `-c sandbox_workspace_write.network_access=true`
  （沙箱内放开联网——默认拦网会导致文献检索/查资料每次都弹提权确认；定时任务 headless 无人可批，不开网必失败），
  AI 无头调用 `-s read-only`；用户可用 extra_env/参数覆盖。
- **诊断包是脱敏的有界快照**：设置页一键导出到 `~/Downloads/ccode-exports/`，包含 Windows/WebView2/GPU/WebGL、
  语言与输入法、当前功能开关、应用日志及自应用启动后的子进程生命周期；进程记录为内存环形缓冲，不读取环境变量，命令参数
  与日志在导出前必须经 Rust 层脱敏。ZIP 内只放 UTF-8 JSON/TXT，保证从 Windows 带回 macOS 后无需 Ccode 或 Windows 工具
  即可离线分析。系统级活动只额外观察 CTF/TextInputHost，禁止借诊断之名采集无关应用的命令行。
- **「是否 git 仓库」探测带 30s 负缓存**（`git_info::probe_is_work_tree`）：轮询入口（git_status/git_status_map）对非仓库
  cwd 不得每轮真 spawn git（诊断包实测 Windows 安装版 85 秒 73 次同目录探测）；只缓存否定结果，应用内 `git init` 成功后
  必须调 `invalidate_repo_probe` 主动失效。**跨来源路径比较一律走 `paths::path_key` 口径**（same_path/path_within，
  前端 `src/path-utils.ts` 同函数）：Windows 上同一路径有 verbatim（`\\?\C:\x`）与普通两种写法、分隔符与大小写都可能
  不同，字符串直接比较会静默失效（删除防护名单、recent_repos 的 home 排除、worktree 归属都曾因此被绕过）；落库与显示
  先 `strip_verbatim`。仅「同一路径判等」可用 canonicalize，且要双校验防 symlink 逃逸。
- **npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**（用错 npm 会把包装进另一个 prefix）；brew 安装的 CLI 一律
  走 `brew upgrade`。
- **交互式 TUI 自更新不走 run_streaming_pty**：kimi/opencode 的 `upgrade` 是方向键选择界面，行输入无法应答——规格标
  `PackagingSpec.interactive_tui`，`check_agent_updates` 按与 update_agent 同一套渠道判定（`updater::interactive_self_update`）
  带出预填命令；配置页「新版/更新」命中时改走 `setPendingTerminal`（shellOnly + prefillCommand，同官方账号登录机制）开
  完整终端让用户方向键操作，普通渠道零变化。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- **PDF 预览（P2a）**：pdf.js 渲染器必须随 PdfPreview 组件动态 import 拆独立 chunk（禁进主包）；`read_pdf_bytes` 只放行五类
  白名单（注册项目登记资源/注册项目根/工作区·仓库根/终端标签 cwd hint/Ccode 自管剪贴板图片目录 `<config>/ccode/tmp`
  ——paste-* 写入侧已有扩展名白名单 + 50MB 上限 + 7 天清理），canonicalize 后判定，传输用 base64 字符串（macOS
  Raw 响应会退化为逐字节 JSON 数组，禁改 raw bytes）；选段问 AI 只 pty_write 注入活跃标签输入框，不自动回车。
- **聊天区 Markdown 渲染（ChatMarkdown）**：会话内容可能含联网抓取文本，按不可信处理——独立 Marked 实例，
  原始 HTML 一律转义（raw `<img>`/`<script>` 是追踪/注入通道）；http(s) 图片不加载只显示文本，本地图片经
  `read_image_bytes` 白名单换 data URL，不新增任何读取通道。
- **引用健康检查（v3.63，citation.rs）**：`check_citation_health` 只读扫描 .md 与 references.bib，目标目录沿用同一
  白名单口径（注册项目根 + 工作区工作树/主仓，canonicalize 后前缀判定，无 cwd hint 来源）；扫描有界（≤200 个 md、单文件 ≤1MB）。
- **「整理为笔记」（P2b）**：归属判定只在后端 `pdf_owner_project`（登记资源 canonical 精确命中 → 项目根最长前缀命中，都未
  命中由前端提示去登记，前端不做路径归属猜测）；写入只走 `append_workspace_inbox`——目标固定为工作区根内 `notes/inbox.md`
  （不接受外部子路径），单次 ≤ 64KB、读-改-原子写、已存在文件 canonicalize 双校验防 symlink 逃逸；笔记步骤定位 =
  `workspaceName === "lit-notes"` 优先、回落流水线第二步；无活跃工作区时复用一键开步链路（ensure_git_repo → create_workspace
  → TASK.md best-effort → 追加 inbox → pendingTerminal + ORGANIZE_NOTES_PROMPT 预填）。
- **MCP 分发（§6.15，规格 = matrix §10）**：Ccode 清单（<config>/ccode/mcp-servers.json）→ 八家用户级配置的映射写入（grok 首版只读不分发）。
  **只写用户级**（项目级各家都有审批闸）；目标文件多是混合状态文件，一律读-改-写一个键/段 + 写前备份 + 原子写 + 读回校验，
  绝不整文件覆盖；codex 走 toml_edit 保格式、gemini/qwen/opencode/codebuddy 走 JSONC 容错读；密钥一律用 `$VAR`/`${VAR}`
  引用形式，映射成各家间接引用字段（codex env_vars/bearer_token_env_var、opencode {env:VAR}、kimi bearerTokenEnvVar），
  不落明文；server 名取各家交集 [A-Za-z0-9-]（下划线禁：gemini policy 引擎按下划线切分）；claude 的 managed-mcp.json
  存在即拒写；cursor 的配置与 IDE 共享，分发同时影响 IDE。CLI 自带 mcp 命令不用于分发（各家语义不一：gemini 默认
  project scope、codebuddy 默认 local、codex add 命中 OAuth 会弹浏览器、kimi/cursor 没有可脚本化命令）。
  **收编/粘贴导入**：`discover_mcp_servers` 扫八家用户级配置列出清单外 server，`import_mcp_from_agent` 反向映射收编
  （各家字段→统一模型，引用语法逆向：`{env:VAR}`/`bearer_token_env_var` 等转回 `${VAR}`，收编即标记已分发到来源 agent）；
  `import_mcp_json` 解析 README 标准片段（剥 mcpServers/mcp/mcp_servers 包裹层，同名跳过）。
  **安全闸**：清单文件 0600（对齐 keys.json）；env/header 命中常见密钥前缀（sk-/ghp_/AIza/AKIA…，复用
  `sessions::common_secret_token`）且非 `$VAR` 引用形式时，保存/粘贴导入报 `PLAINDETECT:` 由前端二次确认放行；
  移除/删除前比对 agent 侧条目与当前映射产物，被外部改过报 `EXTMOD:` 确认后才强删（保护手调版本）；
  粘贴导入两阶段（`parse_mcp_json` 预览命令清单 → 确认才落库，stdio 命令=任意执行须明示）。
  **stdio 命令名落盘前深度解析**（`resolve_command_deep`）：裸名经 `resolve_binary` 落绝对路径（GUI 短 PATH）；
  node 系 shim（shebang `#!/usr/bin/env node` 的脚本/symlink，如 npx）再换成 node 绝对路径 + shim 真实路径首参——
  否则宿主 PATH 无 node 时照样 spawn ENOENT。kimi 的 MCP 只在会话启动时加载，分发后要新会话生效。
- **技能同名导入不得静默跳过**：导入返回 added/updated/skipped/conflicts；覆盖前备份、另存为校验单段安全名称，ZIP 先
  staging，元数据保存失败回滚。GitHub 来源保存 repo/ref/subdir/revision；**一键应用更新**（`apply_skill_update`）按记录的
  repo/ref/subdir 重下并只覆盖同名技能（`import_zip_impl` 的 `only` 过滤，同仓库其他技能不新增不覆盖，走同一覆盖+备份
  路径），上游改名/移动时明确报错并引导手动重新导入；手动重新导入仍走冲突确认。新建/编辑
  走 `create_skill`/`update_skill_content`：重名拒绝并引导改用「编辑内容」；编辑经临时目录走既有覆盖路径（覆盖前备份、
  辅助文件保留、source/repo 不改写）；◈ 优化开终端让 Agent 直改库文件，备份兜底仍靠保存/覆盖路径。**内置技能更新**
  （`apply_builtin_skill_update`）= 覆盖前原文件自动备份为同目录 `SKILL.md.bak-<yyyymmdd>`（同日重名追加 -2/-3），种子内容原子写入。
- **技能接口声明（inputs/outputs）与产物冲突/链路检测**：技能 SKILL.md frontmatter 可声明 `outputs`（产物路径）与 `inputs`（读取路径）字段（YAML 列表，行内 `[a, b]` 与多行 `- a` 两种写法解析都容忍，缺字段 = 空数组；目录带尾斜杠、文件写全路径，只声明主要读写产物），`parse_skill_md` 解析进 `SkillDto.outputs/inputs`（list 时现算，不入库文件）。`compose_skill_md`/`update_content_impl` 支持写接口声明，普通编辑（interface=None）保留库中已声明的 inputs/outputs 不静默丢弃。外部技能未声明时由 `infer_interface_from_body` 从正文推断兜底（逐行找路径 token、按行内动词分类读入/产出、双侧动词不猜、每侧上限 8 条；推断只进 DTO 并打 `interface_inferred` 标，不回写 SKILL.md）。分发随目录走不受影响，CLI 端对未知 frontmatter 字段一律忽略。检测为纯逻辑（`src/skill-conflicts.ts`）：① `skillOutputConflicts`——同一步骤挂载技能的 outputs 两两比对，路径相同或互为目录前缀即报冲突；② `skillChainWarnings`——技能 inputs 对「上游步骤产物 + 本步骤声明输入 + 项目资源」（调用方汇总成 supply）逐条找供给，outputs 对本步骤 expectedArtifacts 对账（含 `*` 通配与目录/文件互含判定），缺供给/未进预期产物即报；推断接口照检但文案标「推断」。StepSkillsChips 警告行逐条提示——只提醒不拦截。
- **技能分类批量回填**：`backfill_skill_categories` 只给「GitHub 来源 + 无分类」的技能补仓库名分类（自动分类 #15 之前的存量导入），已有分类一律不动、幂等；入口在技能页顶部 ⋯。
