# 普通目标评审冻结（review-freeze）

> 状态：已拍板并落地（2026-09-09；2026-09-10 补齐不可变版本、返修与接受状态约束）。前身草案 `docs/review-freeze-design.md`
> 已并入本文件。对应审计 `docs/audits/architecture-audit-2026-09-09.md` §4.2。
> 改动普通目标（free_research / office_doc）的开工、收尾、评审或采纳前必读。

## 适用范围与边界

- 只覆盖普通目标链路：`task_prepare_run` / `task_output_changes` / `task_adopt_outputs`。
- 科研 worktree 评审与编程 lane 走 Git，不在本机制内；定时巡检沿用 `watch_review.rs`
  基线文件 + 技能产出契约冻结（两套机制同构，不合并实现）。
- 有冻结证据即可审，失败/停止的部分成果也可采纳；无冻结证据的旧 Run 仍要求 completed。
- 目标已接受后，Run 退出不得把目标改回待验收/失败/停止；只有用户显式返修才重新进入 running。

## 机制

```
开工（task_prepare_run_impl，Run 登记后）
  → 首次 write_baseline：记录副本与项目根的 stat 签名，小文件另记内容哈希。
    返修 continue_baseline：继承原始基线，保留上一版未修改、但尚未采纳的成果；
    不把上一版成果重新当成输入。上一版缺基线时拒绝安全续改，旧副本保留。
    写失败 = 开工失败（fail-closed），Run 记 failed，不静默降级。

收尾（close_run_with_result，账本提交后）
  → freeze_task_run_evidence：仅「review_required 的 free_research/office_doc」参与；
    对原始基线现算变更，同一次读取的字节用于哈希与副本，发布到独立版本目录；
    完整清单与副本落盘后，再原子更新当前 snapshot.json。
    无基线（旧 Run）跳过不伪造；冻结失败记 logbuf + task.snapshot_failed 事件，
    不反向影响收尾。

评审（task_output_changes → TaskReviewDto）
  → frozen=true：变更清单读 snapshot.json，预览从 payloadDir 读字节。
  → frozen=false（旧 Run / 冻结失败）：目录现算，前端弹层顶部明示「没有冻结证据」。

采纳（task_adopt_outputs）
  → 冻结路径：check_adoption 逐文件三向判定——
      项目现读 == 冻结内容        → 跳过（幂等）
      项目现读 == 开工基线        → 允许写入
      项目现读 == 本目标此前接受的内容哈希 → 允许返修写入（不是拿现读内容重设基线）
      否则                        → 整批拒绝并点名「任务开始后已被修改」
    附带：payload 实际哈希必须等于快照记录（防证据目录被外部改动）；
    写入源只认这版 payload；新冻结结果的采纳必须回传 expectSeq。
    项目采纳锁覆盖三向检查、文件应用与接受记录；文件先私有暂存再替换，
    当前文件写后报错也参与回滚，外部再次修改的文件不强制回滚。
  → 未冻结路径：维持旧行为（隔离目录现读），前端已先行明示。
```

## 存储

`task-runs/<task-id>/review/<run-id>/` 保存 `baseline.json` 与当前 `snapshot.json`；
每个新版本独立保存为 `versions/<payloadId>/snapshot.json` + `payload/`。
冻结发布持文件锁，seq 单调递增；新回合不删除或复用旧副本，已打开的预览仍指向原版本。
失败只清理本次未发布的目录，不能损坏旧快照。旧格式没有 payloadId 时仍读原 `payload/`，不搬走旧证据。
归档目标保留这棵树；容量清理必须另有明确的保留政策，不能以再冻结为由抹掉已接受版本。

另有 `context.json`（2026-09-09，审计 §4.8）：开工一刻**实际下发给 Agent 的上下文全文**
（前端拼装的 Context Pack + 目标行经 `task_prepare_run` 的 `contextText` 传入，sha256 校验，
读取时哈希对不上即拒绝）。开工写失败 = 开工失败，与基线同一 fail-closed 口径。
评审弹层「本次工作环境」折叠区展示；科研流水线侧 TASK.md 落工作区本身就是上下文凭证，
不重复冻结。

容量口径：单文件 > 64 MB 记 `too_large`（进清单、不复制、不可自动采纳）；
冻结总预算 512 MB，遍历上限 20,000 文件；超限明确报错，不写半截快照。

## 硬规则

- **项目写回只有一个临界区**：普通目标、科研合并、编程合并、定时采纳共用 `review_contract::apply_lock`；
  持锁完成检查、写入和接受记录，取锁失败不能无锁继续。它只协调 Mesa，不宣称能锁住外部编辑器。

- **人审的就是写入的**：预览与采纳读同一份 payload 字节；采纳前再校哈希。
- **删除永不自动写回**：`deleted` 只是证据行（前端划线展示、不可勾选），要删由人手动删。
- **mtime 不作数**：`run_artifacts` 的修改时间只用于候选发现，不作产出归属或版本判定依据。
- **冲突不自动合并**：三向判定不通过 = 拒绝 + 人工，不做 three-way merge。
- 新增/修改/删除的展示分组沿用 `goal-review.ts`；保护路径检查在采纳时照旧先跑。

## 接受记录（2026-09-09，审计 §4.5）

- 采纳写文件成功后，先写**长期账本** `.ccode/acceptance-log.jsonl`（append-only，普通目标按
  目标 + Run + 结果版本 + 所选路径集合 + 意见去重；选择顺序不制造重复，新版本/补采纳不得被吞掉）；账本落盘失败 = 采纳返回可见错误引导重试（已写入文件自动跳过），不许静默成功。
- `project-status.json` 降级为账本的「最近摘要」投影（按名替换、留 20 条）；摘要写入失败记
  logbuf + `task.accept_summary_failed` 事件，不再静默吞掉。
- 接受事实记录本次所选文件的完整内容哈希；后续返修只允许覆盖仍等于这些已接受内容的项目文件，
  用户或别的目标后来修改了文件仍拒绝覆盖。旧记录没有内容哈希时不猜测前态。
- 删除即归档，不清 Run/事件/隔离目录/评审证据、摘要或账本：`task_list` 默认不含归档行；目标页「已归档」可恢复。

## 已知未做（后续批次）

- 执行状态 / 结果可审 / 目标完成三分的完整语义（§4.4）：入口侧已解绑（2026-09-09 两轮）。
  第一轮：有冻结证据即可审可采纳，失败/停止 Run 有可审成果时提升待验收。
  第二轮（实机走查驱动）：**交互式 CLI 交付后不退出进程**——回合结束（终端 attention → 已回复）
  即 `task_freeze_turn` 冻结当前成果并提升待验收 + 发 `goal-review-ready` 事件（OS 通知）；
  同一 Run 允许回合间再冻结（`freeze_or_refresh`，seq 递增，每版独立存储），
  采纳按 seq 绑定「人看过的那版」，对不上拒绝并要求重看。未做的剩余部分：Run 状态机
  仍只有 completed/failed/stopped，没有独立的 Result Readiness 字段。
- 接受账本目标页只读展示最近若干条；Context Pack 仍引用摘要/`memory.md`，不把整本账本注入开工文本。
- 项目级知识沉淀最小闭环已做（验收勾选才写 `memory.md`，以结果版本幂等）；无独立 Agent 提议区。

## 性能口径（2026-09-09 实机修正）

基线与冻结判定用 **stat 快路径**（size + mtime 纳秒，与 git stat-dirty 同源）：stat 未变即未变，
不读文件内容。小文件（≤8 MB，「人会编辑的文本」量级）在基线里同时存内容哈希——
「保存未改/撤销编辑」stat 变内容同，不算漂移；大文件（PDF/数据）stat-only，stat 变了保守判冲突。
全量 sha256 曾把 47 个 PDF 的项目开工拖到 14 秒，不得回退到全量哈希。
