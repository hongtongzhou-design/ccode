import { useEffect, useMemo, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, LoadingRows } from "./PageFrame";
import StepSkillsChips from "./StepSkillsChips";
import HumanTasksList from "./HumanTasksList";
import {
  blockingHumanTasks,
  closingHumanTasks,
  taskMdEditorReduce,
  type TaskMdEditorState,
} from "../task-cards";
import { gatherTaskMdExtras, renderTaskMd } from "../pipeline-start";
import { isDecisionsOnly } from "../step-decisions";
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
 * 开工确认弹层（v3.64；任务书沉淀统一走草稿后精简）：「开工」= 点开工 → 本弹层 → 确认开工。
 * 三件事统一在这里承载：
 * 1. TASK.md 编辑区（所见即所得：默认拼装与实际落盘走同一个 renderTaskMd/gatherTaskMdExtras；
 *    任务书草稿非空时初始内容 = 草稿全文；确认开工落盘 = 编辑区最终内容）；
 * 2. 旧版简报兜底：.ccode/brief-*.md 存在且草稿为空时给一行提示，可「并入草稿」
 *    （新口径不再自动带入 TASK.md）；
 * 3. 未存入历史的改动：项目文件夹有改动时顶部提醒（不阻断，文案走白话术语表）；
 * 4. 上一步收尾软门：紧邻上一步的非可选 after 事项未勾时，「确认开始」需按两次
 *    （首击知情、按钮变「仍要开工」再击才开——只确认不阻断）。
 * 「继续」动作不经本弹层；评审合并成功的「→ 去下一步」v3.97 起也不直开——跳项目页聚焦下一步，
 * 用户点「开始」仍经本弹层（上一步收尾软门因此不会被绕过）。
 */
export default function KickoffConfirmDialog({
  projectPath,
  step,
  cfg,
  busy,
  onCancel,
  onConfirm,
  onCfgChange,
}: {
  projectPath: string;
  step: ProjectStepDto;
  cfg: ProjectConfigDto;
  /** 从哪张卡点的开工（步进器大圆开工为 null）；简报来源勾选删除后仅作调用方记录保留 */
  originCardId: string | null;
  /** 确认开工后的链路进行中（父组件自持 starting） */
  busy: boolean;
  onCancel: () => void;
  /** 确认开工：taskMd = 编辑区最终内容（覆盖默认拼装落盘） */
  onConfirm: (taskMd: string) => void;
  /** 技能区增删写回 project.toml 后同步父级 cfg（保持步进器/下次打开一致） */
  onCfgChange?: (cfg: ProjectConfigDto) => void;
}) {
  // 档案卡本地副本：技能区增删写回 project.toml 后重读替换（步骤其余字段以后端回读为准）
  const [cfgLocal, setCfgLocal] = useState(cfg);
  // 技能库（名称 + 一句话描述 + mentionsMcp）：技能区展示与「＋ 添加技能」候选的数据源，打开时读一次
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
  // 链路校验供给侧：上游步骤的预期产物与其技能 outputs + 本步骤声明输入 + 项目资源
  const chainSupply = useMemo(() => {
    const idx = cfgLocal.steps.findIndex((s) => s.name === step.name);
    const upstream = (idx > 0 ? cfgLocal.steps.slice(0, idx) : []).flatMap(
      (s) => [
        ...s.expectedArtifacts,
        ...(skillLib
          ? s.skills.flatMap(
              (n) => skillLib.find((x) => x.name === n)?.outputs ?? [],
            )
          : []),
      ],
    );
    return [
      ...upstream,
      ...(stepNow.inputs ?? []),
      ...(stepNow.optionalInputs ?? []),
      ...(stepNow.anyOfInputs ?? []).flat(),
      ...cfgLocal.resources.map((r) => r.path),
    ];
  }, [cfgLocal, step.name, stepNow, skillLib]);

  // TASK.md 提货单/技能元数据（打开时读一次）
  const [extras, setExtras] = useState<{
    artifacts: ArtifactEntryDto[];
    skillMeta: Record<string, string> | undefined;
    /** 已定方向（决策项答案，读自任务书草稿）：渲染进 TASK.md 的「已定方向」段 */
    decisions: { q: string; answer: string }[];
  } | null>(null);
  // 主仓未提交改动数（null = 非 git 仓库/读取失败，不渲染提醒行）
  const [mainDirty, setMainDirty] = useState<number | null>(null);
  // 人工事项状态（HumanTasksList 回传）：开工前（before）未完成的提醒用
  const [humanStates, setHumanStates] = useState<HumanTaskStateDto[] | null>(
    null,
  );
  // 上一步收尾软门（用户拍板）：上一步非可选 after 事项未勾 → 「确认开始」要按两次
  // （只确认不阻断——不违反「主路径唯一不设门控」，但跳过审阅必须明确表态）。
  // 大纲没审就开初稿这类返工最贵的跳步，就靠它拦住手滑
  const [allHumanStates, setAllHumanStates] = useState<HumanTaskStateDto[] | null>(
    null,
  );
  const [closingAcked, setClosingAcked] = useState(false);
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

  // 旧版简报兜底（.ccode/brief-*.md，新口径不再自动带入 TASK.md）：
  // 草稿为空且旧简报非空时给提示行，「并入草稿」逐份读后 append_step_draft
  const [legacyBriefs, setLegacyBriefs] = useState<string[] | null>(null);
  const [legacyMerging, setLegacyMerging] = useState(false);
  const [legacyError, setLegacyError] = useState<string | null>(null);

  // TASK.md 编辑区：默认拼装内容 + 人编辑覆盖（状态机在 task-cards.ts，纯逻辑可测）
  const [editor, dispatchEditor] = useReducer(
    taskMdEditorReduce,
    { text: "", dirty: false } satisfies TaskMdEditorState,
  );
  const [editorReady, setEditorReady] = useState(false);
  // TASK.md 编辑区默认折叠：它是自动拼装的合同，绝大多数开工不需要看，
  // 更不该摆在正中暗示「你得先改这个」。想看/想改一点即展开
  const [taskMdOpen, setTaskMdOpen] = useState(false);

  // 打开时一次性加载：提货单/技能元数据 + 主仓状态 + 技能库 + 未登记资源 + 任务书草稿 + 旧版简报；不轮询
  useEffect(() => {
    let stale = false;
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
    invoke<string[]>("list_legacy_briefs", { projectRoot: projectPath })
      .then((paths) => {
        if (!stale) setLegacyBriefs(paths);
      })
      .catch(() => {
        if (!stale) setLegacyBriefs([]);
      });
    // 全量人工事项状态（上一步收尾软门用；本步骤的状态由 HumanTasksList 回传，互不相同）
    invoke<HumanTaskStateDto[]>("list_human_task_states", {
      projectRoot: projectPath,
    })
      .then((all) => {
        if (!stale) setAllHumanStates(all);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // 默认拼装（与实际落盘同一 renderTaskMd，单一出处）：extras/技能元数据就绪即拼。
  // 编辑区 dirty（人改过）时 assemble 事件被状态机忽略，不覆盖用户内容
  const assembled = useMemo(() => {
    if (!extras) return null;
    return renderTaskMd(
      stepNow,
      cfgLocal,
      projectPath,
      extras.artifacts,
      skillMeta ?? extras.skillMeta,
      extras.decisions,
    );
  }, [extras, stepNow, cfgLocal, skillMeta, projectPath]);

  // 编辑区初始化：草稿有正文时草稿优先于模板拼装——草稿是讨论的直接产物，所见即所得；
  // 但「只点了几个选项」生成的草稿（只有「已定方向」段、没有正文）不算数：
  // 那种草稿顶掉拼装会把简报/产物/人工事项全丢掉，agent 会拿到一份没有任务的任务书。
  // 这种情况走模板拼装——拼装里已经带上了「已定方向」段，拍板结果一样不丢。
  // 「恢复默认拼装」仍可回到模板拼装。等草稿加载完再初始化，避免闪换
  useEffect(() => {
    if (assembled === null || draftText === undefined) return;
    const raw = draftText?.trim() ?? "";
    const draft = raw && !isDecisionsOnly(raw) ? raw : null;
    dispatchEditor({ type: "assemble", text: draft ?? assembled });
    setEditorReady(true);
  }, [assembled, draftText]);

  /** 旧版简报「并入草稿」：逐份读全文（单份失败行内报错、其余继续），
   *  合并为一段经 append_step_draft 追加，完成后重读草稿刷新编辑区（人未编辑时 assemble 生效） */
  async function mergeLegacyBriefs() {
    if (!legacyBriefs || legacyBriefs.length === 0 || legacyMerging) return;
    setLegacyMerging(true);
    setLegacyError(null);
    const root = projectPath.replace(/[\\/]+$/, "");
    const parts: string[] = [];
    for (const rel of legacyBriefs) {
      try {
        const p = await invoke<{ text: string }>("read_file_preview", {
          path: `${root}/${rel}`,
          root: projectPath,
        });
        parts.push(`### ${rel}\n\n${p.text.trim()}`);
      } catch (reason) {
        setLegacyError(`「${rel}」读取失败：${String(reason)}（其余继续并入）`);
      }
    }
    try {
      if (parts.length > 0) {
        await invoke("append_step_draft", {
          projectRoot: projectPath,
          stepName: step.name,
          heading: "旧简报并入",
          content: parts.join("\n\n"),
        });
        const d = await invoke<{ relPath: string; text: string | null }>(
          "read_task_draft",
          { projectRoot: projectPath, stepName: step.name },
        );
        setDraftRel(d.relPath);
        setDraftText(d.text);
      }
    } catch (reason) {
      setLegacyError(String(reason));
    } finally {
      setLegacyMerging(false);
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

  // 旧简报提示行口径：草稿加载完且为空 + 旧简报非空
  const showLegacyHint =
    draftText !== undefined &&
    !draftText?.trim() &&
    (legacyBriefs?.length ?? 0) > 0;
  // 上一步收尾软门：按流水线顺序取紧邻上一步，其非可选 after 事项未勾则需要二次确认
  const prevStep = (() => {
    const idx = cfgLocal.steps.findIndex((s) => s.name === step.name);
    return idx > 0 ? cfgLocal.steps[idx - 1] : null;
  })();
  const prevClosing =
    prevStep && allHumanStates
      ? closingHumanTasks(allHumanStates, prevStep.name)
      : [];
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 ccode-fade"
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
          <p className="mb-3 shrink-0 rounded-md bg-inset px-3 py-2 text-xs leading-5 text-l2">
            <span className="mr-1 text-warn-text">!</span>
            项目文件夹里有 {mainDirty} 处改动还没存入历史。这一步的 agent 会在一份
            独立副本里干活，只看得到最近一次存入历史的内容——如果刚放进去的文件要给它用，
            先到「改动」面板存一下再开始。
          </p>
        )}

        {/* 旧版简报兜底（只提醒不阻断）：新口径沉淀走任务书草稿，旧 brief-*.md 不再自动带入 */}
        {showLegacyHint && (
          <div className="mb-3 shrink-0 rounded-sm bg-inset px-2.5 py-1.5 text-xs text-l3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                检测到旧版简报 {legacyBriefs!.length}{" "}
                份，新口径不再自动带入 TASK.md
              </span>
              <button
                type="button"
                disabled={legacyMerging}
                onClick={() => void mergeLegacyBriefs()}
                title="把旧版简报全文逐份追加进本步骤的 TASK.md 内容文件（「旧简报并入」小节），之后可在编辑区再改"
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {legacyMerging ? "并入中…" : "并入 TASK.md"}
              </button>
            </div>
            {legacyError && (
              <p className="mt-1 text-xs text-err-text">✗ {legacyError}</p>
            )}
          </div>
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
                className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {resSaving ? "登记中…" : `登记选中（${resChecked.size}）`}
              </button>
              <span className="text-micro text-l4">
                不登记也能开工，登记后 TASK.md 才会列出它们
              </span>
            </div>
            {resError && (
              <p className="mt-1 text-xs text-err-text">✗ {resError}</p>
            )}
          </div>
        )}

        {/* 人工事项区（步骤声明了才有）：开工前事项未完成给提醒，只提醒不阻断；
            勾选/提交交付直接可在这里做，与卡片区同一个 HumanTasksList。
            收尾（after）事项不出现（agent 干完才轮到人做），步骤只剩 after 事项时整区不渲染 */}
        {(stepNow.humanTasks?.some((t) => t.timing !== "after") ?? false) && (
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

        {/* 推荐技能区（可编辑）：增删写回步骤定义（project.toml），预览即时联动；
            mentionsMcp 的技能带「推荐 MCP」标记（点击跳 MCP 页配置） */}
        <StepSkillsChips
          skills={stepNow.skills}
          requiredSkills={stepNow.requiredSkills}
          skillMeta={skillMeta}
          available={skillLib?.map((s) => s.name)}
          mcpRecommended={skillLib
            ?.filter((s) => s.mentionsMcp)
            .map((s) => s.name)}
          skillLib={skillLib}
          chainSupply={chainSupply}
          expectedArtifacts={stepNow.expectedArtifacts}
          onChange={(next) => void onSkillsChange(next)}
        />
        {skillError && (
          <p className="mb-2 shrink-0 text-xs text-err-text">✗ {skillError}</p>
        )}

        {/* TASK.md 编辑区：默认折叠——它由模板+已定方向+资源自动拼装，绝大多数情况不用改；
            摆在正中会暗示「你得编辑这个」，反而让人不敢开工。人改过（dirty）时保持展开，
            避免改完一折叠就看不见自己写了什么 */}
        <div className="mb-1 flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setTaskMdOpen((v) => !v)}
            title={
              taskMdOpen ? "收起 TASK.md" : "展开查看/编辑本步交给 agent 的合同"
            }
            className="rounded-sm px-1 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
          >
            <span className="inline-block w-3 text-l4">
              {taskMdOpen ? "▾" : "▸"}
            </span>
            本步合同 TASK.md
            <span className="ml-1 text-micro text-l4">
              {editor.dirty
                ? "（已手改）"
                : draftText?.trim() && !isDecisionsOnly(draftText.trim())
                  ? "（来自你已编辑的 TASK.md）"
                  : "（自动生成，一般不用改）"}
            </span>
          </button>
          {taskMdOpen && editor.dirty && (
            <button
              type="button"
              onClick={() =>
                assembled !== null &&
                dispatchEditor({ type: "reset", text: assembled })
              }
              title="放弃修改，回到模板的默认拼装"
              className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-l4 hover:bg-hover hover:text-l2"
            >
              恢复默认拼装
            </button>
          )}
        </div>
        {taskMdOpen && (
          <>
            {draftText?.trim() && !isDecisionsOnly(draftText.trim()) && (
              <p className="mb-1 shrink-0 text-micro text-l4">
                内容来自你编辑过的 TASK.md（{draftRel ?? ""}；改这里只影响本次落盘，不回写该文件）
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-field bg-canvas">
              {!editorReady ? (
                <div className="p-3">
                  <LoadingRows compact />
                </div>
              ) : (
                <textarea
                  className="h-full max-h-[38vh] min-h-40 w-full resize-none overflow-auto bg-canvas p-3 font-mono text-micro leading-5 text-l2 outline-none placeholder:text-l4"
                  value={editor.text}
                  onChange={(e) =>
                    dispatchEditor({ type: "edit", text: e.target.value })
                  }
                  spellCheck={false}
                />
              )}
            </div>
          </>
        )}

        {/* 上一步收尾软门（只确认不阻断）：未勾的非可选收尾事项逐条列出，
            第一次点「确认开始」只是表态知情，按钮变成「仍要开工」再点才真开 */}
        {prevClosing.length > 0 && prevStep && (
          <p className="mb-3 shrink-0 rounded-md bg-inset px-3 py-2 text-xs leading-5 text-l2">
            <span className="mr-1 text-warn-text">!</span>
            上一步「{prevStep.name}」还有 {prevClosing.length}{" "}
            件收尾事项没完成（{prevClosing.map((t) => t.title).join("、")}
            ）——跳过审阅直接开工，上一步要返工时这一步也得跟着作废。
            {closingAcked
              ? "再点一次「仍要开工」即继续。"
              : "建议先回去过完再来；确认跳过就点「确认开始」，按钮会再问你一次。"}
          </p>
        )}

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
            onClick={() => {
              if (prevClosing.length > 0 && !closingAcked) {
                setClosingAcked(true);
                return;
              }
              onConfirm(editor.text);
            }}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy
              ? "开始中…"
              : prevClosing.length > 0 && closingAcked
                ? "仍要开工"
                : "确认开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
