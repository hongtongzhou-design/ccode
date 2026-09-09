import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { effectiveProjectRules } from "../project-context";
import {
  pathIsProtected,
  protectableEntries,
  suggestProtectedPaths,
  toggleProtectedFolder,
  type ProtectEntry,
} from "../project-tasks";
import { normalizeWorkMode } from "../work-mode";
import type { DirEntryDto } from "./FileTree";
import type { ProjectConfigDto, ProjectConfigReadDto } from "../types";
import { Checkbox, fieldClass, FoldMark } from "./PageFrame";

const RULE_PLACEHOLDER: Record<string, string> = {
  research: "引用格式：APA\n输出中文",
  office: "按公司模板写\n语气正式",
  coding: "只改当前工作树\n不要切回主仓改",
};

export default function ProjectRulesPanel({
  projectPath,
  workMode,
  compact = false,
  defaultOpen = false,
  onSaved,
  onError,
}: {
  projectPath: string;
  workMode?: string | null;
  compact?: boolean;
  defaultOpen?: boolean;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const mode = normalizeWorkMode(workMode);
  const showProtect = mode !== "coding";
  const [open, setOpen] = useState(defaultOpen);
  const [config, setConfig] = useState<ProjectConfigDto | null>(null);
  const [rulesDraft, setRulesDraft] = useState("");
  const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
  const [entries, setEntries] = useState<ProtectEntry[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protectOpen, setProtectOpen] = useState(false);
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const rulesRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    let nextProtected: string[] = [];
    try {
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      setConfig(read.config);
      setRulesDraft(
        effectiveProjectRules(
          read.config.settings,
          workMode ?? read.config.workMode,
          read.config.rulesOwned,
        ).join("\n"),
      );
      nextProtected = read.config.protectedPaths ?? [];
      setProtectedPaths(nextProtected);
      if (nextProtected.length > 0) setProtectOpen(true);
      setError(null);
    } catch (reason) {
      const message = `读取项目规则失败：${String(reason)}`;
      setError(message);
      onError?.(message);
    }
    if (!showProtect) {
      setEntries([]);
      return;
    }
    try {
      const top = await invoke<DirEntryDto[]>("list_dir", {
        path: projectPath,
        showHidden: false,
      });
      setEntries(protectableEntries(top, nextProtected, workMode));
    } catch {
      setEntries(protectableEntries([], nextProtected, workMode));
    }
  }, [onError, projectPath, showProtect, workMode]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const el = rulesRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), 200)}px`;
  }, [open, rulesDraft]);

  async function save(nextRules: string, nextProtected: string[]) {
    if (!config) return;
    const rules = nextRules
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      const latest = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      await invoke("write_project_config", {
        path: projectPath,
        config: {
          ...latest.config,
          settings: rules,
          rulesOwned: true,
          protectedPaths: nextProtected,
        },
      });
      setConfig({
        ...latest.config,
        settings: rules,
        rulesOwned: true,
        protectedPaths: nextProtected,
      });
      setProtectedPaths(nextProtected);
      setError(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } catch (reason) {
      const message = `保存项目规则失败：${String(reason)}`;
      setError(message);
      onError?.(message);
    }
  }

  function toggleFolder(path: string, checked: boolean) {
    const next = toggleProtectedFolder(protectedPaths, path, checked);
    setProtectedPaths(next);
    void save(rulesDraft, next);
  }

  const ruleCount = rulesDraft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  const suggested = new Set(
    suggestProtectedPaths(
      mode,
      entries.filter((entry) => entry.isDir).map((entry) => entry.path),
    ),
  );
  const folders = entries.filter((entry) => entry.isDir);
  const files = entries.filter((entry) => !entry.isDir);
  const featuredFolders = folders.filter(
    (entry) => suggested.has(entry.path) || pathIsProtected(entry.path, protectedPaths),
  );
  const visibleFolders = showAllFolders ? folders : featuredFolders;
  const extraFolders = folders.filter(
    (entry) => !visibleFolders.some((item) => item.path === entry.path),
  );
  const protectedFiles = files.filter((entry) =>
    pathIsProtected(entry.path, protectedPaths),
  );
  const visibleFiles = showFiles ? files : protectedFiles;
  const summary = [
    ruleCount ? `${ruleCount}` : "默认",
    showProtect && protectedPaths.length ? `⊘${protectedPaths.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  function renderProtectRow(entry: ProtectEntry) {
    const checked = pathIsProtected(entry.path, protectedPaths);
    return (
      <li key={entry.path}>
        <Checkbox
          className="min-w-0"
          checked={checked}
          label={
            <span className="min-w-0 truncate font-mono text-xs text-l2">
              {entry.isDir ? `${entry.path}/` : entry.path}
            </span>
          }
          onChange={(next) => toggleFolder(entry.path, next)}
        />
      </li>
    );
  }

  return (
    <section className={compact ? "" : "space-y-3"}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        <span className="text-xs font-medium text-l3">规则</span>
        <span className="min-w-0 flex-1 truncate text-micro text-l4">{summary}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <textarea
            ref={rulesRef}
            className={`${fieldClass} resize-none overflow-hidden leading-6`}
            value={rulesDraft}
            onChange={(event) => setRulesDraft(event.target.value)}
            onBlur={() => void save(rulesDraft, protectedPaths)}
            placeholder={RULE_PLACEHOLDER[mode]}
            aria-label="项目规则"
          />
          {showProtect && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1.5 text-left"
                onClick={() => setProtectOpen((current) => !current)}
                aria-expanded={protectOpen}
              >
                <FoldMark open={protectOpen} />
                <span className="text-xs text-l3">保持原样</span>
                {protectedPaths.length > 0 && (
                  <span className="text-micro text-l4">{protectedPaths.length}</span>
                )}
              </button>
              {protectOpen &&
                (folders.length === 0 && files.length === 0 ? (
                  <p className="mt-1.5 text-micro text-l4">项目里还没有可勾的项。</p>
                ) : (
                  <>
                    {(visibleFolders.length > 0 || visibleFiles.length > 0) && (
                    <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {visibleFolders.map(renderProtectRow)}
                      {visibleFiles.map(renderProtectRow)}
                    </ul>
                    )}
                    {extraFolders.length > 0 && (
                      <button
                        type="button"
                        className="mt-1 text-micro text-l4 hover:text-l2"
                        onClick={() => setShowAllFolders(true)}
                      >
                        {visibleFolders.length === 0
                          ? `选择文件夹（${extraFolders.length}）`
                          : `其余文件夹 ${extraFolders.length}…`}
                      </button>
                    )}
                    {!showFiles && files.length > protectedFiles.length && (
                      <button
                        type="button"
                        className="mt-1 text-micro text-l4 hover:text-l2"
                        onClick={() => setShowFiles(true)}
                      >
                        文件 {files.length}…
                      </button>
                    )}
                  </>
                ))}
            </div>
          )}
          <div className="flex items-center gap-2 text-micro">
            {saved && <span className="text-ok-text">✓ 已保存</span>}
            {error && <span className="text-err-text">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
