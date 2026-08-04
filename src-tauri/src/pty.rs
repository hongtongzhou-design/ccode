use crate::agents;
use crate::profiles::{self, ProfileStore};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 输出合帧周期：每个 PTY 每 50ms 最多一个 IPC 事件
const FRAME: Duration = Duration::from_millis(50);
/// 隐藏标签的输出缓冲上限（1 MB）
const BACKLOG_CAP: usize = 1024 * 1024;
const TRUNC_MARK: &str = "[…输出过多已截断]\n";

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// 标签可见才推流；不可见时输出进 backlog（优化 2）
    visible: Arc<AtomicBool>,
    backlog: Arc<Mutex<Vec<u8>>>,
    /// 启动用途：归档工作区时只阻止仍在运行的 agent / run 脚本，普通 shell 可自动切回主仓库。
    purpose: PtyPurpose,
    /// 启动目录用于工作区生命周期保护；不用实时 cwd，避免 agent 子命令短暂切目录造成漏判。
    initial_cwd: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PtyPurpose {
    Agent,
    Shell,
    Script,
}

#[derive(Default, Clone)]
pub struct PtyManager {
    entries: Arc<Mutex<HashMap<String, PtyEntry>>>,
}

fn path_within(path: &str, root: &str) -> bool {
    let path = std::path::Path::new(path);
    let root = std::path::Path::new(root);
    path == root || path.starts_with(root)
}

impl PtyManager {
    /// 返回指定工作区里仍存活的 agent/run 脚本类型；普通登录 shell 不阻止归档。
    pub(crate) fn active_workspace_tasks(&self, worktree_path: &str) -> Vec<&'static str> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .filter(|entry| path_within(&entry.initial_cwd, worktree_path))
            .filter_map(|entry| match entry.purpose {
                PtyPurpose::Agent => Some("agent"),
                PtyPurpose::Script => Some("run 脚本"),
                PtyPurpose::Shell => None,
            })
            .collect()
    }
}

/// 从缓冲头部取出尽可能多的完整 UTF-8 文本，返回 (文本, 消耗字节数)。
/// 末尾残缺的多字节序列留给下一轮，避免把中文等字符切成乱码。
pub(crate) fn split_utf8(buf: &[u8]) -> (String, usize) {
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

/// 输出合帧（优化 1）：读取线程只负责 append，发送线程按帧合并发出。
/// 帧内唤醒会重新评估等待时长；距上次发送已满一帧则立即发（回显无延迟）。
struct FrameCoalescer {
    pending: Mutex<Vec<u8>>,
    cond: Condvar,
    done: AtomicBool,
}

impl FrameCoalescer {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            cond: Condvar::new(),
            done: AtomicBool::new(false),
        }
    }

    fn append(&self, bytes: &[u8]) {
        self.pending.lock().unwrap().extend_from_slice(bytes);
        self.cond.notify_one();
    }

    /// 输出流结束：最后一帧立即发，之后 take_frame 返回 None
    fn finish(&self) {
        self.done.store(true, Ordering::Relaxed);
        self.cond.notify_one();
    }

    /// 取下一帧文本；EOF 且缓冲清空后返回 None（发送线程据此退出）
    fn take_frame(&self, last_emit: Instant, frame: Duration) -> Option<(String, Instant)> {
        let mut pending = self.pending.lock().unwrap();
        loop {
            let done = self.done.load(Ordering::Relaxed);
            if pending.is_empty() {
                if done {
                    return None;
                }
                pending = self.cond.wait(pending).unwrap();
                continue;
            }
            let elapsed = last_emit.elapsed();
            if done || elapsed >= frame {
                let (text, used) = split_utf8(&pending);
                if used > 0 {
                    pending.drain(..used);
                    return Some((text, Instant::now()));
                }
                // 只剩残缺的 UTF-8 尾部：EOF 时按 lossy 全发，否则等更多数据
                if done {
                    let text = String::from_utf8_lossy(&pending).into_owned();
                    pending.clear();
                    return Some((text, Instant::now()));
                }
                pending = self.cond.wait(pending).unwrap();
                continue;
            }
            // 帧内：睡到帧尾再合并发；新数据唤醒会重算剩余时长
            let (guard, _) = self.cond.wait_timeout(pending, frame - elapsed).unwrap();
            pending = guard;
        }
    }
}

fn is_utf8_boundary(b: u8) -> bool {
    b < 0x80 || b >= 0xc0
}

/// 追加到 backlog；超上限时从头部按 UTF-8 边界丢弃，并加一次性截断标记
fn backlog_push(backlog: &mut Vec<u8>, bytes: &[u8]) {
    backlog.extend_from_slice(bytes);
    if backlog.len() > BACKLOG_CAP {
        let mut drop = backlog.len() - BACKLOG_CAP;
        while drop < backlog.len() && !is_utf8_boundary(backlog[drop]) {
            drop += 1;
        }
        backlog.drain(..drop);
        if !backlog.starts_with(TRUNC_MARK.as_bytes()) {
            let mut marked = TRUNC_MARK.as_bytes().to_vec();
            marked.extend_from_slice(backlog);
            *backlog = marked;
        }
    }
}

/// 补发 backlog 中完整的 UTF-8 前缀（残缺尾部留到下次）；空或无完整内容返回 None
fn drain_backlog(backlog: &mut Vec<u8>) -> Option<String> {
    let (text, used) = split_utf8(backlog);
    if used == 0 {
        return None;
    }
    let rest = backlog.split_off(used);
    *backlog = rest;
    Some(text)
}

/// 可见性门控发送（优化 2）：可见 → 先补发 backlog 再发本块；不可见 → 进 backlog。
/// 与 pty_set_visible 共用同一把 backlog 锁，保证补发严格先于实时块。
fn gated_emit(
    app: &AppHandle,
    event: &str,
    visible: &AtomicBool,
    backlog: &Mutex<Vec<u8>>,
    text: &str,
) {
    let mut bl = backlog.lock().unwrap();
    if visible.load(Ordering::Relaxed) {
        if let Some(back) = drain_backlog(&mut bl) {
            let _ = app.emit(event, back);
        }
        let _ = app.emit(event, text.to_string());
    } else {
        backlog_push(&mut bl, text.as_bytes());
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
    purpose: PtyPurpose,
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
    let visible = Arc::new(AtomicBool::new(false)); // 默认不可见：前端随即按标签状态标记
    let backlog = Arc::new(Mutex::new(Vec::new()));
    manager.entries.lock().unwrap().insert(
        pty_id.clone(),
        PtyEntry {
            writer,
            master: pair.master,
            child,
            visible: visible.clone(),
            backlog: backlog.clone(),
            purpose,
            initial_cwd: cwd.to_string(),
        },
    );

    let coalescer = Arc::new(FrameCoalescer::new());
    let out_event = format!("pty-output-{pty_id}");
    let exit_event = format!("pty-exit-{pty_id}");

    // 发送线程：按 50ms 帧合并发出（优化 1），经可见性门控（优化 2）
    let emitter = {
        let coalescer = coalescer.clone();
        let app = app.clone();
        let out_event = out_event.clone();
        std::thread::spawn(move || {
            let mut last_emit = Instant::now() - FRAME; // 首字节立即发
            while let Some((text, at)) = coalescer.take_frame(last_emit, FRAME) {
                gated_emit(&app, &out_event, &visible, &backlog, &text);
                last_emit = at;
            }
        })
    };

    let entries = manager.entries.clone();
    let id = pty_id.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        loop {
            let mut buf = [0u8; 8192];
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => coalescer.append(&buf[..n]),
                Err(_) => break,
            }
        }
        coalescer.finish();
        // 等发送线程把尾帧发完，再发退出事件，保证输出先于退出到达
        let _ = emitter.join();
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
    // 工作区端口段（CCODE_PORT 块）等附加 env：在 launch_plan env 之后、TERM 三元组之前注入
    extra_env: Option<HashMap<String, String>>,
    // 恢复已有会话（§6.12 A）：注入各 CLI 的恢复参数，跳过 --session-id，hint 直接锁定该会话
    resume_session_id: Option<String>,
    // 无固定 session id 的 agent 用终端标签 id 预登记关联声明，避免并发标签抢同一会话
    link_claim_id: Option<String>,
) -> Result<SpawnResult, String> {
    let profile = store.get(&profile_id)?;
    if profile.agent != agent_id {
        return Err("profile 与所选 agent 不匹配".into());
    }
    let binary = agents::binary_for(&agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在启动瞬间从钥匙串读出，注入子进程环境后即丢弃
    let key = profiles::get_key(&profile_id);
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().cloned());
    let plan = agents::launch_plan(&profile, key, model.as_deref());
    // 恢复模式：hint = 被恢复的会话；普通模式：claude/qwen 生成新 id 固定文件名
    let session_hint = match &resume_session_id {
        Some(sid) => Some(sid.clone()),
        None => session_id_for(&agent_id),
    };
    // 每-agent 启动前文件准备（codex：写模型 catalog，让 /model 选择器列出全部模型）
    let extra_args = agents::prepare_launch(&profile)?;

    let mut cmd = CommandBuilder::new(&binary_path);
    if let Some(sid) = &resume_session_id {
        let (prepend, args) = agents::resume_args(&agent_id, sid);
        if prepend {
            for arg in &args {
                cmd.arg(arg);
            }
        }
        for arg in &plan.args {
            cmd.arg(arg);
        }
        for arg in &extra_args {
            cmd.arg(arg);
        }
        if !prepend {
            for arg in &args {
                cmd.arg(arg);
            }
        }
    } else {
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
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    if let Some(extra) = &extra_env {
        for (k, v) in extra {
            cmd.env(k, v);
        }
    }
    let registered_claim = if session_hint.is_none() {
        link_claim_id.as_deref().map(|claim_id| {
            crate::sessions::register_session_claim(claim_id, &agent_id, &cwd);
            claim_id.to_string()
        })
    } else {
        None
    };
    let pty_id = match spawn_tracked(
        &app,
        manager.inner(),
        cmd,
        &expand_tilde(&cwd),
        PtyPurpose::Agent,
    ) {
        Ok(pty_id) => pty_id,
        Err(error) => {
            if let Some(claim_id) = registered_claim {
                crate::sessions::release_session_claim_impl(&claim_id);
            }
            return Err(error);
        }
    };
    crate::sessions::invalidate_scan_cache();
    store.touch_last_used(&profile_id);
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
    // 附加环境变量（如工作区 CCODE_PORT 段），run 脚本场景必须传入
    extra_env: Option<std::collections::HashMap<String, String>>,
    // script = 工作区 run 脚本；其他/缺省 = 普通登录 shell
    purpose: Option<String>,
) -> Result<String, String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    if let Some(env) = extra_env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let purpose = if purpose.as_deref() == Some("script") {
        PtyPurpose::Script
    } else {
        PtyPurpose::Shell
    };
    spawn_tracked(&app, manager.inner(), cmd, &expand_tilde(&cwd), purpose)
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

/// 进程的真实 cwd：macOS 走 lsof，Linux 读 /proc，Windows 无轻量途径返回 None
///（前端对 None 回落启动栏 cwd）
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|s| s.to_string()))
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

/// 活动 PTY 进程的真实工作目录（文件树/git 面板跟随 shell 内的 cd）
#[tauri::command]
pub fn pty_get_cwd(manager: tauri::State<'_, PtyManager>, pty_id: String) -> Option<String> {
    let mut entries = manager.entries.lock().unwrap();
    let entry = entries.get_mut(&pty_id)?;
    process_cwd(entry.child.process_id()?)
}

/// 标记标签可见性（优化 2）：翻转为可见时在同一把 backlog 锁内补发积压输出，
/// 与发送线程的 gated_emit 互斥，保证补发严格先于之后的实时输出
#[tauri::command]
pub fn pty_set_visible(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    visible: bool,
) -> Result<(), String> {
    let entries = manager.entries.lock().unwrap();
    let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
    if visible {
        let mut bl = entry.backlog.lock().unwrap();
        entry.visible.store(true, Ordering::Relaxed);
        if let Some(text) = drain_backlog(&mut bl) {
            let _ = app.emit(&format!("pty-output-{pty_id}"), text);
        }
    } else {
        entry.visible.store(false, Ordering::Relaxed);
    }
    Ok(())
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
    fn workspace_path_matching_is_segment_safe() {
        assert!(path_within("/repo/task", "/repo/task"));
        assert!(path_within("/repo/task/src", "/repo/task"));
        assert!(!path_within("/repo/task-two", "/repo/task"));
    }

    #[cfg(unix)]
    #[test]
    fn process_cwd_reads_own_process() {
        // lsof//proc 读自己进程的 cwd，与 current_dir 一致（canonicalize 归一化）
        let got = process_cwd(std::process::id()).expect("应能读取本进程 cwd");
        let expect = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(std::path::Path::new(&got).canonicalize().unwrap(), expect);
    }

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
            assert!(
                session_id_for(agent).is_none(),
                "{agent} 不支持 --session-id"
            );
        }
    }

    // ===== 优化 1：输出合帧 =====

    #[test]
    fn coalescer_emits_immediately_when_idle() {
        let c = FrameCoalescer::new();
        c.append(b"a");
        let frame = Duration::from_millis(40);
        let last = Instant::now() - Duration::from_secs(1);
        let start = Instant::now();
        let (text, _) = c.take_frame(last, frame).unwrap();
        assert_eq!(text, "a");
        // 语义断言：超过截止时间应立即返回（不阻塞到帧尾）。
        // CI 慢节点上线程调度延迟不可控，时序上界只做防挂死的宽松兜底
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "空闲后发送疑似阻塞"
        );
    }

    #[test]
    fn coalescer_merges_within_frame_and_flushes_tail() {
        let c = FrameCoalescer::new();
        let frame = Duration::from_millis(40);
        c.append(b"burst-1;");
        let (_, at) = c
            .take_frame(Instant::now() - Duration::from_secs(1), frame)
            .unwrap();
        // 帧内连续到达：应等待到帧尾合并发出
        c.append(b"burst-2;");
        c.append(b"burst-3");
        let (text, _) = c.take_frame(at, frame).unwrap();
        assert_eq!(text, "burst-2;burst-3");
        // 合帧语义由内容断言保证（burst-2/3 被合并成一帧发出）；
        // CI 慢节点线程调度延迟可达数百 ms，任何时序上下界硬断言都会偶发失败，不做
        // 尾部无新数据：下一帧也应正常发出
        c.append(b"tail");
        let (text, _) = c.take_frame(Instant::now(), frame).unwrap();
        assert_eq!(text, "tail");
    }

    #[test]
    fn coalescer_finish_flushes_then_returns_none() {
        let c = FrameCoalescer::new();
        c.append("中文结尾".as_bytes());
        c.finish();
        let (text, _) = c
            .take_frame(Instant::now(), Duration::from_millis(40))
            .expect("EOF 应立即 flush，不等帧");
        assert_eq!(text, "中文结尾");
        assert!(c
            .take_frame(Instant::now(), Duration::from_millis(40))
            .is_none());
    }

    // ===== 优化 2：隐藏标签缓冲 =====

    #[test]
    fn backlog_cap_truncates_on_utf8_boundary_with_marker() {
        let mut bl = Vec::new();
        // 反复推入含多字节字符的内容直到超限
        let chunk = "数据块-中文-".repeat(1000);
        while bl.len() <= BACKLOG_CAP {
            backlog_push(&mut bl, chunk.as_bytes());
        }
        assert!(bl.len() <= BACKLOG_CAP + TRUNC_MARK.len());
        assert!(bl.starts_with(TRUNC_MARK.as_bytes()), "应有截断标记");
        // 去掉标记后必须是合法 UTF-8（从字符边界截断）
        let body = &bl[TRUNC_MARK.len()..];
        assert!(std::str::from_utf8(body).is_ok(), "截断后必须是合法 UTF-8");
    }

    #[test]
    fn visibility_flip_drains_backlog_before_live_emit() {
        // 模拟：隐藏期积压 → 翻转为可见（pty_set_visible 的锁内补发）→ 实时块
        let visible = AtomicBool::new(false);
        let mut bl: Vec<u8> = Vec::new();
        // 隐藏期：两块输出进 backlog（含末尾残缺多字节，应留到下次）
        backlog_push(&mut bl, "hidden-中".as_bytes());
        backlog_push(&mut bl, "文".as_bytes()[..2].as_ref());
        assert!(!visible.load(Ordering::Relaxed));
        // 翻转为可见：先置 flag 再补发（与命令同序）
        visible.store(true, Ordering::Relaxed);
        let drained = drain_backlog(&mut bl);
        assert_eq!(drained.as_deref(), Some("hidden-中"));
        // 残缺尾部（"文" 的前 2 字节）仍在 backlog，等补齐后随下一块发出
        assert!(!bl.is_empty());
        backlog_push(&mut bl, "文".as_bytes()[2..].as_ref());
        backlog_push(&mut bl, b"-live");
        let drained2 = drain_backlog(&mut bl);
        assert_eq!(drained2.as_deref(), Some("文-live"));
        assert!(bl.is_empty());
    }
}
