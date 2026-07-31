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

pub fn binary_for(agent_id: &str) -> Option<&'static str> {
    AGENTS
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

#[tauri::command]
pub fn detect_agents() -> Vec<DetectResult> {
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
}
