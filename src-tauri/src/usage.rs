//! 用量与费用统计（§6.11）：六个 agent 的会话 usage 按天聚合进 app.db，
//! 内置定价表（可被 <config>/ccode/pricing.json 覆盖）估算 USD 费用；价格不明的只显示 token。

use chrono::{DateTime, Days, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const LIST_CAP: usize = 20;
// v5：usage_daily 增加 workspace 列（工作区成本归因）。扫描时 worktree 会话的项目路径
// 已被改写成真实仓库路径，工作区归属信息无法仅靠既有索引在查询时反推，必须建索引时落库，
// 因此升版本并自动重建旧索引。
// v6：usage_daily 与 usage_provenance 增加 official 列（官方账号「订阅」口径）。
// 建索引时按 provenance 落库，查询期不再反推，升版本自动重建旧索引；
// provenance 表不在重置范围内，单独走 ALTER 补列。
const USAGE_SCHEMA_VERSION: &str = "6";
const SOURCE_CLI: &str = "cli";
const SOURCE_CCODE_AI: &str = "ccode-ai";
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

// ===== 事件提取（每个 agent 一个小提取器，只拿 时间/模型/usage） =====

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct UsageEvent {
    pub day: String, // 本机时区日期
    pub model: String, // 未知为 ""
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// 事件来源由后端运行来源登记决定，不由路径或模型名猜测。
    pub source: String,
    pub internal: bool,
    /// 官方账号（订阅制）用量：同样由 provenance 登记决定，不由事件本身猜测
    pub official: bool,
}

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn day_of_iso(ts: &str) -> String {
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| ts.chars().take(10).collect())
}

fn day_of_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn claude_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("assistant")
            || v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
        {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(u) = msg.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(msg, "model").unwrap_or("").to_string(),
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_read: num("cache_read_input_tokens"),
            cache_write: num("cache_creation_input_tokens"),
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn codex_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    let mut model = String::new(); // turn_context 的 model，取最后出现的（每轮会刷新）
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("turn_context") => {
                if let Some(m) = v.get("payload").and_then(|p| get_str(p, "model")) {
                    model = m.to_string();
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                if get_str(p, "type") != Some("token_count") {
                    continue;
                }
                // last_token_usage 是本轮增量（total 是累计，按天聚合必须用增量）
                let Some(t) = p.get("info").and_then(|i| i.get("last_token_usage")) else {
                    continue;
                };
                let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                out.push(UsageEvent {
                    day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
                    model: model.clone(),
                    input: num("input_tokens"),
                    output: num("output_tokens") + num("reasoning_output_tokens"),
                    cache_read: num("cached_input_tokens"),
                    cache_write: num("cache_write_input_tokens"),
                    source: SOURCE_CLI.into(),
                    internal: false,
                    official: false,
                });
            }
            _ => {}
        }
    }
    out
}

fn gemini_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("gemini") {
            continue;
        }
        let Some(t) = v.get("tokens") else {
            continue;
        };
        let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: num("input"),
            output: num("output") + num("thoughts"),
            cache_read: num("cached"),
            cache_write: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn qwen_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let Some(u) = v.get("usageMetadata") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: get_str(&v, "timestamp").map(day_of_iso).unwrap_or_default(),
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: num("promptTokenCount"),
            output: num("candidatesTokenCount"),
            cache_read: num("cachedContentTokenCount"),
            cache_write: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn kimi_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("usage.record") {
            continue;
        }
        let Some(u) = v.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.push(UsageEvent {
            day: v.get("time").and_then(|t| t.as_i64()).map(day_of_ms).unwrap_or_default(),
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: num("inputOther"),
            output: num("output"),
            cache_read: num("inputCacheRead"),
            cache_write: num("inputCacheCreation"),
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn opencode_events(db_path: &Path, session_id: &str) -> Vec<UsageEvent> {
    let Some(conn) = crate::sessions::open_opencode_db(db_path) else {
        return Vec::new();
    };
    // 逐行流式消费：message.data 可能很大，整会话一次性入内存在长会话下峰值过高。
    // 列级防御沿用 SELECT * + 按列名取索引（drizzle 迁移频繁，缺列给默认而不是报错）
    let Ok(mut stmt) = conn
        .prepare("SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC")
    else {
        return Vec::new();
    };
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let Some(data_idx) = names.iter().position(|n| n == "data") else {
        return Vec::new();
    };
    let time_idx = names.iter().position(|n| n == "time_created");
    let Ok(mut rows) = stmt.query(rusqlite::params![session_id]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        let data = row.get::<_, String>(data_idx).unwrap_or_default();
        // 与旧 DbRow::as_i64 同口径：Integer 直取，Real 截断，其余视为缺失
        let time_created = time_idx.and_then(|i| {
            row.get::<_, rusqlite::types::Value>(i).ok().and_then(|v| match v {
                rusqlite::types::Value::Integer(n) => Some(n),
                rusqlite::types::Value::Real(f) => Some(f as i64),
                _ => None,
            })
        });
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if get_str(&v, "role") != Some("assistant") {
            continue;
        }
        let Some(t) = v.get("tokens") else {
            continue;
        };
        let num = |k: &str| t.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
        let cache = t.get("cache");
        let cnum = |k: &str| cache.and_then(|c| c.get(k)).and_then(|x| x.as_i64()).unwrap_or(0);
        // modelID 为主；model 也可能是 {providerID,modelID} 对象
        let model = get_str(&v, "modelID")
            .map(String::from)
            .or_else(|| v.get("model").and_then(|m| get_str(m, "modelID")).map(String::from))
            .unwrap_or_default();
        out.push(UsageEvent {
            day: time_created.map(day_of_ms).unwrap_or_default(),
            model,
            input: num("input") as u64,
            output: (num("output") + num("reasoning")) as u64,
            cache_read: cnum("read") as u64,
            cache_write: cnum("write") as u64,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

fn usage_line_reader(path: &Path) -> Option<Box<dyn BufRead>> {
    let mut file = File::open(path).ok()?;
    let mut magic = [0u8; 4];
    let read = file.read(&mut magic).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;
    if read == magic.len() && magic == ZSTD_MAGIC {
        let decoder = zstd::stream::read::Decoder::new(file).ok()?;
        Some(Box::new(BufReader::new(decoder)))
    } else {
        Some(Box::new(BufReader::new(file)))
    }
}

fn extract_file_events(agent: &str, path: &Path) -> Vec<UsageEvent> {
    let Some(reader) = usage_line_reader(path) else {
        return Vec::new();
    };
    // JSONL 逐行解析，峰值内存由单条记录而非整个会话大小决定；压缩会话也边解码边消费。
    let lines = reader
        .split(b'\n')
        .map_while(Result::ok)
        .map(|line| String::from_utf8_lossy(&line).into_owned());
    match agent {
        "codex" => codex_events(lines),
        "gemini" => gemini_events(lines),
        "qwen" => qwen_events(lines),
        "kimi" => kimi_events(lines),
        _ => claude_events(lines),
    }
}

/// 会话 → usage 事件流；普通 JSONL 与 zstd 会话均流式读取。
fn extract_events(session: &crate::sessions::SessionMetaDto) -> Vec<UsageEvent> {
    if session.agent == "opencode" {
        let Some((db, sid)) = session.file_path.split_once('#') else {
            return Vec::new();
        };
        return opencode_events(Path::new(db), sid);
    }
    let path = Path::new(&session.file_path);
    extract_file_events(&session.agent, path)
}

// ===== 聚合 =====

#[derive(Debug, Clone)]
pub(crate) struct SessionContrib {
    pub agent: String,
    pub session_id: String,
    pub project_path: String,
    /// 会话发生在任务工作区时的工作区名（扫描已识别）；非工作区会话为空串
    pub workspace: String,
    pub events: Vec<UsageEvent>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DailyRow {
    pub day: String,
    pub agent: String,
    pub model: String,
    pub project_path: String,
    pub session_id: String,
    pub workspace: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub source: String,
    pub internal: bool,
    /// 官方账号（订阅制）用量：不按量计费，统计页费用栏显示「订阅」
    pub official: bool,
}

/// 按 (day, agent, model, project, session, workspace, source, internal, official) 聚合；无 usage 事件的会话不产生行
pub(crate) fn aggregate(contribs: &[SessionContrib]) -> Vec<DailyRow> {
    #[allow(clippy::type_complexity)]
    let mut map: HashMap<(String, String, String, String, String, String, String, bool, bool), DailyRow> =
        HashMap::new();
    for c in contribs {
        for e in &c.events {
            if e.day.is_empty() {
                continue; // 时间戳缺失的事件无法归入任何日桶，直接丢弃而不是产出 day="" 噪声行
            }
            let key = (
                e.day.clone(),
                c.agent.clone(),
                e.model.clone(),
                c.project_path.clone(),
                c.session_id.clone(),
                c.workspace.clone(),
                e.source.clone(),
                e.internal,
                e.official,
            );
            let row = map.entry(key.clone()).or_insert_with(|| DailyRow {
                day: key.0,
                agent: key.1,
                model: key.2,
                project_path: key.3,
                session_id: key.4,
                workspace: key.5,
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                source: key.6,
                internal: key.7,
                official: key.8,
            });
            row.input += e.input;
            row.output += e.output;
            row.cache_read += e.cache_read;
            row.cache_write += e.cache_write;
        }
    }
    map.into_values().collect()
}

// ===== app.db =====

fn usage_db() -> Result<Connection, String> {
    let conn = crate::sessions::open_db()?;
    ensure_usage_schema(&conn)?;
    Ok(conn)
}

fn usage_columns(conn: &Connection) -> Result<HashSet<String>, String> {
    table_columns(conn, "usage_daily")
}

fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn ensure_usage_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_daily(
          day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
          project_path TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
          input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'cli', internal INTEGER NOT NULL DEFAULT 0,
          workspace TEXT NOT NULL DEFAULT '', official INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(day, agent, model, project_path, session_id));
         CREATE TABLE IF NOT EXISTS usage_meta(key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE IF NOT EXISTS usage_provenance(
           agent TEXT NOT NULL, project_path TEXT NOT NULL,
           source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
           official INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL,
           PRIMARY KEY(agent, project_path));",
    )
    .map_err(|e| format!("初始化用量表失败: {e}"))?;
    let columns = usage_columns(conn)?;
    if !columns.contains("source") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'",
            [],
        )
        .map_err(|e| format!("升级用量来源字段失败: {e}"))?;
    }
    if !columns.contains("internal") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN internal INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级内部活动字段失败: {e}"))?;
    }
    if !columns.contains("workspace") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN workspace TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| format!("升级工作区归因字段失败: {e}"))?;
    }
    if !columns.contains("official") {
        conn.execute(
            "ALTER TABLE usage_daily ADD COLUMN official INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级官方账号标记字段失败: {e}"))?;
    }
    // provenance 表不在版本重置范围内（登记行要跨重建保留），单独补列
    let provenance_columns = table_columns(conn, "usage_provenance")?;
    if !provenance_columns.contains("official") {
        conn.execute(
            "ALTER TABLE usage_provenance ADD COLUMN official INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级来源登记官方账号字段失败: {e}"))?;
    }
    let current: Option<String> = conn
        .query_row(
            "SELECT value FROM usage_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .ok();
    if current.as_deref() != Some(USAGE_SCHEMA_VERSION) {
        // 旧索引没有可靠来源，清空后由会话源重新生成，避免把历史猜测伪装成权威分类。
        conn.execute_batch(
            "DELETE FROM usage_daily;
             DELETE FROM usage_meta WHERE key LIKE 'seen:%' OR key='initialized';",
        )
        .map_err(|e| format!("重置旧用量索引失败: {e}"))?;
        conn.execute(
            "INSERT INTO usage_meta(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![USAGE_SCHEMA_VERSION],
        )
        .map_err(|e| format!("记录用量表版本失败: {e}"))?;
    }
    Ok(())
}

fn register_provenance_impl(
    conn: &Connection,
    agent: &str,
    project_path: &str,
    source: &str,
    internal: bool,
    official: bool,
) -> Result<(), String> {
    let project_path = normalize_provenance_path(project_path);
    conn.execute(
        "INSERT INTO usage_provenance(agent, project_path, source, internal, official, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(agent, project_path) DO UPDATE SET
           source=excluded.source, internal=excluded.internal,
           official=excluded.official, created_at=excluded.created_at",
        params![
            agent,
            project_path,
            source,
            i64::from(internal),
            i64::from(official),
            crate::sessions::now_iso()
        ],
    )
    .map_err(|e| format!("记录用量来源失败: {e}"))?;
    Ok(())
}

pub(crate) fn normalize_provenance_path(path: &str) -> String {
    let expanded = crate::sessions::expand_tilde(path);
    let resolved = std::fs::canonicalize(&expanded)
        .unwrap_or_else(|_| std::path::PathBuf::from(&expanded));
    let mut normalized = resolved.to_string_lossy().replace('\\', "/");
    // canonicalize 在 Windows 返回 \\?\ 前缀的 verbatim 形式（替换分隔符后为 //?/），
    // 登记/查询两侧统一剥离再归一化；非 Windows 平台该前缀不会出现，剥离是恒等操作
    if let Some(rest) = normalized.strip_prefix("//?/") {
        normalized = rest.to_string();
    }
    #[cfg(target_os = "macos")]
    {
        // macOS 的 std::env::temp_dir 常返回 /var，CLI 会话通常记录真实的 /private/var。
        if normalized == "/var" || normalized.starts_with("/var/") {
            normalized = format!("/private{normalized}");
        } else if normalized == "/tmp" || normalized.starts_with("/tmp/") {
            normalized = format!("/private{normalized}");
        }
    }
    #[cfg(target_os = "windows")]
    {
        normalized = normalized.to_lowercase();
    }
    if normalized.len() > 1 {
        normalized.truncate(normalized.trim_end_matches('/').len());
    }
    normalized
}

/// Ccode 自己发起无头 AI 调用时登记精确来源；普通终端启动不调用本函数。
pub(crate) fn register_internal_ai_run(agent: &str, project_path: &Path) -> Result<(), String> {
    let conn = usage_db()?;
    register_provenance_impl(
        &conn,
        agent,
        &project_path.to_string_lossy(),
        SOURCE_CCODE_AI,
        true,
        false,
    )
}

/// 官方账号（订阅制）profile 的终端启动登记：与 internal 同一机制，
/// source 保持 cli（是用户自己的交互会话），只标 official，统计页费用栏据此显示「订阅」。
/// 同 agent+项目再以 API profile 启动时不回写本表——official 标记只增不清，
/// 避免一次启动把历史 official 会话的标记抹掉（与 internal 登记同语义）。
pub(crate) fn register_official_launch(agent: &str, project_path: &Path) -> Result<(), String> {
    let conn = usage_db()?;
    register_provenance_impl(
        &conn,
        agent,
        &project_path.to_string_lossy(),
        SOURCE_CLI,
        false,
        true,
    )
}

fn session_provenance(conn: &Connection, agent: &str, project_path: &str) -> (String, bool, bool) {
    let project_path = normalize_provenance_path(project_path);
    conn.query_row(
        "SELECT source, internal, official FROM usage_provenance WHERE agent=?1 AND project_path=?2",
        params![agent, project_path],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? != 0,
                row.get::<_, i64>(2)? != 0,
            ))
        },
    )
    .unwrap_or_else(|_| (SOURCE_CLI.into(), false, false))
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM usage_meta WHERE key=?1", params![key], |r| r.get(0))
        .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO usage_meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, value],
    );
}

/// usage_provenance 只增不减：无头 AI 用的临时工作区（系统临时目录下）用完即删，
/// 登记行会越积越多。清理「临时目录下、目录已不存在、且登记超过 7 天」的行；
/// 真实项目目录的行一律不动（可能暂时未挂载，不能误清）。created_at 是 ISO 字符串可字典序比较
fn prune_stale_provenance(conn: &Connection) {
    const PRUNE_AFTER_SECS: u64 = 7 * 24 * 3600;
    let Some(now) = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
    else {
        return;
    };
    let cutoff = crate::sessions::iso_from_unix(now.saturating_sub(PRUNE_AFTER_SECS));
    let tmp = normalize_provenance_path(&std::env::temp_dir().to_string_lossy());
    // 先收集再删：活跃 SELECT 语句上直接写同连接可能撞 SQLITE_LOCKED
    let rows = {
        let Ok(mut stmt) = conn.prepare(
            "SELECT agent, project_path FROM usage_provenance WHERE created_at < ?1",
        ) else {
            return;
        };
        stmt.query_map(params![cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map(|rows| rows.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
    };
    for (agent, path) in rows {
        let under_tmp = path == tmp || path.starts_with(&format!("{tmp}/"));
        if under_tmp && !std::path::Path::new(&path).exists() {
            let _ = conn.execute(
                "DELETE FROM usage_provenance WHERE agent=?1 AND project_path=?2",
                params![agent, path],
            );
        }
    }
}

// ===== 增量重建 =====

/// 快照与活会话可共用 session_id：marker 键必须区分来源，
/// 否则来源切换时两边 marker 互顶，每轮都全量重解析
fn seen_key(s: &crate::sessions::SessionMetaDto) -> String {
    format!(
        "seen:{}:{}:{}",
        s.agent,
        s.session_id,
        if s.alive { "live" } else { "snap" }
    )
}

/// 从 seen 键反解 (agent, session_id)，供清理已消失会话的行；旧格式/损坏键返回 None
fn parse_seen_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("seen:")?;
    let (agent_sid, _kind) = rest.rsplit_once(':')?;
    let (agent, sid) = agent_sid.split_once(':')?;
    Some((agent.to_string(), sid.to_string()))
}

fn rebuild_impl() -> Result<UsageBuildResult, String> {
    let conn = usage_db()?;
    prune_stale_provenance(&conn);
    let scan = crate::sessions::scan_sessions();
    let mut indexed = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    for s in &scan.sessions {
        let key = seen_key(s);
        seen.insert(key.clone());
        // 快照补出的会话（alive=false）file_path 指向快照，内容稳定；
        // updated_at 缺失时用 created_at 兜底，保持 marker 恒定可跳过
        let marker = if s.alive {
            s.updated_at.clone().unwrap_or_default()
        } else {
            s.updated_at
                .clone()
                .or_else(|| s.created_at.clone())
                .unwrap_or_default()
        };
        if meta_get(&conn, &key).as_deref() == Some(marker.as_str()) && !marker.is_empty() {
            continue;
        }
        let (source, internal, official) = session_provenance(&conn, &s.agent, &s.project_path);
        let mut events = extract_events(s);
        for event in &mut events {
            event.source.clone_from(&source);
            event.internal = internal;
            event.official = official;
        }
        conn.execute(
            "DELETE FROM usage_daily WHERE agent=?1 AND session_id=?2",
            params![s.agent, s.session_id],
        )
        .map_err(|e| e.to_string())?;
        let contrib = SessionContrib {
            agent: s.agent.clone(),
            session_id: s.session_id.clone(),
            project_path: s.project_path.clone(),
            workspace: s.workspace.clone().unwrap_or_default(),
            events,
        };
        for row in aggregate(&[contrib]) {
            conn.execute(
                "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                                        input, output, cache_read, cache_write, source, internal, workspace, official)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(day, agent, model, project_path, session_id) DO UPDATE SET
                   input=input+excluded.input, output=output+excluded.output,
                   cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
                   source=excluded.source, internal=excluded.internal, workspace=excluded.workspace,
                   official=excluded.official",
                params![
                    row.day, row.agent, row.model, row.project_path, row.session_id,
                    row.input as i64, row.output as i64, row.cache_read as i64, row.cache_write as i64,
                    row.source, i64::from(row.internal), row.workspace, i64::from(row.official),
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        meta_set(&conn, &key, &marker);
        indexed += 1;
    }
    // 已消失的会话：连同行一并清除
    let mut stale: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT key FROM usage_meta WHERE key LIKE 'seen:%'")
            .map_err(|e| e.to_string())?;
        let keys = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for k in keys.flatten() {
            if !seen.contains(&k) {
                stale.push(k);
            }
        }
    }
    for k in stale {
        if let Some((agent, sid)) = parse_seen_key(&k) {
            let _ = conn.execute(
                "DELETE FROM usage_daily WHERE agent=?1 AND session_id=?2",
                params![agent, sid],
            );
        }
        let _ = conn.execute("DELETE FROM usage_meta WHERE key=?1", params![k]);
    }
    meta_set(&conn, "initialized", &crate::sessions::now_iso());
    let rows: usize = conn
        .query_row("SELECT COUNT(*) FROM usage_daily", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;
    Ok(UsageBuildResult {
        sessions_indexed: indexed,
        rows,
    })
}

// ===== 定价 =====

/// 内置前缀价目（美元 / 每百万 token）；最长前缀匹配（gpt-5-codex 优先于 gpt-5、
/// grok-4.1-fast 优先于 grok-4、qwen3-coder 优先于 qwen3）
const BUILTIN_PRICING: [(&str, (f64, f64)); 27] = [
    ("claude-opus", (15.0, 75.0)),
    ("claude-sonnet", (3.0, 15.0)),
    ("claude-haiku", (0.8, 4.0)),
    ("claude-fable", (15.0, 75.0)),
    ("gpt-5-codex", (1.25, 10.0)),
    ("gpt-5", (1.25, 10.0)),
    // kimi-k3 官方价 ¥20/¥100（输入缓存未命中/输出，每 1M；缓存命中 ¥2 = 一折，
    // 与 cost_of 的 cache_read×0.1 系数一致），按默认汇率 7.2 折美元
    ("kimi-k3", (2.78, 13.89)),
    ("kimi-k2", (0.6, 2.5)),
    ("moonshot", (0.6, 3.0)),
    ("gemini-3.6-flash", (0.3, 2.5)),
    ("gemini-3.5-flash", (0.3, 2.5)),
    ("gemini-3.1-pro", (2.0, 12.0)),
    ("gemini-3-pro", (2.0, 12.0)),
    ("gemini-3-flash", (0.3, 2.5)),
    ("gemini-2.5-pro", (1.25, 10.0)),
    ("gemini-2.5-flash", (0.3, 2.5)),
    ("grok-4.1-fast", (0.2, 0.5)),
    ("grok-4", (3.0, 15.0)),
    ("grok-3-mini", (0.3, 0.5)),
    ("grok-3", (3.0, 15.0)),
    ("grok-code-fast", (0.2, 1.5)),
    ("glm-4.6", (0.6, 2.2)),
    ("glm-4.5", (0.6, 2.2)),
    // 中转里的 glm-5 系（如 glm-5p2）暂按 4.6 同价估算，官方价出来后单列
    ("glm-5", (0.6, 2.2)),
    ("qwen3-coder", (0.5, 2.0)),
    ("qwen3", (0.5, 2.0)),
    ("deepseek", (0.27, 1.1)),
];

/// 汇率取值链：settings.json 的 rate_usd_cny > pricing.json 的 "_rate" > 默认 7.2
fn load_rate_with(settings_rate: Option<f64>, override_path: Option<&Path>) -> f64 {
    if let Some(r) = settings_rate.filter(|r| *r > 0.0) {
        return r;
    }
    override_path
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("_rate").and_then(|r| r.as_f64()))
        .filter(|r| *r > 0.0)
        .unwrap_or(crate::settings::DEFAULT_RATE_USD_CNY)
}

fn load_rate(override_path: Option<&Path>) -> f64 {
    load_rate_with(crate::settings::rate_setting(), override_path)
}

fn load_pricing(override_path: Option<&Path>) -> Vec<(String, (f64, f64))> {
    let mut table: Vec<(String, (f64, f64))> = BUILTIN_PRICING
        .iter()
        .map(|(p, v)| (p.to_string(), *v))
        .collect();
    if let Some(path) = override_path {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(obj) = v.as_object() {
                    for (prefix, price) in obj {
                        // 空前缀会匹配一切模型名，视为配置错误直接忽略
                        if prefix.trim().is_empty() {
                            continue;
                        }
                        if let Some(pair) = price.as_array() {
                            if pair.len() == 2 {
                                if let (Some(i), Some(o)) = (pair[0].as_f64(), pair[1].as_f64()) {
                                    table.push((prefix.to_lowercase(), (i, o)));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    table
}

fn price_of(model: &str, table: &[(String, (f64, f64))]) -> Option<(f64, f64)> {
    // 中转/聚合的 provider 前缀（accounts/fireworks/models/x、zetatechs/x）剥掉，按末段模型名匹配
    let model = model.rsplit('/').next().unwrap_or(model).to_lowercase();
    table
        .iter()
        .filter(|(prefix, _)| model.starts_with(prefix.as_str()))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, price)| *price)
}

#[derive(Debug, Default, Clone, Copy)]
struct TokenAcc {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

/// cache_read 按输入价 1 折算；cache_write 按输入全价（spec 未定义，取保守全价）
fn cost_of(acc: &TokenAcc, price: (f64, f64)) -> f64 {
    let (ir, or_) = price;
    (acc.input as f64 * ir + acc.output as f64 * or_ + acc.cache_read as f64 * ir * 0.1
        + acc.cache_write as f64 * ir)
        / 1_000_000.0
}

// ===== 查询 =====

fn cutoff_day_from(range: &str, today: NaiveDate) -> Option<String> {
    let days_back = match range {
        "today" => 0,
        "week" => 6,
        "month" => 29,
        _ => return None, // "all" 不过滤
    };
    today
        .checked_sub_days(Days::new(days_back))
        .map(|day| day.format("%Y-%m-%d").to_string())
}

fn cutoff_day(range: &str) -> Option<String> {
    cutoff_day_from(range, Local::now().date_naive())
}

#[derive(Debug, Default)]
struct Bucket {
    tokens: TokenAcc,
    sessions: HashSet<String>,
    by_model: HashMap<String, TokenAcc>,
}

impl Bucket {
    fn add(&mut self, model: &str, session_id: &str, acc: TokenAcc) {
        self.tokens.input += acc.input;
        self.tokens.output += acc.output;
        self.tokens.cache_read += acc.cache_read;
        self.tokens.cache_write += acc.cache_write;
        self.sessions.insert(session_id.to_string());
        let m = self.by_model.entry(model.to_string()).or_default();
        m.input += acc.input;
        m.output += acc.output;
        m.cache_read += acc.cache_read;
        m.cache_write += acc.cache_write;
    }

    /// 部分计价：只累加有价格的模型份额；(费用, 是否含未计价模型用量)。
    /// 全部不明价 → 费用 None（前端显示 ~）；混有不明价 → costPartial=true（前端显示 ≥）
    fn cost(&self, table: &[(String, (f64, f64))]) -> (Option<f64>, bool) {
        let mut total = 0.0;
        let mut has_priced = false;
        let mut has_unpriced = false;
        for (model, acc) in &self.by_model {
            if acc.input + acc.output + acc.cache_read + acc.cache_write == 0 {
                continue;
            }
            match price_of(model, table) {
                Some(price) => {
                    has_priced = true;
                    total += cost_of(acc, price);
                }
                None => has_unpriced = true,
            }
        }
        (if has_priced { Some(total) } else { None }, has_unpriced)
    }
}

type StoredUsageRow = (
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    i64,
    String,
    bool,
    String, // workspace：工作区名，非工作区会话为 ""
    bool,   // official：官方账号（订阅制）用量，不按量计费
);

fn build_stats(
    rows: Vec<StoredUsageRow>,
    table: &[(String, (f64, f64))],
    rate_usd_cny: f64,
) -> UsageStatsDto {
    let mut cards = Bucket::default();
    // (agent, official)：官方账号用量与 API 用量分桶，费用栏分别显示「订阅」与估算金额
    let mut by_agent: HashMap<(String, bool), Bucket> = HashMap::new();
    let mut by_project: HashMap<(String, String, bool, bool), Bucket> = HashMap::new();
    let mut by_model: HashMap<(String, String, bool), Bucket> = HashMap::new();
    // (工作区名, 所属仓库路径, internal, official)：同名工作区在不同仓库下各自成行
    let mut by_workspace: HashMap<(String, String, bool, bool), Bucket> = HashMap::new();
    for (_day, agent, model, project, sid, i, o, cr, cw, source, internal, workspace, official) in rows {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
        };
        cards.add(&model, &sid, acc);
        by_agent
            .entry((agent, official))
            .or_default()
            .add(&model, &sid, acc);
        by_project
            .entry((project.clone(), source.clone(), internal, official))
            .or_default()
            .add(&model, &sid, acc);
        by_model
            .entry((model.clone(), source, internal))
            .or_default()
            .add(&model, &sid, acc);
        if !workspace.is_empty() {
            by_workspace
                .entry((workspace, project, internal, official))
                .or_default()
                .add(&model, &sid, acc);
        }
    }
    let total = |b: &Bucket| b.tokens.input + b.tokens.output;
    let mut agent_rows: Vec<UsageAgentRowDto> = by_agent
        .into_iter()
        .map(|((agent, official), b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageAgentRowDto {
                tokens: total(&b),
                cost_usd,
                cost_partial,
                agent,
                model_count: b.by_model.len() as u32,
                official,
            }
        })
        .collect();
    agent_rows.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    agent_rows.truncate(LIST_CAP);
    let mut project_rows: Vec<UsageProjectRowDto> = by_project
        .into_iter()
        .map(|((project_path, source, internal, official), b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageProjectRowDto {
                tokens: total(&b),
                sessions: b.sessions.len() as u64,
                cost_usd,
                cost_partial,
                project_path,
                source,
                internal,
                official,
            }
        })
        .collect();
    project_rows.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    project_rows.truncate(LIST_CAP);
    let mut model_rows: Vec<UsageModelRowDto> = by_model
        .into_iter()
        .map(|((model, source, internal), b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageModelRowDto {
                model: if model.is_empty() { "(未知)".into() } else { model },
                input: b.tokens.input,
                output: b.tokens.output,
                cost_usd,
                cost_partial,
                source,
                internal,
            }
        })
        .collect();
    model_rows.sort_by(|a, b| (b.input + b.output).cmp(&(a.input + a.output)));
    model_rows.truncate(LIST_CAP);
    let mut workspace_rows: Vec<UsageWorkspaceRowDto> = by_workspace
        .into_iter()
        .map(|((workspace, repo_path, internal, official), b)| {
            let (cost, cost_partial) = b.cost(table);
            UsageWorkspaceRowDto {
                workspace_name: workspace,
                repo_name: Path::new(&repo_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(repo_path),
                tokens_in: b.tokens.input,
                tokens_out: b.tokens.output,
                cost,
                cost_partial,
                models: b.by_model.len() as u32,
                internal,
                official,
            }
        })
        .collect();
    workspace_rows.sort_by(|a, b| {
        (b.tokens_in + b.tokens_out).cmp(&(a.tokens_in + a.tokens_out))
    });
    workspace_rows.truncate(LIST_CAP);
    let (cards_cost, cards_partial) = cards.cost(table);
    UsageStatsDto {
        cards: UsageCardsDto {
            input: cards.tokens.input,
            output: cards.tokens.output,
            cache_read: cards.tokens.cache_read,
            cache_write: cards.tokens.cache_write,
            sessions: cards.sessions.len() as u64,
            cost_usd: cards_cost,
            cost_partial: cards_partial,
        },
        by_agent: agent_rows,
        by_project: project_rows,
        by_model: model_rows,
        by_workspace: workspace_rows,
        rate_usd_cny,
    }
}

fn query_stats(range: &str) -> Result<UsageStatsDto, String> {
    let conn = usage_db()?;
    let (sql, cutoff) = match cutoff_day(range) {
        Some(c) => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write,
                    source, internal, workspace, official
             FROM usage_daily WHERE day >= ?1",
            Some(c),
        ),
        None => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write,
                    source, internal, workspace, official
             FROM usage_daily",
            None,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows: Vec<StoredUsageRow> = {
        let map_row = |r: &rusqlite::Row| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                r.get::<_, i64>(10)? != 0, r.get(11)?, r.get::<_, i64>(12)? != 0,
            ))
        };
        let collected: rusqlite::Result<Vec<_>> = match &cutoff {
            Some(c) => stmt.query_map(params![c], map_row).map_err(|e| e.to_string())?.collect(),
            None => stmt.query_map([], map_row).map_err(|e| e.to_string())?.collect(),
        };
        collected.map_err(|e| e.to_string())?
    };
    let pricing_path = dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
    let table = load_pricing(pricing_path.as_deref());
    Ok(build_stats(
        rows,
        &table,
        load_rate(pricing_path.as_deref()),
    ))
}

// ===== DTO 与 commands =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBuildResult {
    pub sessions_indexed: usize,
    pub rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCardsDto {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub sessions: u64,
    /// 已计价模型的份额合计；全部不明价时为 None
    pub cost_usd: Option<f64>,
    /// 桶里还混有不明价模型的用量（费用应显示为 ≥）
    pub cost_partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAgentRowDto {
    pub agent: String,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    /// 该 agent 在统计范围内使用过的不同模型数
    pub model_count: u32,
    /// 官方账号（订阅制）用量：不按量计费，前端费用栏显示「订阅」
    pub official: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProjectRowDto {
    pub project_path: String,
    pub tokens: u64,
    pub sessions: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub source: String,
    pub internal: bool,
    /// 官方账号（订阅制）用量：不按量计费，前端费用栏显示「订阅」
    pub official: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelRowDto {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub source: String,
    pub internal: bool,
}

/// 任务成本（§P5 成本按工作区归因）：usage 落在某工作区 worktree 内的会话按工作区成桶
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWorkspaceRowDto {
    pub workspace_name: String,
    /// 所属项目（仓库）名
    pub repo_name: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 与项目排行同口径：已计价模型份额合计，全部不明价为 None
    pub cost: Option<f64>,
    pub cost_partial: bool,
    /// 统计范围内用过的不同模型数
    pub models: u32,
    pub internal: bool,
    /// 官方账号（订阅制）用量：不按量计费，前端费用栏显示「订阅」
    pub official: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsDto {
    pub cards: UsageCardsDto,
    pub by_agent: Vec<UsageAgentRowDto>,
    pub by_project: Vec<UsageProjectRowDto>,
    pub by_model: Vec<UsageModelRowDto>,
    /// 按工作区/任务归因的成本（仅含命中工作区的用量，按 token 降序）
    pub by_workspace: Vec<UsageWorkspaceRowDto>,
    /// USD→CNY 汇率（pricing.json 的 "_rate" 可覆盖，默认 7.2）
    pub rate_usd_cny: f64,
}

#[tauri::command]
pub async fn rebuild_usage_index() -> Result<UsageBuildResult, String> {
    tauri::async_runtime::spawn_blocking(rebuild_impl)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_usage_stats(range: String) -> Result<UsageStatsDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 首次使用自动建索引，页面无需手动触发
        let first_run = usage_db()
            .map(|conn| meta_get(&conn, "initialized").is_none())
            .unwrap_or(false);
        if first_run {
            rebuild_impl()?;
        }
        query_stats(&range)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(day: &str, model: &str, input: u64, output: u64) -> UsageEvent {
        UsageEvent {
            day: day.into(),
            model: model.into(),
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        }
    }

    #[test]
    fn aggregate_groups_by_day_model_session() {
        let contribs = vec![
            SessionContrib {
                agent: "codex".into(),
                session_id: "s1".into(),
                project_path: "/p".into(),
                workspace: String::new(),
                events: vec![ev("2026-07-01", "gpt-5", 10, 5), ev("2026-07-01", "gpt-5", 20, 5), ev("2026-07-02", "gpt-5", 1, 1)],
            },
            SessionContrib {
                agent: "codex".into(),
                session_id: "s2".into(),
                project_path: "/p".into(),
                workspace: String::new(),
                events: vec![ev("2026-07-01", "gpt-5", 7, 3)],
            },
            SessionContrib {
                agent: "claude-code".into(),
                session_id: "s3".into(),
                project_path: "/p".into(),
                workspace: String::new(),
                events: vec![], // 无 usage 的会话不产生行
            },
        ];
        let rows = aggregate(&contribs);
        assert_eq!(rows.len(), 3, "(d1,s1)+(d1,s2)+(d2,s1) 三行");
        let d1s1 = rows.iter().find(|r| r.day == "2026-07-01" && r.session_id == "s1").unwrap();
        assert_eq!((d1s1.input, d1s1.output), (30, 10));
        let d2 = rows.iter().find(|r| r.day == "2026-07-02").unwrap();
        assert_eq!((d2.input, d2.session_id.as_str()), (1, "s1"));
    }

    #[test]
    fn aggregate_drops_events_without_day() {
        let contribs = vec![SessionContrib {
            agent: "kimi".into(),
            session_id: "s1".into(),
            project_path: "/p".into(),
            workspace: String::new(),
            events: vec![ev("", "kimi-k2", 10, 5), ev("2026-08-01", "kimi-k2", 1, 1)],
        }];
        let rows = aggregate(&contribs);
        assert_eq!(rows.len(), 1, "时间戳缺失的事件不得产出 day=\"\" 噪声行");
        assert_eq!(rows[0].day, "2026-08-01");
        assert_eq!((rows[0].input, rows[0].output), (1, 1));
    }

    #[test]
    fn seen_key_parse_roundtrips_new_format_only() {
        assert_eq!(
            parse_seen_key("seen:codex:s1:live"),
            Some(("codex".into(), "s1".into()))
        );
        assert_eq!(
            parse_seen_key("seen:claude-code:abc:snap"),
            Some(("claude-code".into(), "abc".into()))
        );
        // 旧格式（无来源后缀）与损坏键反解失败，避免误删其他会话的行
        assert_eq!(parse_seen_key("seen:codex:s1"), None);
        assert_eq!(parse_seen_key("seen:onlyone"), None);
        assert_eq!(parse_seen_key("other:x"), None);
    }

    #[test]
    fn opencode_events_streamed_from_db() {
        let dir = std::env::temp_dir().join(format!("ccode-usage-oc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("opencode.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
            let rows = [
                ("m1", "s1", 1785307071000i64, r#"{"role":"user"}"#),
                ("m2", "s1", 1785307072000, r#"{"role":"assistant","modelID":"grok-4","tokens":{"input":10,"output":5,"reasoning":2,"cache":{"read":3,"write":1}}}"#),
                ("m3", "s2", 1785307073000, r#"{"role":"assistant","tokens":{"input":99,"output":9}}"#),
            ];
            for (id, sid, t, data) in rows {
                conn.execute("INSERT INTO message VALUES(?1,?2,?3,?4)", params![id, sid, t, data])
                    .unwrap();
            }
        }
        let events = opencode_events(&db, "s1");
        assert_eq!(events.len(), 1, "只取本会话的 assistant 行");
        assert_eq!(events[0].day, day_of_ms(1785307072000));
        assert_eq!(
            (events[0].input, events[0].output, events[0].cache_read, events[0].cache_write),
            (10, 7, 3, 1),
            "reasoning 计入输出侧"
        );
        assert_eq!(events[0].model, "grok-4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pricing_override_ignores_empty_prefix() {
        let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pricing.json");
        std::fs::write(&p, r#"{"": [9.0, 9.0], "relay-y": [0.5, 0.5]}"#).unwrap();
        let table = load_pricing(Some(&p));
        assert_eq!(price_of("totally-unknown-model", &table), None, "空前缀不得匹配一切模型");
        assert_eq!(price_of("relay-y-x", &table), Some((0.5, 0.5)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn usage_schema_migration_resets_unclassified_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO usage_daily VALUES('2026-08-01','codex','gpt-5','/tmp/manual','s1',1,1,0,0);
             INSERT INTO usage_meta VALUES('initialized','old'),('seen:codex:s1','old');",
        )
        .unwrap();
        ensure_usage_schema(&conn).unwrap();
        let columns = usage_columns(&conn).unwrap();
        assert!(columns.contains("source"));
        assert!(columns.contains("internal"));
        assert!(columns.contains("workspace"), "v5 起补工作区归因列");
        assert!(columns.contains("official"), "v6 起补官方账号标记列");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_daily", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0,
            "没有来源证据的旧索引必须重建"
        );
        assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some(USAGE_SCHEMA_VERSION));
        assert!(meta_get(&conn, "initialized").is_none());
    }

    #[test]
    fn internal_provenance_is_exact_not_tmp_path_heuristic() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        register_provenance_impl(
            &conn,
            "codex",
            "/private/tmp/ccode-ai-known",
            SOURCE_CCODE_AI,
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            session_provenance(&conn, "codex", "/private/tmp/ccode-ai-known"),
            (SOURCE_CCODE_AI.into(), true, false)
        );
        assert_eq!(
            session_provenance(&conn, "codex", "/tmp/user-task"),
            (SOURCE_CLI.into(), false, false),
            "用户主动在 /tmp 运行不得被判成内部活动"
        );
        assert_eq!(
            session_provenance(&conn, "codex", "/tmp/ccode-ai-unregistered"),
            (SOURCE_CLI.into(), false, false),
            "仅路径长得像 Ccode 临时任务也不是来源证据"
        );
        assert_eq!(
            session_provenance(&conn, "claude-code", "/private/tmp/ccode-ai-known"),
            (SOURCE_CLI.into(), false, false),
            "来源登记同时绑定 agent"
        );
        #[cfg(target_os = "macos")]
        {
            register_provenance_impl(
                &conn,
                "kimi",
                "/var/folders/test/ccode-ai-canonical",
                SOURCE_CCODE_AI,
                true,
                false,
            )
            .unwrap();
            assert_eq!(
                session_provenance(
                    &conn,
                    "kimi",
                    "/private/var/folders/test/ccode-ai-canonical"
                ),
                (SOURCE_CCODE_AI.into(), true, false),
                "macOS 临时目录别名只做路径归一化，不影响来源判定"
            );
        }
    }

    #[test]
    fn official_provenance_marks_rows_and_splits_cost_buckets() {
        // 登记 → 命中 → official 标记：与 internal 同一精确匹配口径（agent + 归一化项目路径）
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        register_provenance_impl(&conn, "gemini", "/home/u/proj", SOURCE_CLI, false, true).unwrap();
        assert_eq!(
            session_provenance(&conn, "gemini", "/home/u/proj"),
            (SOURCE_CLI.into(), false, true),
            "官方账号登记：source 保持 cli，只标 official"
        );
        assert_eq!(
            session_provenance(&conn, "gemini", "/home/u/other"),
            (SOURCE_CLI.into(), false, false),
            "未登记的项目不受影响"
        );
        assert_eq!(
            session_provenance(&conn, "codex", "/home/u/proj"),
            (SOURCE_CLI.into(), false, false),
            "official 登记同样绑定 agent"
        );
        // 同一 agent 下 official 与普通用量在 agent/项目/工作区维度分桶，费用互不染指
        let rows: Vec<StoredUsageRow> = vec![
            ws_row("/home/u/proj", "s1", "gemini-3-pro", 100, 10, false, ""),
            {
                let mut r = ws_row("/home/u/proj", "s2", "gemini-3-pro", 50, 5, false, "");
                r.12 = true;
                r
            },
            {
                let mut r = ws_row("/home/u/proj", "s3", "gemini-3-pro", 20, 2, false, "task-x");
                r.12 = true;
                r
            },
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        let official_agent = stats.by_agent.iter().find(|a| a.official).unwrap();
        let normal_agent = stats.by_agent.iter().find(|a| !a.official).unwrap();
        assert_eq!(official_agent.tokens, 50 + 5 + 20 + 2);
        assert_eq!(normal_agent.tokens, 110);
        assert!(normal_agent.cost_usd.is_some(), "普通行仍按官方价估算");
        let official_project = stats.by_project.iter().find(|p| p.official).unwrap();
        assert_eq!(official_project.sessions, 2);
        assert!(stats.by_project.iter().any(|p| !p.official));
        let official_ws = stats.by_workspace.iter().find(|w| w.official).unwrap();
        assert_eq!(official_ws.workspace_name, "task-x");
        assert_eq!(official_ws.tokens_in + official_ws.tokens_out, 22);
    }

    #[test]
    fn prune_stale_provenance_removes_only_old_gone_tmp_rows() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let tmp = normalize_provenance_path(&std::env::temp_dir().to_string_lossy());
        let gone_old = format!("{tmp}/ccode-prune-gone-{}", uuid::Uuid::new_v4());
        let gone_recent = format!("{tmp}/ccode-prune-recent-{}", uuid::Uuid::new_v4());
        // 固定选一个永远早于「现在-7 天」的日期（2020 年），不做墙钟硬断言
        let old = "2020-01-01T00:00:00Z";
        let recent = crate::sessions::now_iso();
        for (path, at) in [
            (gone_old.as_str(), old),               // tmp 下 + 不存在 + 老 → 删
            (gone_recent.as_str(), recent.as_str()), // tmp 下 + 不存在 + 新 → 留
            (tmp.as_str(), old),                    // tmp 下 + 老但目录还在 → 留
            ("/ccode-test-real-project", old),      // 不在 tmp 下 → 留
        ] {
            conn.execute(
                "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
                 VALUES('kimi', ?1, ?2, 1, ?3)",
                params![path, SOURCE_CCODE_AI, at],
            )
            .unwrap();
        }
        prune_stale_provenance(&conn);
        let mut rows: Vec<String> = conn
            .prepare("SELECT project_path FROM usage_provenance")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        rows.sort();
        let mut expected = vec!["/ccode-test-real-project".to_string(), gone_recent, tmp];
        expected.sort();
        assert_eq!(rows, expected, "只有「tmp 下 + 目录已消失 + 超 7 天」的行被清");
    }

    #[test]
    fn stats_keep_internal_dimension_for_same_model() {
        let rows: Vec<StoredUsageRow> = vec![
            (
                "2026-08-01".into(),
                "codex".into(),
                "gpt-5-codex".into(),
                "/tmp/user-task".into(),
                "normal".into(),
                100,
                10,
                0,
                0,
                SOURCE_CLI.into(),
                false,
                String::new(),
                false,
            ),
            (
                "2026-08-01".into(),
                "codex".into(),
                "gpt-5-codex".into(),
                "/private/tmp/ccode-ai-known".into(),
                "internal".into(),
                20,
                5,
                0,
                0,
                SOURCE_CCODE_AI.into(),
                true,
                String::new(),
                false,
            ),
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        assert_eq!(stats.by_project.len(), 2);
        assert!(stats
            .by_project
            .iter()
            .any(|row| row.project_path == "/tmp/user-task" && !row.internal && row.source == SOURCE_CLI));
        assert!(stats.by_project.iter().any(|row| row.internal && row.source == SOURCE_CCODE_AI));
        assert_eq!(stats.by_model.len(), 2, "相同模型的普通与内部用量不得混成一行");
        assert!(stats.by_model.iter().any(|row| !row.internal));
        assert!(stats.by_model.iter().any(|row| row.internal));
    }

    /// 造一行 StoredUsageRow（official 默认 false，workspace 之外参数从简）
    fn ws_row(
        project: &str,
        sid: &str,
        model: &str,
        input: i64,
        output: i64,
        internal: bool,
        workspace: &str,
    ) -> StoredUsageRow {
        (
            "2026-08-01".into(),
            "codex".into(),
            model.into(),
            project.into(),
            sid.into(),
            input,
            output,
            0,
            0,
            SOURCE_CLI.into(),
            internal,
            workspace.into(),
            false,
        )
    }

    #[test]
    fn workspace_attribution_groups_and_keeps_project_dimension() {
        let rows: Vec<StoredUsageRow> = vec![
            // 工作区会话（扫描已把项目路径改写为真实仓库，workspace 列记工作区名）
            ws_row("/home/u/code/myrepo", "s1", "gpt-5", 100, 10, false, "feat-x"),
            ws_row("/home/u/code/myrepo", "s2", "gpt-5", 50, 5, false, "feat-x"),
            // 同名工作区在另一个仓库下：各自成行
            ws_row("/home/u/code/other", "s3", "gpt-5", 30, 3, false, "feat-x"),
            // 主仓库 / 非工作区会话：不进 by_workspace，项目维度不受影响
            ws_row("/home/u/code/myrepo", "s4", "gpt-5", 7, 1, false, ""),
            ws_row("/elsewhere", "s5", "gpt-5", 9, 1, false, ""),
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        assert_eq!(stats.by_workspace.len(), 2, "同名不同仓库的工作区不得合并");
        let feat_myrepo = stats
            .by_workspace
            .iter()
            .find(|r| r.repo_name == "myrepo")
            .unwrap();
        assert_eq!(feat_myrepo.workspace_name, "feat-x");
        assert_eq!((feat_myrepo.tokens_in, feat_myrepo.tokens_out), (150, 15));
        assert_eq!(feat_myrepo.models, 1);
        assert!(feat_myrepo.cost.is_some(), "gpt-5 官方价应可估算");
        assert!(!feat_myrepo.cost_partial);
        assert!(!feat_myrepo.internal);
        assert!(stats
            .by_workspace
            .iter()
            .all(|r| !r.workspace_name.is_empty()));
        // 项目维度保持原样：工作区用量仍计入所属仓库项目行
        let proj = stats
            .by_project
            .iter()
            .find(|p| p.project_path == "/home/u/code/myrepo")
            .unwrap();
        assert_eq!(proj.tokens, 150 + 15 + 7 + 1);
    }

    #[test]
    fn workspace_rows_sorted_by_tokens_and_partial_cost() {
        let rows: Vec<StoredUsageRow> = vec![
            ws_row("/r/a", "s1", "mystery-model", 10, 10, false, "small"),
            ws_row("/r/a", "s2", "gpt-5", 1_000_000, 1_000_000, false, "big"),
            ws_row("/r/a", "s3", "mystery-model", 5, 5, false, "big"),
            // 内部来源落在工作区时与普通行分桶，开关口径与项目排行一致
            ws_row("/r/a", "s4", "gpt-5", 60, 6, true, "big"),
        ];
        let stats = build_stats(rows, &load_pricing(None), 7.2);
        assert_eq!(stats.by_workspace.len(), 3);
        assert_eq!(stats.by_workspace[0].workspace_name, "big", "按 token 降序");
        assert!(!stats.by_workspace[0].internal);
        let big = &stats.by_workspace[0];
        assert!(big.cost.is_some(), "只累加已计价份额");
        assert!(big.cost_partial, "混有不明价模型必须标记 ≥");
        assert_eq!(big.models, 2);
        let big_internal = stats
            .by_workspace
            .iter()
            .find(|r| r.workspace_name == "big" && r.internal)
            .unwrap();
        assert!(!big_internal.cost_partial);
        let small = stats
            .by_workspace
            .iter()
            .find(|r| r.workspace_name == "small")
            .unwrap();
        assert_eq!(small.cost, None, "全部不明价 → 费用 None（前端显示 ~）");
        assert!(small.cost_partial);
    }

    #[test]
    fn pricing_longest_prefix_and_unknown() {
        let table = load_pricing(None);
        assert_eq!(price_of("gpt-5-codex-mini", &table), Some((1.25, 10.0)));
        assert_eq!(price_of("claude-sonnet-4-5", &table), Some((3.0, 15.0)));
        assert_eq!(price_of("some-relay-model", &table), None);
        assert_eq!(price_of("", &table), None, "未知模型无价格");
        // 扩充的中转/聚合模型走官方价
        assert_eq!(price_of("grok-4.5", &table), Some((3.0, 15.0)), "grok-4 前缀");
        assert_eq!(price_of("grok-4.1-fast-mini", &table), Some((0.2, 0.5)), "更长前缀优先于 grok-4");
        assert_eq!(price_of("grok-3-mini-128k", &table), Some((0.3, 0.5)));
        assert_eq!(price_of("grok-code-fast-1", &table), Some((0.2, 1.5)));
        assert_eq!(price_of("glm-4.6-air", &table), Some((0.6, 2.2)));
        assert_eq!(price_of("qwen3-coder-plus", &table), Some((0.5, 2.0)), "qwen3-coder 优先于 qwen3");
        assert_eq!(price_of("qwen3-max", &table), Some((0.5, 2.0)));
        assert_eq!(price_of("moonshot-v1-8k", &table), Some((0.6, 3.0)));
        assert_eq!(price_of("gemini-3-pro-preview", &table), Some((2.0, 12.0)));
        assert_eq!(price_of("gemini-3.6-flash-lite", &table), Some((0.3, 2.5)));
        assert_eq!(price_of("gemini-2.5-pro", &table), Some((1.25, 10.0)), "旧条目保留");
        // 新增条目
        assert_eq!(price_of("claude-fable-2", &table), Some((15.0, 75.0)));
        assert_eq!(price_of("gemini-3.5-flash-tts", &table), Some((0.3, 2.5)));
        assert_eq!(price_of("gemini-3.1-pro-preview", &table), Some((2.0, 12.0)));
    }

    #[test]
    fn pricing_strips_provider_prefix() {
        let table = load_pricing(None);
        // 中转/聚合的 provider 前缀：按最后一个 / 之后的末段匹配
        assert_eq!(price_of("accounts/fireworks/models/glm-5p2", &table), Some((0.6, 2.2)), "glm 前缀命中");
        assert_eq!(price_of("zetatechs/kimi-k3", &table), Some((2.78, 13.89)));
        assert_eq!(price_of("openrouter/claude-sonnet-4", &table), Some((3.0, 15.0)));
        assert_eq!(price_of("relay/mystery-x", &table), None, "末段不明依然不明价");
    }

    #[test]
    fn rate_priority_chain() {
        assert_eq!(load_rate_with(None, None), 7.2, "默认 7.2");
        let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pricing.json");
        std::fs::write(&p, r#"{"_rate": 7.05, "claude-sonnet": [1.0, 5.0]}"#).unwrap();
        assert_eq!(load_rate_with(None, Some(&p)), 7.05, "_rate 键覆盖默认汇率");
        assert_eq!(load_rate_with(Some(7.3), Some(&p)), 7.3, "settings.json 优先于 pricing.json _rate");
        assert_eq!(load_rate_with(Some(7.3), None), 7.3);
        std::fs::write(&p, r#"{"_rate": -1}"#).unwrap();
        assert_eq!(load_rate_with(None, Some(&p)), 7.2, "非法 _rate 回落默认");
        assert_eq!(load_rate_with(Some(-2.0), None), 7.2, "非法 settings 汇率同样回落");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pricing_override_merges_over_builtins() {
        let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("pricing.json");
        std::fs::write(&p, r#"{"claude-sonnet": [1.0, 5.0], "relay-x": [0.1, 0.2]}"#).unwrap();
        let table = load_pricing(Some(&p));
        assert_eq!(price_of("claude-sonnet-4", &table), Some((1.0, 5.0)), "覆盖内置");
        assert_eq!(price_of("relay-x-pro", &table), Some((0.1, 0.2)), "新增自定义前缀");
        assert_eq!(price_of("claude-opus-4", &table), Some((15.0, 75.0)), "内置保留");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn range_cutoff_days() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 30).unwrap();
        assert_eq!(cutoff_day_from("today", today).as_deref(), Some("2026-07-30"));
        assert_eq!(cutoff_day_from("week", today).as_deref(), Some("2026-07-24"));
        assert_eq!(cutoff_day_from("month", today).as_deref(), Some("2026-07-01"));
        assert_eq!(cutoff_day_from("all", today), None);
    }

    #[test]
    fn bucket_cost_partial_semantics() {
        let table = load_pricing(None);
        // 全计价 → 精确费用，非 partial
        let mut b = Bucket::default();
        b.add("gpt-5", "s1", TokenAcc { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 });
        assert_eq!(b.cost(&table), (Some(1.25 + 10.0), false));
        // 混有不明价 → 只算已计价份额，partial=true
        b.add("mystery", "s2", TokenAcc { input: 5, output: 5, cache_read: 0, cache_write: 0 });
        let (cost, partial) = b.cost(&table);
        assert_eq!(cost, Some(11.25), "不明价模型不再毒化整桶");
        assert!(partial);
        // 全不明价 → None（partial 也置位，前端显示 ~）
        let mut c = Bucket::default();
        c.add("mystery", "s1", TokenAcc { input: 5, output: 5, cache_read: 0, cache_write: 0 });
        assert_eq!(c.cost(&table), (None, true));
    }

    #[test]
    fn extractors_claude_codex_kimi() {
        // claude：assistant 行的 usage + model
        let lines = vec![
            r#"{"type":"assistant","timestamp":"2026-07-29T01:00:00Z","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":"q"}}"#.to_string(),
        ];
        let evs = claude_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(
            (evs[0].day.as_str(), evs[0].model.as_str()),
            (day_of_iso("2026-07-29T01:00:00Z").as_str(), "claude-sonnet-4-5")
        );
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read, evs[0].cache_write), (10, 5, 3, 2));
        // codex：turn_context 定 model，token_count 的 last_token_usage 是本轮增量
        let lines = vec![
            r#"{"timestamp":"2026-07-29T02:00:00Z","type":"turn_context","payload":{"model":"gpt-5-codex"}}"#.to_string(),
            r#"{"timestamp":"2026-07-29T02:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10},"total_token_usage":{"input_tokens":999}}}}"#.to_string(),
        ];
        let evs = codex_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read), (100, 25, 10), "用增量而非累计");
        assert_eq!(evs[0].model, "gpt-5-codex");
        // kimi：usage.record
        let lines = vec![
            r#"{"type":"usage.record","model":"kimi-k2","usage":{"inputOther":50,"output":9,"inputCacheRead":4,"inputCacheCreation":1},"time":1785307071000}"#.to_string(),
        ];
        let evs = kimi_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1785307071000));
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read, evs[0].cache_write), (50, 9, 4, 1));
    }

    #[test]
    fn large_jsonl_and_zstd_sessions_are_streamed() {
        use std::io::{BufWriter, Write};

        let dir = std::env::temp_dir().join(format!("ccode-usage-stream-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("large.jsonl");
        let mut writer = BufWriter::new(File::create(&plain).unwrap());
        writeln!(writer, r#"{{"timestamp":"2026-08-04T04:00:00Z","type":"turn_context","payload":{{"model":"gpt-5-codex"}}}}"#).unwrap();
        let ignored = format!("{}\n", "x".repeat(1024));
        for _ in 0..10_300 {
            writer.write_all(ignored.as_bytes()).unwrap();
        }
        writeln!(writer, r#"{{"timestamp":"2026-08-04T04:01:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10}}}}}}}}"#).unwrap();
        writer.flush().unwrap();
        assert!(std::fs::metadata(&plain).unwrap().len() > 10 * 1024 * 1024);
        let events = extract_file_events("codex", &plain);
        assert_eq!(events.len(), 1, "大于旧 10 MB 上限的会话不得整份跳过");
        assert_eq!((events[0].input, events[0].output, events[0].cache_read), (100, 25, 10));

        let compressed = dir.join("small.jsonl.zst");
        let raw = std::fs::read(&plain).unwrap();
        std::fs::write(&compressed, zstd::stream::encode_all(&raw[..], 1).unwrap()).unwrap();
        let compressed_events = extract_file_events("codex", &compressed);
        assert_eq!(compressed_events, events, "zstd 会话必须同样流式解码并提取用量");
        std::fs::remove_dir_all(&dir).ok();
    }
}



// ===== profile 用量近似归属（按模型名匹配，含 provider 前缀剥离）=====

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsageDto {
    pub input: i64,
    pub output: i64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
}

/// 近似归属规则：usage_daily.model == m 或以 "/m" 结尾（剥离供应商前缀后与 profile 模型匹配）
fn profile_usage_impl(conn: &rusqlite::Connection, models: &[String]) -> Result<ProfileUsageDto, String> {
    if models.is_empty() {
        return Ok(ProfileUsageDto {
            input: 0,
            output: 0,
            cost_usd: None,
            cost_partial: false,
        });
    }
    let mut stmt = conn
        .prepare("SELECT model, session_id, input, output, cache_read, cache_write FROM usage_daily")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut bucket = Bucket::default();
    for (model, session_id, input, output, cache_read, cache_write) in rows.flatten() {
        let hit = models
            .iter()
            .any(|m| model == *m || model.ends_with(&format!("/{m}")));
        if hit {
            bucket.add(
                &model,
                &session_id,
                TokenAcc {
                    input: input as u64,
                    output: output as u64,
                    cache_read: cache_read as u64,
                    cache_write: cache_write as u64,
                },
            );
        }
    }
    let table = load_pricing(None);
    let (cost_usd, cost_partial) = bucket.cost(&table);
    Ok(ProfileUsageDto {
        input: bucket.tokens.input as i64,
        output: bucket.tokens.output as i64,
        cost_usd,
        cost_partial,
    })
}

#[tauri::command]
pub async fn profile_usage(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    profile_id: String,
) -> Result<ProfileUsageDto, String> {
    let models = store.get(&profile_id)?.models;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        profile_usage_impl(&conn, &models)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod profile_usage_tests {
    use super::*;

    #[test]
    fn profile_usage_matches_exact_and_prefixed_models() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
             input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
             PRIMARY KEY(day, agent, model, project_path, session_id));
             INSERT INTO usage_daily VALUES
             ('2026-08-01','claude-code','kimi-k3','/p','s1',1000,100,0,0),
             ('2026-08-01','claude-code','zetatechs/kimi-k3','/p','s2',2000,200,0,0),
             ('2026-08-01','codex','gpt-5.6','/p','s3',9999,999,0,0);",
        )
        .unwrap();
        let dto = profile_usage_impl(&conn, &["kimi-k3".to_string()]).unwrap();
        assert_eq!(dto.input, 3000);
        assert_eq!(dto.output, 300);
        // kimi-k3 在定价表（官方 ¥20/¥100 ≈ $2.78/$13.89），应有费用且不 partial
        assert!(dto.cost_usd.is_some());
        assert!(!dto.cost_partial);
    }
}
