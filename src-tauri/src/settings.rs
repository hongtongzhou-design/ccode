//! 应用级设置（<config>/ccode/settings.json）：全部字段可选，读取侧与默认值合并。
//! 消费点：终端外观（前端）、usage 汇率、updater 的 brew 镜像开关。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_TERMINAL_FONT_SIZE: u16 = 13;
pub const DEFAULT_SCROLLBACK: u32 = 5000;
pub const DEFAULT_RATE_USD_CNY: f64 = 7.2;
pub const DEFAULT_BREW_MIRROR: bool = true;
pub const DEFAULT_THEME: &str = "midnight";
pub const DEFAULT_TERMINAL_FONT_FAMILY: &str = "JetBrains Mono";
const KNOWN_THEMES: [&str; 7] = [
    "midnight", "terracotta", "ayu", "mocha", "neutral", "dracula", "shadcn",
];
/// 会话页「⇗ 外部恢复」可选的终端应用；auto = 按平台优先级探测
const KNOWN_EXTERNAL_TERMINALS: [&str; 9] = [
    "auto", "ghostty", "iterm", "terminal", "cmd",
    "gnome-terminal", "konsole", "xfce4-terminal", "xterm",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettingsDto {
    pub terminal_font_size: Option<u16>,
    pub terminal_font_family: Option<String>,
    /// 终端 16 色调色板预设：dark-plus（默认）| solarized | one-dark | catppuccin
    pub terminal_palette: Option<String>,
    pub scrollback: Option<u32>,
    pub rate_usd_cny: Option<f64>,
    pub brew_mirror: Option<bool>,
    pub theme: Option<String>,
    /// ◈ AI 功能（提交信息/摘要/PR 描述）固定使用的 profile id；None = 自动（最近使用）
    pub ai_profile_id: Option<String>,
    /// 会话页「⇗ 外部恢复」使用的终端应用（KNOWN_EXTERNAL_TERMINALS）；None/auto = 自动探测
    pub external_terminal: Option<String>,
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("settings.json"))
}

/// 文件缺失/损坏 → 全 None（由调用方合并默认值）
fn read_from(path: &Path) -> AppSettingsDto {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_to(path: &Path, settings: &AppSettingsDto) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 合并默认值：get_settings 永远返回完整对象；未知 theme 值回落默认
fn with_defaults(s: AppSettingsDto) -> AppSettingsDto {
    AppSettingsDto {
        terminal_font_size: s.terminal_font_size.or(Some(DEFAULT_TERMINAL_FONT_SIZE)),
        terminal_font_family: s
            .terminal_font_family
            .or_else(|| Some(DEFAULT_TERMINAL_FONT_FAMILY.to_string())),
        terminal_palette: s.terminal_palette.filter(|p| {
            ["dark-plus", "solarized", "one-dark", "catppuccin"].contains(&p.as_str())
        }),
        scrollback: s.scrollback.or(Some(DEFAULT_SCROLLBACK)),
        rate_usd_cny: s.rate_usd_cny.or(Some(DEFAULT_RATE_USD_CNY)),
        brew_mirror: s.brew_mirror.or(Some(DEFAULT_BREW_MIRROR)),
        theme: Some(
            s.theme
                .filter(|t| KNOWN_THEMES.contains(&t.as_str()))
                .unwrap_or_else(|| DEFAULT_THEME.to_string()),
        ),
        ai_profile_id: s.ai_profile_id.filter(|v| !v.trim().is_empty()),
        external_terminal: Some(
            s.external_terminal
                .filter(|v| KNOWN_EXTERNAL_TERMINALS.contains(&v.as_str()))
                .unwrap_or_else(|| "auto".to_string()),
        ),
    }
}

/// patch 语义：只覆盖传入的 Some 字段
fn merge(cur: &mut AppSettingsDto, patch: AppSettingsDto) {
    if patch.terminal_font_size.is_some() {
        cur.terminal_font_size = patch.terminal_font_size;
    }
    if patch.terminal_font_family.is_some() {
        cur.terminal_font_family = patch.terminal_font_family;
    }
    if patch.terminal_palette.is_some() {
        cur.terminal_palette = patch.terminal_palette;
    }
    if patch.scrollback.is_some() {
        cur.scrollback = patch.scrollback;
    }
    if patch.rate_usd_cny.is_some() {
        cur.rate_usd_cny = patch.rate_usd_cny;
    }
    if patch.brew_mirror.is_some() {
        cur.brew_mirror = patch.brew_mirror;
    }
    if patch.theme.is_some() {
        cur.theme = patch.theme;
    }
    // 支持清空：传空字符串 → None（回到「自动=最近使用」）
    if patch.ai_profile_id.is_some() {
        cur.ai_profile_id = patch.ai_profile_id.filter(|v| !v.trim().is_empty());
    }
    if patch.external_terminal.is_some() {
        cur.external_terminal = patch.external_terminal;
    }
}

// ===== 供其他模块读取的小入口（每次都从文件读，改动即时生效） =====

pub(crate) fn read_current() -> AppSettingsDto {
    settings_path()
        .map(|p| read_from(&p))
        .unwrap_or_default()
}

pub(crate) fn brew_mirror_enabled() -> bool {
    read_current().brew_mirror.unwrap_or(DEFAULT_BREW_MIRROR)
}

pub(crate) fn rate_setting() -> Option<f64> {
    read_current().rate_usd_cny.filter(|r| *r > 0.0)
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn get_settings() -> AppSettingsDto {
    with_defaults(read_current())
}

#[tauri::command]
pub async fn update_settings(patch: AppSettingsDto) -> Result<AppSettingsDto, String> {
    let path = settings_path()?;
    let mut cur = read_from(&path);
    merge(&mut cur, patch);
    write_to(&path, &cur)?;
    Ok(with_defaults(cur))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn missing_file_merges_to_full_defaults() {
        let p = tmp();
        let full = with_defaults(read_from(&p));
        assert_eq!(full.terminal_font_size, Some(13));
        assert_eq!(full.scrollback, Some(5000));
        assert_eq!(full.rate_usd_cny, Some(7.2));
        assert_eq!(full.brew_mirror, Some(true));
        assert_eq!(full.theme.as_deref(), Some("midnight"));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn partial_update_keeps_other_fields() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                terminal_font_size: Some(15),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        // 第二次 patch 只动 theme，font_size 应保留
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                theme: Some("dracula".into()),
                ..Default::default()
            },
        );
        write_to(&p, &cur).unwrap();
        let full = with_defaults(read_from(&p));
        assert_eq!(full.terminal_font_size, Some(15), "前次写入的字段不被后续 patch 覆盖");
        assert_eq!(full.theme.as_deref(), Some("dracula"));
        assert_eq!(full.brew_mirror, Some(true));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn unknown_theme_falls_back_to_default() {
        let full = with_defaults(AppSettingsDto {
            theme: Some("neon".into()),
            ..Default::default()
        });
        assert_eq!(full.theme.as_deref(), Some("midnight"));
    }

    #[test]
    fn external_terminal_defaults_to_auto_and_rejects_unknown() {
        // 缺失 → auto
        let full = with_defaults(AppSettingsDto::default());
        assert_eq!(full.external_terminal.as_deref(), Some("auto"));
        // 未知值 → auto；已知值保留
        let full = with_defaults(AppSettingsDto {
            external_terminal: Some("warp".into()),
            ..Default::default()
        });
        assert_eq!(full.external_terminal.as_deref(), Some("auto"));
        let full = with_defaults(AppSettingsDto {
            external_terminal: Some("ghostty".into()),
            ..Default::default()
        });
        assert_eq!(full.external_terminal.as_deref(), Some("ghostty"));
    }

    #[test]
    fn ai_profile_id_empty_string_clears_to_auto() {
        let p = tmp();
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profile_id: Some("p-1".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profile_id.as_deref(), Some("p-1"));
        // 传空字符串 = 清空回「自动」
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profile_id: Some("".into()),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profile_id, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }
}
