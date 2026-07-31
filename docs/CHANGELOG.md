# Ccode 变更记录

> 规矩（用户指令）：**每有一次重大改动，必须在此记录**。条目包含：改了什么、为什么、关键文件、踩过的坑/注意事项。架构级决策同时更新 `docs/architecture.md` §10 决策记录；阶段完成同时更新 `AGENTS.md` 路线图。新会话从这里快速了解近况。

## 2026-07-31 工作区 + 更新链路 + 暖黑主题（未提交批次，随本文件一起提交）

**配置/更新链路**
- agent 安装/更新按钮（updater.rs）：按安装方式选命令（brew/npm/uv/自更新）；**坑：brew 块缓冲 → 必须 PTY 跑命令**；brew 元数据走 TUNA 镜像；输出框实时流 + 可输入迷你终端（[y/n] 可回答）；2 分钟无输出提醒；失败诊断建议
- codex 多模型 catalog 修复：`experimental_supported_tools` 在 codex 0.146 起为必填（schema 随版本漂移，报错 `missing field` 就对照该版本源码补字段）

**git 改动面板**（git_info.rs + GitPanel.tsx）：branch/ahead/behind、+/- 行数（含未跟踪）、一键提交/推送（无上游自动 `push -u`）

**工作区**（§6.9）：文件树懒加载 + 双击钻取 + 右键「在此打开新终端」；运行中总览；三带布局

**UI 两次重构**：
1. 浅色 + 蓝紫渐变参考图风格（后被用户否决）
2. **全站暖黑主题（Conductor 风）**：令牌集中 `src/App.css` `@theme`；五级暖灰阶梯；文字四档；每视图一个绿 CTA；状态 pill 对；零阴影 hairline；禁用蓝色系。xterm 背景 #171111 融入页面

**规矩新增**：AGENTS.md「本机环境档案」（网络镜像/brew 教训/钥匙串/块缓冲/GUI PATH）、「主题与设计系统」（含用户否决过的设计，勿改回）

## 2026-07-30 P0–P2（已提交 9271282）

- P0：Tauri 骨架、Profile CRUD、claude/codex 适配器、内嵌终端（shell 回落）、钥匙串 → **后改 0600 keys.json（钥匙串丢条目坑）**
- P1：六 agent 适配器（gemini/qwen/opencode/kimi 各自注入机制）、全局写入模式（备份/恢复、toml_edit）、多标签终端、三平台 CI（全绿一次）
- P2：会话可视化——claude/codex/gemini/qwen/kimi 解析器、codex resume 链合并（forked_from_id 并查集）、项目聚合、pin 快照保留、SessionLink（--session-id + 探测）、右键删除、性能（异步命令 + 10s 扫描缓存）
- 多模型切换全 CLI：claude 别名槽（≤5）、codex model_catalog_json、qwen modelProviders、kimi [models.*]、opencode provider.models、**gemini 无注册入口只能 /model set**
- 参考实现 `.reference/`：cc-switch / waveterm / vscode（AGENTS.md 有借鉴点清单）
- 踩坑记录：`NO_COLOR` 致黑白终端（必须 env_remove）、TERM/COLORTERM 必须显式注入、项目筛选曾忽略 agent 维度
