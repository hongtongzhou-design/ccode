import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, EmptyState } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import StepSkillsChips from "./StepSkillsChips";
import { PIPELINE_TEMPLATES, RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import type {
  AppendStepsResultDto,
  HumanTaskDto,
  PipelineTemplateDto,
  ProjectConfigDto,
  ProjectConfigReadDto,
  ProjectStepDto,
  ProjectStepRunDto,
  SkillDto,
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
  /** 决策项编辑态：options 用逗号分隔的文本（同 artifactsText 口径） */
  decisions: { q: string; optionsText: string }[];
  /** 这一步要先拍板文献从哪来（流程线「定方向」出现输入准备块） */
  asksLitSource: boolean;
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
    decisions: (s.decisions ?? []).map((d) => ({
      q: d.q,
      optionsText: d.options.join(", "),
    })),
    asksLitSource: s.asksLitSource ?? false,
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
        // optional 必须透传：内置模板用它标「不做也能跑」的事项，漏掉会让编辑器一保存
        // 就把这些事项静默升级为必办（v3.85 修）
        optional: t.optional ?? false,
      })),
    discussionSeeds: d.discussionSeeds.map((x) => x.trim()).filter(Boolean),
    // 与后端解析同一口径：问题与选项都非空才留（没有选项的题该写成讨论种子）
    decisions: d.decisions
      .map((x) => ({
        q: x.q.trim(),
        options: x.optionsText
          .split(/[,，]/)
          .map((o) => o.trim())
          .filter(Boolean),
      }))
      .filter((x) => x.q && x.options.length > 0),
    asksLitSource: d.asksLitSource,
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
  projectPath,
  config,
  warnings,
  saving,
  focusStep,
  onSave,
  onClose,
  onConfigReload,
}: {
  projectName: string;
  /** 项目根路径：「从模板追加」直接写 project.toml 用 */
  projectPath: string;
  config: ProjectConfigDto;
  /** read_project_config 的 warnings（含资源绑定校验），原样展示 */
  warnings: string[];
  saving: boolean;
  /** 从步骤 ✎ 进入时定位的步骤序号：滚动到该卡片并聚焦简报输入框 */
  focusStep?: number | null;
  /** 保存成功与关闭覆盖层由父组件负责 */
  onSave: (steps: ProjectStepDto[]) => void;
  onClose: () => void;
  /** 从模板追加成功后回推重读的配置（父组件同步 cfg/warnings，保持脏检查基准一致） */
  onConfigReload: (read: ProjectConfigReadDto) => void;
}) {
  const [drafts, setDrafts] = useState<StepDraft[]>(() =>
    config.steps.map(toDraft),
  );
  const [error, setError] = useState<string | null>(null);
  // 「从模板追加」：内联模板列表 + 追加结果行内提示
  const [appendOpen, setAppendOpen] = useState(false);
  const [appending, setAppending] = useState(false);
  const [appendResult, setAppendResult] = useState<AppendStepsResultDto | null>(
    null,
  );
  const [userTemplates, setUserTemplates] = useState<PipelineTemplateDto[]>([]);
  const resources = config.resources;
  // 技能库（推荐技能 chip 的展示元数据与「＋ 添加技能」候选）：挂载时读一次，失败降级为不可编辑 chip
  const [skillLib, setSkillLib] = useState<SkillDto[] | null>(null);
  const skillMeta = useMemo(
    () =>
      skillLib
        ? Object.fromEntries(skillLib.map((s) => [s.name, s.description]))
        : undefined,
    [skillLib],
  );
  // 折叠区展开态：键为 `${卡片序号}:${区块}`，一律默认收起，这里只记用户的显式覆盖。
  // 序号在排序/删除后会错位，但折叠态是纯瞬时视图状态，不影响数据。
  const [folds, setFolds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((lib) => {
        if (!stale) setSkillLib(lib);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  // 展开模板列表时拉一次用户另存模板；后端未就绪（旧版本）降级为仅内置模板
  useEffect(() => {
    if (!appendOpen) return;
    let stale = false;
    invoke<PipelineTemplateDto[]>("list_pipeline_templates")
      .then((list) => {
        if (!stale) setUserTemplates(list);
      })
      .catch(() => {
        if (!stale) setUserTemplates([]);
      });
    return () => {
      stale = true;
    };
  }, [appendOpen]);

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

  /** 从模板追加：步骤直接写入 project.toml（后端跳过重名步骤），成功后重读配置刷新卡片 */
  async function appendTemplate(tpl: { name: string; steps: ProjectStepDto[] }) {
    if (appending) return;
    if (
      dirty &&
      !(await confirmDialog(
        "当前有未保存的改动，追加模板后会按最新 project.toml 刷新步骤列表，未保存改动将丢失。继续？",
        { danger: true },
      ))
    )
      return;
    setAppending(true);
    setAppendResult(null);
    setError(null);
    try {
      const res = await invoke<AppendStepsResultDto>("append_pipeline_steps", {
        projectRoot: projectPath,
        steps: tpl.steps,
      });
      // 刷新编辑器步骤列表：与保存后同一口径重读配置，本地草稿与父组件状态一起更新
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      setDrafts(read.config.steps.map(toDraft));
      onConfigReload(read);
      setAppendResult(res);
      setAppendOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setAppending(false);
    }
  }

  /**
   * 步骤卡的折叠区（v3.85 字段分档）：常驻只留「步骤名 / 简报 / 预期产物 / 推荐技能」——
   * 这四项决定 TASK.md 的全部内容，是步骤的合同本体；其余按「人机分工」与「高级」两档收起。
   * 字段一个没删（模板要用、向后兼容），只是默认不占视线：一屏从放不下一张卡变成放得下三张。
   *
   * **一律默认收起**：曾按「已填就展开」处理，结果模板步骤个个都填了 workspace_name 与
   * human_tasks，两档在每张卡上全是展开的，等于没折叠。workspace_name 是保存时自动派生的
   * 机械字段、human_tasks 是模板带的内容，都不算「用户自己配过的东西」；
   * 标题上的明细计数已经足够告诉人里面有什么，不需要靠默认展开来保证可发现性。
   */
  function fold(
    index: number,
    id: string,
    title: string,
    parts: { label: string; n: number }[],
    note: string,
    body: ReactNode,
  ) {
    const key = `${index}:${id}`;
    const filled = parts.filter((p) => p.n > 0);
    const open = folds[key] ?? false;
    return (
      <div className="mb-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setFolds((m) => ({ ...m, [key]: !open }))}
          className="flex w-full items-center gap-1.5 rounded-sm py-1 text-left text-xs text-l3 hover:text-l1"
        >
          <span className="w-3 text-l4">{open ? "▾" : "▸"}</span>
          {title}
          <span className="min-w-0 truncate text-micro text-l4">
            {filled.length
              ? filled
                  .map((p) => (p.n > 1 ? `${p.label} ${p.n}` : p.label))
                  .join(" · ")
              : "未设置"}
          </span>
        </button>
        {open && (
          <div className="pl-4">
            {/* 「这些改了会不会显示在流程里」是编辑时最常问的一句，直接写在区首 */}
            <p className="mb-1.5 text-micro leading-4 text-l4">{note}</p>
            {body}
          </div>
        )}
      </div>
    );
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
          {/* 工作区名移进「高级」：99% 的步骤用派生值，不该常年占一格。
              这里只回显最终会用的名字，不展开也能确认 */}
          <span
            className="shrink-0 truncate font-mono text-micro text-l4"
            title="绑定的工作区名（在「高级」里可改）"
          >
            {d.workspaceName.trim() ||
              sanitizeWsName(d.name) ||
              `step-${i + 1}`}
          </span>
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

        {/* 推荐技能：常驻第 4 项。与另外三项一起构成 TASK.md 的全部内容，是「合同」本体。
            这里改的是草稿，随整份 steps 一起保存（不走 update_step_skills 的单步写回）。 */}
        <div className="mb-2">
          <StepSkillsChips
            skills={d.skills}
            skillMeta={skillMeta}
            available={skillLib?.map((s) => s.name)}
            mcpRecommended={skillLib
              ?.filter((s) => s.mentionsMcp)
              .map((s) => s.name)}
            skillLib={skillLib}
            onChange={(next) => patch(i, { skills: next })}
          />
        </div>

        {fold(
          i,
          "human",
          "人机分工",
          [
            { label: "人工事项", n: d.humanTasks.length },
            { label: "决策项", n: d.decisions.length },
            { label: "讨论种子", n: d.discussionSeeds.length },
          ],
          "这三项都会显示在流程线上。",
          <>
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
              <div className="flex items-center gap-2">
                <textarea
                  className={`${field} min-w-0 flex-1 text-xs`}
                  rows={1}
                  value={t.guidance}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { guidance: e.target.value })
                  }
                  placeholder="引导说明（可选）：渠道选项等，只告知不推荐"
                />
                {/* 「可选」以前只能由模板写、界面上没有开关，编辑器一保存还会把它抹掉（v3.85 补） */}
                <span className="shrink-0">
                  <Checkbox
                    checked={t.optional ?? false}
                    onChange={(checked) =>
                      patchHumanTask(i, ti, { optional: checked })
                    }
                    label={
                      <span
                        className="text-micro text-l3"
                        title="可选事项：不做也不影响这一步跑完，流程线上标「可选」且不计入待办数"
                      >
                        可选
                      </span>
                    }
                  />
                </span>
              </div>
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, {
                humanTasks: [
                  ...d.humanTasks,
                  {
                    title: "",
                    guidance: "",
                    target: "",
                    timing: "before",
                    optional: false,
                  },
                ],
              })
            }
          >
            + 添加人工事项
          </button>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            决策项（答案可枚举的拍板点，在流程线上点选即答、不用开会话；第一个选项即推荐值）
          </span>
          {d.decisions.map((dec, di) => (
            <div key={di} className="mb-1 flex items-center gap-1">
              <input
                className={`${field} min-w-0 flex-1`}
                value={dec.q}
                onChange={(e) =>
                  patch(i, {
                    decisions: d.decisions.map((x, xi) =>
                      xi === di ? { ...x, q: e.target.value } : x,
                    ),
                  })
                }
                placeholder="问题，如 纳入标准定多严"
              />
              <input
                className={`${field} min-w-0 flex-[2]`}
                value={dec.optionsText}
                onChange={(e) =>
                  patch(i, {
                    decisions: d.decisions.map((x, xi) =>
                      xi === di ? { ...x, optionsText: e.target.value } : x,
                    ),
                  })
                }
                placeholder="选项，逗号分隔，如 只要高质量期刊/顶会, 含观察性研究与预印本"
              />
              <button
                type="button"
                className={`${actionBtn} shrink-0`}
                aria-label={`删除决策项：${dec.q || di + 1}`}
                onClick={() =>
                  patch(i, {
                    decisions: d.decisions.filter((_, x) => x !== di),
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
              patch(i, {
                decisions: [...d.decisions, { q: "", optionsText: "" }],
              })
            }
          >
            + 添加决策项
          </button>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            讨论种子（答案不可枚举、需要来回聊的开放问题；点击即开会话）
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
          </>,
        )}

        {fold(
          i,
          "adv",
          "高级",
          [
            // 只把「和派生值不同」算作自定义——模板步骤的 workspace_name 恒等于派生值，
            // 一律算已填会让这一档在每张卡上都显示有内容
            {
              label: "自定义工作区名",
              n:
                d.workspaceName.trim() &&
                d.workspaceName.trim() !== sanitizeWsName(d.name)
                  ? 1
                  : 0,
            },
            { label: "run 脚本", n: d.run.length },
            { label: "资源绑定", n: d.resources.length },
            { label: "先问文献来源", n: d.asksLitSource ? 1 : 0 },
          ],
          "这些不显示在流程线上，幕后生效。",
          <>
        <div className="mb-2">
          <Checkbox
            checked={d.asksLitSource}
            onChange={(checked) => patch(i, { asksLitSource: checked })}
            label={
              <span
                className="text-xs text-l2"
                title="流程线「定方向」里会出现文献来源选择与导入入口；答案写进项目配置，与只写草稿的决策项不是一类"
              >
                这一步先问「文献从哪来」
              </span>
            }
          />
        </div>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            工作区名（英文；留空按步骤名自动派生）
          </span>
          <input
            className={`${field} w-full font-mono text-xs`}
            value={d.workspaceName}
            onChange={(e) => patch(i, { workspaceName: e.target.value })}
            placeholder={sanitizeWsName(d.name) || `step-${i + 1}`}
            title="绑定工作区名（英文）；留空保存时按步骤名自动派生"
          />
        </label>

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
          </>,
        )}
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
              detail="点下方「+ 添加步骤」逐张填写，保存即写入项目。"
            />
          )}
          {drafts.map(renderCard)}
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-md bg-strip p-3 text-sm text-l3 hover:bg-inset hover:text-l1"
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
                    decisions: [],
                    asksLitSource: false,
                  },
                ])
              }
            >
              + 添加步骤
            </button>
            <button
              type="button"
              className="flex-1 rounded-md bg-strip p-3 text-sm text-l3 hover:bg-inset hover:text-l1 disabled:opacity-40"
              disabled={appending}
              title="把模板的步骤追加到当前流程末尾；同名/同工作区名的步骤自动跳过"
              onClick={() => setAppendOpen((v) => !v)}
            >
              ＋ 从模板追加
            </button>
          </div>
          {appendResult && (
            <p className="text-xs">
              <span className="text-ok-text">
                已追加 {appendResult.appended} 步
              </span>
              {appendResult.skipped.length > 0 && (
                <span className="text-warn-text">
                  {"；跳过 "}
                  {appendResult.skipped.length}
                  {" 步（同名）："}
                  {appendResult.skipped.join("、")}
                </span>
              )}
            </p>
          )}
          {appendOpen && (
            <div className="rounded-md bg-strip p-3">
              <p className="mb-2 text-xs text-l3">
                选择模板，把它的步骤追加到当前流程末尾（与现有步骤同名/同工作区名的自动跳过）：
              </p>
              <ul className="space-y-1.5">
                {PIPELINE_TEMPLATES.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="w-full rounded-sm bg-inset p-2 text-left hover:bg-hover disabled:opacity-40"
                      disabled={appending}
                      onClick={() => void appendTemplate(t)}
                    >
                      <span className="text-xs font-medium text-l1">
                        {t.name}
                      </span>
                      <span className="ml-2 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
                        {t.steps.length} 步
                      </span>
                      <span className="mt-1 block truncate text-xs text-l4">
                        {t.steps.map((s) => s.name).join(" → ")}
                      </span>
                    </button>
                  </li>
                ))}
                {userTemplates.length > 0 && (
                  <li className="pt-1 text-xs text-l3">我的模板</li>
                )}
                {userTemplates.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="w-full rounded-sm bg-inset p-2 text-left hover:bg-hover disabled:opacity-40"
                      disabled={appending}
                      onClick={() => void appendTemplate(t)}
                    >
                      <span className="text-xs font-medium text-l1">
                        {t.name}
                      </span>
                      <span className="ml-2 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
                        {t.steps.length} 步
                      </span>
                      <span className="mt-1 block truncate text-xs text-l4">
                        {t.steps.map((s) => s.name).join(" → ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {appending && (
                <p className="mt-2 text-xs text-l3">追加中…</p>
              )}
            </div>
          )}
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
