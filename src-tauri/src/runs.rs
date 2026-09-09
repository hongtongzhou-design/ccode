//! 一次干活（Run）身份：关标签不删行。无头标 internal，不进工作台「正在进行」。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_TASK_INPUT_FILES: usize = 20_000;
const MAX_TASK_INPUT_BYTES: u64 = 512 * 1024 * 1024;

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

/// 入口幂等键闭集：旧 `wt:` 升格为 `lane:`；其余前缀原样保留。
pub(crate) fn canonicalize_reuse_key(key: &str) -> String {
    let key = key.trim();
    if let Some(rest) = key.strip_prefix("wt:") {
        return format!("lane:{rest}");
    }
    key.to_string()
}

pub(crate) fn infer_task_kind(reuse_key: &str, isolation: &str) -> &'static str {
    let key = canonicalize_reuse_key(reuse_key);
    if key.starts_with("login:") {
        return "login";
    }
    if key.starts_with("reader:") {
        return "reader";
    }
    if key.starts_with("watch:") {
        return "watch";
    }
    if key.starts_with("office:") {
        return "office_doc";
    }
    if key.starts_with("free:") || key.starts_with("research:") {
        return "free_research";
    }
    if key.starts_with("ws:") {
        return "pipeline_step";
    }
    if key.starts_with("lane:") || key.starts_with("coding:") {
        return "coding_lane";
    }
    if key.starts_with("headless:") {
        return "scratch";
    }
    let path = isolation.replace('\\', "/");
    if path.contains("/ccode/scratch") {
        return "scratch";
    }
    if path.contains("/ccode/workspaces/") {
        return "pipeline_step";
    }
    if path.contains("/ccode/worktrees/") {
        return "coding_lane";
    }
    "scratch"
}

pub(crate) fn is_internal_kind(task_kind: &str, reuse_key: &str) -> bool {
    task_kind == "watch" || reuse_key.starts_with("watch:") || reuse_key.starts_with("headless:")
}

fn basename_of(path: &str) -> Option<String> {
    let t = path.trim_end_matches(['/', '\\']);
    std::path::Path::new(t)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

fn infer_task_ref(reuse: &str, isolation: &str) -> Option<String> {
    if let Some(rest) = reuse.strip_prefix("watch:") {
        let id = rest.split(':').next().unwrap_or("");
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    if let Some(rest) = reuse.strip_prefix("office:") {
        if let Some((_, rel)) = rest.rsplit_once(':') {
            if rel != "project" && !rel.is_empty() {
                return Some(rel.to_string());
            }
        }
    }
    if let Some(rest) = reuse.strip_prefix("custom:") {
        let id = rest.split(':').next().unwrap_or("");
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    basename_of(isolation)
}

fn infer_project_root(reuse: &str, isolation: &str) -> Option<String> {
    if let Some(rest) = reuse.strip_prefix("reader:") {
        let t = rest.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(p) = crate::projects::project_root_containing(isolation) {
        return Some(p);
    }
    let mut best: Option<(usize, String)> = None;
    for w in crate::workspaces::worktree_rows() {
        if crate::paths::path_within(isolation, &w.worktree_path)
            || crate::paths::path_within(isolation, &w.repo_path)
        {
            let len = w.worktree_path.len().max(w.repo_path.len());
            if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                best = Some((len, w.repo_path));
            }
        }
    }
    if let Some((_, p)) = best {
        return Some(p);
    }
    crate::coding::repo_path_for_worktree(isolation)
}

// Task 是持久意图；identity_key 只在入口解析，跨页面只传 taskId / runId。
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, project_root TEXT,
        kind TEXT NOT NULL, task_ref TEXT, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        input_paths TEXT NOT NULL DEFAULT '[]', output_paths TEXT NOT NULL DEFAULT '[]',
        review_required INTEGER NOT NULL DEFAULT 0, archived_at TEXT, agent TEXT,
        profile_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_root TEXT, task_kind TEXT NOT NULL, task_ref TEXT,
        isolation_path TEXT NOT NULL, runtime TEXT NOT NULL, agent TEXT NOT NULL,
        profile_id TEXT, permission TEXT NOT NULL, reuse_key TEXT, session_id TEXT,
        internal INTEGER NOT NULL DEFAULT 0, sentinel INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, closed_at TEXT);
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_reuse ON runs(reuse_key);
      CREATE INDEX IF NOT EXISTS idx_runs_open ON runs(internal, closed_at);",
    )
    .map_err(|e| e.to_string())?;
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (column, definition) in [
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("input_paths", "TEXT NOT NULL DEFAULT '[]'"),
        ("output_paths", "TEXT NOT NULL DEFAULT '[]'"),
        ("review_required", "INTEGER NOT NULL DEFAULT 0"),
        ("archived_at", "TEXT"),
        ("agent", "TEXT"),
        ("profile_id", "TEXT"),
        ("adopted_paths", "TEXT NOT NULL DEFAULT '[]'"),
    ] {
        if !columns.iter().any(|c| c == column) {
            conn.execute(
                &format!("ALTER TABLE tasks ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let run_columns: Vec<String> = conn
        .prepare("PRAGMA table_info(runs)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (column, definition) in [
        ("status", "TEXT NOT NULL DEFAULT 'running'"),
        ("exit_code", "INTEGER"),
        ("close_reason", "TEXT"),
        ("task_id", "TEXT"),
        ("custom_runtime_id", "TEXT"),
    ] {
        if !run_columns.iter().any(|c| c == column) {
            conn.execute(
                &format!("ALTER TABLE runs ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    // 一次回填旧 Run；不重写任何 CLI 会话文件，也不合并两套 worktree 库。
    let legacy = query_runs(conn, "WHERE task_id IS NULL", [])?;
    for run in legacy {
        let task = ensure_task_at(
            conn,
            run.project_root.as_deref(),
            &run.task_kind,
            run.task_ref.as_deref(),
            &run.isolation_path,
        )?;
        conn.execute("UPDATE runs SET task_id=?2, status=CASE WHEN closed_at IS NOT NULL AND status='running' THEN 'completed' ELSE status END WHERE id=?1",
            params![run.id, task.id]).map_err(|e| e.to_string())?;
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, created_at);")
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn db() -> Result<Connection, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn record_event(
    conn: &Connection,
    id: &str,
    kind: &str,
    payload: Option<&str>,
) -> Result<(), String> {
    let payload = payload.map(crate::sessions::redact_sensitive_text);
    conn.execute(
        "INSERT INTO run_events(id,run_id,event_type,payload,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            id,
            kind,
            payload,
            now_rfc3339()
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub project_root: Option<String>,
    pub kind: String,
    pub task_ref: Option<String>,
    pub name: String,
    pub description: String,
    pub status: String,
    pub input_paths: Vec<String>,
    pub output_paths: Vec<String>,
    pub review_required: bool,
    pub archived_at: Option<String>,
    pub agent: Option<String>,
    pub profile_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub declared: bool,
    pub adopted_paths: Vec<String>,
}
fn map_task(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskDto> {
    let input_paths: String = r.get(7)?;
    let output_paths: String = r.get(8)?;
    let identity_key: String = r.get(15)?;
    Ok(TaskDto {
        id: r.get(0)?,
        project_root: r.get(1)?,
        kind: r.get(2)?,
        task_ref: r.get(3)?,
        name: r.get(4)?,
        description: r.get(5)?,
        status: r.get(6)?,
        input_paths: serde_json::from_str(&input_paths).unwrap_or_default(),
        output_paths: serde_json::from_str(&output_paths).unwrap_or_default(),
        review_required: r.get::<_, i64>(9)? != 0,
        archived_at: r.get(10)?,
        agent: r.get(11)?,
        profile_id: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        declared: identity_key.starts_with("user:"),
        adopted_paths: serde_json::from_str(&r.get::<_, String>(16)?).unwrap_or_default(),
    })
}
const TASK_COLS: &str = "id,project_root,kind,task_ref,name,description,status,input_paths,output_paths,review_required,archived_at,agent,profile_id,created_at,updated_at,identity_key,adopted_paths";
fn ensure_task_at(
    conn: &Connection,
    root: Option<&str>,
    kind: &str,
    task_ref: Option<&str>,
    isolation: &str,
) -> Result<TaskDto, String> {
    let key = serde_json::to_string(&(root, kind, task_ref.unwrap_or(isolation)))
        .map_err(|e| e.to_string())?;
    let now = now_rfc3339();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,created_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(identity_key) DO NOTHING",
        params![
            uuid::Uuid::new_v4().to_string(),
            key,
            root,
            kind,
            task_ref,
            task_ref.unwrap_or(isolation),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {TASK_COLS} FROM tasks WHERE identity_key=?1"),
        [key],
        map_task,
    )
    .map_err(|e| e.to_string())
}

fn task_json_paths(value: &[String]) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("任务文件路径无法保存: {e}"))
}

/// 哪些执行需要在 tasks 表登记（§4.7）：声明目标显式带 task_id，不走这里；
/// 自动登记只留给有归属语义的对象（科研步骤/编程车道/定时巡检）。
/// 随手聊、阅读、办公文件闲聊是沟通记录不是目标——Run 直接落 NULL task_id。
fn run_needs_task(kind: &str) -> bool {
    matches!(kind, "pipeline_step" | "coding_lane" | "watch" | "free_research")
}

fn prune_nested_rel_paths(paths: &[String]) -> Vec<String> {
    let mut items = paths.to_vec();
    items.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    let mut kept = Vec::new();
    for path in items {
        if path == "." {
            return vec![".".into()];
        }
        let covered = kept.iter().any(|parent: &String| {
            parent == "." || path == *parent || path.starts_with(&format!("{parent}/"))
        });
        if !covered {
            kept.push(path);
        }
    }
    kept
}

fn task_rel_path(root: &Path, raw: &str, label: &str) -> Result<(String, PathBuf), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{label}不能是空路径"));
    }
    let candidate = {
        let path = PathBuf::from(crate::sessions::expand_tilde(raw));
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let canonical = crate::paths::canonicalize_plain(&candidate)
        .map_err(|e| format!("{label}无法解析：{e}"))?;
    if !crate::paths::path_within(&canonical.to_string_lossy(), &root.to_string_lossy()) {
        return Err(format!("{label}必须位于项目目录内"));
    }
    let relative = canonical
        .strip_prefix(root)
        .map_err(|_| format!("{label}无法计算项目相对路径"))?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        return Err(format!("{label}不能是项目根目录本身"));
    }
    if relative
        .split('/')
        .any(|part| matches!(part, ".git" | ".ccode"))
    {
        return Err(format!("{label}不能指向 Mesa 或 Git 内部目录"));
    }
    Ok((relative, canonical))
}

#[derive(Default)]
struct TaskCopyBudget {
    files: usize,
    bytes: u64,
}

fn copy_task_tree_with_budget(
    source: &Path,
    target: &Path,
    budget: &mut TaskCopyBudget,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| format!("读取输入文件失败：{e}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("输入文件不能是符号链接：{}", source.display()));
    }
    if metadata.is_dir() {
        if matches!(
            source.file_name().and_then(|name| name.to_str()),
            Some(".git" | ".ccode" | "node_modules" | "target")
        ) {
            return Ok(());
        }
        fs::create_dir_all(target).map_err(|e| format!("创建任务输入目录失败：{e}"))?;
        for entry in
            fs::read_dir(source).map_err(|e| format!("读取任务输入目录失败：{e}"))?
        {
            let entry = entry.map_err(|e| format!("读取任务输入目录失败：{e}"))?;
            let child = entry.path();
            let name = entry.file_name();
            copy_task_tree_with_budget(&child, &target.join(name), budget)?;
        }
    } else if metadata.is_file() {
        budget.files += 1;
        budget.bytes = budget.bytes.saturating_add(metadata.len());
        if budget.files > MAX_TASK_INPUT_FILES {
            return Err(format!("输入文件超过上限（{} 个）", MAX_TASK_INPUT_FILES));
        }
        if budget.bytes > MAX_TASK_INPUT_BYTES {
            return Err("输入文件总大小超过 512 MB 上限".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建任务输入目录失败：{e}"))?;
        }
        fs::copy(source, target).map_err(|e| format!("复制任务输入失败：{e}"))?;
    } else {
        return Err(format!("输入路径不是普通文件或目录：{}", source.display()));
    }
    Ok(())
}

fn copy_project_contents(
    source: &Path,
    target: &Path,
    budget: &mut TaskCopyBudget,
) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| format!("读取项目范围失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取项目范围失败：{e}"))?;
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".git" | ".ccode" | "node_modules" | "target")) {
            continue;
        }
        copy_task_tree_with_budget(&entry.path(), &target.join(name), budget)?;
    }
    Ok(())
}

fn task_entry_is_ignored(name: &std::ffi::OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".ccode" | "node_modules" | "target")
    )
}

fn rel_posix(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| format!("变更路径不在任务目录内：{}", path.display()))
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn reject_symlink(path: &Path, label: &str) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("{label}失败：{e}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label}不能是符号链接：{}", path.display()));
    }
    Ok(metadata)
}

fn validate_output_rel(path: &str) -> Result<String, String> {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("输出路径必须是项目内相对路径".into());
    }
    Ok(path.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputChangeDto {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
}

fn push_file_change(
    source: &Path,
    target: &Path,
    source_root: &Path,
    changes: &mut Vec<TaskOutputChangeDto>,
) -> Result<(), String> {
    let metadata = reject_symlink(source, "读取任务输出")?;
    if !metadata.is_file() {
        return Err(format!("任务输出不是普通文件：{}", source.display()));
    }
    if target.exists() {
        let target_meta = reject_symlink(target, "读取项目文件")?;
        if target_meta.is_dir() {
            return Err(format!("输出目标是目录：{}", target.display()));
        }
        if files_equal(source, target)? {
            return Ok(());
        }
        changes.push(TaskOutputChangeDto {
            path: rel_posix(source_root, source)?,
            kind: "modified".into(),
            bytes: metadata.len(),
        });
        return Ok(());
    }
    changes.push(TaskOutputChangeDto {
        path: rel_posix(source_root, source)?,
        kind: "added".into(),
        bytes: metadata.len(),
    });
    Ok(())
}

fn collect_output_changes(
    source: &Path,
    target: &Path,
    source_root: &Path,
    changes: &mut Vec<TaskOutputChangeDto>,
) -> Result<(), String> {
    let metadata = reject_symlink(source, "读取任务输出")?;
    if metadata.is_dir() {
        if let Ok(target_meta) = fs::symlink_metadata(target) {
            if target_meta.file_type().is_symlink() {
                return Err(format!("输出目标不能是符号链接：{}", target.display()));
            }
            if !target_meta.is_dir() {
                return Err(format!("输出目标不是目录：{}", target.display()));
            }
        }
        for entry in fs::read_dir(source).map_err(|e| format!("读取任务输出目录失败：{e}"))? {
            let entry = entry.map_err(|e| format!("读取任务输出目录失败：{e}"))?;
            if task_entry_is_ignored(&entry.file_name()) {
                continue;
            }
            collect_output_changes(
                &entry.path(),
                &target.join(entry.file_name()),
                source_root,
                changes,
            )?;
        }
        return Ok(());
    }
    push_file_change(source, target, source_root, changes)
}

fn list_output_changes(
    run_root: &Path,
    project_root: &Path,
    output_paths: &[String],
) -> Result<Vec<TaskOutputChangeDto>, String> {
    let mut changes = Vec::new();
    if output_paths.iter().any(|path| path == ".") {
        collect_output_changes(run_root, project_root, run_root, &mut changes)?;
    } else {
        for raw in output_paths {
            let relative = validate_output_rel(raw)?;
            let source = run_root.join(&relative);
            if !source.exists() {
                continue;
            }
            collect_output_changes(
                &source,
                &project_root.join(&relative),
                run_root,
                &mut changes,
            )?;
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes.dedup_by(|a, b| a.path == b.path);
    Ok(changes)
}

fn copy_adopt_file(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = reject_symlink(source, "读取任务输出")?;
    if !metadata.is_file() {
        return Err(format!("任务输出不是普通文件：{}", source.display()));
    }
    if target.exists() {
        let target_meta = reject_symlink(target, "读取项目文件")?;
        if target_meta.is_dir() {
            return Err(format!("输出目标是目录：{}", target.display()));
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败：{e}"))?;
    }
    fs::copy(source, target).map_err(|e| format!("接收任务输出失败：{e}"))?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct AdoptBackupFile {
    path: String,
    existed: bool,
}

struct AdoptItem {
    relative: String,
    source: PathBuf,
    target: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}

fn read_regular_optional(path: &Path, label: &str) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{label}失败：{error}")),
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("{label}不能是符号链接：{}", path.display()))
        }
        Ok(meta) if meta.is_dir() => Err(format!("{label}是目录：{}", path.display())),
        Ok(_) => fs::read(path).map(Some).map_err(|e| format!("{label}失败：{e}")),
    }
}

fn adopt_lock(dir: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建采纳锁目录失败：{e}"))?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("adopt.lock"))
        .map_err(|e| format!("打开采纳锁失败：{e}"))?;
    file.try_lock()
        .map_err(|_| "另一个采纳操作正在执行，请稍后重试".to_string())?;
    Ok(file)
}

fn persist_adopt_backup(dir: &Path, items: &[AdoptItem]) -> Result<PathBuf, String> {
    let backup = dir.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(backup.join("files")).map_err(|e| format!("创建采纳备份失败：{e}"))?;
    let manifest: Vec<AdoptBackupFile> = items
        .iter()
        .map(|item| AdoptBackupFile {
            path: item.relative.clone(),
            existed: item.before.is_some(),
        })
        .collect();
    crate::profiles::atomic_write(
        &backup.join("before.json"),
        &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    for item in items {
        if let Some(bytes) = &item.before {
            let dest = backup.join("files").join(&item.relative);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建采纳备份失败：{e}"))?;
            }
            crate::profiles::atomic_write_bytes(&dest, bytes)?;
        }
    }
    Ok(backup)
}

fn rollback_adopt(written: &[AdoptItem], backup: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    for item in written.iter().rev() {
        let rollback = (|| {
            let current = read_regular_optional(&item.target, "读取项目文件")?;
            if current.as_deref() != Some(item.after.as_slice()) {
                return Err("文件再次被外部修改，未强制回滚".to_string());
            }
            match &item.before {
                Some(bytes) => crate::profiles::atomic_write_bytes(&item.target, bytes),
                None => fs::remove_file(&item.target).map_err(|e| e.to_string()),
            }
        })();
        if let Err(e) = rollback {
            errors.push(format!("{}: {e}", item.relative));
        }
    }
    if !errors.is_empty() {
        errors.push(format!("恢复备份：{}", backup.display()));
    }
    errors
}

#[cfg(test)]
thread_local! {
    static TEST_ADOPT_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn adopt_state_root(project: &Path) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(root) = TEST_ADOPT_ROOT.with(|c| c.borrow().clone()) {
        return Ok(root);
    }
    Ok(task_runs_root()?
        .join("adopt")
        .join(format!("{:x}", md5::compute(project.to_string_lossy().as_bytes()))))
}

fn adopt_selected_with_writer(
    run_id: &str,
    run_root: &Path,
    project: &Path,
    selected: &[String],
    mut write: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let lock_dir = adopt_state_root(project)?;
    let _lock = adopt_lock(&lock_dir)?;
    let mut pending = Vec::new();
    for relative in selected {
        let source = run_root.join(relative);
        let target = project.join(relative);
        let after = fs::read(&source).map_err(|e| format!("读取任务输出失败：{e}"))?;
        let before = read_regular_optional(&target, "读取项目文件")?;
        if before.as_deref() == Some(after.as_slice()) {
            continue;
        }
        pending.push(AdoptItem {
            relative: relative.clone(),
            source,
            target,
            before,
            after,
        });
    }
    if pending.is_empty() {
        return Ok(());
    }
    let backup = persist_adopt_backup(&lock_dir.join("backups").join(run_id), &pending)?;
    let mut written = Vec::new();
    for item in pending {
        let result = (|| {
            let current = read_regular_optional(&item.target, "读取项目文件")?;
            if current != item.before {
                return Err(format!("{} 在采纳期间变化，未覆盖", item.relative));
            }
            write(&item.source, &item.target)
        })();
        if let Err(error) = result {
            let rollback = rollback_adopt(&written, &backup);
            return Err(if rollback.is_empty() {
                format!("采纳失败：{error}。已回滚；备份：{}", backup.display())
            } else {
                format!(
                    "采纳失败：{error}。回滚未完全成功；备份：{}。{}",
                    backup.display(),
                    rollback.join("；")
                )
            });
        }
        written.push(item);
    }
    Ok(())
}

fn adopt_selected_files(
    run_id: &str,
    run_root: &Path,
    project: &Path,
    selected: &[String],
) -> Result<(), String> {
    adopt_selected_with_writer(run_id, run_root, project, selected, copy_adopt_file)
}

fn files_equal(source: &Path, target: &Path) -> Result<bool, String> {
    let source_meta = fs::metadata(source).map_err(|e| format!("读取任务输出失败：{e}"))?;
    let target_meta = match fs::metadata(target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取项目文件失败：{error}")),
    };
    if !source_meta.is_file() || !target_meta.is_file() {
        return Ok(false);
    }
    if source_meta.len() != target_meta.len() {
        return Ok(false);
    }
    let mut source_file = fs::File::open(source).map_err(|e| format!("读取任务输出失败：{e}"))?;
    let mut target_file = fs::File::open(target).map_err(|e| format!("读取项目文件失败：{e}"))?;
    let mut source_buffer = [0_u8; 8192];
    let mut target_buffer = [0_u8; 8192];
    loop {
        let source_read = source_file
            .read(&mut source_buffer)
            .map_err(|e| format!("读取任务输出失败：{e}"))?;
        let target_read = target_file
            .read(&mut target_buffer)
            .map_err(|e| format!("读取项目文件失败：{e}"))?;
        if source_read != target_read
            || source_buffer[..source_read] != target_buffer[..target_read]
        {
            return Ok(false);
        }
        if source_read == 0 {
            return Ok(true);
        }
    }
}

fn copy_project_changes(source: &Path, target: &Path) -> Result<(), String> {
    let changes = list_output_changes(source, target, &[".".to_string()])?;
    for change in changes {
        copy_adopt_file(&source.join(&change.path), &target.join(&change.path))?;
    }
    Ok(())
}

fn task_runs_root() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .or_else(dirs::config_dir)
        .ok_or("无法确定 Mesa 数据目录")?;
    let root = base.join("ccode").join("task-runs");
    fs::create_dir_all(&root).map_err(|e| format!("创建任务运行目录失败：{e}"))?;
    Ok(root)
}

fn task_by_id(conn: &Connection, id: &str) -> Result<TaskDto, String> {
    conn.query_row(
        &format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"),
        [id],
        map_task,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Task 不存在".into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub project_root: String,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub input_paths: Vec<String>,
    pub output_paths: Vec<String>,
    pub permission: Option<String>,
    pub agent: Option<String>,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub fn task_create(input: CreateTaskInput) -> Result<TaskDto, String> {
    let root = validate_existing_dir(&input.project_root, "项目根目录")?;
    if !matches!(input.kind.as_str(), "free_research" | "office_doc") {
        return Err("这里只能创建自由科研或工作任务".into());
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Task 名称不能为空".into());
    }
    let permission = input.permission.as_deref().unwrap_or("write_tree");
    if !matches!(permission, "discuss" | "write_tree") {
        return Err("不支持的权限政策".into());
    }
    let agent = input
        .agent
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(agent) = agent {
        if crate::agent_specs::agent_spec(agent).is_none() {
            return Err(format!("未知 Agent：{agent}"));
        }
    }
    let conn = db()?;
    let project = crate::projects::canonical_key(Path::new(&root));
    let registered = conn
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE path=?1",
            [&project],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    if registered == 0 {
        return Err("项目尚未注册，不能创建 Task".into());
    }
    let mut inputs = Vec::new();
    for path in &input.input_paths {
        if path.trim() == "." {
            if !inputs.is_empty() {
                return Err("整个项目范围不能与指定路径同时使用".into());
            }
            if !inputs.contains(&".".to_string()) {
                inputs.push(".".into());
            }
            continue;
        }
        if inputs.iter().any(|item| item == ".") {
            return Err("整个项目范围不能与指定路径同时使用".into());
        }
        let (relative, _) = task_rel_path(Path::new(&root), path, "输入路径")?;
        if !inputs.contains(&relative) {
            inputs.push(relative);
        }
    }
    if inputs.iter().any(|item| item == ".") {
        inputs = vec![".".into()];
    } else {
        inputs = prune_nested_rel_paths(&inputs);
    }
    let mut outputs = Vec::new();
    for path in &input.output_paths {
        let path = path.trim().replace('\\', "/");
        let path = path.trim_matches('/');
        if path == "." {
            if !outputs.is_empty() {
                return Err("全部项目变更不能与指定输出路径同时使用".into());
            }
            outputs.push(".".to_string());
            continue;
        }
        if outputs.iter().any(|item| item == ".") {
            return Err("全部项目变更不能与指定输出路径同时使用".into());
        }
        if path.is_empty()
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("输出路径必须是项目内相对路径".into());
        }
        if !outputs.contains(&path.to_string()) {
            outputs.push(path.to_string());
        }
    }
    let review_required = permission == "write_tree";
    if !review_required && !outputs.is_empty() {
        return Err("只讨论任务不能指定输出路径；如需生成文件请改为写入后审核".into());
    }
    if review_required && outputs.is_empty() {
        return Err("需要写文件的 Task 必须指定输出路径".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let identity = format!("user:{id}");
    conn.execute(
        "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,description,status,input_paths,output_paths,review_required,agent,profile_id,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10,?11,?12,?13,?13)",
        params![
            id,
            identity,
            project,
            input.kind,
            id,
            name,
            input.description.unwrap_or_default(),
            task_json_paths(&inputs)?,
            task_json_paths(&outputs)?,
            review_required as i64,
            agent,
            input
                .profile_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty()),
            now
        ],
    )
    .map_err(|e| format!("创建 Task 失败: {e}"))?;
    task_by_id(&conn, &id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareTaskRunInput {
    pub task_id: String,
    pub agent: String,
    pub profile_id: String,
    /// 同一目标再出一版：沿用上次隔离目录，不从项目重新复制。
    #[serde(default)]
    pub reuse_isolation: Option<bool>,
    /// 验收意见，记在上一版 Run 上，供时间线与下一版 Context Pack。
    #[serde(default)]
    pub feedback: Option<String>,
    /// 开工一刻实际下发给 Agent 的上下文全文（前端拼装的 Context Pack + 目标行）。
    /// 有就冻结成快照（审计 §4.8）；写失败 = 开工失败，不静默降级。
    #[serde(default)]
    pub context_text: Option<String>,
}

#[tauri::command]
pub async fn task_prepare_run(input: PrepareTaskRunInput) -> Result<RunDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_prepare_run_impl(input))
        .await
        .map_err(|e| format!("准备任务失败：{e}"))?
}

/// 启动失败的收尾清理：只允许删除本次调用新建的 staging 目录；
/// reuse_isolation 复用的上一版目录里有旧成果，绝不能进清理分支。
fn cleanup_failed_prepare(created_here: bool, run_root: &Path) {
    if created_here {
        let _ = fs::remove_dir_all(run_root);
    }
}

fn task_prepare_run_impl(input: PrepareTaskRunInput) -> Result<RunDto, String> {
    let conn = db()?;
    let task = task_by_id(&conn, &input.task_id)?;
    if task.archived_at.is_some() {
        return Err("已归档的 Task 不能启动".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("该 Task 类型由现有项目流程负责启动".into());
    }
    if let Some(active) = query_runs(
        &conn,
        "WHERE task_id=?1 AND closed_at IS NULL AND internal=0 ORDER BY created_at DESC LIMIT 1",
        [&task.id],
    )?
    .into_iter()
    .next()
    {
        return Ok(active);
    }
    let root = validate_existing_dir(
        task.project_root.as_deref().ok_or("Task 没有关联项目")?,
        "项目根目录",
    )?;
    let reuse_isolation = input.reuse_isolation.unwrap_or(false);
    let previous = query_runs(
        &conn,
        "WHERE task_id=?1 AND internal=0 ORDER BY created_at DESC LIMIT 1",
        [&task.id],
    )?
    .into_iter()
    .next();
    let previous_id = previous.as_ref().map(|run| run.id.clone());
    let mut created_here = false;
    let run_root = if reuse_isolation {
        let previous = previous.ok_or("还没有上一版，不能在原副本上继续")?;
        let existing = PathBuf::from(&previous.isolation_path);
        if !existing.is_dir() {
            return Err("上一版工作目录已经不在，请重新开始这个目标".into());
        }
        existing
    } else {
        created_here = true;
        let staging_id = uuid::Uuid::new_v4().to_string();
        let run_root = task_runs_root()?.join(&task.id).join(&staging_id);
        fs::create_dir_all(&run_root).map_err(|e| format!("创建 Task 独立目录失败：{e}"))?;
        let mut copy_budget = TaskCopyBudget::default();
        for relative in &task.input_paths {
            let result = if relative == "." {
                copy_project_contents(Path::new(&root), &run_root, &mut copy_budget)
            } else {
                let source = Path::new(&root).join(relative);
                let target = run_root.join(relative);
                copy_task_tree_with_budget(&source, &target, &mut copy_budget)
            };
            if let Err(error) = result {
                let _ = fs::remove_dir_all(&run_root);
                return Err(error);
            }
        }
        run_root
    };
    let permission = if task.review_required {
        "write_tree"
    } else {
        "discuss"
    };
    let run = open_run_impl(OpenRunInput {
        id: None,
        task_id: Some(task.id.clone()),
        project_root: Some(root.clone()),
        task_kind: Some(task.kind.clone()),
        task_ref: Some(task.name.clone()),
        isolation_path: run_root.to_string_lossy().into_owned(),
        runtime: Some("local_cli".into()),
        agent: input.agent,
        profile_id: Some(input.profile_id),
        permission: Some(permission.into()),
        reuse_key: Some(format!("task:{}", task.id)),
        session_id: None,
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    });
    let run = match run {
        Ok(run) => run,
        Err(error) => {
            cleanup_failed_prepare(created_here, &run_root);
            return Err(error);
        }
    };
    conn.execute(
        "UPDATE tasks SET status='running', updated_at=?2 WHERE id=?1",
        params![task.id, now_rfc3339()],
    )
    .map_err(|e| format!("更新 Task 状态失败: {e}"))?;
    if let Some(note) = input
        .feedback
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        if let Some(previous_id) = previous_id.as_deref() {
            record_event(
                &conn,
                previous_id,
                "task.review_notes",
                Some(&serde_json::json!({ "feedback": note }).to_string()),
            )?;
        }
    }
    // 开工基线：需要人审的目标在 Run 登记后立即落哈希清单（评审三向判定的起点）。
    // 写失败 = 这版没法可信验收，按「开工合同失败即停」直接失败并把这 Run 记为 failed，
    // 不静默降级成无基线运行。
    if task.review_required {
        let dir = task_review_dir(&task.id, &run.id)?;
        if let Err(error) = crate::task_review::write_baseline(
            &dir,
            &run.id,
            &run_root,
            Path::new(&root),
            &now_rfc3339(),
        ) {
            let _ = close_run_with_result(&run.id, None, "failed", None, Some("评审基线写入失败"));
            return Err(format!("记录开工基线失败，未启动：{error}"));
        }
    }
    // 有效上下文快照：前端实际拼装的下发文本，有就冻结；写失败同样开工失败
    if let Some(text) = input
        .context_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        let dir = task_review_dir(&task.id, &run.id)?;
        if let Err(error) =
            crate::task_review::write_context_snapshot(&dir, &run.id, text, &now_rfc3339())
        {
            let _ = close_run_with_result(&run.id, None, "failed", None, Some("上下文快照写入失败"));
            return Err(format!("记录上下文快照失败，未启动：{error}"));
        }
    }
    Ok(run)
}

/// 评审证据目录：随任务隔离目录同生命周期（task_delete 整树清掉）。
fn task_review_dir(task_id: &str, run_id: &str) -> Result<PathBuf, String> {
    Ok(task_runs_root()?
        .join(task_id)
        .join("review")
        .join(run_id))
}

/// 结果可审与进程成败解绑（§4.4）：失败/停止的 Run 若冻结到可审成果，
/// 目标同样进入待验收；没有可审成果则保持 failed/stopped 原状。
fn review_status_for(run_status: &str, has_adoptable_changes: bool) -> Option<&'static str> {
    if matches!(run_status, "failed" | "stopped") && has_adoptable_changes {
        Some("pending_review")
    } else {
        None
    }
}

/// Run 收尾时冻结评审证据：只有「需要人审的普通目标」参与；旧 Run 没有基线则跳过不伪造；
/// 冻结失败只记日志与事件，不反向影响收尾登记。
fn freeze_task_run_evidence(run_id: &str) {
    let result = (|| -> Result<bool, String> {
        let conn = db()?;
        let Some(run) = get_run_at(&conn, run_id)? else {
            return Ok(false);
        };
        if run.internal || !matches!(run.task_kind.as_str(), "free_research" | "office_doc") {
            return Ok(false);
        }
        if run.task_id.is_empty() {
            // 无目标 Run（办公文件闲聊等）：没有任务可审，直接跳过
            return Ok(false);
        }
        let task = task_by_id(&conn, &run.task_id)?;
        if !task.review_required {
            return Ok(false);
        }
        let dir = task_review_dir(&task.id, &run.id)?;
        let Some(snapshot) = crate::task_review::freeze(
            &dir,
            &run.id,
            Path::new(&run.isolation_path),
            &task.output_paths,
            &now_rfc3339(),
        )?
        else {
            return Ok(false);
        };
        record_event(
            &conn,
            &run.id,
            "task.snapshot_frozen",
            Some(&serde_json::json!({ "changes": snapshot.changes.len() }).to_string()),
        )?;
        let has_adoptable = snapshot.changes.iter().any(|change| change.kind != "deleted");
        if let Some(status) = review_status_for(&run.status, has_adoptable) {
            conn.execute(
                "UPDATE tasks SET status=?2, updated_at=?3 WHERE id=?1 AND status IN ('failed','stopped')",
                params![task.id, status, now_rfc3339()],
            )
            .map_err(|e| format!("更新 Task 状态失败: {e}"))?;
        }
        Ok(true)
    })();
    match result {
        Ok(_) => {}
        Err(error) => {
            crate::logbuf::record(
                "error",
                "runs",
                &format!("Run {run_id} 冻结评审证据失败：{error}"),
            );
            if let Ok(conn) = db() {
                let _ = record_event(&conn, run_id, "task.snapshot_failed", Some(&error));
            }
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReviewDto {
    /// true = 变更来自收尾时的冻结副本；false = 旧 Run 或冻结失败，退回目录现算。
    pub frozen: bool,
    /// 冻结内容副本目录（预览/采纳的数据源）；未冻结时为 None。
    pub payload_dir: Option<String>,
    pub changes: Vec<TaskOutputChangeDto>,
}

fn task_output_changes_impl(run_id: &str) -> Result<TaskReviewDto, String> {
    let conn = db()?;
    let run = get_run_at(&conn, run_id)?.ok_or("Run 不存在")?;
    let task = task_by_id(&conn, &run.task_id)?;
    if !task.review_required {
        return Err("该任务不需要审核输出".into());
    }
    let root = validate_existing_dir(
        task.project_root.as_deref().ok_or("Task 没有关联项目")?,
        "项目根目录",
    )?;
    let dir = task_review_dir(&task.id, &run.id)?;
    let snapshot = crate::task_review::load_snapshot(&dir)?;
    // 有冻结证据的 Run 不看进程退出状态（部分成果同样可审）；未冻结的旧 Run 维持 completed 门槛
    if run.status != "completed" && snapshot.is_none() {
        return Err("只有已完成的 Run 才能审核输出（这次运行没有冻结证据）".into());
    }
    if let Some(snapshot) = snapshot {
        let changes = snapshot
            .changes
            .iter()
            .map(|change| TaskOutputChangeDto {
                path: change.path.clone(),
                kind: change.kind.clone(),
                bytes: change.size,
            })
            .collect();
        return Ok(TaskReviewDto {
            frozen: true,
            payload_dir: Some(dir.join("payload").to_string_lossy().into_owned()),
            changes,
        });
    }
    // 旧 Run 或冻结失败：退回目录现算，由前端明示「未冻结」。
    Ok(TaskReviewDto {
        frozen: false,
        payload_dir: None,
        changes: list_output_changes(Path::new(&run.isolation_path), Path::new(&root), &task.output_paths)?,
    })
}

#[tauri::command]
pub async fn task_output_changes(run_id: String) -> Result<TaskReviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_output_changes_impl(&run_id))
        .await
        .map_err(|e| format!("读取任务变更失败：{e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContextDto {
    pub run_id: String,
    pub created_at: String,
    pub sha256: String,
    pub text: String,
}

/// 开工时冻结的有效上下文快照（§4.8）；旧 Run / 未下发快照返回 None。
#[tauri::command]
pub async fn task_run_context(run_id: String) -> Result<Option<TaskContextDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db()?;
        let run = get_run_at(&conn, &run_id)?.ok_or("Run 不存在")?;
        if run.task_id.is_empty() {
            return Ok(None);
        }
        let dir = task_review_dir(&run.task_id, &run.id)?;
        crate::task_review::load_context_snapshot(&dir).map(|snapshot| {
            snapshot.map(|snapshot| TaskContextDto {
                run_id: snapshot.run_id,
                created_at: snapshot.created_at,
                sha256: snapshot.sha256,
                text: snapshot.text,
            })
        })
    })
    .await
    .map_err(|e| format!("读取上下文快照失败：{e}"))?
}

fn task_adopt_outputs_impl(
    run_id: &str,
    paths: Option<Vec<String>>,
    note: Option<String>,
) -> Result<TaskDto, String> {
    let conn = db()?;
    let run = get_run_at(&conn, run_id)?.ok_or("Run 不存在")?;
    let task = task_by_id(&conn, &run.task_id)?;
    let root = validate_existing_dir(
        task.project_root.as_deref().ok_or("Task 没有关联项目")?,
        "项目根目录",
    )?;
    let dir = task_review_dir(&task.id, &run.id)?;
    let snapshot = crate::task_review::load_snapshot(&dir)?;
    // 有冻结证据的 Run 不看进程退出状态（部分成果同样可采纳）；未冻结的旧 Run 维持 completed 门槛
    if run.status != "completed" && snapshot.is_none() {
        return Err("只有已完成的 Run 才能采纳输出（这次运行没有冻结证据）".into());
    }
    // 可采纳集合：已冻结 = 快照里 added/modified 且未超上限的；未冻结（旧 Run/冻结失败）退回目录现算。
    let available: Vec<String> = match &snapshot {
        Some(snapshot) => snapshot
            .changes
            .iter()
            .filter(|change| change.kind != "deleted" && !change.too_large)
            .map(|change| change.path.clone())
            .collect(),
        None => list_output_changes(Path::new(&run.isolation_path), Path::new(&root), &task.output_paths)?
            .iter()
            .map(|change| change.path.clone())
            .collect(),
    };
    let selected = match paths {
        None => available.clone(),
        Some(list) if list.is_empty() => Vec::new(),
        Some(list) => {
            let allowed: std::collections::HashSet<_> = available.iter().cloned().collect();
            let mut selected = Vec::new();
            for raw in list {
                let relative = validate_output_rel(&raw)?;
                if !allowed.contains(&relative) {
                    return Err(format!("没有可采纳的变更：{relative}"));
                }
                if !selected.contains(&relative) {
                    selected.push(relative);
                }
            }
            selected
        }
    };
    // 保护路径读不出来 = 不可信，fail-closed 拒绝写回，不按「没有保护」继续复制
    let protected = crate::projects::protected_paths_at(Path::new(&root))?;
    for relative in &selected {
        if crate::projects::path_is_protected(relative, &protected) {
            return Err(format!("保护路径不可覆盖：{relative}"));
        }
        let target = Path::new(&root).join(relative);
        if let Some(mut probe) = target.parent() {
            while !probe.exists() {
                probe = probe.parent().ok_or("输出目标无法解析")?;
            }
            let parent = crate::paths::canonicalize_plain(probe)
                .map_err(|e| format!("输出目标无法解析：{e}"))?;
            if !crate::paths::path_within(&parent.to_string_lossy(), &root) {
                return Err("输出目标必须位于项目目录内".into());
            }
        }
    }
    if let Some(snapshot) = &snapshot {
        // 冻结路径：三向判定（项目现读 vs 开工基线 vs 冻结内容），写入源只认 payload 副本；
        // 「看过的版本」与「写入的版本」由此逐字节绑定。
        let baseline = crate::task_review::load_baseline(&dir)?;
        let planned =
            crate::task_review::check_adoption(&dir, snapshot, baseline.as_ref(), &selected, Path::new(&root))?;
        let planned_paths: Vec<String> = planned.iter().map(|(path, _)| path.clone()).collect();
        adopt_selected_files(run_id, &dir.join("payload"), Path::new(&root), &planned_paths)?;
    } else {
        adopt_selected_files(run_id, Path::new(&run.isolation_path), Path::new(&root), &selected)?;
    }
    // 文件已写入项目。长期接受账本必须落盘：失败要可诊断、可恢复——
    // 返回错误引导重试（重试幂等：已写入的文件自动跳过，账本按 run_id 去重）。
    let note = note.unwrap_or_default();
    let entry = crate::projects::AcceptanceLogEntry {
        goal_id: task.id.clone(),
        goal_name: task.name.clone(),
        run_id: run_id.to_string(),
        paths: selected.clone(),
        note: note.clone(),
        frozen: snapshot.is_some(),
        decided_at: now_rfc3339(),
    };
    if let Err(error) = crate::projects::append_acceptance_log_at(Path::new(&root), &entry) {
        crate::logbuf::record(
            "error",
            "runs",
            &format!("Run {run_id} 验收记录落盘失败：{error}"),
        );
        let _ = record_event(&conn, run_id, "task.accept_record_failed", Some(&error));
        return Err(format!(
            "文件已写入项目，但验收记录落盘失败：{error}。请再执行一次采纳以补记（已写入的文件会自动跳过）。"
        ));
    }
    conn.execute(
        "UPDATE tasks SET status='completed', adopted_paths=?3, updated_at=?2 WHERE id=?1",
        params![task.id, now_rfc3339(), task_json_paths(&selected)?],
    )
    .map_err(|e| format!("更新 Task 完成状态失败：{e}"))?;
    record_event(
        &conn,
        run_id,
        "task.outputs_adopted",
        Some(&serde_json::json!({"taskId": task.id, "paths": selected, "frozen": snapshot.is_some()}).to_string()),
    )?;
    // project-status.json 是账本的「最近摘要」投影；失败不再静默吞掉，记日志与事件供诊断。
    if let Err(error) =
        crate::projects::record_accepted_goal_at(Path::new(&root), &task.name, &selected, &note)
    {
        crate::logbuf::record(
            "error",
            "runs",
            &format!("Run {run_id} 验收摘要写入失败：{error}"),
        );
        let _ = record_event(&conn, run_id, "task.accept_summary_failed", Some(&error));
    }
    task_by_id(&conn, &run.task_id)
}

#[tauri::command]
pub async fn task_adopt_outputs(
    run_id: String,
    paths: Option<Vec<String>>,
    note: Option<String>,
) -> Result<TaskDto, String> {
    tauri::async_runtime::spawn_blocking(move || task_adopt_outputs_impl(&run_id, paths, note))
        .await
        .map_err(|e| format!("采纳输出失败：{e}"))?
}
#[tauri::command]
pub fn task_list(project_root: Option<String>) -> Result<Vec<TaskDto>, String> {
    let conn = db()?;
    let mut stmt = conn.prepare(&format!("SELECT {TASK_COLS} FROM tasks WHERE ?1 IS NULL OR project_root=?1 ORDER BY updated_at DESC")).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_root], map_task)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn task_delete(id: String) -> Result<(), String> {
    let conn = db()?;
    let task = task_by_id(&conn, &id)?;
    if !task.declared {
        return Err("只能删除你记下的目标".into());
    }
    if task.kind != "free_research" && task.kind != "office_doc" {
        return Err("只能删除科研或工作目标".into());
    }
    if task.status == "running" {
        return Err("先停掉正在跑的 Agent，再删这个目标".into());
    }
    let open = query_runs(
        &conn,
        "WHERE task_id=?1 AND closed_at IS NULL AND internal=0 LIMIT 1",
        [&task.id],
    )?;
    if !open.is_empty() {
        return Err("先停掉正在跑的 Agent，再删这个目标".into());
    }
    conn.execute(
        "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id=?1)",
        [&task.id],
    )
    .map_err(|e| format!("清理目标记录失败: {e}"))?;
    conn.execute("DELETE FROM runs WHERE task_id=?1", [&task.id])
        .map_err(|e| format!("清理目标记录失败: {e}"))?;
    conn.execute("DELETE FROM tasks WHERE id=?1", [&task.id])
        .map_err(|e| format!("删除目标失败: {e}"))?;
    if let Ok(dir) = task_runs_root() {
        let isolation = dir.join(&task.id);
        if isolation.is_dir() {
            let _ = fs::remove_dir_all(&isolation);
        }
    }
    // 删除目标只清工作数据（Run/事件/隔离目录）；验收来源不动：
    // acceptance-log.jsonl 是长期账本，project-status.json 摘要里被接受的产出
    // 仍真实存在于项目中，不能因为目标条目没了就抹掉「它从哪来」。
    Ok(())
}

#[tauri::command]
pub fn task_get(id: String) -> Result<Option<TaskDto>, String> {
    db()?
        .query_row(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"),
            [id],
            map_task,
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub fn runtime_capabilities(runtime: &str) -> crate::runtime::RuntimeCapabilities {
    crate::runtime::RuntimeKind::parse(runtime)
        .map(crate::runtime::capabilities)
        .unwrap_or_else(|| crate::runtime::capabilities(crate::runtime::RuntimeKind::Custom))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    pub id: String,
    pub project_root: Option<String>,
    pub task_kind: String,
    pub task_ref: Option<String>,
    pub isolation_path: String,
    pub runtime: String,
    pub agent: String,
    pub profile_id: Option<String>,
    pub permission: String,
    pub reuse_key: Option<String>,
    pub session_id: Option<String>,
    pub internal: bool,
    pub sentinel: bool,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub close_reason: Option<String>,
    pub task_id: String,
    pub custom_runtime_id: Option<String>,
    pub capabilities: crate::runtime::RuntimeCapabilities,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRunInput {
    pub id: Option<String>,
    pub task_id: Option<String>,
    pub project_root: Option<String>,
    pub task_kind: Option<String>,
    pub task_ref: Option<String>,
    pub isolation_path: String,
    pub runtime: Option<String>,
    pub agent: String,
    pub profile_id: Option<String>,
    pub permission: Option<String>,
    pub reuse_key: Option<String>,
    pub session_id: Option<String>,
    pub custom_runtime_id: Option<String>,
    pub internal: Option<bool>,
    pub sentinel: Option<bool>,
}
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunDto> {
    let runtime: String = row.get(5)?;
    Ok(RunDto {
        id: row.get(0)?,
        project_root: row.get(1)?,
        task_kind: row.get(2)?,
        task_ref: row.get(3)?,
        isolation_path: row.get(4)?,
        capabilities: runtime_capabilities(&runtime),
        runtime,
        agent: row.get(6)?,
        profile_id: row.get(7)?,
        permission: row.get(8)?,
        reuse_key: row.get(9)?,
        session_id: row.get(10)?,
        internal: row.get::<_, i64>(11)? != 0,
        sentinel: row.get::<_, i64>(12)? != 0,
        created_at: row.get(13)?,
        closed_at: row.get(14)?,
        status: row.get(15)?,
        exit_code: row.get(16)?,
        close_reason: row.get(17)?,
        task_id: row.get::<_, Option<String>>(18)?.unwrap_or_default(),
        custom_runtime_id: row.get(19)?,
    })
}
const COLS: &str = "id,project_root,task_kind,task_ref,isolation_path,runtime,agent,profile_id,permission,reuse_key,session_id,internal,sentinel,created_at,closed_at,status,exit_code,close_reason,task_id,custom_runtime_id";
fn query_runs<P: rusqlite::Params>(
    conn: &Connection,
    clause: &str,
    p: P,
) -> Result<Vec<RunDto>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM runs {clause}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(p, map_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
fn get_run_at(conn: &Connection, id: &str) -> Result<Option<RunDto>, String> {
    conn.query_row(
        &format!("SELECT {COLS} FROM runs WHERE id=?1"),
        [id],
        map_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}
pub(crate) fn validate_existing_dir(path: &str, label: &str) -> Result<String, String> {
    let expanded = crate::sessions::expand_tilde(path);
    if !std::path::Path::new(&expanded).is_dir() {
        return Err(format!("{label} 必须是已存在的目录: {expanded}"));
    }
    crate::paths::canonicalize_plain(std::path::Path::new(&expanded))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("{label} 无法解析: {e}"))
}
fn requires_isolated_write_tree(kind: &str, sentinel: bool) -> bool {
    !sentinel && matches!(kind, "pipeline_step" | "coding_lane" | "watch")
}

fn validate_policy(input: &OpenRunInput) -> Result<(), String> {
    let kind = input.task_kind.as_deref().unwrap_or("scratch");
    let runtime = input.runtime.as_deref().unwrap_or("local_cli");
    let permission = input.permission.as_deref().unwrap_or("write_tree");
    if !matches!(runtime, "local_cli" | "headless" | "custom") {
        return Err("不支持的 Runtime".into());
    }
    if runtime == "custom" {
        let id = input
            .custom_runtime_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or("Custom Runtime 必须绑定已保存的运行时配置")?;
        crate::custom_runtime::get_custom_runtime(id)?;
    } else if input.custom_runtime_id.is_some() {
        return Err("只有 Custom Runtime 可以绑定自定义运行时配置".into());
    }
    if !matches!(permission, "discuss" | "write_tree") {
        return Err("不支持的权限政策".into());
    }
    if runtime == "local_cli" && permission == "discuss" && crate::agents::readonly_launch_args(&input.agent, &[]).is_none() {
        return Err("此 Agent 不支持只讨论权限，请更换 Agent 或明确选择可写权限".into());
    }

    if !matches!(
        kind,
        "pipeline_step"
            | "coding_lane"
            | "office_doc"
            | "free_research"
            | "watch"
            | "reader"
            | "scratch"
    ) {
        return Err("不支持的 Task 类型".into());
    }
    if input.sentinel.unwrap_or(false) && (kind != "watch" || runtime != "headless") {
        return Err("只有定时无头任务可以声明主仓哨兵".into());
    }
    if permission == "write_tree"
        && requires_isolated_write_tree(kind, input.sentinel.unwrap_or(false))
    {
        let root = input
            .project_root
            .as_deref()
            .ok_or("无法确定所属项目，拒绝启动写盘任务")?;
        if crate::paths::path_within(&input.isolation_path, root) {
            return Err("写盘任务必须进入主仓之外的隔离工作树，不得回落主仓".into());
        }
    }
    Ok(())
}
pub fn open_run_impl(mut input: OpenRunInput) -> Result<RunDto, String> {
    input.isolation_path = validate_existing_dir(&input.isolation_path, "隔离路径")?;
    if let Some(key) = input.reuse_key.take() {
        let key = canonicalize_reuse_key(&key);
        input.reuse_key = if key.is_empty() { None } else { Some(key) };
    }
    let reuse = input.reuse_key.as_deref().unwrap_or("");
    // 恢复已有 Run（带 id）时不重新猜测身份：按 reuseKey/路径推出的 kind/ref/root
    // 与已登记值稍有出入（声明目标是 free_research + 目标名，路径只能推出
    // scratch/目录名）就会被 open_at 的身份校验拒掉。推断只服务新建。
    if input.id.is_none() {
        input.project_root = input
            .project_root
            .or_else(|| infer_project_root(reuse, &input.isolation_path))
            .map(|p| validate_existing_dir(&p, "项目根目录"))
            .transpose()?;
        input.task_kind = Some(
            input
                .task_kind
                .unwrap_or_else(|| infer_task_kind(reuse, &input.isolation_path).into()),
        );
        // 无显式 taskRef 时以完整隔离路径命名，避免同项目下同名文件/车道串 Task。
        input.task_ref = input.task_ref.or_else(|| {
            if reuse.starts_with("watch:") {
                infer_task_ref(reuse, &input.isolation_path)
            } else if reuse.starts_with("office:") {
                Some(reuse.into())
            } else {
                Some(input.isolation_path.clone())
            }
        });
    }
    validate_policy(&input)?;
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let run = open_at(&tx, input)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(run)
}
fn open_at(conn: &Connection, input: OpenRunInput) -> Result<RunDto, String> {
    let runtime = input.runtime.as_deref().unwrap_or("local_cli");
    let kind = input.task_kind.as_deref().unwrap_or("scratch");
    let reuse = input.reuse_key.as_deref().filter(|s| !s.trim().is_empty());
    let internal = input.internal.unwrap_or(false)
        || runtime == "headless"
        || is_internal_kind(kind, reuse.unwrap_or(""));
    if let Some(id) = &input.id {
        if let Some(existing) = get_run_at(conn, id)? {
            if existing.runtime != runtime
                || existing.agent != input.agent
                || existing.isolation_path != input.isolation_path
                || existing.custom_runtime_id
                    != input
                        .custom_runtime_id
                        .as_deref()
                        .filter(|id| !id.trim().is_empty())
                        .map(str::to_owned)
                || input
                    .project_root
                    .as_deref()
                    .is_some_and(|root| existing.project_root.as_deref() != Some(root))
                || input
                    .task_kind
                    .as_deref()
                    .is_some_and(|kind| existing.task_kind != kind)
                || input
                    .task_ref
                    .as_deref()
                    .is_some_and(|task_ref| existing.task_ref.as_deref() != Some(task_ref))
                || input
                    .permission
                    .as_deref()
                    .is_some_and(|permission| existing.permission != permission)
                || input
                    .task_id
                    .as_deref()
                    .is_some_and(|task_id| existing.task_id != task_id)
            {
                return Err("Run 身份与启动目标不一致，不能改写已有 Run".into());
            }
            if existing.closed_at.is_none() {
                return Ok(existing);
            }
            if !existing.capabilities.can_resume || input.session_id.is_none() {
                return Err("此 Run 不支持恢复；请从任务入口再次运行".into());
            }
            if existing.session_id.as_deref() != input.session_id.as_deref() {
                return Err("恢复会话与原 Run 不一致；请从原会话入口恢复".into());
            }
            conn.execute("UPDATE runs SET status='created',closed_at=NULL,exit_code=NULL,close_reason=NULL,profile_id=?2 WHERE id=?1", params![id,input.profile_id]).map_err(|e| e.to_string())?;
            record_event(conn, id, "run.resumed", None)?;
            return get_run_at(conn, id)?.ok_or("Run 不存在".into());
        }
        return Err("Run 不存在；不能用失效 id 创建另一条任务".into());
    }
    if !internal {
        if let Some(key) = reuse {
            if let Some(run) = query_runs(conn, "WHERE reuse_key=?1 AND closed_at IS NULL AND internal=0 ORDER BY created_at DESC LIMIT 1", [key])?.into_iter().next() {
                if run.agent != input.agent || run.runtime != runtime || run.isolation_path != input.isolation_path
                    || input.permission.as_deref().is_some_and(|p| run.permission != p) {
                    return Err("此任务已有活跃 Run，请先停止它再更换执行体".into());
                }
                return Ok(run);
            }
        }
    }
    let task = if let Some(task_id) = input.task_id.as_deref() {
        let task = conn
            .query_row(
                &format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"),
                [task_id],
                map_task,
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("Task 不存在")?;
        if input
            .project_root
            .as_deref()
            .is_some_and(|root| task.project_root.as_deref() != Some(root))
        {
            return Err("Task 与项目不匹配".into());
        }
        if task.kind != kind {
            return Err("Task 类型与 Run 不匹配".into());
        }
        Some(task)
    } else if run_needs_task(kind) {
        Some(ensure_task_at(
            conn,
            input.project_root.as_deref(),
            kind,
            input.task_ref.as_deref(),
            &input.isolation_path,
        )?)
    } else {
        // Run 可以没有 Goal（§4.7）：随手聊/阅读/办公文件闲聊不是目标，不再强制登记 Task 行
        None
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    conn.execute("INSERT INTO runs(id,project_root,task_kind,task_ref,isolation_path,runtime,agent,profile_id,permission,reuse_key,session_id,internal,sentinel,created_at,status,task_id,custom_runtime_id)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'created',?15,?16)",
        params![id,input.project_root,kind,input.task_ref,input.isolation_path,runtime,input.agent,input.profile_id,
            input.permission.unwrap_or_else(|| "write_tree".into()),reuse,input.session_id,internal,input.sentinel.unwrap_or(false),now,task.as_ref().map(|task| task.id.clone()),input.custom_runtime_id])
        .map_err(|e| e.to_string())?;
    if let Some(task) = &task {
        conn.execute(
            "UPDATE tasks SET updated_at=?2 WHERE id=?1",
            params![task.id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    record_event(conn, &id, "run.created", None)?;
    get_run_at(conn, &id)?.ok_or("Run 写入后读回失败".into())
}
fn claim_at(conn: &Connection, id: &str) -> Result<(), String> {
    let n = conn.execute("UPDATE runs SET status='starting' WHERE id=?1 AND status='created' AND closed_at IS NULL",[id]).map_err(|e| e.to_string())?;
    if n != 1 {
        return Err("Run 已启动或已结束，拒绝重复创建进程".into());
    }
    record_event(conn, id, "run.start_requested", None)
}
fn leases() -> &'static std::sync::Mutex<std::collections::HashMap<String, fs::File>> {
    static LEASES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, fs::File>>> = std::sync::OnceLock::new();
    LEASES.get_or_init(Default::default)
}

fn lease_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir().ok_or("无法确定配置目录")?.join("ccode/run-leases"))
}

fn try_run_lease(dir: &Path, id: &str) -> Result<Option<fs::File>, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{:x}.lock", md5::compute(id.as_bytes())));
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(path).map_err(|e| format!("打开运行锁失败：{e}"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(format!("取得运行锁失败：{error}")),
    }
}

pub fn claim_start(id: &str) -> Result<(), String> {
    let mut leases = leases().lock().unwrap_or_else(|e| e.into_inner());
    if leases.contains_key(id) { return Err("此运行已在启动或执行中".into()); }
    let lease = try_run_lease(&lease_dir()?, id)?.ok_or("此运行正在另一个实例执行")?;
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    claim_at(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    leases.insert(id.to_string(), lease);
    Ok(())
}
pub fn mark_started(id: &str) -> Result<(), String> {
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let changed = tx.execute("UPDATE runs SET status='running' WHERE id=?1 AND status='starting' AND closed_at IS NULL",[id]).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Run 未处于 starting 状态，不能标记为 running".into());
    }
    record_event(&tx,id,"run.started",None)?;
    tx.commit().map_err(|e| e.to_string())
}
fn close_at(
    conn: &Connection,
    id: &str,
    session: Option<&str>,
    status: &str,
    code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    if !matches!(status, "completed" | "failed" | "stopped") {
        return Err("无效的 Run 结束状态".into());
    }
    let reason = reason.map(crate::sessions::redact_sensitive_text);
    let task_meta: Option<(String, bool)> = conn
        .query_row(
            "SELECT t.id, t.review_required
             FROM runs r JOIN tasks t ON t.id=r.task_id
             WHERE r.id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let changed = conn.execute("UPDATE runs SET closed_at=?2,session_id=COALESCE(?3,session_id),status=?4,exit_code=?5,close_reason=?6 WHERE id=?1 AND closed_at IS NULL",
        params![id,now_rfc3339(),session,status,code,reason]).map_err(|e| e.to_string())?;
    if changed > 0 {
        if let Some((task_id, review_required)) = task_meta {
            let task_status = match status {
                "completed" if review_required => "pending_review",
                "completed" => "completed",
                "failed" => "failed",
                "stopped" => "stopped",
                _ => "pending",
            };
            conn.execute(
                "UPDATE tasks SET status=?2, updated_at=?3 WHERE id=?1",
                params![task_id, task_status, now_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        }
        record_event(
            conn,
            id,
            &format!("run.{status}"),
            Some(&serde_json::json!({"exitCode":code,"reason":reason}).to_string()),
        )?;
    }
    Ok(())
}
pub fn close_run_impl(id: &str, session: Option<&str>) -> Result<(), String> {
    close_run_with_result(id, session, "completed", None, None)
}
pub fn close_run_with_result(
    id: &str,
    session: Option<&str>,
    status: &str,
    code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    let outcome = (|| {
        let mut conn = db()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        close_at(&tx, id, session, status, code, reason)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })();
    // 进程侧已经结束时必须放开存活锁，否则账本失败会把 Run 钉在「仍在运行」。
    leases().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    crate::coding::clear_lane_current_run(id);
    freeze_task_run_evidence(id);
    if let Err(error) = &outcome {
        crate::logbuf::record(
            "error",
            "runs",
            &format!("Run {id} 已结束，但账本登记失败：{error}"),
        );
    }
    outcome
}
pub fn attach_session_impl(id: &str, session_id: &str) -> Result<(), String> {
    let conn = db()?;
    let existing: Option<Option<String>> = conn
        .query_row("SELECT session_id FROM runs WHERE id=?1", [id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(existing_session) = existing else {
        return Err("Run 不存在".into());
    };
    if let Some(existing_session) = existing_session {
        if existing_session != session_id {
            return Err("Run 已绑定另一会话，拒绝改写会话身份".into());
        }
        return Ok(());
    }
    if conn
        .execute(
            "UPDATE runs SET session_id=?2 WHERE id=?1 AND session_id IS NULL",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?
        > 0
    {
        record_event(&conn, id, "run.session_attached", None)?;
    }
    Ok(())
}
const OUTPUT_EVENT_CAP: usize = 100;

fn output_tail(text: &str) -> String {
    // 末尾未完成 token 留到下一批；不把跨块密钥前半段当独立文本持久化。
    let end = text.rfind(char::is_whitespace).unwrap_or(0);
    let redacted = crate::sessions::redact_sensitive_text(&text[..end]);
    redacted.chars().rev().take(2000).collect::<String>().chars().rev().collect()
}

fn persist_output(conn: &Connection, id: &str, text: &str) -> Result<(), String> {
    let tail = output_tail(text);
    if tail.is_empty() { return Ok(()); }
    record_event(conn, id, "run.output", Some(&tail))?;
    conn.execute("DELETE FROM run_events WHERE event_type='run.output' AND run_id=?1 AND rowid NOT IN (SELECT rowid FROM run_events WHERE event_type='run.output' AND run_id=?1 ORDER BY rowid DESC LIMIT ?2)", params![id, OUTPUT_EVENT_CAP as i64]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM run_events WHERE event_type='run.output' AND rowid NOT IN (SELECT rowid FROM run_events WHERE event_type='run.output' ORDER BY rowid DESC LIMIT 10000)", []).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_output(id: &str, text: &str) -> Result<(), String> {
    use std::sync::{OnceLock, mpsc};
    static OUTPUT: OnceLock<mpsc::SyncSender<(String, String)>> = OnceLock::new();
    let send = OUTPUT.get_or_init(|| {
        let (send, receive) = mpsc::sync_channel::<(String, String)>(128);
        std::thread::spawn(move || {
            let mut conn = None;
            let mut pending: std::collections::HashMap<String, String> = Default::default();
            loop {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
                while let Ok((id, text)) = receive.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                    if pending.len() >= 64 && !pending.contains_key(&id) { continue; }
                    let buffer = pending.entry(id).or_default();
                    buffer.push_str(&text);
                    if buffer.len() > 65536 {
                        let start = buffer.len() - 32768;
                        let start = buffer.char_indices().find(|(i, c)| *i >= start && c.is_whitespace()).map(|(i, c)| i+c.len_utf8()).unwrap_or(buffer.len());
                        buffer.drain(..start);
                    }
                    if std::time::Instant::now() >= deadline { break; }
                }
                if pending.is_empty() { continue; }
                if conn.is_none() { conn = db().ok(); }
                if let Some(db) = &conn {
                    let _ = db.busy_timeout(std::time::Duration::from_millis(250));
                    for (id, text) in &mut pending {
                        let _ = persist_output(db, id, text);
                        let end = text.char_indices().rev().find(|(_, c)| c.is_whitespace()).map(|(i, c)| i+c.len_utf8()).unwrap_or(0);
                        text.drain(..end);
                    }
                    pending.retain(|_, text| !text.is_empty());
                } else { pending.clear(); }
            }
        });
        send
    });
    // 拥堵时只丢诊断副本，不阻塞/丢失实际终端输出。
    let _ = send.try_send((id.into(), text.into()));
    Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventDto {
    id: String,
    run_id: String,
    event_type: String,
    payload: Option<String>,
    created_at: String,
}
fn map_run_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunEventDto> {
    Ok(RunEventDto {
        id: r.get(0)?,
        run_id: r.get(1)?,
        event_type: r.get(2)?,
        payload: r.get(3)?,
        created_at: r.get(4)?,
    })
}

#[tauri::command]
pub fn run_events(id: String) -> Result<Vec<RunEventDto>, String> {
    let conn = db()?;
    let mut stmt = conn.prepare("SELECT id,run_id,event_type,payload,created_at FROM run_events WHERE run_id=?1 ORDER BY rowid").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], map_run_event)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn task_goal_events(project_root: Option<String>) -> Result<Vec<RunEventDto>, String> {
    let conn = db()?;
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.run_id, e.event_type, e.payload, e.created_at
             FROM run_events e
             INNER JOIN runs r ON r.id = e.run_id
             WHERE (?1 IS NULL OR r.project_root=?1)
               AND e.event_type IN ('task.review_notes', 'task.outputs_adopted')
             ORDER BY e.rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_root], map_run_event)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// 应用启动时收口上次崩溃留下的未闭合 Run；正常运行期间不调用，避免误伤活跃进程。
pub fn reconcile_stale_runs() -> Result<usize, String> {
    let mut conn = db()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare("SELECT id FROM runs WHERE closed_at IS NULL AND status IN ('starting','running')")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let closed = reconcile_ids(&tx, &lease_dir()?, &ids)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(closed)
}
fn reconcile_ids(conn: &Connection, dir: &Path, ids: &[String]) -> Result<usize, String> {
    let mut closed = 0;
    for id in ids {
        // 只有确实无人持有的 Run 才是陈旧运行；OS 锁随进程退出释放。
        let Some(_lease) = try_run_lease(dir, id)? else { continue; };
        close_at(conn, id, None, "failed", None, Some("应用上次异常退出，Run 未能正常收尾"))?;
        closed += 1;
    }
    Ok(closed)
}

#[tauri::command]
pub fn run_open(input: OpenRunInput) -> Result<RunDto, String> {
    open_run_impl(input)
}
#[tauri::command]
pub fn run_get(id: String) -> Result<Option<RunDto>, String> {
    get_run_at(&db()?, &id)
}
#[tauri::command]
pub fn run_list(project_root: Option<String>) -> Result<Vec<RunDto>, String> {
    query_runs(
        &db()?,
        "WHERE ?1 IS NULL OR project_root=?1 ORDER BY created_at DESC LIMIT 500",
        [project_root],
    )
}
pub(crate) fn has_active_run_in(path: &str) -> Result<bool, String> {
    Ok(query_runs(&db()?, "WHERE closed_at IS NULL AND status IN ('starting','running')", [])?
        .iter().any(|r| crate::paths::path_within(&r.isolation_path, path)))
}
// 仅入口允许用旧键查身份，页面之间绝不传 tabId/reuseKey。
#[tauri::command]
pub fn run_find(
    reuse_key: Option<String>,
    agent: Option<String>,
    session_id: Option<String>,
) -> Result<Option<RunDto>, String> {
    Ok(query_runs(&db()?,"WHERE (?1 IS NOT NULL AND reuse_key=?1 AND closed_at IS NULL) OR (?2 IS NOT NULL AND agent=?2 AND session_id=?3) ORDER BY created_at DESC LIMIT 1",
        params![reuse_key,agent,session_id])?.into_iter().next())
}
#[tauri::command]
pub async fn active_background_runs() -> Result<Vec<RunDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let conn = db()?;
        let mut out = Vec::new();
        for id in crate::process::active_capture_ids() {
            if let Some(run) = get_run_at(&conn, &id)? { if run.runtime == "headless" { out.push(run); } }
        }
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn run_cancel(id: String) -> Result<(), String> {
    let run = run_get(id.clone())?.ok_or("Run 不存在")?;
    if run.runtime != "headless" { return Err("交互终端请使用终端停止按钮".into()); }
    crate::process::cancel_capture(&id)
}

#[tauri::command]
pub fn run_close(
    id: String,
    session_id: Option<String>,
    status: Option<String>,
    exit_code: Option<i32>,
    reason: Option<String>,
) -> Result<(), String> {
    close_run_with_result(
        &id,
        session_id.as_deref(),
        status.as_deref().unwrap_or("stopped"),
        exit_code,
        reason.as_deref(),
    )
}
#[tauri::command]
pub fn run_attach_session(id: String, session_id: String) -> Result<(), String> {
    attach_session_impl(&id, &session_id)
}

pub fn open_for_interactive_spawn(
    agent: &str,
    profile: &str,
    cwd: &str,
    reuse: Option<&str>,
    session: Option<&str>,
    readonly: bool,
    existing_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Option<RunDto>, String> {
    if reuse.unwrap_or("").starts_with("login:") {
        return Ok(None);
    }
    let task_context = task_id
        .and_then(|id| db().ok().and_then(|conn| task_by_id(&conn, id).ok()));
    let dto = open_run_impl(OpenRunInput {
        id: existing_id.map(Into::into),
        task_id: task_id.map(Into::into),
        project_root: task_context
            .as_ref()
            .and_then(|task| task.project_root.clone()),
        task_kind: task_context.as_ref().map(|task| task.kind.clone()),
        task_ref: task_context.as_ref().map(|task| task.name.clone()),
        isolation_path: cwd.into(),
        runtime: Some("local_cli".into()),
        agent: agent.into(),
        profile_id: Some(profile.into()),
        permission: Some(if readonly { "discuss" } else { "write_tree" }.into()),
        reuse_key: reuse.map(Into::into),
        session_id: session.map(Into::into),
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    })?;
    if dto.task_kind == "coding_lane" {
        crate::coding::touch_lane_current_run(cwd, &dto.id);
    }
    Ok(Some(dto))
}
pub fn open_headless(
    agent: &str,
    profile: &str,
    cwd: &str,
    reuse: &str,
    sentinel: bool,
    permission: &str,
) -> Result<RunDto, String> {
    open_headless_with_root(None, agent, profile, cwd, reuse, sentinel, permission)
}
pub fn open_headless_with_root(
    project_root: Option<&str>,
    agent: &str,
    profile: &str,
    cwd: &str,
    reuse: &str,
    sentinel: bool,
    permission: &str,
) -> Result<RunDto, String> {
    open_run_impl(OpenRunInput {
        id: None,
        task_id: None,
        project_root: project_root.map(str::to_owned),
        task_kind: None,
        task_ref: None,
        isolation_path: cwd.into(),
        runtime: Some("headless".into()),
        agent: agent.into(),
        profile_id: Some(profile.into()),
        permission: Some(permission.into()),
        reuse_key: Some(reuse.into()),
        session_id: None,
        custom_runtime_id: None,
        internal: Some(true),
        sentinel: Some(sentinel),
    })
}
#[tauri::command]
pub fn run_open_custom(
    cwd: String,
    reuse_key: String,
    run_id: Option<String>,
    custom_runtime_id: Option<String>,
) -> Result<RunDto, String> {
    let runtime_id = custom_runtime_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or("Custom Runtime 必须绑定已保存的运行时配置")?;
    let runtime = crate::custom_runtime::get_custom_runtime(runtime_id)?;
    let cwd = crate::custom_runtime::resolve_custom_cwd(&cwd, runtime.cwd.as_deref())?;
    let dto = open_run_impl(OpenRunInput {
        id: run_id,
        task_id: None,
        project_root: None,
        task_kind: None,
        task_ref: Some(cwd.clone()),
        isolation_path: cwd.clone(),
        runtime: Some("custom".into()),
        agent: "custom".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: Some(reuse_key),
        session_id: None,
        custom_runtime_id,
        internal: Some(false),
        sentinel: Some(false),
    })?;
    if dto.task_kind == "coding_lane" {
        crate::coding::touch_lane_current_run(&cwd, &dto.id);
    }
    Ok(dto)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_events_are_bounded_without_deleting_lifecycle_events() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        record_event(&conn, "r", "run.started", None).unwrap();
        for i in 0..OUTPUT_EVENT_CAP + 5 { persist_output(&conn, "r", &format!("line {i}\n")).unwrap(); }
        let count: i64 = conn.query_row("SELECT count(*) FROM run_events WHERE run_id='r' AND event_type='run.output'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, OUTPUT_EVENT_CAP as i64);
        let lifecycle: i64 = conn.query_row("SELECT count(*) FROM run_events WHERE event_type='run.started'", [], |r| r.get(0)).unwrap();
        assert_eq!(lifecycle, 1);
        assert!(output_tail("sk-partial").is_empty());
        assert!(!output_tail("sk-supersecrettoken123456\n").contains("sk-supersecrettoken"));
    }

    #[test]
    fn run_lease_distinguishes_live_from_stale_and_releases_on_drop() {
        let dir = std::env::temp_dir().join(format!("ccode-run-lease-{}", uuid::Uuid::new_v4()));
        let live = try_run_lease(&dir, "run1").unwrap().unwrap();
        assert!(try_run_lease(&dir, "run1").unwrap().is_none());
        assert!(try_run_lease(&dir, "run2").unwrap().is_some());
        drop(live);
        assert!(try_run_lease(&dir, "run1").unwrap().is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn review_status_promotes_failed_run_only_with_adoptable_changes() {        // 失败/停止 + 有可审成果 → 待验收；没有成果保持原状；completed 不走这条提升
        assert_eq!(review_status_for("failed", true), Some("pending_review"));
        assert_eq!(review_status_for("stopped", true), Some("pending_review"));
        assert_eq!(review_status_for("failed", false), None);
        assert_eq!(review_status_for("stopped", false), None);
        assert_eq!(review_status_for("completed", true), None);
        assert_eq!(review_status_for("running", true), None);
    }

    #[test]
    fn failed_prepare_cleanup_never_deletes_reused_isolation_dir() {        let base = std::env::temp_dir().join(format!("ccode-prepare-cleanup-{}", uuid::Uuid::new_v4()));
        let reused = base.join("reused");
        let staging = base.join("staging");
        fs::create_dir_all(&reused).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(reused.join("draft.md"), "旧成果").unwrap();
        // 复用上一版目录（reuse_isolation=true）：启动失败不得删旧成果
        cleanup_failed_prepare(false, &reused);
        assert!(reused.join("draft.md").is_file());
        // 本次新建的 staging：失败时照常清理
        cleanup_failed_prepare(true, &staging);
        assert!(!staging.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn startup_reconciliation_skips_live_run_and_closes_stale_run() {
        let dir = std::env::temp_dir().join(format!("ccode-run-reconcile-{}", uuid::Uuid::new_v4()));
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','task','scratch','task','now','now')", []).unwrap();
        for id in ["live", "stale"] {
            conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES(?1,'task','scratch','/tmp','local_cli','test','discuss','now','running')", [id]).unwrap();
        }
        let live = try_run_lease(&dir, "live").unwrap().unwrap();
        assert_eq!(reconcile_ids(&conn, &dir, &["live".into(), "stale".into()]).unwrap(), 1);
        let status = |id| conn.query_row("SELECT status FROM runs WHERE id=?1", [id], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!(status("live"), "running");
        assert_eq!(status("stale"), "failed");
        drop(live);
        assert_eq!(reconcile_ids(&conn, &dir, &["live".into()]).unwrap(), 1);
        assert_eq!(status("live"), "failed");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resume_by_id_tolerates_unspecified_identity_fields() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','user:目标','free_research','目标X','now','now')", []).unwrap();
        conn.execute("INSERT INTO runs(id,task_id,task_kind,task_ref,isolation_path,runtime,agent,permission,created_at,status,reuse_key) VALUES('run','task','free_research','目标X','/tmp/ccode-task-runs/task/x','local_cli','claude-code','write_tree','now','running','task:task')", []).unwrap();
        let input = |kind: Option<&str>, task_ref: Option<&str>| OpenRunInput {
            id: Some("run".into()),
            task_id: None,
            project_root: None,
            task_kind: kind.map(Into::into),
            task_ref: task_ref.map(Into::into),
            isolation_path: "/tmp/ccode-task-runs/task/x".into(),
            runtime: Some("local_cli".into()),
            agent: "claude-code".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: Some("task:task".into()),
            session_id: None,
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        // 恢复带 id 且未显式给 kind/ref（open_run_impl 对 id 命中不再推断）：
        // 不与已登记值比较，直接复用同一 Run
        let resumed = open_at(&conn, input(None, None)).unwrap();
        assert_eq!(resumed.id, "run");
        assert_eq!(resumed.task_kind, "free_research");
        // 显式给了不一致身份（修复前推断结果就是 scratch/目录名）仍拒绝
        let err = open_at(&conn, input(Some("scratch"), Some("x"))).unwrap_err();
        assert!(err.contains("不一致"), "{err}");
    }

    #[test]
    fn custom_runtime_on_scratch_is_not_isolated_write() {
        assert!(!requires_isolated_write_tree("scratch", false));
        assert!(!requires_isolated_write_tree("office_doc", false));
        assert!(!requires_isolated_write_tree("free_research", false));
        assert!(requires_isolated_write_tree("coding_lane", false));
        assert!(requires_isolated_write_tree("pipeline_step", false));
        assert!(requires_isolated_write_tree("watch", false));
        assert!(!requires_isolated_write_tree("watch", true));
    }

    #[test]
    fn scratch_and_reader_runs_have_no_goal_task() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let input = |kind: &str, path: &str| OpenRunInput {
            id: None,
            task_id: None,
            project_root: None,
            task_kind: Some(kind.into()),
            task_ref: None,
            isolation_path: path.into(),
            runtime: Some("local_cli".into()),
            agent: "claude-code".into(),
            profile_id: None,
            permission: Some("write_tree".into()),
            reuse_key: None,
            session_id: None,
            custom_runtime_id: None,
            internal: Some(false),
            sentinel: Some(false),
        };
        // 随手聊/阅读/办公文件闲聊：Run 可以没有 Goal，不再自动登记 Task 行
        for (kind, path) in [
            ("scratch", "/tmp/ccode-scratch/a"),
            ("reader", "/tmp/ccode-reader/b"),
            ("office_doc", "/tmp/ccode-office/c"),
        ] {
            let run = open_at(&conn, input(kind, path)).unwrap();
            assert!(run.task_id.is_empty(), "{kind} 不应有 Task");
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "无目标执行不得在 tasks 表留行");
        // 归属类执行（科研步骤/编程车道）仍登记 Task
        let lane = open_at(&conn, input("coding_lane", "/tmp/ccode-worktrees/r/feat")).unwrap();
        assert!(!lane.task_id.is_empty());
    }

    #[test]
    fn infer_task_kind_prefixes() {
        assert_eq!(infer_task_kind("login:claude-code", "/x"), "login");
        assert_eq!(infer_task_kind("reader:/p", "/p"), "reader");
        assert_eq!(infer_task_kind("watch:s1:/p", "/p"), "watch");
        assert_eq!(infer_task_kind("office:/p:file", "/p"), "office_doc");
        assert_eq!(infer_task_kind("free:/p:task", "/p"), "free_research");
        assert_eq!(infer_task_kind("ws:/wt", "/wt"), "pipeline_step");
        assert_eq!(canonicalize_reuse_key("wt:/t"), "lane:/t");
        assert_eq!(infer_task_kind("wt:/t", "/t"), "coding_lane");
        assert_eq!(infer_task_kind("lane:/t", "/t"), "coding_lane");
        assert_eq!(
            infer_task_kind("custom:r1:/Users/me/ccode/worktrees/r/feat", "/Users/me/ccode/worktrees/r/feat"),
            "coding_lane"
        );
        assert_eq!(
            infer_task_kind("coding:/repo:project", "/repo"),
            "coding_lane"
        );
        assert_eq!(infer_task_kind("headless:ai-prompt:x", "/tmp"), "scratch");
        assert_eq!(infer_task_kind("", "/Users/me/ccode/scratch/a"), "scratch");
        assert_eq!(
            infer_task_kind("", "/Users/me/ccode/workspaces/r/lit"),
            "pipeline_step"
        );
        assert_eq!(
            infer_task_kind("", "/Users/me/ccode/worktrees/r/feat"),
            "coding_lane"
        );
    }

    #[test]
    fn watch_is_internal() {
        assert!(is_internal_kind("watch", "watch:1:/p"));
        assert!(is_internal_kind("scratch", "headless:ai-prompt:x"));
        assert!(!is_internal_kind("pipeline_step", "ws:/x"));
    }

    #[test]
    fn prune_nested_rel_paths_keeps_parent() {
        assert_eq!(
            prune_nested_rel_paths(&["notes/a.md".into(), "notes".into(), "papers/a.pdf".into()]),
            vec!["notes".to_string(), "papers/a.pdf".to_string()]
        );
        assert_eq!(prune_nested_rel_paths(&[".".into(), "notes".into()]), vec![".".to_string()]);
    }

    #[test]
    fn project_scope_copy_skips_ccode_and_dependency_directories() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-scope-{}", uuid::Uuid::new_v4()));
        let target = root.join("target");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".ccode")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".git/config"), "secret").unwrap();
        std::fs::write(root.join(".ccode/project.toml"), "secret").unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), "dependency").unwrap();
        std::fs::write(root.join("src/main.ts"), "export {}").unwrap();
        copy_project_contents(&root, &target, &mut TaskCopyBudget::default()).unwrap();
        assert!(target.join("src/main.ts").is_file());
        assert!(!target.join(".git").exists());
        assert!(!target.join(".ccode").exists());
        assert!(!target.join("node_modules").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_all_project_changes_copies_new_and_modified_files() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-sync-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/changed.md"), "new").unwrap();
        std::fs::write(target.join("notes/changed.md"), "old").unwrap();
        std::fs::write(source.join("notes/new.md"), "added").unwrap();
        std::fs::create_dir_all(source.join(".ccode")).unwrap();
        std::fs::write(source.join(".ccode/ignored"), "no").unwrap();

        copy_project_changes(&source, &target).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("notes/changed.md")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/new.md")).unwrap(),
            "added"
        );
        assert!(!target.join(".ccode").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_output_changes_marks_added_and_modified() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-review-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/changed.md"), "new").unwrap();
        std::fs::write(target.join("notes/changed.md"), "old").unwrap();
        std::fs::write(source.join("notes/new.md"), "added").unwrap();
        std::fs::write(source.join("notes/same.md"), "same").unwrap();
        std::fs::write(target.join("notes/same.md"), "same").unwrap();

        let changes = list_output_changes(&source, &target, &[".".to_string()]).unwrap();
        assert_eq!(
            changes
                .iter()
                .map(|item| (item.path.as_str(), item.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("notes/changed.md", "modified"), ("notes/new.md", "added")]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_selected_files_overwrites_after_review() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-adopt-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/keep.md"), "new-keep").unwrap();
        std::fs::write(target.join("notes/keep.md"), "old-keep").unwrap();
        std::fs::write(source.join("notes/skip.md"), "new-skip").unwrap();
        std::fs::write(target.join("notes/skip.md"), "old-skip").unwrap();
        std::fs::write(source.join("notes/extra.md"), "added").unwrap();

        copy_adopt_file(
            &source.join("notes/keep.md"),
            &target.join("notes/keep.md"),
        )
        .unwrap();
        copy_adopt_file(
            &source.join("notes/extra.md"),
            &target.join("notes/extra.md"),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("notes/keep.md")).unwrap(),
            "new-keep"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/skip.md")).unwrap(),
            "old-skip"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/extra.md")).unwrap(),
            "added"
        );
        #[cfg(unix)]
        {
            let link = target.join("notes/link.md");
            std::os::unix::fs::symlink(target.join("notes/keep.md"), &link).unwrap();
            assert!(copy_adopt_file(&source.join("notes/keep.md"), &link).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_second_file_failure_rolls_back_first() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-adopt-rb-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        let adopt = root.join("adopt-state");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/first.md"), "new-first").unwrap();
        std::fs::write(target.join("notes/first.md"), "old-first").unwrap();
        std::fs::write(source.join("notes/second.md"), "new-second").unwrap();
        std::fs::write(target.join("notes/second.md"), "old-second").unwrap();
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(adopt));
        let mut remaining = 1;
        let result = adopt_selected_with_writer(
            "run-1",
            &source,
            &target,
            &["notes/first.md".into(), "notes/second.md".into()],
            |src, dst| {
                if remaining == 0 {
                    return Err("injected failure".into());
                }
                remaining -= 1;
                copy_adopt_file(src, dst)
            },
        );
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
        assert!(result.unwrap_err().contains("injected failure"));
        assert_eq!(
            std::fs::read_to_string(target.join("notes/first.md")).unwrap(),
            "old-first"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("notes/second.md")).unwrap(),
            "old-second"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopt_detects_concurrent_change_and_rolls_back() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-adopt-race-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        let adopt = root.join("adopt-state");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/first.md"), "new-first").unwrap();
        std::fs::write(target.join("notes/first.md"), "old-first").unwrap();
        std::fs::write(source.join("notes/second.md"), "new-second").unwrap();
        std::fs::write(target.join("notes/second.md"), "old-second").unwrap();
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(adopt));
        let second = target.join("notes/second.md");
        let result = adopt_selected_with_writer(
            "run-2",
            &source,
            &target,
            &["notes/first.md".into(), "notes/second.md".into()],
            |src, dst| {
                copy_adopt_file(src, dst)?;
                if dst.ends_with("first.md") {
                    std::fs::write(&second, "external").unwrap();
                }
                Ok(())
            },
        );
        TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
        assert!(result.unwrap_err().contains("采纳期间变化"));
        assert_eq!(
            std::fs::read_to_string(target.join("notes/first.md")).unwrap(),
            "old-first"
        );
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "external");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn specified_output_existing_file_is_modified_not_rejected() {
        let root =
            std::env::temp_dir().join(format!("ccode-task-specified-{}", uuid::Uuid::new_v4()));
        let source = root.join("run");
        let target = root.join("project");
        std::fs::create_dir_all(source.join("notes")).unwrap();
        std::fs::create_dir_all(target.join("notes")).unwrap();
        std::fs::write(source.join("notes/result.md"), "new").unwrap();
        std::fs::write(target.join("notes/result.md"), "old").unwrap();
        let changes =
            list_output_changes(&source, &target, &["notes/result.md".to_string()]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "notes/result.md");
        assert_eq!(changes[0].kind, "modified");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protected_paths_block_descendant_files() {
        let protected = vec!["数据/raw".to_string()];
        assert!(crate::projects::path_is_protected("数据/raw/a.csv", &protected));
        assert!(!crate::projects::path_is_protected("论文/综述.md", &protected));
    }
}
