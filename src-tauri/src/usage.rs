//! 用量与费用统计（§6.11）：六个 agent 的会话 usage 按天聚合进 app.db，
//! 内置定价表（可被 <config>/ccode/pricing.json 覆盖）估算 USD 费用；价格不明的只显示 token。

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 单文件解析上限：过大的会话文件跳过（ comment：避免一次刷新把 IO 打满）
const MAX_PARSE_BYTES: u64 = 10 * 1024 * 1024;
const LIST_CAP: usize = 20;

// ===== 事件提取（每个 agent 一个小提取器，只拿 时间/模型/usage） =====

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct UsageEvent {
    pub day: String, // ISO 日期（UTC）
    pub model: String, // 未知为 ""
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn day_of_iso(ts: &str) -> String {
    ts.chars().take(10).collect()
}

fn day_of_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    day_of_iso(&crate::sessions::iso_from_unix((ms / 1000) as u64))
}

fn claude_events(lines: &[String]) -> Vec<UsageEvent> {
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
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
        });
    }
    out
}

fn codex_events(lines: &[String]) -> Vec<UsageEvent> {
    let mut out = Vec::new();
    let mut model = String::new(); // turn_context 的 model，取最后出现的（每轮会刷新）
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
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
                });
            }
            _ => {}
        }
    }
    out
}

fn gemini_events(lines: &[String]) -> Vec<UsageEvent> {
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
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
        });
    }
    out
}

fn qwen_events(lines: &[String]) -> Vec<UsageEvent> {
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
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
        });
    }
    out
}

fn kimi_events(lines: &[String]) -> Vec<UsageEvent> {
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
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
        });
    }
    out
}

fn opencode_events(db_path: &Path, session_id: &str) -> Vec<UsageEvent> {
    let Some(conn) = crate::sessions::open_opencode_db(db_path) else {
        return Vec::new();
    };
    let sid = session_id.to_string();
    let mut out = Vec::new();
    for r in crate::sessions::query_rows(
        &conn,
        "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC",
        &[&sid],
    ) {
        let row = crate::sessions::DbRow { names: r.0, vals: r.1 };
        let Some(data) = row.as_str("data") else {
            continue;
        };
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
            day: row.as_i64("time_created").map(day_of_ms).unwrap_or_default(),
            model,
            input: num("input") as u64,
            output: (num("output") + num("reasoning")) as u64,
            cache_read: cnum("read") as u64,
            cache_write: cnum("write") as u64,
        });
    }
    out
}

/// 会话 → usage 事件流；超过 10MB 的文件跳过
fn extract_events(session: &crate::sessions::SessionMetaDto) -> Vec<UsageEvent> {
    if session.agent == "opencode" {
        let Some((db, sid)) = session.file_path.split_once('#') else {
            return Vec::new();
        };
        return opencode_events(Path::new(db), sid);
    }
    let path = Path::new(&session.file_path);
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if meta.len() > MAX_PARSE_BYTES {
        return Vec::new();
    }
    let Some(bytes) = crate::sessions::read_session_bytes(path) else {
        return Vec::new();
    };
    let lines = crate::sessions::to_lines(&String::from_utf8_lossy(&bytes));
    match session.agent.as_str() {
        "codex" => codex_events(&lines),
        "gemini" => gemini_events(&lines),
        "qwen" => qwen_events(&lines),
        "kimi" => kimi_events(&lines),
        _ => claude_events(&lines),
    }
}

// ===== 聚合 =====

#[derive(Debug, Clone)]
pub(crate) struct SessionContrib {
    pub agent: String,
    pub session_id: String,
    pub project_path: String,
    pub events: Vec<UsageEvent>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DailyRow {
    pub day: String,
    pub agent: String,
    pub model: String,
    pub project_path: String,
    pub session_id: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// 按 (day, agent, model, project, session) 聚合；无 usage 事件的会话不产生行
pub(crate) fn aggregate(contribs: &[SessionContrib]) -> Vec<DailyRow> {
    let mut map: HashMap<(String, String, String, String, String), DailyRow> = HashMap::new();
    for c in contribs {
        for e in &c.events {
            let key = (
                e.day.clone(),
                c.agent.clone(),
                e.model.clone(),
                c.project_path.clone(),
                c.session_id.clone(),
            );
            let row = map.entry(key.clone()).or_insert_with(|| DailyRow {
                day: key.0,
                agent: key.1,
                model: key.2,
                project_path: key.3,
                session_id: key.4,
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
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
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_daily(
          day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
          project_path TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
          input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(day, agent, model, project_path, session_id));
         CREATE TABLE IF NOT EXISTS usage_meta(key TEXT PRIMARY KEY, value TEXT);",
    )
    .map_err(|e| format!("初始化用量表失败: {e}"))?;
    Ok(conn)
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

// ===== 增量重建 =====

fn rebuild_impl() -> Result<UsageBuildResult, String> {
    let conn = usage_db()?;
    let scan = crate::sessions::scan_sessions();
    let mut indexed = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    for s in &scan.sessions {
        let key = format!("seen:{}:{}", s.agent, s.session_id);
        seen.insert(key.clone());
        let marker = s.updated_at.clone().unwrap_or_default();
        // 快照补出的会话（alive=false）file_path 指向快照，内容稳定，marker 恒定即可跳过
        if meta_get(&conn, &key).as_deref() == Some(marker.as_str()) && !marker.is_empty() {
            continue;
        }
        let events = extract_events(s);
        conn.execute(
            "DELETE FROM usage_daily WHERE agent=?1 AND session_id=?2",
            params![s.agent, s.session_id],
        )
        .map_err(|e| e.to_string())?;
        let contrib = SessionContrib {
            agent: s.agent.clone(),
            session_id: s.session_id.clone(),
            project_path: s.project_path.clone(),
            events,
        };
        for row in aggregate(&[contrib]) {
            conn.execute(
                "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                                        input, output, cache_read, cache_write)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(day, agent, model, project_path, session_id) DO UPDATE SET
                   input=input+excluded.input, output=output+excluded.output,
                   cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write",
                params![
                    row.day, row.agent, row.model, row.project_path, row.session_id,
                    row.input as i64, row.output as i64, row.cache_read as i64, row.cache_write as i64,
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
        if let Some((agent, sid)) = k.strip_prefix("seen:").and_then(|s| s.split_once(':')) {
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

/// 内置前缀价目（美元 / 每百万 token）；最长前缀匹配（gpt-5-codex 优先于 gpt-5）
const BUILTIN_PRICING: [(&str, (f64, f64)); 9] = [
    ("claude-opus", (15.0, 75.0)),
    ("claude-sonnet", (3.0, 15.0)),
    ("claude-haiku", (0.8, 4.0)),
    ("gpt-5-codex", (1.25, 10.0)),
    ("gpt-5", (1.25, 10.0)),
    ("kimi-k2", (0.6, 2.5)),
    ("gemini-2.5-pro", (1.25, 10.0)),
    ("gemini-2.5-flash", (0.3, 2.5)),
    ("deepseek", (0.27, 1.1)),
];

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
    let model = model.to_lowercase();
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

fn cutoff_day(range: &str, now_secs: u64) -> Option<String> {
    let days_back = match range {
        "today" => 0,
        "week" => 6,
        "month" => 29,
        _ => return None, // "all" 不过滤
    };
    Some(day_of_iso(&crate::sessions::iso_from_unix(
        now_secs.saturating_sub(days_back * 86400),
    )))
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

    /// 任一贡献模型价格不明 → 整体费用 None（前端显示 ~）
    fn cost(&self, table: &[(String, (f64, f64))]) -> Option<f64> {
        let mut total = 0.0;
        for (model, acc) in &self.by_model {
            if acc.input + acc.output + acc.cache_read + acc.cache_write == 0 {
                continue;
            }
            total += cost_of(acc, price_of(model, table)?);
        }
        Some(total)
    }
}

fn query_stats(range: &str) -> Result<UsageStatsDto, String> {
    let conn = usage_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (sql, cutoff) = match cutoff_day(range, now) {
        Some(c) => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write
             FROM usage_daily WHERE day >= ?1",
            Some(c),
        ),
        None => (
            "SELECT day, agent, model, project_path, session_id, input, output, cache_read, cache_write
             FROM usage_daily",
            None,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String, i64, i64, i64, i64)> = {
        let map_row = |r: &rusqlite::Row| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?,
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
    let mut cards = Bucket::default();
    let mut by_agent: HashMap<String, Bucket> = HashMap::new();
    let mut by_project: HashMap<String, Bucket> = HashMap::new();
    let mut by_model: HashMap<String, Bucket> = HashMap::new();
    for (_day, agent, model, project, sid, i, o, cr, cw) in rows {
        let acc = TokenAcc {
            input: i as u64,
            output: o as u64,
            cache_read: cr as u64,
            cache_write: cw as u64,
        };
        cards.add(&model, &sid, acc);
        by_agent.entry(agent).or_default().add(&model, &sid, acc);
        by_project.entry(project).or_default().add(&model, &sid, acc);
        by_model.entry(model.clone()).or_default().add(&model, &sid, acc);
    }
    let total = |b: &Bucket| b.tokens.input + b.tokens.output;
    let mut agent_rows: Vec<UsageAgentRowDto> = by_agent
        .into_iter()
        .map(|(agent, b)| UsageAgentRowDto {
            tokens: total(&b),
            cost_usd: b.cost(&table),
            agent,
        })
        .collect();
    agent_rows.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    agent_rows.truncate(LIST_CAP);
    let mut project_rows: Vec<UsageProjectRowDto> = by_project
        .into_iter()
        .map(|(project_path, b)| UsageProjectRowDto {
            tokens: total(&b),
            sessions: b.sessions.len() as u64,
            cost_usd: b.cost(&table),
            project_path,
        })
        .collect();
    project_rows.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    project_rows.truncate(LIST_CAP);
    let mut model_rows: Vec<UsageModelRowDto> = by_model
        .into_iter()
        .map(|(model, b)| UsageModelRowDto {
            model: if model.is_empty() { "(未知)".into() } else { model },
            input: b.tokens.input,
            output: b.tokens.output,
            cost_usd: b.cost(&table),
        })
        .collect();
    model_rows.sort_by(|a, b| (b.input + b.output).cmp(&(a.input + a.output)));
    model_rows.truncate(LIST_CAP);
    Ok(UsageStatsDto {
        cards: UsageCardsDto {
            input: cards.tokens.input,
            output: cards.tokens.output,
            cache_read: cards.tokens.cache_read,
            cache_write: cards.tokens.cache_write,
            sessions: cards.sessions.len() as u64,
            cost_usd: cards.cost(&table),
        },
        by_agent: agent_rows,
        by_project: project_rows,
        by_model: model_rows,
    })
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
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAgentRowDto {
    pub agent: String,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProjectRowDto {
    pub project_path: String,
    pub tokens: u64,
    pub sessions: u64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelRowDto {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsDto {
    pub cards: UsageCardsDto,
    pub by_agent: Vec<UsageAgentRowDto>,
    pub by_project: Vec<UsageProjectRowDto>,
    pub by_model: Vec<UsageModelRowDto>,
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
        }
    }

    #[test]
    fn aggregate_groups_by_day_model_session() {
        let contribs = vec![
            SessionContrib {
                agent: "codex".into(),
                session_id: "s1".into(),
                project_path: "/p".into(),
                events: vec![ev("2026-07-01", "gpt-5", 10, 5), ev("2026-07-01", "gpt-5", 20, 5), ev("2026-07-02", "gpt-5", 1, 1)],
            },
            SessionContrib {
                agent: "codex".into(),
                session_id: "s2".into(),
                project_path: "/p".into(),
                events: vec![ev("2026-07-01", "gpt-5", 7, 3)],
            },
            SessionContrib {
                agent: "claude-code".into(),
                session_id: "s3".into(),
                project_path: "/p".into(),
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
    fn pricing_longest_prefix_and_unknown() {
        let table = load_pricing(None);
        assert_eq!(price_of("gpt-5-codex-mini", &table), Some((1.25, 10.0)));
        assert_eq!(price_of("claude-sonnet-4-5", &table), Some((3.0, 15.0)));
        assert_eq!(price_of("some-relay-model", &table), None);
        assert_eq!(price_of("", &table), None, "未知模型无价格");
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
        // 2026-07-30T10:00:00Z = 1785405600
        let now = 1785405600u64;
        assert_eq!(cutoff_day("today", now).as_deref(), Some("2026-07-30"));
        assert_eq!(cutoff_day("week", now).as_deref(), Some("2026-07-24"));
        assert_eq!(cutoff_day("month", now).as_deref(), Some("2026-07-01"));
        assert_eq!(cutoff_day("all", now), None);
    }

    #[test]
    fn bucket_cost_none_when_any_model_unpriced() {
        let table = load_pricing(None);
        let mut b = Bucket::default();
        b.add("gpt-5", "s1", TokenAcc { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 });
        assert_eq!(b.cost(&table), Some(1.25 + 10.0));
        b.add("mystery", "s2", TokenAcc { input: 5, output: 5, cache_read: 0, cache_write: 0 });
        assert_eq!(b.cost(&table), None, "有不明价模型贡献时整体不明");
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
        assert_eq!((evs[0].day.as_str(), evs[0].model.as_str()), ("2026-07-29", "claude-sonnet-4-5"));
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
        assert_eq!(evs[0].day, "2026-07-29");
        assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read, evs[0].cache_write), (50, 9, 4, 1));
    }
}

