//! 自定义 Runtime：用户登记的命令，在隔离目录里当 shell 跑。无密钥注入、无会话解析。

use rusqlite::{params, Connection};
use serde::Serialize;

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS custom_runtimes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("初始化 custom_runtimes 表失败: {e}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRuntimeDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub created_at: String,
}

fn parse_args(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

pub(crate) fn is_relative_command(cmd: &str) -> bool {
    let t = cmd.trim();
    t.starts_with("./")
        || t.starts_with(".\\")
        || t.starts_with("../")
        || t.starts_with("..\\")
}

fn validate_command(command: &str) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("命令不能为空".into());
    }
    if is_relative_command(command) {
        return Err("相对路径命令不能跨目录跑，请改成绝对路径或已在 PATH 里的命令名".into());
    }
    if command.contains('/') || command.contains('\\') {
        let p = std::path::Path::new(command);
        if !p.is_absolute() {
            return Err("命令若含路径必须是绝对路径".into());
        }
        if !p.exists() {
            return Err(format!("找不到命令：{command}"));
        }
        return Ok(command.to_string());
    }
    crate::agents::resolve_binary(command)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| format!("找不到命令：{command}（PATH 与常见安装目录均无）"))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CustomRuntimeDto> {
    let args_raw: String = row.get(3)?;
    Ok(CustomRuntimeDto {
        id: row.get(0)?,
        name: row.get(1)?,
        command: row.get(2)?,
        args: parse_args(&args_raw),
        created_at: row.get(4)?,
    })
}

#[tauri::command]
pub fn list_custom_runtimes() -> Result<Vec<CustomRuntimeDto>, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, args, created_at FROM custom_runtimes ORDER BY created_at DESC",
        )
        .map_err(|e| format!("读取自定义运行时失败: {e}"))?;
    let rows = stmt
        .query_map([], map_row)
        .map_err(|e| format!("读取自定义运行时失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取自定义运行时失败: {e}"))
}

#[tauri::command]
pub fn save_custom_runtime(
    id: Option<String>,
    name: String,
    command: String,
    args: Vec<String>,
) -> Result<CustomRuntimeDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    let resolved = validate_command(&command)?;
    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    let id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_rfc3339();
    conn.execute(
        "INSERT INTO custom_runtimes (id, name, command, args, created_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET name=?2, command=?3, args=?4",
        params![id, name, resolved, args_json, now],
    )
    .map_err(|e| format!("保存自定义运行时失败: {e}"))?;
    Ok(CustomRuntimeDto {
        id,
        name: name.to_string(),
        command: resolved,
        args,
        created_at: now,
    })
}

#[tauri::command]
pub fn delete_custom_runtime(id: String) -> Result<(), String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM custom_runtimes WHERE id=?1", params![id])
        .map_err(|e| format!("删除自定义运行时失败: {e}"))?;
    Ok(())
}

/// 拼成一条 shell 行：绝对路径命令 + 参数（单引号转义）。
pub fn shell_line(command: &str, args: &[String]) -> String {
    let mut out = sh_quote(command);
    for a in args {
        out.push(' ');
        out.push_str(&sh_quote(a));
    }
    out
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_commands_rejected() {
        assert!(is_relative_command("./foo"));
        assert!(is_relative_command("../foo"));
        assert!(is_relative_command(".\\foo"));
        assert!(!is_relative_command("git"));
        assert!(!is_relative_command("/usr/bin/git"));
    }

    #[test]
    fn shell_line_quotes() {
        assert_eq!(shell_line("/bin/echo", &["a b".into()]), "'/bin/echo' 'a b'");
    }
}
