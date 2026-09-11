# 审计整改交接检查文件（2026-09-09）

> 用途：交给另一个 agent / 审查者核验「2026-09-09 Mesa 架构审计整改」这一天的全部改动。
> 读法：先看 §1 改动地图，再按 §2 逐条核验（每条都有可执行的检查方法），§3 是已知边界与后续方案。
> 基线文档：`docs/audits/architecture-audit-2026-09-09.md`（十大问题清单与各自状态）。

## 2026-09-10 补充核验口径

本节覆盖旧交接文件里已被替代的约束；未列出的历史验证范围保持原样。

- 冻结副本改为不可变版本目录；同 Run 再冻结不替换旧版。旧格式 payload 保留可读。
- 返修继承原始基线与未采纳成果；已接受文件按账本内容哈希作为合法前态，外部改动仍拒绝。
- 接受后的退出不能重开目标；用户显式返修才重开。普通目标接受记录按版本、路径集合和意见幂等。
- 四种写回入口共用项目锁。Git 补账重放原版本/路径/时间，不合并新增工作；补账未完成不归档，凭证缺失不猜测。
- 目标/Run 定位按 ProjectId；真正移动时关联旧记录，现存同 ID 副本拒绝自动接管。Git 指针和原生会话源文件不自动修复/改写。

新增重点回归：`task_review::tests::refreshing_keeps_the_previously_reviewed_payload`、
`continuation_keeps_unchanged_unaccepted_outputs`、`accepted_version_can_be_revised_without_allowing_external_drift`、
`runs::tests::closing_a_run_never_reopens_an_accepted_goal`、`moved_project_resolves_goal_and_run_without_rewriting_history`、
`workspaces::tests::merge_pending_replay_never_merges_new_work_or_changes_original_version`、
`coding::tests::merge_records_the_base_worktree_head_not_the_project_checkout`。

2026-09-10 本轮自动化结果：`npm test` 829 通过；`npm run build` 通过（保留大 chunk 提示）；
`cargo test --offline --lib -- --test-threads=4` 1069 通过、1 忽略；`cargo check --offline --lib` 通过（仍有编译警告）；
`git diff --check` 通过。原科研开工 UI 测试及连续合并/归档测试均已恢复通过。

源码/自动化检查不等于 Mesa Dev 实机交互或九家 CLI × 三平台验收；仍需按下文实机清单确认。

## 2026-09-11 后续闭环与未验收边界

已实现：普通目标环境清单/返修上下文与成果绑定；点名技能分发版本核对；科研来源/结果指纹关联与自由目标入口；
人工知识修订、作废、旧文停用、来源漂移与最新优先注入；输入预检、流式大文件冻结/备份/写回、显式扩展预算；
新运行冻结失败禁止降级实时采纳；收尾复核最后部分成果、相同内容不造版本；评审 readiness；同批幻灯/PDF 配套预览。

最小回归集：`task_review::tests`、`project_memory::tests`、`research_quality::tests`、
`skills::tests::named_skill_snapshot_requires_matching_runtime_copy`、`runs::tests::input_preflight_rejects_over_budget_before_any_copy`；
前端 `tests/project-memory-panel.test.ts`、`tests/research-acceptance-panel.test.ts`、`tests/research-panels.test.ts`、`tests/goal-review.test.ts`。

保留边界：不是 OS 级只读沙箱；大输入仍需分范围，未做零复制只读挂载；定时自动采纳仍为 ≤2MB UTF-8 契约，
不静默升级为任意二进制；科研/编程/定时仍使用各自环境凭证，不宣称已统一所有 Runtime 的有效上下文；
无 Agent 自动记忆/向量库、无 PPT 原生渲染或自动内容一致性验证。三平台九 CLI 与真实端到端需实机另验。
本轮已确认 17575 的 Tauri Dev 来自本仓库，但电脑控制工具不能定位 com.ccode.dev.hmr，因此未拿旧 Mesa 窗口代验。

验证说明（共享工作树有并行开发，不以较早全绿替代最新结果）：本轮专属前端集 25 项通过，
Rust 专属集 task_review 15 / project_memory 3 / research_quality 5 / runs 28 / 技能快照 1 项全部通过；
`npm run build`、`cargo check --offline --lib`、`git diff --check` 通过，保留原有大 chunk/未使用代码提示。
最新一次全量检查出现本轮未修改的模板追加/模板产物契约变化：前端 864 通过、2 失败；Rust 1081 通过、3 失败、1 忽略。
失败位置为 pipeline-presets/research-quality 的模板产物断言，以及 projects 的步骤追加/替换测试；未为刷绿回退并行改动。
这些计数只代表检查时刻，后续并行开发变化需重跑。

## 2026-09-11 可靠性专项：当前实现与验收入口

本批只补两个风险边界：科研非 Git 文件不审错版本；普通目标/科研文件接收中断不丢失原操作。
新增回归覆盖 prepared 部分写入、账本失败、DB 失败、恢复方向中断、外部修改拒绝覆盖、JSONL 尾行截断、
Git 合并成功但合并 SHA 尚未落盘时的恢复、产物内容变化但 Git HEAD 不变、归档前 ignored 产物保护。
目标列表及评审从持久恢复单找回原操作；前端测试验证继续请求携带旧 Run/操作 ID，而不是最新 Run。
科研评审 UI 测试验证非 Git 固定副本展示及 token 随 merge 命令传递。

热更新通过本仓库 `npm run tauri:dev` 启动，17575；工具仍不识别 com.ccode.dev.hmr，用户负责最后窗口验收。
本批不操作真实项目作故障注入；异常路径均使用临时目录和隔离测试数据库。

本批最新完整验证：`npm test` 894 通过；`cargo test --offline --lib -- --test-threads=4` 1100 通过、1 原有忽略；
`npm run build` / `cargo check --offline --lib` / `git diff --check` 通过。保留原有大 chunk 与无关编译警告。
这组结果覆盖此前交接记录中的失败时刻，不把旧失败继续当作当前结论；仍不等同于三平台实机验收。

人工验收使用临时虚构数据项目，添加目录后执行：只生成 output/ 三文件→只改报告标题返修→三文件仍齐全→接受→关闭 Agent，
目标保持完成；检查 manuscript/ 保护文件未变。可选在项目中手改报告后再采纳旧副本，应拒绝覆盖。
中断故障无需用户在图形界面制造，不需要删除真实文件、强杀运行或改数据库。


## 1. 改动地图

| 提交 | 内容 |
|---|---|
| `aa563d8` | 审计基线文档入库 |
| `c2cd80d` | 评审冻结机制 + 接受账本 + 上下文快照 + 稳定项目 id + 技能内容摘要（后端） |
| `dce2906` | 写入政策口径 C：派生产物写工作区、评审合并带回；编程合并补保护路径（模板/技能种子/salvage） |
| `2dba783` | 冻结绑定的评审 UI + 失败可审 + 共享启动链 + 项目技能（前端） |
| `15ada85` | 决策记录与约定同步（§10 / conventions / 手册） |
| `4a33da1` | 实机修复：回合结束即冻结 + seq 绑定采纳 + stat 快路径 + 待验收通知 |
| `95f7412` | 技能纪律线（上下文包） |
| `ef708da` | 重试 = 续上次会话与副本；恢复回写目标状态 |
| `5ffcba8` | 勾选不被刷新重置 + 待验收事件驱动刷新 + 技能措辞强化 |
| `df4c912`+`6d6448b` | 规则面板保护路径不再铺文件墙 |
| `fdb7671` | 项目技能池 + 目标点名技能 + 文件保护选择器 |
| `73e7069` | task_create 占位符修复 + 版本错位防线 |
| `7808a1c` | 另一会话的「对话自动起名」（非本次审计整改，代收） |
| 本次（未命名，工作树/新提交） | 话题改名 + 删除即归档 + memory.md + 定时采纳契约 + project_id 双写回填 |

核心新文件：`src-tauri/src/task_review.rs`（评审证据：基线/冻结/三向判定/上下文快照，纯文件不碰 DB）、
`src/goal-run.ts`（普通目标共享启动链）。核心改动文件：`src-tauri/src/runs.rs`、`projects.rs`、
`watch_review.rs`、`scheduler.rs`、`coding.rs`、`workspaces.rs`、`skills.rs`。

## 2. 核验清单

### 自动化（应全绿）

```bash
npm test                                  # 前端，应为 798+ 全过
./node_modules/.bin/tsc --noEmit          # 类型检查
cd src-tauri && cargo test --offline --lib -- --test-threads=4   # Rust，应为 1040+ 全过
npm run build                             # 生产构建
```

重点回归测试（改动各自带的新增测试）：
- `task_review::tests::*`（7 项）：基线/冻结/三向判定/删除不写回/stat 快路径/旧格式基线兼容/上下文快照防篡改
- `runs::tests::cleanup_failed_prepare…`（复用目录不被失败清理误删，§4.3）
- `runs::tests::scratch_and_reader_runs_have_no_goal_task`（§4.7）+ `resume_returns_goal_task_to_running`
- `runs::tests::project_id_backfills_from_projects_by_path`（§4.6 二期）
- `workspaces::tests::copy_untracked_deliverables_names_conflicts…`（salvage 冲突点名）
- `coding::tests::merge_refuses_branch_touching_protected_paths`（编程合并保护路径）
- `watch_review::tests::contract_dir_pattern_carries_new_text_outputs`（§4.9 后半）
- `projects::tests::acceptance_log_appends_and_dedupes_by_run` + `project_memory_appends_only_confirmed_entries`
- `tests/project-context.test.ts`：技能纪律线 + 点名/池分段 + 版本号展示

### 关键不变量（代码走读核对点）

1. **人审的就是写入的**：`task_adopt_outputs_impl` 的写入源只能是所审版本的不可变 payload（旧证据仍读 `review/<run>/payload/`），
   且 `check_adoption` 先校所审版本的 payload 哈希、再查开工/已接受基线；`expectSeq` 缺失或不一致拒绝。
2. **失败清理不删旧成果**：`cleanup_failed_prepare(created_here, …)`，复用目录 created_here=false。
3. **删除永不自动写回**：snapshot 的 `deleted` 只进证据，采纳路径过滤。
4. **接受账本必写**：`append_acceptance_log_at` 失败 → 采纳整体返回可见错误（重试幂等）。
5. **契约外不采纳**：`watch_review::checked_path` 走 `watch_pattern_allows`。
6. **保护路径两链同口径**：`workspaces.rs` 合并与 `coding.rs merge_at` 都过 `path_is_protected`。
7. **归档不抹数据**：`task_delete` 只置 `archived_at`，无 DELETE。

### 实机走查（自动化覆盖不到的部分）

`tail -f /dev/null | npm run tauri:dev`（窗口标题「Mesa Dev - 热更新」，端口 17575）：

1. 新建目标 → 开工速度（大项目应明显快于全量哈希时代）。
2. Agent 答完一轮（不退出）→ OS 通知「产出待验收」+ 项目页即时出现待验收。
3. 评审弹层：取消勾选不被重置；「本次工作环境」可见冻结上下文；「本次运行未正常完成」横幅只在失败/停止时出现。
4. 任务期间改项目里同名文件 → 采纳被点名拒绝。
5. 重试失败的目标 → 进同一副本、续原会话；工作台「继续」恢复后项目页显示「进行中」。
6. 归档一个目标 → 列表消失；`.ccode/acceptance-log.jsonl` 与 task-runs 目录仍在。
7. 验收时勾选「沉淀进项目长期知识」→ 项目 `.ccode/memory.md` 出现该条；下次开工快照里可见。
8. 规则面板「项目技能池」添加 lit-notes；新建目标不点名 → Agent 不主动套用；点名 → 按其规范执行。

## 3. 已知边界与后续方案

**明确未做（有意保留）**：
- §4.6：目标/Run 已按 ID 解析当前位置；历史路径与原生会话来源保留。跨机恢复、Git 指针修复与完整复制项目 UX 仍需单独验收。
- Memory 没有「Agent 提议区」；已有人工维护、来源漂移和作废，不自动把助手结论沉淀。
- 普通目标评审已返回派生 readiness；未增加持久结果状态机，也未把进程状态当目标状态。
- 技能纪律是提示词级约束，不是硬闸；实机仍滥用的话需要「目标级白名单硬约束」评估。
- 科研流水线/编程链路不走 task_review 冻结（它们走 Git 评审链），统一契约是后续话题。
- watch 契约展开只收 ≤2MB UTF-8 文本；二进制产出留在隔离目录不自动采纳。

**同日已补（优化批次）**：归档案面（`task_unarchive` + 目标页折叠恢复）；验收账本只读展示；
`task_list` 默认不含归档行；沉淀知识失败 fail-closed 且按 run_id 幂等。

**风险点（审查重点）**：
- stat 快路径用 mtime（纳秒）+ size 判「未变」，小文件另有内容哈希兜底；mtime 被人为回拨的对抗场景不在防护范围（本地单人使用前提）。
- 回合结束冻结发生在用户可能继续输入的过程中：采纳靠 expectSeq 防「看过之后又更新」，
  但「正在写一半的文件被冻进快照」由人审阅把关（评审弹层逐文件预览）。
- 另一会话的「自动起名」（`7808a1c`）是代收提交，其作者未走本仓库评审流程，建议单独复查
  `src-tauri/src/ai.rs` +365 行。

**后续优先级（与 audit 文档 P1/P2 对齐）**：
1. 实机走查 §2 全部 8 条，外加归档恢复与验收记录展示。
2. §4.6 引用迁移全量收口（含「会话页恢复不带目标身份」缝隙）。
3. 科研复现能力解绑 workspace_id。
4. P2：PPT 预览组合、大输入低复制成本、冲突对比增强。
