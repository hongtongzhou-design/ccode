import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { effectiveProjectRules } from "../project-context";
import {
  pathIsProtected,
  protectableEntries,
  relativeProjectPath,
  suggestProtectedPaths,
  toggleProtectedFolder,
  type ProtectEntry,
} from "../project-tasks";
import { normalizeWorkMode } from "../work-mode";
import type { DirEntryDto } from "./FileTree";
import type { ProjectConfigDto, ProjectConfigReadDto, SkillDto } from "../types";
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
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [librarySkills, setLibrarySkills] = useState<SkillDto[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
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
      const projectSkills = read.config.skills ?? [];
      setSkillNames(projectSkills);
      if (projectSkills.length > 0) setSkillsOpen(true);
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
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((skills) => {
        if (!stale) setLibrarySkills(skills);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

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

  async function save(nextRules: string, nextProtected: string[], nextSkills: string[]) {
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
          skills: nextSkills,
        },
      });
      setConfig({
        ...latest.config,
        settings: rules,
        rulesOwned: true,
        protectedPaths: nextProtected,
        skills: nextSkills,
      });
      setProtectedPaths(nextProtected);
      setSkillNames(nextSkills);
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
    void save(rulesDraft, next, skillNames);
  }

  function toggleSkill(name: string, checked: boolean) {
    const next = checked
      ? [...skillNames, name]
      : skillNames.filter((item) => item !== name);
    setSkillNames(next);
    void save(rulesDraft, protectedPaths, next);
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
  // 文件级保护只显示「已勾的」，不平铺全部文件——文献项目根下几十个 PDF 铺出来没法看
  const summary = [
    ruleCount ? `${ruleCount}` : "默认",
    showProtect && protectedPaths.length ? `⊘${protectedPaths.length}` : null,
    skillNames.length ? `✦${skillNames.length}` : null,
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
            onBlur={() => void save(rulesDraft, protectedPaths, skillNames)}
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
                    <p className="mt-1.5 text-micro text-l4">
                      长期保护：验收写回时不改这些路径。（单次任务给 Agent
                      看什么，在新建目标的「资料」里选，那是另一回事。）
                    </p>
                    {visibleFolders.length > 0 && (
                    <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {visibleFolders.map(renderProtectRow)}
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
                    {protectedFiles.length > 0 && (
                      <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
                        {protectedFiles.map(renderProtectRow)}
                      </ul>
                    )}
                    <button
                      type="button"
                      className="mt-1.5 text-micro text-l4 hover:text-l2"
                      onClick={() => {
                        void (async () => {
                          const picked = await openFileDialog({
                            multiple: true,
                            directory: false,
                            defaultPath: projectPath,
                          });
                          if (!picked) return;
                          const list = Array.isArray(picked) ? picked : [picked];
                          const next = [...protectedPaths];
                          for (const abs of list) {
                            const rel = relativeProjectPath(projectPath, abs);
                            // 项目外/解析不出相对路径的跳过，不写非法保护项
                            if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) continue;
                            if (!pathIsProtected(rel, next)) next.push(rel);
                          }
                          if (next.length !== protectedPaths.length) {
                            setProtectedPaths(next);
                            void save(rulesDraft, next, skillNames);
                          }
                        })();
                      }}
                    >
                      ＋ 选择文件添加保护…
                    </button>
                  </>
                ))}
            </div>
          )}
          <div>
            <button
              type="button"
              className="flex items-center gap-1.5 text-left"
              onClick={() => setSkillsOpen((current) => !current)}
              aria-expanded={skillsOpen}
            >
              <FoldMark open={skillsOpen} />
              <span className="text-xs text-l3">项目技能池</span>
              {skillNames.length > 0 && (
                <span className="text-micro text-l4">{skillNames.length}</span>
              )}
            </button>
            {skillsOpen && (
              <>
                <p className="mt-1 text-micro text-l4">
                  从技能库添加进来、新建目标时可以点名。添加 ≠ 启用——池子里的技能默认都不用。
                </p>
                {skillNames.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                    {skillNames.map((name) => (
                      <li
                        key={name}
                        className="inline-flex h-7 items-center gap-1 rounded-full bg-strip px-2.5 text-xs text-l2"
                      >
                        {name}
                        <button
                          type="button"
                          className="text-l4 hover:text-err-text"
                          aria-label={`移出 ${name}`}
                          onClick={() => toggleSkill(name, false)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {(() => {
                  const addable = librarySkills.filter(
                    (skill) => !skillNames.includes(skill.name),
                  );
                  if (librarySkills.length === 0) {
                    return (
                      <p className="mt-1.5 text-micro text-l4">
                        技能库里还没有技能，先到技能页新建或导入。
                      </p>
                    );
                  }
                  if (addable.length === 0) return null;
                  return (
                    <select
                      className={`${fieldClass} mt-1.5 text-xs`}
                      value=""
                      onChange={(event) => {
                        const name = event.target.value;
                        if (name) toggleSkill(name, true);
                      }}
                      aria-label="从技能库添加"
                    >
                      <option value="">＋ 从技能库添加…</option>
                      {addable.map((skill) => (
                        <option key={skill.id} value={skill.name}>
                          {skill.name}
                          {skill.description ? `（${skill.description}）` : ""}
                        </option>
                      ))}
                    </select>
                  );
                })()}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-micro">
            {saved && <span className="text-ok-text">✓ 已保存</span>}
            {error && <span className="text-err-text">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
