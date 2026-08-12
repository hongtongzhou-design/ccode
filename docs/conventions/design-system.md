# 约定：主题与设计系统

> 适用范围：一切 UI 改动——主题令牌、字体、线条、控件密度、页面框架、布局结构、预览组件、步进器。从 AGENTS.md「主题与设计系统」节迁入（原文照录，未做语义改动）。

## 主题令牌

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
- **字体渲染按平台分口径（v3.60 后 Windows 糊字修复）**：入口（main.tsx）在 `<html>` 上落 `data-platform`
  （mac/windows/linux，判定在 hotkeys.ts `IS_MAC`/`IS_WINDOWS`）。Windows Chromium 下 `text-rendering:
  optimizeLegibility` 会走 DirectWrite natural 模式丢 hinting，小字号发糊——`[data-platform="windows"]` 覆写回 `auto`，
  macOS 保持 optimizeLegibility 不动。CJK 回退链必须显式带雅黑：body 栈含 `"Microsoft YaHei UI", "Microsoft YaHei"`
  （否则中文穿过未安装的 Noto Sans SC 落通用 sans-serif 发虚）；等宽单一出处是 `@theme` 的 `--font-mono`
  （打包的 JetBrains Mono 在前，Windows 回退 Cascadia Mono/Consolas，CJK 兜底雅黑）；xterm 的 fontFamily 回退链同口径
  （TerminalPage 两处，勿落通用 monospace——Windows 会解析成位图字体）。新增等宽/正文场景一律用这两条链，别自造栈。
- **线条语言（去格子化，v3.35/v3.37 定稿）**：内联内容容器一律**不加 1px 描边**，靠底色差 + 圆角 + hairline 分层；边框只给
  浮层与控件。strip/inset/raised 三级梯度七套主题必须可分辨；hairline/field 与底色对比度七主题同档。**区间分隔优先留白**
  （折叠区标题、rail 底部、PageHeader 均不画横线）。搜索框无描边（inset 底 + 聚焦加深），输入框保留 field 边。**全站线宽
  0.5px**（App.css 覆写 border/divide；focus outline 不动）。**侧栏只保留全高竖分界 + 底部管理区一根横线**。**共享控件集中
  `PageFrame.tsx`**（primary/secondary/rowAction/ghostAction/field/searchField/hoverReveal + SegTabs），禁各页复制本地类，
  一律用通用语义令牌。编辑器面走 `--color-editor-bg/fg/line`，Monaco 经 MutationObserver 随主题换肤。
- **符号语言统一**：导航与图标用单色几何符号（⚙⛁⌨◔✦◫⛭⇄），◈=AI 功能、⚑=pin/保留；**禁用彩色 emoji**。
- 用户明确否决过的设计：多栏嵌套的对话页、浅色 + 蓝紫渐变侧边栏、按钮排排坐的 profile 行、暖棕色系整体主题、
  emoji 图标。不要改回去。（浅色模式曾是否决项，v3.44 用户主动要求并已落地七套浅色，该否决作废。）

## 页面与控件规范

- 配置页结构（用户详版规格）：可折叠 agent 分组 + 五列网格行 + 顶部筛选与搜索 + 无大面积虚线空状态；图标按钮点击区 ≥28px；
  **WKWebView 不支持 window.prompt/confirm/alert 等原生 JS 对话框**（macOS wry 未实现对话框委托，confirm 恒返回 false、prompt/alert 静默无效）——
  一切输入用内联输入框，确认走 `src/components/ConfirmDialog.tsx` 的 `confirmDialog`、提示走 `alertDialog`（promise 版，宿主已挂 App 根部），禁再引入原生 JS 对话框。
- 常规管理页统一共享页面框架/标题层级/主操作样式/主题化开关复选框/加载骨架；页面最大宽度必须显式选择，禁叠加冲突的
  `max-w-*`。**控件尺寸固定两级**：标题栏主/次操作与终端启动栏 32px；任务行、步进器圆/小方块热区、对话列表/回放头部及图标按钮 28px
  （可点击就不得小于 28px；层级靠填充色/边框/文字色区分，不靠按钮忽大忽小）。**留白节拍固定**：统一标题呼吸区/工具栏
  间距/主体内边距；空状态与低对象数量时允许保留连续画布，不为填满窗口堆料；工作区流水线与任务行可增加垂直间距，但不
  改变步骤顺序和操作语义。
- **全站导航按工作流分层**：侧栏顺序固定为工作（工作区/终端/对话）→ 能力（配置/技能/MCP/统计）→ 底部只留设置，首启默认进
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
  所有终端标签保持挂载的语义不得因布局优化改变。**技能/MCP pill 在收缩态同样保留**（展开栏与收缩状态行共用
  renderSkillMenu/renderMcpMenu，收缩栏在页面顶部菜单向下弹出）；技能=一键使用注入输入框，MCP=一键提及 +
  「管理分发→」跳 MCP 页。**专注双模式（v3.43）**：中带「⤢ 专注终端」（藏左右栏，标签条
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

## 预览组件与步进器

- **md 阅读模式（RX2a）**：md 文件预览默认「阅读版式」（marked 渲染，pin 版本、随 FilePreviewEditor 懒加载 chunk，禁进主包；
  本地可信内容不引 sanitize 重库），排版样式集中在 App.css `.md-body`（全主题令牌）；「阅读/编辑」切换时 Monaco 保持挂载仅
  隐藏（未保存改动/undo 不丢）；「⛶ 沉浸阅读」为 `fixed inset-0 z-30` 全宽覆盖层（Esc 退出，终端/PTY 保持挂载）；外部写盘
  自动刷新沿用现有 watcher 链路，编辑中（dirty）不覆盖。
- **步骤对照（RX2b）**：跨页「文件树切根」走 store 一次性 `enterCwdReq`（终端页消费后复用 enterCwd/externalCwd「真进入」
  机制，文件树根随活动标签 cwd）；`previewReq` 可带可选 `root`（文本预览的后端根约束，缺省回落活动标签 cwd）。产物核验已移到
  任务行手风琴与步进器圆后小方块（见「产物核验清单」条）；大圆悬浮信息（目录/agent/profile）读终端页同一键 `ccode.wsLast.<worktreePath>`。
- **流水线大圆步进器（v3.46，取代 v3.45 胶囊分层与进度段；v3.61 虚线链改为带级一次铺满）**：名称带与步进器带两个同列网格；
  虚线为**带级真实块链**（`StepperChain`：6px 块 + 6px 间隙全是真实元素，块位以圆心为锚按列几何分段现算——
  跨列无边界、每段块数与间隙严格一致、各圆两侧断口等大且间隙 = 块间 6px（`NODE_HALF` = 22px 视觉圆半径 11 + 6；
  按列各自现算会在列缝出大间隙，按全局相位铺排会被圆随机截断，两种都已被用户否决），完成列区间内的块亮灰白（l2）、其余暗（hairline）。
  **大圆 = 纯色实心圆（内部无字符）+ 唯一主推进点击**：done=bg-ok-text；进行中/checking=bg-cta（脉冲用有界
  `animate-pulse-brief`：App.css 自定义 3 周期≈6s 后静止，状态复归重播；无限 animate-pulse 是注意力消耗，项目区工作区状态点同口径）；
  待评审=bg-cta-pill；阻塞=bg-warn；pending=bg-l4 实心灰。点击语义按状态：
  pending 无工作区=startStep、已归档=restoreWs、进行中/待评审/阻塞=onOpenTerminal(ws)、done=setPendingTerminal 开主仓 shell 终端。
  状态/目录/agent/profile + 点击动作提示收进**应用内 tooltip**（`useHoverTip`/`HoverTip`，fixed 定位、横向钳制、滚动/缩放/点击即关）：
  原生 title 在 WKWebView 上行为不稳定（不渲染或残留数秒串到相邻控件），圆的悬浮提示**一律走应用内 tooltip，禁再回退原生 title**；
  事件挂包裹 span，禁用态也可悬浮。**大圆右上角注意力角标**（size-2 圆点）：cwd 落在工作区内的终端标签有待确认=bg-warn；
  v3.59 起「已回复」绿点移除（每回合结束都会亮，噪音大于信号，用户否决），只留待确认；数据只读消费 `terminalRunInputs` 镜像，不新增轮询。
  **v3.61 步进器精简（用户拍板）**：**圆视觉 22px（按钮保持 28px 热区）**；**圆前/圆后小方块的按钮职责删除**
  （伪装成虚线块可发现性为零、与步骤 ⋯ 重复、误触打开全宽覆盖层代价高），小方块视觉保留为普通虚线块（DashBlock），
  SquareButton 组件移除；「编辑步骤」（openEditor(i) 定位卡片，PipelineEditor `focusStep` prop 滚动 + 聚焦简报框）与
  「产物核验」（strip 下方就地展开 ArtifactChecklist，单开手风琴记步骤 index；root 口径同任务行：done 读项目根、其余读工作树、
  无工作区禁用）**全部收进步骤名称行右侧 hover 才现的 ⋯ 菜单**（hoverRevealClass）。
  **末端菱形终点**：步进器带末尾 9px 旋转 45° **实心**菱形（装饰无点击，与链条同轴、经 6px 间隙接在末块之后——为保证该间隙恒定，
  尾段方块必须贴菱形端排、段内余数沉到末圆旁，余数若沉菱形前间隙最大 17px，已被用户否决；
  名称带末尾有同宽占位保列对齐），全部步骤 done 时点亮相同 done 绿（bg-done，平时 bg-hairline 与未完成链条同暗）。解决冲突/评审/合并统一在下方任务行，步进器不再放第二行动作。
- **WebGL 探针的「renderer 不明」保守回退仅限 Windows**：`diagnostics.ts webglUsable`——WKWebView 等平台可能屏蔽
  debug renderer 信息但 GPU 正常，不得全局按软件渲染处理。
