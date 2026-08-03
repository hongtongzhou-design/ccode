use crate::profiles::Profile;
use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub id: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

/// 启动计划：env 差异由 adapter 吸收（Codex 没有 base-url 环境变量，只能走 -c 参数）
#[derive(Debug, Default)]
pub struct LaunchPlan {
    pub env: Vec<(String, String)>,
    pub args: Vec<String>,
}

pub(crate) const AGENTS: [(&str, &str); 6] = [
    ("claude-code", "claude"),
    ("codex", "codex"),
    ("gemini", "gemini"),
    ("qwen", "qwen"),
    ("opencode", "opencode"),
    ("kimi", "kimi"),
];

/// 解析 CLI 二进制的绝对路径：先 which（继承进程 PATH），miss 时按平台查常见
/// 安装目录兜底。背景：macOS 打包版从 Finder 启动时 PATH 很短（/usr/bin:/bin），
/// brew/npm 装的 CLI 不在其中（AGENTS.md 本机环境档案「GUI 应用 PATH 很短」）。
/// 所有二进制定位一律走这里，不再直接 which / 裸名 spawn。
pub fn resolve_binary(name: &str) -> Option<std::path::PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    find_in_dirs(name, &candidate_dirs())
}

/// 在候选目录里按序找第一个存在的文件；Windows 下 npm 全局包是 .cmd shim，补扩展名匹配
fn find_in_dirs(name: &str, dirs: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![name.into(), format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.into()]
    };
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

/// which miss 后的兜底候选目录（按优先级排序）；用户目录一律走 dirs 抽象，禁写死。
/// 用户目录排在系统目录前——与用户交互终端的 PATH 解析习惯一致（~/.local/bin 里的
/// 自装副本应优先于 /opt/homebrew/bin 里的同名旧副本，避免检测到非自用的那份）
fn candidate_dirs() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = dirs::home_dir() {
            out.push(h.join(".npm-global/bin"));
            out.push(h.join(".local/bin"));
            out.push(h.join("bin"));
            out.push(h.join(".kimi-code/bin")); // Kimi Code 新版官方安装器
        }
        out.push("/opt/homebrew/bin".into()); // Apple Silicon brew
        out.push("/usr/local/bin".into()); // Intel brew / 手动安装
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(h) = dirs::home_dir() {
            out.push(h.join(".local/bin"));
            out.push(h.join(".kimi-code/bin")); // Kimi Code 新版官方安装器
        }
        out.push("/usr/local/bin".into());
    }
    #[cfg(target_os = "windows")]
    {
        // %LOCALAPPDATA%\Programs、%APPDATA%\npm（npm 全局 bin 目录）
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("Programs"));
        }
        if let Some(roaming) = dirs::data_dir() {
            out.push(roaming.join("npm"));
        }
        if let Some(h) = dirs::home_dir() {
            out.push(h.join(".kimi-code/bin")); // Kimi Code 新版官方安装器
        }
    }
    out
}

fn detect(binary: &str) -> (Option<String>, Option<String>) {
    let path = match resolve_binary(binary) {
        Some(p) => p,
        None => return (None, None),
    };
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text.lines().next().unwrap_or("").to_string())
            }
        });
    (Some(path.to_string_lossy().into_owned()), version)
}

/// 把 profile + 钥匙串密钥翻译成启动 env/args。key 只在启动时刻读取，不外传。
/// model 为启动时选中的模型（调用方已兜底为 profile 模型列表的首个）。
pub fn launch_plan(profile: &Profile, key: Option<String>, model: Option<&str>) -> LaunchPlan {
    let mut plan = LaunchPlan::default();
    match profile.agent.as_str() {
        "claude-code" => {
            if let Some(url) = &profile.base_url {
                plan.env.push(("ANTHROPIC_BASE_URL".into(), url.clone()));
            }
            if let Some(key) = key {
                plan.env.push(("ANTHROPIC_AUTH_TOKEN".into(), key));
            }
            if let Some(model) = model {
                plan.env.push(("ANTHROPIC_MODEL".into(), model.into()));
            }
            // 把模型列表注册进 /model 选择器（否则选择器里只有内置别名可用）：
            // 前 4 个占用 opus/sonnet/haiku/fable 别名槽，_NAME 让选择器显示真实模型名；
            // 第 5 个走唯一的 CUSTOM_MODEL_OPTION；更多模型只能靠 /model <id> 手输
            const SLOTS: [&str; 4] = ["SONNET", "OPUS", "HAIKU", "FABLE"];
            for (m, slot) in profile.models.iter().take(4).zip(SLOTS) {
                plan.env.push((format!("ANTHROPIC_DEFAULT_{slot}_MODEL"), m.clone()));
                plan.env.push((format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"), m.clone()));
            }
            if let Some(fifth) = profile.models.get(4) {
                plan.env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), fifth.clone()));
                plan.env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(), fifth.clone()));
            }
        }
        "codex" => {
            if let Some(key) = key {
                plan.env.push(("CODEX_API_KEY".into(), key));
            }
            // Codex 没有 base URL 环境变量，且只支持 Responses API：
            // 用 -c 内联定义一个名为 ccode 的 provider 并指到它
            if let Some(url) = &profile.base_url {
                for kv in [
                    r#"model_providers.ccode.name="Ccode""#.to_string(),
                    format!(r#"model_providers.ccode.base_url="{url}""#),
                    r#"model_providers.ccode.env_key="CODEX_API_KEY""#.to_string(),
                    r#"model_providers.ccode.wire_api="responses""#.to_string(),
                ] {
                    plan.args.push("-c".into());
                    plan.args.push(kv);
                }
                plan.args.push("-c".into());
                plan.args.push(r#"model_provider="ccode""#.into());
            }
            if let Some(model) = model {
                plan.args.push("-m".into());
                plan.args.push(model.into());
            }
            // 默认沙箱：只能写当前工作目录（需全权限时在系统终端自行启动）
            plan.args.push("-s".into());
            plan.args.push("workspace-write".into());
        }
        "gemini" => {
            if let Some(key) = key {
                plan.env.push(("GEMINI_API_KEY".into(), key));
            }
            // 设了 GOOGLE_GEMINI_BASE_URL 即进入官方支持的 gateway 模式
            if let Some(url) = &profile.base_url {
                plan.env.push(("GOOGLE_GEMINI_BASE_URL".into(), url.clone()));
            }
            if let Some(model) = model {
                plan.env.push(("GEMINI_MODEL".into(), model.into()));
            }
        }
        "qwen" => {
            // 多协议 agent；gemini/vertex-ai 协议暂不支持，一律按 openai 注入
            match profile.protocol.as_deref().unwrap_or("openai") {
                "anthropic" => {
                    if let Some(key) = key {
                        plan.env.push(("ANTHROPIC_API_KEY".into(), key));
                    }
                    if let Some(url) = &profile.base_url {
                        plan.env.push(("ANTHROPIC_BASE_URL".into(), url.clone()));
                    }
                    if let Some(model) = model {
                        plan.env.push(("ANTHROPIC_MODEL".into(), model.into()));
                    }
                    plan.args.push("--auth-type".into());
                    plan.args.push("anthropic".into());
                }
                _ => {
                    if let Some(key) = key {
                        plan.env.push(("OPENAI_API_KEY".into(), key));
                    }
                    if let Some(url) = &profile.base_url {
                        plan.env.push(("OPENAI_BASE_URL".into(), url.clone()));
                    }
                    if let Some(model) = model {
                        plan.env.push(("OPENAI_MODEL".into(), model.into()));
                    }
                    plan.args.push("--auth-type".into());
                    plan.args.push("openai".into());
                }
            }
        }
        "opencode" => {
            // OpenCode 没有通用 key/baseURL 环境变量：用 OPENCODE_CONFIG_CONTENT 内联配置注入，
            // 该层优先级高于 auth.json 和 env（matrix §5），行为确定
            let provider = opencode_provider_json(profile, key.as_deref(), model);
            let mut config = serde_json::json!({ "provider": { "ccode": provider } });
            if let Some(m) = model {
                config["model"] = serde_json::json!(format!("ccode/{m}"));
            }
            plan.env
                .push(("OPENCODE_CONFIG_CONTENT".into(), config.to_string()));
            // 防止自更新在启动时替换掉我们检测到的二进制
            plan.env.push(("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into()));
        }
        "kimi" => {
            // 新旧两个产品共用 kimi 命令：新版故意忽略 shell env 的 API key，只认
            // KIMI_MODEL_* 合成通道；旧版读 KIMI_API_KEY/KIMI_BASE_URL。
            // 两组都设，各变体忽略自己不读的；KIMI_MODEL_NAME 两边通用。
            // 新版通道需模型名才启用：无模型时整组跳过，回落到用户自己的配置
            if let Some(model) = model {
                plan.env.push(("KIMI_MODEL_NAME".into(), model.into()));
                plan.env.push((
                    "KIMI_MODEL_PROVIDER_TYPE".into(),
                    profile.protocol.clone().unwrap_or_else(|| "kimi".into()),
                ));
                if let Some(key) = &key {
                    plan.env.push(("KIMI_MODEL_API_KEY".into(), key.clone()));
                }
                if let Some(url) = &profile.base_url {
                    plan.env.push(("KIMI_MODEL_BASE_URL".into(), url.clone()));
                }
            }
            if let Some(key) = &key {
                plan.env.push(("KIMI_API_KEY".into(), key.clone()));
            }
            if let Some(url) = &profile.base_url {
                plan.env.push(("KIMI_BASE_URL".into(), url.clone()));
            }
        }
        _ => {}
    }
    // 附加环境变量放在最后：CommandBuilder 重复 env 后者生效，用户可借此覆盖 adapter 内置值
    for (k, v) in &profile.extra_env {
        plan.env.push((k.clone(), v.clone()));
    }
    plan
}

/// OpenCode 的 provider 条目（npm + options + models），启动注入与全局写入共用
pub(crate) fn opencode_provider_json(
    profile: &Profile,
    key: Option<&str>,
    model: Option<&str>,
) -> serde_json::Value {
    let mut options = serde_json::Map::new();
    if let Some(url) = &profile.base_url {
        options.insert("baseURL".into(), serde_json::json!(url));
    }
    if let Some(k) = key {
        options.insert("apiKey".into(), serde_json::json!(k));
    }
    let mut models_map = serde_json::Map::new();
    for m in &profile.models {
        models_map.insert(m.clone(), serde_json::json!({}));
    }
    if let Some(m) = model {
        models_map
            .entry(m.to_string())
            .or_insert_with(|| serde_json::json!({}));
    }
    serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "options": options,
        "models": models_map,
    })
}

// ===== codex 模型 catalog：TUI /model 选择器的数据源（仅启动时读取一次） =====

/// catalog 文件路径：<config dir>/ccode/catalogs/codex-<profile_id>.json
pub fn codex_catalog_path(profile_id: &str) -> Option<std::path::PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("catalogs")
            .join(format!("codex-{profile_id}.json")),
    )
}

/// 单个 catalog 条目：字段拼写与标量值照抄 codex-rs/models-manager/models.json 的打包条目
/// （slug/display_name 换成模型 id；reasoning levels 取其 low/medium/high 子集）
fn codex_catalog_entry(model: &str) -> serde_json::Value {
    serde_json::json!({
        "slug": model,
        "display_name": model,
        "description": null,
        "supported_reasoning_levels": [
            { "effort": "low", "description": "Fast responses with lighter reasoning" },
            { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
            { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 1,
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": "You are a coding agent.",
        "support_verbosity": true,
        "default_verbosity": "low",
        "apply_patch_tool_type": "freeform",
        "truncation_policy": { "mode": "tokens", "limit": 10000 },
        "supports_parallel_tool_calls": true,
        // v0.146 起为必填（无 serde default），空数组即可
        "experimental_supported_tools": [],
    })
}

/// ModelsResponse { models: [ModelInfo] }：每个 profile 模型一条目
pub fn codex_catalog_json(models: &[String]) -> serde_json::Value {
    serde_json::json!({
        "models": models.iter().map(|m| codex_catalog_entry(m)).collect::<Vec<_>>(),
    })
}

fn write_codex_catalog_to(path: &std::path::Path, models: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 catalog 目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(&codex_catalog_json(models)).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 把 profile 的模型列表写成 codex catalog 文件（原子写）；无模型时返回 None
pub fn write_codex_catalog(profile: &Profile) -> Result<Option<std::path::PathBuf>, String> {
    if profile.models.is_empty() {
        return Ok(None);
    }
    let path = codex_catalog_path(&profile.id).ok_or("无法确定平台配置目录")?;
    write_codex_catalog_to(&path, &profile.models)?;
    Ok(Some(path))
}

/// -c 注入的 catalog 路径参数：-c 的值是 TOML，路径必须带引号成 TOML 字符串
fn catalog_args(path: &std::path::Path) -> Vec<String> {
    vec![
        "-c".into(),
        format!(r#"model_catalog_json="{}""#, path.to_string_lossy()),
    ]
}

/// 启动前的每-agent 文件准备，返回需追加到 CLI 的参数。
/// codex：写模型 catalog 并用 -c 指过去，让 TUI /model 选择器列出 profile 的全部模型
pub fn prepare_launch(profile: &Profile) -> Result<Vec<String>, String> {
    if profile.agent == "codex" {
        if let Some(path) = write_codex_catalog(profile)? {
            return Ok(catalog_args(&path));
        }
    }
    Ok(vec![])
}

pub fn binary_for(agent_id: &str) -> Option<&'static str> {
    AGENTS
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, bin)| *bin)
}

/// 各 CLI 的按 ID 恢复会话参数（§6.12 A）。
/// 返回 (prepend, args)：codex 的 resume 是子命令需放最前，其余是位置无关的 flag。
pub(crate) fn resume_args(agent_id: &str, session_id: &str) -> (bool, Vec<String>) {
    match agent_id {
        "codex" => (true, vec!["resume".into(), session_id.into()]),
        "claude-code" | "gemini" | "qwen" => (false, vec!["-r".into(), session_id.into()]),
        "kimi" => (false, vec!["-S".into(), session_id.into()]),
        "opencode" => (false, vec!["--session".into(), session_id.into()]),
        _ => (false, vec![]),
    }
}

/// shell 单引号转义（POSIX）；仅含安全字符时不加引号，保持 cc-switch 风格的干净命令行
fn sh_quote_if_needed(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-._/".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// 会话恢复的完整命令行（cd 到项目目录 + CLI resume 参数）。
/// 刻意不带 profile env——密钥只在 Ccode 自家拉起时注入（关键约定），
/// 外部恢复用的是用户全局配置。binary 参数允许外部拉起时传绝对路径（见下）。
fn resume_command_line_with(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    binary: &str,
) -> Result<String, String> {
    let (_, args) = resume_args(agent_id, session_id);
    if args.is_empty() {
        return Err(format!("{agent_id} 不支持按 ID 恢复"));
    }
    let mut cmd = format!("cd {} && {binary}", sh_quote_if_needed(cwd));
    for a in &args {
        cmd.push(' ');
        cmd.push_str(&sh_quote_if_needed(a));
    }
    Ok(cmd)
}

/// 复制用命令行：裸命令名（用户真实交互终端 rc 齐全，且 cc-switch 风格干净）
pub fn resume_command_line(agent_id: &str, session_id: &str, cwd: &str) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    resume_command_line_with(agent_id, session_id, cwd, binary)
}

/// 复制用：返回该会话的恢复命令行
#[tauri::command]
pub fn session_resume_command(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<String, String> {
    resume_command_line(agent_id, session_id, cwd)
}

/// 在外部终端应用中恢复会话（macOS: Ghostty → iTerm → Terminal.app；Windows: cmd 新窗口；
/// Linux: 常见终端模拟器）。终端选择读设置页「外部终端」，auto = 上述优先级探测。
/// 二进制用绝对路径：外部 shell 是非交互启动时可能不加载 .zshrc/.bashrc（kimi 这类
/// 官方安装器目录只写在交互 rc 里），裸命令名会 command not found
#[tauri::command]
pub fn resume_external_terminal(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    let pref = crate::settings::read_current()
        .external_terminal
        .unwrap_or_else(|| "auto".into());
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let binary = resolve_binary(binary)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| binary.into());
    let cmd = resume_command_line_with(agent_id, session_id, cwd, &binary)?;
    open_external_terminal(&cmd, &pref)
}

#[cfg(target_os = "macos")]
fn open_external_terminal(cmd: &str, pref: &str) -> Result<(), String> {
    match pref {
        "ghostty" => open_ghostty(cmd),
        "iterm" => open_iterm(cmd),
        "terminal" => open_terminal_app(cmd),
        // auto：Ghostty → iTerm → Terminal.app
        _ if std::path::Path::new("/Applications/Ghostty.app").exists() => open_ghostty(cmd),
        _ if std::path::Path::new("/Applications/iTerm.app").exists() => open_iterm(cmd),
        _ => open_terminal_app(cmd),
    }
}

#[cfg(target_os = "macos")]
fn open_ghostty(cmd: &str) -> Result<(), String> {
    if !std::path::Path::new("/Applications/Ghostty.app").exists() {
        return Err("未安装 Ghostty（设置页改选其他终端）".into());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let running = Command::new("pgrep")
        .args(["-x", "ghostty"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !running {
        // 未运行：open -na 拉起（仅此一次产生实例）；Ghostty -e 之后的参数整体作为命令
        // 执行；-l -i 交互登录 shell（非交互模式 zsh 不加载 .zshrc / bash 不加载 .bashrc）
        return spawn_status(
            Command::new("open")
                .args(["-na", "Ghostty", "--args", "-e", &shell, "-l", "-i", "-c", cmd]),
            "Ghostty",
        );
    }
    // 已运行：open -n 会再开新实例（程序坞每点一次多一个图标），且 open 对运行中的实例
    // 不投递 --args（实测）——改走 AppleScript：激活 → ⌘N 开新窗 → 剪贴板粘贴命令
    // （keystroke 逐字输入对中文路径/键盘布局不可靠，故走剪贴板，用后还原）
    let escaped = applescript_escape(cmd);
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "set oldClip to the clipboard",
            "-e",
            &format!("set the clipboard to \"{escaped}\""),
            "-e",
            "tell application \"Ghostty\" to activate",
            "-e",
            "delay 0.3",
            "-e",
            "tell application \"System Events\" to keystroke \"n\" using command down",
            "-e",
            "delay 0.4",
            "-e",
            "tell application \"System Events\" to keystroke \"v\" using command down",
            "-e",
            "delay 0.2",
            "-e",
            "tell application \"System Events\" to key code 36",
            "-e",
            "delay 0.2",
            "-e",
            "set the clipboard to oldClip",
        ]),
        "Ghostty",
    )
}

#[cfg(target_os = "macos")]
fn open_iterm(cmd: &str) -> Result<(), String> {
    if !std::path::Path::new("/Applications/iTerm.app").exists() {
        return Err("未安装 iTerm2（设置页改选其他终端）".into());
    }
    let escaped = applescript_escape(cmd);
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "tell application \"iTerm\"",
            "-e",
            "activate",
            "-e",
            "create window with default profile",
            "-e",
            &format!("tell current session of current window to write text \"{escaped}\""),
            "-e",
            "end tell",
        ]),
        "iTerm",
    )
}

/// 系统自带 Terminal.app 兜底（do script 本身跑在 login shell 里）
#[cfg(target_os = "macos")]
fn open_terminal_app(cmd: &str) -> Result<(), String> {
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "tell application \"Terminal\"",
            "-e",
            "activate",
            "-e",
            &format!("do script \"{}\"", applescript_escape(cmd)),
            "-e",
            "end tell",
        ]),
        "Terminal",
    )
}

/// AppleScript 字符串字面量转义（\ 和 "）
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn spawn_status(cmd: &mut Command, what: &str) -> Result<(), String> {
    let status = cmd.status().map_err(|e| format!("启动 {what} 失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("启动 {what} 失败: {status}"))
    }
}

#[cfg(target_os = "windows")]
fn open_external_terminal(cmd: &str, _pref: &str) -> Result<(), String> {
    // resume_command_line 是 POSIX 语法，cmd.exe 不认单引号，换 cmd 方言重建
    let cmd = windows_command_line(cmd)?;
    // start 开新窗口；/K 让窗口在 agent 退出后保留；内层引号 doubling 是 cmd 的转义方式
    let inner = cmd.replace('"', "\"\"");
    Command::new("cmd")
        .args(["/C", &format!("start \"\" cmd /K \"{inner}\"")])
        .spawn()
        .map_err(|e| format!("启动外部终端失败: {e}"))?;
    Ok(())
}

/// 把 POSIX 版恢复命令行改写成 cmd 方言（双引号 + cd /d）
#[cfg(target_os = "windows")]
fn windows_command_line(posix: &str) -> Result<String, String> {
    // 结构固定为 cd <quoted-cwd> && <bin> <args...>，逐段把单引号换成双引号、cd 加 /d
    let rest = posix
        .strip_prefix("cd ")
        .ok_or_else(|| "意外的命令格式".to_string())?;
    let (cwd, tail) = rest
        .split_once(" && ")
        .ok_or_else(|| "意外的命令格式".to_string())?;
    let cwd = cwd.trim_matches('\'');
    Ok(format!("cd /d \"{cwd}\" && {}", tail.replace('\'', "\"")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_external_terminal(cmd: &str, pref: &str) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    // auto 按优先级探测；显式选择只试指定终端，未装则报错（设置页可改选）
    let candidates: Vec<&str> = match pref {
        "auto" | "" => vec!["gnome-terminal", "konsole", "xfce4-terminal", "x-terminal-emulator", "xterm"],
        other => vec![other],
    };
    for term in candidates {
        if let Some(bin) = resolve_binary(term) {
            let mut c = Command::new(bin);
            // -l -i 交互登录 shell：非交互模式不加载 .zshrc/.bashrc，用户 PATH 会丢
            if term == "gnome-terminal" {
                c.args(["--", &shell, "-l", "-i", "-c", cmd]);
            } else {
                c.args(["-e", &shell, "-l", "-i", "-c", cmd]);
            }
            c.spawn().map_err(|e| format!("启动 {term} 失败: {e}"))?;
            return Ok(());
        }
    }
    Err(match pref {
        "auto" | "" => "未找到可用的终端模拟器（gnome-terminal/konsole/xterm）".into(),
        other => format!("未安装所选终端 {other}（设置页改选其他终端）"),
    })
}

/// kimi 新旧两个产品共用命令，按数据目录推断装的是哪个变体（"new" | "legacy"）
pub(crate) fn kimi_variant() -> Option<&'static str> {
    let home = dirs::home_dir()?;
    if home.join(".kimi-code").exists() {
        Some("new")
    } else if home.join(".kimi").exists() {
        Some("legacy")
    } else {
        None
    }
}

fn kimi_variant_hint() -> Option<&'static str> {
    match kimi_variant() {
        Some("new") => Some("新版"),
        Some("legacy") => Some("旧版"),
        _ => None,
    }
}

/// 检测结果按进程缓存一次（要 spawn 6 个子进程跑 --version，没必要每次重算）；
/// 更新成功后由 updater 调 invalidate_detect_cache 清空
static DETECT_CACHE: std::sync::Mutex<Option<Vec<DetectResult>>> = std::sync::Mutex::new(None);

pub(crate) fn invalidate_detect_cache() {
    *DETECT_CACHE.lock().unwrap() = None;
}

#[tauri::command]
pub async fn detect_agents() -> Vec<DetectResult> {
    if let Some(cached) = DETECT_CACHE.lock().unwrap().clone() {
        return cached;
    }
    let results: Vec<DetectResult> = AGENTS
        .iter()
        .map(|(id, binary)| {
            let (binary_path, mut version) = detect(binary);
            if *id == "kimi" {
                if let (Some(v), Some(hint)) = (&version, kimi_variant_hint()) {
                    version = Some(format!("{v} ({hint})"));
                }
            }
            DetectResult {
                id: id.to_string(),
                binary_path,
                version,
            }
        })
        .collect();
    *DETECT_CACHE.lock().unwrap() = Some(results.clone());
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(agent: &str, base_url: Option<&str>) -> Profile {
        Profile {
            id: "test".into(),
            agent: agent.into(),
            name: "测试".into(),
            protocol: None,
            base_url: base_url.map(|s| s.into()),
            models: vec![],
            extra_env: std::collections::HashMap::new(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
        }
    }

    #[test]
    fn claude_plan_registers_models_into_picker() {
        let mut p = profile("claude-code", None);
        p.models = vec!["m1".into(), "m2".into(), "m3".into(), "m4".into(), "m5".into()];
        let plan = launch_plan(&p, None, Some("m1"));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), "m1".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".into(), "m2".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), "m3".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_FABLE_MODEL".into(), "m4".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), "m5".into())));
    }

    #[test]
    fn extra_env_appended_last_for_override() {
        let mut p = profile("claude-code", Some("https://relay.example.com"));
        p.extra_env.insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        p.extra_env.insert("ANTHROPIC_BASE_URL".into(), "https://override.example.com".into());
        let plan = launch_plan(&p, None, None);
        assert!(plan
            .env
            .contains(&("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into())));
        // 与 adapter 内置值重复时，extra_env 排在后面（CommandBuilder 后者生效）
        let last = plan
            .env
            .iter()
            .rposition(|(k, _)| k == "ANTHROPIC_BASE_URL")
            .unwrap();
        assert_eq!(plan.env[last].1, "https://override.example.com");
    }

    #[test]
    fn claude_plan_sets_only_present_fields() {
        let p = profile("claude-code", Some("https://relay.example.com"));
        let plan = launch_plan(&p, Some("sk-secret".into()), None);
        assert!(plan.args.is_empty());
        assert!(plan
            .env
            .contains(&("ANTHROPIC_BASE_URL".into(), "https://relay.example.com".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_AUTH_TOKEN".into(), "sk-secret".into())));
        assert!(!plan.env.iter().any(|(k, _)| k == "ANTHROPIC_MODEL"));
    }

    #[test]
    fn claude_plan_without_key_omits_token() {
        let p = profile("claude-code", None);
        let plan = launch_plan(&p, None, Some("claude-sonnet-4"));
        assert_eq!(plan.env.len(), 1);
        assert!(plan
            .env
            .contains(&("ANTHROPIC_MODEL".into(), "claude-sonnet-4".into())));
    }

    #[test]
    fn codex_plan_inlines_provider_via_c_args() {
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gpt-5-codex"));
        assert!(plan
            .env
            .contains(&("CODEX_API_KEY".into(), "sk-secret".into())));
        let joined = plan.args.join(" ");
        assert!(joined.contains(r#"model_providers.ccode.base_url="https://relay.example.com/v1""#));
        assert!(joined.contains(r#"model_providers.ccode.wire_api="responses""#));
        assert!(joined.contains(r#"model_provider="ccode""#));
        assert!(joined.contains("-m gpt-5-codex"));
    }

    #[test]
    fn codex_plan_without_base_url_has_no_provider_args() {
        let p = profile("codex", None);
        let plan = launch_plan(&p, None, None);
        // 无 provider 参数，只有默认沙箱参数
        assert_eq!(plan.args, vec!["-s", "workspace-write"]);
        assert!(plan.env.is_empty());
    }

    #[test]
    fn gemini_plan_sets_only_present_fields() {
        let p = profile("gemini", Some("https://relay.example.com"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gemini-3-pro"));
        assert!(plan.args.is_empty());
        assert!(plan
            .env
            .contains(&("GEMINI_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "GOOGLE_GEMINI_BASE_URL".into(),
            "https://relay.example.com".into()
        )));
        assert!(plan
            .env
            .contains(&("GEMINI_MODEL".into(), "gemini-3-pro".into())));

        let bare = launch_plan(&p, None, None);
        assert!(bare
            .env
            .contains(&("GOOGLE_GEMINI_BASE_URL".into(), "https://relay.example.com".into())));
        assert!(!bare.env.iter().any(|(k, _)| k == "GEMINI_API_KEY"));
        assert!(!bare.env.iter().any(|(k, _)| k == "GEMINI_MODEL"));
    }

    #[test]
    fn qwen_plan_defaults_to_openai_protocol() {
        let p = profile("qwen", Some("https://dashscope.aliyuncs.com/compatible-mode/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("qwen3-coder"));
        assert!(plan
            .env
            .contains(&("OPENAI_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "OPENAI_BASE_URL".into(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1".into()
        )));
        assert!(plan
            .env
            .contains(&("OPENAI_MODEL".into(), "qwen3-coder".into())));
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("ANTHROPIC_")));
        assert_eq!(plan.args, vec!["--auth-type", "openai"]);
    }

    #[test]
    fn qwen_plan_anthropic_protocol() {
        let mut p = profile("qwen", Some("https://relay.example.com"));
        p.protocol = Some("anthropic".into());
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("claude-sonnet-4"));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_BASE_URL".into(), "https://relay.example.com".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_MODEL".into(), "claude-sonnet-4".into())));
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("OPENAI_")));
        assert_eq!(plan.args, vec!["--auth-type", "anthropic"]);
    }

    #[test]
    fn opencode_plan_inlines_config_json() {
        let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
        p.models = vec!["m1".into(), "m2".into()];
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("m2"));
        assert!(plan
            .env
            .contains(&("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into())));
        let (k, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("OPENCODE_CONFIG_CONTENT 应存在");
        assert_eq!(k, "OPENCODE_CONFIG_CONTENT");
        let config: serde_json::Value = serde_json::from_str(v).expect("应为合法 JSON");
        let ccode = &config["provider"]["ccode"];
        assert_eq!(ccode["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(ccode["options"]["baseURL"], "https://openrouter.ai/api/v1");
        assert_eq!(ccode["options"]["apiKey"], "sk-secret");
        assert!(ccode["models"]["m1"].is_object());
        assert!(ccode["models"]["m2"].is_object());
        assert_eq!(config["model"], "ccode/m2");
    }

    #[test]
    fn opencode_plan_without_model_omits_top_level_model() {
        let p = profile("opencode", None);
        let plan = launch_plan(&p, None, None);
        let (_, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(v).unwrap();
        assert!(config.get("model").is_none());
        // 没有 key/base_url 时 options 里不放这两个字段
        assert!(config["provider"]["ccode"]["options"].get("apiKey").is_none());
        assert!(config["provider"]["ccode"]["options"].get("baseURL").is_none());
    }

    #[test]
    fn kimi_plan_sets_both_env_groups() {
        let p = profile("kimi", Some("https://api.moonshot.cn/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("kimi-k2"));
        // 新版合成通道
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_NAME".into(), "kimi-k2".into())));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_PROVIDER_TYPE".into(), "kimi".into())));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_API_KEY".into(), "sk-secret".into())));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_BASE_URL".into(),
            "https://api.moonshot.cn/v1".into()
        )));
        // 旧版 Python CLI
        assert!(plan
            .env
            .contains(&("KIMI_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("KIMI_BASE_URL".into(), "https://api.moonshot.cn/v1".into())));
        assert!(plan.args.is_empty());
    }

    #[test]
    fn kimi_plan_respects_protocol_for_provider_type() {
        let mut p = profile("kimi", None);
        p.protocol = Some("anthropic".into());
        let plan = launch_plan(&p, None, Some("claude-sonnet-4"));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_PROVIDER_TYPE".into(), "anthropic".into())));
    }

    #[test]
    fn kimi_plan_without_model_skips_synthetic_channel() {
        let p = profile("kimi", Some("https://api.moonshot.cn/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), None);
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("KIMI_MODEL_")));
        // 旧版组不受模型缺失影响
        assert!(plan
            .env
            .contains(&("KIMI_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("KIMI_BASE_URL".into(), "https://api.moonshot.cn/v1".into())));
    }

    #[test]
    fn opencode_inject_json_registers_every_profile_model() {
        let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
        p.models = vec!["m1".into(), "m2".into(), "m3".into()];
        let plan = launch_plan(&p, None, Some("m2"));
        let (_, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(v).unwrap();
        let models = config["provider"]["ccode"]["models"].as_object().unwrap();
        for m in ["m1", "m2", "m3"] {
            assert!(models.contains_key(m), "provider.ccode.models 缺 {m}");
        }
    }

    #[test]
    fn codex_catalog_contains_every_model_with_template_shape() {
        let v = codex_catalog_json(&["gpt-5-codex".into(), "gpt-5.1".into()]);
        let models = v["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        let e = &models[0];
        assert_eq!(e["slug"], "gpt-5-codex");
        assert_eq!(e["display_name"], "gpt-5-codex");
        assert_eq!(models[1]["slug"], "gpt-5.1");
        // 关键枚举拼写与打包条目一致（codex-rs models-manager/models.json）
        assert_eq!(e["shell_type"], "shell_command");
        assert_eq!(e["visibility"], "list");
        assert_eq!(e["apply_patch_tool_type"], "freeform");
        assert_eq!(e["truncation_policy"]["mode"], "tokens");
        assert_eq!(e["default_verbosity"], "low");
        assert_eq!(e["supported_in_api"], true);
        let efforts: Vec<&str> = e["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|l| l["effort"].as_str())
            .collect();
        assert_eq!(efforts, ["low", "medium", "high"]);
    }

    #[test]
    fn codex_catalog_written_atomically() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("catalogs").join("codex-p1.json");
        write_codex_catalog_to(&path, &["m1".into()]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["models"][0]["slug"], "m1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_catalog_arg_is_toml_quoted() {
        let args = catalog_args(std::path::Path::new(
            "/Users/x/Library/Application Support/ccode/catalogs/codex-1.json",
        ));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        assert!(
            args[1].starts_with(r#"model_catalog_json=""#) && args[1].ends_with('"'),
            "路径必须是 TOML 字符串（带引号）: {}",
            args[1]
        );
        assert!(args[1].contains("codex-1.json"));
    }

    #[test]
    fn find_in_dirs_picks_first_existing_candidate() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let d1 = base.join("d1");
        let d2 = base.join("d2");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::create_dir_all(&d2).unwrap();
        std::fs::write(d1.join("tool"), "x").unwrap();
        std::fs::write(d2.join("tool"), "x").unwrap();
        // 两个目录都有同名文件时排前的目录胜出
        assert_eq!(
            find_in_dirs("tool", &[d1.clone(), d2.clone()]),
            Some(d1.join("tool"))
        );
        // 只在后一个候选目录存在也能找到（前面的目录 miss 不阻断）
        assert_eq!(
            find_in_dirs("tool", &[base.join("nope"), d2.clone()]),
            Some(d2.join("tool"))
        );
        // 目录不存在 / 文件不存在 → None
        assert_eq!(find_in_dirs("tool", &[base.join("nope")]), None);
        assert_eq!(find_in_dirs("ghost", &[d1.clone(), d2.clone()]), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(windows)]
    #[test]
    fn find_in_dirs_matches_exe_and_cmd_shims_on_windows() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        // npm 全局包在 Windows 上是 .cmd shim：裸名找不到、带扩展名能命中
        std::fs::write(base.join("tool.cmd"), "x").unwrap();
        assert_eq!(
            find_in_dirs("tool", &[base.clone()]),
            Some(base.join("tool.cmd"))
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolve_binary_returns_none_for_unknown_name() {
        // 名字足够独特：PATH 与各平台候选目录都不会有
        assert!(resolve_binary("ccode-no-such-binary-9f8e7d6c").is_none());
    }

    #[test]
    fn resume_command_line_formats_per_agent() {
        // 安全字符不加引号（cc-switch 风格）；codex 的 resume 子命令在最前
        assert_eq!(
            resume_command_line("codex", "019fbd46-bdc5", "/tmp/proj").unwrap(),
            "cd /tmp/proj && codex resume 019fbd46-bdc5"
        );
        assert_eq!(
            resume_command_line("claude-code", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && claude -r abc"
        );
        assert_eq!(
            resume_command_line("kimi", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && kimi -S abc"
        );
        assert_eq!(
            resume_command_line("opencode", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && opencode --session abc"
        );
        // 路径含空格/中文 → 单引号包裹
        assert_eq!(
            resume_command_line("codex", "abc", "/tmp/我的 项目").unwrap(),
            "cd '/tmp/我的 项目' && codex resume abc"
        );
        // 未知 agent 报错
        assert!(resume_command_line("no-such", "abc", "/tmp").is_err());
        // 外部拉起变体：给定绝对路径直接用
        assert_eq!(
            resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/.kimi-code/bin/kimi").unwrap(),
            "cd /tmp && /Users/x/.kimi-code/bin/kimi -S abc"
        );
    }

    #[test]
    fn sh_quote_if_needed_escapes_single_quote() {
        assert_eq!(sh_quote_if_needed("plain-1.x"), "plain-1.x");
        assert_eq!(sh_quote_if_needed("it's"), "'it'\\''s'");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candidate_dirs_cover_homebrew_prefixes() {
        let dirs = candidate_dirs();
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/opt/homebrew/bin")));
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/usr/local/bin")));
    }
}
