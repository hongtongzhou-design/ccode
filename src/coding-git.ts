/**
 * 编程页 Git / GitHub 纯逻辑（与 coding.rs 双端镜像）。
 * 平台分支经 isWindows 入参，模块内不读 navigator。
 */
import { pathWithin, samePath } from "./path-utils.ts";

export type GitHostKind = "github" | "other";

export interface ParsedGitRemote {
  ok: true;
  host: string;
  ownerRepo: string;
  display: string;
  hostKind: GitHostKind;
  hasUserinfo: boolean;
  urlStripped: string;
}

export interface ParsedGitRemoteFail {
  ok: false;
}

const CTRL_OR_SPACE = /[\s\u0000-\u001f]/;

function gitHostKind(host: string): GitHostKind {
  const h = host.toLowerCase();
  return h === "github.com" || h === "ssh.github.com" ? "github" : "other";
}

function hostOk(host: string): boolean {
  if (!host || host.startsWith("-") || host.includes("@")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(
    host,
  );
}

function normalizeRepoPath(path: string): string | null {
  let p = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p.toLowerCase().endsWith(".git")) p = p.slice(0, -4);
  if (!p) return null;
  const segs = p.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  if (segs.some((s) => s === "." || s === ".." || s.includes("\\"))) return null;
  return segs.join("/");
}

function forbiddenRaw(raw: string): boolean {
  if (!raw || raw.startsWith("-")) return true;
  if (CTRL_OR_SPACE.test(raw) || raw.includes("..")) return true;
  return false;
}

/** 解析 git remote URL；非法返回 ok:false。hostKind=github 仅精确 github.com。 */
export function parseGitRemoteUrl(
  raw: string,
): ParsedGitRemote | ParsedGitRemoteFail {
  const input = raw.trim();
  if (forbiddenRaw(input)) return { ok: false };

  const scp = /^([^/@]+)@([^:]+):(.+)$/.exec(input);
  if (scp && !input.includes("://")) {
    const user = scp[1]!;
    const host = scp[2]!;
    const path = scp[3]!;
    if (user.startsWith("-") || !hostOk(host)) return { ok: false };
    const ownerRepo = normalizeRepoPath(path);
    if (!ownerRepo) return { ok: false };
    const kind = gitHostKind(host);
    return {
      ok: true,
      host,
      ownerRepo,
      display: `${host}/${ownerRepo}`,
      hostKind: kind,
      hasUserinfo: false,
      urlStripped: `${user}@${host}:${ownerRepo}.git`,
    };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false };
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (scheme !== "https" && scheme !== "ssh") return { ok: false };
  const host = url.hostname;
  if (!hostOk(host)) return { ok: false };
  const ownerRepo = normalizeRepoPath(url.pathname);
  if (!ownerRepo) return { ok: false };
  const hasUserinfo = Boolean(url.username || url.password);
  const kind = gitHostKind(host);
  const urlStripped =
    scheme === "ssh"
      ? `ssh://${url.username ? `${url.username}@` : ""}${host}/${ownerRepo}.git`
      : `https://${host}/${ownerRepo}.git`;
  return {
    ok: true,
    host,
    ownerRepo,
    display: `${host}/${ownerRepo}`,
    hostKind: kind,
    hasUserinfo,
    urlStripped,
  };
}

export function abbrevGitRemoteUrl(raw: string): string | null {
  const p = parseGitRemoteUrl(raw);
  return p.ok ? p.display : null;
}

function encodeRef(ref: string): string {
  return ref
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function githubCompareUrl(opts: {
  ownerRepo: string;
  base: string;
  head: string;
}): string {
  return `https://github.com/${opts.ownerRepo}/compare/${encodeRef(opts.base)}...${encodeRef(opts.head)}`;
}

export function shouldWarnEnterPrimaryBase(input: {
  isPrimary: boolean;
  isBase: boolean;
  runningOnPrimary: boolean;
}): { warn: boolean; kind: "base" | "agent" | null } {
  if (!input.isPrimary) return { warn: false, kind: null };
  if (input.runningOnPrimary) return { warn: true, kind: "agent" };
  if (input.isBase) return { warn: true, kind: "base" };
  return { warn: false, kind: null };
}

export function cwdIsCodingWorktree(
  cwd: string,
  overviews: ReadonlyArray<{ worktrees: ReadonlyArray<{ path: string }> }>,
  isWindows: boolean,
): boolean {
  const extraRoots = overviews.flatMap((ov) => ov.worktrees.map((w) => w.path));
  return extraRoots.some(
    (root) =>
      samePath(cwd, root, isWindows) || pathWithin(cwd, root, isWindows),
  );
}

export interface RemotePickerRow {
  key: string;
  label: string;
  source: "local" | "remote";
  name: string;
  remote?: string;
  occupiedPath: string | null;
  disabled: boolean;
}

export function remotePickerRows(
  local: readonly { name: string; occupiedPath: string | null }[],
  remote: readonly {
    remote: string;
    name: string;
    hasLocal: boolean;
    occupiedPath: string | null;
  }[],
  query: string,
  cap = 200,
): RemotePickerRow[] {
  const q = query.trim().toLowerCase();
  const rows: RemotePickerRow[] = [];
  for (const b of local) {
    rows.push({
      key: `local:${b.name}`,
      label: b.name,
      source: "local",
      name: b.name,
      occupiedPath: b.occupiedPath,
      disabled: !!b.occupiedPath,
    });
  }
  for (const b of remote) {
    if (b.hasLocal) continue;
    rows.push({
      key: `remote:${b.remote}/${b.name}`,
      label: `${b.remote}/${b.name}`,
      source: "remote",
      name: b.name,
      remote: b.remote,
      occupiedPath: b.occupiedPath,
      disabled: !!b.occupiedPath,
    });
  }
  const filtered = q
    ? rows.filter(
        (r) =>
          r.label.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
    : rows;
  return filtered.slice(0, cap);
}

/** 「再开一条」预填分支名：feature/login → feature/login-2，已有 -N 则 +1。 */
export function nextLaneBranchName(branch: string): string {
  const t = branch.trim();
  if (!t) return "";
  const m = t.match(/^(.*)-(\d+)$/);
  if (!m) return `${t}-2`;
  const stem = m[1] ?? t;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return `${t}-2`;
  return `${stem}-${n + 1}`;
}
