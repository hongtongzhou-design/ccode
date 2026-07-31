use crate::agents;
use crate::profiles::{self, ProfileStore};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    entries: Arc<Mutex<HashMap<String, PtyEntry>>>,
}

/// 从缓冲头部取出尽可能多的完整 UTF-8 文本，返回 (文本, 消耗字节数)。
/// 末尾残缺的多字节序列留给下一轮，避免把中文等字符切成乱码。
fn split_utf8(buf: &[u8]) -> (String, usize) {
    match std::str::from_utf8(buf) {
        Ok(_) => (String::from_utf8_lossy(buf).into_owned(), buf.len()),
        Err(e) => {
            let valid = e.valid_up_to();
            if valid > 0 {
                (String::from_utf8_lossy(&buf[..valid]).into_owned(), valid)
            } else if let Some(len) = e.error_len() {
                (String::from_utf8_lossy(&buf[..len]).into_owned(), len)
            } else {
                (String::new(), 0)
            }
        }
    }
}

fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

/// pty_spawn 的返回：session_hint 是启动时通过 --session-id 固定的会话 ID，
/// 前端用它把终端标签和落盘的会话文件关联起来（无此能力的 agent 为 None）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub pty_id: String,
    pub session_hint: Option<String>,
}

/// 支持 --session-id <uuid> 的 agent（matrix：claude-code、qwen），会话文件名可预测
fn session_id_for(agent_id: &str) -> Option<String> {
    match agent_id {
        "claude-code" | "qwen" => Some(uuid::Uuid::new_v4().to_string()),
        _ => None,
    }
}

/// 在 PTY 中拉起进程并登记到管理器，输出/退出通过 `pty-output-<id>` / `pty-exit-<id>` 事件推送。
fn spawn_tracked(
    app: &AppHandle,
    manager: &PtyManager,
    mut cmd: CommandBuilder,
    cwd: &str,
) -> Result<String, String> {
    // 声明现代终端能力：缺少这些时 CLI 会按哑终端处理，输出退化为黑白
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Ccode");
    cmd.env_remove("TERM_PROGRAM_VERSION"); // 避免继承到宿主终端的版本号
    // NO_COLOR 只要存在就会强制 CLI 关闭彩色，优先级高于 TERM/COLORTERM，必须剔除
    cmd.env_remove("NO_COLOR");
    cmd.cwd(cwd);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建 PTY 失败: {e}"))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动进程失败: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("读取 PTY 失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("写入 PTY 失败: {e}"))?;

    let pty_id = uuid::Uuid::new_v4().to_string();
    manager.entries.lock().unwrap().insert(
        pty_id.clone(),
        PtyEntry {
            writer,
            master: pair.master,
            child,
        },
    );

    let entries = manager.entries.clone();
    let id = pty_id.clone();
    let app = app.clone();
    let out_event = format!("pty-output-{pty_id}");
    let exit_event = format!("pty-exit-{pty_id}");
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let mut buf = [0u8; 8192];
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let (text, used) = split_utf8(&pending);
                    if used > 0 {
                        let _ = app.emit(&out_event, text);
                        pending.drain(..used);
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let _ = app.emit(&out_event, String::from_utf8_lossy(&pending).into_owned());
        }
        // 输出流结束视为进程结束；谁先移除 entry 谁负责回收并发退出事件
        let entry = entries.lock().unwrap().remove(&id);
        if let Some(mut entry) = entry {
            let code = entry.child.wait().map(|s| s.exit_code()).unwrap_or(0);
            let _ = app.emit(&exit_event, code);
        }
    });

    Ok(pty_id)
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    store: tauri::State<'_, ProfileStore>,
    agent_id: String,
    profile_id: String,
    cwd: String,
    // 启动时选中的模型；None 时取 profile 模型列表的首个
    model: Option<String>,
) -> Result<SpawnResult, String> {
    let profile = store.get(&profile_id)?;
    if profile.agent != agent_id {
        return Err("profile 与所选 agent 不匹配".into());
    }
    let binary = agents::binary_for(&agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let binary_path = which::which(binary).map_err(|_| format!("未在 PATH 找到 {binary}"))?;
    // 密钥只在启动瞬间从钥匙串读出，注入子进程环境后即丢弃
    let key = profiles::get_key(&profile_id);
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().cloned());
    let plan = agents::launch_plan(&profile, key, model.as_deref());
    let session_hint = session_id_for(&agent_id);
    // 每-agent 启动前文件准备（codex：写模型 catalog，让 /model 选择器列出全部模型）
    let extra_args = agents::prepare_launch(&profile)?;

    let mut cmd = CommandBuilder::new(&binary_path);
    for arg in &plan.args {
        cmd.arg(arg);
    }
    for arg in &extra_args {
        cmd.arg(arg);
    }
    // 确定性关联：会话文件名 = 该 uuid，启动即锁定（architecture §6.7）
    if let Some(sid) = &session_hint {
        cmd.arg("--session-id");
        cmd.arg(sid);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let pty_id = spawn_tracked(&app, manager.inner(), cmd, &expand_tilde(&cwd))?;
    Ok(SpawnResult {
        pty_id,
        session_hint,
    })
}

/// 拉起用户的登录 shell，供 agent 退出后回落或纯终端使用。
#[tauri::command]
pub fn shell_spawn(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
) -> Result<String, String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    spawn_tracked(&app, manager.inner(), cmd, &expand_tilde(&cwd))
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    let mut entries = manager.entries.lock().unwrap();
    let entry = entries.get_mut(&pty_id).ok_or("终端不存在或已退出")?;
    entry
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| entry.writer.flush())
        .map_err(|e| format!("写入终端失败: {e}"))
}

#[tauri::command]
pub fn pty_resize(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let entries = manager.entries.lock().unwrap();
    let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
    entry
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

#[tauri::command]
pub fn pty_kill(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
) -> Result<(), String> {
    let entry = manager.entries.lock().unwrap().remove(&pty_id);
    if let Some(mut entry) = entry {
        let _ = entry.child.kill();
        let _ = entry.child.wait();
        let _ = app.emit(&format!("pty-exit-{pty_id}"), -1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_utf8_keeps_incomplete_multibyte_tail() {
        let (text, used) = split_utf8("中".as_bytes());
        assert_eq!(text, "中");
        assert_eq!(used, 3);
        let (text, used) = split_utf8(&"中".as_bytes()[..2]);
        assert_eq!(text, "");
        assert_eq!(used, 0);
    }

    #[test]
    fn expand_tilde_resolves_home() {
        let expanded = expand_tilde("~/work");
        assert!(!expanded.starts_with('~'));
        assert!(expanded.ends_with("/work"));
    }

    #[test]
    fn session_id_only_for_claude_and_qwen() {
        for agent in ["claude-code", "qwen"] {
            let id = session_id_for(agent).expect("应生成会话 ID");
            assert!(uuid::Uuid::parse_str(&id).is_ok(), "会话 ID 应为 uuid");
        }
        for agent in ["codex", "gemini", "opencode", "kimi", "unknown"] {
            assert!(session_id_for(agent).is_none(), "{agent} 不支持 --session-id");
        }
    }
}
