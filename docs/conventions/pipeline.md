# 约定：流水线与项目域

> 术语映射（v3.69 起）：**界面与用户手册一律叫「研究流程」**（科研人员视角，「流水线」工程味太重被否）；
> 代码标识符（pipeline-start.ts、PipelineEditor、PIPELINE_TEMPLATES）与本开发文档沿用 pipeline/流水线，两者同一物。

> 适用范围：工作区（worktree）生命周期、流水线开步/模板/编辑器、任务卡、接力/提炼接力、示例课题。从 AGENTS.md 迁入（原文照录，未做语义改动）。

## 工作区生命周期（无损口径）

- **工作区创建是补偿事务**：先以 SQLite `BEGIN IMMEDIATE` 原子预留端口并写 `creating`，再创建 worktree/复制文件/激活；
  任一步失败必须移除 worktree、prune、删分支、删 creating 行并释放端口。复制错误不得忽略；setup 失败维持非阻断。
  `ready_to_merge` 必须要求 `ahead > 0`，空工作区禁止合并。
- **工作区漂移修复必须显式且非破坏**：仓库/分支/worktree 缺失、注册不一致、归档记录与磁盘冲突、merge 进行中都由
  `workspace_drift` 先诊断并暂停普通危险动作；重新挂载/重新定位可修复实体，标记归档/清理记录只改元数据，不得删目录或分支。
- **工作区归档是无损操作，删除才允许强制**：归档前必须重新检查 merge 状态、未提交改动和该工作区内仍运行的 agent/run
  脚本；任一存在即拒绝。脏工作区只允许走「提交并归档」，提交成功而归档失败后只能重试归档，禁止重复提交。归档移除
  worktree 禁用 `--force`；`git worktree remove --force` 只允许用于用户明确确认的「删除工作区」。最终合并失败必须自动
  `git merge --abort`，不得把主仓库留在冲突状态。
- **项目目录彻底删除（delete_project_dir）防护口径**：必须是 Ccode 项目（`.ccode/project.toml`、注册记录、工作区记录
  三者有其一）才允许删；拒绝 home/document_dir 本身、少于两级的浅层路径与 fs_tree 重要路径黑名单；该 repo 全部工作区
  逐个走删除实现（允许 force 移除 worktree），任一失败即中止且已删不回滚（错误说明已删哪些），再删目录与注册记录。
- **清除 Ccode 痕迹（purge_project_traces，v3.65 中间档）**：保留项目文件夹与用户全部文件——全部工作区
  （worktree + 分支 + 记录，彻底删，同删除项目目录口径）→ `.ccode/` 走系统回收站（可反悔）→ 摘注册记录（未注册容忍）；
  防护复用 `guard_project_dir`；三者皆无时报「没有 Ccode 痕迹」。**不自动 git rm/提交**：.ccode 若被跟踪过，删除显在
  改动面板由用户自行提交（摘要与前端确认框均提示）。

## 流水线开步与模板

- **流水线开步是预设参数的组合调用**（架构 §11）：点「开始」= 建工作区 + 启 Agent + 注入简报 + 落 TASK.md，复用既有
  工作区创建与终端启动；不破坏手动启动栏「Agent → profile → 模型 → 目录 → 启动」主流程。**invoke 链路单一出处
  `src/pipeline-start.ts` 的 `startPipelineStep`**（ensure git → bootstrap 提交 → 建工作区 → 提货单/技能元数据 → TASK.md →
  run 脚本 → 终端交接），工作区页步进器大圆与评审「开始下一步」共用，组件态由调用方回调注入。**v3.64 起「开工」为两步**：
  步进器大圆与卡片「开工」先开 `KickoffConfirmDialog`（TASK.md 预览/编辑（草稿优先）+ 推荐技能区 + 人工事项区 +
  主仓提醒），确认才走 startPipelineStep；评审「开始下一步」保留直开（连续流，结论已沉淀到下一步草稿），「继续」
  不经弹层。**TASK.md 拼装单一出处 `renderTaskMd`**：弹层预览与实际落盘共用 `gatherTaskMdExtras`（提货单/技能元数据）
  + `renderTaskMd`（模板简报拼装；草稿非空时编辑区直接取草稿全文，见「任务书草稿」节），禁复制第二份拼装逻辑。
  **v3.66 起弹层预览区升级为可编辑 TASK.md 编辑区**：默认拼装结果进编辑区（状态机 `taskMdEditorReduce`——dirty 后
  重拼不覆盖人编辑稿），「确认开工」落盘 = 编辑区最终内容（`startPipelineStep` 的 `taskMdOverride`，写盘仍走
  write_workspace_task_md 单一路径）。**v3.77 起砍掉「定稿简报」中间层**：弹层删除简报勾选区与「◈ 融合所选简报」
  「◈ 融合为连贯 TASK.md」两按钮（`save_task_brief`/`ai_fuse_briefs`/`ai_fuse_task_md` 随中间层一并删除）；无草稿且
  存在旧简报（`.ccode/brief-*.md`）时显示一行提示 +「并入草稿」（`list_legacy_briefs` 列出 + `append_step_draft`
  追加，一次性兜底，不恢复勾选区）。技能区加归处标记：技能未安装有标记（已有），`SkillDto.mentionsMcp` 标出含
  「推荐 MCP」节的技能、点击跳 MCP 页。步骤级只读预览入口
  （任务卡桶头部「预览 TASK.md」）走 `buildTaskMdPreview`，同一出处。开步在 ensure_git_repo 后先走
  `commit_project_bootstrap`（best-effort）：只把 `.ccode` 与 `.gitignore` 提交进主仓（literal pathspec，用户暂存文件
  绝不带走），防评审合并被主仓脏拦截；默认 .gitignore 含 `*.pdf` 与 `.ccode/handoff-*.md`。**TASK.md 不进 git**：落盘时自动追加进
  `.git/info/exclude`（`exclude_task_md`，全 worktree 与主仓生效，best-effort 不阻断）——TASK.md 是开步脚手架而非任务产物。
- **流水线模板库**：内置模板集中在 `src/pipeline-presets.ts` 的 `PIPELINE_TEMPLATES`（综述/科研论文/数据处理/毕业论文/投稿与返修），
  新增场景 = 数组加一项，简报必须遵守输入写死/决策写死/交付写死约定（auto 模式无歧义）；用户模板走后端
  `list/save/delete_pipeline_template`，选择器（TemplatePicker）合并展示，后端命令未就绪时优雅降级为仅内置模板。
  **v3.78 起五套模板内容重设计并互相对齐（接壤）**：准绳 =「讨论种子 → 草稿 → TASK.md → 执行」全链相辅相成——
  种子逐条对准 TASK.md/执行中的真实拍板点（删空洞种子、补缺口种子；纯执行步骤不给种子，沿用 v3.69 口径）；
  expectedArtifacts 精确化；技能挂载按 14 个内置技能核对（research-paper 首步 +lit-notes、结果分析/毕业论文
  实验步 +stats-check、毕业论文初稿/定稿 +quarto-render、data-eda 步 +stats-check；submission-rebuttal 摘除
  不存在的假技能 pre-submission-reviewer，投稿前自查口径内联进简报）；lit-search 链路步骤新增 before 人工事项
  「（可选）配置学术检索 MCP」（MCP 页预设导入 Consensus/Undermind，key 走环境变量引用；不配也能跑——
  OpenAlex/Semantic Scholar 免 key 兜底），付费墙文献全程有人工事项接应（落点 `papers/*.pdf`）。
  **接壤路径约定**：五套是同一条科研流水线的相邻段，产物路径固定对齐——综述末步产 `manuscript/review-final.md`、
  科研论文末步产 `manuscript/paper-final.md`，投稿与返修首步输入精确指向两者 + `references.bib`；综述的
  `notes/`+`references.bib` 可被科研论文/毕业论文首步复用，数据处理的 `analysis/` 可接科研论文实验段。
  每套模板首步简报带双口径输入说明（接自上游模板随仓库合并自带 / 独立启动先放入对应目录或在资源面板绑定上游
  项目目录）；投稿与返修首步另有 before 人工事项「放入成稿与 references.bib」（落点 `manuscript/`）。
- **流水线编辑器（RX1）是步骤编辑唯一入口**：`src/components/PipelineEditor.tsx` 全宽覆盖层（fixed inset-0 z-30，与评审
  覆盖层同级），每步一张卡片（名称/工作区名/简报/预期产物/run 脚本/资源绑定），整体写回 steps；新增步骤相关编辑一律进
  编辑器，不再开第二套入口。`ProjectStepDto.resources?: string[]` = 资源绑定（`[[resources]]` 条目的 path），**空/缺省 =
  全部资源**；`renderTaskMd` 只在绑定非空时过滤「项目资源」段（单一出处在 `pipeline-start.ts`）。**例外（v3.67）**：
  开工确认弹层的推荐技能区可就地增删 steps[].skills——走专用小 command `update_step_skills`（读-改-原子写，
  不走整份 write_project_config 往返），步骤名/简报等结构字段仍只在编辑器改。**「＋ 从模板追加」（v3.78，
  模板接壤的 UI 落点）**：编辑器工具区「+ 添加步骤」旁，列出内置五套 + 用户另存模板，选定后把模板步骤
  **追加**到 steps 末尾（区别于「使用模板 = 整体替换」；步骤链/提货单/资源机制对新步骤天然生效）。后端
  command `append_pipeline_steps`（projects.rs）：过 `ensure_task_project_root` 写门槛；读-改-原子写；
  **重名跳过**——name 或非空 workspace_name 撞已有步骤、或撞本批次刚追加进来的，都跳过（避免覆盖已有
  工作区绑定），返回 `{appended, skipped}` 供行内提示「已追加 N 步；跳过 N 步（同名）：xx」；全部被跳过
  不落盘、空批次直接拒绝。追加**直接写盘、不经编辑器未保存草稿**：dirty 时先弹确认（未保存改动将丢失），
  成功后前端重读 `read_project_config` 刷新步骤卡与脏检查基准（`onConfigReload` 回推父组件同步
  cfg/warnings）。

## 接力与提炼接力

- **「接力」是唯一的跨 Agent 交接表述**：接力 = 结构化简报落成文件 + 新 Agent 带简报启动 + 记录接力链，明示不是记忆转移；
  禁用「无缝继续」。v1 机制（handoff.rs）：简报全文过 `redact_sensitive_text` 脱敏 + 64KB 上限后原子写
  `cwd/.ccode/handoff-<时间>.md`（自定义路径不得出项目根）；简报是过程文件不进版本库：新项目默认 .gitignore 模板含
  `.ccode/handoff-*.md`，存量仓库在每次写简报时 best-effort 补齐该规则（`with_handoff_rule` 幂等追加，非仓库静默跳过）；
  接力链先按 agent+cwd 登记 `handoff_links`，新会话被扫描到时
  固化进 `session_meta.handoff_from_*` 并消费登记（防同目录后续会话误标）；kimi/opencode 无启动注入参数，走复制简报路径 +
  手动发送，不得伪造注入成功。
- **「◈ 提炼接力」是长会话续作的 AI 简报变体**（handoff.rs `build_session_digest`，AI 功能键 `digest`）：全会话文本（DTO 层
  已脱敏，`cap_text_middle` 24KB）经无头 AI 蒸馏成结构化简报（任务目标/关键决策/已完改动/状态待办/下一步/环境约束），AI 输出
  再过 `redact_and_cap` 才落盘；目标列表来源 agent 置顶（同 Agent 新会话，不走 resume 防上下文污染），跨 agent 与接力链登记
  复用既有链路；外部续作走 `digest_command_line`（按注册表 prompt_inject 拼「新会话 + 读简报首条指令」，**非 resume**；
  Unsupported 的 kimi/opencode 复制指令文本手动发送）；无 AI profile 或调用失败行内报错可重试，不免 AI 静默降级（免 AI 场景
  用原「◈ 接力到…」快速简报）。**v3.60 起生成是 store 后台任务（`digestJob` + `startDigestJob`）**：DigestPicker 可关可开，
  同一会话（agent+sessionId+filePath）复用结果不重复发起（费 token 且慢），失败重试走 force；ready 未消费进收件箱「待发送」
  （`{type:"digest"}` → `digestOpenReq` 由对话页消费重开 picker），选定目标或「暂不发送」即 `consumeDigestJob` 摘除。
  **v3.77 起 DigestPicker 单页化（钉卡中间层拆除）**：AI 初稿就绪后同页显示「初稿编辑框 + 发送目标列表」，不再强制
  两段定稿；点目标直接发送——零改动用 AI 初稿 handoff-*.md，有改动先 `finalize_digest_brief` 写回 handoff 文件再发
  （写回校验：`.ccode/` 内 + `handoff-` 前缀 + `redact_and_cap` + atomic_write）；「暂不发送」= 有改动才落盘 + 关闭；
  不再有「定稿落盘钉入任务卡」，三条发送路径（内部新会话 / ⧉ 复制外部命令 / ⇗ 外部终端）与收件箱「待发送」胶囊不变。

## 任务卡

- **任务卡（纯对话归档夹；无独立状态机，不碰工作区/评审流程）**：卡片挂在项目
  `.ccode/project.toml` 旁（projects.rs task_cards，写操作过 `ensure_task_project_root` 门槛，list 非项目返回空表）；
  会话归置存 `session_meta.task_id`（`assign_session_task`，删卡自动清归置），SessionMetaDto 回填 taskName。
  前端：`store.taskCards` 按项目根缓存 + 变更后重取（deleteCard/assignSessionTask 顺带刷新会话列表）；纯逻辑集中
  `src/task-cards.ts`（按步骤分桶——失效步骤并入「未挂步骤」桶恒在末尾、cardForStep、groupSessionsByTask——
  「未归置」恒最前同原「无工作区会话排最前」口径）。工作区页卡片区 = `TaskCardsSection`（ProjectGroup 内、步进器下方，
  展开手风琴按卡片 id 记忆、切项目随 key 重挂载清空）：「开工」= 打开开工确认弹层（TASK.md 预览/编辑，草稿优先），
  确认才走 startPipelineStep；「继续」= 有绑定工作区时可用：pendingTerminal initialPrompt「阅读 TASK.md 并继续任务」
  （cwd = 卡片绑定工作区工作树否则项目根，工作树内引用用绝对路径；kimi/opencode 无注入由启动栏 promptDropped
  既有处理兜底）。**主仓改动协同**（v3.64）：聊想法在主仓进行，agent 改动留主仓合法——
  弹层顶部与卡片区标题行各一条警告色提醒（复用 `git_status`，进项目详情读一次 + 弹层打开刷新，不轮询，非 git 不渲染），
  卡片区点击经 `PendingTerminal.rightTab: "git"` 直达终端页改动面板；只提醒不阻断。对话页项目筛选下按卡片分组 + meta 行「▤ 卡片名」chip
  （点击经一次性 `selectProjectReq` 跳工作区页选中项目，WorkspacesPage 消费）+ ⋯「移到卡片…」（仅项目筛选下显示）。
  评审合并成功横幅「▶ 开始下一步」旁「沉淀到下一步」：评审结论 → `append_step_draft` 追加进下一步草稿（v3.72 起，
  详见「任务书草稿」节），成功提示 10s 自收。**认领机制（聊想法/开工/继续发起前）**：`card_claims` 表 +
  `claim_next_session_for_card` command——按 agent+cwd 登记（同键覆盖，created_at 时间口径排除登记前旧会话），
  会话扫描时（`apply_card_claims`，list_sessions 内 apply_handoff 之后）固化进 `session_meta.task_id` 并消费登记，
  口径与 handoff_links 一致；认领 cwd 恒为项目根（工作区会话 project_path 已改写为真实仓库）；登记失败静默降级，
  对话页手动归卡兜底。卡片行「聊想法」= 项目根开终端预填「我想跟你探讨：<卡片名>」（不建工作区，想法期不动手）；
  挂步骤的卡走任务书草稿口径（非只读、结论直写草稿，开聊自动带开草稿预览），未挂步骤的卡维持只读纯聊归档。
  **想法期只读保护**（v3.66，settings.json `discussReadonly`，卡片区标题行就地开关、默认开，设置页不加行；
  v3.77 起只服务未挂步骤卡片的纯聊一路）：
  开 = 预填指令带「只讨论不动文件」约束 + `PendingTerminal.readonly` → pty_spawn 注入注册表
  `readonly_args`（`agents::readonly_launch_args`；claude/codebuddy `--permission-mode plan`、codex `-s read-only`
  替换默认 workspace-write、gemini `--approval-mode plan`、kimi/cursor `--plan`；qwen/opencode 无据只有软约束，
  支持矩阵见 matrix 跨 agent 共性结论 §6）；卡片 ⋯「聊想法（允许改文件）」= 不动开关的单次豁免（开关关时不渲染）。
  主按钮口径（v3.77）：有绑定工作区 = 继续（工作树读 TASK.md）；未开工挂步骤 = 聊想法（草稿口径）+ 开工；
  未挂步骤 = 只读纯聊。

## 任务书草稿（v3.72：讨论直接服务于 TASK.md，中间层拆除）

- **动机（用户拍板）**：「聊想法 → ◈ 提炼定稿 → 钉卡 → 开工拼装/融合」四转手中间层被否——想法既然服务于
  TASK.md，就该直接在 agent 里聊、直接改任务书。v3.77 把中间层残留整体拆除：`save_task_brief`/
  `attach_brief_to_card`/`ai_fuse_briefs`/`ai_fuse_task_md` 四命令删除，TaskCardDto 去 briefs 字段（旧
  project.toml 的 `briefs = [...]` 解析忽略、写回丢弃，旧 `.ccode/brief-*.md` 文件留盘不删），DigestPicker
  单页化不再钉卡；卡片彻底退位为纯对话归档夹。
- **单一事实源 = 任务书草稿**：每步骤一份 `.ccode/drafts/<workspace_name>.md`（无工作区名回落 sanitize 步骤名；
  路径单一出处 `projects::draft_rel_path`），项目根、随 .ccode 进 git（草稿是源，工作区 TASK.md 是开工一刻的产物）。
  读 = `read_task_draft`（list 口径无门槛）；编辑 = 前端经 `read_file_preview`/`save_file_preview` 根约束；
  评审沉淀 = `append_step_draft`（读-改-原子写，不存在则以「# 任务书草稿：<步骤名>」头新建，
  小节 = 「## 上一步（<工作区名>）评审沉淀（<时间>）」）。
- **聊任务书**：流程线 discuss 节点（改名「任务书」）与种子点击同口径——非只读启动（agent 要写草稿，
  想法期只读保护不适用），预填指令约束**只许新建/修改草稿这一个文件**，并要求把没定下来的问题记到草稿
  「## 待拍板」小节；种子点击仍建卡归档（对话归置不变）。**开聊自动带开草稿预览**（v3.77：种子/自定义话题/
  「聊任务书」进终端时自动在右侧打开草稿预览，FilePreviewEditor 目录监听外部变化自动重载、agent 写入实时可见；
  想法期没有工作树，讨论与草稿都在项目根）。discuss 节点完成口径 = 草稿已起草（hasDraft，纯草稿口径）。
- **开工弹层**：草稿非空时编辑区初始内容 = 草稿全文（优先于模板拼装，等草稿到达再初始化防闪换；
  「恢复默认拼装」仍回模板拼装）；label 注明来源草稿路径，改编辑区不回写草稿。旧简报勾选/融合区已删除，
  仅剩一次性兜底：无草稿且存在旧简报（`.ccode/brief-*.md`）时显示一行提示 +「并入草稿」按钮
  （`list_legacy_briefs` + `append_step_draft`）。
- **评审「沉淀到下一步」**：从 save_task_brief 钉卡改为 `append_step_draft` 追加进下一步草稿——
  下一步开工弹层直接读到，不再经中间层。

## 人工事项（人机分工清单，v3.68）

- **定位**：步骤的一等属性「人工事项」= 这步里归人做的事（检索/下载付费文献/送导师审等）。声明在
  `project.toml` 的 `[[steps.human_tasks]]`（title 一句话 / guidance 引导说明 / target 交付落点 /
  timing = before|during|after）。**引擎不识语义**（科研语义只进模板，同既有纪律）：后端只做文本/路径透传 +
  状态派生。编辑唯一入口 = PipelineEditor（步骤卡「人工事项」区）；内置模板由 pipeline-presets.ts 声明，
  guidance 只告知选项与说明、**不替用户选择渠道**。
- **状态派生，无状态机**：done = 手动勾选 || 落点检测，**手动优先**（勾了系统不再追问；取消勾选删行回到纯检测
  口径；检测命中的事项要取消只能移走文件）。手动勾选存 app.db `human_task_checks` 表（行在 = 人勾了，
  主键 project_path+step+title——事项改名视为新事项）；检测 = `human_target_hit` 按落点现算：目录（结尾 /，
  递归限量 2000 项）有任意非隐藏文件 / 「目录/通配」（`*` 只允许最后一段）有匹配文件 / 精确文件存在；
  绝对路径与 `..` 逃逸一律视为未交付（同产物核验口径）。检测根 = 项目根 + 步骤绑定的活跃工作区工作树
  （交付落在哪侧都算）。命令：`list_human_task_states`（list 口径无门槛）、`set_human_task_check`（过
  `ensure_task_project_root`）。
- **提交交付**：`import_human_deliverable`（卡片 checklist 行「提交产物」按钮 / 拖文件到该行）= 复制进落点
  （目录/通配用源文件 basename，精确文件允许改名交付；已存在同名拒绝）+ best-effort 登记该根 artifacts.yaml
  （produced_by = 人工交付；登记失败只回告不否决复制——文件落位检测口径已算完成）。落点根 = 绑定工作区活跃时
  工作树优先，否则项目根。**v3.74 扩展**：新增可选 `target_override`（检索结果导入固定落 `papers/imports/`，
  lit-search 人肉中转协议：Undermind/Consensus/Elicit 导出 RIS/BibTeX/CSV 放入，agent 开工自动解析、去重、
  合并进筛选清单）；`step`/`title` 转可选——无步骤语境（资源面板「导入检索结果」入口）= 纯导入落项目根、
  不登记提货单。两处入口：StepFlow 人工节点（落点在 `papers/` 的事项旁「导入检索结果」按钮，多选）与
  资源面板「发现资源」旁。交付落在项目根时导入成功后追问「要登记为项目资源吗」（登记 = read_project_config
  → write_project_config 追加，与资源面板同一写回口径；工作区落点不追问——临时目录登记没意义）。
- **三个告知触点，全部只提醒不阻断**：① 开工确认弹层「人工事项」区（步骤声明了才渲染；before 档未完成时
  警告色提醒「仍要开始也可以」）；② 流程线 human 节点橙点（v3.73 起替代已删除的「当前步骤条」与
  「等你做 N 件」计数按钮）：聚焦头部显示步骤名 + describeStep 白话状态（待开始按草稿是否已起草分
  「建议先点下方种子聊聊」/「想法已就位」），主推进入口并入流程线节点——待开始=开始（agent 节点）/
  工作区已归档=恢复工作区（agent 节点，替代开始）/待评审=去评审/阻塞=去处理冲突（评审节点，带
  resolve-conflict 意图直达评审覆盖层不绕终端）/进行中=去终端看看；轮到人做的 human 节点旁上橙点
  （口径仍是 `actionableHumanTasks`：after 档 agent 完成前不计；ProjectGroup 算好标题列表经 props 传入，
  组件不重复发明计数），点橙点 scrollIntoView 定位 + 1.5s 高亮。
  **人工事项是步骤级，不进卡片**（v3.69 修正：卡片是想法容器，一步多卡时步骤级清单在每张卡重复渲染 = 噪声）；
  **v3.70 起大圆点击语义从「终端入口」改为「步骤聚焦」**（用户拍板：圆上不再跳终端/开步——推进动作归流程
  线节点、卡片行、任务行）：点圆 = 卡片区只看该步骤（种子 + 卡片 + 人工事项清单一屏内），选中圆中性高亮环，
  未选过时默认聚焦当前步骤，「总览全部步骤」还原（v3.73 改名并真切换：总览态桶强制展开，无卡无种子桶
  占位「该步骤还没开始」；聚焦态桶头去重——步骤名与「预览 TASK.md」不再重复渲染，预览全页唯一入口 =
  流程线 agent 节点）；步骤 ⋯「人工事项（N 件待做）」= 同效聚焦入口。**工作区列表跟随聚焦过滤**（v3.73：
  归属判定 = `steps[].workspaceName` === 工作区名，与 deriveStepStatus 同一映射；ProjectGroup children 改
  render prop 回传 focusStepName/steps/showAll/onToggleShowAll，列表过滤逻辑留在 WorkspacesPage），
  标题「{步骤名} · 工作区（N）」+ 右侧「全部/按步骤」切换，空态区分「该步骤还没有」与「项目还没有」。
  **v3.71 起聚焦视图顶部为「步骤内协同流程线」（StepFlow）**：这一步里人和 agent 的动作按先后排成节点链
  （讨论种子 → before 人工事项 → agent 执行 → during 人工事项（并行段）→ after 人工事项 → 评审合并），
  当前节点 = 第一个未完成（高亮 + 就地展开操作区：种子 chips/提交产物/开始/去终端/去评审）——
  回答「这一步谁先谁后、现在轮到谁、轮到我时在哪操作」。纯逻辑 `src/step-flow.ts`（buildStepFlow，
  runStatus 四态由 ProjectGroup 从 deriveStepStatus 六态映射，blocked 并入 review——阻塞也走评审入口）；
  人工事项的状态/勾选/交付/拖拽逻辑抽成 `useHumanTasks`（HumanTasksList.tsx 导出），
  平铺清单（开工弹层）与流程线共用一份。
  ③ 评审覆盖层可信度行加「收尾事项 N 件待做」（仅 after 档未完成，进评审一次性读取）。熟手可全程无视，不挡任何流程。
- **agent 动态人工请求（HELP-WANTED 约定文件，非阻断）**：agent 需要人协助时写工作树（或主仓）
  `.ccode/help-wanted.md`，每条一行「- 」开头且**必带兜底句**「若未回复则按 ×× 继续」——agent 写完按兜底
  继续，不停工等待（偏差靠评审流兜底，不做阻断式请求）。Ccode 侧 `list_help_requests` 扫活跃工作区工作树 +
  主仓根（无工作区的项目不扫；上限 20 条 × 300 字符）→ 收件箱「人工请求」类条目（`help:<root>`），
  「去查看」经 selectProjectReq 跳工作区页（消费方同时匹配 repoPath 与 worktreePath）；条目可 ✕ dismiss
  （localStorage `ccode.helpDismissed` 按 root 存 items 签名，内容变了自动复现）；新来源 edge-trigger +
  30s 去抖发 OS 通知（复用「长任务 OS 通知」开关，不新增设置项）。TASK.md 在步骤有人工事项时自动带
  该约定的说明段（renderTaskMd 单一出处）。
- **收件箱分类胶囊（v3.68 同步改造）**：顶栏/页内 strip 的单一「待你处理 N」拆为按类别胶囊
  （冲突/待确认/可合并/待核验/待发送/配置失效/人工请求），点胶囊展开该类条目；类别推导与分组纯逻辑在
  `src/inbox.ts`（`inboxCategoryOf`/`groupInbox`，key 前缀即类别，confirm: 与 live: 合并「待确认」口径不变，
  未知前缀回落待确认防静默丢失）。
- **待拍板问题（零新存储）**：草稿里约定小节 `## 待拍板`（`### 待拍板问题` 也算）的条目在卡片展开态渲染为
  「待拍板」列表（`extractOpenQuestions` 纯逻辑，遇下一标题即止；v3.77 起数据源从定稿简报改为步骤草稿，
  卡片展开时按需读草稿）；点条目 = 带该问题去「聊想法」。讨论在终端、结论沉淀在草稿（讨论指令要求 agent
  把没定下来的问题记到草稿「## 待拍板」小节），卡片只做索引——不给待拍板建独立存储。
- **讨论种子（v3.69，`discussion_seeds`）**：模板按步骤预置「开工前建议想清楚的问题」（只有人能拍板、拍错
  返工贵的决策点；与人工事项的分工 = 种子是「要商量的」、人工事项是「要动手做的」），解决「卡片话题不该靠
  用户凭空想」。声明在 `[[steps]]` 的 `discussion_seeds = [...]`（去空白、空项剔除、空数组省略不写；不进
  TASK.md——种子是给人的入口，不是给 agent 的合同），编辑唯一入口 PipelineEditor。种子 chips 渲染在流程线
  「任务书」节点（总览态另在步骤桶内出「开工前聊聊：」行），**点击即聊**：以问题为名自动建卡（已有同名卡
  直接续聊），走任务书口径（非只读、结论直接写草稿，见上节）。手动入口与种子同节点同口径：流程线种子区
  「＋ 自定义话题」起名即聊；总览态桶头「＋ 添加想法」挂步骤时同样走 onSeed 草稿口径，未挂步骤的卡无步骤
  语境、只建卡归档。纯执行步骤不给种子（没有要商量的就不出现入口）。

## 定时雷达（scheduler.rs，v3.75）

- **职责切分**：调度器只管「什么时候跑」，检索策略/关键词/来源永远以项目内 `papers/watchlist.md` 为唯一口径
  （改流程 = 改文件，不在任务定义里复制关键词）；技能固定 `lit-watch`，skill 字段只做预留，不为假想技能抽象。
- **存储**：app 级 `schedules.json`（config_dir/ccode/，原子写 + 进程内锁，同 profiles/skills 口径）；历史留最近
  20 条（简报脱敏 + 截 2000 字符）；周期只支持「每日/每周 + 时分」（本地时区），**不引入 cron 表达式**。
- **due 判定即补跑**：「最近应跑时刻 > last_run_at」即 due——应用没开错过的时间点在启动后首个 tick 自动补跑，
  多次漏跑 coalesce 只补一次；防重入用进程内 Mutex<HashSet>，tick 与「立即跑」共用。
- **执行复用 ai.rs 无头链路**（`run_agent_task`）：与 ai_prompt_impl 唯二差异 = cwd 用项目根（不建/删临时目录、
  不登记 internal_ai_run——token 归因给项目是对的）与 `headless_task_args`（codex 用 `-s workspace-write`，
  巡检要写 notes/inbox.md 与 watch-seen.md，read-only 跑不了）；10 分钟超时；安全口径照旧（密钥拉起瞬间注入、
  background_command、出站脱敏）。
- **投递**：跑完发 `scheduler-run-done` 事件（summary 已脱敏）→ App.tsx 全局监听弹 OS 通知（复用
  notificationsEnabled 开关，不新增设置项）；命中正文仍由技能本身写 `notes/inbox.md`，调度器不二次搬运。
- **已知风险**：各家 CLI 无头模式的工具放行/写权限行为 matrix 无记录、未经全量实测（qwen 无头为位置参数兜底），
  首批用户验证后按实测校准并回写 matrix。

## 其他

- **上游漂移提醒（v3.63，启发式非硬状态）**：`stale_upstream_for`（workspaces.rs）——步骤 k 的任一上游步骤
  （序号更小，steps[].workspace_name 绑定工作区）晚于本步「最后推进时间」（已合并取 merged_at、未合并取
  created_at；now_iso 定宽串字典序即时间序）发生合并 → `WorkspaceDto.staleUpstream` 回填最晚合并的上游步骤名
  （仅 list_workspaces 计算）；本步再次合并自然恢复新鲜，不加状态位。前端三处同文案警告色提醒（步进器悬浮卡 /
  任务行状态详情 / 评审覆盖层顶部），只提醒不阻断。
- **评审「沉淀到下一步」走草稿、DigestPicker 单页化**（v3.63 起 AI 起草，v3.77 拆除定稿中间层）：评审沉淀 =
  「◈ AI 起草」（`ai_distill_review`，上下文 = 本步提交清单 + diff numstat + TASK.md）→ 人改 → `append_step_draft`
  落下一步草稿；DigestPicker = AI 初稿同页编辑、点目标直接发送（有改动先 `finalize_digest_brief` 写回 handoff
  文件）。**功能键复用 `digest` 不新增设置项**，失败行内报错可重试，不静默降级。
- **评审「可信度」行**（v3.63）：`check_citation_health`（citation.rs，纯 Rust 无 AI）扫 .md 引用键
  （`[@key]`/`[@k1; @k2]`/`[-@key]`；保守口径——项必须以 `[-]@key` 起头，带前缀的 `[cf. @k]` 不收）对照
  references.bib（根目录优先、其次 manuscript/）+ 产物 X/Y 摘要（复用 ArtifactChecklist 定位机制）；
  无 bib/全文无引用/无预期产物时不渲染，进评审一次性读取不轮询。

- **科研语义只进模板/数据/技能包**：流水线步骤、任务简报、技能包都是可编辑预设；引擎保持通用，不在逻辑里写死「文献/数据/
  论文」概念。
- **示例课题（首启引导最小版）**：`projects::create_demo_project` 在「文档/Ccode 示例课题」幂等生成演示项目（英文综述五步
  档案卡 + `build_demo_pdf` 手工拼 xref 的单页示例 PDF + references.bib + README；v3.77 起播示范任务书草稿替代原
  示范简报）；已注册直接返回现有 project，目录已存在
  但未注册时**只注册、不补建不覆盖**；git 初始化失败报错、bootstrap 提交 best-effort。前端入口 = 工作区空态「添加项目」旁
  次级按钮；侧栏底部「设置」上方另有常驻「⌘K 命令面板」发现入口（键位标签随自定义绑定）。
- **界面白话双层呈现（双语义）**：UI 主文案一律白话（保存到历史 / 相对主分支 / 多出 N 个保存点 / 改动说明），git 技术信息
  不删除、降为二级呈现（小字 mono、悬浮 title、详情 popover、⋯ 菜单），**不加任何模式开关**；状态分组等纯逻辑集中放
  `src/git-status-groups.ts`，新增 git 相关 UI 必须遵守同一双层规则。
