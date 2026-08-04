import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AGENTS } from "../types";
import ContextMenu from "../components/ContextMenu";
import { Checkbox, PageFrame, PageHeader, primaryActionClass } from "../components/PageFrame";
import type {
  DiscoveredSkillDto,
  SkillDto,
  SkillImportResultDto,
  SkillUpdateDto,
} from "../types";

/** 行内开关的短标签（六 agent 顺序与全局 AGENTS 一致） */
const AGENT_SHORT: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  qwen: "qwen",
  opencode: "oc",
  kimi: "kimi",
};

const SOURCE_LABEL: Record<string, string> = {
  local: "本地",
  zip: "ZIP",
  github: "GitHub",
  discovered: "发现",
};

const GITHUB_PRESETS = ["anthropics/skills", "ComposioHQ/awesome-claude-skills"];

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
  let s = raw.trim().replace(/\/+$/, "").replace(/\.git$/, "");
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
  const [renameTargets, setRenameTargets] = useState<Record<string, string>>({});

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
      const next = await invoke<SkillImportResultDto>(cmd, { ...args, resolutions });
      setLastRequest({ cmd, args });
      const combined = result
        ? {
            added: result.added,
            updated: [...new Set([...result.updated, ...next.updated])],
            skipped: next.skipped.filter((name) => !result.added.includes(name)),
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
            <p className="mb-3 text-xs text-l3">选择包含技能（SKILL.md）的目录。</p>
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
                <span className="mb-1 block text-xs text-l3">子目录（可选）</span>
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
        {busy && tab !== "github" && <p className="mb-2 text-xs text-l3">导入中…</p>}
        {result && (
          <div className="mb-3 rounded border border-field bg-inset p-3 text-xs">
            <p className="text-l2">{summary(result)}</p>
            {result.added.length > 0 && (
              <p className="mt-1 break-words text-ok-text">新增：{result.added.join("、")}</p>
            )}
            {result.updated.length > 0 && (
              <p className="mt-1 break-words text-ok-text">已覆盖：{result.updated.join("、")}</p>
            )}
            {result.conflicts.length > 0 && (
              <div className="mt-2 space-y-2 border-t border-hairline pt-2">
                {result.conflicts.map((conflict) => (
                  <div key={conflict.name} className="grid grid-cols-[1fr_150px] items-center gap-2">
                    <span className="min-w-0 truncate text-warn-text" title={conflict.name}>
                      {conflict.name}
                      {conflict.updateAvailable ? " · GitHub 更新" : " · 同名冲突"}
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
                <p className="text-l4">覆盖会先备份旧库目录；另存为使用右侧名称。</p>
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
                    disabled={busy || result.conflicts.some((item) => !renameTargets[item.name]?.trim())}
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
  const [checked, setChecked] = useState<Set<string>>(new Set(items.map((i) => i.path)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importSelected() {
    setBusy(true);
    setError(null);
    try {
      const n = await invoke<number>("import_discovered", {
        paths: [...checked],
      });
      onDone(`已导入 ${n} 个技能`);
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
          <p className="mb-4 text-sm text-l4">各 agent 目录里没有发现未纳管的技能</p>
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
                label={<span className="min-w-0">
                  <span className="mr-2 text-l1">{it.name}</span>
                  <span className="rounded bg-inset px-1 text-xs text-l3">
                    {it.fromAgent}
                  </span>
                  <span className="block truncate text-xs text-l3" title={it.description}>
                    {it.description}
                  </span>
                </span>}
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

export default function SkillsPage({ visible }: { visible: boolean }) {
  const [skills, setSkills] = useState<SkillDto[]>([]);
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
    | { kind: "import"; github?: { repo: string; branch: string; subdir: string } }
    | { kind: "discover" }
    | null
  >(null);
  const [discovered, setDiscovered] = useState<DiscoveredSkillDto[]>([]);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{ id: string; name: string; content: string } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; skill: SkillDto } | null>(null);
  const [updates, setUpdates] = useState<Record<string, SkillUpdateDto>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  async function refresh() {
    try {
      setSkills(await invoke<SkillDto[]>("list_skills"));
      setError(null);
    } catch (e) {
      setError(String(e));
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
      await invoke("apply_skill", { id: skill.id, agent, enabled: !skill.apps[agent] });
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id ? { ...s, apps: { ...s.apps, [agent]: !s.apps[agent] } } : s,
        ),
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying((prev) => ({ ...prev, [key]: false }));
    }
  }

  const [catEdit, setCatEdit] = useState<{ id: string; value: string } | null>(null);

  async function submitCategory(id: string, value: string) {
    await invoke("set_skill_category", {
      id,
      category: value.trim() || null,
    }).catch((e) => setError(String(e)));
    setCatEdit(null);
    await refresh();
  }

  async function onView(skill: SkillDto) {
    try {
      const content = await invoke<string>("read_skill_md", { id: skill.id });
      setPreview({ id: skill.id, name: skill.name, content });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 副本过期：把库里的最新版本重新分发到漂移的 agent 副本 */
  async function onResync(skill: SkillDto) {
    try {
      const agents = await invoke<string[]>("resync_skill_copies", { id: skill.id });
      setNotice(`已同步: ${agents.join(", ")}`);
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
      if (preview?.id === skill.id) setPreview(null);
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
    try {
      const items = await invoke<SkillUpdateDto[]>("check_skill_updates");
      setUpdates(Object.fromEntries(items.map((item) => [item.id, item])));
      setNotice(items.length ? "GitHub 技能更新检查完成" : "没有可检查的 GitHub 技能");
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCheckingUpdates(false);
    }
  }

  const appliedCount = skills.filter((s) => Object.values(s.apps).some(Boolean)).length;
  const ghostBtn = "rounded px-2 py-1 text-sm text-l2 hover:bg-white/5";

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <PageFrame width="standard">
          <PageHeader
            title="技能"
            meta={`${skills.length} 个技能 · ${appliedCount} 个已应用`}
            actions={
              <>
              <button onClick={() => setModal({ kind: "import" })} className={primaryActionClass}>
                + 导入
              </button>
              <button
                onClick={() => onExport(skills.map((s) => s.id), "ccode-skills.zip")}
                disabled={skills.length === 0}
                className={`${ghostBtn} disabled:opacity-50`}
              >
                导出
              </button>
              <button onClick={onDiscover} className={ghostBtn}>
                发现未纳管
              </button>
              <button
                onClick={() => void onCheckUpdates()}
                disabled={checkingUpdates}
                className={`${ghostBtn} disabled:opacity-50`}
              >
                {checkingUpdates ? "检查中…" : "检查 GitHub 更新"}
              </button>
              </>
            }
          />
          {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
          {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}
          {skills.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-l2">还没有技能</p>
              <button
                onClick={() => setModal({ kind: "import" })}
                className="mt-3 text-sm text-cta hover:brightness-125"
              >
                导入第一个技能
              </button>
            </div>
          ) : (
            [...new Set(skills.map((s) => s.category ?? "未分类"))].map((cat) => (
              <div key={cat}>
                <button
                  onClick={() => toggleCat(cat)}
                  aria-label={catCollapsed.has(cat) ? "展开" : "收起"}
                  className="mt-4 mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-l3 hover:text-l1"
                >
                  {/* 点击区 ≥28px（h-7 w-7），同 ProfilesPage 折叠按钮 */}
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded text-l4 hover:bg-white/5">
                    {catCollapsed.has(cat) ? "▸" : "▾"}
                  </span>
                  {cat}
                  <span className="text-l4">
                    {skills.filter((s) => (s.category ?? "未分类") === cat).length}
                  </span>
                </button>
                <ul className={`divide-y divide-hairline ${catCollapsed.has(cat) ? "hidden" : ""}`}>
                  {skills
                    .filter((s) => (s.category ?? "未分类") === cat)
                    .map((s) => (
                <li key={s.id} className="py-2.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 font-medium text-l1">{s.name}</span>
                    <span
                      className="min-w-0 truncate text-xs text-l2"
                      title={s.description}
                    >
                      {s.description}
                    </span>
                    <span
                      className="shrink-0 rounded bg-inset px-1.5 py-0.5 text-xs text-l3"
                      title={s.repo ?? s.source}
                    >
                      {SOURCE_LABEL[s.source] ?? s.source}
                      {s.repo ? ` · ${s.repo}` : ""}
                    </span>
                    {(s.staleCopies ?? []).length > 0 && (
                      <>
                        <span
                          className="shrink-0 rounded bg-warn px-1.5 py-0.5 text-xs text-warn-text"
                          title={`以下 agent 的副本内容已过期：${(s.staleCopies ?? []).join(", ")}`}
                        >
                          副本过期
                        </span>
                        <button
                          onClick={() => onResync(s)}
                          title="把库里的最新版本重新分发到这些 agent"
                          className="shrink-0 rounded px-2 py-0.5 text-xs text-l2 hover:text-l1"
                        >
                          重新分发
                        </button>
                      </>
                    )}
                    {updates[s.id] && (
                      <span
                        className={`shrink-0 rounded bg-inset px-1.5 py-0.5 text-xs ${
                          updates[s.id].updateAvailable ? "text-warn-text" : "text-l3"
                        }`}
                        title={updates[s.id].message}
                      >
                        {updates[s.id].updateAvailable ? "GitHub 可更新" : "GitHub 已最新"}
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {catEdit?.id === s.id ? (
                        <input
                          autoFocus
                          value={catEdit.value}
                          onChange={(e) => setCatEdit({ id: s.id, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void submitCategory(s.id, catEdit.value);
                            if (e.key === "Escape") setCatEdit(null);
                          }}
                          onBlur={() => void submitCategory(s.id, catEdit.value)}
                          placeholder="分类名（留空=未分类）"
                          className="w-28 rounded border border-field bg-canvas px-1.5 py-0.5 text-xs text-l2 outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => setCatEdit({ id: s.id, value: s.category ?? "" })}
                          title="设置该技能的分类"
                          className="rounded px-2 py-0.5 text-xs text-l3 hover:text-l1"
                        >
                          分类: {s.category ?? "未分类"}
                        </button>
                      )}
                      <button onClick={() => onView(s)} className="rounded px-2 py-0.5 text-xs text-l2 hover:text-l1">
                        查看
                      </button>
                      <button
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setRowMenu({ x: r.right, y: r.bottom + 4, skill: s });
                        }}
                        aria-label={`${s.name} 更多操作`}
                        className="flex h-7 w-7 items-center justify-center rounded text-l3 hover:bg-white/5 hover:text-l1"
                      >
                        ⋯
                      </button>
                    </span>
                  </div>
                  {/* 六 agent 应用开关 */}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {AGENTS.map((a) => {
                      const on = !!s.apps[a.id];
                      const key = `${s.id}:${a.id}`;
                      const mode = on ? (s.appModes ?? {})[a.id] : undefined;
                      return (
                        <button
                          key={a.id}
                          onClick={() => toggleApp(s, a.id)}
                          disabled={applying[key]}
                          title={
                            on
                              ? `已分发到 ${a.label}：${mode === "copy" ? "copy（有漂移检测）" : "symlink"}；点击取消`
                              : `应用到 ${a.label}`
                          }
                          className={`min-w-12 rounded px-1.5 py-0.5 text-[11px] disabled:opacity-50 ${
                            on
                              ? "bg-ok text-ok-text"
                              : "bg-inset text-l3 hover:text-l1"
                          }`}
                        >
                          {applying[key] ? "…" : AGENT_SHORT[a.id] ?? a.id}
                          {on && mode && (
                            <span className="ml-0.5 opacity-70">
                              {mode === "copy" ? "·c" : "·s"}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                    </li>
                    ))}
                </ul>
              </div>
            ))
          )}
        </PageFrame>
      </div>

      {/* SKILL.md 预览面板 */}
      {preview && (
        <div className="flex w-[420px] shrink-0 flex-col border-l border-hairline bg-canvas">
          <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-2">
            <span className="truncate text-sm font-medium text-l1">{preview.name}</span>
            <span className="text-xs text-l3">SKILL.md</span>
            <button
              onClick={() => setPreview(null)}
              title="关闭预览"
              aria-label="关闭预览"
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l1"
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-l2">
              {preview.content}
            </pre>
          </div>
        </div>
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
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              label: "导出 ZIP",
              onSelect: () => void onExport([rowMenu.skill.id], `${rowMenu.skill.name}.zip`),
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
