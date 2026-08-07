//! 精确注意力标记（Claude Code hooks）：用户显式开启后，向 ~/.claude/settings.json 的
//! hooks 段写入三个事件（UserPromptSubmit/Stop/Notification）的命令条目，Claude 每次触发
//! 事件时把原始事件 JSON（带 unix 时间戳前缀）追加到 <config>/ccode/hooks-state/claude-hooks.jsonl。
//! sessions 的注意力分类在 claude-code 会话上优先读该日志（按 session_id 取最新事件），
//! 比尾部文本推断精确；日志缺失/过期（>10 分钟无更新）自动回落尾部推断。
//! 写 settings.json 遵守 global_config 同款约定：写前备份、原子写、只动 hooks 键、
//! 用户已有 hooks 合并而非覆盖、移除时只删含本日志路径的条目、配置损坏拒绝写入。

use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// hooks 作用的三个事件；Notification = Claude 请求权限/空闲等输入
const HOOK_EVENTS: [&str; 3] = ["UserPromptSubmit", "Stop", "Notification"];
/// 识别「我们的条目」的子串：命令里含状态日志路径，移除时只删含此子串的命令
const MARKER: &str = "hooks-state/claude-hooks.jsonl";
/// 状态日志过期阈值：超过 10 分钟无事件视为失效，回落尾部推断
const HOOKS_TTL_SECS: i64 = 10 * 60;
/// 读取日志的尾部窗口（日志只增不删，分类只看尾部即可）
const LOG_TAIL_WINDOW: u64 = 256 * 1024;
/// 同前缀备份保留份数
const BACKUP_KEEP: usize = 10;

fn hooks_state_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("hooks-state"))
}

fn hooks_log_path() -> Result<PathBuf, String> {
    Ok(hooks_state_dir()?.join("claude-hooks.jsonl"))
}

fn claude_settings_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("无法确定用户主目录")?
        .join(".claude")
        .join("settings.json"))
}

fn backups_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("backups"))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ===== hook 命令构造 =====

#[cfg(not(windows))]
fn shell_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(windows)]
fn shell_quote(p: &Path) -> String {
    // PowerShell 单引号字符串内的单引号双写转义
    format!("'{}'", p.to_string_lossy().replace('\'', "''"))
}

/// hook 命令：读 stdin 事件 JSON，加 unix 秒前缀后单行追加到状态日志。
/// unix 走 sh（Claude Code 以 sh -c 执行），Windows 走 powershell；命令内 mkdir -p 兜底目录不存在。
fn hook_command(log_path: &Path) -> String {
    let log = shell_quote(log_path);
    let dir = shell_quote(log_path.parent().unwrap_or_else(|| Path::new(".")));
    #[cfg(not(windows))]
    {
        format!(
            "umask 077; mkdir -p {dir}; {{ printf '%s ' \"$(date +%s)\"; cat; printf '\\n'; }} >> {log}"
        )
    }
    #[cfg(windows)]
    {
        // \s+ 折叠换行，保证一行一条记录（Claude Code stdin 可能是 pretty JSON）
        format!(
            "powershell -NoProfile -Command \"$d={dir};New-Item -ItemType Directory -Force -Path $d|Out-Null;\
             $l=[Console]::In.ReadToEnd();Add-Content -LiteralPath {log} \
             -Value (([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).ToString()+' '+($l -replace '\\s+',' '))\""
        )
    }
}

// ===== settings.json hooks 段合并/移除（纯函数） =====

fn parse_doc(existing: Option<&str>) -> Result<Value, String> {
    let v: Value = match existing {
        Some(t) if !t.trim().is_empty() => serde_json::from_str(t)
            .map_err(|e| format!("~/.claude/settings.json 不是合法 JSON，已停止写入以免破坏: {e}"))?,
        _ => json!({}),
    };
    if !v.is_object() {
        return Err("~/.claude/settings.json 根节点不是对象，已停止写入".into());
    }
    Ok(v)
}

fn to_pretty(v: &Value) -> Result<String, String> {
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

/// 从事件组数组中剔除我们的条目；组内 hooks 清空则整组删除
fn strip_marker_entries(arr: &mut Vec<Value>) {
    arr.retain_mut(|group| {
        if let Some(hooks) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            hooks.retain(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .is_none_or(|c| !c.contains(MARKER))
            });
            !hooks.is_empty()
        } else {
            true // 不是标准组结构的用户条目，原样保留
        }
    });
}

/// 合并：保留其他配置键与用户已有 hooks，三个事件各追加一条我们的命令；重复调用幂等
fn merge_hooks(existing: Option<&str>, command: &str) -> Result<String, String> {
    let mut v = parse_doc(existing)?;
    if let Some(h) = v.get("hooks") {
        if !h.is_object() {
            return Err("~/.claude/settings.json 的 hooks 字段不是对象，已停止写入".into());
        }
    }
    let hooks = v
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().unwrap();
    for event in HOOK_EVENTS {
        if let Some(e) = hooks.get(event) {
            if !e.is_array() {
                return Err(format!("hooks.{event} 不是数组，已停止写入"));
            }
        }
        let arr = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap();
        strip_marker_entries(arr); // 幂等：先清旧条目再追加
        arr.push(json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": command }]
        }));
    }
    to_pretty(&v)
}

/// 移除：只删含 MARKER 的命令条目；事件数组/hooks 对象清空后回收空壳键，其余原样保留
fn remove_hooks(existing: Option<&str>) -> Result<String, String> {
    let mut v = parse_doc(existing)?;
    let Some(hooks) = v.get_mut("hooks") else {
        return to_pretty(&v); // 本来就没有 hooks 段
    };
    if !hooks.is_object() {
        return Err("~/.claude/settings.json 的 hooks 字段不是对象，已停止写入".into());
    }
    let hooks = hooks.as_object_mut().unwrap();
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        if let Some(arr) = hooks.get_mut(&event).and_then(|e| e.as_array_mut()) {
            strip_marker_entries(arr);
            if arr.is_empty() {
                hooks.remove(&event);
            }
        }
    }
    if hooks.is_empty() {
        v.as_object_mut().unwrap().remove("hooks");
    }
    to_pretty(&v)
}

// ===== 备份与事务写入 =====

fn read_existing(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().filter(|t| !t.trim().is_empty())
}

/// 写前备份到 <config>/ccode/backups/claude-hooks-settings-<纳秒>.json，按前缀保留最近 N 份
/// （纳秒后缀保证同秒内连续开/关两次也各留一份，不会被同名覆盖）
fn backup_settings(backups: &Path, settings: &Path) -> Result<(), String> {
    fs::create_dir_all(backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dst = backups.join(format!("claude-hooks-settings-{nanos:020}.json"));
    fs::copy(settings, &dst).map_err(|e| format!("备份 ~/.claude/settings.json 失败: {e}"))?;
    let mut olds: Vec<PathBuf> = fs::read_dir(backups)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("claude-hooks-settings-"))
                })
                .collect()
        })
        .unwrap_or_default();
    olds.sort();
    for p in olds.iter().take(olds.len().saturating_sub(BACKUP_KEEP)) {
        fs::remove_file(p).ok();
    }
    Ok(())
}

/// 应用开关：enabled=true 合并 hooks 段，false 移除我们的条目；写前备份 + 原子写。
/// 关闭时顺带清理状态日志；未安装过（文件不存在）时关闭是无操作。
fn apply_hooks_at(
    settings_path: &Path,
    log_path: &Path,
    backups: &Path,
    enabled: bool,
) -> Result<(), String> {
    let existing = read_existing(settings_path);
    if !enabled && existing.is_none() {
        return Ok(());
    }
    let content = if enabled {
        merge_hooks(existing.as_deref(), &hook_command(log_path))?
    } else {
        remove_hooks(existing.as_deref())?
    };
    if existing.is_some() {
        backup_settings(backups, settings_path)?;
    }
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    }
    crate::profiles::atomic_write(settings_path, &content)?;
    if !enabled {
        fs::remove_file(log_path).ok(); // 关闭即清理状态日志，避免残留状态被误读
    }
    Ok(())
}

// ===== 状态日志读取（注意力分类数据源） =====

struct HookRecord {
    ts: i64,
    session_id: String,
    event: String,
}

fn event_state(event: &str) -> Option<&'static str> {
    match event {
        "UserPromptSubmit" => Some("working"),
        "Stop" => Some("done"),
        "Notification" => Some("confirm"),
        _ => None,
    }
}

/// 防御式解析日志：一行一条 `<unix秒> <事件JSON>`；容忍坏行、末行截断与 pretty JSON 续行
/// （hook stdin 若非单行 JSON，续行拼回上一条记录再解析）
fn parse_log_records(text: &str) -> Vec<HookRecord> {
    fn push(out: &mut Vec<HookRecord>, buf: &str) {
        let Some((ts_s, body)) = buf.split_once(' ') else { return };
        let Ok(ts) = ts_s.parse::<i64>() else { return };
        let Ok(v) = serde_json::from_str::<Value>(body) else { return };
        let (Some(sid), Some(ev)) = (
            v.get("session_id").and_then(|x| x.as_str()),
            v.get("hook_event_name").and_then(|x| x.as_str()),
        ) else {
            return;
        };
        out.push(HookRecord {
            ts,
            session_id: sid.to_string(),
            event: ev.to_string(),
        });
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    for line in text.lines() {
        let starts_record = line
            .split_once(' ')
            .is_some_and(|(head, _)| head.parse::<i64>().is_ok());
        if starts_record {
            if !buf.is_empty() {
                push(&mut out, &buf);
            }
            buf = line.to_string();
        } else if !buf.is_empty() {
            buf.push_str(line); // pretty JSON 续行
        }
    }
    if !buf.is_empty() {
        push(&mut out, &buf);
    }
    out
}

/// 取该 session 最新事件映射的注意力状态；无记录或最新事件已过期（>TTL）返回 None（回落尾部推断）
fn state_from_text(text: &str, session_id: &str, now: i64) -> Option<String> {
    let mut best: Option<(i64, &str)> = None;
    for rec in parse_log_records(text) {
        if rec.session_id != session_id {
            continue;
        }
        let Some(state) = event_state(&rec.event) else { continue };
        if best.is_none_or(|(ts, _)| rec.ts >= ts) {
            best = Some((rec.ts, state));
        }
    }
    let (ts, state) = best?;
    if now - ts > HOOKS_TTL_SECS {
        return None;
    }
    Some(state.to_string())
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > LOG_TAIL_WINDOW && f.seek(SeekFrom::Start(len - LOG_TAIL_WINDOW)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// sessions::tail_state_impl 的 claude-code 融合入口：
/// 仅当设置开启且日志内有该会话的未过期事件时返回精确状态，其余情况 None 回落尾部推断。
/// session_id = 会话文件主名（~/.claude/projects/<slug>/<session_id>.jsonl）。
pub(crate) fn state_for_session_file(file_path: &str) -> Option<String> {
    if crate::settings::read_current().claude_hooks_attention != Some(true) {
        return None;
    }
    let session_id = Path::new(file_path).file_stem()?.to_string_lossy().into_owned();
    if session_id.is_empty() {
        return None;
    }
    let log = hooks_log_path().ok()?;
    state_from_text(&read_log_tail(&log), &session_id, now_unix())
}

// ===== Tauri command =====

/// 设置页开关：先改 ~/.claude/settings.json（备份+原子写），成功后记应用设置；
/// 应用设置写失败时回滚 hooks，避免开关显示与实际安装不一致。
#[tauri::command]
pub async fn set_claude_hooks_attention(
    enabled: bool,
) -> Result<crate::settings::AppSettingsDto, String> {
    let settings = claude_settings_path()?;
    let log = hooks_log_path()?;
    let backups = backups_dir()?;
    {
        let (s, l, b) = (settings.clone(), log.clone(), backups.clone());
        tauri::async_runtime::spawn_blocking(move || apply_hooks_at(&s, &l, &b, enabled))
            .await
            .map_err(|e| format!("切换精确注意力标记失败: {e}"))??;
    }
    let patch = crate::settings::AppSettingsDto {
        claude_hooks_attention: Some(enabled),
        ..Default::default()
    };
    match crate::settings::update_settings(patch).await {
        Ok(full) => Ok(full),
        Err(e) => {
            tauri::async_runtime::spawn_blocking(move || {
                apply_hooks_at(&settings, &log, &backups, !enabled)
            })
            .await
            .ok();
            Err(format!("应用设置保存失败，已还原 Claude hooks 配置: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-hooks-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn merge_into_empty_creates_three_events_idempotent() {
        let out = merge_hooks(None, "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for event in HOOK_EVENTS {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} 一条我们的条目");
            assert_eq!(arr[0]["hooks"][0]["command"], "CMD hooks-state/claude-hooks.jsonl");
        }
        // 重复合并不叠加
        let out2 = merge_hooks(Some(&out), "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v2: Value = serde_json::from_str(&out2).unwrap();
        for event in HOOK_EVENTS {
            assert_eq!(v2["hooks"][event].as_array().unwrap().len(), 1, "{event} 幂等");
        }
    }

    #[test]
    fn merge_preserves_user_hooks_and_other_keys() {
        let existing = r#"{
            "env": {"FOO": "bar"},
            "hooks": {
                "Notification": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "user-script"}]}
                ]
            }
        }"#;
        let out = merge_hooks(Some(existing), "CMD hooks-state/claude-hooks.jsonl").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["FOO"], "bar", "其他配置键保留");
        let notif = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2, "用户条目保留 + 追加我们的");
        assert_eq!(notif[0]["hooks"][0]["command"], "user-script");
    }

    #[test]
    fn merge_and_remove_reject_broken_json() {
        assert!(merge_hooks(Some("{broken"), "CMD").is_err());
        assert!(remove_hooks(Some("{broken")).is_err());
        assert!(merge_hooks(Some(r#"{"hooks": 42}"#), "CMD").is_err(), "hooks 非对象拒绝");
        assert!(merge_hooks(Some(r#"{"hooks": {"Stop": {"x": 1}}}"#), "CMD").is_err(), "事件非数组拒绝");
    }

    #[test]
    fn remove_only_ours_and_cleans_empty_shells() {
        let existing = r#"{
            "env": {"FOO": "bar"},
            "hooks": {
                "Stop": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "user-stop"}]},
                    {"matcher": "", "hooks": [
                        {"type": "command", "command": "x hooks-state/claude-hooks.jsonl y"},
                        {"type": "command", "command": "user-mixed"}
                    ]}
                ],
                "UserPromptSubmit": [
                    {"matcher": "", "hooks": [{"type": "command", "command": "x hooks-state/claude-hooks.jsonl"}]}
                ]
            }
        }"#;
        let out = remove_hooks(Some(existing)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["FOO"], "bar");
        // Stop：我们的命令被剔除但同组的用户命令保留，组与用户组都在
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        let cmds: Vec<&str> = stop
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().iter())
            .map(|h| h["command"].as_str().unwrap())
            .collect();
        assert_eq!(cmds, ["user-stop", "user-mixed"], "只删我们的条目");
        // UserPromptSubmit 只剩我们的条目 → 事件键整体回收
        assert!(v["hooks"].get("UserPromptSubmit").is_none());
    }

    #[test]
    fn remove_drops_hooks_key_when_empty() {
        let existing = r#"{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "hooks-state/claude-hooks.jsonl"}]}]}}"#;
        let out = remove_hooks(Some(existing)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("hooks").is_none(), "hooks 清空后回收键");
        // 本来就没有 hooks 段：原样（不报错）
        let out = remove_hooks(Some(r#"{"env": {}}"#)).unwrap();
        assert!(serde_json::from_str::<Value>(&out).unwrap().get("hooks").is_none());
    }

    #[test]
    fn parse_log_records_tolerates_multiline_and_garbage() {
        let text = "not-a-record\n\
                    100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}\n\
                    101 {\n  \"session_id\": \"s1\",\n  \"hook_event_name\": \"Stop\"\n}\n\
                    102 {broken json\n\
                    103 {\"hook_event_name\": \"Stop\"}\n";
        let recs = parse_log_records(text);
        assert_eq!(recs.len(), 2, "坏行与缺字段行跳过");
        assert_eq!(recs[0].ts, 100);
        assert_eq!(recs[1].event, "Stop", "pretty JSON 续行拼回解析");
    }

    #[test]
    fn state_from_text_latest_event_and_ttl() {
        let text = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}\n\
                    200 {\"session_id\": \"s2\", \"hook_event_name\": \"Notification\"}\n\
                    300 {\"session_id\": \"s1\", \"hook_event_name\": \"Stop\"}\n";
        assert_eq!(state_from_text(text, "s1", 310).as_deref(), Some("done"), "取最新事件");
        assert_eq!(state_from_text(text, "s2", 310).as_deref(), Some("confirm"));
        assert_eq!(state_from_text(text, "s3", 310), None, "无记录 → None");
        assert_eq!(
            state_from_text(text, "s1", 300 + HOOKS_TTL_SECS + 1),
            None,
            "过期 → None 回落尾部推断"
        );
        let working = "100 {\"session_id\": \"s1\", \"hook_event_name\": \"UserPromptSubmit\"}";
        assert_eq!(state_from_text(working, "s1", 120).as_deref(), Some("working"));
    }

    #[test]
    fn apply_hooks_at_roundtrip_backup_and_cleanup() {
        let dir = tmpdir("roundtrip");
        let settings = dir.join("settings.json");
        let log = dir.join("hooks-state").join("claude-hooks.jsonl");
        let backups = dir.join("backups");
        fs::write(&settings, r#"{"env": {"KEEP": "1"}}"#).unwrap();
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "1 {}\n").unwrap();

        // 开启：hooks 写入、原文件被备份、其他键保留
        apply_hooks_at(&settings, &log, &backups, true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v["hooks"]["Stop"].is_array());
        let baks: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(baks.len(), 1, "写前备份");

        // 关闭：hooks 段移除、其他键保留、状态日志清理、再留一份备份
        apply_hooks_at(&settings, &log, &backups, false).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v.get("hooks").is_none());
        assert!(!log.exists(), "关闭清理状态日志");
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 2);

        // 未安装过（文件不存在）时关闭 = 无操作
        let missing = dir.join("nope/settings.json");
        apply_hooks_at(&missing, &log, &backups, false).unwrap();
        assert!(!missing.exists());
        fs::remove_dir_all(&dir).ok();
    }
}
