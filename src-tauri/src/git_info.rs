//! 改动面板（§6.9）：git 状态查询与提交/推送。
//! 全部走 std::process::Command 参数数组（无 shell），阻塞调用放 spawn_blocking。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command, Output};

const FILE_DIFF_CAP: usize = 200_000;

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
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    Command::new(git)
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
            xy.chars()
                .find(|c| !c.is_whitespace())
                .unwrap_or('M')
                .to_string()
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

/// 已知二进制扩展名：内容可能是纯 ASCII 开头（部分 PDF 无 NUL 字节），按扩展名直接排除
const BINARY_EXTS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz", "zip", "gz", "tar",
    "zst", "xz", "bz2", "7z", "rar", "parquet", "xlsx", "xls", "docx", "doc", "pptx", "ppt",
    "mp4", "mov", "avi", "mp3", "wav", "flac", "ttf", "otf", "woff", "woff2", "eot", "sqlite",
    "db", "pyc", "so", "dylib", "dll", "exe", "bin", "dat", "sav", "dta", "rds",
];

/// 未跟踪文件的行数作为 additions（best effort：二进制/超大/目录/不可读 → None。
/// 二进制必须探测——PDF 这类文件的换行字节会把面板总增删数顶到几十万）
fn count_lines(cwd: &str, rel: &str) -> Option<u64> {
    use std::io::Read;
    const MAX_SIZE: u64 = 32 * 1024 * 1024;
    const SNIFF: usize = 8192;
    let path = Path::new(cwd).join(rel);
    // 已知二进制扩展名直接排除（内容探测对纯 ASCII 开头的 PDF 会漏判）
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if ext.is_some_and(|e| BINARY_EXTS.contains(&e.as_str())) {
        return None;
    }
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SIZE {
        return None;
    }
    // 头部含 NUL 或不是合法 UTF-8（截断的尾字符除外）即按二进制处理，不计行数
    let mut file = std::fs::File::open(&path).ok()?;
    let mut head = [0u8; SNIFF];
    let n = file.read(&mut head).ok()?;
    let sample = &head[..n];
    if sample.contains(&0) {
        return None;
    }
    if let Err(e) = std::str::from_utf8(sample) {
        // 样本末尾截断多字节字符不算二进制；中途出现非法序列才算
        if e.error_len().is_some() {
            return None;
        }
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(bytes.iter().filter(|b| **b == b'\n').count() as u64)
}

pub(crate) fn git_status_sync(cwd: &str) -> Result<GitStatusDto, String> {
    let cwd = expand_tilde(cwd);
    let check = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !check.status.success() {
        return Ok(GitStatusDto::default()); // is_repo = false，其余默认
    }
    let status_out = run_git(
        &cwd,
        &["status", "--porcelain=v1", "-b", "--untracked-files=all"],
    )?;
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

fn branch_name(cwd: &str) -> Option<String> {
    let o = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if !o.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if b.is_empty() {
        None
    } else {
        Some(b)
    }
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
        return if p2.status.success() {
            Ok(text2)
        } else {
            Err(text2)
        };
    }
    Err(text)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResultDto {
    pub committed: bool,
    pub pushed: bool,
    pub failed_phase: Option<String>,
    pub message: String,
    pub output: String,
}

pub(crate) fn validate_selected_paths(cwd: &str, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("请至少选择一个要提交的文件".into());
    }
    let changed: HashSet<String> = git_status_sync(cwd)?.files.into_iter().map(|f| f.path).collect();
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for path in paths {
        let candidate = Path::new(path);
        if path.trim().is_empty()
            || candidate.is_absolute()
            || candidate.components().any(|part| {
                matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))
            })
        {
            return Err(format!("提交路径必须是仓库内相对路径: {path:?}"));
        }
        if !changed.contains(path) {
            return Err(format!("文件已不在当前改动清单中，请刷新后重试: {path}"));
        }
        if seen.insert(path.clone()) {
            validated.push(path.clone());
        }
    }
    Ok(validated)
}

fn run_git_owned(cwd: &str, args: &[String]) -> Result<Output, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    Command::new(git)
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("执行 git 失败: {e}"))
}

fn git_commit_sync(
    cwd: &str,
    message: &str,
    push: bool,
    paths: Option<&[String]>,
) -> Result<GitCommitResultDto, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    let cwd = expand_tilde(cwd);
    let mut log = String::new();
    let selected = paths
        .map(|paths| validate_selected_paths(&cwd, paths))
        .transpose()?;
    let add = if let Some(selected) = &selected {
        let mut args = vec!["--literal-pathspecs".into(), "add".into(), "-A".into(), "--".into()];
        args.extend(selected.iter().cloned());
        run_git_owned(&cwd, &args)?
    } else {
        run_git(&cwd, &["add", "-A"])?
    };
    if !add.status.success() {
        return Err(output_tail(&add));
    }
    let commit = if let Some(selected) = &selected {
        let mut args = vec![
            "--literal-pathspecs".into(),
            "commit".into(),
            "-m".into(),
            message.into(),
            "--".into(),
        ];
        args.extend(selected.iter().cloned());
        run_git_owned(&cwd, &args)?
    } else {
        run_git(&cwd, &["commit", "-m", message])?
    };
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
                let output = tail_lines(&log, 20);
                return Ok(GitCommitResultDto {
                    committed: true,
                    pushed: false,
                    failed_phase: Some("push".into()),
                    message: "提交已完成，但推送失败；可直接重试推送，无需再次提交".into(),
                    output,
                });
            }
        }
    }
    let output = tail_lines(&log, 20);
    Ok(GitCommitResultDto {
        committed: true,
        pushed: push,
        failed_phase: None,
        message: if push {
            "提交并推送成功"
        } else {
            "提交成功"
        }
        .into(),
        output,
    })
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
pub async fn git_status_map(
    cwd: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_map_sync(&cwd))
        .await
        .map_err(|e| format!("查询 git 状态失败: {e}"))?
}

#[tauri::command]
pub async fn git_commit(
    cwd: String,
    message: String,
    push: bool,
    paths: Option<Vec<String>>,
) -> Result<GitCommitResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_commit_sync(&cwd, &message, push, paths.as_deref())
    })
        .await
        .map_err(|e| format!("提交失败: {e}"))?
}

#[tauri::command]
pub async fn git_push(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_push_sync(&cwd))
        .await
        .map_err(|e| format!("推送失败: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffDto {
    pub text: String,
    pub binary: bool,
    pub truncated: bool,
}

fn truncate_utf8(mut text: String, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text, false);
    }
    let mut end = cap;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n…（diff 过大已截断）");
    (text, true)
}

fn synthetic_untracked_diff(path: &str, bytes: &[u8], source_truncated: bool) -> GitFileDiffDto {
    if bytes.contains(&0) {
        return GitFileDiffDto {
            text: "二进制文件，无法显示文本 diff".into(),
            binary: true,
            truncated: false,
        };
    }
    let content = String::from_utf8_lossy(bytes);
    let mut text = format!("--- /dev/null\n+++ b/{path}\n");
    for line in content.lines() {
        text.push('+');
        text.push_str(line);
        text.push('\n');
        if text.len() > FILE_DIFF_CAP {
            break;
        }
    }
    let (text, capped) = truncate_utf8(text, FILE_DIFF_CAP);
    GitFileDiffDto {
        text,
        binary: false,
        truncated: capped || source_truncated,
    }
}

fn git_file_diff_sync(cwd: &str, path: &str) -> Result<GitFileDiffDto, String> {
    let cwd = expand_tilde(cwd);
    let validated = validate_selected_paths(&cwd, &[path.to_string()])?;
    let path = validated.first().ok_or("文件已不在当前改动清单中")?;
    let status = git_status_sync(&cwd)?.files.into_iter()
        .find(|file| file.path == *path)
        .ok_or_else(|| format!("文件已不在当前改动清单中，请刷新后重试: {path}"))?;

    if status.status == "??" {
        let full = Path::new(&cwd).join(path);
        let file = std::fs::File::open(&full).map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let mut bytes = Vec::with_capacity(FILE_DIFF_CAP + 1);
        file.take((FILE_DIFF_CAP + 1) as u64).read_to_end(&mut bytes)
            .map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let source_truncated = bytes.len() > FILE_DIFF_CAP;
        if source_truncated {
            bytes.truncate(FILE_DIFF_CAP);
        }
        return Ok(synthetic_untracked_diff(path, &bytes, source_truncated));
    }

    let out = run_git(&cwd, &["diff", "HEAD", "--", path])?;
    let mut text = if out.status.success() {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        String::new()
    };
    if !out.status.success() || text.trim().is_empty() {
        let staged = run_git(&cwd, &["diff", "--cached", "--", path])?;
        if !staged.status.success() {
            return Err(if out.status.success() { output_tail(&staged) } else { output_tail(&out) });
        }
        text = String::from_utf8_lossy(&staged.stdout).into_owned();
    }
    let binary = text.lines().any(|line| {
        line.starts_with("Binary files ") || line.starts_with("GIT binary patch")
    });
    if text.trim().is_empty() {
        return Ok(GitFileDiffDto {
            text: "该文件没有可显示的文本 diff".into(),
            binary,
            truncated: false,
        });
    }
    let (text, truncated) = truncate_utf8(text, FILE_DIFF_CAP);
    Ok(GitFileDiffDto { text, binary, truncated })
}

/// 普通仓库单文件 diff：仅允许读取当前 git status 中的安全相对路径。
#[tauri::command]
pub async fn git_file_diff(cwd: String, path: String) -> Result<GitFileDiffDto, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_diff_sync(&cwd, &path))
        .await
        .map_err(|e| format!("读取 diff 失败: {e}"))?
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
    if let Ok(porc) = run_git(&wt, &["status", "--porcelain=v1", "--untracked-files=all"]) {
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
        let file = std::fs::File::open(&full).map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let mut bytes = Vec::with_capacity(FILE_DIFF_CAP + 1);
        file.take((FILE_DIFF_CAP + 1) as u64).read_to_end(&mut bytes)
            .map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let source_truncated = bytes.len() > FILE_DIFF_CAP;
        if source_truncated {
            bytes.truncate(FILE_DIFF_CAP);
        }
        if bytes.contains(&0) {
            return Ok("二进制文件，无法显示文本 diff".into());
        }
        let content = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = content.lines().collect();
        text = lines
            .iter()
            .take(400)
            .map(|l| format!("+{l}"))
            .collect::<Vec<_>>()
            .join("\n");
        if source_truncated {
            text.push_str("\n…（文件过大，已截断）");
        } else if lines.len() > 400 {
            text.push_str(&format!("\n…（共 {} 行，已截断）", lines.len()));
        }
    }
    Ok(truncate_utf8(text, FILE_DIFF_CAP).0)
}

/// 单文件任务 diff 内容（工作区「评审」面板展开用）
#[tauri::command]
pub async fn workspace_file_diff(worktree_path: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wt = expand_tilde(&worktree_path);
        let rows = crate::workspaces::worktree_rows();
        let row = find_worktree_row(&wt, &rows).ok_or("该目录不在任何工作区内")?;
        let current = workspace_diff_with_rows(&wt, &rows)?;
        if !current.files.iter().any(|file| file.path == path) {
            return Err(format!("文件已不在当前任务改动清单中，请刷新后重试: {path}"));
        }
        file_diff_impl(&wt, &row.base_branch, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 图片双栏评审（P3 图片评审）：基准版 vs 当前版字节对 =====

/// 单文件上限：图片必须完整传输，超限直接拒绝（同 pdf.rs 的「截断无意义」口径）
const IMAGE_PAIR_CAP: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitImagePairDto {
    /// base64 编码的基准版字节；基准中不存在（新增图片）→ None
    pub base: Option<String>,
    /// base64 编码的当前版字节；文件已删除 → None
    pub current: Option<String>,
    pub base_label: String,
    pub current_label: String,
}

/// 图片扩展名判定（与前端 ImagePairView 的 isImagePath 保持同一清单）
fn is_image_path(path: &str) -> bool {
    let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp")
    )
}

/// 取 `git show <spec>` 的原始字节；对象不存在 → None（新增图片的基准侧）
fn git_show_image(cwd: &str, spec: &str) -> Result<Option<Vec<u8>>, String> {
    // 先查对象大小，避免超大图片整个读进内存才发现超限
    let size = run_git(cwd, &["cat-file", "-s", spec])?;
    if !size.status.success() {
        return Ok(None);
    }
    let size: u64 = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse()
        .map_err(|_| format!("无法解析 {spec} 的对象大小"))?;
    if size > IMAGE_PAIR_CAP {
        return Err(format!(
            "图片超过 20 MB（{:.1} MB），暂不支持双栏查看",
            size as f64 / 1024.0 / 1024.0
        ));
    }
    let out = run_git(cwd, &["show", spec])?;
    if !out.status.success() {
        return Err(output_tail(&out));
    }
    Ok(Some(out.stdout))
}

/// 读工作树当前文件字节；文件不存在 → None（删除图片的当前侧）
fn read_current_image(root: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let full = Path::new(root).join(path);
    if !full.is_file() {
        return Ok(None);
    }
    let size = std::fs::metadata(&full)
        .map_err(|e| format!("读取 {path} 失败: {e}"))?
        .len();
    if size > IMAGE_PAIR_CAP {
        return Err(format!(
            "图片超过 20 MB（{:.1} MB），暂不支持双栏查看",
            size as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read(&full)
        .map(Some)
        .map_err(|e| format!("读取 {path} 失败: {e}"))
}

fn encode_base64(bytes: Vec<u8>) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn image_pair_sync(cwd: &str, path: &str) -> Result<GitImagePairDto, String> {
    let cwd = expand_tilde(cwd);
    if !is_image_path(path) {
        return Err(format!("不是可双栏查看的图片文件: {path}"));
    }
    let rows = crate::workspaces::worktree_rows();
    // 白名单沿用 diff 安全规则：工作区 = 任务 diff 清单内；普通仓库 = status 中的安全相对路径
    let (root, base_spec, base_label) = if let Some(row) = find_worktree_row(&cwd, &rows) {
        let diff = workspace_diff_with_rows(&cwd, &rows)?;
        if !diff.files.iter().any(|file| file.path == path) {
            return Err(format!("文件已不在当前任务改动清单中，请刷新后重试: {path}"));
        }
        (
            row.worktree_path.clone(),
            format!("{}:{path}", diff.merge_base),
            format!("基准 {}", row.base_branch),
        )
    } else {
        let validated = validate_selected_paths(&cwd, &[path.to_string()])?;
        let path = validated.first().ok_or("文件已不在当前改动清单中")?;
        (cwd.clone(), format!("HEAD:{path}"), "HEAD".to_string())
    };
    let base = git_show_image(&cwd, &base_spec)?;
    let current = read_current_image(&root, path)?;
    Ok(GitImagePairDto {
        base: base.map(encode_base64),
        current: current.map(encode_base64),
        base_label,
        current_label: "当前".into(),
    })
}

/// 图片文件双栏评审：基准版（普通仓库 = HEAD，工作区 = merge-base）vs 当前版。
/// base64 传输（macOS Raw 响应退化为逐字节 JSON，理由同 pdf.rs）。
#[tauri::command]
pub async fn git_image_pair(cwd: String, path: String) -> Result<GitImagePairDto, String> {
    tauri::async_runtime::spawn_blocking(move || image_pair_sync(&cwd, &path))
        .await
        .map_err(|e| format!("读取图片失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 测试也统一走 resolve_binary（与生产代码同一解析路径）
    fn git_bin() -> PathBuf {
        crate::agents::resolve_binary("git").expect("测试环境找不到 git 可执行文件")
    }

    fn git_available() -> bool {
        crate::agents::resolve_binary("git")
            .map(|git| {
                Command::new(git)
                    .arg("--version")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-git-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new(git_bin())
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
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
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
    fn status_untracked_binary_not_counted() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status-binary");
        git(&dir, &["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"]);
        // 含 NUL 的伪 PDF 二进制：换行字节极多，但不得计入增删统计
        let mut blob = b"%PDF-1.7 fake".to_vec();
        blob.extend_from_slice(&[0u8; 16]);
        blob.extend(std::iter::repeat(b'\n').take(5000));
        fs::write(dir.join("paper.pdf"), &blob).unwrap();
        fs::write(dir.join("notes.md"), "a\nb\n").unwrap();

        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        let pdf = s.files.iter().find(|f| f.path == "paper.pdf").unwrap();
        assert_eq!(pdf.additions, None, "二进制未跟踪文件不应计行数");
        let md = s.files.iter().find(|f| f.path == "notes.md").unwrap();
        assert_eq!(md.additions, Some(2));
        assert_eq!(s.total_add, 2, "总数不得被二进制换行字节污染");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_untracked_ascii_header_pdf_not_counted() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status-ascii-pdf");
        git(&dir, &["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"]);
        // 纯 ASCII 开头、无 NUL 的 PDF（真实世界存在）：靠扩展名拦截，内容探测会漏
        let mut blob = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n".to_vec();
        for _ in 0..1000 {
            blob.extend_from_slice(b"ascii stream line\n");
        }
        fs::write(dir.join("clean.pdf"), &blob).unwrap();

        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        let pdf = s.files.iter().find(|f| f.path == "clean.pdf").unwrap();
        assert_eq!(pdf.additions, None, "ASCII 开头的 PDF 也不应计行数");
        assert_eq!(s.total_add, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_flow_leaves_clean_status() {
        if !git_available() {
            return;
        }
        let dir = init_repo("commit");
        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let result = git_commit_sync(dir.to_str().unwrap(), "初始提交", false, None).unwrap();
        assert!(result.committed);
        assert!(!result.pushed);
        assert!(result.failed_phase.is_none());
        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(s.is_repo);
        assert!(s.files.is_empty(), "提交后工作区应干净: {:?}", s.files);
        assert!(git_commit_sync(dir.to_str().unwrap(), "   ", false, None).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_success_push_failure_is_partial_success() {
        if !git_available() {
            return;
        }
        let dir = init_repo("commit-push-partial");
        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let result = git_commit_sync(dir.to_str().unwrap(), "提交但无远端", true, None).unwrap();
        assert!(result.committed);
        assert!(!result.pushed);
        assert_eq!(result.failed_phase.as_deref(), Some("push"));
        assert!(result.message.contains("无需再次提交"));
        assert!(git_status_sync(dir.to_str().unwrap())
            .unwrap()
            .files
            .is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn selective_commit_leaves_unselected_changes_untouched() {
        if !git_available() {
            return;
        }
        let dir = init_repo("selective-commit");
        fs::write(dir.join("a.txt"), "base-a\n").unwrap();
        fs::write(dir.join("b.txt"), "base-b\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(dir.join("a.txt"), "changed-a\n").unwrap();
        fs::write(dir.join("b.txt"), "changed-b\n").unwrap();

        let selected = vec!["a.txt".to_string()];
        let result = git_commit_sync(
            dir.to_str().unwrap(),
            "只提交 a",
            false,
            Some(&selected),
        )
        .unwrap();
        assert!(result.committed);
        let status = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "b.txt");
        let head_a = run_git(dir.to_str().unwrap(), &["show", "HEAD:a.txt"]).unwrap();
        let head_b = run_git(dir.to_str().unwrap(), &["show", "HEAD:b.txt"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&head_a.stdout), "changed-a\n");
        assert_eq!(String::from_utf8_lossy(&head_b.stdout), "base-b\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn selective_commit_rejects_path_escape_and_stale_file() {
        if !git_available() {
            return;
        }
        let dir = init_repo("selective-invalid");
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        let escape = vec!["../outside".to_string()];
        assert!(git_commit_sync(dir.to_str().unwrap(), "bad", false, Some(&escape))
            .unwrap_err()
            .contains("相对路径"));
        let stale = vec!["missing.txt".to_string()];
        assert!(git_commit_sync(dir.to_str().unwrap(), "bad", false, Some(&stale))
            .unwrap_err()
            .contains("不在当前改动清单"));
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
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(dir.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(dir.join("b.txt"), "new\n").unwrap();
        let map = git_status_map_sync(dir.to_str().unwrap()).unwrap();
        assert_eq!(
            map.get(dir.join("a.txt").to_str().unwrap()),
            Some(&"M".to_string())
        );
        assert_eq!(
            map.get(dir.join("b.txt").to_str().unwrap()),
            Some(&"??".to_string())
        );
        assert!(!map.contains_key(dir.join("c.txt").to_str().unwrap()));
        // 非仓库 → 空表
        let plain = tmpdir("status-map-plain");
        assert!(git_status_map_sync(plain.to_str().unwrap())
            .unwrap()
            .is_empty());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&plain).ok();
    }

    #[test]
    fn porcelain_header_parses_branch_ahead_behind() {
        let (branch, ahead, behind, files) =
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
        git(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(&repo, &["push", "-u", "origin", "main"]);
        let wt = dir.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                wt.to_str().unwrap(),
                "-b",
                "ccode/t1",
                "origin/main",
            ],
        );
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
        assert_eq!(
            a.additions,
            Some(3),
            "merge-base 起累计：已提交 2 行 + 未提交 1 行"
        );
        assert_eq!(a.status, "M");
        let n = d.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(n.status, "??");
        assert_eq!(n.additions, Some(3));
        assert_eq!(d.total_add, 6);
        // 非工作区路径：in_workspace=false，前端回落普通 git_status
        let outside = workspace_diff_with_rows(repo.to_str().unwrap(), &rows).unwrap();
        assert!(!outside.in_workspace);
        git(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
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
        git(
            &repo,
            &[
                "worktree",
                "add",
                wt.to_str().unwrap(),
                "-b",
                "ccode/t1",
                "main",
            ],
        );
        // 已跟踪文件：改一行 → diff 含 +/-；未跟踪文件 → 全文按新增
        fs::write(wt.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(wt.join("new.txt"), "x\ny\n").unwrap();
        let tracked = file_diff_impl(wt.to_str().unwrap(), "main", "a.txt").unwrap();
        assert!(
            tracked.contains("-l1") || tracked.contains(" l1"),
            "{tracked}"
        );
        assert!(tracked.contains("+l2"), "{tracked}");
        let untracked = file_diff_impl(wt.to_str().unwrap(), "main", "new.txt").unwrap();
        assert_eq!(untracked, "+x\n+y");
        git(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn generic_file_diff_is_safe_and_handles_binary_untracked_files() {
        if !git_available() {
            return;
        }
        let repo = init_repo("generic-file-diff");
        fs::write(repo.join("a.txt"), "before\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
        fs::write(repo.join("a.txt"), "after\n").unwrap();
        fs::write(repo.join("image.bin"), [0, 1, 2, 3]).unwrap();

        let tracked = git_file_diff_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        assert!(tracked.text.contains("-before"));
        assert!(tracked.text.contains("+after"));
        let binary = git_file_diff_sync(repo.to_str().unwrap(), "image.bin").unwrap();
        assert!(binary.binary);
        assert!(git_file_diff_sync(repo.to_str().unwrap(), "../outside").is_err());
        fs::remove_dir_all(&repo).ok();
    }

    fn decode(dto_data: &Option<String>) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(dto_data.as_ref().expect("应有 base64 数据"))
            .unwrap()
    }

    #[test]
    fn image_pair_normal_repo_base_and_current() {
        if !git_available() {
            return;
        }
        let repo = init_repo("img-pair");
        fs::write(repo.join("pic.png"), b"\x89PNG-v1").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(repo.join("pic.png"), b"\x89PNG-v2").unwrap();

        let dto = image_pair_sync(repo.to_str().unwrap(), "pic.png").unwrap();
        assert_eq!(dto.base_label, "HEAD");
        assert_eq!(dto.current_label, "当前");
        assert_eq!(decode(&dto.base), b"\x89PNG-v1");
        assert_eq!(decode(&dto.current), b"\x89PNG-v2");
        // 白名单：不在 status 中的路径与逃逸路径都拒绝
        assert!(image_pair_sync(repo.to_str().unwrap(), "missing.png").is_err());
        assert!(image_pair_sync(repo.to_str().unwrap(), "../outside.png").is_err());
        // 非图片扩展名拒绝
        let err = image_pair_sync(repo.to_str().unwrap(), "notes.txt").unwrap_err();
        assert!(err.contains("不是可双栏查看的图片文件"), "{err}");
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn image_pair_added_and_deleted_have_single_empty_side() {
        if !git_available() {
            return;
        }
        let repo = init_repo("img-sides");
        fs::write(repo.join("old.png"), b"\x89PNG-old").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        // 新增（未跟踪）：base 为空
        fs::write(repo.join("new.png"), b"\x89PNG-new").unwrap();
        let added = image_pair_sync(repo.to_str().unwrap(), "new.png").unwrap();
        assert!(added.base.is_none());
        assert_eq!(decode(&added.current), b"\x89PNG-new");
        // 删除：current 为空
        fs::remove_file(repo.join("old.png")).unwrap();
        let deleted = image_pair_sync(repo.to_str().unwrap(), "old.png").unwrap();
        assert_eq!(decode(&deleted.base), b"\x89PNG-old");
        assert!(deleted.current.is_none());
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn image_pair_rejects_oversize() {
        if !git_available() {
            return;
        }
        let repo = init_repo("img-cap");
        let f = repo.join("huge.png");
        // 稀疏文件置长度，避免真的写 20MB
        let file = fs::File::create(&f).unwrap();
        file.set_len(IMAGE_PAIR_CAP + 1).unwrap();
        drop(file);
        let err = image_pair_sync(repo.to_str().unwrap(), "huge.png").unwrap_err();
        assert!(err.contains("20 MB"), "{err}");
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn image_pair_workspace_base_is_merge_base() {
        if !git_available() {
            return;
        }
        let dir = tmpdir("img-ws");
        let repo = dir.join("repo");
        git(&dir, &["init", "-b", "main", "repo"]);
        git(&repo, &["config", "user.email", "t@t.dev"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("pic.png"), b"\x89PNG-v1").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        let wt = dir.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                wt.to_str().unwrap(),
                "-b",
                "ccode/t1",
                "main",
            ],
        );
        // 任务分支上改图并提交：基准应取 merge-base（即 main 的 v1）
        fs::write(wt.join("pic.png"), b"\x89PNG-v2").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-m", "task"]);
        let rows = vec![crate::workspaces::WorktreeRow {
            id: "ws-1".into(),
            worktree_path: wt.to_string_lossy().into_owned(),
            repo_path: repo.to_string_lossy().into_owned(),
            name: "t1".into(),
            branch: "ccode/t1".into(),
            base_branch: "main".into(),
        }];
        // image_pair_sync 走全局 worktree_rows()，测试里直接验证内部判定逻辑：
        // 白名单用任务 diff 清单、基准用 merge-base
        let diff = workspace_diff_with_rows(wt.to_str().unwrap(), &rows).unwrap();
        assert!(diff.files.iter().any(|f| f.path == "pic.png"));
        let base = git_show_image(
            wt.to_str().unwrap(),
            &format!("{}:pic.png", diff.merge_base),
        )
        .unwrap()
        .unwrap();
        assert_eq!(base, b"\x89PNG-v1");
        let current = read_current_image(&wt.to_string_lossy(), "pic.png")
            .unwrap()
            .unwrap();
        assert_eq!(current, b"\x89PNG-v2");
        git(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        fs::remove_dir_all(&dir).ok();
    }
}
