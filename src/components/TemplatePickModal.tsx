import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PIPELINE_TEMPLATES } from "../pipeline-presets";
import type { PipelineTemplateDef } from "../pipeline-presets";
import type { AppendStepsResultDto, ProjectConfigReadDto } from "../types";
import { fieldClass, primaryActionClass, secondaryActionClass } from "./PageFrame";

/**
 * 添加项目注册成功后的研究流程模板选择层（v3.79）：
 * 选项 = 内置六套模板（名称 + 一句话说明 + 步骤数），选中即把模板步骤追加进
 * project.toml（append_pipeline_steps：重名跳过、全跳过不落盘、顺带清 pipeline_opt_out）；
 * 「不使用研究流程」= 显式写 pipeline_opt_out = true（记住选择，不再显示模板引导），
 * 「稍后再选」= 只关闭不留痕；两条路事后都可从项目组 ⋯ 或编辑器「＋ 从模板追加」补。
 *
 * v3.90 第二屏「全局设定」：模板带 projectSettings（贯穿全程的决定）时，
 * 选中模板先进入填写屏——注册当下正是人最有耐心的时刻，只预填空答案等人
 * 自己去项目设置抽屉里发现，等于没引导（用户实测反馈）。全部可留空跳过，
 * 跳过则按原样预填提示行（答案留空，之后在抽屉里补）。
 */
export default function TemplatePickModal({
  projectPath,
  projectName,
  onClose,
  onOptOut,
  onApplied,
}: {
  projectPath: string;
  projectName: string;
  /** 「稍后再选」/遮罩点击：只关闭，不写任何标记 */
  onClose: () => void;
  /** 「不使用研究流程」：已把 pipeline_opt_out = true 写进 project.toml，父级关闭并刷新 */
  onOptOut: () => void;
  /** 模板步骤追加成功：携带结果供页面刷新与成功提示 */
  onApplied: (result: AppendStepsResultDto, templateName: string) => void;
}) {
  // 追加中的模板 id（防连击，"__optout__" 为「不使用」写入中）；失败留在弹层内报错可换选/重试
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 第二屏：选中的带全局设定模板 + 逐条答案（下标对齐 tpl.projectSettings）
  const [settingsTpl, setSettingsTpl] = useState<PipelineTemplateDef | null>(
    null,
  );
  const [answers, setAnswers] = useState<string[]>([]);

  /** 「问题：（提示）」拆成问题与提示（提示去掉括号做输入占位） */
  function splitSetting(line: string): { q: string; hint: string } {
    const i = line.indexOf("：");
    if (i < 0) return { q: line, hint: "" };
    return {
      q: line.slice(0, i),
      hint: line
        .slice(i + 1)
        .replace(/^（|）$/g, ""),
    };
  }

  /** 选中模板：有全局设定建议项先进填写屏，否则直接应用 */
  function pick(templateId: string) {
    const tpl = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl || busy) return;
    if (tpl.projectSettings?.length) {
      setSettingsTpl(tpl);
      setAnswers(tpl.projectSettings.map(() => ""));
      setError(null);
    } else {
      void apply(tpl);
    }
  }

  async function apply(tpl: PipelineTemplateDef, filled?: string[]) {
    if (busy) return;
    setBusy(tpl.id);
    setError(null);
    try {
      const res = await invoke<AppendStepsResultDto>("append_pipeline_steps", {
        projectRoot: projectPath,
        steps: tpl.steps,
      });
      // 全局设定（v3.89）：贯穿全程的决定预填进项目层。有答案的用「问题：答案」，
      // 留空的保留模板提示行（答案留空，之后在项目设置抽屉里补）。
      // 已有设定则不覆盖——用户自己填过的优先
      if (tpl.projectSettings?.length) {
        const lines = tpl.projectSettings.map((line, i) => {
          const a = filled?.[i]?.trim();
          if (!a) return line;
          return `${splitSetting(line).q}：${a}`;
        });
        try {
          const read = await invoke<ProjectConfigReadDto>(
            "read_project_config",
            { path: projectPath },
          );
          if ((read.config.settings ?? []).length === 0)
            await invoke("write_project_config", {
              path: projectPath,
              config: { ...read.config, settings: lines },
            });
        } catch {
          /* 预填失败不影响模板应用本身 */
        }
      }
      onApplied(res, tpl.name);
    } catch (reason) {
      setError(String(reason));
      setBusy(null);
    }
  }

  /** 「不使用研究流程」：显式写 pipeline_opt_out = true（区别于「稍后再选」的不留痕关闭） */
  async function optOut() {
    if (busy) return;
    setBusy("__optout__");
    setError(null);
    try {
      await invoke("set_pipeline_opt_out", {
        projectRoot: projectPath,
        optOut: true,
      });
      onOptOut();
    } catch (reason) {
      setError(String(reason));
      setBusy(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 ccode-fade"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[36rem] rounded-md border border-field ccode-float-surface p-5"
      >
        {settingsTpl ? (
          /* 第二屏「全局设定」：贯穿全程的决定，注册当下就填（留空跳过，
             之后仍可在项目设置抽屉里补——抽屉是长期编辑处，这里是引导） */
          <>
            <h2 className="mb-1 text-base font-semibold text-l1">
              「{settingsTpl.name}」的几件全局设定
            </h2>
            <p className="mb-4 text-xs text-l3">
              这几件事决定后面每一步，开工时会随 TASK.md 带给 AI。现在能定就填，拿不准留空跳过。
            </p>
            <div className="space-y-2.5">
              {settingsTpl.projectSettings!.map((line, i) => {
                const { q, hint } = splitSetting(line);
                return (
                  <label key={q} className="block">
                    <span className="mb-1 block text-xs text-l2">{q}</span>
                    <input
                      className={fieldClass}
                      value={answers[i] ?? ""}
                      placeholder={hint}
                      onChange={(e) =>
                        setAnswers((prev) =>
                          prev.map((a, j) => (j === i ? e.target.value : a)),
                        )
                      }
                    />
                  </label>
                );
              })}
            </div>
            {error && <p className="mt-3 text-sm text-err-text">{error}</p>}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setSettingsTpl(null);
                  setError(null);
                }}
                className="rounded-sm px-3 py-1.5 text-sm text-l3 hover:bg-hover hover:text-l2 disabled:opacity-50"
              >
                ‹ 换个模板
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void apply(settingsTpl)}
                  title="按模板原样预填（答案留空），之后可在项目设置抽屉补"
                  className={`${secondaryActionClass} disabled:opacity-50`}
                >
                  跳过，以后再填
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void apply(settingsTpl, answers)}
                  className={`${primaryActionClass} disabled:opacity-50`}
                >
                  {busy === settingsTpl.id ? "写入中…" : "保存并应用模板"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h2 className="mb-1 text-base font-semibold text-l1">
              选择研究流程模板
            </h2>
            <p className="mb-4 text-xs text-l3">
              「{projectName}」已添加。挑一套研究流程，也可以先空着。
            </p>
            <ul className="space-y-1.5">
              {PIPELINE_TEMPLATES.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => pick(t.id)}
                    className="w-full rounded-sm bg-inset p-2.5 text-left hover:bg-hover disabled:opacity-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-l1">{t.name}</span>
                      <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
                        {t.steps.length} 步
                      </span>
                      {busy === t.id && (
                        <span className="ml-auto text-xs text-l3">写入中…</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-l3">{t.description}</p>
                  </button>
                </li>
              ))}
            </ul>
            {error && <p className="mt-3 text-sm text-err-text">{error}</p>}
            {/* 「不使用」显式写 pipeline_opt_out 标记（隐藏模板引导）；「稍后」只关闭不留痕，
                两者事后都可从项目组 ⋯「选择研究流程模板」/编辑器「＋ 从模板追加」补 */}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void optOut()}
                title="项目保持空白，只作为目录与任务的分组管理（记住这个选择，不再显示模板引导）"
                className="rounded-sm px-3 py-1.5 text-sm text-l3 hover:bg-hover hover:text-l2 disabled:opacity-50"
              >
                {busy === "__optout__" ? "保存中…" : "不用，别再提示"}
              </button>
              <button
                type="button"
                onClick={onClose}
                title="之后可从项目组 ⋯「选择研究流程模板」或编辑器「＋ 从模板追加」随时添加"
                className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              >
                稍后再选
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
