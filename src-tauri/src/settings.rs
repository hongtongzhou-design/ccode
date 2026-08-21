//! 应用级设置（<config>/ccode/settings.json）：全部字段可选，读取侧与默认值合并。
//! 消费点：终端外观（前端）、usage 汇率、updater 的 brew 镜像开关、长任务 OS 通知开关（前端）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const DEFAULT_TERMINAL_FONT_SIZE: u16 = 14;
pub const DEFAULT_SCROLLBACK: u32 = 5000;
pub const DEFAULT_RATE_USD_CNY: f64 = 7.2;
pub const DEFAULT_BREW_MIRROR: bool = true;
pub const DEFAULT_NOTIFICATIONS_ENABLED: bool = true;
pub const DEFAULT_THEME: &str = "midnight";
pub const DEFAULT_TERMINAL_FONT_FAMILY: &str = "JetBrains Mono";
/// 全局快捷键默认绑定（前端 hotkeys.ts 解析；mod = macOS ⌘ / 其他平台 Ctrl）
pub const DEFAULT_HOTKEY_PALETTE: &str = "mod+k";
pub const DEFAULT_HOTKEY_HIDE_CHROME: &str = "mod+\\";
pub const DEFAULT_HOTKEY_PAGE_SWITCH: bool = true;
const KNOWN_THEMES: [&str; 14] = [
    "midnight", "terracotta", "ayu", "mocha", "neutral", "dracula", "shadcn",
    "midnight-light", "terracotta-light", "ayu-light", "mocha-light",
    "neutral-light", "dracula-light", "shadcn-light",
];
/// 终端 ANSI 调色板：四套深色 + 四套配对浅色。
/// 单一出处在前端 `src/terminal-palettes.ts` 的 PALETTE_LIST，此处是持久化白名单，两边须同步
/// （不在名单里的值会被静默丢弃，表现为「设置页选了调色板但没生效」）。
/// 启动页白名单（与前端 hotkeys.ts PAGE_HOTKEY_DEFS 同步）
const KNOWN_PAGES: [&str; 9] = [
    "workbench", "workspaces", "terminal", "sessions", "profiles",
    "skills", "mcp", "stats", "settings",
];
const KNOWN_PALETTES: [&str; 8] = [
    "dark-plus", "solarized", "one-dark", "catppuccin",
    "light-plus", "solarized-light", "one-light", "latte",
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
    /// 长任务 OS 通知开关（注意力跃迁且窗口未聚焦时发系统通知）
    pub notifications_enabled: Option<bool>,
    pub theme: Option<String>,
    /// ◈ AI 功能（提交信息/摘要/PR 描述）固定使用的 profile id；None = 自动（最近使用）
    pub ai_profile_id: Option<String>,
    /// ◈ AI 功能按功能独立配置：键 = 功能 key（见 ai.rs FN_* 常量），值 = profile id；
    /// 某功能缺省时回落 ai_profile_id，None = 全部走默认
    pub ai_profiles: Option<BTreeMap<String, String>>,
    /// 每个 agent 的默认 profile（agent id → profile id）：终端启动栏选完 agent 后预选它。
    /// 解析顺序 显式默认 > ccode.lastProfile（上次使用）> 该 agent 首个配置。
    /// 键缺失 = 没设默认，整图覆盖（同 ai_profiles 口径）。
    /// 刻意不在 profiles.json 加 `enabled` 布尔：配置是**启动那一刻**注入的，
    /// 没有「全局激活态」，加 enabled 会与注入语义打架、也会和「设为全局」形成两套激活概念。
    pub default_profiles: Option<BTreeMap<String, String>>,
    /// 启动时进入哪一页（页面 id，同 hotkeys.ts PAGE_HOTKEY_DEFS）；缺省 = workbench
    pub start_page: Option<String>,
    /// 「隐藏」的 profile id 列表：只影响终端启动栏下拉的分组（沉到「更多」），
    /// **不删数据、不改任何启动行为**——已选中它的标签照常工作，配置页照常列出。
    /// 与 default_profiles 一样存在设置里而不是 profiles.json：这是展示偏好，不是配置属性。
    pub hidden_profiles: Option<Vec<String>>,
    /// 会话页「⇗ 外部恢复」使用的终端应用（KNOWN_EXTERNAL_TERMINALS）；None/auto = 自动探测
    pub external_terminal: Option<String>,
    /// 精确注意力标记（agent hooks 桥接）：agent id → 开关。键缺失 = 关。
    /// 开/关由 hooks::set_hooks_attention 统一完成（写各家 hooks 配置 + 逐键记本字段），勿单独 patch
    pub hooks_attention: Option<BTreeMap<String, bool>>,
    /// 旧字段（Claude 单开关时代）：仅保留反序列化兼容，读取侧迁移进 hooks_attention（见
    /// with_defaults / set_hooks_attention_entry），不再写出
    #[serde(skip_serializing)]
    pub claude_hooks_attention: Option<bool>,
    /// 快捷键绑定（"mod+shift+k" 格式，mod=⌘/Ctrl；空串 = 禁用该快捷键）
    pub hotkey_palette: Option<String>,
    pub hotkey_hide_chrome: Option<String>,
    /// ⌘1–⌘9 页切整组总开关（关 = 全部页切绑定不生效）
    pub hotkey_page_switch: Option<bool>,
    /// 页切逐页绑定：键 = 页面 id（前端 hotkeys.ts PAGE_HOTKEY_DEFS），值 = 组合串；
    /// 键缺失 = 该页用默认绑定（mod+1..mod+9），整图覆盖（同 ai_profiles 口径）
    pub hotkey_pages: Option<BTreeMap<String, String>>,
    /// 想法期只读保护（卡片区「聊想法」）：开 = 注入只读/计划模式参数（支持的 CLI）+
    /// 预填指令带不动文件约束；关 = 纯聊天不动参数。卡片区就地开关，设置页不加行
    pub discuss_readonly: Option<bool>,
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
        terminal_palette: s
            .terminal_palette
            .filter(|p| KNOWN_PALETTES.contains(&p.as_str())),
        scrollback: s.scrollback.or(Some(DEFAULT_SCROLLBACK)),
        rate_usd_cny: s.rate_usd_cny.or(Some(DEFAULT_RATE_USD_CNY)),
        brew_mirror: s.brew_mirror.or(Some(DEFAULT_BREW_MIRROR)),
        notifications_enabled: s
            .notifications_enabled
            .or(Some(DEFAULT_NOTIFICATIONS_ENABLED)),
        theme: Some(
            s.theme
                .filter(|t| KNOWN_THEMES.contains(&t.as_str()))
                .unwrap_or_else(|| DEFAULT_THEME.to_string()),
        ),
        ai_profile_id: s.ai_profile_id.filter(|v| !v.trim().is_empty()),
        // 按功能配置不做默认值填充：键缺失即「跟随默认」
        ai_profiles: s.ai_profiles,
        default_profiles: s.default_profiles,
        start_page: s
            .start_page
            .filter(|p| KNOWN_PAGES.contains(&p.as_str())),
        hidden_profiles: s.hidden_profiles,
        external_terminal: Some(
            s.external_terminal
                .filter(|v| KNOWN_EXTERNAL_TERMINALS.contains(&v.as_str()))
                .unwrap_or_else(|| "auto".to_string()),
        ),
        // 旧字段迁移：claude_hooks_attention=true 且新 map 无 claude-code 键 → 视为开
        hooks_attention: Some({
            let mut map = s.hooks_attention.unwrap_or_default();
            if s.claude_hooks_attention == Some(true) && !map.contains_key("claude-code") {
                map.insert("claude-code".to_string(), true);
            }
            map
        }),
        // 旧字段原样随行（不再写出，仅内存保留供迁移判断）
        claude_hooks_attention: s.claude_hooks_attention,
        hotkey_palette: s
            .hotkey_palette
            .or_else(|| Some(DEFAULT_HOTKEY_PALETTE.to_string())),
        hotkey_hide_chrome: s
            .hotkey_hide_chrome
            .or_else(|| Some(DEFAULT_HOTKEY_HIDE_CHROME.to_string())),
        hotkey_page_switch: s.hotkey_page_switch.or(Some(DEFAULT_HOTKEY_PAGE_SWITCH)),
        // 逐页绑定不做默认值填充：键缺失即「跟随默认」（同 ai_profiles 口径）
        hotkey_pages: s.hotkey_pages,
        discuss_readonly: s.discuss_readonly.or(Some(true)),
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
    if patch.notifications_enabled.is_some() {
        cur.notifications_enabled = patch.notifications_enabled;
    }
    if patch.theme.is_some() {
        cur.theme = patch.theme;
    }
    // 支持清空：传空字符串 → None（回到「自动=最近使用」）
    if patch.ai_profile_id.is_some() {
        cur.ai_profile_id = patch.ai_profile_id.filter(|v| !v.trim().is_empty());
    }
    // 按功能配置整图覆盖（前端每次提交完整 map；空 map = 全部跟随默认）
    if patch.start_page.is_some() {
        cur.start_page = patch.start_page;
    }
    if patch.hidden_profiles.is_some() {
        cur.hidden_profiles = patch.hidden_profiles;
    }
    if patch.default_profiles.is_some() {
        cur.default_profiles = patch.default_profiles;
    }
    if patch.ai_profiles.is_some() {
        cur.ai_profiles = patch.ai_profiles;
    }
    if patch.external_terminal.is_some() {
        cur.external_terminal = patch.external_terminal;
    }
    // 整图覆盖（同 ai_profiles 口径）；开/关走 hooks::set_hooks_attention 专用命令
    // （那边用 set_hooks_attention_entry 逐键读-改-写），勿单独 patch 本字段
    if patch.hooks_attention.is_some() {
        cur.hooks_attention = patch.hooks_attention;
    }
    // 旧字段 claude_hooks_attention 不再接受 patch（只读迁移用）
    // 快捷键：Some 即覆盖（含空串=禁用）；读侧 with_defaults 只填 None
    if patch.hotkey_palette.is_some() {
        cur.hotkey_palette = patch.hotkey_palette;
    }
    if patch.hotkey_hide_chrome.is_some() {
        cur.hotkey_hide_chrome = patch.hotkey_hide_chrome;
    }
    if patch.hotkey_page_switch.is_some() {
        cur.hotkey_page_switch = patch.hotkey_page_switch;
    }
    // 逐页绑定整图覆盖（前端每次提交完整 map）
    if patch.hotkey_pages.is_some() {
        cur.hotkey_pages = patch.hotkey_pages;
    }
    if patch.discuss_readonly.is_some() {
        cur.discuss_readonly = patch.discuss_readonly;
    }
}

// ===== 供其他模块读取的小入口（每次都从文件读，改动即时生效） =====

/// 删除 profile 时同步清掉设置里的引用（AI 专用 / 按功能绑定指到已删 id 会让
/// resolve_profile_from 的硬报错槽炸出来）。调用方须已持 profiles::store_lock
/// （profiles.delete 路径持锁内联调用，本函数不再加锁）；失败只记日志不否决删除
pub(crate) fn clear_profile_refs(id: &str) {
    let Ok(path) = settings_path() else { return };
    let mut cur = read_from(&path);
    let mut touched = false;
    if cur.ai_profile_id.as_deref() == Some(id) {
        cur.ai_profile_id = None;
        touched = true;
    }
    if let Some(map) = &mut cur.ai_profiles {
        let before = map.len();
        map.retain(|_, v| v != id);
        if map.len() != before {
            touched = true;
        }
        if map.is_empty() {
            cur.ai_profiles = None;
        }
    }
    if touched {
        if let Err(e) = write_to(&path, &cur) {
            crate::logbuf::record(
                "error",
                "settings",
                &format!("清理已删 profile 的设置引用失败: {e}"),
            );
        }
    }
}

pub(crate) fn read_current() -> AppSettingsDto {
    settings_path()
        .map(|p| read_from(&p))
        .unwrap_or_default()
}

pub(crate) fn current_with_defaults() -> AppSettingsDto {
    with_defaults(read_current())
}

pub(crate) fn brew_mirror_enabled() -> bool {
    read_current().brew_mirror.unwrap_or(DEFAULT_BREW_MIRROR)
}

pub(crate) fn rate_setting() -> Option<f64> {
    read_current().rate_usd_cny.filter(|r| *r > 0.0)
}

/// 精确注意力标记读取口径（含旧字段迁移）：新 map 有键以它为准；
/// 旧字段 claude_hooks_attention=true 且新 map 无 claude-code 键 → 视为开
pub(crate) fn hooks_attention_enabled(s: &AppSettingsDto, agent: &str) -> bool {
    if let Some(v) = s.hooks_attention.as_ref().and_then(|m| m.get(agent)) {
        return *v;
    }
    agent == "claude-code" && s.claude_hooks_attention == Some(true)
}

/// hooks::set_hooks_attention 专用：逐键读-改-写（持 profiles 锁防并发 patch 互相覆盖，
/// 与 update_settings 同一把锁），顺带把旧字段迁移进新 map
pub(crate) fn set_hooks_attention_entry(agent: &str, enabled: bool) -> Result<AppSettingsDto, String> {
    let _g = crate::profiles::store_lock();
    set_hooks_attention_entry_at(&settings_path()?, agent, enabled)
}

fn set_hooks_attention_entry_at(
    path: &Path,
    agent: &str,
    enabled: bool,
) -> Result<AppSettingsDto, String> {
    let mut cur = read_from(path);
    let mut map = cur.hooks_attention.unwrap_or_default();
    if cur.claude_hooks_attention == Some(true) && !map.contains_key("claude-code") {
        map.insert("claude-code".to_string(), true);
    }
    map.insert(agent.to_string(), enabled);
    cur.hooks_attention = Some(map);
    cur.claude_hooks_attention = None; // 已迁移，内存里也清掉（写出时本就不序列化）
    write_to(path, &cur)?;
    Ok(with_defaults(cur))
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn get_settings() -> AppSettingsDto {
    with_defaults(read_current())
}

#[tauri::command]
pub async fn update_settings(patch: AppSettingsDto) -> Result<AppSettingsDto, String> {
    // 与 profiles 共用同一把读-改-写锁，防并发 patch 互相覆盖；
    // 本函数持锁期间不再获取其他锁，与全局写入（GLOBAL_CONFIG_MUTEX 内不调 profiles）锁序一致
    let _g = crate::profiles::store_lock();
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
        assert_eq!(full.terminal_font_size, Some(14));
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

    #[test]
    fn ai_profiles_merge_overwrites_whole_map() {
        let p = tmp();
        let mut cur = read_from(&p);
        // 首次写入两个功能键
        let mut m = BTreeMap::new();
        m.insert("commit".to_string(), "p-1".to_string());
        m.insert("summarize".to_string(), "p-2".to_string());
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profiles: Some(m),
                ..Default::default()
            },
        );
        assert_eq!(cur.ai_profiles.as_ref().unwrap().len(), 2);
        // Some 即整图覆盖：改一键后整体提交，旧键按新 map 去留
        let mut m2 = BTreeMap::new();
        m2.insert("commit".to_string(), "p-3".to_string());
        merge(
            &mut cur,
            AppSettingsDto {
                ai_profiles: Some(m2),
                ..Default::default()
            },
        );
        let map = cur.ai_profiles.as_ref().unwrap();
        assert_eq!(map.get("commit").map(String::as_str), Some("p-3"));
        assert!(!map.contains_key("summarize"), "整图覆盖，未提交的键被删除");
        // patch 缺省（None）不动现有 map
        merge(&mut cur, AppSettingsDto::default());
        assert_eq!(cur.ai_profiles.as_ref().unwrap().len(), 1);
        // with_defaults 原样透传，不填默认
        let full = with_defaults(cur);
        assert_eq!(full.ai_profiles.as_ref().unwrap().len(), 1);
        assert_eq!(with_defaults(AppSettingsDto::default()).ai_profiles, None);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn hooks_attention_roundtrip_and_legacy_migration() {
        let p = tmp();
        // 缺省 → 空 map
        assert_eq!(
            with_defaults(read_from(&p)).hooks_attention,
            Some(BTreeMap::new())
        );
        // 整图 patch 写读往返
        let mut cur = read_from(&p);
        let mut m = BTreeMap::new();
        m.insert("claude-code".to_string(), true);
        m.insert("kimi".to_string(), false);
        merge(&mut cur, AppSettingsDto { hooks_attention: Some(m), ..Default::default() });
        write_to(&p, &cur).unwrap();
        let full = with_defaults(read_from(&p));
        let map = full.hooks_attention.unwrap();
        assert_eq!(map.get("claude-code"), Some(&true), "写读往返");
        assert_eq!(map.get("kimi"), Some(&false));
        // 写出不含旧字段
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("claudeHooksAttention"), "旧字段不再写出");
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn legacy_claude_hooks_attention_migrates_into_map() {
        let p = tmp();
        // 磁盘上只有旧字段 true → with_defaults 迁移为 map 里 claude-code=true
        std::fs::write(&p, r#"{"claudeHooksAttention": true}"#).unwrap();
        let full = with_defaults(read_from(&p));
        assert_eq!(
            full.hooks_attention.as_ref().unwrap().get("claude-code"),
            Some(&true),
            "旧字段 true 迁移进新 map"
        );
        // 读取口径：未迁移的原始 DTO 也认旧字段
        assert!(hooks_attention_enabled(&read_from(&p), "claude-code"));
        assert!(!hooks_attention_enabled(&read_from(&p), "kimi"));
        // 新 map 已有 claude-code 键时以新 map 为准（旧 true 不覆盖显式 false）
        std::fs::write(&p, r#"{"claudeHooksAttention": true, "hooksAttention": {"claude-code": false}}"#).unwrap();
        assert!(!hooks_attention_enabled(&read_from(&p), "claude-code"));
        // 专用写入：逐键读写 + 顺带迁移旧字段，写出后旧字段消失
        let full = set_hooks_attention_entry_at(&p, "qwen", true).unwrap();
        assert_eq!(full.hooks_attention.as_ref().unwrap().get("qwen"), Some(&true));
        let disk = std::fs::read_to_string(&p).unwrap();
        assert!(!disk.contains("claudeHooksAttention"), "旧字段随迁移从磁盘消失");
        let v: serde_json::Value = serde_json::from_str(&disk).unwrap();
        assert_eq!(v["hooksAttention"]["claude-code"], false, "迁移以新 map 为准");
        assert_eq!(v["hooksAttention"]["qwen"], true);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn discuss_readonly_defaults_true_and_roundtrips() {
        let p = tmp();
        // 缺省 → true（想法期只读保护默认开）
        assert_eq!(with_defaults(read_from(&p)).discuss_readonly, Some(true));
        let mut cur = read_from(&p);
        merge(
            &mut cur,
            AppSettingsDto { discuss_readonly: Some(false), ..Default::default() },
        );
        write_to(&p, &cur).unwrap();
        assert_eq!(with_defaults(read_from(&p)).discuss_readonly, Some(false), "写读往返");
        // 无关 patch 不动该字段
        let mut cur2 = read_from(&p);
        merge(&mut cur2, AppSettingsDto::default());
        assert_eq!(cur2.discuss_readonly, Some(false));
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }
}

/// 应用数据占用（设置页「数据与存储」）：用户此前完全不知道 Ccode 在硬盘上占了多少、存在哪。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntryDto {
    /// 展示名（app.db / 技能库 / 会话快照 …）
    pub label: String,
    /// 绝对路径（前端只展示与「打开目录」，不参与任何写操作）
    pub path: String,
    pub bytes: u64,
    pub exists: bool,
    /// 可清理（快照与备份是可再生/可丢的；profiles/keys/app.db 一律 false）
    pub clearable: bool,
}

/// 递归求目录大小；单个条目读失败按 0 计（宁可少算也不报错——这只是个信息展示）。
/// 有界：最多下钻 2000 个条目，异常巨大的目录返回已累计值，不卡住设置页。
fn dir_size(path: &std::path::Path, budget: &mut u32) -> u64 {
    if *budget == 0 {
        return 0;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        *budget = budget.saturating_sub(1);
        return meta.len();
    }
    // 符号链接不跟随（技能分发可能是 symlink，跟随会重复计入甚至成环）
    if meta.is_symlink() || !meta.is_dir() {
        return 0;
    }
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for e in rd.flatten() {
        if *budget == 0 {
            break;
        }
        total = total.saturating_add(dir_size(&e.path(), budget));
    }
    total
}

#[tauri::command]
pub async fn app_storage_usage() -> Result<Vec<StorageEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode");
        // (展示名, 相对名, 可清理)
        let items: [(&str, &str, bool); 6] = [
            ("会话索引与用量（app.db）", "app.db", false),
            ("配置（profiles.json）", "profiles.json", false),
            ("技能库", "skills", false),
            ("会话快照（pin 保留的）", "snapshots", true),
            ("配置改写备份", "backups", true),
            ("模型目录缓存", "catalogs", true),
        ];
        let mut out = Vec::new();
        for (label, rel, clearable) in items {
            let p = root.join(rel);
            let exists = p.exists();
            let mut budget = 20_000u32;
            out.push(StorageEntryDto {
                label: label.to_string(),
                path: p.to_string_lossy().to_string(),
                bytes: if exists { dir_size(&p, &mut budget) } else { 0 },
                exists,
                clearable,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("统计应用数据占用失败: {e}"))?
}
