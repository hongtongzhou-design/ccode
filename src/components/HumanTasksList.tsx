import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
  HumanTaskStateDto,
  ImportDeliverableDto,
  ProjectConfigDto,
} from "../types";

/** 检索结果导入的固定落点（lit-search 人肉中转协议：agent 开工自动解析、去重、合并进筛选清单） */
export const SEARCH_IMPORTS_DIR = "papers/imports/";

/** 扩展名 → 资源类型（与后端 classify_extension 同一口径：paper/dataset/reference/other） */
function resourceTypeOf(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "paper";
  if (["csv", "tsv", "parquet", "xlsx", "sav", "dta"].includes(ext))
    return "dataset";
  if (["bib", "ris", "enw"].includes(ext)) return "reference";
  return "other";
}

/** 人工事项的状态与动作（HumanTasksList 平铺清单与 StepFlow 流程线共用）：
 *  状态全部后端派生（落点检测 + 手动勾选，手动优先），挂载时取一次、操作后重取，不轮询。
 *  提交交付 = 系统对话框选文件 或 把文件拖到条目上（webview 窗口级 drag-drop 事件，
 *  落点判定用 elementFromPoint 命中带 data-human-task 的行元素；取不到命中时静默忽略）。
 *  containerRef 指向包裹所有 [data-human-task] 行的容器（ul/div 均可） */
export function useHumanTasks({
  projectPath,
  stepName,
  containerRef,
  onChanged,
  onStates,
}: {
  projectPath: string;
  stepName: string;
  containerRef: React.RefObject<HTMLElement | null>;
  onChanged?: () => void;
  onStates?: (states: HumanTaskStateDto[]) => void;
}) {
  const [states, setStates] = useState<HumanTaskStateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyTitle, setBusyTitle] = useState<string | null>(null);
  // 拖拽悬停命中的事项标题（高亮行）
  const [dropHover, setDropHover] = useState<string | null>(null);
  // 导入成功后的「登记为项目资源」追问（7b）：仅交付落在项目根时出现，关掉不纠缠
  const [registerOffer, setRegisterOffer] = useState<{ destRel: string } | null>(
    null,
  );

  async function reload() {
    try {
      const all = await invoke<HumanTaskStateDto[]>("list_human_task_states", {
        projectRoot: projectPath,
      });
      const mine = all.filter((s) => s.step === stepName);
      setStates(mine);
      onStates?.(mine);
    } catch {
      /* 读取失败静默：下轮挂载/操作重试 */
    }
  }

  useEffect(() => {
    let stale = false;
    invoke<HumanTaskStateDto[]>("list_human_task_states", {
      projectRoot: projectPath,
    })
      .then((all) => {
        if (stale) return;
        const mine = all.filter((s) => s.step === stepName);
        setStates(mine);
        onStates?.(mine);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, stepName]);

  // 窗口级文件拖放：命中本清单某行 = 提交该事项的交付物
  useEffect(() => {
    if (!states?.some((s) => s.target)) return;
    /** Tauri drag-drop 位置为物理像素，elementFromPoint 要 CSS 像素：两种都试 */
    function hitRow(x: number, y: number): HTMLElement | null {
      const scale = window.devicePixelRatio || 1;
      for (const [cx, cy] of [
        [x, y],
        [x / scale, y / scale],
      ]) {
        const el = document.elementFromPoint(cx, cy);
        const row = el?.closest<HTMLElement>("[data-human-task]");
        if (row && containerRef.current?.contains(row)) return row;
      }
      return null;
    }
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        const row = hitRow(event.payload.position.x, event.payload.position.y);
        setDropHover(row?.dataset.humanTask ?? null);
      } else if (event.payload.type === "drop") {
        const row = hitRow(event.payload.position.x, event.payload.position.y);
        setDropHover(null);
        const title = row?.dataset.humanTask;
        const path = event.payload.paths[0];
        if (title && path) void importFile(title, path);
      } else {
        setDropHover(null);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states, projectPath, stepName]);

  async function toggle(task: HumanTaskStateDto, checked: boolean) {
    setError(null);
    try {
      await invoke("set_human_task_check", {
        projectRoot: projectPath,
        step: stepName,
        title: task.title,
        checked,
      });
      await reload();
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 提交产物（按钮选文件 / 拖拽共用）：复制进落点 + 登记提货单（登记失败只提示不否决）。
   *  targetOverride = 落点覆盖（papers/imports/ 检索结果导入专用，提示文案不同） */
  async function importFile(
    title: string,
    sourcePath: string,
    targetOverride?: string,
  ) {
    setBusyTitle(title);
    setError(null);
    setNote(null);
    setRegisterOffer(null);
    try {
      const out = await invoke<ImportDeliverableDto>("import_human_deliverable", {
        projectRoot: projectPath,
        step: stepName,
        title,
        sourcePath,
        targetOverride: targetOverride ?? null,
      });
      if (targetOverride) {
        setNote(
          `已放入 ${targetOverride.replace(/[\\/]+$/, "")}/，agent 开工时会自动解析、去重并合并进筛选清单`,
        );
      } else {
        setNote(
          out.registered
            ? `已提交「${title}」→ ${out.destRel}（已登记提货单）`
            : `已提交「${title}」→ ${out.destRel}（提货单登记未成功：${out.registerError ?? "未知原因"}）`,
        );
        // 「登记为项目资源」追问：只限交付落在项目根（工作区是临时的，登记其中路径没意义）
        const norm = (p: string) => p.replace(/[\\/]+$/, "");
        if (norm(out.destRoot) === norm(projectPath)) {
          setRegisterOffer({ destRel: out.destRel });
        }
      }
      await reload();
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyTitle(null);
    }
  }

  async function pickFile(title: string) {
    const selected = await open({
      multiple: false,
      directory: false,
      title: `选择「${title}」的交付文件`,
    });
    if (typeof selected === "string") void importFile(title, selected);
  }

  /** 导入检索结果（papers/ 落点事项的专用入口）：多选 Undermind/Consensus/Elicit 等
   *  闭源站导出的 RIS/BibTeX/CSV，落点固定 papers/imports/（lit-search 协议） */
  async function pickSearchResults(title: string) {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择导出的检索结果文件",
      filters: [
        {
          name: "检索结果（RIS / BibTeX / CSV / TXT）",
          extensions: ["ris", "bib", "csv", "txt"],
        },
      ],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    // 逐个导入：单个失败（如同名已存在）只报错，不阻断其余
    for (const p of paths) await importFile(title, p, SEARCH_IMPORTS_DIR);
  }

  /** 登记导入的交付文件为项目资源（读-改-写回 project.toml，与资源面板同一口径） */
  async function registerOffered() {
    if (!registerOffer) return;
    const rel = registerOffer.destRel;
    setError(null);
    try {
      const read = await invoke<{ config: ProjectConfigDto }>(
        "read_project_config",
        { path: projectPath },
      );
      await invoke("write_project_config", {
        path: projectPath,
        config: {
          ...read.config,
          resources: [
            ...read.config.resources,
            {
              name: rel.split("/").pop() ?? rel,
              path: rel,
              type: resourceTypeOf(rel),
              readonly: false,
              note: "",
            },
          ],
        },
      });
      setNote(`已登记为项目资源：${rel}`);
      setRegisterOffer(null);
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return {
    states,
    error,
    note,
    busyTitle,
    dropHover,
    toggle,
    pickFile,
    pickSearchResults,
    registerOffer,
    registerOffered,
    dismissRegisterOffer: () => setRegisterOffer(null),
  };
}

/** 人工事项平铺 checklist（开工确认弹层用；聚焦视图用 StepFlow 流程线）：
 *  状态与动作逻辑在 useHumanTasks，本组件只是分组渲染 */
export default function HumanTasksList({
  projectPath,
  stepName,
  onChanged,
  onStates,
}: {
  projectPath: string;
  stepName: string;
  /** 勾选/交付后通知父级（外部统计重取） */
  onChanged?: () => void;
  /** 每次状态（重）载后回传本步骤的状态切片（开工弹层的开工前提醒等需要读状态） */
  onStates?: (states: HumanTaskStateDto[]) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const {
    states,
    error,
    note,
    busyTitle,
    dropHover,
    toggle,
    pickFile,
    registerOffer,
    registerOffered,
    dismissRegisterOffer,
  } = useHumanTasks({
    projectPath,
    stepName,
    containerRef: listRef,
    onChanged,
    onStates,
  });

  if (states !== null && states.length === 0) return null;

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] text-l4">人工事项</span>
        {states && states.some((s) => !s.done) && (
          <span className="text-[10px] text-warn-text">
            {states.filter((s) => !s.done).length} 件待做
          </span>
        )}
      </div>
      {states === null ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : (
        // 按时机分组（开始前 → 进行中 → 收尾）：组名即"什么时候轮到你了"，
        // 避免不同档的事项并排摆着被误读成"现在全都要做"
        <div className="space-y-2">
          {(["before", "during", "after"] as const)
            .map((timing) => ({
              timing,
              items: states.filter((s) =>
                timing === "during"
                  ? s.timing !== "before" && s.timing !== "after"
                  : s.timing === timing,
              ),
            }))
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.timing}>
                <div className="mb-0.5 text-[10px] text-l4">
                  {g.timing === "before"
                    ? "开始前（建议先做，不做也能开工）"
                    : g.timing === "after"
                      ? "收尾（agent 干完后轮到你）"
                      : "进行中（随时可做）"}
                </div>
                <ul ref={listRef} className="space-y-1">
                  {g.items.map((task) => (
            <li
              key={task.title}
              data-human-task={task.target ? task.title : undefined}
              className={`rounded px-1.5 py-1 ${
                dropHover === task.title
                  ? "bg-cta/10 outline outline-1 outline-cta-bd"
                  : "bg-inset"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-3.5 shrink-0 accent-[var(--color-cta)]"
                  checked={task.done}
                  disabled={busyTitle === task.title}
                  onChange={(e) => void toggle(task, e.target.checked)}
                  title={
                    task.detected && !task.manual
                      ? "落点已检测到文件；取消勾选需移走文件（检测口径）"
                      : task.manual
                        ? "人工已确认；取消勾选回到文件检测口径"
                        : "勾选 = 人工确认完成（系统不再追问）"
                  }
                />
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${
                    task.done ? "text-l3 line-through" : "text-l1"
                  }`}
                >
                  {task.title}
                </span>
                {task.done && (
                  <span className="shrink-0 text-[10px] text-ok-text">
                    {task.manual ? "✓ 已确认" : "✓ 已见到文件"}
                  </span>
                )}
                {task.target && !task.done && (
                  <button
                    type="button"
                    disabled={busyTitle !== null}
                    onClick={() => void pickFile(task.title)}
                    title={`选文件提交到落点 ${task.target}（复制 + 登记提货单）；也可直接把文件拖到这一行`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-l3 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
                  >
                    {busyTitle === task.title ? "提交中…" : "提交产物"}
                  </button>
                )}
              </div>
              {(task.guidance || task.target) && (
                <details className="mt-0.5 pl-6">
                  <summary className="cursor-pointer select-none text-[10px] text-l4 hover:text-l2">
                    怎么做 / 落点
                  </summary>
                  <div className="mt-0.5 space-y-0.5 text-[11px] leading-4 text-l3">
                    {task.guidance && (
                      <p className="whitespace-pre-wrap">{task.guidance}</p>
                    )}
                    {task.target && (
                      <p className="font-mono text-l4">
                        落点：{task.target}（放到这里系统会自动勾上）
                      </p>
                    )}
                  </div>
                </details>
              )}
            </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
      {note && <p className="mt-1 text-[11px] text-ok-text">{note}</p>}
      {registerOffer && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-l3">
          要登记为项目资源吗（{registerOffer.destRel}）
          <button
            type="button"
            onClick={() => void registerOffered()}
            className="rounded border border-field px-1.5 py-0.5 text-l2 hover:bg-white/5 hover:text-l1"
          >
            登记
          </button>
          <button
            type="button"
            onClick={dismissRegisterOffer}
            title="不登记，文件已在落点目录里"
            className="rounded px-1 py-0.5 text-l4 hover:bg-white/5 hover:text-l1"
          >
            不了
          </button>
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-err-text">{error}</p>}
    </div>
  );
}
