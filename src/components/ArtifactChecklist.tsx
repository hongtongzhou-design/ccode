import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rowActionClass } from "./PageFrame";
import type { DirEntryDto } from "./FileTree";
import { absTime, relTime } from "../rel-time";
import { useAppStore } from "../store";
import type { ProjectConfigReadDto } from "../types";

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 资源/产物登记的路径多为相对根目录；拼成绝对路径，绝对路径原样返回 */
export function absoluteResourcePath(root: string, resourcePath: string): string {
  if (resourcePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resourcePath)) {
    return resourcePath;
  }
  return `${root.replace(/[\\/]+$/, "")}/${resourcePath}`;
}

/** 产物核验清单的一行：一个预期产物条目的定位结果 */
interface ArtifactRow {
  /** 预期产物条目原文（相对根的路径） */
  entry: string;
  files: DirEntryDto[];
}

/** 预期产物条目逐个在 root 下定位——文件单列自身；
 *  目录列一层文件（只列文件不递归）；找不到返回空 files（UI 显示「尚未产出」）。
 *  list_dir 无根目录约束（只读列举），直接传绝对路径；仅在面板打开/手动刷新时调用，不进轮询。
 *  评审覆盖层的「产物 X/Y 已产出」摘要也复用本函数（同一数据机制，不另造请求）。 */
export async function loadArtifactRows(
  entries: string[],
  root: string,
): Promise<ArtifactRow[]> {
  return Promise.all(
    entries.map(async (raw) => {
      const entry = raw.replace(/[\\/]+$/, "");
      const abs = absoluteResourcePath(root, entry);
      // 目录条目：list_dir 成功即列一层文件
      try {
        const children = await invoke<DirEntryDto[]>("list_dir", {
          path: abs,
          showHidden: false,
        });
        return { entry, files: children.filter((c) => !c.isDir) };
      } catch {
        /* 非目录或不存在，走父目录匹配 */
      }
      // 文件条目：列父目录按名称匹配，区分「文件存在」与「尚未产出」
      const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
      if (idx > 0) {
        try {
          const siblings = await invoke<DirEntryDto[]>("list_dir", {
            path: abs.slice(0, idx),
            showHidden: false,
          });
          const hit = siblings.find((s) => s.name === abs.slice(idx + 1));
          if (hit && !hit.isDir) return { entry, files: [hit] };
        } catch {
          /* 父目录也不存在 */
        }
      }
      return { entry, files: [] };
    }),
  );
}

/**
 * 步骤产物核验清单（RX2b → v3.45 起挂在任务行下）：挂载时拉取一次 + 手动 ⟳ 刷新，不进轮询。
 * 步骤从 project.toml 按 workspaceName 反查；定位根由调用方按状态给定——已合并读项目根（main），其余读工作树。
 */
export default function ArtifactChecklist({
  projectPath,
  workspaceName,
  root,
  rootLabel,
}: {
  /** 读 project.toml 找绑定步骤（注册项目路径） */
  projectPath: string;
  /** 绑定步骤 = steps[].workspaceName 匹配工作区名 */
  workspaceName: string;
  /** 产物定位根目录（工作树或项目根） */
  root: string;
  /** 根来源小字：「工作区」/「主文件夹（已合并）」 */
  rootLabel: string;
}) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPage = useAppStore((s) => s.setPage);
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [stepName, setStepName] = useState<string | null>(null);
  // 步骤反查失败（未注册项目/未绑定步骤/读取失败）时给明确提示而非空清单
  const [stepFound, setStepFound] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void (async () => {
      try {
        const read = await invoke<ProjectConfigReadDto>("read_project_config", {
          path: projectPath,
        });
        const step = read.config.steps.find(
          (s) => s.workspaceName === workspaceName,
        );
        if (!step) {
          if (!stale) {
            setStepFound(false);
            setStepName(null);
            setRows([]);
          }
          return;
        }
        const loaded = await loadArtifactRows(step.expectedArtifacts, root);
        if (!stale) {
          setStepFound(true);
          setStepName(step.name);
          setRows(loaded);
        }
      } catch {
        if (!stale) {
          setStepFound(false);
          setRows([]);
        }
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [projectPath, workspaceName, root, refreshTick]);

  return (
    <div className="mt-2 rounded-md bg-strip p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-l2">
          「{stepName ?? workspaceName}」产物核验
        </span>
        <span
          className="min-w-0 truncate font-mono text-[11px] text-l4"
          title={root}
        >
          {rootLabel}
        </span>
        <button
          type="button"
          className={`${rowActionClass} ml-auto shrink-0`}
          disabled={loading}
          onClick={() => setRefreshTick((v) => v + 1)}
        >
          ⟳ 刷新
        </button>
      </div>
      {loading || !rows ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : !stepFound ? (
        <p className="text-xs text-l4">
          未找到绑定该任务的流水线步骤，暂无预期产物可核验。
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-l4">
          该步骤未登记预期产物，可在「编辑流水线」中补充。
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => {
            const produced = row.files.length > 0;
            // 单文件产物：行本身可点击预览；目录产物：行只表状态，文件逐个列在下方
            const single = row.files.length === 1 ? row.files[0] : null;
            const openFile = (f: DirEntryDto) => {
              setPreviewReq({ path: f.path, name: f.name, root });
              setPage("terminal");
            };
            const fileMeta = (f: DirEntryDto) => (
              <>
                <span
                  className="shrink-0 text-[10px] text-l4"
                  title={absTime(f.modified)}
                >
                  {relTime(f.modified)}
                </span>
                <span className="shrink-0 text-[10px] text-l4">
                  {formatSize(f.size)}
                </span>
              </>
            );
            return (
              <li key={row.entry}>
                {!produced ? (
                  <div className="flex h-7 items-center gap-2 rounded px-1 text-xs">
                    <span className="shrink-0 text-l4">—</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-l4">
                      {row.entry}
                    </span>
                    <span className="shrink-0 text-l4">尚未产出</span>
                  </div>
                ) : single ? (
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-2 rounded px-1 text-left text-xs text-l2 hover:bg-white/5 hover:text-l1"
                    title={`在终端页预览 ${single.path}`}
                    onClick={() => openFile(single)}
                  >
                    <span className="shrink-0 text-ok-text">✓</span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {single.name}
                    </span>
                    {fileMeta(single)}
                  </button>
                ) : (
                  <>
                    <div className="flex h-7 items-center gap-2 rounded px-1 text-xs">
                      <span className="shrink-0 text-ok-text">✓</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-l2">
                        {row.entry}
                      </span>
                      <span className="shrink-0 text-[10px] text-l4">
                        {row.files.length} 个文件
                      </span>
                    </div>
                    <ul className="pl-5">
                      {row.files.map((f) => (
                        <li key={f.path}>
                          <button
                            type="button"
                            className="flex h-7 w-full items-center gap-2 rounded px-1 text-left text-xs text-l2 hover:bg-white/5 hover:text-l1"
                            title={`在终端页预览 ${f.path}`}
                            onClick={() => openFile(f)}
                          >
                            <span className="min-w-0 flex-1 truncate font-mono">
                              {f.name}
                            </span>
                            {fileMeta(f)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
