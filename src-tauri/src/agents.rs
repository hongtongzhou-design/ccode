use crate::agent_specs::{agent_spec, AgentSpec, LaunchSpec, SpecialLaunch};
use crate::profiles::{Profile, ProfileStore};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "command")]
pub enum ModelSwitchDto {
    /// 带参直切（命令模板含 {model} 占位）
    Direct(String),
    /// 唤出 TUI 选择器由用户完成
    Picker(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortSpecDto {
    pub levels: Vec<String>,
    /// 命令模板（含 {level} 占位），pty_write 写入
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub id: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    /// 该 CLI 有进程级只读参数（注册表 readonly_args 非空）。
    /// false = 「聊想法只读保护」对它只剩 prompt 里的软约束，agent 可以无视——
    /// UI 据此如实标注，不让开关沉默降级（用户在头脑风暴时最依赖「它不会动我文件」这个假设）
    pub readonly_supported: bool,
    /// 运行中模型切换命令形态（终端状态栏模型菜单；None = 无机制不显示）
    pub model_switch: Option<ModelSwitchDto>,
    /// 运行中思考档调节（档位表 + 命令模板；None = 不显示「◈ 思考」控件）
    pub effort: Option<EffortSpecDto>,
    /// TUI 的 Enter 需要 CSI-u 形式（kitty 键盘协议；kimi）——xterm 键盘层与状态栏写入改写
    pub submit_csi_u: bool,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvPreviewDto {
    pub name: String,
    /// 来源标注（展示用启发式：命名即来源约定；同键多次出现 = 后者覆盖前者）
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlanPreviewDto {
    pub agent: String,
    pub binary: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<EnvPreviewDto>,
    pub env_remove: Vec<String>,
    pub prompt_supported: bool,
    pub request_policy: crate::profiles::RequestPolicy,
}

/// 预览里的 env 来源启发式分类（只读展示，不影响注入本身）
fn env_preview_source(name: &str, profile: &Profile) -> &'static str {
    if profile.extra_env.contains_key(name) {
        return "附加环境变量";
    }
    match name {
        // apply_request_policy_env 与各臂策略注入的键全集
        "CLAUDE_CODE_EXTRA_BODY"
        | "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
        | "CLAUDE_CODE_EFFORT_LEVEL"
        | "ANTHROPIC_CUSTOM_HEADERS"
        | "CODEBUDDY_CODE_MAX_OUTPUT_TOKENS"
        | "CODEBUDDY_CUSTOM_HEADERS"
        | "KIMI_MODEL_THINKING_EFFORT" => return "请求策略",
        _ => {}
    }
    if name.starts_with("ANTHROPIC_DEFAULT_") || name.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION") {
        return "模型选择器";
    }
    match name {
        "ANTHROPIC_MODEL" | "CODEBUDDY_MODEL" | "KIMI_MODEL_NAME" => "默认模型",
        n if n.contains("BASE_URL") || n == "CURSOR_API_ENDPOINT" => "端点",
        n if n.contains("API_KEY") || n.contains("AUTH_TOKEN") => "密钥注入",
        _ => "内置注入",
    }
}

/// 返回不含密钥值的启动计划，供配置页诊断和跨平台问题排查使用。
#[tauri::command]
pub fn preview_launch_plan(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<LaunchPlanPreviewDto, String> {
    let profile = store.get(&profile_id)?;
    let key = crate::profiles::get_key(&profile.id)?;
    let selected = model.as_deref().or_else(|| profile.models.first().map(String::as_str));
    let plan = launch_plan(&profile, key, selected);
    let args = plan
        .args
        .into_iter()
        .map(|arg| crate::sessions::redact_sensitive_text(&arg))
        .collect();
    let env = plan
        .env
        .into_iter()
        .map(|(name, _)| {
            let source = env_preview_source(&name, &profile).to_string();
            EnvPreviewDto { name, source }
        })
        .collect();
    Ok(LaunchPlanPreviewDto {
        agent: profile.agent.clone(),
        binary: resolve_binary(binary_for(&profile.agent).unwrap_or(""))
            .map(|p| p.to_string_lossy().into_owned()),
        args,
        env,
        env_remove: plan.env_remove,
        prompt_supported: !plan.prompt_dropped,
        request_policy: profile.request_policy,
    })
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
        // Windows 上可执行的是 .exe/.cmd/.bat；npm 系目录里的裸名是 shell 脚本，
        // CreateProcess 直接起会报 os error 193——扩展名匹配必须优先，裸名只作兜底
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.into(),
        ]
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
    let mut child = crate::process::background_command(path)
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
/// 请求策略注入（仅 api 模式；官方账号拉起在上方已 early-return，不会走到这里）。
/// 只接 matrix §9 第 8 条实证过的通道，未实证 agent/字段一律不注（fail-loud 由能力表
/// 与校验提示承担）。getenv 解析 Header 值（Profile 只存变量名引用，不落密文）；
/// 变量不存在或为空时跳过该条 Header。
fn apply_request_policy_env(
    plan: &mut LaunchPlan,
    agent: &str,
    policy: &crate::profiles::RequestPolicy,
    getenv: &dyn Fn(&str) -> Option<String>,
) {
    // Header 名=环境变量名 → "Name: value" 逐行（claude/codebuddy 同格式，\n 连接，二进制实证）
    let inject_headers = |plan: &mut LaunchPlan, env_key: &str| {
        let lines: Vec<String> = policy
            .header_env
            .iter()
            .filter_map(|(h, var)| {
                getenv(var).filter(|v| !v.is_empty()).map(|v| format!("{h}: {v}"))
            })
            .collect();
        if !lines.is_empty() {
            plan.env.push((env_key.into(), lines.join("\n")));
        }
    };
    match agent {
        "claude-code" => {
            // temperature/top_p 无独立 env：CLAUDE_CODE_EXTRA_BODY 解析为 JSON 对象后展开进
            // API 请求体（v2.x 二进制反编译实证），只写用户填了的字段
            let mut extra = serde_json::Map::new();
            if let Some(v) = policy.temperature {
                extra.insert("temperature".into(), serde_json::json!(v));
            }
            if let Some(v) = policy.top_p {
                extra.insert("top_p".into(), serde_json::json!(v));
            }
            if !extra.is_empty() {
                plan.env.push((
                    "CLAUDE_CODE_EXTRA_BODY".into(),
                    serde_json::Value::Object(extra).to_string(),
                ));
            }
            if let Some(v) = policy.max_output_tokens {
                plan.env.push(("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string()));
            }
            if let Some(v) = &policy.reasoning_effort {
                plan.env.push(("CLAUDE_CODE_EFFORT_LEVEL".into(), v.clone()));
            }
            inject_headers(plan, "ANTHROPIC_CUSTOM_HEADERS");
        }
        "codebuddy" => {
            // claude-code fork 但 env 前缀独立（v2.132.0 实测 ANTHROPIC_* 无效）；
            // 无 EXTRA_BODY/EFFORT 入口，只接两条实证通道
            if let Some(v) = policy.max_output_tokens {
                plan.env.push(("CODEBUDDY_CODE_MAX_OUTPUT_TOKENS".into(), v.to_string()));
            }
            inject_headers(plan, "CODEBUDDY_CUSTOM_HEADERS");
        }
        _ => {}
    }
}

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
                apply_env_inject(&mut plan, env, profile, key.as_deref(), model);
                // grok：把模型列表收敛进选择器——GROK_CONFIG 是 JSON overlay（深合并进 config.toml，
                // 白名单含 models 表），allowed_models 支持精确名/通配；不注则 GROK_MODELS_BASE_URL
                // 网关的全量目录（动辄几百个）全进选择器。空列表不注（allowed_models 空 = fail-closed
                // 一个都不匹配）；选中模型兜底并入，防选择器与默认模型脱节
                if profile.agent == "grok" && !profile.models.is_empty() {
                    let mut allowed = profile.models.clone();
                    if let Some(m) = model {
                        if !allowed.iter().any(|x| x == m) {
                            allowed.push(m.into());
                        }
                    }
                    plan.env.push((
                        "GROK_CONFIG".into(),
                        serde_json::json!({ "models": { "allowed_models": allowed } }).to_string(),
                    ));
                }
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
                    // 前 4 个占用 opus/sonnet/haiku/fable 别名槽，_NAME 让选择器显示友好名
                    // （profile 名 · 模型，与 kimi/codex/opencode 同口径）；
                    // 第 5 个走唯一的 CUSTOM_MODEL_OPTION；更多模型只能靠 /model <id> 手输
                    const SLOTS: [&str; 4] = ["SONNET", "OPUS", "HAIKU", "FABLE"];
                    for (m, slot) in profile.models.iter().take(4).zip(SLOTS) {
                        plan.env.push((format!("ANTHROPIC_DEFAULT_{slot}_MODEL"), m.clone()));
                        plan.env.push((
                            format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"),
                            format!("{} · {m}", profile.name),
                        ));
                    }
                    if let Some(fifth) = profile.models.get(4) {
                        plan.env.push(("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), fifth.clone()));
                        plan.env.push((
                            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(),
                            format!("{} · {fifth}", profile.name),
                        ));
                    }
                }
                SpecialLaunch::CodexInlineProvider { key_env, sandbox_args } => {
                    if let Some(key) = key {
                        plan.env.push(((*key_env).into(), key));
                    }
                    // Codex 没有 base URL 环境变量，且只支持 Responses API：
                    // 用 -c 内联定义一个名为 ccode 的 provider 并指到它
                    if let Some(url) = &profile.base_url {
                        plan.args.extend(codex_inline_provider_args(url, key_env));
                    }
                    if let Some(model) = model {
                        plan.args.push("-m".into());
                        plan.args.push(model.into());
                        // 会话内自省入口：codex 没有模型/base URL 环境变量（matrix §2），配置又走
                        // 内联 -c 不落盘，agent 被问「你是什么模型」时 config.json/$CODEX_MODEL 全空。
                        // 注入 Ccode 命名空间的显示名（配置名 · 模型，与选择器口径一致），
                        // 对齐 kimi KIMI_MODEL_DISPLAY_NAME 先例；纯信息性，codex 本身不读
                        plan.env.push((
                            "CCODE_MODEL_DISPLAY_NAME".into(),
                            format!("{} · {model}", profile.name),
                        ));
                    }
                    // 默认沙箱：只能写当前工作目录（需全权限时在系统终端自行启动）
                    for arg in *sandbox_args {
                        plan.args.push((*arg).into());
                    }
                    // workspace-write 默认拦网：文献检索/查资料一联网就弹提权确认，
                    // 这里放开沙箱内联网（只影响 workspace-write 档，read-only 下该键被忽略）
                    plan.args.push("-c".into());
                    plan.args.push("sandbox_workspace_write.network_access=true".into());
                    // 请求策略（实证通道）：effort = config 键 model_reasoning_effort；
                    // Header = provider env_http_headers（值是环境变量名引用，不落密文）。
                    // 后者依赖内联 provider 定义存在，无 base_url 时没有 ccode provider 可挂
                    if let Some(effort) = profile.request_policy.reasoning_effort.as_deref() {
                        plan.args.push("-c".into());
                        plan.args.push(format!(r#"model_reasoning_effort="{effort}""#));
                    }
                    if profile.base_url.is_some() {
                        for (header, env_name) in &profile.request_policy.header_env {
                            plan.args.push("-c".into());
                            plan.args.push(format!(
                                r#"model_providers.ccode.env_http_headers."{header}"="{env_name}""#
                            ));
                        }
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
                    // 请求策略（config schema 实证：model options 含 temperature/topP/
                    // maxOutputTokens/reasoningEffort；provider options 支持 headers）。
                    // 在这里合并而不进 opencode_provider_json：该函数与全局写入共用，
                    // headers 值是拉起瞬间从进程环境解析的密文，绝不能走落盘路径
                    let policy = &profile.request_policy;
                    let mut model_opts = serde_json::Map::new();
                    if let Some(v) = policy.temperature {
                        model_opts.insert("temperature".into(), serde_json::json!(v));
                    }
                    if let Some(v) = policy.top_p {
                        model_opts.insert("topP".into(), serde_json::json!(v));
                    }
                    if let Some(v) = policy.max_output_tokens {
                        model_opts.insert("maxOutputTokens".into(), serde_json::json!(v));
                    }
                    if let Some(v) = policy.reasoning_effort.as_deref() {
                        model_opts.insert("reasoningEffort".into(), serde_json::json!(v));
                    }
                    if !model_opts.is_empty() {
                        if let Some(models) =
                            config["provider"]["ccode"]["models"].as_object_mut()
                        {
                            for entry in models.values_mut() {
                                entry["options"] = serde_json::Value::Object(model_opts.clone());
                            }
                        }
                    }
                    let headers: serde_json::Map<String, serde_json::Value> = policy
                        .header_env
                        .iter()
                        .filter_map(|(h, var)| {
                            std::env::var(var)
                                .ok()
                                .filter(|v| !v.is_empty())
                                .map(|v| (h.clone(), serde_json::json!(v)))
                        })
                        .collect();
                    if !headers.is_empty() {
                        config["provider"]["ccode"]["options"]["headers"] =
                            serde_json::Value::Object(headers);
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
                        let provider_type = profile
                            .protocol
                            .clone()
                            .unwrap_or_else(|| spec.protocols.first().copied().unwrap_or("kimi").into());
                        plan.env.push(("KIMI_MODEL_PROVIDER_TYPE".into(), provider_type.clone()));
                        if let Some(key) = &key {
                            plan.env.push(("KIMI_MODEL_API_KEY".into(), key.clone()));
                        }
                        if let Some(url) = &profile.base_url {
                            plan.env.push(("KIMI_MODEL_BASE_URL".into(), url.clone()));
                        }
                        // 合成模型的元数据（2026-08-17 二进制实证）：
                        // 选择器 label 优先 displayName——用 profile 名避免显示成内部名；
                        // 兼容协议通道（openai/anthropic）capabilities 缺省只有 ["tool_use"]，
                        // 注册表判定为思考模型时显式声明（kimi 官方协议默认 ["image_in","thinking"]
                        // 已合理，不注入以免覆盖丢 image_in）
                        plan.env.push((
                            "KIMI_MODEL_DISPLAY_NAME".into(),
                            format!("{} · {model}", profile.name),
                        ));
                        plan.env.push((
                            "KIMI_MODEL_MAX_CONTEXT_SIZE".into(),
                            crate::model_registry::model_context_size(model).to_string(),
                        ));
                        if provider_type != "kimi" {
                            // 兼容协议通道 capabilities 缺省只有 ["tool_use"]：
                            // 思考/视觉模型都要显式声明，否则能力丧失（kimi 官方协议通道
                            // 缺省 ["image_in","thinking"] 已合理，不动）
                            let thinking = crate::model_registry::model_thinking(model);
                            let vision = crate::model_registry::model_supports_vision(model);
                            if thinking || vision {
                                let mut caps = String::from("tool_use");
                                if thinking {
                                    caps.push_str(",thinking");
                                }
                                if vision {
                                    caps.push_str(",image_in");
                                }
                                plan.env.push(("KIMI_MODEL_CAPABILITIES".into(), caps));
                            }
                        } else if let Some(effort) = &profile.request_policy.reasoning_effort {
                            // KIMI_MODEL_THINKING_EFFORT（2026-08-28 二进制实证：原样透传 +
                            // 小写归一，env 路径无闭集校验；仅 kimi 协议通道读取，
                            // 兼容协议通道会被静默忽略所以干脆不注）
                            plan.env.push((
                                "KIMI_MODEL_THINKING_EFFORT".into(),
                                effort.to_lowercase(),
                            ));
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
    // 请求策略注入：按能力表实证通道落地（当前 claude-code/codebuddy），extra_env 仍可最后覆盖
    apply_request_policy_env(&mut plan, &profile.agent, &profile.request_policy, &|k| {
        std::env::var(k).ok()
    });
    // 附加环境变量放在最后：CommandBuilder 重复 env 后者生效，用户可借此覆盖 adapter 内置值
    for (k, v) in &profile.extra_env {
        plan.env.push((k.clone(), v.clone()));
    }
    if profile.no_auth {
        for key in [
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN",
            "CURSOR_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "KIMI_API_KEY",
            "KIMI_MODEL_API_KEY",
        ] {
            if !plan.env_remove.iter().any(|existing| existing == key) {
                plan.env_remove.push(key.into());
            }
        }
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
        // 该 CLI 无交互模式初始 prompt 参数（目前仅 kimi）：不注入，让前端提示手动发送
        Some(crate::agent_specs::PromptInject::Unsupported) | None => {
            plan.prompt_dropped = true;
        }
    }
    plan
}

/// 「聊想法」只读模式（硬保护，想法期防 agent 擅自改主仓文件）：在启动计划 args 上应用
/// 注册表 readonly_args。codex 特殊：只读要替换默认的 `-s workspace-write`
///（重复 -s 哪个生效未文档化，不赌后者生效——先剔除原沙箱参数对再追加）。
/// 返回 None = 该 CLI 无只读参数（只有 prompt 软约束），调用方原样使用 plan.args。
pub fn readonly_launch_args(agent_id: &str, base_args: &[String]) -> Option<Vec<String>> {
    let spec = agent_spec(agent_id)?;
    if spec.readonly_args.is_empty() {
        return None;
    }
    let mut args: Vec<String> = if agent_id == "codex" {
        // 剔除 `-s/--sandbox <值>` 参数对（值是分离的下一个参数）
        let mut filtered = Vec::with_capacity(base_args.len());
        let mut skip_next = false;
        for a in base_args {
            if skip_next {
                skip_next = false;
                continue;
            }
            if a == "-s" || a == "--sandbox" {
                skip_next = true;
                continue;
            }
            filtered.push(a.clone());
        }
        filtered
    } else {
        base_args.to_vec()
    };
    for a in spec.readonly_args {
        args.push((*a).into());
    }
    Some(args)
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
                // 默认沙箱与认证方式无关，官方账号同样生效；沙箱内联网同步放开
                for arg in *sandbox_args {
                    plan.args.push((*arg).into());
                }
                plan.args.push("-c".into());
                plan.args.push("sandbox_workspace_write.network_access=true".into());
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

// ===== kimi 模型元数据：能力与上下文统一走 model_registry（内置表 + 覆盖文件 + 推断兜底） =====

/// OpenCode 的 provider 条目（npm + options + models），启动注入与全局写入共用。
/// provider 级 name = 选择器里的供应商显示名（用 profile 名，不再是内部 id "ccode"）；
/// models 条目 name = 模型显示名（models.dev 覆盖语义，官方文档核实）；
/// 思考能力与上下文取自 model_registry（内置表 + 覆盖文件 + 推断兜底）
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
    let mut all: Vec<&str> = profile.models.iter().map(|m| m.as_str()).collect();
    if let Some(m) = model {
        if !all.contains(&m) {
            all.push(m);
        }
    }
    for m in all {
        let mut entry = serde_json::json!({
            "name": format!("{} · {m}", profile.name),
            // 上下文与输出上限写入 limit（官方文档字段；1.18 起 schema 强制要求 output，
            // 缺了直接 Configuration is invalid），供 opencode 算剩余上下文与 max output tokens
            "limit": {
                "context": crate::model_registry::model_context_size(m),
                "output": crate::model_registry::model_output_limit(m),
            },
        });
        // 思考模型补 reasoning: true（models.dev 覆盖语义）；否则 models.dev
        // 查不到条目时 opencode 按无思考能力处理
        if crate::model_registry::model_thinking(m) {
            entry["reasoning"] = serde_json::json!(true);
        }
        // 视觉模型补 modalities（input 加 image）；缺省 = 纯文本，中继视觉模型
        // 不声明会在 opencode 里丢掉图像输入
        if crate::model_registry::model_supports_vision(m) {
            entry["modalities"] = serde_json::json!({ "input": ["text", "image"], "output": ["text"] });
        }
        models_map.insert(m.into(), entry);
    }
    serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": profile.name,
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
/// （reasoning levels 取其 low/medium/high 子集全量给——cc-switch 的 catalog 同样全量模板
/// （自家资源 codex_native_responses_template.json），模型不支持时端点忽略 effort，口径稳妥；
/// display_name 带 profile 名，选择器里不再是裸模型 id）
fn codex_catalog_entry(profile_name: &str, model: &str) -> serde_json::Value {
    let ctx = crate::model_registry::model_context_size(model);
    serde_json::json!({
        "slug": model,
        "display_name": format!("{profile_name} · {model}"),
        "description": null,
        // 上下文窗口按能力注册表（cc-switch 的 catalog 条目同样带这两个字段）
        "context_window": ctx,
        "max_context_window": ctx,
        // 有效上下文百分比：codex 按它算自动压缩阈值，缺了会用满窗口才压缩、
        // 容易先撞上下文上限报错（cc-switch 模板同值 95）
        "effective_context_window_percent": 95,
        // 图像输入按能力注册表如实声明（只认确知多模态系列，纯文本模型不给 ["text","image"]）
        "input_modalities": if crate::model_registry::model_supports_vision(model) {
            vec!["text", "image"]
        } else {
            vec!["text"]
        },
        // codex 的 web_search 是官方 hosted tool，第三方中继不支持——如实声明 false，
        // 不摆一个调了必挂的死工具（cc-switch 对拒收网关同样禁用）
        "supports_search_tool": false,
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
pub fn codex_catalog_json(profile_name: &str, models: &[String]) -> serde_json::Value {
    serde_json::json!({
        "models": models.iter().map(|m| codex_catalog_entry(profile_name, m)).collect::<Vec<_>>(),
    })
}

fn write_codex_catalog_to(
    path: &std::path::Path,
    profile_name: &str,
    models: &[String],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 catalog 目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&codex_catalog_json(profile_name, models))
        .map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 把 profile 的模型列表写成 codex catalog 文件（原子写）；无模型时返回 None
pub fn write_codex_catalog(profile: &Profile) -> Result<Option<std::path::PathBuf>, String> {
    if profile.models.is_empty() {
        return Ok(None);
    }
    let path = codex_catalog_path(&profile.id).ok_or("无法确定平台配置目录")?;
    write_codex_catalog_to(&path, &profile.name, &profile.models)?;
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

/// Codex 内联 provider 的 -c 定义参数（启动注入与外部恢复命令同一出处）。
/// rollout 元信息记录 model_provider="ccode"，恢复时没有这组定义 codex 报
/// "Model provider `ccode` not found"。只含 base_url 与 env_key 变量名引用，不含密钥
/// （密钥值由用户 shell 环境里的 CODEX_API_KEY 提供，不进命令行——关键约定不变）
fn codex_inline_provider_args(base_url: &str, key_env: &str) -> Vec<String> {
    let mut out = Vec::new();
    for kv in [
        r#"model_providers.ccode.name="Ccode""#.to_string(),
        format!(r#"model_providers.ccode.base_url="{base_url}""#),
        format!(r#"model_providers.ccode.env_key="{key_env}""#),
        r#"model_providers.ccode.wire_api="responses""#.to_string(),
    ] {
        out.push("-c".into());
        out.push(kv);
    }
    out.push("-c".into());
    out.push(r#"model_provider="ccode""#.into());
    out
}

/// 复制到用户终端的恢复命令附加参数：仅 codex 且调用方给出 Base URL 时补
/// provider 定义；复制命令本身不携带 Ccode profile 密钥，其他 agent 依赖用户全局配置。
fn resume_extra_args(agent_id: &str, base_url: Option<&str>) -> Vec<String> {
    match (agent_id, base_url) {
        ("codex", Some(url)) if !url.trim().is_empty() => match agent_spec("codex") {
            Some(spec) => match spec.launch {
                crate::agent_specs::LaunchSpec::Special(
                    crate::agent_specs::SpecialLaunch::CodexInlineProvider { key_env, .. },
                ) => codex_inline_provider_args(url, key_env),
                _ => vec![],
            },
            None => vec![],
        },
        _ => vec![],
    }
}

/// 外部终端启动的临时包装器：只把明确选中的 profile id/model 这类无敏感元数据从前端传进来，
/// 缺少 profile id 时 fail-closed，避免多配置场景静默选错端点。密钥由后端从 ProfileStore
/// 读取后写入一次性 0600 文件。包装器路径本身可以进入
/// Ghostty 的启动命令，因为路径不含密钥；包装器经 /bin/sh 启动后立即自删，超时兜底清理。
fn external_profile(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: Option<&str>,
    provider: Option<&str>,
    base_url: Option<&str>,
) -> Result<Profile, String> {
    let requested_id = require_external_profile_id(profile_id)?;
    let profiles = store.list()?;
    let pool: Vec<Profile> = profiles
        .into_iter()
        .filter(|p| p.agent == agent_id)
        .filter(|p| provider != Some("ccode") || p.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some())
        .collect();
    if pool.is_empty() {
        return Err(format!("没有可用于外部启动的 {agent_id} profile"));
    }
    let mut profile = pool
        .into_iter()
        .find(|p| p.id == requested_id)
        .ok_or_else(|| format!("profile 不存在或与 {agent_id} 不兼容"))?;
    // 兼容旧版调用方传入的 baseUrl；新路径优先使用 profile 自身配置。
    if profile.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        if let Some(url) = base_url.map(str::trim).filter(|s| !s.is_empty()) {
            profile.base_url = Some(url.to_string());
        }
    }
    crate::profile_validation::validate_profile_fields(&profile)?;
    Ok(profile)
}

fn require_external_profile_id(profile_id: Option<&str>) -> Result<&str, String> {
    profile_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "外部启动必须指定 Ccode profile，请重新选择配置".to_string())
}

pub(crate) fn ensure_launch_credentials(profile: &Profile, key: Option<&str>) -> Result<(), String> {
    if profile.account_type == crate::profiles::AccountType::Api
        && !profile.no_auth
        && key.is_none_or(|value| value.trim().is_empty())
    {
        return Err("API 连接没有密钥；请回到连接页填写密钥，或明确勾选本地端点无密钥".into());
    }
    Ok(())
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn sh_script_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn external_wrapper_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("external-launch");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建外部启动临时目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("收紧外部启动临时目录权限失败: {e}"))?;
    }
    Ok(dir)
}

fn schedule_wrapper_cleanup(path: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let _ = std::fs::remove_file(path);
    });
}

#[cfg(unix)]
fn write_external_wrapper(
    binary: &str,
    args: &[String],
    env: &[(String, String)],
    env_remove: &[String],
) -> Result<PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    for (name, _) in env {
        if !valid_env_name(name) {
            return Err(format!("profile 附加环境变量名非法: {name}"));
        }
    }
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("launch-{}.sh", uuid::Uuid::new_v4()));
    let mut text = String::from("#!/bin/sh\n\n# Ccode one-shot external launch; remove credentials before exec.\n\n");
    text.push_str("self=\"$0\"\nrm -f -- \"$self\" 2>/dev/null || :\n");
    for name in env_remove {
        if valid_env_name(name) {
            text.push_str("unset ");
            text.push_str(name);
            text.push('\n');
        }
    }
    for (name, value) in env {
        text.push_str("export ");
        text.push_str(name);
        text.push('=');
        text.push_str(&sh_script_quote(value));
        text.push('\n');
    }
    text.push_str("exec ");
    text.push_str(&sh_script_quote(binary));
    for arg in args {
        text.push(' ');
        text.push_str(&sh_script_quote(arg));
    }
    text.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("创建外部启动包装器失败: {e}"))?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("写入外部启动包装器失败: {e}")
        })?;
    schedule_wrapper_cleanup(path.clone());
    Ok(path)
}

#[cfg(windows)]
fn write_external_wrapper(
    binary: &str,
    args: &[String],
    env: &[(String, String)],
    env_remove: &[String],
) -> Result<PathBuf, String> {
    // PowerShell 脚本只通过路径传给 cmd/Ghostty，密钥不进入命令行；脚本首行自删。
    for (name, _) in env {
        if !valid_env_name(name) {
            return Err(format!("profile 附加环境变量名非法: {name}"));
        }
    }
    let dir = external_wrapper_dir()?;
    let path = dir.join(format!("launch-{}.ps1", uuid::Uuid::new_v4()));
    let mut text = String::from("$self = $PSCommandPath\nRemove-Item -LiteralPath $self -Force -ErrorAction SilentlyContinue\n");
    for name in env_remove {
        if valid_env_name(name) {
            text.push_str("Remove-Item Env:");
            text.push_str(name);
            text.push_str(" -ErrorAction SilentlyContinue\n");
        }
    }
    for (name, value) in env {
        text.push_str("$env:");
        text.push_str(name);
        text.push_str(" = ");
        text.push_str(&format!("'{}'", value.replace('\'', "''")));
        text.push('\n');
    }
    text.push_str("& ");
    text.push_str(&format!("'{}'", binary.replace('\'', "''")));
    for arg in args {
        text.push(' ');
        text.push_str(&format!("'{}'", arg.replace('\'', "''")));
    }
    text.push_str("\nexit $LASTEXITCODE\n");
    std::fs::write(&path, text).map_err(|e| format!("写入外部启动包装器失败: {e}"))?;
    schedule_wrapper_cleanup(path.clone());
    Ok(path)
}

#[cfg(unix)]
fn external_wrapper_command(cwd: &str, wrapper: &Path) -> String {
    let cwd = expand_home_path(cwd);
    format!(
        "cd {} && /bin/sh {}",
        sh_quote_if_needed(&cwd),
        sh_quote_if_needed(&wrapper.to_string_lossy())
    )
}

#[cfg(windows)]
fn external_wrapper_command(cwd: &str, wrapper: &Path) -> String {
    let cwd = expand_home_path(cwd);
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    format!(
        "cd /d {} && powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File {}",
        q(&cwd),
        q(&wrapper.to_string_lossy())
    )
}

/// 外部终端命令交给 shell 前先展开用户输入的家目录缩写。
/// 不能直接把 `~` 放进单引号，否则 POSIX shell 会按字面目录名处理。
fn expand_home_path(cwd: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return cwd.to_string();
    };
    let trimmed = cwd.trim();
    if trimmed == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home.join(rest).to_string_lossy().into_owned();
    }
    cwd.to_string()
}

fn external_launch_args(
    agent_id: &str,
    profile: &Profile,
    key: Option<String>,
    model: Option<&str>,
    resume_session_id: Option<&str>,
    prompt: Option<&str>,
) -> Result<(Vec<String>, Vec<(String, String)>, Vec<String>), String> {
    let plan = match prompt {
        Some(prompt) => launch_plan_with_prompt(profile, key, model, Some(prompt)),
        None => launch_plan(profile, key, model),
    };
    if prompt.is_some() && plan.prompt_dropped {
        return Err(format!("{agent_id} 不支持启动注入参数，简报指令需启动后手动发送"));
    }
    let extra = prepare_launch(profile)?;
    let mut args = Vec::new();
    if let Some(session_id) = resume_session_id {
        let (prepend, resume) = resume_args(agent_id, session_id);
        if prepend {
            args.extend(resume.iter().cloned());
        }
        args.extend(plan.args);
        args.extend(extra);
        if !prepend {
            args.extend(resume);
        }
    } else {
        args.extend(plan.args);
        args.extend(extra);
        // 与内嵌启动保持同一会话归属语义：支持固定 session id 的 CLI
        //（Claude/Qwen/CodeBuddy）在外部提炼接力时也锁定本次新会话文件名。
        // 必须放在首条 prompt 之前，避免位置参数 CLI 把它误当成用户指令。
        if agent_spec(agent_id).is_some_and(|spec| spec.fixed_session_id) {
            args.push("--session-id".into());
            args.push(uuid::Uuid::new_v4().to_string());
        }
        args.extend(plan.prompt_args);
    }
    Ok((args, plan.env, plan.env_remove))
}

fn open_external_profiled(
    store: &ProfileStore,
    agent_id: &str,
    profile_id: Option<&str>,
    provider: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
    cwd: &str,
    resume_session_id: Option<&str>,
    prompt: Option<&str>,
) -> Result<(), String> {
    let profile = external_profile(store, agent_id, profile_id, provider, base_url)?;
    let selected_model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or_else(|| profile.models.first().map(String::as_str));
    let key = crate::profiles::get_key(&profile.id)?;
    ensure_launch_credentials(&profile, key.as_deref())?;
    let (args, env, env_remove) = external_launch_args(
        agent_id,
        &profile,
        key,
        selected_model,
        resume_session_id,
        prompt,
    )?;
    let binary = resolve_binary(binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?)
        .ok_or_else(|| format!("未找到 {agent_id} 的 CLI 二进制"))?;
    let wrapper = write_external_wrapper(&binary.to_string_lossy(), &args, &env, &env_remove)?;
    let pref = crate::settings::read_current()
        .external_terminal
        .unwrap_or_else(|| "auto".into());
    let cmd = external_wrapper_command(cwd, &wrapper);
    match open_external_terminal(&cmd, &pref, cwd, &wrapper) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&wrapper);
            Err(e)
        }
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
    extra_args: &[String],
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
    for a in args.iter().chain(extra_args) {
        cmd.push(' ');
        cmd.push_str(&sh_quote_if_needed(a));
    }
    Ok(cmd)
}

#[cfg(target_os = "windows")]
fn windows_resume_command_line(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    binary: &str,
    extra_args: &[String],
) -> Result<String, String> {
    let (_, args) = resume_args(agent_id, session_id);
    if args.is_empty() {
        return Err(format!("{agent_id} 不支持按 ID 恢复"));
    }
    // 路径/值一律双引号包裹（含空格路径与裸名统一处理）；内嵌 " doubling 是 cmd 的转义方式。
    // flag 参数（-r/--session/-c 等）保持裸名，与 unix 版风格一致
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut cmd = format!("cd /d {} && {}", q(cwd), q(binary));
    for a in args.iter().chain(extra_args) {
        cmd.push(' ');
        if a.starts_with('-') {
            cmd.push_str(a);
        } else {
            cmd.push_str(&q(a));
        }
    }
    Ok(cmd)
}

/// 复制用命令行：裸命令名（用户真实交互终端 rc 齐全，且 cc-switch 风格干净）
pub fn resume_command_line(agent_id: &str, session_id: &str, cwd: &str) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    resume_command_line_with(agent_id, session_id, cwd, binary, &[])
}

/// 复制用：返回该会话的恢复命令行。
/// base_url：codex 会话走 Ccode 内联 provider（rollout 记 model_provider="ccode"）时必须
/// 补上 provider 定义才能在外部恢复——定义不含密钥（env_key 是变量名引用）
#[tauri::command]
pub fn session_resume_command(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    base_url: Option<String>,
) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let extra = resume_extra_args(agent_id, base_url.as_deref());
    #[cfg(target_os = "windows")]
    return windows_resume_command_line(agent_id, session_id, cwd, binary, &extra);
    #[cfg(not(target_os = "windows"))]
    resume_command_line_with(agent_id, session_id, cwd, binary, &extra)
}

/// 在外部终端应用中恢复会话。profile、模型、provider 与 CLI 参数由后端复用
/// launch_plan 生成；密钥只写入一次性 0600 wrapper，绝不进入 argv/剪贴板/前端 payload。
#[tauri::command]
pub fn resume_external_terminal(
    store: tauri::State<'_, ProfileStore>,
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    profile_id: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    open_external_profiled(
        &store,
        agent_id,
        profile_id.as_deref(),
        provider.as_deref(),
        base_url.as_deref(),
        model.as_deref(),
        cwd,
        Some(session_id),
        None,
    )
}

/// 在外部终端按指定 Ccode profile 新建会话。与连接页「在终端使用」同一套注入计划。
#[tauri::command]
pub fn new_external_terminal(
    store: tauri::State<'_, ProfileStore>,
    agent_id: &str,
    cwd: &str,
    profile_id: String,
    model: Option<String>,
) -> Result<(), String> {
    open_external_profiled(
        &store,
        agent_id,
        Some(&profile_id),
        None,
        None,
        model.as_deref(),
        cwd,
        None,
        None,
    )
}

/// 「◈ 提炼接力」外部续作命令行：cd 到项目目录 + 新会话首条指令（读简报续作，非 resume）。
/// 注入形态读注册表 prompt_inject：Positional → 位置参数，Flag → `-i '<prompt>'`；
/// Unsupported（目前仅 kimi）报错，由前端改为复制指令文本。
/// 与 resume 命令同一口径：不带 profile env，外部用的是用户全局配置。
fn digest_command_line_with(agent_id: &str, cwd: &str, prompt: &str, binary: &str) -> Result<String, String> {
    let mut cmd = format!(
        "cd {} && {}",
        sh_quote_if_needed(cwd),
        sh_quote_if_needed(binary)
    );
    match agent_spec(agent_id).map(|s| s.prompt_inject) {
        Some(crate::agent_specs::PromptInject::Positional) => {
            cmd.push(' ');
            cmd.push_str(&sh_quote_if_needed(prompt));
        }
        Some(crate::agent_specs::PromptInject::Flag(flag)) => {
            cmd.push(' ');
            cmd.push_str(flag);
            cmd.push(' ');
            cmd.push_str(&sh_quote_if_needed(prompt));
        }
        Some(crate::agent_specs::PromptInject::Unsupported) => {
            return Err(format!("{agent_id} 无启动注入参数，简报指令需启动后手动发送"));
        }
        None => return Err(format!("未知 agent: {agent_id}")),
    }
    Ok(cmd)
}

/// cmd.exe 方言的提炼接力命令行（镜像 windows_resume_command_line：双引号包裹路径与 prompt）
#[cfg(target_os = "windows")]
fn windows_digest_command_line(agent_id: &str, cwd: &str, prompt: &str, binary: &str) -> Result<String, String> {
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut cmd = format!("cd /d {} && {}", q(cwd), q(binary));
    match agent_spec(agent_id).map(|s| s.prompt_inject) {
        Some(crate::agent_specs::PromptInject::Positional) => {
            cmd.push(' ');
            cmd.push_str(&q(prompt));
        }
        Some(crate::agent_specs::PromptInject::Flag(flag)) => {
            cmd.push(' ');
            cmd.push_str(flag);
            cmd.push(' ');
            cmd.push_str(&q(prompt));
        }
        Some(crate::agent_specs::PromptInject::Unsupported) => {
            return Err(format!("{agent_id} 无启动注入参数，简报指令需启动后手动发送"));
        }
        None => return Err(format!("未知 agent: {agent_id}")),
    }
    Ok(cmd)
}

/// 复制用：提炼接力的外部续作命令行（裸命令名，同 session_resume_command 口径）
#[tauri::command]
pub fn session_digest_command(agent_id: &str, cwd: &str, prompt: &str) -> Result<String, String> {
    let binary = binary_for(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    #[cfg(target_os = "windows")]
    return windows_digest_command_line(agent_id, cwd, prompt, binary);
    #[cfg(not(target_os = "windows"))]
    digest_command_line_with(agent_id, cwd, prompt, binary)
}

/// 在外部终端应用中以「读简报续作」开新会话；使用与内嵌启动相同的 profile 注入计划。
#[tauri::command]
pub fn digest_external_terminal(
    store: tauri::State<'_, ProfileStore>,
    agent_id: &str,
    cwd: &str,
    prompt: &str,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    open_external_profiled(
        &store,
        agent_id,
        profile_id.as_deref(),
        None,
        None,
        model.as_deref(),
        cwd,
        None,
        Some(prompt),
    )
}

#[cfg(target_os = "macos")]
fn open_external_terminal(cmd: &str, pref: &str, cwd: &str, wrapper: &Path) -> Result<(), String> {
    match pref {
        "ghostty" => open_ghostty(cmd, cwd, wrapper),
        "iterm" => open_iterm(cmd),
        "terminal" => open_terminal_app(cmd),
        // auto：Ghostty → iTerm → Terminal.app
        _ if std::path::Path::new("/Applications/Ghostty.app").exists() => {
            open_ghostty(cmd, cwd, wrapper)
        }
        _ if std::path::Path::new("/Applications/iTerm.app").exists() => open_iterm(cmd),
        _ => open_terminal_app(cmd),
    }
}

#[cfg(target_os = "macos")]
fn open_ghostty(cmd: &str, cwd: &str, wrapper: &Path) -> Result<(), String> {
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
    // 已运行：使用 Ghostty 自带 AppleScript 字典直接创建带 command 的窗口。
    // 旧实现通过 System Events 模拟 ⌘N/⌘V/回车：辅助功能权限或脚本任一步失败时，
    // 命令可能已经贴进终端但 wrapper 随错误返回被删除，最终变成「No such file」。
    // 原生 new surface configuration 不需要控制 System Events，也不经过剪贴板。
    // Ghostty 的 command 字段会自动包装成 `exec -l <command>`，所以不能传
    // `cd ... && ...`；否则会变成 `exec -l cd ...`。另外，command 字段对带空格
    // 的 shell 命令路径（本机 wrapper 位于 `Application Support`）不会可靠保留
    // POSIX 引号。让 Ghostty 先启动 /bin/sh，再通过 initial input 交给 shell
    // 解析一次路径，避免出现“wrapper 不存在”的假错误。
    let initial_working_directory = expand_home_path(cwd);
    let initial_input = format!(
        "exec /bin/sh {}\n",
        sh_quote_if_needed(&wrapper.to_string_lossy())
    );
    let escaped_cwd = applescript_escape(&initial_working_directory);
    let escaped_input = applescript_escape(&initial_input);
    spawn_status(
        Command::new("osascript").args([
            "-e",
            "tell application \"Ghostty\"",
            "-e",
            "set cfg to new surface configuration",
            "-e",
            &format!("set initial working directory of cfg to \"{escaped_cwd}\""),
            "-e",
            "set command of cfg to \"/bin/sh\"",
            "-e",
            &format!("set initial input of cfg to \"{escaped_input}\""),
            "-e",
            "new window with configuration cfg",
            "-e",
            "activate",
            "-e",
            "end tell",
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
fn open_external_terminal(cmd: &str, _pref: &str, _cwd: &str, _wrapper: &Path) -> Result<(), String> {
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
fn open_external_terminal(cmd: &str, pref: &str, _cwd: &str, _wrapper: &Path) -> Result<(), String> {
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
        readonly_supported: !spec.readonly_args.is_empty(),
        model_switch: match spec.model_switch {
            crate::agent_specs::ModelSwitch::Direct(t) => {
                Some(ModelSwitchDto::Direct(t.to_string()))
            }
            crate::agent_specs::ModelSwitch::Picker(c) => {
                Some(ModelSwitchDto::Picker(c.to_string()))
            }
            crate::agent_specs::ModelSwitch::None => None,
        },
        effort: spec.effort_levels.map(|(levels, cmd)| EffortSpecDto {
            levels: levels.iter().map(|s| s.to_string()).collect(),
            command: cmd.to_string(),
        }),
        submit_csi_u: spec.submit_csi_u,
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
    /// Files that can be safely cleaned by removing only Ccode-owned API keys.
    pub cleanup_supported: bool,
}

/// auth 文件里标识「官方账号已登录」的凭证字段名（各家结构不同，命中任一即算）：
/// codex tokens.access_token、claude claudeAiOauth.accessToken、gemini access_token / refresh_token。
/// 注意 OPENAI_API_KEY 不在此列——那是 API Key 模式（第三方中转同一形状），
/// 由 OfficialAccountSpec.api_key_fields 单独识别，不能算作官方账号连接
const CREDENTIAL_FIELD_NAMES: &[&str] = &[
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "id_token",
];

/// 递归（限深）查找指定字段：值是非空字符串才命中；防御式——结构随版本漂移时不误判
fn json_has_field(value: &serde_json::Value, fields: &[&str], depth: u8) -> bool {
    if depth == 0 || fields.is_empty() {
        return false;
    }
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
            (fields.contains(&k.as_str()) && v.as_str().is_some_and(|s| !s.is_empty()))
                || json_has_field(v, fields, depth - 1)
        }),
        _ => false,
    }
}

/// 单个 auth 文件的只读探测；文件不存在/不可读 → None（按缺失处理）。
/// api_key_fields 命中（且无官方凭证字段）→ ApiKeyMode：API Key 模式不算官方账号连接
fn probe_auth_file(path: &std::path::Path, api_key_fields: &[&str]) -> Option<AuthProbe> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if json_has_field(&v, CREDENTIAL_FIELD_NAMES, 4) => AuthProbe::Connected,
        Ok(v) if json_has_field(&v, api_key_fields, 4) => AuthProbe::ApiKeyMode,
        Ok(_) => AuthProbe::Unrecognized,
        Err(_) => AuthProbe::Corrupt,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum AuthProbe {
    Connected,
    /// API Key 模式（如 codex auth.json 顶层 OPENAI_API_KEY）：可能是官方 --api-key，
    /// 也可能是第三方中转，不能显示为「已连接官方账号」
    ApiKeyMode,
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

fn toml_conflict_keys(text: &str, keys: &[&str]) -> Vec<String> {
    let Ok(value) = text.parse::<toml::Value>() else { return Vec::new() };
    let mut out = value
        .as_table()
        .into_iter()
        .flat_map(|table| table.keys())
        .filter(|key| keys.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
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
        } else if probe.file.ends_with(".toml") {
            toml_conflict_keys(&text, probe.keys)
        } else {
            dotenv_conflict_keys(&text, probe.keys)
        };
        for key in hits {
            out.push(format!("~/{} 中存在 {}，{}", probe.file, key, probe.note));
        }
    }
    out
}

fn clear_conflict_keys_in_file(path: &std::path::Path, probe: &crate::agent_specs::ConflictProbe) -> Result<bool, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    if probe.file.ends_with(".json") {
        let mut value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("{} 不是合法 JSON，已停止清理: {e}", path.display()))?;
        let Some(env) = value.get_mut("env").and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        let mut changed = false;
        for key in probe.keys {
            changed |= env.remove(*key).is_some();
        }
        if changed {
            let mut out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
            out.push('\n');
            crate::profiles::atomic_write(path, &out)?;
            tighten_private_file(path)?;
        }
        return Ok(changed);
    }
    if probe.file.ends_with(".toml") {
        let mut doc = text.parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("{} 不是合法 TOML，已停止清理: {e}", path.display()))?;
        let mut changed = false;
        for key in probe.keys {
            changed |= doc.remove(key).is_some();
        }
        if changed {
            crate::profiles::atomic_write(path, &doc.to_string())?;
            tighten_private_file(path)?;
        }
        return Ok(changed);
    }
    if probe.file.ends_with(".env") {
        let mut changed = false;
        let lines: Vec<String> = text
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed);
                let name = assignment.split_once('=').map(|(name, _)| name.trim());
                let remove = name.is_some_and(|name| probe.keys.contains(&name));
                changed |= remove;
                !remove
            })
            .map(String::from)
            .collect();
        if changed {
            let mut out = lines.join("\n");
            out.push('\n');
            crate::profiles::atomic_write(path, &out)?;
            tighten_private_file(path)?;
        }
        return Ok(changed);
    }
    Ok(false)
}

fn tighten_private_file(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("收紧冲突配置权限失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_account_conflicts(agent_id: &str) -> Result<Vec<String>, String> {
    let spec = agent_spec(agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let oa = spec
        .official_account
        .as_ref()
        .ok_or_else(|| "该 agent 没有可清理的官方账号冲突项".to_string())?;
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    let backup_dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("conflict-backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("创建冲突备份目录失败: {e}"))?;
    let mut changed = Vec::new();
    for probe in oa.conflict_probes {
        if !probe.file.ends_with(".json") && !probe.file.ends_with(".env") && !probe.file.ends_with(".toml") {
            continue;
        }
        let path = home.join(probe.file);
        if path.is_file() {
            let backup = backup_dir.join(format!(
                "{}-{}-{}.bak",
                agent_id,
                uuid::Uuid::new_v4(),
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            std::fs::copy(&path, &backup).map_err(|e| format!("备份冲突文件失败: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| format!("设置冲突备份权限失败: {e}"))?;
            }
            if clear_conflict_keys_in_file(&path, probe)? {
                changed.push(format!("~/{}（备份已保存）", probe.file));
            } else {
                let _ = std::fs::remove_file(&backup);
            }
        }
    }
    Ok(changed)
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
            cleanup_supported: false,
        };
    };
    let Some(oa) = spec.official_account.as_ref() else {
        return OfficialAccountStatusDto {
            supported: false,
            connected: false,
            detail: Some("该 CLI 暂未接入官方账号（不支持或无官方账号语义）".into()),
            login_command: None,
            conflicts: Vec::new(),
            cleanup_supported: false,
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
    let mut api_key_mode: Option<String> = None;
    let mut corrupt: Option<String> = None;
    let candidates = home
        .as_ref()
        .map(|h| auth_probe_candidates(h, oa))
        .unwrap_or_default();
    for (rel, path) in &candidates {
        match probe_auth_file(path, oa.api_key_fields) {
            Some(AuthProbe::Connected) => {
                return OfficialAccountStatusDto {
                    supported: true,
                    connected: true,
                    detail: Some(format!("已检测到登录凭证（~/{rel}）")),
                    login_command,
                    conflicts,
                    cleanup_supported: oa.conflict_probes.iter().all(|probe| probe.file.ends_with(".json") || probe.file.ends_with(".env") || probe.file.ends_with(".toml")),
                };
            }
            Some(AuthProbe::Unrecognized) => {
                if unrecognized.is_none() {
                    unrecognized = Some(rel.clone());
                }
            }
            Some(AuthProbe::ApiKeyMode) => {
                if api_key_mode.is_none() {
                    api_key_mode = Some(rel.clone());
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
    } else if let Some(rel) = api_key_mode {
        // API Key 模式不是官方账号：官方 --api-key 与第三方中转（如 cc-switch）写出的
        // 文件形状相同，文件层面无法区分，如实说明而不显示「已连接官方账号」
        format!("~/{rel} 是 API Key 配置（可能来自官方 --api-key 或第三方中转），不是官方账号登录")
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
        cleanup_supported: oa.conflict_probes.iter().all(|probe| probe.file.ends_with(".json") || probe.file.ends_with(".env") || probe.file.ends_with(".toml")),
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
            no_auth: false,
            protocol: None,
            base_url: base_url.map(|s| s.into()),
            models: vec![],
            extra_env: std::collections::HashMap::new(),
            request_policy: crate::profiles::RequestPolicy::default(),
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
        // _NAME 槽是选择器显示名：带 profile 名（配置名 · 模型）
        assert!(plan.env.contains(&(
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".into(),
            "测试 · m2".into()
        )));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), "m3".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_DEFAULT_FABLE_MODEL".into(), "m4".into())));
        assert!(plan
            .env
            .contains(&("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), "m5".into())));
        assert!(plan.env.contains(&(
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(),
            "测试 · m5".into()
        )));
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
    fn claude_request_policy_injects_verified_channels() {
        let mut p = profile("claude-code", None);
        p.request_policy.temperature = Some(0.7);
        p.request_policy.top_p = Some(0.9);
        p.request_policy.max_output_tokens = Some(8192);
        p.request_policy.reasoning_effort = Some("high".into());
        p.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        p.request_policy
            .header_env
            .insert("X-Miss".into(), "MISSING_VAR".into());
        let mut plan = LaunchPlan::default();
        apply_request_policy_env(&mut plan, "claude-code", &p.request_policy, &|k| {
            (k == "MODEL_REGION").then(|| "cn-1".to_string())
        });
        // temperature/top_p 合并进同一个 EXTRA_BODY JSON（只含填了的字段）
        let body = plan
            .env
            .iter()
            .find(|(k, _)| k == "CLAUDE_CODE_EXTRA_BODY")
            .map(|(_, v)| v.clone())
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["temperature"], 0.7);
        assert_eq!(v["top_p"], 0.9);
        assert!(plan
            .env
            .contains(&("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), "8192".into())));
        assert!(plan
            .env
            .contains(&("CLAUDE_CODE_EFFORT_LEVEL".into(), "high".into())));
        // 解析不到的环境变量跳过该 header，不注空值
        assert!(plan
            .env
            .contains(&("ANTHROPIC_CUSTOM_HEADERS".into(), "X-Region: cn-1".into())));
    }

    #[test]
    fn codebuddy_request_policy_uses_own_prefix_and_skips_unverified() {
        let mut p = profile("codebuddy", None);
        p.request_policy.temperature = Some(0.7); // 无 EXTRA_BODY 通道：不注
        p.request_policy.max_output_tokens = Some(4096);
        p.request_policy.reasoning_effort = Some("high".into()); // unknown：不注
        p.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        let mut plan = LaunchPlan::default();
        apply_request_policy_env(&mut plan, "codebuddy", &p.request_policy, &|k| {
            (k == "MODEL_REGION").then(|| "cn-1".to_string())
        });
        assert_eq!(plan.env.len(), 2);
        assert!(plan
            .env
            .contains(&("CODEBUDDY_CODE_MAX_OUTPUT_TOKENS".into(), "4096".into())));
        assert!(plan
            .env
            .contains(&("CODEBUDDY_CUSTOM_HEADERS".into(), "X-Region: cn-1".into())));
    }

    #[test]
    fn request_policy_not_injected_for_unverified_agents_or_official() {
        // 未实证 agent（codex）：任何策略字段都不产生 env
        let mut p = profile("codex", None);
        p.request_policy.temperature = Some(0.2);
        let plan = launch_plan(&p, None, None);
        assert!(!plan.env.iter().any(|(k, _)| {
            k.contains("EXTRA_BODY")
                || k.contains("EFFORT")
                || k.contains("CUSTOM_HEADERS")
                || k.contains("MAX_OUTPUT_TOKENS")
        }));
        // 官方账号模式：early-return 路径不经过策略注入
        let mut p = profile("claude-code", None);
        p.account_type = crate::profiles::AccountType::Official;
        p.request_policy.max_output_tokens = Some(8192);
        let plan = launch_plan(&p, None, None);
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
    }

    #[test]
    fn extra_env_overrides_policy_injection() {
        // 用户 extra_env 与策略注入同键时排在最后（CommandBuilder 后者生效）
        let mut p = profile("claude-code", None);
        p.request_policy.temperature = Some(0.7);
        p.extra_env
            .insert("CLAUDE_CODE_EXTRA_BODY".into(), "{\"temperature\":0.1}".into());
        let plan = launch_plan(&p, None, None);
        let last = plan
            .env
            .iter()
            .rposition(|(k, _)| k == "CLAUDE_CODE_EXTRA_BODY")
            .unwrap();
        assert_eq!(plan.env[last].1, "{\"temperature\":0.1}");
    }

    #[test]
    fn codex_request_policy_injects_effort_and_env_headers() {
        let mut p = profile("codex", Some("https://relay.example.com/v1"));
        p.request_policy.reasoning_effort = Some("high".into());
        p.request_policy.temperature = Some(0.2); // 无通道：不注
        p.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        let plan = launch_plan(&p, None, Some("gpt-x"));
        assert!(plan
            .args
            .iter()
            .any(|a| a == r#"model_reasoning_effort="high""#));
        assert!(plan
            .args
            .iter()
            .any(|a| a == r#"model_providers.ccode.env_http_headers."X-Region"="MODEL_REGION""#));
        // 无 base_url = 无内联 provider 可挂，headers 不注；effort 是全局键照常
        let mut p2 = profile("codex", None);
        p2.request_policy
            .header_env
            .insert("X-Region".into(), "MODEL_REGION".into());
        let plan2 = launch_plan(&p2, None, None);
        assert!(!plan2.args.iter().any(|a| a.contains("env_http_headers")));
    }

    #[test]
    fn opencode_request_policy_merges_into_inline_config() {
        let mut p = profile("opencode", Some("https://relay.example.com/v1"));
        p.models = vec!["m1".into()];
        p.request_policy.temperature = Some(0.3);
        p.request_policy.max_output_tokens = Some(4096);
        p.request_policy.reasoning_effort = Some("low".into());
        let plan = launch_plan(&p, None, Some("m1"));
        let raw = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap()
            .1
            .clone();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let opts = &v["provider"]["ccode"]["models"]["m1"]["options"];
        assert_eq!(opts["temperature"], 0.3);
        assert_eq!(opts["maxOutputTokens"], 4096);
        assert_eq!(opts["reasoningEffort"], "low");
        // headers 引用的环境变量未设置时不进配置（不落空值/密文）
        assert!(v["provider"]["ccode"]["options"].get("headers").is_none());
    }

    #[test]
    fn kimi_request_policy_effort_only_on_kimi_channel() {
        let mut p = profile("kimi", Some("https://api.moonshot.cn"));
        p.request_policy.reasoning_effort = Some("High".into());
        let plan = launch_plan(&p, None, Some("kimi-k3"));
        assert!(plan
            .env
            .contains(&("KIMI_MODEL_THINKING_EFFORT".into(), "high".into())));
        // anthropic 兼容通道该 env 被 CLI 静默忽略——干脆不注
        p.protocol = Some("anthropic".into());
        let plan = launch_plan(&p, None, Some("kimi-k3"));
        assert!(!plan
            .env
            .iter()
            .any(|(k, _)| k == "KIMI_MODEL_THINKING_EFFORT"));
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
    fn grok_plan_injects_xai_env() {
        let mut p = profile("grok", Some("https://relay.example.com/v1"));
        p.models = vec!["grok-code-fast-1".into(), "grok-4.5".into()];
        let plan = launch_plan(&p, Some("xai-secret".into()), Some("grok-code-fast-1"));
        assert!(plan
            .env
            .contains(&("GROK_MODELS_BASE_URL".into(), "https://relay.example.com/v1".into())));
        assert!(plan
            .env
            .contains(&("XAI_API_KEY".into(), "xai-secret".into())));
        assert!(plan
            .env
            .contains(&("GROK_DEFAULT_MODEL".into(), "grok-code-fast-1".into())));
        // 模型列表经 GROK_CONFIG overlay 收敛进选择器（allowed_models）
        let grok_config = plan
            .env
            .iter()
            .find(|(k, _)| k == "GROK_CONFIG")
            .map(|(_, v)| v.clone())
            .expect("grok 有模型列表时必须注入 GROK_CONFIG");
        let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
        assert_eq!(
            v["models"]["allowed_models"],
            serde_json::json!(["grok-code-fast-1", "grok-4.5"])
        );
        // 初始 prompt 是位置参数（一键开步注入）
        let plan = launch_plan_with_prompt(&p, Some("xai-secret".into()), None, Some("干活"));
        assert_eq!(plan.prompt_args, vec!["干活"]);
        // 空模型列表不注入 GROK_CONFIG（allowed_models 空 = fail-closed 全不匹配）
        let empty = profile("grok", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&empty, Some("xai-secret".into()), None);
        assert!(!plan.env.iter().any(|(k, _)| k == "GROK_CONFIG"));
    }

    #[test]
    fn grok_official_plan_purges_api_env() {
        // 官方账号拉起：不注入 API env，且必须 env_remove 残留密钥变量（凭证优先级 api_key > env_key > 登录 token）
        let p = official_profile("grok");
        let plan = launch_plan(&p, None, None);
        assert!(!plan.env.iter().any(|(k, _)| k.starts_with("XAI_") || k.starts_with("GROK_")));
        assert!(plan.env_remove.contains(&"XAI_API_KEY".to_string()));
        assert!(plan.env_remove.contains(&"GROK_CODE_XAI_API_KEY".to_string()));
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
    fn readonly_launch_args_per_agent() {
        // 硬保护矩阵（注册表 readonly_args）：六家有只读/计划模式参数
        assert_eq!(
            readonly_launch_args("claude-code", &[]).unwrap(),
            vec!["--permission-mode", "plan"]
        );
        assert_eq!(
            readonly_launch_args("gemini", &[]).unwrap(),
            vec!["--approval-mode", "plan"]
        );
        assert_eq!(readonly_launch_args("kimi", &[]).unwrap(), vec!["--plan"]);
        assert_eq!(readonly_launch_args("cursor", &[]).unwrap(), vec!["--plan"]);
        assert_eq!(
            readonly_launch_args("codebuddy", &[]).unwrap(),
            vec!["--permission-mode", "plan"]
        );
        // grok：dontAsk（CI 严格白名单）+ sandbox read-only（OS 级只读）
        assert_eq!(
            readonly_launch_args("grok", &[]).unwrap(),
            vec!["--permission-mode", "dontAsk", "--sandbox", "read-only"]
        );
        // codex：只读替换默认的 -s workspace-write（先剔除原沙箱参数对再追加）
        let base: Vec<String> = vec!["-c".into(), "x=1".into(), "-s".into(), "workspace-write".into()];
        assert_eq!(
            readonly_launch_args("codex", &base).unwrap(),
            vec!["-c", "x=1", "-s", "read-only"]
        );
        // 无只读参数（qwen/opencode）与未知 agent：None = 只有软约束，调用方原样用 plan.args
        assert!(readonly_launch_args("qwen", &[]).is_none());
        assert!(readonly_launch_args("opencode", &[]).is_none());
        assert!(readonly_launch_args("nope", &[]).is_none());
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
        // 会话内自省：模型显示名随启动注入（配置名 · 模型），agent 可查
        assert!(plan.env.contains(&(
            "CCODE_MODEL_DISPLAY_NAME".into(),
            format!("{} · gpt-5-codex", p.name),
        )));
    }

    #[test]
    fn codex_plan_without_model_has_no_display_name_env() {
        let p = profile("codex", Some("https://relay.example.com/v1"));
        let plan = launch_plan(&p, Some("sk-secret".into()), None);
        assert!(!plan.env.iter().any(|(k, _)| k == "CCODE_MODEL_DISPLAY_NAME"));
    }

    #[test]
    fn codex_plan_without_base_url_has_no_provider_args() {
        let p = profile("codex", None);
        let plan = launch_plan(&p, None, None);
        // 无 provider 参数，只有默认沙箱参数 + 沙箱内联网放开
        assert_eq!(
            plan.args,
            vec![
                "-s",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true"
            ]
        );
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
            "KIMI_MODEL_DISPLAY_NAME",
            "KIMI_MODEL_CAPABILITIES",
            "KIMI_MODEL_MAX_CONTEXT_SIZE",
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
        // 默认沙箱与认证方式无关，官方账号同样生效；沙箱内联网同步放开
        assert!(joined.contains("-s workspace-write"));
        assert!(joined.contains("sandbox_workspace_write.network_access=true"));
        assert!(plan.env_remove.contains(&"CODEX_API_KEY".into()));
        assert!(plan.env_remove.contains(&"OPENAI_API_KEY".into()));
        // 模型为空：只剩沙箱参数
        let bare = launch_plan(&p, None, None);
        assert_eq!(
            bare.args,
            vec![
                "-s",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=true"
            ]
        );
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
        // kimi 没有可用于交互新会话的初始 prompt 参数：不注入 + 标记。
        let p = profile("kimi", None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开工"));
        assert!(plan.prompt_args.is_empty(), "kimi 不得注入");
        assert!(plan.prompt_dropped, "kimi 应置 dropped 标记");
        // OpenCode 1.18.x 的 --prompt 是交互会话可用的显式参数。
        let p = profile("opencode", None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开工"));
        assert_eq!(plan.prompt_args, vec!["--prompt", "开工"]);
        assert!(!plan.prompt_dropped);
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

    fn probe_temp(name: &str, content: &str, api_key_fields: &[&str]) -> Option<AuthProbe> {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        let probe = probe_auth_file(&path, api_key_fields);
        std::fs::remove_dir_all(&dir).ok();
        probe
    }

    #[test]
    fn auth_probe_detects_codex_chatgpt_and_apikey_shapes() {
        // ChatGPT 账号：tokens.access_token
        let probe = probe_temp(
            "auth.json",
            r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"x","access_token":"tok","refresh_token":"r"},"last_refresh":"2026-01-01T00:00:00Z"}"#,
            &["OPENAI_API_KEY"],
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
        // API key 模式：顶层 OPENAI_API_KEY（官方 --api-key 与第三方中转同一形状），
        // 不算官方账号连接
        let probe = probe_temp(
            "auth.json",
            r#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#,
            &["OPENAI_API_KEY"],
        );
        assert_eq!(probe, Some(AuthProbe::ApiKeyMode));
        // 规格没声明 api_key_fields 时同样形状回落 Unrecognized（不误判已连接）
        let probe = probe_temp("auth.json", r#"{"OPENAI_API_KEY":"sk-x"}"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
    }

    #[test]
    fn auth_probe_detects_nested_claude_and_flat_gemini_shapes() {
        // claude：凭证嵌套在 claudeAiOauth 下（camelCase）
        let probe = probe_temp(
            ".credentials.json",
            r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":123}}"#,
            &[],
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
        // gemini：google-auth-library Credentials 扁平结构
        let probe = probe_temp(
            "oauth_creds.json",
            r#"{"access_token":"tok","refresh_token":"r","scope":"s","token_type":"Bearer","expiry_date":123}"#,
            &[],
        );
        assert_eq!(probe, Some(AuthProbe::Connected));
    }

    #[test]
    fn auth_probe_is_defensive_on_missing_corrupt_and_unrecognized() {
        // 缺失 → None
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(probe_auth_file(&dir.join("nope.json"), &[]), None);
        // 损坏（截断的 JSON）→ Corrupt，不误判为已连接
        let probe = probe_temp("auth.json", r#"{"tokens":{"access_token":"to"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Corrupt));
        // 合法 JSON 但无凭证字段 → Unrecognized
        let probe = probe_temp("auth.json", r#"{"foo":"bar","n":1}"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
        // 空字符串凭证不算命中
        let probe = probe_temp("auth.json", r#"{"access_token":""}"#, &[]);
        assert_eq!(probe, Some(AuthProbe::Unrecognized));
    }

    // ===== auth 候选展开（/* 目录扫描）=====

    #[test]
    fn auth_candidates_expand_dir_scan_and_skip_subdirs_and_non_json() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let cred = dir.join(".kimi-code/credentials");
        std::fs::create_dir_all(cred.join("mcp")).unwrap();
        // 文件名取 Windows 也合法的形式（kimi 实际命名含冒号，仅 unix 能建）
        std::fs::write(cred.join("managed-kimi-code.json"), "{}").unwrap();
        std::fs::write(cred.join("notes.txt"), "{}").unwrap();
        std::fs::write(cred.join("mcp/server.json"), "{}").unwrap();
        let oa = crate::agent_specs::OfficialAccountSpec {
            login_cmd: &["login"],
            auth_file_paths: &[".kimi-code/credentials/*"],
            env_purge_list: &["KIMI_API_KEY"],
            conflict_probes: &[],
            detection_note: None,
            api_key_fields: &[],
        };
        let found = auth_probe_candidates(&dir, &oa);
        // 只命中直接子级 .json：mcp/ 子目录与 .txt 都排除
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, ".kimi-code/credentials/managed-kimi-code.json");
        assert!(found[0].1.ends_with("managed-kimi-code.json"));
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
        // 合成模型元数据：显示名 = profile 名 · 模型；上下文按模型映射（k2 = 128K）
        assert!(plan.env.contains(&(
            "KIMI_MODEL_DISPLAY_NAME".into(),
            "测试 · kimi-k2".into()
        )));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_MAX_CONTEXT_SIZE".into(),
            "131072".into()
        )));
        // kimi 官方协议不注入 CAPABILITIES（CLI 默认 ["image_in","thinking"] 已合理）
        assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
        assert!(plan.args.is_empty());
    }

    #[test]
    fn kimi_plan_thinking_model_declares_capabilities_on_compat_protocol() {
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("kimi-k2-thinking"));
        // 兼容协议通道 capabilities 缺省只有 ["tool_use"]：思考模型要显式声明
        assert!(plan.env.contains(&(
            "KIMI_MODEL_CAPABILITIES".into(),
            "tool_use,thinking".into()
        )));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_DISPLAY_NAME".into(),
            "测试 · kimi-k2-thinking".into()
        )));
    }

    #[test]
    fn kimi_plan_plain_model_omits_capabilities() {
        // 非思考模型不声明 capabilities：留空走 CLI registry 默认，避免降级
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("deepseek-chat"));
        assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
        // 显示名与上下文照常注入
        assert!(plan.env.contains(&(
            "KIMI_MODEL_DISPLAY_NAME".into(),
            "测试 · deepseek-chat".into()
        )));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_MAX_CONTEXT_SIZE".into(),
            "131072".into()
        )));
    }

    #[test]
    fn kimi_plan_vision_model_declares_image_in_on_compat_protocol() {
        // 多模态思考模型（kimi-k3）：tool_use + thinking + image_in
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("kimi-k3"));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_CAPABILITIES".into(),
            "tool_use,thinking,image_in".into()
        )));
        // 纯视觉非思考模型（gpt-4o）：tool_use + image_in，不带 thinking
        let mut p = profile("kimi", Some("https://relay.example.com/v1"));
        p.protocol = Some("openai".into());
        let plan = launch_plan(&p, None, Some("gpt-4o"));
        assert!(plan.env.contains(&(
            "KIMI_MODEL_CAPABILITIES".into(),
            "tool_use,image_in".into()
        )));
        // kimi 官方协议通道：CLI 缺省 ["image_in","thinking"] 已合理，不注入
        let p = profile("kimi", None);
        let plan = launch_plan(&p, None, Some("kimi-k3"));
        assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
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
            // 每个条目带显示名（配置名 · 模型）与 limit.context（注册表保守默认 128K）
            // + limit.output（opencode 1.18 起 schema 必填，缺省 8192）
            assert_eq!(models[m]["name"].as_str(), Some(format!("测试 · {m}").as_str()));
            assert_eq!(models[m]["limit"]["context"].as_i64(), Some(131_072));
            assert_eq!(models[m]["limit"]["output"].as_i64(), Some(8192));
        }
        // provider 级 name = profile 名（选择器不再显示内部 id "ccode"）
        assert_eq!(config["provider"]["ccode"]["name"].as_str(), Some("测试"));
        // 表外未知模型不声明 reasoning
        assert!(models["m1"].get("reasoning").is_none());
        // 视觉模型补 modalities（input 含 image）；非视觉模型不声明
        let v2 = opencode_provider_json(&{
            let mut p2 = profile("opencode", Some("https://openrouter.ai/api/v1"));
            p2.models = vec!["kimi-k3".into(), "deepseek-chat".into()];
            p2
        }, None, None);
        let models2 = v2["models"].as_object().unwrap();
        assert_eq!(
            models2["kimi-k3"]["modalities"]["input"],
            serde_json::json!(["text", "image"])
        );
        assert!(models2["deepseek-chat"].get("modalities").is_none());
    }

    #[test]
    fn opencode_inject_marks_thinking_model_reasoning() {
        // 注册表命中思考模型 → models 条目带 reasoning: true
        let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
        p.models = vec!["deepseek-reasoner".into()];
        let plan = launch_plan(&p, None, None);
        let (_, v) = plan
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(v).unwrap();
        assert_eq!(
            config["provider"]["ccode"]["models"]["deepseek-reasoner"]["reasoning"],
            true
        );
    }

    #[test]
    fn codex_catalog_contains_every_model_with_template_shape() {
        let v = codex_catalog_json("测试", &["gpt-5-codex".into(), "gpt-5.1".into()]);
        let models = v["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        let e = &models[0];
        assert_eq!(e["slug"], "gpt-5-codex");
        // display_name 带 profile 名（选择器不再是裸模型 id）
        assert_eq!(e["display_name"], "测试 · gpt-5-codex");
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
        // 能力字段：有效上下文 95%（自动压缩阈值）、如实声明无 search tool
        assert_eq!(e["effective_context_window_percent"], 95);
        assert_eq!(e["supports_search_tool"], false);
        // 图像输入按能力注册表：gpt-5 系不在确知多模态清单 → 仅 text
        assert_eq!(e["input_modalities"], serde_json::json!(["text"]));
        // 确知多模态（kimi-k3）→ text + image
        let v2 = codex_catalog_json("测试", &["kimi-k3".into()]);
        assert_eq!(
            v2["models"][0]["input_modalities"],
            serde_json::json!(["text", "image"])
        );
    }

    #[test]
    fn codex_catalog_written_atomically() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("catalogs").join("codex-p1.json");
        write_codex_catalog_to(&path, "测试", &["m1".into()]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["models"][0]["slug"], "m1");
        assert_eq!(v["models"][0]["display_name"], "测试 · m1");
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
        // 裸名（shell 脚本）与 .cmd 并存时 .cmd 胜出：裸名在 Windows 上不可执行（os error 193）
        std::fs::write(base.join("tool2"), "x").unwrap();
        std::fs::write(base.join("tool2.cmd"), "x").unwrap();
        assert_eq!(
            find_in_dirs("tool2", &[base.clone()]),
            Some(base.join("tool2.cmd"))
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
        assert_eq!(
            resume_command_line("grok", "abc", "/tmp/proj").unwrap(),
            "cd /tmp/proj && grok -r abc"
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
            resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/.kimi-code/bin/kimi", &[]).unwrap(),
            "cd /tmp && /Users/x/.kimi-code/bin/kimi -S abc"
        );
        // 绝对路径含空格 → binary 也必须 shell 转义（否则命令行在空格处断裂）
        assert_eq!(
            resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/My Apps/bin/kimi", &[]).unwrap(),
            "cd /tmp && '/Users/x/My Apps/bin/kimi' -S abc"
        );
    }

    #[test]
    fn resume_command_with_codex_inline_provider() {
        // codex 内联 provider 会话（rollout 记 model_provider="ccode"）外部恢复必须带 -c 定义，
        // 否则报 "Model provider `ccode` not found"；定义只含 base_url/env_key 引用，不含密钥
        let extra = resume_extra_args("codex", Some("https://relay.example.com/v1"));
        let cmd =
            resume_command_line_with("codex", "abc", "/tmp/proj", "codex", &extra).unwrap();
        // kv 值含双引号 → 单引号包裹（sh_quote_if_needed），语义无损
        assert!(cmd.contains(r#"-c 'model_providers.ccode.base_url="https://relay.example.com/v1"'"#));
        assert!(cmd.contains(r#"-c 'model_provider="ccode"'"#));
        assert!(cmd.starts_with("cd /tmp/proj && codex resume abc"));
        // 非 codex / 无 base_url：不追加任何定义（env 注入型 agent 裸 resume 即可）
        assert!(resume_extra_args("claude-code", Some("https://x")).is_empty());
        assert!(resume_extra_args("codex", None).is_empty());
        assert!(resume_extra_args("codex", Some("  ")).is_empty());
        let bare = resume_command_line_with(
            "codex",
            "abc",
            "/tmp/proj",
            "codex",
            &resume_extra_args("codex", None),
        )
        .unwrap();
        assert_eq!(bare, "cd /tmp/proj && codex resume abc");
    }

    #[cfg(windows)]
    #[test]
    fn windows_resume_line_uses_cmd_dialect() {
        // cmd 方言：cd /d + 双引号；裸名与含空格路径统一包裹
        assert_eq!(
            windows_resume_command_line("claude-code", "abc", r"C:\work\my proj", r"C:\tools\claude.cmd", &[]).unwrap(),
            r#"cd /d "C:\work\my proj" && "C:\tools\claude.cmd" -r "abc""#
        );
        // cwd 含单引号：从结构化参数生成，不受 POSIX 转义影响
        let line = windows_resume_command_line("kimi", "abc", r"C:\it's\proj", "kimi", &[]).unwrap();
        assert_eq!(line, r#"cd /d "C:\it's\proj" && "kimi" -S "abc""#);
        assert!(windows_resume_command_line("no-such", "abc", r"C:\x", "x", &[]).is_err());
        // codex provider 定义：flag 裸名、kv 值双引号包裹（内嵌引号 doubling）
        let with_provider = windows_resume_command_line(
            "codex", "abc", r"C:\p", "codex",
            &resume_extra_args("codex", Some("https://relay.example.com/v1")),
        ).unwrap();
        assert!(with_provider.contains(r#"-c "model_provider=""ccode"""#));
    }

    #[test]
    fn digest_command_line_formats_per_agent() {
        let prompt = "读 .ccode/handoff-x.md 接力简报，继续完成任务";
        // Positional：prompt 追加为位置参数（含空格/中文 → 单引号包裹）
        assert_eq!(
            digest_command_line_with("claude-code", "/tmp/proj", prompt, "claude").unwrap(),
            format!("cd /tmp/proj && claude '{prompt}'")
        );
        assert_eq!(
            digest_command_line_with("codex", "/tmp/proj", prompt, "codex").unwrap(),
            format!("cd /tmp/proj && codex '{prompt}'")
        );
        // Flag：-i '<prompt>'
        assert_eq!(
            digest_command_line_with("gemini", "/tmp/proj", prompt, "gemini").unwrap(),
            format!("cd /tmp/proj && gemini -i '{prompt}'")
        );
        // Unsupported（kimi）与未知 agent 报错；OpenCode 1.18.x 已支持 --prompt
        assert!(digest_command_line_with("kimi", "/tmp/proj", prompt, "kimi").is_err());
        assert_eq!(
            digest_command_line_with("opencode", "/tmp/proj", prompt, "opencode").unwrap(),
            format!("cd /tmp/proj && opencode --prompt '{prompt}'")
        );
        assert!(digest_command_line_with("no-such", "/tmp", prompt, "x").is_err());
        // cwd 与绝对路径二进制的转义（同 resume 口径）
        assert_eq!(
            digest_command_line_with("qwen", "/tmp/我的 项目", prompt, "/Users/x/My Apps/bin/qwen").unwrap(),
            format!("cd '/tmp/我的 项目' && '/Users/x/My Apps/bin/qwen' -i '{prompt}'")
        );
        // prompt 内嵌单引号 → POSIX 转义
        let quoted = digest_command_line_with("claude-code", "/tmp", "读 it's 简报", "claude").unwrap();
        assert_eq!(quoted, "cd /tmp && claude '读 it'\\''s 简报'");
    }

    #[test]
    fn external_plan_reuses_profile_injections_without_putting_key_in_args() {
        let mut p = profile("codex", Some("https://relay.example.com/v1"));
        p.models = vec!["deepseek-v4".into()];
        let (args, env, _) = external_launch_args(
            "codex",
            &p,
            Some("sk-secret".into()),
            Some("deepseek-v4"),
            Some("session-1"),
            None,
        )
        .unwrap();
        assert!(args.iter().any(|a| a == "model_provider=\"ccode\""));
        assert!(args.iter().any(|a| a == "deepseek-v4"));
        assert!(env.iter().any(|(k, v)| k == "CODEX_API_KEY" && v == "sk-secret"));
        assert!(!args.iter().any(|a| a.contains("sk-secret")));
    }

    #[test]
    fn external_launch_requires_an_explicit_profile_id() {
        assert!(require_external_profile_id(None).is_err());
        assert!(require_external_profile_id(Some("  ")).is_err());
        assert_eq!(require_external_profile_id(Some(" p1 ")).unwrap(), "p1");
    }

    #[test]
    fn no_auth_profile_cleans_inherited_credentials() {
        let mut p = profile("codex", Some("http://127.0.0.1:11434/v1"));
        p.no_auth = true;
        let plan = launch_plan(&p, None, Some("local-model"));
        assert!(plan.env_remove.contains(&"OPENAI_API_KEY".to_string()));
        assert!(plan.env_remove.contains(&"CODEX_API_KEY".to_string()));
    }

    #[test]
    fn external_digest_locks_fixed_session_agents_to_a_new_session_id() {
        let mut p = profile("claude-code", Some("https://relay.example.com"));
        p.models = vec!["sonnet-custom".into()];
        let (args, _, _) = external_launch_args(
            "claude-code",
            &p,
            Some("sk-secret".into()),
            Some("sonnet-custom"),
            None,
            Some("读取简报继续"),
        )
        .unwrap();
        let pos = args.iter().position(|a| a == "--session-id").unwrap();
        assert!(!args[pos + 1].is_empty());
        assert_eq!(args.last().map(String::as_str), Some("读取简报继续"));
    }

    #[cfg(unix)]
    #[test]
    fn external_wrapper_is_private_and_contains_no_secret_in_path() {
        use std::os::unix::fs::PermissionsExt;
        let wrapper = write_external_wrapper(
            "/bin/echo",
            &["hello world".into()],
            &[("CCODE_TEST_SECRET".into(), "sk-secret".into())],
            &["NO_COLOR".into()],
        )
        .unwrap();
        let mode = std::fs::metadata(&wrapper).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!wrapper.to_string_lossy().contains("sk-secret"));
        let body = std::fs::read_to_string(&wrapper).unwrap();
        assert!(body.contains("CCODE_TEST_SECRET='sk-secret'"));
        assert!(body.contains("exec '/bin/echo' 'hello world'"));
        let _ = std::fs::remove_file(wrapper);
    }

    #[cfg(unix)]
    #[test]
    fn external_wrapper_executes_and_removes_itself_before_agent_start() {
        let wrapper = write_external_wrapper(
            "/usr/bin/printf",
            &["%s".into(), "ok".into()],
            &[],
            &[],
        )
        .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg(&wrapper)
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
        assert!(!wrapper.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_digest_line_uses_cmd_dialect() {
        let line = windows_digest_command_line("claude-code", r"C:\work\my proj", "读简报", r"C:\tools\claude.cmd").unwrap();
        assert_eq!(line, r#"cd /d "C:\work\my proj" && "C:\tools\claude.cmd" "读简报""#);
        let line = windows_digest_command_line("gemini", r"C:\x", "读简报", "gemini").unwrap();
        assert_eq!(line, r#"cd /d "C:\x" && "gemini" -i "读简报""#);
        assert!(windows_digest_command_line("kimi", r"C:\x", "读简报", "kimi").is_err());
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

    #[test]
    fn expand_home_path_resolves_tilde_before_shell_quoting() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home_path("~"), home.to_string_lossy());
        assert_eq!(
            expand_home_path("~/Ccode project"),
            home.join("Ccode project").to_string_lossy()
        );
        assert_eq!(expand_home_path("/tmp/project"), "/tmp/project");
    }

    #[cfg(unix)]
    #[test]
    fn external_wrapper_command_does_not_single_quote_tilde() {
        let wrapper = Path::new("/tmp/ccode-wrapper.sh");
        let cmd = external_wrapper_command("~/Ccode project", wrapper);
        assert!(cmd.starts_with("cd "));
        assert!(!cmd.contains("cd '~"));
        assert!(cmd.contains("Ccode project"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candidate_dirs_cover_homebrew_prefixes() {
        let dirs = crate::agent_specs::binary_candidate_dirs();
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/opt/homebrew/bin")));
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/usr/local/bin")));
        // MacTeX/TeXLive（latexmk）：GUI 短 PATH 兜底，批次 E LaTeX 编译链
        assert!(dirs.iter().any(|d| d == std::path::Path::new("/Library/TeX/texbin")));
    }
}
