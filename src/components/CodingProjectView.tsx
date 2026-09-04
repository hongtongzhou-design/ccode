import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { AppWindow, Copy, FolderOpen, GitBranch } from "lucide-react";
import { confirmDialog } from "./ConfirmDialog";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { HoverTip, useHoverTip } from "./HoverTip";
import {
  compactPrimaryActionClass,
  fieldClass,
  ghostActionClass,
  primaryActionClass,
  projectWellClass,
  rowActionClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { abbrevHome, pathWithin } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import {
  nextLaneBranchName,
  parseGitRemoteUrl,
  remotePickerRows,
  shouldWarnEnterPrimaryBase,
} from "../coding-git";
import {
  groupLanesByTheme,
  laneActivityLabel,
  lastLaneTheme,
  overlayLanes,
} from "../coding-lanes";
import { loadAskAiRemembered } from "../ask-ai";
import { codingTerminalLaunch } from "../kickoff-launch";
import { absTime, relTime } from "../rel-time";
import { imeBlocksEnter } from "../ime-guard";
import {
  CODING_KIND_LABEL,
  codingFactChips,
  deriveCodingKind,
  type CodingFactChip,
  type CodingKind,
} from "../work-mode";
import { codingStatusLine } from "../project-status";
import { beginProjectChat } from "./AskAiModal";
import ProjectSessionsSection, {
  sessionsAsideOpenClass,
} from "./ProjectSessionsSection";
import ScheduleSection from "./ScheduleSection";
import PortsSection from "./PortsSection";
import { AGENTS } from "../types";
import type {
  CodingBranchDto,
  CodingMergeDto,
  CodingOpDto,
  CodingOverviewDto,
  CodingWorktreeDto,
  CustomRuntimeDto,
  ProjectDto,
} from "../types";

const overviewCache = new Map<string, CodingOverviewDto>();

const splitBtnClass =
  "inline-flex h-7 items-center justify-center px-2.5 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

export function prefetchCodingOverview(repoPath: string) {
  if (overviewCache.has(repoPath)) return;
  invoke<CodingOverviewDto>("coding_overview", { repoPath })
    .then((dto) => overviewCache.set(repoPath, dto))
    .catch(() => {});
}

export async function loadCodingOverview(
  repoPath: string,
): Promise<CodingOverviewDto> {
  const hit = overviewCache.get(repoPath);
  if (hit) return hit;
  const dto = await invoke<CodingOverviewDto>("coding_overview", { repoPath });
  overviewCache.set(repoPath, dto);
  return dto;
}

function kindOfWorktree(w: CodingWorktreeDto, base: string): CodingKind {
  return deriveCodingKind({
    isBase: w.isBase || w.branch === base,
    isPrimary: w.isPrimary,
    dirty: w.dirty,
    ahead: w.ahead,
    behind: w.behind,
    hasWorktree: true,
  });
}

function kindOfBranch(b: CodingBranchDto): CodingKind {
  return deriveCodingKind({
    isBase: b.isBase,
    isPrimary: b.isPrimary,
    dirty: b.dirty,
    ahead: b.ahead,
    behind: b.behind,
    hasWorktree: !!b.worktreePath,
  });
}

function kindDotClass(kind: CodingKind): string {
  if (kind === "sync" || kind === "ready") return "bg-warn-text";
  if (kind === "dev") return "bg-ok-text";
  if (kind === "prune") return "bg-l4";
  return "bg-l3";
}

function chipToneClass(tone: CodingFactChip["tone"]): string {
  if (tone === "ok") return "text-ok-text";
  if (tone === "warn") return "text-warn-text";
  return "text-l4";
}

function revealFolderLabel(): string {
  if (IS_MAC) return "在访达中显示";
  if (IS_WINDOWS) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

function BranchLabel({
  name,
  detached,
}: {
  name: string;
  detached?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs text-l2">
      <GitBranch size={12} strokeWidth={1.8} className="shrink-0 text-l4" />
      <span className="truncate">
        {detached ? "游离 HEAD" : name || "（无分支）"}
      </span>
    </span>
  );
}

function FactChipView({ chip }: { chip: CodingFactChip }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref);
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      className={`rounded-full bg-raised px-1.5 py-px font-mono text-micro ${chipToneClass(chip.tone)}`}
    >
      {chip.label}
      <HoverTip tip={tip} text={chip.tip} />
    </span>
  );
}

function TipWrap({
  text,
  up = true,
  children,
}: {
  text: string;
  up?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref, up);
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      className="inline-flex"
    >
      {children}
      <HoverTip tip={tip} text={text} up={up} />
    </span>
  );
}

function FactChips({
  facts,
  baseBranch,
  hostKind,
}: {
  facts: {
    dirty: boolean;
    dirtyCount?: number | null;
    ahead: number;
    behind: number;
    unpushed: number;
    hasUpstream: boolean;
    upstreamBehind?: number;
  };
  baseBranch: string;
  hostKind?: "github" | "other" | null;
}) {
  const chips = codingFactChips({
    ...facts,
    baseBranch,
    hostKind,
  });
  if (chips.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chips.map((chip) => (
        <FactChipView key={chip.key} chip={chip} />
      ))}
    </span>
  );
}

function PathActions({
  path,
  onError,
}: {
  path: string;
  onError: (msg: string) => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
        title="复制路径"
        aria-label="复制路径"
        onClick={() => {
          void navigator.clipboard.writeText(path).catch(() => onError("复制路径失败"));
        }}
      >
        <Copy size={13} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
        title={revealFolderLabel()}
        aria-label={revealFolderLabel()}
        onClick={() => {
          void revealItemInDir(path).catch((e) => onError(String(e)));
        }}
      >
        <FolderOpen size={13} strokeWidth={1.8} />
      </button>
    </span>
  );
}

export default function CodingProjectView({
  project,
  repoPath,
  homeDir,
  onError,
  onNotice,
}: {
  project: ProjectDto | null;
  repoPath: string;
  homeDir: string;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const profiles = useAppStore((s) => s.profiles);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const [ov, setOv] = useState<CodingOverviewDto | null>(
    () => overviewCache.get(repoPath) ?? null,
  );
  const [loading, setLoading] = useState(() => !overviewCache.has(repoPath));
  const [branchName, setBranchName] = useState("");
  const [laneTheme, setLaneTheme] = useState("");
  const [laneName, setLaneName] = useState("");
  const [customRuntimes, setCustomRuntimes] = useState<CustomRuntimeDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [initNote, setInitNote] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [originOpen, setOriginOpen] = useState(false);
  const [originUrl, setOriginUrl] = useState("");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const composingLockRef = useRef(false);
  const composingFrameRef = useRef<number | null>(null);

  async function reload(opts?: { silent?: boolean }) {
    if (!opts?.silent && !overviewCache.has(repoPath)) setLoading(true);
    try {
      const next = await invoke<CodingOverviewDto>("coding_overview", {
        repoPath,
      });
      overviewCache.set(repoPath, next);
      setOv(next);
      try {
        setCustomRuntimes(await invoke<CustomRuntimeDto[]>("list_custom_runtimes"));
      } catch {
        /* 自定义运行时列表失败不挡工作树 */
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = overviewCache.get(repoPath);
    if (cached) {
      setOv(cached);
      setLoading(false);
      void reload({ silent: true });
    } else {
      setOv(null);
      setLoading(true);
      void reload();
    }
    function onVis() {
      if (document.visibilityState === "visible") void reload({ silent: true });
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (composingFrameRef.current != null) {
        cancelAnimationFrame(composingFrameRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const extraRoots = useMemo(
    () => (ov?.worktrees ?? []).map((w) => w.path),
    [ov],
  );

  const trees = useMemo(() => {
    const list = ov?.worktrees ?? [];
    const merging = ov?.mergingCwd;
    return [...list].sort((a, b) => {
      const am = merging && a.path === merging ? 0 : 1;
      const bm = merging && b.path === merging ? 0 : 1;
      return am - bm;
    });
  }, [ov]);

  const laneGroups = useMemo(
    () => groupLanesByTheme(overlayLanes(trees, ov?.lanes ?? [], IS_WINDOWS)),
    [trees, ov],
  );

  async function enterTree(w: CodingWorktreeDto, title: string) {
    const primaryPath = trees.find((t) => t.isPrimary)?.path ?? repoPath;
    const runningOnPrimary = terminalRunInputs.some(
      (t) => t.running && pathWithin(t.cwd, primaryPath, IS_WINDOWS),
    );
    const warn = shouldWarnEnterPrimaryBase({
      isPrimary: w.isPrimary,
      isBase: w.isBase,
      runningOnPrimary,
    });
    if (warn.warn) {
      const ok = await confirmDialog(
        warn.kind === "agent"
          ? "主仓里已有 Agent 在跑。再开一个会改同一份目录。"
          : `主仓正停在基准分支上。Agent 会直接改 ${w.branch || "基准"}。建议先从基准拉出工作树。`,
        { confirmText: "仍要进入" },
      );
      if (!ok) return;
    }
    setPendingTerminal({
      cwd: w.path,
      extraEnv: {},
      title,
      reuseKey: `lane:${w.path}`,
      ...codingTerminalLaunch(profiles, loadAskAiRemembered()),
    });
    setPage("terminal");
  }

  async function startCustomRuntime(cwd: string, runtime?: CustomRuntimeDto) {
    try {
      let r = runtime;
      if (!r) {
        const list =
          customRuntimes.length > 0
            ? customRuntimes
            : await invoke<CustomRuntimeDto[]>("list_custom_runtimes");
        if (list.length === 0) {
          useAppStore.getState().setSettingsSectionReq("storage");
          useAppStore.getState().setPage("settings");
          onNotice("还没有自定义运行时，已打开设置页「数据与存储」。");
          return;
        }
        r = list[0]!;
      }
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const line = [r.command, ...r.args].map(q).join(" ");
      const reuseKey = `custom:${r.id}:${cwd}`;
      const run = await invoke<{ id: string }>("run_open_custom", {
        cwd,
        reuseKey,
        runId: null,
      });
      setPendingTerminal({
        cwd,
        extraEnv: {},
        title: r.name,
        shellOnly: true,
        prefillCommand: line,
        reuseKey,
        runId: run.id,
        surface: "terminal",
      });
      setPage("terminal");
    } catch (e) {
      onError(String(e));
    }
  }

  function openGit(path: string, title: string) {
    setPendingTerminal({
      cwd: path,
      extraEnv: {},
      title,
      reuseKey: `lane:${path}`,
      rightTab: "git",
      surface: "terminal",
    });
    setPage("terminal");
  }

  async function createTree(
    name: string,
    source: { kind: "fromBase" } | { kind: "local" } | { kind: "remote"; remote: string },
  ) {
    const branch = name.trim();
    if (!branch || creating) return;
    setCreating(true);
    try {
      let req = source;
      for (;;) {
        const r = await invoke<CodingOpDto>("coding_create_worktree", {
          repoPath,
          branch,
          source: req,
        });
        if (!r.ok && r.code === "branch_exists") {
          const ok = await confirmDialog(r.message, {
            confirmText: "给它建工作树",
          });
          if (!ok) return;
          req = { kind: "local" };
          continue;
        }
        if (!r.ok) {
          onError(r.message);
          return;
        }
        if (r.createdInitialCommit) setInitNote(true);
        setBranchName("");
        setPickerOpen(false);
        onNotice(r.message);
        await reload();
        if (r.worktree) {
          const theme = laneTheme.trim() || lastLaneTheme(ov?.lanes ?? []);
          const name = laneName.trim() || r.worktree.branch;
          try {
            await invoke("coding_upsert_lane", {
              repoPath,
              worktreePath: r.worktree.path,
              branch: r.worktree.branch,
              name,
              theme: theme || null,
            });
          } catch {
            /* 车道覆盖层失败不阻断开工 */
          }
          setLaneName("");
          const launch = codingTerminalLaunch(profiles, loadAskAiRemembered());
          setPendingTerminal({
            cwd: r.worktree.path,
            extraEnv: {},
            title: name || r.worktree.branch || branch,
            reuseKey: `lane:${r.worktree.path}`,
            initialPrompt: "先读 TASK.md 再动手",
            ...(launch ?? {}),
          });
          setPage("terminal");
        }
        return;
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function removeTree(w: CodingWorktreeDto) {
    if (w.isPrimary) return;
    const delBranch = await confirmDialog(
      w.dirty
        ? "有未提交改动。强制删除工作树？可同时删除分支。"
        : "删除这棵工作树？可同时删除分支。",
      { confirmText: "删除工作树", danger: true },
    );
    if (!delBranch) return;
    const also = await confirmDialog("连分支一起删？", {
      confirmText: "同时删分支",
    });
    setBusy(w.path);
    try {
      await invoke("coding_remove_worktree", {
        repoPath,
        worktreePath: w.path,
        deleteBranch: also,
        force: w.dirty,
      });
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runRemote(
    cmd: "coding_fetch" | "coding_pull" | "coding_push",
    cwd: string,
    label: string,
  ) {
    setBusy(cwd + cmd);
    try {
      if (cmd === "coding_pull") {
        const r = await invoke<CodingOpDto>(cmd, { cwd });
        if (!r.ok) onError(r.message);
        else onNotice(r.message || label);
      } else {
        const msg = await invoke<string>(cmd, { cwd });
        onNotice(msg || label);
      }
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openDesktop(path: string) {
    try {
      const r = await invoke<CodingOpDto>("coding_open_desktop", {
        repoPath,
        path,
      });
      if (!r.ok) onError(r.message);
      else onNotice(r.message);
    } catch (e) {
      onError(String(e));
    }
  }

  async function openPr(cwd: string) {
    if (busy) return;
    setBusy(`pr:${cwd}`);
    try {
      const r = await invoke<CodingOpDto>("coding_open_pr", {
        repoPath,
        cwd,
      });
      if (r.method === "compare-url" && r.url) {
        await openUrl(r.url);
        onNotice(r.message);
        return;
      }
      if (!r.ok) onError(r.message);
      else onNotice(r.message);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addOrigin() {
    const parsed = parseGitRemoteUrl(originUrl);
    if (!parsed.ok) {
      onError("远程地址不合法");
      return;
    }
    if (parsed.hasUserinfo) {
      const ok = await confirmDialog(
        "URL 含密码，会写入 .git/config。仍要添加？",
        { danger: true, confirmText: "仍要添加" },
      );
      if (!ok) return;
    }
    setBusy("origin");
    try {
      const r = await invoke<CodingOpDto>("coding_add_origin", {
        repoPath,
        url: originUrl.trim(),
      });
      if (!r.ok && r.failedPhase === "fetch") {
        onNotice(r.message);
        setOriginOpen(false);
        await reload();
        return;
      }
      if (!r.ok) {
        onError(r.message);
        return;
      }
      setOriginOpen(false);
      setOriginUrl("");
      onNotice(r.message);
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function mergeBranch(name: string) {
    if (
      !(await confirmDialog(`把「${name}」合并进 ${ov?.baseBranch ?? "基准"}？`))
    )
      return;
    setBusy(`merge:${name}`);
    try {
      const r = await invoke<CodingMergeDto>("coding_merge_into_base", {
        repoPath,
        branch: name,
      });
      if (r.code === "base_not_checked_out") {
        onNotice(r.message);
        await reload();
        return;
      }
      if (r.conflict) {
        onNotice(r.message);
        openGit(r.cwd, "解决冲突");
      } else {
        onNotice(r.message);
      }
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteBranch(name: string, force = false) {
    if (
      !(await confirmDialog(
        force
          ? `强制删除分支 ${name}？未合入的提交会丢掉。`
          : `删除分支 ${name}？`,
        { danger: true, confirmText: force ? "强制删除" : "删除" },
      ))
    )
      return;
    setBusy(`br:${name}`);
    try {
      await invoke("coding_delete_branch", { repoPath, branch: name, force });
      await reload();
    } catch (e) {
      const msg = String(e);
      if (!force && msg.includes("未合入")) {
        setBusy(null);
        await deleteBranch(name, true);
        return;
      }
      onError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function abortMerge() {
    const cwd = ov?.mergingCwd;
    if (!cwd) return;
    if (!(await confirmDialog("取消这次合并？未解决的冲突会丢弃。"))) return;
    setBusy("abort");
    try {
      await invoke("git_abort_merge", { cwd });
      onNotice("已取消合并");
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  function lockIme() {
    if (composingFrameRef.current != null) {
      cancelAnimationFrame(composingFrameRef.current);
      composingFrameRef.current = null;
    }
    composingLockRef.current = true;
  }

  function unlockImeAfterFrame() {
    composingLockRef.current = true;
    composingFrameRef.current = requestAnimationFrame(() => {
      composingLockRef.current = false;
      composingFrameRef.current = null;
    });
  }

  function openMenu(e: MouseEvent<HTMLButtonElement>, items: ContextMenuItem[]) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 4, items });
  }

  const name = project?.name ?? repoPath.split(/[\\/]/).pop() ?? repoPath;
  const branches = ov?.branches ?? [];
  const base = ov?.baseBranch ?? "";
  const statusLine = ov
    ? codingStatusLine({
        worktrees: ov.worktrees,
        merging: ov.merging,
      })
    : "";
  const showPath = homeDir ? abbrevHome(repoPath, homeDir, IS_WINDOWS) : repoPath;
  const origin = ov?.origin ?? null;
  const hostKind = (origin?.hostKind === "github" ? "github" : origin ? "other" : null) as
    | "github"
    | "other"
    | null;
  const hasBaseTree = trees.some((w) => w.isBase);
  const primaryOffBase = trees.some((w) => w.isPrimary && !w.isBase);
  const pickerRows = remotePickerRows(
    branches.map((b) => ({ name: b.name, occupiedPath: b.worktreePath })),
    ov?.remoteBranches ?? [],
    pickerQuery,
  );

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-0">
      <div className={`min-w-0 flex-1 space-y-5 ${sessionsOpen ? "lg:pr-6" : ""}`}>
        <section>
          <div className="flex min-w-0 items-start gap-2">
            <p className="min-w-0 flex-1 text-base font-semibold tracking-tight text-l1">
              {name}
            </p>
            {!sessionsOpen && ov?.isRepo && (
              <ProjectSessionsSection
                projectPath={repoPath}
                extraRoots={extraRoots}
                variant="sidebar"
                collapsed
                onToggle={() => setSessionsOpen(true)}
                onError={onError}
              />
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <p
              className="min-w-0 truncate font-mono text-micro text-l3"
              title={repoPath}
            >
              {showPath}
            </p>
            <PathActions path={repoPath} onError={onError} />
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-l3">
            <span className="rounded-full bg-strip px-2 py-0.5 text-micro text-l2">
              编程
            </span>
            {base && (
              <span className="inline-flex items-center gap-1 text-l4">
                基准
                <BranchLabel name={base} />
              </span>
            )}
            {origin ? (
              <span
                className="truncate font-mono text-micro text-l3"
                title={origin.url}
              >
                {hostKind === "github"
                  ? origin.display.replace(/^(?:ssh\.)?github\.com\//, "")
                  : origin.display}
              </span>
            ) : (
              ov?.isRepo && (
                <button
                  type="button"
                  className={ghostActionClass}
                  onClick={() => setOriginOpen(true)}
                >
                  还没连上远程 · 连接远程
                </button>
              )
            )}
            {statusLine && <span className="text-micro text-l4">{statusLine}</span>}
            {primaryOffBase && (
              <TipWrap
                text={`主仓不在 ${base}。给基准建一棵工作树再合并，不要把主仓切回去。`}
              >
                <button
                  type="button"
                  className="rounded-full bg-raised px-2 py-0.5 text-micro text-l4"
                  onClick={() => void createTree(base, { kind: "local" })}
                >
                  主仓不在基准
                </button>
              </TipWrap>
            )}
            <span className="ml-auto flex items-center gap-1">
              {origin && (
                <button
                  type="button"
                  className={rowActionClass}
                  disabled={loading || !!busy}
                  onClick={() =>
                    void runRemote("coding_fetch", repoPath, "已更新引用")
                  }
                >
                  {hostKind === "github" ? "从 GitHub 更新" : "从远程更新"}
                </button>
              )}
              <button
                type="button"
                className={rowActionClass}
                disabled={loading || !!busy}
                onClick={() => {
                  setLoading(true);
                  void reload();
                }}
              >
                刷新
              </button>
            </span>
          </p>
          {!hasBaseTree && ov?.isRepo && base && (
            <button
              type="button"
              className={`${ghostActionClass} mt-1`}
              disabled={creating || !!busy}
              onClick={() => void createTree(base, { kind: "local" })}
            >
              为 {base} 建工作树
            </button>
          )}
          {initNote && (
            <p className="mt-2 text-xs text-l3">
              这个仓库还没有提交，已自动写了一条空的初始提交，才能建工作树。
            </p>
          )}
        </section>

        {loading && !ov && <p className="text-xs text-l4">读取工作树…</p>}
        {ov && !ov.isRepo && (
          <p className="text-sm text-l3">还不是 git 仓库。</p>
        )}

        {ov?.isRepo && (
          <>
            <section>
              <div className="mb-2.5 flex items-center gap-2">
                <GitBranch size={14} strokeWidth={1.8} className="text-l4" />
                <h2 className="text-xs font-medium text-l2">工作树</h2>
              </div>
              <div className="mb-3 flex gap-2">
                <input
                  ref={branchInputRef}
                  className={`${fieldClass} h-8 py-0`}
                  value={branchName}
                  placeholder="feature/login"
                  aria-label="新分支名（从基准拉出）"
                  onChange={(e) => setBranchName(e.target.value)}
                  onCompositionStart={lockIme}
                  onCompositionUpdate={lockIme}
                  onCompositionEnd={unlockImeAfterFrame}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (
                      imeBlocksEnter({
                        isComposing: e.nativeEvent.isComposing,
                        keyCode: e.nativeEvent.keyCode,
                        composingLock: composingLockRef.current,
                      })
                    ) {
                      return;
                    }
                    e.preventDefault();
                    void createTree(branchName, { kind: "fromBase" });
                  }}
                />
                <button
                  type="button"
                  className={`${primaryActionClass} shrink-0`}
                  disabled={creating || !branchName.trim()}
                  onClick={() =>
                    void createTree(branchName, { kind: "fromBase" })
                  }
                >
                  {creating ? "创建中…" : `从 ${base || "基准"} 开工`}
                </button>
                {trees.some((w) => !w.isPrimary && !w.detached) && (
                  <button
                    type="button"
                    className={`${ghostActionClass} shrink-0`}
                    onClick={() => {
                      const last = [...trees]
                        .reverse()
                        .find((w) => !w.isPrimary && !w.detached);
                      const next = nextLaneBranchName(
                        last?.branch || branchName || "feature/work",
                      );
                      if (!next) return;
                      setBranchName(next);
                      branchInputRef.current?.focus();
                    }}
                  >
                    再开一条
                  </button>
                )}
              </div>
              <p className="mb-2 text-micro text-l4">
                从基准拉出新分支，在独立目录里给 Agent 改。已有工作树时可「再开一条」并行。
              </p>
              <div className="mb-3 flex gap-2">
                <input
                  className={`${fieldClass} h-8 min-w-0 flex-1 py-0`}
                  value={laneName}
                  placeholder="名称（可选，默认分支名）"
                  aria-label="车道名称"
                  onChange={(e) => setLaneName(e.target.value)}
                />
                <input
                  className={`${fieldClass} h-8 min-w-0 flex-1 py-0`}
                  value={laneTheme}
                  placeholder={`主题分组（可选）${lastLaneTheme(ov?.lanes ?? []) ? `，上次「${lastLaneTheme(ov?.lanes ?? [])}」` : ""}`}
                  aria-label="车道主题分组"
                  onChange={(e) => setLaneTheme(e.target.value)}
                />
              </div>
              <button
                type="button"
                className={`${ghostActionClass} mb-3`}
                onClick={() => setPickerOpen((v) => !v)}
              >
                从已有分支开工
              </button>
              {pickerOpen && (
                <div className="mb-3 rounded-lg bg-inset p-2">
                  <input
                    className={`${fieldClass} mb-2 h-8 py-0`}
                    value={pickerQuery}
                    placeholder="搜索分支"
                    onChange={(e) => setPickerQuery(e.target.value)}
                  />
                  <ul className="max-h-48 space-y-0.5 overflow-auto">
                    {pickerRows.length === 0 ? (
                      <li className="px-2 py-1 text-xs text-l4">没有可开工的分支</li>
                    ) : (
                      pickerRows.map((row) => (
                        <li key={row.key}>
                          <button
                            type="button"
                            disabled={row.disabled || creating}
                            title={
                              row.occupiedPath
                                ? `已在 ${row.occupiedPath} 检出`
                                : undefined
                            }
                            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs text-l2 hover:bg-hover disabled:opacity-40"
                            onClick={() =>
                              void createTree(
                                row.name,
                                row.source === "remote"
                                  ? {
                                      kind: "remote",
                                      remote: row.remote ?? "origin",
                                    }
                                  : { kind: "local" },
                              )
                            }
                          >
                            {row.label}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              )}
              <ul className="flex flex-col gap-2">
                {laneGroups.flatMap((group) => {
                  const head =
                    group.label === "主仓" ? null : (
                      <li
                        key={`theme:${group.label}`}
                        className="px-0.5 pt-1 text-micro font-medium text-l4"
                      >
                        {group.label}
                      </li>
                    );
                  const rows = group.items.map((w) => {
                  const kind = kindOfWorktree(w, base);
                  const label = w.detached
                    ? "游离 HEAD"
                    : w.branch || "（无分支）";
                  const displayName = w.isPrimary
                    ? "主仓"
                    : w.lane.name || label;
                  const activity = laneActivityLabel(
                    w.path,
                    terminalRunInputs,
                    IS_WINDOWS,
                  );
                  const activityText =
                    activity === "空闲"
                      ? "空闲"
                      : (AGENTS.find((a) => a.id === activity)?.label ??
                        activity);
                  const merging = !!ov?.merging && ov.mergingCwd === w.path;
                  const moreItems: ContextMenuItem[] = [];
                  if (merging) {
                    moreItems.push({
                      label: "取消合并",
                      onSelect: () => void abortMerge(),
                    });
                  }
                  if (customRuntimes.length === 0) {
                    moreItems.push({
                      label: "用自定义运行时…",
                      onSelect: () => void startCustomRuntime(w.path),
                    });
                  } else {
                    for (const r of customRuntimes) {
                      moreItems.push({
                        label: `运行「${r.name}」`,
                        onSelect: () => void startCustomRuntime(w.path, r),
                      });
                    }
                  }
                  if (!w.isPrimary) {
                    moreItems.push({ separator: true });
                    moreItems.push({
                      label: "删除工作树",
                      danger: true,
                      disabled: !!busy,
                      onSelect: () => void removeTree(w),
                    });
                  }
                  return (
                    <li key={w.path} className={projectWellClass}>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-l1">
                            <span className="shrink-0">{displayName}</span>
                            {!w.isPrimary &&
                              w.lane.branch &&
                              w.lane.branch !== displayName && (
                                <BranchLabel
                                  name={w.lane.branch}
                                  detached={w.detached}
                                />
                              )}
                            {w.isPrimary && (
                              <BranchLabel name={label} detached={w.detached} />
                            )}
                            <span className="shrink-0 text-micro font-normal text-l4">
                              {activityText}
                            </span>
                            {merging && (
                              <span className="text-xs text-warn-text">
                                有冲突
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          {merging ? (
                            <button
                              type="button"
                              className={compactPrimaryActionClass}
                              onClick={() => openGit(w.path, "解决冲突")}
                            >
                              去解决
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className={rowActionClass}
                                onClick={() =>
                                  void enterTree(w, w.lane.name || label)
                                }
                              >
                                进入
                              </button>
                              {!w.isPrimary && !w.detached && (
                                <button
                                  type="button"
                                  className={ghostActionClass}
                                  onClick={() => {
                                    const next = nextLaneBranchName(
                                      w.branch || "feature/work",
                                    );
                                    if (!next) return;
                                    setBranchName(next);
                                    branchInputRef.current?.focus();
                                    branchInputRef.current?.scrollIntoView({
                                      block: "nearest",
                                    });
                                  }}
                                >
                                  再开一条
                                </button>
                              )}
                              <button
                                type="button"
                                className={ghostActionClass}
                                onClick={() => openGit(w.path, label)}
                              >
                                查看改动
                              </button>
                            </>
                          )}
                          <div className="inline-flex overflow-hidden rounded-md border border-field">
                            <button
                              type="button"
                              className={`${splitBtnClass} border-r border-field`}
                              disabled={!!busy}
                              onClick={() =>
                                void runRemote("coding_pull", w.path, "已拉取")
                              }
                            >
                              拉取
                            </button>
                            <button
                              type="button"
                              className={splitBtnClass}
                              disabled={!!busy}
                              title={
                                w.hasUpstream
                                  ? `推送到 origin/${w.branch || "HEAD"}`
                                  : "第一次会推到 origin 并设上游"
                              }
                              onClick={() =>
                                void runRemote("coding_push", w.path, "已推送")
                              }
                            >
                              推送
                            </button>
                          </div>
                          {moreItems.length > 0 && (
                          <button
                            type="button"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                            aria-label={`更多操作：${label}`}
                            title="更多操作"
                            onClick={(e) => openMenu(e, moreItems)}
                          >
                            ⋯
                          </button>
                          )}
                        </div>
                      </div>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-micro">
                        <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-l2">
                          <span
                            className={`size-1.5 rounded-full ${kindDotClass(kind)}`}
                          />
                          {CODING_KIND_LABEL[kind]}
                        </span>
                        <FactChips
                          facts={w}
                          baseBranch={base}
                          hostKind={hostKind}
                        />
                        {hostKind === "github" &&
                          (w.hasUpstream ? (
                            <button
                              type="button"
                              className={ghostActionClass}
                              disabled={!!busy}
                              onClick={() => void openPr(w.path)}
                            >
                              {busy === `pr:${w.path}`
                                ? "打开中…"
                                : "打开 Pull Request"}
                            </button>
                          ) : (
                            <TipWrap text="先推送才能开 PR">
                              <button
                                type="button"
                                className={ghostActionClass}
                                disabled
                              >
                                打开 Pull Request
                              </button>
                            </TipWrap>
                          ))}
                      </p>
                      <p className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-micro text-l4">
                        <span title={absTime(w.lastCommitAt ?? null)}>
                          {w.lastCommitAt
                            ? `上次提交 ${relTime(w.lastCommitAt)}`
                            : "还没有提交"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="min-w-0 truncate" title={w.path}>
                          {homeDir
                            ? abbrevHome(w.path, homeDir, IS_WINDOWS)
                            : w.path}
                        </span>
                        <PathActions path={w.path} onError={onError} />
                        <TipWrap
                          up={false}
                          text={
                            w.isPrimary
                              ? "在 GitHub Desktop 打开主仓这一目录"
                              : "用 GitHub Desktop 打开这一目录"
                          }
                        >
                          <button
                            type="button"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                            aria-label="在 GitHub Desktop 打开"
                            onClick={() => void openDesktop(w.path)}
                          >
                            <AppWindow size={13} strokeWidth={1.8} />
                          </button>
                        </TipWrap>
                        {!w.isPrimary && (
                          <span className="text-micro text-l4">
                            用 GitHub Desktop 打开这一目录
                          </span>
                        )}
                      </p>
                    </li>
                  );
                  });
                  return head ? [head, ...rows] : rows;
                })}
              </ul>
            </section>

            <section>
              <h2 className="mb-2.5 text-xs font-medium text-l2">分支</h2>
              {branches.length === 0 ? (
                <p className="py-4 text-sm text-l3">还没有本地分支。</p>
              ) : (
                <ul className="space-y-0.5">
                  {branches.map((b) => {
                    const kind = kindOfBranch(b);
                    const tree = trees.find((w) => w.branch === b.name);
                    return (
                      <li
                        key={b.name}
                        className="flex min-h-10 items-center gap-2 rounded-md px-2.5 hover:bg-hover"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <BranchLabel name={b.name} />
                            {b.isBase && (
                              <span className="text-micro text-l4">基准</span>
                            )}
                            {!b.worktreePath && (
                              <span className="text-micro text-l4">未检出</span>
                            )}
                          </div>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-micro text-l3">
                              <span
                                className={`size-1.5 rounded-full ${kindDotClass(kind)}`}
                              />
                              {CODING_KIND_LABEL[kind]}
                            </span>
                            <FactChips
                              facts={{
                                ...b,
                                dirtyCount: tree?.dirtyCount,
                              }}
                              baseBranch={base}
                              hostKind={hostKind}
                            />
                          </p>
                        </div>
                        {!b.worktreePath && (
                          <button
                            type="button"
                            className={ghostActionClass}
                            disabled={creating || !!busy}
                            onClick={() =>
                              void createTree(b.name, { kind: "local" })
                            }
                          >
                            建工作树
                          </button>
                        )}
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                          aria-label={`更多操作：${b.name}`}
                          title="更多操作"
                          onClick={(e) =>
                            openMenu(e, [
                              {
                                label: "合并进基准",
                                disabled: !!busy || b.isBase,
                                title: b.isBase
                                  ? "基准分支不能合并进自己"
                                  : undefined,
                                onSelect: () => void mergeBranch(b.name),
                              },
                              {
                                label: "删除分支",
                                danger: true,
                                disabled:
                                  !!busy || b.isBase || !!b.worktreePath,
                                title: b.isBase
                                  ? "基准分支不能删"
                                  : b.worktreePath
                                    ? "先删工作树再删分支"
                                    : undefined,
                                onSelect: () => void deleteBranch(b.name),
                              },
                            ])
                          }
                        >
                          ⋯
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <PortsSection roots={[repoPath, ...extraRoots]} />
          </>
        )}
      </div>

      {ov?.isRepo && sessionsOpen && (
        <aside className={sessionsAsideOpenClass}>
          <div className="flex min-w-0 flex-col gap-4">
            <ProjectSessionsSection
              projectPath={repoPath}
              extraRoots={extraRoots}
              variant="sidebar"
              collapsed={false}
              onToggle={() => setSessionsOpen(false)}
              onError={onError}
              onNewChat={(e) =>
                beginProjectChat(
                  { cwd: repoPath, name, kind: "coding" },
                  { forcePick: !!(e.metaKey || e.ctrlKey) },
                )
              }
            />
            <ScheduleSection projectRoot={repoPath} steps={[]} layout="card" />
          </div>
        </aside>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {originOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
          onClick={() => setOriginOpen(false)}
        >
          <div
            className="ccode-float-surface w-full max-w-[500px] rounded-lg border border-field p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium text-l1">连接远程</p>
            <p className="mt-1 text-xs text-l4">远程名固定 origin</p>
            <input
              className={`${fieldClass} mt-3`}
              value={originUrl}
              placeholder="https://github.com/org/repo.git"
              onChange={(e) => setOriginUrl(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={ghostActionClass}
                onClick={() => setOriginOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className={primaryActionClass}
                disabled={!originUrl.trim() || !!busy}
                onClick={() => void addOrigin()}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
