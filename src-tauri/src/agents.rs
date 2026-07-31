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

const AGENTS: [(&str, &str); 6] = [
    ("claude-code", "claude"),
    ("codex", "codex"),
    ("gemini", "gemini"),
    ("qwen", "qwen"),
    ("opencode", "opencode"),
    ("kimi", "kimi"),
];

fn detect(binary: &str) -> (Option<String>, Option<String>) {
    let path = match which::which(binary) {
        Ok(p) => p,
        Err(_) => return (None, None),
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

pub fn binary_for(agent_id: &str) -> Option<&'static str> {    AGENTS
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, bin)| *bin)
}

/// kimi 新旧两个产品共用命令，按数据目录推断装的是哪个变体
fn kimi_variant_hint() -> Option<&'static str> {
    let home = dirs::home_dir()?;
    if home.join(".kimi-code").exists() {
        Some("新版")
    } else if home.join(".kimi").exists() {
        Some("旧版")
    } else {
        None
    }
}

/// 检测结果按进程缓存一次（要 spawn 6 个子进程跑 --version，没必要每次重算）
static DETECT_CACHE: std::sync::OnceLock<Vec<DetectResult>> = std::sync::OnceLock::new();

#[tauri::command]
pub async fn detect_agents() -> Vec<DetectResult> {
    DETECT_CACHE
        .get_or_init(|| {
            AGENTS
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
                .collect()
        })
        .clone()
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
        assert!(plan.args.is_empty());
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
}
