//! 「设为全局默认」：把 profile 写入各 CLI 自己的配置文件。
//! 这是全应用唯一被允许写 CLI 配置的地方；写任何已存在的文件前必须先备份。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// 一次计划好的写入：tag 用于备份文件命名（kimi 两个 config.toml 靠它区分）
struct PlannedWrite {
    tag: &'static str,
    path: PathBuf,
    content: String,
}

/// 每个 agent 的全局配置目标文件（tag, 相对 home 路径），restore/has_backup 共用
fn target_specs(agent: &str) -> Vec<(&'static str, &'static str)> {
    match agent {
        "claude-code" => vec![("settings.json", ".claude/settings.json")],
        "codex" => vec![
            ("config.toml", ".codex/config.toml"),
            ("auth.json", ".codex/auth.json"),
        ],
        "gemini" => vec![(".env", ".gemini/.env")],
        "qwen" => vec![("settings.json", ".qwen/settings.json")],
        "opencode" => vec![("opencode.json", ".config/opencode/opencode.json")],
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
        ensure_obj(&mut v, &["modelProviders", protocol])?
            .insert("models".into(), json!(entries));
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

fn patch_opencode_config(
    existing: Option<&str>,
    provider: Value,
    model: Option<&str>,
) -> Result<String, String> {
    let mut v = parse_json_doc(existing)?;
    ensure_obj(&mut v, &["provider"])?.insert("ccode".into(), provider);
    let root = v.as_object_mut().unwrap();
    if let Some(m) = model {
        root.insert("model".into(), json!(format!("ccode/{m}")));
    }
    root.insert("autoupdate".into(), json!(false));
    to_pretty(&v)
}

// ===== TOML 补丁（toml_edit 保留文档其余部分） =====

fn parse_toml_doc(existing: Option<&str>) -> Result<toml_edit::DocumentMut, String> {
    existing
        .unwrap_or("")
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("现有 TOML 配置解析失败，已停止写入: {e}"))
}

/// 取子表；已存在但不是表时报错停止，避免覆盖用户数据
fn sub_table<'a>(item: &'a mut toml_edit::Item, key: &str) -> Result<&'a mut toml_edit::Item, String> {
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
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    // 与 launch_plan 的 -c 注入同构：内联一个名为 ccode 的 Responses API provider
    let providers = sub_table(doc.as_item_mut(), "model_providers")?;
    let ccode = sub_table(providers, "ccode")?;
    ccode["name"] = value("Ccode");
    if let Some(u) = base_url {
        ccode["base_url"] = value(u);
    }
    ccode["env_key"] = value("CODEX_API_KEY");
    ccode["wire_api"] = value("responses");
    doc["model_provider"] = value("ccode");
    if let Some(m) = model {
        doc["model"] = value(m);
    }
    // /model 选择器的模型目录（仅启动时读取）
    if let Some(p) = catalog {
        doc["model_catalog_json"] = value(p.to_string_lossy().as_ref());
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
    base_url: Option<&str>,
    key: Option<&str>,
    models: &[String],
) -> Result<String, String> {
    use toml_edit::value;
    let mut doc = parse_toml_doc(existing)?;
    let providers = sub_table(doc.as_item_mut(), "providers")?;
    let ccode = sub_table(providers, "ccode")?;
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
        let mc = sub_table(models_tbl, "ccode")?;
        mc["provider"] = value("ccode");
        doc["default_model"] = value("ccode");
    } else {
        let models_tbl = sub_table(doc.as_item_mut(), "models")?;
        for m in models {
            let t = sub_table(models_tbl, &kimi_model_alias(m))?;
            t["provider"] = value("ccode");
            t["model"] = value(m.as_str());
        }
        doc["default_model"] = value(kimi_model_alias(&models[0]));
    }
    Ok(doc.to_string())
}

// ===== .env 补丁（gemini） =====

fn patch_env_file(existing: Option<&str>, pairs: &[(String, String)]) -> String {
    let mut lines: Vec<String> = existing
        .unwrap_or("")
        .lines()
        .map(String::from)
        .collect();
    for (k, v) in pairs {
        let prefix = format!("{k}=");
        match lines.iter_mut().find(|l| l.starts_with(&prefix)) {
            Some(l) => *l = format!("{k}={v}"),
            None => lines.push(format!("{k}={v}")),
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
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
    let base_url = profile.base_url.as_deref();
    // 全局模式没有运行时模型选择，默认取模型列表首个（与启动注入的兜底一致）
    let model = models.first().map(|s| s.as_str());
    let mut plans = Vec::new();
    let mut push = |tag: &'static str, path: PathBuf, content: String| {
        plans.push(PlannedWrite { tag, path, content });
    };
    match profile.agent.as_str() {
        "claude-code" => {
            let path = home.join(".claude/settings.json");
            let content =
                patch_claude_settings(read_existing(&path).as_deref(), base_url, key, models)?;
            push("settings.json", path, content);
        }
        "codex" => {
            // /model 选择器的模型目录：先写 catalog 文件，再把路径写进 config.toml
            let catalog = agents::write_codex_catalog(profile)?;
            let path = home.join(".codex/config.toml");
            let content = patch_codex_config(
                read_existing(&path).as_deref(),
                base_url,
                model,
                catalog.as_deref(),
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
                let content = patch_env_file(read_existing(&path).as_deref(), &pairs);
                push(".env", path, content);
            }
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
            let provider = agents::opencode_provider_json(profile, key, model);
            let path = home.join(".config/opencode/opencode.json");
            let content = patch_opencode_config(read_existing(&path).as_deref(), provider, model)?;
            push("opencode.json", path, content);
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
                let content = patch_kimi_config(
                    read_existing(&path).as_deref(),
                    provider_type,
                    base_url,
                    key,
                    &profile.models,
                )?;
                push(tag, path, content);
            }
        }
        other => return Err(format!("未知 agent: {other}")),
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

fn backup_file_with_ts(dir: &Path, tag: &str, path: &Path, ts: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let bak = dir.join(format!("{tag}.{ts}.bak"));
    fs::copy(path, &bak).map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
    // 每个 agent+文件只保留最新 5 份（文件名含时间戳，字典序即时间序）
    let mut baks = list_backups(dir, tag);
    baks.sort();
    while baks.len() > 5 {
        let oldest = baks.remove(0);
        let _ = fs::remove_file(dir.join(oldest));
    }
    Ok(bak)
}

fn backup_file(dir: &Path, tag: &str, path: &Path) -> Result<PathBuf, String> {
    backup_file_with_ts(dir, tag, path, &timestamp_now())
}

fn apply_plans(backups_dir: &Path, home: &Path, plans: &[PlannedWrite]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    for plan in plans {
        if plan.path.exists() {
            backup_file(backups_dir, plan.tag, &plan.path)?;
        }
        if let Some(parent) = plan.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        profiles::atomic_write(&plan.path, &plan.content)?;
        written.push(display_path(home, &plan.path));
    }
    Ok(written)
}

fn restore_from(backups_dir: &Path, home: &Path, agent: &str) -> Result<Vec<String>, String> {
    let mut restored = Vec::new();
    for (tag, rel) in target_specs(agent) {
        let mut baks = list_backups(backups_dir, tag);
        baks.sort();
        if let Some(newest) = baks.pop() {
            let to = home.join(rel);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            fs::rename(backups_dir.join(&newest), &to)
                .map_err(|e| format!("恢复 {} 失败: {e}", to.display()))?;
            restored.push(display_path(home, &to));
        }
    }
    Ok(restored)
}

fn display_path(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rel) => format!("~/{}", rel.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn apply_profile_global(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<Vec<String>, String> {
    let profile = store.get(&profile_id)?;
    let key = profiles::get_key(&profile_id);
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    let plans = plan_writes(&home, &profile, key.as_deref(), &profile.models)?;
    let backups_dir = backups_root()?.join(&profile.agent);
    apply_plans(&backups_dir, &home, &plans)
}

#[tauri::command]
pub fn restore_global_backup(agent: String) -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    let dir = backups_root()?.join(&agent);
    restore_from(&dir, &home, &agent)
}

#[tauri::command]
pub fn has_global_backup(agent: String) -> bool {
    let dir = match backups_root() {
        Ok(r) => r.join(&agent),
        Err(_) => return false,
    };
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.file_name().to_string_lossy().ends_with(".bak"))
        })
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
            protocol: None,
            base_url: Some("https://relay.example.com".into()),
            models: vec!["m1".into()],
            extra_env: Default::default(),
            key_hint: None,
            model: None,
            has_key: false,
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
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret");
        assert_eq!(v["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4");
        // 模型列表注册进 /model 选择器的别名槽
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "claude-sonnet-4");
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "m2");
        assert_eq!(v["env"]["OTHER"], "1");
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn claude_patch_from_missing_file_creates_env_only() {
        let out = patch_claude_settings(None, None, None, &[]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].is_object());
        assert_eq!(v["env"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn codex_config_patch_preserves_other_tables() {
        let existing = "[other]\nkeep = 1\n\n[model_providers.ccode]\nold = \"x\"\n";
        let out = patch_codex_config(
            Some(existing),
            Some("https://r.example.com/v1"),
            Some("gpt-5"),
            Some(std::path::Path::new("/cfg/ccode/catalogs/codex-p1.json")),
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["other"]["keep"].as_integer(), Some(1));
        let ccode = &doc["model_providers"]["ccode"];
        assert_eq!(ccode["name"].as_str(), Some("Ccode"));
        assert_eq!(ccode["base_url"].as_str(), Some("https://r.example.com/v1"));
        assert_eq!(ccode["env_key"].as_str(), Some("CODEX_API_KEY"));
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
    fn gemini_env_patch_replaces_only_our_keys() {
        let existing = "# comment\nGEMINI_API_KEY=old\nOTHER=1\n";
        let pairs = vec![
            ("GEMINI_API_KEY".to_string(), "new-key".to_string()),
            ("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string()),
        ];
        let out = patch_env_file(Some(existing), &pairs);
        assert!(out.contains("GEMINI_API_KEY=new-key"));
        assert!(out.contains("GEMINI_MODEL=gemini-3-pro"));
        assert!(out.contains("OTHER=1"));
        assert!(out.contains("# comment"));
        assert!(!out.contains("old"));
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
        let existing = r#"{"modelProviders": {"gemini": {"models": [{"id": "g1"}]}, "openai": {"extra": 1}}}"#;
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
        assert!(models[0].get("baseUrl").is_none(), "无 base_url 时不写该字段");
    }

    #[test]
    fn opencode_patch_preserves_other_providers() {
        let existing = r#"{"provider": {"other": {"npm": "x"}}, "theme": "dark"}"#;
        let p = profile("opencode");
        let provider = agents::opencode_provider_json(&p, Some("sk-secret"), Some("m1"));
        let out = patch_opencode_config(Some(existing), provider, Some("m1")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"]["other"]["npm"], "x");
        assert_eq!(v["provider"]["ccode"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(v["provider"]["ccode"]["options"]["apiKey"], "sk-secret");
        assert_eq!(v["model"], "ccode/m1");
        assert_eq!(v["autoupdate"], false);
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn kimi_patch_writes_alias_table_per_model() {
        let existing = "[providers.other]\ntype = \"openai\"\n";
        let out = patch_kimi_config(
            Some(existing),
            "kimi",
            Some("https://api.moonshot.cn/v1"),
            Some("sk-secret"),
            &["kimi-k2".into(), "kimi.k2.5 turbo".into()],
        )
        .unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["providers"]["other"]["type"].as_str(), Some("openai"));
        let ccode = &doc["providers"]["ccode"];
        assert_eq!(ccode["type"].as_str(), Some("kimi"));
        assert_eq!(ccode["base_url"].as_str(), Some("https://api.moonshot.cn/v1"));
        assert_eq!(ccode["api_key"].as_str(), Some("sk-secret"));
        // 每个模型一个 [models.<alias>] 表；非法字符清洗为 _
        assert_eq!(doc["models"]["kimi-k2"]["provider"].as_str(), Some("ccode"));
        assert_eq!(doc["models"]["kimi-k2"]["model"].as_str(), Some("kimi-k2"));
        assert_eq!(
            doc["models"]["kimi_k2_5_turbo"]["model"].as_str(),
            Some("kimi.k2.5 turbo")
        );
        // default_model = 首个模型的别名
        assert_eq!(doc["default_model"].as_str(), Some("kimi-k2"));
    }

    #[test]
    fn kimi_patch_without_models_keeps_single_ccode_alias() {
        let out = patch_kimi_config(None, "openai", None, None, &[]).unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["providers"]["ccode"]["type"].as_str(), Some("openai"));
        assert_eq!(doc["models"]["ccode"]["provider"].as_str(), Some("ccode"));
        assert_eq!(doc["default_model"].as_str(), Some("ccode"));
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
        // 再改一次（原地制造第二份备份），restore 应恢复最近的那份
        fs::write(&target, r#"{"v": 2}"#).unwrap();
        backup_file_with_ts(&backups, "settings.json", &target, "20990101-000000").unwrap();
        let restored = restore_from(&backups, &home, "claude-code").unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"v": 2}"#);
        // 用过的 .bak 被移除，只剩最早那份
        assert_eq!(list_backups(&backups, "settings.json").len(), 1);
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
}
