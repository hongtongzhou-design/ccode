//! 各 agent CLI 的升级：按安装方式（从二进制真实路径推断）选包管理器命令，
//! 否则用 CLI 自更新命令；命令在 PTY 里跑（brew/curl 对管道会块缓冲，接 PTY 才
//! 有实时输出），spawn_blocking + 参数数组（无 shell），900 秒超时。

use crate::agents;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// 慢网络下 brew/npm 下载可能远超 5 分钟，给 15 分钟
const TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResultDto {
    pub ok: bool,
    pub output: String,
    pub method: String,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
}

/// 安装方式：从二进制真实路径（已解符号链接）推断。
/// Caskroom/Cellar 是 brew 包的实体目录，优先判断——brew formula（如 gemini-cli）
/// 内部也带 node_modules，不能被 npm 规则抢走；homebrew prefix 下的 npm 全局包
/// （/opt/homebrew/lib/node_modules）仍命中 npm 规则
fn detect_method(resolved_path: &str) -> &'static str {
    if resolved_path.contains("Caskroom") || resolved_path.contains("Cellar") {
        "brew"
    } else if resolved_path.contains("node_modules") {
        "npm"
    } else if resolved_path.to_lowercase().contains("homebrew") {
        "brew"
    } else if resolved_path.contains("uv/tools") || resolved_path.contains(".local/share/uv") {
        "uv"
    } else {
        "self"
    }
}

struct UpdateCmd {
    method: &'static str,
    program: String,
    args: Vec<String>,
}

fn cmd(method: &'static str, program: String, args: &[&str]) -> UpdateCmd {
    UpdateCmd {
        method,
        program,
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// 升级命令候选（按序尝试，首个成功即止）。
/// 有对应包管理器路径时优先包管理器，否则用 CLI 自更新
fn update_commands(agent_id: &str, method: &str, binary_path: &str) -> Vec<UpdateCmd> {
    let npm = |pkg: &str| cmd("npm", "npm".into(), &["install", "-g", &format!("{pkg}@latest")]);
    let bin = || binary_path.to_string();
    match (agent_id, method) {
        ("claude-code", "brew") => vec![cmd("brew", "brew".into(), &["upgrade", "--cask", "claude-code"])],
        ("claude-code", _) => vec![
            cmd("self", bin(), &["update"]),
            cmd("brew", "brew".into(), &["upgrade", "--cask", "claude-code"]),
        ],
        ("codex", "brew") => vec![cmd("brew", "brew".into(), &["upgrade", "--cask", "codex"])],
        ("codex", _) => vec![npm("@openai/codex")],
        ("gemini", "brew") => vec![cmd("brew", "brew".into(), &["upgrade", "gemini-cli"])],
        ("gemini", _) => vec![npm("@google/gemini-cli")],
        ("qwen", "brew") => vec![cmd("brew", "brew".into(), &["upgrade", "qwen-code"])],
        ("qwen", _) => vec![npm("@qwen-code/qwen-code")],
        ("opencode", "npm") => vec![npm("opencode-ai")],
        ("opencode", _) => vec![
            cmd("self", bin(), &["upgrade"]),
            npm("opencode-ai"),
        ],
        ("kimi", "uv") => vec![cmd("uv", "uv".into(), &["tool", "upgrade", "kimi-cli"])],
        ("kimi", _) => match agents::kimi_variant() {
            Some("legacy") => vec![cmd("uv", "uv".into(), &["tool", "upgrade", "kimi-cli"])],
            // 新版（或探测不到目录时按新版处理）走自更新
            _ => vec![cmd("self", bin(), &["upgrade"])],
        },
        _ => vec![],
    }
}

fn version_of(binary: &std::path::Path) -> Option<String> {
    let out = Command::new(binary).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.lines().next().unwrap_or("").to_string())
    }
}

/// stdout+stderr 合并取尾部 ~30 行
fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.trim_end().lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first < 0xe0 {
        2
    } else if first < 0xf0 {
        3
    } else {
        4
    }
}

/// 进行中的 run 的 PTY 写入端（每 agent 同时最多一个 run；前端经 updater_write 交互，
/// 例如回答 brew 的 [y/n] 确认）。run 结束（成功/超时/出错）时务必移除。
static UPDATER_WRITERS: OnceLock<Mutex<HashMap<String, Box<dyn Write + Send>>>> = OnceLock::new();

fn writers() -> &'static Mutex<HashMap<String, Box<dyn Write + Send>>> {
    UPDATER_WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 移除哨兵：无论 run_streaming_pty 从哪条路径返回，writer 都会从 map 里清掉
struct WriterGuard(String);

impl Drop for WriterGuard {
    fn drop(&mut self) {
        writers().lock().unwrap().remove(&self.0);
    }
}

#[tauri::command]
pub fn updater_write(agent_id: String, data: String) -> Result<(), String> {
    let mut map = writers().lock().unwrap();
    let w = map
        .get_mut(&agent_id)
        .ok_or("该 agent 没有正在运行的安装/更新")?;
    w.write_all(data.as_bytes())
        .and_then(|_| w.flush())
        .map_err(|e| format!("写入失败: {e}"))
}

/// 剥离 ANSI 转义序列并展开 \r 行重绘：
/// CSI（ESC [ … 最终字节 0x40-0x7E）、OSC（ESC ] … BEL 或 ESC \）、两字节序列；
/// \r 丢弃本行已写内容（\r\n 视为正常换行）。输入必须是合法 UTF-8。
pub(crate) fn strip_ansi(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut line_start = 0usize;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            0x1b if i + 1 < b.len() => match b[i + 1] {
                b'[' => {
                    i += 2;
                    while i < b.len() && !(0x40..=0x7e).contains(&b[i]) {
                        i += 1;
                    }
                    i += (i < b.len()) as usize; // 跳过最终字节
                }
                b']' => {
                    i += 2;
                    while i < b.len() {
                        if b[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if b[i] == 0x1b && i + 1 < b.len() && b[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 2, // 两字节序列（如 ESC ( B）
            },
            b'\r' => {
                if i + 1 < b.len() && b[i + 1] == b'\n' {
                    i += 1; // \r\n：跳过 \r，\n 照常处理
                } else {
                    out.truncate(line_start); // 行内重绘：回本行开头
                    i += 1;
                }
            }
            c => {
                let len = utf8_len(c).min(b.len() - i);
                out.push_str(&input[i..i + len]);
                i += len;
                if c == b'\n' {
                    line_start = out.len();
                }
            }
        }
    }
    out
}

/// 在 PTY 里跑命令并流式转发输出（emit 收到剥离 ANSI 后的文本块）。
/// 为什么用 PTY 而不是管道：brew（Ruby）/curl 检测到 stdout 是管道会切到块缓冲，
/// brew 的环境变量：跳过自动元数据更新；settings.brew_mirror 开启时（默认）
/// API 与 bottle 走清华 TUNA 镜像（用户显式设置过的变量不动）。
/// 抽成纯函数便于测试镜像开关。
pub(crate) fn brew_env_pairs(program: &str, mirror: bool) -> Vec<(String, String)> {
    let mut env = vec![(
        "HOMEBREW_NO_AUTO_UPDATE".to_string(),
        "1".to_string(),
    )];
    if program == "brew" && mirror {
        // formulae.brew.sh 托管在 GitHub Pages，国内拉几十 MB 元数据要几分钟
        if std::env::var_os("HOMEBREW_API_DOMAIN").is_none() {
            env.push((
                "HOMEBREW_API_DOMAIN".to_string(),
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api".to_string(),
            ));
        }
        if std::env::var_os("HOMEBREW_BOTTLE_DOMAIN").is_none() {
            env.push((
                "HOMEBREW_BOTTLE_DOMAIN".to_string(),
                "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles".to_string(),
            ));
        }
    }
    env
}

/// 运行期间一个字节都到不了我们手里；接 PTY 后它们按 TTY 行缓冲，输出实时可见。
/// TERM=dumb 让 brew/npm 放弃彩色和花式重绘，但保留 TTY 行为。
/// 带 900s 超时（杀直接子进程）；reader 在子进程退出后最多等 1 秒 drain，
/// 其子孙（curl 等）可能持有 slave 导致永远无 EOF，绝不无限 join。
fn run_streaming_pty<F: Fn(&str) + Send + 'static>(key: &str, program: &str, args: &[String], emit: F) -> (bool, String) {
    let pair = match native_pty_system().openpty(PtySize {
        rows: 24,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return (false, format!("创建 PTY 失败: {e}")),
    };
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    for (k, v) in brew_env_pairs(program, crate::settings::brew_mirror_enabled()) {
        cmd.env(&k, &v);
    }
    cmd.env("TERM", "dumb");
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("TERM_PROGRAM_VERSION");
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return (false, format!("启动 {program} 失败: {e}")),
    };
    // writer 先取出供交互输入（updater_write），再配置读端
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return (false, format!("写入 PTY 失败: {e}")),
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return (false, format!("读取 PTY 失败: {e}")),
    };
    // slave 必须立刻 drop：子进程退出后 reader 才能看到 EOF
    drop(pair.slave);
    writers().lock().unwrap().insert(key.to_string(), writer);
    let _writer_guard = WriterGuard(key.to_string());

    let collected = Arc::new(Mutex::new(String::new()));
    let collected2 = collected.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let (text, used) = crate::pty::split_utf8(&pending);
                    if used > 0 {
                        let text = strip_ansi(&text);
                        if !text.is_empty() {
                            emit(&text);
                            collected2.lock().unwrap().push_str(&text);
                        }
                        pending.drain(..used);
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let text = strip_ansi(&String::from_utf8_lossy(&pending));
            if !text.is_empty() {
                emit(&text);
                collected2.lock().unwrap().push_str(&text);
            }
        }
        let _ = done_tx.send(());
    });

    let start = std::time::Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if start.elapsed() > TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return (false, format!("等待 {program} 失败: {e}")),
        }
    };
    // 给 reader 最多 1 秒收残余输出，之后放弃该线程（见函数文档）
    let _ = done_rx.recv_timeout(Duration::from_secs(1));
    let tail = tail_lines(&collected.lock().unwrap(), 30);
    if timed_out {
        let mut msg = format!("命令超时（{} 秒）", TIMEOUT.as_secs());
        if !tail.is_empty() {
            msg.push('\n');
            msg.push_str(&tail);
        }
        return (false, msg);
    }
    let success = status.map(|s| s.success()).unwrap_or(false);
    (success, tail)
}

/// Tauri 事件封装：输出块经 `agent-update-output-<agent_id>` 实时推给前端，
/// writer 以 agent_id 为 key 入 UPDATER_WRITERS 供 updater_write 交互
fn run_streaming(app: &AppHandle, agent_id: &str, program: &str, args: &[String]) -> (bool, String) {
    let event = format!("agent-update-output-{agent_id}");
    let app = app.clone();
    run_streaming_pty(agent_id, program, args, move |text| {
        let _ = app.emit(&event, text);
    })
}

fn update_agent_sync(app: &AppHandle, agent_id: &str) -> Result<UpdateResultDto, String> {
    let binary = agents::binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let path = match which::which(binary) {
        Ok(p) => p,
        Err(_) => {
            return Ok(UpdateResultDto {
                ok: false,
                output: format!("未在 PATH 找到 {binary}，无法更新（请先在「配置」页确认安装）"),
                method: "none".into(),
                version_before: None,
                version_after: None,
            });
        }
    };
    let version_before = version_of(&path);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
    let method = detect_method(&resolved.to_string_lossy());
    let cmds = update_commands(agent_id, method, &path.to_string_lossy());
    if cmds.is_empty() {
        return Ok(UpdateResultDto {
            ok: false,
            output: format!("没有适用于 {agent_id}（{method} 安装）的更新方式"),
            method: method.into(),
            version_before,
            version_after: None,
        });
    }

    let mut ok = false;
    let mut output = String::new();
    let mut method_used = cmds[0].method;
    for c in &cmds {
        method_used = c.method;
        let (success, out) = run_streaming(app, agent_id, &c.program, &c.args);
        output = out;
        ok = success;
        if ok {
            break;
        }
        // 主命令失败：还有候选（fallback）则继续尝试
    }

    let version_after = if ok { version_of(&path) } else { None };
    if ok {
        agents::invalidate_detect_cache();
    }
    Ok(UpdateResultDto {
        ok,
        output,
        method: method_used.into(),
        version_before,
        version_after,
    })
}

/// 构建结果并经 `agent-update-done-<agent_id>` 推送（前端以事件为准，invoke 返回值兜底）
fn emit_done(app: &AppHandle, agent_id: &str, result: UpdateResultDto) -> UpdateResultDto {
    let _ = app.emit(&format!("agent-update-done-{agent_id}"), &result);
    result
}

#[tauri::command]
pub async fn update_agent(app: AppHandle, agent_id: String) -> Result<UpdateResultDto, String> {
    let app2 = app.clone();
    let agent_id2 = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        update_agent_sync(&app2, &agent_id2)
    })
    .await
    .map_err(|e| format!("更新失败: {e}"))??;
    Ok(emit_done(&app, &agent_id, result))
}

// ===== 安装（agent 未安装时） =====

/// 一个候选安装方式：tool 是执行它所需的 PATH 工具（"script" 需要 bash+curl）
struct InstallSpec {
    tool: &'static str,
    method: &'static str,
    program: String,
    args: Vec<String>,
}

fn spec(tool: &'static str, method: &'static str, program: &str, args: &[&str]) -> InstallSpec {
    InstallSpec {
        tool,
        method,
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// 全部候选，按 brew > npm > uv > 官方脚本 的优先级排序（脚本兜底，仅无其他方式时用）
fn install_specs(agent_id: &str) -> Vec<InstallSpec> {
    match agent_id {
        "claude-code" => vec![
            spec("brew", "brew", "brew", &["install", "--cask", "claude-code"]),
            spec("script", "script", "bash", &["-c", "curl -fsSL https://claude.ai/install.sh | bash"]),
        ],
        "codex" => vec![
            spec("brew", "brew", "brew", &["install", "--cask", "codex"]),
            spec("npm", "npm", "npm", &["install", "-g", "@openai/codex"]),
        ],
        "gemini" => vec![
            spec("brew", "brew", "brew", &["install", "gemini-cli"]),
            spec("npm", "npm", "npm", &["install", "-g", "@google/gemini-cli"]),
        ],
        "qwen" => vec![
            spec("brew", "brew", "brew", &["install", "qwen-code"]),
            spec("npm", "npm", "npm", &["install", "-g", "@qwen-code/qwen-code"]),
        ],
        "opencode" => vec![
            spec("brew", "brew", "brew", &["install", "anomalyco/tap/opencode"]),
            spec("npm", "npm", "npm", &["install", "-g", "opencode-ai"]),
        ],
        "kimi" => vec![
            spec("npm", "npm", "npm", &["install", "-g", "@moonshot-ai/kimi-code"]),
            // uv 装的是旧版 kimi-cli（Python）
            spec("uv", "uv", "uv", &["tool", "install", "kimi-cli"]),
            spec("script", "script", "bash", &["-c", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"]),
        ],
        _ => vec![],
    }
}

/// 按工具可用性挑第一个候选；available 可注入以便测试
fn pick_install(agent_id: &str, available: &dyn Fn(&str) -> bool) -> Option<InstallSpec> {
    install_specs(agent_id).into_iter().find(|s| match s.tool {
        "script" => available("bash") && available("curl"),
        tool => available(tool),
    })
}

/// 展示用：选中的安装方式描述（UI 在确认框里先亮出来）
fn install_method_for(agent_id: &str) -> Option<String> {
    let available = |tool: &str| which::which(tool).is_ok();
    let s = pick_install(agent_id, &available)?;
    Some(format!("{}: {} {}", s.method, s.program, s.args.join(" ")))
}

#[tauri::command]
pub fn install_method_preview(agent_id: String) -> Option<String> {
    install_method_for(&agent_id)
}

fn install_agent_sync(app: &AppHandle, agent_id: &str) -> Result<UpdateResultDto, String> {
    let binary = agents::binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    if which::which(binary).is_ok() {
        return Ok(UpdateResultDto {
            ok: false,
            output: format!("{binary} 已在 PATH 中，无需安装（要升级请用「更新」）"),
            method: "none".into(),
            version_before: None,
            version_after: None,
        });
    }
    let available = |tool: &str| which::which(tool).is_ok();
    let Some(s) = pick_install(agent_id, &available) else {
        return Ok(UpdateResultDto {
            ok: false,
            output: "未找到可用的安装工具（brew / npm / uv / curl 都不在 PATH）".into(),
            method: "none".into(),
            version_before: None,
            version_after: None,
        });
    };
    let (ok, output) = run_streaming(app, agent_id, &s.program, &s.args);
    let version_after = if ok {
        which::which(binary).ok().and_then(|p| version_of(&p))
    } else {
        None
    };
    if ok {
        agents::invalidate_detect_cache();
    }
    Ok(UpdateResultDto {
        ok,
        output,
        method: s.method.into(),
        version_before: None,
        version_after,
    })
}

#[tauri::command]
pub async fn install_agent(app: AppHandle, agent_id: String) -> Result<UpdateResultDto, String> {
    let app2 = app.clone();
    let agent_id2 = agent_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_agent_sync(&app2, &agent_id2)
    })
    .await
    .map_err(|e| format!("安装失败: {e}"))??;
    Ok(emit_done(&app, &agent_id, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brew_mirror_off_skips_tuna_domains() {
        let on = brew_env_pairs("brew", true);
        assert!(on.iter().any(|(k, _)| k == "HOMEBREW_API_DOMAIN"));
        assert!(on.iter().any(|(k, _)| k == "HOMEBREW_BOTTLE_DOMAIN"));
        let off = brew_env_pairs("brew", false);
        assert!(!off.iter().any(|(k, _)| k == "HOMEBREW_API_DOMAIN"), "镜像关闭时不注入镜像域名");
        assert!(!off.iter().any(|(k, _)| k == "HOMEBREW_BOTTLE_DOMAIN"));
        // NO_AUTO_UPDATE 无论开关都保留；非 brew 命令不注入镜像
        assert!(off.iter().any(|(k, _)| k == "HOMEBREW_NO_AUTO_UPDATE"));
        assert!(!brew_env_pairs("npm", true).iter().any(|(k, _)| k == "HOMEBREW_API_DOMAIN"));
    }

    #[test]
    fn method_detection_from_resolved_path() {
        assert_eq!(
            detect_method("/opt/homebrew/Caskroom/claude-code/2.1.212/claude"),
            "brew"
        );
        // brew formula 内部也带 node_modules：Cellar 规则优先，正确判为 brew
        assert_eq!(
            detect_method("/opt/homebrew/Cellar/gemini-cli/0.46.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js"),
            "brew"
        );
        assert_eq!(
            detect_method("/Users/x/.local/lib/node_modules/@openai/codex/bin/codex.js"),
            "npm"
        );
        // homebrew prefix 的 npm 全局包仍是 npm
        assert_eq!(detect_method("/opt/homebrew/lib/node_modules/qwen-code/bin/qwen"), "npm");
        assert_eq!(detect_method("/opt/homebrew/Caskroom/codex/0.1.0/codex"), "brew");
        assert_eq!(detect_method("/Users/x/.local/share/uv/tools/kimi-cli/bin/kimi"), "uv");
        assert_eq!(detect_method("/Users/x/.local/uv/tools/kimi/bin/kimi"), "uv");
        assert_eq!(detect_method("/Users/x/.kimi-code/bin/kimi"), "self");
        assert_eq!(detect_method("/usr/local/bin/opencode"), "self");
    }

    #[test]
    fn install_selection_follows_brew_npm_uv_script_priority() {
        let all = |_: &str| true;
        assert_eq!(pick_install("codex", &all).unwrap().method, "brew");
        let no_brew = |t: &str| t != "brew";
        assert_eq!(pick_install("codex", &no_brew).unwrap().method, "npm");
        // 只剩脚本工具时 claude 走官方脚本
        let only_script = |t: &str| matches!(t, "bash" | "curl");
        let s = pick_install("claude-code", &only_script).unwrap();
        assert_eq!(s.method, "script");
        assert_eq!(s.program, "bash");
        // 脚本也需要 bash+curl，全无 → None
        let nothing = |_: &str| false;
        assert!(pick_install("claude-code", &nothing).is_none());
        // kimi 优先级 npm > uv > script（script 是新版官方安装，uv 是旧版 kimi-cli）
        assert_eq!(pick_install("kimi", &all).unwrap().method, "npm");
        let only_uv = |t: &str| t == "uv";
        let u = pick_install("kimi", &only_uv).unwrap();
        assert_eq!((u.method, u.args.join(" ")), ("uv", "tool install kimi-cli".to_string()));
        assert_eq!(pick_install("kimi", &only_script).unwrap().method, "script");
        // 未知 agent → None
        assert!(pick_install("nope", &all).is_none());
    }

    #[test]
    fn strip_ansi_handles_csi_osc_and_cr() {
        // CSI 颜色
        assert_eq!(strip_ansi("\x1b[1;31mred\x1b[0m"), "red");
        // CSI 带参数的光标移动
        assert_eq!(strip_ansi("a\x1b[2Kb"), "ab");
        // OSC（BEL 结尾）
        assert_eq!(strip_ansi("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
        // OSC（ESC \ 结尾）
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\rest"), "rest");
        // \r 行重绘：只保留最后一段
        assert_eq!(strip_ansi("progress 10%\rprogress 20%\n"), "progress 20%\n");
        // \r\n 是正常换行，不截断
        assert_eq!(strip_ansi("a\r\nb"), "a\nb");
        // 多字节字符不受剥离影响
        assert_eq!(strip_ansi("中\x1b[1m文"), "中文");
        // 纯文本原样
        assert_eq!(strip_ansi("plain text\n"), "plain text\n");
    }

    /// 冒烟测试：验证 PTY 流式输出——3 行各自间隔 1s 到达，而非退出时一次性到齐。
    /// 这正是修复前管道块缓冲的症状（"运行中，等待输出…" 卡住不动）。
    #[test]
    fn pty_streaming_delivers_lines_incrementally() {
        let chunks: Arc<Mutex<Vec<(std::time::Instant, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let c = chunks.clone();
        let (ok, _tail) = run_streaming_pty(
            "test-streaming",
            "bash",
            &[
                "-c".into(),
                "for i in 1 2 3; do echo line$i; sleep 1; done".into(),
            ],
            move |t| {
                c.lock().unwrap().push((std::time::Instant::now(), t.to_string()));
            },
        );
        assert!(ok);
        let chunks = chunks.lock().unwrap();
        let joined: String = chunks.iter().map(|(_, t)| t.as_str()).collect();
        for i in 1..=3 {
            assert!(joined.contains(&format!("line{i}")), "缺 line{i}: {joined}");
        }
        let at = |needle: &str| {
            chunks
                .iter()
                .find(|(_, t)| t.contains(needle))
                .map(|(t, _)| *t)
                .unwrap()
        };
        let gap = at("line3").duration_since(at("line1"));
        assert!(
            gap >= Duration::from_millis(1500),
            "line3 与 line1 到达间隔仅 {gap:?}，输出不是流式的"
        );
    }

    /// 交互测试：run 中途经 writers map 写入（模拟 brew [y/n] 确认），
    /// 子进程读到输入并把回显行吐出来；run 结束后 writer 已从 map 移除。
    #[test]
    fn pty_run_is_interactive_via_writers_map() {
        let chunks: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let c = chunks.clone();
        let key = "test-interactive".to_string();
        let key2 = key.clone();
        let handle = std::thread::spawn(move || {
            run_streaming_pty(
                &key2,
                "bash",
                &["-c".into(), "read x; echo got-$x".into()],
                move |t| {
                    c.lock().unwrap().push_str(t);
                },
            )
        });
        // 等 writer 就绪（最多 5s）
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if writers().lock().unwrap().contains_key(&key) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "writer 未注册进 map");
            std::thread::sleep(Duration::from_millis(50));
        }
        {
            let mut map = writers().lock().unwrap();
            let w = map.get_mut(&key).unwrap();
            w.write_all(b"hello\n").unwrap();
            w.flush().unwrap();
        }
        let (ok, _tail) = handle.join().unwrap();
        assert!(ok);
        let out = chunks.lock().unwrap().clone();
        assert!(out.contains("got-hello"), "子进程未读到输入，输出: {out}");
        assert!(
            !writers().lock().unwrap().contains_key(&key),
            "run 结束后 writer 应从 map 移除"
        );
    }
}
