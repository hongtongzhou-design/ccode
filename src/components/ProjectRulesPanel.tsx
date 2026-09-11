import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  effectiveProjectRules,
  projectShowsProtectedPaths,
  projectUsesSkillPool,
} from "../project-context";
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
import { Checkbox, FoldMark, MenuSelect, surfaceFieldClass } from "./PageFrame";

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
    let listed: ProjectConfigDto | null = null;
    try {
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      listed = read.config;
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
      const projectSkills = read.config.skills ?? [];
      setSkillNames(projectSkills);
      setError(null);
    } catch (reason) {
      const message = `读取项目规则失败：${String(reason)}`;
      setError(message);
      onError?.(message);
    }
    const protect =
      listed != null &&
      projectShowsProtectedPaths(
        workMode ?? listed.workMode,
        listed.steps.length,
      );
    if (!protect) {
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
  }, [onError, projectPath, workMode]);

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
  const showProtect =
    config != null && projectShowsProtectedPaths(mode, config.steps.length);
  const showSkillPool =
    config != null && projectUsesSkillPool(mode, config.steps.length);
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
  const showAllProtectFolders = showAllFolders || suggested.size === 0;
  const visibleFolders = showAllProtectFolders ? folders : featuredFolders;
  const extraFolders = showAllProtectFolders
    ? []
    : folders.filter(
        (entry) => !visibleFolders.some((item) => item.path === entry.path),
      );
  const protectedFiles = files.filter((entry) =>
    pathIsProtected(entry.path, protectedPaths),
  );
  // 文件级保护只显示「已勾的」，不平铺全部文件——文献项目根下几十个 PDF 铺出来没法看
  const summary = [
    ruleCount ? `${ruleCount}` : "默认",
    showProtect && protectedPaths.length ? `⊘${protectedPaths.length}` : null,
    showSkillPool && skillNames.length ? `✦${skillNames.length}` : null,
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
            className={`${surfaceFieldClass} resize-none overflow-hidden leading-6`}
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
                <span className="text-xs text-l3">写回时跳过</span>
                {protectedPaths.length > 0 && (
                  <span className="text-micro text-l4">{protectedPaths.length}</span>
                )}
              </button>
              {protectOpen &&
                (folders.length === 0 && files.length === 0 ? (
                  <p className="mt-1.5 text-micro text-l4">项目里还没有可勾的项。</p>
                ) : (
                  <>
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
                        其余 {extraFolders.length}…
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
                      ＋ 文件
                    </button>
                  </>
                ))}
            </div>
          )}
          {showSkillPool && (
          <div>
            <button
              type="button"
              className="flex items-center gap-1.5 text-left"
              onClick={() => setSkillsOpen((current) => !current)}
              aria-expanded={skillsOpen}
            >
              <FoldMark open={skillsOpen} />
              <span className="text-xs text-l3">技能</span>
              {skillNames.length > 0 && (
                <span className="text-micro text-l4">{skillNames.length}</span>
              )}
            </button>
            {skillsOpen && (
              <>
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
                    <div className="mt-1.5">
                      <MenuSelect
                        aria-label="从技能库添加"
                        value=""
                        placeholder="＋ 从技能库添加…"
                        onChange={(name) => {
                          if (name) toggleSkill(name, true);
                        }}
                        options={addable.map((skill) => ({
                          value: skill.name,
                          label: skill.description
                            ? `${skill.name}（${skill.description}）`
                            : skill.name,
                        }))}
                      />
                    </div>
                  );
                })()}
              </>
            )}
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
