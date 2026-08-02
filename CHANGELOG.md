# 更新日志

本项目按[语义化版本](https://semver.org/lang/zh-CN/)管理。架构级决策记录见 [docs/architecture.md](docs/architecture.md) §10。

## v0.1.1（首个发布版本）

**模块**

- 配置中心：六 agent（Claude Code/Codex/Gemini/Qwen/OpenCode/Kimi）多配置管理、多模型切换、CLI 安装/更新、连接测试
- 工作区：git worktree 任务隔离、`.ccode/settings.toml` 自动化（files-to-copy/setup/archive 脚本/端口段）、评审流（任务 diff/健康状态/本地合并/gh PR）
- 终端：多标签 xterm.js、agent 退出回落 shell、会话一键恢复、Monaco 文件预览编辑、git 改动面板、⌘F 输出搜索、◈ AI 提交信息
- 会话：六 CLI 会话解析回放（含外部运行会话感知）、pin 快照/标签/归档/搜索/批量删除、◈ AI 摘要、Markdown 导出
- 技能：Skills 统一库 + 六 CLI 分发、目录/ZIP/GitHub 导入、ZIP 导出、分类管理
- 统计：token/费用统计（官方价、$/¥ 切换）、agent 占比进度条
- 设置：七套深色主题、终端字体/调色板、AI 专用配置、自动更新、诊断日志

**性能**

- 前端分包：首屏 4.7MB → 224KB；终端页 memo 化与轮询门控；输出合帧
- list_repos 60s 缓存

**修复与安全**

- 工作区起点从 origin 主分支改为本地主分支（未推送提交不再丢失）
- 删除保护 canonicalize 双校验（堵符号链接绕过）；codex 默认沙箱（交互 workspace-write / 无头 read-only）
- CLI 二进制解析 GUI 短 PATH 兜底
- macOS 暂未签名公证：首次打开需 `xattr -cr /Applications/Ccode.app`
