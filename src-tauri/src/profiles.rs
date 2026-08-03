use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "ccode";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    /// 可用模型列表，首个为默认；同一端点下通常有多个模型可切换
    #[serde(default)]
    pub models: Vec<String>,
    /// 附加环境变量，启动时注入且优先级高于 adapter 内置 env（供覆盖）
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    /// 密钥尾号提示（如 "···abc1"），仅用于界面区分多个 key，非敏感信息
    #[serde(default)]
    pub key_hint: Option<String>,
    /// 旧版单模型字段，仅用于读取时迁移，写回后即消失；不作为业务字段使用
    #[serde(default, skip_serializing)]
    pub model: Option<String>,
    /// 上次用于启动的时间（ISO），配置页据此识别活跃/闲置配置（§6.12 E）
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// 密钥本体在系统钥匙串里，这里只反映「钥匙串中是否存在」
    pub has_key: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub agent: String,
    pub name: String,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    /// 明文密钥，写入钥匙串后丢弃；空 / None 表示不设置或不修改
    pub api_key: Option<String>,
}

/// 取密钥尾号做界面提示，过短的 key 整体打码
fn key_hint_of(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    if key.chars().count() > 4 {
        format!("···{tail}")
    } else {
        "····".into()
    }
}

/// 清洗模型列表：去空白、去空串、去重保序
fn normalize_models(models: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    models
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .filter(|m| seen.insert(m.clone()))
        .collect()
}

pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new() -> Result<Self, String> {
        let dir = dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode");
        fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
        Ok(Self {
            path: dir.join("profiles.json"),
        })
    }

    fn read_all(&self) -> Result<Vec<Profile>, String> {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("解析 profiles.json 失败: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("读取 profiles.json 失败: {e}")),
        }
    }

    fn write_all(&self, profiles: &[Profile]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
        atomic_write(&self.path, &text)
    }

    pub fn list(&self) -> Result<Vec<Profile>, String> {
        let mut profiles = self.read_all()?;
        for p in &mut profiles {
            // 旧版单模型字段迁移进列表
            if p.models.is_empty() {
                if let Some(m) = p.model.take() {
                    p.models = vec![m];
                }
            }
            p.has_key = has_key(&p.id);
        }
        Ok(profiles)
    }

    pub fn get(&self, id: &str) -> Result<Profile, String> {
        self.list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))
    }

    pub fn create(&self, input: ProfileInput) -> Result<Profile, String> {
        let _g = store_lock();
        let mut profile = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            agent: input.agent,
            name: input.name,
            protocol: input.protocol,
            base_url: input.base_url.filter(|s| !s.is_empty()),
            models: normalize_models(input.models),
            extra_env: input.extra_env,
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
        };
        if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
            set_key(&profile.id, &key)?;
            profile.key_hint = Some(key_hint_of(&key));
        }
        let mut profiles = self.read_all()?;
        profiles.push(profile.clone());
        self.write_all(&profiles)?;
        Ok(profile)
    }

    /// 复制配置：字段全部拷贝，钥匙串密钥一并复制到新 id，名称加「副本」
    pub fn duplicate(&self, id: &str) -> Result<Profile, String> {
        let _g = store_lock();
        let src = self.get(id)?;
        let mut copy = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            agent: src.agent,
            name: format!("{} 副本", src.name),
            protocol: src.protocol,
            base_url: src.base_url,
            models: src.models,
            extra_env: src.extra_env,
            key_hint: src.key_hint,
            model: None,
            last_used_at: None,
            has_key: false,
        };
        if let Some(key) = get_key(id) {
            set_key(&copy.id, &key)?;
            copy.has_key = true;
        }
        let mut profiles = self.read_all()?;
        profiles.push(copy.clone());
        self.write_all(&profiles)?;
        Ok(copy)
    }

    pub fn update(&self, id: &str, input: ProfileInput) -> Result<Profile, String> {
        let _g = store_lock();
        let mut profiles = self.read_all()?;
        let profile = profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        profile.agent = input.agent;
        profile.name = input.name;
        profile.protocol = input.protocol;
        profile.base_url = input.base_url.filter(|s| !s.is_empty());
        profile.models = normalize_models(input.models);
        profile.model = None;
        profile.extra_env = input.extra_env;
        if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
            set_key(id, &key)?;
            profile.key_hint = Some(key_hint_of(&key));
        }
        let updated = profile.clone();
        self.write_all(&profiles)?;
        Ok(updated)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _g = store_lock();
        let mut profiles = self.read_all()?;
        profiles.retain(|p| p.id != id);
        self.write_all(&profiles)?;
        delete_key(id);
        Ok(())
    }

    /// 每次用于启动即刷新 last_used_at（§6.12 E）；失败静默，不影响启动
    pub fn touch_last_used(&self, id: &str) {
        let _g = store_lock();
        let _ = (|| -> Result<(), String> {
            let mut profiles = self.read_all()?;
            if let Some(p) = profiles.iter_mut().find(|p| p.id == id) {
                p.last_used_at = Some(crate::sessions::now_iso());
                self.write_all(&profiles)?;
            }
            Ok(())
        })();
    }
}

// ===== 密钥存储：0600 权限的 keys.json =====
// 不直接用 macOS 钥匙串的原因：未签名的开发构建每次热重编译都会产生新 cdhash，
// 钥匙串 ACL 随之失配，旧条目表现为"密钥消失"。0600 文件与 Codex auth.json、
// Claude Code 在 Linux 的 .credentials.json 是同一威胁模型，行为确定。
// 读取时仍会从钥匙串做一次性迁移，兼容旧版本写入的条目。

fn keys_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("keys.json"))
}

fn read_keys_at(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_keys_at(
    path: &std::path::Path,
    keys: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    atomic_write(path, &text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 keys.json 权限失败: {e}"))?;
    }
    Ok(())
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃留下半截 JSON（借鉴 CC Switch）
pub(crate) fn atomic_write(path: &std::path::Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
}

/// profiles.json / keys.json 的读-改-写序列化锁：多标签页并发保存时防互相覆盖
/// （原子写只保证单文件不碎，不保证 A读-B读-A写-B写 的丢失更新）
static STORE_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn store_lock() -> std::sync::MutexGuard<'static, ()> {
    STORE_MUTEX.lock().unwrap_or_else(|e| e.into_inner())
}

fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| format!("钥匙串不可用: {e}"))
}

fn set_key(id: &str, key: &str) -> Result<(), String> {
    let _g = store_lock();
    let path = keys_path()?;
    let mut keys = read_keys_at(&path);
    keys.insert(id.to_string(), key.to_string());
    write_keys_at(&path, &keys)
}

pub fn get_key(id: &str) -> Option<String> {
    let path = keys_path().ok()?;
    let keys = read_keys_at(&path);
    if let Some(k) = keys.get(id) {
        return Some(k.clone());
    }
    // 一次性迁移：旧版本写入钥匙串的条目读回文件
    let key = key_entry(id).ok()?.get_password().ok()?;
    let mut keys = keys;
    keys.insert(id.to_string(), key.clone());
    let _ = write_keys_at(&path, &keys);
    Some(key)
}

fn has_key(id: &str) -> bool {
    get_key(id).is_some()
}

fn delete_key(id: &str) {
    if let Ok(path) = keys_path() {
        let mut keys = read_keys_at(&path);
        if keys.remove(id).is_some() {
            let _ = write_keys_at(&path, &keys);
        }
    }
    // 顺带清理旧版本可能残留在钥匙串里的条目
    if let Ok(entry) = key_entry(id) {
        let _ = entry.delete_credential();
    }
}

#[tauri::command]
pub fn list_profiles(store: tauri::State<'_, ProfileStore>) -> Result<Vec<Profile>, String> {
    store.list()
}

#[tauri::command]
pub fn create_profile(
    store: tauri::State<'_, ProfileStore>,
    input: ProfileInput,
) -> Result<Profile, String> {
    store.create(input)
}

#[tauri::command]
pub fn update_profile(
    store: tauri::State<'_, ProfileStore>,
    id: String,
    input: ProfileInput,
) -> Result<Profile, String> {
    store.update(&id, input)
}

#[tauri::command]
pub fn delete_profile(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.delete(&id)
}

#[tauri::command]
pub fn duplicate_profile(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<Profile, String> {
    store.duplicate(&id)
}

/// 导出全部 profile 到指定路径；密钥本体与尾号一律不导出
#[tauri::command]
pub fn export_profiles(store: tauri::State<'_, ProfileStore>, path: String) -> Result<(), String> {
    let mut profiles = store.list()?;
    for p in &mut profiles {
        p.has_key = false;
        p.key_hint = None;
    }
    let text = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    atomic_write(std::path::Path::new(&path), &text)
}

/// 从指定路径导入 profile：id 冲突换发新 id；(agent, name, base_url) 完全相同的跳过；
/// 密钥不包含在文件里，导入后需逐个补填。返回新增数量。
#[tauri::command]
pub fn import_profiles(store: tauri::State<'_, ProfileStore>, path: String) -> Result<usize, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败: {e}"))?;
    let incoming: Vec<Profile> =
        serde_json::from_str(&text).map_err(|e| format!("导入文件格式不正确: {e}"))?;
    let mut profiles = store.read_all()?;
    let mut added = 0;
    for mut p in incoming {
        let dup = profiles.iter().any(|q| {
            q.agent == p.agent && q.name == p.name && q.base_url == p.base_url
        });
        if dup {
            continue;
        }
        if p.id.is_empty() || profiles.iter().any(|q| q.id == p.id) {
            p.id = uuid::Uuid::new_v4().to_string();
        }
        p.has_key = false;
        p.key_hint = None;
        p.model = None;
        profiles.push(p);
        added += 1;
    }
    store.write_all(&profiles)?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_file_roundtrip_with_0600_perms() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        let mut keys = std::collections::HashMap::new();
        keys.insert("p1".to_string(), "sk-secret".to_string());
        write_keys_at(&path, &keys).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let loaded = read_keys_at(&path);
        assert_eq!(loaded.get("p1").map(|s| s.as_str()), Some("sk-secret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn key_hint_masks_short_keys() {
        assert_eq!(key_hint_of("sk-1234567"), "···4567");
        assert_eq!(key_hint_of("abc"), "····");
    }
}
