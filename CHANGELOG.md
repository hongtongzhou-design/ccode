# 更新日志

本项目按[语义化版本](https://semver.org/lang/zh-CN/)管理。架构级决策记录见 [docs/architecture.md](docs/architecture.md) §10。

## Unreleased（未发布）

**修复**

- ⇗ 外部终端恢复对 kimi 等官方安装器 CLI 失败（Ghostty 报 failed to launch）：外部拉起的命令改用二进制绝对路径 + shell 改交互登录模式（`-l -i`）——非交互 `zsh -l -c` 不加载 `.zshrc`，`~/.kimi-code/bin` 这类 PATH 会丢
- codex 更新失败/无效：同机多份 node/npm 时，二进制候选目录改为用户目录优先（与应用外终端的解析一致），npm 更新改用与目标二进制同目录的 npm（`updater::npm_for`），不再装错 prefix
- opencode 更新卡在交互选择框：brew 安装的 opencode 改走 `brew upgrade`（自更新 TUI 行输入无法应答）
- kimi-k3 定价修正：内置价从 $0.6/$3.0 改为官方价 ¥20/¥100（输入缓存未命中/输出，每 1M，折 $2.78/$13.89）；缓存命中一折口径不变

## v0.1.0（首个发布版本）

**模块**

- 配置中心：六 agent（Claude Code/Codex/Gemini/Qwen/OpenCode/Kimi）多配置管理、多模型切换（编辑表单提示各 agent 切换页上限）、CLI 安装/更新（组头版本号 + 新版/已更新/更新三态）、连接测试
- 工作区：git worktree 任务隔离、`.ccode/settings.toml` 自动化（files-to-copy/setup/archive 脚本/端口段）、评审面板（任务 diff + 逐文件彩色 diff + 冲突闭环：并入主分支、两侧内容预览、逐文件/一键选边、◈ AI 选侧建议）、合并拆分「合并（保留工作区，显示已合并 pill）/ 合并并归档」、主仓库状态前置健康检查、归档后滞留终端自动回主仓库
- 终端：多标签 xterm.js、agent 退出回落 shell、会话一键恢复、Monaco 文件预览编辑（稳定文档模型、外部改写自动刷新、主仓库保存二次确认、路径归属标识 + 主项目⇄多分支切换）、真实 cwd 跟踪（文件树/git 面板跟随 shell 内 cd）、git 改动面板（成功 toast）、⌘F 输出搜索、专注模式（只剩终端，标签与动作菜单移到侧栏）、◈ AI 提交信息
- 会话：六 CLI 会话解析回放（含外部运行会话感知）、pin 快照/标签/归档/搜索/批量删除、恢复三入口（内嵌终端 / ⇗ 外部终端 / ⧉ 复制恢复命令）、◈ AI 摘要、Markdown 导出
- 技能：Skills 统一库 + 六 CLI 分发、目录/ZIP/GitHub 导入、ZIP 导出、分类管理
- 统计：token/费用统计（官方价、$/¥ 切换）、agent 占比进度条
- 设置：七套深色主题、终端字体/调色板、AI 专用配置、外部终端首选、自动更新、诊断日志

**性能**

- 前端分包：首屏 4.7MB → 224KB；终端页 memo 化与轮询门控；输出合帧
- list_repos 60s 缓存

**修复与安全**

- 工作区起点从 origin 主分支改为本地主分支（未推送提交不再丢失）
- 删除保护 canonicalize 双校验（堵符号链接绕过）；codex 默认沙箱（交互 workspace-write / 无头 read-only）
- CLI 二进制解析 GUI 短 PATH 兜底（含 `~/.kimi-code/bin` 候选，修复打包版 kimi 检测）
- 预览编辑器稳定文档模型（同名文件跨仓库静默切换曾导致误改主仓库，该「跟随」机制已移除并禁止复活）
- 密钥只在拉起瞬间注入；外部恢复/复制恢复命令不携带 profile 密钥
- macOS 暂未签名公证：首次打开需 `xattr -cr /Applications/Ccode.app`
