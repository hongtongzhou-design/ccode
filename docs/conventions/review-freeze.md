# 普通目标评审冻结（review-freeze）

> 状态：已拍板并落地（2026-09-09，用户指令「执行」）。前身草案 `docs/review-freeze-design.md`
> 已并入本文件。对应审计 `docs/audits/architecture-audit-2026-09-09.md` §4.2。
> 改动普通目标（free_research / office_doc）的开工、收尾、评审或采纳前必读。

## 适用范围与边界

- 只覆盖普通目标链路：`task_prepare_run` / `task_output_changes` / `task_adopt_outputs`。
- 科研 worktree 评审与编程 lane 走 Git，不在本机制内；定时巡检沿用 `watch_review.rs`
  固定白名单冻结（两套机制同构，不合并实现）。
- 「completed 才能审」的入口未解绑：执行状态 / 结果可审 / 目标完成三分是 P1 事项；
  本机制只保证收尾时证据冻住（失败/停止的 Run 也冻结）。

## 机制

```
开工（task_prepare_run_impl，Run 登记后）
  → write_baseline：对隔离目录逐文件记 sha256+大小，同时记项目根同路径哈希
    （复用上一版目录时两侧可不一致，那正是要防的漂移起点）。
    写失败 = 开工失败（fail-closed），Run 记 failed，不静默降级。

收尾（close_run_with_result，账本提交后）
  → freeze_task_run_evidence：仅「review_required 的 free_research/office_doc」参与；
    隔离目录现状对基线现算 diff，变化文件内容复制进 payload/，写 snapshot.json。
    无基线（旧 Run）跳过不伪造；冻结失败记 logbuf + task.snapshot_failed 事件，
    不反向影响收尾。

评审（task_output_changes → TaskReviewDto）
  → frozen=true：变更清单读 snapshot.json，预览从 payloadDir 读字节。
  → frozen=false（旧 Run / 冻结失败）：目录现算，前端弹层顶部明示「没有冻结证据」。

采纳（task_adopt_outputs）
  → 冻结路径：check_adoption 逐文件三向判定——
      项目现读 == 冻结内容        → 跳过（幂等）
      项目现读 == 开工基线        → 允许写入
      否则                        → 整批拒绝并点名「任务开始后已被修改」
    附带：payload 实际哈希必须等于快照记录（防证据目录被外部改动）；
    写入源只认 payload/，经原有备份+回滚+采纳锁落盘。
  → 未冻结路径：维持旧行为（隔离目录现读），前端已先行明示。
```

## 存储

`task-runs/<task-id>/review/<run-id>/` 下 `baseline.json` + `snapshot.json` + `payload/`，
随 `task_delete` 整树清除。快照与基线写入后拒绝改写（同一 Run 只有一份证据）。

另有 `context.json`（2026-09-09，审计 §4.8）：开工一刻**实际下发给 Agent 的上下文全文**
（前端拼装的 Context Pack + 目标行经 `task_prepare_run` 的 `contextText` 传入，sha256 校验，
读取时哈希对不上即拒绝）。开工写失败 = 开工失败，与基线同一 fail-closed 口径。
评审弹层「本次工作环境」折叠区展示；科研流水线侧 TASK.md 落工作区本身就是上下文凭证，
不重复冻结。

容量口径：单文件 > 64 MB 记 `too_large`（进清单、不复制、不可自动采纳）；
冻结总预算 512 MB，遍历上限 20,000 文件；超限明确报错，不写半截快照。

## 硬规则

- **人审的就是写入的**：预览与采纳读同一份 payload 字节；采纳前再校哈希。
- **删除永不自动写回**：`deleted` 只是证据行（前端划线展示、不可勾选），要删由人手动删。
- **mtime 不作数**：`run_artifacts` 的修改时间只用于候选发现，不作产出归属或版本判定依据。
- **冲突不自动合并**：三向判定不通过 = 拒绝 + 人工，不做 three-way merge。
- 新增/修改/删除的展示分组沿用 `goal-review.ts`；保护路径检查在采纳时照旧先跑。

## 接受记录（2026-09-09，审计 §4.5）

- 采纳写文件成功后，先写**长期账本** `.ccode/acceptance-log.jsonl`（append-only，按 run_id 去重，
  重试幂等）；账本落盘失败 = 采纳返回可见错误引导重试（已写入文件自动跳过），不许静默成功。
- `project-status.json` 降级为账本的「最近摘要」投影（按名替换、留 20 条）；摘要写入失败记
  logbuf + `task.accept_summary_failed` 事件，不再静默吞掉。
- 删除目标只清工作数据（Run/事件/隔离目录/评审证据），**不再**连带删摘要；账本在项目 `.ccode/`
  里，天然不受目标删除影响。目标「删除即归档」的完整语义留待后续拍板。

## 已知未做（后续批次）

- 执行状态 / 结果可审 / 目标完成三分的完整语义（§4.4）已完成**入口侧**（2026-09-09）：
  有冻结证据的 Run 审核/采纳不再要求 `completed`，失败/停止且冻结到可审成果的 Run
  会把目标提升为 `pending_review`（`review_status_for`），评审弹层对非正常完成给出横幅。
  未做的剩余部分：Run 状态机本身仍只有 completed/failed/stopped，没有独立的
  Result Readiness 字段；目标「完成」仍由人点接受表达，没有显式验收条件对象。
- 接受账本暂无界面展示与 Context Pack 引用（P1 项目知识沉淀时消费）。
- 项目级接受记录与知识沉淀（P1）。
