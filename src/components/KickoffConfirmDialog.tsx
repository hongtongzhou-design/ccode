import { useEffect, useMemo, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, LoadingRows } from "./PageFrame";
import StepSkillsChips from "./StepSkillsChips";
import HumanTasksList from "./HumanTasksList";
import {
  blockingHumanTasks,
  taskMdEditorReduce,
  type TaskMdEditorState,
} from "../task-cards";
import { gatherTaskMdExtras, renderTaskMd } from "../pipeline-start";
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
 * 3. 主仓改动协同：主仓有未提交改动时顶部提醒（不阻断）。
 * 「继续」动作不经本弹层；评审「开始下一步」保留直开（连续流，评审沉淀已落下一步草稿）。
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

  // TASK.md 提货单/技能元数据（打开时读一次）
  const [extras, setExtras] = useState<{
    artifacts: ArtifactEntryDto[];
    skillMeta: Record<string, string> | undefined;
  } | null>(null);
  // 主仓未提交改动数（null = 非 git 仓库/读取失败，不渲染提醒行）
  const [mainDirty, setMainDirty] = useState<number | null>(null);
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
    );
  }, [extras, stepNow, cfgLocal, skillMeta, projectPath]);

  // 编辑区初始化：草稿存在（非空）时草稿优先于模板拼装——草稿是讨论的直接产物，
  // 所见即所得；「恢复默认拼装」仍可回到模板拼装。等草稿加载完再初始化，避免闪换
  useEffect(() => {
    if (assembled === null || draftText === undefined) return;
    const draft = draftText?.trim() ? draftText.trim() : null;
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
          <p className="mb-3 shrink-0 rounded-sm bg-inset px-2.5 py-1.5 text-xs text-warn-text">
            主仓有 {mainDirty} 个未提交改动，不会带入新工作区——可先在主仓提交，
            或开始后用 files-to-copy 机制携带。
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
                title="把旧版简报全文逐份追加进本步骤任务书草稿（「旧简报并入」小节），之后可在编辑区再改"
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {legacyMerging ? "并入中…" : "并入草稿"}
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

        {/* 推荐技能区（可编辑）：增删写回步骤定义（project.toml），预览即时联动；
            mentionsMcp 的技能带「推荐 MCP」标记（点击跳 MCP 页配置） */}
        <StepSkillsChips
          skills={stepNow.skills}
          skillMeta={skillMeta}
          available={skillLib?.map((s) => s.name)}
          mcpRecommended={skillLib
            ?.filter((s) => s.mentionsMcp)
            .map((s) => s.name)}
          skillLib={skillLib}
          onChange={(next) => void onSkillsChange(next)}
        />
        {skillError && (
          <p className="mb-2 shrink-0 text-xs text-err-text">✗ {skillError}</p>
        )}

        {/* TASK.md 编辑区：默认拼装（同一 renderTaskMd），草稿优先、可人改；
            确认开工落盘 = 编辑区最终内容 */}
        <div className="mb-1 flex shrink-0 items-center gap-2">
          <span className="text-xs text-l3">TASK.md（可编辑）</span>
          <span className="text-micro text-l4">
            {draftText?.trim()
              ? `内容来自任务书草稿 ${draftRel ?? ""}（改这里只影响本次落盘，不回写草稿）`
              : "默认由模板拼装，确认后按编辑区内容落盘"}
          </span>
          {editor.dirty && (
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
            onClick={() => onConfirm(editor.text)}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "开始中…" : "确认开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
