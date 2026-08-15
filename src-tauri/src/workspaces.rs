use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
#[cfg(test)]
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

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
    /// 上游漂移提醒（启发式，非硬状态）：序号更小的上游步骤晚于本步「最后推进时间」
    /// 发生合并时，回填该上游步骤名（见 stale_upstream_for）；仅 list_workspaces 计算
    pub stale_upstream: Option<String>,
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
    ensure_workspaces_table(&conn)?;
    Ok(conn)
}

// 幂等建表：delete_workspaces_for_repo 可能拿到只建过 projects 表的连接（同一 app.db）
fn ensure_workspaces_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces(
          id TEXT PRIMARY KEY, repo_path TEXT, name TEXT, branch TEXT,
          worktree_path TEXT, base_branch TEXT, port_base INTEGER,
          status TEXT NOT NULL DEFAULT 'active', created_at TEXT, archived_at TEXT);",
    )
    .map_err(|e| format!("初始化 workspaces 表失败: {e}"))?;
    // 轻量迁移：老库补 merged_at 列（已存在则忽略错误）
    let _ = conn.execute_batch("ALTER TABLE workspaces ADD COLUMN merged_at TEXT;");
    Ok(())
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
        stale_upstream: None,
        setup_result: None,
    }
}

/// 上游漂移（纯逻辑，启发式提醒非硬状态）：步骤 k 的任一上游步骤（序号更小）晚于本步
/// 「最后推进时间」发生合并 → 返回最晚合并的上游步骤名，否则 None。
/// 最后推进时间口径：本步工作区已合并取 merged_at，未合并取 created_at。
/// 时间戳均为 now_iso 定宽 UTC 串，字典序即时间序。
/// workspaces 需先按同仓库过滤；步骤-工作区绑定 = steps[].workspace_name 匹配工作区名。
pub(crate) fn stale_upstream_for(
    steps: &[crate::projects::StepDto],
    workspaces: &[WorkspaceDto],
    step_index: usize,
) -> Option<String> {
    let step = steps.get(step_index)?;
    let target_ws = workspaces.iter().find(|w| w.name == step.workspace_name)?;
    let last_progress = target_ws
        .merged_at
        .as_deref()
        .unwrap_or(&target_ws.created_at);
    let mut best: Option<(&str, &str)> = None; // (merged_at, 步骤名)
    for step in &steps[..step_index] {
        let Some(upstream_ws) = workspaces.iter().find(|w| w.name == step.workspace_name)
        else {
            continue;
        };
        let Some(merged_at) = upstream_ws.merged_at.as_deref() else {
            continue;
        };
        if merged_at > last_progress && best.map_or(true, |(b, _)| merged_at > b) {
            best = Some((merged_at, step.name.as_str()));
        }
    }
    best.map(|(_, name)| name.to_string())
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
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_cmd(cmd, timeout)
}

/// 子进程原始结果：conflict_probe 需要区分退出码 0/1，run_git_raw 需要未 trim 的 stdout
struct CmdOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

/// 子进程的 stdout/stderr 各放线程读空（管道容量有限，不读会死锁），主线程轮询退出，超时则 kill
fn run_cmd_full(mut cmd: crate::process::BackgroundCommand, timeout: Duration) -> Result<CmdOutput, String> {
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
                return Ok(CmdOutput {
                    success: status.success(),
                    code: status.code(),
                    stdout: out_handle.join().unwrap_or_default(),
                    stderr: err_handle.join().unwrap_or_default(),
                    timed_out: false,
                });
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Ok(CmdOutput {
                        success: false,
                        code: None,
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        timed_out: true,
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待进程失败: {e}")),
        }
    }
}

/// 成功返回 trim 后 stdout，失败返回 trim 后 stderr
fn run_cmd(cmd: crate::process::BackgroundCommand, timeout: Duration) -> Result<String, String> {
    let out = run_cmd_full(cmd, timeout)?;
    if out.timed_out {
        return Err("操作超时".into());
    }
    if out.success {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
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

/// 空仓库（HEAD 为 unborn，尚无任何提交）没有可引用的基准分支，worktree add 必失败：
/// 先在 HEAD symbolic-ref 指向的分支上补一个空初始提交（分支名由 init.defaultBranch 决定，
/// 可能是 master，禁止硬编码），提交后继续走正常创建流程。
/// 身份优先沿用仓库/全局已配置的 user.name/user.email；未配置时仅本次提交用 -c 注入临时身份，
/// 不写入用户 git config。
fn ensure_initial_commit(repo: &Path) -> Result<(), String> {
    const T: Duration = Duration::from_secs(30);
    // 已有任一提交则不是 unborn，直接返回（非空仓库零行为变化）
    if run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], T).is_ok() {
        return Ok(());
    }
    let configured = |key: &str| {
        run_git(repo, &["config", "--get", key], T)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    };
    // 与 merge/sync_base 一致：应用内自动提交必须绕过用户全局 commit.gpgsign
    let mut args: Vec<&str> = vec!["-c", "commit.gpgsign=false"];
    if !configured("user.name") {
        args.extend(["-c", "user.name=Ccode"]);
    }
    if !configured("user.email") {
        args.extend(["-c", "user.email=ccode@localhost"]);
    }
    args.extend(["commit", "--allow-empty", "-m", "初始化空仓库（Ccode 自动创建）"]);
    run_git(repo, &args, T).map_err(|e| format!("空仓库初始化提交失败: {e}"))?;
    Ok(())
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

/// files_to_copy 写入 worktree 前的目标安全检查：rel 必须是树内相对路径，且父链上
/// 已存在的目录与目标自身都不得是符号链接。工作区可被 agent 任意写入，仓库也可能
/// 跟踪指向树外的符号链接——fs::copy/create_dir_all 跟随符号链接会把文件写到树外。
fn ensure_copy_dest_safe(worktree: &Path, rel: &str) -> Result<(), String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("复制目标必须是工作区内相对路径: {rel}"));
    }
    let mut cursor = worktree.to_path_buf();
    if let Some(parent_rel) = rel_path.parent() {
        for comp in parent_rel.components() {
            cursor.push(comp.as_os_str());
            match fs::symlink_metadata(&cursor) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!(
                        "复制目标路径经过符号链接 {}，为避免写出工作区已拒绝: {rel}",
                        cursor.display()
                    ));
                }
                Ok(_) => {}
                // 缺失的分量由后面 create_dir_all 补建，更深层级无需再查
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(format!("检查复制目标路径失败: {e}")),
            }
        }
    }
    let dest = worktree.join(rel);
    if let Ok(meta) = fs::symlink_metadata(&dest) {
        if meta.file_type().is_symlink() {
            return Err(format!("复制目标是符号链接，为避免写出工作区已拒绝: {rel}"));
        }
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("复制 {rel} 前创建目录失败: {e}"))?;
    }
    Ok(())
}

/// files_to_copy 落到 worktree 的统一入口：先过 ensure_copy_dest_safe 再复制
fn safe_copy_into_worktree(worktree: &Path, rel: &str, src: &Path) -> Result<(), String> {
    ensure_copy_dest_safe(worktree, rel)?;
    fs::copy(src, worktree.join(rel))
        .map(|_| ())
        .map_err(|e| format!("复制文件 {rel} 失败: {e}"))
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
        // --force 例外理由（对照归档禁用 --force 的约定）：这个 worktree 是应用秒前自建的，
        // 里面只可能有 git 刚检出 + 本进程刚复制的未跟踪 files_to_copy 文件，不存在用户劳动成果
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
    // 落库/分支检测/worktree 路径派生统一用 canonical 路径（与 register_project 的
    // canonical_key 同口径）：前端按 repoPath 字符串把工作组归进项目分组，symlink
    // 拼写不一致（macOS /var→/private/var 等）会让工作区掉出分组。canonicalize 失败
    // （目录不存在）保留原路径——后续 rev-parse 仍报「不是 git 仓库」，错误体验不变。
    let repo = PathBuf::from(crate::projects::canonical_key(&repo));
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
    // 空仓库（unborn HEAD）先补初始提交：放在端口预留/事务之前，失败无需回滚，
    // 错误直接透出；成功后 detect_base_branch 才能解析到真实基准分支
    ensure_initial_commit(&repo)?;
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
            // 安全检查在注入的复制函数之外：防 dest/父链符号链接穿透对三处复制点统一生效
            ensure_copy_dest_safe(&worktree_path, file)?;
            copy_file(&src, &worktree_path.join(file))
                .map_err(|e| format!("复制配置文件 {file} 失败: {e}"))?;
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

// 生产路径一律走带 guard 的变体（归档前复查运行中任务）；本包装仅供测试免传 guard
#[cfg(test)]
fn archive_impl(conn: &Connection, id: &str) -> Result<(), String> {
    archive_impl_with_guard(conn, id, &|_| Ok(()))
}

/// ensure_no_active_tasks：紧邻 worktree remove 前复查工作区内是否仍有运行中的
/// agent/run 脚本（命令层的预检与移除之间隔着脚本钩子，TOCTOU 窗口必须在这里再关一次）
fn archive_impl_with_guard(
    conn: &Connection,
    id: &str,
    ensure_no_active_tasks: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
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
        // 钩子可能跑了很久，期间用户可能又在工作区启动了任务；移除前必须再确认无人占用
        ensure_no_active_tasks(&w.worktree_path)?;
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
            // 回写先前删除的可恢复副本；回写失败必须并入错误信息，不能静默吞掉
            let mut restore_errors = Vec::new();
            for path in &removable_copies {
                let src = Path::new(&w.repo_path).join(path);
                if let Err(re) = safe_copy_into_worktree(&wt, path, &src) {
                    restore_errors.push(re);
                }
            }
            return Err(if restore_errors.is_empty() {
                format!("移除 worktree 失败，工作区已保留: {e}")
            } else {
                format!(
                    "移除 worktree 失败，工作区已保留: {e}；回写副本失败: {}",
                    restore_errors.join("；")
                )
            });
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
                    let mut copy_errors = Vec::new();
                    for path in &copied_files {
                        let src = Path::new(&w.repo_path).join(path);
                        if src.is_file() && !wt.join(path).exists() {
                            if let Err(ce) = safe_copy_into_worktree(&wt, path, &src) {
                                copy_errors.push(ce);
                            }
                        }
                    }
                    if copy_errors.is_empty() {
                        format!("归档状态写入失败，已恢复工作树，未丢失内容: {e}")
                    } else {
                        format!(
                            "归档状态写入失败，已恢复工作树: {e}；回写副本失败: {}",
                            copy_errors.join("；")
                        )
                    }
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
                safe_copy_into_worktree(Path::new(&w.worktree_path), &path, &src)
                    .map_err(|e| format!("恢复复制文件失败: {e}"))?;
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

/// 某仓库的全部工作区（active/archived 不分状态）。
/// repo_path 落库时可能非 canonical 写法，按 canonical 路径比对。
pub(crate) fn workspaces_of_repo(
    conn: &Connection,
    repo: &Path,
) -> Result<Vec<WorkspaceDto>, String> {
    ensure_workspaces_table(conn)?;
    let key = fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    Ok(query_workspaces(conn)?
        .into_iter()
        .filter(|w| {
            fs::canonicalize(&w.repo_path).unwrap_or_else(|_| PathBuf::from(&w.repo_path)) == key
        })
        .collect())
}

/// 删除某仓库的全部工作区，返回已删工作区名清单。
/// 供 projects::delete_project_dir 彻底删除项目目录用：属删除语义，允许 force 移除
/// worktree；任一失败即中止（已删的不回滚），错误信息里说明已删哪些。
pub(crate) fn delete_workspaces_for_repo(
    conn: &Connection,
    repo: &Path,
) -> Result<Vec<String>, String> {
    let targets = workspaces_of_repo(conn, repo)?;
    let mut deleted: Vec<String> = Vec::new();
    for w in &targets {
        if let Err(e) = delete_impl(conn, &w.id) {
            let done = if deleted.is_empty() {
                "尚无工作区被删除".to_string()
            } else {
                format!("已删除的工作区：{}", deleted.join("、"))
            };
            return Err(format!("删除工作区「{}」失败: {e}；{done}", w.name));
        }
        deleted.push(w.name.clone());
    }
    Ok(deleted)
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
    // 只有 active 工作区占用端口段；creating/archived 不下发端口 env
    let Ok(w) = query_workspaces(conn).and_then(|rows| {
        rows.into_iter()
            .find(|w| w.worktree_path == worktree_path && w.status == "active")
            .ok_or_else(|| "工作区不存在或未激活".to_string())
    }) else {
        return Vec::new();
    };
    port_env(w.port_base)
}

// ===== 项目级脚本钩子（§6.10 阶段 B；脚本来自仓库自己的 .ccode 配置） =====

#[cfg(windows)]
fn shell_cmd(script: &str) -> Result<crate::process::BackgroundCommand, String> {
    // cmd 是 Windows 系统组件，固定在 System32 且不受用户 PATH 影响，无需 resolve_binary
    let mut c = crate::process::background_command("cmd");
    c.args(["/C", script]);
    Ok(c)
}

#[cfg(not(windows))]
fn shell_cmd(script: &str) -> Result<crate::process::BackgroundCommand, String> {
    let bash = crate::agents::resolve_binary("bash")
        .ok_or("找不到 bash 可执行文件，无法运行项目脚本钩子")?;
    let mut c = crate::process::background_command(bash);
    c.args(["-c", script]);
    Ok(c)
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
    let mut cmd = match shell_cmd(script) {
        Ok(cmd) => cmd,
        Err(e) => return (false, e),
    };
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
    /// 冲突现场已落后基准（MERGE_HEAD ≠ 基准分支 tip）：继续按旧两侧选边是解过期冲突，
    /// 收件箱据此提示「需重新同步」（评审层 unmerged_with_base 的同口径前置）
    pub stale_base: bool,
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
    let Some(git) = crate::agents::resolve_binary("git") else {
        return (None, vec![]);
    };
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args(["merge-tree", "--write-tree", "--name-only", base, branch])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(out) = run_cmd_full(cmd, Duration::from_secs(30)) else {
        return (None, vec![]);
    };
    let conflict = match (out.timed_out, out.code) {
        (false, Some(0)) => Some(false),
        (false, Some(1)) => Some(true),
        _ => None, // 旧版 git 没有该参数（退出码 129 等），或超时/启动失败
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
    // 冲突现场是否已落后基准：仅 merge 进行中才有 MERGE_HEAD，多一次 rev-parse 只发生在此时
    let stale_base = run_git(
        &wt,
        &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
        Duration::from_secs(10),
    )
    .ok()
    .filter(|mh| !mh.is_empty())
    .map(|mh| {
        run_git(&wt, &["rev-parse", &base], Duration::from_secs(10))
            .map(|tip| tip != mh)
            .unwrap_or(false)
    })
    .unwrap_or(false);
    Ok(WsHealthDto {
        uncommitted,
        ahead,
        behind,
        conflict,
        conflict_files,
        main_off_base,
        main_dirty,
        stale_base,
        ready_to_merge: ahead > 0
            && !uncommitted
            && conflict == Some(false)
            && !main_off_base
            && !main_dirty,
    })
}

// 生产路径一律走带 guard 的变体（归档前复查运行中任务）；本包装仅供测试免传 guard
#[cfg(test)]
fn merge_impl(
    conn: &Connection,
    id: &str,
    archive: bool,
) -> Result<WorkspaceMergeResultDto, String> {
    merge_impl_with_guard(conn, id, archive, &|_| Ok(()))
}

/// ensure_no_active_tasks 透传给归档阶段：merge 成功后、worktree remove 前复查运行中任务
fn merge_impl_with_guard(
    conn: &Connection,
    id: &str,
    archive: bool,
    ensure_no_active_tasks: &dyn Fn(&str) -> Result<(), String>,
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
    // 应用内自动 merge commit 必须绕过用户全局 commit.gpgsign：无头环境调 gpg 会卡住或失败
    let mut log = match run_git(
        &repo,
        &["-c", "commit.gpgsign=false", "merge", "--no-ff", &w.branch],
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
        if let Err(e) = archive_impl_with_guard(conn, id, ensure_no_active_tasks) {
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
    let gh_ok = crate::process::background_command(&gh)
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
    let mut cmd = crate::process::background_command(&gh);
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
        // 上游漂移提醒：按仓库分组读一次 project.toml，逐步骤比对合并时间（启发式，读失败静默跳过）
        let mut repos: Vec<String> = rows.iter().map(|w| w.repo_path.clone()).collect();
        repos.sort_unstable();
        repos.dedup();
        for repo in repos {
            let steps = crate::projects::read_config_at(Path::new(&repo)).config.steps;
            if steps.is_empty() {
                continue;
            }
            let repo_ws: Vec<WorkspaceDto> = rows
                .iter()
                .filter(|w| w.repo_path == repo)
                .cloned()
                .collect();
            for index in 0..steps.len() {
                let Some(stale) = stale_upstream_for(&steps, &repo_ws, index) else {
                    continue;
                };
                if let Some(w) = rows
                    .iter_mut()
                    .find(|w| w.repo_path == repo && w.name == steps[index].workspace_name)
                {
                    w.stale_upstream = Some(stale);
                }
            }
        }
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
        let ensure_idle = |worktree_path: &str| {
            let active = manager.active_workspace_tasks(worktree_path);
            if active.is_empty() {
                Ok(())
            } else {
                Err(format!(
                    "工作区仍有 {} 个 agent/run 脚本在运行，请先停止或关闭对应终端标签",
                    active.len()
                ))
            }
        };
        ensure_idle(&w.worktree_path)?; // 快速预检；归档内部在移除 worktree 前还会复查
        archive_impl_with_guard(&conn, &id, &ensure_idle)?;
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

// ===== 产物待核验（收件箱；只读，不进轮询——由前端随健康度同频次拉取） =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingArtifactDto {
    pub workspace_id: String,
    pub workspace_name: String,
    pub repo_name: String,
}

/// 单个预期产物「已产出且够新」：目录条目（尾斜杠）要求至少一个直接子文件（与核验清单
/// 同口径），mtime 取目录与子项最大值；文件条目看自身。mtime 早于工作区创建时间的不算
/// （files-to-copy/模板带入的旧文件不是本任务产物）。
fn artifact_produced_since(root: &Path, entry: &str, since: SystemTime) -> bool {
    let is_dir_entry = entry.ends_with('/') || entry.ends_with('\\');
    let rel = entry.trim().trim_end_matches(['/', '\\']);
    // 只接受根的相对路径（核验清单的根约束同口径）；绝对路径/逃逸一律视为未产出
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
        return false;
    }
    let path = root.join(rel);
    let fresh = |m: &fs::Metadata| m.modified().map(|t| t >= since).unwrap_or(false);
    if is_dir_entry {
        let mut any_file = false;
        let mut any_fresh = fs::metadata(&path).map(|m| fresh(&m)).unwrap_or(false);
        let Ok(rd) = fs::read_dir(&path) else {
            return false;
        };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_file() {
                any_file = true;
                if fresh(&m) {
                    any_fresh = true;
                }
            }
        }
        any_file && any_fresh
    } else {
        fs::metadata(&path)
            .map(|m| m.is_file() && fresh(&m))
            .unwrap_or(false)
    }
}

pub(crate) fn pending_artifact_checks_impl(conn: &Connection) -> Vec<PendingArtifactDto> {
    let mut out = Vec::new();
    let Ok(rows) = query_workspaces(conn) else {
        return out;
    };
    // 每个 repo 只读一次 project.toml
    let mut configs: std::collections::HashMap<String, crate::projects::ProjectConfigDto> =
        std::collections::HashMap::new();
    for w in rows.into_iter().filter(|w| w.status == "active") {
        let cfg = configs
            .entry(w.repo_path.clone())
            .or_insert_with(|| crate::projects::read_config_at(Path::new(&w.repo_path)).config);
        let Some(step) = cfg
            .steps
            .iter()
            .find(|s| !s.workspace_name.is_empty() && s.workspace_name == w.name)
        else {
            continue;
        };
        if step.expected_artifacts.is_empty() {
            continue;
        }
        let Ok(created) = chrono::DateTime::parse_from_rfc3339(&w.created_at) else {
            continue; // 创建时间不可解析时不猜，宁缺勿报
        };
        let since: SystemTime = created.into();
        let root = PathBuf::from(&w.worktree_path);
        if step
            .expected_artifacts
            .iter()
            .all(|a| artifact_produced_since(&root, a, since))
        {
            out.push(PendingArtifactDto {
                workspace_id: w.id,
                workspace_name: w.name,
                repo_name: w.repo_name,
            });
        }
    }
    out
}

#[tauri::command]
pub async fn pending_artifact_checks() -> Vec<PendingArtifactDto> {
    tauri::async_runtime::spawn_blocking(|| {
        db().map(|c| pending_artifact_checks_impl(&c))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

// ===== 人工事项（步骤的人机分工清单）：声明在 project.toml steps[].human_tasks，
// 状态不进档案卡——手动勾选存 app.db human_task_checks 表（行在 = 人勾了），
// 落点检测按文件系统现算；done = 手动 || 检测，手动优先（勾了系统不再追问） =====

/// 单个人工事项的派生状态（list_human_task_states 返回，按步骤顺序平铺）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanTaskStateDto {
    pub step: String,
    pub title: String,
    pub guidance: String,
    pub target: String,
    pub timing: String,
    /// 可选事项：不做也不影响这一步跑完；UI 标「可选」且不计入待做数
    pub optional: bool,
    /// 落点位置检测到文件（空 target 恒 false——纯脑力事项只能手勾）
    pub detected: bool,
    /// 人手动勾过（优先于检测；取消勾选即回到纯检测口径）
    pub manual: bool,
    /// done = manual || detected（前端不再重算）
    pub done: bool,
}

fn ensure_human_task_checks_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS human_task_checks(
          project_path TEXT NOT NULL, step TEXT NOT NULL, title TEXT NOT NULL,
          updated_at TEXT, PRIMARY KEY(project_path, step, title));",
    )
    .map_err(|e| format!("初始化 human_task_checks 表失败: {e}"))?;
    // checked 列（v3.89）：0 = 用户**显式取消**。原表只能记「勾了」，
    // 取消就是删行、回落检测口径——落点里有文件时会立刻自动勾回来，表现为「取消不了」。
    // 已存在时报错，忽略即可（SQLite 无 IF NOT EXISTS COLUMN）
    let _ = conn.execute(
        "ALTER TABLE human_task_checks ADD COLUMN checked INTEGER NOT NULL DEFAULT 1",
        [],
    );
    Ok(())
}

fn manual_checks_at(
    conn: &Connection,
    project_path: &str,
) -> std::collections::HashMap<(String, String), bool> {
    let mut out = std::collections::HashMap::new();
    if ensure_human_task_checks_table(conn).is_err() {
        return out;
    }
    if let Ok(mut stmt) = conn
        .prepare("SELECT step, title, checked FROM human_task_checks WHERE project_path = ?1")
    {
        if let Ok(rows) = stmt.query_map(params![project_path], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, i64>(2)? != 0,
            ))
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// 极简通配匹配：仅支持 `*`（任意字符序列），大小写敏感（两指针 + 星号回退点）
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let pc: Vec<char> = pattern.chars().collect();
    let nc: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star_p, mut star_n) = (None, None);
    while ni < nc.len() {
        if pi < pc.len() && pc[pi] == nc[ni] {
            pi += 1;
            ni += 1;
        } else if pi < pc.len() && pc[pi] == '*' {
            star_p = Some(pi);
            star_n = Some(ni);
            pi += 1;
        } else if let (Some(sp), Some(sn)) = (star_p, star_n) {
            pi = sp + 1;
            ni = sn + 1;
            star_n = Some(ni);
        } else {
            return false;
        }
    }
    while pi < pc.len() && pc[pi] == '*' {
        pi += 1;
    }
    pi == pc.len()
}

/// 落点检测：root 下是否已有交付物。
/// 三种形态：目录（结尾 /）= 内有任意非隐藏文件；目录/通配 = 目录内有匹配文件（不递归）；
/// 精确文件 = 存在。只接受根的相对路径，绝对路径/.. 逃逸一律视为未交付（同产物核验口径）。
pub(crate) fn human_target_hit(root: &Path, target: &str) -> bool {
    let rel = target.trim();
    if rel.is_empty() {
        return false;
    }
    let is_dir_entry = rel.ends_with('/') || rel.ends_with('\\');
    let rel = rel.trim_end_matches(['/', '\\']);
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
        return false;
    }
    let visible_file = |e: &fs::DirEntry| {
        !e.file_name().to_string_lossy().starts_with('.')
            && e.metadata().map(|m| m.is_file()).unwrap_or(false)
    };
    if is_dir_entry {
        // 目录形态：内有任意非隐藏文件即算交付；递归（用户可能放进子目录），限量防暴走
        let mut stack = vec![root.join(rel)];
        let mut visited = 0usize;
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                visited += 1;
                if visited > 2000 || stack.len() > 64 {
                    return false; // 异常巨大的目录不按交付计
                }
                let Ok(m) = e.metadata() else { continue };
                if m.is_file() {
                    return true;
                }
                if m.is_dir() {
                    stack.push(e.path());
                }
            }
        }
        return false;
    }
    if rel.contains('*') {
        // 只允许通配在最后一段；目录部分仍须是纯相对路径
        let (dir, pattern) = match rel.rsplit_once('/') {
            Some((d, p)) => (d, p),
            None => ("", rel),
        };
        if pattern.is_empty() || dir.contains('*') {
            return false;
        }
        let dir_path = if dir.is_empty() { root.to_path_buf() } else { root.join(dir) };
        let Ok(rd) = fs::read_dir(dir_path) else {
            return false;
        };
        return rd.flatten().any(|e| {
            visible_file(&e) && wildcard_match(pattern, &e.file_name().to_string_lossy())
        });
    }
    fs::metadata(root.join(rel))
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// 步骤人工事项的检测根列表：项目根恒在；步骤绑定了活跃工作区时工作树根也算
/// （交付落在哪一侧都算数——开工前的事项多在主仓，执行中的事项多在工作树）
fn human_detection_roots(
    conn: Option<&Connection>,
    project_root: &Path,
    workspace_name: &str,
) -> Vec<PathBuf> {
    let mut roots = vec![project_root.to_path_buf()];
    if workspace_name.is_empty() {
        return roots;
    }
    if let Some(conn) = conn {
        let key = project_root.to_string_lossy().into_owned();
        if let Ok(rows) = query_workspaces(conn) {
            for w in rows {
                if w.status == "active"
                    && w.name == workspace_name
                    && crate::projects::canonical_key(Path::new(&w.repo_path)) == key
                {
                    roots.push(PathBuf::from(w.worktree_path));
                }
            }
        }
    }
    roots
}


pub(crate) fn list_human_task_states_at(root: &Path) -> Vec<HumanTaskStateDto> {
    let cfg = crate::projects::read_config_at(root).config;
    if cfg.steps.iter().all(|s| s.human_tasks.is_empty()) {
        return Vec::new();
    }
    let conn = db().ok();
    if let Some(c) = &conn {
        let _ = ensure_human_task_checks_table(c);
    }
    let key = root.to_string_lossy().into_owned();
    let manual = conn
        .as_ref()
        .map(|c| manual_checks_at(c, &key))
        .unwrap_or_default();
    let mut out = Vec::new();
    for step in &cfg.steps {
        for h in &step.human_tasks {
            let detected = human_detection_roots(conn.as_ref(), root, &step.workspace_name)
                .iter()
                .any(|r| human_target_hit(r, &h.target));
            // 手动优先（v3.89）：显式取消（checked=0）时**检测命中也不算完成**——
            // 否则落点里有文件就会自动勾回来，用户取消不掉（实测 bug）
            let manual_state = manual.get(&(step.name.clone(), h.title.clone())).copied();
            out.push(HumanTaskStateDto {
                step: step.name.clone(),
                title: h.title.clone(),
                guidance: h.guidance.clone(),
                target: h.target.clone(),
                timing: h.timing.clone(),
                optional: h.optional,
                detected,
                manual: manual_state == Some(true),
                done: match manual_state {
                    Some(v) => v,
                    None => detected,
                },
            });
        }
    }
    out
}

#[tauri::command]
pub async fn list_human_task_states(project_root: String) -> Result<Vec<HumanTaskStateDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        let root = fs::canonicalize(&root).map_err(|e| format!("项目目录无效: {e}"))?;
        // list 口径同 list_task_cards：非项目（无档案卡）返回空表，不设门槛
        Ok(list_human_task_states_at(&root))
    })
    .await
    .map_err(|e| format!("读取人工事项状态失败: {e}"))?
}

#[tauri::command]
pub async fn set_human_task_check(
    project_root: String,
    step: String,
    title: String,
    checked: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
                &project_root,
            )))?;
        let conn = db()?;
        ensure_human_task_checks_table(&conn)?;
        let key = root.to_string_lossy().into_owned();
        if checked {
            conn.execute(
                "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
                 VALUES(?1, ?2, ?3, ?4, 1)",
                params![key, step, title, crate::sessions::now_iso()],
            )
            .map_err(|e| format!("勾选人工事项失败: {e}"))?;
        } else {
            // 取消勾选 = 落 checked=0（显式取消），不再删行——删行会回落检测口径，
            // 落点里有文件时立刻自动勾回来，用户取消不掉（v3.89 修）
            conn.execute(
                "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
                 VALUES(?1, ?2, ?3, ?4, 0)",
                params![key, step, title, crate::sessions::now_iso()],
            )
            .map_err(|e| format!("取消勾选失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("更新人工事项勾选失败: {e}"))?
}

// ===== 人工交付导入：选中的外部文件复制进落点目录 + 登记提货单 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDeliverableDto {
    /// 复制后的绝对路径
    pub dest_path: String,
    /// 相对落点根（项目根或工作树根），正斜杠
    pub dest_rel: String,
    /// 落点根（工作树根优先，无活跃工作区 = 项目根）
    pub dest_root: String,
    /// 提货单登记是否成功（文件已复制；失败原因在 register_error）
    pub registered: bool,
    pub register_error: Option<String>,
}

/// target → 目标目录与文件名策略：目录/通配 = 目录取静态前缀、文件名用源文件 basename；
/// 精确文件 = 按 target 原样落（允许改名交付）
fn dest_for_target(root: &Path, target: &str, source: &Path) -> Result<PathBuf, String> {
    let rel = target.trim();
    if rel.is_empty() {
        return Err("该事项没有落点路径，无法登记交付".into());
    }
    let is_dir_entry = rel.ends_with('/') || rel.ends_with('\\');
    let rel = rel.trim_end_matches(['/', '\\']);
    if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
        return Err(format!("落点路径不安全: {target}"));
    }
    let base = source
        .file_name()
        .ok_or("源文件没有文件名")?;
    if is_dir_entry {
        return Ok(root.join(rel).join(base));
    }
    if rel.contains('*') {
        let (dir, _) = rel.rsplit_once('/').unwrap_or(("", rel));
        if dir.contains('*') {
            return Err(format!("落点通配只允许出现在最后一段: {target}"));
        }
        return Ok(if dir.is_empty() {
            root.join(base)
        } else {
            root.join(dir).join(base)
        });
    }
    Ok(root.join(rel))
}

#[tauri::command]
pub async fn import_human_deliverable(
    project_root: String,
    step: Option<String>,
    title: Option<String>,
    source_path: String,
    // 落点覆盖（papers/imports/ 检索结果导入专用）：给定时不再取人工事项声明的落点
    target_override: Option<String>,
) -> Result<ImportDeliverableDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
                &project_root,
            )))?;
        let cfg = crate::projects::read_config_at(&root).config;
        let step_cfg = match &step {
            Some(name) => Some(
                cfg.steps
                    .iter()
                    .find(|s| &s.name == name)
                    .ok_or_else(|| format!("步骤不存在: {name}"))?,
            ),
            None => None,
        };
        let target = match &target_override {
            Some(t) => t.clone(),
            None => {
                let sc = step_cfg.ok_or("缺少步骤参数")?;
                let t = title.as_deref().ok_or("缺少人工事项参数")?;
                sc.human_tasks
                    .iter()
                    .find(|h| h.title == t)
                    .ok_or_else(|| format!("人工事项不存在: {t}"))?
                    .target
                    .clone()
            }
        };
        let source = PathBuf::from(crate::sessions::expand_tilde(&source_path));
        let source =
            fs::canonicalize(&source).map_err(|e| format!("源文件不存在或不可读: {e}"))?;
        if !source.is_file() {
            return Err("源路径不是文件".into());
        }
        // 落点根：人工事项语境（带步骤）= 步骤绑定的活跃工作区优先（agent 在工作树里干活），
        // 否则项目根；纯导入（无步骤，资源面板入口）一律落项目根
        let conn = db().ok();
        let dest_root = match step_cfg {
            Some(sc) => human_detection_roots(conn.as_ref(), &root, &sc.workspace_name)
                .into_iter()
                .last()
                .unwrap_or_else(|| root.clone()),
            None => root.clone(),
        };
        let dest = dest_for_target(&dest_root, &target, &source)?;
        if dest.exists() {
            return Err(format!("落点已存在同名文件: {}", dest.display()));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建落点目录失败: {e}"))?;
        }
        fs::copy(&source, &dest).map_err(|e| format!("复制文件失败: {e}"))?;
        // 登记提货单（best-effort：文件已落位，检测口径已算完成；登记失败只回告不否决）；
        // 纯导入（无人工事项语境）不登记提货单
        let (registered, register_error) = match &title {
            Some(t) => match register_artifact_impl(&dest_root, t, &dest, "人工交付") {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e)),
            },
            None => (false, None),
        };
        let dest_rel = dest
            .strip_prefix(&dest_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        Ok(ImportDeliverableDto {
            dest_path: dest.to_string_lossy().into_owned(),
            dest_rel,
            dest_root: dest_root.to_string_lossy().into_owned(),
            registered,
            register_error,
        })
    })
    .await
    .map_err(|e| format!("导入人工交付失败: {e}"))?
}

// ===== agent 人工请求（HELP-WANTED.md 约定文件） =====
// agent 只会写文件，Ccode 负责看见：工作树/主仓 .ccode/help-wanted.md 里每行
// 「- 」开头是一条请求，约定每条自带兜底句「若未回复则按 … 继续」（非阻断）。
// 扫描范围：活跃工作区的工作树 + 其主仓根（聊想法在主仓进行）；无工作区的项目不扫。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpRequestDto {
    /// 来源根（工作树根或主仓根）
    pub root: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub repo_name: String,
    /// 请求条目（已去「- 」前缀，上限 20 条 × 300 字符）
    pub items: Vec<String>,
}

pub(crate) const HELP_WANTED_FILE: &str = ".ccode/help-wanted.md";

fn parse_help_wanted(text: &str) -> Vec<String> {
    text.chars()
        .take(32 * 1024)
        .collect::<String>()
        .lines()
        .filter_map(|l| {
            let t = l.trim();
            let item = t
                .strip_prefix("- ")
                .or_else(|| t.strip_prefix("* "))
                .unwrap_or(t);
            let item = item.trim();
            // 跳过标题/空行/分隔线，只收实质条目
            if item.is_empty() || item.starts_with('#') || item.starts_with("---") {
                return None;
            }
            Some(item.chars().take(300).collect())
        })
        .take(20)
        .collect()
}

#[tauri::command]
pub async fn list_help_requests() -> Vec<HelpRequestDto> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        let Ok(conn) = db() else {
            return out;
        };
        let Ok(rows) = query_workspaces(&conn) else {
            return out;
        };
        let mut seen_roots = std::collections::HashSet::new();
        for w in rows.into_iter().filter(|w| w.status == "active") {
            // 工作树 + 主仓根各算一个来源（主仓可能覆盖多个工作区，去重）
            for (root, ws_id, ws_name) in [
                (w.worktree_path.clone(), Some(w.id.clone()), Some(w.name.clone())),
                (w.repo_path.clone(), None, None),
            ] {
                if !seen_roots.insert(root.clone()) {
                    continue;
                }
                let file = Path::new(&root).join(HELP_WANTED_FILE);
                let Ok(text) = fs::read_to_string(&file) else {
                    continue;
                };
                let items = parse_help_wanted(&text);
                if items.is_empty() {
                    continue;
                }
                out.push(HelpRequestDto {
                    root,
                    workspace_id: ws_id,
                    workspace_name: ws_name,
                    repo_name: w.repo_name.clone(),
                    items,
                });
            }
        }
        out
    })
    .await
    .unwrap_or_default()
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
        let ensure_idle = |worktree_path: &str| {
            let active = manager.active_workspace_tasks(worktree_path);
            if active.is_empty() {
                Ok(())
            } else {
                Err(format!(
                    "工作区仍有 {} 个 agent/run 脚本在运行，请先停止或关闭对应终端标签",
                    active.len()
                ))
            }
        };
        if archive {
            ensure_idle(&w.worktree_path)?; // 快速预检；归档内部在移除 worktree 前还会复查
        }
            let out = merge_impl_with_guard(&conn, &id, archive, &ensure_idle)?;
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
pub async fn path_context(path: String) -> Result<PathContextDto, String> {
    tauri::async_runtime::spawn_blocking(move || path_context_impl(&db()?, &path))
        .await
        .map_err(|e| e.to_string())?
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
    let worktree = Path::new(&w.worktree_path);
    for path in files {
        let src = Path::new(&w.repo_path).join(&path);
        if src.is_file() && !worktree.join(&path).exists() {
            safe_copy_into_worktree(worktree, &path, &src)
                .map_err(|e| format!("重新挂载时复制失败: {e}"))?;
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
    // 干净并入会产生 merge commit，同样要绕过用户全局 commit.gpgsign
    match run_git(
        wt,
        &["-c", "commit.gpgsign=false", "merge", base_branch],
        Duration::from_secs(60),
    ) {
        Ok(out) => Ok(format!(
            "已把 {} 并入当前任务分支：\n{}",
            base_branch,
            if out.trim().is_empty() { "已是最新" } else { out.trim() }
        )),
        Err(e) => {
            // 只有真的进入 MERGING 才是冲突；其余失败（引用不存在、钩子失败等）如实透出，
            // 不能一律谎报「并入产生冲突」误导用户去解决不存在的冲突
            let merging = run_git(
                wt,
                &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
                Duration::from_secs(10),
            )
            .is_ok();
            if !merging {
                return Err(format!(
                    "并入 {base_branch} 失败（非冲突），工作区未留下合并现场：\n{e}"
                ));
            }
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
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = run_cmd_full(cmd, Duration::from_secs(30))?;
    if out.timed_out {
        return Err("操作超时".into());
    }
    if out.success {
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
        // checkout 失败只在「选定侧已删除」的删/改冲突下才该落到 git rm；先用 ls-files -u
        // 确认该路径确为未合并、另一侧内容还在且选定侧 stage 缺失，避免其他原因
        //（索引损坏、路径异常等）导致 checkout 失败时把文件误删
        let chosen_stage = if side == "ours" { "2" } else { "3" };
        let other_stage = if side == "ours" { "3" } else { "2" };
        let unmerged = run_git(wt, &["ls-files", "-u", "--", path], Duration::from_secs(10))?;
        let stages: Vec<&str> = unmerged
            .lines()
            .filter_map(|line| line.split('\t').next())
            .filter_map(|meta| meta.split_whitespace().nth(2))
            .collect();
        let is_delete_side = !stages.is_empty()
            && !stages.contains(&chosen_stage)
            && stages.contains(&other_stage);
        if !is_delete_side {
            return Err(format!(
                "无法解决 {path}：该文件的冲突形态不是「选定侧已删除」，请检查冲突状态"
            ));
        }
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
    // 与 merge 路径一致：应用内自动提交绕过用户全局 commit.gpgsign
    run_git(
        wt,
        &["-c", "commit.gpgsign=false", "commit", "--no-edit"],
        Duration::from_secs(60),
    )?;
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
    pub last_active: Option<String>,
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

fn sort_recent_repos(repos: &mut [RepoDto]) {
    repos.sort_by(|a, b| {
        b.last_active
            .cmp(&a.last_active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
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
        // 会话路径统一走了 canonicalize（Windows 上带 \\?\ 前缀），home 必须同口径
        // 才能比中，否则 home 排除在 Windows 上静默失效（诊断包实测 home 仍被探测）
        let home = dirs::home_dir().map(|h| std::fs::canonicalize(&h).unwrap_or(h));
        let ws_root = workspaces_root().unwrap_or_default();
        let mut activity = std::collections::HashMap::<PathBuf, Option<String>>::new();
        for session in crate::sessions::cached_scan().sessions {
            let Ok(path) = std::fs::canonicalize(&session.project_path) else {
                continue;
            };
            if !path.is_dir() || Some(path.clone()) == home || path.starts_with(&ws_root) {
                continue;
            }
            let updated = session.updated_at;
            activity
                .entry(path)
                .and_modify(|current| {
                    if updated.as_deref() > current.as_deref() {
                        current.clone_from(&updated);
                    }
                })
                .or_insert(updated);
        }
        let mut repos: Vec<RepoDto> = activity
            .into_iter()
            .filter(|(path, _)| {
                run_git(path, &["rev-parse", "--git-dir"], Duration::from_secs(5)).is_ok()
            })
            .map(|(path, last_active)| RepoDto {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "repo".into()),
                path: path.to_string_lossy().into_owned(),
                last_active,
            })
            .collect();
        sort_recent_repos(&mut repos);
        // 时间戳取扫描完成后，TTL 从最新数据起算
        if let Ok(mut guard) = repo_cache().lock() {
            *guard = Some((Instant::now(), repos.clone()));
        }
        repos
    })
    .await
    .unwrap_or_default()
}

// ===== 提货单 artifacts.yaml（§11.3 机制五，P3 v1 务实版） =====
// 大产物（数据/图/PDF）不进 git，只有本清单随分支提交传递；下一步工作区凭清单按路径直读产物。
// Cargo.toml 未引入 serde_yaml（约定不加新依赖），清单采用手写简化 YAML 子集：
// 顶层一个 `artifacts:` 数组，每条目六行 `key: "value"`（双引号字符串，反斜杠转义），
// 解析/渲染只认该子集；其余顶层内容（注释、未知键）在读写往返中原样保留。

const ARTIFACTS_FILE: &str = "artifacts.yaml";
/// 清单头注释；解析时剔除本行，避免每次重写都再叠一份
const MANIFEST_HEADER: &str = "# Ccode 提货单：大产物不进 git，本清单随分支提交传递给下一步";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryDto {
    pub name: String,
    /// 绝对路径（canonicalize 后）
    pub path: String,
    /// md5 hex
    pub hash: String,
    pub size: u64,
    /// 产出工作区名
    pub produced_by: String,
    pub created_at: String,
}

/// 简化 YAML 字符串转义：只处理引号/反斜杠，换行折叠为空格（路径与名称不应含换行）
fn yaml_escape(value: &str) -> String {
    value
        .replace(['\n', '\r'], " ")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// 解析双引号字符串值；未加引号的值原样返回（防御式，容忍手写清单）
fn yaml_unescape(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        v.to_string()
    }
}

/// 拆分为（保留行， 条目）：`artifacts:` 块外的顶层内容原样保留（头注释行除外）；
/// 块内无法识别的行直接跳过（格式随版本漂移时不拖垮整个清单）。
fn parse_manifest(text: &str) -> (Vec<String>, Vec<ArtifactEntryDto>) {
    let mut preserved = Vec::new();
    let mut entries = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        if !in_block {
            if line.trim() == "artifacts:" {
                in_block = true;
            } else if line.trim_end() != MANIFEST_HEADER {
                preserved.push(line.to_string());
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue; // 块内空行/注释不保留
        }
        // 无缩进的非块内容 = 块结束，回到顶层保留
        if !line.starts_with(char::is_whitespace) {
            in_block = false;
            preserved.push(line.to_string());
            continue;
        }
        let content = trimmed.strip_prefix("- ").unwrap_or_else(|| {
            // 纯 `-` 行视为新空条目
            if trimmed == "-" {
                ""
            } else {
                trimmed
            }
        });
        let is_new = trimmed.starts_with('-');
        if is_new {
            entries.push(ArtifactEntryDto {
                name: String::new(),
                path: String::new(),
                hash: String::new(),
                size: 0,
                produced_by: String::new(),
                created_at: String::new(),
            });
        }
        let Some(entry) = entries.last_mut() else { continue };
        let Some((key, value)) = content.split_once(':') else {
            continue;
        };
        match key.trim() {
            "name" => entry.name = yaml_unescape(value),
            "path" => entry.path = yaml_unescape(value),
            "hash" => entry.hash = yaml_unescape(value),
            "size" => entry.size = value.trim().parse().unwrap_or(0),
            "produced_by" => entry.produced_by = yaml_unescape(value),
            "created_at" => entry.created_at = yaml_unescape(value),
            _ => {} // 未知字段跳过
        }
    }
    // 损坏文件的防御：缺路径或名字的条目没有意义，剔除
    entries.retain(|e| !e.path.is_empty() && !e.name.is_empty());
    (preserved, entries)
}

fn render_manifest(preserved: &[String], entries: &[ArtifactEntryDto]) -> String {
    let mut out = String::new();
    out.push_str(MANIFEST_HEADER);
    out.push_str("\nartifacts:\n");
    for e in entries {
        out.push_str(&format!("  - name: \"{}\"\n", yaml_escape(&e.name)));
        out.push_str(&format!("    path: \"{}\"\n", yaml_escape(&e.path)));
        out.push_str(&format!("    hash: \"{}\"\n", yaml_escape(&e.hash)));
        out.push_str(&format!("    size: {}\n", e.size));
        out.push_str(&format!(
            "    produced_by: \"{}\"\n",
            yaml_escape(&e.produced_by)
        ));
        out.push_str(&format!(
            "    created_at: \"{}\"\n",
            yaml_escape(&e.created_at)
        ));
    }
    for line in preserved {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 流式 md5 + 大小：产物可能很大（数据/图/PDF），不整文件读入内存
fn file_md5_and_size(path: &Path) -> Result<(String, u64), String> {
    use std::io::Read;
    let mut file =
        fs::File::open(path).map_err(|e| format!("读取产物失败 {}: {e}", path.display()))?;
    let mut ctx = md5::Context::new();
    let mut buf = [0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取产物失败 {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        ctx.consume(&buf[..n]);
        size += n as u64;
    }
    Ok((format!("{:x}", ctx.compute()), size))
}

/// 已被 git 跟踪的文件随分支走，不需要提货单；登记它会误导下一步，直接拒绝。
/// 工作区外的路径谈不上被本仓库跟踪，git 不可用/非仓库时放行（防御式，不阻断登记）。
fn ensure_artifact_not_tracked(worktree: &Path, artifact: &Path) -> Result<(), String> {
    // artifact 已 canonicalize，worktree 同步 canonicalize 再比前缀（/var→/private/var 这类符号链接）
    let worktree = fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    let Ok(rel) = artifact.strip_prefix(&worktree) else {
        return Ok(());
    };
    if run_git(
        &worktree,
        &["ls-files", "--error-unmatch", "--", &rel.to_string_lossy()],
        Duration::from_secs(10),
    )
    .is_ok()
    {
        return Err(format!(
            "产物 {} 已被 git 跟踪，随分支提交即可，无需登记提货单",
            artifact.display()
        ));
    }
    Ok(())
}

fn register_artifact_impl(
    worktree: &Path,
    name: &str,
    artifact: &Path,
    produced_by: &str,
) -> Result<ArtifactEntryDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("产物名称不能为空".into());
    }
    // canonicalize 同时完成存在性校验与绝对路径化
    let artifact = fs::canonicalize(artifact)
        .map_err(|e| format!("产物文件不存在或不可读 {}: {e}", artifact.display()))?;
    if !artifact.is_file() {
        return Err(format!("产物路径不是文件: {}", artifact.display()));
    }
    ensure_artifact_not_tracked(worktree, &artifact)?;
    let (hash, size) = file_md5_and_size(&artifact)?;
    let entry = ArtifactEntryDto {
        name: name.to_string(),
        path: artifact.to_string_lossy().into_owned(),
        hash,
        size,
        produced_by: produced_by.to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
    };
    // 读-改-原子写：损坏文件按防御式解析后的结果继续，不清空用户手改的其他内容
    let manifest = worktree.join(ARTIFACTS_FILE);
    let existing = fs::read_to_string(&manifest).unwrap_or_default();
    let (preserved, mut entries) = parse_manifest(&existing);
    // 同路径重复登记 = 更新（内容/hash/时间都可能变），不产生重复条目
    match entries.iter_mut().find(|e| e.path == entry.path) {
        Some(slot) => *slot = entry.clone(),
        None => entries.push(entry.clone()),
    }
    crate::profiles::atomic_write(&manifest, &render_manifest(&preserved, &entries))?;
    Ok(entry)
}

/// 读项目根（或工作区根）的清单；缺失返回空，解析全程防御式容错
/// （pub(crate)：PDF 白名单 artifact_paths_at 与清单命令共用这份解析）
pub(crate) fn read_artifacts_manifest_impl(root: &Path) -> Vec<ArtifactEntryDto> {
    let Ok(text) = fs::read_to_string(root.join(ARTIFACTS_FILE)) else {
        return Vec::new();
    };
    parse_manifest(&text).1
}

/// P4 PDF 白名单用（pdf.rs）：某根目录 artifacts.yaml 中登记产物的绝对路径。
/// 登记产物可位于根之外（如 quarto 渲染产物入产物目录），pdf.rs 按条目精确路径放行。
pub(crate) fn artifact_paths_at(root: &Path) -> Vec<PathBuf> {
    read_artifacts_manifest_impl(root)
        .into_iter()
        .map(|e| PathBuf::from(e.path))
        .collect()
}

#[tauri::command]
pub async fn register_artifact(
    worktree_path: String,
    name: String,
    artifact_path: String,
) -> Result<ArtifactEntryDto, String> {
    let worktree = PathBuf::from(&worktree_path);
    // produced_by 取注册工作区名；查不到（普通仓库面板）回落目录名
    let produced_by = db()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT name FROM workspaces WHERE worktree_path = ?1 AND status != 'archived'",
                params![&worktree_path],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .unwrap_or_else(|| {
            worktree
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| worktree_path.clone())
        });
    register_artifact_impl(&worktree, &name, Path::new(&artifact_path), &produced_by)
}

#[tauri::command]
pub async fn read_artifacts_manifest(repo_path: String) -> Result<Vec<ArtifactEntryDto>, String> {
    Ok(read_artifacts_manifest_impl(Path::new(&repo_path)))
}

#[cfg(test)]
mod tests {

    use super::*;

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

    fn sh(dir: &Path, args: &[&str]) {
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

    /// 带 origin（裸仓库）+ origin/HEAD 的测试仓库，repo 根下放两个 files-to-copy 文件
    fn setup_repo(dir: &Path) -> PathBuf {
        let origin = dir.join("origin.git");
        let repo = dir.join("myrepo");
        Command::new(git_bin())
            .args(["init", "--bare"])
            .arg(&origin)
            .output()
            .unwrap();
        Command::new(git_bin())
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

    // ===== 上游漂移提醒（stale_upstream_for 纯逻辑） =====

    fn ws_named(name: &str, created_at: &str, merged_at: Option<&str>) -> WorkspaceDto {
        WorkspaceDto {
            id: name.into(),
            repo_path: "/r".into(),
            repo_name: "r".into(),
            name: name.into(),
            branch: format!("ccode/{name}"),
            worktree_path: format!("/wt/{name}"),
            base_branch: "main".into(),
            port_base: 0,
            status: "active".into(),
            created_at: created_at.into(),
            archived_at: None,
            merged_at: merged_at.map(String::from),
            stale_upstream: None,
            setup_result: None,
        }
    }

    fn step(name: &str, workspace_name: &str) -> crate::projects::StepDto {
        crate::projects::StepDto {
            name: name.into(),
            workspace_name: workspace_name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn stale_upstream_rules() {
        let steps = vec![step("查文献", "lit"), step("做分析", "ana"), step("写论文", "write")];
        // 无上游：第一步永不标
        let ws = vec![
            ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-02T00:00:00Z")),
            ws_named("ana", "2026-08-03T00:00:00Z", None),
        ];
        assert_eq!(stale_upstream_for(&steps, &ws, 0), None);
        // 上游合并早于本步推进（本步未合并，推进时间=创建时间）：新鲜
        assert_eq!(stale_upstream_for(&steps, &ws, 1), None);
        // 上游晚于本步创建发生合并 → 标出上游步骤名
        let ws = vec![
            ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-05T00:00:00Z")),
            ws_named("ana", "2026-08-03T00:00:00Z", None),
        ];
        assert_eq!(stale_upstream_for(&steps, &ws, 1).as_deref(), Some("查文献"));
        // 本步之后重新合并（merged_at 晚于上游合并）→ 恢复新鲜
        let ws = vec![
            ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-05T00:00:00Z")),
            ws_named("ana", "2026-08-03T00:00:00Z", Some("2026-08-06T00:00:00Z")),
        ];
        assert_eq!(stale_upstream_for(&steps, &ws, 1), None);
        // 多个上游时标最晚合并的那个；未合并/未建工作区的上游不参与
        let ws = vec![
            ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-04T00:00:00Z")),
            ws_named("ana", "2026-08-01T00:00:00Z", Some("2026-08-05T00:00:00Z")),
            ws_named("write", "2026-08-03T00:00:00Z", None),
        ];
        assert_eq!(stale_upstream_for(&steps, &ws, 2).as_deref(), Some("做分析"));
        // 本步尚未创建工作区 / 步骤未绑定工作区名 → 不标
        assert_eq!(stale_upstream_for(&steps, &ws[..2], 2), None);
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
                last_active: None,
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
    fn recent_repos_sort_by_latest_activity_then_name() {
        let mut repos = vec![
            RepoDto {
                path: "/older".into(),
                name: "zeta".into(),
                last_active: Some("2026-08-01T00:00:00Z".into()),
            },
            RepoDto {
                path: "/newer-b".into(),
                name: "Beta".into(),
                last_active: Some("2026-08-04T00:00:00Z".into()),
            },
            RepoDto {
                path: "/newer-a".into(),
                name: "alpha".into(),
                last_active: Some("2026-08-04T00:00:00Z".into()),
            },
        ];
        sort_recent_repos(&mut repos);
        assert_eq!(
            repos.iter().map(|repo| repo.path.as_str()).collect::<Vec<_>>(),
            vec!["/newer-a", "/newer-b", "/older"]
        );
    }

    #[test]
    fn create_workspace_invalidates_repo_cache() {
        let Some(fx) = Fixture::new() else { return };
        *repo_cache().lock().unwrap() = Some((
            Instant::now(),
            vec![RepoDto {
                path: "/r".into(),
                name: "r".into(),
                last_active: None,
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

    /// git init 后的空仓库（unborn HEAD）：创建流程自动补空初始提交，
    /// 分支名尊重 init.defaultBranch（master 形态），且临时身份不写入本地 config
    #[test]
    fn create_on_unborn_repo_bootstraps_initial_commit() {
        let Some(fx) = Fixture::new() else { return };
        let repo = fx.dir.join("empty-master");
        Command::new(git_bin())
            .args(["-c", "init.defaultBranch=master", "init"])
            .arg(&repo)
            .output()
            .unwrap();
        let w = create_impl(&fx.conn, &fx.ws_root, repo.to_str().unwrap(), "first").unwrap();
        assert_eq!(w.base_branch, "master");
        assert_eq!(w.branch, "ccode/first");
        assert_eq!(w.status, "active");
        assert!(Path::new(&w.worktree_path).exists());
        // 初始提交落在 master 上，HEAD 不再是 unborn
        assert_eq!(
            run_git(
                &repo,
                &["rev-parse", "--abbrev-ref", "HEAD"],
                Duration::from_secs(10)
            )
            .unwrap(),
            "master"
        );
        let subject = run_git(
            &repo,
            &["log", "--format=%s", "-1", "master"],
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(subject.contains("初始化空仓库"), "{subject}");
        // 临时身份只注入本次提交，不得写入仓库本地 config
        assert!(
            run_git(
                &repo,
                &["config", "--local", "--get", "user.name"],
                Duration::from_secs(10)
            )
            .is_err(),
            "不得向本地 config 写 user.name"
        );
        assert!(
            run_git(
                &repo,
                &["config", "--local", "--get", "user.email"],
                Duration::from_secs(10)
            )
            .is_err(),
            "不得向本地 config 写 user.email"
        );
        // 补偿事务完整：同一仓库再起第二个工作区，端口段顺延
        let w2 = create_impl(&fx.conn, &fx.ws_root, repo.to_str().unwrap(), "second").unwrap();
        assert_eq!(w2.port_base, w.port_base + 10);
    }

    /// 空仓库已配置 user.name/email 时，初始提交沿用该身份，不注入 Ccode 临时身份
    #[test]
    fn create_on_unborn_repo_uses_configured_identity() {
        let Some(fx) = Fixture::new() else { return };
        let repo = fx.dir.join("empty-main");
        Command::new(git_bin())
            .args(["-c", "init.defaultBranch=main", "init"])
            .arg(&repo)
            .output()
            .unwrap();
        sh(&repo, &["config", "user.name", "Config User"]);
        sh(&repo, &["config", "user.email", "config@example.com"]);
        let w = create_impl(&fx.conn, &fx.ws_root, repo.to_str().unwrap(), "task").unwrap();
        assert_eq!(w.base_branch, "main");
        let author = run_git(
            &repo,
            &["log", "--format=%an <%ae>", "-1"],
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(author, "Config User <config@example.com>");
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

    #[cfg(unix)]
    #[test]
    fn create_refuses_symlink_escape_in_copy_dest_parent() {
        let Some(fx) = Fixture::new() else { return };
        // 仓库跟踪一个指向树外的符号链接，files_to_copy 引用链接内路径：
        // 复制若不检查会跟随符号链接把文件覆写到 worktree 外
        let outside = fx.dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("payload.env"), "ORIGINAL\n").unwrap();
        std::os::unix::fs::symlink(&outside, fx.repo.join("linked")).unwrap();
        sh(&fx.repo, &["add", "linked"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "add symlink"],
        );
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/settings.toml"),
            "files_to_copy = [\"linked/payload.env\"]\n",
        )
        .unwrap();
        let err = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "symlnk").unwrap_err();
        assert!(err.contains("符号链接"), "{err}");
        assert!(err.contains("已回滚"), "{err}");
        // 树外文件未被覆写，创建已整体回滚
        assert_eq!(
            fs::read_to_string(outside.join("payload.env")).unwrap(),
            "ORIGINAL\n"
        );
        assert!(query_workspaces(&fx.conn).unwrap().is_empty());
        assert!(!fx.ws_root.join("myrepo/symlnk").exists());
    }

    #[cfg(unix)]
    #[test]
    fn create_refuses_symlink_at_copy_dest_itself() {
        let Some(fx) = Fixture::new() else { return };
        // files_to_copy 的目标自身是仓库跟踪的符号链接（指向树外文件）
        let outside = fx.dir.join("outside-dst");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("target.env"), "ORIGINAL\n").unwrap();
        fs::remove_file(fx.repo.join(".env")).unwrap(); // fixture 预置的实体文件让位给符号链接
        std::os::unix::fs::symlink(outside.join("target.env"), fx.repo.join(".env")).unwrap();
        sh(&fx.repo, &["add", ".env"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env as symlink"],
        );
        let err = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "dstsym").unwrap_err();
        assert!(err.contains("符号链接"), "{err}");
        assert_eq!(
            fs::read_to_string(outside.join("target.env")).unwrap(),
            "ORIGINAL\n"
        );
        assert!(query_workspaces(&fx.conn).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn create_via_symlinked_repo_path_stores_canonical_repo_path() {
        let Some(fx) = Fixture::new() else { return };
        // 经符号链接路径创建工作区：落库的 repo_path 必须解析为 canonical 形式
        // （与 register_project 的 canonical_key 同口径），否则前端按路径字符串
        // 归组时工作区会掉出项目分组（macOS /var→/private/var 同理）
        let link = fx.dir.join("repo-link");
        std::os::unix::fs::symlink(&fx.repo, &link).unwrap();
        let w = create_impl(&fx.conn, &fx.ws_root, link.to_str().unwrap(), "canon").unwrap();
        let canonical = fs::canonicalize(&fx.repo).unwrap();
        assert_eq!(w.repo_path, canonical.to_string_lossy().as_ref());
        assert_ne!(w.repo_path, link.to_string_lossy().as_ref());
        // worktree 目录按 canonical 路径末段派生
        assert_eq!(w.repo_name, "myrepo");
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
        // 归档后不再占用端口段，不下发端口 env
        archive_impl(&fx.conn, &w.id).unwrap();
        assert!(
            workspace_env_impl(&fx.conn, &w.worktree_path).is_empty(),
            "归档工作区不得再返回端口 env"
        );
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
        Command::new(git_bin())
            .args(["init", "--bare"])
            .arg(&origin)
            .output()
            .unwrap();
        Command::new(git_bin())
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

    #[cfg(unix)]
    #[test]
    fn health_marks_stale_base_when_base_advanced_during_conflict() {
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
        fs::write(fx.repo.join("feature.txt"), "main v1\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线 v1"],
        );
        // 未在 merge 中：stale_base 恒 false
        assert!(!health_impl(&fx.conn, &w.id).unwrap().stale_base);
        // 开始并入 → 冲突，MERGE_HEAD = 当前基准 tip
        assert!(
            run_git(&wt, &["merge", "main"], Duration::from_secs(60)).is_err(),
            "应产生冲突"
        );
        assert!(
            !health_impl(&fx.conn, &w.id).unwrap().stale_base,
            "MERGE_HEAD 与基准 tip 一致不算落后"
        );
        // 基准继续前进 → 冲突现场落后
        fs::write(fx.repo.join("other.txt"), "v2\n").unwrap();
        sh(&fx.repo, &["add", "other.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线 v2"],
        );
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert!(h.stale_base, "基准已前进：MERGE_HEAD ≠ tip 应标记 stale_base");
    }

    #[cfg(unix)]
    #[test]
    fn pending_artifact_checks_reports_only_fresh_and_complete() {
        let Some(fx) = Fixture::new() else { return };
        // 步骤绑定工作区 art，预期产物 = 一个文件 + 一个目录
        fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
        fs::write(
            fx.repo.join(".ccode/project.toml"),
            "[[steps]]\nname = \"出图\"\nworkspace_name = \"art\"\nexpected_artifacts = [\"out/result.txt\", \"figs/\"]\n",
        )
        .unwrap();
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "art").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        // 未产出 → 不报
        assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
        // 只产出一半（目录产物还缺）→ 不报
        fs::create_dir_all(wt.join("out")).unwrap();
        fs::write(wt.join("out/result.txt"), "new\n").unwrap();
        assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
        // 目录产物补一个文件 → 全部备齐 → 报
        fs::create_dir_all(wt.join("figs")).unwrap();
        fs::write(wt.join("figs/a.png"), b"png").unwrap();
        let hits = pending_artifact_checks_impl(&fx.conn);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].workspace_id, w.id);
        // 产物 mtime 早于工作区创建 → 不算本任务产出（防 files-to-copy/旧文件误报）
        let f = fs::File::options()
            .write(true)
            .open(wt.join("out/result.txt"))
            .unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(3600))
            .unwrap();
        assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
        // 无绑定步骤的工作区永不报
        let _plain =
            create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "plain2").unwrap();
        assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
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
        // Windows 上 checkout 落盘为 CRLF，断言归一化
        assert_eq!(
            fs::read_to_string(fx.repo.join("feature.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
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
        // Windows 上 checkout 落盘为 CRLF，断言归一化
        assert_eq!(
            fs::read_to_string(fx.repo.join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
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

    /// 打开 commit.gpgsign 且 gpg 程序不存在：应用内自动 merge/commit 必须仍能完成
    #[test]
    fn auto_merge_and_commit_bypass_gpgsign_config() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        // 配置共享给所有 worktree：不带 -c commit.gpgsign=false 的提交必失败
        sh(&fx.repo, &["config", "commit.gpgsign", "true"]);
        sh(&fx.repo, &["config", "gpg.program", "definitely-missing-gpg"]);
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "gpg").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "v1\n").unwrap();
        commit_all_in_worktree(&wt, "任务改动");
        // 主仓库推进别的文件形成分叉，sync_base 的干净并入会产生 merge commit
        fs::write(fx.repo.join("other.txt"), "main\n").unwrap();
        sh(&fx.repo, &["add", "other.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"],
        );
        sync_base_impl(&wt, "main", false).expect("干净并入应绕过 gpgsign");
        assert!(!unmerged_impl(&wt).unwrap().merging);
        // 冲突并入 → 选边 → finish_merge 的 --no-edit 提交同样绕过 gpgsign
        fs::write(wt.join("feature.txt"), "branch\n").unwrap();
        commit_all_in_worktree(&wt, "分支改动");
        fs::write(fx.repo.join("feature.txt"), "main\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线再改"],
        );
        assert!(sync_base_impl(&wt, "main", false).is_err());
        resolve_file_impl(&wt, "feature.txt", "ours").unwrap();
        finish_merge_impl(&wt).expect("完成并入的提交应绕过 gpgsign");
        // 最终 merge --no-ff 进主仓库也绕过 gpgsign
        let out = merge_impl(&fx.conn, &w.id, false).unwrap();
        assert!(out.merged, "{}", out.message);
        // Windows 上 checkout 落盘为 CRLF，断言归一化
        assert_eq!(
            fs::read_to_string(fx.repo.join("feature.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "branch\n"
        );
    }

    /// 非冲突的 merge 失败（基准引用不存在）不得谎报「并入产生冲突」
    #[test]
    fn sync_base_non_conflict_failure_reports_git_error() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "badref").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        // 复制进来的 .env* 是未跟踪文件，先提交掉让工作区干净，才能走到 merge 一步
        commit_all_in_worktree(&wt, "副本");
        let err = sync_base_impl(&wt, "no-such-branch", false).unwrap_err();
        assert!(!err.contains("并入产生冲突"), "{err}");
        assert!(err.contains("非冲突"), "{err}");
        assert!(!unmerged_impl(&wt).unwrap().merging);
    }

    /// 删/改冲突：选定「已删除」侧时 git rm 兜底必须经 ls-files -u 确认后生效
    #[test]
    fn resolve_modify_delete_conflict_picks_deleted_side() {
        let Some(fx) = Fixture::new() else { return };
        // merge-base 必须先含有 feature.txt：任务分支修改、基准分支删除才构成删/改冲突
        fs::write(fx.repo.join("feature.txt"), "base\n").unwrap();
        sh(&fx.repo, &["add", ".env", ".envrc", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
        );
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "moddel").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        // 任务分支修改 feature.txt；基准分支删除它 → 并入产生 modify/delete 冲突
        fs::write(wt.join("feature.txt"), "branch\n").unwrap();
        commit_all_in_worktree(&wt, "分支改动");
        sh(&fx.repo, &["rm", "-q", "feature.txt"]);
        sh(
            &fx.repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "主线删除"],
        );
        assert!(sync_base_impl(&wt, "main", false).is_err());
        let st = unmerged_impl(&wt).unwrap();
        assert_eq!(st.files, vec!["feature.txt".to_string()]);
        // 选定 theirs（基准侧 = 已删除）：经确认后 git rm 生效，文件从工作区移除
        let st = resolve_file_impl(&wt, "feature.txt", "theirs").unwrap();
        assert!(st.files.is_empty());
        assert!(!wt.join("feature.txt").exists());
        finish_merge_impl(&wt).unwrap();
        assert!(
            run_git(&wt, &["cat-file", "-e", "HEAD:feature.txt"], Duration::from_secs(10))
                .is_err(),
            "选定删除侧后文件不得留在提交里"
        );
    }

    // ===== 提货单 artifacts.yaml =====

    /// 注册往返：条目字段齐全、md5/大小正确，未知顶层内容读写往返原样保留
    #[test]
    fn artifact_register_roundtrip_preserves_unknown_keys() {
        let Some(fx) = Fixture::new() else { return };
        // 产物保持未跟踪（大产物不进 git）
        let data = fx.repo.join("result.csv");
        fs::write(&data, b"a,b\n1,2\n").unwrap();
        // 预置清单带未知顶层键与注释，验证保留
        fs::write(
            fx.repo.join(ARTIFACTS_FILE),
            "# 手写备注\nupstream: \"https://example.com\"\n",
        )
        .unwrap();
        let entry = register_artifact_impl(&fx.repo, "清洗结果", &data, "data-clean").unwrap();
        assert_eq!(entry.name, "清洗结果");
        assert_eq!(entry.produced_by, "data-clean");
        assert_eq!(entry.size, 8);
        assert_eq!(entry.hash, format!("{:x}", md5::compute(b"a,b\n1,2\n")));
        assert!(!entry.created_at.is_empty());
        assert!(Path::new(&entry.path).is_absolute());
        let text = fs::read_to_string(fx.repo.join(ARTIFACTS_FILE)).unwrap();
        assert!(text.contains("upstream: \"https://example.com\""), "{text}");
        assert!(text.contains("# 手写备注"), "{text}");
        assert_eq!(text.matches(MANIFEST_HEADER).count(), 1, "{text}");
        let entries = read_artifacts_manifest_impl(&fx.repo);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "清洗结果");
        assert_eq!(entries[0].path, entry.path);
        assert_eq!(entries[0].hash, entry.hash);
        // 清单缺失时返回空
        let empty_dir = fx.dir.join("no-manifest");
        fs::create_dir_all(&empty_dir).unwrap();
        assert!(read_artifacts_manifest_impl(&empty_dir).is_empty());
    }

    /// 同路径重复登记 = 更新条目而非追加；已跟踪文件拒绝登记
    #[test]
    fn artifact_register_same_path_updates_and_tracked_rejected() {
        let Some(fx) = Fixture::new() else { return };
        let data = fx.repo.join("figure.png");
        fs::write(&data, b"v1").unwrap();
        let first = register_artifact_impl(&fx.repo, "图一", &data, "plot").unwrap();
        fs::write(&data, b"v2-longer").unwrap();
        let second = register_artifact_impl(&fx.repo, "图一（修订）", &data, "plot").unwrap();
        assert_ne!(first.hash, second.hash);
        let entries = read_artifacts_manifest_impl(&fx.repo);
        assert_eq!(entries.len(), 1, "同路径不得重复登记");
        assert_eq!(entries[0].name, "图一（修订）");
        assert_eq!(entries[0].hash, second.hash);
        // 已跟踪文件随分支走，登记提货单会误导下一步
        let err = register_artifact_impl(&fx.repo, "自述", &fx.repo.join("README.md"), "ws")
            .unwrap_err();
        assert!(err.contains("跟踪"), "{err}");
        // 不存在的文件拒绝
        assert!(register_artifact_impl(&fx.repo, "缺失", &fx.repo.join("nope.bin"), "ws").is_err());
    }

    /// 损坏/手写不规范的清单：解析容错不 panic，残缺条目剔除，再登记不清空其他内容
    #[test]
    fn artifact_manifest_corrupt_is_tolerated() {
        let Some(fx) = Fixture::new() else { return };
        fs::write(
            fx.repo.join(ARTIFACTS_FILE),
            "not yaml at all: [{\nartifacts:\n  - name: \"孤儿\"\n  garbage line\n  - name: \"好条目\"\n    path: \"/tmp/ok.bin\"\n    hash: \"abc\"\n    size: not-a-number\n",
        )
        .unwrap();
        let entries = read_artifacts_manifest_impl(&fx.repo);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].name, "好条目");
        assert_eq!(entries[0].size, 0);
        // 在损坏清单上继续登记：顶层杂行保留，新条目可解析
        let data = fx.repo.join("out.parquet");
        fs::write(&data, b"parquet").unwrap();
        register_artifact_impl(&fx.repo, "数据集", &data, "etl").unwrap();
        let text = fs::read_to_string(fx.repo.join(ARTIFACTS_FILE)).unwrap();
        assert!(text.contains("not yaml at all: [{"), "{text}");
        let entries = read_artifacts_manifest_impl(&fx.repo);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert!(entries.iter().any(|e| e.name == "数据集"));
    }

    // ===== 人工事项：落点检测 / 勾选存取 / 交付导入 / HELP-WANTED 解析 =====

    #[test]
    fn wildcard_match_basics() {
        assert!(wildcard_match("*.bib", "a.bib"));
        assert!(wildcard_match("*.bib", ".bib"));
        assert!(!wildcard_match("*.bib", "a.bib.bak"));
        assert!(wildcard_match("a*", "a"));
        assert!(wildcard_match("*", "任意.txt"));
        assert!(!wildcard_match("a*", "ba"));
        assert!(wildcard_match("s*.pdf", "smith-2024.pdf"));
    }

    #[test]
    fn human_target_hit_three_forms() {
        let dir = std::env::temp_dir().join(format!("ccode-ht-{}", uuid::Uuid::new_v4()));
        let root = dir.join("proj");
        fs::create_dir_all(root.join("papers/search")).unwrap();
        // 空目录/缺文件 → 未交付
        assert!(!human_target_hit(&root, "papers/"));
        assert!(!human_target_hit(&root, "papers/*.bib"));
        assert!(!human_target_hit(&root, "papers/screening.md"));
        // 目录形态：隐藏文件不算交付
        fs::write(root.join("papers/.keep"), "x").unwrap();
        assert!(!human_target_hit(&root, "papers/"));
        fs::write(root.join("papers/search/wos.bib"), "@article{}").unwrap();
        assert!(human_target_hit(&root, "papers/"));
        assert!(human_target_hit(&root, "papers/search/"));
        // 通配只认最后一段
        assert!(human_target_hit(&root, "papers/search/*.bib"));
        assert!(!human_target_hit(&root, "papers/search/*.pdf"));
        assert!(!human_target_hit(&root, "papers/*/x.bib"), "跨段通配不支持");
        // 精确文件
        fs::write(root.join("papers/screening.md"), "s").unwrap();
        assert!(human_target_hit(&root, "papers/screening.md"));
        // 逃逸/绝对路径一律未交付
        assert!(!human_target_hit(&root, "../outside/"));
        assert!(!human_target_hit(&root, "/etc/hosts"));
        assert!(!human_target_hit(&root, ""));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_help_wanted_bullets_only() {
        let text = "# 需要人工协助\n\n- 请补充检索词 GLP-1 心血管（若未回复则按现有检索词继续）\n\n- 下载 smith 2024 全文\n---\n* 星号条目也算\n\n";
        let items = parse_help_wanted(text);
        assert_eq!(items.len(), 3, "{items:?}");
        assert!(items[0].starts_with("请补充检索词"));
        assert_eq!(items[2], "星号条目也算");
        assert_eq!(parse_help_wanted("# 只有标题\n\n"), Vec::<String>::new());
    }

    #[test]
    fn dest_for_target_forms() {
        let root = Path::new("/proj");
        let src = Path::new("/downloads/smith-2024.pdf");
        assert_eq!(
            dest_for_target(root, "papers/", src).unwrap(),
            PathBuf::from("/proj/papers/smith-2024.pdf")
        );
        assert_eq!(
            dest_for_target(root, "papers/*.pdf", src).unwrap(),
            PathBuf::from("/proj/papers/smith-2024.pdf")
        );
        // 精确文件 = 允许改名交付
        assert_eq!(
            dest_for_target(root, "papers/list.md", src).unwrap(),
            PathBuf::from("/proj/papers/list.md")
        );
        assert!(dest_for_target(root, "../x/", src).is_err());
        assert!(dest_for_target(root, "", src).is_err());
    }

    /// 显式取消后，即便落点检测命中也不得自动勾回（v3.89 实测 bug：用户「取消不了」）
    #[test]
    fn explicit_uncheck_beats_detection() {
        let dir = std::env::temp_dir().join(format!("ccode-unchk-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let conn = db_at(&dir.join("app.db")).unwrap();
        ensure_human_task_checks_table(&conn).unwrap();
        let proj = dir.join("p").to_string_lossy().into_owned();
        let key = ("检索".to_string(), "下载付费墙文献全文".to_string());

        // 勾上
        conn.execute(
            "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
             VALUES(?1,?2,?3,?4,1)",
            params![proj, key.0, key.1, "2026-08-16T00:00:00Z"],
        )
        .unwrap();
        assert_eq!(manual_checks_at(&conn, &proj).get(&key), Some(&true));

        // 取消：留痕为 false，而不是消失
        conn.execute(
            "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
             VALUES(?1,?2,?3,?4,0)",
            params![proj, key.0, key.1, "2026-08-16T00:01:00Z"],
        )
        .unwrap();
        let m = manual_checks_at(&conn, &proj);
        assert_eq!(
            m.get(&key),
            Some(&false),
            "取消必须留痕；删行会让检测命中把它自动勾回来",
        );
        // done 判定：Some(false) 一律不完成，不看 detected
        let done = match m.get(&key).copied() {
            Some(v) => v,
            None => true, // 假设检测命中
        };
        assert!(!done, "显式取消后，检测命中也不算完成");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 勾选存取（行在 = 人勾了）：upsert/delete 往返 + 项目间隔离
    #[test]
    fn human_task_checks_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ccode-htc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let conn = db_at(&dir.join("app.db")).unwrap();
        ensure_human_task_checks_table(&conn).unwrap();
        let proj = dir.join("p1").to_string_lossy().into_owned();
        conn.execute(
            "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at) VALUES(?1,?2,?3,?4)",
            params![proj, "检索", "下载全文", "2026-08-12T00:00:00Z"],
        )
        .unwrap();
        let set = manual_checks_at(&conn, &proj);
        // 旧行（无 checked 列时写入）默认视为已勾选，向后兼容
        assert_eq!(set.get(&("检索".into(), "下载全文".into())), Some(&true));
        // 其他项目隔离
        let other = dir.join("p2").to_string_lossy().into_owned();
        assert!(manual_checks_at(&conn, &other).is_empty());
        // 取消勾选 = 落 checked=0（**不删行**）：删行会回落检测口径，
        // 落点里有文件时立刻自动勾回来，用户取消不掉（v3.89 修）
        conn.execute(
            "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
             VALUES(?1,?2,?3,?4,0)",
            params![proj, "检索", "下载全文", "2026-08-12T00:00:00Z"],
        )
        .unwrap();
        assert_eq!(
            manual_checks_at(&conn, &proj).get(&("检索".into(), "下载全文".into())),
            Some(&false),
            "显式取消要留痕，不能删行",
        );
        fs::remove_dir_all(&dir).ok();
    }
}
