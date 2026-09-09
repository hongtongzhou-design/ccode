# 审计整改交接检查文件（2026-09-09）

> 用途：交给另一个 agent / 审查者核验「2026-09-09 Mesa 架构审计整改」这一天的全部改动。
> 读法：先看 §1 改动地图，再按 §2 逐条核验（每条都有可执行的检查方法），§3 是已知边界与后续方案。
> 基线文档：`docs/audits/architecture-audit-2026-09-09.md`（十大问题清单与各自状态）。

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

1. **人审的就是写入的**：`task_adopt_outputs_impl` 的写入源只能是 `review/<run>/payload/`，
   且 `check_adoption` 先校 payload 哈希、再查项目侧开工基线；`expectSeq` 不一致拒绝。
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
- §4.6 二期只做了双写+回填：读取侧（tasks/runs/会话归属）仍按路径查询，全量迁移待单独一批；
  项目搬家后历史关联仍指旧路径。
- 归档案面：归档后无 UI 恢复入口（数据都在，命令行/下一版 UI 可恢复）。
- Memory 没有「Agent 提议区」——Agent 的结论只能经人勾选沉淀，没有独立提议通道。
- Result Readiness 没有独立字段（由快照存在性隐式表达）。
- 技能纪律是提示词级约束，不是硬闸；实机仍滥用的话需要「目标级白名单硬约束」评估。
- 科研流水线/编程链路不走 task_review 冻结（它们走 Git 评审链），统一契约是后续话题。
- watch 契约展开只收 ≤2MB UTF-8 文本；二进制产出留在隔离目录不自动采纳。

**风险点（审查重点）**：
- stat 快路径用 mtime（纳秒）+ size 判「未变」，小文件另有内容哈希兜底；mtime 被人为回拨的对抗场景不在防护范围（本地单人使用前提）。
- 回合结束冻结发生在用户可能继续输入的过程中：采纳靠 expectSeq 防「看过之后又更新」，
  但「正在写一半的文件被冻进快照」由人审阅把关（评审弹层逐文件预览）。
- 另一会话的「自动起名」（`7808a1c`）是代收提交，其作者未走本仓库评审流程，建议单独复查
  `src-tauri/src/ai.rs` +365 行。

**后续优先级（与 audit 文档 P1/P2 对齐）**：
1. 实机走查 §2 全部 8 条。
2. §4.6 引用迁移全量收口（含「会话页恢复不带目标身份」缝隙）。
3. 归档案面（恢复入口）。
4. 科研复现能力解绑 workspace_id。
5. P2：PPT 预览组合、大输入低复制成本、冲突对比增强。
