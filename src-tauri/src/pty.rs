use crate::agents;
use crate::profiles::{self, ProfileStore};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 输出合帧周期：每个 PTY 每 16ms 最多一个 IPC 事件。
/// 从 50ms 收紧到 16ms（约一帧屏幕刷新）：TUI 高频小块场景下等待窗口更短，
/// 既减少 IPC 事件数又不让回显有可感延迟
const FRAME: Duration = Duration::from_millis(16);
/// 隐藏标签的输出缓冲上限（1 MB）
const BACKLOG_CAP: usize = 1024 * 1024;
/// 可见时合帧缓冲上限（256 KB）：超限无视帧周期立即 flush。
/// 从 4 MB 收紧：高速输出下更早 flush，pending 不会在大块场景里堆到 MB 级
const PENDING_CAP: usize = 256 * 1024;
const TRUNC_MARK: &str = "[…输出过多已截断]\n";
/// 子进程开启 bracketed paste 模式（DECSET 2004）时输出的序列
const BRACKETED_PASTE_ON: &[u8] = b"\x1b[?2004h";

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// 标签可见才推流；不可见时输出进 backlog（优化 2）
    visible: Arc<AtomicBool>,
    backlog: Arc<Mutex<Vec<u8>>>,
    /// 子进程是否开过 bracketed paste（输出里出现过 ESC[?2004h，粘性置位）；
    /// pty_write 据此决定是否给多行输入手工包裹粘贴序列
    bracketed_paste: Arc<AtomicBool>,
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
            if done || elapsed >= frame || pending.len() >= PENDING_CAP {
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

/// 在子进程输出中扫描 bracketed paste 开启序列（ESC[?2004h）。
/// tail 保存上一块末尾的 N-1 字节，防止序列恰好跨读取块被漏检。
/// 返回 true 表示本块（含跨界）出现了开启序列。
fn scan_bracketed_paste_on(tail: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let mut hay = std::mem::take(tail);
    hay.extend_from_slice(chunk);
    let found = hay
        .windows(BRACKETED_PASTE_ON.len())
        .any(|w| w == BRACKETED_PASTE_ON);
    if !found {
        let keep = BRACKETED_PASTE_ON.len() - 1;
        let start = hay.len().saturating_sub(keep);
        *tail = hay[start..].to_vec();
    }
    found
}

/// 多行输入在子进程已开 bracketed paste 时包裹为一次粘贴（ESC[200~ … ESC[201~），
/// 避免多行被目标程序逐行提交；单行输入或未开粘贴模式时原样返回——
/// 未开 2004 的程序会把控制序列原样显示出来，绝不能包裹
fn wrap_bracketed_paste(data: &str, paste_mode_on: bool) -> std::borrow::Cow<'_, str> {
    if paste_mode_on && data.contains('\n') {
        format!("\x1b[200~{data}\x1b[201~").into()
    } else {
        data.into()
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
    /// 初始 prompt 因 CLI 不支持注入被丢弃（前端提示用户手动发送）
    pub prompt_dropped: bool,
}

/// 支持 --session-id <uuid> 的 agent（AgentSpec.fixed_session_id；matrix：claude-code、qwen、codebuddy），
/// 会话文件名可预测
fn session_id_for(agent_id: &str) -> Option<String> {
    crate::agent_specs::agent_spec(agent_id)
        .filter(|s| s.fixed_session_id)
        .map(|_| uuid::Uuid::new_v4().to_string())
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

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动进程失败: {e}"))?;
    // spawn 已成功：后续任一步失败都必须先杀子进程，否则它脱离管理器成为孤儿
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("读取 PTY 失败: {e}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("写入 PTY 失败: {e}"));
        }
    };

    let pty_id = uuid::Uuid::new_v4().to_string();
    let visible = Arc::new(AtomicBool::new(false)); // 默认不可见：前端随即按标签状态标记
    let backlog = Arc::new(Mutex::new(Vec::new()));
    let bracketed_paste = Arc::new(AtomicBool::new(false));
    manager.entries.lock().unwrap().insert(
        pty_id.clone(),
        PtyEntry {
            writer,
            master: pair.master,
            child,
            visible: visible.clone(),
            backlog: backlog.clone(),
            bracketed_paste: bracketed_paste.clone(),
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
        // bracketed paste 检测的跨块尾部（序列可能恰好被 8KB 读取边界切开）
        let mut scan_tail: Vec<u8> = Vec::new();
        loop {
            let mut buf = [0u8; 8192];
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 粘性检测：一旦见过 ESC[?2004h 就记住，pty_write 据此包裹多行粘贴
                    if !bracketed_paste.load(Ordering::Relaxed)
                        && scan_bracketed_paste_on(&mut scan_tail, &buf[..n])
                    {
                        bracketed_paste.store(true, Ordering::Relaxed);
                    }
                    coalescer.append(&buf[..n]);
                }
                Err(_) => break,
            }
        }
        coalescer.finish();
        // 等发送线程把尾帧发完，再发退出事件，保证输出先于退出到达
        let _ = emitter.join();
        // 输出流结束视为进程结束；谁先移除 entry 谁负责回收并发退出事件
        let entry = entries.lock().unwrap().remove(&id);
        if let Some(mut entry) = entry {
            // wait 失败按异常退出（-1）上报，不误报正常退出
            let code = entry.child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
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
    // 初始 prompt（一键开步首条指令）：按注册表形态注入 args；仅全新会话生效，恢复会话不注入
    initial_prompt: Option<String>,
    // 无固定 session id 的 agent 用终端标签 id 预登记关联声明，避免并发标签抢同一会话
    link_claim_id: Option<String>,
    // 「聊想法」只读模式：对支持的 CLI 注入注册表 readonly_args（仅全新会话生效）
    readonly: Option<bool>,
) -> Result<SpawnResult, String> {
    let profile = store.get(&profile_id)?;
    if profile.agent != agent_id {
        return Err("profile 与所选 agent 不匹配".into());
    }
    let binary = agents::binary_for(&agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在启动瞬间从钥匙串读出，注入子进程环境后即丢弃；keys.json 损坏时报错阻断启动
    let key = profiles::get_key(&profile_id)?;
    agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().cloned());
    // 恢复会话不注入初始 prompt（那是既有会话的延续，不是开步）
    let prompt = match &resume_session_id {
        Some(_) => None,
        None => initial_prompt.as_deref(),
    };
    let plan = agents::launch_plan_with_prompt(&profile, key, model.as_deref(), prompt);
    // 恢复模式：hint = 被恢复的会话；普通模式：claude/qwen 生成新 id 固定文件名
    let session_hint = match &resume_session_id {
        Some(sid) => Some(sid.clone()),
        None => session_id_for(&agent_id),
    };
    // 每-agent 启动前文件准备（codex：写模型 catalog，让 /model 选择器列出全部模型）
    let extra_args = agents::prepare_launch(&profile)?;
    // 聊想法只读模式（仅全新会话）：支持的 CLI 替换/追加只读参数；不支持的原样（软约束兜底）
    let plan_args = if readonly.unwrap_or(false) && resume_session_id.is_none() {
        agents::readonly_launch_args(&agent_id, &plan.args).unwrap_or_else(|| plan.args.clone())
    } else {
        plan.args.clone()
    };

    let mut command_args = Vec::new();
    if let Some(sid) = &resume_session_id {
        let (prepend, args) = agents::resume_args(&agent_id, sid);
        if prepend {
            command_args.extend(args.iter().cloned());
        }
        command_args.extend(plan_args.iter().cloned());
        command_args.extend(extra_args.iter().cloned());
        if !prepend {
            command_args.extend(args.iter().cloned());
        }
    } else {
        command_args.extend(plan_args.iter().cloned());
        command_args.extend(extra_args.iter().cloned());
        // 确定性关联：会话文件名 = 该 uuid，启动即锁定（architecture §6.7）
        if let Some(sid) = &session_hint {
            command_args.push("--session-id".into());
            command_args.push(sid.clone());
        }
        // 初始 prompt 放最后：位置参数形态（claude/codex）必须是命令行最后一个参数
        for arg in &plan.prompt_args {
            command_args.push(arg.clone());
        }
    }
    let mut cmd = crate::process::pty_command(&binary_path, &command_args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    // 官方账号模式：剔除继承环境里的残留 API 密钥变量（防静默覆盖账号登录）
    for k in &plan.env_remove {
        cmd.env_remove(k);
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
    // 官方账号（订阅制）启动：登记 usage provenance，统计页费用栏据此显示「订阅」。
    // 尽力而为：登记失败不阻断启动（与 touch_last_used 同语义）
    if profile.account_type == profiles::AccountType::Official {
        let _ = crate::usage::register_official_launch(&agent_id, std::path::Path::new(&cwd));
    }
    crate::sessions::invalidate_scan_cache();
    store.touch_last_used(&profile_id);
    Ok(SpawnResult {
        pty_id,
        session_hint,
        prompt_dropped: plan.prompt_dropped,
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
    let paste_on = entry.bracketed_paste.load(Ordering::Relaxed);
    let data = wrap_bracketed_paste(&data, paste_on);
    entry
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| entry.writer.flush())
        .map_err(|e| format!("写入终端失败: {e}"))
}

/// 将一条聊天消息和提交键在同一把 PTY 锁内连续写入。
/// 文本仍遵守 bracketed-paste 规则，提交键在粘贴包结束后单独写入，
/// 避免前端两个 IPC 调用之间被 TUI 切帧，也避免多行消息把回车吞进粘贴文本。
#[tauri::command]
pub async fn pty_write_submit(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    text: String,
    submit: String,
) -> Result<(), String> {
    let entries = manager.entries.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 正文与提交键分两次写、中间留 60ms：开了 bracketed paste 的 TUI 要把粘贴内容
        // 收进输入框后才认得回车，背靠背写入时回车会被吞掉（消息躺在输入框里没发出去）
        {
            let mut entries = entries.lock().unwrap();
            let entry = entries.get_mut(&pty_id).ok_or("终端不存在或已退出")?;
            let paste_on = entry.bracketed_paste.load(Ordering::Relaxed);
            let text = wrap_bracketed_paste(&text, paste_on);
            entry
                .writer
                .write_all(text.as_bytes())
                .and_then(|_| entry.writer.flush())
                .map_err(|e| format!("写入终端失败: {e}"))?;
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut entries = entries.lock().unwrap();
        let entry = entries.get_mut(&pty_id).ok_or("终端不存在或已退出")?;
        entry
            .writer
            .write_all(submit.as_bytes())
            .and_then(|_| entry.writer.flush())
            .map_err(|e| format!("写入终端失败: {e}"))
    })
    .await
    .map_err(|e| format!("写入终端失败: {e}"))?
}

/// 关窗守卫用：PTY 在管且子进程尚未退出才为 true。
/// try_wait 是非阻塞探测（unix 走 waitpid WNOHANG，Windows 查进程退出码），
/// 已退出时会顺带回收并缓存退出状态，不影响清理路径再 wait 取真实退出码；
/// 探测本身出错按「未在运行」处理（entry 缺失/进程已回收等边界都归到 false）
#[tauri::command]
pub fn pty_has_running_process(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
) -> bool {
    has_running_process(manager.inner(), &pty_id)
}

fn has_running_process(manager: &PtyManager, pty_id: &str) -> bool {
    let mut entries = manager.entries.lock().unwrap();
    match entries.get_mut(pty_id) {
        Some(entry) => child_running(entry.child.as_mut()),
        None => false,
    }
}

/// 子进程仍在运行 = 非阻塞 try_wait 尚未取到退出状态（探测出错按未运行处理）
fn child_running(child: &mut (dyn Child + Send + Sync)) -> bool {
    matches!(child.try_wait(), Ok(None))
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

/// unix 下终止子进程的整个进程组：portable-pty spawn 时子进程已 setsid
///（pid == pgid），kill 负 pgid 连带杀掉 agent 拉起的子孙。只杀直接子进程
/// 会让持有 PTY slave 的子孙成孤儿，reader 线程永远等不到 EOF。
/// Windows（ConPTY）无进程组语义，保持 child.kill() 原路径。
/// 已知边角：交互 shell 的作业控制会把每个作业放进新进程组，不在此覆盖——
/// entry 随本函数 drop 时 master 关闭，内核会向 slave 前台进程组发 SIGHUP 兜底。
#[cfg(unix)]
pub(crate) fn kill_process_group(pid: u32) {
    // 用 /bin/kill 绝对路径：打包版 GUI 的 PATH 很短；负 pid 表示整个进程组
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", &format!("-{pid}")])
        .status();
}

#[tauri::command]
pub fn pty_kill(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
) -> Result<(), String> {
    let entry = manager.entries.lock().unwrap().remove(&pty_id);
    if let Some(mut entry) = entry {
        #[cfg(unix)]
        if let Some(pid) = entry.child.process_id() {
            kill_process_group(pid);
        }
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
    fn session_id_only_for_claude_qwen_and_codebuddy() {
        for agent in ["claude-code", "qwen", "codebuddy"] {
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
    fn coalescer_flushes_immediately_when_pending_exceeds_cap() {
        // 帧远未到期时超限也必须立即 flush（防止高速输出下 pending 无限增长）。
        // 用 1 小时的帧周期：若无超限路径，take_frame 会睡到帧尾（测试由 10s 兜底判负）
        let c = Arc::new(FrameCoalescer::new());
        let big = vec![b'a'; PENDING_CAP + 1];
        c.append(&big);
        let c2 = c.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let got = c2.take_frame(Instant::now(), Duration::from_secs(3600));
            let _ = tx.send(got);
        });
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Some((text, _))) => assert_eq!(text.len(), PENDING_CAP + 1),
            other => {
                // 唤醒被卡住的线程再判负，避免泄漏一个睡在 condvar 上的线程
                c.finish();
                let _ = handle.join();
                panic!("超限未触发立即 flush: {other:?}");
            }
        }
        handle.join().unwrap();
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

    // ===== bracketed paste 手工包裹 =====

    #[test]
    fn bracketed_paste_scan_detects_across_chunk_boundary() {
        let mut tail = Vec::new();
        // 普通输出不命中
        assert!(!scan_bracketed_paste_on(&mut tail, b"hello \x1b[1mworld"));
        // 序列跨两块切开也应命中
        assert!(!scan_bracketed_paste_on(&mut tail, b"prompt \x1b[?20"));
        assert!(scan_bracketed_paste_on(&mut tail, b"04h rest"));
    }

    #[test]
    fn wrap_bracketed_paste_only_multiline_and_only_when_on() {
        // 已开 2004 + 多行 → 包裹
        let wrapped = wrap_bracketed_paste("line1\nline2", true);
        assert_eq!(wrapped, "\x1b[200~line1\nline2\x1b[201~");
        // 未开 2004 → 原样直写（否则控制序列会被原样显示）
        assert_eq!(wrap_bracketed_paste("line1\nline2", false), "line1\nline2");
        // 单行 → 行为不变，即使已开 2004 也不包裹
        assert_eq!(wrap_bracketed_paste("one-liner", true), "one-liner");
    }

    // ===== 输出批处理调优（16ms 帧 / 256KB cap） =====

    #[test]
    fn coalescer_tuning_constants() {
        // 固化调优目标：高频小块更早合帧、大块更早 flush
        assert_eq!(FRAME, Duration::from_millis(16));
        assert_eq!(PENDING_CAP, 256 * 1024);
    }

    #[test]
    fn coalescer_merges_small_burst_into_one_frame() {
        // 帧窗口内到达的多个小块必须合并成一个事件（减少 TUI 高频输出的 IPC 事件数）
        let c = FrameCoalescer::new();
        c.append(b"chunk-1;");
        c.append(b"chunk-2;");
        c.append(b"chunk-3");
        let (text, _) = c
            .take_frame(Instant::now(), FRAME)
            .expect("帧内应合并发出");
        assert_eq!(text, "chunk-1;chunk-2;chunk-3");
    }

    // ===== 进程存活检查 =====

    #[test]
    fn has_running_process_false_for_unknown_pty() {
        assert!(!has_running_process(&PtyManager::default(), "no-such-pty"));
    }

    #[cfg(unix)]
    #[test]
    fn child_running_tracks_lifecycle() {
        use portable_pty::Child as _;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("应能启动 sleep");
        assert!(child_running(&mut child), "运行中应判 true");
        child.kill().expect("应能 kill");
        // 退出判定靠轮询等待（禁墙钟硬断言）：宽松上限内终应判 false
        let deadline = Instant::now() + Duration::from_secs(10);
        while child_running(&mut child) {
            assert!(Instant::now() < deadline, "kill 后 10s 内应判定退出");
            std::thread::sleep(Duration::from_millis(20));
        }
        // 退出状态被缓存：再次探测仍为 false，且 wait 能取到真实状态
        assert!(!child_running(&mut child));
        assert!(child.try_wait().unwrap().is_some());
    }
}
