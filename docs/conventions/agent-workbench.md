# 约定：多 Agent 工作台对象模型

| 字段 | 值 |
|---|---|
| 作者 | Ccode |
| 日期 | 2026-09-04 |
| 状态 | Accepted（v3.221 设计定稿；v3.223 第 0–3 期已落地，见文内「落地状态」） |
| 范围 | 产品对象 Project → Task → Run；编程并行车道；Agent Runtime 抽象 |
| 前置决策 | 架构 v3.4 人负责拍板；v3.5 否决自动拆任务；v3.7 否决智能路由；v3.10 验收层是护城河；v3.179 科研/编程/办公三档；v3.202 编程 Git 环 |

> **改工作台主卡、终端标签生命周期、编程并行、无头/定时执行入口、AgentSpec 执行形态前必读。**
> Git 原语仍以 `coding-git.md` 为准；科研工作区生命周期仍以 `pipeline.md` 为准。本文管「一次干活是什么」，不吞那两套库。

---

## 0. 产品合同

Ccode 是**人指挥的多 Agent 工作台**：人声明任务，系统给隔离、上下文、权限和验收；底下的执行体可以是 CLI，也可以不是。

| 做 | 不做 |
|---|---|
| 一个项目 = 一个工作空间；里面可同时有多条隔离车道 | 把一句话自动拆成多个 Agent |
| 一次干活 = 一棵树 + 一个 Agent + 一份上下文 + 一种权限 | 系统替用户选谁做前端、谁做测试 |
| 写文件默认进隔离副本，人看过 diff 才进主仓 | 绕过评审自动合并 |
| CLI / 无头 / 以后的云端，都只是 Runtime | 自研 meta-agent、自研云端 Agent、自研 tool-call 循环 |
| 界面仍叫工作台；内核按 Project → Task → Run 长 | 改名为 AI Development OS；为叙事重做八页信息架构 |

跨厂商中立（纪律三）继续成立：Claude 不会调度 Codex。工作台的壁垒是**跨厂商 + 跨科研/编程/办公 + 主仓门**，不是更好看的 CLI。

科研步骤保持顺序（模板声明 + 人开步）。并行车道是**编程**的主增量；办公维持文档 + 一次对话。

---

## 1. 对象模型（全期共用，现在定稿）

```
Project                         已有 project.toml
  work_mode: research | coding | office

  Task                          人声明的工作单元
    科研 = 流水线一步（已有 steps[] + 任务卡）
    编程 = Lane（第 2 期）：名 + 分支 + 可选主题分组
    办公 = 一份文档上的一次处理（现有问 AI / 会话栏即可）

    Run                         一次执行（第 1 期）
      runtime      local_cli | headless | custom | cloud
      isolation    worktree 路径；哨兵任务才允许 project_root
      agent        用户指定的绑定
      permission   discuss | write_tree
      context      TASK.md / 简报 / 提货单 / 技能
      session      只读解析
      events       待确认 / 求助 / 失败 / 可评审
      view         终端标签是视图，不是身份
```

### 1.1 字段（实现时用 camelCase DTO）

```text
Run
  id              UUID；关标签不删
  projectRoot     注册项目根；scratch 可空
  taskKind        pipeline_step | coding_lane | office_doc | watch | reader | scratch
  taskRef         步骤名 / 分支 / 文档路径 / 日程 id
  isolationPath   实际 cwd（科研 worktree / 编程 worktree / 项目根 / ~）
  runtime         local_cli | headless | custom | cloud
  agent           AgentSpec.id
  profileId       绑定 id；custom 可空
  permission      discuss | write_tree
  reuseKey        见 §1.3；同一隔离单元的活标签去重键
  sessionId       解析到的会话；可空
  createdAt
  closedAt        进程结束或用户关掉；Run 行仍在，可恢复
```

`tabId` 只活在前端内存，**不进 SQLite**。重开标签用 `reuseKey` + `sessionId` 反查。

### 1.2 Isolation 两套库不合并

| 工作方式 | Isolation 实现 | 路径 |
|---|---|---|
| 科研 | `workspaces.rs` | `~/ccode/workspaces/<仓>/<步骤工作区名>` |
| 编程 | `coding.rs` | `~/ccode/worktrees/<仓>/<分支路径>` |
| 办公 / scratch | 无新树 | 项目根或 `~/ccode/scratch` |

Run 只引用 `isolationPath`。禁止把编程树并进 `workspaces` 表（`coding-git.md` Non-Goal）。用户心智统一为「给 Agent 的独立目录」，代码保持两套。

### 1.3 reuseKey 闭集（已有字符串升格为 Run 键）

| 前缀 | 含义 | 已有出处 |
|---|---|---|
| `ws:<worktreePath>` | 科研工作区 | `workspaceReuseKey` |
| `reader:<projectRoot>` | 沉浸阅读注入 | TerminalPage |
| `login:<agentId>` | 官方账号登录 | ProfilesPage |
| `office:…` | 办公问 AI（按文件/项目） | `officeFileReuseKey` / `projectChatReuseKey` |
| 编程第 2 期 | `lane:<worktreePath>` | 新；未实现前用 cwd 匹配 |
| 定时第 1 期 | `watch:<scheduleId>:<isolation>` | 新 |
| scratch | 现有快速开聊键 | `quick-chat.ts` |

同一 `reuseKey` 同时只允许一个活标签（现有 `PendingTerminal.reuseKey` 语义，不得退回堆标签）。

### 1.4 Permission 政策 → Adapter 翻译

用户选政策，不选 CLI 旗标。翻译表已有 `AgentSpec.readonly_args`：

| 政策 | 用户可见 | 翻译 |
|---|---|---|
| `discuss` | 只讨论，不改文件 | 注入 `readonly_args`；空表 = 仅 prompt 软约束，UI 必须标明 |
| `write_tree` | 可以改这棵树 | 现有默认启动（codex 交互 `workspace-write` 等） |

某家做不到 `discuss` 硬保护：置灰 + 原因，和 `set_global` / `mcp_write` 同一 fail-loud 口径。禁止第三档「自动 yolo 出网」当默认。

### 1.5 Context Pack（已有科研开步，编程第 0/2 期补齐）

一次 Run 允许看到的输入由系统打包，用户不复制路径：

- 科研：`renderTaskMd`（简报、提货单、技能、项目根绝对路径）——已落地
- 编程：最短 `TASK.md`（分支、基准、一句话意图）——第 0 期
- 接力：结构化简报，禁止称「无缝继续」

---

## 2. 现状对照（设计以它为起点，不重做已有）

| 对象 | 今天 | 缺口 |
|---|---|---|
| Project | `project.toml` + 三档 `work_mode` | 无 |
| Task（科研） | 步骤 + 任务卡 + 开工弹层 | 够用；不要编程式并行车道 |
| Task（编程） | 一棵工作树 = 一条分支 | 没有「主题分组 / 再开一条」一等动作 |
| Run | 终端标签 + `reuseKey` + 无头旁路 | 无头/定时/阅读不是同一类对象 |
| Permission | `PendingTerminal.readonly` + 各家旗标 | 政策没挂到 Run |
| Event | 收件箱 + hooks 注意力 | 文案指向「去终端」，不是去哪条活 |
| Runtime | `AgentSpec` 假定二进制 + PTY | 无头是 `ai.rs` 旁路；无 Custom |
| 工作台 | `pickWorkbenchNow` **已按项目收卡**，`runningCount` 累加 | 卡上只挂一个 `tabId/agentId`，看不出多次 Run |
| 开步选 Agent | `KickoffConfirmDialog` + `KickoffLaunch` **已落地** | 编程从基准开工没有同等选择 |

---

## 3. 第 0 期 — 表面优化（可立即实现，不建表）

目标：用户感到「我在管几条活」，不是「我开了几个 CLI」。禁止新表、禁止改 AgentSpec 形状。

### 3.1 工作台主卡列出多次 Run

**已有：** `pickWorkbenchNow` 按项目聚合，`runningCount` 是次数。

**改：** `WorkbenchNowItem` 增加：

```ts
runs: {
  tabId: string;
  agentId: string;
  attention: "confirm" | "working" | "done" | null;
  taskLabel: string; // 工作区名 / 分支 / 文档名，不是 CLI 名
}[];
```

规则：

- 主卡 / 紧凑行展示 `runs`（待确认在前）；「继续」仍跳优先级最高的那条（confirm > working > 其余）
- `heroStatusLine`：多次时「2 个 Agent 在跑 · Codex 在等你确认」，单次保持现状
- `tabId/agentId/attention` 三字段保留为「继续」指针，等于 `runs[0]` 的优先条，避免全站改调用
- 纯逻辑 `src/workbench-hero.ts`，测试先改再接线 `WorkbenchPage.tsx`

### 3.2 编程「再开一条」

位置：`CodingProjectView` 工作树区。主 CTA 仍是「从 &lt;base&gt; 开工」。

次主动作 **「再开一条」**：

- 出现条件：已有至少一棵非主仓功能树（或用户刚从基准开过）
- 行为：焦点回到分支名输入；placeholder 用当前树分支派生（`feature/login` → `feature/login-2`），**不自动提交**
- 确认后走现有 `coding_create_worktree` + `fromBase`；同名本地分支仍 `branch_exists` fail-loud
- **不**自动选 Agent、不拆任务、不合并、不合成 PR
- 每条树「进入」仍开终端，cwd = 该树

后端 v0 可不动。

### 3.3 编程开工带上 Agent 选择

科研开工弹层已经选 Agent。编程「从基准开工 / 再开一条 / 进入」要对齐：

- 创建树成功后的 `PendingTerminal` 用 `pickKickoffLaunch` 同款规则（`ccode.askAi` 记住的连接还在就用）
- 若用户勾过「设为默认」，`autoStart: true`；否则预填启动栏不自动拉起
- 不新造第三套记忆键

### 3.4 标签标题先任务、后 Agent

| 来源 | 标题 |
|---|---|
| 科研工作区 | 工作区名（已是 `ws.name`） |
| 编程树 | 分支名 |
| 办公问 AI | 文档名 |
| 阅读注入 | `阅读 · {pdf 主名}`（已有） |
| scratch | 现有快速开聊标题 |

Agent / 模型只出现在状态栏（进程起来之后，v3.213 口径）。禁止把 `claude-code` 放进标签主名。

### 3.5 收件箱文案带任务名

`InboxItem.text` 模板：`去「{taskLabel}」{动作}`。

`taskLabel` 推导：科研 worktree → 工作区名；编程树 → 分支；否则项目名。动作用现有「看待确认 / 解决冲突 / 看新文献」。不改 `action` 联合类型（第 1 期再加 `run`）。

### 3.6 编程树最短 TASK.md

`coding_create_worktree` 在 `fromBase` 成功后 best-effort 写入工作树 `TASK.md`：

```markdown
# {branch}

- 基准：{baseBranch}
- 意图：{用户在输入框留下的分支名或稍后可改的一句话}

先读本文件再改代码。只改这棵树，不要切回主仓文件夹。
```

- 注入：`initialPrompt` = 「先读 TASK.md 再动手」（有 prompt 则不 resume，与 `buildWorkspaceTerminalRequest` 同口径）
- 不进 git：复用 `exclude_task_md`（`.git/info/exclude`），全 worktree 生效
- 失败不阻断建树
- 不挂技能、不做开工弹层、不引入流水线步骤

### 3.7 能力表补只读 / 无头人话

`AgentCapabilitiesDto` 增加（与 `readonly_args` / 架构 §11.4 backlog 同源，不另造表）：

```ts
readonly: CapabilityFlagDto;          // readonly_args 非空 = supported
headlessWrite: CapabilityFlagDto;     // 定时/无头写盘：未实证则 supported:false 或 reason 写「权限未实测」
```

前端：想法期开关、定时任务选 Agent 时置灰 + 原因。qwen 无头未验证则禁选；grok 标「无沙箱」。不默默降级。

### 3.8 第 0 期明确不做

- 不建 `runs` / `lanes` 表
- 不改侧栏八页
- 不开步弹层里加「拆成三个 Agent」
- 不把科研工作区改成编程车道 UI

---

## 4. 第 1 期 — Run 身份

把「一次干活」从标签升格为可恢复对象。终端标签变成 `view`。

**两层不得混（v3.222）**：机器里可以给无头一次编号；人看见的「正在进行」只列交互活。无头没有「接着聊」的价值——人要的是雷达/收件箱里的结果，不是那次对话。沿用既有纪律：无头标 `internal`，不进「本项目会话」。

| 层 | 列什么 | 人能不能看见 |
|---|---|---|
| 机器 Run | 交互启动 + 无头/定时（对账、失败归因） | 默认看不见 |
| 「正在进行」/ 可恢复任务 | 开步、进工作树、普通终端、阅读区**正开着的**标签 | 看见 |
| 收件箱 / 雷达 | 无头的**结果**：新文献、巡检失败 | 看见结果，不看见一次对话 |

「正在进行」白名单：用户点开、会改文件、关了还想找回来的交互会话。  
「正在进行」黑名单：定时雷达、雷达解读、提交信息/融合简报/其它 `ai.rs` 无头。成功只更新雷达或收件箱；失败一条「巡检没跑完」，不冒充对话。  
阅读注入：窗口还开着，可以出现在「正在进行」（那就是用户开的标签）；关掉后不当项目任务留着，也不进「本项目会话」（现有 `filterProjectSessions`）。

### 4.1 存储

SQLite `runs` 表（`app.db`），字段见 §1.1。不把 PTY id、密钥、env、scrollback 写入（对齐标签持久化白名单）。

写入点（创建 Run，失败则启动 fail-closed 或降级由调用方决定——**交互 pty_spawn 必须先有 Run id**）：

| 入口 | taskKind | runtime | permission |
|---|---|---|---|
| 科研开步 / 去终端 | `pipeline_step` | `local_cli` | 默认 `write_tree`；聊想法 `discuss` |
| 编程进入树 | `coding_lane` | `local_cli` | `write_tree` |
| 办公问 AI | `office_doc` | `local_cli` | 按场景 |
| 阅读注入 | `reader` | `local_cli` | 默认 `write_tree`（改笔记） |
| 快速开聊 | `scratch` | `local_cli` | `write_tree` |
| `ai.rs` 无头 | 调用方声明 | `headless` | 一次性 prompt = `discuss`；**internal，不进工作台** |
| `scheduler` | `watch` | `headless` | 见 §7；**internal，不进工作台** |

进程退出：写 `closedAt`，保留 `sessionId`。用户点「恢复」= 新 PTY + 同一 Run（resume 会话），不新建 Run。

### 4.2 前端

- `PendingTerminal.runId?: string`；spawn 后标签持有它
- 重启恢复白名单增加 `runId`（仍不含 PTY/密钥）
- 收件箱 `action` 增加 `{ type: "run"; runId: string }`；旧 `tab` / `review` 保留一版兼容，能映射就映射
- 工作台 `runs[]` 只 join **非 internal** 的交互 Run + 活标签；无头 Run 不得出现在工作台主卡/紧凑行
- 无头失败走收件箱（现有 `lit:` / 定时历史），不新造「无头对话」卡

### 4.3 验收

- 关标签 ≠ 丢**交互**任务：工作台 / 收件箱 / 「本步骤的对话」能用同一 `runId` 对上开步、工作树、普通终端
- 无头巡检成功：只更新雷达/收件箱，工作台不出现一张「刚巡检过」
- 无头巡检失败：收件箱一条失败，不是一次可恢复对话
- 阅读区问 AI：仅当对应标签还活着才进「正在进行」；结束后不进本项目会话
- 会话解析仍只读；Run 行不得回写 CLI 会话文件

---

## 5. 第 2 期 — 编程车道（Lane = Task）

人声明的并行，不是自动拆工。科研不要套这套 UI。

### 5.1 对象

```text
Lane
  id
  repoPath
  name          界面名，如「登录 · 前端」；缺省 = 分支名
  theme         可选展示分组，如「登录」；不是 DAG、不是编排
  branch
  worktreePath
  currentRunId  可空
```

落 `app.db`（不进仓库 git）。`coding.rs` 的工作树事实来源仍是 `git worktree list`；Lane 是覆盖层：有树无 Lane 时按分支名现算一条（`name = branch`，`theme = null`）。

### 5.2 界面

编程页左栏：

```
主仓    {project.path}     基准 {base}     不要让 Agent 写这里

{theme 或「未分组」}
  {lane.name}   {branch}   {agent 或空闲}   可推 · 开 PR
  …

[ 从 {base} 开工 ]   [ 再开一条 ]
```

- 「再开一条」升为：问分支名；主题默认上一条的 `theme`（可改、可空）
- 合并 / PR / Desktop / 逐 hunk **全部仍按树、按分支**，不引入「三条合成一个 PR」
- 以后若「这几条一起评审」：人勾选多棵树，再进现有评审覆盖层——仍不是 Review Agent。本期不做

### 5.3 与第 0 期关系

第 0 期「再开一条」只是预填分支名。第 2 期才有 `theme` / `name`。实现第 2 期时把第 0 期按钮接到建 Lane。

### 5.4 明确不做

- 自然语言 → 自动开三条车道
- Lane 之间自动接力或自动选 Agent
- 并入科研 `workspaces` 表
- 任意 git 命令框（v3.179）

---

## 6. 第 3 期 — Runtime 可替换

`AgentSpec` 描述 Runtime，不再默认「必有本机二进制 + PTY」。缺省仍是今天的 Local CLI。

### 6.1 RuntimeKind

```text
local_cli   现有 PTY + launch_plan     交互 Agent 的 100%
headless    现有 ai.rs / scheduler     升格为正式 Runtime，不再像内部杂务
custom      用户登记的命令 + args      用来证明「不是 CLI 也能进工作台」
cloud       预留；有稳定官方 API 再加一张规格，不预研、不自建
```

新功能按 `AgentRuntime` 挂：

```text
start(run) -> handle
stop(handle)
resume(session) -> handle    // 无会话格式则 Unsupported + 原因
```

`LocalCli` = `pty_spawn`。`Headless` = `run_agent_task`。会话解析器 / usage 提取器仍每 CLI 一份，不数据化（v3.13 边界）。

### 6.2 Custom Runtime（本期最小验收）

用户登记：`name` + `command`（经 `resolve_binary`）+ `args`。无 Ccode 密钥注入、无 session 解析、无 MCP/技能分发。

- 在 `isolationPath` 里起 PTY（当 shell 命令跑）
- 能停、能看输出
- 若改了文件，走现有改动面板 / 评审
- 命令相对路径拒写（与 MCP stdio 同一红线）
- 不进九家清单，不当第九+一家 CLI

这是抽象证明，不是插件市场。

### 6.3 Cloud

只定边界：鉴权走现有网关/官方账号双轨之一；事件映射进 Run events；隔离仍是本机 worktree（云端沙箱 = 对方的事，Ccode 不自建 Docker/VM，v3.8）。**没有稳定、可本机鉴权的官方 API 之前不写实现、不占 UI。**

---

## 7. 定时写入隔离（设计完成，实施待拍板）

现状：scheduler cwd = 项目根，绕过验收层。架构 §11.4 已记为定位决策。

**推荐方案（拍板后按此做，不要另开第三套）：**

- 每个日程一次 Run，`taskKind=watch`，`isolationPath` = 科研工作区 `ccode/watch-<YYYYMMDD>`（当天复用，不每天狂建）
- 技能简报继续约束只写 `notes/inbox.md`、`papers/watch-*.md`
- 跑完收件箱「新命中可评审」；合并走现有工作区评审，禁止静默合进主仓
- 失败 / 超时分列状态（§11.4 已列）

**若拍板维持写主仓：** UI 必须写明「这是直接写主仓的哨兵」，且能力表 §3.7 仍要做。不得 silently 两种都做。

未拍板前：第 0 期只做能力标注；第 1 期 watch Run 的 `isolationPath` 先记项目根并打标 `sentinel: true`，方便以后改路径不改对象。

---

## 8. 三档工作方式怎么用这套对象

| | 科研 | 编程 | 办公 |
|---|---|---|---|
| Task | 流程一步（已有） | Lane（第 2 期） | 文档（现有即可） |
| 并行 | 默认顺序；多想法卡 ≠ 多车道 | 人声明多 Lane | 不作为主路径 |
| Isolation | 步骤 worktree | 分支 worktree | 通常无 |
| 开 Run | 开工弹层（已选 Agent） | 进入树 / 再开一条 | 问 AI |
| 验收 | 工作区评审合并 | 改动面板 + 合进基准 / PR | 人保存文档 |

异构项目（仓里既有论文又有代码）仍是一张主界面、一种 `work_mode`，不做转换（v3.179）。

---

## 9. 现在不能完成的设计（不要假装写完）

| 项 | 原因 |
|---|---|
| 具体哪家 Cloud API 的字段表 | 没有稳定官方 API；到时候加一张规格 |
| 自动拆工 DAG / Review Agent | 已否决（v3.5 / v3.10） |
| 科研/编程 worktree 并库 | 已否决 |
| 定时是否改隔离树 | 推荐方案在 §7，**实施等拍板** |
| 多 Lane 一起开一个 PR | 第 2 期明确不做；真要做再单独立项 |
| 编排语言 / 自研 MCP host / Docker 沙箱 | 已否决 |

---

## 10. 落地顺序与改动面

| 期 | 内容 | 主要文件 | 状态 |
|---|---|---|---|
| 0 | 工作台 `runs[]`；编程再开一条；编程开工带 Agent；标签标题；收件箱文案；编程 TASK.md；能力表只读/无头 | `workbench-hero.ts` `WorkbenchPage.tsx` `CodingProjectView.tsx` `coding.rs` `kickoff-launch.ts` `inbox.ts` `agent_specs.rs` `types.ts` | **已落地（v3.221；v3.224：阅读标签还开着算正在进行）** |
| 1 | `runs` 表；spawn/无头/定时登记；收件箱 `action.run` | `pty.rs` `ai.rs` `scheduler.rs` `store.ts` `sessions.rs` | **已落地（v3.222：无头不进工作台）** |
| 2 | `lanes` 表；编程页分组 UI | `coding.rs` `CodingProjectView.tsx` | **已落地** |
| 3 | `RuntimeKind` + Custom | `agent_specs.rs` `pty.rs` | **已落地（Custom 最小；Cloud 不实现）** |
| 7 | 定时进 watch 工作区 | `scheduler.rs` `workspaces.rs` | 设计完成，**实施待拍板** |

实现某一期时同步 `docs/user-guide.md` 对应操作；未实现不得写进手册当已有功能。发版才写 `CHANGELOG.md`。
