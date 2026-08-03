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
    pub status: String, // active | archived
    pub created_at: String,
    pub archived_at: Option<String>,
    /// 已合并进基准分支的时间（仅「合并（保留工作区）」后置位；继续提交后前端按 ahead>0 隐藏）
    pub merged_at: Option<String>,
    /// 仅创建时填充：setup 脚本的执行结果（W2）；查询路径一律 None
    pub setup_result: Option<SetupResultDto>,
}

/// 无任何设置层定义 files_to_copy 时的回落清单（W1 固定值）
pub(crate) const FILES_TO_COPY: [&str; 4] = [".env", ".env.local", ".env.development.local", ".envrc"];

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
        .filter(|w| w.status == "active")
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

fn create_impl(
    conn: &Connection,
    ws_root: &Path,
    repo_path: &str,
    name: &str,
) -> Result<WorkspaceDto, String> {
    let name = sanitize_name(name)?;
    let repo = PathBuf::from(crate::sessions::expand_tilde(repo_path));
    run_git(&repo, &["rev-parse", "--git-dir"], Duration::from_secs(10))
        .map_err(|e| format!("不是 git 仓库: {repo_path} ({e})"))?;
    let branch = format!("ccode/{name}");
    if run_git(&repo, &["rev-parse", "--verify", "--quiet", &branch], Duration::from_secs(10))
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
    // 项目级配置（三层合并）：files_to_copy 并集；没有设置层时用 W1 固定清单
    let settings = crate::ws_settings::merged_settings(&repo);
    let files = settings
        .files_to_copy
        .clone()
        .unwrap_or_else(|| FILES_TO_COPY.iter().map(|s| s.to_string()).collect());
    for f in &files {
        let src = repo.join(f);
        if src.is_file() {
            let _ = fs::copy(&src, worktree_path.join(f));
        }
    }
    let port_base = alloc_port_base(conn)?;
    // setup 脚本失败不阻断创建，结果记进 DTO 给 UI 展示
    let setup_result = settings.setup.as_ref().map(|script| {
        let (ok, output_tail) = run_hook(&worktree_path, script, port_base, Duration::from_secs(600));
        SetupResultDto { ok, output_tail }
    });
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = crate::sessions::now_iso();
    conn.execute(
        "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch,
                               port_base, status, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8)",
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
    .map_err(|e| format!("写入 workspaces 失败: {e}"))?;
    let mut dto = get_workspace(conn, &id)?;
    dto.setup_result = setup_result;
    // 新工作区会改变 list_repos 的聚合结果（worktree 路径需被排除），主动失效
    invalidate_repo_cache();
    Ok(dto)
}

fn archive_impl(conn: &Connection, id: &str) -> Result<(), String> {
    let w = get_workspace(conn, id)?;
    let wt = PathBuf::from(&w.worktree_path);
    if wt.exists() {
        // archive 脚本在移除前跑（如 docker compose down）；失败则保留 worktree 并报错给 UI
        let settings = crate::ws_settings::merged_settings(Path::new(&w.repo_path));
        if let Some(script) = &settings.archive {
            let (ok, tail) = run_hook(&wt, script, w.port_base, Duration::from_secs(300));
            if !ok {
                return Err(format!("archive 脚本执行失败，worktree 未移除:\n{tail}"));
            }
        }
        run_git(
            Path::new(&w.repo_path),
            &["worktree", "remove", "--force", &w.worktree_path],
            Duration::from_secs(60),
        )
        .map_err(|e| format!("移除 worktree 失败: {e}"))?;
    }
    // worktree 目录已不存在时跳过 git 调用直接翻状态
    conn.execute(
        "UPDATE workspaces SET status='archived', archived_at=?2 WHERE id=?1",
        params![id, crate::sessions::now_iso()],
    )
    .map_err(|e| format!("更新 workspaces 失败: {e}"))?;
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
    cmd.current_dir(dir).stdout(Stdio::piped()).stderr(Stdio::piped());
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
    let uncommitted = !run_git(&wt, &["status", "--porcelain"], Duration::from_secs(30))?.is_empty();
    let base = base_ref(&wt, &w.base_branch);
    // A...B 的左侧 = 只在 base（behind），右侧 = 只在 HEAD（ahead）
    let counts = run_git(
        &wt,
        &["rev-list", "--left-right", "--count", &format!("{base}...HEAD")],
        Duration::from_secs(30),
    )?;
    let mut parts = counts.split_whitespace();
    let behind = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let (conflict, conflict_files) = conflict_probe(&wt, &base, "HEAD");
    // 主仓库状态也是本地合并的前置条件：提前暴露，别等点了「合并」才报错
    let repo = PathBuf::from(&w.repo_path);
    let main_off_base = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"], Duration::from_secs(10))
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
        ready_to_merge: !uncommitted && conflict == Some(false) && !main_off_base && !main_dirty,
    })
}

fn merge_impl(conn: &Connection, id: &str, archive: bool) -> Result<String, String> {
    let w = get_workspace(conn, id)?;
    let repo = PathBuf::from(&w.repo_path);
    // 前置条件：主仓库必须停在基准分支且工作区干净，否则合并会搅乱用户手头的工作
    let cur = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"], Duration::from_secs(10))?;
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
    let mut log = match run_git(&repo, &["merge", "--no-ff", &w.branch], Duration::from_secs(60)) {
        Ok(out) => out,
        Err(e) => {
            // 冲突留给用户在主仓库手动解决，不自动 abort（用户可能想就地处理）
            let files = run_git(&repo, &["diff", "--name-only", "--diff-filter=U"], Duration::from_secs(10))
                .unwrap_or_default();
            return Err(format!(
                "合并发生冲突，请到主仓库手动解决（git merge --abort 可回退）:\n{e}\n冲突文件:\n{files}"
            ));
        }
    };
    if archive {
        // 合并成功后走标准归档生命周期（archive 钩子 + worktree 移除 + 状态翻转）
        archive_impl(conn, id)?;
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str("已合并并归档工作区");
    } else {
        // 只合并：记录 merged_at（前端显示「已合并」pill；继续提交后按 ahead>0 隐藏）
        conn.execute(
            "UPDATE workspaces SET merged_at=?1 WHERE id=?2",
            params![crate::sessions::now_iso(), id],
        )
        .map_err(|e| e.to_string())?;
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str("已合并（工作区保留，可继续干活或之后归档）");
    }
    Ok(log)
}

fn pr_impl(conn: &Connection, id: &str, title: &str, body: Option<String>) -> Result<String, String> {
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
    run_git(&wt, &["push", "-u", "origin", &w.branch], Duration::from_secs(120))
        .map_err(|e| format!("推送分支失败: {e}"))?;
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
        .args(["pr", "create", "--base", &w.base_branch, "--head", &w.branch, "--title", title, "--body", &body])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = run_cmd(cmd, Duration::from_secs(120)).map_err(|e| format!("gh pr create 失败: {e}"))?;
    // gh 成功输出的末行是 PR URL
    Ok(out
        .lines()
        .rev()
        .find(|l| l.contains("http"))
        .unwrap_or(out.trim())
        .trim()
        .to_string())
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
pub async fn archive_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let paths = tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
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
    let paths = tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
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
    id: String,
    archive: bool,
) -> Result<String, String> {
    let (out, paths) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let conn = db()?;
            let w = get_workspace(&conn, &id)?;
            let out = merge_impl(&conn, &id, archive)?;
            Ok((out, (w.worktree_path, w.repo_path)))
        })
        .await
        .map_err(|e| e.to_string())??;
    // 只有归档了才广播（前端把留在被移除工作树里的终端标签切回主仓库）
    if archive {
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
    if let Some(w) = actives.iter().find(|w| target.starts_with(canon(&w.repo_path))) {
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

/// 把基准分支并入任务分支（`git merge <base>` 在工作树里执行）：冲突留在工作区就地解决，
/// 不碰主仓库——前端在解决后串联提交与最终合并
#[tauri::command]
pub async fn workspace_sync_base(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        // 工作树有未提交改动时 git 会拒绝合并，先说清楚
        if !run_git(&wt, &["status", "--porcelain"], Duration::from_secs(30))?.is_empty() {
            return Err("工作区有未提交改动，请先在「改动」面板提交，再并入主分支".into());
        }
        match run_git(&wt, &["merge", &w.base_branch], Duration::from_secs(60)) {
            Ok(out) => Ok(format!(
                "已把 {} 并入 {}：\n{}",
                w.base_branch,
                w.branch,
                if out.trim().is_empty() { "已是最新" } else { out.trim() }
            )),
            Err(e) => {
                let files =
                    run_git(&wt, &["diff", "--name-only", "--diff-filter=U"], Duration::from_secs(10))
                        .unwrap_or_default();
                Err(format!(
                    "并入产生冲突——冲突留在工作区，不影响主仓库：\n{e}\n冲突文件:\n{files}\n逐文件选择版本后可直接「完成解决并合并」"
                ))
            }
        }
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
}

fn unmerged_impl(wt: &Path) -> Result<UnmergedDto, String> {
    let merging = run_git(wt, &["rev-parse", "--verify", "-q", "MERGE_HEAD"], Duration::from_secs(10))
        .is_ok();
    let out = run_git(wt, &["diff", "--name-only", "--diff-filter=U"], Duration::from_secs(10))?;
    Ok(UnmergedDto {
        merging,
        files: out.lines().map(|l| l.to_string()).filter(|l| !l.is_empty()).collect(),
    })
}

#[tauri::command]
pub async fn workspace_unmerged_files(id: String) -> Result<UnmergedDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let w = get_workspace(&conn, &id)?;
        unmerged_impl(&PathBuf::from(&w.worktree_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 单边解决实现（worktree 直给，便于测试）
fn resolve_file_impl(wt: &Path, path: &str, side: &str) -> Result<UnmergedDto, String> {
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(format!("未知选边: {side}")),
    };
    if run_git(wt, &["checkout", flag, "--", path], Duration::from_secs(30)).is_ok() {
        run_git(wt, &["add", "--", path], Duration::from_secs(30))?;
    } else {
        // 删/改冲突中选定侧是「已删除」：checkout 失败，git rm 即选定该侧
        run_git(wt, &["rm", "-q", "--ignore-unmatch", "--", path], Duration::from_secs(30))?;
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
        resolve_file_impl(&PathBuf::from(&w.worktree_path), &path, &side)
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
        finish_merge_impl(&PathBuf::from(&w.worktree_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 推送分支并用 gh CLI 创建 PR（复用机器上的 gh 认证）
#[tauri::command]
pub async fn create_pr(id: String, title: String, body: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pr_impl(&db()?, &id, &title, body))
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
fn repo_cache_hit(cached: &Option<(Instant, Vec<RepoDto>)>, now: Instant, ttl: Duration) -> Option<Vec<RepoDto>> {
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
            .filter(|p| {
                run_git(p, &["rev-parse", "--git-dir"], Duration::from_secs(5)).is_ok()
            })
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
        assert!(out.status.success(), "git {:?} 失败: {}", args, String::from_utf8_lossy(&out.stderr));
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
        sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
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
            Some(Self { dir, conn, ws_root, repo })
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
        assert!(sanitize_name("我的").is_err(), "全非允许字符清洗后为空要拒绝");
    }

    #[test]
    fn repo_cache_hit_within_ttl_and_expired() {
        let t0 = Instant::now();
        let ttl = Duration::from_secs(60);
        let cached = Some((t0, vec![RepoDto { path: "/r".into(), name: "r".into() }]));
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
        *repo_cache().lock().unwrap() =
            Some((Instant::now(), vec![RepoDto { path: "/r".into(), name: "r".into() }]));
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "cache-inv").unwrap();
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
        assert_eq!(fs::read_to_string(Path::new(&w.worktree_path).join(".env")).unwrap(), "SECRET=1");
        assert!(Path::new(&w.worktree_path).join(".envrc").exists());
        assert!(Path::new(&w.worktree_path).join(".env.local").exists() == false);
        // 分支真实存在
        assert!(run_git(&fx.repo, &["rev-parse", "--verify", "--quiet", "ccode/task-one"], Duration::from_secs(10)).is_ok());
        // 第二个工作区拿到下一段端口
        let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "two").unwrap();
        assert_eq!(w2.port_base, 4010);
        // 同名（同分支）拒绝
        let err = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "task one").unwrap_err();
        assert!(err.contains("已存在"), "{err}");
    }

    #[test]
    fn archive_restore_delete_lifecycle() {
        let Some(fx) = Fixture::new() else { return };
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "life").unwrap();
        archive_impl(&fx.conn, &w.id).unwrap();
        let w = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w.status, "archived");
        assert!(w.archived_at.is_some());
        assert!(!Path::new(&w.worktree_path).exists(), "归档后 worktree 目录应被移除");
        // 分支保留，可恢复
        restore_impl(&fx.conn, &w.id).unwrap();
        let w = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w.status, "active");
        assert!(w.archived_at.is_none());
        assert!(Path::new(&w.worktree_path).exists());
        // 删除：分支与行都没了
        delete_impl(&fx.conn, &w.id).unwrap();
        assert!(run_git(&fx.repo, &["rev-parse", "--verify", "--quiet", "ccode/life"], Duration::from_secs(10)).is_err());
        assert!(get_workspace(&fx.conn, &w.id).is_err());
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
        Command::new("git").args(["init", "--bare"]).arg(&origin).output().unwrap();
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
        sh(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
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
        let start = run_git(&repo, &["rev-parse", "ccode/on-master"], Duration::from_secs(10)).unwrap();
        let local = run_git(&repo, &["rev-parse", "master"], Duration::from_secs(10)).unwrap();
        let origin = run_git(&repo, &["rev-parse", "origin/master"], Duration::from_secs(10)).unwrap();
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
        assert!(res.output_tail.contains("port=4000"), "脚本应拿到端口段 env: {}", res.output_tail);
        assert_eq!(
            fs::read_to_string(Path::new(&w.worktree_path).join("setup-mark.txt")).unwrap().trim(),
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
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "failsetup").unwrap();
        let res = w.setup_result.as_ref().unwrap();
        assert!(!res.ok, "exit 1 的 setup 应记录为失败");
        assert!(res.output_tail.contains("boom"), "stderr 尾部应保留: {}", res.output_tail);
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
        assert!(Path::new(&w.worktree_path).exists(), "脚本失败时 worktree 不得移除");
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
        assert!(w.setup_result.is_none(), "无 setup 脚本时 setup_result 为 None");
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
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "env"]);
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "health").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "v1\n").unwrap();
        commit_all_in_worktree(&wt, "任务改动");
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert!(!h.uncommitted);
        assert!(!h.main_dirty && !h.main_off_base);
        assert_eq!(h.ahead, 1);
        assert_eq!(h.behind, 0);
        assert_eq!(h.conflict, Some(false), "merge-tree 探测应为干净（git 2.55）");
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
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"]);
        sh(&fx.repo, &["push", "origin", "main"]);
        let h = health_impl(&fx.conn, &w.id).unwrap();
        assert_eq!(h.behind, 1);
        assert_eq!(h.conflict, Some(true), "同一文件同一行应探出冲突");
        assert_eq!(h.conflict_files, vec!["feature.txt".to_string()]);
        assert!(!h.ready_to_merge);
    }

    #[test]
    fn resolve_flow_sync_conflict_pick_side_finish() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "env"]);
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "resolve").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        // 分支改 feature.txt 并提交；main 改同一行 → 并入冲突
        fs::write(wt.join("feature.txt"), "branch\n").unwrap();
        commit_all_in_worktree(&wt, "分支改动");
        fs::write(fx.repo.join("feature.txt"), "main\n").unwrap();
        sh(&fx.repo, &["add", "feature.txt"]);
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"]);
        assert!(run_git(&wt, &["merge", "main"], Duration::from_secs(60)).is_err(), "应产生冲突");
        // 未解决清单；未解决前拒绝 finish
        let st = unmerged_impl(&wt).unwrap();
        assert!(st.merging);
        assert_eq!(st.files, vec!["feature.txt".to_string()]);
        assert!(finish_merge_impl(&wt).unwrap_err().contains("未解决"));
        // 选分支版（ours）→ 清单清空，文件内容是分支版（Windows 上 checkout 落盘为 CRLF，断言归一化）
        let st = resolve_file_impl(&wt, "feature.txt", "ours").unwrap();
        assert!(st.files.is_empty());
        assert_eq!(
            fs::read_to_string(wt.join("feature.txt")).unwrap().replace("\r\n", "\n"),
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

    #[cfg(unix)]
    #[test]
    fn merge_workspace_happy_path_merges_and_archives() {
        let Some(fx) = Fixture::new() else { return };
        // 主仓库保持干净（把 fixture 里未跟踪的 .env* 提交掉）
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "env"]);
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "mergeme").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "done\n").unwrap();
        commit_all_in_worktree(&wt, "任务完成");
        let out = merge_impl(&fx.conn, &w.id, true).unwrap();
        assert!(out.contains("已合并并归档"), "{out}");
        // 改动进了主仓库的 main
        assert_eq!(fs::read_to_string(fx.repo.join("feature.txt")).unwrap(), "done\n");
        // 工作区已归档、worktree 已移除
        let w2 = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w2.status, "archived");
        assert!(!wt.exists());
    }

    #[cfg(unix)]
    #[test]
    fn merge_without_archive_keeps_workspace_active() {
        let Some(fx) = Fixture::new() else { return };
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "env"]);
        let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "keepme").unwrap();
        let wt = PathBuf::from(&w.worktree_path);
        fs::write(wt.join("feature.txt"), "done\n").unwrap();
        commit_all_in_worktree(&wt, "任务完成");
        let out = merge_impl(&fx.conn, &w.id, false).unwrap();
        assert!(out.contains("工作区保留"), "{out}");
        // 改动进了 main，但工作区仍活跃、worktree 还在，merged_at 已置位
        assert_eq!(fs::read_to_string(fx.repo.join("feature.txt")).unwrap(), "done\n");
        let w2 = get_workspace(&fx.conn, &w.id).unwrap();
        assert_eq!(w2.status, "active");
        assert!(w2.merged_at.is_some(), "只合并应记录 merged_at");
        assert!(wt.exists());
        // 之后「合并并归档」：merge 变 no-op，归档照常发生
        let out = merge_impl(&fx.conn, &w.id, true).unwrap();
        assert!(out.contains("已合并并归档"), "{out}");
        assert!(!wt.exists());
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
        assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "active", "拒绝后工作区状态不变");
        assert!(wt.exists());
        // 清掉脏文件但切到别的分支 → 同样拒绝
        sh(&fx.repo, &["add", ".env", ".envrc"]);
        sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "env"]);
        sh(&fx.repo, &["checkout", "-b", "other"]);
        let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
        assert!(err.contains("不在基准分支"), "{err}");
        // 主仓库 main 上不应有 x.txt（merge 没发生）
        sh(&fx.repo, &["checkout", "main"]);
        assert!(!fx.repo.join("x.txt").exists());
    }
}
