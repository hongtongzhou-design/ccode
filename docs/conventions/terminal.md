# 约定：终端与工作台

> 适用范围：TerminalPage、PTY 生命周期、评审/冲突覆盖层、收件箱与注意力标记、改动面板、键盘流、会话关联。从 AGENTS.md 迁入（原文照录，未做语义改动）。

## 终端行为（用户明确要求；配色 = VS Code Dark+ 调色板，集中在 `TerminalPage.tsx` 的 `theme` 一处）

- 「停止」或 agent 退出后必须**自动回落用户登录 shell**（`$SHELL -l`，同 cwd），不死在最终画面；手动 `exit` 不自动
  重开；回落 shell 不带 profile env；agent/shell 共用 `pty.rs` 的 `spawn_tracked`，退出事件按 PTY 类型区分。
- **重启只恢复标签元数据，不恢复 PTY**：白名单限 label/cwd/agent/profile/model/sessionId，禁存 PTY id/scrollback/密钥/
  env/run 脚本；重开后为「上次任务，可恢复」占位，点击才建新 PTY；目录/profile 失效留在可编辑启动栏提示，禁自动换目标。
- **预览编辑器不映射同名文件**：切项目/工作区/标签 cwd/树根时清空旧预览，由用户在新根重选，禁自动打开新根同相对路径
  文件；有未保存改动先确认，取消则不切根；主仓库文件保存按钮警示色 + 二次确认。
- **`.ccode` 目录对「默认隐藏」豁免**：文件树 `list_dir` 在 `showHidden=false` 时仍显示 `.ccode`（任务书草稿
  drafts/、help-wanted 等是用户要找的内容，预览关掉后只能从这里找回）；同一理由 `fs_noise_skip` 也豁免
  `/.ccode/`——AI 改草稿必须能触发预览实时重载。其余点开头条目/隐藏目录照旧隐藏、照旧过滤。
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
  紧凑双侧控件，AI 理由单行展示、用户显式执行。**提交信息可留空（v3.97，面向不懂编程的用户）**：留空走
  `defaultCommitMessage` 本地规则默认信息（chore: 更新 N 个文件），不调 AI、不拦提交——评审与归档弹层同口径，
  与改动面板「留空 = 快速提交」、主仓快速提交面板的先例一致；想写更好的点 ◈。
- **改动面板跟随左栏文件树的根，而非终端标签 cwd**（v3.82，用户拍板）：「我在看哪个目录，改动就显示哪个」——
  FileTree 根切换（钻取/上级/项目区切根）成功后经 `onRootNavigated` 上报 TerminalPage（`treeRoot`），GitPanel 吃
  `treeRoot ?? activeCwd`；切标签/分屏焦点变化时 TerminalPage 主动清空分叉回落标签 cwd（树未挂载时无人上报，必须兜底）。
  对话页签不跟随（对话天然属于终端会话），文件预览沿用 `preview.root ?? activeCwd` 不变。
- **标签条只放标签管理 + 布局分段 + ⋯（v3.88 减负，13 类 → 5 类）**：原先一行同时挂着
  注意力点/标题/可恢复/◧/×/＋/git 芯片/✓保存/可合并 pill/◧分屏/◫工作台/⤢专注/⋯。按职责三分：
  ① **标签管理**（点/标题/可恢复/◧/×/＋）留原位；② **布局三开关合成一个分段控件**
  （◧ 分屏 / ◫ 工作台 / ⤢ 专注终端本质是同一维度「这块屏怎么排」，互斥高亮，`bg-seg-sel` 选中）；
  ③ **状态镜像下移**到中带底部状态条（见下条）。**`⋯` 改为常驻**——原先只在专注模式渲染，
  非专注时同一批动作散在标签内启动栏的 `⋯` 里，两套菜单内容高度重叠。
  **标签支持拖拽排序（v3.93，用户提出；Ghostty 式跟手拖动）**：pointer 事件自实现（按下超 6px
  横移进拖拽态，window 级 move/up/cancel 监听）——**不能用 HTML5 DnD**（`draggable`/`onDragStart`）：
  Tauri 原生文件拖放（`dragDropEnabled` 默认开）会拦截 WKWebView 的拖拽手势，dragstart 根本不触发；
  全站拖文件走的都是 `onDragDropEvent` 原生事件而非 HTML5 DnD。拖拽手感：进拖拽态时测量各槽位
  `getBoundingClientRect`（拖拽期间 `tabs` 顺序不变，测量值才有效）；源标签 `translateX` 跟手
  （钳制在标签条内容范围内、relative + z-10 浮起 + `bg-raised`），原位置与目标槽位之间的标签各
  退/进一个槽位（150ms transform transition 滑动让位，位移用相邻槽位测量差而非假设等宽）；
  松手先让源标签 transition 吸附到目标槽位、动画结束才 `moveTab` 重排清态（避免瞬移跳变），
  落定后吞掉紧随的 click 防误切换。钳制与目标槽位判定抽在 `src/tab-drag.ts`
  （tests/tab-drag.test.ts）——**目标判定必须 `>=` 中线**：钳制上限恰好让源中心到达末槽中线
  （等宽槽位等号成立），严格 `>` 会让「拖到最右」永远差一个无穷小、末槽永远不让位（两标签时
  左拖右 100% 复现）。顺序即 `tabs` 数组顺序，重启持久化本就按数组存，顺序自动带过去。
- **中带底部状态条（v3.88）**：git 芯片 `⑂ 分支 +N -M`、`✓ 保存`、`● N 个可合并` 从标签条下移至此。
  理由：它们是**结果不是入口**，放顶部与标签抢注意力；状态栏是 VS Code / Codex 的通行心智，
  `✓ 保存` 在底部误触概率也更低。**v3.83 的行为语义一字未改**（点数字开改动页签、
  `✓保存` 走 defaultCommitMessage 全量快速提交、隐藏 GitPanel 实例继续轮询喂数据），只是换了位置；
  专注终端下同样保留（那正是最需要「手边有个保存」的场景）。整条在非仓库且无可合并时不渲染。
  **v3.90（用户拍板）**：芯片在「工作区干净但有未推送提交」时也要出现——`GitSummary` 增
  ahead/behind 字段，芯片渲染条件从 `files>0` 放宽为 `files>0 || ahead>0`；芯片行内新增
  `↑N`/`↓N`（悬浮白话解释）与「⇧ 推送」按钮——走与改动面板同一个 `git_push` 命令
  （含无上游自动 `push -u`），只在 `ahead>0` 时渲染（没提交可推时摆着只会误点）；
  行内反馈（推送中/已推送/失败 2.5s）与 ✓保存 同口径、独立计时器。
- **右栏头部低频动作 hover 才现（v3.88）**：「⇱ 专注内容」「× 收起工作台」与「↺ 完整回放」（v3.91 起
  由文字钮改图标钮）均挂 `hoverRevealClass`（头部行挂 `group`）；双击页签 = 专注内容的语义不变。
  **v3.91**：会话上下文（状态点 + 标题/agent/会话 ID/状态）从页签行迁到「对话」页签底部细条
  （整条可点 = 完整回放，状态点按全局口径 size-2），页签行只留三页签，标题不再截断。
  **v3.92 差异化**：底条不再重复状态栏的 agent · 配置——未关联会话报关联状态（运行中 = 「等待会话关联」），
  关联后报标题/状态 + 右端 token 用量（session_usage 60s 轮询，与状态栏同命令同节奏）。
- **从其他页面进入终端页，右栏默认收起（v3.90，用户拍板）**：`visible` 假→真跃迁时检查交接——
  有 previewReq / pendingTerminal.rightTab / pendingTerminal.previewPath（资源面板「查看」、
  主仓改动提醒、开聊带开草稿）才开右栏，否则 `setRightOpen(false)` 只剩终端。判定用
  `useAppStore.getState()` 现查（交接与切页是同一批 store 更新），不依赖 effect 顺序；页内动作
  （单击文件树文件、◫ 工作台、对话联动）照常展开，不受影响。
- **标签条变更芯片（v3.83，Codex 式，用户拍板）**：标签条右侧常驻镜像改动面板摘要（`⑂ 分支 +N -M`，仅当前目录
  是仓库且有未提交改动时出现）；点数字 = 打开右栏「改动」页签，「✓ 保存」= 全量快速提交（message 走
  defaultCommitMessage 本地生成，工作区视图 paths 传 null——与面板「快速保存到历史」完全同口径，行内
  保存中/已保存/失败 2.5s 反馈）。数据源是 GitPanel 上报的 GitSummary（onTotals 扩展）；**右栏关闭/专注终端时
  改动面板随右栏卸载，须挂 display:none 的隐藏 GitPanel 实例持续轮询**（与面板实例互斥永不同存），否则芯片无数据。
- **改动面板空信息走本地快速提交**：非空原样提交；为空按文件状态/数量即时生成中性默认信息直接执行 `git_commit`，不
  为此启动 AI；失败保留默认信息供重试；◈ 按钮与手动输入保留，仅主动点 ◈ 才调 AI。
- **终端右栏统一称“对话”，有界实时视图**：仅最近 50 条；标题/agent/会话 ID/状态在「对话」页签底部细条
  （v3.91 起；页签行与对话头部合并为一行，页签行只留三页签 + hover 动作钮）；在底部附近才自动跟随，向上阅读后禁强制滚动，改显示“有新消息”。
- **启动栏与状态栏分工（v3.91）**：启动栏主流程 Agent → 配置 → 模型 → 启动，技能/MCP 胶囊右对齐在启动行末端；
  工作目录不再占启动栏，改由底部状态栏 📂 胶囊浮层编辑（仅未启动可改；运行/shell 中 cwd 由 pty_get_cwd
  4s 回写跟随，shell 里 cd 即可）。未启动时画布中央渲染空态引导卡（启动/恢复 + 打开 Shell）。
  **空态卡元素收敛（v3.93 用户拍板）**：无顶部图标盒、无说明小字（「上次任务还在，可接着跑」
  这类全删——按钮文案本身已说清现在该干嘛），卡片 `w-80`，agent 名（text-base）与配置胶囊
  （text-xs）放大为视觉主体；主按钮宽 `min-w-40 px-5` 自适应内容——勿按比例（w-2/3）随卡片宽
  缩放，卡片一窄按钮文字就溢出。
- **文件树系统目录置灰（v3.91）**：`list_dir` 对家目录直下命中平台清单的目录（macOS：Library/Applications；
  Windows：AppData 等）标 `isSystem`，前端行 opacity-50 + title 注「系统目录」；普通用户目录不置灰，交互不变。
- **终端左栏两段化（v3.42）**：常驻 = 项目区（ProjectRail）+ 文件树；「打开的标签」折叠区已删除（runInputs 镜像保留）；
  「最近项目」收进文件树搜索行 ⌄ 浮层（真进入/↗ 新标签语义不变）；区间靠留白分层。**项目区固定列出所有建有活跃
  工作区的项目**（每仓一小节：组头 + 主文件夹节点 + 活跃工作区行），cwd 命中的当前项目置顶标注「当前」、无活跃
  工作区也保留；行内交互（真进入/悬浮/size-2 状态点）不变。
- **右栏可调分栏，不新增普通内容全屏路由**：左缘拖拽调宽并记忆；**宽度上限不写死像素**（v3.60 前曾限 820px），
  随窗口自由拉宽、只给中带终端保留 340px 最小宽度（`TERMINAL_MIN_RESERVE`），下限 360px；宽屏动作暂隐工作树但保留终端，再执行恢复，双击
  对话/预览/改动页签同义；宽度变化必须触发 xterm 重新 fit；任务评审仍用全宽覆盖层。
- **渲染器按平台分流（实测定论，勿回退）**：macOS 不走 WebGL——xterm 的字形图集→GPU 纹理采样在
  WKWebView 里整体偏软发糊（A/B 截屏实测 DOM 渲染明显更锐利，Safari 同引擎复现一致），故 macOS 直接用
  xterm 默认 DOM 渲染器；Windows 保留 WebGL 加速，但加载前必须过 `isSoftwareWebGL` 探针（TerminalPage.tsx）：
  Windows/WebView2 GPU 被拉黑时退回 SwiftShader 软件渲染，上下文能建但终端持续闪烁，try/catch 拦不住；
  探测失败同样不用 WebGL，勿删此兜底。
- **弱字亮度兜底 `minimumContrastRatio: 4.5`**（VS Code 终端同款默认值）：暗色主题下 brightBlack 灰字、
  dim 修饰文本对比度不足发暗，xterm 自动提亮不达标的颜色；只作用于显示，不改调色板定义。
- **运行中会话关联排他 + 复合键**：固定 session id 的 CLI 精确锁定；其余 CLI 启动前按 agent+归并后项目登记 claim，同批
  并发统一排序分配，已分配会话进程内不得转给另一标签；前端 live/open 一律以 agent+sessionId 为键，完整回放跳转前先刷新索引。

## 收件箱与注意力

- **精确注意力标记（hooks 桥接，七家）**：`session_tail_state` 对设置页已开启的 agent 优先读 hooks 事件日志
  （`<config>/ccode/hooks-state/<tag>-hooks.jsonl`，尾部窗口读取），日志缺失或超 10 分钟无更新回落尾部文本推断——
  TTL 与回落语义不变，消费侧（终端注意力点/运行中聚合/OS 通知/收件箱）零改动。事件映射：用户提交→working /
  轮次结束→done / 等待确认→confirm；各家原生事件名与 matcher 以 hooks.rs 的 BRIDGE_SPECS 为单一出处
  （调研结论录 matrix §12），日志解析兼容 snake_case/camelCase 双信封、事件名去下划线小写归一、
  grok Stop 只认 reason=end_turn（teardown 会以 shutdown/channel_closed 重发，跳过）、会话归属双键匹配
  （session_id==会话文件主名 或 transcript_path==完整路径）。支持 claude/qwen/codebuddy/gemini/kimi/grok/codex
  七家；cursor（无「等待确认」等价事件）与 opencode（无 shell hooks 形态）未接入。**两个生效条件**：codex 非托管
  hook 首次需在其 TUI /hooks 面板人工信任后才执行（按 hook 定义 hash 记信任，改命令失效需重审——不自动 bypass，
  安全优先，UI 备注引导）；codebuddy 启动时快照 hooks 配置，已运行的会话需重启后生效。
- **收件箱条目通用忽略（v3.88）**：`filterDismissed`/`dismissInboxItem`（inbox.ts）把原先只有 `help:`
  才有的屏蔽能力推广到全部七类。签名口径同 help——`text|actionLabel` 变化即视为新事件、旧忽略自动失效，
  所以「忽略」不会真的漏掉事情。生产端（WorkspacesPage）在写入 store 前过滤。
- **顶栏 = 全局上下文栏（v3.88）**：macOS 自绘标题栏从「只有收件箱胶囊」升级为
  左「当前项目 · 步骤」（`store.contextLabel`，WorkspacesPage 唯一写入方，只读消费不新增轮询）
  + 中「搜索与命令 ⌘K」+ 右「运行中计数 + 收件箱胶囊」。**与 v3.38 否决的「全局顶栏」不冲突**：
  那条否决的是新增垂直占用，而这条栏在 Overlay 模式下恒占 40px 且不可省（红绿灯靠 `pl-[78px]` 让位），
  这里是利用既有空间。`chromeHidden` 执行态下左中两段隐藏，只留让位与收件箱。
- **首页「待你处理」收件箱（v3.39；v3.42 起横跨项目导航与详情两栏之上；v3.59 起文档流单行 strip + macOS 收进自绘标题栏；v3.60 扩四类新来源）**：聚合工作区冲突/可合并
  + 终端注意力（仅待确认），排序 冲突 > 待确认 > 可合并 > 待核验 > 待发送 > 配置失效，为空整块不渲染；条目为可序列化 `InboxItem`（action 描述非闭包），
  由 WorkspacesPage 签名去抖镜像进 store（唯一写入方），点击统一走 `runInboxAction` 派发（review/tab/session/digest/artifacts/profiles 都走 store 一次性请求）。
  **v3.60 新来源（全部过「是否阻塞人的决策」闸）**：**产物待核验**（后端 `pending_artifact_checks`：活跃工作区绑定步骤的
  expectedArtifacts 全部产出且 mtime ≥ 工作区创建时间，可合并/冲突已覆盖的不重复报——产物多为 gitignore 的 *.pdf，git 状态看不见，
  不提醒就是黑洞；action `artifacts` → 选中项目 + 展开任务行产物清单）；**接力待发送**（digestJob ready 未消费）；**配置失效**
  （`profileIssues`：只镜像用户触发的三层验证/设为全局复检失败，验证通过或 profile 删除即摘除，**不新增后台网络轮询**）；
  **冲突升级文案**：`WsHealthDto.stale_base`（MERGE_HEAD ≠ 基准 tip，health_impl 内仅 merge 进行中多一次 rev-parse）命中时
  冲突条目改「基准已前进——需重新同步」，动作仍走 resolve-conflict（评审层自动以当前基准 tip 重备两侧）。
  **macOS：标题栏自绘（tauri.conf `titleBarStyle: Overlay` + `hiddenTitle`，capabilities 加 `core:window:allow-title` 与
  `core:window:allow-start-dragging`——缺后者 `data-tauri-drag-region` 拖拽静默失效），窗口标题不在界面渲染
  （用户拍板：纯拖拽区即可，标题字符串保留在配置里供自动化定位窗口），收件箱 =
  栏上的 Ghostty 式胶囊 + 下拉明细，页内 strip 不渲染；**chromeHidden 执行态下标题栏体仍必须保留**（Overlay 模式红绿灯始终悬浮
  左上角，靠栏的 `pl-[78px]` 让位，整条隐藏会被按钮压内容且胶囊丢失），只省略底部分隔线**；Windows/Linux 保留原生标题栏 + 页内 strip（32px 一行，展开明细为悬浮下拉，
  遮罩/Esc 收起——整体悬浮 pill 遮挡内容被用户否决）。终端运行状态经 `terminalRunInputs` 镜像进 store 跨页
  只读（TerminalPage 唯一写入方，不新增轮询）；跳终端激活标签走一次性 `focusTabReq`（已关闭标签静默忽略）。
  **注意力信噪比总规则（v3.60，用户拍板全链路清理）**：「已回复」（done = 回合结束）**在全链路无任何视觉标记**——不进收件箱、标签/项目区
  工作区行不打点、OS 通知不发、`run-overview` 不占排序档，done 态仅剩会话尾部推断的内部状态；理由 = 每回合结束都会亮，噪音 > 信号
  （同 v3.59 步进器绿点否决）。同批口径：**纯状态不用语义色**（分组头「进行中/待评审」计数降灰点，仅「阻塞」用 err 色；项目导航行副行只留
  「M 个待处理」，活跃任务数删除）；**瞬态反馈自动消退**（「✓ 工作区已创建」横幅 10s 自收，setup 失败除外）；**常驻 pill 降裸字**
  （标签「可恢复」、启动栏「端口段已注入/上次任务」去底色去 link 蓝）；**无限脉冲禁留**（标签「工作中」与项目区同用有界
  `animate-pulse-brief`）；端口「N 个监听中」只在展开后显示；产物清单「刚更新」标记删除。新状态指示进界面前先过「是否阻塞人的决策」闸。
  **v3.59 起导航行「待处理」与收件箱同口径按项目摊开**：终端待确认与外部 live 待确认按 cwd 最长前缀归属项目根/
  工作树（`run-overview.ts attributeToProject` 纯逻辑，段边界防误中），收件箱给总数、导航行给分布。同批：收件箱条目数
  镜像进 store（`inboxCount`，WorkspacesPage 唯一写入方）。**侧栏不挂任何徽标**（终端运行数、工作区待处理全部取消，
  三平台统一——数字胶囊突兀、size-2 圆点与项目行状态点撞语义、9px 裸数字用户仍嫌吵，三轮均被否决；计数只在悬浮
  title 与 macOS 标题栏胶囊/页内 strip 出现）——收件箱仍为空不渲染，发现性由标题栏胶囊（mac）与页内 strip（Win/Linux）承担。

## 键盘流与分屏（v3.40/v3.41；v3.58 起页切逐页可自定义）

- ⌘K 命令面板（过滤纯逻辑在 `command-palette.ts`）、页切（顺序同侧栏；
  清单单一出处 `hotkeys.ts` PAGE_HOTKEY_DEFS，默认 mod+1..8，`hotkeyPages` map 按页覆盖、整组总开关 `hotkeyPageSwitch` 保留）、
  ⌘\ 执行态隐藏侧栏（`chromeHidden`，session 级）；⌘F 已被终端搜索占用。主题清单单一出处 `src/themes.ts`。绑定可自定义（设置页录制，
  `hotkeys.ts` 组合串，空串=禁用，settings.json 四字段；录制冲突判定对全部在用绑定互判）。通知动作 `ccode.attention` → 聚焦窗口 + 聚焦对应终端标签，
  无 extra 回首页收件箱；通知 extra 带 tabId/cwd（v3.60 起通知只有「待确认」一种，原「已回复直达评审覆盖层」链路随 done 通知一并移除）；
  收件箱经 `session_tail_state` 直查外部 live 会话（≤10 条）。
- **终端分屏（SplitView）只是显隐与排序变化**：全部标签仍在同一容器保持挂载，靠 flex order 把活跃标签（左）与对照标签
  （右）排到分隔条两侧，禁止把标签移进第二棵子树（会重挂载杀 PTY）；右栏/文件树/改动跟随「活跃 pane」（点击切换，
  focusedId），分屏时两个 pane 的 PTY 都推流；分屏状态不进持久化白名单，仅分隔比例本地记忆。
- **关标签/关窗进程守卫**：仅 `running && ptyId` 的 agent 标签弹确认（shell/已退出一律不弹），存活判定以后端
  `pty_has_running_process` 为准，命令不存在/报错时静默跳过不阻塞关闭；关窗前对全部在跑标签统一确认一次，确认后放行
  （allowWindowCloseRef 防 onCloseRequested 重入）。Tauri 的 `onCloseRequested` 前端封装最终调用 `window.destroy()`，且确认后
  会调用 `window.close()`；`src-tauri/capabilities/default.json` 必须同时保留 `core:window:allow-destroy` 与
  `core:window:allow-close`，否则进入终端页挂载监听后窗口无法关闭。

## 输入侧：图片粘贴 / 文件拖入 / 右键菜单 / 链接点击（2026-08-17）

- **九家 CLI 图片输入的通吃口径 = 绝对路径文本写进 PTY**（各家升级行为分两派，明细见 matrix §11）；
  macOS 直读剪贴板键是 Ctrl+V。机制明细：前端纯逻辑在 `src/terminal-input.ts`（`escapeShellPath`/`joinDroppedPaths`/
  `firstImageItem`/`imageExtFromMime`/反馈文案，tests/terminal-input.test.ts），落盘在 `src-tauri/src/clipboard.rs`。
- **paste 事件拦图片**：capture 阶段挂在 xterm 容器上，`clipboardData.items` 含 `image/*` 才
  preventDefault + stopPropagation（拦掉 xterm 默认文本粘贴），落盘后把**转义绝对路径**写 PTY（不补换行、
  不自动发送）；无图片一律不干预。终端未启动时提示「终端未启动，无法粘贴」，不落盘。
- **macOS Ctrl+V 透传**：`attachCustomKeyEventHandler` 里拦 `keydown + 仅 ctrl + v` → `pty_write("\x16")`，
  return false（网页侧 Ctrl+V 在 WKWebView 不产生 paste 事件也到不了 PTY；CLI 收到 \x16 自读系统剪贴板）。
  **kimi 特判发 CSI-u `\x1b[118;5u`**（kitty 协议，v=118 + ctrl 修饰位 5，与同函数 Enter→`\x1b[13u` 同模式，
  **待实机验证**）。非 mac 不拦：Windows 各家贴图用 Alt+V（本就透传为 ESC+v），Ctrl+V 保留文本粘贴语义。
- **文件拖入转路径**：`getCurrentWebviewWindow().onDragDropEvent`（HumanTasksList 同款），只处理 `drop` 且
  坐标命中本终端容器 rect（devicePixelRatio 两口径都试）；隐藏标签 rect 全 0 天然不响应；**只在自己 rect 内响应，
  不 return 掉人工事项导入等其它监听**（按坐标域区分共存）。多路径 shell 转义后空格拼接，不换行防误执行。
- **右键菜单**：容器 `onContextMenu` → 复用 `ContextMenu` 组件（复制按打开时选区裁剪 / 粘贴先试
  `navigator.clipboard.read()` 找图片、回落 readText / 全选 / 清屏 / 查找输出）。**链接点击** =
  `@xterm/addon-web-links`（0.12.0 配 xterm 6），点击 handler 走 `@tauri-apps/plugin-opener` 的 `openUrl`
  （capabilities 已有 `opener:default`，与技能页同源，不另引入机制）。
- **临时图片生命周期**：`save_clipboard_image(bytes, ext)` 落 `<config>/ccode/tmp/paste-<时间戳>-<随机>.<ext>`
  （ext 白名单 png/jpg/jpeg/gif/webp，非法归 png；上限 50MB），每次调用顺带清理 7 天前 `paste-*`；**不加
  arboard 依赖**（读剪贴板在前端 paste 事件完成，Rust 只收字节）。

## 沉浸阅读区（v3.96；批次 B1/B2/B3）

- **覆盖层形态**：`ReaderOverlay` 挂在终端页内（`fixed inset-0 z-40` 页面模态档，与评审覆盖层同思路），
  三栏「笔记｜PDF｜Agent 终端」，**不要底部终端**（用户拍板）；底下终端/PTY/右栏全程保持挂载，退出即回原样。
  覆盖层会盖住 App 自绘标题栏，**覆盖层自带顶栏必须自担两件事**：可拖动 + macOS `pl-[78px]` 红绿灯让位
  （口径同 App.tsx 顶栏）。拖拽用**手动 `startDragging`**（mousedown 落在按钮/链接等交互元素上才放行）——
  `data-tauri-drag-region` 属性版只认落点元素本尊，顶栏几乎全被子元素占满，实测拖不动（v3.99 教训）。
  任何 inset-0 覆盖层同理，漏了就是按钮重合 + 窗口拖不动。
  分隔条拖拽记宽度（localStorage `ccode.readerSplitL/R`，钳制与像素换算在 `src/reader.ts`），左右栏可收起；
  右栏底部还有终端状态栏——TerminalStatusBar 节点随 xterm 宿主一并 DOM 搬移（`data-statusbar-host` 标记，
  槽位缺席时留在原 pane，两槽位挂载时机不同步故 host/bar 独立判定）。
  **建档配对（v3.99）**：`ensure_paper_note` 建档前先扫 notes/*.md 头部的「来源行」（lit-notes 的
  `> 来源 PDF：<相对路径>` 或建档模板的 `> 来源：<path> · 开始阅读`）——命中即打开该笔记不另建 slug 笔记，
  此前误建的空模板 slug 笔记顺带清进回收站；反向 `pair_pdf_at` 同样来源行优先、标题互相包含兜底。
  v1 单窗全屏，结构上预留 v2 独立弹窗能力（未做）。入口三处统一走 store 一次性请求
  `readerReq: { pdfPath, projectRoot }`：PDF 预览工具条「⛶ 沉浸阅读」、文献雷达精读清单「开读」、文件树 PDF 右键。
- **指定笔记入口（v3.98，精读笔记产物）**：`readerReq`/阅读区 state 增加可选 `notePath`——`notePath` 非空时
  ReaderOverlay **跳过 ensure_paper_note 建档**、笔记栏直接编辑这份 md（否则会按 PDF slug 再建一份模板笔记，
  与 lit-notes 的 `<序号-短标题>.md` 并存打架）。md 入口三处：产物核验清单 md 就地预览弹层「⛶ 沉浸阅读」、
  终端页文件树 md 右键、终端页 md 预览工具条「⛶ 沉浸阅读」（read 态；缺省仍是 FilePreviewEditor 自带单栏沉浸层）。
  三处统一走 `reader_for_note`（reader.rs）一次给齐归属项目根 + 配对 PDF + 实际笔记路径：归属反查 = 注册项目根
  canonical 前缀直含 → 工作区 worktree 包含则映射主仓副本（主仓还没有 = 未合并，明确报错「评审合并后再进」）；
  配对 = 笔记 stem 与 project.toml `type="paper"` 资源的文件 stem 做 `normalize_title`（lit_watch.rs，已提
  pub(crate) 复用）**互相包含**（与前端 lit-watch.ts `paperResourceFor` 同口径），多命中取规范化最长者，
  无命中报错透出。另有根已知的变体 `pdf_for_note`（返回 Option，供已知 projectRoot 的调用方）。
- **右栏 = 阅读会话标签的 xterm 终端画面**（2026-08-18 用户拍板：右栏从结构化对话视图改为真实终端，
  用户看着终端直接敲）：TerminalPage 用 `useLayoutEffect` 把该标签的 xterm 宿主节点（TerminalView 容器 div，
  `data-terminal-host=<tabId>`）appendChild 进覆盖层右栏槽位（槽位经回调 ref + state 上报，右栏收起槽位卸载时
  自动回搬），关闭时插回原槽位最前——FilePreviewEditor 的 Monaco 宿主移动同款先例，PTY/xterm/scrollback
  不重建不丢；容器上既有 ResizeObserver 在尺寸变化时自动 fit，无需额外触发。阅读区打开时该标签被提到活跃。
  没有独立的对话视图与输入框：「◈ 问 AI」/圈选截图注入仍写该标签 PTY（`injectToReader`），文字出现在终端
  输入行里正好可见。无配置引导卡、标签被关的「重新启动会话」卡片行为保留。标签的 ⌘F 搜索条与粘贴反馈小条
  留在终端页原区域（阅读区里看不见，退出后可用）。**同日拍板：不做扩展性功能，只做场景必需**——快捷 chips
  （图导游/总结这页/帮我改笔记）与「✦ 工具」页签（译历史/生词本表格/大纲三段）砍掉待需求，
  `ReaderToolsPanel` 已删；⌘+点击段落对照的结果改在点击位置旁的选区同款浮卡呈现（可保存译段）。
- **Esc 级联阅读区最优先**：阅读区自己的 keydown 监听带 `isComposing` 守卫（中文输入法组词中按 Esc 是取消候选）；
  TerminalPage 的专注/右栏全宽 Esc 在阅读区打开期间直接放行不拦（`if (reader) return`）；圈选模式内的 Esc 用
  capture 相 + stopPropagation 抢在关阅读区之前（先退圈选，再退阅读区）。**焦点在右栏 xterm 里时 Esc 被 xterm
  就地消化（打断生成/vim），不冒泡、不关阅读区**（与终端页专注模式同一口径）——此时退出用「← 返回」或先点别处再 Esc。
- **⌘E 翻转笔记栏阅读/编辑**（组合串 `READER_MODE_HOTKEY` 在 hotkeys.ts，mod = ⌘/Ctrl）：ReaderOverlay
  全局 keydown 命中后经 `modeTick` 信号递进通知 FilePreviewEditor（tick/signal 先例：readerAgentTick），
  变化即翻转、初挂载不动作；**焦点在右栏 xterm 时不拦**（`rightColRef.contains(e.target)` 判定，
  Ctrl+E 是 readline 行尾——与 Esc 级联「键归终端」同语义）。切换按钮 title 只在接线（modeTick 存在）时
  才带快捷键提示。
- **保存译段/插入笔记的反馈口径**：成功 = 浮卡按钮变 ✓ + ReaderOverlay 右下角 toast + 笔记栏 watcher 自动
  回显；**唯一不回显的场景是笔记栏停在编辑态且有未保存改动**（dirty 时 watcher 停订）——此时 toast 必须
  明说「笔记栏有未保存改动，保存后可见」（dirty 状态经 FilePreviewEditor `onDirtyChange` 上报 ReaderOverlay，
  文案口径纯函数 `translationSavedToast` 在 reader.ts，tests/reader.test.ts 锚定）；失败一律 loud
  （PDF 栏顶部 hint 条 + toast ✗）。
- **Agent 上下文简报**：note 就绪且 `agentStatus.running` 为真时，ReaderOverlay 自动向阅读会话**直发**一行
  简报（「【阅读上下文】在读 PDF：<pdfPath>；配套笔记：<note.path>…」），按 note.path 去重一次性
  （换 PDF 后 note.path 变 → 重新简报；发送失败不标记，下次 running 跃迁重试）。已知竞态：send=true 会把
  用户输入行未发完的文字一起带出，running 守门后窗口极小，接受（注释在 ReaderOverlay 同效应处）。
- **注入单一内核 `injectToTab(tabId, data, send)`**：原 `injectToActiveAgent` 抽成按 tabId 的共用内核，
  右栏选段（活跃标签）与阅读区注入（阅读会话标签）走同一条链路，行为口径不变（缺省不自动回车、`send=true`
  一次拼接 `\r`）；选段「◈ 问 AI」/「↵ 直接发送」/圈选「发给 agent」全部经此。
- **阅读会话 reuseKey 口径**：进入阅读区自动起一个阅读会话标签（项目根 + 默认配置 + autoStart，快速开聊同款
  机制），`reuseKey = reader:<projectRoot>`（`src/reader.ts readerReuseKey` 单一出处）——退出再进找回同一标签
  接着聊；恢复出的占位标签不带 reuseKey 不参与复用；用户手动关掉标签后不连环重建（一次性标记，栏内给
  「重新启动」入口）；无可用配置时右栏给引导卡跳配置页，不自动起会话。
- **圈选截图两个去向**（裁好的 PNG 由 PdfContinuousView 交来）：「◈ 发给 agent」= 走 `save_clipboard_image`
  落**临时图**（终端粘贴图片同一命令/口径），路径 + 预填 prompt 写进终端输入行**不自动发送**（图是临时产物，
  不进项目目录）；「＋ 插入笔记」= 走 `save_reader_capture` 落 `notes/assets/`（PNG 魔数校验 + 同秒重名 -2/-3）
  并 `append_note_image` 追加进笔记「## 我的想法」小节（笔记栏经 watcher 自动刷新可见）。
- **md 阅读版式图片与相对链接后处理**（批次 B2，FilePreviewEditor）：相对/绝对路径图片经 `read_image_bytes`
  （白名单判定复用 pdf.rs `read_whitelisted_sync` 内核，png/jpg/jpeg/gif/webp/svg，20MB）转 data URL 内嵌；
  **http(s) 图片不加载**（隐私，用户拍板——笔记渲染不发网络请求），只显示链接文本；相对链接在阅读区笔记栏
  **原地打开** + 顶栏「← 回笔记」退回（previewReq 会开在阅读区底下看不见，故不走它）。
  异步落地守卫只用 `isConnected`、**不用 cancelled**（v3.99 修正）：该 setup 不幂等（img 换成占位 span），
  StrictMode 双跑/阅读⇄编辑重挂时后一次 setup 找不到 img，占位只能靠前一次的异步结果落地；脱树守卫交给
  `isConnected`。`renderMathInto`（md-math.ts）同理在 await 前快照 TeX 源码，重跑幂等。
  **编辑→阅读同步（同日修复）**：编辑期间 `text` 状态不随键入更新（dirty 时 watcher 停订、保存又只动
  lastSavedRef），直接切回阅读会停在旧盘稿（删除/新增都看不见）——`switchMode("read")` 时把
  `editorRef.getValue()`（含未保存改动）setText 进去，阅读态 = 当前缓冲的预览；反向不走这条路
  （external-reload effect 遇模型相同自行跳过）。
- **笔记编辑态粘贴图片**：项目内 md（有 projectRoot 语境）落 `notes/assets/` 并在光标处插 `![](相对路径)`；
  非项目内文件回落临时图路径文本（终端粘贴同口径），不混用两条通道。
- **术语淡高亮实现约束**：textLayer 落地后对**文本节点**跑整词匹配（`findGlossaryMatches`，大小写不敏感），
  命中处包 `<span class="ccode-gloss">`（点状下划线；悬停释义由 PdfContinuousView 事件代理命中 `.ccode-gloss`
  出 HoverTip，禁原生 title）；cleanup 先还原旧高亮再重包（`replaceWith(childNodes)` + `normalize()`），
  幂等可重入——**不得破坏 textLayer 文档流**（选区/复制行为不能变）。护眼反色只反 canvas 层
  （CSS filter，不动 canvas 数据），进度/护眼均按文件记忆（localStorage `ccode.readerProgress.`/`ccode.readerDark.`）。
- **生词本/译段落盘契约**：`notes/glossary.md` 表格（`| 术语 | 释义 | 出处 |`）是机管文件，表外内容保留；
  格式契约与 `src/reader.ts` 双端镜像（前端不直接写文件，那组函数是格式的单一可读规格 + 测试锚点，
  改动需同步）；翻译结果 v2 起直接进顶部翻译面板（在途骨架/失败重试同承载，选区旁浮卡已取消），
  「存进笔记」才经 `append_note_translation` 写进笔记「## 译段」小节（✓ = 历史条目的持久 saved 标记）。
- **翻译面板（右栏终端上方）+ 历史抽屉（v2 结构定稿）**：翻译默认**不进笔记**——选段浮动条「译」/
  ⌘+点击段落只负责触发（PdfContinuousView 的 `onTranslate` 回调上送原文+页码），状态机与面板全部在
  ReaderOverlay（`runTranslate`：`tlPending` 在途态 → 纯文本翻译 → 成功入历史；× 时递增 `tlReqRef`
  作废在途结果）。面板 = 独立组件 `ReaderTranslatePanel`（右栏状态行之下、xterm/引导卡之上，占布局流；
  右栏整体收起随终端一起不见；无 agent 标签的引导卡/重启分支照常可用——历史/存进笔记不依赖会话）。
  **块级对照（唯一形态，无对照开关）**：原文整段弱色小字（text-xs/l4）在上、译文整段正文（text-sm/leading-6）
  在下，两块均 `text-justify` 两端对齐、间距 mt-1；表头「原文」开关控制原文块显隐（默认显示）。
  **原文/译文渲染与「存进笔记」前都先过 `reflowBlockText`**（reader.ts 纯函数：PDF 文本层的硬换行与
  断词是排版产物——`-\n` 断词接回、段内单换行英文转空格/中文直连、连续空行压成单换行、行首尾 trim；
  原文按 `{cjk:false}`、译文按 `{cjk:true}` 口径；抽屉两行摘要同样过）。封顶 40% 栏高、
  超出内部滚动（% max-h 挂栏根 flex 子级才解析定高）。chevron 只折正文留表头
  （组件内 state 不持久化、新翻译自动展开）；× = 面板整体消失本轮不再弹出（记当前显示条 at），收起态留
  一行动作条让「历史 N」抽屉随时可开。**历史抽屉点行 = 载入主面板**（`viewingAt` 按条目 at 标识当前
  显示条，不碰 latest 语义；新翻译进来自动回最新）；行内只留译文摘要（两行 clamp，第 N 页/相对时间已
  拿掉）+「存进笔记」收到摘要下方（动作不占正文宽度）；「复制」挪到主面板表头小图标钮（复制当前显示条
  的纯译文）。在途提示 = ◌ animate-spin +「正在翻译…」。**bilingual 逐句对照
  prompt 已下线**（原文整段由条目 original 字段承担）：`buildReaderTranslatePrompt` 回到单参纯文本；
  `parseBilingual`/`plainFromBilingual` 保留为**旧条目兼容 shim**（bilingual 期存的带标记 raw 在渲染/
  复制/存进笔记时转纯译文，新条目永不命中），测试保留。「存进笔记」走 saveTranslation 既有链路
  （toast/dirty 口径不变），存后条目标记持久 saved。数据源 localStorage `ccode.readerTlHistory:<pdfPath>`
  （键不变），封顶 50 先进先出，同原文重翻 = 替换置顶且保留已存标记；纯逻辑在 reader.ts，
  tests/reader.test.ts 锚定；写盘在 setState updater 里（StrictMode 双跑写同内容，幂等）。
  **生词卡是带输入框的表单，浮卡保留**；其释义预填走 `onRequestTranslate` 纯文本 + 独立 `glossReqRef`。
- **PDF 选区高亮 = pdf.js v6 DrawLayer 自绘**（v3.99 修正，PdfPageView）：原生 `::selection` 在 scaleX 变换的
  textLayer 文本片上溢出/错位，官方 viewer 因此默认 `enableSelectionRendering`——textLayer 挂
  `selectionRendering` 类（pdf_viewer.css 把原生高亮透明化），`pdfjs.DrawLayer`（`pageIndex` + textLayer 元素，
  `setParent(页宿主)`，cleanup 必须 `destroy()`）按 selectionchange 把选区画成整页 div + SVG clip-path 贴字形；
  该 div 的样式在 pdf_viewer.css 里 scoped 于 `.pdfViewer .canvasWrapper`，我们 DOM 没有这两个类，App.css
  照抄一份 `[data-page-num] > .selection`。**WebKit 还有个坑（同日实测修复）**：`range.getClientRects()` 对同一行
  会返回 span 边框盒（高 = line-height）与字形 A+D 内容盒两个错位矩形，DrawLayer 取并集 → 高亮比字形胖一截
  压住邻行（Chrome 只返回一个，官方 viewer 无感）；App.css 给 `.textLayer span` 设 `line-height: normal`
  （边框盒 = 字体自身 A+D，与内容盒重合，并集收敛成单盒，WKWebView 探针实测验证）——span 均绝对定位且
  文字透明，此改动只影响选区几何。另对齐 viewer 两件套：textLayer 渲染完追加 `endOfContent` 页尾捕手
  + mousedown 挂 `selecting` 类（拖过末行仍能扩到页尾；DrawLayer 的 MutationObserver 也靠它感知重渲染重算选区）；
  `--total-scale-factor` 取 `viewport.scale × viewport.userUnit`（官方 = scale-factor × user-unit，userUnit≠1
  的 PDF 才不等价于名义倍率）。**缩放/圈选控件是 PDF 栏顶部常驻细工具条**（Zotero 式：图标钮 28px 热区 +
  页码居中 grid 三列 + ▦ 圈选右置）——不再是滚动层内 sticky 浮块（实测挡正文与圈选画面）；
  **三栏顶条统一 h-8 + 底部 hairline**（FilePreviewEditor 工具条同步改成这个规格，栏间才严丝合缝）；
  圈选 Esc/手势语义不变。

## 其余终端工作台条目

- **产物核验清单（v3.42；v3.45 起从胶囊移到任务行；v3.61 起第二入口为步骤 ⋯ 菜单）**：共享组件 `src/components/ArtifactChecklist.tsx`（步骤按 workspaceName 反查
  project.toml，定位根由调用方给：已合并读项目根/main，其余读工作树）；任务行「产物」按钮（hover 才现，与 ⌨ 终端同档）在行下方
  就地手风琴展开，展开态按工作区 id 记忆在 WorkspacesPage、切项目清空；步进器圆后小方块在 strip 下方就地展开，展开态记步骤 index（单开）；面板 = 已产出 ✓/未产出 — + mtime 相对时间
  + 手动 ⟳ 刷新（打开时拉取一次，不进轮询；v3.60 起无「刚更新」标记——文件新旧不是待办）；选段反馈浮动条带「↵ 直接发送」（pty_write 一次拼接 \r，同帧到达防半截输入）。
- **沉淀为技能（v3.42）**：md/PDF 选段浮动条「✦ 沉淀为技能」→ `ai_distill_skill`（脱敏 + 8KB 截断 + JSON 容错解析）→
  `skillDraftReq` 一次性请求 → 技能页新建弹窗预填，保存走既有 create_skill（重名拒绝）。
- **模型 combo-box（v3.42）**：启动栏模型 = 可输可选（profile 预设 + `ccode.modelHistory.<agent>` 历史去重，上限 10 条），
  启动成功即记历史；「新增模型」不再是配置概念。
- **评审一键开下一步（v3.42；v3.97 改向）**：评审覆盖层合并成功且保留工作区时，成功横幅
  给出「→ 去下一步：步骤名」——下一步 = 同名步骤之后第一个无同名工作区（含已归档）的步骤；无下一步/未注册/无流水线
  只显示合并成功横幅；「合并并归档」成功即关覆盖层，不出此入口。**v3.97 起不再直接开步跳终端**
  （用户拍板：直接开步会把不熟流程的用户扔进黑窗）——改为 `selectProjectReq` + 跳项目页，
  聚焦逻辑自动落在刚解锁的下一步（第一个未完成步骤），流程线/TASK.md/人工事项先看再自己点「开始」。
