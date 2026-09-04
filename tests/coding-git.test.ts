import assert from "node:assert/strict";
import test from "node:test";
import { pathWithin } from "../src/path-utils.ts";
import {
  abbrevGitRemoteUrl,
  cwdIsCodingWorktree,
  githubCompareUrl,
  parseGitRemoteUrl,
  remotePickerRows,
  shouldWarnEnterPrimaryBase,
  nextLaneBranchName,
} from "../src/coding-git.ts";

function ok(url: string) {
  const p = parseGitRemoteUrl(url);
  assert.equal(p.ok, true, url);
  return p.ok ? p : null!;
}

test("合法 GitHub / GitLab remote", () => {
  const a = ok("https://github.com/org/repo.git");
  assert.equal(a.hostKind, "github");
  assert.equal(a.display, "github.com/org/repo");
  assert.equal(a.ownerRepo, "org/repo");
  assert.equal(a.hasUserinfo, false);
  assert.equal(ok("https://github.com/org/repo").display, "github.com/org/repo");
  assert.equal(ok("git@github.com:org/repo.git").hostKind, "github");
  assert.equal(ok("ssh://git@github.com/org/repo.git").hostKind, "github");
  assert.equal(ok("git@ssh.github.com:org/repo.git").hostKind, "github");
  assert.equal(ok("ssh://git@ssh.github.com/org/repo.git").hostKind, "github");
  const gl = ok("https://gitlab.com/group/sub/repo.git");
  assert.equal(gl.hostKind, "other");
  assert.equal(gl.ownerRepo, "group/sub/repo");
  assert.equal(ok("git@gitlab.com:group/sub/repo.git").hostKind, "other");
});

test("userinfo 要标出来；DTO 剥密", () => {
  const p = ok("https://user:token@github.com/org/repo.git");
  assert.equal(p.hasUserinfo, true);
  assert.equal(p.hostKind, "github");
  assert.equal(p.urlStripped, "https://github.com/org/repo.git");
  assert.ok(!p.urlStripped.includes("token"));
});

test("非法 remote 拒绝", () => {
  const bad = [
    "file:///tmp/repo",
    "ext::sh -c evil",
    "git://github.com/org/repo",
    "ssh://-oProxyCommand=evil/x",
    "git@-oProxyCommand:foo",
    "https://github.com/onlyone",
    "https://github.com/org/foo/../bar",
    "-https://github.com/org/repo",
    "https://github.com/org/repo with space",
  ];
  for (const u of bad) {
    assert.equal(parseGitRemoteUrl(u).ok, false, u);
  }
});

test("钓鱼与 www/gist 都是 other，不得当 github", () => {
  assert.equal(ok("https://github.com.evil.com/org/repo").hostKind, "other");
  assert.equal(ok("https://www.github.com/org/repo").hostKind, "other");
  assert.equal(ok("https://gist.github.com/abc/def").hostKind, "other");
});

test("abbrev 与 compare 分段编码", () => {
  assert.equal(
    abbrevGitRemoteUrl("https://github.com/org/repo.git"),
    "github.com/org/repo",
  );
  assert.equal(
    githubCompareUrl({
      ownerRepo: "org/repo",
      base: "main",
      head: "feature/login",
    }),
    "https://github.com/org/repo/compare/main...feature/login",
  );
  assert.equal(
    githubCompareUrl({ ownerRepo: "org/repo", base: "main", head: "a#b" }),
    "https://github.com/org/repo/compare/main...a%23b",
  );
});

test("主仓在基准或已有 Agent 才警告进入", () => {
  assert.deepEqual(
    shouldWarnEnterPrimaryBase({
      isPrimary: true,
      isBase: true,
      runningOnPrimary: false,
    }),
    { warn: true, kind: "base" },
  );
  assert.deepEqual(
    shouldWarnEnterPrimaryBase({
      isPrimary: true,
      isBase: false,
      runningOnPrimary: true,
    }),
    { warn: true, kind: "agent" },
  );
  assert.deepEqual(
    shouldWarnEnterPrimaryBase({
      isPrimary: false,
      isBase: false,
      runningOnPrimary: false,
    }),
    { warn: false, kind: null },
  );
});

test("cwd 是否 coding 工作树：功能树不在项目根下", () => {
  const ov = {
    worktrees: [
      { path: "/Users/me/Documents/网页设计" },
      { path: "/Users/me/ccode/worktrees/网页设计/feature/login" },
    ],
  };
  assert.equal(
    cwdIsCodingWorktree(
      "/Users/me/ccode/worktrees/网页设计/feature/login",
      [ov],
      false,
    ),
    true,
  );
  assert.equal(
    cwdIsCodingWorktree("/Users/me/Documents/网页设计", [ov], false),
    true,
  );
  assert.equal(
    cwdIsCodingWorktree("/Users/me/Documents/网页设计-x", [ov], false),
    false,
  );
  assert.equal(
    cwdIsCodingWorktree(
      "/Users/me/ccode/workspaces/网页设计/search",
      [ov],
      false,
    ),
    false,
  );
  assert.equal(
    pathWithin(
      "/Users/me/ccode/worktrees/网页设计/feature/login",
      "/Users/me/Documents/网页设计",
      false,
    ),
    false,
  );
});

test("选择层：占用禁用、远程已有本地不重复、cap 与搜索", () => {
  const rows = remotePickerRows(
    [
      { name: "main", occupiedPath: "/repo" },
      { name: "feat", occupiedPath: null },
    ],
    [
      {
        remote: "origin",
        name: "feat",
        hasLocal: true,
        occupiedPath: null,
      },
      {
        remote: "origin",
        name: "from-gh",
        hasLocal: false,
        occupiedPath: null,
      },
    ],
    "",
  );
  assert.deepEqual(
    rows.map((r) => ({ label: r.label, disabled: r.disabled, source: r.source })),
    [
      { label: "main", disabled: true, source: "local" },
      { label: "feat", disabled: false, source: "local" },
      { label: "origin/from-gh", disabled: false, source: "remote" },
    ],
  );
  assert.equal(remotePickerRows([], [], "", 200).length, 0);
  assert.equal(
    remotePickerRows(
      [{ name: "alpha", occupiedPath: null }],
      [],
      "nope",
    ).length,
    0,
  );
});

test("nextLaneBranchName：再开一条预填", () => {
  assert.equal(nextLaneBranchName("feature/login"), "feature/login-2");
  assert.equal(nextLaneBranchName("feature/login-2"), "feature/login-3");
  assert.equal(nextLaneBranchName("  "), "");
});
