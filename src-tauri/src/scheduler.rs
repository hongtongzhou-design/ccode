//! 定时雷达：按「每日/每周 + 时分」周期，无头拉起 agent CLI 在项目目录里跑一次技能
//! （默认文献监控 lit-watch，可选技能库里的其他技能），跑完记录历史并发 `scheduler-run-done` 事件给前端。
//!
//! 存储：应用配置目录 ccode/schedules.json（snake_case）；给前端的 DTO 用 camelCase。
//! due 判定按本地时间算「最近一次应跑时刻」，last_run_at 早于它即 due——应用关闭错过
//! 的时间点在启动后第一个 tick 自动补跑一次（多次漏跑只补一次，coalesce）。

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Emitter;

/// 单条任务执行超时：无头 CLI 巡检 10 分钟足够
const RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// 调度 tick 间隔
const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// 历史只留最近 20 条（新的在前）
const HISTORY_CAP: usize = 20;
/// 简报脱敏后截 2000 字符
const SUMMARY_CAP: usize = 2000;

/// 任务 prompt 模板按技能分派：lit-watch 用文献巡检专用文案（一字不动），
/// 其他技能用通用模板（技能自有规范为准，调度器不复制关键词/路径口径）
const TASK_PROMPT_LIT_WATCH: &str = "请使用 {skill} 技能执行一次文献巡检：按 papers/watchlist.md 的订阅清单检索新文献，去重、精选后把命中追加到 notes/inbox.md，结束时输出三行以内的简报（检索了几条关键词/来源、新命中几篇、其中推荐几篇、哪些来源未达）。本任务由 Ccode 定时雷达自动触发。";
const TASK_PROMPT_GENERIC: &str = "请使用 {skill} 技能在项目内执行一次定时巡检，按该技能的既定规范产出结果，结束时输出三行以内简报。本任务由 Ccode 定时雷达自动触发。";

// ===== 数据模型 =====

/// 单次运行记录（at/status/summary 均为单词，snake_case 与 camelCase 一致，存储/前端共用；
/// new_entries 是两词字段，按前端 DTO 约定序列化为 newEntries，老记录缺省 None）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunRecord {
    pub at: String,
    /// "ok" | "error"
    pub status: String,
    /// 脱敏后截 2000 字符的简报/错误信息
    pub summary: String,
    /// 本次运行新增的收件箱条目数（仅 lit-watch 类任务、仅成功时记；超时/失败为 None）
    #[serde(default, rename = "newEntries")]
    pub new_entries: Option<u32>,
}

/// 存储形态（schedules.json，snake_case）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    /// 项目根绝对路径（任务 cwd）
    pub project_root: String,
    /// 技能名，默认 "lit-watch"
    pub skill: String,
    /// None = 每次运行现解析（设置页 AI 专用 profile → 最近使用）
    pub profile_id: Option<String>,
    /// 关联的流水线步骤名（步骤 name；未关联为 None）。serde default 兼容老 schedules.json
    #[serde(default)]
    pub linked_step: Option<String>,
    /// "daily" | "weekly"
    pub frequency: String,
    /// weekly 时 1-7（周一=1）；daily 忽略
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub history: Vec<RunRecord>,
}

/// 前端 DTO（camelCase）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDto {
    pub id: String,
    pub name: String,
    pub project_root: String,
    pub skill: String,
    pub profile_id: Option<String>,
    pub linked_step: Option<String>,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub history: Vec<RunRecord>,
}

impl From<Schedule> for ScheduleDto {
    fn from(s: Schedule) -> Self {
        Self {
            id: s.id,
            name: s.name,
            project_root: s.project_root,
            skill: s.skill,
            profile_id: s.profile_id,
            linked_step: s.linked_step,
            frequency: s.frequency,
            weekday: s.weekday,
            hour: s.hour,
            minute: s.minute,
            enabled: s.enabled,
            last_run_at: s.last_run_at,
            last_status: s.last_status,
            history: s.history,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduleInput {
    pub name: Option<String>,
    pub project_root: String,
    pub skill: Option<String>,
    pub profile_id: Option<String>,
    /// 关联的流水线步骤名（可选；老前端不传为 None）
    pub linked_step: Option<String>,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub hour: u8,
    pub minute: u8,
}

/// 更新补丁：字段全 Option（None = 不改）；profile_id/linked_step 用 Option<Option<String>>，
/// 传空字符串（空白归一为 None）表示清掉指定值、回到每次运行现解析/未关联
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSchedulePatch {
    pub name: Option<String>,
    #[serde(default)]
    pub profile_id: Option<Option<String>>,
    // 关联步骤补丁。注意 serde 对 Option<Option<T>> 不区分「缺失」与显式 null（都按 None = 不改），
    // 清除关联走 Some("")：空白在下方归一为 None（与 profile_id 的空串过滤口径一致）
    #[serde(default)]
    pub linked_step: Option<Option<String>>,
    pub frequency: Option<String>,
    pub weekday: Option<u8>,
    pub hour: Option<u8>,
    pub minute: Option<u8>,
    pub enabled: Option<bool>,
}

/// `scheduler-run-done` 事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunDonePayload {
    schedule_id: String,
    project_root: String,
    status: String,
    summary: String,
}

// ===== 存储 =====

fn schedules_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("schedules.json"))
}

fn read_schedules_at(path: &Path) -> Result<Vec<Schedule>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("解析 schedules.json 失败: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 schedules.json 失败: {e}")),
    }
}

fn write_schedules_at(path: &Path, list: &[Schedule]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// schedules.json 读-改-写进程内锁（同 profiles.rs 的 store_lock 模式）
static SCHED_MUTEX: Mutex<()> = Mutex::new(());

fn sched_lock() -> MutexGuard<'static, ()> {
    SCHED_MUTEX.lock().unwrap_or_else(|e| e.into_inner())
}

/// 正在运行的任务 id（防重入）：tick 内与 run_schedule_now 共用
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_running<R>(f: impl FnOnce(&mut HashSet<String>) -> R) -> R {
    let mut g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashSet::new))
}

/// 成功登记返回 true；已在跑返回 false
fn mark_running(id: &str) -> bool {
    with_running(|s| s.insert(id.to_string()))
}

fn unmark_running(id: &str) {
    with_running(|s| {
        s.remove(id);
    });
}

// ===== due 判定（纯函数，时间全部注入，可测） =====

fn at_hms(date: NaiveDate, hour: u8, minute: u8) -> Option<NaiveDateTime> {
    date.and_hms_opt(hour as u32, minute as u32, 0)
}

/// 「最近一次应跑时刻」（本地时间）：daily = 今天 hour:minute（还没到则昨天）；
/// weekly = 本周 weekday+hour:minute（还没到则上周）
fn latest_due_moment(
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let today = now.date();
    let mut date = today;
    if frequency == "weekly" {
        // weekday 1-7（周一=1）→ chrono num_days_from_monday 0-6
        let target = (weekday.unwrap_or(1) as i64 - 1).clamp(0, 6);
        let cur = today.weekday().num_days_from_monday() as i64;
        date = today + ChronoDuration::days(target - cur);
    }
    let moment = at_hms(date, hour, minute)?;
    if moment > now {
        date = date - ChronoDuration::days(if frequency == "weekly" { 7 } else { 1 });
    }
    at_hms(date, hour, minute)
}

/// last_run_at（ISO UTC 字符串）→ 本地 NaiveDateTime；解析失败按「没跑过」处理（更安全的方向：补跑）
fn parse_last_run_local(last_run_at: Option<&str>) -> Option<NaiveDateTime> {
    last_run_at.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Local).naive_local())
    })
}

/// last_run 早于最近一次应跑时刻即 due；None（从没跑过）恒 due。
/// 漏跑多天只算一次 due：跑一次后 last_run 落到最新时刻之后，自然不再 due（coalesce）
fn is_due(
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
    last_run_local: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> bool {
    let Some(moment) = latest_due_moment(frequency, weekday, hour, minute, now) else {
        return false;
    };
    match last_run_local {
        Some(last) => last < moment,
        None => true,
    }
}

// ===== 校验与构造 =====

fn validate_fields(
    project_root: &str,
    frequency: &str,
    weekday: Option<u8>,
    hour: u8,
    minute: u8,
) -> Result<String, String> {
    let root = crate::sessions::expand_tilde(project_root);
    if !Path::new(&root).is_dir() {
        return Err(format!("项目目录不存在: {root}"));
    }
    if frequency != "daily" && frequency != "weekly" {
        return Err(format!("frequency 必须是 daily 或 weekly: {frequency}"));
    }
    if frequency == "weekly" {
        match weekday {
            Some(d) if (1..=7).contains(&d) => {}
            _ => return Err("weekly 任务必须指定 weekday（1-7，周一=1）".into()),
        }
    }
    if hour >= 24 {
        return Err(format!("hour 必须在 0-23: {hour}"));
    }
    if minute >= 60 {
        return Err(format!("minute 必须在 0-59: {minute}"));
    }
    Ok(root)
}

fn build_task_prompt(skill: &str) -> String {
    let template = if skill == "lit-watch" {
        TASK_PROMPT_LIT_WATCH
    } else {
        TASK_PROMPT_GENERIC
    };
    template.replace("{skill}", skill)
}

fn cap_summary(text: &str) -> String {
    text.chars().take(SUMMARY_CAP).collect()
}

fn create_schedule_at(path: &Path, input: CreateScheduleInput) -> Result<Schedule, String> {
    let _g = sched_lock();
    let root = validate_fields(
        &input.project_root,
        &input.frequency,
        input.weekday,
        input.hour,
        input.minute,
    )?;
    let name = input
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "文献雷达".into());
    let skill = input
        .skill
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "lit-watch".into());
    let task = Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        project_root: root,
        skill,
        profile_id: input.profile_id.filter(|v| !v.trim().is_empty()),
        linked_step: input
            .linked_step
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        frequency: input.frequency,
        weekday: input.weekday,
        hour: input.hour,
        minute: input.minute,
        enabled: true,
        last_run_at: None,
        last_status: None,
        history: Vec::new(),
    };
    let mut list = read_schedules_at(path)?;
    list.push(task.clone());
    write_schedules_at(path, &list)?;
    Ok(task)
}

fn update_schedule_at(path: &Path, id: &str, patch: UpdateSchedulePatch) -> Result<Schedule, String> {
    let _g = sched_lock();
    let mut list = read_schedules_at(path)?;
    let task = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("定时任务不存在: {id}"))?;
    if let Some(name) = patch.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("名称不能为空".into());
        }
        task.name = name;
    }
    if let Some(profile_id) = patch.profile_id {
        task.profile_id = profile_id.filter(|v| !v.trim().is_empty());
    }
    if let Some(linked_step) = patch.linked_step {
        task.linked_step = linked_step
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }
    if let Some(frequency) = patch.frequency {
        task.frequency = frequency;
    }
    if let Some(weekday) = patch.weekday {
        task.weekday = Some(weekday);
    }
    if let Some(hour) = patch.hour {
        task.hour = hour;
    }
    if let Some(minute) = patch.minute {
        task.minute = minute;
    }
    if let Some(enabled) = patch.enabled {
        task.enabled = enabled;
    }
    // 校验合并后的整体（如 daily→weekly 时必须已有合法 weekday）
    let root = validate_fields(
        &task.project_root,
        &task.frequency,
        task.weekday,
        task.hour,
        task.minute,
    )?;
    task.project_root = root;
    let task = task.clone();
    write_schedules_at(path, &list)?;
    Ok(task)
}

/// 跑一次后回填 last_run_at/last_status/history（新的在前，只留 20 条）并原子写。
/// new_entries 仅 lit-watch 类任务成功时才有值（超时/失败由调用方传 None）
fn record_run(id: &str, status: &str, summary: &str, new_entries: Option<u32>) -> Result<(), String> {
    let _g = sched_lock();
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    let task = list
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("定时任务不存在: {id}"))?;
    let at = crate::sessions::now_iso();
    task.last_run_at = Some(at.clone());
    task.last_status = Some(status.to_string());
    task.history.insert(
        0,
        RunRecord {
            at,
            status: status.to_string(),
            summary: summary.to_string(),
            new_entries,
        },
    );
    task.history.truncate(HISTORY_CAP);
    write_schedules_at(&path, &list)
}

// ===== 执行 =====

/// 执行一条任务并回填历史，返回事件载荷。失败（进程错误/超时/解析不到 profile/
/// 找不到二进制/项目目录不存在）同样记 history（status="error"）。
/// 绝不真的在测试里调用（会拉起 CLI）。
fn execute_one(id: &str) -> RunDonePayload {
    let path = match schedules_path() {
        Ok(p) => p,
        Err(e) => {
            return RunDonePayload {
                schedule_id: id.to_string(),
                project_root: String::new(),
                status: "error".into(),
                summary: e,
            }
        }
    };
    let task = {
        let _g = sched_lock();
        match read_schedules_at(&path) {
            Ok(list) => list.into_iter().find(|t| t.id == id),
            Err(e) => {
                crate::logbuf::record("error", "scheduler", &format!("读取 schedules.json 失败: {e}"));
                None
            }
        }
    };
    let Some(task) = task else {
        return RunDonePayload {
            schedule_id: id.to_string(),
            project_root: String::new(),
            status: "error".into(),
            summary: format!("定时任务不存在: {id}"),
        };
    };
    // 新增条目计数仅对 lit-watch 类任务有意义（只有它往 notes/inbox.md 追加条目）
    let is_lit_watch = task.skill == "lit-watch";
    let before_entries = if is_lit_watch {
        Some(crate::lit_watch::count_inbox_entries(Path::new(&task.project_root)))
    } else {
        None
    };
    let result: Result<String, String> = (|| {
        let root = Path::new(&task.project_root);
        if !root.is_dir() {
            return Err(format!("项目目录不存在: {}", task.project_root));
        }
        let profiles = crate::profiles::ProfileStore::new()?.list()?;
        // profile 解析与 ai.rs 同一回落链：显式 id → 设置页 AI 专用 → 最近使用
        let dedicated = crate::settings::read_current().ai_profile_id;
        let profile = crate::ai::resolve_profile_from(profiles, task.profile_id.clone(), None, dedicated)?;
        crate::ai::run_agent_task(&profile, &build_task_prompt(&task.skill), root, RUN_TIMEOUT)
    })();
    // 超时/失败不记新增数：只有成功跑完才数第二次取差值（saturating_sub 防文件被外部截断）
    let new_entries = match (&result, before_entries) {
        (Ok(_), Some(before)) => Some(
            crate::lit_watch::count_inbox_entries(Path::new(&task.project_root))
                .saturating_sub(before),
        ),
        _ => None,
    };
    let (status, summary) = match result {
        // 简报/错误文本落存储与发事件前必须脱敏
        Ok(out) => ("ok", cap_summary(&crate::sessions::redact_sensitive_text(&out))),
        Err(e) => ("error", cap_summary(&crate::sessions::redact_sensitive_text(&e))),
    };
    if let Err(e) = record_run(id, status, &summary, new_entries) {
        crate::logbuf::record("error", "scheduler", &format!("回填运行历史失败: {e}"));
    }
    RunDonePayload {
        schedule_id: id.to_string(),
        project_root: task.project_root,
        status: status.to_string(),
        summary,
    }
}

fn emit_done(app: &tauri::AppHandle, payload: RunDonePayload) {
    if let Err(e) = app.emit("scheduler-run-done", &payload) {
        crate::logbuf::record("warn", "scheduler", &format!("发送 scheduler-run-done 事件失败: {e}"));
    }
}

/// 收集本轮 due 的任务 id（enabled 且未在跑）
fn collect_due_ids() -> Vec<String> {
    let path = match schedules_path() {
        Ok(p) => p,
        Err(e) => {
            crate::logbuf::record("error", "scheduler", &e);
            return Vec::new();
        }
    };
    let list = {
        let _g = sched_lock();
        match read_schedules_at(&path) {
            Ok(l) => l,
            Err(e) => {
                crate::logbuf::record("error", "scheduler", &e);
                return Vec::new();
            }
        }
    };
    let now = Local::now().naive_local();
    list.into_iter()
        .filter(|t| t.enabled)
        .filter(|t| {
            is_due(
                &t.frequency,
                t.weekday,
                t.hour,
                t.minute,
                parse_last_run_local(t.last_run_at.as_deref()),
                now,
            )
        })
        .filter(|t| with_running(|s| !s.contains(&t.id)))
        .map(|t| t.id)
        .collect()
}

/// 启动调度引擎（lib.rs setup 里调用一次）：后台线程每 60s 一个 tick，
/// 启动即先跑一轮——天然补跑应用关闭期间错过的任务；多条 due 任务串行执行，
/// 避免并发拉起一堆 CLI。用 spawn_blocking + thread::sleep（参照 diagnostics 后台循环），
/// 不为一个 sleep 引入 tokio 依赖。
pub fn start_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || loop {
        for id in collect_due_ids() {
            if !mark_running(&id) {
                continue;
            }
            let payload = execute_one(&id);
            unmark_running(&id);
            emit_done(&app, payload);
        }
        std::thread::sleep(TICK_INTERVAL);
    });
}

// ===== Tauri commands =====

#[tauri::command]
pub fn list_schedules() -> Result<Vec<ScheduleDto>, String> {
    let _g = sched_lock();
    let list = read_schedules_at(&schedules_path()?)?;
    Ok(list.into_iter().map(ScheduleDto::from).collect())
}

#[tauri::command]
pub fn create_schedule(input: CreateScheduleInput) -> Result<ScheduleDto, String> {
    create_schedule_at(&schedules_path()?, input).map(ScheduleDto::from)
}

#[tauri::command]
pub fn update_schedule(id: String, patch: UpdateSchedulePatch) -> Result<ScheduleDto, String> {
    update_schedule_at(&schedules_path()?, &id, patch).map(ScheduleDto::from)
}

#[tauri::command]
pub fn delete_schedule(id: String) -> Result<(), String> {
    let _g = sched_lock();
    let path = schedules_path()?;
    let mut list = read_schedules_at(&path)?;
    let before = list.len();
    list.retain(|t| t.id != id);
    if list.len() == before {
        return Err(format!("定时任务不存在: {id}"));
    }
    write_schedules_at(&path, &list)
}

/// 立即触发一次（不等结果）：走同一执行路径与防重入集合，结果经 scheduler-run-done 事件回前端
#[tauri::command]
pub fn run_schedule_now(app: tauri::AppHandle, id: String) -> Result<(), String> {
    {
        let _g = sched_lock();
        let list = read_schedules_at(&schedules_path()?)?;
        if !list.iter().any(|t| t.id == id) {
            return Err(format!("定时任务不存在: {id}"));
        }
    }
    if !mark_running(&id) {
        return Err("该任务正在运行中".into());
    }
    tauri::async_runtime::spawn(async move {
        let id2 = id.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || execute_one(&id2)).await;
        unmark_running(&id);
        match outcome {
            Ok(payload) => emit_done(&app, payload),
            Err(e) => crate::logbuf::record("error", "scheduler", &format!("任务执行线程异常: {e}")),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(date: NaiveDate, h: u8, m: u8) -> NaiveDateTime {
        date.and_hms_opt(h as u32, m as u32, 0).unwrap()
    }

    fn ymd(y: i32, mo: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap()
    }

    fn tmp_schedules_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccode-scheduler-test-{}-{}", tag, uuid::Uuid::new_v4()))
    }

    #[test]
    fn due_daily_not_yet_today_is_not_due() {
        // 今天 09:00，任务定在 10:00：最近应跑时刻是昨天 10:00，昨天已跑 → 不 due
        let now = dt(ymd(2026, 8, 13), 9, 0);
        let last = dt(ymd(2026, 8, 12), 10, 30);
        assert!(!is_due("daily", None, 10, 0, Some(last), now));
        // 昨天没跑 → due
        let last = dt(ymd(2026, 8, 11), 10, 30);
        assert!(is_due("daily", None, 10, 0, Some(last), now));
    }

    #[test]
    fn due_daily_past_time_not_run_is_due() {
        // 今天 09:00，任务定在 08:00：应跑时刻是今天 08:00，上次跑是昨天 → due
        let now = dt(ymd(2026, 8, 13), 9, 0);
        let last = dt(ymd(2026, 8, 12), 8, 30);
        assert!(is_due("daily", None, 8, 0, Some(last), now));
        // 今天已跑 → 不 due
        let last = dt(ymd(2026, 8, 13), 8, 30);
        assert!(!is_due("daily", None, 8, 0, Some(last), now));
    }

    #[test]
    fn due_weekly_across_weeks() {
        // now 取周四 09:00（动态算 weekday，测试不依赖具体日期）
        let now_date = ymd(2026, 8, 13);
        let today_idx = now_date.weekday().num_days_from_monday() as u8; // 0-6
        let now = dt(now_date, 9, 0);
        // 定在今天 08:00：应跑时刻是今天 08:00
        let wd = today_idx + 1;
        assert!(is_due("weekly", Some(wd), 8, 0, Some(dt(now_date - ChronoDuration::days(6), 8, 0)), now));
        assert!(!is_due("weekly", Some(wd), 8, 0, Some(dt(now_date, 8, 30)), now));
        // 定在今天 10:00（还没到）：应跑时刻是上周今天 10:00
        assert!(is_due("weekly", Some(wd), 10, 0, Some(dt(now_date - ChronoDuration::days(8), 10, 0)), now));
        assert!(!is_due("weekly", Some(wd), 10, 0, Some(dt(now_date - ChronoDuration::days(6), 10, 0)), now));
        // 定在昨天 08:00：应跑时刻是昨天 08:00，6 天前跑过 → due；昨天跑过 → 不 due
        let yesterday_idx = (today_idx + 6) % 7;
        let wd = yesterday_idx + 1;
        assert!(is_due("weekly", Some(wd), 8, 0, Some(dt(now_date - ChronoDuration::days(6), 8, 0)), now));
        assert!(!is_due("weekly", Some(wd), 8, 0, Some(dt(now_date - ChronoDuration::days(1), 8, 30)), now));
    }

    #[test]
    fn due_last_run_none_is_always_due() {
        let now = dt(ymd(2026, 8, 13), 9, 0);
        assert!(is_due("daily", None, 8, 0, None, now));
        assert!(is_due("weekly", Some(1), 8, 0, None, now));
    }

    #[test]
    fn due_missed_days_coalesce_to_single_run() {
        // 漏跑 5 天 → due；跑一次后 last_run 落到现在 → 不再 due（不会连补多次）
        let now = dt(ymd(2026, 8, 13), 9, 0);
        let last = dt(ymd(2026, 8, 8), 8, 0);
        assert!(is_due("daily", None, 8, 0, Some(last), now));
        assert!(!is_due("daily", None, 8, 0, Some(now), now));
    }

    #[test]
    fn schedules_json_roundtrip_via_atomic_write() {
        let path = tmp_schedules_path("roundtrip");
        let task = Schedule {
            id: "t1".into(),
            name: "文献雷达".into(),
            project_root: "/tmp/p".into(),
            skill: "lit-watch".into(),
            profile_id: None,
            linked_step: Some("文献监控".into()),
            frequency: "daily".into(),
            weekday: None,
            hour: 8,
            minute: 30,
            enabled: true,
            last_run_at: Some("2026-08-13T01:00:00Z".into()),
            last_status: Some("ok".into()),
            history: vec![RunRecord {
                at: "2026-08-13T01:00:00Z".into(),
                status: "ok".into(),
                summary: "新命中 2 篇".into(),
                new_entries: Some(2),
            }],
        };
        write_schedules_at(&path, &[task.clone()]).unwrap();
        // 原子写不留 tmp 残影
        assert!(!path.with_extension("tmp").exists());
        let back = read_schedules_at(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "t1");
        assert_eq!(back[0].linked_step.as_deref(), Some("文献监控"));
        assert_eq!(back[0].history.len(), 1);
        assert_eq!(back[0].history[0].summary, "新命中 2 篇");
        assert_eq!(back[0].history[0].new_entries, Some(2));
        // 缺文件 → 空列表
        let missing = tmp_schedules_path("missing");
        assert!(read_schedules_at(&missing).unwrap().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_json_without_linked_step_and_new_entries_deserializes() {
        // 老版本 schedules.json：无 linked_step、history 无 newEntries —— 两个字段都要 default 兼容
        let text = r#"[{
            "id": "t1", "name": "文献雷达", "project_root": "/tmp/p", "skill": "lit-watch",
            "profile_id": null, "frequency": "daily", "weekday": null, "hour": 8, "minute": 30,
            "enabled": true, "last_run_at": null, "last_status": null,
            "history": [{"at": "2026-08-13T01:00:00Z", "status": "ok", "summary": "新命中 2 篇"}]
        }]"#;
        let list: Vec<Schedule> = serde_json::from_str(text).unwrap();
        assert_eq!(list[0].linked_step, None);
        assert_eq!(list[0].history[0].new_entries, None);
        // 老前端发来的 create/update 报文（无 linkedStep）也要能解析
        let create: CreateScheduleInput = serde_json::from_str(
            r#"{"projectRoot": "/tmp/p", "frequency": "daily", "hour": 8, "minute": 0}"#,
        )
        .unwrap();
        assert_eq!(create.linked_step, None);
        let patch: UpdateSchedulePatch = serde_json::from_str(r#"{"hour": 9}"#).unwrap();
        assert_eq!(patch.linked_step, None);
        // 显式 null 与缺失等价：serde 对 Option<Option<T>> 不区分二者（既有 profile_id 同款口径），
        // 清除关联由 update 时空白字符串归一为 None 承担
        let patch: UpdateSchedulePatch = serde_json::from_str(r#"{"linkedStep": null}"#).unwrap();
        assert_eq!(patch.linked_step, None);
        let patch: UpdateSchedulePatch = serde_json::from_str(r#"{"linkedStep": " 检索筛选 "}"#).unwrap();
        assert_eq!(patch.linked_step, Some(Some(" 检索筛选 ".into())));
    }

    #[test]
    fn create_validation_rejects_bad_fields() {
        let dir = std::env::temp_dir().join(format!("ccode-scheduler-test-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let input = |frequency: &str, weekday: Option<u8>, hour: u8, minute: u8, root: &str| CreateScheduleInput {
            name: None,
            project_root: root.to_string(),
            skill: None,
            profile_id: None,
            linked_step: None,
            frequency: frequency.into(),
            weekday,
            hour,
            minute,
        };
        // 不存在的目录
        assert!(validate_fields("/definitely/not/exist-cccode", "daily", None, 8, 0).is_err());
        // 坏 hour / minute / frequency / weekday
        assert!(validate_fields(&root, "daily", None, 24, 0).is_err());
        assert!(validate_fields(&root, "daily", None, 8, 60).is_err());
        assert!(validate_fields(&root, "monthly", None, 8, 0).is_err());
        assert!(validate_fields(&root, "weekly", None, 8, 0).is_err());
        assert!(validate_fields(&root, "weekly", Some(8), 8, 0).is_err());
        assert!(validate_fields(&root, "weekly", Some(3), 8, 0).is_ok());
        assert!(validate_fields(&root, "daily", None, 8, 0).is_ok());
        // create 走同一校验（落到独立临时文件，不碰真实配置目录）
        let path = tmp_schedules_path("create");
        assert!(create_schedule_at(&path, input("daily", None, 25, 0, &root)).is_err());
        assert!(create_schedule_at(&path, input("daily", None, 8, 0, "/definitely/not/exist-cccode")).is_err());
        let t = create_schedule_at(&path, input("weekly", Some(2), 8, 30, &root)).unwrap();
        // 默认值：名称/技能/enabled/空历史/uuid
        assert_eq!(t.name, "文献雷达");
        assert_eq!(t.skill, "lit-watch");
        assert!(t.enabled);
        assert!(t.history.is_empty());
        assert!(!t.id.is_empty());
        assert_eq!(read_schedules_at(&path).unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompt_template_uses_skill_and_mentions_trigger() {
        let p = build_task_prompt("lit-watch");
        assert!(p.contains("lit-watch"));
        assert!(p.contains("papers/watchlist.md"));
        assert!(p.contains("notes/inbox.md"));
        assert!(p.contains("定时雷达自动触发"));
        let p = build_task_prompt("other-skill");
        assert!(p.contains("other-skill"));
        assert!(!p.contains("{skill}"));
    }

    #[test]
    fn prompt_template_dispatches_by_skill() {
        // lit-watch 专用文案一字不动（回归钉死）
        assert_eq!(
            build_task_prompt("lit-watch"),
            "请使用 lit-watch 技能执行一次文献巡检：按 papers/watchlist.md 的订阅清单检索新文献，去重、精选后把命中追加到 notes/inbox.md，结束时输出三行以内的简报（检索了几条关键词/来源、新命中几篇、其中推荐几篇、哪些来源未达）。本任务由 Ccode 定时雷达自动触发。"
        );
        // 其他技能走通用模板：替换技能名、不带文献巡检的路径口径
        let p = build_task_prompt("data-clean");
        assert!(p.contains("data-clean"));
        assert!(p.contains("定时巡检"));
        assert!(p.contains("定时雷达自动触发"));
        assert!(!p.contains("watchlist.md"));
        assert!(!p.contains("{skill}"));
    }
}
