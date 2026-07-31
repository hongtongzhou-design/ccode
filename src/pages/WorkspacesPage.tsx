import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import ContextMenu from "../components/ContextMenu";
import type { RepoDto, RunScriptDto, WorkspaceDto, WorkspaceHealthDto, WsSettingsDto } from "../types";

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
function sanitizeBranch(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** 工作区 → 终端的交接：取端口段 env，交给终端页开新标签 */
function useOpenInTerminal() {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  return async (ws: WorkspaceDto) => {
    const pairs = await invoke<[string, string][]>("workspace_env_for", {
      worktreePath: ws.worktreePath,
    });
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: Object.fromEntries(pairs),
      title: ws.name,
    });
    setPage("terminal");
  };
}

const field =
  "w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

function NewWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (ws: WorkspaceDto) => void;
}) {
  const [repoOptions, setRepoOptions] = useState<RepoDto[]>([]);
  const [repoChoice, setRepoChoice] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 候选仓库：后端聚合的会话目录，已过滤为真实存在的 git 仓库（排除 home 与 worktree 路径）
  useEffect(() => {
    invoke<RepoDto[]>("list_repos")
      .then((repos) => {
        setRepoOptions(repos);
        setRepoChoice((c) => c || repos[0]?.path || "__custom__");
      })
      .catch(() => setRepoChoice("__custom__"));
  }, []);

  const repoPath = repoChoice === "__custom__" ? customPath.trim() : repoChoice;
  const branch = `ccode/${sanitizeBranch(name)}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const ws = await invoke<WorkspaceDto>("create_workspace", {
        repoPath,
        name: name.trim(),
      });
      onCreated(ws);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[26rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">新建工作区</h2>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">仓库</span>
          <select
            className={field}
            value={repoChoice}
            onChange={(e) => setRepoChoice(e.target.value)}
          >
            {repoOptions.map((r) => (
              <option key={r.path} value={r.path} title={r.path}>
                {r.name}（{r.path}）
              </option>
            ))}
            <option value="__custom__">其他目录…</option>
          </select>
        </label>
        {repoChoice === "__custom__" && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">仓库路径</span>
            <input
              className={field}
              required
              placeholder="~/work/myproject"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
            />
          </label>
        )}
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">任务名</span>
          <input
            className={field}
            required
            placeholder="如 fix-login"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {name.trim() && (
            <span className="mt-1 block font-mono text-xs text-l4">
              分支：{branch}
            </span>
          )}
        </label>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={creating || !name.trim() || !repoPath}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PrModal({ ws, onClose }: { ws: WorkspaceDto; onClose: () => void }) {
  const [title, setTitle] = useState(ws.name);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const url = await invoke<string>("create_pr", {
        id: ws.id,
        title: title.trim(),
        body: body.trim() || null,
      });
      setPrUrl(url);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[26rem] rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">
          创建 PR（{ws.branch} → {ws.baseBranch}）
        </h2>
        {prUrl ? (
          <div className="mb-4">
            <p className="mb-2 text-sm text-ok-text">✓ PR 已创建</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void openUrl(prUrl)}
                title={prUrl}
                className="truncate text-sm text-l1 underline decoration-l4 underline-offset-2 hover:decoration-l1"
              >
                {prUrl}
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(prUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="shrink-0 rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5"
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-xs text-l3">标题</span>
              <input
                className={field}
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="mb-4 block text-sm">
              <span className="mb-1 block text-xs text-l3">描述</span>
              <textarea
                className={`${field} h-20`}
                placeholder="留空自动生成提交摘要"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
          </>
        )}
        <div className="flex justify-end gap-2">
          {prUrl ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
            >
              关闭
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy || !title.trim()}
                className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "创建中…" : "创建 PR"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

export default function WorkspacesPage({ visible }: { visible: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [settings, setSettings] = useState<Record<string, WsSettingsDto>>({});
  const [health, setHealth] = useState<Record<string, WorkspaceHealthDto>>({});
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [created, setCreated] = useState<WorkspaceDto | null>(null);
  const [runMenu, setRunMenu] = useState<{ x: number; y: number; ws: WorkspaceDto } | null>(null);
  const [mergeResults, setMergeResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [prModal, setPrModal] = useState<WorkspaceDto | null>(null);
  const openInTerminal = useOpenInTerminal();
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const runningScripts = useAppStore((s) => s.runningScripts);

  async function refresh() {
    try {
      const list = await invoke<WorkspaceDto[]>("list_workspaces");
      setWorkspaces(list);
      // 活跃工作区所在仓库的 settings（按 repoPath 缓存，不重复拉取）
      const repos = [
        ...new Set(list.filter((w) => w.status === "active").map((w) => w.repoPath)),
      ];
      const entries = await Promise.all(
        repos.map(async (r) => {
          try {
            return [r, await invoke<WsSettingsDto>("workspace_settings", { repoPath: r })] as const;
          } catch {
            return null; // 无 settings.toml / 读取失败的仓库静默跳过
          }
        }),
      );
      setSettings((prev) => {
        const next = { ...prev };
        for (const e of entries) {
          // 每次刷新无条件覆盖：settings.toml 新建/修改后回到本页即生效
          if (e) next[e[0]] = e[1];
        }
        return next;
      });
      // 活跃工作区的健康度（每次刷新覆盖，ReadyToMerge 判定随提交/合并变化）
      const activeIds = list.filter((w) => w.status === "active").map((w) => w.id);
      const healthEntries = await Promise.all(
        activeIds.map(async (id) => {
          try {
            return [id, await invoke<WorkspaceHealthDto>("workspace_health", { id })] as const;
          } catch {
            return null;
          }
        }),
      );
      setHealth((prev) => {
        const next = { ...prev };
        for (const e of healthEntries) {
          if (e) next[e[0]] = e[1];
        }
        return next;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 合并回 base 并归档：输出显示在行内结果条（可关闭） */
  async function onMerge(ws: WorkspaceDto) {
    if (
      !window.confirm(
        `将把 ${ws.branch} 合并进 ${ws.baseBranch} 并归档工作区（worktree 将被移除）。继续？`,
      )
    )
      return;
    try {
      const out = await invoke<string>("merge_workspace", { id: ws.id });
      setMergeResults((prev) => ({ ...prev, [ws.id]: { ok: true, text: out } }));
      await refresh();
    } catch (e) {
      setMergeResults((prev) => ({ ...prev, [ws.id]: { ok: false, text: String(e) } }));
    }
  }

  /** run 脚本：开 shell 标签并立即执行命令；wsId 用于 nonconcurrent 互斥 */
  async function runScript(ws: WorkspaceDto, script: RunScriptDto) {
    const pairs = await invoke<[string, string][]>("workspace_env_for", {
      worktreePath: ws.worktreePath,
    });
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: Object.fromEntries(pairs),
      title: `run: ${script.name}`,
      prefillCommand: script.command,
      shellOnly: true,
      wsId: ws.id,
    });
    setPage("terminal");
  }

  useEffect(() => {
    if (visible) void refresh();
  }, [visible]);

  async function onArchive(ws: WorkspaceDto) {
    if (!window.confirm("归档后 worktree 将被移除（分支保留，可随时恢复）。继续？"))
      return;
    try {
      await invoke("archive_workspace", { id: ws.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRestore(ws: WorkspaceDto) {
    try {
      await invoke("restore_workspace", { id: ws.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(ws: WorkspaceDto) {
    if (
      !window.confirm(
        `将删除 worktree、分支 ${ws.branch} 和元数据，不可恢复。继续？`,
      )
    )
      return;
    try {
      await invoke("delete_workspace", { id: ws.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const active = workspaces.filter((w) => w.status === "active");
  const repoCount = new Set(workspaces.map((w) => w.repoPath)).size;
  // 按仓库分组（保持出现顺序）
  const groups = [...new Set(workspaces.map((w) => w.repoPath))].map((rp) => ({
    repoPath: rp,
    repoName: workspaces.find((w) => w.repoPath === rp)!.repoName,
    list: workspaces.filter((w) => w.repoPath === rp),
  }));

  const actionBtn = "rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-l1">工作区</h1>
          <span className="text-xs text-l3">
            {active.length} 个活跃 · {repoCount} 个仓库
          </span>
        </div>
        <button
          onClick={() => setModal(true)}
          className="rounded px-2 py-1 text-sm text-l1 hover:bg-white/5"
        >
          新建工作区
        </button>
      </div>
      {error && <p className="mb-4 text-sm text-err-text">{error}</p>}
      {created && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded bg-ok p-2 text-xs text-ok-text">
          <span>
            已创建「{created.name}」（{created.branch}）— 已在终端就绪：打开终端开始使用
          </span>
          {created.setupResult &&
            (created.setupResult.ok ? (
              <span className="rounded bg-ok px-1.5 py-0.5 text-ok-text">
                setup 脚本完成
              </span>
            ) : (
              <span className="rounded bg-err px-1.5 py-0.5 text-err-text">
                setup 脚本失败
                <details className="mt-1">
                  <summary className="cursor-pointer">输出</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">
                    {created.setupResult.outputTail}
                  </pre>
                </details>
              </span>
            ))}
          <button
            onClick={() => {
              const ws = created;
              setCreated(null);
              void openInTerminal(ws);
            }}
            className="ml-auto shrink-0 rounded border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110"
          >
            打开终端
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <p className="rounded border border-dashed border-field p-4 text-sm text-l4">
          还没有工作区——新建一个，让 agent 在隔离的 worktree 里干活
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.repoPath} className="mb-5">
            <h2 className="mb-1 text-sm font-medium text-l1" title={g.repoPath}>
              {g.repoName}
              <span className="ml-2 text-xs font-normal text-l4">{g.repoPath}</span>
            </h2>
            <ul className="divide-y divide-hairline">
              {g.list.map((ws) => (
                <li key={ws.id} className="py-2.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-l1">{ws.name}</span>
                    <span className="text-xs text-l3">
                      {ws.branch} → {ws.baseBranch}
                    </span>
                    <span className="text-xs text-l4">
                      端口 {ws.portBase}–{ws.portBase + 9}
                    </span>
                    <span className="text-xs text-l4">{relTime(ws.createdAt)}</span>
                    {ws.status === "active" ? (
                      <span className="rounded bg-ok px-1.5 py-0.5 text-xs text-ok-text">
                        活跃
                      </span>
                    ) : (
                      <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                        已归档
                      </span>
                    )}
                    {ws.status === "active" &&
                      (() => {
                        const h = health[ws.id];
                        if (!h) return null;
                        return (
                          <>
                            {h.readyToMerge && (
                              <span className="rounded bg-ok px-1.5 py-0.5 text-xs text-ok-text">
                                可合并
                              </span>
                            )}
                            {h.conflict === true && (
                              <span className="rounded bg-err px-1.5 py-0.5 text-xs text-err-text">
                                有冲突
                              </span>
                            )}
                            {h.uncommitted > 0 && (
                              <span className="rounded bg-warn px-1.5 py-0.5 text-xs text-warn-text">
                                有未提交
                              </span>
                            )}
                            {h.ahead > 0 && (
                              <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                                ↑{h.ahead}
                              </span>
                            )}
                            {h.behind > 0 && (
                              <span className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3">
                                ↓{h.behind}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {ws.status === "active" && (
                        <>
                          {(() => {
                            const wsSettings = settings[ws.repoPath];
                            const scripts = wsSettings?.run ?? [];
                            if (scripts.length === 0) return null;
                            const defaultScript =
                              scripts.find((s) => s.default) ?? scripts[0];
                            const blocked =
                              wsSettings?.runMode === "nonconcurrent" &&
                              !!runningScripts[ws.id];
                            const blockedTip = "已有运行中的脚本（nonconcurrent）";
                            return (
                              <>
                                <button
                                  disabled={blocked}
                                  title={blocked ? blockedTip : `运行 ${defaultScript.name}：${defaultScript.command}`}
                                  onClick={() => void runScript(ws, defaultScript)}
                                  className={`${actionBtn} disabled:opacity-50`}
                                >
                                  ▶
                                </button>
                                {scripts.length > 1 && (
                                  <button
                                    disabled={blocked}
                                    title={blocked ? blockedTip : "选择脚本"}
                                    onClick={(e) => {
                                      const r = e.currentTarget.getBoundingClientRect();
                                      setRunMenu({ x: r.left, y: r.bottom + 4, ws });
                                    }}
                                    className={`${actionBtn} disabled:opacity-50`}
                                  >
                                    ▾
                                  </button>
                                )}
                              </>
                            );
                          })()}
                          <button
                            onClick={() => void openInTerminal(ws)}
                            className={actionBtn}
                          >
                            打开终端
                          </button>
                          <button
                            disabled={!health[ws.id]?.readyToMerge}
                            title={
                              health[ws.id]?.readyToMerge
                                ? `合并 ${ws.branch} 进 ${ws.baseBranch} 并归档`
                                : "尚不可合并（有未提交改动或与基准冲突）"
                            }
                            onClick={() => onMerge(ws)}
                            className={`${actionBtn} disabled:opacity-50`}
                          >
                            合并
                          </button>
                          <button onClick={() => setPrModal(ws)} className={actionBtn}>
                            创建 PR
                          </button>
                          <button onClick={() => onArchive(ws)} className={actionBtn}>
                            归档
                          </button>
                        </>
                      )}
                      {ws.status === "archived" && (
                        <button onClick={() => onRestore(ws)} className={actionBtn}>
                          恢复
                        </button>
                      )}
                      <button
                        onClick={() => onDelete(ws)}
                        className="rounded px-2 py-0.5 text-xs text-err-text hover:bg-white/5"
                      >
                        删除
                      </button>
                    </span>
                  </div>
                  {mergeResults[ws.id] && (
                    <div
                      className={`mt-1.5 flex items-start gap-2 rounded p-2 text-xs ${
                        mergeResults[ws.id].ok ? "bg-ok text-ok-text" : "bg-err text-err-text"
                      }`}
                    >
                      <pre className="whitespace-pre-wrap break-all font-mono">
                        {mergeResults[ws.id].text}
                      </pre>
                      <button
                        onClick={() =>
                          setMergeResults((prev) => {
                            const n = { ...prev };
                            delete n[ws.id];
                            return n;
                          })
                        }
                        aria-label="关闭"
                        className="ml-auto shrink-0"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {modal && (
        <NewWorkspaceModal
          onClose={() => setModal(false)}
          onCreated={(ws) => {
            setModal(false);
            setCreated(ws);
            void refresh();
          }}
        />
      )}
      {runMenu && (
        <ContextMenu
          x={runMenu.x}
          y={runMenu.y}
          onClose={() => setRunMenu(null)}
          items={(settings[runMenu.ws.repoPath]?.run ?? []).map((s) => ({
            label: `${s.name}（${s.command}）`,
            onSelect: () => void runScript(runMenu.ws, s),
          }))}
        />
      )}
      {prModal && <PrModal ws={prModal} onClose={() => setPrModal(null)} />}
    </div>
  );
}
