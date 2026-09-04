//! 一次干活（Run）身份：关标签不删行。无头标 internal，不进工作台「正在进行」。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

pub(crate) fn infer_task_kind(reuse_key: &str, isolation: &str) -> &'static str {
    let key = reuse_key.trim();
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
    if key.starts_with("ws:") {
        return "pipeline_step";
    }
    if key.starts_with("wt:") || key.starts_with("lane:") || key.starts_with("coding:") {
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
    task_kind == "watch"
        || reuse_key.starts_with("watch:")
        || reuse_key.starts_with("headless:")
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

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          project_root TEXT,
          task_kind TEXT NOT NULL,
          task_ref TEXT,
          isolation_path TEXT NOT NULL,
          runtime TEXT NOT NULL,
          agent TEXT NOT NULL,
          profile_id TEXT,
          permission TEXT NOT NULL,
          reuse_key TEXT,
          session_id TEXT,
          internal INTEGER NOT NULL DEFAULT 0,
          sentinel INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          closed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runs_reuse ON runs(reuse_key);
        CREATE INDEX IF NOT EXISTS idx_runs_open ON runs(internal, closed_at);",
    )
    .map_err(|e| format!("初始化 runs 表失败: {e}"))
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRunInput {
    pub id: Option<String>,
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
    pub internal: Option<bool>,
    pub sentinel: Option<bool>,
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunDto> {
    Ok(RunDto {
        id: row.get(0)?,
        project_root: row.get(1)?,
        task_kind: row.get(2)?,
        task_ref: row.get(3)?,
        isolation_path: row.get(4)?,
        runtime: row.get(5)?,
        agent: row.get(6)?,
        profile_id: row.get(7)?,
        permission: row.get(8)?,
        reuse_key: row.get(9)?,
        session_id: row.get(10)?,
        internal: row.get::<_, i64>(11)? != 0,
        sentinel: row.get::<_, i64>(12)? != 0,
        created_at: row.get(13)?,
        closed_at: row.get(14)?,
    })
}

const COLS: &str = "id, project_root, task_kind, task_ref, isolation_path, runtime, agent, profile_id, permission, reuse_key, session_id, internal, sentinel, created_at, closed_at";

pub fn open_run_impl(input: OpenRunInput) -> Result<RunDto, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    let reuse = input.reuse_key.clone().unwrap_or_default();
    let kind = input
        .task_kind
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| infer_task_kind(&reuse, &input.isolation_path).to_string());
    let runtime = input
        .runtime
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "local_cli".into());
    let permission = input
        .permission
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "write_tree".into());
    let internal = input.internal.unwrap_or_else(|| is_internal_kind(&kind, &reuse));
    let sentinel = input.sentinel.unwrap_or(false);
    let project_root = input
        .project_root
        .filter(|s| !s.trim().is_empty())
        .or_else(|| infer_project_root(&reuse, &input.isolation_path));
    let task_ref = input
        .task_ref
        .filter(|s| !s.trim().is_empty())
        .or_else(|| infer_task_ref(&reuse, &input.isolation_path));
    let now = now_rfc3339();

    if let Some(id) = input.id.clone().filter(|s| !s.trim().is_empty()) {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM runs WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("查询 Run 失败: {e}"))?;
        if exists.is_some() {
            conn.execute(
                "UPDATE runs SET project_root=?2, task_kind=?3, task_ref=?4, isolation_path=?5,
                 runtime=?6, agent=?7, profile_id=?8, permission=?9, reuse_key=?10,
                 session_id=COALESCE(?11, session_id), internal=?12, sentinel=?13, closed_at=NULL
                 WHERE id=?1",
                params![
                    id,
                    project_root,
                    kind,
                    task_ref,
                    input.isolation_path,
                    runtime,
                    input.agent,
                    input.profile_id,
                    permission,
                    input.reuse_key,
                    input.session_id,
                    if internal { 1 } else { 0 },
                    if sentinel { 1 } else { 0 },
                ],
            )
            .map_err(|e| format!("更新 Run 失败: {e}"))?;
            return get_run_at(&conn, &id)?.ok_or_else(|| "Run 更新后读回失败".into());
        }
        conn.execute(
            "INSERT INTO runs (id, project_root, task_kind, task_ref, isolation_path, runtime, agent, profile_id, permission, reuse_key, session_id, internal, sentinel, created_at, closed_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL)",
            params![
                id,
                project_root,
                kind,
                task_ref,
                input.isolation_path,
                runtime,
                input.agent,
                input.profile_id,
                permission,
                input.reuse_key,
                input.session_id,
                if internal { 1 } else { 0 },
                if sentinel { 1 } else { 0 },
                now,
            ],
        )
        .map_err(|e| format!("写入 Run 失败: {e}"))?;
        return get_run_at(&conn, &id)?.ok_or_else(|| "Run 写入后读回失败".into());
    }

    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO runs (id, project_root, task_kind, task_ref, isolation_path, runtime, agent, profile_id, permission, reuse_key, session_id, internal, sentinel, created_at, closed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL)",
        params![
            id,
            project_root,
            kind,
            task_ref,
            input.isolation_path,
            runtime,
            input.agent,
            input.profile_id,
            permission,
            input.reuse_key,
            input.session_id,
            if internal { 1 } else { 0 },
            if sentinel { 1 } else { 0 },
            now,
        ],
    )
    .map_err(|e| format!("写入 Run 失败: {e}"))?;
    get_run_at(&conn, &id)?.ok_or_else(|| "Run 写入后读回失败".into())
}

fn get_run_at(conn: &Connection, id: &str) -> Result<Option<RunDto>, String> {
    conn.query_row(
        &format!("SELECT {COLS} FROM runs WHERE id = ?1"),
        params![id],
        map_row,
    )
    .optional()
    .map_err(|e| format!("读取 Run 失败: {e}"))
}

pub fn close_run_impl(id: &str, session_id: Option<&str>) -> Result<(), String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    let now = now_rfc3339();
    conn.execute(
        "UPDATE runs SET closed_at=?2, session_id=COALESCE(?3, session_id) WHERE id=?1 AND closed_at IS NULL",
        params![id, now, session_id],
    )
    .map_err(|e| format!("关闭 Run 失败: {e}"))?;
    Ok(())
}

pub fn attach_session_impl(id: &str, session_id: &str) -> Result<(), String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    conn.execute(
        "UPDATE runs SET session_id=?2 WHERE id=?1",
        params![id, session_id],
    )
    .map_err(|e| format!("绑定会话失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn run_open(input: OpenRunInput) -> Result<RunDto, String> {
    open_run_impl(input)
}

#[tauri::command]
pub fn run_close(id: String, session_id: Option<String>) -> Result<(), String> {
    close_run_impl(&id, session_id.as_deref())
}

#[tauri::command]
pub fn run_attach_session(id: String, session_id: String) -> Result<(), String> {
    attach_session_impl(&id, &session_id)
}

#[tauri::command]
pub fn run_get(id: String) -> Result<Option<RunDto>, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    get_run_at(&conn, &id)
}

/// 交互 spawn 用：登录标签不建 Run。
pub fn open_for_interactive_spawn(
    agent: &str,
    profile_id: &str,
    cwd: &str,
    reuse_key: Option<&str>,
    session_id: Option<&str>,
    readonly: bool,
    existing_id: Option<&str>,
) -> Result<Option<RunDto>, String> {
    let reuse = reuse_key.unwrap_or("");
    if reuse.starts_with("login:") {
        return Ok(None);
    }
    let kind = infer_task_kind(reuse, cwd);
    if kind == "watch" || reuse.starts_with("headless:") {
        return Ok(None);
    }
    let dto = open_run_impl(OpenRunInput {
        id: existing_id.map(|s| s.to_string()),
        project_root: None,
        task_kind: Some(kind.to_string()),
        task_ref: None,
        isolation_path: cwd.to_string(),
        runtime: Some("local_cli".into()),
        agent: agent.to_string(),
        profile_id: Some(profile_id.to_string()),
        permission: Some(if readonly { "discuss" } else { "write_tree" }.into()),
        reuse_key: reuse_key.map(|s| s.to_string()),
        session_id: session_id.map(|s| s.to_string()),
        internal: Some(false),
        sentinel: Some(false),
    })?;
    if kind == "coding_lane" {
        crate::coding::touch_lane_current_run(cwd, &dto.id);
    }
    Ok(Some(dto))
}

pub fn open_headless(
    agent: &str,
    profile_id: &str,
    cwd: &str,
    reuse_key: &str,
    sentinel: bool,
    permission: &str,
) -> Result<RunDto, String> {
    open_run_impl(OpenRunInput {
        id: None,
        project_root: Some(cwd.to_string()),
        task_kind: Some(infer_task_kind(reuse_key, cwd).to_string()),
        task_ref: None,
        isolation_path: cwd.to_string(),
        runtime: Some("headless".into()),
        agent: agent.to_string(),
        profile_id: Some(profile_id.to_string()),
        permission: Some(permission.to_string()),
        reuse_key: Some(reuse_key.to_string()),
        session_id: None,
        internal: Some(true),
        sentinel: Some(sentinel),
    })
}

#[tauri::command]
pub fn run_open_custom(
    cwd: String,
    reuse_key: String,
    run_id: Option<String>,
) -> Result<RunDto, String> {
    let dto = open_run_impl(OpenRunInput {
        id: run_id.filter(|s| !s.trim().is_empty()),
        project_root: None,
        task_kind: None,
        task_ref: None,
        isolation_path: cwd.clone(),
        runtime: Some("custom".into()),
        agent: "custom".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: Some(reuse_key),
        session_id: None,
        internal: Some(false),
        sentinel: Some(false),
    })?;
    crate::coding::touch_lane_current_run(&cwd, &dto.id);
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_task_kind_prefixes() {
        assert_eq!(infer_task_kind("login:claude-code", "/x"), "login");
        assert_eq!(infer_task_kind("reader:/p", "/p"), "reader");
        assert_eq!(infer_task_kind("watch:s1:/p", "/p"), "watch");
        assert_eq!(infer_task_kind("office:/p:file", "/p"), "office_doc");
        assert_eq!(infer_task_kind("ws:/wt", "/wt"), "pipeline_step");
        assert_eq!(infer_task_kind("wt:/t", "/t"), "coding_lane");
        assert_eq!(infer_task_kind("lane:/t", "/t"), "coding_lane");
        assert_eq!(infer_task_kind("coding:/repo:project", "/repo"), "coding_lane");
        assert_eq!(infer_task_kind("headless:ai-prompt:x", "/tmp"), "scratch");
        assert_eq!(
            infer_task_kind("", "/Users/me/ccode/scratch/a"),
            "scratch"
        );
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
}
