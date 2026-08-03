//! 改动面板（§6.9）：git 状态查询与提交/推送。
//! 全部走 std::process::Command 参数数组（无 shell），阻塞调用放 spawn_blocking。

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Output};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDto {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileDto>,
    pub total_add: u64,
    pub total_del: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDto {
    pub path: String,
    /// "M" | "A" | "D" | "R" | "??"
    pub status: String,
    /// 二进制文件为 None（numstat 显示 -\t-）
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

pub(crate) fn run_git(cwd: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("执行 git 失败: {e}"))
}

/// stdout+stderr 合并取尾部 ~20 行，作为命令结果/错误展示
fn output_tail(o: &Output) -> String {
    let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
    let err = String::from_utf8_lossy(&o.stderr);
    if !s.is_empty() && !err.is_empty() {
        s.push('\n');
    }
    s.push_str(&err);
    tail_lines(&s, 20)
}

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.trim_end().lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// 解析 `git status --porcelain=v1 -b`：
/// 返回 (branch, ahead, behind, [(status, path)])
fn parse_porcelain(text: &str) -> (String, u32, u32, Vec<(String, String)>) {
    let mut branch = String::new();
    let (mut ahead, mut behind) = (0, 0);
    let mut files = Vec::new();
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" / "main" / "No commits yet on main"
            if let Some(b) = h.strip_prefix("No commits yet on ") {
                branch = b.trim().to_string();
                continue;
            }
            let (b, rest) = match h.split_once("...") {
                Some((b, r)) => (b, r),
                None => (h, ""),
            };
            branch = b.trim().to_string();
            if let Some(start) = rest.find('[') {
                if let Some(end) = rest[start..].find(']') {
                    for part in rest[start + 1..start + end].split(',') {
                        let part = part.trim();
                        if let Some(n) = part.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        if xy == "!!" {
            continue; // gitignore 忽略的条目
        }
        let status = if xy == "??" {
            "??".to_string()
        } else {
            xy.chars().find(|c| !c.is_whitespace()).unwrap_or('M').to_string()
        };
        let mut path = line[3..].to_string();
        // 重命名条目形如 "old -> new"，取新名
        if let Some((_, new)) = path.split_once(" -> ") {
            path = new.to_string();
        }
        // 含空格/特殊字符的路径 git 会加引号
        if path.len() >= 2 && path.starts_with('"') && path.ends_with('"') {
            path = path[1..path.len() - 1].to_string();
        }
        files.push((status, path));
    }
    (branch, ahead, behind, files)
}

/// 解析 `git diff --numstat HEAD`：path → (add, del)；二进制行（-\t-）跳过
fn parse_numstat(text: &str) -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let (Ok(a), Ok(d)) = (a.parse::<u64>(), d.parse::<u64>()) {
            map.insert(p.to_string(), (a, d));
        }
    }
    map
}

/// 未跟踪文件的行数作为 additions（best effort，目录/不可读 → None）
fn count_lines(cwd: &str, rel: &str) -> Option<u64> {
    let bytes = std::fs::read(Path::new(cwd).join(rel)).ok()?;
    Some(bytes.iter().filter(|b| **b == b'\n').count() as u64)
}

fn git_status_sync(cwd: &str) -> Result<GitStatusDto, String> {
    let cwd = expand_tilde(cwd);
    let check = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !check.status.success() {
        return Ok(GitStatusDto::default()); // is_repo = false，其余默认
    }
    let status_out = run_git(&cwd, &["status", "--porcelain=v1", "-b"])?;
    if !status_out.status.success() {
        return Err(output_tail(&status_out));
    }
    let (branch, ahead, behind, raw_files) =
        parse_porcelain(&String::from_utf8_lossy(&status_out.stdout));
    // 空仓库（无 HEAD）numstat 会失败，此时 tracked 增量拿不到，按 None 处理
    let numstat = run_git(&cwd, &["diff", "--numstat", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_numstat(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    let mut files = Vec::new();
    let (mut total_add, mut total_del) = (0, 0);
    for (status, path) in raw_files {
        let (additions, deletions) = if status == "??" {
            (count_lines(&cwd, &path), Some(0))
        } else {
            match numstat.get(&path) {
                Some((a, d)) => (Some(*a), Some(*d)),
                None => (None, None),
            }
        };
        total_add += additions.unwrap_or(0);
        total_del += deletions.unwrap_or(0);
        files.push(GitFileDto {
            path,
            status,
            additions,
            deletions,
        });
    }
    Ok(GitStatusDto {
        is_repo: true,
        branch,
        ahead,
        behind,
        files,
        total_add,
        total_del,
    })
}

/// 文件树 git 装饰（P4）：变更/未跟踪文件的绝对路径 → 状态字母；非仓库返回空表
fn git_status_map_sync(cwd: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let cwd = expand_tilde(cwd);
    let check = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !check.status.success() {
        return Ok(std::collections::HashMap::new());
    }
    let out = run_git(&cwd, &["status", "--porcelain=v1"])?;
    if !out.status.success() {
        return Err(output_tail(&out));
    }
    let (_, _, _, files) = parse_porcelain(&String::from_utf8_lossy(&out.stdout));
    let mut map = std::collections::HashMap::new();
    for (status, rel) in files {
        let abs = Path::new(&cwd).join(&rel).to_string_lossy().into_owned();
        map.insert(abs, status);
    }
    Ok(map)
}

fn branch_name(cwd: &str) -> Option<String> {    let o = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if !o.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if b.is_empty() { None } else { Some(b) }
}

fn do_push(cwd: &str) -> Result<String, String> {
    let p = run_git(cwd, &["push"])?;
    if p.status.success() {
        return Ok(output_tail(&p));
    }
    let text = output_tail(&p);
    // 没有上游分支时按 git 自己的提示补 -u origin <branch> 重试
    let lower = text.to_lowercase();
    if lower.contains("no upstream") || lower.contains("set-upstream") {
        let branch = branch_name(cwd).unwrap_or_else(|| "HEAD".into());
        let p2 = run_git(cwd, &["push", "-u", "origin", &branch])?;
        let text2 = output_tail(&p2);
        return if p2.status.success() { Ok(text2) } else { Err(text2) };
    }
    Err(text)
}

fn git_commit_sync(cwd: &str, message: &str, push: bool) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    let cwd = expand_tilde(cwd);
    let mut log = String::new();
    let add = run_git(&cwd, &["add", "-A"])?;
    if !add.status.success() {
        return Err(output_tail(&add));
    }
    let commit = run_git(&cwd, &["commit", "-m", message])?;
    log.push_str(&output_tail(&commit));
    if !commit.status.success() {
        return Err(tail_lines(&log, 20));
    }
    if push {
        match do_push(&cwd) {
            Ok(t) => {
                if !t.is_empty() {
                    log.push('\n');
                    log.push_str(&t);
                }
            }
            Err(t) => {
                log.push('\n');
                log.push_str(&t);
                return Err(tail_lines(&log, 20));
            }
        }
    }
    Ok(tail_lines(&log, 20))
}

fn git_push_sync(cwd: &str) -> Result<String, String> {
    do_push(&expand_tilde(cwd))
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_sync(&cwd))
        .await
        .map_err(|e| format!("查询 git 状态失败: {e}"))?
}

#[tauri::command]
pub async fn git_status_map(cwd: String) -> Result<std::collections::HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_map_sync(&cwd))
        .await
        .map_err(|e| format!("查询 git 状态失败: {e}"))?
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String, push: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_sync(&cwd, &message, push))
        .await
        .map_err(|e| format!("提交失败: {e}"))?
}

#[tauri::command]
pub async fn git_push(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_push_sync(&cwd))
        .await
        .map_err(|e| format!("推送失败: {e}"))?
}

// ===== 工作区任务 diff（§6.10 阶段 C：基准从 HEAD 改为 merge-base） =====

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiffDto {
    pub in_workspace: bool,
    pub workspace_id: String,
    pub workspace_name: String,
    pub branch: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub merge_base: String,
    pub files: Vec<GitFileDto>,
    pub total_add: u64,
    pub total_del: u64,
}

/// 累计任务改动 = diff merge-base（已提交 + 未提交的已跟踪部分）+ 未跟踪文件行数。
/// rows 参数化以便测试注入；命中不到工作区时返回默认（前端回落普通 git_status）
fn find_worktree_row<'a>(
    wt: &str,
    rows: &'a [crate::workspaces::WorktreeRow],
) -> Option<&'a crate::workspaces::WorktreeRow> {
    rows.iter().find(|r| {
        let p = r.worktree_path.trim_end_matches('/');
        wt == p || wt.starts_with(&format!("{p}/"))
    })
}

fn workspace_diff_with_rows(
    worktree_path: &str,
    rows: &[crate::workspaces::WorktreeRow],
) -> Result<WorkspaceDiffDto, String> {
    let wt = expand_tilde(worktree_path);
    let Some(row) = find_worktree_row(&wt, rows) else {
        return Ok(WorkspaceDiffDto::default());
    };
    // 与 §6.10 生命周期一致：基准固定为本地分支（worktree 即从本地基准拉出，
    // 用 origin 会把基准上未推送的提交误算进任务改动）
    let base_ref = row.base_branch.clone();
    let mb = run_git(&wt, &["merge-base", &base_ref, "HEAD"])?;
    if !mb.status.success() {
        return Err(output_tail(&mb));
    }
    let merge_base = String::from_utf8_lossy(&mb.stdout).trim().to_string();
    let numstat = run_git(&wt, &["diff", "--numstat", &merge_base])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_numstat(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    // name-status 给每个文件的改动类型（R 取新名）
    let mut status_map: HashMap<String, String> = HashMap::new();
    if let Ok(ns) = run_git(&wt, &["diff", "--name-status", &merge_base]) {
        if ns.status.success() {
            for line in String::from_utf8_lossy(&ns.stdout).lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    let letter = parts[0].chars().next().unwrap_or('M').to_string();
                    let path = parts.last().map_or("", |v| v).to_string();
                    status_map.insert(path, letter);
                }
            }
        }
    }
    let mut files = Vec::new();
    let (mut total_add, mut total_del) = (0u64, 0u64);
    for (path, (a, d)) in &numstat {
        total_add += a;
        total_del += d;
        files.push(GitFileDto {
            path: path.clone(),
            status: status_map.get(path).cloned().unwrap_or_else(|| "M".into()),
            additions: Some(*a),
            deletions: Some(*d),
        });
    }
    // 未跟踪文件：numstat 覆盖不到，行数当 additions（与 git_status 同一口径）
    if let Ok(porc) = run_git(&wt, &["status", "--porcelain=v1"]) {
        if porc.status.success() {
            let (_, _, _, raw) = parse_porcelain(&String::from_utf8_lossy(&porc.stdout));
            for (status, path) in raw {
                if status != "??" {
                    continue;
                }
                let additions = count_lines(&wt, &path);
                total_add += additions.unwrap_or(0);
                files.push(GitFileDto {
                    path,
                    status: "??".into(),
                    additions,
                    deletions: Some(0),
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(WorkspaceDiffDto {
        in_workspace: true,
        workspace_id: row.id.clone(),
        workspace_name: row.name.clone(),
        branch: row.branch.clone(),
        worktree_path: row.worktree_path.clone(),
        base_branch: row.base_branch.clone(),
        merge_base,
        files,
        total_add,
        total_del,
    })
}

#[tauri::command]
pub async fn workspace_diff(worktree_path: String) -> Result<WorkspaceDiffDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace_diff_with_rows(&worktree_path, &crate::workspaces::worktree_rows())
    })
    .await
    .map_err(|e| format!("计算工作区 diff 失败: {e}"))?
}

/// 单文件任务 diff 的实现（worktree 路径 + 基准分支直给，便于测试）：
/// 未跟踪新文件 git diff 为空 → 读全文按全新增返回（400 行截断）；大 diff 200KB 截断
fn file_diff_impl(wt: &str, base_branch: &str, path: &str) -> Result<String, String> {
    let mb = run_git(wt, &["merge-base", base_branch, "HEAD"])?;
    if !mb.status.success() {
        return Err(output_tail(&mb));
    }
    let mb = String::from_utf8_lossy(&mb.stdout).trim().to_string();
    let out = run_git(wt, &["diff", &mb, "--", path])?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        let full = std::path::Path::new(wt).join(path);
        let content =
            std::fs::read_to_string(&full).map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let lines: Vec<&str> = content.lines().collect();
        text = lines
            .iter()
            .take(400)
            .map(|l| format!("+{l}"))
            .collect::<Vec<_>>()
            .join("\n");
        if lines.len() > 400 {
            text.push_str(&format!("\n…（共 {} 行，已截断）", lines.len()));
        }
    }
    const CAP: usize = 200_000;
    if text.len() > CAP {
        text.truncate(CAP);
        text.push_str("\n…（diff 过大已截断）");
    }
    Ok(text)
}

/// 单文件任务 diff 内容（工作区「评审」面板展开用）
#[tauri::command]
pub async fn workspace_file_diff(worktree_path: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wt = expand_tilde(&worktree_path);
        let rows = crate::workspaces::worktree_rows();
        let row = find_worktree_row(&wt, &rows).ok_or("该目录不在任何工作区内")?;
        file_diff_impl(&wt, &row.base_branch, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-git-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(name: &str) -> PathBuf {
        let dir = tmpdir(name);
        git(&dir, &["init", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t.dev"]);
        git(&dir, &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn status_parses_modified_and_untracked() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status");
        fs::write(dir.join("a.txt"), "l1\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
        fs::write(dir.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(dir.join("b.txt"), "x\ny\nz\n").unwrap();

        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(s.is_repo);
        assert_eq!(s.branch, "main");
        let a = s.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, "M");
        assert_eq!(a.additions, Some(1));
        assert_eq!(a.deletions, Some(0));
        let b = s.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(b.status, "??");
        assert_eq!(b.additions, Some(3));
        assert_eq!(b.deletions, Some(0));
        assert_eq!(s.total_add, 4);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_flow_leaves_clean_status() {
        if !git_available() {
            return;
        }
        let dir = init_repo("commit");
        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        git_commit_sync(dir.to_str().unwrap(), "初始提交", false).unwrap();
        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(s.is_repo);
        assert!(s.files.is_empty(), "提交后工作区应干净: {:?}", s.files);
        assert!(git_commit_sync(dir.to_str().unwrap(), "   ", false).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn not_a_repo_returns_default() {
        let dir = tmpdir("norepo");
        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(!s.is_repo);
        assert!(s.files.is_empty());
        assert_eq!(s.total_add, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_map_marks_changed_and_untracked() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status-map");
        fs::write(dir.join("a.txt"), "l1\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
        fs::write(dir.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(dir.join("b.txt"), "new\n").unwrap();
        let map = git_status_map_sync(dir.to_str().unwrap()).unwrap();
        assert_eq!(map.get(dir.join("a.txt").to_str().unwrap()), Some(&"M".to_string()));
        assert_eq!(map.get(dir.join("b.txt").to_str().unwrap()), Some(&"??".to_string()));
        assert!(!map.contains_key(dir.join("c.txt").to_str().unwrap()));
        // 非仓库 → 空表
        let plain = tmpdir("status-map-plain");
        assert!(git_status_map_sync(plain.to_str().unwrap()).unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&plain).ok();
    }

    #[test]
    fn porcelain_header_parses_branch_ahead_behind() {        let (branch, ahead, behind, files) =
            parse_porcelain("## main...origin/main [ahead 2, behind 3]\n M a.rs\n?? new.txt\n");
        assert_eq!((branch.as_str(), ahead, behind), ("main", 2, 3));
        assert_eq!(files.len(), 2);
        assert_eq!(files[1], ("??".to_string(), "new.txt".to_string()));

        let (b2, a2, b22, _) = parse_porcelain("## No commits yet on dev\n");
        assert_eq!((b2.as_str(), a2, b22), ("dev", 0, 0));

        let (_, _, _, files3) = parse_porcelain("R  old.rs -> new.rs\n");
        assert_eq!(files3[0], ("R".to_string(), "new.rs".to_string()));
    }

    #[test]
    fn workspace_diff_accumulates_committed_uncommitted_untracked() {
        if !git_available() {
            return;
        }
        let dir = tmpdir("wsdiff");
        let repo = dir.join("repo");
        git(&dir, &["init", "-b", "main", "repo"]);
        git(&repo, &["config", "user.email", "t@t.dev"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "l1\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        let origin = dir.join("origin.git");
        git(&dir, &["init", "--bare", "origin.git"]);
        git(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        let wt = dir.join("wt");
        git(&repo, &["worktree", "add", wt.to_str().unwrap(), "-b", "ccode/t1", "origin/main"]);
        // 累计改动：已提交 +2 行、未提交 +1 行、未跟踪 3 行
        fs::write(wt.join("a.txt"), "l1\nl2\nl3\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-m", "task"]);
        fs::write(wt.join("a.txt"), "l1\nl2\nl3\nl4\n").unwrap();
        fs::write(wt.join("new.txt"), "x\ny\nz\n").unwrap();
        let rows = vec![crate::workspaces::WorktreeRow {
            id: "ws-1".into(),
            worktree_path: wt.to_string_lossy().into_owned(),
            repo_path: repo.to_string_lossy().into_owned(),
            name: "t1".into(),
            branch: "ccode/t1".into(),
            base_branch: "main".into(),
        }];
        let d = workspace_diff_with_rows(wt.to_str().unwrap(), &rows).unwrap();
        assert!(d.in_workspace);
        assert_eq!(d.workspace_id, "ws-1");
        assert_eq!(d.workspace_name, "t1");
        assert_eq!(d.branch, "ccode/t1");
        assert_eq!(d.base_branch, "main");
        assert!(!d.merge_base.is_empty());
        let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.additions, Some(3), "merge-base 起累计：已提交 2 行 + 未提交 1 行");
        assert_eq!(a.status, "M");
        let n = d.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(n.status, "??");
        assert_eq!(n.additions, Some(3));
        assert_eq!(d.total_add, 6);
        // 非工作区路径：in_workspace=false，前端回落普通 git_status
        let outside = workspace_diff_with_rows(repo.to_str().unwrap(), &rows).unwrap();
        assert!(!outside.in_workspace);
        git(&repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_diff_shows_tracked_changes_and_untracked_as_all_added() {
        if !git_available() {
            return;
        }
        let dir = tmpdir("wsfdiff");
        let repo = dir.join("repo");
        git(&dir, &["init", "-b", "main", "repo"]);
        git(&repo, &["config", "user.email", "t@t.dev"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "l1\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        let wt = dir.join("wt");
        git(&repo, &["worktree", "add", wt.to_str().unwrap(), "-b", "ccode/t1", "main"]);
        // 已跟踪文件：改一行 → diff 含 +/-；未跟踪文件 → 全文按新增
        fs::write(wt.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(wt.join("new.txt"), "x\ny\n").unwrap();
        let tracked = file_diff_impl(wt.to_str().unwrap(), "main", "a.txt").unwrap();
        assert!(tracked.contains("-l1") || tracked.contains(" l1"), "{tracked}");
        assert!(tracked.contains("+l2"), "{tracked}");
        let untracked = file_diff_impl(wt.to_str().unwrap(), "main", "new.txt").unwrap();
        assert_eq!(untracked, "+x\n+y");
        git(&repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        fs::remove_dir_all(&dir).ok();
    }
}
