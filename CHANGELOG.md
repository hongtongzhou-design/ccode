# 更新日志

本项目按[语义化版本](https://semver.org/lang/zh-CN/)管理。架构级决策记录见 [docs/architecture.md](docs/architecture.md) §10。

## Unreleased（未发布）

**修复**

- ⇗ 外部终端恢复对 kimi 等官方安装器 CLI 失败（Ghostty 报 failed to launch）：外部拉起的命令改用二进制绝对路径 + shell 改交互登录模式（`-l -i`）——非交互 `zsh -l -c` 不加载 `.zshrc`，`~/.kimi-code/bin` 这类 PATH 会丢
- codex 更新失败/无效：同机多份 node/npm 时，二进制候选目录改为用户目录优先（与应用外终端的解析一致），npm 更新改用与目标二进制同目录的 npm（`updater::npm_for`），不再装错 prefix
- opencode 更新卡在交互选择框：brew 安装的 opencode 改走 `brew upgrade`（自更新 TUI 行输入无法应答）
- kimi-k3 定价修正：内置价从 $0.6/$3.0 改为官方价 ¥20/¥100（输入缓存未命中/输出，每 1M，折 $2.78/$13.89）；缓存命中一折口径不变
- kimi 全局配置补齐 `max_context_size`（0.31+ 必填；k3=1M / k2.6-2.7=256K / 其他=128K 保守默认；旧版 kimi-cli 不写防解析报错）
- ⇗ Ghostty 恢复不再每点一次多开一个程序坞实例：已运行时改走 AppleScript ⌘N 新窗 + 剪贴板粘贴命令（用后还原剪贴板；首次需一次自动化授权）
- 会话删除保护补齐 OpenCode 数据根（`~/.local/share/opencode`），OpenCode 会话删除不再被误拒
- 会话扫描窗口化：普通文件 seek 读头/尾窗，zstd 压缩会话流式解码只留头尾窗（几十 MB 大会话不再整个解压进内存）
- delete_project_sessions 改单连接 + 事务批量删除；全量扫描移入 spawn_blocking（不占 async worker）
- profiles.json / keys.json 读-改-写加序列化锁（并发保存防丢失更新）；pricing.json 写入加数值校验（非负价格、正汇率、逐项报错）
- 会话页「改动」页签对进行中会话加警告条（agent 可能正在写文件，提交前确认）

**体验**

- ⇗ 外部恢复 / ⧉ 复制命令的入口提示「使用全局 CLI 配置，不携带本 profile 密钥」（免误解）
- 会话搜索覆盖 AI 摘要内容（项目/标题/标签之外可按摘要关键词找会话）
- 工作区仓库节点直接显示「主仓有改动」黄点（建工作区的决策前置可见）
- 配置页 ▸用量对跨配置共享的模型加 ⚠ 可见标记（用量近似归属会重复计入的提示不用悬停也能看到）
- 技能行显示各 agent 的分发形态（·s=symlink / ·c=copy，悬停含 copy 漂移检测说明）
- ◈ AI 生成（提交信息/摘要/PR 描述/冲突建议）失败时附排查建议（检查 AI 专用配置或换快模型）
- 批量删除二次确认用警示色（bg-err 仅用于此类场景）+「含 pin 快照」明确文案；会话筛选无结果时给「清除筛选」按钮
- 评审面板冲突文件加红色左边条（长列表快速扫视）；文件树 git 状态字母悬停显示中文完整状态
- 侧栏「终端」图标加运行中 agent 数徽标（任意页面可见）；统计页 agent 条右侧加「N 模型」（按使用过的不同模型计）
- 终端调色板抽出共享表（`src/terminal-palettes.ts`），设置页色卡预览升级为真实 8 个 ANSI 色（与终端生效色同源）
- 诊断日志加「导出」按钮（txt 落 ~/Downloads/ccode-exports/，配合反馈问题流程）

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
