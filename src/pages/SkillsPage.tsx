import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AGENTS } from "../types";
import { useAppStore } from "../store";
import ContextMenu from "../components/ContextMenu";
import {
  Checkbox,
  EmptyState,
  LoadingRows,
  PageFrame,
  PageHeader,
  primaryActionClass,
} from "../components/PageFrame";
import type {
  DiscoveredSkillDto,
  SkillDto,
  SkillImportResultDto,
  SkillPathDto,
  SkillUpdateDto,
} from "../types";

const SOURCE_LABEL: Record<string, string> = {
  local: "本地",
  zip: "ZIP",
  github: "GitHub",
  discovered: "发现",
};

const GITHUB_PRESETS = [
  "anthropics/skills",
  "ComposioHQ/awesome-claude-skills",
];

const field =
  "w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 把用户粘贴的 GitHub 网址/简写统一解析为 { repo, branch, subdir }：
 *  支持 owner/repo、github.com/owner/repo、https://github.com/owner/repo.git、
 *  /tree/<branch>/<subdir> 形式 */
function parseGithubInput(raw: string): {
  repo: string;
  branch: string | null;
  subdir: string | null;
} {
  let s = raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
  const parts = s.split("/").filter(Boolean);
  const repo = parts.slice(0, 2).join("/");
  let branch: string | null = null;
  let subdir: string | null = null;
  if (parts[2] === "tree" && parts.length > 3) {
    branch = parts[3];
    if (parts.length > 4) subdir = parts.slice(4).join("/");
  } else if (parts.length > 2) {
    subdir = parts.slice(2).join("/");
  }
  return { repo, branch, subdir };
}

function ImportModal({
  initialGithub,
  onClose,
  onDone,
}: {
  initialGithub?: { repo: string; branch: string; subdir: string };
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [tab, setTab] = useState<"dir" | "zip" | "github">(
    initialGithub ? "github" : "dir",
  );
  const [repo, setRepo] = useState(initialGithub?.repo ?? "");
  const [branch, setBranch] = useState(initialGithub?.branch ?? "");
  const [subdir, setSubdir] = useState(initialGithub?.subdir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SkillImportResultDto | null>(null);
  const [lastRequest, setLastRequest] = useState<{
    cmd: string;
    args: Record<string, unknown>;
  } | null>(null);
  const [renameTargets, setRenameTargets] = useState<Record<string, string>>(
    {},
  );

  function summary(value: SkillImportResultDto): string {
    const parts = [
      value.added.length ? `新增 ${value.added.length}` : "",
      value.updated.length ? `覆盖更新 ${value.updated.length}` : "",
      value.skipped.length ? `跳过 ${value.skipped.length}` : "",
      value.conflicts.length ? `冲突 ${value.conflicts.length}` : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "未发现可导入技能";
  }

  async function run(
    cmd: string,
    args: Record<string, unknown>,
    resolutions: Record<string, string> | null = null,
  ) {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<SkillImportResultDto>(cmd, {
        ...args,
        resolutions,
      });
      setLastRequest({ cmd, args });
      // 冲突「另存为」成功的技能计入 next.added，必须并入首轮新增
      const combined = result
        ? {
            added: [...new Set([...result.added, ...next.added])],
            updated: [...new Set([...result.updated, ...next.updated])],
            skipped: next.skipped.filter(
              (name) => !result.added.includes(name),
            ),
            conflicts: next.conflicts,
          }
        : next;
      setResult(combined);
      setRenameTargets(
        Object.fromEntries(
          combined.conflicts.map((conflict) => [
            conflict.name,
            renameTargets[conflict.name] ?? `${conflict.name}-copy`,
          ]),
        ),
      );
      if (combined.added.length > 0 || combined.updated.length > 0) {
        onDone(summary(combined));
      }
      if (combined.conflicts.length === 0) {
        if (combined.added.length === 0 && combined.updated.length === 0) {
          onDone(summary(combined));
        }
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflicts(action: "overwrite" | "skip" | "rename") {
    if (!lastRequest || !result) return;
    const resolutions: Record<string, string> = {};
    for (const name of result.added) resolutions[name] = "skip";
    for (const conflict of result.conflicts) {
      resolutions[conflict.name] =
        action === "rename"
          ? `rename:${(renameTargets[conflict.name] ?? "").trim()}`
          : action;
    }
    await run(lastRequest.cmd, lastRequest.args, resolutions);
  }

  async function pickDir() {
    const path = await open({ directory: true, multiple: false });
    if (!path) return;
    await run("import_skills_from_dir", { path });
  }

  async function pickZip() {
    const path = await open({
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!path) return;
    await run("import_skills_from_zip", { path });
  }

  const tabBtn = (k: typeof tab, label: string) => (
    <button
      key={k}
      onClick={() => setTab(k)}
      className={`rounded px-2.5 py-1 text-xs ${
        tab === k ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[26rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-3 text-base font-semibold text-l1">导入技能</h2>
        <div className="mb-4 flex gap-1">
          {tabBtn("dir", "本地目录")}
          {tabBtn("zip", "ZIP 文件")}
          {tabBtn("github", "GitHub 仓库")}
        </div>
        {tab === "dir" && (
          <div className="mb-4">
            <p className="mb-3 text-xs text-l3">
              选择包含技能（SKILL.md）的目录。
            </p>
            <button
              onClick={pickDir}
              disabled={busy}
              className="rounded bg-btn px-3 py-1.5 text-sm text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              选择目录…
            </button>
          </div>
        )}
        {tab === "zip" && (
          <div className="mb-4">
            <p className="mb-3 text-xs text-l3">选择技能打包的 .zip 文件。</p>
            <button
              onClick={pickZip}
              disabled={busy}
              className="rounded bg-btn px-3 py-1.5 text-sm text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              选择 ZIP…
            </button>
          </div>
        )}
        {tab === "github" && (
          <div className="mb-4">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {GITHUB_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setRepo(p)}
                  className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3 hover:text-l1"
                >
                  {p}
                </button>
              ))}
            </div>
            <label className="mb-2 block text-sm">
              <span className="mb-1 block text-xs text-l3">仓库</span>
              <input
                className={field}
                placeholder="anthropics/skills 或 https://github.com/owner/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <label className="block flex-1 text-sm">
                <span className="mb-1 block text-xs text-l3">分支（可选）</span>
                <input
                  className={field}
                  placeholder="main"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label className="block flex-1 text-sm">
                <span className="mb-1 block text-xs text-l3">
                  子目录（可选）
                </span>
                <input
                  className={field}
                  placeholder="skills/pdf"
                  value={subdir}
                  onChange={(e) => setSubdir(e.target.value)}
                />
              </label>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => {
                  const parsed = parseGithubInput(repo);
                  run("import_skills_from_github", {
                    repo: parsed.repo,
                    branch: branch.trim() || parsed.branch,
                    subdir: subdir.trim() || parsed.subdir,
                  });
                }}
                disabled={busy || !repo.trim()}
                className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "下载中…" : "导入"}
              </button>
            </div>
          </div>
        )}
        {busy && tab !== "github" && (
          <p className="mb-2 text-xs text-l3">导入中…</p>
        )}
        {result && (
          <div className="mb-3 rounded border border-field bg-inset p-3 text-xs">
            <p className="text-l2">{summary(result)}</p>
            {result.added.length > 0 && (
              <p className="mt-1 break-words text-ok-text">
                新增：{result.added.join("、")}
              </p>
            )}
            {result.updated.length > 0 && (
              <p className="mt-1 break-words text-ok-text">
                已覆盖：{result.updated.join("、")}
              </p>
            )}
            {result.skipped.length > 0 && (
              <p className="mt-1 break-words text-l3">
                已跳过：{result.skipped.join("、")}
              </p>
            )}
            {result.conflicts.length > 0 && (
              <div className="mt-2 space-y-2 border-t border-hairline pt-2">
                {result.conflicts.map((conflict) => (
                  <div
                    key={conflict.name}
                    className="grid grid-cols-[1fr_150px] items-center gap-2"
                  >
                    <span
                      className="min-w-0 truncate text-warn-text"
                      title={conflict.name}
                    >
                      {conflict.name}
                      {conflict.updateAvailable
                        ? " · GitHub 更新"
                        : " · 同名冲突"}
                    </span>
                    <input
                      value={renameTargets[conflict.name] ?? ""}
                      onChange={(event) =>
                        setRenameTargets((current) => ({
                          ...current,
                          [conflict.name]: event.target.value,
                        }))
                      }
                      aria-label={`${conflict.name} 另存为名称`}
                      className="rounded border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
                    />
                  </div>
                ))}
                <p className="text-l4">
                  覆盖会先备份旧库目录；另存为使用右侧名称。
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void resolveConflicts("skip")}
                    disabled={busy}
                    className="rounded px-2 py-1 text-l3 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
                  >
                    跳过冲突
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveConflicts("rename")}
                    disabled={
                      busy ||
                      result.conflicts.some(
                        (item) => !renameTargets[item.name]?.trim(),
                      )
                    }
                    className="rounded bg-btn px-2 py-1 text-l1 hover:bg-white/10 disabled:opacity-50"
                  >
                    全部另存为
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveConflicts("overwrite")}
                    disabled={busy}
                    className="rounded border border-cta-bd bg-cta px-2 py-1 text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    备份并覆盖
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {error && <p className="mb-2 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function DiscoverModal({
  items,
  onClose,
  onDone,
}: {
  items: DiscoveredSkillDto[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    new Set(items.map((i) => i.path)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importSelected() {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<SkillImportResultDto>("import_discovered", {
        paths: [...checked],
      });
      const conflictNote = r.conflicts.length
        ? `，${r.conflicts.length} 个与库中同名被跳过（可在「导入」中选择覆盖或另存为）`
        : "";
      onDone(`已导入 ${r.added.length} 个技能${conflictNote}`);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[28rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-3 text-base font-semibold text-l1">发现未纳管技能</h2>
        {items.length === 0 ? (
          <p className="mb-4 text-sm text-l4">
            各 agent 目录里没有发现未纳管的技能
          </p>
        ) : (
          <div className="mb-4 max-h-64 overflow-auto">
            {items.map((it) => (
              <Checkbox
                key={it.path}
                checked={checked.has(it.path)}
                onChange={(isChecked) => {
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (isChecked) next.add(it.path);
                    else next.delete(it.path);
                    return next;
                  });
                }}
                align="start"
                className="border-b border-hairline py-2 text-sm"
                label={
                  <span className="min-w-0">
                    <span className="mr-2 text-l1">{it.name}</span>
                    <span className="rounded bg-inset px-1 text-xs text-l3">
                      {it.fromAgent}
                    </span>
                    <span
                      className="block truncate text-xs text-l3"
                      title={it.description}
                    >
                      {it.description}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        )}
        {error && <p className="mb-2 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            取消
          </button>
          {items.length > 0 && (
            <button
              onClick={importSelected}
              disabled={busy || checked.size === 0}
              className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "导入中…" : `导入选中（${checked.size}）`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 编辑预填：剥掉 SKILL.md 的 frontmatter 只留正文（frontmatter 由表单字段在保存时重新生成） */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return m ? text.slice(m[0].length).replace(/^(\r?\n)+/, "") : text;
}

/** 新建/编辑技能（RX3b）：名称=目录名（编辑时锁定）、描述一句话、正文即 SKILL.md 主体。
 *  保存走后端 create_skill / update_skill_content（覆盖前自动备份旧库目录）。 */
function SkillEditorModal({
  mode,
  skill,
  initialBody,
  onClose,
  onDone,
}: {
  mode: "create" | "edit";
  skill?: SkillDto;
  initialBody?: string;
  onClose: () => void;
  /** editedId 用于保存后刷新正在展示的预览面板 */
  onDone: (msg: string, editedId?: string) => void;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(initialBody ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await invoke("create_skill", {
          name: name.trim(),
          description: description.trim(),
          content,
        });
        onDone(`已创建技能「${name.trim()}」，打开 agent 开关即可分发`);
      } else if (skill) {
        await invoke("update_skill_content", {
          name: skill.name,
          content,
          description: description.trim(),
        });
        onDone(`已保存「${skill.name}」（旧版本已自动备份）`, skill.id);
      }
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[36rem] flex-col rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-3 text-base font-semibold text-l1">
          {mode === "create" ? "新建技能" : `编辑技能：${skill?.name}`}
        </h2>
        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-xs text-l3">
            名称（即目录名，单个安全名称）
          </span>
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={mode === "edit"}
            placeholder="如 paper-notes"
          />
        </label>
        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-xs text-l3">
            描述（一句话，列表与步骤推荐里展示）
          </span>
          <input
            className={field}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个技能帮 Agent 做什么"
          />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">
            正文（SKILL.md 主体，frontmatter 由名称/描述自动生成）
          </span>
          <textarea
            className={`${field} h-56 resize-y font-mono text-xs`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="把你的工作方法写在这里：步骤、规范、注意事项……"
          />
        </label>
        {mode === "edit" && (
          <p className="mb-2 text-xs text-l4">
            保存会先备份当前版本（保留最近 5 份），SKILL.md 之外的辅助文件不受影响。
          </p>
        )}
        {error && <p className="mb-2 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || !content.trim()}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "保存中…" : mode === "create" ? "创建" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** ◈ 优化技能（RX3b）：内联收集优化意见 → 开终端标签，让 Agent 阅读并直接改写库中的 SKILL.md */
function OptimizeModal({
  skill,
  onClose,
  onConfirm,
}: {
  skill: SkillDto;
  onClose: () => void;
  onConfirm: (opinion: string) => Promise<void>;
}) {
  const [opinion, setOpinion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(opinion.trim());
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[30rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-1 text-base font-semibold text-l1">
          ◈ 优化技能：{skill.name}
        </h2>
        <p className="mb-3 text-xs text-l3">
          开终端让 Agent 阅读并按你的意见直接改写该技能的
          SKILL.md；改写结果请审查后再用，技能页的保存/覆盖都会自动备份旧版本。
        </p>
        <textarea
          autoFocus
          className={`${field} mb-3 h-24 resize-y`}
          value={opinion}
          onChange={(e) => setOpinion(e.target.value)}
          placeholder="优化意见，如：补充中文输出格式约定；把检查清单精简到 5 条"
        />
        {error && <p className="mb-2 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !opinion.trim()}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "打开中…" : "开终端优化"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SkillsPage({ visible }: { visible: boolean }) {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [catCollapsed, setCatCollapsed] = useState<Set<string>>(new Set());
  function toggleCat(cat: string) {
    setCatCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | {
        kind: "import";
        github?: { repo: string; branch: string; subdir: string };
      }
    | { kind: "discover" }
    | null
  >(null);
  const [discovered, setDiscovered] = useState<DiscoveredSkillDto[]>([]);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{
    skill: SkillDto;
    content: string;
  } | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    skill: SkillDto;
  } | null>(null);
  const [topMenu, setTopMenu] = useState<{ x: number; y: number } | null>(null);
  const [updates, setUpdates] = useState<Record<string, SkillUpdateDto>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // 技能编辑器（RX3b）：create=空白表单；edit=预填名称/描述/正文（名称锁定）
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; skill: SkillDto; body: string } | null
  >(null);
  // ◈ 优化：内联收集意见后开终端让 Agent 改写 SKILL.md
  const [optimize, setOptimize] = useState<SkillDto | null>(null);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);

  async function refresh() {
    try {
      const list = await invoke<SkillDto[]>("list_skills");
      setSkills(list);
      // 预览面板跟随最新数据（resync/分类等变化），技能消失时关闭预览
      setPreview((prev) => {
        if (!prev) return prev;
        const fresh = list.find((item) => item.id === prev.skill.id);
        return fresh ? { ...prev, skill: fresh } : null;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (visible) void refresh();
  }, [visible]);

  /** 切换某 agent 的应用开关（apply_skill），按钮级 spinner */
  async function toggleApp(skill: SkillDto, agent: string) {
    const key = `${skill.id}:${agent}`;
    if (applying[key]) return;
    setApplying((prev) => ({ ...prev, [key]: true }));
    try {
      await invoke("apply_skill", {
        id: skill.id,
        agent,
        enabled: !skill.apps[agent],
      });
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id
            ? { ...s, apps: { ...s.apps, [agent]: !s.apps[agent] } }
            : s,
        ),
      );
      // 乐观更新后拉取最新 appModes/staleCopies
      await refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying((prev) => ({ ...prev, [key]: false }));
    }
  }

  const [catEdit, setCatEdit] = useState<{ id: string; value: string } | null>(
    null,
  );
  // Enter 提交未完成时 input 失焦会触发第二次提交，用 guard 挡住
  const catSubmitting = useRef(false);

  async function submitCategory(id: string, value: string) {
    if (catSubmitting.current) return;
    catSubmitting.current = true;
    try {
      await invoke("set_skill_category", {
        id,
        category: value.trim() || null,
      }).catch((e) => setError(String(e)));
      setCatEdit(null);
      await refresh();
    } finally {
      catSubmitting.current = false;
    }
  }

  async function onView(skill: SkillDto) {
    try {
      const content = await invoke<string>("read_skill_md", { id: skill.id });
      setPreview({ skill, content });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 编辑内容：读 SKILL.md 剥掉 frontmatter 预填编辑器表单 */
  async function onEdit(skill: SkillDto) {
    try {
      const full = await invoke<string>("read_skill_md", { id: skill.id });
      setEditor({ mode: "edit", skill, body: stripFrontmatter(full) });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** ◈ 优化：以技能库目录为 cwd 开终端，预填「阅读 + 按意见优化」指令（Agent 直接改写库文件） */
  async function confirmOptimize(skill: SkillDto, opinion: string) {
    const target = await invoke<SkillPathDto>("skill_md_path", { id: skill.id });
    setPendingTerminal({
      cwd: target.dir,
      extraEnv: {},
      title: `优化技能 ${skill.name}`,
      initialPrompt: `阅读 ${target.mdPath}，按以下意见优化它：\n${opinion}`,
    });
    setPage("terminal");
  }

  /** 副本过期：把库里的最新版本重新分发到漂移的 agent 副本 */
  async function onResync(skill: SkillDto) {
    try {
      const agents = await invoke<string[]>("resync_skill_copies", {
        id: skill.id,
      });
      setNotice(agents.length ? `已同步：${agents.join("、")}` : "副本已同步");
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(skill: SkillDto) {
    if (
      !window.confirm(
        `将删除技能「${skill.name}」并同步从各 agent 移除（库文件自动备份）。继续？`,
      )
    )
      return;
    try {
      await invoke("delete_skill", { id: skill.id });
      if (preview?.skill.id === skill.id) setPreview(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onExport(ids: string[], defaultName: string) {
    try {
      const destPath = await save({
        defaultPath: defaultName,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!destPath) return;
      const out = await invoke<string>("export_skills", { ids, destPath });
      setNotice(`已导出：${out}`);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDiscover() {
    try {
      const items = await invoke<DiscoveredSkillDto[]>("discover_unmanaged");
      setDiscovered(items);
      setModal({ kind: "discover" });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onCheckUpdates() {
    setCheckingUpdates(true);
    setNotice("正在检查 GitHub 更新…");
    try {
      const items = await invoke<SkillUpdateDto[]>("check_skill_updates");
      setUpdates(Object.fromEntries(items.map((item) => [item.id, item])));
      setNotice(
        items.length ? "GitHub 技能更新检查完成" : "没有可检查的 GitHub 技能",
      );
      setError(null);
    } catch (reason) {
      setNotice(null);
      setError(String(reason));
    } finally {
      setCheckingUpdates(false);
    }
  }

  const appliedCount = skills.filter((s) =>
    Object.values(s.apps).some(Boolean),
  ).length;

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <PageFrame width="wide">
          <PageHeader
            title="技能"
            meta={`${skills.length} 个技能 · ${appliedCount} 个已应用`}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setEditor({ mode: "create" })}
                  className={primaryActionClass}
                >
                  + 新建技能
                </button>
                <button
                  type="button"
                  onClick={() => setModal({ kind: "import" })}
                  className="rounded bg-btn px-3 py-1.5 text-sm text-l1 hover:bg-white/10"
                >
                  + 导入
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTopMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                  }}
                  title="更多技能操作"
                  aria-label="更多技能操作"
                  className="flex h-8 w-8 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
                >
                  ⋯
                </button>
              </>
            }
          />
          {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
          {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}
          {loading ? (
            <LoadingRows />
          ) : skills.length === 0 ? (
            <EmptyState
              title="还没有技能"
              detail="导入现有技能，或把自己的研究方法新建为可复用技能。"
              action={
                <button
                  type="button"
                  onClick={() => setModal({ kind: "import" })}
                  className={primaryActionClass}
                >
                  导入技能
                </button>
              }
            />
          ) : (
            <div className="mt-4 overflow-hidden rounded-md border border-hairline bg-canvas">
              <div>
                <div className="sticky top-0 z-10 grid grid-cols-[minmax(220px,1fr)_92px_120px_36px] items-center gap-3 border-b border-hairline bg-strip px-3 py-2 text-xs text-l4">
                  <span>技能</span>
                  <span>来源</span>
                  <span>应用</span>
                  <span />
                </div>
                {[
                  ...new Set(skills.map((skill) => skill.category ?? "未分类")),
                ].map((category) => {
                  const categorySkills = skills.filter(
                    (skill) => (skill.category ?? "未分类") === category,
                  );
                  return (
                    <section key={category}>
                      <button
                        type="button"
                        onClick={() => toggleCat(category)}
                        aria-label={
                          catCollapsed.has(category) ? "展开" : "收起"
                        }
                        className="flex h-9 w-full items-center gap-1.5 border-b border-hairline bg-canvas px-2 text-xs font-medium text-l3 hover:bg-white/5 hover:text-l1"
                      >
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded text-l4 hover:bg-white/5">
                          {catCollapsed.has(category) ? "▸" : "▾"}
                        </span>
                        {category}
                        <span className="text-l4">{categorySkills.length}</span>
                      </button>
                      {!catCollapsed.has(category) && (
                        <ul className="divide-y divide-hairline">
                          {categorySkills.map((skill) => {
                            const stale = (skill.staleCopies ?? []).length > 0;
                            const update = updates[skill.id];
                            return (
                              <li
                                key={skill.id}
                                onClick={() => void onView(skill)}
                                className={`grid min-h-16 cursor-pointer grid-cols-[minmax(220px,1fr)_92px_120px_36px] items-center gap-3 px-3 transition-colors hover:bg-white/5 ${
                                  preview?.skill.id === skill.id
                                    ? "bg-inset"
                                    : ""
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="flex min-w-0 items-center gap-1.5">
                                    <span className="min-w-0 truncate text-[15px] font-medium text-l1">
                                      {skill.name}
                                    </span>
                                    {stale && (
                                      <span
                                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warnb"
                                        title={`副本过期：${(skill.staleCopies ?? []).join("、")}`}
                                      />
                                    )}
                                    {update?.updateAvailable && (
                                      <span
                                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warnb"
                                        title={update.message}
                                      />
                                    )}
                                  </div>
                                  {catEdit?.id === skill.id ? (
                                    <input
                                      autoFocus
                                      onClick={(event) => event.stopPropagation()}
                                      value={catEdit.value}
                                      onChange={(event) =>
                                        setCatEdit({
                                          id: skill.id,
                                          value: event.target.value,
                                        })
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                          void submitCategory(
                                            skill.id,
                                            catEdit.value,
                                          );
                                        if (event.key === "Escape")
                                          setCatEdit(null);
                                      }}
                                      onBlur={() =>
                                        void submitCategory(
                                          skill.id,
                                          catEdit.value,
                                        )
                                      }
                                      placeholder="分类名（留空=未分类）"
                                      className="mt-1 w-full rounded border border-field bg-canvas px-1.5 py-0.5 text-xs text-l2 outline-none"
                                    />
                                  ) : (
                                    <p
                                      className="mt-0.5 truncate text-[13px] text-l3"
                                      title={skill.description}
                                    >
                                      {skill.description}
                                    </p>
                                  )}
                                </div>
                                <span className="truncate text-xs text-l3">
                                  {SOURCE_LABEL[skill.source] ?? skill.source}
                                </span>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void onView(skill);
                                  }}
                                  className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs text-l2 hover:bg-seg-sel hover:text-l1"
                                  title="在右侧管理该技能应用到哪些 Agent"
                                >
                                  <span
                                    className={`size-1.5 shrink-0 rounded-full ${
                                      Object.values(skill.apps).some(Boolean)
                                        ? "bg-ok-text"
                                        : "bg-l4"
                                    }`}
                                  />
                                  {Object.values(skill.apps).filter(Boolean).length}/
                                  {AGENTS.length} 个 Agent
                                </button>
                                <div className="flex items-center justify-end">
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      const rect =
                                        event.currentTarget.getBoundingClientRect();
                                      setRowMenu({
                                        x: rect.right - 176,
                                        y: rect.bottom + 4,
                                        skill,
                                      });
                                    }}
                                    aria-label={`${skill.name} 更多操作`}
                                    className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
                                  >
                                    ⋯
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </PageFrame>
      </div>

      {/* SKILL.md 预览面板 */}
      {preview && (
        <div className="flex w-[clamp(360px,34vw,460px)] shrink-0 flex-col border-l border-hairline bg-canvas">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3">
            <span className="truncate text-[15px] font-medium text-l1">
              {preview.skill.name}
            </span>
            <button
              onClick={() => setPreview(null)}
              title="关闭预览"
              aria-label="关闭预览"
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l1"
            >
              ×
            </button>
          </div>
          <div className="shrink-0 border-b border-hairline px-3 py-2.5 text-[13px] text-l3">
            <span>
              {SOURCE_LABEL[preview.skill.source] ?? preview.skill.source}
            </span>
            {preview.skill.repo && (
              <span
                className="ml-2 font-mono text-l2"
                title={preview.skill.repo}
              >
                {preview.skill.repo}
              </span>
            )}
            {(preview.skill.staleCopies ?? []).length > 0 && (
              <span
                className="ml-2 text-warn-text"
                title={`副本过期：${(preview.skill.staleCopies ?? []).join("、")}`}
              >
                副本需同步
              </span>
            )}
            {updates[preview.skill.id]?.updateAvailable && (
              <span
                className="ml-2 text-warn-text"
                title={updates[preview.skill.id].message}
              >
                GitHub 可更新
              </span>
            )}
          </div>
          <div className="shrink-0 border-b border-hairline bg-strip px-3 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-medium text-l2">
                应用到 Agent
              </span>
              <span className="ml-auto text-xs text-l4">
                {Object.values(preview.skill.apps).filter(Boolean).length}/
                {AGENTS.length}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {AGENTS.map((agent) => {
                const enabled = !!preview.skill.apps[agent.id];
                const key = `${preview.skill.id}:${agent.id}`;
                const mode = enabled
                  ? (preview.skill.appModes ?? {})[agent.id]
                  : undefined;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => void toggleApp(preview.skill, agent.id)}
                    disabled={applying[key]}
                    title={
                      enabled
                        ? `${mode === "copy" ? "copy（有漂移检测）" : "symlink"}；点击取消应用`
                        : `应用到 ${agent.label}`
                    }
                    className={`flex h-9 items-center gap-2 rounded-md border px-2 text-[13px] transition-colors disabled:opacity-50 ${
                      enabled
                        ? "border-cta-bd bg-inset text-l1"
                        : "border-hairline bg-canvas text-l3 hover:bg-inset hover:text-l1"
                    }`}
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        enabled ? "bg-ok-text" : "bg-l4"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {agent.label}
                    </span>
                    {applying[key] && <span className="text-l4">…</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="mb-3 text-xs font-medium tracking-wide text-l4">
              SKILL.md
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[13px] leading-6 text-l2">
              {preview.content}
            </pre>
          </div>
        </div>
      )}

      {editor && (
        <SkillEditorModal
          mode={editor.mode}
          skill={editor.mode === "edit" ? editor.skill : undefined}
          initialBody={editor.mode === "edit" ? editor.body : undefined}
          onClose={() => setEditor(null)}
          onDone={(msg, editedId) => {
            setNotice(msg);
            // 正在预览的技能被编辑后，面板内容同步刷新
            if (editedId && preview?.skill.id === editedId) {
              void onView(preview.skill);
            }
            void refresh();
          }}
        />
      )}
      {optimize && (
        <OptimizeModal
          skill={optimize}
          onClose={() => setOptimize(null)}
          onConfirm={(opinion) => confirmOptimize(optimize, opinion)}
        />
      )}
      {modal?.kind === "import" && (
        <ImportModal
          initialGithub={modal.github}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            setNotice(msg);
            void refresh();
          }}
        />
      )}
      {modal?.kind === "discover" && (
        <DiscoverModal
          items={discovered}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            setNotice(msg);
            void refresh();
          }}
        />
      )}
      {topMenu && (
        <ContextMenu
          x={topMenu.x}
          y={topMenu.y}
          onClose={() => setTopMenu(null)}
          items={[
            ...(skills.length
              ? [
                  {
                    label: "导出全部 ZIP",
                    onSelect: () =>
                      void onExport(
                        skills.map((skill) => skill.id),
                        "ccode-skills.zip",
                      ),
                  },
                ]
              : []),
            { label: "发现未纳管技能", onSelect: () => void onDiscover() },
            {
              label: checkingUpdates
                ? "正在检查 GitHub 更新…"
                : "检查 GitHub 更新",
              onSelect: () => {
                if (!checkingUpdates) void onCheckUpdates();
              },
            },
          ]}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            { label: "查看详情", onSelect: () => void onView(rowMenu.skill) },
            {
              label: "编辑内容",
              onSelect: () => void onEdit(rowMenu.skill),
            },
            {
              label: "◈ 优化",
              onSelect: () => setOptimize(rowMenu.skill),
            },
            {
              label: "设置分类",
              onSelect: () =>
                setCatEdit({
                  id: rowMenu.skill.id,
                  value: rowMenu.skill.category ?? "",
                }),
            },
            ...((rowMenu.skill.staleCopies ?? []).length > 0
              ? [
                  {
                    label: "重新分发副本",
                    onSelect: () => void onResync(rowMenu.skill),
                  },
                ]
              : []),
            {
              label: "导出 ZIP",
              onSelect: () =>
                void onExport([rowMenu.skill.id], `${rowMenu.skill.name}.zip`),
            },
            ...(rowMenu.skill.repo
              ? [
                  {
                    label: updates[rowMenu.skill.id]?.updateAvailable
                      ? "导入 GitHub 更新"
                      : "重新从 GitHub 导入",
                    onSelect: () =>
                      setModal({
                        kind: "import",
                        github: {
                          repo: rowMenu.skill.repo!,
                          branch: rowMenu.skill.repoRef ?? "",
                          subdir: rowMenu.skill.repoSubdir ?? "",
                        },
                      }),
                  },
                ]
              : []),
            { label: "删除", onSelect: () => void onDelete(rowMenu.skill) },
          ]}
        />
      )}
    </div>
  );
}
