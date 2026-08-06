use crate::agent_specs::{agent_spec, AgentSpec, LaunchSpec, SpecialLaunch};
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
    /// 必须从继承环境中剔除的变量（官方账号模式：防 shell 残留 API key 静默覆盖账号登录）
    pub env_remove: Vec<String>,
    /// 初始 prompt（一键开步首条指令）的参数形态；pty_spawn 追加在全部参数之后，
    /// 保证位置参数语义（codex 的 -c/-m/-s、claude 的 --session-id 都在它前面）
    pub prompt_args: Vec<String>,
    /// 请求了初始 prompt 但该 CLI 不支持注入（PromptInject::Unsupported / 未知 agent），
    /// 前端据此提示「请手动发送」
    pub prompt_dropped: bool,
}

/// 解析 CLI 二进制的绝对路径：先 which（继承进程 PATH），miss 时按平台查常见
/// 安装目录兜底。背景：macOS 打包版从 Finder 启动时 PATH 很短（/usr/bin:/bin），
/// brew/npm 装的 CLI 不在其中（AGENTS.md 本机环境档案「GUI 应用 PATH 很短」）。
/// 所有二进制定位一律走这里，不再直接 which / 裸名 spawn。
pub fn resolve_binary(name: &str) -> Option<std::path::PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    find_in_dirs(name, &crate::agent_specs::binary_candidate_dirs())
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

/// --version 探测的统一超时：正常 CLI 毫秒级返回，卡死的 CLI 不能拖住检测/更新流程
pub(crate) const VERSION_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 带超时跑 `<binary> --version` 并取首行输出；超时或失败杀掉子进程返回 None。
/// agents::detect 与 updater::version_of 共用（原实现无超时，CLI 卡死会无限阻塞）
pub(crate) fn version_with_timeout(
    path: &std::path::Path,
    timeout: std::time::Duration,
) -> Option<String> {
    version_args_with_timeout(path, &["--version"], timeout)
}

/// 探测参数来自 AgentSpec.version_args（八个 CLI 目前都是 --version）
fn version_args_with_timeout(
    path: &std::path::Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Option<String> {
    let mut child = Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    // 进程已退出：输出躺在管道缓冲里，读到 EOF 不会阻塞（--version 输出远小于缓冲）
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.lines().next().unwrap_or("").to_string())
    }
}

fn detect(spec: &AgentSpec) -> (Option<String>, Option<String>) {
    let path = match resolve_binary(spec.binary) {
        Some(p) => p,
        None => return (None, None),
    };
    let version = version_args_with_timeout(&path, spec.version_args, VERSION_QUERY_TIMEOUT);
    (Some(path.to_string_lossy().into_owned()), version)
}

/// 把 profile + 钥匙串密钥翻译成启动 env/args。key 只在启动时刻读取，不外传。
/// model 为启动时选中的模型（调用方已兜底为 profile 模型列表的首个）。
/// env 名/固定参数等差异化数据全部来自 AgentSpec（agent_specs.rs）；
/// 只有无法纯数据化的注入形态保留分支逻辑（SpecialLaunch 各变体）。
pub fn launch_plan(profile: &Profile, key: Option<String>, model: Option<&str>) -> LaunchPlan {
    let mut plan = LaunchPlan::default();
    // 官方账号模式：不注入 base_url/密钥（用 CLI 自己的账号登录），仅按需注入选中模型；
    // 并按规格 purge 继承环境里的残留 API 密钥变量（防静默覆盖账号登录，§11.7）
    if profile.account_type == crate::profiles::AccountType::Official {
        if let Some(spec) = agent_spec(&profile.agent) {
            apply_official_inject(&mut plan, spec, profile, model);
        }
        // extra_env 依旧最后注入（用户显式覆盖的逃生口，与 api 模式一致）
        for (k, v) in &profile.extra_env {
            plan.env.push((k.clone(), v.clone()));
        }
        return plan;
    }
    if let Some(spec) = agent_spec(&profile.agent) {
        match &spec.launch {
            LaunchSpec::Env(env) => {
                apply_env_inject(&mut plan, env, profile, key.as_deref(), model)
            }
            LaunchSpec::ByProtocol(entries) => {
                // 缺省 = 协议表第一个；未支持的取值（gemini/vertex-ai 暂不支持）也按第一个注入
                let default = spec.protocols.first().copied().unwrap_or("");
                let proto = profile.protocol.as_deref().unwrap_or(default);
                let entry = entries
                    .iter()
                    .find(|e| e.protocol == proto)
                    .or_else(|| entries.first());
                if let Some(entry) = entry {
                    apply_env_inject(&mut plan, &entry.env, profile, key.as_deref(), model);
                    for arg in entry.args {
                        plan.args.push((*arg).into());
                    }
                }
            }
            LaunchSpec::Special(special) => match special {
                SpecialLaunch::ClaudeModelSlots(env) => {
                    apply_env_inject(&mut plan, env, profile, key.as_deref(), model);
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
                SpecialLaunch::CodexInlineProvider { key_env, sandbox_args } => {
                    if let Some(key) = key {
                        plan.env.push(((*key_env).into(), key));
                    }
                    // Codex 没有 base URL 环境变量，且只支持 Responses API：
                    // 用 -c 内联定义一个名为 ccode 的 provider 并指到它
                    if let Some(url) = &profile.base_url {
                        for kv in [
                            r#"model_providers.ccode.name="Ccode""#.to_string(),
                            format!(r#"model_providers.ccode.base_url="{url}""#),
                            format!(r#"model_providers.ccode.env_key="{key_env}""#),
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
                    for arg in *sandbox_args {
                        plan.args.push((*arg).into());
                    }
                }
                SpecialLaunch::OpenCodeInlineConfig { config_env, no_autoupdate_env } => {
                    // OpenCode 没有通用 key/baseURL 环境变量：用 OPENCODE_CONFIG_CONTENT 内联配置注入，
                    // 该层优先级高于 auth.json 和 env（matrix §5），行为确定
                    let provider = opencode_provider_json(profile, key.as_deref(), model);
                    let mut config = serde_json::json!({ "provider": { "ccode": provider } });
                    if let Some(m) = model {
                        config["model"] = serde_json::json!(format!("ccode/{m}"));
                    }
                    plan.env.push(((*config_env).into(), config.to_string()));
                    // 防止自更新在启动时替换掉我们检测到的二进制
                    plan.env.push(((*no_autoupdate_env).into(), "1".into()));
                }
                SpecialLaunch::KimiDualChannel => {
                    // 新旧两个产品共用 kimi 命令：新版故意忽略 shell env 的 API key，只认
                    // KIMI_MODEL_* 合成通道；旧版读 KIMI_API_KEY/KIMI_BASE_URL。
                    // 两组都设，各变体忽略自己不读的；KIMI_MODEL_NAME 两边通用。
                    // 新版通道需模型名才启用：无模型时整组跳过，回落到用户自己的配置。
                    // env 名留在代码里：双通道的条件结构无法纯数据化
                    if let Some(model) = model {
                        plan.env.push(("KIMI_MODEL_NAME".into(), model.into()));
                        plan.env.push((
                            "KIMI_MODEL_PROVIDER_TYPE".into(),
                            profile
                                .protocol
                                .clone()
                                .unwrap_or_else(|| spec.protocols.first().copied().unwrap_or("kimi").into()),
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
                SpecialLaunch::CursorFlags { key_env, endpoint_env, model_flag } => {
                    // key/端点走 env（CURSOR_API_KEY / CURSOR_API_ENDPOINT，仅非空时注入）；
                    // 模型没有 env，只能追加 --model <name> flag（bracket 参数化原样透传）
                    if let Some(key) = key {
                        plan.env.push(((*key_env).into(), key));
                    }
                    if let Some(url) = &profile.base_url {
                        plan.env.push(((*endpoint_env).into(), url.clone()));
                    }
                    if let Some(model) = model {
                        plan.args.push((*model_flag).into());
                        plan.args.push(model.into());
                    }
                }
            },
        }
    }
    // 附加环境变量放在最后：CommandBuilder 重复 env 后者生效，用户可借此覆盖 adapter 内置值
    for (k, v) in &profile.extra_env {
        plan.env.push((k.clone(), v.clone()));
    }
    plan
}

/// 带初始 prompt 的启动计划（一键开步首条指令）：api / 官方账号两种模式同样适用。
/// 注入形态读注册表 prompt_inject：Positional → prompt_args 单元素（pty_spawn 放最后），
/// Flag → `-i <prompt>`；Unsupported 或未知 agent 不注入并置 prompt_dropped 标记。
pub fn launch_plan_with_prompt(
    profile: &Profile,
    key: Option<String>,
    model: Option<&str>,
    initial_prompt: Option<&str>,
) -> LaunchPlan {
    let mut plan = launch_plan(profile, key, model);
    let Some(prompt) = initial_prompt.map(str::trim).filter(|p| !p.is_empty()) else {
        return plan;
    };
    match agent_spec(&profile.agent).map(|s| s.prompt_inject) {
        Some(crate::agent_specs::PromptInject::Positional) => {
            plan.prompt_args.push(prompt.into());
        }
        Some(crate::agent_specs::PromptInject::Flag(flag)) => {
            plan.prompt_args.push(flag.into());
            plan.prompt_args.push(prompt.into());
        }
        // 该 CLI 无交互模式初始 prompt 参数（kimi/opencode）：不注入，让前端提示手动发送
        Some(crate::agent_specs::PromptInject::Unsupported) | None => {
            plan.prompt_dropped = true;
        }
    }
    plan
}

/// 官方账号模式的注入：purge 残留密钥 env（规格 env_purge_list），模型非空才注入模型 env/参数。
/// 凭证与 base URL 一律不注入——认证完全交给 CLI 自己的账号登录
fn apply_official_inject(
    plan: &mut LaunchPlan,
    spec: &AgentSpec,
    profile: &Profile,
    model: Option<&str>,
) {
    if let Some(oa) = &spec.official_account {
        for var in oa.env_purge_list {
            plan.env_remove.push((*var).into());
        }
    }
    match &spec.launch {
        LaunchSpec::Env(env) => {
            if let (Some(name), Some(m)) = (env.model, model) {
                plan.env.push((name.into(), m.into()));
            }
        }
        LaunchSpec::ByProtocol(entries) => {
            // 与 api 模式同一缺省规则取协议条目，但只注入模型 env；
            // --auth-type 等凭证参数不注入（官方账号用 CLI 默认认证方式）
            let default = spec.protocols.first().copied().unwrap_or("");
            let proto = profile.protocol.as_deref().unwrap_or(default);
            let entry = entries
                .iter()
                .find(|e| e.protocol == proto)
                .or_else(|| entries.first());
            if let (Some(entry), Some(m)) = (entry, model) {
                if let Some(name) = entry.env.model {
                    plan.env.push((name.into(), m.into()));
                }
            }
        }
        LaunchSpec::Special(special) => match special {
            // 模型槽位注册（ANTHROPIC_DEFAULT_*）只在 api 模式做：官方账号的可用模型由订阅决定
            SpecialLaunch::ClaudeModelSlots(env) => {
                if let (Some(name), Some(m)) = (env.model, model) {
                    plan.env.push((name.into(), m.into()));
                }
            }
            SpecialLaunch::CodexInlineProvider { sandbox_args, .. } => {
                if let Some(m) = model {
                    plan.args.push("-m".into());
                    plan.args.push(m.into());
                }
                // 默认沙箱与认证方式无关，官方账号同样生效
                for arg in *sandbox_args {
                    plan.args.push((*arg).into());
                }
            }
            // cursor 官方账号：不注入密钥/端点，模型 flag 与认证方式无关照常可用
            SpecialLaunch::CursorFlags { model_flag, .. } => {
                if let Some(m) = model {
                    plan.args.push((*model_flag).into());
                    plan.args.push(m.into());
                }
            }
            // kimi 官方账号：KIMI_MODEL_* env 合成通道会抢 OAuth 登录态（已被 purge 清单移除），
            // 模型只能走 -m flag（新版 CLI --help 实证，与认证方式无关）
            SpecialLaunch::KimiDualChannel => {
                if let Some(m) = model {
                    plan.args.push("-m".into());
                    plan.args.push(m.into());
                }
            }
            // opencode 内联配置缺 provider 会指向不存在的节点——官方账号模式下不注入模型
            //（opencode 无官方账号语义，注册表保持 None，正常不会走到）
            _ => {}
        },
    }
}

/// 通用 env 注入：base_url/密钥/选中模型各自写入规格指定的 env 名（None = 该 CLI 无此 env）
fn apply_env_inject(
    plan: &mut LaunchPlan,
    env: &crate::agent_specs::EnvInject,
    profile: &Profile,
    key: Option<&str>,
    model: Option<&str>,
) {
    if let (Some(name), Some(url)) = (env.base_url, &profile.base_url) {
        plan.env.push((name.into(), url.clone()));
    }
    if let (Some(name), Some(k)) = (env.key, key) {
        plan.env.push((name.into(), k.into()));
    }
    if let (Some(name), Some(m)) = (env.model, model) {
        plan.env.push((name.into(), m.into()));
    }
    for (k, v) in env.fixed_env {
        plan.env.push(((*k).into(), (*v).into()));
    }
    for arg in env.fixed_args {
        plan.args.push((*arg).into());
    }
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
    let is_codex = matches!(
        agent_spec(&profile.agent).map(|s| &s.launch),
        Some(LaunchSpec::Special(SpecialLaunch::CodexInlineProvider { .. }))
    );
    if is_codex {
        if let Some(path) = write_codex_catalog(profile)? {
            return Ok(catalog_args(&path));
        }
    }
    Ok(vec![])
}

pub fn binary_for(agent_id: &str) -> Option<&'static str> {
    agent_spec(agent_id).map(|s| s.binary)
}

/// 各 CLI 的按 ID 恢复会话参数（§6.12 A），参数格式来自 AgentSpec.resume。
/// 返回 (prepend, args)：codex 的 resume 是子命令需放最前，其余是位置无关的 flag。
pub(crate) fn resume_args(agent_id: &str, session_id: &str) -> (bool, Vec<String>) {
    match agent_spec(agent_id) {
        Some(spec) => (
            spec.resume.prepend,
            spec.resume
                .args
                .iter()
                .map(|a| a.replace("{session}", session_id))
                .collect(),
        ),
        None => (false, vec![]),
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
    // binary 可能是含空格的绝对路径（外部拉起场景），与 cwd 一样必须 shell 转义
    let mut cmd = format!(
        "cd {} && {}",
        sh_quote_if_needed(cwd),
        sh_quote_if_needed(binary)
    );
    for a in &args {
        cmd.push(' ');
        cmd.push_str(&sh_quote_if_needed(a));
    }
    Ok(cmd)
}

/// cmd.exe 方言的恢复命令行（cd /d + 双引号）。从结构化参数直接生成，
/// 不做 POSIX 串解析——POSIX 转义（'it'\''s'）无法靠替换引号正确还原。
/// 已知边角：cwd 含 %VAR% 形式子串时 cmd 仍会做变量展开（交互式 cmd 没有
/// 转义 % 的手段），这类目录名需要在系统终端手工恢复。
#[cfg(target_os = "windows")]
fn windows_resume_command_line(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    binary: &str,
) -> Result<String, String> {
    let (_, args) = resume_args(agent_id, session_id);
    if args.is_empty() {
        return Err(format!("{agent_id} 不支持按 ID 恢复"));
    }
    // 一律双引号包裹（含空格路径与裸名统一处理）；内嵌 " doubling 是 cmd 的转义方式
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut cmd = format!("cd /d {} && {}", q(cwd), q(binary));
    for a in &args {
        cmd.push(' ');
        cmd.push_str(&q(a));
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
    // Windows 直接生成 cmd 方言（POSIX 串解析无法正确还原引号转义）
    #[cfg(target_os = "windows")]
    let cmd = windows_resume_command_line(agent_id, session_id, cwd, &binary)?;
    #[cfg(not(target_os = "windows"))]
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
    // （keystroke 逐字输入对中文路径/键盘布局不可靠，故走剪贴板，用后还原）。
    // 剪贴板读取用 try 容错（图片等非文本内容 as string 会抛错）；主体包在 try/on error
    // 里，中途失败（如「控制 System Events」未授权）也先还原剪贴板再原样报错
    let escaped = applescript_escape(cmd);
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "set oldClip to \"\"",
            "-e",
            "try",
            "-e",
            "set oldClip to the clipboard as string",
            "-e",
            "end try",
            "-e",
            "set errMsg to \"\"",
            "-e",
            "try",
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
            "on error errMsg",
            "-e",
            "end try",
            "-e",
            "try",
            "-e",
            "set the clipboard to oldClip",
            "-e",
            "end try",
            "-e",
            "if errMsg is not \"\" then error errMsg",
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
    // cmd 已是 cmd.exe 方言（windows_resume_command_line 生成）；
    // start 开新窗口；/K 让窗口在 agent 退出后保留；内层引号 doubling 是 cmd 的转义方式
    let inner = cmd.replace('"', "\"\"");
    Command::new("cmd")
        .args(["/C", &format!("start \"\" cmd /K \"{inner}\"")])
        .spawn()
        .map_err(|e| format!("启动外部终端失败: {e}"))?;
    Ok(())
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

/// kimi 新旧两个产品共用命令，按数据目录推断装的是哪个变体（"new" | "legacy"）。
/// 目录名来自 AgentSpec.packaging.legacy_variant
pub(crate) fn kimi_variant() -> Option<&'static str> {
    crate::agent_specs::variant_of(agent_spec("kimi")?)
}

fn kimi_variant_hint() -> Option<&'static str> {
    match kimi_variant() {
        Some("new") => Some("新版"),
        Some("legacy") => Some("旧版"),
        _ => None,
    }
}

/// 检测结果按进程缓存一次（要 spawn 8 个子进程跑 --version，没必要每次重算）；
/// 更新成功后由 updater 调 invalidate_detect_cache 清空
static DETECT_CACHE: std::sync::Mutex<Option<Vec<DetectResult>>> = std::sync::Mutex::new(None);

pub(crate) fn invalidate_detect_cache() {
    *DETECT_CACHE.lock().unwrap() = None;
}

fn detect_one(spec: &'static AgentSpec) -> DetectResult {
    let (binary_path, mut version) = detect(spec);
    // 双变体 CLI（kimi）在版本号后标注装的是新版还是旧版
    if spec.packaging.legacy_variant.is_some() {
        if let (Some(v), Some(hint)) = (&version, kimi_variant_hint()) {
            version = Some(format!("{v} ({hint})"));
        }
    }
    DetectResult {
        id: spec.id.to_string(),
        binary_path,
        version,
    }
}

#[tauri::command]
pub async fn detect_agents() -> Vec<DetectResult> {
    if let Some(cached) = DETECT_CACHE.lock().unwrap().clone() {
        return cached;
    }
    // --version 要 spawn 8 个子进程，放阻塞线程池并并行跑（与 updater 的更新检查同模式；
    // 单个 CLI 卡死由 version_with_timeout 的 5s 超时兜底）
    let results = tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = crate::agent_specs::all_agent_specs()
            .iter()
            .map(|spec| std::thread::spawn(move || detect_one(spec)))
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    *DETECT_CACHE.lock().unwrap() = Some(results.clone());
    results
}

// ===== 官方账号（P1a）：只读检测 auth 文件，绝不写入/删除 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialAccountStatusDto {
    /// 注册表已填该 agent 的官方账号规格
    pub supported: bool,
    /// auth 文件存在且解析出凭证字段
    pub connected: bool,
    /// 检测说明（漏报场景/文件异常），界面直接展示
    pub detail: Option<String>,
    /// 终端内执行的登录命令（含二进制名；不支持官方账号时 None）
    pub login_command: Option<String>,
    /// 配置文件冲突告警（中文可读描述；只含文件名与变量名，绝不含密钥值）
    pub conflicts: Vec<String>,
}

/// auth 文件里标识「已登录」的凭证字段名（各家结构不同，命中任一即算）：
/// codex tokens.access_token / OPENAI_API_KEY、claude claudeAiOauth.accessToken、
/// gemini access_token / refresh_token
const CREDENTIAL_FIELD_NAMES: &[&str] = &[
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "id_token",
    "OPENAI_API_KEY",
];

/// 递归（限深）查找凭证字段：值是非空字符串才命中；防御式——结构随版本漂移时不误判
fn json_has_credential(value: &serde_json::Value, depth: u8) -> bool {
    if depth == 0 {
        return false;
    }
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
            (CREDENTIAL_FIELD_NAMES.contains(&k.as_str())
                && v.as_str().is_some_and(|s| !s.is_empty()))
                || json_has_credential(v, depth - 1)
        }),
        _ => false,
    }
}

/// 单个 auth 文件的只读探测；文件不存在/不可读 → None（按缺失处理）
fn probe_auth_file(path: &std::path::Path) -> Option<AuthProbe> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if json_has_credential(&v, 4) => AuthProbe::Connected,
        Ok(_) => AuthProbe::Unrecognized,
        Err(_) => AuthProbe::Corrupt,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum AuthProbe {
    Connected,
    /// 存在但找不到凭证字段（结构可能随版本漂移）
    Unrecognized,
    /// 存在但解析失败（可能损坏或末行截断）
    Corrupt,
}

// ===== 配置冲突探测（P1a 增强）：CLI 自读配置文件里的残留密钥会覆盖官方账号登录 =====
// 只读扫描，只报变量名；密钥值只在这一行内存里经过，绝不进 DTO/日志

/// .env 逐行解析：容忍注释/空行/export 前缀与等号两侧空白；
/// 大小写敏感（env 变量名本身大小写敏感，小写变体不会被 CLI 当作同一变量读取）
fn dotenv_conflict_keys(text: &str, keys: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((name, _)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if keys.contains(&name) {
            hits.push(name.to_string());
        }
    }
    hits
}

/// settings.json 防御式解析：只查顶层 env 对象的键；文件损坏/env 非对象 → 无冲突
fn settings_env_conflict_keys(text: &str, keys: &[&str]) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(env) = value.get("env").and_then(|e| e.as_object()) else {
        return Vec::new();
    };
    env.keys()
        .filter(|k| keys.contains(&k.as_str()))
        .cloned()
        .collect()
}

/// 逐条执行注册表的冲突探测；文件缺失/不可读静默跳过（不算冲突）
fn probe_conflicts(home: &std::path::Path, oa: &crate::agent_specs::OfficialAccountSpec) -> Vec<String> {
    let mut out = Vec::new();
    for probe in oa.conflict_probes {
        let Ok(text) = std::fs::read_to_string(home.join(probe.file)) else {
            continue;
        };
        let hits = if probe.file.ends_with(".json") {
            settings_env_conflict_keys(&text, probe.keys)
        } else {
            dotenv_conflict_keys(&text, probe.keys)
        };
        for key in hits {
            out.push(format!("~/{} 中存在 {}，{}", probe.file, key, probe.note));
        }
    }
    out
}

/// 展开 auth 文件候选：(展示路径, 绝对路径)。`/*` 结尾 = 目录扫描（kimi credentials/<name>.json
/// 文件名随 provider 名变化）：只探直接子级 *.json，不进 mcp/ 等子目录（那是 MCP 服务器凭证，
/// 不算 CLI 登录态）；目录缺失/不可读 = 无候选（按未检出处理）。扫描结果按文件名排序保证稳定输出
fn auth_probe_candidates(
    home: &std::path::Path,
    oa: &crate::agent_specs::OfficialAccountSpec,
) -> Vec<(String, std::path::PathBuf)> {
    let mut out: Vec<(String, std::path::PathBuf)> = Vec::new();
    for rel in oa.auth_file_paths {
        if let Some(dir_rel) = rel.strip_suffix("/*") {
            let Ok(entries) = std::fs::read_dir(home.join(dir_rel)) else {
                continue;
            };
            let mut scanned: Vec<(String, std::path::PathBuf)> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "json"))
                .map(|p| {
                    let display = format!(
                        "{dir_rel}/{}",
                        p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                    );
                    (display, p)
                })
                .collect();
            scanned.sort_by(|a, b| a.0.cmp(&b.0));
            out.extend(scanned);
        } else {
            out.push(((*rel).to_string(), home.join(rel)));
        }
    }
    out
}

/// 官方账号连接状态（P1a）。supported = 注册表有规格；connected = auth 文件检出凭证。
/// 断开不做文件删除——引导用户用 CLI 自己的 logout（前端文案）
#[tauri::command]
pub fn official_account_status(agent_id: &str) -> OfficialAccountStatusDto {
    let Some(spec) = agent_spec(agent_id) else {
        return OfficialAccountStatusDto {
            supported: false,
            connected: false,
            detail: Some(format!("未知 agent: {agent_id}")),
            login_command: None,
            conflicts: Vec::new(),
        };
    };
    let Some(oa) = spec.official_account.as_ref() else {
        return OfficialAccountStatusDto {
            supported: false,
            connected: false,
            detail: Some("该 CLI 暂未接入官方账号（不支持或无官方账号语义）".into()),
            login_command: None,
            conflicts: Vec::new(),
        };
    };
    // login_cmd 为空 = 裸启动 CLI 后在 TUI 内登录（gemini / qwen）
    let login_command = Some(
        std::iter::once(spec.binary)
            .chain(oa.login_cmd.iter().copied())
            .collect::<Vec<_>>()
            .join(" "),
    );
    let home = dirs::home_dir();
    // 冲突探测与连接状态无关：未登录时残留的 API 配置同样值得告警
    let conflicts = home
        .as_ref()
        .map(|h| probe_conflicts(h, oa))
        .unwrap_or_default();
    let mut unrecognized: Option<String> = None;
    let mut corrupt: Option<String> = None;
    let candidates = home
        .as_ref()
        .map(|h| auth_probe_candidates(h, oa))
        .unwrap_or_default();
    for (rel, path) in &candidates {
        match probe_auth_file(path) {
            Some(AuthProbe::Connected) => {
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(format!("已检测到登录凭证（~/{rel}）")),
                    login_command,
                    conflicts,
                };
            }
            Some(AuthProbe::Unrecognized) => {
                if unrecognized.is_none() {
                    unrecognized = Some(rel.clone());
                }
            }
            Some(AuthProbe::Corrupt) => {
                if corrupt.is_none() {
                    corrupt = Some(rel.clone());
                }
            }
            None => {}
        }
    }
    let detail = if let Some(rel) = corrupt {
        format!("~/{rel} 存在但无法解析（文件可能损坏）")
    } else if let Some(rel) = unrecognized {
        format!("~/{rel} 存在但未识别到凭证字段（格式可能随版本变化）")
    } else {
        match oa.detection_note {
            Some(note) => format!("未检测到凭证文件；{note}"),
            None => "未检测到凭证文件".into(),
        }
    };
    OfficialAccountStatusDto {
        supported: true,
        connected: false,
        detail: Some(detail),
        login_command,
        conflicts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(agent: &str, base_url: Option<&str>) -> Profile {
        Profile {
            id: "test".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
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
    fn codebuddy_plan_injects_codebuddy_env() {
        let p = profile("codebuddy", Some("https://api.deepseek.com/anthropic"));
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("deepseek-v3-2-volc"));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_BASE_URL".into(), "https://api.deepseek.com/anthropic".into())));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_API_KEY".into(), "sk-secret".into())));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_MODEL".into(), "deepseek-v3-2-volc".into())));
        // 初始 prompt 是位置参数（一键开步注入）
        let plan = launch_plan_with_prompt(&p, Some("sk-secret".into()), None, Some("干活"));
        assert_eq!(plan.prompt_args, vec!["干活"]);
    }

    #[test]
    fn codebuddy_official_plan_purges_api_env() {
        // 官方账号拉起：不注入 API env，且必须 env_remove 残留密钥变量（env 优先压账号，实测 401）
        let p = official_profile("codebuddy");
        let plan = launch_plan(&p, None, None);
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("CODEBUDDY_")));
        assert!(plan.env_remove.contains(&"CODEBUDDY_API_KEY".to_string()));
        assert!(plan.env_remove.contains(&"CODEBUDDY_AUTH_TOKEN".to_string()));
    }

    #[test]
    fn cursor_plan_injects_key_endpoint_env_and_model_flag() {
        let p = profile("cursor", Some("https://cursor.example.com"));
        let plan = launch_plan(&p, Some("key-secret".into()), Some("claude-opus-4-8[context=1m,effort=high]"));
        assert!(plan
            .env
            .contains(&("CURSOR_API_KEY".into(), "key-secret".into())));
        assert!(plan
            .env
            .contains(&("CURSOR_API_ENDPOINT".into(), "https://cursor.example.com".into())));
        // 模型走 --model flag（bracket 参数化原样透传），不是 env
        assert_eq!(
            plan.args,
            vec!["--model", "claude-opus-4-8[context=1m,effort=high]"]
        );
        assert!(!plan.env.iter().any(|(k, _)| k.contains("MODEL")));
        // 空字段不注入：无 base_url/密钥/模型时 env 与 args 都为空
        let bare = launch_plan(&profile("cursor", None), None, None);
        assert!(bare.env.is_empty());
        assert!(bare.args.is_empty());
        // 初始 prompt 是位置参数（一键开步注入）
        let plan = launch_plan_with_prompt(&p, Some("key-secret".into()), None, Some("干活"));
        assert_eq!(plan.prompt_args, vec!["干活"]);
        assert!(!plan.prompt_dropped);
    }

    #[test]
    fn cursor_official_plan_purges_key_but_keeps_model_flag() {
        // 官方账号拉起：不注入 CURSOR_API_KEY（且 env_remove 残留），模型 flag 照常可用
        let p = official_profile("cursor");
        let plan = launch_plan(&p, Some("key-secret".into()), Some("gpt-5"));
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("CURSOR_")));
        assert_eq!(plan.args, vec!["--model", "gpt-5"]);
        assert!(plan.env_remove.contains(&"CURSOR_API_KEY".to_string()));
        // 模型为空：无任何参数
        let bare = launch_plan(&p, None, None);
        assert!(bare.args.is_empty());
        assert!(bare.env.is_empty());
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

    // ===== 官方账号模式（P1a）=====

    fn official_profile(agent: &str) -> Profile {
        let mut p = profile(agent, Some("https://relay.example.com"));
        p.account_type = crate::profiles::AccountType::Official;
        p
    }

    #[test]
    fn official_plan_injects_no_credentials_and_purges_residual_env() {
        let p = official_profile("claude-code");
        let plan = launch_plan(&p, Some("sk-secret".into()), None);
        // 密钥/base_url 一律不注入，模型为空也不注入模型 env
        assert!(plan.env.is_empty());
        assert!(plan.args.is_empty());
        assert!(!plan.env.iter().any(|(_, v)| v.contains("sk-secret")));
        assert!(plan.env_remove.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
        assert!(plan.env_remove.contains(&"ANTHROPIC_API_KEY".into()));
        assert!(plan.env_remove.contains(&"ANTHROPIC_BASE_URL".into()));
    }

    #[test]
    fn kimi_official_plan_purges_synth_channel_and_uses_model_flag() {
        let p = official_profile("kimi");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("kimi-code/k3"));
        // KIMI_MODEL_* 合成通道会抢 OAuth 登录态：一律 env_remove 且不注入任何 env
        assert!(plan.env.is_empty());
        for var in [
            "KIMI_MODEL_NAME",
            "KIMI_MODEL_PROVIDER_TYPE",
            "KIMI_MODEL_API_KEY",
            "KIMI_MODEL_BASE_URL",
            "KIMI_API_KEY",
            "KIMI_BASE_URL",
        ] {
            assert!(plan.env_remove.contains(&var.into()), "purge 缺 {var}");
        }
        // 模型走 -m flag（与认证方式无关），密钥绝不出现
        assert_eq!(plan.args, vec!["-m", "kimi-code/k3"]);
        assert!(!plan.args.iter().any(|a| a.contains("sk-secret")));
    }

    #[test]
    fn official_plan_injects_model_only_when_selected() {
        let p = official_profile("claude-code");
        let plan = launch_plan(&p, None, Some("claude-sonnet-4"));
        assert_eq!(
            plan.env,
            vec![("ANTHROPIC_MODEL".to_string(), "claude-sonnet-4".to_string())]
        );
        // 模型槽位注册（ANTHROPIC_DEFAULT_*）只在 api 模式做
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("ANTHROPIC_DEFAULT_")));
        // purge 列表照常
        assert!(!plan.env_remove.is_empty());
    }

    #[test]
    fn official_plan_keeps_extra_env_as_escape_hatch() {
        let mut p = official_profile("claude-code");
        p.extra_env.insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        let plan = launch_plan(&p, None, None);
        assert_eq!(
            plan.env,
            vec![("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string())]
        );
    }

    #[test]
    fn official_codex_plan_has_no_provider_args_but_keeps_sandbox() {
        let p = official_profile("codex");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gpt-5-codex"));
        assert!(plan.env.is_empty());
        let joined = plan.args.join(" ");
        assert!(!joined.contains("model_providers"));
        assert!(!joined.contains("model_provider="));
        assert!(joined.contains("-m gpt-5-codex"));
        // 默认沙箱与认证方式无关，官方账号同样生效
        assert!(joined.contains("-s workspace-write"));
        assert!(plan.env_remove.contains(&"CODEX_API_KEY".into()));
        assert!(plan.env_remove.contains(&"OPENAI_API_KEY".into()));
        // 模型为空：只剩沙箱参数
        let bare = launch_plan(&p, None, None);
        assert_eq!(bare.args, vec!["-s", "workspace-write"]);
    }

    #[test]
    fn official_gemini_plan_purges_gateway_env() {
        let p = official_profile("gemini");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("gemini-3-pro"));
        // base URL（GATEWAY 模式）与密钥都不注入，只注入模型
        assert_eq!(
            plan.env,
            vec![("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string())]
        );
        assert!(plan.env_remove.contains(&"GEMINI_API_KEY".into()));
        assert!(plan.env_remove.contains(&"GOOGLE_GEMINI_BASE_URL".into()));
    }

    #[test]
    fn official_plan_for_unsupported_agent_is_inert() {
        // 规格未填官方账号的 agent（opencode）：purge 为空、不注入任何凭证/模型，不崩溃
        let p = official_profile("opencode");
        let plan = launch_plan(&p, Some("sk-secret".into()), Some("m1"));
        assert!(plan.env.is_empty());
        assert!(plan.args.is_empty());
        assert!(plan.env_remove.is_empty());
    }

    // ===== 初始 prompt 注入（一键开步首条指令）=====

    #[test]
    fn prompt_inject_positional_and_flag_shapes() {
        // claude/codex：位置参数（单元素，pty_spawn 追加在命令行最后）
        let p = profile("claude-code", None);
        let plan = launch_plan_with_prompt(&p, None, Some("m1"), Some("读 TASK.md，按简报开始执行"));
        assert_eq!(plan.prompt_args, vec!["读 TASK.md，按简报开始执行"]);
        assert!(!plan.prompt_dropped);
        // 位置参数不在 plan.args 里（保证 codex 沙箱/-c、claude --session-id 都在它前面）
        assert!(!plan.args.iter().any(|a| a.contains("TASK.md")));
        // gemini/qwen：-i <prompt>（执行后继续交互）
        for agent in ["gemini", "qwen"] {
            let p = profile(agent, None);
            let plan = launch_plan_with_prompt(&p, None, None, Some("开始干活"));
            assert_eq!(plan.prompt_args, vec!["-i", "开始干活"], "{agent} 应为 -i 形态");
            assert!(!plan.prompt_dropped);
        }
    }

    #[test]
    fn prompt_inject_coexists_with_codex_sandbox_args() {
        // codex 特殊变体：既有 -c/-m/沙箱参数保持原顺序，prompt 单列在 prompt_args 末尾追加
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let plan =
            launch_plan_with_prompt(&p, Some("sk-secret".into()), Some("gpt-5-codex"), Some("开工"));
        assert_eq!(plan.prompt_args, vec!["开工"]);
        let joined = plan.args.join(" ");
        assert!(joined.contains("-s workspace-write"));
        assert!(joined.contains(r#"model_provider="ccode""#));
        assert!(joined.contains("-m gpt-5-codex"));
        assert!(!joined.contains("开工"), "prompt 不得混入既有参数序列");
    }

    #[test]
    fn prompt_inject_unsupported_marks_dropped() {
        // kimi/opencode 无交互模式初始 prompt 参数（-p 是非交互模式，禁用）：不注入 + 标记
        for agent in ["kimi", "opencode"] {
            let p = profile(agent, None);
            let plan = launch_plan_with_prompt(&p, None, None, Some("开工"));
            assert!(plan.prompt_args.is_empty(), "{agent} 不得注入");
            assert!(plan.prompt_dropped, "{agent} 应置 dropped 标记");
        }
        // 未知 agent：无从注入，同样标记
        let p = profile("no-such-agent", None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开工"));
        assert!(plan.prompt_dropped);
    }

    #[test]
    fn prompt_inject_applies_to_official_account_too() {
        // api / 官方账号两种模式都注入（prompt 与认证方式无关）；purge/凭证语义不受影响
        let p = official_profile("claude-code");
        let plan = launch_plan_with_prompt(&p, Some("sk-secret".into()), None, Some("开工"));
        assert_eq!(plan.prompt_args, vec!["开工"]);
        assert!(plan.env_remove.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
        assert!(!plan.env.iter().any(|(_, v)| v.contains("sk-secret")));
    }

    #[test]
    fn prompt_inject_skips_empty_and_blank_prompt() {
        let p = profile("claude-code", None);
        for prompt in [None, Some(""), Some("   ")] {
            let plan = launch_plan_with_prompt(&p, None, None, prompt);
            assert!(plan.prompt_args.is_empty());
            assert!(!plan.prompt_dropped);
        }
        // 前后空白先裁剪再注入
        let plan = launch_plan_with_prompt(&p, None, None, Some("  开工  "));
        assert_eq!(plan.prompt_args, vec!["开工"]);
    }

    // ===== auth 文件只读探测（防御式）=====

    fn probe_temp(name: &str, content: &str) -> Option<AuthProbe> {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        let probe = probe_auth_file(&path);
        std::fs::remove_dir_all(&dir).ok();
        probe
    }

    #[test]
    fn auth_probe_detects_codex_chatgpt_and_apikey_shapes() {
        // ChatGPT 账号：tokens.access_token
        let probe = probe_temp(
            "auth.json",
            r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"x","access_token":"tok","refresh_token":"r"},"last_refresh":"2026-01-01T00:00:00Z"}"#,
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
        // API key 登录：顶层 OPENAI_API_KEY
        let probe = probe_temp("auth.json", r#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#);
        assert_eq!(probe, Some(AuthProbe::Connected));
    }

    #[test]
    fn auth_probe_detects_nested_claude_and_flat_gemini_shapes() {
        // claude：凭证嵌套在 claudeAiOauth 下（camelCase）
        let probe = probe_temp(
            ".credentials.json",
            r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":123}}"#,
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
        // gemini：google-auth-library Credentials 扁平结构
        let probe = probe_temp(
            "oauth_creds.json",
            r#"{"access_token":"tok","refresh_token":"r","scope":"s","token_type":"Bearer","expiry_date":123}"#,
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
    }

    #[test]
    fn auth_probe_is_defensive_on_missing_corrupt_and_unrecognized() {
        // 缺失 → None
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(probe_auth_file(&dir.join("nope.json")), None);
        // 损坏（截断的 JSON）→ Corrupt，不误判为已连接
        let probe = probe_temp("auth.json", r#"{"tokens":{"access_token":"to"#);
        assert_eq!(probe, Some(AuthProbe::Corrupt));
        // 合法 JSON 但无凭证字段 → Unrecognized
        let probe = probe_temp("auth.json", r#"{"foo":"bar","n":1}"#);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
        // 空字符串凭证不算命中
        let probe = probe_temp("auth.json", r#"{"access_token":""}"#);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
    }

    // ===== auth 候选展开（/* 目录扫描）=====

    #[test]
    fn auth_candidates_expand_dir_scan_and_skip_subdirs_and_non_json() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let cred = dir.join(".kimi-code/credentials");
        std::fs::create_dir_all(cred.join("mcp")).unwrap();
        std::fs::write(cred.join("managed:kimi-code.json"), "{}").unwrap();
        std::fs::write(cred.join("notes.txt"), "{}").unwrap();
        std::fs::write(cred.join("mcp/server.json"), "{}").unwrap();
        let oa = crate::agent_specs::OfficialAccountSpec {
            login_cmd: &["login"],
            auth_file_paths: &[".kimi-code/credentials/*"],
            env_purge_list: &["KIMI_API_KEY"],
            conflict_probes: &[],
            detection_note: None,
        };
        let found = auth_probe_candidates(&dir, &oa);
        // 只命中直接子级 .json：mcp/ 子目录与 .txt 都排除
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, ".kimi-code/credentials/managed:kimi-code.json");
        assert!(found[0].1.ends_with("managed:kimi-code.json"));
        // 目录缺失 → 无候选（按未检出处理，不报错）
        std::fs::remove_dir_all(&cred).ok();
        assert!(auth_probe_candidates(&dir, &oa).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auth_candidates_pass_plain_paths_through() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let spec = crate::agent_specs::agent_spec("qwen").unwrap();
        let oa = spec.official_account.as_ref().unwrap();
        let found = auth_probe_candidates(&dir, oa);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, ".qwen/oauth_creds.json");
        assert!(found[0].1.ends_with(".qwen/oauth_creds.json"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 配置冲突探测（.env / settings.json）=====

    const CONFLICT_KEYS: &[&str] = &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"];

    #[test]
    fn dotenv_probe_tolerates_comments_blank_lines_and_export_prefix() {
        let text = "# 注释\n\nGEMINI_API_KEY=sk-live-secret-123\nexport GOOGLE_GEMINI_BASE_URL = https://relay.example.com\n  # 缩进注释\nNOT_A_KEY=x\n";
        let hits = dotenv_conflict_keys(text, CONFLICT_KEYS);
        assert_eq!(hits, vec!["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]);
        // 只报变量名，密钥值绝不进结果
        assert!(!hits.iter().any(|h| h.contains("sk-live-secret-123")));
    }

    #[test]
    fn dotenv_probe_is_case_sensitive_and_skips_malformed_lines() {
        // 小写变体不算（env 变量名大小写敏感，CLI 不会把它读成同一变量）
        assert!(dotenv_conflict_keys("gemini_api_key=x\n", CONFLICT_KEYS).is_empty());
        // 无等号的行、空键名都不命中
        assert!(dotenv_conflict_keys("GEMINI_API_KEY\n=value\n", CONFLICT_KEYS).is_empty());
    }

    #[test]
    fn settings_json_probe_reads_only_top_level_env_object() {
        // env 对象内命中；env 之外的同名键（如 mcpServers 里）不命中
        let text = r#"{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret"},"mcpServers":{"x":{"env":{"ANTHROPIC_API_KEY":"y"}}}}"#;
        let keys = &["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
        assert_eq!(settings_env_conflict_keys(text, keys), vec!["ANTHROPIC_API_KEY"]);
    }

    #[test]
    fn settings_json_probe_is_defensive_on_non_object_corrupt_and_missing_env() {
        let keys = &["ANTHROPIC_API_KEY"];
        // env 不是对象
        assert!(settings_env_conflict_keys(r#"{"env":"ANTHROPIC_API_KEY"}"#, keys).is_empty());
        // 损坏的 JSON
        assert!(settings_env_conflict_keys(r#"{"env":{"ANTHROPIC_API_KEY":"x""#, keys).is_empty());
        // 没有 env 键
        assert!(settings_env_conflict_keys(r#"{"model":"opus"}"#, keys).is_empty());
    }

    #[test]
    fn probe_conflicts_reports_file_and_key_only_and_skips_missing_files() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".gemini")).unwrap();
        std::fs::write(
            dir.join(".gemini/.env"),
            "GEMINI_API_KEY=sk-super-secret-value\n",
        )
        .unwrap();
        let spec = crate::agent_specs::agent_spec("gemini").unwrap();
        let oa = spec.official_account.as_ref().unwrap();
        let conflicts = probe_conflicts(&dir, oa);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("~/.gemini/.env"));
        assert!(conflicts[0].contains("GEMINI_API_KEY"));
        // DTO 文案不得含密钥值
        assert!(!conflicts[0].contains("sk-super-secret-value"));
        // 文件缺失静默跳过：claude 的 settings.json 探测在该目录无文件，不产生冲突
        let claude = crate::agent_specs::agent_spec("claude-code").unwrap();
        assert!(probe_conflicts(&dir, claude.official_account.as_ref().unwrap()).is_empty());
        // codex 保守留空：永不产生冲突
        let codex = crate::agent_specs::agent_spec("codex").unwrap();
        assert!(probe_conflicts(&dir, codex.official_account.as_ref().unwrap()).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn qwen_conflict_probe_flags_dotenv_residual_keys() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".qwen")).unwrap();
        std::fs::write(
            dir.join(".qwen/.env"),
            "OPENAI_API_KEY=sk-super-secret-value\nDASHSCOPE_API_KEY=sk-other\n",
        )
        .unwrap();
        let spec = crate::agent_specs::agent_spec("qwen").unwrap();
        let oa = spec.official_account.as_ref().unwrap();
        let conflicts = probe_conflicts(&dir, oa);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("~/.qwen/.env"));
        assert!(conflicts[0].contains("OPENAI_API_KEY"));
        // DASHSCOPE_API_KEY 不在探测清单（是否压 OAuth 未核实，见注册表注释）
        assert!(!conflicts[0].contains("DASHSCOPE_API_KEY"));
        assert!(!conflicts[0].contains("sk-super-secret-value"));
        std::fs::remove_dir_all(&dir).ok();
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
        assert_eq!(
            resume_command_line("codebuddy", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && codebuddy -r abc"
        );
        assert_eq!(
            resume_command_line("cursor", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && cursor-agent --resume abc"
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
        // 绝对路径含空格 → binary 也必须 shell 转义（否则命令行在空格处断裂）
        assert_eq!(
            resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/My Apps/bin/kimi").unwrap(),
            "cd /tmp && '/Users/x/My Apps/bin/kimi' -S abc"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_resume_line_uses_cmd_dialect() {
        // cmd 方言：cd /d + 双引号；裸名与含空格路径统一包裹
        assert_eq!(
            windows_resume_command_line("claude-code", "abc", r"C:\work\my proj", r"C:\tools\claude.cmd").unwrap(),
            r#"cd /d "C:\work\my proj" && "C:\tools\claude.cmd" -r "abc""#
        );
        // cwd 含单引号：从结构化参数生成，不受 POSIX 转义影响
        let line = windows_resume_command_line("kimi", "abc", r"C:\it's\proj", "kimi").unwrap();
        assert_eq!(line, r#"cd /d "C:\it's\proj" && "kimi" -S "abc""#);
        assert!(windows_resume_command_line("no-such", "abc", r"C:\x", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn version_with_timeout_reads_first_line() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let bin = base.join("fake-cli");
        std::fs::write(&bin, "#!/bin/sh\necho '1.2.3 (Fake CLI)'\necho second\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            version_with_timeout(&bin, std::time::Duration::from_secs(5)),
            Some("1.2.3 (Fake CLI)".into())
        );
        // 空输出 → None
        std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        assert_eq!(
            version_with_timeout(&bin, std::time::Duration::from_secs(5)),
            None
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn version_with_timeout_kills_hung_cli() {
        let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let bin = base.join("hung-cli");
        // --version 永不返回：超时后必须杀掉并返回 None（不能无限阻塞）
        std::fs::write(&bin, "#!/bin/sh\nsleep 60\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            version_with_timeout(&bin, std::time::Duration::from_millis(300)),
            None
        );
        // 子进程已被杀掉（防挂死兜底之外不做墙钟时序硬断言）
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn sh_quote_if_needed_escapes_single_quote() {
        assert_eq!(sh_quote_if_needed("plain-1.x"), "plain-1.x");
        assert_eq!(sh_quote_if_needed("it's"), "'it'\\''s'");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candidate_dirs_cover_homebrew_prefixes() {
        let dirs = crate::agent_specs::binary_candidate_dirs();
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/opt/homebrew/bin")));
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/usr/local/bin")));
    }
}
