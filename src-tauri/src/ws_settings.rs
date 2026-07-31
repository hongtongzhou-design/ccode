use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// ===== 解析模型（未知键忽略，前向兼容） =====

#[derive(Debug, Default, Deserialize)]
struct LayerSettings {
    files_to_copy: Option<Vec<String>>,
    run_mode: Option<String>,
    scripts: Option<Scripts>,
}

#[derive(Debug, Default, Deserialize)]
struct Scripts {
    setup: Option<String>,
    archive: Option<String>,
    run: Option<BTreeMap<String, RunScript>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RunScript {
    command: String,
    #[serde(default)]
    default: bool,
}

// ===== 前端 DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptDto {
    pub name: String,
    pub command: String,
    #[serde(rename = "default")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsSettingsDto {
    pub files_to_copy: Vec<String>,
    pub run_mode: String,
    pub setup: Option<String>,
    pub archive: Option<String>,
    pub run: Vec<RunScriptDto>,
}

/// 合并后的内部形态：files_to_copy 为 None 表示三层都没定义（调用方回落 W1 固定清单）
#[derive(Debug, Default)]
pub(crate) struct MergedSettings {
    pub files_to_copy: Option<Vec<String>>,
    pub run_mode: Option<String>,
    pub setup: Option<String>,
    pub archive: Option<String>,
    pub run: Vec<RunScriptDto>,
}

fn parse_layer(path: &Path) -> Option<LayerSettings> {
    let text = fs::read_to_string(path).ok()?;
    toml::from_str(&text).ok()
}

/// 单层并入累计结果：标量后层覆盖，files_to_copy 并集去重，run 按名字覆盖
fn merge_into(acc: &mut MergedSettings, layer: LayerSettings) {
    if let Some(files) = layer.files_to_copy {
        let acc_files = acc.files_to_copy.get_or_insert_with(Vec::new);
        for f in files {
            if !f.is_empty() && !acc_files.contains(&f) {
                acc_files.push(f);
            }
        }
    }
    if let Some(run_mode) = layer.run_mode {
        acc.run_mode = Some(run_mode);
    }
    if let Some(scripts) = layer.scripts {
        if scripts.setup.is_some() {
            acc.setup = scripts.setup;
        }
        if scripts.archive.is_some() {
            acc.archive = scripts.archive;
        }
        if let Some(run) = scripts.run {
            for (name, script) in run {
                let dto = RunScriptDto {
                    name: name.clone(),
                    command: script.command,
                    is_default: script.default,
                };
                if let Some(existing) = acc.run.iter_mut().find(|r| r.name == name) {
                    *existing = dto; // 同名后层覆盖
                } else {
                    acc.run.push(dto);
                }
            }
        }
    }
}

/// 三层合并：用户 ~/.config/ccode/settings.toml → 仓库 .ccode/settings.toml → .ccode/settings.local.toml
pub(crate) fn merged_settings(repo: &Path) -> MergedSettings {
    let user = dirs::config_dir().map(|d| d.join("ccode").join("settings.toml"));
    merged_settings_with_user(repo, user.as_deref())
}

/// user 层路径参数化，便于测试隔离
fn merged_settings_with_user(repo: &Path, user_layer: Option<&Path>) -> MergedSettings {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(u) = user_layer {
        paths.push(u.to_path_buf());
    }
    paths.push(repo.join(".ccode").join("settings.toml"));
    paths.push(repo.join(".ccode").join("settings.local.toml"));
    let mut acc = MergedSettings::default();
    for p in paths {
        if let Some(layer) = parse_layer(&p) {
            merge_into(&mut acc, layer);
        }
    }
    acc
}

fn to_dto(m: MergedSettings, fallback_files: &[&str]) -> WsSettingsDto {
    WsSettingsDto {
        files_to_copy: m
            .files_to_copy
            .unwrap_or_else(|| fallback_files.iter().map(|s| s.to_string()).collect()),
        run_mode: m.run_mode.unwrap_or_else(|| "concurrent".into()),
        setup: m.setup,
        archive: m.archive,
        run: m.run,
    }
}

#[tauri::command]
pub async fn workspace_settings(repo_path: String) -> WsSettingsDto {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(crate::sessions::expand_tilde(&repo_path));
        to_dto(
            merged_settings(&repo),
            &crate::workspaces::FILES_TO_COPY,
        )
    })
    .await
    .unwrap_or_else(|_| to_dto(MergedSettings::default(), &crate::workspaces::FILES_TO_COPY))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn three_layer_merge_precedence_and_union() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        let user = dir.join("user-settings.toml");
        write(
            &user,
            r#"files_to_copy = [".env", ".userrc"]
run_mode = "concurrent"
[scripts]
setup = "user setup"
archive = "user archive"
[scripts.run]
web = { command = "user dev", default = true }
"#,
        );
        write(
            &repo.join(".ccode").join("settings.toml"),
            r#"files_to_copy = [".env.local"]
[scripts]
setup = "repo setup"
[scripts.run]
web = { command = "repo dev" }
test = { command = "repo test" }
"#,
        );
        write(
            &repo.join(".ccode").join("settings.local.toml"),
            r#"files_to_copy = [".env", ".secrets"]
run_mode = "nonconcurrent"
[scripts.run]
test = { command = "local test" }
"#,
        );
        let m = merged_settings_with_user(&repo, Some(&user));
        // files_to_copy：三层并集去重，保持出现顺序
        assert_eq!(
            m.files_to_copy.unwrap(),
            vec![".env", ".userrc", ".env.local", ".secrets"]
        );
        // 标量后层覆盖；未被覆盖的保留浅层值
        assert_eq!(m.run_mode.as_deref(), Some("nonconcurrent"));
        assert_eq!(m.setup.as_deref(), Some("repo setup"));
        assert_eq!(m.archive.as_deref(), Some("user archive"));
        // run 按名字合并：web 被 repo 层覆盖，test 被 local 层覆盖
        assert_eq!(m.run.len(), 2);
        let web = m.run.iter().find(|r| r.name == "web").unwrap();
        assert_eq!(web.command, "repo dev");
        assert!(!web.is_default, "覆盖条目整体替换（default 也随之替换）");
        let test = m.run.iter().find(|r| r.name == "test").unwrap();
        assert_eq!(test.command, "local test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_layers_yield_defaults() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let m = merged_settings_with_user(&dir, None);
        assert!(m.files_to_copy.is_none(), "三层都没定义时由调用方回落固定清单");
        let dto = to_dto(m, &[".env", ".envrc"]);
        assert_eq!(dto.files_to_copy, vec![".env", ".envrc"]);
        assert_eq!(dto.run_mode, "concurrent");
        assert!(dto.setup.is_none() && dto.run.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_keys_and_broken_files_tolerated() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        write(
            &repo.join(".ccode").join("settings.toml"),
            "future_key = 42\n[scripts]\nsetup = \"ok\"\n",
        );
        write(&repo.join(".ccode").join("settings.local.toml"), "not [valid toml");
        let m = merged_settings_with_user(&repo, None);
        assert_eq!(m.setup.as_deref(), Some("ok"), "坏掉的 local 层不影响有效层");
        std::fs::remove_dir_all(&dir).ok();
    }
}
