// 诊断日志：进程内环形缓冲（不落盘），供设置页「诊断」分区查看
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use crate::sessions::now_iso;

const CAP: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryDto {
    pub ts: String,
    pub level: String, // info | warn | error
    pub source: String,
    pub message: String,
}

fn buf() -> &'static Mutex<VecDeque<LogEntryDto>> {
    static BUF: OnceLock<Mutex<VecDeque<LogEntryDto>>> = OnceLock::new();
    BUF.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP)))
}

/// 追加一条日志；level 归一化为 info/warn/error，超长消息截断防刷屏
pub fn record(level: &str, source: &str, message: &str) {
    let level = match level {
        "warn" | "error" => level,
        _ => "info",
    };
    let message: String = message.chars().take(2000).collect();
    let entry = LogEntryDto {
        ts: now_iso(),
        level: level.into(),
        source: source.into(),
        message,
    };
    if let Ok(mut q) = buf().lock() {
        if q.len() >= CAP {
            q.pop_front();
        }
        q.push_back(entry);
    }
}

#[tauri::command]
pub fn get_app_log(limit: usize) -> Vec<LogEntryDto> {
    let q = match buf().lock() {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };
    let limit = limit.min(CAP);
    q.iter().skip(q.len().saturating_sub(limit)).cloned().collect()
}

#[tauri::command]
pub fn clear_app_log() {
    if let Ok(mut q) = buf().lock() {
        q.clear();
    }
}

/// 前端上报入口（window.onerror / unhandledrejection）
#[tauri::command]
pub fn log_event(level: String, source: String, message: String) {
    record(&level, &source, &message);
}

#[cfg(test)]
mod tests {
    use super::*;

    // 缓冲是全局单例，相关断言合并到一个测试里串行跑，避免并行互相干扰
    #[test]
    fn ring_buffer_caps_normalizes_and_truncates() {
        clear_app_log();
        for i in 0..(CAP + 20) {
            record("info", "test", &format!("m{i}"));
        }
        let all = get_app_log(CAP);
        assert_eq!(all.len(), CAP, "超过容量时只留最新 {CAP} 条");
        assert_eq!(all[0].message, "m20");
        assert_eq!(all[all.len() - 1].message, format!("m{}", CAP + 19));
        // limit 取最近 N 条
        let last3 = get_app_log(3);
        assert_eq!(last3.len(), 3);
        assert_eq!(last3[2].message, format!("m{}", CAP + 19));

        // 未知级别归一为 info；超长消息截断
        clear_app_log();
        record("debug", "test", "x");
        record("error", "test", &"y".repeat(5000));
        let all = get_app_log(10);
        assert_eq!(all[0].level, "info");
        assert_eq!(all[1].level, "error");
        assert_eq!(all[1].message.chars().count(), 2000);

        clear_app_log();
        assert!(get_app_log(CAP).is_empty());
    }
}
