# Mesa

<p>
  <img src="icon/icon-v3-01-emerald-mint.png" width="96" alt="Mesa icon" />
</p>

<p>
  <a href="https://github.com/hongtongzhou-design/ccode/actions/workflows/build.yml"><img src="https://github.com/hongtongzhou-design/ccode/actions/workflows/build.yml/badge.svg" alt="Build" /></a>
  <a href="https://github.com/hongtongzhou-design/ccode/releases/latest"><img src="https://img.shields.io/github/v/release/hongtongzhou-design/ccode?label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-blue" alt="Platforms" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
</p>

**AI 科研工作台**（桌面应用，Tauri v2 + React/TS + Rust）。底层是九个终端 Agent 的统一控制台（启动器 + 配置中心 + 会话监控台），表面是科研、编程、办公流水线：读文献 → 整数据 → 做图 → 写论文。**AI 负责干活，Mesa 负责管环境和验收，人负责拍板。**

为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI、Grok Build 管理多套 API 配置（端点 / 密钥 / 模型）与官方账号登录，内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

产品对象按 **Project → Task → Run** 管理：Task 是人声明的工作单元，Run 是一次执行，终端标签只是 Run 的视图。需要写盘的任务默认在隔离工作树中运行，完成后由人查看改动并决定是否写回项目。

展示名 **Mesa**；内部身份仍是 `ccode`（bundle ID `com.ccode.dev`、项目 `.ccode/`、本机 `~/ccode/`、Codex provider `ccode`）。数据和配置位置不随展示名改动。

## 界面

侧栏按 **工作 → 资源 → 管理** 分层，启动默认进入工作台：

| 组 | 页面 | 做什么 |
|---|---|---|
| 工作 | **工作台** | 正在进行、待你处理、最近项目 / 对话；关标签后按运行身份找回 |
| 工作 | **项目** | 科研 / 编程 / 办公三种工作方式：研究流程或目标、工作树、定时任务、文件、Agents 名册 |
| 工作 | **运行** | 内嵌多标签终端（聊天 / 终端同一会话切换）、文件树、改动面板、沉浸阅读 |
| 工作 | **对话** | 九家 CLI 本地会话的结构化回放、自动起名、归档 / 导出 / 接力 |
| 资源 | **连接** | 网关 × 绑定；默认启动注入环境变量（零污染），可选「写入 CLI 全局默认」 |
| 资源 | **技能** | Skills 统一库，分发到各 CLI；内置 18 个科研技能 |
| 资源 | **MCP** | 统一清单，一键分发到各 CLI（Grok 只读） |
| 管理 | **用量** | token 与费用（官方账号显示「订阅」），按项目 / 模型 / 任务归因 |
| 管理 | **设置** | 十四套主题 + 自定义、字体 / 调色板、通知、更新、诊断 |

快捷键：`⌘K` / `Ctrl+K` 命令面板，`⌘1`–`⌘9` / `Ctrl+1`–`Ctrl+9` 切页（顺序同上）。

## 功能

- **连接**：Agent × 网关 × 绑定；API 配置与官方账号双轨；密钥 0600 本地存储、绝不回显；CLI 安装 / 更新一键完成
- **项目**：科研六套研究流程模板（综述 / 论文 / 数据 / 毕业论文 / 投稿返修 / LaTeX）+ 一键开步；无流程科研与办公用「新建目标」（隔离副本，人验收后写回）；编程用独立工作树，合进基准或开 PR
- **运行**：xterm.js 多标签；Agent 退出回落 shell、会话可恢复；Monaco 预览 / 编辑；PDF / docx / 表格 / 图片内嵌预览；选段「◈ 问 AI」；⛶ 沉浸阅读（笔记｜PDF｜终端）
- **对话**：解析九个 CLI 本地会话（含外部终端里跑的）；按项目 / 步骤整理；pin 快照、标签、归档、批量删除、◈ 摘要、Markdown 导出、会话包换机导入
- **技能 / MCP**：技能四路导入（目录 / ZIP / GitHub / 收编）与 ZIP 导出；MCP 预设含 Consensus、Undermind、Blender
- **科研配套**：文献雷达（定时巡检新文献）、精读清单、期刊指标徽章、引用检查、复现运行记录（与 Git 合并分开）
- **工作台体验**：收件箱聚合冲突 / 待确认 / 可合并 / 更新 / 人工请求；快速开聊（不建项目直接聊）；长任务 OS 通知；应用内自动更新

## 安装

从 [Releases](../../releases) 下载，按你的平台选择：

| 平台 | 选哪个 | 说明 |
|---|---|---|
| macOS（Apple 芯片 M1/M2/M3/M4） | `Mesa_x.x.x_aarch64.dmg` | 目前唯一 macOS 包；Intel Mac 暂需自行 `npm run tauri build` 构建 |
| Windows | `Mesa_x.x.x_x64-setup.exe` | 推荐，安装向导简单；`x64_en-US.msi` 适合企业批量部署，二选一即可 |
| Linux（Debian/Ubuntu） | `Mesa_x.x.x_amd64.deb` | `sudo dpkg -i` 安装 |
| Linux（Fedora/RHEL/openSUSE） | `Mesa-x.x.x-1.x86_64.rpm` | `sudo rpm -i` 安装 |
| Linux（其他发行版） | `Mesa_x.x.x_amd64.AppImage` | 免安装，chmod +x 后直接运行 |

其余 `.sig`、`latest.json`、`.app.tar.gz` 是应用内自动更新用的签名文件，**不用手动下载**。

不确定自己的芯片？macOS：屏幕左上角苹果菜单 → 关于本机，看「芯片」一栏；Windows：设置 → 系统 → 关于，看「系统类型」（基本都是 x64）。

> **macOS 注意**：应用暂未做 Apple 签名公证，首次打开如提示「已损坏」，终端执行：
> ```bash
> xattr -cr /Applications/Mesa.app
> ```

之后的版本更新：打开应用后若有新版本，顶栏「待处理」会出现提醒，也可在「设置 → 更新」查看说明并一键下载安装（完成后自动重启）。

## 文档

- [docs/user-guide.md](docs/user-guide.md) — 使用手册（完整操作流程）
- [CHANGELOG.md](CHANGELOG.md) — 版本更新日志
- [docs/architecture.md](docs/architecture.md) — 架构设计与决策记录
- [docs/agent-integration-matrix.md](docs/agent-integration-matrix.md) — 九个 CLI 的 env / 配置 / 会话格式调研
- [AGENTS.md](AGENTS.md) — 开发约定与踩坑记录

## 开发

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # Rust 不在默认 PATH 时

npm install
npm run tauri:dev      # 开发（独立窗口「Mesa Dev - 热更新」；前端 HMR + Rust 自动重启）
npm run build          # 前端构建（tsc + vite）
npm test               # 前端测试
cd src-tauri && cargo test
npm run tauri build    # 打包
```

开发预览必须用 `npm run tauri:dev`（窗口标题 **Mesa Dev - 热更新**，bundle ID `com.ccode.dev.hmr`）。不要用 `/Applications/Mesa.app` 或旧打包前端做界面验收。

三平台 CI：tag `v*` 或手动 dispatch 触发，跑全量测试后打三平台安装包并创建 Release 草稿（含自动更新签名包）。

## 反馈

遇到问题或有想法，欢迎到 [Issues](../../issues) 提出；附上应用内「设置 → 诊断」导出的日志能加快定位。

## 开源协议

[MIT](LICENSE)

## 技术栈

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · zustand · xterm.js · Monaco Editor · Rust（rusqlite / portable-pty / notify）
