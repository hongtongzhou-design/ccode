//! 用量与费用统计（§6.11）：各 agent 的会话 usage 按天聚合进 app.db，
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

/// CodeBuddy：usage/工具调用字段未实证（实测样本是 401 会话，无 usage 行），
/// 按 Anthropic 兼容字段名尽力而为；无 usage 字段的行不产生事件（不报错）。
/// TODO: 拿到真账号样本后补全实际字段名。
fn codebuddy_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        if get_str(&v, "type") != Some("message") || get_str(&v, "role") != Some("assistant") {
            continue;
        }
        let Some(u) = v.get("usage") else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        // timestamp 是毫秒 epoch 数字（容错 ISO 字符串）
        let day = match v.get("timestamp") {
            Some(Value::Number(n)) => n.as_i64().map(day_of_ms).unwrap_or_default(),
            Some(Value::String(s)) => day_of_iso(s),
            _ => String::new(),
        };
        out.push(UsageEvent {
            day,
            model: get_str(&v, "model").unwrap_or("").to_string(),
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

/// Cursor：usage 字段未实证（调研无真账号样本，2026.08.04-aaa8809），
/// 按常见字段名候选尽力而为；无 usage 字段的行不产生事件（不报错）。
/// TODO: 拿到真账号样本后补全实际字段名。
fn cursor_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        let Some(u) = v.get("usage") else {
            continue;
        };
        // 字段名候选：snake_case / camelCase / OpenAI 风格
        let nums = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| u.get(k).and_then(|x| x.as_u64()))
                .unwrap_or(0)
        };
        // 时间戳字段名未实证，多候选；数字按量级区分毫秒/秒 epoch，字符串当 ISO
        let day = ["timestamp", "time", "created_at", "createdAt", "ts"]
            .iter()
            .find_map(|k| match v.get(k) {
                Some(Value::Number(n)) => n.as_i64().map(|raw| {
                    if raw.abs() >= 1_000_000_000_000 {
                        day_of_ms(raw)
                    } else {
                        day_of_ms(raw * 1000)
                    }
                }),
                Some(Value::String(s)) => Some(day_of_iso(s)),
                _ => None,
            })
            .unwrap_or_default();
        out.push(UsageEvent {
            day,
            model: get_str(&v, "model").unwrap_or("").to_string(),
            input: nums(&["input_tokens", "inputTokens", "prompt_tokens"]),
            output: nums(&["output_tokens", "outputTokens", "completion_tokens"]),
            cache_read: nums(&["cache_read_input_tokens", "cacheReadInputTokens"]),
            cache_write: nums(&["cache_creation_input_tokens", "cacheCreationInputTokens"]),
            source: SOURCE_CLI.into(),
            internal: false,
            official: false,
        });
    }
    out
}

/// Grok Build：token usage 在 updates.jsonl 中 turn 结束时的 ACP 通知 `_meta.usage`（PromptUsage）：
/// input_tokens/output_tokens/total_tokens/cached_read_tokens + modelUsage{<model>:{...}}。
/// _meta 位置未完全实证（params._meta 或 params.update._meta 两种都探）；
/// 无 usage 字段的行不产生事件（不报错）。模型取 modelUsage 的第一个键（多模型取其一）。
fn grok_events<I, S>(lines: I) -> Vec<UsageEvent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        let Some(params) = v.get("params") else {
            continue;
        };
        // _meta 两层兼容：params._meta 或 params.update._meta
        let usage = params
            .get("_meta")
            .and_then(|m| m.get("usage"))
            .or_else(|| {
                params
                    .get("update")
                    .and_then(|u| u.get("_meta"))
                    .and_then(|m| m.get("usage"))
            });
        let Some(u) = usage else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        // 时间戳是 unix 秒数字（容错 ISO 字符串）
        let day = match v.get("timestamp") {
            Some(Value::Number(n)) => n.as_i64().map(|s| day_of_ms(s * 1000)).unwrap_or_default(),
            Some(Value::String(s)) => day_of_iso(s),
            _ => String::new(),
        };
        // modelUsage 是 <model> → {...} 的 map；模型名取第一个键
        let model = u
            .get("modelUsage")
            .and_then(|m| m.as_object())
            .and_then(|o| o.keys().next().cloned())
            .unwrap_or_default();
        out.push(UsageEvent {
            day,
            model,
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_read: num("cached_read_tokens"),
            cache_write: 0,
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
        "codebuddy" => codebuddy_events(lines),
        "cursor" => cursor_events(lines),
        "grok" => grok_events(lines),
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

/// 缓存读相对「按输入全价」省下的钱：实际按 1 折计，省 9 折。无定价或 0 读则 None。
fn cache_savings_usd(model: &str, cache_read: u64, table: &[(String, (f64, f64))]) -> Option<f64> {
    if cache_read == 0 {
        return None;
    }
    price_of(model, table).map(|(ir, _)| cache_read as f64 * ir * 0.9 / 1_000_000.0)
}

fn parse_day(iso: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()
}

fn each_day(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let mut d = from;
    while d <= to {
        out.push(d.format("%Y-%m-%d").to_string());
        d = match d.checked_add_days(Days::new(1)) {
            Some(n) => n,
            None => break,
        };
    }
    out
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
    let mut cache_savings = 0.0;
    let mut cache_savings_any = false;
    // (agent, official)：官方账号用量与 API 用量分桶，费用栏分别显示「订阅」与估算金额
    let mut by_agent: HashMap<(String, bool), Bucket> = HashMap::new();
    let mut by_project: HashMap<(String, String, bool, bool), Bucket> = HashMap::new();
    let mut by_model: HashMap<(String, String, bool), Bucket> = HashMap::new();
    // (工作区名, 所属仓库路径, internal, official)：同名工作区在不同仓库下各自成行
    let mut by_workspace: HashMap<(String, String, bool, bool), Bucket> = HashMap::new();
    // 按天成桶（v3.88 趋势线）：区间总数看不出「这周比上周多花多少」，
    // 而数据本来就是按天存的，聚合一层即可，不引图表库
    let mut by_day: std::collections::BTreeMap<String, Bucket> = Default::default();
    for (_day, agent, model, project, sid, i, o, cr, cw, source, internal, workspace, official) in rows {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
        };
        cards.add(&model, &sid, acc);
        if !official {
            if let Some(saved) = cache_savings_usd(&model, acc.cache_read, table) {
                cache_savings += saved;
                cache_savings_any = true;
            }
        }
        if !_day.is_empty() {
            by_day.entry(_day).or_default().add(&model, &sid, acc);
        }
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
    // 趋势序列：按日期升序，日期字符串定宽（YYYY-MM-DD）故 BTreeMap 顺序即时间序
    let daily: Vec<UsageDayRowDto> = by_day
        .into_iter()
        .map(|(day, b)| {
            let (cost_usd, cost_partial) = b.cost(table);
            UsageDayRowDto {
                day,
                input: b.tokens.input,
                output: b.tokens.output,
                cost_usd,
                cost_partial,
            }
        })
        .collect();
    let (cards_cost, cards_partial) = cards.cost(table);
    UsageStatsDto {
        daily,
        cards: UsageCardsDto {
            input: cards.tokens.input,
            output: cards.tokens.output,
            cache_read: cards.tokens.cache_read,
            cache_write: cards.tokens.cache_write,
            sessions: cards.sessions.len() as u64,
            cost_usd: cards_cost,
            cost_partial: cards_partial,
            cache_savings_usd: if cache_savings_any {
                Some(cache_savings)
            } else {
                None
            },
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
pub struct UsageDayRowDto {
    /// 本机日期 YYYY-MM-DD（定宽，字典序即时间序）
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
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
    /// 已计价且非官方账号的缓存读相对全价输入省下的钱；无定价缓存为 None
    pub cache_savings_usd: Option<f64>,
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
    /// 按天的 token 与费用（升序）：统计页趋势线用；区间总数看不出周比周的变化
    pub daily: Vec<UsageDayRowDto>,
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

#[derive(Debug, Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageDto {
    pub input: u64,
    pub output: u64,
    pub cost_usd: f64,
    /// 至少一个模型命中定价表（费用才有意义；全未命中时前端只显示 token）
    pub priced: bool,
}

/// 按 session 聚合用量（查询本体，测试可注入内存库）；费用按模型分组各自计价再合计
fn session_usage_from(
    conn: &Connection,
    agent: &str,
    session_id: &str,
) -> Result<SessionUsageDto, String> {
    let mut stmt = conn
        .prepare(
            "SELECT model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write)
             FROM usage_daily WHERE agent = ?1 AND session_id = ?2 GROUP BY model",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![agent, session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let pricing = load_pricing(None);
    let mut out = SessionUsageDto::default();
    for row in rows {
        let (model, i, o, cr, cw) = row.map_err(|e| e.to_string())?;
        out.input += i as u64;
        out.output += o as u64;
        if let Some(price) = price_of(&model, &pricing) {
            out.priced = true;
            out.cost_usd += cost_of(
                &TokenAcc {
                    input: i as u64,
                    output: o as u64,
                    cache_read: cr as u64,
                    cache_write: cw as u64,
                },
                price,
            );
        }
    }
    Ok(out)
}

/// 单个会话的累计用量（终端状态栏）：先增量索引（marker 未变的会话直接跳过，运行中
/// 会话随前端轮询节奏追新）再按 session_id 聚合 usage_daily
#[tauri::command]
pub async fn session_usage(agent: String, session_id: String) -> Result<SessionUsageDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rebuild_impl()?;
        let conn = usage_db()?;
        session_usage_from(&conn, &agent, &session_id)
    })
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendDayDto {
    pub day: String,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub has_usage: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendDto {
    pub days: Vec<UsageTrendDayDto>,
    pub rate_usd_cny: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTopSessionDto {
    pub agent: String,
    pub session_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
}

type TrendQueryRow = (
    String, // day
    String, // agent
    String, // model
    String, // project_path
    String, // session_id
    i64,
    i64,
    i64,
    i64,
    bool, // official
    bool, // internal
);

fn select_daily_rows(conn: &Connection, cutoff: Option<&str>) -> Result<Vec<TrendQueryRow>, String> {
    let sql = if cutoff.is_some() {
        "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official, internal
         FROM usage_daily WHERE day >= ?1"
    } else {
        "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official, internal
         FROM usage_daily"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |r: &rusqlite::Row| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
            r.get::<_, i64>(9)? != 0,
            r.get::<_, i64>(10)? != 0,
        ))
    };
    let collected: rusqlite::Result<Vec<_>> = if let Some(c) = cutoff {
        stmt.query_map(params![c], map_row)
            .map_err(|e| e.to_string())?
            .collect()
    } else {
        stmt.query_map([], map_row)
            .map_err(|e| e.to_string())?
            .collect()
    };
    collected.map_err(|e| e.to_string())
}

struct DayAgg {
    billed: Bucket,
    has_usage: bool,
}

fn usage_trend_from(
    conn: &Connection,
    range: &str,
    today: NaiveDate,
    table: &[(String, (f64, f64))],
    rate: f64,
) -> Result<UsageTrendDto, String> {
    let cutoff = cutoff_day_from(range, today);
    let rows = select_daily_rows(conn, cutoff.as_deref())?;
    let mut by_day: std::collections::BTreeMap<String, DayAgg> = Default::default();
    for (day, _agent, model, _project, sid, i, o, cr, cw, official, internal) in &rows {
        if day.is_empty() || *internal {
            continue;
        }
        let slot = by_day.entry(day.clone()).or_insert_with(|| DayAgg {
            billed: Bucket::default(),
            has_usage: false,
        });
        slot.has_usage = true;
        if !official {
            slot.billed.add(
                model,
                sid,
                TokenAcc {
                    input: *i as u64,
                    output: *o as u64,
                    cache_read: *cr as u64,
                    cache_write: *cw as u64,
                },
            );
        }
    }
    let to = today;
    let from = match cutoff.as_deref().and_then(parse_day) {
        Some(d) => d,
        None => by_day
            .keys()
            .next()
            .and_then(|d| parse_day(d))
            .unwrap_or(today),
    };
    let days = each_day(from, to)
        .into_iter()
        .map(|day| match by_day.remove(&day) {
            Some(agg) => {
                let (cost_usd, cost_partial) = agg.billed.cost(table);
                UsageTrendDayDto {
                    day,
                    // 当天没有任何 API 行（空天或纯订阅）记 0；只有未计价模型时保持 None（~）
                    cost_usd: if agg.billed.by_model.is_empty() {
                        Some(0.0)
                    } else {
                        cost_usd
                    },
                    cost_partial,
                    has_usage: agg.has_usage,
                }
            }
            None => UsageTrendDayDto {
                day,
                cost_usd: Some(0.0),
                cost_partial: false,
                has_usage: false,
            },
        })
        .collect();
    Ok(UsageTrendDto {
        days,
        rate_usd_cny: rate,
    })
}

fn session_custom_title(conn: &Connection, agent: &str, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT custom_title FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .and_then(|t| {
        let s = t.trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(crate::sessions::redact_sensitive_text(&s))
        }
    })
}

fn top_sessions_from(
    conn: &Connection,
    range: &str,
    today: NaiveDate,
    table: &[(String, (f64, f64))],
) -> Result<Vec<UsageTopSessionDto>, String> {
    let cutoff = cutoff_day_from(range, today);
    let rows = select_daily_rows(conn, cutoff.as_deref())?;
    let mut by_session: HashMap<(String, String), (Bucket, String)> = HashMap::new();
    for (_day, agent, model, project, sid, i, o, cr, cw, official, internal) in rows {
        if official || internal || sid.is_empty() {
            continue;
        }
        let sid_key = sid.clone();
        let entry = by_session
            .entry((agent, sid))
            .or_insert_with(|| (Bucket::default(), project.clone()));
        if entry.1.is_empty() && !project.is_empty() {
            entry.1 = project;
        }
        entry.0.add(
            &model,
            &sid_key,
            TokenAcc {
                input: i as u64,
                output: o as u64,
                cache_read: cr as u64,
                cache_write: cw as u64,
            },
        );
    }
    let mut ranked: Vec<(f64, UsageTopSessionDto)> = by_session
        .into_iter()
        .filter_map(|((agent, session_id), (bucket, project_path))| {
            let (cost_usd, cost_partial) = bucket.cost(table);
            cost_usd.map(|cost| {
                (
                    cost,
                    UsageTopSessionDto {
                        title: None,
                        tokens: bucket.tokens.input + bucket.tokens.output,
                        cost_usd: Some(cost),
                        cost_partial,
                        agent,
                        session_id,
                        project_path,
                    },
                )
            })
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.tokens.cmp(&a.1.tokens))
            .then(a.1.agent.cmp(&b.1.agent))
            .then(a.1.session_id.cmp(&b.1.session_id))
    });
    ranked.truncate(5);
    Ok(ranked
        .into_iter()
        .map(|(_, mut row)| {
            // 红线：标题出站前必须脱敏（用户可能在自定义标题里粘过密钥），同 redact_session_meta 口径
            row.title = session_custom_title(conn, &row.agent, &row.session_id)
                .map(|t| crate::sessions::redact_sensitive_text(&t));
            row
        })
        .collect())
}

fn pricing_table_and_rate() -> (Vec<(String, (f64, f64))>, f64) {
    let pricing_path = dirs::config_dir().map(|d| d.join("ccode").join("pricing.json"));
    (
        load_pricing(pricing_path.as_deref()),
        load_rate(pricing_path.as_deref()),
    )
}

#[tauri::command]
pub async fn usage_trend(range: String) -> Result<UsageTrendDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (table, rate) = pricing_table_and_rate();
        usage_trend_from(
            &conn,
            &range,
            Local::now().date_naive(),
            &table,
            rate,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn top_sessions(range: String) -> Result<Vec<UsageTopSessionDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = usage_db()?;
        let (table, _) = pricing_table_and_rate();
        top_sessions_from(&conn, &range, Local::now().date_naive(), &table)
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
    fn session_usage_aggregates_per_session_with_pricing() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let mut ins = |session: &str, model: &str, i: i64, o: i64, cr: i64, cw: i64| {
            conn.execute(
                "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                 input, output, cache_read, cache_write) VALUES ('2026-08-17','claude-code',?1,'/p',?2,?3,?4,?5,?6)",
                rusqlite::params![model, session, i, o, cr, cw],
            )
            .unwrap();
        };
        ins("s1", "claude-sonnet-4", 1_000_000, 100_000, 0, 0);
        ins("s1", "gpt-5", 500_000, 50_000, 100_000, 0); // 同会话多模型分组计价
        ins("s1", "unknown-model-x", 10_000, 5_000, 0, 0); // 未命中定价表不计费
        ins("s2", "claude-sonnet-4", 9_999, 1, 0, 0); // 别的会话不混入
        let dto = session_usage_from(&conn, "claude-code", "s1").unwrap();
        assert_eq!(dto.input, 1_510_000);
        assert_eq!(dto.output, 155_000);
        assert!(dto.priced);
        // sonnet: 1M×3 + 0.1M×15 = 4.5；gpt-5: 0.5M×1.25 + 0.05M×10 + 0.1M×1.25×0.1 = 1.1375
        let expect = 4.5 + 1.1375;
        assert!((dto.cost_usd - expect).abs() < 1e-9, "{}", dto.cost_usd);
        // 未命中定价表时 priced=false（前端只显示 token）
        let dto2 = session_usage_from(&conn, "claude-code", "s-none").unwrap();
        assert_eq!(dto2.input, 0);
        assert!(!dto2.priced);
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

    fn insert_daily(
        conn: &Connection,
        day: &str,
        agent: &str,
        model: &str,
        project: &str,
        sid: &str,
        input: i64,
        output: i64,
        cache_read: i64,
        official: bool,
    ) {
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, official)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)",
            rusqlite::params![
                day, agent, model, project, sid, input, output, cache_read, i64::from(official)
            ],
        )
        .unwrap();
    }

    #[test]
    fn usage_trend_empty_db_fills_month_zeros() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
        let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
        assert_eq!(dto.days.len(), 30, "近 30 天含 today");
        assert_eq!(dto.days[0].day, "2026-02-14");
        assert_eq!(dto.days[29].day, "2026-03-15");
        assert!(dto.days.iter().all(|d| !d.has_usage && d.cost_usd == Some(0.0)));
    }

    #[test]
    fn usage_trend_fills_today_and_week_length() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
        let table = load_pricing(None);
        let day = usage_trend_from(&conn, "today", today, &table, 7.2).unwrap();
        assert_eq!(day.days.len(), 1, "今日只填当天");
        assert_eq!(day.days[0].day, "2026-03-15");
        let week = usage_trend_from(&conn, "week", today, &table, 7.2).unwrap();
        assert_eq!(week.days.len(), 7, "近 7 天含 today");
        assert_eq!(week.days[0].day, "2026-03-09");
        assert_eq!(week.days[6].day, "2026-03-15");
    }

    #[test]
    fn usage_trend_fills_across_month_and_skips_official_cost() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 3, 5).unwrap();
        insert_daily(
            &conn, "2026-02-28", "codex", "gpt-5", "/p", "s-api", 1_000_000, 0, 0, false,
        );
        insert_daily(
            &conn, "2026-02-28", "gemini", "gemini-3-pro", "/p", "s-off", 9_000_000, 0, 0, true,
        );
        insert_daily(
            &conn, "2026-03-05", "codex", "mystery-x", "/p", "s-unk", 100, 10, 0, false,
        );
        let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
        assert_eq!(dto.days.first().map(|d| d.day.as_str()), Some("2026-02-04"));
        let feb = dto.days.iter().find(|d| d.day == "2026-02-28").unwrap();
        assert!(feb.has_usage);
        assert!(feb.cost_usd.unwrap() > 0.0, "官方账号那行不计费，API 行仍计价");
        let mar = dto.days.iter().find(|d| d.day == "2026-03-05").unwrap();
        assert!(mar.has_usage);
        assert_eq!(mar.cost_usd, None, "当天只有未计价模型 → ~ 而不是 0");
        let gap = dto.days.iter().find(|d| d.day == "2026-03-01").unwrap();
        assert!(!gap.has_usage);
        assert_eq!(gap.cost_usd, Some(0.0));
    }

    #[test]
    fn top_sessions_ranks_billed_skips_official_and_unpriced() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
               agent TEXT NOT NULL, session_id TEXT NOT NULL,
               custom_title TEXT, PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, custom_title) VALUES('codex','s-big','飞了的长会话')",
            [],
        )
        .unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(&conn, "2026-08-20", "codex", "gpt-5", "/proj/a", "s-big", 2_000_000, 0, 0, false);
        insert_daily(&conn, "2026-08-21", "codex", "gpt-5", "/proj/a", "s-small", 100_000, 0, 0, false);
        insert_daily(&conn, "2026-08-22", "gemini", "gemini-3-pro", "/proj/b", "s-off", 9_000_000, 0, 0, true);
        insert_daily(&conn, "2026-08-23", "codex", "mystery-x", "/proj/c", "s-unk", 9_000_000, 0, 0, false);
        insert_daily(&conn, "2026-07-01", "codex", "gpt-5", "/proj/a", "s-old", 9_000_000, 0, 0, false);
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        assert_eq!(top.len(), 2, "官方与未计价不进榜，区间外的旧会话也不进");
        assert_eq!(top[0].session_id, "s-big");
        assert_eq!(top[0].title.as_deref(), Some("飞了的长会话"));
        assert_eq!(top[1].session_id, "s-small");
        assert!(top[0].cost_usd.unwrap() > top[1].cost_usd.unwrap());
    }

    #[test]
    fn usage_trend_and_top_sessions_skip_internal() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn, "2026-08-20", "codex", "gpt-5", "/p", "s-user", 100_000, 0, 0, false,
        );
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, official, internal)
             VALUES ('2026-08-21','kimi','kimi-k2','/tmp/ccode-ai','s-radar',9000000,0,0,0,0,1)",
            [],
        )
        .unwrap();
        let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
        let radar = dto.days.iter().find(|d| d.day == "2026-08-21").unwrap();
        assert!(!radar.has_usage, "内部活动不得进入花费折线");
        assert_eq!(radar.cost_usd, Some(0.0));
        let user = dto.days.iter().find(|d| d.day == "2026-08-20").unwrap();
        assert!(user.has_usage);
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].session_id, "s-user");
    }

    #[test]
    fn top_session_title_is_redacted() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
               agent TEXT NOT NULL, session_id TEXT NOT NULL,
               custom_title TEXT, PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, custom_title)
             VALUES('codex','s-leak','任务 sk-live-secret-987654')",
            [],
        )
        .unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn, "2026-08-20", "codex", "gpt-5", "/p", "s-leak", 1_000_000, 0, 0, false,
        );
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        let title = top[0].title.as_deref().unwrap();
        assert!(!title.contains("sk-live-secret-987654"));
        assert!(title.contains("已隐藏密钥"));
    }

    #[test]
    fn top_sessions_equal_cost_uses_stable_tiebreak() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        insert_daily(
            &conn, "2026-08-20", "codex", "gpt-5", "/p", "s-b", 1_000_000, 0, 0, false,
        );
        insert_daily(
            &conn, "2026-08-21", "codex", "gpt-5", "/p", "s-a", 1_000_000, 0, 0, false,
        );
        let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].session_id, "s-a", "花费相同按 session_id 升序");
        assert_eq!(top[1].session_id, "s-b");
    }

    #[test]
    fn top_sessions_empty_db() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_usage_schema(&conn).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
        let top = top_sessions_from(&conn, "all", today, &load_pricing(None)).unwrap();
        assert!(top.is_empty());
    }

    #[test]
    fn cache_savings_priced_only_skips_official() {
        let table = load_pricing(None);
        let rows: Vec<StoredUsageRow> = vec![
            (
                "2026-08-01".into(),
                "codex".into(),
                "gpt-5".into(),
                "/p".into(),
                "s1".into(),
                0,
                0,
                1_000_000,
                0,
                SOURCE_CLI.into(),
                false,
                String::new(),
                false,
            ),
            (
                "2026-08-01".into(),
                "codex".into(),
                "mystery-x".into(),
                "/p".into(),
                "s2".into(),
                0,
                0,
                1_000_000,
                0,
                SOURCE_CLI.into(),
                false,
                String::new(),
                false,
            ),
            {
                let mut r = ws_row("/p", "s3", "gpt-5", 0, 0, false, "");
                r.7 = 1_000_000; // cache_read
                r.12 = true; // official
                r
            },
        ];
        let stats = build_stats(rows, &table, 7.2);
        // gpt-5 输入 1.25 / MTok，省 90% → 1.125；未计价与官方不计入
        let saved = stats.cards.cache_savings_usd.unwrap();
        assert!((saved - 1.125).abs() < 1e-9, "{saved}");
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
        // codebuddy：毫秒 epoch 时间戳；无 usage 字段的行（401 实测样本）不产生事件
        let lines = vec![
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"timestamp":1786005441386}"#.to_string(),
            r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"401 Unauthorized"}],"timestamp":1786005443775}"#.to_string(),
        ];
        assert!(codebuddy_events(&lines).is_empty(), "无 usage 字段必须零事件不报错");
        let lines = vec![
            r#"{"type":"message","role":"assistant","model":"glm-5.0","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2},"timestamp":1786005443775}"#.to_string(),
        ];
        let evs = codebuddy_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005443775));
        assert_eq!(evs[0].model, "glm-5.0");
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read, evs[0].cache_write), (10, 5, 3, 2));
        // cursor：usage 字段未实证，按字段名候选尽力而为；无 usage 字段的行必须零事件不报错
        let lines = vec![
            r#"{"type":"user_message","message":{"content":[{"text":"hi"}]},"timestamp":1786005441386}"#.to_string(),
            r#"{"type":"turn_ended","timestamp":1786005441500}"#.to_string(),
        ];
        assert!(cursor_events(&lines).is_empty(), "无 usage 字段必须零事件不报错");
        let lines = vec![
            r#"{"type":"turn_ended","model":"claude-opus-4-8","usage":{"inputTokens":20,"outputTokens":7},"timestamp":1786005443775}"#.to_string(),
        ];
        let evs = cursor_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005443775));
        assert_eq!(evs[0].model, "claude-opus-4-8");
        assert_eq!((evs[0].input, evs[0].output), (20, 7), "camelCase 候选字段名也要能取到");
        // grok：_meta.usage 在 turn 结束通知里（params._meta 与 params.update._meta 两层都探）；
        // 无 usage 的行必须零事件不报错
        let lines = vec![
            r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#.to_string(),
            r#"{"timestamp":1786005442,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好"}}}}"#.to_string(),
        ];
        assert!(grok_events(&lines).is_empty(), "无 _meta.usage 的行必须零事件不报错");
        // params.update._meta 位置
        let lines = vec![
            r#"{"timestamp":1786005445,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"完成"},"_meta":{"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150,"cached_read_tokens":40,"modelUsage":{"grok-code-fast-1":{"input_tokens":120,"output_tokens":30}},"numTurns":1,"usageIsIncomplete":false}}}}}"#.to_string(),
        ];
        let evs = grok_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].day, day_of_ms(1786005445 * 1000), "unix 秒转日期");
        assert_eq!(evs[0].model, "grok-code-fast-1", "modelUsage 第一个键作模型名");
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read, evs[0].cache_write), (120, 30, 40, 0));
        // params._meta 位置（兼容另一层）
        let lines = vec![
            r#"{"timestamp":1786005500,"method":"session/update","params":{"_meta":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cached_read_tokens":2,"modelUsage":{"grok-4":{}},"numTurns":1}},"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#.to_string(),
        ];
        let evs = grok_events(&lines);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].model, "grok-4");
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read), (10, 5, 2));
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



// ===== 按网关归因：usage_daily ⋈ session_meta.profile_id ⋈ binding.gateway_id =====

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayUsageRow {
    pub gateway_id: String,
    pub gateway_name: String,
    pub bucket: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: Option<f64>,
    pub cost_partial: bool,
    pub session_count: u64,
    pub agents: Vec<String>,
}

fn usage_by_gateway_impl(
    conn: &Connection,
    range: &str,
    bindings: &[crate::profiles::Binding],
    gateways: &[crate::profiles::Gateway],
) -> Result<Vec<GatewayUsageRow>, String> {
    let sql = match cutoff_day(range) {
        Some(_) => "SELECT d.agent, d.model, d.session_id, d.input, d.output, d.cache_read, d.cache_write, d.official,
                           m.profile_id
                    FROM usage_daily d
                    LEFT JOIN session_meta m ON m.agent = d.agent AND m.session_id = d.session_id
                    WHERE d.day >= ?1",
        None => "SELECT d.agent, d.model, d.session_id, d.input, d.output, d.cache_read, d.cache_write, d.official,
                        m.profile_id
                 FROM usage_daily d
                 LEFT JOIN session_meta m ON m.agent = d.agent AND m.session_id = d.session_id",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let cutoff = cutoff_day(range);
    let map_row = |r: &rusqlite::Row| -> rusqlite::Result<(String, String, String, i64, i64, i64, i64, i64, Option<String>)> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
        ))
    };
    let rows: Vec<_> = match &cutoff {
        Some(c) => stmt
            .query_map(params![c], map_row)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map([], map_row)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
    };
    let bind_by_id: HashMap<&str, &crate::profiles::Binding> =
        bindings.iter().map(|b| (b.id.as_str(), b)).collect();
    let gw_by_id: HashMap<&str, &crate::profiles::Gateway> =
        gateways.iter().map(|g| (g.id.as_str(), g)).collect();

    #[derive(Default)]
    struct Acc {
        bucket: Bucket,
        agents: HashSet<String>,
        name: String,
        kind: String,
        gid: String,
    }
    let mut accs: HashMap<String, Acc> = HashMap::new();
    for (agent, model, session_id, input, output, cr, cw, official, profile_id) in rows {
        let official_row = official != 0;
        let (key, name, kind, gid) = if official_row {
            (
                "official".to_string(),
                "官方订阅".to_string(),
                "official".to_string(),
                String::new(),
            )
        } else {
            match profile_id.as_deref().filter(|s| !s.is_empty()) {
                None => (
                    "unlinked".into(),
                    "未关联".into(),
                    "unlinked".into(),
                    String::new(),
                ),
                Some(pid) => match bind_by_id.get(pid) {
                    None => (
                        "unlinked".into(),
                        "未关联".into(),
                        "unlinked".into(),
                        String::new(),
                    ),
                    Some(b) if b.kind == crate::profiles::BindingKind::Official => (
                        "official".into(),
                        "官方订阅".into(),
                        "official".into(),
                        String::new(),
                    ),
                    Some(b) => match b.gateway_id.as_deref() {
                        None => (
                            "unlinked".into(),
                            "未关联".into(),
                            "unlinked".into(),
                            String::new(),
                        ),
                        Some(id) if gw_by_id.contains_key(id) => {
                            let n = gw_by_id.get(id).map(|g| g.name.clone()).unwrap_or_default();
                            (id.to_string(), n, "gateway".into(), id.to_string())
                        }
                        Some(id) => {
                            let short: String = id.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect();
                            (
                                format!("deleted:{id}"),
                                format!("已删除网关 · {short}"),
                                "deleted".into(),
                                id.to_string(),
                            )
                        }
                    },
                },
            }
        };
        let e = accs.entry(key).or_insert_with(|| Acc {
            name,
            kind,
            gid,
            ..Default::default()
        });
        e.agents.insert(agent);
        e.bucket.add(
            &model,
            &session_id,
            TokenAcc {
                input: input as u64,
                output: output as u64,
                cache_read: cr as u64,
                cache_write: cw as u64,
            },
        );
    }
    let table = load_pricing(None);
    let mut out: Vec<GatewayUsageRow> = accs
        .into_iter()
        .map(|(_, a)| {
            let (cost_usd, cost_partial) = a.bucket.cost(&table);
            let mut agents: Vec<String> = a.agents.into_iter().collect();
            agents.sort();
            GatewayUsageRow {
                gateway_id: a.gid,
                gateway_name: a.name,
                bucket: a.kind,
                tokens_in: a.bucket.tokens.input,
                tokens_out: a.bucket.tokens.output,
                cost_usd,
                cost_partial,
                session_count: a.bucket.sessions.len() as u64,
                agents,
            }
        })
        .collect();
    out.sort_by(|a, b| (b.tokens_in + b.tokens_out).cmp(&(a.tokens_in + a.tokens_out)));
    Ok(out)
}

pub(crate) fn month_cost_usd_by_gateway() -> std::collections::HashMap<String, Option<f64>> {
    let bindings = crate::gateway_store::load_bindings().unwrap_or_default();
    let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
    let Ok(conn) = usage_db() else {
        return Default::default();
    };
    let Ok(rows) = usage_by_gateway_impl(&conn, "month", &bindings, &gateways) else {
        return Default::default();
    };
    rows.into_iter()
        .filter(|r| r.bucket == "gateway")
        .map(|r| (r.gateway_id, r.cost_usd))
        .collect()
}

#[tauri::command]
pub async fn usage_by_gateway(range: String) -> Result<Vec<GatewayUsageRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::profiles::ProfileStore::new().and_then(|s| s.list());
        let bindings = crate::gateway_store::load_bindings().unwrap_or_default();
        let gateways = crate::gateway_store::load_gateways().unwrap_or_default();
        let conn = usage_db()?;
        usage_by_gateway_impl(&conn, &range, &bindings, &gateways)
    })
    .await
    .map_err(|e| e.to_string())?
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

#[allow(dead_code)]
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

#[cfg(test)]
mod gateway_usage_tests {
    use super::*;
    use crate::profiles::{Binding, BindingKind, Gateway, ProtocolSlots};

    fn gw(id: &str, name: &str) -> Gateway {
        Gateway {
            id: id.into(),
            name: name.into(),
            no_auth: false,
            key_hint: None,
            slots: ProtocolSlots::default(),
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![],
            slot_probes: vec![],
        }
    }

    fn bind(id: &str, agent: &str, gid: Option<&str>, kind: BindingKind) -> Binding {
        Binding {
            id: id.into(),
            agent: agent.into(),
            kind,
            gateway_id: gid.map(|s| s.into()),
            protocol: None,
            models: vec![],
            extra_env: Default::default(),
            last_used_at: None,
        }
    }

    #[test]
    fn usage_join_three_missing_buckets_and_live_gateway() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily(day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
             input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, official INTEGER);
             CREATE TABLE session_meta(agent TEXT, session_id TEXT, profile_id TEXT);
             INSERT INTO usage_daily VALUES
             ('2026-08-30','claude-code','m','/p','s-gw',10,1,0,0,0),
             ('2026-08-30','codex','m','/p','s-none',20,2,0,0,0),
             ('2026-08-30','claude-code','m','/p','s-dead',30,3,0,0,0),
             ('2026-08-30','gemini','m','/p','s-off',40,4,0,0,1),
             ('2026-08-30','claude-code','m','/p','s-del',50,5,0,0,0);
             INSERT INTO session_meta VALUES
             ('claude-code','s-gw','b-live'),
             ('claude-code','s-dead','gone'),
             ('claude-code','s-del','b-del');",
        )
        .unwrap();
        let gws = vec![gw("g-live", "Zeta")];
        let bindings = vec![
            bind("b-live", "claude-code", Some("g-live"), BindingKind::Api),
            bind("b-del", "claude-code", Some("g-gone"), BindingKind::Api),
        ];
        let rows = usage_by_gateway_impl(&conn, "all", &bindings, &gws).unwrap();
        let live = rows.iter().find(|r| r.bucket == "gateway").unwrap();
        assert_eq!(live.gateway_name, "Zeta");
        assert_eq!(live.tokens_in, 10);
        let unlinked = rows.iter().find(|r| r.bucket == "unlinked").unwrap();
        assert_eq!(unlinked.tokens_in, 20 + 30); // no meta + deleted binding id
        let official = rows.iter().find(|r| r.bucket == "official").unwrap();
        assert_eq!(official.tokens_in, 40);
        let deleted = rows.iter().find(|r| r.bucket == "deleted").unwrap();
        assert!(deleted.gateway_name.contains("已删除网关"));
        assert_eq!(deleted.tokens_in, 50);
    }
}
