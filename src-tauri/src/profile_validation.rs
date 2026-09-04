//! Profile 三层验证：本地配置解析、CLI 启动预检、最小 models API 请求。
//! 密钥只在后端读取并注入请求/子进程，任何输出返回 React 前统一脱敏。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const API_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCheckDto {
    /// passed | failed | skipped
    pub status: String,
    pub message: String,
    pub latency_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationDto {
    pub ok: bool,
    pub checked_at: String,
    pub local: ValidationCheckDto,
    pub cli: ValidationCheckDto,
    pub api: ValidationCheckDto,
}

fn check(status: &str, message: impl Into<String>, latency_ms: Option<u128>) -> ValidationCheckDto {
    ValidationCheckDto {
        status: status.into(),
        message: crate::sessions::redact_sensitive_text(&message.into()),
        latency_ms,
    }
}

fn result(
    local: ValidationCheckDto,
    cli: ValidationCheckDto,
    api: ValidationCheckDto,
) -> ProfileValidationDto {
    let ok = [&local, &cli, &api]
        .iter()
        .all(|item| item.status != "failed");
    ProfileValidationDto {
        ok,
        checked_at: crate::sessions::now_iso(),
        local,
        cli,
        api,
    }
}

fn parse_json_file(path: &Path, label: &str) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取 {label} 失败: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{label} 不是合法 JSON: {e}"))?;
    if !value.is_object() {
        return Err(format!("{label} 根节点必须是对象"));
    }
    Ok(Some(label.into()))
}

fn parse_toml_file(path: &Path, label: &str) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取 {label} 失败: {e}"))?;
    text.parse::<toml::Value>()
        .map_err(|e| format!("{label} 不是合法 TOML: {e}"))?;
    Ok(Some(label.into()))
}

pub(crate) fn validate_profile_fields(profile: &Profile) -> Result<Vec<String>, String> {
    if agents::binary_for(&profile.agent).is_none() {
        return Err(format!("未知 agent: {}", profile.agent));
    }
    if profile.account_type == profiles::AccountType::Official && profile.no_auth {
        return Err("官方账号不能设置为无密钥模式".into());
    }
    if profile.name.trim().is_empty() {
        return Err("配置名称不能为空".into());
    }
    if let Some(base_url) = profile.base_url.as_deref() {
        let url = reqwest::Url::parse(base_url).map_err(|e| format!("API 地址格式错误: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("API 地址只支持 http/https".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("API 地址不得内嵌用户名或密码".into());
        }
    }
    // 协议取值校验：合法值与缺省（第一个）都来自 AgentSpec.protocols；空表 = 无协议概念
    if let Some(spec) = crate::agent_specs::agent_spec(&profile.agent) {
        if let Some(default) = spec.protocols.first() {
            let value = profile.protocol.as_deref().unwrap_or(default);
            if !spec.protocols.contains(&value) {
                return Err(format!("{} 不支持协议 {value}", spec.display_name));
            }
        }
    }
    // grok 的 API 后端（绑定级，仅设为全局写 [model.*] 段消费）：闭集 + 仅 grok
    if let Some(backend) = profile.api_backend.as_deref() {
        if profile.agent != "grok" {
            return Err("apiBackend 仅 Grok Build 支持".into());
        }
        const GROK_BACKENDS: [&str; 3] = ["chat_completions", "responses", "messages"];
        if !GROK_BACKENDS.contains(&backend) {
            return Err(format!(
                "Grok 不支持 API 后端 {backend}（可选 chat_completions / responses / messages）"
            ));
        }
    }
    for key in profile.extra_env.keys() {
        if key.trim().is_empty() || key.contains('=') || key.contains('\0') {
            return Err(format!("附加环境变量名不合法: {key:?}"));
        }
    }
    let policy = &profile.request_policy;
    if let Some(v) = policy.temperature {
        if !v.is_finite() || !(0.0..=2.0).contains(&v) {
            return Err("temperature 必须是 0 到 2 之间的有限数字".into());
        }
    }
    if let Some(v) = policy.top_p {
        if !v.is_finite() || !(0.0..=1.0).contains(&v) {
            return Err("topP 必须是 0 到 1 之间的有限数字".into());
        }
    }
    if matches!(policy.max_output_tokens, Some(0)) {
        return Err("maxOutputTokens 必须大于 0".into());
    }
    if policy.reasoning_effort.as_deref().is_some_and(|v| v.trim().is_empty()) {
        return Err("reasoningEffort 不能为空".into());
    }
    // claude-code 的 effort 档位有实证闭集（/effort 与 CLAUDE_CODE_EFFORT_LEVEL 同口径，
    // matrix §1 v2.1.212 strings 实证）——保存期拦掉无效值，免得启动才被 CLI 拒
    if profile.agent == "claude-code" {
        if let Some(v) = policy.reasoning_effort.as_deref() {
            const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
            if !EFFORTS.contains(&v) {
                return Err(format!(
                    "Claude Code 的 reasoningEffort 只接受 {}",
                    EFFORTS.join(" / ")
                ));
            }
        }
    }
    for (header, env_name) in &policy.header_env {
        // header 名禁冒号/引号/控制符（引号会撞 codex TOML 内联键的引号段）
        if header.trim().is_empty() || header.contains(['\r', '\n', ':', '"']) {
            return Err(format!("模型 Header 名不合法: {header:?}"));
        }
        // 环境变量名收 POSIX 字符集：值会进 codex -c 的 TOML 字符串与 shell，
        // 放宽字符集会留出注入面
        let valid_env_name = env_name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && env_name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_env_name {
            return Err(format!("模型 Header 环境变量名不合法: {env_name:?}"));
        }
    }
    if profile.no_auth {
        const AUTH_KEYS: &[&str] = &[
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN",
            "CURSOR_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "KIMI_API_KEY",
            "KIMI_MODEL_API_KEY", "OPENCODE_CONFIG_CONTENT",
        ];
        if let Some(key) = profile.extra_env.keys().find(|key| AUTH_KEYS.contains(&key.as_str())) {
            return Err(format!("无密钥模式不能附加认证变量 {key}"));
        }
    }
    if profile.extra_env.values().any(|value| value.contains('\0')) {
        return Err("附加环境变量值不得包含 NUL 字符".into());
    }
    let mut notes = Vec::new();
    let support = crate::agent_specs::request_policy_support(&profile.agent);
    let policy = &profile.request_policy;
    if policy.temperature.is_some()
        || policy.top_p.is_some()
        || policy.max_output_tokens.is_some()
        || policy.reasoning_effort.is_some()
        || !policy.header_env.is_empty()
    {
        notes.push("请求策略按能力表逐字段处理：有实证通道的字段在启动时注入（已接线 claude-code/codebuddy/codex/opencode/kimi/grok，qwen 仅 max output 一条 env），不支持或未知的字段仅保存声明、不会伪造注入".into());
    }
    // 通道表按入口记账（inject/persist/tui/unsupported/unknown），提示文案分入口
    let channel_note = |label: &str, status: &str| -> Option<String> {
        match status {
            "inject" => None,
            "persist" => Some(format!(
                "{label} 的通道是「设为全局默认」写入 CLI 配置文件；启动注入不携带此字段"
            )),
            "tui" => Some(format!(
                "{label} 仅支持会话内原生命令切换（如 /effort），启动与写盘均不携带"
            )),
            other => Some(format!(
                "当前 Agent 对 {label} 的协议支持状态为 {other}，不会由 Ccode 强行注入"
            )),
        }
    };
    if let Some(note) = policy
        .temperature
        .is_some()
        .then(|| channel_note("temperature", support.temperature))
        .flatten()
    {
        notes.push(note);
    }
    if let Some(note) = policy
        .top_p
        .is_some()
        .then(|| channel_note("topP", support.top_p))
        .flatten()
    {
        notes.push(note);
    }
    if let Some(note) = policy
        .max_output_tokens
        .is_some()
        .then(|| channel_note("maxOutputTokens", support.max_output_tokens))
        .flatten()
    {
        notes.push(note);
    }
    if let Some(note) = policy
        .reasoning_effort
        .is_some()
        .then(|| channel_note("reasoningEffort", support.reasoning_effort))
        .flatten()
    {
        notes.push(note);
    }
    if !policy.header_env.is_empty() {
        if let Some(note) = channel_note("模型自定义 Header", support.custom_headers) {
            notes.push(note);
        }
    }
    if profile.models.is_empty() {
        notes.push("未指定模型，将使用 CLI 自身默认值".into());
    }
    // grok 的 api_backend 只随设为全局落盘，启动注入不携带——只提醒不阻断
    if profile.agent == "grok" && profile.api_backend.is_some() {
        notes.push("API 后端（apiBackend）只在「设为全局默认」写入 ~/.grok/config.toml 后生效；启动注入不携带此设置".into());
    }
    // Anthropic 协议通道的 SDK 会在 Base URL 后自动拼 /v1/messages：base 以 /v1 结尾会打成
    // /v1/v1/messages 404（2026-08-28 实测），且「获取模型」（OpenAI 风格 {base}/models）照样成功，
    // 极具迷惑性——只提醒不阻断
    let anthropic_wire = matches!(profile.agent.as_str(), "claude-code" | "codebuddy")
        || profile.protocol.as_deref() == Some("anthropic");
    if anthropic_wire {
        if let Some(base) = profile.base_url.as_deref() {
            if base.trim_end_matches('/').ends_with("/v1") {
                notes.push(
                    "Base URL 以 /v1 结尾：Anthropic 客户端会自动拼 /v1/messages，实际请求将变成 /v1/v1/messages 报 404（此时「获取模型」仍能成功，不代表运行可用）——请去掉末尾的 /v1"
                        .into(),
                );
            }
        }
    }
    Ok(notes)
}

fn local_check_at(home: &Path, profile: &Profile) -> ValidationCheckDto {
    let started = Instant::now();
    let outcome = (|| -> Result<String, String> {
        let notes = validate_profile_fields(profile)?;
        let mut parsed = Vec::new();
        let mut add = |item: Result<Option<String>, String>| -> Result<(), String> {
            if let Some(label) = item? {
                parsed.push(label);
            }
            Ok(())
        };
        match profile.agent.as_str() {
            "claude-code" => add(parse_json_file(
                &home.join(".claude/settings.json"),
                "~/.claude/settings.json",
            ))?,
            "codex" => {
                add(parse_toml_file(
                    &home.join(".codex/config.toml"),
                    "~/.codex/config.toml",
                ))?;
                add(parse_json_file(
                    &home.join(".codex/auth.json"),
                    "~/.codex/auth.json",
                ))?;
            }
            "gemini" => add(parse_json_file(
                &home.join(".gemini/settings.json"),
                "~/.gemini/settings.json",
            ))?,
            "qwen" => add(parse_json_file(
                &home.join(".qwen/settings.json"),
                "~/.qwen/settings.json",
            ))?,
            "codebuddy" => add(parse_json_file(
                &home.join(".codebuddy/settings.json"),
                "~/.codebuddy/settings.json",
            ))?,
            // grok 主配置是 TOML（[model.<name>] 段的 base_url/env_key 线索在 profile 字段已验）
            "grok" => add(parse_toml_file(
                &home.join(".grok/config.toml"),
                "~/.grok/config.toml",
            ))?,
            // cursor 仅 AGENT_CLI_CREDENTIAL_STORE=file 时落 auth.json（默认在钥匙串）
            "cursor" => add(parse_json_file(
                &home.join(".cursor/auth.json"),
                "~/.cursor/auth.json",
            ))?,
            "opencode" => add(parse_json_file(
                &home.join(".config/opencode/opencode.json"),
                "~/.config/opencode/opencode.json",
            ))?,
            "kimi" => {
                add(parse_toml_file(
                    &home.join(".kimi-code/config.toml"),
                    "~/.kimi-code/config.toml",
                ))?;
                add(parse_toml_file(
                    &home.join(".kimi/config.toml"),
                    "~/.kimi/config.toml",
                ))?;
            }
            _ => {}
        }
        let mut message = if parsed.is_empty() {
            "Profile 字段合法；未发现该 CLI 的现有全局配置文件".to_string()
        } else {
            format!("Profile 字段合法；已解析 {}", parsed.join("、"))
        };
        if !notes.is_empty() {
            message.push_str(&format!("；{}", notes.join("；")));
        }
        Ok(message)
    })();
    match outcome {
        Ok(message) => check("passed", message, Some(started.elapsed().as_millis())),
        Err(message) => check("failed", message, Some(started.elapsed().as_millis())),
    }
}

fn tail_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

fn run_capture(cmd: &mut crate::process::BackgroundCommand, timeout: Duration) -> Result<String, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动 CLI 失败: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout.take() {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr.take() {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
        }
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
                let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
                let detail = if stderr.trim().is_empty() { stdout } else { stderr };
                if status.success() {
                    return Ok(tail_chars(detail.trim(), 1200));
                }
                return Err(format!(
                    "CLI 退出码 {:?}: {}",
                    status.code(),
                    tail_chars(detail.trim(), 1200)
                ));
            }
            Ok(None) if Instant::now() >= deadline => {
                // 连带杀子孙：Windows 上包装层（cmd /d /c call）之下的 CLI 才是持有
                // 管道写端的那个，只杀包装层会让下面两个 join 永久阻塞
                crate::pty::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                let _ = crate::process::join_with_timeout(out_handle, Duration::from_secs(2));
                let _ = crate::process::join_with_timeout(err_handle, Duration::from_secs(2));
                return Err(format!("CLI 预检超时（{} 秒）", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("等待 CLI 失败: {e}")),
        }
    }
}

fn codex_config_args(plan: &agents::LaunchPlan) -> Vec<String> {
    let mut args = Vec::new();
    let mut index = 0;
    while index < plan.args.len() {
        if plan.args[index] == "-c" && index + 1 < plan.args.len() {
            args.push("-c".into());
            args.push(plan.args[index + 1].clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    args
}

fn cli_check(profile: &Profile, key: Option<&str>, injected: bool) -> ValidationCheckDto {
    let started = Instant::now();
    let outcome = (|| -> Result<String, String> {
        let binary = agents::binary_for(&profile.agent).ok_or("该 agent 不支持 CLI 预检")?;
        let binary = agents::resolve_binary(binary).ok_or_else(|| format!("未找到 {binary} CLI"))?;
        let plan = agents::launch_plan(
            profile,
            key.map(ToOwned::to_owned),
            profile.models.first().map(String::as_str),
        );
        let mut cmd = crate::process::background_command(binary);
        if injected {
            for (name, value) in &plan.env {
                cmd.env(name, value);
            }
        }
        let description = match profile.agent.as_str() {
            "claude-code" if key.is_some() => {
                cmd.args(["auth", "status", "--json"]);
                "Claude auth status"
            }
            "claude-code" => {
                cmd.arg("--version");
                "Claude 启动预检（未配置密钥，跳过 auth status）"
            }
            "codex" => {
                if injected {
                    cmd.args(codex_config_args(&plan));
                }
                cmd.args(["doctor", "--json"]);
                "Codex doctor"
            }
            "opencode" => {
                cmd.args(["debug", "config"]);
                "OpenCode resolved config"
            }
            "kimi" => {
                cmd.arg("doctor");
                "Kimi doctor"
            }
            "gemini" => {
                cmd.arg("--version");
                "Gemini 启动预检（CLI 暂无 doctor）"
            }
            "qwen" => {
                cmd.arg("--version");
                "Qwen 启动预检（CLI 暂无 doctor）"
            }
            "codebuddy" => {
                cmd.arg("--version");
                "CodeBuddy 启动预检（CLI 暂无 doctor）"
            }
            "grok" => {
                cmd.arg("--version");
                "Grok 启动预检（CLI 暂无 doctor）"
            }
            "cursor" => {
                cmd.arg("--version");
                "Cursor 启动预检（CLI 暂无 doctor）"
            }
            _ => return Err("该 agent 不支持 CLI 预检".into()),
        };
        cmd.env("NO_COLOR", "1");
        let cwd = std::env::temp_dir().join(format!("ccode-validate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&cwd).map_err(|e| format!("创建预检目录失败: {e}"))?;
        cmd.current_dir(&cwd);
        let output = run_capture(&mut cmd, CLI_TIMEOUT);
        let _ = fs::remove_dir_all(&cwd);
        let output = output?;
        let suffix = output.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
        Ok(if suffix.is_empty() {
            format!("{description} 通过")
        } else {
            format!("{description} 通过：{suffix}")
        })
    })();
    match outcome {
        Ok(message) => check("passed", message, Some(started.elapsed().as_millis())),
        Err(message) => check("failed", message, Some(started.elapsed().as_millis())),
    }
}

#[derive(Clone, Copy)]
enum ApiKind {
    OpenAi,
    Anthropic,
    Gemini,
}

fn api_kind(profile: &Profile) -> ApiKind {
    match profile.agent.as_str() {
        // codebuddy 协议 Anthropic 兼容（docs 有 DeepSeek Anthropic 端点对接示例）
        "claude-code" | "codebuddy" => ApiKind::Anthropic,
        "gemini" => ApiKind::Gemini,
        "qwen" | "kimi" if profile.protocol.as_deref() == Some("anthropic") => {
            ApiKind::Anthropic
        }
        // grok 绑定声明了 messages 后端（仅设为全局写入生效）→ 探针走 Anthropic 形状
        "grok" if profile.api_backend.as_deref() == Some("messages") => ApiKind::Anthropic,
        _ => ApiKind::OpenAi,
    }
}

/// 协议族标签（profiles::copy_to_agent 的兼容性判定用）。与 api_kind 同口径，
/// 唯一差异是 cursor：api_kind 因 `_` 兜底落入 OpenAi 仅用于跳过云端验证，
/// 复制判定时 Cursor 是专有协议（见 api_check 注释），自成一族不与任何 agent 互通
pub(crate) fn api_kind_label(agent: &str, protocol: Option<&str>) -> &'static str {
    match agent {
        "claude-code" | "codebuddy" => "anthropic",
        "gemini" => "gemini",
        "cursor" => "cursor",
        "qwen" | "kimi" if protocol == Some("anthropic") => "anthropic",
        _ => "openai",
    }
}

fn default_base(profile: &Profile, kind: ApiKind) -> &'static str {
    match kind {
        // codebuddy 缺省端点：官方国际站（product.json 的 endpoint 字段）
        ApiKind::Anthropic if profile.agent == "codebuddy" => "https://www.codebuddy.ai",
        ApiKind::Anthropic => "https://api.anthropic.com/v1",
        ApiKind::Gemini => "https://generativelanguage.googleapis.com/v1beta",
        ApiKind::OpenAi if profile.agent == "kimi" => "https://api.moonshot.cn/v1",
        ApiKind::OpenAi if profile.agent == "grok" => "https://api.x.ai/v1",
        ApiKind::OpenAi => "https://api.openai.com/v1",
    }
}

fn models_url(base: &str, kind: ApiKind) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("API 地址格式错误: {e}"))?;
    let path = url.path().trim_end_matches('/');
    let suffix = match kind {
        ApiKind::Gemini if path.ends_with("/v1beta") || path.ends_with("/v1") => "models",
        ApiKind::Gemini => "v1beta/models",
        _ if path.ends_with("/v1") => "models",
        _ => "v1/models",
    };
    let next = if path.is_empty() {
        format!("/{suffix}")
    } else if path.ends_with("/models") {
        path.to_string()
    } else {
        format!("{path}/{suffix}")
    };
    url.set_path(&next);
    Ok(url)
}

fn model_ids(value: &serde_json::Value, kind: ApiKind) -> Vec<String> {
    let entries = match kind {
        ApiKind::Gemini => value.get("models"),
        _ => value.get("data"),
    };
    entries
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let key = if matches!(kind, ApiKind::Gemini) {
                "name"
            } else {
                "id"
            };
            item.get(key)
                .and_then(|value| value.as_str())
                .map(|value| value.trim_start_matches("models/").to_string())
        })
        .collect()
}

async fn api_check(profile: &Profile, key: Option<&str>) -> ValidationCheckDto {
    // Cursor 是专有协议（非 OpenAI/Anthropic 兼容），models 请求形态无从适配——
    // 不硬套三种 ApiKind，标记不支持云端验证，只给本地两层检查
    if profile.agent == "cursor" {
        return check(
            "skipped",
            "Cursor 为专有协议，不支持云端验证；以本地配置解析与 CLI 预检为准",
            None,
        );
    }
    let Some(key) = key.filter(|value| !value.trim().is_empty()) else {
        return check(
            "skipped",
            "未保存 API 密钥，无法验证 endpoint、密钥和模型（CLI 登录配置仍可单独使用）",
            None,
        );
    };
    let started = Instant::now();
    let outcome = async {
        let kind = api_kind(profile);
        let base = profile
            .base_url
            .as_deref()
            .unwrap_or_else(|| default_base(profile, kind));
        let mut url = models_url(base, kind)?;
        let client = reqwest::Client::builder()
            .timeout(API_TIMEOUT)
            .build()
            .map_err(|e| format!("创建 API 客户端失败: {e}"))?;
        let mut request = client.get(url.clone());
        match kind {
            ApiKind::OpenAi => {
                request = request.bearer_auth(key);
            }
            ApiKind::Anthropic => {
                request = request
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01");
            }
            ApiKind::Gemini => {
                url.query_pairs_mut().append_pair("key", key);
                request = client.get(url.clone());
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("无法访问 API endpoint: {e}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("读取 API 响应失败: {e}"))?;
        if !status.is_success() {
            let detail = tail_chars(body.trim(), 500);
            return Err(match status.as_u16() {
                401 | 403 => format!("密钥被端点拒绝（HTTP {status}）——密钥可能填错、过期或已被吊销，请核对后重新填写。{detail}"),
                404 | 405 => format!("模型列表接口不存在，可能是 endpoint 或协议不匹配（HTTP {status}）：{detail}"),
                _ => format!("API 返回 HTTP {status}：{detail}"),
            });
        }
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("API 响应不是预期 JSON，可能协议不匹配: {e}"))?;
        let ids = model_ids(&value, kind);
        if ids.is_empty() {
            return Err("endpoint 与密钥可访问，但响应中没有可识别的模型列表，无法确认协议和模型".into());
        }
        if let Some(model) = profile.models.first() {
            if !ids.iter().any(|id| id == model) {
                return Err(format!("密钥与 endpoint 可访问，但模型 {model} 不在返回列表中"));
            }
            Ok(format!("endpoint、密钥和模型 {model} 均通过"))
        } else {
            Ok(format!("endpoint 与密钥通过，共返回 {} 个模型", ids.len()))
        }
    }
    .await;
    match outcome {
        Ok(message) => check("passed", message, Some(started.elapsed().as_millis())),
        Err(message) => check("failed", message, Some(started.elapsed().as_millis())),
    }
}

// ===== 网关体检探针（2026-08-28）：绕过 CLI 直连端点发最小请求，观测裸响应 =====
// 回答「网关把请求怎么了」：流式还是整段、请求策略参数被接受还是被拒/触发降级。
// 探针只发 max_tokens=16 的 ping，单次成本可忽略；它证明的是「网关对这种请求的行为」，
// 是 CLI 实际流量的强代理证据（要 100% 还原 CLI 流量只能靠 CLI 自身 debug 日志，不属于本探针）。
// 密钥不出本模块；所有出站文案经 check() 统一脱敏。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayProbeDto {
    pub ok: bool,
    pub model: String,
    pub checks: Vec<ValidationCheckDto>,
}

/// 对话端点 URL：与 models_url 同口径——base 已含 /v1（gemini /v1beta）直接拼资源名，
/// 否则补协议默认版本段
fn chat_url(base: &str, kind: ApiKind) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("API 地址格式错误: {e}"))?;
    let path = url.path().trim_end_matches('/');
    let (version, resource) = match kind {
        ApiKind::Anthropic => ("v1", "messages"),
        ApiKind::OpenAi => ("v1", "chat/completions"),
        ApiKind::Gemini => return Err("Gemini 协议暂不支持探针".into()),
    };
    let next = if path.ends_with("/v1") || path.ends_with("/v1beta") {
        format!("{path}/{resource}")
    } else if path.is_empty() {
        format!("/{version}/{resource}")
    } else {
        format!("{path}/{version}/{resource}")
    };
    url.set_path(&next);
    Ok(url)
}

/// 探针请求体：stream 控制流式；with_policy 时把 profile 请求策略按协议字段名带上。
/// anthropic 的 effort 没有线协议字段，CLI 内部翻译成 thinking 块——探针同样翻译成
/// thinking.enabled（budget 1024，max_tokens 同步抬到 2048 满足 > budget 的协议要求）
fn probe_body(
    kind: ApiKind,
    model: &str,
    policy: &profiles::RequestPolicy,
    with_policy: bool,
    stream: bool,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "stream": stream,
    });
    let max_tokens = if with_policy {
        policy.max_output_tokens.unwrap_or(16)
    } else {
        16
    };
    match kind {
        ApiKind::Anthropic => {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }
        _ => {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }
    }
    if with_policy {
        if let Some(v) = policy.temperature {
            body["temperature"] = serde_json::json!(v);
        }
        if let Some(v) = policy.top_p {
            body["top_p"] = serde_json::json!(v);
        }
        if let Some(effort) = policy.reasoning_effort.as_deref() {
            match kind {
                ApiKind::Anthropic => {
                    body["thinking"] =
                        serde_json::json!({ "type": "enabled", "budget_tokens": 1024 });
                    if max_tokens <= 1024 {
                        body["max_tokens"] = serde_json::json!(2048);
                    }
                    let _ = effort; // 档位本身不进 anthropic 请求体，只体现为 thinking 开关
                }
                _ => {
                    body["reasoning_effort"] = serde_json::json!(effort);
                }
            }
        }
    }
    body
}

struct ProbeOutcome {
    status: reqwest::StatusCode,
    /// content-type 含 event-stream
    sse: bool,
    content_type: String,
    /// 非 2xx 时的响应尾部（截断）
    error_tail: String,
}

async fn send_probe(request: reqwest::RequestBuilder) -> Result<ProbeOutcome, String> {
    let response = request
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let sse = content_type.contains("event-stream");
    // SSE 成功响应不读全文（流会挂住）；只在非 2xx 时取错误尾部
    let error_tail = if status.is_success() {
        String::new()
    } else {
        tail_chars(
            response
                .text()
                .await
                .unwrap_or_default()
                .trim(),
            300,
        )
    };
    Ok(ProbeOutcome { status, sse, content_type, error_tail })
}

#[tauri::command]
pub async fn probe_gateway(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<GatewayProbeDto, String> {
    let profile = store.get(&profile_id)?;
    probe_loaded_profile(&store, profile, model, false).await
}

#[tauri::command]
pub async fn probe_gateway_slot(
    store: tauri::State<'_, ProfileStore>,
    gateway_id: String,
    slot: String,
    model: Option<String>,
    basic_only: Option<bool>,
) -> Result<GatewayProbeDto, String> {
    let slot = crate::gateway_store::Slot::from_str(&slot).ok_or_else(|| format!("未知协议槽: {slot}"))?;
    let gateways = store.list_gateways()?;
    let gw = gateways
        .iter()
        .find(|g| g.id == gateway_id)
        .ok_or("网关不存在")?
        .clone();
    let model = Some(default_probe_model(&gw, slot, model));
    let binding = crate::profiles::Binding {
        id: format!("probe-{}", gw.id),
        agent: crate::gateway_store::agent_for_slot(slot).into(),
        kind: crate::profiles::BindingKind::Api,
        gateway_id: Some(gw.id.clone()),
        protocol: None,
        api_backend: None,
        models: gw.models.iter().map(|m| m.id.clone()).collect(),
        extra_env: Default::default(),
        last_used_at: None,
    };
    let mut profile = crate::gateway_store::materialize(&binding, Some(&gw), model.as_deref());
    profile.has_key = gw.key_hint.is_some();
    probe_loaded_profile(&store, profile, model, basic_only.unwrap_or(false)).await
}

fn default_probe_model(
    gw: &crate::profiles::Gateway,
    slot: crate::gateway_store::Slot,
    explicit: Option<String>,
) -> String {
    if let Some(m) = explicit.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return m;
    }
    if let Ok(bindings) = crate::gateway_store::load_bindings() {
        for b in bindings {
            if b.gateway_id.as_deref() != Some(gw.id.as_str()) {
                continue;
            }
            if crate::gateway_store::slot_for_agent(&b.agent, b.protocol.as_deref()) != slot {
                continue;
            }
            if let Some(m) = b.models.iter().find(|s| !s.is_empty()) {
                return m.clone();
            }
        }
    }
    gw.models
        .iter()
        .map(|m| m.id.clone())
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

async fn probe_loaded_profile(
    store: &ProfileStore,
    profile: crate::profiles::Profile,
    model: Option<String>,
    basic_only: bool,
) -> Result<GatewayProbeDto, String> {
    let key = profiles::get_key_for_profile(&profile)?;
    if profile.agent == "cursor" {
        return Err("Cursor 为专有协议，不支持网关体检".into());
    }
    let kind = api_kind(&profile);
    if matches!(kind, ApiKind::Gemini) {
        return Err("Gemini 协议暂不支持网关体检".into());
    }
    let model = model
        .or_else(|| profile.models.first().cloned())
        .filter(|m| !m.trim().is_empty())
        .ok_or("请先在配置里填写模型")?;
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or_else(|| default_base(&profile, kind))
        .to_string();
    let url = chat_url(&base, kind)?;
    let client = reqwest::Client::builder()
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 API 客户端失败: {e}"))?;

    // 鉴权镜像 CLI 真实形态：Ccode 给 claude 注入的是 ANTHROPIC_AUTH_TOKEN（Bearer），
    // 探针同口径；codebuddy 协议 Anthropic 兼容同走 Bearer
    let build = |body: serde_json::Value, with_headers: bool| {
        let mut req = client.post(url.clone()).json(&body);
        if let Some(k) = key.as_deref().filter(|k| !k.trim().is_empty()) {
            req = match kind {
                ApiKind::Anthropic => req
                    .bearer_auth(k)
                    .header("anthropic-version", "2023-06-01"),
                _ => req.bearer_auth(k),
            };
        }
        if with_headers {
            // Header 名=环境变量名引用，值从进程环境解析（与启动注入同口径）
            for (header, env_name) in &profile.request_policy.header_env {
                if let Ok(value) = std::env::var(env_name) {
                    if !value.is_empty() {
                        req = req.header(header, value);
                    }
                }
            }
        }
        req
    };

    let policy = &profile.request_policy;
    let has_policy = policy.temperature.is_some()
        || policy.top_p.is_some()
        || policy.max_output_tokens.is_some()
        || policy.reasoning_effort.is_some();
    let mut checks = Vec::new();

    // ① 基础请求：鉴权 + 模型存在（不流式、不带策略）
    let started = Instant::now();
    let basic = send_probe(build(probe_body(kind, &model, policy, false, false), false)).await;
    let basic_ok = matches!(&basic, Ok(o) if o.status.is_success());
    checks.push(match &basic {
        Ok(o) if o.status.is_success() => check(
            "passed",
            "基础请求",
            Some(started.elapsed().as_millis()),
        ),
        Ok(o) => check(
            "failed",
            format!("基础请求 HTTP {}：{}", o.status, o.error_tail),
            Some(started.elapsed().as_millis()),
        ),
        Err(e) => check("failed", format!("基础请求：{e}"), Some(started.elapsed().as_millis())),
    });
    let basic_latency = checks
        .last()
        .and_then(|c| c.latency_ms)
        .map(|n| n as u64);
    if !basic_ok {
        // 基础请求挂了，流式/参数探测无意义
        for label in ["流式响应", "请求策略参数", "自定义 Header"] {
            checks.push(check("skipped", format!("{label}：基础请求未通过，跳过"), None));
        }
        persist_slot_probe(store, &profile, &model, &base, key.as_deref(), &checks, basic_latency, basic_only);
        return Ok(GatewayProbeDto { ok: false, model, checks });
    }
    if basic_only {
        persist_slot_probe(store, &profile, &model, &base, key.as_deref(), &checks, basic_latency, true);
        return Ok(GatewayProbeDto { ok: true, model, checks });
    }

    // ② 流式：裸 stream:true，看网关回不回 SSE
    let started = Instant::now();
    let bare_stream = send_probe(build(probe_body(kind, &model, policy, false, true), false)).await;
    let bare_sse = matches!(&bare_stream, Ok(o) if o.status.is_success() && o.sse);
    checks.push(match &bare_stream {
        Ok(o) if o.status.is_success() && o.sse => {
            check("passed", "流式响应：网关返回 SSE", Some(started.elapsed().as_millis()))
        }
        Ok(o) if o.status.is_success() => check(
            "failed",
            format!(
                "流式响应：HTTP 200 但非 SSE（content-type: {}），该模型/端点不流式",
                o.content_type
            ),
            Some(started.elapsed().as_millis()),
        ),
        Ok(o) => check(
            "failed",
            format!("流式响应 HTTP {}：{}", o.status, o.error_tail),
            Some(started.elapsed().as_millis()),
        ),
        Err(e) => check("failed", format!("流式响应：{e}"), Some(started.elapsed().as_millis())),
    });

    // ③ 请求策略参数：带上策略再发流式，对比 ② 定位「加参数就不流式」
    let started = Instant::now();
    if !has_policy {
        checks.push(check("skipped", "请求策略参数：未配置请求策略字段", None));
    } else {
        let with_policy =
            send_probe(build(probe_body(kind, &model, policy, true, true), false)).await;
        checks.push(match &with_policy {
            Ok(o) if o.status.is_success() && o.sse => check(
                "passed",
                "请求策略参数：被接受且保持流式",
                Some(started.elapsed().as_millis()),
            ),
            Ok(o) if o.status.is_success() => check(
                "failed",
                "请求策略参数：被接受（HTTP 200）但响应不再流式——疑似网关对带参请求降级，这正是不流式的触发源",
                Some(started.elapsed().as_millis()),
            ),
            Ok(o) => check(
                "failed",
                format!("请求策略参数：被拒（HTTP {}）：{}", o.status, o.error_tail),
                Some(started.elapsed().as_millis()),
            ),
            Err(e) => check(
                "failed",
                format!("请求策略参数：{e}"),
                Some(started.elapsed().as_millis()),
            ),
        });
    }

    // ④ 自定义 Header：带上解析后的 header 发一次基础请求
    let started = Instant::now();
    if policy.header_env.is_empty() {
        checks.push(check("skipped", "自定义 Header：未配置", None));
    } else {
        let unresolved: Vec<&str> = policy
            .header_env
            .values()
            .filter(|var| std::env::var(var).map(|v| v.is_empty()).unwrap_or(true))
            .map(String::as_str)
            .collect();
        let with_headers =
            send_probe(build(probe_body(kind, &model, policy, false, false), true)).await;
        let suffix = if unresolved.is_empty() {
            String::new()
        } else {
            format!("；环境变量 {} 未设置，对应 Header 未发送", unresolved.join("、"))
        };
        checks.push(match &with_headers {
            Ok(o) if o.status.is_success() => check(
                "passed",
                format!("自定义 Header：网关接受{suffix}"),
                Some(started.elapsed().as_millis()),
            ),
            Ok(o) => check(
                "failed",
                format!("自定义 Header：HTTP {}：{}{}", o.status, o.error_tail, suffix),
                Some(started.elapsed().as_millis()),
            ),
            Err(e) => check(
                "failed",
                format!("自定义 Header：{e}{suffix}"),
                Some(started.elapsed().as_millis()),
            ),
        });
    }

    let ok = checks.iter().all(|c| c.status != "failed");
    if let Some(gid) = profile.gateway_id.clone() {
        let slot = crate::gateway_store::slot_for_agent(&profile.agent, profile.protocol.as_deref());
        let st = |prefix: &str| -> crate::profiles::ProbeStatus {
            match checks.iter().find(|c| c.message.starts_with(prefix)) {
                Some(c) if c.status == "passed" => crate::profiles::ProbeStatus::Passed,
                Some(c) if c.status == "failed" => crate::profiles::ProbeStatus::Failed,
                _ => crate::profiles::ProbeStatus::Never,
            }
        };
        let rec = crate::profiles::ProbeRecord {
            slot: slot.as_str().into(),
            model: Some(model.clone()),
            url_fp: format!("{:x}", md5::compute(base.as_bytes())),
            key_fp: if key.as_deref().is_some_and(|k| !k.is_empty()) {
                "has".into()
            } else {
                "none".into()
            },
            streaming: st("流式"),
            effort: st("请求策略"),
            headers: st("自定义 Header"),
            basic: st("基础请求"),
            probed_at: crate::sessions::now_iso(),
            latency_ms: checks
                .iter()
                .find(|c| c.message.starts_with("基础请求"))
                .and_then(|c| c.latency_ms)
                .map(|n| n as u64),
        };
        let _ = store.record_probe(&gid, rec);
    }
    Ok(GatewayProbeDto { ok, model, checks })
}

fn persist_slot_probe(
    store: &ProfileStore,
    profile: &crate::profiles::Profile,
    model: &str,
    base: &str,
    key: Option<&str>,
    checks: &[ValidationCheckDto],
    latency_ms: Option<u64>,
    basic_only: bool,
) {
    let Some(gid) = profile.gateway_id.clone() else {
        return;
    };
    let slot = crate::gateway_store::slot_for_agent(&profile.agent, profile.protocol.as_deref());
    let st = |prefix: &str| -> crate::profiles::ProbeStatus {
        match checks.iter().find(|c| c.message.starts_with(prefix)) {
            Some(c) if c.status == "passed" => crate::profiles::ProbeStatus::Passed,
            Some(c) if c.status == "failed" => crate::profiles::ProbeStatus::Failed,
            _ => crate::profiles::ProbeStatus::Never,
        }
    };
    let mut rec = crate::profiles::ProbeRecord {
        slot: slot.as_str().into(),
        model: Some(model.to_string()),
        url_fp: format!("{:x}", md5::compute(base.as_bytes())),
        key_fp: if key.is_some_and(|k| !k.is_empty()) {
            "has".into()
        } else {
            "none".into()
        },
        streaming: st("流式"),
        effort: st("请求策略"),
        headers: st("自定义 Header"),
        basic: st("基础请求"),
        probed_at: crate::sessions::now_iso(),
        latency_ms,
    };
    if basic_only {
        if let Ok(gws) = crate::gateway_store::load_gateways() {
            if let Some(prev) = gws
                .iter()
                .find(|g| g.id == gid)
                .and_then(|g| {
                    g.last_probe
                        .iter()
                        .filter(|p| p.slot == rec.slot)
                        .max_by_key(|p| p.probed_at.as_str())
                })
            {
                rec.streaming = prev.streaming;
                rec.effort = prev.effort;
                rec.headers = prev.headers;
            }
        }
    }
    let _ = store.record_probe(&gid, rec);
}

pub(crate) fn validate_after_global_write(
    profile: &Profile,
    key: Option<&str>,
) -> ProfileValidationDto {
    let local = match dirs::home_dir() {
        Some(home) => local_check_at(&home, profile),
        None => check("failed", "无法确定用户主目录", None),
    };
    let cli = cli_check(profile, key, false);
    let api = check("skipped", "全局写入后仅自动检查本地配置与 CLI；可点击“验证”执行 API 请求", None);
    result(local, cli, api)
}

#[tauri::command]
pub async fn validate_profile(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<ProfileValidationDto, String> {
    let profile = store.get(&profile_id)?;
    let key = profiles::get_key_for_profile(&profile)?;
    let local_profile = profile.clone();
    let local = tauri::async_runtime::spawn_blocking(move || match dirs::home_dir() {
        Some(home) => local_check_at(&home, &local_profile),
        None => check("failed", "无法确定用户主目录", None),
    })
    .await
    .map_err(|e| e.to_string())?;
    let cli_profile = profile.clone();
    let cli_key = key.clone();
    let cli = tauri::async_runtime::spawn_blocking(move || {
        cli_check(&cli_profile, cli_key.as_deref(), true)
    })
    .await
    .map_err(|e| e.to_string())?;
    let api = if local.status == "failed" {
        check("skipped", "请先修复本地配置解析错误，再执行 API 验证", None)
    } else {
        api_check(&profile, key.as_deref()).await
    };
    Ok(result(local, cli, api))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(agent: &str) -> Profile {
        Profile {
            id: "p".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some("https://relay.example.com/v1".into()),
            models: vec!["model-a".into()],
            extra_env: Default::default(),
            request_policy: crate::profiles::RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: true,
            gateway_id: None,
            slot_missing: false,
            provider_override: None,
        }
    }

    #[test]
    fn models_url_preserves_gateway_prefix() {
        assert_eq!(
            models_url("https://relay.example.com/gateway/v1", ApiKind::OpenAi)
                .unwrap()
                .as_str(),
            "https://relay.example.com/gateway/v1/models"
        );
        assert_eq!(
            models_url("https://relay.example.com/gemini", ApiKind::Gemini)
                .unwrap()
                .as_str(),
            "https://relay.example.com/gemini/v1beta/models"
        );
    }

    #[test]
    fn request_policy_ranges_and_header_references_are_validated() {
        let mut p = profile("claude-code");
        p.request_policy.temperature = Some(2.1);
        assert!(validate_profile_fields(&p).is_err());
        p.request_policy.temperature = Some(0.7);
        p.request_policy.top_p = Some(1.1);
        assert!(validate_profile_fields(&p).is_err());
        p.request_policy.top_p = Some(0.9);
        p.request_policy.header_env.insert("X-Relay-Key".into(), "RELAY_KEY".into());
        assert!(validate_profile_fields(&p).is_ok());
        p.request_policy.header_env.insert("Bad:Header".into(), "RELAY_KEY".into());
        assert!(validate_profile_fields(&p).is_err());
    }

    #[test]
    fn unsupported_request_policy_is_a_warning_not_silent_success() {
        let mut p = profile("codex");
        p.request_policy.temperature = Some(0.2);
        let notes = validate_profile_fields(&p).unwrap();
        assert!(notes.iter().any(|n| n.contains("temperature")));
    }

    #[test]
    fn anthropic_base_url_trailing_v1_is_warned_not_blocked() {
        // /v1 结尾会被 SDK 拼成 /v1/v1/messages 404：给提醒但保存不阻断
        let mut p = profile("claude-code");
        p.base_url = Some("https://relay.example.com/v1".into());
        let notes = validate_profile_fields(&p).unwrap();
        assert!(notes.iter().any(|n| n.contains("/v1/v1/messages")));
        // 不带 /v1 不提醒；非 Anthropic 通道（如 codex 的 OpenAI 系 /v1 惯例）不提醒
        p.base_url = Some("https://relay.example.com".into());
        assert!(!validate_profile_fields(&p).unwrap().iter().any(|n| n.contains("/v1/v1")));
        let mut c = profile("codex");
        c.base_url = Some("https://relay.example.com/v1".into());
        assert!(!validate_profile_fields(&c).unwrap().iter().any(|n| n.contains("/v1/v1")));
    }

    #[test]
    fn claude_effort_closed_set_is_validated() {
        let mut p = profile("claude-code");
        p.request_policy.reasoning_effort = Some("ultra".into());
        assert!(validate_profile_fields(&p).is_err());
        p.request_policy.reasoning_effort = Some("xhigh".into());
        assert!(validate_profile_fields(&p).is_ok());
        // 其他 agent 不套用 claude 的档位闭集
        let mut k = profile("kimi");
        k.request_policy.reasoning_effort = Some("ultra".into());
        assert!(validate_profile_fields(&k).is_ok());
    }

    #[test]
    fn local_check_reports_invalid_cli_config() {
        let home = std::env::temp_dir().join(format!("ccode-profile-check-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(home.join(".kimi-code")).unwrap();
        fs::write(home.join(".kimi-code/config.toml"), "[providers.bad\n").unwrap();
        let result = local_check_at(&home, &profile("kimi"));
        assert_eq!(result.status, "failed");
        assert!(result.message.contains("不是合法 TOML"));
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn profile_fields_reject_protocol_and_embedded_credentials() {
        let mut qwen = profile("qwen");
        qwen.protocol = Some("gemini".into());
        assert!(validate_profile_fields(&qwen).unwrap_err().contains("不支持协议"));
        qwen.protocol = Some("openai".into());
        qwen.base_url = Some("https://user:pass@example.com/v1".into());
        assert!(validate_profile_fields(&qwen)
            .unwrap_err()
            .contains("不得内嵌"));
    }

    #[test]
    fn model_ids_support_openai_anthropic_and_gemini_shapes() {
        let openai = serde_json::json!({"data": [{"id": "m1"}]});
        let gemini = serde_json::json!({"models": [{"name": "models/gemini-2.5-pro"}]});
        assert_eq!(model_ids(&openai, ApiKind::OpenAi), vec!["m1"]);
        assert_eq!(model_ids(&openai, ApiKind::Anthropic), vec!["m1"]);
        assert_eq!(model_ids(&gemini, ApiKind::Gemini), vec!["gemini-2.5-pro"]);
    }
}
