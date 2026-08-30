//! 「设为全局默认」：把 profile 写入各 CLI 自己的配置文件。
//! 这是全应用唯一被允许写 CLI 配置的地方；写任何已存在的文件前必须先备份。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 一次计划好的写入：tag 用于备份文件命名（kimi 两个 config.toml 靠它区分）
struct PlannedWrite {
    tag: &'static str,
    path: PathBuf,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEntry {
    tag: String,
    target: String,
    existed: bool,
    backup_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupManifest {
    batch_id: String,
    operation: String,
    entries: Vec<BackupEntry>,
}

#[derive(Debug, Clone)]
struct TxAction {
    tag: String,
    path: PathBuf,
    content: Option<Vec<u8>>,
}

static GLOBAL_CONFIG_MUTEX: Mutex<()> = Mutex::new(());

/// 与 apply_profile_global 同一口径：选中模型求交后再 plan。
fn profile_for_global_write(store: &ProfileStore, profile_id: &str) -> Result<Profile, String> {
    let mut profile = store.get_with_model(profile_id, None)?;
    let first = profile.models.first().cloned();
    crate::combo::apply_to_profile(&mut profile, first.as_deref());
    Ok(profile)
}

fn disk_matches_plans(plans: &[PlannedWrite]) -> bool {
    plans
        .iter()
        .all(|p| crate::drift::planned_matches_live(&p.path, &p.content))
}

/// 托盘选中态：计划产物与磁盘是否一致（子集比对）。None = dry-run 失败，回落「上次写入」。
pub(crate) fn dry_run_matches(store: &ProfileStore, profile: &Profile) -> Option<bool> {
    if profile.account_type == crate::profiles::AccountType::Official {
        return None;
    }
    let profile = profile_for_global_write(store, &profile.id).ok()?;
    let key = crate::profiles::get_key_for_profile(&profile).ok().flatten();
    let home = dirs::home_dir()?;
    let plans = plan_writes(&home, &profile, key.as_deref(), &profile.models).ok()?;
    Some(disk_matches_plans(&plans))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalApplyResultDto {
    pub files: Vec<String>,
    pub validation: crate::profile_validation::ProfileValidationDto,
}

/// 每个 agent 的全局配置目标文件（tag, 相对 home 路径），restore/has_backup 共用
fn target_specs(agent: &str) -> Vec<(&'static str, &'static str)> {
    match agent {
        "claude-code" => vec![("settings.json", ".claude/settings.json")],
        "codex" => vec![
            ("config.toml", ".codex/config.toml"),
            ("auth.json", ".codex/auth.json"),
        ],
        "gemini" => vec![
            (".env", ".gemini/.env"),
            // 光有 .env 不够：gemini ≥0.46 在 base URL 存在时把 env 推断为 gateway 认证，
            // validateAuthMethod 不认 → headless 直接报 auth 错起不来；必须落
            // settings.json 的 selectedType="gemini-api-key"（cc-switch 同口径，审计实证）
            ("settings.json", ".gemini/settings.json"),
        ],
        "qwen" => vec![("settings.json", ".qwen/settings.json")],
        "opencode" => vec![("opencode.json", ".config/opencode/opencode.json")],
        "codebuddy" => vec![("settings.json", ".codebuddy/settings.json")],
        "kimi" => vec![
            ("config.toml", ".kimi-code/config.toml"),
            ("legacy-config.toml", ".kimi/config.toml"),
        ],
        _ => vec![],
    }
}

// ===== JSON 补丁 =====

fn parse_json_doc(existing: Option<&str>) -> Result<Value, String> {
    let v: Value = match existing {
        Some(t) if !t.trim().is_empty() => serde_json::from_str(t)
            .map_err(|e| format!("现有配置不是合法 JSON，已停止写入以免破坏: {e}"))?,
        _ => json!({}),
    };
    if !v.is_object() {
        return Err("现有配置根节点不是对象，已停止写入".into());
    }
    Ok(v)
}

/// 沿路径确保每一级都是对象并返回末级；遇到非对象字段时报错停止而不是覆盖
fn ensure_obj<'a>(
    mut cur: &'a mut Value,
    path: &[&str],
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    for &p in path {
        if cur.is_null() {
            *cur = json!({});
        }
        if !cur.is_object() {
            return Err(format!("配置字段 {p} 的上级不是对象，已停止写入"));
        }
        cur = &mut cur[p];
    }
    if cur.is_null() {
        *cur = json!({});
    }
    if !cur.is_object() {
        return Err(format!(
            "配置字段 {} 不是对象，已停止写入",
            path.last().copied().unwrap_or("")
        ));
    }
    Ok(cur.as_object_mut().unwrap())
}

fn to_pretty(v: &Value) -> Result<String, String> {
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

fn patch_claude_settings(
    existing: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    models: &[String],
    gateway_id: Option<&str>,
    effort: Option<&str>,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let env = ensure_obj(&mut v, &["env"])?;
    if let Some(u) = base_url {
        env.insert("ANTHROPIC_BASE_URL".into(), json!(u));
    }
    if let Some(k) = key {
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(k));
    }
    if let Some(m) = models.first() {
        env.insert("ANTHROPIC_MODEL".into(), json!(m));
    }
    // 与注入模式一致：模型列表注册进 /model 选择器（前 4 个别名槽 + 第 5 个自定义槽）
    const SLOTS: [&str; 4] = ["SONNET", "OPUS", "HAIKU", "FABLE"];
    for (m, slot) in models.iter().take(4).zip(SLOTS) {
        env.insert(format!("ANTHROPIC_DEFAULT_{slot}_MODEL"), json!(m));
        env.insert(format!("ANTHROPIC_DEFAULT_{slot}_MODEL_NAME"), json!(m));
    }
    if let Some(fifth) = models.get(4) {
        env.insert("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), json!(fifth));
        env.insert("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(), json!(fifth));
    }
    // claude 对不认识的第三方模型按 200K 上下文假设；注册表确知更大的（如 kimi-k3 1M）
    // 必须显式写 CLAUDE_CODE_MAX_CONTEXT_TOKENS，否则长会话提前 compact（cc-switch 同口径）。
    // 不需要时清掉旧值：该键随「设为全局」归 Ccode 管，留着过期大值比没有更有害
    let max_ctx = models
        .first()
        .map(|m| crate::model_registry::model_context_size_for(m, gateway_id));
    match max_ctx {
        Some(ctx) if ctx > 200_000 => {
            env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), json!(ctx.to_string()));
        }
        _ => {
            env.remove("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
        }
    }
    if let Some(e) = effort.filter(|s| !s.is_empty()) {
        env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), json!(e));
    } else {
        env.remove("CLAUDE_CODE_EFFORT_LEVEL");
    }
    to_pretty(&v)
}

fn patch_qwen_settings(
    existing: Option<&str>,
    protocol: &str,
    base_url: Option<&str>,
    key: Option<&str>,
    model: Option<&str>,
    models: &[String],
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    ensure_obj(&mut v, &["security", "auth"])?.insert("selectedType".into(), json!(protocol));
    let env = ensure_obj(&mut v, &["env"])?;
    // gemini/vertex-ai 协议暂不支持，按 openai 处理（与 launch_plan 一致）
    let is_anthropic = protocol == "anthropic";
    let triple: [(&str, Option<&str>); 3] = if is_anthropic {
        [
            ("ANTHROPIC_API_KEY", key),
            ("ANTHROPIC_BASE_URL", base_url),
            ("ANTHROPIC_MODEL", model),
        ]
    } else {
        [
            ("OPENAI_API_KEY", key),
            ("OPENAI_BASE_URL", base_url),
            ("OPENAI_MODEL", model),
        ]
    };
    for (k, val) in triple {
        if let Some(val) = val {
            env.insert(k.into(), json!(val));
        }
    }
    if let Some(m) = model {
        ensure_obj(&mut v, &["model"])?.insert("name".into(), json!(m));
    }
    // TUI /model 对话框列出的就是 modelProviders.<协议>.models 里的条目；
    // 只覆盖本协议的 models 数组，其他协议/字段原样保留
    if !models.is_empty() {
        let env_key = if is_anthropic {
            "ANTHROPIC_API_KEY"
        } else {
            "OPENAI_API_KEY"
        };
        let entries: Vec<Value> = models
            .iter()
            .map(|m| {
                let mut e = json!({ "id": m, "name": m, "envKey": env_key });
                if let Some(u) = base_url {
                    e["baseUrl"] = json!(u);
                }
                e
            })
            .collect();
        ensure_obj(&mut v, &["modelProviders", protocol])?.insert("models".into(), json!(entries));
    }
    to_pretty(&v)
}

fn patch_codex_auth(existing: Option<&str>, key: &str) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    v.as_object_mut()
        .unwrap()
        .insert("OPENAI_API_KEY".into(), json!(key));
    to_pretty(&v)
}

/// gemini 的 settings.json：只补 security.auth.selectedType = "gemini-api-key"——
/// 光有 .env 的 GEMINI_API_KEY 时 gemini ≥0.46 无法推断认证方式（base URL 存在时
/// env 推断为 gateway，validateAuthMethod 不认 → headless 报 auth 错起不来），
/// cc-switch 同口径。settings.json 是 JSONC（容忍注释/尾逗号，读侧剥注释后重写为
/// 严格 JSON），其余字段一律保留
fn patch_gemini_settings(existing: Option<&str>) -> Result<String, String> {
    let mut v = match existing {
        Some(text) => serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(text))
            .map_err(|e| format!("现有 settings.json 解析失败，已停止写入: {e}"))?,
        None => json!({}),
    };
    ensure_obj(&mut v, &["security", "auth"])?
        .insert("selectedType".into(), json!("gemini-api-key"));
    to_pretty(&v)
}

fn patch_opencode_config(
    existing: Option<&str>,
    provider: Value,
    model: Option<&str>,
    provider_id: &str,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let map = ensure_obj(&mut v, &["provider"])?;
    if provider_id != crate::provider_id::LEGACY {
        map.remove(crate::provider_id::LEGACY);
    }
    map.insert(provider_id.into(), provider);
    let root = v.as_object_mut().unwrap();
    if let Some(m) = model {
        root.insert("model".into(), json!(format!("{provider_id}/{m}")));
    }
    root.insert("autoupdate".into(), json!(false));
    to_pretty(&v)
}

/// OpenCode 全局写入：每个模型写自己的 options，不再把一份策略套到全部模型。
fn overlay_opencode_per_model(provider: &mut Value, profile: &Profile) {
    let Some(models_map) = provider.get_mut("models").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let gw = profile
        .gateway_id
        .as_deref()
        .and_then(crate::gateway_store::find_gateway);
    for m in &profile.models {
        let mut tmp = profile.clone();
        if let Some(gm) = gw.as_ref().and_then(|g| g.models.iter().find(|x| x.id == *m)) {
            tmp.request_policy.temperature = gm.temperature;
            tmp.request_policy.top_p = gm.top_p;
            tmp.request_policy.max_output_tokens = gm.max_output_tokens;
            tmp.request_policy.reasoning_effort = gm.reasoning_effort.clone();
        }
        crate::combo::apply_to_profile(&mut tmp, Some(m));
        let policy = &tmp.request_policy;
        let mut opts = serde_json::Map::new();
        if let Some(v) = policy.temperature {
            opts.insert("temperature".into(), json!(v));
        }
        if let Some(v) = policy.top_p {
            opts.insert("topP".into(), json!(v));
        }
        if let Some(v) = policy.max_output_tokens {
            opts.insert("maxOutputTokens".into(), json!(v));
        }
        if let Some(v) = policy.reasoning_effort.as_deref() {
            opts.insert("reasoningEffort".into(), json!(v));
        }
        if opts.is_empty() {
            continue;
        }
        if let Some(entry) = models_map.get_mut(m) {
            entry["options"] = Value::Object(opts);
        }
    }
}

// ===== TOML 补丁（toml_edit 保留文档其余部分） =====

fn parse_toml_doc(existing: Option<&str>) -> Result<toml_edit::DocumentMut, String> {
    existing
        .unwrap_or("")
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("现有 TOML 配置解析失败，已停止写入: {e}"))
}

/// 取子表；已存在但不是表时报错停止，避免覆盖用户数据
fn sub_table<'a>(
    item: &'a mut toml_edit::Item,
    key: &str,
) -> Result<&'a mut toml_edit::Item, String> {
    if let Some(existing) = item.as_table().and_then(|t| t.get(key)) {
        if !existing.is_table() {
            return Err(format!("配置项 {key} 不是表，已停止写入"));
        }
    }
    let table = item
        .as_table_mut()
        .ok_or_else(|| "配置文档结构异常，已停止写入".to_string())?;
    Ok(table.entry(key).or_insert(toml_edit::table()))
}

fn patch_codex_config(
    existing: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
    catalog: Option<&std::path::Path>,
    provider_id: &str,
    effort: Option<&str>,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    // 认证走 requires_openai_auth = true：自定义 provider 改用 auth.json 的 OPENAI_API_KEY。
    let providers = sub_table(doc.as_item_mut(), "model_providers")?;
    if provider_id != crate::provider_id::LEGACY {
        if let Some(t) = providers.as_table_mut() {
            t.remove(crate::provider_id::LEGACY);
        }
    }
    let ccode = sub_table(providers, provider_id)?;
    ccode["name"] = value("Ccode");
    if let Some(u) = base_url {
        ccode["base_url"] = value(u);
    }
    if let Some(t) = ccode.as_table_mut() {
        t.remove("env_key");
    }
    ccode["requires_openai_auth"] = value(true);
    ccode["wire_api"] = value("responses");
    doc["model_provider"] = value(provider_id);
    if let Some(m) = model {
        doc["model"] = value(m);
    }
    // /model 选择器的模型目录（仅启动时读取）
    if let Some(p) = catalog {
        doc["model_catalog_json"] = value(p.to_string_lossy().as_ref());
    }
    if let Some(e) = effort.filter(|s| !s.is_empty()) {
        doc["model_reasoning_effort"] = value(e);
    }
    Ok(doc.to_string())
}

/// kimi 模型别名：清洗为 TOML 裸键字符集 [A-Za-z0-9_-]，无需引号
fn kimi_model_alias(model: &str) -> String {
    model
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn patch_kimi_config(
    existing: Option<&str>,
    provider_type: &str,
    profile_name: &str,
    base_url: Option<&str>,
    key: Option<&str>,
    models: &[String],
    require_context_size: bool,
    provider_id: &str,
    gateway_id: Option<&str>,
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    let providers = sub_table(doc.as_item_mut(), "providers")?;
    if provider_id != crate::provider_id::LEGACY {
        if let Some(t) = providers.as_table_mut() {
            t.remove(crate::provider_id::LEGACY);
        }
    }
    let ccode = sub_table(providers, provider_id)?;
    ccode["type"] = value(provider_type);
    if let Some(u) = base_url {
        ccode["base_url"] = value(u);
    }
    if let Some(k) = key {
        ccode["api_key"] = value(k);
    }
    // 选择器按 [models.*] 别名列出模型：每个 profile 模型一个别名表
    if models.is_empty() {
        // 向后兼容：无模型列表时仍写单个 models.ccode 占位
        let models_tbl = sub_table(doc.as_item_mut(), "models")?;
        let mc = sub_table(models_tbl, provider_id)?;
        mc["provider"] = value(provider_id);
        if require_context_size {
            mc["max_context_size"] = value(131_072);
        }
        doc["default_model"] = value(provider_id);
    } else {
        let models_tbl = sub_table(doc.as_item_mut(), "models")?;
        for m in models {
            let t = sub_table(models_tbl, &kimi_model_alias(m))?;
            t["provider"] = value(provider_id);
            t["model"] = value(m.as_str());
            // 新版 0.31+ 必填 max_context_size；旧版 kimi-cli 不写（未知字段可能报错），
            // display_name/capabilities 同理只写新版（alias.display_name 与 capabilities
            // 数组均为新版字段，2026-08-17 二进制实证）
            if require_context_size {
                t["max_context_size"] = value(crate::model_registry::model_context_size_for(m, gateway_id));
                // 选择器 label 优先 display_name：用 profile 名避免显示成 provider id "ccode"
                t["display_name"] = value(format!("{profile_name} · {m}"));
                // 思考/视觉模型显式声明 capabilities；否则留空走 CLI registry 默认兜底，
                // 避免把 CLI 自己认得的模型能力降级（兼容通道缺省只有 tool_use）
                let thinking = crate::model_registry::model_thinking_for(m, gateway_id);
                let vision = crate::model_registry::model_supports_vision_for(m, gateway_id);
                if thinking || vision {
                    let mut caps = vec!["tool_use"];
                    if thinking {
                        caps.push("thinking");
                    }
                    if vision {
                        caps.push("image_in");
                    }
                    t["capabilities"] = toml_edit::value(
                        caps.into_iter().collect::<toml_edit::Array>(),
                    );
                }
            }
        }
        doc["default_model"] = value(kimi_model_alias(&models[0]));
    }
    Ok(doc.to_string())
}

/// CodeBuddy：settings.json 的 env 块写 CODEBUDDY_* 三件套（无模型槽位机制，结构最简单）
fn patch_codebuddy_settings(
    existing: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    let env = ensure_obj(&mut v, &["env"])?;
    if let Some(u) = base_url {
        env.insert("CODEBUDDY_BASE_URL".into(), json!(u));
    }
    if let Some(k) = key {
        env.insert("CODEBUDDY_API_KEY".into(), json!(k));
    }
    if let Some(m) = model {
        env.insert("CODEBUDDY_MODEL".into(), json!(m));
    }
    to_pretty(&v)
}

// ===== .env 补丁（gemini） =====

fn patch_env_file(existing: Option<&str>, pairs: &[(String, String)]) -> Result<String, String> {
    let mut lines: Vec<String> = existing.unwrap_or("").lines().map(String::from).collect();
    for (k, v) in pairs {
        // 值含换行会拆出额外 KEY=VALUE 行，既破坏 .env 也可能注入别的变量
        if v.contains('\n') || v.contains('\r') {
            return Err(format!("环境变量 {k} 的值包含换行符，已停止写入"));
        }
        let prefix = format!("{k}=");
        match lines.iter_mut().find(|l| l.starts_with(&prefix)) {
            Some(l) => *l = format!("{k}={v}"),
            None => lines.push(format!("{k}={v}")),
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Ok(out)
}

// ===== 计划与执行 =====

fn read_existing(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// 计算要写入的全部文件内容；home 显式传入以便测试不碰真实主目录
fn plan_writes(
    home: &Path,
    profile: &Profile,
    key: Option<&str>,
    models: &[String],
) -> Result<Vec<PlannedWrite>, String> {
    if profile.account_type == crate::profiles::AccountType::Official {
        return Err("官方账号不支持「设为全局」；请在 CLI 内登录，Ccode 只在启动时复现账号状态".into());
    }
    if profile.no_auth {
        return Err("无密钥连接不支持「设为全局」；请使用启动注入，避免污染 CLI 全局配置".into());
    }
    let base_url = profile.base_url.as_deref();
    // 全局模式没有运行时模型选择，默认取模型列表首个（与启动注入的兜底一致）
    let model = models.first().map(|s| s.as_str());
    // 能力表先行：不支持的 agent 带原因 fail-loud，不进写计划分发
    match crate::agent_specs::agent_spec(&profile.agent).map(|s| s.set_global) {
        Some(crate::agent_specs::SetGlobalCap::Supported) => {}
        Some(crate::agent_specs::SetGlobalCap::Unsupported(reason)) => {
            return Err(format!("「设为全局默认」暂不支持 {}：{reason}", profile.agent))
        }
        None => {
            return Err(format!(
                "「设为全局默认」暂不支持 {}（未适配）",
                profile.agent
            ))
        }
    }
    let mut plans = Vec::new();
    let mut push = |tag: &'static str, path: PathBuf, content: String| {
        plans.push(PlannedWrite { tag, path, content });
    };
    match profile.agent.as_str() {
        "claude-code" => {
            let path = home.join(".claude/settings.json");
            let content = patch_claude_settings(
                read_existing(&path).as_deref(),
                base_url,
                key,
                models,
                profile.gateway_id.as_deref(),
                profile.request_policy.reasoning_effort.as_deref(),
            )?;
            push("settings.json", path, content);
        }
        "codex" => {
            // /model 选择器的模型目录：先写 catalog 文件，再把路径写进 config.toml
            let catalog = if profile.models.is_empty() {
                None
            } else {
                let path = agents::codex_catalog_path(&profile.id).ok_or("无法确定平台配置目录")?;
                let mut content = serde_json::to_string_pretty(&agents::codex_catalog_json_for(
                    &profile.name,
                    &profile.models,
                    profile.gateway_id.as_deref(),
                ))
                .map_err(|e| e.to_string())?;
                content.push('\n');
                push("model-catalog.json", path.clone(), content);
                Some(path)
            };
            let path = home.join(".codex/config.toml");
            let content = patch_codex_config(
                read_existing(&path).as_deref(),
                base_url,
                model,
                catalog.as_deref(),
                &profile.provider_name(),
                profile.request_policy.reasoning_effort.as_deref(),
            )?;
            push("config.toml", path, content);
            // 密钥不写 config.toml，走 auth.json 合并
            if let Some(k) = key {
                let path = home.join(".codex/auth.json");
                let content = patch_codex_auth(read_existing(&path).as_deref(), k)?;
                push("auth.json", path, content);
            }
        }
        "gemini" => {
            let pairs: Vec<(String, String)> = [
                ("GEMINI_API_KEY", key),
                ("GOOGLE_GEMINI_BASE_URL", base_url),
                ("GEMINI_MODEL", model),
            ]
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v.to_string())))
            .collect();
            let path = home.join(".gemini/.env");
            // 没有任何可写值且文件不存在时，不创建空文件
            if !pairs.is_empty() || path.exists() {
                let content = patch_env_file(read_existing(&path).as_deref(), &pairs)?;
                push(".env", path, content);
            }
            // 认证方式落盘（见 patch_gemini_settings 注释：没有它 headless 起不来）
            let path = home.join(".gemini/settings.json");
            let content = patch_gemini_settings(read_existing(&path).as_deref())?;
            push("settings.json", path, content);
        }
        "qwen" => {
            let protocol = profile.protocol.as_deref().unwrap_or("openai");
            let path = home.join(".qwen/settings.json");
            let content = patch_qwen_settings(
                read_existing(&path).as_deref(),
                protocol,
                base_url,
                key,
                model,
                &profile.models,
            )?;
            push("settings.json", path, content);
        }
        "opencode" => {
            let mut provider = agents::opencode_provider_json(profile, key, model);
            overlay_opencode_per_model(&mut provider, profile);
            let path = home.join(".config/opencode/opencode.json");
            let content = patch_opencode_config(
                read_existing(&path).as_deref(),
                provider,
                model,
                &profile.provider_name(),
            )?;
            push("opencode.json", path, content);
        }
        "codebuddy" => {
            let path = home.join(".codebuddy/settings.json");
            let content = patch_codebuddy_settings(
                read_existing(&path).as_deref(),
                base_url,
                key,
                model,
            )?;
            push("settings.json", path, content);
        }
        "kimi" => {
            // 两个变体共用 kimi 命令：存在的变体目录都写；都不存在时写到新版目录
            let provider_type = profile.protocol.as_deref().unwrap_or("kimi");
            let new_path = home.join(".kimi-code/config.toml");
            let legacy_path = home.join(".kimi/config.toml");
            let mut targets: Vec<(&'static str, PathBuf)> = Vec::new();
            if new_path.parent().is_some_and(|d| d.exists()) {
                targets.push(("config.toml", new_path.clone()));
            }
            if legacy_path.parent().is_some_and(|d| d.exists()) {
                targets.push(("legacy-config.toml", legacy_path.clone()));
            }
            if targets.is_empty() {
                targets.push(("config.toml", new_path));
            }
            for (tag, path) in targets {
                // 新版 0.31+ 要求 max_context_size；旧版 kimi-cli 不写（未知字段可能报错）
                let content = patch_kimi_config(
                    read_existing(&path).as_deref(),
                    provider_type,
                    &profile.name,
                    base_url,
                    key,
                    &profile.models,
                    tag == "config.toml",
                    &profile.provider_name(),
                    profile.gateway_id.as_deref(),
                )?;
                push(tag, path, content);
            }
        }
        // 防御兜底：能力表标 Supported 但这里漏了 arm（两表漂移），属内部错误
        other => return Err(format!(
            "内部错误：{other} 的能力表标为支持「设为全局默认」但写计划缺失"
        )),
    }
    Ok(plans)
}

fn backups_root() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("backups"))
}

fn timestamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let tod = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// 天数 → 公历日期（Howard Hinnant 算法，UTC）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn list_backups(dir: &Path, tag: &str) -> Vec<String> {
    let prefix = format!("{tag}.");
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with(&prefix) && n.ends_with(".bak"))
                .collect()
        })
        .unwrap_or_default()
}

fn backup_file_raw(dir: &Path, tag: &str, path: &Path, ts: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let bak = dir.join(format!("{tag}.{ts}.bak"));
    fs::copy(path, &bak).map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bak, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置备份权限失败: {e}"))?;
    }
    Ok(bak)
}

fn prune_tag_backups(dir: &Path, tag: &str) {
    let mut baks = list_backups(dir, tag);
    baks.sort();
    while baks.len() > 5 {
        let oldest = baks.remove(0);
        let _ = fs::remove_file(dir.join(oldest));
    }
}

// 仅测试用来快速制造多份带时间戳的备份验证轮换；生产路径走 backup_actions 的事务备份
#[cfg(test)]
fn backup_file_with_ts(dir: &Path, tag: &str, path: &Path, ts: &str) -> Result<PathBuf, String> {
    let bak = backup_file_raw(dir, tag, path, ts)?;
    prune_tag_backups(dir, tag);
    Ok(bak)
}

fn batch_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{nanos:09}-{}", timestamp_now(), &id[..8])
}

fn manifest_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("batch.{id}.json"))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("同步 {} 失败: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 {} 权限失败: {e}", path.display()))?;
    }
    Ok(())
}

fn write_manifest(dir: &Path, manifest: &BackupManifest) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let mut text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    text.push('\n');
    let path = manifest_path(dir, &manifest.batch_id);
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = write_private_file(&tmp, text.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入批次备份清单失败: {e}"));
    }
    Ok(())
}

fn remove_batch_artifacts(dir: &Path, id: &str) {
    let _ = fs::remove_file(manifest_path(dir, id));
    let suffix = format!(".{id}.bak");
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(&suffix) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn backup_actions(
    backups_dir: &Path,
    id: &str,
    operation: &str,
    actions: &[TxAction],
) -> Result<Vec<Option<Vec<u8>>>, String> {
    let mut entries = Vec::new();
    let mut originals = Vec::new();
    let mut created_backups = Vec::new();
    for action in actions {
        let original = match fs::read(&action.path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                for path in &created_backups {
                    let _ = fs::remove_file(path);
                }
                return Err(format!("读取现有配置 {} 失败: {e}", action.path.display()));
            }
        };
        let backup_file = if original.is_some() {
            match backup_file_raw(backups_dir, &action.tag, &action.path, id) {
                Ok(path) => {
                    created_backups.push(path.clone());
                    Some(path.file_name().unwrap().to_string_lossy().into_owned())
                }
                Err(e) => {
                    for path in &created_backups {
                        let _ = fs::remove_file(path);
                    }
                    return Err(e);
                }
            }
        } else {
            None
        };
        entries.push(BackupEntry {
            tag: action.tag.clone(),
            target: action.path.to_string_lossy().into_owned(),
            existed: original.is_some(),
            backup_file,
        });
        originals.push(original);
    }
    if let Err(e) = write_manifest(
        backups_dir,
        &BackupManifest {
            batch_id: id.to_string(),
            operation: operation.to_string(),
            entries,
        },
    ) {
        for path in &created_backups {
            let _ = fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(originals)
}

fn stage_actions(actions: &[TxAction], id: &str) -> Result<Vec<Option<PathBuf>>, String> {
    let mut staged: Vec<Option<PathBuf>> = Vec::new();
    for (i, action) in actions.iter().enumerate() {
        if let Some(parent) = action.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        if let Some(content) = &action.content {
            let name = action
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "config".into());
            let tmp = action
                .path
                .with_file_name(format!(".{name}.ccode-{id}-{i}.tmp"));
            if let Err(e) = write_private_file(&tmp, content) {
                for path in staged.iter().flatten() {
                    let _ = fs::remove_file(path);
                }
                return Err(e);
            }
            staged.push(Some(tmp));
        } else {
            staged.push(None);
        }
    }
    Ok(staged)
}

fn restore_original(path: &Path, original: &Option<Vec<u8>>, id: &str) -> Result<(), String> {
    match original {
        Some(bytes) => {
            let tmp = path.with_file_name(format!(
                ".{}.ccode-{id}-rollback.tmp",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            write_private_file(&tmp, bytes)?;
            replace_staged(&tmp, path)
                .map_err(|e| format!("回滚 {} 失败: {e}", path.display()))
        }
        None => match fs::remove_file(path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("回滚新建文件 {} 失败: {e}", path.display())),
        },
    }
}

/// Unix rename 可原子覆盖；Windows 不允许覆盖已有文件，先移除后替换，失败时由事务回滚恢复。
fn replace_staged(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if to.exists() {
            fs::remove_file(to)?;
        }
    }
    fs::rename(from, to)
}

fn commit_actions_with<F>(
    actions: &[TxAction],
    staged: &[Option<PathBuf>],
    originals: &[Option<Vec<u8>>],
    id: &str,
    mut rename: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path, usize) -> std::io::Result<()>,
{
    for (i, action) in actions.iter().enumerate() {
        let result = if let Some(tmp) = &staged[i] {
            rename(tmp, &action.path, i)
        } else {
            match fs::remove_file(&action.path) {
                Ok(_) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        };
        if let Err(e) = result {
            let mut rollback_errors = Vec::new();
            for (action, original) in actions.iter().zip(originals) {
                if let Err(err) = restore_original(&action.path, original, id) {
                    rollback_errors.push(err);
                }
            }
            for path in staged.iter().flatten() {
                let _ = fs::remove_file(path);
            }
            let suffix = if rollback_errors.is_empty() {
                "已自动回滚全部目标文件".to_string()
            } else {
                format!("自动回滚不完整：{}", rollback_errors.join("；"))
            };
            return Err(format!(
                "替换 {} 失败: {e}；{suffix}",
                action.path.display()
            ));
        }
    }
    Ok(())
}

fn manifest_files(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| {
                            let n = n.to_string_lossy();
                            n.starts_with("batch.") && n.ends_with(".json")
                        })
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
}

fn prune_manifests(dir: &Path) {
    let mut paths = manifest_files(dir);
    while paths.len() > 5 {
        let _ = fs::remove_file(paths.remove(0));
    }
}

fn transact(
    backups_dir: &Path,
    home: &Path,
    actions: &[TxAction],
    operation: &str,
) -> Result<Vec<String>, String> {
    if actions.is_empty() {
        return Ok(Vec::new());
    }
    let id = batch_id();
    let originals = backup_actions(backups_dir, &id, operation, actions)?;
    // apply 时顺带保证「首次写入前」原始快照存在（永久保留，不参与轮换）；
    // 快照内容 = 本次读到的写入前状态，即使后面的提交失败回滚也依然准确
    if operation == "apply" {
        ensure_original_snapshot(backups_dir, actions, &originals);
    }
    let staged = match stage_actions(actions, &id) {
        Ok(staged) => staged,
        Err(e) => {
            remove_batch_artifacts(backups_dir, &id);
            return Err(e);
        }
    };
    commit_actions_with(actions, &staged, &originals, &id, |from, to, _| {
        replace_staged(from, to)
    })?;
    for action in actions {
        prune_tag_backups(backups_dir, &action.tag);
    }
    prune_manifests(backups_dir);
    Ok(actions
        .iter()
        .map(|a| display_path(home, &a.path))
        .collect())
}

fn apply_plans(
    backups_dir: &Path,
    home: &Path,
    plans: &[PlannedWrite],
) -> Result<Vec<String>, String> {
    let actions: Vec<TxAction> = plans
        .iter()
        .map(|plan| TxAction {
            tag: plan.tag.to_string(),
            path: plan.path.clone(),
            content: Some(plan.content.as_bytes().to_vec()),
        })
        .collect();
    transact(backups_dir, home, &actions, "apply")
}

// ===== 「首次写入前」原始快照（永久保留，不参与 5 份轮换） =====
//
// 动机：常规批次备份每个 tag 只留 5 份、清单也只留 5 份——连续「设为全局」几次后，
// 最早的「Ccode 动手之前」的状态就被轮换掉了，「恢复备份」只能回到上一次写入前，
// 用户真正想要的「恢复默认」永远够不到。original/ 子目录在首次 apply 时落一份，
// 之后任何 apply/restore 都不碰（prune 只扫扁平的 <tag>.*.bak 与 batch.*.json）。

fn original_dir(backups_dir: &Path) -> PathBuf {
    backups_dir.join("original")
}

/// 首次 apply 时用写入前内容（originals）落永久快照；已存在则不动。
/// 失败只记日志不否决主流程（常规批次备份链仍可用）；半份快照清掉下次重试
fn ensure_original_snapshot(
    backups_dir: &Path,
    actions: &[TxAction],
    originals: &[Option<Vec<u8>>],
) {
    let dir = original_dir(backups_dir);
    if dir.join("manifest.json").is_file() {
        return;
    }
    let result = (|| -> Result<(), String> {
        // 目录要先建：全部目标在首次写入前都不存在时，循环里不会走到建目录的分支
        fs::create_dir_all(&dir).map_err(|e| format!("创建原始快照目录失败: {e}"))?;
        let mut entries = Vec::new();
        for (action, original) in actions.iter().zip(originals) {
            let backup_file = if let Some(bytes) = original {
                // 不可变快照，文件名直接用 tag（不需要时间戳）
                write_private_file(&dir.join(&action.tag), bytes)?;
                Some(action.tag.clone())
            } else {
                None
            };
            entries.push(BackupEntry {
                tag: action.tag.clone(),
                target: action.path.to_string_lossy().into_owned(),
                existed: original.is_some(),
                backup_file,
            });
        }
        let mut text = serde_json::to_string_pretty(&BackupManifest {
            batch_id: "original".into(),
            operation: "original".into(),
            entries,
        })
        .map_err(|e| e.to_string())?;
        text.push('\n');
        write_private_file(&dir.join("manifest.json"), text.as_bytes())
    })();
    if let Err(e) = result {
        crate::logbuf::record("error", "global-config", &format!("写入原始快照失败: {e}"));
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 恢复到「Ccode 首次写入前」的原始状态：快照里不存在的文件 = 当时是 Ccode 新建的，
/// 恢复即删除（transact 会先把当前状态存成常规批次，可再恢复回来）
fn restore_from_original(backups_dir: &Path, home: &Path) -> Result<Vec<String>, String> {
    let dir = original_dir(backups_dir);
    let manifest: BackupManifest = serde_json::from_str(
        &fs::read_to_string(dir.join("manifest.json"))
            .map_err(|e| format!("读取原始快照清单失败: {e}"))?,
    )
    .map_err(|e| format!("原始快照清单损坏: {e}"))?;
    let mut actions = Vec::new();
    for entry in manifest.entries {
        let content = match &entry.backup_file {
            Some(name) => Some(
                fs::read(dir.join(name)).map_err(|e| format!("读取原始快照失败: {e}"))?,
            ),
            None => None,
        };
        actions.push(TxAction {
            tag: entry.tag,
            path: PathBuf::from(entry.target),
            content,
        });
    }
    transact(backups_dir, home, &actions, "restore-original")
}

fn latest_valid_manifest(dir: &Path) -> Option<BackupManifest> {
    manifest_files(dir).into_iter().rev().find_map(|path| {
        let manifest: BackupManifest =
            serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        manifest
            .entries
            .iter()
            .all(|entry| {
                !entry.existed
                    || entry
                        .backup_file
                        .as_ref()
                        .is_some_and(|name| dir.join(name).is_file())
            })
            .then_some(manifest)
    })
}

fn restore_from(backups_dir: &Path, home: &Path, agent: &str) -> Result<Vec<String>, String> {
    let actions = if let Some(manifest) = latest_valid_manifest(backups_dir) {
        manifest
            .entries
            .into_iter()
            .map(|entry| {
                let content = match entry.backup_file {
                    Some(name) => Some(
                        fs::read(backups_dir.join(name))
                            .map_err(|e| format!("读取恢复备份失败: {e}"))?,
                    ),
                    None => None,
                };
                Ok(TxAction {
                    tag: entry.tag,
                    path: PathBuf::from(entry.target),
                    content,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        let mut actions = Vec::new();
        for (tag, rel) in target_specs(agent) {
            let mut baks = list_backups(backups_dir, tag);
            baks.sort();
            if let Some(newest) = baks.pop() {
                actions.push(TxAction {
                    tag: tag.to_string(),
                    path: home.join(rel),
                    content: Some(
                        fs::read(backups_dir.join(newest))
                            .map_err(|e| format!("读取恢复备份失败: {e}"))?,
                    ),
                });
            }
        }
        actions
    };
    transact(backups_dir, home, &actions, "restore")
}

fn display_path(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rel) => format!("~/{}", rel.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

pub(crate) fn drift_status(store: &ProfileStore, agent: &str) -> crate::drift::GlobalDriftDto {
    let settings = crate::settings::read_current();
    let Some(pid) = settings
        .active_global_profiles
        .as_ref()
        .and_then(|m| m.get(agent))
        .cloned()
    else {
        return crate::drift::classify(true, None, Vec::new());
    };
    let profile = match profile_for_global_write(store, &pid) {
        Ok(p) => p,
        Err(e) => return crate::drift::classify(false, Some(e), Vec::new()),
    };
    if profile.account_type == crate::profiles::AccountType::Official {
        return crate::drift::classify(true, None, Vec::new());
    }
    let key = crate::profiles::get_key_for_profile(&profile).ok().flatten();
    let Some(home) = dirs::home_dir() else {
        return crate::drift::classify(false, Some("无法确定用户主目录".into()), Vec::new());
    };
    let plans = match plan_writes(&home, &profile, key.as_deref(), &profile.models) {
        Ok(p) => p,
        Err(e) => return crate::drift::classify(false, Some(e), Vec::new()),
    };
    let mut drifted = Vec::new();
    for p in &plans {
        if !crate::drift::planned_matches_live(&p.path, &p.content) {
            drifted.push(p.tag.to_string());
        }
    }
    crate::drift::classify(false, None, drifted)
}

#[tauri::command]
pub fn check_global_drift(
    store: tauri::State<'_, ProfileStore>,
    agent: String,
) -> Result<crate::drift::GlobalDriftDto, String> {
    Ok(drift_status(&store, &agent))
}

#[tauri::command]
pub async fn apply_profile_global(
    app: tauri::AppHandle,
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<GlobalApplyResultDto, String> {
    let profile = profile_for_global_write(&store, &profile_id)?;
    if profile.account_type == crate::profiles::AccountType::Official {
        let agent = profile.agent.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _guard = GLOBAL_CONFIG_MUTEX
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let dir = backups_root()?.join(&agent);
            if !dir.join("original").join("manifest.json").is_file() {
                return Err("当前全局文件不是 Ccode 写的，无需恢复".into());
            }
            let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
            let files = restore_from_original(&dir, &home)?;
            crate::settings::clear_active_global(&agent);
            let skip = |msg: &str| crate::profile_validation::ValidationCheckDto {
                status: "skipped".into(),
                message: msg.into(),
                latency_ms: None,
            };
            Ok(GlobalApplyResultDto {
                files,
                validation: crate::profile_validation::ProfileValidationDto {
                    ok: true,
                    checked_at: crate::sessions::now_iso(),
                    local: crate::profile_validation::ValidationCheckDto {
                        status: "passed".into(),
                        message: "已恢复初始状态（官方账号）".into(),
                        latency_ms: None,
                    },
                    cli: skip("官方账号不跑 CLI 复检"),
                    api: skip(""),
                },
            })
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = crate::tray::rebuild_and_wait(app.clone()).await;
        return result;
    }
    let key = profiles::get_key_for_profile(&profile)?;
    crate::agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
        let plans = plan_writes(&home, &profile, key.as_deref(), &profile.models)?;
        let backups_dir = backups_root()?.join(&profile.agent);
        let files = apply_plans(&backups_dir, &home, &plans)?;
        // 写成功即记录「全局生效」追踪（settings.active_global_profiles）；后面的验证
        // 失败不影响记录——文件已真实写入，验证只是体检报告
        crate::settings::record_active_global(&profile.agent, &profile.id);
        let validation =
            crate::profile_validation::validate_after_global_write(&profile, key.as_deref());
        Ok(GlobalApplyResultDto { files, validation })
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

#[tauri::command]
pub async fn restore_global_backup(
    app: tauri::AppHandle,
    agent: String,
) -> Result<Vec<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
        let dir = backups_root()?.join(&agent);
        let restored = restore_from(&dir, &home, &agent)?;
        // 恢复后全局内容不再是任何 profile 的快照，清除「全局生效」追踪
        crate::settings::clear_active_global(&agent);
        Ok(restored)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

#[tauri::command]
pub async fn has_original_backup(agent: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        backups_root()
            .map(|r| r.join(&agent).join("original").join("manifest.json").is_file())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn restore_original_backup(
    app: tauri::AppHandle,
    agent: String,
) -> Result<Vec<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = GLOBAL_CONFIG_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
        let dir = backups_root()?.join(&agent);
        let restored = restore_from_original(&dir, &home)?;
        // 恢复初始状态后同样清除「全局生效」追踪
        crate::settings::clear_active_global(&agent);
        Ok(restored)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = crate::tray::rebuild_and_wait(app.clone()).await;
    result
}

#[tauri::command]
pub async fn has_global_backup(agent: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match backups_root() {
            Ok(r) => r.join(&agent),
            Err(_) => return false,
        };
        latest_valid_manifest(&dir).is_some()
            || fs::read_dir(dir)
                .map(|rd| {
                    rd.flatten()
                        .any(|e| e.file_name().to_string_lossy().ends_with(".bak"))
                })
                .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-gcfg-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(agent: &str) -> Profile {
        Profile {
            id: "test".into(),
            agent: agent.into(),
            name: "测试".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            base_url: Some("https://relay.example.com".into()),
            models: vec!["m1".into()],
            extra_env: Default::default(),
            request_policy: crate::profiles::RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
            gateway_id: None,
            slot_missing: false,
            provider_override: None,
        }
    }

    #[test]
    fn claude_patch_preserves_unrelated_fields() {
        let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
        let out = patch_claude_settings(
            Some(existing),
            Some("https://relay.example.com"),
            Some("sk-secret"),
            &["claude-sonnet-4".to_string(), "m2".to_string()],
            None,
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret");
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4");
        // 模型列表注册进 /model 选择器的别名槽
        assert_eq!(
            v["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            "claude-sonnet-4"
        );
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "m2");
        assert_eq!(v["env"]["OTHER"], "1");
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn claude_patch_from_missing_file_creates_env_only() {
        let out = patch_claude_settings(None, None, None, &[], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].is_object());
        assert_eq!(v["env"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn claude_patch_writes_max_context_only_when_beyond_default_assumption() {
        // 注册表确知 >200K 的模型（kimi-k3 = 1M）：必须显式声明，否则 claude 按 200K 假设提前 compact
        let out = patch_claude_settings(None, None, None, &["kimi-k3".to_string()], None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1048576");
        // ≤200K 的模型：不写；已有旧值时清掉（防上一个 profile 的 1M 残留误导）
        let out = patch_claude_settings(
            Some(r#"{"env": {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576"}}"#),
            None,
            None,
            &["claude-sonnet-4".to_string()],
            None,
            None,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());
    }

    #[test]
    fn codex_config_patch_preserves_other_tables() {
        let existing = "[other]\nkeep = 1\n\n[model_providers.ccode]\nold = \"x\"\nenv_key = \"CODEX_API_KEY\"\n";
        let out = patch_codex_config(
            Some(existing),
            Some("https://r.example.com/v1"),
            Some("gpt-5"),
            Some(std::path::Path::new("/cfg/ccode/catalogs/codex-p1.json")),
            "ccode",
            None,
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["other"]["keep"].as_integer(), Some(1));
        let ccode = &doc["model_providers"]["ccode"];
        assert_eq!(ccode["name"].as_str(), Some("Ccode"));
        assert_eq!(ccode["base_url"].as_str(), Some("https://r.example.com/v1"));
        // 认证改走 requires_openai_auth（auth.json 的 OPENAI_API_KEY 直接可用）；
        // 旧版写入遗留的 env_key 行被清掉（自定义 provider 的 env_key 只认环境变量）
        assert!(ccode.get("env_key").is_none());
        assert_eq!(ccode["requires_openai_auth"].as_bool(), Some(true));
        assert_eq!(ccode["wire_api"].as_str(), Some("responses"));
        // 表内既有键不被清掉
        assert_eq!(ccode["old"].as_str(), Some("x"));
        assert_eq!(doc["model_provider"].as_str(), Some("ccode"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/cfg/ccode/catalogs/codex-p1.json")
        );
        // 密钥绝不进 config.toml
        assert!(!out.contains("sk-secret"));
    }

    #[test]
    fn codex_auth_patch_merges() {
        let existing = r#"{"tokens": {"id_token": "abc"}}"#;
        let out = patch_codex_auth(Some(existing), "sk-secret").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["OPENAI_API_KEY"], "sk-secret");
        assert_eq!(v["tokens"]["id_token"], "abc");
    }

    #[test]
    fn gemini_settings_patch_adds_selected_type_and_tolerates_jsonc() {
        // 从无到有
        let v: Value = serde_json::from_str(&patch_gemini_settings(None).unwrap()).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
        // JSONC 容错（注释 + 尾逗号），既有字段保留
        let existing = "{\n  // 主题\n  \"theme\": \"dark\",\n}\n";
        let v: Value =
            serde_json::from_str(&patch_gemini_settings(Some(existing)).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
        // 损坏文件拒写（fail-loud），不静默覆盖
        assert!(patch_gemini_settings(Some("{ not json")).is_err());
    }

    #[test]
    fn gemini_env_patch_replaces_only_our_keys() {
        let existing = "# comment\nGEMINI_API_KEY=old\nOTHER=1\n";
        let pairs = vec![
            ("GEMINI_API_KEY".to_string(), "new-key".to_string()),
            ("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string()),
        ];
        let out = patch_env_file(Some(existing), &pairs).unwrap();
        assert!(out.contains("GEMINI_API_KEY=new-key"));
        assert!(out.contains("GEMINI_MODEL=gemini-3-pro"));
        assert!(out.contains("OTHER=1"));
        assert!(out.contains("# comment"));
        assert!(!out.contains("old"));
    }

    #[test]
    fn gemini_env_patch_rejects_multiline_values() {
        let pairs = vec![("GEMINI_API_KEY".to_string(), "k1\nINJECTED=1".to_string())];
        let err = patch_env_file(None, &pairs).unwrap_err();
        assert!(err.contains("换行符"), "{err}");
        let pairs_cr = vec![("GEMINI_MODEL".to_string(), "m\rx".to_string())];
        assert!(patch_env_file(None, &pairs_cr).is_err());
    }

    #[test]
    fn qwen_patch_openai_protocol() {
        let existing = r#"{"security": {"auth": {"other": true}}}"#;
        let out = patch_qwen_settings(
            Some(existing),
            "openai",
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            Some("sk-secret"),
            Some("qwen3-coder"),
            &["qwen3-coder".into(), "qwen3-max".into()],
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "openai");
        assert_eq!(v["security"]["auth"]["other"], true);
        assert_eq!(v["env"]["OPENAI_API_KEY"], "sk-secret");
        assert_eq!(v["env"]["OPENAI_MODEL"], "qwen3-coder");
        assert_eq!(v["model"]["name"], "qwen3-coder");
        assert!(v["env"].get("ANTHROPIC_API_KEY").is_none());
        // modelProviders.openai.models：TUI /model 对话框的数据源
        let models = v["modelProviders"]["openai"]["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "qwen3-coder");
        assert_eq!(models[0]["name"], "qwen3-coder");
        assert_eq!(
            models[0]["baseUrl"],
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        );
        assert_eq!(models[0]["envKey"], "OPENAI_API_KEY");
        assert_eq!(models[1]["id"], "qwen3-max");
    }

    #[test]
    fn qwen_patch_anthropic_protocol() {
        let out = patch_qwen_settings(
            None,
            "anthropic",
            Some("https://r.example.com"),
            Some("k"),
            None,
            &[],
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["security"]["auth"]["selectedType"], "anthropic");
        assert_eq!(v["env"]["ANTHROPIC_API_KEY"], "k");
        assert!(v["env"].get("OPENAI_API_KEY").is_none());
        assert!(v.get("model").is_none());
        assert!(v.get("modelProviders").is_none());
    }

    #[test]
    fn qwen_patch_model_providers_preserves_other_protocols() {
        let existing =
            r#"{"modelProviders": {"gemini": {"models": [{"id": "g1"}]}, "openai": {"extra": 1}}}"#;
        let out = patch_qwen_settings(
            Some(existing),
            "openai",
            None,
            None,
            None,
            &["qwen3-coder".into()],
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // 其他协议原样保留，本协议的既有字段不清掉
        assert_eq!(v["modelProviders"]["gemini"]["models"][0]["id"], "g1");
        assert_eq!(v["modelProviders"]["openai"]["extra"], 1);
        let models = v["modelProviders"]["openai"]["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "qwen3-coder");
        assert!(
            models[0].get("baseUrl").is_none(),
            "无 base_url 时不写该字段"
        );
    }

    #[test]
    fn opencode_patch_preserves_other_providers() {
        let existing = r#"{"provider": {"other": {"npm": "x"}}, "theme": "dark"}"#;
        let p = profile("opencode");
        let provider = agents::opencode_provider_json(&p, Some("sk-secret"), Some("m1"));
        let out = patch_opencode_config(Some(existing), provider, Some("m1"), "ccode").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"]["other"]["npm"], "x");
        assert_eq!(v["provider"]["ccode"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(v["provider"]["ccode"]["options"]["apiKey"], "sk-secret");
        assert_eq!(v["model"], "ccode/m1");
        assert_eq!(v["autoupdate"], false);
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn codebuddy_patch_writes_env_block_and_preserves_rest() {
        let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
        let out = patch_codebuddy_settings(
            Some(existing),
            Some("https://api.deepseek.com/anthropic"),
            Some("sk-secret"),
            Some("deepseek-v3-2-volc"),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CODEBUDDY_BASE_URL"], "https://api.deepseek.com/anthropic");
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
        assert_eq!(v["env"]["CODEBUDDY_MODEL"], "deepseek-v3-2-volc");
        assert_eq!(v["env"]["OTHER"], "1", "无关 env 必须保留");
        assert_eq!(v["theme"], "dark", "无关字段必须保留");
        // 缺省（文件不存在）：只创建 env 块
        let out = patch_codebuddy_settings(None, None, Some("sk-secret"), None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
        assert!(v["env"].get("CODEBUDDY_BASE_URL").is_none());
    }

    #[test]
    fn kimi_patch_writes_alias_table_per_model() {
        let existing = "[providers.other]\ntype = \"openai\"\n";
        let out = patch_kimi_config(
            Some(existing),
            "kimi",
            "Zetatechs",
            Some("https://api.moonshot.cn/v1"),
            Some("sk-secret"),
            &["kimi-k3".into(), "kimi.k2.5 turbo".into(), "deepseek-chat".into()],
            true,
            "ccode",
            None,
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["providers"]["other"]["type"].as_str(), Some("openai"));
        let ccode = &doc["providers"]["ccode"];
        assert_eq!(ccode["type"].as_str(), Some("kimi"));
        assert_eq!(
            ccode["base_url"].as_str(),
            Some("https://api.moonshot.cn/v1")
        );
        assert_eq!(ccode["api_key"].as_str(), Some("sk-secret"));
        // 每个模型一个 [models.<alias>] 表；非法字符清洗为 _
        assert_eq!(doc["models"]["kimi-k3"]["provider"].as_str(), Some("ccode"));
        assert_eq!(doc["models"]["kimi-k3"]["model"].as_str(), Some("kimi-k3"));
        // 0.31+ 必填 max_context_size：k3 = 1M，未知模型 = 128K 保守默认
        assert_eq!(
            doc["models"]["kimi-k3"]["max_context_size"].as_integer(),
            Some(1_048_576)
        );
        assert_eq!(
            doc["models"]["kimi_k2_5_turbo"]["max_context_size"].as_integer(),
            Some(131_072)
        );
        assert_eq!(
            doc["models"]["kimi_k2_5_turbo"]["model"].as_str(),
            Some("kimi.k2.5 turbo")
        );
        // display_name 用 profile 名 + 模型名（选择器 label 优先 display_name）
        assert_eq!(
            doc["models"]["kimi-k3"]["display_name"].as_str(),
            Some("Zetatechs · kimi-k3")
        );
        // 推断为思考模型的写 capabilities；普通模型不写（走 CLI registry 默认）
        let caps = &doc["models"]["kimi-k3"]["capabilities"];
        assert_eq!(
            caps.as_array().map(|a| a.len()),
            Some(3),
            "kimi-k3 应声明 tool_use + thinking + image_in（多模态思考）"
        );
        assert_eq!(
            doc["models"]["kimi-k3"]["capabilities"][1].as_str(),
            Some("thinking")
        );
        assert_eq!(
            doc["models"]["kimi-k3"]["capabilities"][2].as_str(),
            Some("image_in")
        );
        assert!(doc["models"]["deepseek-chat"].get("capabilities").is_none());
        // default_model = 首个模型的别名
        assert_eq!(doc["default_model"].as_str(), Some("kimi-k3"));
    }

    #[test]
    fn kimi_patch_without_models_keeps_single_ccode_alias() {
        let out = patch_kimi_config(None, "openai", "P", None, None, &[], true, "ccode", None).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["providers"]["ccode"]["type"].as_str(), Some("openai"));
        assert_eq!(doc["models"]["ccode"]["provider"].as_str(), Some("ccode"));
        assert_eq!(
            doc["models"]["ccode"]["max_context_size"].as_integer(),
            Some(131_072)
        );
        assert_eq!(doc["default_model"].as_str(), Some("ccode"));
    }

    #[test]
    fn kimi_patch_legacy_variant_omits_context_size() {
        // 旧版 kimi-cli（~/.kimi）：不写 max_context_size/display_name/capabilities，
        // 防止老版本解析未知字段报错
        let out =
            patch_kimi_config(None, "kimi", "P", None, None, &["kimi-k3".into()], false, "ccode", None).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc["models"]["kimi-k3"].get("max_context_size").is_none());
        assert!(doc["models"]["kimi-k3"].get("display_name").is_none());
        assert!(doc["models"]["kimi-k3"].get("capabilities").is_none());
    }

    #[test]
    fn kimi_alias_sanitizes_to_bare_key_charset() {
        assert_eq!(kimi_model_alias("kimi-k2"), "kimi-k2");
        assert_eq!(kimi_model_alias("a.b/c d"), "a_b_c_d");
    }

    #[test]
    fn kimi_plan_writes_existing_variant_dirs() {
        let home = tmpdir("kimi-dirs");
        let p = profile("kimi");
        // 都不存在 → 只写新版目录
        let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(plans[0].path.ends_with(".kimi-code/config.toml"));
        // 只有旧版目录 → 只写旧版
        fs::create_dir_all(home.join(".kimi")).unwrap();
        let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].tag, "legacy-config.toml");
        // 两者都有 → 都写
        fs::create_dir_all(home.join(".kimi-code")).unwrap();
        let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
        assert_eq!(plans.len(), 2);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn apply_creates_backup_and_restore_brings_back_newest() {
        let home = tmpdir("apply-home");
        let backups = tmpdir("apply-bak");
        let target_dir = home.join(".claude");
        fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("settings.json");
        fs::write(&target, r#"{"env": {"OTHER": "1"}}"#).unwrap();

        let p = profile("claude-code");
        let plans = plan_writes(&home, &p, Some("sk-secret"), &["m1".to_string()]).unwrap();
        let written = apply_plans(&backups, &home, &plans).unwrap();
        assert_eq!(written, vec!["~/.claude/settings.json".to_string()]);
        // 原文件被备份，新内容已写入
        let baks = list_backups(&backups, "settings.json");
        assert_eq!(baks.len(), 1);
        let new_content = fs::read_to_string(&target).unwrap();
        assert!(new_content.contains("ANTHROPIC_AUTH_TOKEN"));
        // 再改一次并重新应用：第二批清单记录 v2，restore 应按完整批次恢复它
        fs::write(&target, r#"{"v": 2}"#).unwrap();
        let plans = plan_writes(&home, &p, Some("sk-secret-2"), &["m1".to_string()]).unwrap();
        apply_plans(&backups, &home, &plans).unwrap();
        let restored = restore_from(&backups, &home, "claude-code").unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"v": 2}"#);
        // 恢复前的当前状态也生成一批备份；原恢复点不会被消费，可再次恢复撤销本次操作
        assert!(list_backups(&backups, "settings.json").len() >= 3);
        assert!(manifest_files(&backups).len() >= 3);
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn transaction_rolls_back_all_targets_when_later_replace_fails() {
        let dir = tmpdir("rollback");
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        fs::write(&a, "old-a").unwrap();
        fs::write(&b, "old-b").unwrap();
        let actions = vec![
            TxAction {
                tag: "a".into(),
                path: a.clone(),
                content: Some(b"new-a".to_vec()),
            },
            TxAction {
                tag: "b".into(),
                path: b.clone(),
                content: Some(b"new-b".to_vec()),
            },
        ];
        let id = batch_id();
        let originals = actions
            .iter()
            .map(|a| fs::read(&a.path).ok())
            .collect::<Vec<_>>();
        let staged = stage_actions(&actions, &id).unwrap();
        let err = commit_actions_with(&actions, &staged, &originals, &id, |from, to, i| {
            if i == 1 {
                Err(std::io::Error::other("injected failure"))
            } else {
                fs::rename(from, to)
            }
        })
        .unwrap_err();
        assert!(err.contains("已自动回滚全部目标文件"), "{err}");
        assert_eq!(fs::read_to_string(&a).unwrap(), "old-a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "old-b");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_removes_file_that_did_not_exist_before_apply() {
        let home = tmpdir("restore-absent-home");
        let backups = tmpdir("restore-absent-bak");
        let target = home.join(".gemini/.env");
        let p = profile("gemini");
        let plans = plan_writes(&home, &p, Some("secret"), &["m1".to_string()]).unwrap();
        apply_plans(&backups, &home, &plans).unwrap();
        assert!(target.exists());
        restore_from(&backups, &home, "gemini").unwrap();
        assert!(!target.exists(), "应用前不存在的文件恢复时应被移除");
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn original_snapshot_survives_rotations_and_restores_first_write_state() {
        let home = tmpdir("orig-home");
        let backups = tmpdir("orig-bak");
        let target_dir = home.join(".claude");
        fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("settings.json");
        // Ccode 动手前的原始内容
        fs::write(&target, r#"{"env": {"OTHER": "1"}}"#).unwrap();
        let p = profile("claude-code");
        // 连续 7 次 apply：常规批次窗口（5 份）被烧穿，原始快照必须始终在场
        for _ in 0..7 {
            let plans = plan_writes(&home, &p, Some("sk-secret"), &["m1".to_string()]).unwrap();
            apply_plans(&backups, &home, &plans).unwrap();
        }
        assert!(list_backups(&backups, "settings.json").len() <= 5);
        assert_eq!(
            fs::read_to_string(original_dir(&backups).join("settings.json")).unwrap(),
            r#"{"env": {"OTHER": "1"}}"#,
            "原始快照必须保持首次写入前的内容"
        );
        // 恢复初始状态 = 回到首次写入前
        restore_from_original(&backups, &home).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"env": {"OTHER": "1"}}"#);
        // 原始快照不被恢复动作消耗，可再次恢复
        assert!(original_dir(&backups).join("manifest.json").is_file());
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn restore_original_removes_file_created_by_first_apply() {
        let home = tmpdir("orig-absent-home");
        let backups = tmpdir("orig-absent-bak");
        let target = home.join(".gemini/.env");
        let p = profile("gemini");
        let plans = plan_writes(&home, &p, Some("secret"), &["m1".to_string()]).unwrap();
        apply_plans(&backups, &home, &plans).unwrap();
        assert!(target.exists());
        restore_from_original(&backups, &home).unwrap();
        assert!(!target.exists(), "首次写入前不存在的文件，恢复初始状态时应删除");
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn backup_rotation_keeps_newest_five() {
        let dir = tmpdir("rotation");
        let target = dir.join("f.json");
        fs::write(&target, "{}").unwrap();
        for i in 0..7 {
            backup_file_with_ts(&dir, "f.json", &target, &format!("2026010{i}-000000")).unwrap();
        }
        let mut baks = list_backups(&dir, "f.json");
        baks.sort();
        assert_eq!(baks.len(), 5);
        assert_eq!(baks[0], "f.json.20260102-000000.bak");
        assert_eq!(baks[4], "f.json.20260106-000000.bak");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn timestamp_formats_utc() {
        let (y, m, d) = civil_from_days(20454); // 2026-01-01
        assert_eq!((y, m, d), (2026, 1, 1));
        assert_eq!(timestamp_now().len(), 15); // yyyymmdd-hhmmss
    }

    #[test]
    fn disk_matches_plans_uses_json_subset_not_full_trim() {
        let dir = tmpdir("dry-subset");
        let path = dir.join("settings.json");
        fs::write(&path, "{\n  \"env\": {\"A\": \"1\"},\n  \"theme\": \"dark\"\n}\n").unwrap();
        let planned = PlannedWrite {
            tag: "settings.json",
            path: path.clone(),
            content: "{\"env\":{\"A\":\"1\"}}".into(),
        };
        assert!(disk_matches_plans(&[planned]), "CLI 多出来的键不算漂移");
        fs::write(&path, "{\"env\":{\"A\":\"2\"}}").unwrap();
        let planned2 = PlannedWrite {
            tag: "settings.json",
            path,
            content: "{\"env\":{\"A\":\"1\"}}".into(),
        };
        assert!(!disk_matches_plans(&[planned2]));
        fs::remove_dir_all(&dir).ok();
    }
}
