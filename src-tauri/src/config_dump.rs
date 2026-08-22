//! 生效配置自省：dump 出当前实际生效的配置快照（整份脱敏），排查九家 agent
//! 配置漂移时不用猜。只读——不创建/改写任何用户配置文件
//! （ProfileStore::existing 不建目录，ws_settings 三层合并本来就是只读解析）。

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// profile 快照：绝不包含密钥本体与 extra_env（用户自定义 env 可能夹带密钥），只留尾号提示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDumpDto {
    pub id: String,
    pub name: String,
    pub agent: String,
    /// "api"（端点+密钥注入）| "official"（官方账号登录，拉起不注入 API env）
    pub account_type: crate::profiles::AccountType,
    pub no_auth: bool,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub models: Vec<String>,
    pub key_hint: Option<String>,
    pub has_key: bool,
    pub last_used_at: Option<String>,
}

impl ProfileDumpDto {
    fn from(p: &crate::profiles::Profile) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            agent: p.agent.clone(),
            account_type: p.account_type,
            no_auth: p.no_auth,
            protocol: p.protocol.clone(),
            base_url: p.base_url.clone(),
            models: p.models.clone(),
            key_hint: p.key_hint.clone(),
            has_key: p.has_key,
            last_used_at: p.last_used_at.clone(),
        }
    }
}

/// 项目级 .ccode/settings.toml 三层合并的生效值 + 每层来源标注（仅传入 project_root 时产出）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSettingsDumpDto {
    pub project_root: String,
    pub merged: crate::ws_settings::WsSettingsDto,
    pub sources: crate::ws_settings::WsTraceDto,
    /// 三层都没定义 files_to_copy 时 true：merged 里是工作区 W1 固定回落清单，不来自任何一层
    pub files_to_copy_fallback: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectiveConfigDumpDto {
    pub generated_at: String,
    pub app_version: &'static str,
    /// 合并缺省后的完整应用设置（settings.rs with_defaults 后的 DTO，无敏感字段）
    pub app_settings: crate::settings::AppSettingsDto,
    pub profiles: Vec<ProfileDumpDto>,
    /// 精确注意力标记开关 map（agent id → 开关；与 appSettings.hooksAttention 同一份，
    /// 单独列出便于一眼查——排查 hooks 漂移时不用翻整份设置）
    pub hooks_attention: BTreeMap<String, bool>,
    /// 九家能力表（与 agent_capabilities command 同源）
    pub capabilities: Vec<crate::agent_specs::AgentCapabilitiesDto>,
    /// 仅当传入 project_root 时存在
    pub workspace_settings: Option<WorkspaceSettingsDumpDto>,
}

fn collect_dump(project_root: Option<String>) -> Result<EffectiveConfigDumpDto, String> {
    let settings = crate::settings::current_with_defaults();
    let profiles = match crate::profiles::ProfileStore::existing() {
        Some(store) => store.list()?.iter().map(ProfileDumpDto::from).collect(),
        None => Vec::new(),
    };
    let workspace_settings = project_root
        .filter(|r| !r.trim().is_empty())
        .map(|root| {
            let repo = PathBuf::from(crate::sessions::expand_tilde(&root));
            let (merged, sources) = crate::ws_settings::merged_settings_traced(&repo);
            let files_to_copy_fallback = merged.files_to_copy.is_none();
            WorkspaceSettingsDumpDto {
                project_root: repo.to_string_lossy().into_owned(),
                merged: crate::ws_settings::to_dto(merged, &crate::workspaces::FILES_TO_COPY),
                sources,
                files_to_copy_fallback,
            }
        });
    Ok(EffectiveConfigDumpDto {
        generated_at: crate::sessions::now_iso(),
        app_version: env!("CARGO_PKG_VERSION"),
        hooks_attention: settings.hooks_attention.clone().unwrap_or_default(),
        app_settings: settings,
        profiles,
        capabilities: crate::agent_specs::agent_capabilities(),
        workspace_settings,
    })
}

/// 序列化 pretty JSON 后整份过出站脱敏（防 baseUrl 等处意外带出密钥样字符串），
/// 与 handoff/sessions 出站同一口径（sessions::redact_sensitive_text）
fn render_dump(dump: &EffectiveConfigDumpDto) -> Result<String, String> {
    let text = serde_json::to_string_pretty(dump).map_err(|e| e.to_string())?;
    Ok(crate::sessions::redact_sensitive_text(&text))
}

fn build_dump(project_root: Option<String>) -> Result<String, String> {
    render_dump(&collect_dump(project_root)?)
}

/// 当前生效配置快照（pretty JSON 字符串，已脱敏）
#[tauri::command]
pub async fn dump_effective_config(project_root: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || build_dump(project_root))
        .await
        .map_err(|e| format!("生成配置快照失败: {e}"))?
}

/// 导出到 ~/Downloads/ccode-exports/ccode-effective-config-<时间戳>.json，返回文件路径
/// （交互口径与 export_app_log / export_diagnostics_bundle 一致：一键落盘，不弹对话框）
#[tauri::command]
pub async fn export_effective_config(project_root: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = build_dump(project_root)?;
        let dir = dirs::download_dir()
            .ok_or("无法确定下载目录")?
            .join("ccode-exports");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
        let path = dir.join(format!(
            "ccode-effective-config-{}.json",
            crate::sessions::now_iso().replace([':', '.'], "-")
        ));
        crate::profiles::atomic_write(&path, &text)?;
        crate::logbuf::record(
            "info",
            "config-dump",
            &format!("配置快照已导出: {}", path.display()),
        );
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("导出配置快照失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile(base_url: &str) -> crate::profiles::Profile {
        crate::profiles::Profile {
            id: "p-1".into(),
            agent: "claude-code".into(),
            name: "测试配置".into(),
            account_type: crate::profiles::AccountType::Api,
            no_auth: false,
            protocol: Some("anthropic".into()),
            base_url: Some(base_url.into()),
            models: vec!["claude-sonnet".into()],
            extra_env: Default::default(),
            key_hint: Some("···3456".into()),
            model: None,
            last_used_at: None,
            has_key: true,
        }
    }

    fn dump_with(dump_profiles: Vec<ProfileDumpDto>) -> EffectiveConfigDumpDto {
        EffectiveConfigDumpDto {
            generated_at: "2026-08-20T00:00:00Z".into(),
            app_version: "0.0.0-test",
            app_settings: crate::settings::AppSettingsDto::default(),
            profiles: dump_profiles,
            hooks_attention: BTreeMap::new(),
            capabilities: vec![],
            workspace_settings: None,
        }
    }

    #[test]
    fn profile_dump_redacts_secret_like_base_url() {
        // baseUrl 意外带出密钥样字符串（?key=sk-... 形式）时，整份 JSON 脱敏必须拦下
        let dump = dump_with(vec![ProfileDumpDto::from(&sample_profile(
            "https://api.example.com/?key=sk-testsecretkey123456",
        ))]);
        let text = render_dump(&dump).unwrap();
        assert!(
            !text.contains("sk-testsecretkey123456"),
            "密钥样字符串必须被脱敏: {text}"
        );
        assert!(text.contains("[已隐藏密钥"), "应留下脱敏标记: {text}");
        // 脱敏只改字符串值内部，输出仍是合法 JSON
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["profiles"][0]["keyHint"], "···3456");
    }

    #[test]
    fn profile_dump_never_carries_secret_fields() {
        let dump = dump_with(vec![ProfileDumpDto::from(&sample_profile(
            "https://api.example.com",
        ))]);
        let text = render_dump(&dump).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let p = &v["profiles"][0];
        assert_eq!(p["keyHint"], "···3456", "只留尾号提示");
        assert_eq!(p["accountType"], "api");
        assert!(p.get("apiKey").is_none(), "绝不包含密钥本体字段");
        assert!(p.get("extraEnv").is_none(), "不含 extra_env（可能夹带密钥）");
        assert!(p.get("model").is_none(), "旧版单模型字段不写出");
    }

    #[test]
    fn build_dump_smoke_produces_valid_json() {
        // command 冒烟：无 project_root 时五段齐备、workspaceSettings 为 null
        let text = build_dump(None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        for key in [
            "generatedAt",
            "appVersion",
            "appSettings",
            "profiles",
            "hooksAttention",
            "capabilities",
        ] {
            assert!(v.get(key).is_some(), "缺段 {key}");
        }
        assert!(
            !v["capabilities"].as_array().unwrap().is_empty(),
            "能力表来自 agent_specs 注册表，不应为空"
        );
        assert!(v["workspaceSettings"].is_null(), "无 project_root 时为 null");
        // appSettings 是合并缺省后的完整对象
        assert!(v["appSettings"]["terminalFontSize"].is_number());
    }

    #[test]
    fn build_dump_with_project_root_includes_workspace_settings() {
        let dir = std::env::temp_dir().join(format!("ccode-cfgdump-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        let ccode = repo.join(".ccode");
        std::fs::create_dir_all(&ccode).unwrap();
        std::fs::write(
            ccode.join("settings.toml"),
            "run_mode = \"nonconcurrent\"\n[scripts]\nsetup = \"make setup\"\n",
        )
        .unwrap();
        let text = build_dump(Some(repo.to_string_lossy().into_owned())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let ws = &v["workspaceSettings"];
        assert_eq!(ws["merged"]["runMode"], "nonconcurrent");
        assert_eq!(
            ws["sources"]["runMode"], "repo",
            "来源标注：run_mode 生效值来自仓库层"
        );
        assert_eq!(ws["sources"]["setup"], "repo");
        assert_eq!(ws["merged"]["setup"], "make setup");
        std::fs::remove_dir_all(&dir).ok();
    }
}
