import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, LoadingRows } from "./PageFrame";
import StepSkillsChips from "./StepSkillsChips";
import HumanTasksList from "./HumanTasksList";
import { useAppStore } from "../store";
import { relTime } from "../rel-time";
import {
  blockingHumanTasks,
  briefSourcesForStep,
  checkedBriefRefs,
  defaultCheckedSources,
  taskMdEditorReduce,
  type TaskMdEditorState,
} from "../task-cards";
import {
  gatherTaskMdExtras,
  readTaskBriefs,
  renderTaskMd,
  type TaskBriefRef,
} from "../pipeline-start";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import type {
  ArtifactEntryDto,
  DiscoveredResourceDto,
  HumanTaskStateDto,
  ProjectConfigDto,
  ProjectStepDto,
  SkillDto,
} from "../types";

/** git_status 返回（本组件只看是否仓库与未提交改动数） */
interface GitStatusBrief {
  isRepo: boolean;
  files: unknown[];
}

/**
 * 开工确认弹层（v3.64；v3.66 预览区升级为可编辑 + 连贯融合）：「开工」= 点开工 → 本弹层 → 确认开工。
 * 三件事统一在这里承载：
 * 1. TASK.md 编辑区（所见即所得：默认拼装与实际落盘走同一个 renderTaskMd/gatherTaskMdExtras；
 *    人可直接改，「◈ 融合为连贯 TASK.md」把模板简报与所选卡片简报融合成连贯文档填入，
 *    确认开工落盘 = 编辑区最终内容）；
 * 2. 多卡简报来源勾选：本步骤 + 未挂步骤的含简报卡片（默认勾出处卡/唯一卡）；
 *    ≥2 张可「◈ 融合所选简报」→ 定稿钉卡（save_task_brief）；
 * 3. 主仓改动协同：主仓有未提交改动时顶部提醒（不阻断）。
 * 「继续」动作不经本弹层；评审「开始下一步」保留直开（连续流，简报已沉淀到下一步卡）。
 */
export default function KickoffConfirmDialog({
  projectPath,
  step,
  cfg,
  originCardId,
  busy,
  onCancel,
  onConfirm,
  onCfgChange,
}: {
  projectPath: string;
  step: ProjectStepDto;
  cfg: ProjectConfigDto;
  /** 从哪张卡点的开工（步进器大圆开工为 null） */
  originCardId: string | null;
  /** 确认开工后的链路进行中（父组件自持 starting） */
  busy: boolean;
  onCancel: () => void;
  /** 确认开工：briefs = 勾选（或融合定稿）的简报引用；taskMd = 编辑区最终内容（覆盖默认拼装落盘） */
  onConfirm: (briefs: TaskBriefRef[], taskMd: string) => void;
  /** 技能区增删写回 project.toml 后同步父级 cfg（保持步进器/下次打开一致） */
  onCfgChange?: (cfg: ProjectConfigDto) => void;
}) {
  const cards = useAppStore((s) => s.taskCards[projectPath]);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const createCard = useAppStore((s) => s.createCard);

  // 档案卡本地副本：技能区增删写回 project.toml 后重读替换（步骤其余字段以后端回读为准）
  const [cfgLocal, setCfgLocal] = useState(cfg);
  // 技能库（名称 + 一句话描述）：技能区展示与「＋ 添加技能」候选的数据源，打开时读一次
  const [skillLib, setSkillLib] = useState<SkillDto[] | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  // 当前步骤（技能区写回后 cfgLocal 里的最新版本，prop 可能是旧的）
  const stepNow =
    cfgLocal.steps.find((s) => s.name === step.name) ?? step;
  const skillMeta = useMemo(
    () =>
      skillLib
        ? Object.fromEntries(skillLib.map((s) => [s.name, s.description]))
        : undefined,
    [skillLib],
  );

  // 简报来源与勾选：本步骤 + 未挂步骤（含步骤改名失效）的含简报卡片
  const stepNames = useMemo(() => cfg.steps.map((s) => s.name), [cfg.steps]);
  const sources = useMemo(
    () => briefSourcesForStep(cards ?? [], step.name, stepNames),
    [cards, step.name, stepNames],
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const checkedInitRef = useRef(false);
  // 简报全文缓存（卡片 id → 文本）；预览与融合共用
  const [briefTexts, setBriefTexts] = useState<Record<string, string>>({});
  // TASK.md 提货单/技能元数据（打开时读一次，勾选切换不重取）
  const [extras, setExtras] = useState<{
    artifacts: ArtifactEntryDto[];
    skillMeta: Record<string, string> | undefined;
  } | null>(null);
  // 主仓未提交改动数（null = 非 git 仓库/读取失败，不渲染提醒行）
  const [mainDirty, setMainDirty] = useState<number | null>(null);
  // 简报融合流程（融合所选简报 → 钉卡）：draft 非空 = 定稿态；saved = 已定稿钉卡
  const [fusing, setFusing] = useState(false);
  const [fuseError, setFuseError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [fuseTarget, setFuseTarget] = useState<string>("");
  const [savingFuse, setSavingFuse] = useState(false);
  const [savedFuse, setSavedFuse] = useState<{
    rel: string;
    cardName: string;
  } | null>(null);
  // 连贯 TASK.md 融合（④）：结果直接填进编辑区
  const [fusingTaskMd, setFusingTaskMd] = useState(false);
  const [fuseTaskMdError, setFuseTaskMdError] = useState<string | null>(null);
  // 人工事项状态（HumanTasksList 回传）：开工前（before）未完成的提醒用
  const [humanStates, setHumanStates] = useState<HumanTaskStateDto[] | null>(
    null,
  );
  // 未登记资源提醒（打开时只读扫描一次）：有候选才渲染，默认不勾选不打扰，登记后小节消失
  const [resCandidates, setResCandidates] = useState<
    DiscoveredResourceDto[] | null
  >(null);
  const [resChecked, setResChecked] = useState<Set<string>>(new Set());
  const [resSaving, setResSaving] = useState(false);
  const [resError, setResError] = useState<string | null>(null);

  // 任务书草稿（v3.72）：草稿存在时编辑区初始内容 = 草稿全文（优先于模板拼装）；
  // undefined = 尚未加载（等草稿到达再初始化编辑区，避免先显示拼装再被草稿闪换）
  const [draftText, setDraftText] = useState<string | null | undefined>(
    undefined,
  );
  const [draftRel, setDraftRel] = useState<string | null>(null);

  // TASK.md 编辑区：默认拼装内容 + 人编辑/AI 融合覆盖（状态机在 task-cards.ts，纯逻辑可测）
  const [editor, dispatchEditor] = useReducer(
    taskMdEditorReduce,
    { text: "", dirty: false } satisfies TaskMdEditorState,
  );
  const [editorReady, setEditorReady] = useState(false);

  // 打开时一次性加载：卡片（兜底）+ 提货单/技能元数据 + 各来源简报全文 + 主仓状态；不轮询
  useEffect(() => {
    let stale = false;
    if (!cards) loadTaskCards(projectPath).catch(() => {});
    gatherTaskMdExtras(projectPath, step).then((value) => {
      if (!stale) setExtras(value);
    });
    invoke<GitStatusBrief>("git_status", { cwd: projectPath })
      .then((status) => {
        if (!stale) setMainDirty(status.isRepo ? status.files.length : null);
      })
      .catch(() => {});
    invoke<SkillDto[]>("list_skills")
      .then((lib) => {
        if (!stale) setSkillLib(lib);
      })
      .catch(() => {});
    invoke<DiscoveredResourceDto[]>("discover_resources", { path: projectPath })
      .then((items) => {
        if (!stale) setResCandidates(items.filter((d) => !d.exists));
      })
      .catch(() => {});
    invoke<{ relPath: string; text: string | null }>("read_task_draft", {
      projectRoot: projectPath,
      stepName: step.name,
    })
      .then((d) => {
        if (stale) return;
        setDraftRel(d.relPath);
        setDraftText(d.text);
      })
      .catch(() => {
        if (!stale) setDraftText(null);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // 来源就绪后：初始化默认勾选 + 读各简报全文（只做一次，后续卡片刷新不重置用户勾选）
  useEffect(() => {
    if (sources.length === 0) return;
    if (!checkedInitRef.current) {
      checkedInitRef.current = true;
      setChecked(defaultCheckedSources(sources, originCardId));
      // 出处卡无简报（不在来源里）时，融合目标回落第一张来源卡
      const originInSources = sources.some((s) => s.card.id === originCardId);
      setFuseTarget(originInSources ? originCardId! : sources[0].card.id);
    }
    let stale = false;
    const missing = sources.filter((s) => !(s.card.id in briefTexts));
    if (missing.length === 0) return;
    void (async () => {
      const loaded = await readTaskBriefs(
        projectPath,
        missing.map((s) => ({ path: s.brief, cardName: s.card.name })),
      );
      if (stale) return;
      // 按卡片名对回（读取失败的简报会被跳过，不能按下标对齐）
      const byName = new Map(loaded.map((b) => [b.cardName, b.text]));
      setBriefTexts((current) => {
        const next = { ...current };
        for (const s of missing) {
          const text = byName.get(s.card.name);
          if (text !== undefined) next[s.card.id] = text;
        }
        return next;
      });
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, originCardId, projectPath]);

  function toggle(id: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 进 TASK.md 的简报：已定稿融合 = 融合简报一份；否则 = 勾选来源的多份全文 */
  const activeBriefRefs: TaskBriefRef[] = savedFuse
    ? [{ path: savedFuse.rel, cardName: savedFuse.cardName }]
    : checkedBriefRefs(sources, checked);

  // 默认拼装（与实际落盘同一 renderTaskMd，单一出处）：extras/勾选/简报文本就绪即重拼。
  // 编辑区 dirty（人改过或已填融合稿）时 assemble 事件被状态机忽略，不覆盖用户内容
  const assembled = useMemo(() => {
    if (!extras) return null;
    if (savedFuse) {
      // 融合简报文本本地已有（定稿时写的就是它），直接用避免再读盘
      const text = briefTexts["__fused__"] ?? "";
      return renderTaskMd(stepNow, cfgLocal, projectPath, extras.artifacts, skillMeta ?? extras.skillMeta, [
        { cardName: savedFuse.cardName, text },
      ]);
    }
    const briefInputs = sources
      .filter((s) => checked.has(s.card.id))
      .map((s) => ({
        cardName: s.card.name,
        text: briefTexts[s.card.id] ?? "（简报读取中…）",
      }));
    return renderTaskMd(stepNow, cfgLocal, projectPath, extras.artifacts, skillMeta ?? extras.skillMeta, briefInputs);
  }, [extras, savedFuse, sources, checked, briefTexts, stepNow, cfgLocal, skillMeta, projectPath]);

  // 编辑区初始化：草稿存在（非空）时草稿优先于模板拼装——草稿是讨论的直接产物，
  // 所见即所得；「恢复默认拼装」仍可回到模板拼装。等草稿加载完再初始化，避免闪换
  useEffect(() => {
    if (assembled === null || draftText === undefined) return;
    const draft = draftText?.trim() ? draftText.trim() : null;
    dispatchEditor({ type: "assemble", text: draft ?? assembled });
    setEditorReady(true);
  }, [assembled, draftText]);

  /** 「◈ 融合所选简报」：多份简报 AI 融合成一份初稿 → 弹层内定稿钉卡；失败行内报错可重试 */
  async function fuseSelected() {
    const refs = checkedBriefRefs(sources, checked);
    if (refs.length < 2 || fusing) return;
    setFusing(true);
    setFuseError(null);
    try {
      const text = await invoke<string>("ai_fuse_briefs", {
        projectRoot: projectPath,
        briefPaths: refs.map((r) => r.path),
      });
      setDraft(text.trim());
    } catch (reason) {
      setFuseError(`${reason}（检查设置页「AI 专用配置」是否可用）`);
    } finally {
      setFusing(false);
    }
  }

  /** 融合定稿：save_task_brief 钉到目标卡（可换卡或新建），TASK.md 改用融合简报 */
  async function finalizeFuse() {
    if (draft === null || !draft.trim() || savingFuse) return;
    setSavingFuse(true);
    setFuseError(null);
    try {
      let cardId = fuseTarget;
      let cardName = sources.find((s) => s.card.id === fuseTarget)?.card.name;
      if (fuseTarget === "__new__" || !cardName) {
        // 新建卡：以步骤名为名，撞名退「步骤名（融合）」
        const existing = new Set((cards ?? []).map((c) => c.name));
        const name = existing.has(step.name) ? `${step.name}（融合）` : step.name;
        const created = await createCard(projectPath, name, step.name);
        cardId = created.id;
        cardName = created.name;
      }
      const rel = await invoke<string>("save_task_brief", {
        projectRoot: projectPath,
        taskId: cardId,
        content: draft,
      });
      setBriefTexts((current) => ({ ...current, __fused__: draft }));
      setSavedFuse({ rel, cardName });
      setDraft(null);
      void loadTaskCards(projectPath).catch(() => {});
    } catch (reason) {
      setFuseError(String(reason));
    } finally {
      setSavingFuse(false);
    }
  }

  /** 技能区增删（v3.67）：写回 project.toml steps[].skills（持久配置，影响以后所有开工），
   *  成功后重读档案卡同步本地与父级，预览经 renderTaskMd 即时联动 */
  async function onSkillsChange(next: string[]) {
    setSkillError(null);
    try {
      await invoke("update_step_skills", {
        projectRoot: projectPath,
        stepName: step.name,
        skills: next,
      });
      const read = await invoke<{ config: ProjectConfigDto }>(
        "read_project_config",
        { path: projectPath },
      );
      setCfgLocal(read.config);
      onCfgChange?.(read.config);
    } catch (reason) {
      setSkillError(String(reason));
    }
  }

  /** 「登记选中」未登记资源：resources 数组整体写回 project.toml（与资源面板同一口径），
   *  成功后重读档案卡同步本地与父级，小节消失 */
  async function registerResources() {
    if (!resCandidates || resChecked.size === 0 || resSaving) return;
    setResSaving(true);
    setResError(null);
    try {
      const additions = resCandidates
        .filter((d) => resChecked.has(d.path))
        .map((d) => ({
          name: d.path.split("/").pop() ?? d.path,
          path: d.path,
          type: d.type,
          readonly: false,
          note: "",
        }));
      await invoke("write_project_config", {
        path: projectPath,
        config: {
          ...cfgLocal,
          resources: [...cfgLocal.resources, ...additions],
        },
      });
      const read = await invoke<{ config: ProjectConfigDto }>(
        "read_project_config",
        { path: projectPath },
      );
      setCfgLocal(read.config);
      onCfgChange?.(read.config);
      setResCandidates(null);
    } catch (reason) {
      setResError(String(reason));
    } finally {
      setResSaving(false);
    }
  }

  /** 「◈ 融合为连贯 TASK.md」（④）：模板简报为主干 + 所选简报融入，结果填进编辑区（可再改） */
  async function fuseTaskMd() {
    const refs = checkedBriefRefs(sources, checked);
    if (refs.length === 0 || fusingTaskMd) return;
    setFusingTaskMd(true);
    setFuseTaskMdError(null);
    try {
      const text = await invoke<string>("ai_fuse_task_md", {
        projectRoot: projectPath,
        stepName: step.name,
        briefPaths: refs.map((r) => r.path),
      });
      dispatchEditor({ type: "fused", text: text.trim() });
    } catch (reason) {
      setFuseTaskMdError(`${reason}（检查设置页「AI 专用配置」是否可用）`);
    } finally {
      setFusingTaskMd(false);
    }
  }

  const fusable = checked.size >= 2 && !savedFuse && draft === null;
  const canFuseTaskMd = checked.size >= 1 && !savedFuse;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-md border border-field ccode-float-surface p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 shrink-0 text-base font-semibold text-l1">
          开始：{step.name}
        </h2>
        <p className="mb-3 shrink-0 font-mono text-xs text-l4">
          工作区 {step.workspaceName}
        </p>

        {/* 主仓改动协同（只提醒不阻断）：想法期实验性改动留在主仓是合法的 */}
        {mainDirty !== null && mainDirty > 0 && (
          <p className="mb-3 shrink-0 rounded-sm bg-inset px-2.5 py-1.5 text-xs text-warn-text">
            主仓有 {mainDirty} 个未提交改动，不会带入新工作区——可先在主仓提交，
            或开始后用 files-to-copy 机制携带。
          </p>
        )}

        {/* 简报来源勾选：本步骤 + 未挂步骤的含简报卡片；无可选时也渲染（引导语教下一步动作） */}
        {savedFuse ? (
          <div className="mb-3 flex shrink-0 items-center gap-2 text-xs">
            <span className="text-ok-text">
              ✓ 已融合钉入「{savedFuse.cardName}」，TASK.md 使用融合简报
            </span>
            <button
              type="button"
              onClick={() => setSavedFuse(null)}
              className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
            >
              撤销，改回多份全文
            </button>
          </div>
        ) : draft !== null ? (
          <div className="mb-3 shrink-0">
            {/* 与 DigestPicker / 评审沉淀同一措辞 */}
            <p className="pb-1.5 text-xs text-l4">
              AI 初稿，改完定稿后才会落盘（钉入任务卡）
            </p>
            <textarea
              className="h-36 w-full resize-none rounded-md border border-field bg-inset px-2 py-1.5 text-[13px] leading-relaxed text-l2 outline-none placeholder:text-l4 focus:border-l4"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-1.5 flex items-center gap-2">
              <select
                value={fuseTarget}
                onChange={(e) => setFuseTarget(e.target.value)}
                title="融合简报钉到哪张任务卡"
                className="h-7 rounded-md border border-field bg-canvas px-1.5 text-xs text-l2 outline-none focus:border-l4"
              >
                {sources.map((s) => (
                  <option key={s.card.id} value={s.card.id}>
                    钉到「{s.card.name}」
                  </option>
                ))}
                <option value="__new__">添加想法（以步骤名）</option>
              </select>
              <button
                type="button"
                disabled={savingFuse || !draft.trim()}
                onClick={() => void finalizeFuse()}
                className="inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {savingFuse ? "定稿中…" : "定稿并采用"}
              </button>
              <button
                type="button"
                disabled={savingFuse}
                onClick={() => setDraft(null)}
                className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                放弃融合
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-3 shrink-0">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs text-l3">带进 TASK.md 的简报</span>
              {fusable && (
                <button
                  type="button"
                  disabled={fusing}
                  onClick={() => void fuseSelected()}
                  title="AI 把所选简报融合成一份简报初稿，定稿后钉卡并用于 TASK.md"
                  className="rounded-sm px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  {fusing ? "◈ 融合中…" : "◈ 融合所选简报"}
                </button>
              )}
            </div>
            {sources.length === 0 ? (
              <p className="text-[11px] text-l4">
                还没有定稿简报——对话页 ◈ 提炼接力定稿后会自动钉到卡片，再回来勾选。
              </p>
            ) : (
              <ul className="space-y-0.5">
                {sources.map((s) => (
                  <li key={s.card.id}>
                    <Checkbox
                      checked={checked.has(s.card.id)}
                      onChange={() => toggle(s.card.id)}
                      label={
                        <span className="flex min-w-0 items-center gap-2 text-xs">
                          <span className="min-w-0 truncate text-l2">
                            {s.card.name}
                            {s.card.step === null && (
                              <span className="ml-1 text-[10px] text-l4">
                                （未挂步骤）
                              </span>
                            )}
                          </span>
                          {s.time && (
                            <span className="shrink-0 text-[10px] text-l4">
                              最新简报 {relTime(s.time)}
                            </span>
                          )}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {fuseError && (
          <p className="mb-2 shrink-0 text-xs text-err-text">
            ✗ {fuseError}
            {draft === null && !savedFuse && (
              <button
                type="button"
                onClick={() => void fuseSelected()}
                className="ml-2 rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
              >
                重试
              </button>
            )}
          </p>
        )}

        {/* 未登记资源提醒（只提醒不阻断，默认不勾选）：登记后进 TASK.md 的「项目资源」段 */}
        {resCandidates && resCandidates.length > 0 && (
          <div className="mb-3 shrink-0 rounded-md bg-inset px-2.5 py-2">
            <div className="mb-1 text-xs text-l3">
              发现 {resCandidates.length} 个未登记文件
            </div>
            <ul className="max-h-28 space-y-0.5 overflow-auto">
              {resCandidates.map((d) => (
                <li key={d.path}>
                  <Checkbox
                    checked={resChecked.has(d.path)}
                    onChange={(checked) => {
                      setResChecked((cur) => {
                        const next = new Set(cur);
                        if (checked) next.add(d.path);
                        else next.delete(d.path);
                        return next;
                      });
                    }}
                    label={
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 rounded-sm bg-strip px-1 py-0.5 text-l3">
                          {RESOURCE_TYPE_LABELS[d.type] ?? "其他"}
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-l2"
                          title={d.path}
                        >
                          {d.path}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                disabled={resChecked.size === 0 || resSaving}
                onClick={() => void registerResources()}
                className="rounded-sm border border-field px-1.5 py-0.5 text-[11px] text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {resSaving ? "登记中…" : `登记选中（${resChecked.size}）`}
              </button>
              <span className="text-[10px] text-l4">
                不登记也能开工，登记后 TASK.md 才会列出它们
              </span>
            </div>
            {resError && (
              <p className="mt-1 text-xs text-err-text">✗ {resError}</p>
            )}
          </div>
        )}

        {/* 人工事项区（步骤声明了才有）：开工前事项未完成给提醒，只提醒不阻断；
            勾选/提交交付直接可在这里做，与卡片区同一个 HumanTasksList */}
        {(stepNow.humanTasks?.length ?? 0) > 0 && (
          <div className="mb-3 max-h-44 shrink-0 overflow-auto rounded-md bg-inset px-2.5 py-2">
            {(() => {
              const blocking = humanStates
                ? blockingHumanTasks(humanStates, step.name)
                : [];
              return blocking.length > 0 ? (
                <p className="mb-1.5 text-xs text-warn-text">
                  开始前还有 {blocking.length}{" "}
                  件事没完成（{blocking.map((t) => t.title).join("、")}
                  ）——做完再开始更顺；现在开始也可以，系统只提醒不拦你
                </p>
              ) : null;
            })()}
            <HumanTasksList
              projectPath={projectPath}
              stepName={step.name}
              onStates={setHumanStates}
            />
          </div>
        )}

        {/* 推荐技能区（可编辑）：增删写回步骤定义（project.toml），预览即时联动 */}
        <StepSkillsChips
          skills={stepNow.skills}
          skillMeta={skillMeta}
          available={skillLib?.map((s) => s.name)}
          onChange={(next) => void onSkillsChange(next)}
        />
        {skillError && (
          <p className="mb-2 shrink-0 text-xs text-err-text">✗ {skillError}</p>
        )}

        {/* TASK.md 编辑区：默认拼装（同一 renderTaskMd），可人改 / AI 融合为连贯文档；
            确认开工落盘 = 编辑区最终内容 */}
        <div className="mb-1 flex shrink-0 items-center gap-2">
          <span className="text-xs text-l3">TASK.md（可编辑）</span>
          <span className="text-[10px] text-l4">
            {draftText?.trim()
              ? `内容来自任务书草稿 ${draftRel ?? ""}（改这里只影响本次落盘，不回写草稿）`
              : "默认由模板与勾选简报拼装，确认后按编辑区内容落盘"}
          </span>
          {canFuseTaskMd && (
            <button
              type="button"
              disabled={fusingTaskMd || !editorReady}
              onClick={() => void fuseTaskMd()}
              title="AI 把模板简报与所选简报融合成一份连贯的 TASK.md（提货单段原样保留），填入后可再改"
              className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
            >
              {fusingTaskMd ? "◈ 融合中…" : "◈ 融合为连贯 TASK.md"}
            </button>
          )}
          {editor.dirty && !canFuseTaskMd && (
            <span className="ml-auto" />
          )}
          {editor.dirty && (
            <button
              type="button"
              onClick={() =>
                assembled !== null &&
                dispatchEditor({ type: "reset", text: assembled })
              }
              title="放弃修改，回到模板与勾选简报的默认拼装"
              className={`shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-l4 hover:bg-hover hover:text-l2 ${canFuseTaskMd ? "" : "ml-auto"}`}
            >
              恢复默认拼装
            </button>
          )}
        </div>
        {fuseTaskMdError && (
          <p className="mb-2 shrink-0 text-xs text-err-text">
            ✗ {fuseTaskMdError}
            <button
              type="button"
              onClick={() => void fuseTaskMd()}
              className="ml-2 rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
            >
              重试
            </button>
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-field bg-canvas">
          {!editorReady ? (
            <div className="p-3">
              <LoadingRows compact />
            </div>
          ) : (
            <textarea
              className="h-full max-h-[38vh] min-h-40 w-full resize-none overflow-auto bg-canvas p-3 font-mono text-[11px] leading-5 text-l2 outline-none placeholder:text-l4"
              value={editor.text}
              onChange={(e) =>
                dispatchEditor({ type: "edit", text: e.target.value })
              }
              spellCheck={false}
            />
          )}
        </div>

        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || !editorReady}
            onClick={() => onConfirm(activeBriefRefs, editor.text)}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "开始中…" : "确认开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
