# Windows 全链路操作流程审查（2026-08-31，fix/windows-0831）

> 范围：以「Windows 下跑通一个完整文献综述科研项目」为剧本的五大链路只读审查——外部终端恢复、
> agent 安装/配置/使用、技能与 MCP 分发、对话页全部操作项、流水线端到端。
> 本文件只有筛查结论与修复方案，未改任何代码。标注口径：**确认断点** = 代码层面必然/极可能出错；
> **待实测** = 代码看似可行但需 Windows 实机确认。
>
> 总体判断：方言层（paths.rs）、.cmd shim 深化（process.rs）、git 调用参数数组化、env 注入、
> 归属比较等主干在 Windows 上扎实且有测试钉住。断点集中在四族：
> ① **cmd/PowerShell 引号方言**（外部终端拉起、复制命令）；
> ② **UNIX 语法脚本喂给 Windows shell**（setup 钩子、render-pdf run 脚本）；
> ③ **路径比较漏网**（reader.rs 裸 starts_with、笔记配对大小写、opencode 数据目录硬编码 unix 形态）；
> ④ **进程生命周期**（check_mcp_server 裸 kill 挂起、外部终端 spawn 后无人 wait、闪窗约定漏网）。

## 〇、用户实测报错的根因（对话页「外部终端继续」）

**P0 确认断点：`agents.rs:1701-1711` `open_external_terminal` 的 cmd 复合命令被 Rust 参数转义破坏——Windows 外部恢复对所有人必现失败。**

```rust
let inner = cmd.replace('"', "\"\"");
Command::new("cmd")
    .args(["/C", &format!("start \"\" cmd /K \"{inner}\"")])
    .spawn()
```

`Command::args` 在 Windows 按 MSVCRT 规则给含引号的参数加壳（`"` → `\"`），而 cmd.exe 对 `/C` 之后的文本不做反斜杠转义解析。结果 `start` 收到的第一个 token 是 `\"\"` 而非 `""`，不再被识别为窗口标题而被当成程序名 → 失败。已本机实测复现：ps1 从未执行、外层 cmd 挂起直至超时；同一字符串用 `raw_arg` 原文直投则完整跑通。

**修复方案（任选其一）**：
1. 最小改动：`std::os::windows::process::CommandExt::raw_arg` 原文直投，顺带用 `start /D <cwd>` 设工作目录，去掉 `cd /d &&` 一层引号嵌套（已实测可用）。
2. 更干净：不经 cmd/start，直接 `Command::new("powershell.exe").args([... "-File", wrapper])`——GUI 应用无控制台，CreateProcess 自动分配新可见窗口；每个参数由 Rust 正确加引号。代价是失去 `cmd /K` 驻留（可在 ps1 末尾加确认提示）。
3. 无论哪种，补 Windows cfg 单测锁定最终命令行文本（现有单测只覆盖命令文本生成，没覆盖 `start "" cmd /K` 组装层）。

**连带断点**：
- P1：该处裸 `std::process::Command`（agents.rs:5, 1706）违反「Windows 后台命令必须走 `process::background_command`」约定——正式版会多一个 conhost 闪窗；spawn 后无人 wait，失败时挂起进程无人收割。
- P1：失败路径 wrapper ps1 滞留 `%APPDATA%\ccode\external-launch\`（含密钥），仅靠 60s 兜底线程删除，应用提前退出则永久滞留；Windows 侧无 ACL 收紧（unix 有 0600，agents.rs:1092-1096 vs 1207），与 conventions/terminal.md:18 承诺不符。
- P2：codex 外部恢复在 Windows PowerShell 5.1 下的引号脆弱点——ps1 单引号保证 PowerShell 解析正确，但 5.1 把含「空格+内嵌双引号」的参数转交原生进程时丢引号（PS 7.3 才修）；catalog 路径落在含空格目录时 codex 起不来。
- 判别：若用户看到的是 Ccode 应用内错误弹窗（「打开外部终端失败：…」），根因是 profile 未选/密钥为空/二进制未找到（agents.rs:1057-1072、1322-1323，fail-closed 设计内）；若看到 Windows 系统弹窗或窗口闪退而 Ccode 无提示，即本 P0。

## 一、agent 安装 / 配置 / 使用

### 确认断点

1. **【高】codex 在 Windows 内经 Ccode 启动必挂：`-c` 内联 TOML 里的反斜杠路径**（agents.rs:917-923）
   `catalog_args` 拼 `model_catalog_json="C:\Users\x\…"`——codex 把 `-c` value 按 TOML 解析，`\U` 是 Unicode 转义起始 → 解析失败。profile 有模型列表时必触发，内嵌终端与外部终端同命中。「设为全局」路径走 toml_edit 无此问题，**只有 `-c` 内联坏了**；现有单测只用 macOS 路径。
   修复：`catalog_args` 里 `\`→`/`（Windows API 与 codex 均接受正斜杠）+ Windows 路径单测。**一行修复，不修则 codex 在 Windows 完全不可用。**
2. **【高】cursor 在 Windows 全链路不可用，且报错指引是错的**
   - 唯一安装渠道是 `curl … | bash`（agent_specs.rs:712）；`pick_install`（updater.rs:667-672）要求 bash 可解析，`binary_candidate_dirs` 未收录 Git\bin，多数机器直接「未找到可用的安装工具」。
   - `installToolHelp`（ProfilesPage.tsx:1296-1304）对非 winget 五家一律说「请装 Node.js」——cursor 没有任何 npm 包，误导。
   - 即便脚本在 Git Bash 跑通，落点 `~/.local/bin/cursor-agent` 不在 Windows 候选目录；Git Bash 的 symlink 对 Win32 是文本文件，ConPTY spawn 必败。
   修复：cursor 在 Windows 安装/检测 fail-loud，文案改「官方仅支持 macOS/Linux，Windows 请用 WSL」；`installToolHelp` 按 agent 分流。
3. **【中】script 渠道装到 `~/.local/bin` 的 CLI 装完检测不到**——`binary_candidate_dirs` Windows 分支（agent_specs.rs:985-1008）缺 `~/.local/bin`（mac/Linux 分支都有），claude 官方 install.sh 在 MINGW 下正装这里。修复：补 `~/.local/bin`，顺带考虑 `C:\Program Files\Git\bin`。
4. **【低】** updater 错误消息在 Windows 列 brew（updater.rs:699-703）纯噪音；DETECT_CACHE 无 TTL，Ccode 外自行安装要重启才认（updater CHECK_CACHE 有 2 分钟 TTL 自愈，detect 没有）。

### 确认无断点
.cmd shim 双入口（background_command/pty_command 同口径深化 + cmd /c call 回落）；env 注入/env_remove（portable-pty 0.9 CommandBuilder）；「设为全局」事务写（replace_staged 先删后 rename + 回滚；toml_edit 转义正确）；cli_check 走 background_command + kill_process_tree；安装后缓存失效；官方账号 auth 文件检测全 home 相对。

### 待实测
winget 五家实际落点（installer 型包可能只改 PATH、find_in_dirs 不递归子目录）；reqwest rustls 只读 HTTP(S)_PROXY env 不读 Windows 系统代理，「全局代理」用户体检可能连不通且文案无提示；cursor install 脚本在 Git Bash 的实际行为（大概率 uname 见 MINGW64 报不支持——诚实失败但 install_method_preview 会把它亮为将执行方式）；cursor 官方账号 Windows 凭证位置。

## 二、技能与 MCP 分发

### 确认断点

1. **【高】check_mcp_server stdio 检测可永久挂起 + 孤儿进程泄漏**（mcp.rs:1808-1814）
   8s 超时后 `child.kill()` 只杀 cmd 包装层，node 孙子进程持有管道写端 → `stderr.read_to_string` 等不到 EOF 永久阻塞。违反仓库自己的约定（kill_process_tree + join_with_timeout，两处工具都已有就是没用）。
   修复：超时/收尾改 `kill_process_tree(child.id())`，stderr 读取进线程 + join_with_timeout 兜底。
2. **【高】分发的 stdio command 落成 `.cmd` 绝对路径，与各 CLI 真实拉起能力不对称——健康检查绿灯不可信**（mcp.rs:273-287）
   `resolve_command_deep` 只深化 unix shebang shim；Windows 上 `npx.cmd` 首行是 `@ECHO off` → 原样写出 `.cmd` 绝对路径。而健康检查走 background_command 的深化路径（node 直启）→ 检测绿 ≠ agent 能用。本机实证各家 MCP 客户端：gemini/qwen/codebuddy/opencode/kimi 走 cross-spawn 能起 .cmd；**claude/codex 存疑**（codex 是 Rust CreateProcess 直起 .cmd 会 os error 193）。
   修复：分发侧复用 `process::node_entry_from_cmd_shim`（提为 crate 内共享），统一落成 `node.exe + shim JS 入口` 直启形态——对包括 codex 在内的所有 CLI 必然可用。
3. **【中】`reject_relative_command` 漏拦 Windows 相对路径形态**（mcp.rs:305-313）——只拦 `./ ../ .\ ..\` 前缀；`dir\sub\serve.exe`、`C:rel.exe`（盘符相对）放行。修复：改为「含路径分隔符但 `Path::is_absolute()` 为 false 即拒」，注意放行 `\\?\` 与 UNC。
4. **【中】技能分发目录不跟随 `*_HOME` 搬迁变量，与 MCP 侧口径分裂**——mcp.rs agent_paths 跟随 CLAUDE_CONFIG_DIR/CODEX_HOME/KIMI_CODE_HOME 等九路（mcp.rs:514-588），skills.rs agent_dirs 一律 home_dir + 固定段（skills.rs:141-150）。设了 `KIMI_CODE_HOME=D:\kimi` 的用户技能静默落空、apps=true 假状态。修复：`skills_dir` 升级为「搬迁变量 + 缺省段」二元组，两模块共用出处。
5. **【低】** opencode 企业 managed 目录拒写未实现（mcp.rs:8 注释承诺了，check_managed_guard 只查 claude）；内置种子 CRLF 一次性假阳性（skills.rs:269 逐字节比对 + 2169 行注释已过时）；ZIP 导入 GBK 文件名乱码（导出侧无问题）；codebuddy env 引用只认全大写但写入侧无校验（matrix §10.3 已记载）；`delete_impl` 先卸载后备份，Windows 文件锁下 rename 失败留「显示启用但盘上无物」假状态（skills.rs:924-946，备份挪前即可）。

### 待实测
claude.exe/codex.exe 对 .cmd stdio command 的实机行为（断点 2 落点）；symlink 形态分发是否被各 CLI 的 Windows 目录扫描跟随；cursor/grok Windows 技能目录；is_ours 对 junction 的 read_link 判定（fail-safe 方向）；8s 超时对 npx 冷启动误报（建议首检放宽 30s 或加提示）。

### 确认无断点
JSON/TOML 全走 serde 序列化（反斜杠安全）；validate_fs_name 接入全部命名入口；copy 回退 MARKER_FILE 识别/卸载/漂移/resync 闭环有测试；env 读取大小写不敏感与宿主一致；内置播种幂等。

## 三、对话页与会话操作

操作项完整清单（前端均在 src/pages/SessionsPage.tsx）：列表行点击/恢复/⚑ pin/⋯ 菜单（归档、编辑标题标签、移到卡片、在终端恢复、外部终端恢复、AI 摘要、提炼接力、删除）；快筛 chips（保留/进行中/今天 + 更多：近 7 天/内部 AI/已归档）；分类筛选手风琴（含项目右键「删除该项目全部会话」）；搜索与结构化建议；↑/↓ 切换；批量管理（全选/批量删除/4s 二次确认）；回放头部（恢复 ▾ 三入口、提炼接力、Markdown 导出、接力到…、live 跳终端）。

### 确认断点

1. **【高】OpenCode 会话数据路径硬编码 unix 形态——Windows 上 OpenCode 会话列表为空**（sessions.rs:2533-2540、2970-2972）
   只认 `OPENCODE_DB` env 或 `~/.local/share/opencode/opencode.db`；Windows 实际落点通常是 `%LOCALAPPDATA%\opencode`（matrix §5 与 AGENTS.md 待办均已挂账）。连带 delete_opencode_rows、session_watch_targets、usage opencode_events 同根。
   修复：加平台分支依次探测 `dirs::data_local_dir()/opencode` 与现路径；实机验证后回填 matrix §5 并销待办。
2. **【中高】gemini pin 快照在源文件被 30 天 retention 清理后从列表消失——pin 的「防自动清理」承诺落空**（sessions.rs:1155-1157、3291）
   归属 = slug 映射或行内 `directories`，两者皆无即整条跳过；快照位于 snapshots/ 目录，slug 反查必 miss，只剩行内 directories 独苗。修复：pin 时把 project_path 写进 session_meta sidecar；归属缺失降级为占位进「全部」而非丢弃。待实测：gemini ≥0.46 是否恒写 directories。
3. **【中】会话删除直接 `fs::remove_file` 不走回收站**（sessions.rs:5057、5078-5092）——与工作树 trash 口径不一致；前端文案已如实写「不可恢复」，非误导但安全分层不自洽。修复：改 trash::delete（保留白名单双闸），或在 safety.md 写为已拍板决策。
4. **【中】「复制恢复命令」产出 cmd 方言，PowerShell 粘贴即报错**（agents.rs:1395、1428-1429）——`cd /d` + `&&` + 引号 doubling 全是 cmd 语法（与外部终端 P0 同族）。修复：按 shell 出两份（PowerShell 版 `Set-Location 'x'; & claude -r 'id'`），或菜单注明「粘贴到 cmd」。
5. **【中低】grok 精确注意力的 transcript_path 匹配是字符串全等**（hooks.rs:652）——未走 paths::same_path，Windows 下分隔符/盘符大小写差异即失配（有 10 分钟 TTL 推断兜底，表现为退化非报错）。
6. **【中低】行内 cwd 缺失时目录名原样兜底产出 `-c--Users-foo` 伪项目路径**（sessions.rs:616-621、2073、2241、2403）——下游分组/归属/移到卡片全降级；恢复链路有 checkWorkingDirectory 兜住不静默起错目录。已知设计取舍，可选加「目录名推断」徽标。
7. **【低】usage 增量索引 marker 秒级 mtime**——同秒连续写入不触发重索引（usage.rs:865-873），跨平台同有。

### 待实测
cursor 会话目录 Windows 落点（matrix §8 未验证）；kimi 新版 sessionDir 是否带 `~`（sessions.rs:3190 未 expand_tilde，带则静默跳过）；watch_session 事件路径大小写；cmd 回落路径 prompt 二次展开（低频）；>260 长路径；opencode time_updated 单位。

### 确认无断点
九家归属主路径都读行内 cwd/目录字段（目录名编码只是有损兜底，盘符反斜杠怎么编码不影响归属）；归属比较方言层贯彻（path_within/same_path 无漏网）；AI 摘要/提炼接力无头链路走 background_command 双覆盖；删除双闸 canonicalize 成立；pin/导出文件名 sanitize 有测试；codex zst/opencode db 的 usage 提取平台无关；resume 参数九家齐备、内嵌恢复走 ConPTY 结构化 argv。

## 四、文献综述流水线端到端

### 确认断点（按剧本阶段）

1. **【高·开步】setup/archive 钩子：bash 脚本在 Windows 被 `cmd /C` 逐字执行**（workspaces.rs:992-1007）
   仓库级脚本全平台同一份文本，Windows 固定 cmd /C——`source`/`&&`/`export` 全不认；且「setup 失败不阻断」语义下工作区建成了环境是空的。修复首选：Windows 改走 Git Bash（装 git 必有，resolve_binary("bash") + %ProgramFiles%\Git\bin 兜底），探测不到才回落 cmd 并在报错文案带解释器名。
2. **【高·交付】quarto `render-pdf` run 脚本是纯 bash，Windows 终端是 PowerShell——论文线四步共用，整链断**（pipeline-presets.ts:971-975 + pty.rs:589-601 + TerminalPage.tsx:1416-1418）
   错误提示文案还是 mac 专属（brew install tectonic / MacTeX）。修复：最小 = 命令拆平台变体（前端按 IS_WINDOWS 选，Windows 用 PowerShell 语法 + winget install Tectonic.Tectonic 引导）；更稳 = render-pdf 后端化为 Rust command，run 脚本只留跨平台纯命令。
3. **【高·沉浸阅读】reader.rs 裸 starts_with/strip_prefix，verbatim 与普通形式混比——主仓笔记「沉浸阅读」误报「不在任何项目内」**（reader.rs:289-310、252、63、78）
   ensure_task_project_root 返回带 `\\?\` 的 canonical 根，与 strip_verbatim 过的项目根比 Prefix 永不相等。workspaces.rs:3156-3169 踩过同款并修过，reader.rs 是漏网。修复：比较前两侧过 strip_verbatim 或走 paths::path_within；**建议顺手把 ensure_task_project_root 改成返回 stripped canonical 根，一次收掉 lit_watch/reader/citation 三处隐患**（改前全量核调用方；lit_watch.rs:138-147 resolve_inside 同款但目前自洽）。
4. **【中·沉浸阅读】find_note_by_source 配对大小写敏感**（reader.rs:152-157）——NTFS 下文件名大小写漂移即漏配 → 重复建档/误清空模板笔记。修复：配对比较走 paths::same_path 口径。
5. **【中·评审归档】git porcelain 中文路径八进制转义未反转义**（workspaces.rs:774-777、1198-1204）——归档守卫拿带引号的 `"dir/\346…md"` 直接 fs::read 必失败 → 中文路径下「副本未改动」快速归档通道永远落空、误报「有未提交改动拒绝归档」；报错清单把八进制串甩给用户。修复：`run_git` 读路径类输出统一加 `-c core.quotepath=false`（最省），或写 unquote_porcelain_path 纯函数 + 中文路径回归测试。
6. **【中·终端交接】cmd 回落路径的 prompt 二次展开缝**——shim 深化失败回落 `cmd /d /c call` 时用户可编辑文本（fork prompt 等）里的 `%`/`&`/引号被 cmd 吞/展开；开步 prompt 目前是 12 字固定安全串，风险在分叉/技能注入路径。建议：回落路径参数做 `^` 转义或文档声明；长期统一 prompt 通道到 stdin/临时文件（逐 agent 白名单，grok 不读 stdin）。
7. **【低·定时雷达】** 无头巡检写盘编码：agent 若经 GBK 代码页工具写 inbox.md，`fs::read_to_string` 报错 → newEntries 静默恒 0（lit_watch.rs:364）；建议技能明示 UTF-8 + 读取侧 warning。`record_run` 无论成败回填 last_run_at（scheduler.rs:605），「盘没插」的当天不会被补跑，与漏跑 coalesce 语义冲突，待拍板。
8. **【低】** reader.rs:331 返回前端的 root 可能是 `//?/C:/…` 丑形态（随断点 3 一并修）；fs_tree Windows isSystem 清单只有 AppData 等三项（约定宁缺毋滥，非断点）。

### 待实测
无头 codex `-s workspace-write` 在 Windows 沙箱的实现度（AGENTS.md 已标「写权限九家不齐」）；setup 钩子修复方向的 Git Bash 兜底；render-pdf 实点报错原文；中文路径归档误拒复现；合并后主仓笔记 vs 未合并 worktree 笔记两条沉浸阅读路径；精简 Windows（Server Core/LTSC N）无 powershell 的回落形态。

### 确认无断点
注册/去重/定时任务清理/list_repos 全走方言层（canonical_key strip_verbatim 落库）；CRLF 对 inbox.md 解析免疫（str::lines + trim）；merge/PR 链路 git 全参数数组无 quote 问题、--literal-pathspecs + -z 中文安全；开步 prompt 是固定短句走参数注入，无命令行长度风险。

## 五、修复优先级建议（跨域排序）

| 序 | 断点 | 影响面 |
|---|---|---|
| 1 | 外部终端 P0（agents.rs:1701-1711 raw_arg/直起 powershell） | 用户实测报错点，Windows 必现 |
| 2 | codex `-c` catalog 反斜杠（agents.rs:917，一行修） | codex 在 Windows 完全不可用 |
| 3 | reader 方言层 + ensure_task_project_root 收口（reader.rs/projects.rs） | 沉浸阅读主路径误报 |
| 4 | check_mcp_server 挂起 + 孤儿进程（mcp.rs:1808） | MCP 体检卡死 UI + 泄漏 |
| 5 | MCP 分发 .cmd 深化统一（mcp.rs:273 + process.rs 共享） | claude/codex 可能起不来 stdio server |
| 6 | setup 钩子 Git Bash + render-pdf 平台变体 | 流水线在 Windows 交付不了 PDF |
| 7 | git porcelain 中文路径（core.quotepath=false） | 中文项目归档误拒 |
| 8 | opencode 数据路径 Windows 分支（需实机确认落点） | OpenCode 会话列表为空 |
| 9 | cursor Windows fail-loud + installToolHelp 纠正 + ~/.local/bin 候选 | 误导性安装指引 |
| 10 | gemini pin 快照归属 sidecar | pin 防清理承诺落空 |
| 11 | 复制命令按 shell 出双方言 | PowerShell 用户粘贴即错 |
| 12 | 其余中低项（reject_relative_command、skills_dir 搬迁变量、会话删除 trash、grok same_path 等） | 择机 |
