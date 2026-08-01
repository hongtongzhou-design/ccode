use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

// ===== 前端 DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageDto {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaDto {
    pub agent: String, // "claude-code" | "codex"
    pub session_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub created_at: Option<String>, // 文件里的 ISO 时间戳，或文件 mtime
    pub updated_at: Option<String>,
    pub file_path: String,
    pub token_usage: Option<TokenUsageDto>,
    pub cli_version: Option<String>,
    // 以下来自 app.db 的 session_meta 表
    pub pinned: bool,
    pub archived: bool,
    pub custom_title: Option<String>,
    pub tags: Vec<String>,
    pub alive: bool, // 源文件是否还在（不在则回放走快照）
    /// Codex resume/fork 链长度（同一对话的多个 rollout 文件合并为一个条目）；非 Codex 恒为 1
    pub chain_count: usize,
    /// 会话发生在任务工作区（git worktree）里时的工作区名（§6.10）；project_path 同时改写为真实仓库
    pub workspace: Option<String>,
    /// AI 生成的会话摘要（session_meta.summary 列）
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub kind: String, // text | thinking | tool_use | tool_result
    pub text: String,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub role: String, // user | assistant
    pub blocks: Vec<BlockDto>,
    pub timestamp: Option<String>,
    pub usage: Option<TokenUsageDto>,
}

// ===== 通用小工具 =====

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn text_block(text: String) -> BlockDto {
    BlockDto {
        kind: "text".into(),
        text,
        tool_name: None,
    }
}

/// 列表标题：取首条真实用户消息，截断到约 60 字符
fn truncate_title(text: &str) -> String {
    const MAX: usize = 60;
    let t = text.trim();
    if t.chars().count() <= MAX {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(MAX).collect::<String>())
    }
}

/// 工具结果尽量并入上一条 assistant（视觉上跟随发起调用的那条）；没有则单发一条 user
fn push_tool_result(msgs: &mut Vec<ChatMessageDto>, blocks: Vec<BlockDto>, ts: Option<String>) {
    if let Some(last) = msgs.last_mut() {
        if last.role == "assistant" {
            last.blocks.extend(blocks);
            return;
        }
    }
    msgs.push(ChatMessageDto {
        role: "user".into(),
        blocks,
        timestamp: ts,
        usage: None,
    });
}

/// payload 字段可能是字符串也可能是对象，统一成文本
fn stringify_payload(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

pub(crate) fn to_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

// ===== 时间格式化（避免仅为 mtime 格式化引入 chrono） =====

/// Unix 秒 → ISO8601 UTC 字符串（Howard Hinnant 的 civil_from_days 算法）
pub(crate) fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub(crate) fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_unix(secs)
}

pub(crate) fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

fn mtime_iso(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    let secs = m.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(iso_from_unix(secs))
}

// ===== 文件读取（含 zstd） =====

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// 按 magic 识别 zstd（Codex 旧会话会被后台压缩成 .jsonl.zst）；截断的压缩流保留已解码部分
fn maybe_decompress(bytes: &[u8]) -> Vec<u8> {
    if !bytes.starts_with(&ZSTD_MAGIC) {
        return bytes.to_vec();
    }
    let Ok(mut decoder) = zstd::stream::read::Decoder::new(bytes) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match decoder.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    out
}

pub(crate) fn read_session_bytes(path: &Path) -> Option<Vec<u8>> {
    let raw = fs::read(path).ok()?;
    Some(maybe_decompress(&raw))
}

/// 扫描只读头部（cwd/时间戳/标题）+ 尾部（ai-title / token_count），各有字节上限；
/// 文件小于两倍上限时全读进头部。切片按换行对齐，半行丢弃。
fn head_tail_lines(bytes: &[u8], budget: usize) -> (Vec<String>, Vec<String>) {
    if bytes.len() <= budget * 2 {
        return (to_lines(&String::from_utf8_lossy(bytes)), Vec::new());
    }
    let head_end = bytes[..budget]
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let tail_from = bytes.len() - budget;
    let tail_from = bytes[tail_from..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| tail_from + i + 1)
        .unwrap_or(bytes.len());
    (
        to_lines(&String::from_utf8_lossy(&bytes[..head_end])),
        to_lines(&String::from_utf8_lossy(&bytes[tail_from..])),
    )
}

/// max_depth 限制递归深度：Claude 会话文件直接在项目目录下（更深处的 subagents/workflows
/// 目录是支线副本，不能当会话列出）；Codex 有 YYYY/MM/DD 分层，需要多几层
fn collect_files(dir: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    if max_depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_files(&p, max_depth - 1, out);
        } else {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if name.ends_with(".jsonl") || name.ends_with(".jsonl.zst") {
                out.push(p);
            }
        }
    }
}

// ===== Claude Code =====

/// 从 user 行提取标题候选；命令输出/meta 样式（XML 标签开头）不算
fn claude_user_title(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr.iter().find_map(|b| {
            if get_str(b, "type") == Some("text") {
                get_str(b, "text").map(String::from)
            } else {
                None
            }
        })?,
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') {
        None
    } else {
        Some(truncate_title(t))
    }
}

fn claude_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("input_tokens"),
        output: num("output_tokens"),
        cache_read: num("cache_read_input_tokens"),
        cache_write: num("cache_creation_input_tokens"),
    }
}

fn claude_tool_result_text(b: &Value) -> String {
    match b.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        other => stringify_payload(other),
    }
}

fn claude_file_meta(path: &Path, alive: bool) -> Option<SessionMetaDto> {
    let bytes = read_session_bytes(path)?;
    let (head, tail) = head_tail_lines(&bytes, 64 * 1024);
    let (mut cwd, mut created, mut session_id, mut version) = (None, None, None, None);
    let (mut title, mut ai_title) = (None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if version.is_none() {
            version = get_str(&v, "version").map(String::from);
        }
        if get_str(&v, "type") == Some("ai-title") {
            if let Some(t) = get_str(&v, "aiTitle") {
                ai_title = Some(truncate_title(t)); // 尾部后出现的覆盖先出现的
            }
        }
        if title.is_none()
            && get_str(&v, "type") == Some("user")
            && v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true)
            && v.get("isMeta").and_then(|x| x.as_bool()) != Some(true)
        {
            title = claude_user_title(&v);
        }
    }
    // 目录名是 sanitize 后的项目路径（有损），不解码；读不到 cwd 时原样兜底
    let project_path = cwd.unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "claude-code".into(),
        session_id,
        project_path,
        title: ai_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage: None, // Claude 的用量分散在每行，全量统计留给 P3
        cli_version: version,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        summary: None,
    })
}

fn parse_claude(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 末行截断等坏行直接跳过
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue; // 子 agent 支线消息不进主对话
        }
        if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some("user") => {
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                match content {
                    Value::String(s) => {
                        if !s.trim().is_empty() {
                            msgs.push(ChatMessageDto {
                                role: "user".into(),
                                blocks: vec![text_block(s.clone())],
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    Value::Array(arr) => {
                        let mut blocks = Vec::new();
                        for b in arr {
                            match get_str(b, "type") {
                                Some("text") => {
                                    if let Some(t) = get_str(b, "text") {
                                        blocks.push(text_block(t.to_string()));
                                    }
                                }
                                Some("tool_result") => blocks.push(BlockDto {
                                    kind: "tool_result".into(),
                                    text: claude_tool_result_text(b),
                                    tool_name: None,
                                }),
                                _ => {}
                            }
                        }
                        if blocks.is_empty() {
                            continue;
                        }
                        if blocks.iter().all(|b| b.kind == "tool_result") {
                            push_tool_result(&mut msgs, blocks, ts);
                        } else {
                            msgs.push(ChatMessageDto {
                                role: "user".into(),
                                blocks,
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                let Some(msg) = v.get("message") else {
                    continue;
                };
                let mut blocks = Vec::new();
                if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in arr {
                        match get_str(b, "type") {
                            Some("text") => {
                                if let Some(t) = get_str(b, "text") {
                                    blocks.push(text_block(t.to_string()));
                                }
                            }
                            Some("thinking") => {
                                if let Some(t) = get_str(b, "thinking") {
                                    blocks.push(BlockDto {
                                        kind: "thinking".into(),
                                        text: t.to_string(),
                                        tool_name: None,
                                    });
                                }
                            }
                            Some("tool_use") => blocks.push(BlockDto {
                                kind: "tool_use".into(),
                                text: b.get("input").map(|i| i.to_string()).unwrap_or_default(),
                                tool_name: get_str(b, "name").map(String::from),
                            }),
                            _ => {}
                        }
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: ts,
                    usage: msg.get("usage").map(claude_usage),
                });
            }
            _ => {} // summary / ai-title / file-history-snapshot 等非对话类型
        }
    }
    msgs
}

// ===== Codex CLI =====

fn codex_message_text(p: &Value) -> Option<String> {
    if get_str(p, "type") != Some("message") {
        return None;
    }
    let parts = p.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|c| match get_str(c, "type") {
            Some("input_text") | Some("output_text") => get_str(c, "text"),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn codex_token_usage(v: &Value) -> Option<TokenUsageDto> {
    if get_str(v, "type") != Some("event_msg") {
        return None;
    }
    let p = v.get("payload")?;
    if get_str(p, "type") != Some("token_count") {
        return None;
    }
    let t = p.get("info")?.get("total_token_usage")?;
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Some(TokenUsageDto {
        input: num("input_tokens"),
        // reasoning token 计入输出侧，与计费口径一致
        output: num("output_tokens") + num("reasoning_output_tokens"),
        cache_read: num("cached_input_tokens"),
        cache_write: num("cache_write_input_tokens"),
    })
}

/// 返回值附带 forked_from_id（resume/fork 链的父线程 id，可能不存在），供扫描时合并链
fn codex_file_meta(
    path: &Path,
    alive: bool,
    archived: bool,
) -> Option<(SessionMetaDto, Option<String>)> {
    let bytes = read_session_bytes(path)?;
    // Codex 开头的 user_instructions 块可能很大，头部放宽到 256KB 才更常拿到真实首条提问
    let (head, tail) = head_tail_lines(&bytes, 256 * 1024);
    let (mut cwd, mut created, mut session_id, mut version, mut title) =
        (None, None, None, None, None);
    let mut forked_from_id = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if get_str(&v, "type") == Some("session_meta") {
            if let Some(p) = v.get("payload") {
                cwd = get_str(p, "cwd").map(String::from);
                session_id = get_str(p, "id")
                    .or_else(|| get_str(p, "session_id"))
                    .map(String::from);
                version = get_str(p, "cli_version").map(String::from);
                forked_from_id = get_str(p, "forked_from_id").map(String::from);
                if let Some(t) = get_str(p, "timestamp") {
                    created = Some(t.to_string());
                }
            }
        }
        if title.is_none() && get_str(&v, "type") == Some("response_item") {
            if let Some(p) = v.get("payload") {
                if get_str(p, "role") == Some("user") {
                    if let Some(t) = codex_message_text(p) {
                        let t = t.trim();
                        // 跳过注入的指令块和粘贴的导出历史，取第一条真实提问作标题
                        if !t.starts_with('<')
                            && !t.starts_with("# AGENTS.md")
                            && !t.starts_with("The following is the ")
                        {
                            title = Some(truncate_title(t));
                        }
                    }
                }
            }
        }
    }
    // 小文件全在头部、tail 为空，此时从头部找最后一条 token_count
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| codex_token_usage(&v))
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some((
        SessionMetaDto {
            agent: "codex".into(),
            session_id,
            project_path: cwd.unwrap_or_default(),
            title,
            created_at: created,
            updated_at: mtime_iso(path),
            file_path: path.to_string_lossy().into_owned(),
            token_usage,
            cli_version: version,
            pinned: false,
            archived,
            custom_title: None,
            tags: Vec::new(),
            alive,
            chain_count: 1,
            workspace: None,
            summary: None,
        },
        forked_from_id,
    ))
}

fn parse_codex(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    let mut legacy = Vec::new();
    let mut has_response_message = false;
    let mut last_usage = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some("response_item") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("message") => {
                        let role = get_str(p, "role").unwrap_or("");
                        if role != "user" && role != "assistant" {
                            continue; // developer/system 指令不进对话视图
                        }
                        if let Some(text) = codex_message_text(p) {
                            has_response_message = true;
                            msgs.push(ChatMessageDto {
                                role: role.into(),
                                blocks: vec![text_block(text)],
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    Some("function_call") | Some("custom_tool_call") => msgs.push(ChatMessageDto {
                        role: "assistant".into(),
                        blocks: vec![BlockDto {
                            kind: "tool_use".into(),
                            text: get_str(p, "arguments")
                                .or_else(|| get_str(p, "input"))
                                .unwrap_or("")
                                .to_string(),
                            tool_name: get_str(p, "name").map(String::from),
                        }],
                        timestamp: ts,
                        usage: None,
                    }),
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        let text = stringify_payload(p.get("output"));
                        push_tool_result(
                            &mut msgs,
                            vec![BlockDto {
                                kind: "tool_result".into(),
                                text,
                                tool_name: None,
                            }],
                            ts,
                        );
                    }
                    _ => {}
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    // 旧格式兜底：新文件里它与 response_item 重复，只在没有 response_item 消息时采用
                    Some("user_message") | Some("agent_message") => {
                        if let Some(t) = get_str(p, "message") {
                            let role = if get_str(p, "type") == Some("user_message") {
                                "user"
                            } else {
                                "assistant"
                            };
                            legacy.push(ChatMessageDto {
                                role: role.into(),
                                blocks: vec![text_block(t.to_string())],
                                timestamp: ts,
                                usage: None,
                            });
                        }
                    }
                    Some("token_count") => {
                        if let Some(u) = codex_token_usage(&v) {
                            last_usage = Some(u);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut msgs = if has_response_message { msgs } else { legacy };
    // token_count 的总量挂在最后一条 assistant 消息上，代表整场用量
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    msgs
}

// ===== Gemini CLI =====

/// slug → 项目绝对路径映射。绝不自己推导 slug：
/// 优先 ~/.gemini/projects.json（{"projects": {"<abs path>": "<slug>"}}）反向，
/// 再以各 slug 目录里的 .project_root 标记文件兜底
fn gemini_slug_map(tmp_root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(cfg) = tmp_root.parent() {
        if let Ok(text) = fs::read_to_string(cfg.join("projects.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(projects) = v.get("projects").and_then(|p| p.as_object()) {
                    for (path, slug) in projects {
                        if let Some(slug) = slug.as_str() {
                            map.insert(slug.to_string(), path.clone());
                        }
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(tmp_root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let Some(slug) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if map.contains_key(&slug) {
                continue;
            }
            if let Ok(root) = fs::read_to_string(p.join(".project_root")) {
                let root = root.trim().to_string();
                if !root.is_empty() {
                    map.insert(slug, root);
                }
            }
        }
    }
    map
}

/// content 可能是字符串或 parts 数组（[{text}]）
fn gemini_content_text(c: &Value) -> Option<String> {
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn gemini_usage(t: &Value) -> TokenUsageDto {
    let num = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("input"),
        output: num("output"),
        cache_read: num("cached"),
        cache_write: 0, // gemini 的 tokens 没有写缓存概念
    }
}

/// 列表标题候选：空白或 XML 标签开头（注入内容）的不算
fn title_from_text(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') {
        None
    } else {
        Some(truncate_title(t))
    }
}

fn gemini_file_meta(
    path: &Path,
    alive: bool,
    slug_to_path: &HashMap<String, String>,
) -> Option<SessionMetaDto> {
    let bytes = read_session_bytes(path)?;
    let (head, tail) = head_tail_lines(&bytes, 64 * 1024);
    let (mut session_id, mut created, mut title, mut summary, mut directories) =
        (None, None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // $set 控制记录：补丁元数据，summary 可作标题（后出现覆盖先出现）
        if let Some(set) = v.get("$set") {
            if let Some(s) = get_str(set, "summary") {
                summary = Some(truncate_title(s));
            }
            continue;
        }
        // 首行 metadata（无 type 字段）
        if v.get("type").is_none() {
            if session_id.is_none() {
                session_id = get_str(&v, "sessionId").map(String::from);
            }
            if created.is_none() {
                created = get_str(&v, "startTime").map(String::from);
            }
            if directories.is_none() {
                directories = v
                    .get("directories")
                    .and_then(|d| d.as_array())
                    .and_then(|a| a.first())
                    .and_then(|x| x.as_str())
                    .map(String::from);
            }
            if summary.is_none() {
                summary = get_str(&v, "summary").map(truncate_title);
            }
            continue;
        }
        if title.is_none() && get_str(&v, "type") == Some("user") {
            if let Some(t) = v.get("content").and_then(gemini_content_text) {
                title = title_from_text(&t);
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "type") == Some("gemini") {
            v.get("tokens").map(gemini_usage)
        } else {
            None
        }
    });
    // 项目归属：slug 映射 → metadata.directories，都拿不到就跳过该会话（不猜 slug）
    let slug = path.parent()?.parent()?.file_name()?.to_string_lossy().into_owned();
    let project_path = slug_to_path.get(&slug).cloned().or(directories)?;
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "gemini".into(),
        session_id,
        project_path,
        title: summary.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        summary: None,
    })
}

fn parse_gemini(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut ids: Vec<Option<String>> = Vec::new(); // 与 msgs 平行，供 $rewindTo 定位
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // $rewindTo 控制记录：删除该消息 id 起的全部消息
        if let Some(rewind) = get_str(&v, "$rewindTo") {
            if let Some(pos) = ids.iter().position(|id| id.as_deref() == Some(rewind)) {
                msgs.truncate(pos);
                ids.truncate(pos);
            }
            continue;
        }
        if v.get("$set").is_some() {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        let id = get_str(&v, "id").map(String::from);
        match get_str(&v, "type") {
            Some("user") => {
                if let Some(text) = v.get("content").and_then(gemini_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text)],
                        timestamp: ts,
                        usage: None,
                    });
                    ids.push(id);
                }
            }
            Some("gemini") => {
                let mut blocks = Vec::new();
                if let Some(text) = v.get("content").and_then(gemini_content_text) {
                    blocks.push(text_block(text));
                }
                if let Some(calls) = v.get("toolCalls").and_then(|t| t.as_array()) {
                    for c in calls {
                        blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: c.get("args").map(|a| a.to_string()).unwrap_or_default(),
                            tool_name: get_str(c, "name").map(String::from),
                        });
                        if let Some(result) = c.get("result") {
                            blocks.push(BlockDto {
                                kind: "tool_result".into(),
                                text: stringify_payload(Some(result)),
                                tool_name: None,
                            });
                        }
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: ts,
                    usage: v.get("tokens").map(gemini_usage),
                });
                ids.push(id);
            }
            _ => {} // metadata / info / error / warning 不进对话视图
        }
    }
    msgs
}

// ===== Qwen Code =====

fn qwen_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        input: num("promptTokenCount"),
        output: num("candidatesTokenCount"),
        cache_read: num("cachedContentTokenCount"),
        cache_write: 0,
    }
}

/// genai Content {role, parts[]} → 块列表；thought 部分映射为 thinking
fn qwen_parts_blocks(msg: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    let Some(parts) = msg.get("parts").and_then(|p| p.as_array()) else {
        return blocks;
    };
    for p in parts {
        if let Some(fc) = p.get("functionCall") {
            blocks.push(BlockDto {
                kind: "tool_use".into(),
                text: fc.get("args").map(|a| a.to_string()).unwrap_or_default(),
                tool_name: get_str(fc, "name").map(String::from),
            });
        } else if let Some(fr) = p.get("functionResponse") {
            let text = stringify_payload(fr.get("response"));
            blocks.push(BlockDto {
                kind: "tool_result".into(),
                text: if text.is_empty() { fr.to_string() } else { text },
                tool_name: None,
            });
        } else if let Some(t) = get_str(p, "text") {
            let kind = if p.get("thought").and_then(|x| x.as_bool()) == Some(true) {
                "thinking"
            } else {
                "text"
            };
            blocks.push(BlockDto {
                kind: kind.into(),
                text: t.to_string(),
                tool_name: None,
            });
        }
    }
    blocks
}

fn qwen_content_text(msg: &Value) -> Option<String> {
    let parts = msg.get("parts")?.as_array()?;
    let text = parts
        .iter()
        .filter(|p| p.get("thought").and_then(|x| x.as_bool()) != Some(true))
        .filter_map(|p| get_str(p, "text"))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn qwen_file_meta(path: &Path, alive: bool, archived: bool) -> Option<SessionMetaDto> {
    let bytes = read_session_bytes(path)?;
    let (head, tail) = head_tail_lines(&bytes, 64 * 1024);
    let (mut cwd, mut created, mut session_id, mut version, mut title, mut custom_title) =
        (None, None, None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if version.is_none() {
            version = get_str(&v, "version").map(String::from);
        }
        // system 记录只关心 custom_title（目录名会碰撞，标题以它为准）
        if get_str(&v, "type") == Some("system") && get_str(&v, "subtype") == Some("custom_title")
        {
            if let Some(t) = v.get("systemPayload").and_then(|p| get_str(p, "customTitle")) {
                custom_title = Some(truncate_title(t));
            }
        }
        if title.is_none() && get_str(&v, "type") == Some("user") {
            if let Some(t) = v.get("message").and_then(qwen_content_text) {
                title = title_from_text(&t);
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v.get("usageMetadata").map(qwen_usage))
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "qwen".into(),
        session_id,
        project_path: cwd.unwrap_or_default(),
        title: custom_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: version,
        pinned: false,
        archived,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        summary: None,
    })
}

fn parse_qwen(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some(role @ ("user" | "assistant")) => {
                let Some(msg) = v.get("message") else {
                    continue;
                };
                let blocks = qwen_parts_blocks(msg);
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: role.into(),
                    blocks,
                    timestamp: ts,
                    usage: v.get("usageMetadata").map(qwen_usage),
                });
            }
            // 独立 tool_result 记录并入上一条 assistant（视觉跟随调用）
            Some("tool_result") => {
                let blocks: Vec<BlockDto> = v
                    .get("message")
                    .map(qwen_parts_blocks)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|b| b.kind == "tool_result")
                    .collect();
                if !blocks.is_empty() {
                    push_tool_result(&mut msgs, blocks, ts);
                }
            }
            _ => {} // system 等记录不进对话（custom_title 只用于列表标题）
        }
    }
    msgs
}

// ===== Kimi Code（新版 kimi-code + 旧版 kimi-cli，统一 agent id "kimi"） =====

/// wire/context 记录的时间是 epoch 毫秒（容忍字符串形式）
fn kimi_time(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => n.as_u64().map(|ms| iso_from_unix(ms / 1000)),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// content 可能是字符串或 parts 数组 [{type:"text",text},{type:"think",think}]
fn kimi_content_text(c: &Value) -> Option<String> {
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter(|p| get_str(p, "type") != Some("think"))
            .filter_map(|p| get_str(p, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn kimi_content_blocks(c: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    match c {
        Value::String(s) => {
            if !s.trim().is_empty() {
                blocks.push(text_block(s.clone()));
            }
        }
        Value::Array(arr) => {
            for p in arr {
                match get_str(p, "type") {
                    Some("think") => {
                        if let Some(t) = get_str(p, "think") {
                            blocks.push(BlockDto {
                                kind: "thinking".into(),
                                text: t.to_string(),
                                tool_name: None,
                            });
                        }
                    }
                    _ => {
                        if let Some(t) = get_str(p, "text") {
                            blocks.push(text_block(t.to_string()));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    blocks
}

/// toolCalls/tool_calls（两个变体拼写不同）→ tool_use 块；arguments 是 JSON 字符串原样保留
fn kimi_tool_call_blocks(m: &Value) -> Vec<BlockDto> {
    let calls = m
        .get("toolCalls")
        .or_else(|| m.get("tool_calls"))
        .and_then(|t| t.as_array());
    let Some(calls) = calls else {
        return Vec::new();
    };
    calls
        .iter()
        .map(|c| {
            let f = c.get("function");
            BlockDto {
                kind: "tool_use".into(),
                text: f
                    .and_then(|f| get_str(f, "arguments"))
                    .unwrap_or("")
                    .to_string(),
                tool_name: f.and_then(|f| get_str(f, "name")).map(String::from),
            }
        })
        .collect()
}

fn kimi_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    // inputOther 是非缓存输入；缓存读/写单列，与 Claude 口径一致
    TokenUsageDto {
        input: num("inputOther"),
        output: num("output"),
        cache_read: num("inputCacheRead"),
        cache_write: num("inputCacheCreation"),
    }
}

/// 新版 kimi-code：session_index.jsonl 给 (sessionId, sessionDir, workDir)，
/// 会话本体在 sessionDir/agents/main/wire.jsonl（agents/agent-* 是子 agent，不读）
fn kimi_wire_file_meta(
    path: &Path,
    alive: bool,
    session_id: &str,
    project_path: String,
    state: Option<&Value>,
) -> Option<SessionMetaDto> {
    let bytes = read_session_bytes(path)?;
    let (head, tail) = head_tail_lines(&bytes, 64 * 1024);
    let (mut created, mut title) = (None, None);
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("metadata") => {
                if created.is_none() {
                    created = v.get("created_at").and_then(kimi_time);
                }
            }
            Some("turn.prompt") => {
                if title.is_none()
                    && v.get("origin").and_then(|o| get_str(o, "kind")) == Some("user")
                {
                    if let Some(t) = v.get("input").and_then(kimi_content_text) {
                        title = title_from_text(&t);
                    }
                }
            }
            _ => {}
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "type") == Some("usage.record") {
            v.get("usage").map(kimi_usage)
        } else {
            None
        }
    });
    // 标题以 state.json 为准（CLI 自己维护，含 AI 起题），否则首条用户输入
    let state_title = state
        .and_then(|s| get_str(s, "title"))
        .filter(|t| !t.trim().is_empty())
        .map(truncate_title);
    if created.is_none() {
        created = state.and_then(|s| s.get("createdAt")).and_then(kimi_time);
    }
    Some(SessionMetaDto {
        agent: "kimi".into(),
        session_id: session_id.to_string(),
        project_path,
        title: state_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        summary: None,
    })
}

fn parse_kimi(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs: Vec<ChatMessageDto> = Vec::new();
    let mut last_usage = None;
    let mut last_prompt: Option<String> = None; // 用于去掉 append_message 对 prompt 的回显
    // 新协议里 assistant 的输出走 append_loop_event 流式事件；cur 是当前 step 打开的 assistant 消息
    let mut cur: Option<usize> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = v.get("time").and_then(kimi_time);
        match get_str(&v, "type") {
            Some("turn.prompt") => {
                cur = None;
                if v.get("origin").and_then(|o| get_str(o, "kind")) != Some("user") {
                    continue; // slash 命令等非用户来源不进对话
                }
                if let Some(text) = v.get("input").and_then(kimi_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text.clone())],
                        timestamp: ts,
                        usage: None,
                    });
                    last_prompt = Some(text);
                }
            }
            Some("context.append_loop_event") => {
                let Some(e) = v.get("event") else {
                    continue;
                };
                match get_str(e, "type") {
                    // 一个 step = 一次 LLM 响应 = 一条 assistant 消息
                    Some("step.begin") => {
                        msgs.push(ChatMessageDto {
                            role: "assistant".into(),
                            blocks: Vec::new(),
                            timestamp: ts,
                            usage: None,
                        });
                        cur = Some(msgs.len() - 1);
                    }
                    Some("content.part") => {
                        let Some(i) = cur else { continue };
                        let Some(p) = e.get("part") else { continue };
                        match get_str(p, "type") {
                            Some("think") => {
                                if let Some(t) = get_str(p, "think") {
                                    msgs[i].blocks.push(BlockDto {
                                        kind: "thinking".into(),
                                        text: t.to_string(),
                                        tool_name: None,
                                    });
                                }
                            }
                            _ => {
                                if let Some(t) = get_str(p, "text") {
                                    msgs[i].blocks.push(text_block(t.to_string()));
                                }
                            }
                        }
                    }
                    // args 是对象（不同于 append_message 的 JSON 字符串）
                    Some("tool.call") => {
                        let Some(i) = cur else { continue };
                        msgs[i].blocks.push(BlockDto {
                            kind: "tool_use".into(),
                            text: e.get("args").map(|a| a.to_string()).unwrap_or_default(),
                            tool_name: get_str(e, "name").map(String::from),
                        });
                    }
                    Some("tool.result") => {
                        let r = e.get("result");
                        let text = {
                            let via_output = stringify_payload(r.and_then(|r| r.get("output")));
                            if via_output.is_empty() {
                                stringify_payload(r)
                            } else {
                                via_output
                            }
                        };
                        let block = BlockDto {
                            kind: "tool_result".into(),
                            text,
                            tool_name: None,
                        };
                        match cur {
                            Some(i) => msgs[i].blocks.push(block),
                            None => push_tool_result(&mut msgs, vec![block], ts),
                        }
                    }
                    Some("step.end") => {
                        if let Some(i) = cur.take() {
                            if let Some(u) = e.get("usage").map(kimi_usage) {
                                msgs[i].usage = Some(u);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("context.append_message") => {
                let Some(m) = v.get("message") else {
                    continue;
                };
                match get_str(m, "role") {
                    Some("user") => {
                        // 注入内容（system-reminder 等）跳过
                        let kind = m.get("origin").and_then(|o| get_str(o, "kind"));
                        if kind.is_some() && kind != Some("user") {
                            continue;
                        }
                        let Some(text) = m.get("content").and_then(kimi_content_text) else {
                            continue;
                        };
                        if last_prompt.take().as_deref() == Some(text.as_str()) {
                            continue; // turn.prompt 的回显，已发过
                        }
                        msgs.push(ChatMessageDto {
                            role: "user".into(),
                            blocks: vec![text_block(text)],
                            timestamp: ts,
                            usage: None,
                        });
                    }
                    Some("assistant") => {
                        let mut blocks = kimi_content_blocks(
                            m.get("content").unwrap_or(&Value::Null),
                        );
                        blocks.extend(kimi_tool_call_blocks(m));
                        if blocks.is_empty() {
                            continue;
                        }
                        msgs.push(ChatMessageDto {
                            role: "assistant".into(),
                            blocks,
                            timestamp: ts,
                            usage: None,
                        });
                    }
                    Some("tool") => {
                        let text = m
                            .get("content")
                            .and_then(kimi_content_text)
                            .unwrap_or_default();
                        push_tool_result(
                            &mut msgs,
                            vec![BlockDto {
                                kind: "tool_result".into(),
                                text,
                                tool_name: None,
                            }],
                            ts,
                        );
                    }
                    _ => {}
                }
            }
            Some("usage.record") => {
                if let Some(u) = v.get("usage").map(kimi_usage) {
                    last_usage = Some(u);
                }
            }
            _ => {}
        }
    }
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    // step.begin 后没有任何内容的空 assistant 消息（被中断的 step）不出现在视图里
    msgs.retain(|m| !m.blocks.is_empty() || m.usage.is_some());
    msgs
}

/// 旧版 kimi-cli：~/.kimi/sessions/<md5(workDir)>/<uuid>/context.jsonl，
/// bucket → 项目路径靠 kimi.json 的 work_dirs[].path 逐个 md5 反查
fn kimi_workdir_buckets(kimi_json: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(text) = fs::read_to_string(kimi_json) else {
        return map;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return map;
    };
    if let Some(dirs) = v.get("work_dirs").and_then(|d| d.as_array()) {
        for d in dirs {
            if let Some(path) = get_str(d, "path") {
                let bucket = format!("{:x}", md5::compute(path.as_bytes()));
                map.insert(bucket, path.to_string());
            }
        }
    }
    map
}

fn kimi_legacy_file_meta(
    path: &Path,
    alive: bool,
    session_id: &str,
    project_path: String,
    state: Option<&Value>,
) -> Option<SessionMetaDto> {
    let bytes = read_session_bytes(path)?;
    let (head, tail) = head_tail_lines(&bytes, 64 * 1024);
    let mut title = None;
    for line in &head {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if get_str(&v, "role") == Some("user") {
            if let Some(t) = v.get("content").and_then(kimi_content_text) {
                title = title_from_text(&t);
                break;
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        let v = serde_json::from_str::<Value>(line).ok()?;
        if get_str(&v, "role") == Some("_usage") {
            kimi_legacy_usage(&v)
        } else {
            None
        }
    });
    let state_title = state
        .and_then(|s| get_str(s, "title"))
        .filter(|t| !t.trim().is_empty())
        .map(truncate_title);
    let created = state.and_then(|s| s.get("createdAt")).and_then(kimi_time);
    Some(SessionMetaDto {
        agent: "kimi".into(),
        session_id: session_id.to_string(),
        project_path,
        title: state_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        summary: None,
    })
}

/// 旧版 _usage 记录是累计 token 数；字段位置未核实，usage 对象或 content JSON 字符串都试
fn kimi_legacy_usage(v: &Value) -> Option<TokenUsageDto> {
    let u = v.get("usage").cloned().or_else(|| {
        v.get("content")
            .and_then(|c| c.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
    })?;
    let num = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| u.get(*k).and_then(|x| x.as_u64()))
            .unwrap_or(0)
    };
    Some(TokenUsageDto {
        input: num(&["input_tokens", "prompt_tokens"]),
        output: num(&["output_tokens", "completion_tokens"]),
        cache_read: num(&["cached_tokens", "cache_read"]),
        cache_write: num(&["cache_write"]),
    })
}

fn parse_kimi_legacy(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    let mut last_usage = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = get_str(&v, "role").unwrap_or("");
        if role == "_usage" {
            if let Some(u) = kimi_legacy_usage(&v) {
                last_usage = Some(u);
            }
            continue;
        }
        if role.starts_with('_') {
            continue; // 内部记录不进对话
        }
        match role {
            "user" => {
                if let Some(text) = v.get("content").and_then(kimi_content_text) {
                    msgs.push(ChatMessageDto {
                        role: "user".into(),
                        blocks: vec![text_block(text)],
                        timestamp: None,
                        usage: None,
                    });
                }
            }
            "assistant" => {
                let mut blocks =
                    kimi_content_blocks(v.get("content").unwrap_or(&Value::Null));
                blocks.extend(kimi_tool_call_blocks(&v));
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: "assistant".into(),
                    blocks,
                    timestamp: None,
                    usage: None,
                });
            }
            "tool" => {
                let text = v
                    .get("content")
                    .and_then(kimi_content_text)
                    .unwrap_or_default();
                push_tool_result(
                    &mut msgs,
                    vec![BlockDto {
                        kind: "tool_result".into(),
                        text,
                        tool_name: None,
                    }],
                    None,
                );
            }
            _ => {}
        }
    }
    if let Some(u) = last_usage {
        if let Some(m) = msgs.iter_mut().rev().find(|m| m.role == "assistant") {
            if m.usage.is_none() {
                m.usage = Some(u);
            }
        }
    }
    msgs
}

/// 快照文件名丢失变体线索（wire.jsonl / context.jsonl 都变成 <id>.jsonl），
/// 按内容首行判别：新版 wire 记录带 type 字段，旧版 context 记录顶层是 role
fn kimi_looks_like_wire(lines: &[String]) -> bool {
    lines.iter().find_map(|l| serde_json::from_str::<Value>(l).ok()).map_or(false, |v| {
        v.get("type").is_some()
    })
}

// ===== OpenCode（v1.2+ 单一 SQLite；旧版 storage/ 扁平 JSON；agent id "opencode"） =====

/// OPENCODE_DB 环境变量优先，其次 ~/.local/share/opencode/opencode.db
fn opencode_db_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OPENCODE_DB") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".local").join("share").join("opencode").join("opencode.db"))
}

/// WAL 模式只读打开 + busy_timeout；库不存在/打不开都返回 None（扫描时跳过）
pub(crate) fn open_opencode_db(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    Some(conn)
}

// drizzle 迁移频繁，列级防御：SELECT * 后按列名取值，缺列给默认值而不是报错
pub(crate) fn query_rows(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<(Vec<String>, Vec<rusqlite::types::Value>)> {
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let Ok(rows) = stmt.query(params) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rows = rows;
    while let Ok(Some(row)) = rows.next() {
        let mut vals = Vec::new();
        for i in 0..names.len() {
            vals.push(row.get::<_, rusqlite::types::Value>(i).unwrap_or(rusqlite::types::Value::Null));
        }
        out.push((names.clone(), vals));
    }
    out
}

// 行 -> 按名取值的小包装，复用 col_string/col_i64 的防御逻辑
pub(crate) struct DbRow {
    pub names: Vec<String>,
    pub vals: Vec<rusqlite::types::Value>,
}

impl DbRow {
    pub(crate) fn as_str(&self, key: &str) -> Option<String> {
        self.names.iter().position(|n| n == key).and_then(|i| match &self.vals[i] {
            rusqlite::types::Value::Text(s) => Some(s.clone()),
            rusqlite::types::Value::Integer(n) => Some(n.to_string()),
            _ => None,
        })
    }

    pub(crate) fn as_i64(&self, key: &str) -> Option<i64> {
        self.names.iter().position(|n| n == key).and_then(|i| match &self.vals[i] {
            rusqlite::types::Value::Integer(n) => Some(*n),
            rusqlite::types::Value::Real(f) => Some(*f as i64),
            _ => None,
        })
    }
}

fn opencode_ms_to_iso(ms: i64) -> String {
    iso_from_unix(if ms >= 0 { (ms / 1000) as u64 } else { 0 })
}

fn opencode_usage(input: i64, output: i64, reasoning: i64, cache_read: i64, cache_write: i64) -> TokenUsageDto {
    TokenUsageDto {
        input: input as u64,
        // reasoning 计入输出侧，与 Codex 口径一致
        output: (output + reasoning) as u64,
        cache_read: cache_read as u64,
        cache_write: cache_write as u64,
    }
}

fn opencode_scan_db(db_path: &Path) -> Vec<SessionMetaDto> {
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    // project_id → worktree（"global" 项目没有 worktree，回落 session.directory）
    let mut worktrees: HashMap<String, String> = HashMap::new();
    for row in query_rows(&conn, "SELECT * FROM project", &[]) {
        let row = DbRow { names: row.0, vals: row.1 };
        if let (Some(id), Some(wt)) = (row.as_str("id"), row.as_str("worktree")) {
            worktrees.insert(id, wt);
        }
    }
    let mut out = Vec::new();
    for row in query_rows(&conn, "SELECT * FROM session", &[]) {
        let row = DbRow { names: row.0, vals: row.1 };
        let Some(id) = row.as_str("id") else {
            continue;
        };
        let project_id = row.as_str("project_id").unwrap_or_default();
        let directory = row.as_str("directory").unwrap_or_default();
        let project_path = if project_id.is_empty() || project_id == "global" {
            directory
        } else {
            worktrees.get(&project_id).cloned().unwrap_or(directory)
        };
        let t = |k: &str| row.as_i64(k).unwrap_or(0);
        let token_usage = if t("tokens_input") + t("tokens_output") + t("tokens_reasoning") > 0 {
            Some(opencode_usage(
                t("tokens_input"),
                t("tokens_output"),
                t("tokens_reasoning"),
                t("tokens_cache_read"),
                t("tokens_cache_write"),
            ))
        } else {
            None
        };
        out.push(SessionMetaDto {
            agent: "opencode".into(),
            session_id: id.clone(),
            project_path,
            title: row.as_str("title").filter(|t| !t.trim().is_empty()).map(|t| truncate_title(&t)),
            created_at: row.as_i64("time_created").map(opencode_ms_to_iso),
            updated_at: row.as_i64("time_updated").map(opencode_ms_to_iso),
            // 没有单会话文件：db 路径 + "#" + session_id，pin/回放据此定位
            file_path: format!("{}#{}", db_path.display(), id),
            token_usage,
            cli_version: row.as_str("version"),
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true, // 行在即在
            chain_count: 1,
            workspace: None,
            summary: None,
        });
    }
    out
}

/// part.data → 块：text / reasoning→thinking / tool→tool_use(+tool_result)；
/// step-start/finish、file、snapshot、agent、retry、subtask、compaction 等一律跳过
fn opencode_part_blocks(data: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    match get_str(data, "type") {
        Some("text") => {
            if let Some(t) = get_str(data, "text") {
                if !t.trim().is_empty() {
                    blocks.push(text_block(t.to_string()));
                }
            }
        }
        Some("reasoning") => {
            if let Some(t) = get_str(data, "text") {
                if !t.trim().is_empty() {
                    blocks.push(BlockDto {
                        kind: "thinking".into(),
                        text: t.to_string(),
                        tool_name: None,
                    });
                }
            }
        }
        Some("tool") => {
            let state = data.get("state");
            let input = state.and_then(|s| s.get("input"));
            blocks.push(BlockDto {
                kind: "tool_use".into(),
                text: input.map(|i| i.to_string()).unwrap_or_default(),
                tool_name: get_str(data, "tool").map(String::from),
            });
            // 完成给 output、失败给 error；进行中的调用只有 tool_use
            let result = state.and_then(|s| s.get("output")).map(|v| stringify_payload(Some(v)));
            let error = state.and_then(|s| s.get("error")).map(|v| stringify_payload(Some(v)));
            let text = match (result, error) {
                (Some(o), _) if !o.is_empty() => o,
                (_, Some(e)) if !e.is_empty() => e,
                _ => String::new(),
            };
            if !text.is_empty() {
                blocks.push(BlockDto {
                    kind: "tool_result".into(),
                    text,
                    tool_name: None,
                });
            }
        }
        _ => {}
    }
    blocks
}

/// 用户消息文本：summary.body（或字符串 summary）→ parts 里的 text
fn opencode_user_text(data: &Value, parts: &[&Value]) -> Option<String> {
    let summary = data.get("summary");
    let from_summary = summary
        .and_then(|s| get_str(s, "body").or_else(|| s.as_str()))
        .filter(|t| !t.trim().is_empty())
        .map(String::from);
    from_summary.or_else(|| {
        let text = parts
            .iter()
            .filter_map(|p| {
                if get_str(p, "type") == Some("text") {
                    get_str(p, "text")
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

/// message.data + 其 parts → ChatMessageDto；非 user/assistant 返回 None
fn opencode_message(data: &Value, parts: Vec<&Value>, ts_ms: Option<i64>) -> Option<ChatMessageDto> {
    let ts = ts_ms
        .or_else(|| data.get("time").and_then(|t| t.get("created")).and_then(|t| t.as_i64()))
        .map(opencode_ms_to_iso);
    match get_str(data, "role") {
        Some("user") => {
            let text = opencode_user_text(data, &parts)?;
            Some(ChatMessageDto {
                role: "user".into(),
                blocks: vec![text_block(text)],
                timestamp: ts,
                usage: None,
            })
        }
        Some("assistant") => {
            let mut blocks = Vec::new();
            for p in parts {
                blocks.extend(opencode_part_blocks(p));
            }
            if blocks.is_empty() {
                return None;
            }
            let usage = data.get("tokens").map(|t| {
                let num = |k: &str| t.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                let cache = t.get("cache");
                let cnum = |k: &str| cache.and_then(|c| c.get(k)).and_then(|x| x.as_i64()).unwrap_or(0);
                opencode_usage(num("input"), num("output"), num("reasoning"), cnum("read"), cnum("write"))
            });
            Some(ChatMessageDto {
                role: "assistant".into(),
                blocks,
                timestamp: ts,
                usage,
            })
        }
        _ => None,
    }
}

fn opencode_parse_db(db_path: &Path, session_id: &str) -> Vec<ChatMessageDto> {
    let Some(conn) = open_opencode_db(db_path) else {
        return Vec::new();
    };
    let sid = session_id.to_string();
    // parts 按 message_id 分组（part 表带 session_id 列，按时间序）
    let mut parts_by_msg: HashMap<String, Vec<Value>> = HashMap::new();
    for row in query_rows(&conn, "SELECT * FROM part WHERE session_id=? ORDER BY time_created ASC", &[&sid]) {
        let row = DbRow { names: row.0, vals: row.1 };
        let (Some(msg_id), Some(data)) = (row.as_str("message_id"), row.as_str("data")) else {
            continue;
        };
        if let Ok(v) = serde_json::from_str::<Value>(&data) {
            parts_by_msg.entry(msg_id).or_default().push(v);
        }
    }
    let mut msgs = Vec::new();
    for row in query_rows(&conn, "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC", &[&sid]) {
        let row = DbRow { names: row.0, vals: row.1 };
        let Some(data) = row.as_str("data") else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let parts = row
            .as_str("id")
            .and_then(|id| parts_by_msg.remove(&id))
            .unwrap_or_default();
        let ts = row.as_i64("time_created");
        if let Some(m) = opencode_message(&v, parts.iter().collect(), ts) {
            msgs.push(m);
        }
    }
    msgs
}

/// pin 导出：{session:{列...}, messages:[{id,time_created,data}], parts:[{message_id,data}]}
///（自包含且保留 id 关联，回放不依赖原库）
fn opencode_export_session(db_path: &Path, session_id: &str) -> Result<Value, String> {
    let conn = open_opencode_db(db_path).ok_or("OpenCode 数据库不可读")?;
    let sid = session_id.to_string();
    let mut session_json = serde_json::json!({ "id": sid });
    for row in query_rows(&conn, "SELECT * FROM session WHERE id=?", &[&sid]) {
        let row = DbRow { names: row.0, vals: row.1 };
        let mut obj = serde_json::Map::new();
        for (i, name) in row.names.iter().enumerate() {
            let v = match &row.vals[i] {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::json!(s),
                rusqlite::types::Value::Blob(_) => continue,
            };
            obj.insert(name.clone(), v);
        }
        session_json = Value::Object(obj);
        break;
    }
    let messages: Vec<Value> = query_rows(&conn, "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC", &[&sid])
        .into_iter()
        .filter_map(|r| {
            let row = DbRow { names: r.0, vals: r.1 };
            let data = row.as_str("data").and_then(|d| serde_json::from_str::<Value>(&d).ok())?;
            Some(serde_json::json!({
                "id": row.as_str("id"),
                "time_created": row.as_i64("time_created"),
                "data": data,
            }))
        })
        .collect();
    let parts: Vec<Value> = query_rows(&conn, "SELECT * FROM part WHERE session_id=? ORDER BY time_created ASC", &[&sid])
        .into_iter()
        .filter_map(|r| {
            let row = DbRow { names: r.0, vals: r.1 };
            let data = row.as_str("data").and_then(|d| serde_json::from_str::<Value>(&d).ok())?;
            Some(serde_json::json!({
                "message_id": row.as_str("message_id"),
                "data": data,
            }))
        })
        .collect();
    Ok(serde_json::json!({
        "session": session_json,
        "messages": messages,
        "parts": parts,
    }))
}

/// 快照 JSON → 消息列表：按导出时保留的 message_id 分组 parts
fn opencode_parse_snapshot(v: &Value) -> Vec<ChatMessageDto> {
    let messages = v.get("messages").and_then(|m| m.as_array());
    let parts = v.get("parts").and_then(|p| p.as_array());
    let (Some(messages), Some(parts)) = (messages, parts) else {
        return Vec::new();
    };
    let mut parts_by_msg: HashMap<String, Vec<&Value>> = HashMap::new();
    for p in parts {
        if let Some(mid) = get_str(p, "message_id") {
            if let Some(data) = p.get("data") {
                parts_by_msg.entry(mid.to_string()).or_default().push(data);
            }
        }
    }
    let mut msgs = Vec::new();
    for m in messages {
        let Some(data) = m.get("data") else {
            continue;
        };
        let owned = get_str(m, "id")
            .and_then(|id| parts_by_msg.remove(id))
            .unwrap_or_default();
        let ts = m.get("time_created").and_then(|t| t.as_i64());
        if let Some(msg) = opencode_message(data, owned, ts) {
            msgs.push(msg);
        }
    }
    msgs
}

// ----- 旧版（pre-v1.2）storage/ 扁平 JSON -----
// 更老的 project/<slug>/storage/... 布局不兼容（此处只读 v1.1 的 storage/ 结构）

fn opencode_legacy_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".local").join("share").join("opencode").join("storage"))
}

/// legacy 目录下的一层 .json 文件（collect_files 只认 .jsonl[.zst]，不能复用）
fn collect_json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("json") {
            out.push(p);
        }
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Session Info 的时间字段：顶层 epoch ms 或嵌套 time.{created,updated}
fn legacy_time(v: &Value, flat: &str, nested: &str) -> Option<i64> {
    v.get(flat)
        .and_then(|t| t.as_i64())
        .or_else(|| v.get("time").and_then(|t| t.get(nested)).and_then(|t| t.as_i64()))
}

fn legacy_tokens(v: &Value) -> Option<TokenUsageDto> {
    let t = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    if t("tokens_input") + t("tokens_output") + t("tokens_reasoning") > 0 {
        Some(opencode_usage(
            t("tokens_input"),
            t("tokens_output"),
            t("tokens_reasoning"),
            t("tokens_cache_read"),
            t("tokens_cache_write"),
        ))
    } else {
        None
    }
}

fn opencode_scan_legacy(storage: &Path) -> Vec<SessionMetaDto> {
    // legacy 是 .json 文件，不能用 collect_files（只认 .jsonl[.zst]）
    let mut files = Vec::new();
    if let Ok(projects) = fs::read_dir(storage.join("session")) {
        for p in projects.flatten() {
            let Ok(entries) = fs::read_dir(p.path()) else {
                continue;
            };
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().and_then(|x| x.to_str()) == Some("json") {
                    files.push(path);
                }
            }
        }
    }
    let mut out = Vec::new();
    for f in files {
        let Some(v) = read_json_file(&f) else {
            continue;
        };
        let id = get_str(&v, "id")
            .map(String::from)
            .or_else(|| f.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        out.push(SessionMetaDto {
            agent: "opencode".into(),
            session_id: id,
            project_path: get_str(&v, "directory").unwrap_or("").to_string(),
            title: get_str(&v, "title").filter(|t| !t.trim().is_empty()).map(truncate_title),
            created_at: legacy_time(&v, "time_created", "created").map(opencode_ms_to_iso),
            updated_at: legacy_time(&v, "time_updated", "updated").map(opencode_ms_to_iso),
            file_path: f.to_string_lossy().into_owned(),
            token_usage: legacy_tokens(&v),
            cli_version: get_str(&v, "version").map(String::from),
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true,
            chain_count: 1,
            workspace: None,
            summary: None,
        });
    }
    out
}

fn opencode_parse_legacy(session_json: &Path) -> Vec<ChatMessageDto> {
    let storage = session_json.parent().and_then(|p| p.parent()).and_then(|p| p.parent());
    let Some(storage) = storage else {
        return Vec::new();
    };
    let sid = session_json.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // message/<sid>/<msgID>.json 按 data.time.created 排序
    let mut msg_files = Vec::new();
    collect_json_files(&storage.join("message").join(&sid), &mut msg_files);
    let mut messages: Vec<(i64, String, Value)> = Vec::new();
    for f in msg_files {
        let Some(v) = read_json_file(&f) else {
            continue;
        };
        let ts = legacy_time(&v, "time_created", "created").unwrap_or(0);
        let mid = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        messages.push((ts, mid, v));
    }
    messages.sort_by_key(|(ts, _, _)| *ts);
    let mut msgs = Vec::new();
    for (ts, mid, v) in messages {
        let mut part_files = Vec::new();
        collect_json_files(&storage.join("part").join(&mid), &mut part_files);
        part_files.sort();
        let parts: Vec<Value> = part_files.iter().filter_map(|f| read_json_file(f)).collect();
        if let Some(m) = opencode_message(&v, parts.iter().collect(), Some(ts)) {
            msgs.push(m);
        }
    }
    msgs
}

// ===== 扫描 =====

#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub sessions: Vec<SessionMetaDto>,
    /// codex 链代表 id → 全部成员 id（含代表自己）；链代表随新 resume 换人时，
    /// 用户写在任一成员 id 上的 pinned/tags 等整理数据仍能找回来
    pub chain_members: HashMap<String, Vec<String>>,
}

pub fn scan_sessions() -> ScanResult {
    let mut out = Vec::new();
    let mut chain_members = HashMap::new();
    // Gemini 的 slug → 项目路径映射在扫描与快照补全时都要用
    let gemini_map = dirs::home_dir()
        .map(|h| gemini_slug_map(&h.join(".gemini").join("tmp")))
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        let mut claude_files = Vec::new();
        collect_files(&home.join(".claude").join("projects"), 2, &mut claude_files);
        for f in claude_files {
            if let Some(m) = claude_file_meta(&f, true) {
                out.push(m);
            }
        }
        // archived_sessions 里的文件是 alive 的归档，不是「已失效」
        let mut codex_metas = Vec::new();
        let mut active_files = Vec::new();
        collect_files(&home.join(".codex").join("sessions"), 5, &mut active_files);
        for f in active_files {
            if let Some(pair) = codex_file_meta(&f, true, false) {
                codex_metas.push(pair);
            }
        }
        let mut archived_files = Vec::new();
        collect_files(&home.join(".codex").join("archived_sessions"), 5, &mut archived_files);
        for f in archived_files {
            if let Some(pair) = codex_file_meta(&f, true, true) {
                codex_metas.push(pair);
            }
        }
        let (reps, members) = merge_codex_chains(codex_metas);
        out.extend(reps);
        chain_members = members;
        // Gemini：深度 3 恰好到 chats/*.jsonl，chats/<parentId>/ 下的子 agent 会话被排除；
        // 旧版单 JSON .json 文件不匹配 .jsonl 后缀，自然跳过（如需兼容再单开解析器）
        let mut gemini_files = Vec::new();
        collect_files(&home.join(".gemini").join("tmp"), 3, &mut gemini_files);
        for f in gemini_files {
            if let Some(m) = gemini_file_meta(&f, true, &gemini_map) {
                out.push(m);
            }
        }
        // Qwen：深度 4 覆盖 chats/archive/；archive 目录下的是归档（alive 但 archived）
        let mut qwen_files = Vec::new();
        collect_files(&home.join(".qwen").join("projects"), 4, &mut qwen_files);
        for f in qwen_files {
            let archived = f
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|n| n == "archive");
            if let Some(m) = qwen_file_meta(&f, true, archived) {
                out.push(m);
            }
        }
        // Kimi 新版：session_index.jsonl 是枚举入口（workDir 即项目归属）
        let index = home.join(".kimi-code").join("session_index.jsonl");
        if let Ok(text) = fs::read_to_string(&index) {
            for line in to_lines(&text) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let (Some(sid), Some(dir), Some(wd)) = (
                    get_str(&v, "sessionId"),
                    get_str(&v, "sessionDir"),
                    get_str(&v, "workDir"),
                ) else {
                    continue;
                };
                let dir = PathBuf::from(dir);
                let wire = dir.join("agents").join("main").join("wire.jsonl");
                if !wire.exists() {
                    continue;
                }
                let state = fs::read_to_string(dir.join("state.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                if let Some(m) = kimi_wire_file_meta(&wire, true, sid, wd.to_string(), state.as_ref()) {
                    out.push(m);
                }
            }
        }
        // Kimi 旧版：sessions/<md5(workDir)>/<uuid>/context.jsonl
        let buckets = kimi_workdir_buckets(&home.join(".kimi").join("kimi.json"));
        if !buckets.is_empty() {
            let mut kimi_files = Vec::new();
            collect_files(&home.join(".kimi").join("sessions"), 3, &mut kimi_files);
            for f in kimi_files {
                let Some(bucket) = f
                    .parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                else {
                    continue;
                };
                let Some(project) = buckets.get(&bucket) else {
                    continue; // 反查不到项目归属的会话不猜
                };
                let sid = f
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let state = fs::read_to_string(f.parent().unwrap_or(&f).join("state.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                if let Some(m) = kimi_legacy_file_meta(&f, true, &sid, project.clone(), state.as_ref()) {
                    out.push(m);
                }
            }
        }
        // OpenCode：v1.2+ 读共享 SQLite（WAL 只读）；旧版读 storage/ 扁平 JSON
        if let Some(db) = opencode_db_path() {
            if db.exists() {
                out.extend(opencode_scan_db(&db));
            } else if let Some(storage) = opencode_legacy_root() {
                out.extend(opencode_scan_legacy(&storage));
            }
        } else if let Some(storage) = opencode_legacy_root() {
            out.extend(opencode_scan_legacy(&storage));
        }
    }
    // pin 即保留：源文件已消失的会话从快照补齐（§6.5）
    let seen: HashSet<(String, String)> = out
        .iter()
        .map(|m| (m.agent.clone(), m.session_id.clone()))
        .collect();
    if let Some(dir) = snapshots_root() {
        for agent in ["claude-code", "codex", "gemini", "qwen", "kimi", "opencode"] {
            let mut files = Vec::new();
            collect_files(&dir.join(agent), 1, &mut files);
            for f in files {
                let stem = snapshot_stem(&f);
                if seen.contains(&(agent.to_string(), stem.clone())) {
                    continue; // 源文件还在，快照不重复列出
                }
                let meta = match agent {
                    "codex" => codex_file_meta(&f, false, false).map(|(m, _)| m),
                    "gemini" => gemini_file_meta(&f, false, &gemini_map),
                    "qwen" => qwen_file_meta(&f, false, false),
                    "opencode" => read_json_file(&f).and_then(|v| {
                        let s = v.get("session")?;
                        Some(SessionMetaDto {
                            agent: "opencode".into(),
                            session_id: stem.clone(),
                            project_path: get_str(s, "directory").unwrap_or("").to_string(),
                            title: get_str(s, "title").filter(|t| !t.trim().is_empty()).map(truncate_title),
                            created_at: s.get("time_created").and_then(|t| t.as_i64()).map(opencode_ms_to_iso),
                            updated_at: s.get("time_updated").and_then(|t| t.as_i64()).map(opencode_ms_to_iso),
                            file_path: f.to_string_lossy().into_owned(),
                            token_usage: legacy_tokens(s),
                            cli_version: get_str(s, "version").map(String::from),
                            pinned: false,
                            archived: false,
                            custom_title: None,
                            tags: Vec::new(),
                            alive: false,
                            chain_count: 1,
                            workspace: None,
                            summary: None,
                        })
                    }),
                    "kimi" => {
                        // 快照脱离了原目录结构（无 state.json / bucket），项目归属不可知
                        let bytes = read_session_bytes(&f);
                        bytes.and_then(|b| {
                            let lines = to_lines(&String::from_utf8_lossy(&b));
                            if kimi_looks_like_wire(&lines) {
                                kimi_wire_file_meta(&f, false, &stem, String::new(), None)
                            } else {
                                kimi_legacy_file_meta(&f, false, &stem, String::new(), None)
                            }
                        })
                    }
                    _ => claude_file_meta(&f, false),
                };
                if let Some(mut m) = meta {
                    m.session_id = stem; // 快照文件名即 pin 时的 session_id
                    m.alive = false;
                    out.push(m);
                }
            }
        }
    }
    // 工作区 worktree 里的会话归并回「真实仓库 + 工作区名」（§6.10 ProjectAggregator 咬合点）
    let wt_rows = crate::workspaces::worktree_rows();
    if !wt_rows.is_empty() {
        for s in &mut out {
            if let Some((repo, ws)) = resolve_worktree_project(&s.project_path, &wt_rows) {
                s.project_path = repo;
                s.workspace = Some(ws);
            }
        }
    }
    ScanResult {
        sessions: out,
        chain_members,
    }
}

/// 会话的项目路径落在某个工作区 worktree 内（含子目录）时，返回 (真实仓库路径, 工作区名)；
/// 最长前缀优先，找不到返回 None（保持原样）
fn resolve_worktree_project(
    project_path: &str,
    rows: &[crate::workspaces::WorktreeRow],
) -> Option<(String, String)> {
    let mut best: Option<&crate::workspaces::WorktreeRow> = None;
    for r in rows {
        let wt = r.worktree_path.trim_end_matches('/');
        if project_path == wt || project_path.starts_with(&format!("{wt}/")) {
            let len = wt.len();
            if best.map_or(true, |b| len > b.worktree_path.trim_end_matches('/').len()) {
                best = Some(r);
            }
        }
    }
    best.map(|r| (r.repo_path.clone(), r.name.clone()))
}

/// Codex resume/fork 会产生新 rollout 文件（session_meta.forked_from_id 指向父线程），
/// 新文件已拷入完整历史——同一条链只保留 updated_at 最新的文件作为代表条目。
/// 用并查集按「线程 id ↔ forked_from_id」分组；父线程文件已被清理时链仍然成立。
/// 返回值附带 代表 id → 成员 id 列表，供 db meta 按任一成员查找。
fn merge_codex_chains(
    metas: Vec<(SessionMetaDto, Option<String>)>,
) -> (Vec<SessionMetaDto>, HashMap<String, Vec<String>>) {
    fn find(parent: &mut HashMap<String, String>, x: &str) -> String {
        let mut root = x.to_string();
        while let Some(p) = parent.get(&root) {
            if *p == root {
                break;
            }
            root = p.clone();
        }
        let mut cur = x.to_string();
        while let Some(p) = parent.get(&cur).cloned() {
            if p == cur || p == root {
                break;
            }
            parent.insert(cur.clone(), root.clone());
            cur = p;
        }
        root
    }
    let mut parent: HashMap<String, String> = HashMap::new();
    for (m, fork) in &metas {
        parent.entry(m.session_id.clone()).or_insert_with(|| m.session_id.clone());
        if let Some(f) = fork {
            parent.entry(f.clone()).or_insert_with(|| f.clone());
            let ra = find(&mut parent, &m.session_id);
            let rb = find(&mut parent, f);
            if ra != rb {
                parent.insert(ra, rb);
            }
        }
    }
    let mut groups: HashMap<String, Vec<SessionMetaDto>> = HashMap::new();
    for (m, _) in metas {
        let root = find(&mut parent, &m.session_id);
        groups.entry(root).or_default().push(m);
    }
    let mut reps = Vec::new();
    let mut members = HashMap::new();
    for mut g in groups.into_values() {
        g.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let n = g.len();
        let member_ids: Vec<String> = g.iter().map(|m| m.session_id.clone()).collect();
        let mut rep = g.into_iter().next().unwrap_or_else(|| unreachable!());
        rep.chain_count = n;
        if n > 1 {
            members.insert(rep.session_id.clone(), member_ids);
        }
        reps.push(rep);
    }
    (reps, members)
}

fn snapshot_stem(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.strip_suffix(".jsonl.zst")
        .or_else(|| name.strip_suffix(".jsonl"))
        .or_else(|| name.strip_suffix(".json")) // opencode 快照是导出的 JSON
        .unwrap_or(&name)
        .to_string()
}

// ===== 快照与 app.db =====

fn snapshots_root() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("ccode").join("snapshots"))
}

/// session_id/agent 来自前端参数，进路径前收敛字符集，防目录穿越
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn snapshot_path(agent: &str, session_id: &str, zst: bool) -> Option<PathBuf> {
    let name = format!(
        "{}.jsonl{}",
        sanitize_id(session_id),
        if zst { ".zst" } else { "" }
    );
    Some(snapshots_root()?.join(sanitize_id(agent)).join(name))
}

/// opencode 的会话存在共享 SQLite 里，pin 时导出为 JSON 快照（.json 扩展名）
fn snapshot_json_path(agent: &str, session_id: &str) -> Option<PathBuf> {
    let name = format!("{}.json", sanitize_id(session_id));
    Some(snapshots_root()?.join(sanitize_id(agent)).join(name))
}

fn snapshot_candidates(agent: &str, session_id: &str) -> Vec<PathBuf> {
    [snapshot_path(agent, session_id, false), snapshot_path(agent, session_id, true), snapshot_json_path(agent, session_id)]
        .into_iter()
        .flatten()
        .collect()
}

/// 源文件消失时找快照：Claude 文件名即 session_id；Codex 是 rollout-<时间>-<uuid>，取尾部 uuid
fn find_snapshot(agent: &str, source: &Path) -> Option<PathBuf> {
    let stem = source.file_stem()?.to_string_lossy().into_owned();
    let mut stems = vec![stem.clone()];
    if stem.len() > 36 {
        if let Some(tail) = stem.get(stem.len() - 36..) {
            if tail.chars().filter(|c| *c == '-').count() == 4 {
                stems.push(tail.to_string());
            }
        }
    }
    for s in stems {
        if let Some(p) = snapshot_candidates(agent, &s).into_iter().find(|p| p.exists()) {
            return Some(p);
        }
    }
    None
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let conn = Connection::open(dir.join("app.db")).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_meta(
          agent TEXT NOT NULL, session_id TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
          note TEXT, pinned_at TEXT,
          PRIMARY KEY(agent, session_id));",
    )
    .map_err(|e| format!("初始化 session_meta 表失败: {e}"))?;
    migrate_session_meta(&conn);
    Ok(conn)
}

/// 老库补列（AI 摘要）：已存在则报错忽略，幂等
pub(crate) fn migrate_session_meta(conn: &Connection) {
    for col in ["summary TEXT", "summary_at TEXT"] {
        let _ = conn.execute_batch(&format!("ALTER TABLE session_meta ADD COLUMN {col}"));
    }
}

struct MetaRow {
    pinned: bool,
    archived: bool,
    custom_title: Option<String>,
    tags: Vec<String>,
    summary: Option<String>,
}

fn read_all_meta(conn: &Connection) -> HashMap<(String, String), MetaRow> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn
        .prepare("SELECT agent, session_id, pinned, archived, custom_title, tags, summary FROM session_meta")
    else {
        return map;
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    });
    if let Ok(rows) = rows {
        for (agent, sid, pinned, archived, custom_title, tags, summary) in rows.flatten() {
            map.insert(
                (agent, sid),
                MetaRow {
                    pinned: pinned != 0,
                    archived: archived != 0,
                    custom_title,
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                    summary,
                },
            );
        }
    }
    map
}

/// AI 摘要落库（ai_summarize_session 用）
pub(crate) fn set_session_summary(agent: &str, session_id: &str, summary: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, summary, summary_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(agent, session_id) DO UPDATE SET summary=?3, summary_at=?4",
        params![agent, session_id, summary, now_iso()],
    )
    .map_err(|e| format!("写入摘要失败: {e}"))?;
    Ok(())
}

// ===== 注意力标记 v1（§6.11）：读尾部 ~64KB 分类最后一个有意义的记录 =====
// 返回 "done" | "working" | "confirm" | "unknown"

/// 读文件最后 budget 字节并对齐到换行；小文件全读
fn last_lines(path: &Path, budget: usize) -> Vec<String> {
    let Some(bytes) = read_session_bytes(path) else {
        return Vec::new();
    };
    if bytes.len() <= budget {
        return to_lines(&String::from_utf8_lossy(&bytes));
    }
    let from = bytes.len() - budget;
    let from = bytes[from..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| from + i + 1)
        .unwrap_or(bytes.len());
    to_lines(&String::from_utf8_lossy(&bytes[from..]))
}

fn ends_with_question(text: &str) -> bool {
    let t = text.trim_end();
    t.ends_with('?') || t.ends_with('？')
}

fn claude_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
            || v.get("isMeta").and_then(|x| x.as_bool()) == Some(true)
        {
            continue;
        }
        match get_str(&v, "type") {
            Some("user") => return "working", // 发了 prompt 还没等到回答（或 tool_result 刚回）
            Some("assistant") => {
                let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else {
                    continue;
                };
                if arr.iter().any(|b| get_str(b, "type") == Some("tool_use")) {
                    return "working"; // 尾部有待执行的工具调用
                }
                let last_text = arr
                    .iter()
                    .rev()
                    .find_map(|b| if get_str(b, "type") == Some("text") { get_str(b, "text") } else { None });
                match last_text {
                    None => continue,
                    Some(t) if ends_with_question(t) => return "confirm", // 文本以问句收尾，保守判定待确认
                    Some(_) => return "done",
                }
            }
            _ => continue,
        }
    }
    "unknown"
}

fn codex_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("response_item") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("message") => match get_str(p, "role") {
                        Some("user") => return "working",
                        Some("assistant") => {
                            let text = codex_message_text(p).unwrap_or_default();
                            return if ends_with_question(&text) { "confirm" } else { "done" };
                        }
                        _ => continue,
                    },
                    // 调用未回/刚回，都还在一轮当中
                    Some("function_call") | Some("custom_tool_call") => return "working",
                    Some("function_call_output") | Some("custom_tool_call_output") => return "working",
                    _ => continue,
                }
            }
            Some("event_msg") => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                match get_str(p, "type") {
                    Some("user_message") => return "working",
                    Some("agent_message") | Some("task_complete") => return "done",
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
    "unknown"
}

fn gemini_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("$set").is_some() || v.get("$rewindTo").is_some() {
            continue;
        }
        match get_str(&v, "type") {
            Some("user") => return "working",
            Some("gemini") => {
                let text = v.get("content").and_then(gemini_content_text).unwrap_or_default();
                return if ends_with_question(&text) { "confirm" } else { "done" };
            }
            _ => continue, // metadata / info / error / warning 不算数
        }
    }
    "unknown"
}

fn qwen_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        match get_str(&v, "type") {
            Some("user") => return "working",
            Some("assistant") => return "done",
            Some("tool_result") => return "working",
            _ => continue, // system 等
        }
    }
    "unknown"
}

fn kimi_tail_state(lines: &[String]) -> &'static str {
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match get_str(&v, "type") {
            Some("turn.prompt") => {
                if v.get("origin").and_then(|o| get_str(o, "kind")) == Some("user") {
                    return "working";
                }
            }
            Some("context.append_message") => {
                match v.get("message").and_then(|m| get_str(m, "role")) {
                    Some("assistant") => return "done",
                    Some("user") | Some("tool") => return "working",
                    _ => continue,
                }
            }
            Some("context.append_loop_event") => {
                let Some(e) = v.get("event") else {
                    continue;
                };
                match get_str(e, "type") {
                    Some("step.end") => return "done",
                    // step 进行中（开始/内容流/工具调用与结果）都在工作
                    Some("step.begin") | Some("content.part") | Some("tool.call") | Some("tool.result") => {
                        return "working"
                    }
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
    "unknown"
}

fn opencode_tail_state(db_path: &Path, session_id: &str) -> &'static str {
    let Some(conn) = open_opencode_db(db_path) else {
        return "unknown";
    };
    let sid = session_id.to_string();
    let last_part = query_rows(&conn, "SELECT * FROM part WHERE session_id=? ORDER BY time_created DESC LIMIT 1", &[&sid])
        .into_iter()
        .next();
    let last_msg = query_rows(&conn, "SELECT * FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT 1", &[&sid])
        .into_iter()
        .next();
    let part_ts = last_part.as_ref().and_then(|r| DbRow { names: r.0.clone(), vals: r.1.clone() }.as_i64("time_created")).unwrap_or(0);
    let msg_ts = last_msg.as_ref().and_then(|r| DbRow { names: r.0.clone(), vals: r.1.clone() }.as_i64("time_created")).unwrap_or(0);
    if part_ts == 0 && msg_ts == 0 {
        return "unknown";
    }
    if part_ts >= msg_ts {
        let row = DbRow { names: last_part.as_ref().unwrap().0.clone(), vals: last_part.unwrap().1 };
        let data = row.as_str("data").and_then(|d| serde_json::from_str::<Value>(&d).ok());
        match data.as_ref().and_then(|d| get_str(d, "type")) {
            Some("tool") => {
                let status = data
                    .as_ref()
                    .and_then(|d| d.get("state"))
                    .and_then(|s| get_str(s, "status"))
                    .unwrap_or("");
                // 待执行/执行中 → 工作；已完成/失败也仍在一轮里
                return match status {
                    "pending" | "running" => "working",
                    _ => "working",
                };
            }
            Some("text") | Some("reasoning") => return "done",
            _ => {} // 其他 part 类型回落到消息角色判断
        }
    }
    let Some(row) = last_msg else {
        return "unknown";
    };
    let row = DbRow { names: row.0, vals: row.1 };
    let role = row
        .as_str("data")
        .and_then(|d| serde_json::from_str::<Value>(&d).ok())
        .and_then(|v| get_str(&v, "role").map(String::from));
    match role.as_deref() {
        Some("user") => "working",
        Some("assistant") => "done",
        _ => "unknown",
    }
}

fn tail_state_impl(agent: &str, file_path: &str) -> String {
    if agent == "opencode" {
        let Some((db, sid)) = file_path.split_once('#') else {
            return "unknown".into();
        };
        return opencode_tail_state(Path::new(db), sid).into();
    }
    let lines = last_lines(Path::new(file_path), 64 * 1024);
    if lines.is_empty() {
        return "unknown".into();
    }
    match agent {
        "codex" => codex_tail_state(&lines),
        "gemini" => gemini_tail_state(&lines),
        "qwen" => qwen_tail_state(&lines),
        "kimi" => kimi_tail_state(&lines),
        _ => claude_tail_state(&lines),
    }
    .into()
}

// ===== Tauri commands =====

/// 扫描结果缓存 10 秒：同步 command 跑在主线程上，列表每 5 秒全量扫几百个文件会卡 UI
static SCAN_CACHE: OnceLock<Mutex<Option<(Instant, ScanResult)>>> = OnceLock::new();

pub(crate) fn cached_scan() -> ScanResult {
    let m = SCAN_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = m.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, res)) = &*guard {
        if at.elapsed() < std::time::Duration::from_secs(10) {
            return res.clone();
        }
    }
    let res = scan_sessions();
    *guard = Some((Instant::now(), res.clone()));
    res
}

/// pin/unpin/删除/改整理数据后立刻失效，下一次列表拿到新结果
fn invalidate_scan_cache() {
    if let Some(m) = SCAN_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

/// 把 session_meta 表的整理数据合并进扫描结果；codex 链代表自身没有行时按任一成员 id 找
fn apply_meta(
    sessions: &mut [SessionMetaDto],
    chain_members: &HashMap<String, Vec<String>>,
    meta: &HashMap<(String, String), MetaRow>,
) {
    for s in sessions {
        let row = meta.get(&(s.agent.clone(), s.session_id.clone())).or_else(|| {
            chain_members.get(&s.session_id).and_then(|members| {
                members
                    .iter()
                    .find_map(|id| meta.get(&(s.agent.clone(), id.clone())))
            })
        });
        if let Some(row) = row {
            s.pinned = row.pinned;
            // 扫描侧已标归档的（Codex archived_sessions 目录）不能被 db 行覆盖掉
            s.archived = s.archived || row.archived;
            s.custom_title = row.custom_title.clone();
            s.tags = row.tags.clone();
            s.summary = row.summary.clone();
        }
    }
}

#[tauri::command]
pub async fn list_sessions() -> Vec<SessionMetaDto> {
    let scan = cached_scan();
    let mut sessions = scan.sessions;
    if let Ok(conn) = open_db() {
        let meta = read_all_meta(&conn);
        apply_meta(&mut sessions, &scan.chain_members, &meta);
    }
    // 最近活跃在前；ISO 字符串可直接字典序比较
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

/// 终端联动兜底（architecture §6.7）：无 --session-id 的 agent，
/// 按 (agent, 项目目录, 启动时间) 找最新会话；updated_at 为 ISO 字符串可字典序比较
#[tauri::command]
pub async fn find_session_for(
    agent: String,
    cwd: String,
    since_iso: String,
) -> Option<SessionMetaDto> {
    let cwd = expand_tilde(&cwd);
    cached_scan()
        .sessions
        .into_iter()
        .filter(|s| s.agent == agent && s.project_path == cwd)
        .filter(|s| s.updated_at.as_deref().unwrap_or("") >= since_iso.as_str())
        .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
}

/// 注意力标记 v1（§6.11）：读会话文件尾部分类 done/working/confirm/unknown
#[tauri::command]
pub async fn session_tail_state(agent: String, file_path: String) -> String {
    tauri::async_runtime::spawn_blocking(move || tail_state_impl(&agent, &file_path))
        .await
        .unwrap_or_else(|_| "unknown".into())
}

#[tauri::command]
pub async fn get_session_conversation(agent: String, file_path: String) -> Vec<ChatMessageDto> {
    conversation_impl(&agent, &file_path)
}

/// 会话全文解析（get_session_conversation 与 ai_summarize_session 共用）
pub(crate) fn conversation_impl(agent: &str, file_path: &str) -> Vec<ChatMessageDto> {
    if agent == "opencode" {
        // "<db路径>#<session_id>"：db 在就直接读库；db 不在了读 pin 快照
        if let Some((db, sid)) = file_path.split_once('#') {
            if Path::new(db).exists() {
                return opencode_parse_db(Path::new(db), sid);
            }
            return snapshot_json_path("opencode", sid)
                .filter(|p| p.exists())
                .and_then(|p| read_json_file(&p))
                .map(|v| opencode_parse_snapshot(&v))
                .unwrap_or_default();
        }
        // 快照导出 JSON（含 messages 键）或 legacy session JSON
        let path = PathBuf::from(&file_path);
        let Some(v) = read_json_file(&path) else {
            return Vec::new();
        };
        if v.get("messages").is_some() {
            return opencode_parse_snapshot(&v);
        }
        return opencode_parse_legacy(&path);
    }
    let path = PathBuf::from(&file_path);
    let bytes = read_session_bytes(&path)
        .or_else(|| find_snapshot(&agent, &path).and_then(|p| read_session_bytes(&p)));
    let Some(bytes) = bytes else {
        return Vec::new();
    };
    let lines = to_lines(&String::from_utf8_lossy(&bytes));
    match agent {
        "codex" => parse_codex(&lines),
        "gemini" => parse_gemini(&lines),
        "qwen" => parse_qwen(&lines),
        "kimi" => {
            if kimi_looks_like_wire(&lines) {
                parse_kimi(&lines)
            } else {
                parse_kimi_legacy(&lines)
            }
        }
        _ => parse_claude(&lines),
    }
}

#[tauri::command]
pub fn pin_session(agent: String, session_id: String, file_path: String) -> Result<(), String> {
    if agent == "opencode" {
        // OpenCode 没有单会话文件：从共享 db 导出自包含 JSON 快照
        let Some((db, sid)) = file_path.split_once('#') else {
            return Err("OpenCode 会话定位格式应为 <db路径>#<session_id>".into());
        };
        let data = opencode_export_session(Path::new(db), sid)?;
        let dst = snapshot_json_path(&agent, sid).ok_or("无法确定平台配置目录")?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {e}"))?;
        }
        let text = serde_json::to_string(&data).map_err(|e| e.to_string())?;
        fs::write(&dst, text).map_err(|e| format!("写入快照失败: {e}"))?;
        let conn = open_db()?;
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, pinned, pinned_at) VALUES(?1, ?2, 1, ?3)
             ON CONFLICT(agent, session_id) DO UPDATE SET pinned=1, pinned_at=?3",
            params![agent, session_id, now_iso()],
        )
        .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
        invalidate_scan_cache();
        return Ok(());
    }
    let src = PathBuf::from(&file_path);
    if !src.exists() {
        return Err("源会话文件已不存在，无法 pin".into());
    }
    let dst = snapshot_path(&agent, &session_id, file_path.ends_with(".zst"))
        .ok_or("无法确定平台配置目录")?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {e}"))?;
    }
    fs::copy(&src, &dst).map_err(|e| format!("复制快照失败: {e}"))?;
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, pinned, pinned_at) VALUES(?1, ?2, 1, ?3)
         ON CONFLICT(agent, session_id) DO UPDATE SET pinned=1, pinned_at=?3",
        params![agent, session_id, now_iso()],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub fn unpin_session(
    agent: String,
    session_id: String,
    delete_snapshot: bool,
) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE session_meta SET pinned=0 WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
    )
    .map_err(|e| format!("更新 session_meta 失败: {e}"))?;
    if delete_snapshot {
        for p in snapshot_candidates(&agent, &session_id) {
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }
    }
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub fn set_session_meta(
    agent: String,
    session_id: String,
    custom_title: Option<String>,
    tags: Vec<String>,
    archived: bool,
) -> Result<(), String> {
    let conn = open_db()?;
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, custom_title, tags, archived)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(agent, session_id) DO UPDATE SET custom_title=?3, tags=?4, archived=?5",
        params![agent, session_id, custom_title, tags_json, archived],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    invalidate_scan_cache();
    Ok(())
}

// ===== 删除（用户显式发起，是只读原则的唯一例外） =====

/// 删除只允许落在已知会话根目录内（各 CLI 会话目录 + 我们的快照目录），防误删
fn session_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for name in [".claude", ".codex", ".gemini", ".qwen", ".kimi", ".kimi-code"] {
            roots.push(home.join(name));
        }
    }
    if let Some(snap) = snapshots_root() {
        roots.push(snap);
    }
    roots
}

fn is_under_session_root(path: &Path) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    session_roots().iter().any(|root| {
        root.canonicalize()
            .map(|r| path.starts_with(r))
            .unwrap_or(false)
    })
}

/// 删除源文件（不存在的候选跳过），返回是否真的删到了文件
fn delete_source_file(file_path: &str) -> Result<bool, String> {
    let mut deleted = false;
    let mut candidates = vec![file_path.to_string()];
    if !file_path.ends_with(".zst") {
        candidates.push(format!("{file_path}.zst")); // Codex 后台压缩后源文件名会变
    }
    for c in candidates {
        let p = PathBuf::from(&c);
        if !p.exists() {
            continue;
        }
        if !is_under_session_root(&p) {
            return Err(format!("拒绝删除会话根目录之外的文件: {c}"));
        }
        fs::remove_file(&p).map_err(|e| format!("删除 {c} 失败: {e}"))?;
        deleted = true;
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn delete_session(
    agent: String,
    session_id: String,
    file_path: String,
) -> Result<(), String> {
    delete_source_file(&file_path)?;
    for p in snapshot_candidates(&agent, &session_id) {
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }
    let conn = open_db()?;
    conn.execute(
        "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
        params![agent, session_id],
    )
    .map_err(|e| format!("删除 session_meta 失败: {e}"))?;
    invalidate_scan_cache();
    Ok(())
}

#[tauri::command]
pub async fn delete_project_sessions(agent: String, project_path: String) -> Result<usize, String> {
    let project_path = expand_tilde(&project_path);
    let targets: Vec<SessionMetaDto> = cached_scan()
        .sessions
        .into_iter()
        .filter(|s| s.agent == agent && s.project_path == project_path)
        .collect();
    let mut count = 0;
    for s in targets {
        delete_source_file(&s.file_path)?;
        for p in snapshot_candidates(&s.agent, &s.session_id) {
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }
        let conn = open_db()?;
        conn.execute(
            "DELETE FROM session_meta WHERE agent=?1 AND session_id=?2",
            params![s.agent, s.session_id],
        )
        .map_err(|e| format!("删除 session_meta 失败: {e}"))?;
        count += 1;
    }
    invalidate_scan_cache();
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|l| l.to_string()).collect()
    }

    // ===== Claude 解析 =====

    #[test]
    fn claude_parse_user_assistant_tool_flow() {
        let lines = s(&[
            r#"{"type":"summary","summary":"忽略我"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"支线"}}"#,
            r#"{"type":"user","cwd":"/tmp/proj","sessionId":"s1","version":"1.0.0","message":{"role":"user","content":"帮我修 bug"},"timestamp":"2026-07-01T00:00:01Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想想"},{"type":"text","text":"好的"},{"type":"tool_use","name":"Read","input":{"file_path":"/a"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}},"timestamp":"2026-07-01T00:00:02Z"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file body"}]},"timestamp":"2026-07-01T00:00:03Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":"#, // 截断末行
        ]);
        let msgs = parse_claude(&lines);
        assert_eq!(msgs.len(), 2, "summary/isMeta/sidechain/截断行都要跳过");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
        assert_eq!(msgs[0].timestamp.as_deref(), Some("2026-07-01T00:00:01Z"));
        assert_eq!(msgs[1].role, "assistant");
        // thinking + text + tool_use + 并入的 tool_result
        assert_eq!(msgs[1].blocks.len(), 4);
        assert_eq!(msgs[1].blocks[0].kind, "thinking");
        assert_eq!(msgs[1].blocks[1].kind, "text");
        assert_eq!(msgs[1].blocks[2].kind, "tool_use");
        assert_eq!(msgs[1].blocks[2].tool_name.as_deref(), Some("Read"));
        assert_eq!(msgs[1].blocks[3].kind, "tool_result");
        assert_eq!(msgs[1].blocks[3].text, "file body");
        let u = msgs[1].usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (10, 5, 3, 2));
    }

    #[test]
    fn claude_mixed_user_blocks_stay_user_message() {
        let lines = s(&[
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"},{"type":"text","text":"补充说明"}]}}"#,
        ]);
        let msgs = parse_claude(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks.len(), 2);
        assert_eq!(msgs[0].blocks[0].kind, "tool_result");
    }

    #[test]
    fn claude_tool_result_without_prior_assistant_becomes_user() {
        let lines = s(&[
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"}]}}"#,
        ]);
        let msgs = parse_claude(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].kind, "tool_result");
    }

    #[test]
    fn claude_meta_reads_cwd_title_and_ai_title_override() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-2222-3333-4444-555555555555.jsonl");
        let content = concat!(
            r#"{"type":"user","cwd":"/tmp/proj","sessionId":"sid-1","version":"1.2.3","timestamp":"2026-07-01T00:00:00Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
            "\n",
            r#"{"type":"user","timestamp":"2026-07-01T00:01:00Z","message":{"role":"user","content":"真正的第一条消息"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"AI 起的标题","sessionId":"sid-1"}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let m = claude_file_meta(&file, true).unwrap();
        assert_eq!(m.project_path, "/tmp/proj");
        assert_eq!(m.session_id, "sid-1");
        assert_eq!(m.cli_version.as_deref(), Some("1.2.3"));
        assert_eq!(m.created_at.as_deref(), Some("2026-07-01T00:00:00Z"));
        assert_eq!(m.title.as_deref(), Some("AI 起的标题"), "ai-title 应覆盖首条用户消息");
        assert!(m.updated_at.is_some());
        assert!(m.alive);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn title_truncates_to_60_chars() {
        let long = "啊".repeat(100);
        let t = truncate_title(&long);
        assert_eq!(t.chars().count(), 61); // 60 + 省略号
    }

    // ===== Codex 解析 =====

    #[test]
    fn codex_parse_messages_tools_and_usage() {
        let lines = s(&[
            r#"{"timestamp":"2026-07-20T00:00:00Z","type":"session_meta","payload":{"id":"019f-test","timestamp":"2026-07-20T00:00:00Z","cwd":"/tmp/proj","cli_version":"0.20.0"}}"#,
            r#"{"timestamp":"2026-07-20T00:00:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"指令跳过"}]}}"#,
            r#"{"timestamp":"2026-07-20T00:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi codex"}]}}"#,
            r#"{"timestamp":"2026-07-20T00:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}"#,
            r#"{"timestamp":"2026-07-20T00:00:04Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
            r#"{"timestamp":"2026-07-20T00:00:05Z","type":"response_item","payload":{"type":"function_call_output","output":"total 0"}}"#,
            r#"{"timestamp":"2026-07-20T00:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10,"cache_write_input_tokens":0}}}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 3, "developer 消息跳过，tool_result 并入上一条");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "hi codex");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].blocks[0].text, "hello");
        assert_eq!(msgs[2].role, "assistant");
        assert_eq!(msgs[2].blocks[0].kind, "tool_use");
        assert_eq!(msgs[2].blocks[0].tool_name.as_deref(), Some("shell"));
        assert_eq!(msgs[2].blocks[1].kind, "tool_result");
        assert_eq!(msgs[2].blocks[1].text, "total 0");
        // 最后一条 token_count 的总量挂在最后一条 assistant 上；reasoning 计入 output
        let u = msgs[2].usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (100, 25, 10, 0));
    }

    #[test]
    fn codex_legacy_event_msg_fallback() {
        let lines = s(&[
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"老格式提问"}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"老格式回答"}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[test]
    fn codex_response_item_wins_over_legacy_dup() {
        let lines = s(&[
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"重复的"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"新的"}]}}"#,
        ]);
        let msgs = parse_codex(&lines);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].blocks[0].text, "新的");
    }

    #[test]
    fn codex_meta_reads_session_meta_and_tail_usage() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-2026-07-20T00-00-00-019f8039-8bed-7323-8c9d-853c1e7a9edf.jsonl");
        let content = concat!(
            r#"{"timestamp":"2026-07-20T00:00:00Z","type":"session_meta","payload":{"id":"019f8039-8bed-7323-8c9d-853c1e7a9edf","timestamp":"2026-07-20T00:00:00Z","cwd":"/tmp/proj","cli_version":"0.20.0"}}"#,
            "\n",
            r#"{"timestamp":"2026-07-20T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"做点事"}]}}"#,
            "\n",
            r#"{"timestamp":"2026-07-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"output_tokens":8,"cached_input_tokens":4,"cache_write_input_tokens":2}}}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let (m, fork) = codex_file_meta(&file, true, false).unwrap();
        assert_eq!(m.project_path, "/tmp/proj");
        assert_eq!(m.session_id, "019f8039-8bed-7323-8c9d-853c1e7a9edf");
        assert_eq!(m.cli_version.as_deref(), Some("0.20.0"));
        assert_eq!(m.title.as_deref(), Some("做点事"));
        assert_eq!(m.chain_count, 1);
        assert!(!m.archived);
        assert_eq!(fork, None);
        let u = m.token_usage.unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (50, 8, 4, 2));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_archived_flag_comes_from_directory() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-x.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"session_meta","payload":{"id":"t1","cwd":"/tmp/p","forked_from_id":"t0"}}"#,
        )
        .unwrap();
        let (m, fork) = codex_file_meta(&file, true, true).unwrap();
        assert!(m.archived, "archived_sessions 目录扫描出的文件必须带 archived 标记");
        assert!(m.alive, "归档不等于已失效");
        assert_eq!(fork.as_deref(), Some("t0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_title_skips_pasted_history_blob() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-x.jsonl");
        let content = concat!(
            r#"{"type":"session_meta","payload":{"id":"t1","cwd":"/tmp/p"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"The following is the Codex agent history whose request actions..."}]}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真正的提问"}]}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let (m, _) = codex_file_meta(&file, true, false).unwrap();
        assert_eq!(m.title.as_deref(), Some("真正的提问"), "粘贴的导出历史不能作标题");

        let file2 = dir.join("rollout-y.jsonl");
        let content2 = concat!(
            r#"{"type":"session_meta","payload":{"id":"t2","cwd":"/tmp/p"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"The following is the Claude Code history..."}]}}"#,
            "\n",
        );
        std::fs::write(&file2, content2).unwrap();
        let (m2, _) = codex_file_meta(&file2, true, false).unwrap();
        assert_eq!(m2.title, None, "全是粘贴历史时标题为空");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Codex resume/fork 链合并 =====

    fn codex_meta(id: &str, updated: &str, fork: Option<&str>) -> (SessionMetaDto, Option<String>) {
        (
            SessionMetaDto {
                agent: "codex".into(),
                session_id: id.into(),
                project_path: "/tmp/p".into(),
                title: None,
                created_at: None,
                updated_at: Some(updated.into()),
                file_path: format!("/rollout-{id}.jsonl"),
                token_usage: None,
                cli_version: None,
                pinned: false,
                archived: false,
                custom_title: None,
                tags: Vec::new(),
                alive: true,
                chain_count: 1,
                workspace: None,
                summary: None,
            },
            fork.map(String::from),
        )
    }

    #[test]
    fn codex_chain_merges_to_newest_representative() {
        let metas = vec![
            codex_meta("t1", "2026-07-01T00:00:00Z", None),
            codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
            codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
            codex_meta("u1", "2026-07-01T12:00:00Z", None), // 无关会话不受影响
        ];
        let (merged, members) = merge_codex_chains(metas);
        assert_eq!(merged.len(), 2);
        let rep = merged.iter().find(|m| m.chain_count == 3).unwrap();
        assert_eq!(rep.session_id, "t3", "代表是 updated_at 最新的文件");
        assert_eq!(rep.file_path, "/rollout-t3.jsonl");
        let single = merged.iter().find(|m| m.session_id == "u1").unwrap();
        assert_eq!(single.chain_count, 1);
        assert_eq!(
            members.get("t3").map(|v| v.len()),
            Some(3),
            "成员表记录链上全部 id 供 db meta 反查"
        );
        assert!(!members.contains_key("u1"), "单文件会话不进成员表");
    }

    #[test]
    fn codex_chain_survives_missing_parent_file() {
        // 父线程文件已被清理：forked_from_id 指向不存在的线程，链内剩余文件仍合并
        let metas = vec![
            codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
            codex_meta("t3", "2026-07-01T00:00:00Z", Some("t2")),
        ];
        let (merged, _) = merge_codex_chains(metas);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].chain_count, 2);
        assert_eq!(merged[0].session_id, "t2");
    }

    #[test]
    fn meta_written_for_chain_member_applies_to_rep() {
        // 用户归档了旧代表 t2，链换人后代表变 t3：t3 没有自己的 meta 行时要按成员 id 找回
        let metas = vec![
            codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
            codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
        ];
        let (mut merged, members) = merge_codex_chains(metas);
        let mut meta: HashMap<(String, String), MetaRow> = HashMap::new();
        meta.insert(
            ("codex".to_string(), "t2".to_string()),
            MetaRow {
                pinned: true,
                archived: true,
                custom_title: Some("旧代表上的标题".into()),
                tags: vec!["重要".into()],
                summary: None,
            },
        );
        apply_meta(&mut merged, &members, &meta);
        let rep = merged.iter().find(|m| m.session_id == "t3").unwrap();
        assert!(rep.pinned);
        assert!(rep.archived);
        assert_eq!(rep.custom_title.as_deref(), Some("旧代表上的标题"));
        assert_eq!(rep.tags, vec!["重要".to_string()]);
    }

    // ===== zstd / 路径 / 时间 =====

    #[test]
    fn zstd_roundtrip_parses() {
        let raw = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello zst\"}}\n".to_vec();
        let compressed = zstd::stream::encode_all(&raw[..], 3).unwrap();
        assert!(compressed.starts_with(&ZSTD_MAGIC));
        let bytes = maybe_decompress(&compressed);
        let msgs = parse_claude(&to_lines(&String::from_utf8_lossy(&bytes)));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].blocks[0].text, "hello zst");
    }

    #[test]
    fn snapshot_path_sanitizes_and_keeps_zst() {
        let p = snapshot_path("codex", "abc/def.json", true).unwrap();
        assert!(p.ends_with("snapshots/codex/abc_def_json.jsonl.zst"));
        let p2 = snapshot_path("claude-code", "sid-1", false).unwrap();
        assert!(p2.ends_with("snapshots/claude-code/sid-1.jsonl"));
    }

    #[test]
    fn iso_from_unix_formats_utc() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1700000000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn head_tail_splits_large_files() {
        let mut bytes = Vec::new();
        for i in 0..1000 {
            bytes.extend_from_slice(format!("{{\"n\":{i}}}\n").as_bytes());
        }
        let (head, tail) = head_tail_lines(&bytes, 1024);
        assert!(head.len() < 1000 && !head.is_empty());
        assert!(tail.len() < 1000 && !tail.is_empty());
        assert!(head.iter().all(|l| serde_json::from_str::<Value>(l).is_ok()));
        assert!(tail.iter().all(|l| serde_json::from_str::<Value>(l).is_ok()));
    }

    // ===== Gemini =====

    #[test]
    fn gemini_parse_rewind_truncates_and_tokens_map() {
        let lines = s(&[
            r#"{"sessionId":"g1","startTime":"2026-07-21T02:46:00Z","lastUpdated":"..."}"#,
            r#"{"id":"m1","timestamp":"2026-07-21T02:46:01Z","type":"user","content":"第一问"}"#,
            r#"{"id":"m2","timestamp":"2026-07-21T02:46:02Z","type":"gemini","content":"第一答","tokens":{"input":100,"output":20,"cached":10,"thoughts":5,"tool":0,"total":135},"model":"gemini-3"}"#,
            r#"{"id":"m3","timestamp":"2026-07-21T02:46:03Z","type":"user","content":"第二问（被回滚）"}"#,
            r#"{"$rewindTo":"m2"}"#,
            r#"{"id":"m4","timestamp":"2026-07-21T02:46:04Z","type":"user","content":"改问这个"}"#,
            r#"{"id":"m5","timestamp":"2026-07-21T02:46:05Z","type":"gemini","content":[{"text":"part1"},{"text":"part2"}],"toolCalls":[{"name":"read_file","args":{"path":"/a"},"result":"file body"}]}"#,
            r#"{"id":"m6","timestamp":"2026-07-21T02:46:06Z","type":"info","content":"忽略"}"#,
            r#"{"id":"m7","timestamp":"2026-07-21T02:46:07Z","type":"gemini","content":"截断"#, // 截断末行
        ]);
        let msgs = parse_gemini(&lines);
        // m2 起的消息被 $rewindTo 删除，之后 m4/m5 正常接续
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].blocks[0].text, "第一问");
        assert_eq!(msgs[1].blocks[0].text, "改问这个");
        let g = &msgs[2];
        assert_eq!(g.role, "assistant");
        assert_eq!(g.blocks[0].text, "part1\npart2");
        assert_eq!(g.blocks[1].kind, "tool_use");
        assert_eq!(g.blocks[1].tool_name.as_deref(), Some("read_file"));
        assert_eq!(g.blocks[2].kind, "tool_result");
        assert_eq!(g.blocks[2].text, "file body");
        // tokens 映射来自被回滚前 m2 之外——这里验证 m5 无 tokens 时 usage 为空，
        // 另起一条只含 tokens 的场景验证映射
        assert!(g.usage.is_none());
        let with_tokens = parse_gemini(&s(&[
            r#"{"id":"a","type":"gemini","content":"答","tokens":{"input":100,"output":20,"cached":10,"thoughts":5,"tool":0,"total":135}}"#,
        ]));
        let u = with_tokens[0].usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (100, 20, 10, 0));
    }

    #[test]
    fn gemini_slug_map_from_projects_json_and_marker() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let tmp = dir.join(".gemini").join("tmp");
        std::fs::create_dir_all(tmp.join("slug-a")).unwrap();
        std::fs::create_dir_all(tmp.join("slug-b")).unwrap();
        std::fs::write(
            dir.join(".gemini").join("projects.json"),
            r#"{"projects":{"/abs/path/a":"slug-a"}}"#,
        )
        .unwrap();
        std::fs::write(tmp.join("slug-b").join(".project_root"), "/abs/path/b\n").unwrap();
        let map = gemini_slug_map(&tmp);
        assert_eq!(map.get("slug-a").map(String::as_str), Some("/abs/path/a"));
        assert_eq!(map.get("slug-b").map(String::as_str), Some("/abs/path/b"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gemini_meta_summary_title_and_directories_fallback() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let chats = dir.join("tmp").join("some-slug").join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        let file = chats.join("session-x.jsonl");
        let content = concat!(
            r#"{"sessionId":"g1","startTime":"2026-07-21T02:46:00Z","directories":["/abs/proj"]}"#,
            "\n",
            r#"{"id":"m1","timestamp":"2026-07-21T02:46:01Z","type":"user","content":"问点什么"}"#,
            "\n",
            r#"{"$set":{"summary":"AI 摘要标题","lastUpdated":"2026-07-21T03:00:00Z"}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        // 空映射 → 走 metadata.directories 兜底
        let m = gemini_file_meta(&file, true, &HashMap::new()).unwrap();
        assert_eq!(m.project_path, "/abs/proj");
        assert_eq!(m.session_id, "g1");
        assert_eq!(m.title.as_deref(), Some("AI 摘要标题"), "$set 的 summary 优先于首条用户消息");
        assert_eq!(m.created_at.as_deref(), Some("2026-07-21T02:46:00Z"));
        // slug 映射命中时优先于 directories；映射和 directories 都没有则跳过该会话
        let mut map = HashMap::new();
        map.insert("some-slug".to_string(), "/mapped/proj".to_string());
        let m2 = gemini_file_meta(&file, true, &map).unwrap();
        assert_eq!(m2.project_path, "/mapped/proj");
        let file2 = chats.join("session-y.jsonl");
        std::fs::write(&file2, r#"{"sessionId":"g2","startTime":"t"}"#).unwrap();
        assert!(gemini_file_meta(&file2, true, &HashMap::new()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Qwen =====

    #[test]
    fn qwen_parse_blocks_usage_and_sidechain() {
        let lines = s(&[
            r#"{"uuid":"1","sessionId":"q1","timestamp":"2026-07-01T00:00:00Z","type":"user","cwd":"/tmp/proj","version":"0.10.0","message":{"role":"user","parts":[{"text":"帮我写代码"}]}}"#,
            r#"{"uuid":"2","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"想想","thought":true},{"text":"好的"},{"functionCall":{"name":"write_file","args":{"path":"/a"}}}]},"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"cachedContentTokenCount":5}}"#,
            r#"{"uuid":"3","sessionId":"q1","type":"tool_result","message":{"role":"tool","parts":[{"functionResponse":{"name":"write_file","response":{"ok":true}}}]}}"#,
            r#"{"uuid":"4","sessionId":"q1","type":"user","isSidechain":true,"message":{"role":"user","parts":[{"text":"支线"}]}}"#,
            r#"{"uuid":"5","sessionId":"q1","type":"system","subtype":"custom_title","systemPayload":{"customTitle":"自定义标题"}}"#,
            r#"{"uuid":"6","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"截断"#, // 截断末行
        ]);
        let msgs = parse_qwen(&lines);
        assert_eq!(msgs.len(), 2, "sidechain/system/截断行跳过，tool_result 并入上一条");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "帮我写代码");
        let a = &msgs[1];
        assert_eq!(a.role, "assistant");
        assert_eq!(a.blocks[0].kind, "thinking");
        assert_eq!(a.blocks[1].kind, "text");
        assert_eq!(a.blocks[2].kind, "tool_use");
        assert_eq!(a.blocks[2].tool_name.as_deref(), Some("write_file"));
        assert_eq!(a.blocks[3].kind, "tool_result");
        let u = a.usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (50, 10, 5, 0));
    }

    #[test]
    fn qwen_meta_custom_title_cwd_version_and_archive() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let chats = dir.join("projects").join("-tmp-proj").join("chats").join("archive");
        std::fs::create_dir_all(&chats).unwrap();
        let file = chats.join("q1.jsonl");
        let content = concat!(
            r#"{"uuid":"1","sessionId":"q1","timestamp":"2026-07-01T00:00:00Z","type":"user","cwd":"/tmp/proj","version":"0.10.0","message":{"role":"user","parts":[{"text":"首条提问"}]}}"#,
            "\n",
            r#"{"uuid":"2","sessionId":"q1","type":"system","subtype":"custom_title","systemPayload":{"customTitle":"我的会话"}}"#,
            "\n",
            r#"{"uuid":"3","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"答"}]},"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3}}"#,
            "\n",
        );
        std::fs::write(&file, content).unwrap();
        let m = qwen_file_meta(&file, true, true).unwrap();
        assert_eq!(m.project_path, "/tmp/proj", "项目归属以首条记录 cwd 为准，不解码目录名");
        assert_eq!(m.session_id, "q1");
        assert_eq!(m.cli_version.as_deref(), Some("0.10.0"));
        assert_eq!(m.title.as_deref(), Some("我的会话"), "custom_title 覆盖首条用户消息");
        assert!(m.archived);
        assert!(m.alive);
        let u = m.token_usage.unwrap();
        assert_eq!((u.input, u.output), (9, 3));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== Kimi =====

    #[test]
    fn kimi_wire_parse_dedup_injection_tools_usage() {
        let lines = s(&[
            r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"第一问"}],"origin":{"kind":"user"},"time":1785307072000}"#,
            r#"{"type":"context.append_message","message":{"role":"user","origin":{"kind":"user"},"content":[{"type":"text","text":"第一问"}]},"time":1785307072001}"#, // prompt 回显，去重
            r#"{"type":"context.append_message","message":{"role":"user","origin":{"kind":"injection"},"content":[{"type":"text","text":"<system-reminder>注入</system-reminder>"}]},"time":1785307072002}"#,
            r#"{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"think","think":"想想"},{"type":"text","text":"好的"}],"toolCalls":[{"function":{"name":"Read","arguments":"{\"path\":\"/a\"}"}}]},"time":1785307073000}"#,
            r#"{"type":"context.append_message","message":{"role":"tool","content":[{"type":"text","text":"file body"}]},"time":1785307074000}"#,
            r#"{"type":"usage.record","usage":{"inputOther":100,"output":20,"inputCacheRead":10,"inputCacheCreation":5},"time":1785307075000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"slash 命令"}],"origin":{"kind":"slash"},"time":1785307076000}"#, // 非 user 来源跳过
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"截断"#, // 截断末行
        ]);
        let msgs = parse_kimi(&lines);
        assert_eq!(msgs.len(), 2, "回显/注入/slash/截断行都要处理掉");
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "第一问");
        assert_eq!(msgs[0].timestamp.as_deref(), Some("2026-07-29T06:37:52Z"));
        let a = &msgs[1];
        assert_eq!(a.role, "assistant");
        assert_eq!(a.blocks[0].kind, "thinking");
        assert_eq!(a.blocks[1].kind, "text");
        assert_eq!(a.blocks[2].kind, "tool_use");
        assert_eq!(a.blocks[2].tool_name.as_deref(), Some("Read"));
        assert_eq!(a.blocks[2].text, "{\"path\":\"/a\"}");
        assert_eq!(a.blocks[3].kind, "tool_result");
        assert_eq!(a.blocks[3].text, "file body");
        let u = a.usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (100, 20, 10, 5));
    }

    #[test]
    fn kimi_wire_parse_loop_events() {
        // 新协议：assistant 输出走 append_loop_event 流式事件（step.begin/content.part/tool.call/tool.result/step.end）
        let lines = s(&[
            r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"跑一下测试"}],"origin":{"kind":"user"},"time":1785307072000}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":1},"time":1785307072100}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"先想"}},"time":1785307072200}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"我来跑"}},"time":1785307072300}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{"command":"cargo test"}},"time":1785307072400}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"tool.result","result":{"output":"ok 70 passed"}},"time":1785307072500}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":500,"output":60,"inputCacheRead":7,"inputCacheCreation":3}},"time":1785307072600}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":2},"time":1785307072700}"#,
            r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"全绿"}},"time":1785307072800}"#,
        ]);
        let msgs = parse_kimi(&lines);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        let a1 = &msgs[1];
        assert_eq!(a1.blocks[0].kind, "thinking");
        assert_eq!(a1.blocks[1].kind, "text");
        assert_eq!(a1.blocks[2].kind, "tool_use");
        assert_eq!(a1.blocks[2].tool_name.as_deref(), Some("Bash"));
        assert_eq!(a1.blocks[2].text, "{\"command\":\"cargo test\"}");
        assert_eq!(a1.blocks[3].kind, "tool_result");
        assert_eq!(a1.blocks[3].text, "ok 70 passed");
        let u = a1.usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (500, 60, 7, 3));
        assert_eq!(msgs[2].blocks[0].text, "全绿", "第二个 step 是独立的一条 assistant 消息");
    }

    #[test]
    fn kimi_wire_meta_title_from_state_json() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let main = dir.join("session_abc").join("agents").join("main");
        std::fs::create_dir_all(&main).unwrap();
        let wire = main.join("wire.jsonl");
        std::fs::write(
            &wire,
            concat!(
                r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
                "\n",
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"首条输入"}],"origin":{"kind":"user"},"time":1785307072000}"#,
                "\n",
                r#"{"type":"usage.record","usage":{"inputOther":7,"output":3}}"#,
                "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("session_abc").join("state.json"),
            r#"{"createdAt":1785307071000,"title":"AI 起的标题"}"#,
        )
        .unwrap();
        let state: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("session_abc").join("state.json")).unwrap(),
        )
        .unwrap();
        let m = kimi_wire_file_meta(&wire, true, "abc", "/proj/x".into(), Some(&state)).unwrap();
        assert_eq!(m.agent, "kimi");
        assert_eq!(m.project_path, "/proj/x");
        assert_eq!(m.title.as_deref(), Some("AI 起的标题"), "state.json 标题优先");
        assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
        let u = m.token_usage.unwrap();
        assert_eq!((u.input, u.output), (7, 3));
        // 无 state 时回落首条用户输入
        let m2 = kimi_wire_file_meta(&wire, true, "abc", "/proj/x".into(), None).unwrap();
        assert_eq!(m2.title.as_deref(), Some("首条输入"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn kimi_legacy_parse_and_buckets() {
        // md5("/tmp/proj") 预计算值，验证 bucket 反查规则
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let kimi_json = dir.join("kimi.json");
        std::fs::write(&kimi_json, r#"{"work_dirs":[{"path":"/tmp/proj"}]}"#).unwrap();
        let buckets = kimi_workdir_buckets(&kimi_json);
        assert_eq!(
            buckets.get("d5ebc5292b750d2bb41a2557ca31bcac").map(String::as_str),
            Some("/tmp/proj")
        );
        std::fs::remove_dir_all(&dir).ok();

        let lines = s(&[
            r#"{"role":"_init","content":"内部记录"}"#,
            r#"{"role":"user","content":"旧版提问"}"#,
            r#"{"role":"assistant","content":[{"type":"text","text":"旧版回答"}],"tool_calls":[{"function":{"name":"Bash","arguments":"{\"cmd\":\"ls\"}"}}]}"#,
            r#"{"role":"tool","content":"total 0"}"#,
            r#"{"role":"_usage","usage":{"input_tokens":42,"output_tokens":9}}"#,
        ]);
        let msgs = parse_kimi_legacy(&lines);
        assert_eq!(msgs.len(), 2, "_ 开头的内部角色跳过，tool 并入上一条");
        assert_eq!(msgs[0].blocks[0].text, "旧版提问");
        let a = &msgs[1];
        assert_eq!(a.blocks[1].kind, "tool_use");
        assert_eq!(a.blocks[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(a.blocks[2].kind, "tool_result");
        let u = a.usage.as_ref().unwrap();
        assert_eq!((u.input, u.output), (42, 9));
    }

    #[test]
    fn kimi_variant_sniffing() {
        assert!(kimi_looks_like_wire(&s(&[r#"{"type":"metadata"}"#])));
        assert!(!kimi_looks_like_wire(&s(&[r#"{"role":"user","content":"x"}"#])));
    }

    // ===== 删除路径校验 =====

    #[test]
    fn delete_refuses_paths_outside_session_roots() {
        assert!(!is_under_session_root(Path::new("/etc/passwd")));
        assert!(!is_under_session_root(Path::new("/tmp/whatever.jsonl")));
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.jsonl");
        std::fs::write(&f, "{}").unwrap();
        let err = delete_source_file(f.to_str().unwrap()).unwrap_err();
        assert!(err.contains("拒绝删除"), "根目录外的文件必须拒绝: {err}");
        assert!(f.exists(), "被拒绝的文件不能被删");
        std::fs::remove_dir_all(&dir).ok();
        // 根目录内的路径放行（用真实 home 下的 .claude 构造，不实际创建）
        if let Some(home) = dirs::home_dir() {
            let inside = home.join(".claude").join("projects").join("x.jsonl");
            if inside.canonicalize().is_ok() {
                assert!(is_under_session_root(&inside));
            }
        }
    }

    #[test]
    fn worktree_sessions_rewrite_to_real_repo() {
        let rows = vec![
            crate::workspaces::WorktreeRow {
                worktree_path: "/home/u/ccode/workspaces/myrepo/feat-x".into(),
                repo_path: "/home/u/code/myrepo".into(),
                name: "feat-x".into(),
                base_branch: "main".into(),
            },
            crate::workspaces::WorktreeRow {
                worktree_path: "/home/u/ccode/workspaces/other/task".into(),
                repo_path: "/home/u/code/other".into(),
                name: "task".into(),
                base_branch: "main".into(),
            },
        ];
        // worktree 根命中
        let hit = resolve_worktree_project("/home/u/ccode/workspaces/myrepo/feat-x", &rows);
        assert_eq!(hit, Some(("/home/u/code/myrepo".into(), "feat-x".into())));
        // worktree 子目录也命中
        let sub = resolve_worktree_project("/home/u/ccode/workspaces/other/task/src", &rows);
        assert_eq!(sub, Some(("/home/u/code/other".into(), "task".into())));
        // 普通项目路径不受影响；相似前缀（feat-xy）不误判
        assert!(resolve_worktree_project("/home/u/code/myrepo", &rows).is_none());
        assert!(resolve_worktree_project("/home/u/ccode/workspaces/myrepo/feat-xy", &rows).is_none());
        assert!(resolve_worktree_project("/anywhere", &[]).is_none());
    }

    #[test]
    fn session_meta_summary_migration_and_merge() {
        // 模拟旧库：没有 summary/summary_at 列，迁移应幂等补上
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("app.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        migrate_session_meta(&conn);
        migrate_session_meta(&conn); // 第二次不报错（幂等）
        conn.execute(
            "INSERT INTO session_meta(agent, session_id, summary, summary_at)
             VALUES('codex', 's1', 'AI 摘要内容', '2026-07-30T00:00:00Z')",
            [],
        )
        .unwrap();
        let meta = read_all_meta(&conn);
        let row = meta.get(&("codex".to_string(), "s1".to_string())).unwrap();
        assert_eq!(row.summary.as_deref(), Some("AI 摘要内容"));
        // apply_meta 合并进 DTO
        let (mut merged, _) = merge_codex_chains(vec![codex_meta("s1", "2026-07-03T00:00:00Z", None)]);
        apply_meta(&mut merged, &HashMap::new(), &meta);
        assert_eq!(merged[0].summary.as_deref(), Some("AI 摘要内容"));
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== OpenCode =====

    /// 按 matrix §5 模式建临时 SQLite：project/session/message/part 四表 + fixture 行
    fn opencode_fixture_db(dir: &Path) -> PathBuf {
        let db = dir.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
               title TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
               tokens_cache_read INTEGER, tokens_cache_write INTEGER, agent TEXT, model TEXT,
               version TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO project VALUES('p1','/repo/x'),('global','');
             INSERT INTO session VALUES('ses_1','p1',NULL,'/fallback','修复登录 bug',0.1,100,20,5,10,2,'build','{}','0.9.0',1785307071000,1785307072000);
             INSERT INTO session VALUES('ses_2','global',NULL,'/tmp/dir2','',0,0,0,0,0,0,'build','{}',NULL,1785307080000,1785307080000);
             INSERT INTO message VALUES('msg_1','ses_1',1785307071100,'{\"role\":\"user\",\"summary\":{\"body\":\"帮我修 bug\"}}');
             INSERT INTO message VALUES('msg_2','ses_1',1785307071200,'{\"role\":\"assistant\",\"tokens\":{\"input\":100,\"output\":20,\"reasoning\":5,\"cache\":{\"read\":10,\"write\":2}}}');
             INSERT INTO part VALUES('prt_1','msg_2','ses_1',1785307071201,'{\"type\":\"reasoning\",\"text\":\"想想\"}');
             INSERT INTO part VALUES('prt_2','msg_2','ses_1',1785307071202,'{\"type\":\"text\",\"text\":\"好的\"}');
             INSERT INTO part VALUES('prt_3','msg_2','ses_1',1785307071203,'{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"completed\",\"input\":{\"cmd\":\"ls\"},\"output\":\"ok\"}}');
             INSERT INTO part VALUES('prt_4','msg_2','ses_1',1785307071204,'{\"type\":\"tool\",\"tool\":\"edit\",\"state\":{\"status\":\"error\",\"input\":{\"file\":\"/a\"},\"error\":\"写入失败\"}}');
             INSERT INTO part VALUES('prt_5','msg_2','ses_1',1785307071205,'{\"type\":\"step-start\"}');",
        )
        .unwrap();
        db
    }

    #[test]
    fn opencode_scan_maps_db_rows() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        let metas = opencode_scan_db(&db);
        assert_eq!(metas.len(), 2);
        let m1 = metas.iter().find(|m| m.session_id == "ses_1").unwrap();
        assert_eq!(m1.agent, "opencode");
        assert_eq!(m1.project_path, "/repo/x", "project_id → project.worktree");
        assert_eq!(m1.title.as_deref(), Some("修复登录 bug"));
        assert_eq!(m1.created_at.as_deref(), Some("2026-07-29T06:37:51Z"), "epoch ms → ISO");
        assert_eq!(m1.cli_version.as_deref(), Some("0.9.0"));
        assert!(m1.file_path.ends_with("#ses_1"));
        assert!(m1.alive);
        let u = m1.token_usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (100, 25, 10, 2));
        let m2 = metas.iter().find(|m| m.session_id == "ses_2").unwrap();
        assert_eq!(m2.project_path, "/tmp/dir2", "global 项目回落 session.directory");
        assert_eq!(m2.title, None, "空标题按 None 处理");
        assert!(m2.token_usage.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_parse_db_messages_blocks_usage() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        let msgs = opencode_parse_db(&db, "ses_1");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
        let a = &msgs[1];
        let kinds: Vec<&str> = a.blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["thinking", "text", "tool_use", "tool_result", "tool_use", "tool_result"]);
        assert_eq!(a.blocks[2].tool_name.as_deref(), Some("bash"));
        assert_eq!(a.blocks[3].text, "ok");
        assert_eq!(a.blocks[5].text, "写入失败", "error 状态的 state.error 进 tool_result");
        let u = a.usage.as_ref().unwrap();
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write), (100, 25, 10, 2), "reasoning 计入 output");
        assert_eq!(a.timestamp.as_deref(), Some("2026-07-29T06:37:51Z"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_scan_tolerates_minimal_columns() {
        // drizzle 迁移漂移：只有最小列集也得能扫
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
             INSERT INTO session VALUES('ses_min','只有标题','/dir');",
        )
        .unwrap();
        drop(conn);
        let metas = opencode_scan_db(&db);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].project_path, "/dir");
        assert!(metas[0].created_at.is_none());
        assert!(metas[0].token_usage.is_none());
        assert!(opencode_parse_db(&db, "ses_min").is_empty(), "缺 message/part 表 → 空消息列表");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_export_snapshot_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        let exported = opencode_export_session(&db, "ses_1").unwrap();
        assert_eq!(get_str(exported.get("session").unwrap(), "title"), Some("修复登录 bug"));
        let msgs = opencode_parse_snapshot(&exported);
        let db_msgs = opencode_parse_db(&db, "ses_1");
        assert_eq!(msgs.len(), db_msgs.len());
        assert_eq!(msgs[1].blocks.len(), db_msgs[1].blocks.len(), "快照回放与读库一致");
        assert_eq!(msgs[1].blocks[3].text, "ok");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_legacy_flat_json_scan_and_parse() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let storage = dir.join("storage");
        std::fs::create_dir_all(storage.join("session/p1")).unwrap();
        std::fs::create_dir_all(storage.join("message/ses_9")).unwrap();
        std::fs::create_dir_all(storage.join("part/msg_2")).unwrap();
        std::fs::write(
            storage.join("session/p1/ses_9.json"),
            r#"{"id":"ses_9","title":"旧会话","directory":"/old/dir","time":{"created":1785307071000,"updated":1785307072000},"tokens_input":7,"tokens_output":3}"#,
        )
        .unwrap();
        std::fs::write(
            storage.join("message/ses_9/msg_1.json"),
            r#"{"role":"user","time":{"created":1785307071100},"summary":{"body":"旧问题"}}"#,
        )
        .unwrap();
        std::fs::write(
            storage.join("message/ses_9/msg_2.json"),
            r#"{"role":"assistant","time":{"created":1785307071200},"tokens":{"input":7,"output":3}}"#,
        )
        .unwrap();
        std::fs::write(storage.join("part/msg_2/prt_1.json"), r#"{"type":"text","text":"旧回答"}"#).unwrap();
        let metas = opencode_scan_legacy(&storage);
        assert_eq!(metas.len(), 1);
        let m = &metas[0];
        assert_eq!(m.session_id, "ses_9");
        assert_eq!(m.project_path, "/old/dir");
        assert_eq!(m.title.as_deref(), Some("旧会话"));
        assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
        assert_eq!(m.token_usage.as_ref().map(|u| (u.input, u.output)), Some((7, 3)));
        let msgs = opencode_parse_legacy(&storage.join("session/p1/ses_9.json"));
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].blocks[0].text, "旧问题");
        assert_eq!(msgs[1].blocks[0].text, "旧回答");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 注意力标记 v1 =====

    #[test]
    fn tail_state_claude_variants() {
        // 文本收尾 → done；问句收尾 → confirm
        let done = s(&[
            r#"{"type":"user","message":{"role":"user","content":"问"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"已完成修复。"}]}}"#,
        ]);
        assert_eq!(claude_tail_state(&done), "done");
        let confirm = s(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"我需要删除这个文件，可以继续吗？"}]}}"#,
        ]);
        assert_eq!(claude_tail_state(&confirm), "confirm");
        // 尾部工具调用未回 → working；user 刚发 → working；meta/支线不算
        let tool = s(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#,
        ]);
        assert_eq!(claude_tail_state(&tool), "working");
        let user = s(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"再改一下"}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
        ]);
        assert_eq!(claude_tail_state(&user), "working");
    }

    #[test]
    fn tail_state_codex_variants() {
        let done = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#, // token_count 等事件不算
        ]);
        assert_eq!(codex_tail_state(&done), "done");
        let working = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#,
        ]);
        assert_eq!(codex_tail_state(&working), "working");
        let user = s(&[
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"干活"}]}}"#,
        ]);
        assert_eq!(codex_tail_state(&user), "working");
    }

    #[test]
    fn tail_state_gemini_qwen_kimi() {
        let g_user = s(&[r#"{"id":"m1","type":"user","content":"在吗"}"#]);
        assert_eq!(gemini_tail_state(&g_user), "working");
        let g_done = s(&[
            r#"{"id":"m1","type":"gemini","content":"做完了"}"#,
            r#"{"$set":{"lastUpdated":"x"}}"#, // 控制记录跳过
        ]);
        assert_eq!(gemini_tail_state(&g_done), "done");
        let g_confirm = s(&[r#"{"id":"m1","type":"gemini","content":"要我继续吗？"}"#]);
        assert_eq!(gemini_tail_state(&g_confirm), "confirm");

        let q_user = s(&[r#"{"type":"user","message":{"role":"user","parts":[{"text":"问"}]}}"#]);
        assert_eq!(qwen_tail_state(&q_user), "working");
        let q_done = s(&[r#"{"type":"assistant","message":{"role":"model","parts":[{"text":"答"}]}}"#]);
        assert_eq!(qwen_tail_state(&q_done), "done");

        let k_working = s(&[
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"干活"}],"origin":{"kind":"user"},"time":1}"#,
        ]);
        assert_eq!(kimi_tail_state(&k_working), "working");
        let k_done = s(&[
            r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{}},"time":2}"#,
        ]);
        assert_eq!(kimi_tail_state(&k_done), "done");
        let k_tool = s(&[
            r#"{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{}},"time":2}"#,
        ]);
        assert_eq!(kimi_tail_state(&k_tool), "working");
    }

    #[test]
    fn tail_state_opencode_and_unknown() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = opencode_fixture_db(&dir);
        // fixture：最后一条 part 是 step-start（回落到消息角色），最后消息是 assistant → done
        assert_eq!(opencode_tail_state(&db, "ses_1"), "done");
        // 加一条 pending 工具 → working
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO part VALUES('prt_9','msg_2','ses_1',1785307071300,'{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"running\",\"input\":{}}}')", []).unwrap();
        drop(conn);
        assert_eq!(opencode_tail_state(&db, "ses_1"), "working");
        // 最后消息是 user → working
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO message VALUES('msg_9','ses_1',1785307071400,'{\"role\":\"user\",\"summary\":{\"body\":\"再来\"}}')", []).unwrap();
        drop(conn);
        assert_eq!(opencode_tail_state(&db, "ses_1"), "working");
        // 不存在的会话 / 不存在的库 → unknown
        assert_eq!(opencode_tail_state(&db, "ses_none"), "unknown");
        assert_eq!(opencode_tail_state(&dir.join("none.db"), "ses_1"), "unknown");
        std::fs::remove_dir_all(&dir).ok();
        // 文件缺失 → unknown
        assert_eq!(tail_state_impl("claude-code", "/nonexistent/x.jsonl"), "unknown");
    }
}








