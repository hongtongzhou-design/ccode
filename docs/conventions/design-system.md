# 约定：主题与设计系统

> 适用范围：一切 UI 改动——主题令牌、字体、线条、控件密度、页面框架、布局结构、预览组件、步进器。从 AGENTS.md「主题与设计系统」节迁入（原文照录，未做语义改动）。

## 主题令牌

- 全站主题令牌集中在 `src/App.css` 的 `@theme` + `[data-theme]` 变体（**七套深色 + 七套对应浅色**，v3.44 起：
  沉浸黑(默认)/陶土/Ayu琥珀/Catppuccin/极简灰蓝/Dracula/灰蓝正红，各配一套同性格浅色；浅色方向翻转——rail 比 canvas
  略暗、面板向白浮起、hairline/field 为深灰线、cta 加深保白底对比，状态语义色共享深色值；行 hover 统一走
  `--color-hover` 令牌（深色 5% 白 / 浅色 5% 黑，`hover:bg-hover`，禁再写死 `hover:bg-white/*`），选中行 bg-white/10
  与缩进线 border-white/5 仍在浅色下由 App.css 按类名翻转），运行时切 `document.documentElement.dataset.theme`，
  **改主题只动这一个文件**，组件里禁散落 hex。主题清单单一出处 `src/themes.ts`（settings.rs KNOWN_THEMES 与
  TerminalPage XTERM_BG_FG 需同步）。**切主题同时同步原生窗口外观**（`applyTheme` 调 `setTheme(light/dark)`，
  浅色判定走 themes.ts 的 `light` 标记）——原生 `<select>` 下拉、滚动条等按 NSWindow appearance 渲染，
  只改 CSS 变量时深色主题下弹出系统浅色列表；capabilities 需保留 `core:window:allow-set-theme`。
  默认主题 CTA 粉 `#faa8d4`（cta-text 近黑）；`--color-raised`（浮起面板/pill 底）、
  `--color-bubble`（用户消息气泡）、`--color-nav-accent`（侧栏选中左条+选中图标，默认靛蓝、其余取各自 CTA 色）。
- 四层「浮起」结构（rail/rail2/canvas/inset 逐级变亮）；文字冷白→灰四档；每主题独立 CTA 强调色（按钮/选中用 `cta`；可操作
  状态如「可合并」用**按钮本身的 cta 高亮**，不另挂 pill；纯状态 pill 用 inset 灰底 + 语义色小圆点）；
  **浅色浮起阶梯必须真的拉得开（v3.85）**：`canvas→strip→inset→raised` 每档亮度差 ≥4，且
  `rail < canvas < rail2 < strip < inset < raised` 次序不得破坏，`rail-sel/seg-sel/hairline/field/bubble`
  必须比各自所在底色深。浅色的「浮起 = 更亮」在 raised = 白处到顶，阶梯只能靠**把 canvas 压深**换空间——
  七套浅色原先挤在 1–4 的差里（整页发平、卡片与页面底糊在一起，用户截图即此症），v3.85 统一按
  「从白往下每档降约 4.5 亮度」重排（保各主题色相；midnight 家族随 v3.48 去蓝一并转暖；
  mocha-light 不再直接照搬 Latte 官方 base/mantle/crust——那套是「越深越低」，与本应用方向相反）。
  **开关（Toggle）走专用令牌 `--color-switch-off`（轨道）/`--color-switch-knob`（滑块）**：
  滑块恒为浅色、状态由轨道表达；禁用 `bg-l1` 当滑块（l1 是文字最亮档，浅色主题是近黑，会渲染成白底黑疙瘩）。
  **以上几条已写成可执行断言 `tests/theme-contrast.test.ts`（直接解析 App.css），改主题令牌必须跑它**；
  对比度断言要用 WCAG 相对亮度（先线性化 sRGB），直接拿 0–255 加权会高估暗色、把合格色误判成不合格。
  **状态语义色分深浅两套**（v3.85 修正原「ok/err/warn 不随主题变」口径）——深色沿用深底浅字，
  浅色主题在 `[data-theme$="-light"]` 覆写为浅底深字（与 diff 行同手法，实测五对均 ≈5:1 过 AA）：不覆写会让全站 69 处
  `bg-ok/bg-err/bg-warn` 变成白页上的深色块。**`--color-*` 与 `--color-*-text` 分工是硬规则**：
  `--color-ok/err/warn` 只作 **pill 底色**（必须配 `text-*-text`），`--color-*-text` 同时供 pill 文字与
  **一切实心状态圆点/圆形**使用。**禁止用底色档铺实心形状**——浅色下 `--color-warn` 是浅黄 `#fdf1cd`，
  铺成圆点/22px 步进器大圆会在近白 canvas 上消失（v3.85 已修 `stepCircleClass` 的 blocked、
  步进器注意力角标、任务卡主仓改动点三处；同为实心圆的 done 本就用 `-text` 档，原先是自相矛盾）；
  **结果横幅一律 bg-strip/inset 底 + ✓/✗ 语义色文字**，不用整块 bg-ok/bg-err（bg-err
  仅留给需警惕的小 pill）；**diff 增删行铺底走专用令牌 `--color-diff-add-bg/fg`、`--color-diff-del-bg/fg`**（v3.81：
  深色主题沿用深底浅字，浅色主题在 `[data-theme$="-light"]` 统一覆写为 GitHub 式浅底深字——ok/err 深底整行铺在浅底上
  会显黑，故不再直接复用 bg-ok/bg-err 铺整行）；**diff 行数文字 `--color-add/--color-del` 同样分深浅两套**
  （画在 canvas 上不是画在 pill 上，深色值在浅底约 1.8:1）；零阴影、隐式 hairline。**浮层统一口径**：弹窗/下拉/右键菜单/命令面板表面一律
  `.ccode-float-surface`（= raised 底 + 顶部 1px 内高光，Linear edge highlight 手法——零阴影原则不变，浮起感靠
  边缘高光而非投影），禁再随手用 bg-strip/bg-raised 做弹层；**浅色下白色内高光在白底上不可见**，
  `[data-theme$="-light"] .ccode-float-surface` 改为极淡内暗边 + 一圈 `0 0 0 0.5px` 外描线
  （零偏移零模糊，仍不违反零阴影）；全屏遮罩统一 `bg-black/40`（25/50/60 三档已并一）。
- **终端 ANSI 调色板深浅成对（v3.85）**：`src/terminal-palettes.ts` 的 `PALETTE_LIST` 是 id/名称/亮暗的单一出处，
  四套深色（dark-plus / solarized / one-dark / catppuccin）各配一套 twin 浅色（light-plus / solarized-light /
  one-light / latte），`PALETTE_TWIN` 双向映射。**ANSI 16 色 + `cursor` + `selectionBackground` 全部进调色板表**，
  禁再在 `buildXtermTheme` 里写死——原先写死的 `cursor #aeafad` / `selectionBackground #264f78` 在浅色底上
  分别是「几乎看不见」和「深底压深字、选中即不可读」。`buildXtermTheme` 必须经 `resolvePaletteId(paletteId, isLightTheme(themeId))`
  按主题亮暗解析，亮暗不符自动换 twin；设置页只列出与当前主题亮暗匹配的四套。
  **三处同步点**：`terminal-palettes.ts PALETTE_LIST` ↔ `settings.rs KNOWN_PALETTES`（持久化白名单，
  漏加会让新调色板被静默丢弃、表现为「选了没生效」）↔ `TerminalPage XTERM_BG_FG`（每主题底/字色）。
  **主题亮暗判定单一出处是 `themes.ts` 的 `isLightTheme()`**，禁另造判定。
- **字体渲染按平台分口径（v3.60 后 Windows 糊字修复）**：入口（main.tsx）在 `<html>` 上落 `data-platform`
  （mac/windows/linux，判定在 hotkeys.ts `IS_MAC`/`IS_WINDOWS`）。Windows Chromium 下 `text-rendering:
  optimizeLegibility` 会走 DirectWrite natural 模式丢 hinting，小字号发糊——`[data-platform="windows"]` 覆写回 `auto`，
  macOS 保持 optimizeLegibility 不动。CJK 回退链必须显式带雅黑：body 栈含 `"Microsoft YaHei UI", "Microsoft YaHei"`
  （否则中文穿过未安装的 Noto Sans SC 落通用 sans-serif 发虚）；等宽单一出处是 `@theme` 的 `--font-mono`
  （打包的 JetBrains Mono 在前，Windows 回退 Cascadia Mono/Consolas，CJK 兜底雅黑）；xterm 的 fontFamily 回退链同口径
  （TerminalPage 两处，勿落通用 monospace——Windows 会解析成位图字体）。新增等宽/正文场景一律用这两条链，别自造栈。
- **线条语言（去格子化，v3.35/v3.37 定稿；v3.85 补「去线条化」）**：内联内容容器一律**不加 1px 描边**，靠底色差 + 圆角 + hairline 分层；边框只给
  浮层与控件。strip/inset/raised 三级梯度七套主题必须可分辨；hairline/field 与底色对比度七主题同档。**区间分隔优先留白**
  （折叠区标题、rail 底部、PageHeader 均不画横线）。搜索框无描边（inset 底 + 聚焦加深），输入框保留 field 边。**全站线宽
  0.5px**（App.css 覆写 border/divide；focus outline 不动）。**侧栏只保留全高竖分界 + 底部管理区一根横线**。**共享控件集中
  `PageFrame.tsx`**（primary/secondary/rowAction/ghostAction/field/searchField/hoverReveal + SegTabs），禁各页复制本地类，
  一律用通用语义令牌。编辑器面走 `--color-editor-bg/fg/line`，Monaco 经 MutationObserver 随主题换肤。
- **去线条化（v3.85，用户反馈「工作区界面有点线条化」）**：v3.35/v3.37 拆掉了描边与横线，但没解决**「带太多」这个结构问题**——
  拆完变成一堆等高细条，反而更像线。补三条硬规则：
  - **同屏最多 2 条横向「带」**。工作区页只有大圆步进器带保留（它是流程骨架，规格另有硬约束）；其余一律改**块区**——
    有内边距、靠 `bg-strip`/`bg-inset` 底色成块，不靠横线切分。
  - **列表分两类**：页面级对象列表（工作区、项目）用**卡片 + 卡间留白**（`flex flex-col gap-2` + `rounded-lg bg-strip p-3`），
    禁 `divide-y`；块内的密集行列表（任务卡、定时任务）用 `space-y-0.5` + 行 hover 高亮做分隔感，同样不画分隔线。
    仅浮层内部（popover/下拉）与带左缩进线的层级子列表保留 `divide-y`。
  - **块与块之间用留白（≥16px / `mb-4`）分隔，禁画分隔横线**。
  卡片底色选 `bg-strip` 而非 `bg-inset`：卡内还有状态 pill 要再浮一层（pill 走 `bg-raised`），
  用 inset 做卡会让 pill 无处可去（浅色主题 inset/raised 已接近纯白，梯度顶端压缩）。
- **界面文案克制（v3.88，用户拍板「界面处越简单越好」）**：
  - **一个操作最多配一句话**，一句话 ≤ 20 字左右；说不完的**进 `title=` 悬浮提示**，不占版面。
  - **禁止在界面上写「为什么这么设计」**——那属于代码注释与决策记录（architecture.md §10 / 本文件），
    不是给用户看的。界面只回答「这是什么、我该怎么做、出了什么问题」。
  - 弹层/分区的开场白最多一行；**能靠控件自明的就不写说明**（「打开」按钮不必解释它会打开文件管理器）。
  - 警示类文案（会丢数据、会被覆盖、不会生效）优先保留，但同样压到一句；纯功能介绍一律砍到一句或删。
  - 反例（v3.88 自查砍掉的）：折叠区整段「这三项会出现在流程线上：人工事项按…、决策项…、种子…」
    压成「这三项都会显示在流程线上。」；选项 hint 里写完整机制，压成一句、细节进 `title`。
- **界面术语用白话，内部术语不外露（v3.88）**：`register_project` 的用户面表述是**添加 ↔ 移除**，
  不是「注册 / 移除注册」——弹层叫「添加项目」，按钮就得叫「添加」，状态叫「未添加」，
  移除项叫「从 Ccode 移除」（天然与「删除项目目录」区分）。代码标识符与开发文档继续用 register/注册，
  两者同一物（同 pipeline/研究流程 的映射口径）。
- **跨页视觉三原则（v3.85，每批 UI 改动自查）**：
  1. **美观 = 减少同权重元素**——同一视觉层里超过 5 个等权重控件必须分级（主 / 次 / hover 才现）。
  2. **沉浸 = 减少边界**——一屏内的容器边界（描边 + 横线 + 底色跳变）总数 ≤ 4。
  3. **简洁 = 每个视图一个答案**——每屏必须能一句话说出「现在该干嘛」，且该答案只出现在一处。
- **项目详情页固定三段（v3.85）**：①**身份段**（项目名 16px semibold + 课题主题；主题为空时给可点的
  「＋ 写一句课题主题」占位，不让它只活在菜单深处）→ ②**流程段**（大圆步进器带**规格不动** +
  其下一张「当前步骤卡」）→ ③**工作段**（任务卡 + 工作区卡）。段间只用留白。
  **「当前步骤卡」是「现在该干嘛」的唯一答案**：卡头 = 步骤名 + 白话状态（`describeStep` 口径），
  卡身 = `StepFlow` 流程线（含唯一主动作）。v3.73 把这个答案拆到聚焦头/步进器/流程线三条独立细带上，
  正是「详情页不够清楚」的来源；现在聚焦头与流程线并进同一张 `bg-inset` 卡，`StepFlow` 传 `bare`
  去掉自带底色由外层卡承载。**卡内再浮一层用 `bg-raised`**（如「可选」徽标——原用 bg-inset，
  并进卡后与卡同色即消失）。
- **项目级低频配置收进「项目设置」抽屉（v3.85）**：右侧滑出，**不是页面、不进侧栏、不占路由**。
  分组 = 基本（项目名 / 课题主题 / 项目路径）· 研究流程（更换模板 / 另存为模板 + TemplatePicker 实例）·
  文献与数据（litSource + 资源清单 + 发现资源）· 定时巡检（ScheduleSection）。
  项目 `⋯` 随之收敛为四项：编辑研究流程 · 项目设置… · 历史 · 移除项目注册
  （清除痕迹与删除目录仍只在左侧项目栏右键菜单，不在两处各留一套删除入口）。
  **模板库实例住在抽屉里**——任何打开模板库的入口（空流程引导横幅、设置里的按钮）都必须
  同时开抽屉，只翻 `pickerOpen` 界面上不会有任何反应；模板应用成功后连抽屉一起关（要让用户看到步进器）。
- **「快速开聊」是动作不是页面（v3.85）**：侧栏「工作」组首位 + ⌘K 命令，弹层只问 agent / 配置 / 目录，
  确认即开标签并自动启动（`PendingTerminal.autoStart`；无可用配置时降级为只预填）。
  **明确不做**：不建项目、不建工作区、不写 `.ccode`、不注册、不选模板、不落 TASK.md；
  默认落脚 `~/ccode/scratch`（后端 `ensure_scratch_dir` 只 create_dir_all，**不 git init**——
  改动面板显示「不是 git 仓库」是预期）。转正走终端标签 ⋯「转为项目…」= 仅 `register_project`，
  会话历史跟 cwd 走、自动归到新项目下，不需要迁移。
- **符号语言统一**：导航与图标用单色几何符号（⚙⛁⌨◔✦◫⛭⇄），◈=AI 功能、⚑=pin/保留；**禁用彩色 emoji**。
- **字号阶梯令牌化**：正文阶梯 `text-micro`(11/15) → `text-xs`(12) → `text-sm`(14) → `text-base`(16)，**禁 `text-[Npx]` 任意值**；
  语义分工：micro = badge/时间戳/副注释（11px 是可读下限，不再用 10px），xs = 次级说明，sm = 正文/列表行，base = 页面标题。
  终端工作台整体提高一档（`.terminal-workbench` 覆写 micro→12、xs→13）。同类信息必须用同一档，禁止同页相邻出现两档灰字。
  **已定现状，勿动（v3.90 否决）**：`App.css` 的全局 `button/input { font: inherit }` 未包 cascade layer，
  优先级高于 Tailwind v4 工具类——按钮上的 `text-*` 类实际不生效，**全站按钮按继承字号渲染**。
  曾尝试包进 `@layer base` 修复，全站按钮整体变小一档，用户实测「还不如之前」否决，已回退。
  局部块要统一字号的做法：给容器定字号、让按钮继承（不要再给按钮单独标 `text-*`）。
- **动效口径**：弹层入场 `ccode-pop`（150ms opacity+scale .98→1，已绑在 `.ccode-float-surface` 上，弹层零额外接入）；
  遮罩入场 `ccode-fade`（120ms 透明度）；统一 `--ccode-motion-ease`，UI 反馈都在 200ms 内；`prefers-reduced-motion` 全局关闭。
  focus 环 `outline: 1px solid var(--color-l3)`（field 色太弱，l3 提亮不换色相）。
- **弹层规格台账**：宽度两档——简单对话/短表单 `w-[26rem]`、富表单 `w-[36rem]`（命令面板 `w-[30rem]` 为独立规格）；
  遮罩统一 `bg-black/40` + `ccode-fade`；z 轴台账：sticky 页头 z-20（基准）/ 页面模态 z-40（必须压过页头，用 z-10 会被
  页头白底戳穿遮罩）/ 右键菜单·命令面板·下拉 z-50 / 评审内弹层 z-60 / 确认框 z-[70]（ConfirmDialog 压一切）。新弹层按档入座，禁造新档。
- **按钮分工**：页头/工具栏次按钮 = `secondaryActionClass`（描边 bg-strip）；表单内实心确认 = `bg-btn` + `hover:brightness-125`
  （实心按钮 hover 用提亮，禁 `hover:bg-white/10`——浅色下不可见）；分段控件选中态 = `bg-seg-sel`（SegTabs 口径），
  不用 CTA 填充（每视图只允许一个主 CTA）。
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
- 终端展开态主流程固定为 Agent → profile → 模型 → 启动（v3.91 起目录输入框移出启动栏，改由底部状态栏
  📂 胶囊浮层编辑、仅未启动可改；技能/MCP pill 右对齐收进启动行末端），辅助动作视觉分组；启动后自动收缩、
  PTY shell 回落、所有终端标签保持挂载的语义不得因布局优化改变。**技能/MCP pill 在收缩态同样保留**（展开栏与收缩状态行共用
  renderSkillMenu/renderMcpMenu，收缩栏在页面顶部菜单向下弹出）；技能=一键使用注入输入框，MCP=一键提及 +
  「管理分发→」跳 MCP 页。**专注双模式（v3.43）**：中带「⤢ 专注终端」（藏左右栏，标签条
  留在中带顶部，portal 机制已删）与右栏「⇱ 专注内容」（右栏铺满、中带不加遮罩），Esc 退出；左栏不再有 « 收起态。
  状态点全局统一 `size-2 rounded-full`；端口区分「本应用/系统其他」两段，终止外部进程必须二次确认。
  **终端未启动空态（v3.91）**：画布中央一张静态引导卡（当前配置 + 启动/恢复 + 「打开普通 Shell 终端」），
  xterm 保持挂载在底层，浮层壳 pointer-events-none；运行/shell/脚本标签不显示。
  **磨砂口径（v3.92）**：卡片可见时启动栏「启动」降级为线框（同一视野不留双主按钮）；卡片主按钮
  `h-9 w-2/3` 内置 `⌘↵` kbd（真实快捷键：⌘/Ctrl+Enter 启动，打字中不抢；**终端聚焦时按键被 xterm
  吞掉、到不了 window 监听，必须在 attachCustomKeyEventHandler 里加同款分支**，与 ⌘F 同一处理模式；
  window 监听须门控 `visible && primaryFocus`，否则多标签的保持挂载实例会重复触发）；
  Shell 次入口 = `>_` 前缀 + bg-inset 胶囊 + hover 背景块；图标盒用 `bg-cta-pill text-cta-pill-text`
  与主按钮同色系呼应；卡片边线用 `border-field`（hairline 太浅，画布有输出时轮廓会糊）。
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
  待评审=bg-cta-pill；阻塞=bg-warn-text（v3.85 由 bg-warn 改：底色档在浅色主题是浅黄，铺 22px 实心圆会消失；
  且同为实心圆的 done 本就用 `-text` 档）；pending=bg-l4 实心灰。点击语义按状态：
  pending 无工作区=startStep、已归档=restoreWs、进行中/待评审/阻塞=onOpenTerminal(ws)、done=setPendingTerminal 开主仓 shell 终端。
  状态/目录/agent/profile + 点击动作提示收进**应用内 tooltip**（`useHoverTip`/`HoverTip`，fixed 定位、横向钳制、滚动/缩放/点击即关）：
  原生 title 在 WKWebView 上行为不稳定（不渲染或残留数秒串到相邻控件），圆的悬浮提示**一律走应用内 tooltip，禁再回退原生 title**；
  事件挂包裹 span，禁用态也可悬浮。**大圆右上角注意力角标**（size-2 圆点）：cwd 落在工作区内的终端标签有待确认=bg-warn-text（同上，v3.85 由 bg-warn 改）；
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
