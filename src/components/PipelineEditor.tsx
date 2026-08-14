import { useEffect, useMemo, useState } from "react";
import { Checkbox, EmptyState } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import type {
  HumanTaskDto,
  ProjectConfigDto,
  ProjectStepDto,
  ProjectStepRunDto,
} from "../types";

const actionBtn =
  "rounded-sm px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40";
const ctaSm =
  "rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50";
const field =
  "rounded-sm border border-field bg-canvas px-2 py-1 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
function sanitizeWsName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** 人工事项时机选项（值与后端 before/during/after 对应） */
const TIMING_OPTIONS: { value: string; label: string }[] = [
  { value: "before", label: "开始前" },
  { value: "during", label: "进行中" },
  { value: "after", label: "收尾" },
];

/** 编辑器内的步骤草稿：预期产物用逗号分隔文本编辑，保存时再归一化为数组 */
type StepDraft = {
  name: string;
  workspaceName: string;
  brief: string;
  artifactsText: string;
  skills: string[];
  run: ProjectStepRunDto[];
  /** 勾选中的资源绑定（path）；空 = 不绑定 = 使用项目全部资源 */
  resources: string[];
  /** 人工事项编辑态（人机分工清单） */
  humanTasks: HumanTaskDto[];
  /** 讨论种子编辑态：每行一条 */
  discussionSeeds: string[];
};

function toDraft(s: ProjectStepDto): StepDraft {
  return {
    name: s.name,
    workspaceName: s.workspaceName,
    brief: s.brief,
    artifactsText: s.expectedArtifacts.join(", "),
    skills: [...s.skills],
    run: s.run.map((r) => ({ ...r })),
    resources: [...(s.resources ?? [])],
    humanTasks: (s.humanTasks ?? []).map((t) => ({ ...t })),
    discussionSeeds: [...(s.discussionSeeds ?? [])],
  };
}

/** 草稿 → 写回的步骤：名称去空白、工作区名留空时按步骤名派生、产物按中英文逗号切分、run 丢弃缺名称/命令的行、
 *  人工事项丢弃标题空白的行并 trim 各字段 */
function toStep(d: StepDraft, index: number): ProjectStepDto {
  const name = d.name.trim();
  return {
    name,
    workspaceName:
      d.workspaceName.trim() || sanitizeWsName(name) || `step-${index + 1}`,
    brief: d.brief,
    expectedArtifacts: d.artifactsText
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    skills: d.skills,
    run: d.run
      .filter((r) => r.name.trim() && r.command.trim())
      .map((r) => ({ ...r, name: r.name.trim(), command: r.command.trim() })),
    resources: [...d.resources],
    humanTasks: d.humanTasks
      .filter((t) => t.title.trim())
      .map((t) => ({
        title: t.title.trim(),
        guidance: t.guidance.trim(),
        target: t.target.trim(),
        timing: t.timing,
      })),
    discussionSeeds: d.discussionSeeds.map((x) => x.trim()).filter(Boolean),
  };
}

/**
 * 研究流程编辑器（全宽覆盖层）：项目研究流程的唯一编辑入口。
 * 每个步骤一张卡片（名称/工作区名/简报/预期产物/run 脚本/资源绑定），卡片可排序与增删；
 * 「保存」把全部步骤整体写回 project.toml（write_project_config 由父组件执行），「取消」放弃草稿，
 * 有未保存改动时关闭需确认。
 */
export default function PipelineEditor({
  projectName,
  config,
  warnings,
  saving,
  focusStep,
  onSave,
  onClose,
}: {
  projectName: string;
  config: ProjectConfigDto;
  /** read_project_config 的 warnings（含资源绑定校验），原样展示 */
  warnings: string[];
  saving: boolean;
  /** 从步骤 ✎ 进入时定位的步骤序号：滚动到该卡片并聚焦简报输入框 */
  focusStep?: number | null;
  /** 保存成功与关闭覆盖层由父组件负责 */
  onSave: (steps: ProjectStepDto[]) => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<StepDraft[]>(() =>
    config.steps.map(toDraft),
  );
  const [error, setError] = useState<string | null>(null);
  const resources = config.resources;

  // 挂载时定位一次（仅 ✎ 入口带 focusStep；卡片内第一个 textarea 即简报框）
  useEffect(() => {
    if (focusStep == null) return;
    const card = document.querySelector(`[data-step-card="${focusStep}"]`);
    card?.scrollIntoView({ block: "center" });
    card?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始快照按写回口径归一化后序列化，作为脏检查基准（与编辑器保存的结果同构）
  const initialJson = useMemo(
    () => JSON.stringify(config.steps.map((s, i) => toStep(toDraft(s), i))),
    [config.steps],
  );
  const dirty = JSON.stringify(drafts.map(toStep)) !== initialJson;

  function patch(index: number, patchPart: Partial<StepDraft>) {
    setDrafts((list) =>
      list.map((d, i) => (i === index ? { ...d, ...patchPart } : d)),
    );
  }

  function move(index: number, delta: -1 | 1) {
    setDrafts((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function toggleResource(index: number, path: string, checked: boolean) {
    const bound = new Set(drafts[index].resources);
    if (checked) bound.add(path);
    else bound.delete(path);
    patch(index, { resources: [...bound] });
  }

  function patchHumanTask(
    index: number,
    ti: number,
    part: Partial<HumanTaskDto>,
  ) {
    patch(index, {
      humanTasks: drafts[index].humanTasks.map((t, x) =>
        x === ti ? { ...t, ...part } : t,
      ),
    });
  }

  async function tryClose() {
    if (
      dirty &&
      !(await confirmDialog("研究流程有未保存的改动，确定放弃并关闭？", {
        danger: true,
      }))
    )
      return;
    onClose();
  }

  function save() {
    const missing = drafts.findIndex((d) => !d.name.trim());
    if (missing >= 0) {
      setError(`第 ${missing + 1} 步还没有填写步骤名`);
      return;
    }
    setError(null);
    onSave(drafts.map(toStep));
  }

  function renderCard(d: StepDraft, i: number) {
    // 绑定里引用了已移除资源的失效条目：保留展示并可勾选移除，不静默丢弃
    const stale = d.resources.filter(
      (p) => !resources.some((r) => r.path === p),
    );
    return (
      <div
        key={i}
        data-step-card={i}
        className="rounded-md bg-strip p-3"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-l4">#{i + 1}</span>
          <input
            className={`${field} min-w-0 flex-1`}
            value={d.name}
            onChange={(e) => patch(i, { name: e.target.value })}
            placeholder="步骤名，如 文献综述"
          />
          <input
            className={`${field} w-44 shrink-0 font-mono text-xs`}
            value={d.workspaceName}
            onChange={(e) => patch(i, { workspaceName: e.target.value })}
            placeholder={sanitizeWsName(d.name) || `step-${i + 1}`}
            title="绑定工作区名（英文）；留空保存时按步骤名自动派生"
          />
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              className={actionBtn}
              disabled={i === 0}
              title="上移"
              aria-label={`上移步骤：${d.name || i + 1}`}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className={actionBtn}
              disabled={i === drafts.length - 1}
              title="下移"
              aria-label={`下移步骤：${d.name || i + 1}`}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className={actionBtn}
              title="删除该步骤（不影响已创建的工作区；保存后才生效）"
              onClick={() =>
                setDrafts((list) => list.filter((_, x) => x !== i))
              }
            >
              删除
            </button>
          </div>
        </div>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            简报（一键开步时落成工作区 TASK.md）
          </span>
          <textarea
            className={`${field} w-full`}
            rows={10}
            value={d.brief}
            onChange={(e) => patch(i, { brief: e.target.value })}
            placeholder="本步骤的目标、背景与交付物要求"
          />
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            预期产物（逗号分隔，如 notes/, references.bib）
          </span>
          <input
            className={`${field} w-full`}
            value={d.artifactsText}
            onChange={(e) => patch(i, { artifactsText: e.target.value })}
            placeholder="notes/, references.bib"
          />
        </label>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            人工事项（人必须参与的事项清单；标题空白行保存时丢弃）
          </span>
          {d.humanTasks.map((t, ti) => (
            <div key={ti} className="mb-1 rounded-sm bg-inset p-1.5">
              <div className="mb-1 flex items-center gap-1">
                <input
                  className={`${field} min-w-0 flex-1`}
                  value={t.title}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { title: e.target.value })
                  }
                  placeholder="一句话说明，如 下载付费墙文献全文"
                />
                <input
                  className={`${field} w-44 shrink-0 font-mono text-xs`}
                  value={t.target}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { target: e.target.value })
                  }
                  placeholder="落点，如 papers/ 或 papers/*.pdf"
                  title="交付落点：目录（结尾 /）、精确文件或「目录/通配」；留空 = 纯脑力事项"
                />
                <select
                  className={`${field} w-24 shrink-0`}
                  value={t.timing}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { timing: e.target.value })
                  }
                  title="时机：开始前 / 进行中 / 收尾"
                >
                  {/* 旧配置里出现未知 timing 值时保留原值可选，不静默改写 */}
                  {!TIMING_OPTIONS.some((o) => o.value === t.timing) && (
                    <option value={t.timing}>{t.timing}</option>
                  )}
                  {TIMING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`${actionBtn} shrink-0`}
                  aria-label={`删除人工事项：${t.title || ti + 1}`}
                  onClick={() =>
                    patch(i, {
                      humanTasks: d.humanTasks.filter((_, x) => x !== ti),
                    })
                  }
                >
                  删除
                </button>
              </div>
              <textarea
                className={`${field} w-full text-xs`}
                rows={1}
                value={t.guidance}
                onChange={(e) =>
                  patchHumanTask(i, ti, { guidance: e.target.value })
                }
                placeholder="引导说明（可选）：渠道选项等，只告知不推荐"
              />
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, {
                humanTasks: [
                  ...d.humanTasks,
                  { title: "", guidance: "", target: "", timing: "before" },
                ],
              })
            }
          >
            + 添加人工事项
          </button>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            讨论种子（开工前建议先和 Agent 聊清楚的问题，会在任务卡区列出、点击即聊）
          </span>
          {d.discussionSeeds.map((s, si) => (
            <div key={si} className="mb-1 flex items-center gap-1">
              <input
                className={`${field} min-w-0 flex-1`}
                value={s}
                onChange={(e) =>
                  patch(i, {
                    discussionSeeds: d.discussionSeeds.map((x, xi) =>
                      xi === si ? e.target.value : x,
                    ),
                  })
                }
                placeholder="如 纳入排除标准定多严：只要 RCT 还是观察性研究也要？"
              />
              <button
                type="button"
                className={`${actionBtn} shrink-0`}
                aria-label={`删除讨论种子：${s || si + 1}`}
                onClick={() =>
                  patch(i, {
                    discussionSeeds: d.discussionSeeds.filter(
                      (_, x) => x !== si,
                    ),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, { discussionSeeds: [...d.discussionSeeds, ""] })
            }
          >
            + 添加讨论种子
          </button>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            run 脚本（开步时写入项目 .ccode/settings.toml，可在工作区「运行脚本」菜单执行）
          </span>
          {d.run.map((r, ri) => (
            <div key={ri} className="mb-1 flex items-center gap-1">
              <input
                className={`${field} w-40 shrink-0 text-xs`}
                value={r.name}
                onChange={(e) =>
                  patch(i, {
                    run: d.run.map((x, xi) =>
                      xi === ri ? { ...x, name: e.target.value } : x,
                    ),
                  })
                }
                placeholder="名称，如 render-draft"
              />
              <input
                className={`${field} min-w-0 flex-1 font-mono text-xs`}
                value={r.command}
                onChange={(e) =>
                  patch(i, {
                    run: d.run.map((x, xi) =>
                      xi === ri ? { ...x, command: e.target.value } : x,
                    ),
                  })
                }
                placeholder="命令，如 quarto render manuscript/draft.md --to pdf"
              />
              <button
                type="button"
                className={`${actionBtn} shrink-0`}
                aria-label={`删除脚本：${r.name || ri + 1}`}
                onClick={() =>
                  patch(i, { run: d.run.filter((_, xi) => xi !== ri) })
                }
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, {
                run: [...d.run, { name: "", command: "", default: false }],
              })
            }
          >
            + 添加脚本
          </button>
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs text-l3">资源绑定</span>
            <span className="text-xs text-l4">
              {d.resources.length === 0
                ? `不绑定 = 本步骤使用项目全部资源（${resources.length} 项）`
                : `已绑定 ${d.resources.length} 项；全部取消勾选即恢复为使用全部资源`}
            </span>
          </div>
          {resources.length === 0 && stale.length === 0 ? (
            <p className="text-xs text-l4">
              项目还没有登记资源，可在项目「资源」面板扫描登记。
            </p>
          ) : (
            <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {resources.map((r) => (
                <li key={r.path} className="min-w-0">
                  <Checkbox
                    checked={d.resources.includes(r.path)}
                    onChange={(checked) => toggleResource(i, r.path, checked)}
                    label={
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-l3">
                          {RESOURCE_TYPE_LABELS[r.type] ?? "其他"}
                        </span>
                        <span className="min-w-0 truncate text-l2" title={r.name}>
                          {r.name}
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-l4"
                          title={r.path}
                        >
                          {r.path}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
              {stale.map((p) => (
                <li key={p} className="min-w-0">
                  <Checkbox
                    checked
                    onChange={(checked) => toggleResource(i, p, checked)}
                    label={
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-warn-text">
                          失效
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-l4"
                          title="该资源已从项目资源清单移除，取消勾选可清理绑定"
                        >
                          {p}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-canvas">
      {/* 覆盖层头部统一（P3）：strip 底 + hairline 下缘，标题 + 副题 + 唯一主动作（保存） */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline bg-strip px-8 py-3">
        <h2 className="shrink-0 text-base font-semibold text-l1">
          编辑研究流程
        </h2>
        <span className="min-w-0 truncate text-xs text-l3">
          {projectName} · {drafts.length} 个步骤
        </span>
        {error && <span className="shrink-0 text-xs text-err-text">{error}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
            onClick={tryClose}
          >
            取消
          </button>
          <button
            type="button"
            className={ctaSm}
            disabled={saving}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-8 py-4">
          {warnings.length > 0 && (
            <div className="rounded-sm bg-strip p-2 text-xs">
              <p className="mb-1 text-warn-text">
                ⚠ project.toml 有 {warnings.length} 条提示
              </p>
              <ul className="space-y-0.5 text-l3">
                {warnings.map((w) => (
                  <li key={w}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
          {drafts.length === 0 && (
            <EmptyState
              title="还没有研究步骤"
              detail="点击下方「+ 添加步骤」逐张卡片填写（名称、简报、预期产物与资源绑定），保存后写入 .ccode/project.toml。"
            />
          )}
          {drafts.map(renderCard)}
          <button
            type="button"
            className="w-full rounded-md bg-strip p-3 text-sm text-l3 hover:bg-inset hover:text-l1"
            onClick={() =>
              setDrafts((list) => [
                ...list,
                {
                  name: "",
                  workspaceName: "",
                  brief: "",
                  artifactsText: "",
                  skills: [],
                  run: [],
                  resources: [],
                  humanTasks: [],
                  discussionSeeds: [],
                },
              ])
            }
          >
            + 添加步骤
          </button>
          <div className="flex justify-end gap-2 pb-4">
            <button
              type="button"
              className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              onClick={tryClose}
            >
              取消
            </button>
            <button
              type="button"
              className={ctaSm}
              disabled={saving}
              onClick={save}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
