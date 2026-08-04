use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ===== DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResultDto {
    pub ok: bool,
    pub output_tail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub repo_path: String,
    pub repo_name: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub port_base: i64,
    pub status: String, // creating | active | archived
    pub created_at: String,
    pub archived_at: Option<String>,
    /// 已合并进基准分支的时间（仅「合并（保留工作区）」后置位；继续提交后前端按 ahead>0 隐藏）
    pub merged_at: Option<String>,
    /// 仅创建时填充：setup 脚本的执行结果（W2）；查询路径一律 None
    pub setup_result: Option<SetupResultDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMergeResultDto {
    pub merged: bool,
    pub archived: bool,
    pub failed_phase: Option<String>,
    pub message: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePrResultDto {
    pub pushed: bool,
    pub pr_created: bool,
    pub pr_url: Option<String>,
    pub failed_phase: Option<String>,
    pub message: String,
}

/// 无任何设置层定义 files_to_copy 时的回落清单（W1 固定值）
pub(crate) const FILES_TO_COPY: [&str; 4] =
    [".env", ".env.local", ".env.development.local", ".envrc"];

const PORT_LOW: i64 = 4000;
const PORT_HIGH: i64 = 4300; // 块起点上限，每块 10 个端口

// ===== 路径与 DB =====

fn workspaces_root() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("无法确定用户主目录")?
        .join("ccode")
        .join("workspaces"))
}

fn app_db_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("app.db"))
}

fn db_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 app.db 等待时间失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces(
          id TEXT PRIMARY KEY, repo_path TEXT, name TEXT, branch TEXT,
          worktree_path TEXT, base_branch TEXT, port_base INTEGER,
          status TEXT NOT NULL DEFAULT 'active', created_at TEXT, archived_at TEXT);",
    )
    .map_err(|e| format!("初始化 workspaces 表失败: {e}"))?;
    // 轻量迁移：老库补 merged_at 列（已存在则忽略错误）
    let _ = conn.execute_batch("ALTER TABLE workspaces ADD COLUMN merged_at TEXT;");
    Ok(conn)
}

pub(crate) fn db() -> Result<Connection, String> {
    db_at(&app_db_path()?)
}

fn row_to_dto(
    id: String,
    repo_path: String,
    name: String,
    branch: String,
    worktree_path: String,
    base_branch: String,
    port_base: i64,
    status: String,
    created_at: String,
    archived_at: Option<String>,
    merged_at: Option<String>,
) -> WorkspaceDto {
    let repo_name = Path::new(&repo_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_path.clone());
    WorkspaceDto {
        id,
        repo_path,
        repo_name,
        name,
        branch,
        worktree_path,
        base_branch,
        port_base,
        status,
        created_at,
        archived_at,
        merged_at,
        setup_result: None,
    }
}

fn query_workspaces(conn: &Connection) -> Result<Vec<WorkspaceDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, repo_path, name, branch, worktree_path, base_branch,
                    port_base, status, created_at, archived_at, merged_at FROM workspaces",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(row_to_dto(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub(crate) fn get_workspace(conn: &Connection, id: &str) -> Result<WorkspaceDto, String> {
    query_workspaces(conn)?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("工作区不存在: {id}"))
}

// ===== 会话归并用：worktree 前缀 → (真实仓库, 工作区名) =====

#[derive(Debug, Clone)]
pub(crate) struct WorktreeRow {
    pub id: String,
    pub worktree_path: String,
    pub repo_path: String,
    pub name: String,
    pub branch: String,
    pub base_branch: String,
}

pub(crate) fn worktree_rows() -> Vec<WorktreeRow> {
    let Ok(conn) = db() else {
        return Vec::new();
    };
    query_workspaces(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|w| WorktreeRow {
            id: w.id,
            worktree_path: w.worktree_path,
            repo_path: w.repo_path,
            name: w.name,
            branch: w.branch,
            base_branch: w.base_branch,
        })
        .collect()
}

// ===== git 调用（参数数组 + 超时；输出走管道防阻塞） =====

pub(crate) fn run_git(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_cmd(cmd, timeout)
}

/// 子进程的 stdout/stderr 各放线程读空（管道容量有限，不读会死锁），主线程轮询退出，超时则 kill
fn run_cmd(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    let mut child = cmd.spawn().map_err(|e| format!("无法启动进程: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = out_handle.join().unwrap_or_default();
                let err = err_handle.join().unwrap_or_default();
                if status.success() {
                    return Ok(String::from_utf8_lossy(&out).trim().to_string());
                }
                return Err(String::from_utf8_lossy(&err).trim().to_string());
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("操作超时".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待进程失败: {e}")),
        }
    }
}

// ===== 核心逻辑（命令的同步实现，参数化 db/根目录便于测试） =====

/// 任务名收敛为分支/目录安全字符集
fn sanitize_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        return Err("任务名清洗后为空，请换一个名字".into());
    }
    Ok(cleaned)
}

/// 取 4000-4300 间最低的空闲 10 端口块起点；活跃工作区少时自然等于 4000+10*n
/// 基准分支探测：origin/HEAD → origin/main|master → 本地 main|master → 当前分支
fn detect_base_branch(repo: &std::path::Path) -> String {
    const T: Duration = Duration::from_secs(10);
    if let Ok(s) = run_git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        T,
    ) {
        if let Some(b) = s.strip_prefix("origin/") {
            return b.to_string();
        }
    }
    for cand in ["origin/main", "origin/master", "main", "master"] {
        if run_git(repo, &["rev-parse", "--verify", "--quiet", cand], T).is_ok() {
            return cand.trim_start_matches("origin/").to_string();
        }
    }
    run_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"], T).unwrap_or_else(|_| "main".into())
}

fn alloc_port_base(conn: &Connection) -> Result<i64, String> {
    let used: Vec<i64> = query_workspaces(conn)?
        .into_iter()
        .filter(|w| w.status == "active" || w.status == "creating")
        .map(|w| w.port_base)
        .collect();
    let mut candidate = PORT_LOW;
    while candidate <= PORT_HIGH {
        if !used.contains(&candidate) {
            return Ok(candidate);
        }
        candidate += 10;
    }
    Err("活跃工作区过多，端口段（4000-4300）已用尽".into())
}

fn validate_copy_paths(files: &[String]) -> Result<(), String> {
    for file in files {
        let path = Path::new(file);
        if file.trim().is_empty()
            || path.is_absolute()
            || path.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(format!("files_to_copy 只能使用仓库内相对路径: {file}"));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn reserve_creating_workspace(
    conn: &Connection,
    id: &str,
    repo: &Path,
    name: &str,
    branch: &str,
    worktree_path: &Path,
    base_branch: &str,
    created_at: &str,
) -> Result<i64, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("锁定工作区端口分配失败: {e}"))?;
    let result = (|| {
        let port_base = alloc_port_base(conn)?;
        conn.execute(
            "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch,
                                    port_base, status, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'creating', ?8)",
            params![
                id,
                repo.to_string_lossy().as_ref(),
                name,
                branch,
                worktree_path.to_string_lossy().as_ref(),
                base_branch,
                port_base,
                created_at,
            ],
        )
        .map_err(|e| format!("记录创建中工作区失败: {e}"))?;
        Ok(port_base)
    })();
    match result {
        Ok(port_base) => {
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("提交工作区端口预留失败: {e}"))
            } else {
                Ok(port_base)
            }
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn rollback_creating_workspace(
    conn: &Connection,
    repo: &Path,
    worktree_path: &Path,
    branch: &str,
    id: &str,
) -> Vec<String> {
    let mut issues = Vec::new();
    if worktree_path.exists() {
        if let Err(e) = run_git(
            repo,
            &[
                "worktree",
                "remove",
                "--force",
                &worktree_path.to_string_lossy(),
            ],
            Duration::from_secs(60),
        ) {
            if let Err(remove_error) = fs::remove_dir_all(worktree_path) {
                issues.push(format!(
                    "移除创建中的 worktree 失败: {e}；删除目录也失败: {remove_error}"
                ));
            }
        }
    }
    if let Err(e) = run_git(repo, &["worktree", "prune"], Duration::from_secs(30)) {
        issues.push(format!("清理 worktree 元数据失败: {e}"));
    }
    if run_git(
        repo,
        &["rev-parse", "--verify", "--quiet", branch],
        Duration::from_secs(10),
    )
    .is_ok()
    {
        if let Err(e) = run_git(repo, &["branch", "-D", branch], Duration::from_secs(30)) {
            issues.push(format!("删除创建中的分支 {branch} 失败: {e}"));
        }
    }
    if let Err(e) = conn.execute("DELETE FROM workspaces WHERE id=?1", params![id]) {
        issues.push(format!("释放创建中记录和端口失败: {e}"));
    }
    issues
}

fn create_impl(
    conn: &Connection,
    ws_root: &Path,
    repo_path: &str,
    name: &str,
) -> Result<WorkspaceDto, String> {
    create_impl_with_copy(conn, ws_root, repo_path, name, |src, dest| {
        fs::copy(src, dest).map(|_| ())
    })
}

fn create_impl_with_copy<F>(
    conn: &Connection,
    ws_root: &Path,
    repo_path: &str,
    name: &str,
    mut copy_file: F,
) -> Result<WorkspaceDto, String>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    let name = sanitize_name(name)?;
    let repo = PathBuf::from(crate::sessions::expand_tilde(repo_path));
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("不是 git 仓库: {repo_path} ({e})"))?;
    let branch = format!("ccode/{name}");
    if run_git(
        &repo,
        &["rev-parse", "--verify", "--quiet", &branch],
        Duration::from_secs(10),
    )
        .is_ok()
    {
        return Err(format!("分支 {branch} 已存在，请换一个任务名"));
    }
    // 基准分支：origin/HEAD → main/master 候选 → 当前分支
    let base_branch = detect_base_branch(&repo);
    // 起点固定用本地基准分支：工作区应镜像「本地项目现状」，
    // 含未推送的提交——用 origin/<base> 会把本地未推送的工作丢掉（实测踩坑）
    let start_point = base_branch.clone();
    let repo_name = repo
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let worktree_path = ws_root.join(&repo_name).join(&name);
    if worktree_path.exists() {
        return Err(format!("worktree 路径已存在: {}", worktree_path.display()));
    }
    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建工作区目录失败: {e}"))?;
    }
    // 项目级配置（三层合并）：files_to_copy 并集；没有设置层时用 W1 固定清单
    let settings = crate::ws_settings::merged_settings(&repo);
    let files = settings
        .files_to_copy
        .clone()
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    validate_copy_paths(&files)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = crate::sessions::now_iso();
    let port_base = reserve_creating_workspace(
        conn,
        &id,
        &repo,
        &name,
        &branch,
        &worktree_path,
        &base_branch,
        &created_at,
    )?;
    let create_result: Result<WorkspaceDto, String> = (|| {
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                &worktree_path.to_string_lossy(),
                "-b",
                &branch,
                &start_point,
            ],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("创建 worktree 失败: {e}"))?;
        for file in &files {
            let src = repo.join(file);
            if !src.is_file() {
                continue;
            }
            let dest = worktree_path.join(file);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("复制 {file} 前创建目录失败: {e}"))?;
            }
            copy_file(&src, &dest).map_err(|e| format!("复制配置文件 {file} 失败: {e}"))?;
        }
        // setup 脚本失败不阻断创建，结果记进 DTO 给 UI 展示
        let setup_result = settings.setup.as_ref().map(|script| {
            let (ok, output_tail) =
                run_hook(&worktree_path, script, port_base, Duration::from_secs(600));
            SetupResultDto { ok, output_tail }
        });
        let changed = conn
            .execute(
                "UPDATE workspaces SET status='active' WHERE id=?1 AND status='creating'",
                params![id],
            )
            .map_err(|e| format!("激活工作区记录失败: {e}"))?;
        if changed != 1 {
            return Err("激活工作区记录失败：创建中记录已丢失".into());
        }
        let mut dto = get_workspace(conn, &id)?;
        dto.setup_result = setup_result;
        Ok(dto)
    })();
    let dto = match create_result {
        Ok(dto) => dto,
        Err(e) => {
            let rollback_issues =
                rollback_creating_workspace(conn, &repo, &worktree_path, &branch, &id);
            if rollback_issues.is_empty() {
                return Err(format!("{e}；已回滚创建中的工作区"));
            }
            return Err(format!(
                "{e}；自动回滚未完全成功：{}",
                rollback_issues.join("；")
            ));
        }
    };
    // 新工作区会改变 list_repos 的聚合结果（worktree 路径需被排除），主动失效
    invalidate_repo_cache();
    Ok(dto)
}

fn archive_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
    let copied_files = settings
        .files_to_copy
        .clone()
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    if wt.exists() {
        let merge_state = unmerged_impl(&wt)?;
        if merge_state.merging || !merge_state.files.is_empty() {
            return Err("工作区存在未完成的合并或冲突，请先完成或中止冲突处理后再归档".into());
        }
        let dirty = run_git(&wt, &["status", "--porcelain"], Duration::from_secs(30))?;
        let mut removable_copies = Vec::new();
        let unsafe_lines: Vec<&str> = dirty
            .lines()
            .filter(|line| {
                let path = line.get(3..).unwrap_or(line).trim();
                let is_unchanged_copy = copied_files.iter().any(|f| f == path)
                    && fs::read(Path::new(&w.repo_path).join(path)).ok()
                        == fs::read(wt.join(path)).ok();
                if is_unchanged_copy {
                    removable_copies.push(path.to_string());
                }
                !is_unchanged_copy
            })
            .collect();
        if !unsafe_lines.is_empty() {
            return Err("工作区有未提交改动，已拒绝归档；请使用“提交并归档”保留改动".into());
        }
        // archive 脚本在移除前跑（如 docker compose down）；失败则保留 worktree 并报错给 UI
        if let Some(script) = &settings.archive {
            let (ok, tail) = run_hook(&wt, script, w.port_base, Duration::from_secs(300));
            if !ok {
                return Err(format!("archive 脚本执行失败，worktree 未移除:\n{tail}"));
            }
        }
        // files-to-copy 若与主仓库原件完全一致，可安全移除后用非 --force 归档；修改过的副本已被上面拦截。
        for path in &removable_copies {
            fs::remove_file(wt.join(path))
                .map_err(|e| format!("清理可恢复副本 {path} 失败: {e}"))?;
        }
        if let Err(e) = run_git(
            Path::new(&w.repo_path),
            &["worktree", "remove", &w.worktree_path],
            Duration::from_secs(60),
        ) {
            for path in &removable_copies {
                let _ = fs::copy(Path::new(&w.repo_path).join(path), wt.join(path));
            }
            return Err(format!("移除 worktree 失败，工作区已保留: {e}"));
        }
    }
    // worktree 目录已不存在时跳过 git 调用直接翻状态
    if let Err(e) = conn.execute(
        "UPDATE workspaces SET status='archived', archived_at=?2 WHERE id=?1",
        params![id, crate::sessions::now_iso()],
    ) {
        if !wt.exists() {
            let restored = run_git(
                Path::new(&w.repo_path),
                &["worktree", "add", &w.worktree_path, &w.branch],
                Duration::from_secs(60),
            );
            return Err(match restored {
                Ok(_) => {
                    for path in &copied_files {
                        let src = Path::new(&w.repo_path).join(path);
                        let dst = wt.join(path);
                        if src.is_file() && !dst.exists() {
                            let _ = fs::copy(src, dst);
                        }
                    }
                    format!("归档状态写入失败，已恢复工作树，未丢失内容: {e}")
                }
                Err(restore_err) => format!(
                    "工作树已移除，但归档状态写入失败；分支仍保留，请手动恢复工作树: {e}; {restore_err}"
                ),
            });
        }
        return Err(format!("更新 workspaces 失败: {e}"));
    }
    Ok(())
}

fn restore_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    if !Path::new(&w.worktree_path).exists() {
        // 归档只移除 worktree 不删分支，恢复 = 从分支重新 worktree add
        run_git(
            Path::new(&w.repo_path),
            &["worktree", "add", &w.worktree_path, &w.branch],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("恢复 worktree 失败: {e}"))?;
        let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
        let files = settings
            .files_to_copy
            .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
        for path in files {
            let src = Path::new(&w.repo_path).join(&path);
            let dst = Path::new(&w.worktree_path).join(&path);
            if src.is_file() && !dst.exists() {
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("恢复复制文件目录失败: {e}"))?;
                }
                fs::copy(&src, &dst).map_err(|e| format!("恢复复制文件 {path} 失败: {e}"))?;
            }
        }
    }
    conn.execute(
        "UPDATE workspaces SET status='active', archived_at=NULL, merged_at=NULL WHERE id=?1",
        params![id],
    )
    .map_err(|e| format!("更新 workspaces 失败: {e}"))?;
    Ok(())
}

fn delete_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    if Path::new(&w.worktree_path).exists() {
        run_git(
            Path::new(&w.repo_path),
            &["worktree", "remove", "--force", &w.worktree_path],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("移除 worktree 失败: {e}"))?;
    }
    // 分支可能已被用户手动删掉，不存在不算错误
    if run_git(
        Path::new(&w.repo_path),
        &["rev-parse", "--verify", "--quiet", &w.branch],
        Duration::from_secs(10),
    )
    .is_ok()
    {
        run_git(
            Path::new(&w.repo_path),
            &["branch", "-D", &w.branch],
            Duration::from_secs(30),
        )
        .map_err(|e| format!("删除分支失败: {e}"))?;
    }
    conn.execute("DELETE FROM workspaces WHERE id=?1", params![id])
        .map_err(|e| format!("删除 workspaces 行失败: {e}"))?;
    Ok(())
}

fn port_env(port_base: i64) -> Vec<(String, String)> {
    (0..10)
        .map(|i| {
            let key = if i == 0 {
                "CCODE_PORT".to_string()
            } else {
                format!("CCODE_PORT_{i}")
            };
            (key, (port_base + i).to_string())
        })
        .collect()
}

fn workspace_env_impl(conn: &Connection, worktree_path: &str) -> Vec<(String, String)> {
    let Ok(w) = query_workspaces(conn).and_then(|rows| {
        rows.into_iter()
            .find(|w| w.worktree_path == worktree_path)
            .ok_or_else(|| "工作区不存在".to_string())
    }) else {
        return Vec::new();
    };
    port_env(w.port_base)
}

// ===== 项目级脚本钩子（§6.10 阶段 B；脚本来自仓库自己的 .ccode 配置） =====

#[cfg(windows)]
fn shell_cmd(script: &str) -> Command {
    let mut c = Command::new("cmd");
    c.args(["/C", script]);
    c
}

#[cfg(not(windows))]
fn shell_cmd(script: &str) -> Command {
    let mut c = Command::new("bash");
    c.args(["-c", script]);
    c
}

/// 输出尾部（按字符截取，保留换行），给失败提示用
fn output_tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

/// cwd = worktree，注入端口段；成功返 stdout、失败返 stderr，统一截尾部 4000 字符
fn run_hook(dir: &Path, script: &str, port_base: i64, timeout: Duration) -> (bool, String) {
    let mut cmd = shell_cmd(script);
    cmd.current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in port_env(port_base) {
        cmd.env(k, v);
    }
    match run_cmd(cmd, timeout) {
        Ok(out) => (true, output_tail(&out, 4000)),
        Err(err) => (false, output_tail(&err, 4000)),
    }
}

// ===== 评审与合并（§6.10 阶段 C；merge_workspace 是 git 写操作，仅由用户显式触发） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsHealthDto {
    pub uncommitted: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Some(false)=可干净合并，Some(true)=有冲突，None=git 版本不支持探测
    pub conflict: Option<bool>,
    /// 冲突文件清单（conflict==Some(true) 时非空，评审面板展示用）
    pub conflict_files: Vec<String>,
    /// 主仓库未停在基准分支（本地合并前置条件之一；原为 merge 时才校验，前置到健康度）
    pub main_off_base: bool,
    /// 主仓库有未提交改动（本地合并会被拒）
    pub main_dirty: bool,
    pub ready_to_merge: bool,
}

/// 基准引用固定用本地分支：与 create_impl 的起点一致（工作区从本地基准拉出，
/// 评审 diff 也应相对本地基准——用 origin 会把基准分支上未推送的提交误算进任务改动）
pub(crate) fn base_ref(_repo: &Path, base: &str) -> String {
    base.to_string()
}

/// git ≥2.38 的 merge-tree --write-tree：退出码 0=干净 1=冲突；只写对象库，不碰工作区/索引/
/// 引用。--name-only 时 stdout 首行是树 OID，其余行是冲突文件路径
fn conflict_probe(repo: &Path, base: &str, branch: &str) -> (Option<bool>, Vec<String>) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-tree", "--write-tree", "--name-only", base, branch])
        .output();
    let Ok(out) = out else {
        return (None, vec![]);
    };
    let conflict = match out.status.code() {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None, // 旧版 git 没有该参数（退出码 129 等）
    };
    let files = if conflict == Some(true) {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1) // 首行树 OID
            .map(|l| l.trim().to_string())
            .filter(|l| {
                !l.is_empty() && !l.starts_with("Auto-merging") && !l.starts_with("CONFLICT")
            })
            .collect()
    } else {
        vec![]
    };
    (conflict, files)
}

fn health_impl(conn: &Connection, id: &str) -> Result<WsHealthDto, String> {
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    let uncommitted =
        !run_git(&wt, &["status", "--porcelain"], Duration::from_secs(30))?.is_empty();
    let base = base_ref(&wt, &w.base_branch);
    // A...B 的左侧 = 只在 base（behind），右侧 = 只在 HEAD（ahead）
    let counts = run_git(
        &wt,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...HEAD"),
        ],
        Duration::from_secs(30),
    )?;
    let mut parts = counts.split_whitespace();
    let behind = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let (conflict, conflict_files) = conflict_probe(&wt, &base, "HEAD");
    // 主仓库状态也是本地合并的前置条件：提前暴露，别等点了「合并」才报错
    let repo = PathBuf::from(&w.repo_path);
    let main_off_base = run_git(
        &repo,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(10),
    )
        .map(|cur| cur != w.base_branch)
        .unwrap_or(false);
    let main_dirty = run_git(&repo, &["status", "--porcelain"], Duration::from_secs(30))
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    Ok(WsHealthDto {
        uncommitted,
        ahead,
        behind,
        conflict,
        conflict_files,
        main_off_base,
        main_dirty,
        ready_to_merge: ahead > 0
            && !uncommitted
            && conflict == Some(false)
            && !main_off_base
            && !main_dirty,
    })
}

fn merge_impl(
    conn: &Connection,
    id: &str,
    archive: bool,
) -> Result<WorkspaceMergeResultDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(&w.repo_path);
    // 前置条件：主仓库必须停在基准分支且工作区干净，否则合并会搅乱用户手头的工作
    let cur = run_git(
        &repo,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(10),
    )?;
    if cur != w.base_branch {
        return Err(format!(
            "主仓库当前分支是 {cur}，不在基准分支 {} 上；请先在主仓库切换分支，或改用 PR 流程",
            w.base_branch
        ));
    }
    let dirty = run_git(&repo, &["status", "--porcelain"], Duration::from_secs(30))?;
    if !dirty.is_empty() {
        // porcelain 前两列是状态码，第三列起是路径；列出前 5 个帮用户定位
        let lines: Vec<&str> = dirty.lines().collect();
        let names = lines
            .iter()
            .take(5)
            .map(|l| l.get(3..).unwrap_or(l))
            .collect::<Vec<_>>()
            .join("、");
        let suffix = if lines.len() > 5 {
            format!(" 等 {} 个文件", lines.len())
        } else {
            String::new()
        };
        return Err(format!(
            "主仓库有未提交改动（{names}{suffix}），请先提交或 stash 再合并（或改用 PR 流程）"
        ));
    }
    let mut log = match run_git(
        &repo,
        &["merge", "--no-ff", &w.branch],
        Duration::from_secs(60),
    ) {
        Ok(out) => out,
        Err(e) => {
            let files = run_git(
                &repo,
                &["diff", "--name-only", "--diff-filter=U"],
                Duration::from_secs(10),
            )
            .unwrap_or_default();
            let merge_in_progress = run_git(
                &repo,
                &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
                Duration::from_secs(10),
            )
            .is_ok();
            let abort_note = if merge_in_progress {
                match run_git(&repo, &["merge", "--abort"], Duration::from_secs(30)) {
                    Ok(_) => "已自动回退，主仓库保持干净",
                    Err(_) => "自动回退失败，请立即在主仓库执行 git merge --abort",
                }
            } else {
                "未进入合并状态，主仓库未留下 merge 过程"
            };
            return Err(format!(
                "最终合并失败；{abort_note}。请回到隔离工作区重新处理冲突:\n{e}\n冲突文件:\n{files}"
            ));
        }
    };
    let merged_at = crate::sessions::now_iso();
    if let Err(e) = conn.execute(
        "UPDATE workspaces SET merged_at=?1 WHERE id=?2",
        params![merged_at, id],
    ) {
        return Ok(WorkspaceMergeResultDto {
            merged: true,
            archived: false,
            failed_phase: Some("state".into()),
            message: format!(
                "代码已合并进 {}，但 Ccode 状态记录失败；不要重复合并：{e}",
                w.base_branch
            ),
            output: log,
        });
    }
    if archive {
        // 合并成功后走标准归档生命周期（archive 钩子 + worktree 移除 + 状态翻转）
        if let Err(e) = archive_impl(conn, id) {
            return Ok(WorkspaceMergeResultDto {
                merged: true,
                archived: false,
                failed_phase: Some("archive".into()),
                message: format!("代码已合并进 {}，但归档失败：{e}", w.base_branch),
                output: log,
            });
        }
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str("已合并并归档工作区");
        Ok(WorkspaceMergeResultDto {
            merged: true,
            archived: true,
            failed_phase: None,
            message: format!("已合并进 {} 并归档工作区", w.base_branch),
            output: log,
        })
    } else {
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str("已合并（工作区保留，可继续干活或之后归档）");
        Ok(WorkspaceMergeResultDto {
            merged: true,
            archived: false,
            failed_phase: None,
            message: format!("已合并进 {}，工作区已保留", w.base_branch),
            output: log,
        })
    }
}

fn pr_impl(
    conn: &Connection,
    id: &str,
    title: &str,
    body: Option<String>,
    skip_push: bool,
) -> Result<WorkspacePrResultDto, String> {
    // 复用机器上的 gh CLI 认证，不做应用内 GitHub 登录
    let gh = crate::agents::resolve_binary("gh").ok_or("需要安装 gh CLI")?;
    let gh_ok = Command::new(&gh)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !gh_ok {
        return Err("需要安装 gh CLI".into());
    }
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    if !skip_push {
        if let Err(e) = run_git(
            &wt,
            &["push", "-u", "origin", &w.branch],
            Duration::from_secs(120),
        ) {
            return Ok(WorkspacePrResultDto {
                pushed: false,
                pr_created: false,
                pr_url: None,
                failed_phase: Some("push".into()),
                message: format!("分支推送失败，PR 尚未创建：{e}"),
            });
        }
    }
    let body = match body.filter(|b| !b.trim().is_empty()) {
        Some(b) => b,
        // 自动 body = 任务分支上的提交清单（cap 50 行）
        None => {
            let base = base_ref(&wt, &w.base_branch);
            let log = run_git(
                &wt,
                &["log", "--oneline", &format!("{base}..{}", w.branch)],
                Duration::from_secs(30),
            )
            .unwrap_or_default();
            let lines: Vec<&str> = log.lines().take(50).collect();
            if lines.is_empty() {
                "由 Ccode 创建".to_string()
            } else {
                lines.join("\n")
            }
        }
    };
    let mut cmd = Command::new(&gh);
    cmd.current_dir(&wt)
        .args([
            "pr",
            "create",
            "--base",
            &w.base_branch,
            "--head",
            &w.branch,
            "--title",
            title,
            "--body",
            &body,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = match run_cmd(cmd, Duration::from_secs(120)) {
        Ok(out) => out,
        Err(e) => {
            return Ok(WorkspacePrResultDto {
                pushed: true,
                pr_created: false,
                pr_url: None,
                failed_phase: Some("pr".into()),
                message: format!("分支已推送，但 PR 创建失败；可直接重试创建 PR：{e}"),
            });
        }
    };
    // gh 成功输出的末行是 PR URL
    let url = out
        .lines()
        .rev()
        .find(|l| l.contains("http"))
        .unwrap_or(out.trim())
        .trim()
        .to_string();
    Ok(WorkspacePrResultDto {
        pushed: true,
        pr_created: true,
        pr_url: Some(url.clone()),
        failed_phase: None,
        message: "PR 已创建".into(),
    })
}

// ===== Tauri commands（全部 async + spawn_blocking，git/DB 不阻塞主线程） =====

#[tauri::command]
pub async fn create_workspace(repo_path: String, name: String) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        create_impl(&conn, &workspaces_root()?, &repo_path, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let mut rows = query_workspaces(&conn)?;
        // active 在前、archived 在后，组内按创建时间倒序
        rows.sort_by(|a, b| {
            (b.status != "active")
                .cmp(&(a.status != "active"))
                .then(b.created_at.cmp(&a.created_at))
        });
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 归档/删除/合并成功后广播（前端把还留在被移除工作树里的终端标签切回主仓库）
fn emit_ws_archived(app: &tauri::AppHandle, worktree_path: &str, repo_path: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "ws-archived",
        serde_json::json!({ "worktreePath": worktree_path, "repoPath": repo_path }),
    );
}

#[tauri::command]
pub async fn archive_workspace(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::pty::PtyManager>,
    id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let paths =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
            let active = manager.active_workspace_tasks(&w.worktree_path);
            if !active.is_empty() {
                return Err(format!(
                    "工作区仍有 {} 个 agent/run 脚本在运行，请先停止或关闭对应终端标签",
                    active.len()
                ));
            }
        archive_impl(&conn, &id)?;
        Ok((w.worktree_path, w.repo_path))
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_ws_archived(&app, &paths.0, &paths.1);
    Ok(())
}

#[tauri::command]
pub async fn restore_workspace(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let paths =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        delete_impl(&conn, &id)?;
        Ok((w.worktree_path, w.repo_path))
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_ws_archived(&app, &paths.0, &paths.1);
    Ok(())
}

#[tauri::command]
pub async fn workspace_env_for(worktree_path: String) -> Vec<(String, String)> {
    tauri::async_runtime::spawn_blocking(move || {
        db().map(|conn| workspace_env_impl(&conn, &worktree_path))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn workspace_health(id: String) -> Result<WsHealthDto, String> {
    tauri::async_runtime::spawn_blocking(move || health_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// 合并回基准分支（本地 merge，git 写操作）：前置条件不满足直接报错，不动任何东西。
/// archive=false 只合并（工作区保留，终端可继续用）；archive=true 合并并归档
#[tauri::command]
pub async fn merge_workspace(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::pty::PtyManager>,
    id: String,
    archive: bool,
) -> Result<WorkspaceMergeResultDto, String> {
    let manager = manager.inner().clone();
    let (out, paths) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let conn = db()?;
            let w = get_workspace(&conn, &id)?;
        if archive {
            let active = manager.active_workspace_tasks(&w.worktree_path);
            if !active.is_empty() {
                return Err(format!(
                    "工作区仍有 {} 个 agent/run 脚本在运行，请先停止或关闭对应终端标签",
                    active.len()
                ));
            }
        }
            let out = merge_impl(&conn, &id, archive)?;
            Ok((out, (w.worktree_path, w.repo_path)))
        })
        .await
        .map_err(|e| e.to_string())??;
    // 只有归档了才广播（前端把留在被移除工作树里的终端标签切回主仓库）
    if out.archived {
        emit_ws_archived(&app, &paths.0, &paths.1);
    }
    Ok(out)
}

// ===== 路径归属（预览编辑器标识「主仓库/工作区分支」用） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchTargetDto {
    pub workspace_name: String,
    pub branch: String,
    pub worktree_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathContextDto {
    /// "worktree"（活跃工作区的工作树内）| "main"（活跃工作区的主仓库内）| "other"
    pub kind: String,
    pub workspace_name: Option<String>,
    pub branch: Option<String>,
    /// 命中工作区的工作树绝对路径（切换「分支」用）
    pub worktree_path: Option<String>,
    /// 命中工作区的主仓库绝对路径（切换「主项目」用）
    pub repo_path: Option<String>,
    /// 同仓库的其他活跃工作区（主项目⇄多分支的切换列表）
    pub siblings: Vec<SwitchTargetDto>,
}

/// 判断路径落在哪个上下文，供预览编辑器提示「你在改主仓库还是分支」。
/// 双方都 canonicalize 再比前缀（防 symlink 误判）；工作树优先于主仓库命中
///（工作树在 ~/ccode/workspaces/ 下不在主仓库内，理论上不会重叠，取确定语义）
fn path_context_impl(conn: &Connection, path: &str) -> Result<PathContextDto, String> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let actives: Vec<WorkspaceDto> = query_workspaces(conn)?
        .into_iter()
        .filter(|w| w.status == "active")
        .collect();
    let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    let to_target = |o: &WorkspaceDto| SwitchTargetDto {
        workspace_name: o.name.clone(),
        branch: o.branch.clone(),
        worktree_path: o.worktree_path.clone(),
    };
    // 工作树命中（优先）：同仓库其他活跃工作区作为切换目标
    for w in &actives {
        if target.starts_with(canon(&w.worktree_path)) {
            return Ok(PathContextDto {
                kind: "worktree".into(),
                workspace_name: Some(w.name.clone()),
                branch: Some(w.branch.clone()),
                worktree_path: Some(w.worktree_path.clone()),
                repo_path: Some(w.repo_path.clone()),
                siblings: actives
                    .iter()
                    .filter(|o| o.id != w.id && o.repo_path == w.repo_path)
                    .map(to_target)
                    .collect(),
            });
        }
    }
    // 主仓库命中：该仓库全部活跃工作区都是切换目标
    if let Some(w) = actives
        .iter()
        .find(|w| target.starts_with(canon(&w.repo_path)))
    {
        return Ok(PathContextDto {
            kind: "main".into(),
            workspace_name: Some(w.name.clone()),
            branch: Some(w.base_branch.clone()),
            worktree_path: Some(w.worktree_path.clone()),
            repo_path: Some(w.repo_path.clone()),
            siblings: actives
                .iter()
                .filter(|o| o.repo_path == w.repo_path)
                .map(to_target)
                .collect(),
        });
    }
    Ok(PathContextDto {
        kind: "other".into(),
        workspace_name: None,
        branch: None,
        worktree_path: None,
        repo_path: None,
        siblings: vec![],
    })
}

#[tauri::command]
pub fn path_context(path: String) -> Result<PathContextDto, String> {
    path_context_impl(&db()?, &path)
}

// ===== 工作区状态漂移与修复 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDriftIssueDto {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDriftDto {
    pub healthy: bool,
    pub issues: Vec<WorkspaceDriftIssueDto>,
    pub can_remount: bool,
    pub can_relocate: bool,
    pub can_mark_archived: bool,
    pub can_clean_record: bool,
    pub can_resolve_merge: bool,
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn registered_worktrees(repo: &Path) -> Result<Vec<(PathBuf, Option<String>)>, String> {
    let text = run_git(
        repo,
        &["worktree", "list", "--porcelain"],
        Duration::from_secs(30),
    )?;
    let mut rows = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut branch: Option<String> = None;
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(path) = path.take() {
                rows.push((path, branch.take()));
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(value));
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            branch = Some(value.to_string());
        }
    }
    Ok(rows)
}

fn drift_issue(code: &str, message: impl Into<String>) -> WorkspaceDriftIssueDto {
    WorkspaceDriftIssueDto {
        code: code.into(),
        message: message.into(),
    }
}

fn workspace_drift_impl(conn: &Connection, id: &str) -> Result<WorkspaceDriftDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(&w.repo_path);
    let wt = PathBuf::from(&w.worktree_path);
    let repo_valid = repo.is_dir()
        && run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10)).is_ok();
    let branch_exists = repo_valid
        && run_git(
            &repo,
            &["rev-parse", "--verify", "--quiet", &w.branch],
            Duration::from_secs(10),
        )
        .is_ok();
    let registrations = if repo_valid {
        registered_worktrees(&repo).unwrap_or_default()
    } else {
        Vec::new()
    };
    let registered = registrations
        .iter()
        .find(|(path, _)| same_path(path, &wt));
    let mut issues = Vec::new();
    if w.status == "creating" {
        issues.push(drift_issue(
            "creating_incomplete",
            "上次创建没有完成，需要重新挂载或清理记录",
        ));
    }
    if !repo_valid {
        issues.push(drift_issue(
            "repo_missing",
            "仓库目录不存在、已移动或不再是 Git 仓库",
        ));
    } else if !branch_exists {
        issues.push(drift_issue(
            "branch_missing",
            format!("任务分支 {} 不存在", w.branch),
        ));
    }
    if w.status == "active" || w.status == "creating" {
        if !wt.is_dir() {
            issues.push(drift_issue("worktree_missing", "工作树目录不存在"));
        } else if repo_valid {
            match registered {
                None => issues.push(drift_issue(
                    "worktree_unregistered",
                    "工作树目录存在，但不在该仓库的 Git worktree 清单中",
                )),
                Some((_, actual_branch)) if actual_branch.as_deref() != Some(&w.branch) => {
                    issues.push(drift_issue(
                        "worktree_branch_mismatch",
                        format!(
                            "工作树登记分支为 {}，数据库记录为 {}",
                            actual_branch.as_deref().unwrap_or("detached HEAD"),
                            w.branch
                        ),
                    ));
                }
                _ => {}
            }
        }
    } else if w.status == "archived" && (wt.exists() || registered.is_some()) {
        issues.push(drift_issue(
            "archived_worktree_present",
            "数据库标记为已归档，但工作树仍存在或仍被 Git 登记",
        ));
    }
    let merging = wt.is_dir()
        && run_git(
            &wt,
            &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
            Duration::from_secs(10),
        )
        .is_ok();
    if merging {
        issues.push(drift_issue(
            "merge_in_progress",
            "工作树存在未完成的合并，需要继续解决冲突或中止合并",
        ));
    }
    let can_remount = repo_valid
        && branch_exists
        && (w.status == "creating"
            || w.status == "archived"
            || !wt.is_dir()
            || registered.is_none());
    let can_mark_archived = matches!(w.status.as_str(), "active" | "creating") && !wt.exists();
    Ok(WorkspaceDriftDto {
        healthy: issues.is_empty(),
        can_remount,
        can_relocate: !repo_valid,
        can_mark_archived,
        can_clean_record: true,
        can_resolve_merge: merging,
        issues,
    })
}

fn copy_workspace_restore_files(w: &WorkspaceDto) -> Result<(), String> {
    let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
    let files = settings
        .files_to_copy
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    validate_copy_paths(&files)?;
    for path in files {
        let src = Path::new(&w.repo_path).join(&path);
        let dst = Path::new(&w.worktree_path).join(&path);
        if src.is_file() && !dst.exists() {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("重新挂载时创建文件目录失败: {e}"))?;
            }
            fs::copy(&src, &dst).map_err(|e| format!("重新挂载时复制 {path} 失败: {e}"))?;
        }
    }
    Ok(())
}

fn repair_remount_impl(conn: &Connection, id: &str) -> Result<WorkspaceDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(&w.repo_path);
    let wt = PathBuf::from(&w.worktree_path);
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("仓库不可用，请先重新定位: {e}"))?;
    run_git(
        &repo,
        &["rev-parse", "--verify", "--quiet", &w.branch],
        Duration::from_secs(10),
    )
    .map_err(|_| format!("任务分支 {} 不存在，无法重新挂载", w.branch))?;
    let mut added = false;
    if wt.exists() {
        let registered = registered_worktrees(&repo)?
            .into_iter()
            .any(|(path, branch)| same_path(&path, &wt) && branch.as_deref() == Some(&w.branch));
        if !registered {
            run_git(
                &repo,
                &["worktree", "repair", &w.worktree_path],
                Duration::from_secs(60),
            )
            .map_err(|e| format!("修复现有工作树登记失败，目录未改动: {e}"))?;
        }
    } else {
        if let Some(parent) = wt.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建工作树父目录失败: {e}"))?;
        }
        run_git(
            &repo,
            &["worktree", "add", &w.worktree_path, &w.branch],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("重新挂载 worktree 失败: {e}"))?;
        added = true;
    }
    if let Err(e) = copy_workspace_restore_files(&w) {
        if added {
            let _ = run_git(
                &repo,
                &["worktree", "remove", "--force", &w.worktree_path],
                Duration::from_secs(60),
            );
        }
        return Err(e);
    }
    let actual_branch = run_git(
        &wt,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Duration::from_secs(10),
    )?;
    if actual_branch != w.branch {
        return Err(format!(
            "重新挂载后分支不一致：实际 {actual_branch}，预期 {}",
            w.branch
        ));
    }
    conn.execute(
        "UPDATE workspaces SET status='active', archived_at=NULL WHERE id=?1",
        params![id],
    )
    .map_err(|e| format!("工作树已修复，但更新 Ccode 记录失败；可重试重新挂载: {e}"))?;
    invalidate_repo_cache();
    get_workspace(conn, id)
}

fn relocate_repo_impl(
    conn: &Connection,
    id: &str,
    new_repo_path: &str,
) -> Result<WorkspaceDto, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(crate::sessions::expand_tilde(new_repo_path));
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("所选目录不是可用的 Git 仓库: {e}"))?;
    run_git(
        &repo,
        &["rev-parse", "--verify", "--quiet", &w.branch],
        Duration::from_secs(10),
    )
    .map_err(|_| format!("所选仓库不包含任务分支 {}，已拒绝重新定位", w.branch))?;
    let wt = PathBuf::from(&w.worktree_path);
    if wt.exists() {
        let registered = registered_worktrees(&repo)?
            .into_iter()
            .any(|(path, branch)| same_path(&path, &wt) && branch.as_deref() == Some(&w.branch));
        if !registered {
            run_git(
                &repo,
                &["worktree", "repair", &w.worktree_path],
                Duration::from_secs(60),
            )
            .map_err(|e| format!("仓库可用，但修复工作树链接失败，记录未更新: {e}"))?;
        }
    }
    conn.execute(
        "UPDATE workspaces SET repo_path=?1 WHERE id=?2",
        params![repo.to_string_lossy().as_ref(), id],
    )
    .map_err(|e| format!("Git 链接已检查，但更新仓库位置失败，可重试重新定位: {e}"))?;
    invalidate_repo_cache();
    get_workspace(conn, id)
}

fn mark_archived_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    if Path::new(&w.worktree_path).exists() {
        return Err("工作树目录仍存在，不能只标记归档；请重新挂载后走正常归档或明确删除".into());
    }
    if Path::new(&w.repo_path).is_dir() {
        let _ = run_git(
            Path::new(&w.repo_path),
            &["worktree", "prune"],
            Duration::from_secs(30),
        );
    }
    conn.execute(
        "UPDATE workspaces SET status='archived', archived_at=?2 WHERE id=?1",
        params![id, crate::sessions::now_iso()],
    )
    .map_err(|e| format!("标记归档失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn workspace_drift(id: String) -> Result<WorkspaceDriftDto, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_drift_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_repair_remount(id: String) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || repair_remount_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_relocate_repo(
    id: String,
    new_repo_path: String,
) -> Result<WorkspaceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        relocate_repo_impl(&db()?, &id, &new_repo_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_mark_archived(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mark_archived_impl(&db()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_clean_record(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        get_workspace(&conn, &id)?;
        conn.execute("DELETE FROM workspaces WHERE id=?1", params![id])
            .map_err(|e| format!("清理工作区记录失败: {e}"))?;
        invalidate_repo_cache();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把基准分支并入任务分支（`git merge <base>` 在工作树里执行）：冲突留在工作区就地解决，
/// 不碰主仓库——前端在解决后串联提交与最终合并
fn sync_base_impl(wt: &Path, base_branch: &str, restart: bool) -> Result<String, String> {
    let state = unmerged_with_base(wt, base_branch)?;
    if state.merging {
        if !restart {
            return Err(if state.stale_base {
                format!("当前冲突基于旧的 {base_branch}，请重新同步最新基准")
            } else {
                "当前已有进行中的冲突解决，请继续处理或明确重新同步".into()
            });
        }
        run_git(wt, &["merge", "--abort"], Duration::from_secs(30))
            .map_err(|e| format!("放弃旧冲突现场失败，请先手动执行 git merge --abort：{e}"))?;
    }
    // 工作树有未提交改动时 git 会拒绝合并，先说清楚。restart 已先 abort，避免把冲突状态误判为普通脏文件。
    if !run_git(wt, &["status", "--porcelain"], Duration::from_secs(30))?.is_empty() {
        return Err("工作区有未提交改动，请先在「改动」面板提交，再并入主分支".into());
    }
    match run_git(wt, &["merge", base_branch], Duration::from_secs(60)) {
        Ok(out) => Ok(format!(
            "已把 {} 并入当前任务分支：\n{}",
            base_branch,
            if out.trim().is_empty() { "已是最新" } else { out.trim() }
        )),
        Err(e) => {
            let files = run_git(
                wt,
                &["diff", "--name-only", "--diff-filter=U"],
                Duration::from_secs(10),
            )
            .unwrap_or_default();
            Err(format!(
                "并入产生冲突——冲突留在工作区，不影响主仓库：\n{e}\n冲突文件:\n{files}\n逐文件选择版本后可直接「完成解决并合并」"
            ))
        }
    }
}

#[tauri::command]
pub async fn workspace_sync_base(id: String, restart: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        sync_base_impl(&wt, &w.base_branch, restart.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 工作区内冲突解决（评审面板闭环：选边 → 提交，不用去终端） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmergedDto {
    /// 工作树处于 MERGING 状态（有未完成的并入）
    pub merging: bool,
    /// 仍未解决的冲突文件（UU）
    pub files: Vec<String>,
    /// MERGE_HEAD 与当前基准分支 tip 不一致：冲突现场已落后，不能继续按旧的 theirs 选边。
    pub stale_base: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictContentDto {
    /// stage 2：当前任务分支（ours）；删除侧为 None
    pub ours: Option<String>,
    /// stage 3：并入的基准分支（theirs）；删除侧为 None
    pub theirs: Option<String>,
    /// ours → theirs 的全文件 unified diff，供双栏审阅复用
    pub diff: String,
    pub truncated: bool,
}

const CONFLICT_PREVIEW_CAP: usize = 512 * 1024;

fn cap_conflict_text(mut text: String) -> (String, bool) {
    if text.len() <= CONFLICT_PREVIEW_CAP {
        return (text, false);
    }
    let mut end = CONFLICT_PREVIEW_CAP;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n…（冲突预览已截断）\n");
    (text, true)
}

/// 冲突审阅必须保留文件首尾空白，不能复用会 trim 输出的 run_git。
fn run_git_raw(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("无法启动 git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn unmerged_impl(wt: &Path) -> Result<UnmergedDto, String> {
    let merging = run_git(
        wt,
        &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
        Duration::from_secs(10),
    )
        .is_ok();
    let out = run_git(
        wt,
        &["diff", "--name-only", "--diff-filter=U"],
        Duration::from_secs(10),
    )?;
    Ok(UnmergedDto {
        merging,
        files: out
            .lines()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        stale_base: false,
    })
}

fn unmerged_with_base(wt: &Path, base_branch: &str) -> Result<UnmergedDto, String> {
    let mut state = unmerged_impl(wt)?;
    if !state.merging {
        return Ok(state);
    }
    let merge_head = run_git(
        wt,
        &["rev-parse", "--verify", "MERGE_HEAD"],
        Duration::from_secs(10),
    )?;
    let base_head = run_git(wt, &["rev-parse", base_branch], Duration::from_secs(10))?;
    state.stale_base = merge_head.trim() != base_head.trim();
    Ok(state)
}

fn conflict_content_impl(wt: &Path, path: &str) -> Result<ConflictContentDto, String> {
    let state = unmerged_impl(wt)?;
    if !state.files.iter().any(|file| file == path) {
        return Err(format!("文件不在当前冲突清单中: {path}"));
    }
    let ours_spec = format!(":2:{path}");
    let theirs_spec = format!(":3:{path}");
    let ours = run_git_raw(wt, &["show", &ours_spec]).ok();
    let theirs = run_git_raw(wt, &["show", &theirs_spec]).ok();
    if ours.is_none() && theirs.is_none() {
        return Err(format!("无法读取冲突两侧内容: {path}"));
    }
    let raw_diff = run_git_raw(
        wt,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=999999",
            &ours_spec,
            &theirs_spec,
        ],
    )
    .unwrap_or_else(|_| match (&ours, &theirs) {
        (Some(left), None) => left.lines().fold(String::new(), |mut out, line| {
            out.push_str(&format!("-{line}\n"));
            out
        }),
        (None, Some(right)) => right.lines().fold(String::new(), |mut out, line| {
            out.push_str(&format!("+{line}\n"));
            out
        }),
        _ => String::new(),
    });
    let (ours, ours_cut) = match ours {
        Some(text) => {
            let (text, cut) = cap_conflict_text(text);
            (Some(text), cut)
        }
        None => (None, false),
    };
    let (theirs, theirs_cut) = match theirs {
        Some(text) => {
            let (text, cut) = cap_conflict_text(text);
            (Some(text), cut)
        }
        None => (None, false),
    };
    let (diff, diff_cut) = cap_conflict_text(raw_diff);
    Ok(ConflictContentDto {
        ours,
        theirs,
        diff,
        truncated: ours_cut || theirs_cut || diff_cut,
    })
}

#[tauri::command]
pub async fn workspace_unmerged_files(id: String) -> Result<UnmergedDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        unmerged_with_base(&PathBuf::from(&w.worktree_path), &w.base_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_conflict_content(
    id: String,
    path: String,
) -> Result<ConflictContentDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        if unmerged_with_base(&wt, &w.base_branch)?.stale_base {
            return Err(format!("{} 已更新，请先重新同步最新基准", w.base_branch));
        }
        conflict_content_impl(&wt, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 单边解决实现（worktree 直给，便于测试）
fn resolve_file_impl(wt: &Path, path: &str, side: &str) -> Result<UnmergedDto, String> {
    let state = unmerged_impl(wt)?;
    if !state.files.iter().any(|file| file == path) {
        return Err(format!("文件不在当前冲突清单中: {path}"));
    }
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(format!("未知选边: {side}")),
    };
    if run_git(wt, &["checkout", flag, "--", path], Duration::from_secs(30)).is_ok() {
        run_git(wt, &["add", "--", path], Duration::from_secs(30))?;
    } else {
        // 删/改冲突中选定侧是「已删除」：checkout 失败，git rm 即选定该侧
        run_git(
            wt,
            &["rm", "-q", "--ignore-unmatch", "--", path],
            Duration::from_secs(30),
        )?;
    }
    unmerged_impl(wt)
}

/// 单边解决一个冲突文件：side = "ours"（分支版）| "theirs"（基准/main 版）。
/// 返回剩余未解决清单
#[tauri::command]
pub async fn workspace_resolve_file(
    id: String,
    path: String,
    side: String,
) -> Result<UnmergedDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        if unmerged_with_base(&wt, &w.base_branch)?.stale_base {
            return Err(format!("{} 已更新，请先重新同步最新基准", w.base_branch));
        }
        resolve_file_impl(&wt, &path, &side)?;
        unmerged_with_base(&wt, &w.base_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 完成并入提交的实现（worktree 直给，便于测试）
fn finish_merge_impl(wt: &Path) -> Result<String, String> {
    let st = unmerged_impl(wt)?;
    if !st.merging {
        return Err("当前没有进行中的并入".into());
    }
    if !st.files.is_empty() {
        return Err(format!("还有未解决的冲突文件：{}", st.files.join("、")));
    }
    run_git(wt, &["commit", "--no-edit"], Duration::from_secs(60))?;
    Ok("冲突解决完成，已提交并入".to_string())
}

/// 全部冲突解决完后完成并入提交（--no-edit 用 git 生成的 merge 信息）
#[tauri::command]
pub async fn workspace_finish_merge(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        if unmerged_with_base(&wt, &w.base_branch)?.stale_base {
            return Err(format!("{} 已更新，请先重新同步最新基准", w.base_branch));
        }
        finish_merge_impl(&wt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 推送分支并用 gh CLI 创建 PR（复用机器上的 gh 认证）
#[tauri::command]
pub async fn create_pr(
    id: String,
    title: String,
    body: Option<String>,
    skip_push: Option<bool>,
) -> Result<WorkspacePrResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pr_impl(&db()?, &id, &title, body, skip_push.unwrap_or(false))
    })
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDto {
    pub path: String,
    pub name: String,
}

// ===== list_repos 进程内缓存：全量扫描要逐目录跑 git，TTL 内直接复用 =====

const REPO_CACHE_TTL: Duration = Duration::from_secs(60);
static REPO_CACHE: OnceLock<Mutex<Option<(Instant, Vec<RepoDto>)>>> = OnceLock::new();

fn repo_cache() -> &'static Mutex<Option<(Instant, Vec<RepoDto>)>> {
    REPO_CACHE.get_or_init(|| Mutex::new(None))
}

/// 缓存命中判断（纯函数，注入 now 便于测试）；时钟回拨按过期处理
fn repo_cache_hit(
    cached: &Option<(Instant, Vec<RepoDto>)>,
    now: Instant,
    ttl: Duration,
) -> Option<Vec<RepoDto>> {
    cached.as_ref().and_then(|(ts, repos)| {
        now.checked_duration_since(*ts)
            .filter(|elapsed| *elapsed < ttl)
            .map(|_| repos.clone())
    })
}

/// 主动失效：新建工作区会改变聚合结果（新增 worktree 路径），成功后必须清掉
fn invalidate_repo_cache() {
    if let Ok(mut guard) = repo_cache().lock() {
        *guard = None;
    }
}

/// 新建工作区的仓库候选：来自会话聚合目录，只保留真实存在的 git 仓库，
/// 排除 home 目录与 worktree 路径（非 git 仓库创建必失败，混杂会误导用户）
#[tauri::command]
pub async fn list_repos() -> Vec<RepoDto> {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(guard) = repo_cache().lock() {
            if let Some(hit) = repo_cache_hit(&guard, Instant::now(), REPO_CACHE_TTL) {
                return hit;
            }
        }
        let home = dirs::home_dir();
        let ws_root = workspaces_root().unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        let repos: Vec<RepoDto> = crate::sessions::cached_scan()
            .sessions
            .into_iter()
            .filter_map(|s| std::fs::canonicalize(&s.project_path).ok())
            .filter(|p| {
                p.is_dir()
                    && Some(p.clone()) != home
                    && !p.starts_with(&ws_root)
                    && seen.insert(p.clone())
            })
            .filter(|p| run_git(p, &["rev-parse", "--git-dir"], Duration::from_secs(5)).is_ok())
            .map(|p| RepoDto {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "repo".into()),
                path: p.to_string_lossy().into_owned(),
            })
            .collect();
        // 时间戳取扫描完成后，TTL 从最新数据起算
        if let Ok(mut guard) = repo_cache().lock() {
            *guard = Some((Instant::now(), repos.clone()));
        }
        repos
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn sh(dir: &Path, args: &[&str]) {
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

    /// 带 origin（裸仓库）+ origin/HEAD 的测试仓库，repo 根下放两个 files-to-copy 文件
    fn setup_repo(dir: &Path) -> PathBuf {
        let origin = dir.join("origin.git");
        let repo = dir.join("myrepo");
        Command::new("git")
            .args(["init", "--bare"])
            .arg(&origin)
            .output()
            .unwrap();
        Command::new("git")
            .args(["-c", "init.defaultBranch=main", "init"])
            .arg(&repo)
            .output()
            .unwrap();
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("README.md"), "hi").unwrap();
        fs::write(repo.join(".env"), "SECRET=1").unwrap();
        fs::write(repo.join(".envrc"), "export X=1").unwrap();
        sh(&repo, &["add", "README.md"]);
        sh(&repo, &["commit", "-m", "init"]);
        sh(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        sh(&repo, &["push", "-u", "origin", "main"]);
        sh(&repo, &["remote", "set-head", "origin", "main"]);
        repo
    }

    struct Fixture {
        dir: PathBuf,
        conn: Connection,
        ws_root: PathBuf,
        repo: PathBuf,
    }

    impl Fixture {
        fn new() -> Option<Self> {
            if !git_available() {
                return None;
            }
            let dir = std::env::temp_dir().join(format!("ccode-ws-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let conn = db_at(&dir.join("app.db")).unwrap();
            let ws_root = dir.join("workspaces");
            let repo = setup_repo(&dir);
            Some(Self {
                dir,
                conn,
                ws_root,
                repo,
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // 先摘掉 worktree 再删目录，避免 git 元数据残留
            let _ = run_git(&self.repo, &["worktree", "prune"], Duration::from_secs(10));
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn sanitize_name_rules() {
        assert_eq!(sanitize_name("fix bug!").unwrap(), "fix-bug");
        assert_eq!(sanitize_name("feat-x").unwrap(), "feat-x");
        assert!(
            sanitize_name("我的").is_err(),
            "全非允许字符清洗后为空要拒绝"
        );
    }

    #[test]
    fn repo_cache_hit_within_ttl_and_expired() {
        let t0 = Instant::now();
        let ttl = Duration::from_secs(60);
        let cached = Some((
            t0,
            vec![RepoDto {
                path: "/r".into(),
                name: "r".into(),
            }],
        ));
        // TTL 内命中，返回缓存副本
        let hit = repo_cache_hit(&cached, t0 + Duration::from_secs(59), ttl).unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].path, "/r");
        // 到期（含恰好在边界）视为过期 → None，走重扫
        assert!(repo_cache_hit(&cached, t0 + ttl, ttl).is_none());
        assert!(repo_cache_hit(&cached, t0 + Duration::from_secs(120), ttl).is_none());
        // 空缓存 → None
        assert!(repo_cache_hit(&None, t0, ttl).is_none());
        // 时钟回拨按过期处理，不命中也不 panic
        if let Some(earlier) = t0.checked_sub(Duration::from_secs(1)) {
            assert!(repo_cache_hit(&cached, earlier, ttl).is_none());
        }
    }

    #[test]
    fn create_workspace_invalidates_repo_cache() {
        let Some(fx) = Fixture::new() else { return };
        *repo_cache().lock().unwrap() = Some((
            Instant::now(),
            vec![RepoDto {
                path: "/r".into(),
                name: "r".into(),
            }],
        ));
        create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "cache-inv",
        )
        .unwrap();
        assert!(
            repo_cache().lock().unwrap().is_none(),
            "create_workspace 成功后 list_repos 缓存必须失效"
        );
    }

    #[test]
    fn create_full_flow_then_duplicate_rejected() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "task one").unwrap();
        assert_eq!(w.name, "task-one");
        assert_eq!(w.branch, "ccode/task-one");
        assert_eq!(w.base_branch, "main");
        assert_eq!(w.repo_name, "myrepo");
        assert_eq!(w.status, "active");
        assert_eq!(w.port_base, 4000);
        assert!(Path::new(&w.worktree_path).join("README.md").exists());
        // files-to-copy 进了 worktree
        assert_eq!(
            fs::read_to_string(Path::new(&w.worktree_path).join(".env")).unwrap(),
            "SECRET=1"
        );
        assert!(Path::new(&w.worktree_path).join(".envrc").exists());
        assert!(Path::new(&w.worktree_path).join(".env.local").exists() == false);
        // 分支真实存在
        assert!(run_git(
            &fx.repo,
            &["rev-parse", "--verify", "--quiet", "ccode/task-one"],
            Duration::from_secs(10)
        )
        .is_ok());
        // 第二个工作区拿到下一段端口
        let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "two").unwrap();
        assert_eq!(w2.port_base, 4010);
        // 同名（同分支）拒绝
        let err =
            create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "task one").unwrap_err();
        assert!(err.contains("已存在"), "{err}");
    }

    #[test]
    fn create_copy_failure_rolls_back_row_worktree_branch_and_port() {
        let Some(fx) = Fixture::new() else { return };
        let err = create_impl_with_copy(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "copy-fail",
            |_src, _dest| Err(std::io::Error::other("forced copy failure")),
        )
        .unwrap_err();
        assert!(err.contains("复制配置文件 .env 失败"), "{err}");
        assert!(err.contains("已回滚"), "{err}");
        assert!(query_workspaces(&fx.conn).unwrap().is_empty());
        assert!(!fx.ws_root.join("myrepo/copy-fail").exists());
        assert!(
            run_git(
                &fx.repo,
                &["rev-parse", "--verify", "--quiet", "ccode/copy-fail"],
                Duration::from_secs(10),
            )
            .is_err(),
            "复制失败后不得残留任务分支"
        );
        let next = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "after-copy-fail",
        )
        .unwrap();
        assert_eq!(next.port_base, 4000, "回滚后应释放预留端口段");
    }

    #[test]
    fn create_activation_failure_rolls_back_row_worktree_branch_and_port() {
        let Some(fx) = Fixture::new() else { return };
        fx.conn
            .execute_batch(
                "CREATE TRIGGER fail_workspace_activation
                 BEFORE UPDATE OF status ON workspaces
                 WHEN NEW.status='active'
                 BEGIN SELECT RAISE(FAIL, 'forced activation failure'); END;",
            )
            .unwrap();
        let err = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "db-fail",
        )
        .unwrap_err();
        assert!(err.contains("激活工作区记录失败"), "{err}");
        assert!(err.contains("已回滚"), "{err}");
        assert!(query_workspaces(&fx.conn).unwrap().is_empty());
        assert!(!fx.ws_root.join("myrepo/db-fail").exists());
        assert!(
            run_git(
                &fx.repo,
                &["rev-parse", "--verify", "--quiet", "ccode/db-fail"],
                Duration::from_secs(10),
            )
            .is_err(),
            "数据库激活失败后不得残留任务分支"
        );
    }

    #[test]
    fn create_rejects_files_to_copy_outside_repo() {
        let Some(fx) = Fixture::new() else { return };
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            "files_to_copy = [\"../outside\"]\n",
        )
        .unwrap();
        let err = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "escape",
        )
        .unwrap_err();
        assert!(err.contains("仓库内相对路径"), "{err}");
        assert!(query_workspaces(&fx.conn).unwrap().is_empty());
        assert!(!fx.ws_root.join("myrepo/escape").exists());
    }

    #[test]
    fn archive_restore_delete_lifecycle() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "life").unwrap();
        archive_impl(&fx.conn, &w.id).unwrap();
        let w = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w.status, "archived");
        assert!(w.archived_at.is_some());
        assert!(
            !Path::new(&w.worktree_path).exists(),
            "归档后 worktree 目录应被移除"
        );
        // 分支保留，可恢复
        restore_impl(&fx.conn, &w.id).unwrap();
        let w = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w.status, "active");
        assert!(w.archived_at.is_none());
        assert!(Path::new(&w.worktree_path).exists());
        // 删除：分支与行都没了
        delete_impl(&fx.conn, &w.id).unwrap();
        assert!(run_git(
            &fx.repo,
            &["rev-parse", "--verify", "--quiet", "ccode/life"],
            Duration::from_secs(10)
        )
        .is_err());
        assert!(get_workspace(&fx.conn, &w.id).is_err());
    }

    #[test]
    fn archive_refuses_uncommitted_changes_without_force() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "dirty-archive",
        )
        .unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("keep-me.txt"), "important\n").unwrap();
        let err = archive_impl(&fx.conn, &w.id).unwrap_err();
        assert!(err.contains("未提交改动"), "{err}");
        assert_eq!(
            fs::read_to_string(wt.join("keep-me.txt")).unwrap(),
            "important\n"
        );
        assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "active");
    }

    #[test]
    fn archive_tolerates_already_gone_worktree() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "gone").unwrap();
        fs::remove_dir_all(&w.worktree_path).unwrap();
        run_git(&fx.repo, &["worktree", "prune"], Duration::from_secs(10)).unwrap();
        archive_impl(&fx.conn, &w.id).unwrap();
        assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "archived");
    }

    #[test]
    fn workspace_env_block_from_port_base() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "envs").unwrap();
        let env = workspace_env_impl(&fx.conn, &w.worktree_path);
        assert_eq!(env.len(), 10);
        assert_eq!(env[0], ("CCODE_PORT".to_string(), "4000".to_string()));
        assert_eq!(env[9], ("CCODE_PORT_9".to_string(), "4009".to_string()));
        assert!(workspace_env_impl(&fx.conn, "/nonexistent").is_empty());
    }

    #[test]
    fn port_blocks_reuse_freed_slots() {
        let Some(fx) = Fixture::new() else { return };
        let a = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "a").unwrap();
        let b = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "b").unwrap();
        assert_eq!((a.port_base, b.port_base), (4000, 4010));
        // a 归档后其端口块释放，新工作区复用最低空闲块
        archive_impl(&fx.conn, &a.id).unwrap();
        let c = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "c").unwrap();
        assert_eq!(c.port_base, 4000);
    }

    #[test]
    fn create_rejects_non_repo() {
        let Some(fx) = Fixture::new() else { return };
        let err = create_impl(&fx.conn, &fx.ws_root, fx.dir.to_str().unwrap(), "x").unwrap_err();
        assert!(err.contains("不是 git 仓库"), "{err}");
    }

    /// 复刻真实用户仓库形态：默认分支 master、origin/HEAD 未设置
    fn setup_master_repo(dir: &Path) -> PathBuf {
        let origin = dir.join("origin.git");
        let repo = dir.join("masterrepo");
        Command::new("git")
            .args(["init", "--bare"])
            .arg(&origin)
            .output()
            .unwrap();
        Command::new("git")
            .args(["-c", "init.defaultBranch=master", "init"])
            .arg(&repo)
            .output()
            .unwrap();
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("README.md"), "hi").unwrap();
        sh(&repo, &["add", "README.md"]);
        sh(&repo, &["commit", "-m", "init"]);
        sh(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        sh(&repo, &["push", "-u", "origin", "master"]);
        // 故意不 set-head：origin/HEAD 不存在
        repo
    }

    #[test]
    fn master_repo_without_origin_head_uses_master_base() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("ccode-ws-master-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let conn = db_at(&dir.join("app.db")).unwrap();
        let ws_root = dir.join("workspaces");
        let repo = setup_master_repo(&dir);

        assert_eq!(detect_base_branch(&repo), "master");
        // 本地未推送的提交：工作区必须带上（从本地基准拉，不用 origin）
        fs::write(repo.join("local-only.txt"), "unpushed").unwrap();
        sh(&repo, &["add", "local-only.txt"]);
        sh(&repo, &["commit", "-m", "local only"]);
        let w = create_impl(&conn, &ws_root, repo.to_str().unwrap(), "on-master").unwrap();
        assert_eq!(w.base_branch, "master");
        assert_eq!(w.branch, "ccode/on-master");
        assert!(Path::new(&w.worktree_path).join("README.md").exists());
        assert!(
            Path::new(&w.worktree_path).join("local-only.txt").exists(),
            "未推送的本地提交必须出现在工作区"
        );
        // worktree 从本地 master 拉出（此时领先 origin/master 一个提交）
        let start = run_git(
            &repo,
            &["rev-parse", "ccode/on-master"],
            Duration::from_secs(10),
        )
        .unwrap();
        let local = run_git(&repo, &["rev-parse", "master"], Duration::from_secs(10)).unwrap();
        let origin = run_git(
            &repo,
            &["rev-parse", "origin/master"],
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(start, local);
        assert_ne!(start, origin);

        let _ = delete_impl(&conn, &w.id);
        let _ = run_git(&repo, &["worktree", "prune"], Duration::from_secs(10));
        let _ = fs::remove_dir_all(&dir);
    }

    // ===== W2：项目级脚本钩子 =====

    #[cfg(unix)]
    #[test]
    fn create_runs_setup_script_and_custom_files_to_copy() {
        let Some(fx) = Fixture::new() else { return };
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            "files_to_copy = [\".env\"]\n[scripts]\nsetup = \"echo ran > setup-mark.txt && echo port=$CCODE_PORT\"\n",
        )
        .unwrap();
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "hooked").unwrap();
        let res = w.setup_result.as_ref().expect("setup 结果应记录进 DTO");
        assert!(res.ok, "setup 输出: {}", res.output_tail);
        assert!(
            res.output_tail.contains("port=4000"),
            "脚本应拿到端口段 env: {}",
            res.output_tail
        );
        assert_eq!(
            fs::read_to_string(Path::new(&w.worktree_path).join("setup-mark.txt"))
                .unwrap()
                .trim(),
            "ran"
        );
        // 自定义 files_to_copy 生效：只复制 .env，不再复制 .envrc
        assert!(Path::new(&w.worktree_path).join(".env").exists());
        assert!(!Path::new(&w.worktree_path).join(".envrc").exists());
    }

    #[test]
    fn create_survives_setup_failure() {
        let Some(fx) = Fixture::new() else { return };
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            "[scripts]\nsetup = \"echo boom >&2 && exit 1\"\n",
        )
        .unwrap();
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "failsetup",
        )
        .unwrap();
        let res = w.setup_result.as_ref().unwrap();
        assert!(!res.ok, "exit 1 的 setup 应记录为失败");
        assert!(
            res.output_tail.contains("boom"),
            "stderr 尾部应保留: {}",
            res.output_tail
        );
        // 失败不阻断创建
        assert_eq!(w.status, "active");
        assert!(Path::new(&w.worktree_path).exists());
    }

    #[cfg(unix)]
    #[test]
    fn archive_script_failure_blocks_removal() {
        let Some(fx) = Fixture::new() else { return };
        let marker = fx.dir.join("archived-mark");
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            "[scripts]\narchive = \"exit 1\"\n",
        )
        .unwrap();
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "blockarc").unwrap();
        let err = archive_impl(&fx.conn, &w.id).unwrap_err();
        assert!(err.contains("archive 脚本执行失败"), "{err}");
        assert!(
            Path::new(&w.worktree_path).exists(),
            "脚本失败时 worktree 不得移除"
        );
        assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "active");
        // 脚本改成成功后归档照常
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            &format!("[scripts]\narchive = \"touch {}\"\n", marker.display()),
        )
        .unwrap();
        archive_impl(&fx.conn, &w.id).unwrap();
        assert!(!Path::new(&w.worktree_path).exists());
        assert!(marker.exists(), "archive 脚本应在移除前执行");
        assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "archived");
    }

    #[test]
    fn no_settings_repo_keeps_w1_behavior() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "plain").unwrap();
        assert!(
            w.setup_result.is_none(),
            "无 setup 脚本时 setup_result 为 None"
        );
        // 固定清单仍然生效
        assert!(Path::new(&w.worktree_path).join(".env").exists());
        assert!(Path::new(&w.worktree_path).join(".envrc").exists());
    }

    // ===== W3：评审与合并 =====

    /// 把 worktree 里的全部改动（含复制进来的 .env*）提交掉，返回提交数基准外的 ahead=1
    fn commit_all_in_worktree(wt: &Path, msg: &str) {
        sh(wt, &["add", "-A"]);
        sh(wt, &["-c", "commit.gpgsign=false", "commit", "-m", msg]);
    }

    #[test]
    fn health_ready_then_dirty_then_conflicting() {
        let Some(fx) = Fixture::new() else { return };
        // 主仓库保持干净（把 fixture 里未跟踪的 .env* 提交掉，否则 main_dirty 不 ready）
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "health").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "v1\n").unwrap();
        commit_all_in_worktree(&wt, "任务改动");
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert!(!h.uncommitted);
        assert!(!h.main_dirty && !h.main_off_base);
        assert_eq!(h.ahead, 1);
        assert_eq!(h.behind, 0);
        assert_eq!(
            h.conflict,
            Some(false),
            "merge-tree 探测应为干净（git 2.55）"
        );
        assert!(h.ready_to_merge);
        // 主仓库未提交改动 → 不再 ready（删文件恢复干净，不影响后面 behind 计数）
        fs::write(fx.repo.join("main-dirty.txt"), "x\n").unwrap();
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert!(h.main_dirty);
        assert!(!h.ready_to_merge);
        fs::remove_file(fx.repo.join("main-dirty.txt")).unwrap();
        // 未提交改动 → 不再 ready
        fs::write(wt.join("feature.txt"), "v2\n").unwrap();
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert!(h.uncommitted);
        assert!(!h.ready_to_merge);
        commit_all_in_worktree(&wt, "v2");
        // 主仓库推进同一文件的同一行并推到 origin → behind + 冲突探测命中
        fs::write(fx.repo.join("feature.txt"), "main 版本\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"],
        );
        sh(&fx.repo, &["push", "origin", "main"]);
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert_eq!(h.behind, 1);
        assert_eq!(h.conflict, Some(true), "同一文件同一行应探出冲突");
        assert_eq!(h.conflict_files, vec!["feature.txt".to_string()]);
        assert!(!h.ready_to_merge);
    }

    #[test]
    fn empty_workspace_is_not_ready_to_merge() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "empty").unwrap();
        let health = health_impl(&fx.conn, &w.id).unwrap();
        assert_eq!(health.ahead, 0);
        assert!(!health.uncommitted);
        assert_eq!(health.conflict, Some(false));
        assert!(!health.ready_to_merge, "空工作区不得启用合并");
    }

    #[test]
    fn resolve_flow_sync_conflict_pick_side_finish() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "resolve").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        // 分支改 feature.txt 并提交；main 改同一行 → 并入冲突
        fs::write(wt.join("feature.txt"), "branch\n").unwrap();
        commit_all_in_worktree(&wt, "分支改动");
        fs::write(fx.repo.join("feature.txt"), "main\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"],
        );
        assert!(
            run_git(&wt, &["merge", "main"], Duration::from_secs(60)).is_err(),
            "应产生冲突"
        );
        // 未解决清单；未解决前拒绝 finish
        let st = unmerged_impl(&wt).unwrap();
        assert!(st.merging);
        assert_eq!(st.files, vec!["feature.txt".to_string()]);
        let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
        assert!(drift.can_resolve_merge);
        assert!(drift
            .issues
            .iter()
            .any(|issue| issue.code == "merge_in_progress"));
        let content = conflict_content_impl(&wt, "feature.txt").unwrap();
        assert_eq!(content.ours.as_deref(), Some("branch\n"));
        assert_eq!(content.theirs.as_deref(), Some("main\n"));
        assert!(content.diff.contains("-branch"));
        assert!(content.diff.contains("+main"));
        let archive_err = archive_impl(&fx.conn, &w.id).unwrap_err();
        assert!(archive_err.contains("合并或冲突"), "{archive_err}");
        assert!(wt.exists(), "冲突未解决时归档不得移除工作树");
        assert!(finish_merge_impl(&wt).unwrap_err().contains("未解决"));
        // 选分支版（ours）→ 清单清空，文件内容是分支版（Windows 上 checkout 落盘为 CRLF，断言归一化）
        let st = resolve_file_impl(&wt, "feature.txt", "ours").unwrap();
        assert!(st.files.is_empty());
        assert_eq!(
            fs::read_to_string(wt.join("feature.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "branch\n"
        );
        // finish → merge 提交完成，健康检查通过后可直接合入主仓库
        finish_merge_impl(&wt).unwrap();
        assert!(!unmerged_impl(&wt).unwrap().merging);
        let (conflict, _) = conflict_probe(&wt, "main", "HEAD");
        assert_eq!(conflict, Some(false));
        assert!(health_impl(&fx.conn, &w.id).unwrap().ready_to_merge);
        merge_impl(&fx.conn, &w.id, false).unwrap();
        let merged = get_workspace(&fx.conn, &w.id).unwrap();
        assert!(merged.merged_at.is_some());
        assert_eq!(health_impl(&fx.conn, &w.id).unwrap().ahead, 0);
    }

    #[test]
    fn conflict_sync_uses_main_after_another_workspace_was_merged() {
        let Some(fx) = Fixture::new() else { return };
        fs::write(fx.repo.join("feature.txt"), "base\n").unwrap();
        sh(&fx.repo, &["add", ".env", ".envrc", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "base"],
        );
        let w1 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "one").unwrap();
        let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "two").unwrap();
        let wt1 = PathBuf::from(&w1.worktree_path);
        let wt2 = PathBuf::from(&w2.worktree_path);

        fs::write(wt1.join("feature.txt"), "workspace-one\n").unwrap();
        commit_all_in_worktree(&wt1, "工作区 1 改动");
        fs::write(wt2.join("feature.txt"), "workspace-two\n").unwrap();
        commit_all_in_worktree(&wt2, "工作区 2 改动");

        merge_impl(&fx.conn, &w1.id, false).unwrap();
        assert_eq!(
            fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
            "workspace-one\n"
        );
        assert_eq!(health_impl(&fx.conn, &w2.id).unwrap().conflict, Some(true));

        assert!(sync_base_impl(&wt2, "main", false).is_err());
        let state = unmerged_with_base(&wt2, "main").unwrap();
        assert!(state.merging);
        assert!(!state.stale_base);
        assert_eq!(state.files, vec!["feature.txt".to_string()]);
        assert_eq!(
            conflict_content_impl(&wt2, "feature.txt")
                .unwrap()
                .theirs
                .as_deref(),
            Some("workspace-one\n"),
            "基准侧必须是工作区 1 合并后的最新 main，而不是工作区 2 创建时的旧内容"
        );
    }

    #[test]
    fn stale_conflict_restarts_against_latest_base() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "stale").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "branch\n").unwrap();
        commit_all_in_worktree(&wt, "分支改动");

        fs::write(fx.repo.join("feature.txt"), "main-v1\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "main v1"],
        );
        assert!(sync_base_impl(&wt, "main", false).is_err());
        assert!(!unmerged_with_base(&wt, "main").unwrap().stale_base);
        assert_eq!(
            conflict_content_impl(&wt, "feature.txt")
                .unwrap()
                .theirs
                .as_deref(),
            Some("main-v1\n")
        );

        fs::write(fx.repo.join("feature.txt"), "main-v2\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "main v2"],
        );
        assert!(unmerged_with_base(&wt, "main").unwrap().stale_base);

        assert!(sync_base_impl(&wt, "main", true).is_err());
        assert!(!unmerged_with_base(&wt, "main").unwrap().stale_base);
        assert_eq!(
            conflict_content_impl(&wt, "feature.txt")
                .unwrap()
                .theirs
                .as_deref(),
            Some("main-v2\n")
        );
    }

    #[test]
    fn path_context_classifies_worktree_main_and_other() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "ctx").unwrap();
        let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "ctx2").unwrap();
        // 工作树内 → worktree（带工作区名与分支）；siblings = 同仓库其他活跃工作区
        let wt_readme = PathBuf::from(&w.worktree_path).join("README.md");
        let c = path_context_impl(&fx.conn, wt_readme.to_str().unwrap()).unwrap();
        assert_eq!(c.kind, "worktree");
        assert_eq!(c.workspace_name.as_deref(), Some("ctx"));
        assert_eq!(c.branch.as_deref(), Some("ccode/ctx"));
        assert_eq!(c.siblings.len(), 1);
        assert_eq!(c.siblings[0].workspace_name, "ctx2");
        // 主仓库内 → main（分支给的是基准分支）；siblings = 全部活跃工作区
        let c = path_context_impl(&fx.conn, fx.repo.join("README.md").to_str().unwrap()).unwrap();
        assert_eq!(c.kind, "main");
        assert_eq!(c.branch.as_deref(), Some("main"));
        assert_eq!(c.siblings.len(), 2);
        // 不相关路径 → other；归档后不再命中
        let c = path_context_impl(&fx.conn, "/tmp").unwrap();
        assert_eq!(c.kind, "other");
        archive_impl(&fx.conn, &w.id).unwrap();
        archive_impl(&fx.conn, &w2.id).unwrap();
        let c = path_context_impl(&fx.conn, fx.repo.join("README.md").to_str().unwrap()).unwrap();
        assert_eq!(c.kind, "other", "已归档工作区的主仓库不再标记");
    }

    #[test]
    fn drift_detects_missing_worktree_and_remount_repairs_it() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "drift-remount",
        )
        .unwrap();
        sh(
            &fx.repo,
            &["worktree", "remove", "--force", &w.worktree_path],
        );
        let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
        assert!(!drift.healthy);
        assert!(drift.can_remount);
        assert!(drift
            .issues
            .iter()
            .any(|issue| issue.code == "worktree_missing"));

        let repaired = repair_remount_impl(&fx.conn, &w.id).unwrap();
        assert_eq!(repaired.status, "active");
        assert!(Path::new(&repaired.worktree_path).is_dir());
        assert!(workspace_drift_impl(&fx.conn, &w.id).unwrap().healthy);
    }

    #[test]
    fn drift_relocates_moved_repository_without_losing_archived_branch() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "drift-move",
        )
        .unwrap();
        archive_impl(&fx.conn, &w.id).unwrap();
        let moved = fx.dir.join("moved-repo");
        fs::rename(&fx.repo, &moved).unwrap();
        let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
        assert!(drift.can_relocate);
        assert!(drift
            .issues
            .iter()
            .any(|issue| issue.code == "repo_missing"));

        let relocated = relocate_repo_impl(&fx.conn, &w.id, moved.to_str().unwrap()).unwrap();
        assert_eq!(relocated.repo_path, moved.to_string_lossy());
        assert_eq!(relocated.status, "archived");
        assert!(workspace_drift_impl(&fx.conn, &w.id).unwrap().healthy);
    }

    #[test]
    fn drift_detects_archived_record_with_live_worktree_and_reactivates() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "drift-mismatch",
        )
        .unwrap();
        fx.conn
            .execute(
                "UPDATE workspaces SET status='archived' WHERE id=?1",
                params![w.id],
            )
            .unwrap();
        let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
        assert!(drift
            .issues
            .iter()
            .any(|issue| issue.code == "archived_worktree_present"));
        assert!(drift.can_remount);
        let repaired = repair_remount_impl(&fx.conn, &w.id).unwrap();
        assert_eq!(repaired.status, "active");
        assert!(workspace_drift_impl(&fx.conn, &w.id).unwrap().healthy);
    }

    #[test]
    fn drift_detects_missing_archived_branch() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "drift-branch",
        )
        .unwrap();
        archive_impl(&fx.conn, &w.id).unwrap();
        sh(&fx.repo, &["branch", "-D", &w.branch]);
        let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
        assert!(drift
            .issues
            .iter()
            .any(|issue| issue.code == "branch_missing"));
        assert!(!drift.can_remount);
        assert!(drift.can_clean_record);
    }

    #[cfg(unix)]
    #[test]
    fn merge_workspace_happy_path_merges_and_archives() {
        let Some(fx) = Fixture::new() else { return };
        // 主仓库保持干净（把 fixture 里未跟踪的 .env* 提交掉）
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "mergeme").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "done\n").unwrap();
        commit_all_in_worktree(&wt, "任务完成");
        let out = merge_impl(&fx.conn, &w.id, true).unwrap();
        assert!(out.merged && out.archived);
        assert!(out.output.contains("已合并并归档"), "{}", out.output);
        // 改动进了主仓库的 main
        assert_eq!(
            fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
            "done\n"
        );
        // 工作区已归档、worktree 已移除
        let w2 = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w2.status, "archived");
        assert!(!wt.exists());
    }

    #[cfg(unix)]
    #[test]
    fn merge_success_archive_failure_is_reported_as_partial() {
        let Some(fx) = Fixture::new() else { return };
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            "[scripts]\narchive = \"exit 1\"\n",
        )
        .unwrap();
        sh(&fx.repo, &["add", ".env", ".envrc", ".ccode/settings.toml"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "settings"],
        );
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "partial-archive",
        )
        .unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "done\n").unwrap();
        commit_all_in_worktree(&wt, "任务完成");

        let result = merge_impl(&fx.conn, &w.id, true).unwrap();
        assert!(result.merged);
        assert!(!result.archived);
        assert_eq!(result.failed_phase.as_deref(), Some("archive"));
        assert!(result.message.contains("代码已合并"));
        assert!(wt.exists(), "归档失败必须保留工作树");
        let saved = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(saved.status, "active");
        assert!(saved.merged_at.is_some());
        assert_eq!(
            fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
            "done\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn merge_without_archive_keeps_workspace_active() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "keepme").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "done\n").unwrap();
        commit_all_in_worktree(&wt, "任务完成");
        let out = merge_impl(&fx.conn, &w.id, false).unwrap();
        assert!(out.merged && !out.archived);
        assert!(out.output.contains("工作区保留"), "{}", out.output);
        // 改动进了 main，但工作区仍活跃、worktree 还在，merged_at 已置位
        assert_eq!(
            fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
            "done\n"
        );
        let w2 = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w2.status, "active");
        assert!(w2.merged_at.is_some(), "只合并应记录 merged_at");
        assert!(wt.exists());
        // 之后「合并并归档」：merge 变 no-op，归档照常发生
        let out = merge_impl(&fx.conn, &w.id, true).unwrap();
        assert!(out.archived);
        assert!(out.output.contains("已合并并归档"), "{}", out.output);
        assert!(!wt.exists());
    }

    #[test]
    fn final_merge_conflict_is_aborted_in_main_repo() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(
            &fx.conn,
            &fx.ws_root,
            fx.repo.to_str().unwrap(),
            "abort-main",
        )
        .unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("README.md"), "branch\n").unwrap();
        commit_all_in_worktree(&wt, "branch change");
        fs::write(fx.repo.join("README.md"), "main\n").unwrap();
        sh(&fx.repo, &["add", "README.md"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "main change"],
        );

        let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
        assert!(err.contains("已自动回退"), "{err}");
        assert!(run_git(
            &fx.repo,
            &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
            Duration::from_secs(10)
        )
        .is_err());
        assert!(run_git(
            &fx.repo,
            &["status", "--porcelain"],
            Duration::from_secs(10)
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            fs::read_to_string(fx.repo.join("README.md")).unwrap(),
            "main\n"
        );
    }

    #[test]
    fn merge_workspace_refuses_dirty_or_wrong_branch_main_repo() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "guard").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("x.txt"), "x\n").unwrap();
        commit_all_in_worktree(&wt, "x");
        // 主仓库有未跟踪文件（fixture 的 .env*）→ 脏，拒绝
        let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
        assert!(err.contains("未提交改动"), "{err}");
        assert_eq!(
            get_workspace(&fx.conn, &w.id).unwrap().status,
            "active",
            "拒绝后工作区状态不变"
        );
        assert!(wt.exists());
        // 清掉脏文件但切到别的分支 → 同样拒绝
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        sh(&fx.repo, &["checkout", "-b", "other"]);
        let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
        assert!(err.contains("不在基准分支"), "{err}");
        // 主仓库 main 上不应有 x.txt（merge 没发生）
        sh(&fx.repo, &["checkout", "main"]);
        assert!(!fx.repo.join("x.txt").exists());
    }
}
