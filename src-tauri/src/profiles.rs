use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "ccode";

/// 账号类型（P1a）：api = 端点+密钥注入；official = CLI 官方账号登录，
/// 拉起时不注入 API env 并按规格 purge 残留密钥变量。缺省 api 向后兼容旧 profiles.json
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccountType {
    #[default]
    Api,
    Official,
}

/// 请求级策略。这里仅保存“可安全复用的声明”，不会假设所有 Agent 都支持这些字段。
/// header_env 的 value 是环境变量名，不保存 Header 密文本体；真正的值在启动时由 CLI/网关读取。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestPolicy {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub header_env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub agent: String,
    pub name: String,
    /// 账号类型；旧数据无此字段按 api 处理
    #[serde(default)]
    pub account_type: AccountType,
    /// API profile explicitly allowed to run without a credential (normally a local endpoint).
    /// This is fail-closed by default; it is not the same as inheriting a shell credential.
    #[serde(default)]
    pub no_auth: bool,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    /// 可用模型列表，首个为默认；同一端点下通常有多个模型可切换
    #[serde(default)]
    pub models: Vec<String>,
    /// 附加环境变量，启动时注入且优先级高于 adapter 内置 env（供覆盖）
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    /// 请求策略声明；是否实际生效由 Agent/协议能力表决定。
    #[serde(default)]
    pub request_policy: RequestPolicy,
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
    #[serde(default)]
    pub account_type: AccountType,
    #[serde(default)]
    pub no_auth: bool,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub request_policy: RequestPolicy,
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

fn sensitive_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"]
        .iter()
        .any(|part| upper.contains(part))
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

    /// 只读场景的构造（config_dump 自省快照）：配置目录不存在返回 None，
    /// 不像 new() 那样建目录——只读路径不得有写副作用
    pub(crate) fn existing() -> Option<Self> {
        let dir = dirs::config_dir()?.join("ccode");
        dir.is_dir().then(|| Self {
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
        atomic_write(&self.path, &text)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("设置 profiles.json 权限失败: {e}"))?;
        }
        Ok(())
    }

    /// list 的锁内版本：调用方须已持 store_lock
    fn list_locked(&self) -> Result<Vec<Profile>, String> {
        let mut profiles = self.read_all()?;
        for p in &mut profiles {
            // 旧版单模型字段迁移进列表
            if p.models.is_empty() {
                if let Some(m) = p.model.take() {
                    p.models = vec![m];
                }
            }
            // keys.json 损坏时向上报错，不能把全部 profile 谎报成「无密钥」
            p.has_key = has_key_locked(&p.id)?;
        }
        Ok(profiles)
    }

    pub fn list(&self) -> Result<Vec<Profile>, String> {
        let _g = store_lock();
        self.list_locked()
    }

    pub fn get(&self, id: &str) -> Result<Profile, String> {
        self.list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))
    }

    /// get 的锁内版本：调用方须已持 store_lock
    fn get_locked(&self, id: &str) -> Result<Profile, String> {
        self.list_locked()?
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
            account_type: input.account_type,
            no_auth: input.no_auth,
            protocol: input.protocol,
            base_url: input.base_url.filter(|s| !s.is_empty()),
            models: normalize_models(input.models),
            extra_env: input.extra_env,
            request_policy: input.request_policy,
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
        };
        if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
            set_key(&profile.id, &key)?;
            profile.key_hint = Some(key_hint_of(&key));
            profile.has_key = true;
        }
        if let Err(error) = crate::profile_validation::validate_profile_fields(&profile) {
            delete_key(&profile.id);
            return Err(error);
        }
        let mut profiles = self.read_all()?;
        profiles.push(profile.clone());
        self.write_all(&profiles)?;
        Ok(profile)
    }

    /// 复制配置：字段全部拷贝，钥匙串密钥一并复制到新 id，名称加「副本」
    pub fn duplicate(&self, id: &str) -> Result<Profile, String> {
        let _g = store_lock();
        let src = self.get_locked(id)?;
        let mut copy = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            agent: src.agent,
            name: format!("{} 副本", src.name),
            account_type: src.account_type,
            no_auth: src.no_auth,
            protocol: src.protocol,
            base_url: src.base_url,
            models: src.models,
            extra_env: src.extra_env,
            request_policy: src.request_policy,
            key_hint: src.key_hint,
            model: None,
            last_used_at: None,
            has_key: false,
        };
        if let Some(key) = get_key_locked(id)? {
            set_key(&copy.id, &key)?;
            copy.has_key = true;
        }
        if let Err(error) = crate::profile_validation::validate_profile_fields(&copy) {
            delete_key(&copy.id);
            return Err(error);
        }
        let mut profiles = self.read_all()?;
        profiles.push(copy.clone());
        self.write_all(&profiles)?;
        Ok(copy)
    }

    /// 复制配置到其他 agent（#14）：密钥在本进程内从 keys.json 直读直写（0600 文件内操作，
    /// 密钥不出站、不经前端）；名称在目标 agent 内防重名（重名追加 -2/-3…）；
    /// 目标 agent 必须与源同协议族，多协议目标取与源同族的协议取值
    pub fn copy_to_agent(&self, id: &str, target_agent: &str) -> Result<Profile, String> {
        let _g = store_lock();
        let src = self.get_locked(id)?;
        if target_agent == src.agent {
            return Err("目标与来源是同一个 agent，请用「复制配置」".into());
        }
        let protocol = pick_copy_protocol(&src, target_agent)?;
        let profiles = self.read_all()?;
        let name = copy_name(
            &profiles
                .iter()
                .filter(|p| p.agent == target_agent)
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            &src.name,
        );
        let mut copy = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            agent: target_agent.to_string(),
            name,
            account_type: src.account_type,
            no_auth: src.no_auth,
            protocol,
            base_url: src.base_url,
            models: src.models,
            extra_env: src.extra_env,
            request_policy: src.request_policy,
            key_hint: src.key_hint,
            model: None,
            last_used_at: None,
            has_key: false,
        };
        if let Some(key) = get_key_locked(id)? {
            set_key(&copy.id, &key)?;
            copy.has_key = true;
        }
        if let Err(error) = crate::profile_validation::validate_profile_fields(&copy) {
            delete_key(&copy.id);
            return Err(error);
        }
        let mut profiles = profiles;
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
        if profile.agent != input.agent {
            return Err("连接创建后不能直接更换 Agent，请使用「复制到其他 Agent」".into());
        }
        let mut candidate = profile.clone();
        candidate.name = input.name.clone();
        candidate.account_type = input.account_type;
        candidate.no_auth = input.no_auth;
        candidate.protocol = input.protocol.clone();
        candidate.base_url = input.base_url.clone().filter(|s| !s.trim().is_empty());
        candidate.models = normalize_models(input.models.clone());
        candidate.extra_env = input.extra_env.clone();
        candidate.request_policy = input.request_policy.clone();
        candidate.has_key = input.api_key.as_deref().is_some_and(|k| !k.trim().is_empty())
            || get_key_locked(id)?.is_some();
        crate::profile_validation::validate_profile_fields(&candidate)?;
        if candidate.account_type == AccountType::Official && candidate.no_auth {
            return Err("官方账号不能设置为无密钥模式".into());
        }
        profile.agent = input.agent;
        profile.name = input.name;
        profile.account_type = input.account_type;
        profile.no_auth = input.no_auth;
        profile.protocol = input.protocol;
        profile.base_url = input.base_url.filter(|s| !s.is_empty());
        profile.models = normalize_models(input.models);
        profile.model = None;
        profile.extra_env = input.extra_env;
        profile.request_policy = input.request_policy;
        if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
            set_key(id, &key)?;
            profile.key_hint = Some(key_hint_of(&key));
        } else if profile.account_type == AccountType::Official {
            delete_key(id);
            profile.key_hint = None;
        } else if profile.no_auth {
            delete_key(id);
            profile.key_hint = None;
        }
        profile.has_key = get_key_locked(id)?.is_some();
        crate::profile_validation::validate_profile_fields(profile)?;
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
        // 同步清掉设置里的引用（AI 专用/按功能绑定指到已删 id 会让解析链硬报错）；
        // 持锁内联调用，失败只记日志不否决删除
        crate::settings::clear_profile_refs(id);
        Ok(())
    }

    pub fn clear_key(&self, id: &str) -> Result<(), String> {
        let _g = store_lock();
        let mut profiles = self.read_all()?;
        let profile = profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        delete_key(id);
        profile.key_hint = None;
        profile.has_key = false;
        self.write_all(&profiles)
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

/// 目标 agent 内不重名的副本名（copy_to_agent 用）：原名未被占用则沿用，否则追加 -2/-3…
fn copy_name(existing: &[&str], base: &str) -> String {
    if !existing.contains(&base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !existing.contains(&candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

/// 复制到其他 agent 的协议取值（copy_to_agent 用）：目标无协议概念时用固有协议族判定；
/// 多协议目标优先保留源协议取值，其次取首个与源同族的候选；不同协议族报错拒绝
fn pick_copy_protocol(src: &Profile, target_agent: &str) -> Result<Option<String>, String> {
    let spec = crate::agent_specs::agent_spec(target_agent)
        .ok_or_else(|| format!("未知 agent: {target_agent}"))?;
    let kind = crate::profile_validation::api_kind_label(&src.agent, src.protocol.as_deref());
    if spec.protocols.is_empty() {
        if crate::profile_validation::api_kind_label(target_agent, None) == kind {
            return Ok(None);
        }
    } else {
        // find 的谓词收到的是条目的引用（&&&str），逐层解引用到 &str
        let matched = |p: &&&'static str| {
            crate::profile_validation::api_kind_label(target_agent, Some(**p)) == kind
        };
        if let Some(p) = spec
            .protocols
            .iter()
            .find(|p| matched(p) && Some(**p) == src.protocol.as_deref())
            .or_else(|| spec.protocols.iter().find(matched))
        {
            return Ok(Some((*p).to_string()));
        }
    }
    let src_name = crate::agent_specs::agent_spec(&src.agent)
        .map(|s| s.display_name)
        .unwrap_or(&src.agent);
    Err(format!(
        "协议不兼容：{} 的配置（{kind} 协议）不能复制到 {}",
        src_name, spec.display_name
    ))
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

/// 读取 keys.json：文件缺失视为空表；解析失败说明文件损坏——改名备份为
/// keys.json.corrupt-<ts> 并返回错误，绝不当作空表继续（否则下次写回会静默清空其余密钥）
fn read_keys_at(
    path: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| {
        let backup = corrupt_backup_path(path);
        let _ = fs::rename(path, &backup);
        format!("keys.json 已损坏，已备份为 {}: {e}", backup.display())
    })
}

/// 损坏文件备份名：keys.json.corrupt-<unix 秒>（不用 ISO 时间，冒号在 Windows 文件名非法）
fn corrupt_backup_path(path: &std::path::Path) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".corrupt-{ts}"));
    PathBuf::from(name)
}

fn write_keys_at(
    path: &std::path::Path,
    keys: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    // 崩溃残留的 keys.tmp 可能带着半截密钥与宽松权限，先清掉
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("清理 {} 失败: {e}", tmp.display())),
    }
    fs::write(&tmp, &text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        // rename 前先把权限收窄到 0600，消除新文件以默认 0644 短暂暴露密钥的窗口；
        // Windows 无 0600 语义，文件权限由配置目录 ACL 控制，无需对应分支
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 {} 权限失败: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃留下半截 JSON（借鉴 CC Switch）。
/// iCloud 等同步目录里新落盘的 tmp 偶发被同步代理瞬时介入，rename 吃 ENOENT——
/// 短暂退避后重试一次（父目录真不存在时第二次照样失败，语义不变）
pub(crate) fn atomic_write(path: &std::path::Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::thread::sleep(std::time::Duration::from_millis(50));
            fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
        }
        Err(e) => Err(format!("替换 {} 失败: {e}", path.display())),
    }
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

/// 写入密钥；调用方须已持 store_lock（create/update/duplicate 均持锁调用，本函数不再重复加锁）
fn set_key(id: &str, key: &str) -> Result<(), String> {
    let path = keys_path()?;
    let mut keys = read_keys_at(&path)?;
    keys.insert(id.to_string(), key.to_string());
    write_keys_at(&path, &keys)
}

/// get_key 的锁内版本：调用方须已持 store_lock
fn get_key_locked(id: &str) -> Result<Option<String>, String> {
    let path = keys_path()?;
    let keys = read_keys_at(&path)?;
    if let Some(k) = keys.get(id) {
        return Ok(Some(k.clone()));
    }
    // 一次性迁移：旧版本写入钥匙串的条目读回文件（回写在锁内进行，防并发丢更新）
    let Some(key) = key_entry(id).ok().and_then(|e| e.get_password().ok()) else {
        return Ok(None);
    };
    let mut keys = keys;
    keys.insert(id.to_string(), key.clone());
    let _ = write_keys_at(&path, &keys);
    Ok(Some(key))
}

/// 读取密钥；keys.json 损坏时返回错误而非谎报「无密钥」
pub fn get_key(id: &str) -> Result<Option<String>, String> {
    let _g = store_lock();
    get_key_locked(id)
}

/// 仅供后端展示脱敏使用；调用方不得把返回值序列化给前端或写入日志。
/// 阈值 ≥8 的取舍：更短的「密钥」与普通单词/标识符碰撞率高，全文替换脱敏会误伤会话正文；
/// 漏遮极短密钥的风险低于破坏全部回放文本，故不收录（如确需覆盖短密钥，降到 6 是下限）。
/// keys.json 损坏时按空表尽力脱敏：损坏文件已被 read_keys_at 改名备份，
/// 读写主路径会向用户报错，这里不阻断会话浏览。
pub(crate) fn stored_secrets() -> Vec<String> {
    let Ok(path) = keys_path() else {
        return Vec::new();
    };
    read_keys_at(&path)
        .unwrap_or_default()
        .into_values()
        .filter(|v| v.chars().count() >= 8)
        .collect()
}

/// has_key 的锁内版本：调用方须已持 store_lock
fn has_key_locked(id: &str) -> Result<bool, String> {
    Ok(get_key_locked(id)?.is_some())
}

/// 删除密钥；调用方须已持 store_lock（delete 持锁调用）；损坏文件上的清理尽力而为
fn delete_key(id: &str) {
    if let Ok(path) = keys_path() {
        if let Ok(mut keys) = read_keys_at(&path) {
            if keys.remove(id).is_some() {
                let _ = write_keys_at(&path, &keys);
            }
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
pub fn clear_profile_key(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.clear_key(&id)
}

#[tauri::command]
pub fn duplicate_profile(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<Profile, String> {
    store.duplicate(&id)
}

/// 复制配置到其他 agent（#14）：密钥在后端 0600 文件内直读直写，不经前端
#[tauri::command]
pub fn copy_profile_to_agent(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
    target_agent: String,
) -> Result<Profile, String> {
    store.copy_to_agent(&profile_id, &target_agent)
}

/// 导出全部 profile 到指定路径；密钥本体与尾号一律不导出
#[tauri::command]
pub fn export_profiles(store: tauri::State<'_, ProfileStore>, path: String) -> Result<(), String> {
    let mut profiles = store.list()?;
    for p in &mut profiles {
        p.has_key = false;
        p.key_hint = None;
        p.extra_env.retain(|name, _| !sensitive_env_name(name));
    }
    let text = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    atomic_write(std::path::Path::new(&path), &text)
}

/// 从指定路径导入 profile：id 冲突换发新 id；(agent, name, base_url) 完全相同的跳过；
/// 密钥不包含在文件里，导入后需逐个补填。返回新增数量。
#[tauri::command]
pub fn import_profiles(store: tauri::State<'_, ProfileStore>, path: String) -> Result<usize, String> {
    // 读-改-写全程持锁，与 create/update 互斥，防并发保存互相覆盖
    let _g = store_lock();
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
        p.no_auth = p.no_auth && p.account_type == AccountType::Api;
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
        let loaded = read_keys_at(&path).unwrap();
        assert_eq!(loaded.get("p1").map(|s| s.as_str()), Some("sk-secret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_keys_file_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("keys.json");
        let loaded = read_keys_at(&path).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn corrupt_keys_file_is_backed_up_and_errors() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        std::fs::write(&path, "{ 不是合法 json").unwrap();

        let err = read_keys_at(&path).unwrap_err();
        assert!(err.contains("已损坏"), "报错须说明损坏: {err}");
        assert!(!path.exists(), "原损坏文件应已改名备份");
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("keys.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "应生成唯一 corrupt 备份: {backups:?}");
        // 损坏内容完整保留在备份里，可被人工恢复
        let kept = std::fs::read_to_string(dir.join(&backups[0])).unwrap();
        assert_eq!(kept, "{ 不是合法 json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_keys_cleans_stale_tmp_before_rename() {
        let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keys.json");
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, "崩溃残留").unwrap();

        let mut keys = std::collections::HashMap::new();
        keys.insert("p1".to_string(), "sk-secret".to_string());
        write_keys_at(&path, &keys).unwrap();

        assert!(!tmp.exists(), "写入后不得残留 keys.tmp");
        let loaded = read_keys_at(&path).unwrap();
        assert_eq!(loaded.get("p1").map(|s| s.as_str()), Some("sk-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "rename 后即 0600，无 0644 暴露窗口");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn key_hint_masks_short_keys() {
        assert_eq!(key_hint_of("sk-1234567"), "···4567");
        assert_eq!(key_hint_of("abc"), "····");
    }

    #[test]
    fn copy_name_dedups_within_target_agent() {
        assert_eq!(copy_name(&[], "中转 A"), "中转 A");
        assert_eq!(copy_name(&["中转 A"], "中转 A"), "中转 A-2");
        assert_eq!(copy_name(&["中转 A", "中转 A-2"], "中转 A"), "中转 A-3");
    }

    #[test]
    fn pick_copy_protocol_matches_api_kind() {
        let src = |agent: &str, protocol: Option<&str>| Profile {
            id: "x".into(),
            agent: agent.into(),
            name: "n".into(),
            account_type: AccountType::Api,
            no_auth: false,
            protocol: protocol.map(str::to_string),
            base_url: None,
            models: vec![],
            extra_env: Default::default(),
            request_policy: RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
        };
        // 同族可行：anthropic → qwen 取 anthropic；openai 源保留源协议取值
        assert_eq!(
            pick_copy_protocol(&src("claude-code", None), "qwen").unwrap(),
            Some("anthropic".to_string())
        );
        assert_eq!(
            pick_copy_protocol(&src("kimi", Some("openai")), "qwen").unwrap(),
            Some("openai".to_string())
        );
        // 无协议概念的同族目标：协议清为 None
        assert_eq!(pick_copy_protocol(&src("qwen", Some("anthropic")), "codebuddy").unwrap(), None);
        // grok 归 openai 族（xAI 官方 API 是 OpenAI chat_completions 兼容），无协议概念目标协议清 None
        assert_eq!(pick_copy_protocol(&src("codex", None), "grok").unwrap(), None);
        assert!(pick_copy_protocol(&src("claude-code", None), "grok").is_err(), "anthropic → grok 不同族应拒绝");
        // 不同族拒绝：anthropic → codex/gemini；cursor 专有协议与谁都不互通
        assert!(pick_copy_protocol(&src("claude-code", None), "codex").is_err());
        assert!(pick_copy_protocol(&src("codex", None), "gemini").is_err());
        assert!(pick_copy_protocol(&src("codex", None), "cursor").is_err());
        assert!(pick_copy_protocol(&src("cursor", None), "codex").is_err());
        // 未知目标报错
        assert!(pick_copy_protocol(&src("codex", None), "not-an-agent").is_err());
    }

    #[test]
    fn profile_without_account_type_defaults_to_api() {
        // 旧 profiles.json 无 accountType 字段 → api（向后兼容）
        let old = r#"{"id":"1","agent":"codex","name":"n","protocol":null,"baseUrl":null,"models":[],"extraEnv":{},"hasKey":false}"#;
        let p: Profile = serde_json::from_str(old).unwrap();
        assert_eq!(p.account_type, AccountType::Api);
        // 显式 official 往返
        let new = r#"{"id":"1","agent":"codex","name":"n","accountType":"official","protocol":null,"baseUrl":null,"models":[],"extraEnv":{},"hasKey":false}"#;
        let p: Profile = serde_json::from_str(new).unwrap();
        assert_eq!(p.account_type, AccountType::Official);
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.contains("\"accountType\":\"official\""));
        // api 序列化为 "api"（导出/导入兼容）
        let p = Profile { account_type: AccountType::Api, ..p };
        assert!(serde_json::to_string(&p).unwrap().contains("\"accountType\":\"api\""));
    }

    #[test]
    fn profile_without_request_policy_defaults_to_empty_policy() {
        let old = r#"{"id":"1","agent":"codex","name":"n","accountType":"api","protocol":null,"baseUrl":null,"models":[],"extraEnv":{},"hasKey":false}"#;
        let p: Profile = serde_json::from_str(old).unwrap();
        assert_eq!(p.request_policy, RequestPolicy::default());

        let mut p = p;
        p.request_policy.header_env.insert("X-Relay-Key".into(), "RELAY_KEY".into());
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.contains("requestPolicy"));
        assert!(text.contains("RELAY_KEY"));
        assert!(!text.contains("sk-secret"));
    }
}
