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
    /// Grok 专用：API 后端（绑定级，仅设为全局写入消费；其余 agent 不消费）
    #[serde(default)]
    pub api_backend: Option<String>,
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
    /// 密钥本体在 0600 keys.json，这里只反映是否已存
    pub has_key: bool,
    /// 所属网关；官方账号绑定为 None。物化视图字段，旧 profiles.json 无此键。
    #[serde(default)]
    pub gateway_id: Option<String>,
    /// 该 Agent 所需协议槽未填
    #[serde(default)]
    pub slot_missing: bool,
    /// 仅启动瞬间现算：按会话 meta.provider 对齐 rollout 名字，不落盘。
    #[serde(default, skip_serializing)]
    pub provider_override: Option<String>,
}

impl Profile {
    pub fn provider_name(&self) -> String {
        if let Some(p) = &self.provider_override {
            return p.clone();
        }
        match &self.gateway_id {
            Some(gid) => crate::provider_id::provider_id(gid),
            None => crate::provider_id::LEGACY.to_string(),
        }
    }

    /// 恢复会话时按 rollout 记下的 provider 现算注入名。
    /// `ccode` → 注 LEGACY；`ccode-<短id>` → 注该派生名；其它/空 → 用网关派生。
    pub fn apply_session_provider(&mut self, session_provider: Option<&str>) {
        let Some(p) = session_provider.map(str::trim).filter(|s| !s.is_empty()) else {
            self.provider_override = None;
            return;
        };
        if crate::provider_id::is_ccode_provider(p) {
            self.provider_override = Some(p.to_string());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BindingKind {
    #[default]
    Api,
    Official,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    #[default]
    Never,
    Passed,
    Failed,
}

impl ProbeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeStatus::Never => "never",
            ProbeStatus::Passed => "passed",
            ProbeStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProtocolSlots {
    pub anthropic: Option<String>,
    pub openai: Option<String>,
    pub responses: Option<String>,
    pub gemini: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayModel {
    pub id: String,
    pub source: String,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRecord {
    pub slot: String,
    pub model: Option<String>,
    pub url_fp: String,
    pub key_fp: String,
    pub streaming: ProbeStatus,
    pub effort: ProbeStatus,
    pub headers: ProbeStatus,
    pub basic: ProbeStatus,
    pub probed_at: String,
    /// 基础请求延迟；旧记录无此键。
    #[serde(default)]
    pub latency_ms: Option<u64>,
}

/// 每槽体检摘要（list 时现算，不落盘）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlotProbeSummary {
    pub slot: String,
    pub last_latency_ms: Option<u64>,
    pub last_probe_at: Option<String>,
    pub last_ok: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gateway {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub no_auth: bool,
    #[serde(default)]
    pub key_hint: Option<String>,
    #[serde(default)]
    pub slots: ProtocolSlots,
    #[serde(default)]
    pub header_env: BTreeMap<String, String>,
    #[serde(default)]
    pub models: Vec<GatewayModel>,
    #[serde(default)]
    pub catalog_fetched_at: Option<String>,
    #[serde(default)]
    pub catalog_from_slot: Option<String>,
    #[serde(default)]
    pub last_probe: Vec<ProbeRecord>,
    /// list 现算，不落盘
    #[serde(default, skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub slot_probes: Vec<SlotProbeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub agent: String,
    #[serde(default)]
    pub kind: BindingKind,
    #[serde(default)]
    pub gateway_id: Option<String>,
    pub protocol: Option<String>,
    /// Grok 专用：API 后端（chat_completions/responses/messages），仅「设为全局默认」
    /// 写 [model.*] 段时消费；启动注入够不到（overlay 白名单不含 [model.*]）
    #[serde(default)]
    pub api_backend: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInput {
    pub name: String,
    #[serde(default)]
    pub no_auth: bool,
    pub slots: ProtocolSlots,
    #[serde(default)]
    pub header_env: BTreeMap<String, String>,
    #[serde(default)]
    pub models: Vec<GatewayModel>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingInput {
    pub agent: String,
    pub gateway_id: Option<String>,
    #[serde(default)]
    pub kind: BindingKind,
    pub protocol: Option<String>,
    #[serde(default)]
    pub api_backend: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
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
    #[serde(default)]
    pub api_backend: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub extra_env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub request_policy: RequestPolicy,
    /// 明文密钥，写入 keys.json 后丢弃；空 / None 表示不设置或不修改
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

pub(crate) fn sensitive_env_name(name: &str) -> bool {
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

    fn read_legacy_profiles(&self) -> Result<Vec<Profile>, String> {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("解析 profiles.json 失败: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("读取 profiles.json 失败: {e}")),
        }
    }

    /// 首次把 profiles.json 拆成 gateways.json + bindings.json。调用方须已持 store_lock。
    pub(crate) fn ensure_split_locked(&self) -> Result<(), String> {
        if crate::gateway_store::split_migrated() {
            return Ok(());
        }
        let old = self.read_legacy_profiles()?;
        if old.is_empty() && !self.path.exists() {
            crate::gateway_store::save_gateways(&[])?;
            crate::gateway_store::save_bindings(&[])?;
            return Ok(());
        }
        let keys_file = keys_path()?;
        let mut old_keys = read_keys_at(&keys_file)?;
        for p in &old {
            if old_keys.contains_key(&p.id) {
                continue;
            }
            if let Some(k) = key_entry(&p.id)
                .ok()
                .and_then(|e| e.get_password().ok())
                .filter(|s| !s.is_empty())
            {
                old_keys.insert(p.id.clone(), k);
            }
        }
        let result = crate::gateway_store::migrate_from_profiles(old, old_keys);
        backup_split_sidecars(&self.path, &keys_file);
        crate::gateway_store::save_gateways(&result.gateways)?;
        crate::gateway_store::save_bindings(&result.bindings)?;
        write_keys_at(&keys_file, &result.keys)?;
        if !result.journal.entries.is_empty() {
            let text = serde_json::to_string_pretty(&result.journal).map_err(|e| e.to_string())?;
            atomic_write(&crate::gateway_store::merge_journal_path()?, &text)?;
        }
        crate::gateway_store::apply_rewrites_to_settings_and_schedules(&result.rewrites);
        Ok(())
    }

    fn materialize_locked(&self, selected_model: Option<&str>) -> Result<Vec<Profile>, String> {
        self.ensure_split_locked()?;
        let gateways = crate::gateway_store::load_gateways()?;
        let bindings = crate::gateway_store::load_bindings()?;
        let mut out = Vec::with_capacity(bindings.len());
        for b in &bindings {
            let gw = b
                .gateway_id
                .as_deref()
                .and_then(|id| gateways.iter().find(|g| g.id == id));
            let mut p = crate::gateway_store::materialize(b, gw, selected_model);
            p.has_key = match &b.gateway_id {
                Some(gid) => has_key_locked(gid)?,
                None => false,
            };
            if p.models.is_empty() {
                if let Some(m) = p.model.take() {
                    p.models = vec![m];
                }
            }
            out.push(p);
        }
        Ok(out)
    }

    /// list 的锁内版本：调用方须已持 store_lock
    fn list_locked(&self) -> Result<Vec<Profile>, String> {
        self.materialize_locked(None)
    }

    pub fn list(&self) -> Result<Vec<Profile>, String> {
        let _g = store_lock();
        self.list_locked()
    }

    pub fn get(&self, id: &str) -> Result<Profile, String> {
        self.get_with_model(id, None)
    }

    /// 按启动选中模型物化策略字段（温度/effort 取该模型，不是名单首个）。
    pub fn get_with_model(&self, id: &str, selected_model: Option<&str>) -> Result<Profile, String> {
        let _g = store_lock();
        self.get_locked_with_model(id, selected_model)
    }

    /// get 的锁内版本：调用方须已持 store_lock
    fn get_locked(&self, id: &str) -> Result<Profile, String> {
        self.get_locked_with_model(id, None)
    }

    fn get_locked_with_model(
        &self,
        id: &str,
        selected_model: Option<&str>,
    ) -> Result<Profile, String> {
        self.ensure_split_locked()?;
        let bindings = crate::gateway_store::load_bindings()?;
        let b = bindings
            .iter()
            .find(|b| b.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        let gateways = crate::gateway_store::load_gateways()?;
        let gw = b
            .gateway_id
            .as_deref()
            .and_then(|gid| gateways.iter().find(|g| g.id == gid));
        let mut p = crate::gateway_store::materialize(b, gw, selected_model);
        p.has_key = match &b.gateway_id {
            Some(gid) => has_key_locked(gid)?,
            None => false,
        };
        Ok(p)
    }

    pub fn create(&self, input: ProfileInput) -> Result<Profile, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        if input.account_type == AccountType::Official {
            let mut bindings = crate::gateway_store::load_bindings()?;
            if bindings
                .iter()
                .any(|b| b.agent == input.agent && b.kind == BindingKind::Official)
            {
                return Err("该 Agent 已有官方账号绑定".into());
            }
            let binding = Binding {
                id: uuid::Uuid::new_v4().to_string(),
                agent: input.agent,
                kind: BindingKind::Official,
                gateway_id: None,
                protocol: None,
                api_backend: None,
                models: normalize_models(input.models),
                extra_env: input.extra_env,
                last_used_at: None,
            };
            let profile = crate::gateway_store::materialize(&binding, None, None);
            crate::profile_validation::validate_profile_fields(&profile)?;
            bindings.push(binding);
            crate::gateway_store::save_bindings(&bindings)?;
            return Ok(profile);
        }
        let models = normalize_models(input.models);
        let mut gateway = Gateway {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name.clone(),
            no_auth: input.no_auth,
            key_hint: None,
            slots: ProtocolSlots::default(),
            header_env: input.request_policy.header_env.clone(),
            models: models
                .iter()
                .map(|id| GatewayModel {
                    id: id.clone(),
                    source: "user".into(),
                    temperature: input.request_policy.temperature,
                    top_p: input.request_policy.top_p,
                    max_output_tokens: input.request_policy.max_output_tokens,
                    reasoning_effort: input.request_policy.reasoning_effort.clone(),
                })
                .collect(),
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: Vec::new(),
            slot_probes: Vec::new(),
        };
        let slot = crate::gateway_store::slot_for_agent(&input.agent, input.protocol.as_deref());
        crate::gateway_store::set_slot_url(
            &mut gateway.slots,
            slot,
            input.base_url.clone().filter(|s| !s.is_empty()),
        );
        if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
            set_key(&gateway.id, &key)?;
            gateway.key_hint = Some(key_hint_of(&key));
        }
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: input.agent.clone(),
            kind: BindingKind::Api,
            gateway_id: Some(gateway.id.clone()),
            protocol: input.protocol.clone(),
            api_backend: input.api_backend.clone(),
            models: models.clone(),
            extra_env: input.extra_env.clone(),
            last_used_at: None,
        };
        let mut profile = crate::gateway_store::materialize(&binding, Some(&gateway), None);
        profile.has_key = gateway.key_hint.is_some();
        if let Err(error) = crate::profile_validation::validate_profile_fields(&profile) {
            delete_key(&gateway.id);
            return Err(error);
        }
        let mut gateways = crate::gateway_store::load_gateways()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        gateways.push(gateway);
        bindings.push(binding);
        crate::gateway_store::save_gateways(&gateways)?;
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(profile)
    }

    /// 复制配置：克隆网关（新 id）再绑到同一 Agent。同一网关不能绑两次。
    pub fn duplicate(&self, id: &str) -> Result<Profile, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let src = self.get_locked(id)?;
        if src.account_type == AccountType::Official {
            return Err("官方账号绑定不能复制".into());
        }
        let Some(gid) = src.gateway_id.clone() else {
            return Err("这条绑定没有网关".into());
        };
        let mut gateways = crate::gateway_store::load_gateways()?;
        let src_gw = gateways
            .iter()
            .find(|g| g.id == gid)
            .ok_or("网关不存在")?
            .clone();
        let mut gw = src_gw;
        gw.id = uuid::Uuid::new_v4().to_string();
        let existing: Vec<&str> = gateways.iter().map(|g| g.name.as_str()).collect();
        gw.name = copy_name(&existing, &gw.name);
        gw.last_probe.clear();
        if let Some(key) = get_key_locked(&gid)? {
            set_key(&gw.id, &key)?;
        }
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: src.agent.clone(),
            kind: BindingKind::Api,
            gateway_id: Some(gw.id.clone()),
            protocol: src.protocol.clone(),
            api_backend: src.api_backend.clone(),
            models: src.models.clone(),
            extra_env: src.extra_env.clone(),
            last_used_at: None,
        };
        let mut copy = crate::gateway_store::materialize(&binding, Some(&gw), None);
        copy.has_key = has_key_locked(&gw.id)?;
        if let Err(error) = crate::profile_validation::validate_profile_fields(&copy) {
            delete_key(&gw.id);
            return Err(error);
        }
        let mut bindings = crate::gateway_store::load_bindings()?;
        gateways.push(gw);
        bindings.push(binding);
        crate::gateway_store::save_gateways(&gateways)?;
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(copy)
    }

    /// 把该网关绑到目标 Agent。缺槽时把源 URL 填进目标槽（与旧「复制」同 URL 行为）。
    pub fn copy_to_agent(&self, id: &str, target_agent: &str) -> Result<Profile, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let src = self.get_locked(id)?;
        if target_agent == src.agent {
            return Err("目标与来源是同一个 agent，请用「复制配置」".into());
        }
        if src.account_type == AccountType::Official {
            return Err("官方账号不能绑到其他 Agent".into());
        }
        let protocol = pick_copy_protocol(&src, target_agent)?;
        let Some(gid) = src.gateway_id.clone() else {
            return Err("这条绑定没有网关".into());
        };
        let mut bindings = crate::gateway_store::load_bindings()?;
        if bindings
            .iter()
            .any(|b| b.agent == target_agent && b.gateway_id.as_deref() == Some(gid.as_str()))
        {
            return Err("该 Agent 已经绑过这个网关".into());
        }
        let mut gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways
            .iter_mut()
            .find(|g| g.id == gid)
            .ok_or("网关不存在")?;
        let slot = crate::gateway_store::slot_for_agent(target_agent, protocol.as_deref());
        if crate::gateway_store::slot_url(&gw.slots, slot).is_none() {
            crate::gateway_store::set_slot_url(&mut gw.slots, slot, src.base_url.clone());
        }
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: target_agent.to_string(),
            kind: BindingKind::Api,
            gateway_id: Some(gid.clone()),
            protocol,
            // grok 专用字段不跨 agent 携带；绑到 grok 时取缺省（chat_completions）
            api_backend: None,
            models: src.models.clone(),
            extra_env: src.extra_env.clone(),
            last_used_at: None,
        };
        let mut copy = crate::gateway_store::materialize(&binding, Some(gw), None);
        copy.has_key = has_key_locked(&gid)?;
        crate::profile_validation::validate_profile_fields(&copy)?;
        bindings.push(binding);
        crate::gateway_store::save_gateways(&gateways)?;
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(copy)
    }

    pub fn update(&self, id: &str, input: ProfileInput) -> Result<Profile, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        let idx = bindings
            .iter()
            .position(|b| b.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        if bindings[idx].agent != input.agent {
            return Err("连接创建后不能直接更换 Agent，请使用「复制到其他 Agent」".into());
        }
        if input.account_type == AccountType::Official && input.no_auth {
            return Err("官方账号不能设置为无密钥模式".into());
        }
        bindings[idx].protocol = input.protocol.clone();
        bindings[idx].api_backend = input.api_backend.clone();
        bindings[idx].models = normalize_models(input.models.clone());
        bindings[idx].extra_env = input.extra_env.clone();
        let mut gateways = crate::gateway_store::load_gateways()?;
        if bindings[idx].kind == BindingKind::Official {
            if input.account_type != AccountType::Official {
                return Err("官方账号绑定不能改成 API 连接，请新建".into());
            }
            let profile = crate::gateway_store::materialize(&bindings[idx], None, None);
            crate::profile_validation::validate_profile_fields(&profile)?;
            crate::gateway_store::save_bindings(&bindings)?;
            return Ok(profile);
        }
        let gid = bindings[idx]
            .gateway_id
            .clone()
            .ok_or("这条绑定没有网关")?;
        let gw_idx = gateways
            .iter()
            .position(|g| g.id == gid)
            .ok_or("网关不存在")?;
        let old_url = {
            let slot = crate::gateway_store::slot_for_agent(&input.agent, input.protocol.as_deref());
            crate::gateway_store::slot_url(&gateways[gw_idx].slots, slot).map(str::to_string)
        };
        let key_changed = input.api_key.as_deref().is_some_and(|k| !k.is_empty());
        let no_auth_changed = gateways[gw_idx].no_auth != input.no_auth;
        gateways[gw_idx].name = input.name.clone();
        gateways[gw_idx].no_auth = input.no_auth;
        gateways[gw_idx].header_env = input.request_policy.header_env.clone();
        let slot = crate::gateway_store::slot_for_agent(&input.agent, input.protocol.as_deref());
        let new_url = input.base_url.clone().filter(|s| !s.trim().is_empty());
        crate::gateway_store::set_slot_url(&mut gateways[gw_idx].slots, slot, new_url.clone());
        if old_url != new_url {
            crate::gateway_store::invalidate_slot_probes(&mut gateways[gw_idx], slot);
        }
        if key_changed || no_auth_changed {
            crate::gateway_store::invalidate_all_probes(&mut gateways[gw_idx]);
        }
        // 绑定名单里没有的模型只补空条目，不覆盖网关库里已设的逐模型策略
        for id in &bindings[idx].models {
            if !gateways[gw_idx].models.iter().any(|m| m.id == *id) {
                gateways[gw_idx].models.push(GatewayModel {
                    id: id.clone(),
                    source: "user".into(),
                    temperature: None,
                    top_p: None,
                    max_output_tokens: None,
                    reasoning_effort: None,
                });
            }
        }
        if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
            set_key(&gid, &key)?;
            gateways[gw_idx].key_hint = Some(key_hint_of(&key));
        } else if input.no_auth {
            delete_key(&gid);
            gateways[gw_idx].key_hint = None;
        }
        let mut profile =
            crate::gateway_store::materialize(&bindings[idx], Some(&gateways[gw_idx]), None);
        profile.has_key = has_key_locked(&gid)?;
        crate::profile_validation::validate_profile_fields(&profile)?;
        crate::gateway_store::save_gateways(&gateways)?;
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(profile)
    }

    /// 解绑。不删网关、不动密钥。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        bindings.retain(|b| b.id != id);
        crate::gateway_store::save_bindings(&bindings)?;
        let catalog = crate::agents::codex_catalog_path(id);
        if let Some(p) = catalog {
            let _ = fs::remove_file(p);
        }
        crate::settings::clear_profile_refs(id);
        Ok(())
    }

    pub fn clear_key(&self, id: &str) -> Result<(), String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let bindings = crate::gateway_store::load_bindings()?;
        let b = bindings
            .iter()
            .find(|b| b.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}"))?;
        let Some(gid) = &b.gateway_id else {
            return Ok(());
        };
        delete_key(gid);
        let mut gateways = crate::gateway_store::load_gateways()?;
        if let Some(g) = gateways.iter_mut().find(|g| g.id == *gid) {
            g.key_hint = None;
            crate::gateway_store::invalidate_all_probes(g);
        }
        crate::gateway_store::save_gateways(&gateways)
    }

    /// 每次用于启动即刷新 last_used_at（§6.12 E）；失败静默，不影响启动
    pub fn touch_last_used(&self, id: &str) {
        let _g = store_lock();
        let _ = (|| -> Result<(), String> {
            self.ensure_split_locked()?;
            let mut bindings = crate::gateway_store::load_bindings()?;
            if let Some(b) = bindings.iter_mut().find(|b| b.id == id) {
                b.last_used_at = Some(crate::sessions::now_iso());
                crate::gateway_store::save_bindings(&bindings)?;
            }
            Ok(())
        })();
    }

    pub fn list_gateways(&self) -> Result<Vec<Gateway>, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let mut items = crate::gateway_store::load_gateways()?;
        for g in &mut items {
            g.key_hint = if has_key_locked(&g.id)? {
                g.key_hint.clone().or(Some("····".into()))
            } else {
                None
            };
            g.slot_probes = crate::gateway_store::slot_probe_summaries(&g.last_probe);
        }
        Ok(items)
    }

    pub fn save_gateway(&self, id: Option<String>, input: GatewayInput) -> Result<Gateway, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        if let Some(id) = id {
            let idx = gateways
                .iter()
                .position(|g| g.id == id)
                .ok_or("网关不存在")?;
            let old = gateways[idx].clone();
            gateways[idx].name = input.name;
            gateways[idx].no_auth = input.no_auth;
            gateways[idx].slots = input.slots;
            gateways[idx].header_env = input.header_env;
            gateways[idx].models = input.models;
            if old.slots.anthropic != gateways[idx].slots.anthropic {
                crate::gateway_store::invalidate_slot_probes(&mut gateways[idx], crate::gateway_store::Slot::Anthropic);
            }
            if old.slots.openai != gateways[idx].slots.openai {
                crate::gateway_store::invalidate_slot_probes(&mut gateways[idx], crate::gateway_store::Slot::Openai);
            }
            if old.slots.responses != gateways[idx].slots.responses {
                crate::gateway_store::invalidate_slot_probes(&mut gateways[idx], crate::gateway_store::Slot::Responses);
            }
            if old.slots.gemini != gateways[idx].slots.gemini {
                crate::gateway_store::invalidate_slot_probes(&mut gateways[idx], crate::gateway_store::Slot::Gemini);
            }
            if old.slots.cursor != gateways[idx].slots.cursor {
                crate::gateway_store::invalidate_slot_probes(&mut gateways[idx], crate::gateway_store::Slot::Cursor);
            }
            let key_changed = input.api_key.as_deref().is_some_and(|k| !k.is_empty());
            if key_changed || old.no_auth != gateways[idx].no_auth {
                crate::gateway_store::invalidate_all_probes(&mut gateways[idx]);
            }
            if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
                set_key(&id, &key)?;
                gateways[idx].key_hint = Some(key_hint_of(&key));
            } else if input.no_auth {
                delete_key(&id);
                gateways[idx].key_hint = None;
            }
            let saved = gateways[idx].clone();
            crate::gateway_store::save_gateways(&gateways)?;
            Ok(saved)
        } else {
            let mut gw = Gateway {
                id: uuid::Uuid::new_v4().to_string(),
                name: input.name,
                no_auth: input.no_auth,
                key_hint: None,
                slots: input.slots,
                header_env: input.header_env,
                models: input.models,
                catalog_fetched_at: None,
                catalog_from_slot: None,
                last_probe: Vec::new(),
                slot_probes: Vec::new(),
            };
            if let Some(key) = input.api_key.filter(|k| !k.is_empty()) {
                set_key(&gw.id, &key)?;
                gw.key_hint = Some(key_hint_of(&key));
            }
            gateways.push(gw.clone());
            crate::gateway_store::save_gateways(&gateways)?;
            Ok(gw)
        }
    }

    pub fn delete_gateway(&self, id: &str) -> Result<(), String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let bindings = crate::gateway_store::load_bindings()?;
        if bindings.iter().any(|b| b.gateway_id.as_deref() == Some(id)) {
            return Err("还有 Agent 绑着这个网关，请先解绑".into());
        }
        let mut gateways = crate::gateway_store::load_gateways()?;
        gateways.retain(|g| g.id != id);
        crate::gateway_store::save_gateways(&gateways)?;
        delete_key(id);
        crate::model_registry::purge_relay_for_gateway(id);
        Ok(())
    }

    pub fn bind_gateway(&self, input: BindingInput) -> Result<Profile, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        if input.kind == BindingKind::Official {
            return self.create(ProfileInput {
                agent: input.agent,
                name: "官方账号".into(),
                account_type: AccountType::Official,
                no_auth: false,
                protocol: None,
                api_backend: None,
                base_url: None,
                models: input.models,
                extra_env: input.extra_env,
                request_policy: RequestPolicy::default(),
                api_key: None,
            });
        }
        let gid = input.gateway_id.clone().ok_or("请选择网关")?;
        let mut bindings = crate::gateway_store::load_bindings()?;
        if bindings
            .iter()
            .any(|b| b.agent == input.agent && b.gateway_id.as_deref() == Some(gid.as_str()))
        {
            return Err("该 Agent 已经绑过这个网关".into());
        }
        let gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways.iter().find(|g| g.id == gid).ok_or("网关不存在")?;
        let slot = crate::gateway_store::slot_for_agent(&input.agent, input.protocol.as_deref());
        if crate::gateway_store::slot_url(&gw.slots, slot).is_none() {
            return Err("这个网关还没配该协议的端点，请先在网关库补槽".into());
        }
        let binding = Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: input.agent,
            kind: BindingKind::Api,
            gateway_id: Some(gid.clone()),
            protocol: input.protocol,
            api_backend: input.api_backend,
            models: normalize_models(input.models),
            extra_env: input.extra_env,
            last_used_at: None,
        };
        let mut profile = crate::gateway_store::materialize(&binding, Some(gw), None);
        profile.has_key = has_key_locked(&gid)?;
        crate::profile_validation::validate_profile_fields(&profile)?;
        bindings.push(binding);
        crate::gateway_store::save_bindings(&bindings)?;
        Ok(profile)
    }

    pub fn record_probe(&self, gateway_id: &str, rec: ProbeRecord) -> Result<(), String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways
            .iter_mut()
            .find(|g| g.id == gateway_id)
            .ok_or("网关不存在")?;
        gw.last_probe
            .retain(|p| !(p.slot == rec.slot && p.model == rec.model));
        gw.last_probe.push(rec);
        crate::gateway_store::save_gateways(&gateways)
    }

    pub fn merge_fetched_models(
        &self,
        gateway_id: &str,
        slot: &str,
        ids: Vec<String>,
    ) -> Result<Gateway, String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        let mut gateways = crate::gateway_store::load_gateways()?;
        let gw = gateways
            .iter_mut()
            .find(|g| g.id == gateway_id)
            .ok_or("网关不存在")?;
        let ids = normalize_models(ids);
        if crate::gateway_store::Slot::from_str(slot).is_none() {
            return Err(format!("未知协议槽: {slot}"));
        }
        for id in &ids {
            if !gw.models.iter().any(|m| m.id == *id) {
                gw.models.push(GatewayModel {
                    id: id.clone(),
                    source: "fetched".into(),
                    temperature: None,
                    top_p: None,
                    max_output_tokens: None,
                    reasoning_effort: None,
                });
            }
        }
        gw.catalog_fetched_at = Some(crate::sessions::now_iso());
        gw.catalog_from_slot = Some(slot.to_string());
        let mut saved = gw.clone();
        saved.slot_probes = crate::gateway_store::slot_probe_summaries(&saved.last_probe);
        crate::gateway_store::save_gateways(&gateways)?;
        Ok(saved)
    }

    pub fn clear_gateway_key(&self, id: &str) -> Result<(), String> {
        let _g = store_lock();
        self.ensure_split_locked()?;
        delete_key(id);
        let mut gateways = crate::gateway_store::load_gateways()?;
        if let Some(g) = gateways.iter_mut().find(|g| g.id == id) {
            g.key_hint = None;
            crate::gateway_store::invalidate_all_probes(g);
        }
        crate::gateway_store::save_gateways(&gateways)
    }
}

/// 迁移前备份 profiles.json 与 keys.json（.json.bak-gateway-split），已存在则覆盖。
fn backup_split_sidecars(profiles_path: &std::path::Path, keys_path: &std::path::Path) {
    if profiles_path.exists() {
        let bak = profiles_path.with_extension("json.bak-gateway-split");
        let _ = fs::copy(profiles_path, &bak);
    }
    if keys_path.exists() {
        let bak = keys_path.with_extension("json.bak-gateway-split");
        let _ = fs::copy(keys_path, &bak);
    }
}

/// 目标名未被占用则沿用，否则追加 -2/-3…
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

fn restrict_file_mode(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃留下半截 JSON（借鉴 CC Switch）。
/// 父目录不存在时先建（MCP 分发会写到尚未初始化的 agent 配置目录，如 ~/.cursor、
/// ~/.config/opencode；缺了这步报的是「系统找不到指定的路径」，还会把用户没见过的
/// .tmp 名字吐到界面上）。任何失败路径都清掉残留 tmp，不在用户项目树里留垃圾。
pub(crate) fn atomic_write(path: &std::path::Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    let result = rename_replacing(&tmp, path);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// rename 覆盖目标，带两类重试：
/// - ENOENT：iCloud 等同步目录里新落盘的 tmp 偶发被同步代理瞬时介入，短暂退避后重试一次
///   （父目录真不存在时第二次照样失败，语义不变）。
/// - PermissionDenied（仅 Windows）：`MoveFileExW` 对**只读属性**的目标返回
///   ERROR_ACCESS_DENIED，而 POSIX `rename(2)` 只看父目录权限、不看目标 mode ——
///   所以这是 Windows 独有的失败。先清掉目标（`remove_file` 能删只读文件）再重试。
fn rename_replacing(tmp: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    match fs::rename(tmp, path) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        #[cfg(windows)]
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            let _ = fs::remove_file(path);
        }
        Err(e) => return Err(format!("替换 {} 失败: {e}", path.display())),
    }
    fs::rename(tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
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

/// 启动/写入用：官方账号无密钥；API 从网关 id 取（迁移后 keys.json 键是网关 id）。
pub fn get_key_for_profile(profile: &Profile) -> Result<Option<String>, String> {
    if profile.account_type == AccountType::Official {
        return Ok(None);
    }
    if let Some(gid) = &profile.gateway_id {
        return get_key(gid);
    }
    get_key(&profile.id)
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
    let text = fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败: {e}"))?;
    let incoming: Vec<Profile> =
        serde_json::from_str(&text).map_err(|e| format!("导入文件格式不正确: {e}"))?;
    let existing = store.list()?;
    let mut added = 0;
    for p in incoming {
        let dup = existing.iter().any(|q| {
            q.agent == p.agent && q.name == p.name && q.base_url == p.base_url
        });
        if dup {
            continue;
        }
        store.create(ProfileInput {
            agent: p.agent,
            name: p.name,
            account_type: p.account_type,
            no_auth: p.no_auth && p.account_type == AccountType::Api,
            protocol: p.protocol,
            api_backend: p.api_backend,
            base_url: p.base_url,
            models: p.models,
            extra_env: p.extra_env,
            request_policy: p.request_policy,
            api_key: None,
        })?;
        added += 1;
    }
    Ok(added)
}

fn slot_fingerprint(slots: &ProtocolSlots) -> String {
    let pairs = [
        ("anthropic", slots.anthropic.as_deref()),
        ("openai", slots.openai.as_deref()),
        ("responses", slots.responses.as_deref()),
        ("gemini", slots.gemini.as_deref()),
        ("cursor", slots.cursor.as_deref()),
    ];
    let mut parts = Vec::new();
    for (name, url) in pairs {
        if let Some(u) = url.map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(format!("{name}={}", u.trim_end_matches('/')));
        }
    }
    parts.join("|")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayExportV2 {
    name: String,
    no_auth: bool,
    slots: ProtocolSlots,
    header_env: BTreeMap<String, String>,
    models: Vec<GatewayModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindingExportV2 {
    agent: String,
    gateway_ref: GatewayRefV2,
    protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_backend: Option<String>,
    models: Vec<String>,
    extra_env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayRefV2 {
    name: String,
    slot_fp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigExportV2 {
    version: u32,
    gateways: Vec<GatewayExportV2>,
    bindings: Vec<BindingExportV2>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportV2Result {
    pub added_gateways: usize,
    pub added_bindings: usize,
    pub skipped_slots: Vec<String>,
}

fn extra_env_for_export(
    env: &std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    env.iter()
        .filter(|(name, _)| !sensitive_env_name(name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn build_export_v2(
    gateways: &[Gateway],
    bindings: &[Binding],
    keys: &std::collections::HashMap<String, String>,
    include_keys: bool,
) -> Result<(ConfigExportV2, String), String> {
    let mut out_gws = Vec::new();
    for g in gateways {
        out_gws.push(GatewayExportV2 {
            name: g.name.clone(),
            no_auth: g.no_auth,
            slots: g.slots.clone(),
            header_env: g.header_env.clone(),
            models: g.models.clone(),
            api_key: None,
        });
    }
    let out_binds: Vec<BindingExportV2> = bindings
        .iter()
        .filter(|b| b.kind == BindingKind::Api)
        .filter_map(|b| {
            let gw = gateways
                .iter()
                .find(|g| Some(g.id.as_str()) == b.gateway_id.as_deref())?;
            Some(BindingExportV2 {
                agent: b.agent.clone(),
                gateway_ref: GatewayRefV2 {
                    name: gw.name.clone(),
                    slot_fp: slot_fingerprint(&gw.slots),
                },
                protocol: b.protocol.clone(),
                api_backend: b.api_backend.clone(),
                models: b.models.clone(),
                extra_env: extra_env_for_export(&b.extra_env),
            })
        })
        .collect();
    let mut doc = ConfigExportV2 {
        version: 2,
        gateways: out_gws,
        bindings: out_binds,
    };
    let mut text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    text = crate::sessions::redact_sensitive_text(&text);
    if include_keys {
        doc = serde_json::from_str(&text).unwrap_or(doc);
        for (g, ge) in gateways.iter().zip(doc.gateways.iter_mut()) {
            ge.api_key = keys.get(&g.id).cloned();
        }
        text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    }
    Ok((doc, text))
}

#[tauri::command]
pub fn export_gateways_v2(
    store: tauri::State<'_, ProfileStore>,
    path: String,
    include_keys: bool,
) -> Result<(), String> {
    let _g = store_lock();
    store.ensure_split_locked()?;
    let gateways = crate::gateway_store::load_gateways()?;
    let bindings = crate::gateway_store::load_bindings()?;
    let mut keys = std::collections::HashMap::new();
    if include_keys {
        for g in &gateways {
            if let Ok(Some(k)) = get_key_locked(&g.id) {
                keys.insert(g.id.clone(), k);
            }
        }
    }
    let (_, text) = build_export_v2(&gateways, &bindings, &keys, include_keys)?;
    let dest = std::path::Path::new(&path);
    atomic_write(dest, &text)?;
    if include_keys {
        restrict_file_mode(dest);
    }
    Ok(())
}

fn match_existing_gateway(
    gateways: &[Gateway],
    incoming: &GatewayExportV2,
    keys: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let fp = slot_fingerprint(&incoming.slots);
    if let Some(k) = incoming.api_key.as_deref().filter(|s| !s.is_empty()) {
        let kfp = format!("{:x}", md5::compute(k.as_bytes()));
        if let Some(id) = gateways.iter().find(|g| {
            keys.get(&g.id)
                .map(|live| format!("{:x}", md5::compute(live.as_bytes())) == kfp)
                .unwrap_or(false)
        }).map(|g| g.id.clone()) {
            return Some(id);
        }
    }
    if !fp.is_empty() {
        return gateways
            .iter()
            .find(|g| slot_fingerprint(&g.slots) == fp)
            .map(|g| g.id.clone());
    }
    None
}

fn apply_import_v2(
    doc: ConfigExportV2,
    gateways: &mut Vec<Gateway>,
    bindings: &mut Vec<Binding>,
    keys: &mut std::collections::HashMap<String, String>,
) -> ImportV2Result {
    let mut skipped = Vec::new();
    let mut added_gws = 0;
    let mut added_binds = 0;
    let mut ref_to_id: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();

    for incoming in doc.gateways {
        let fp = slot_fingerprint(&incoming.slots);
        let existing = match_existing_gateway(gateways, &incoming, keys);
        let gid = if let Some(id) = existing {
            if let Some(idx) = gateways.iter().position(|g| g.id == id) {
                merge_incoming_slots(&mut gateways[idx], &incoming, &mut skipped);
                if let Some(k) = incoming.api_key.as_deref().filter(|s| !s.is_empty()) {
                    keys.insert(id.clone(), k.to_string());
                    gateways[idx].key_hint = Some(key_hint_of(k));
                }
            }
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let mut gw = Gateway {
                id: id.clone(),
                name: incoming.name.clone(),
                no_auth: incoming.no_auth,
                key_hint: None,
                slots: incoming.slots.clone(),
                header_env: incoming.header_env.clone(),
                models: incoming.models.clone(),
                catalog_fetched_at: None,
                catalog_from_slot: None,
                last_probe: Vec::new(),
                slot_probes: Vec::new(),
            };
            if let Some(k) = incoming.api_key.as_deref().filter(|s| !s.is_empty()) {
                keys.insert(id.clone(), k.to_string());
                gw.key_hint = Some(key_hint_of(k));
            }
            gateways.push(gw);
            added_gws += 1;
            id
        };
        ref_to_id.insert((incoming.name, fp), gid);
    }

    for b in doc.bindings {
        let Some(gid) = ref_to_id
            .get(&(b.gateway_ref.name.clone(), b.gateway_ref.slot_fp.clone()))
            .cloned()
            .or_else(|| {
                gateways
                    .iter()
                    .find(|g| {
                        g.name == b.gateway_ref.name
                            && slot_fingerprint(&g.slots) == b.gateway_ref.slot_fp
                    })
                    .map(|g| g.id.clone())
            })
        else {
            skipped.push(format!("绑定 {} 找不到对应网关", b.agent));
            continue;
        };
        if let Some(existing) = bindings
            .iter_mut()
            .find(|x| x.agent == b.agent && x.gateway_id.as_deref() == Some(gid.as_str()))
        {
            merge_incoming_binding(existing, &b, &mut skipped);
            continue;
        }
        bindings.push(Binding {
            id: uuid::Uuid::new_v4().to_string(),
            // grok 专用字段：导入对象非 grok 时丢弃
            api_backend: if b.agent == "grok" { b.api_backend.clone() } else { None },
            agent: b.agent,
            kind: BindingKind::Api,
            gateway_id: Some(gid),
            protocol: b.protocol,
            models: b.models,
            extra_env: b.extra_env,
            last_used_at: None,
        });
        added_binds += 1;
    }
    ImportV2Result {
        added_gateways: added_gws,
        added_bindings: added_binds,
        skipped_slots: skipped,
    }
}

#[tauri::command]
pub fn import_gateways_v2(
    store: tauri::State<'_, ProfileStore>,
    path: String,
) -> Result<ImportV2Result, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败: {e}"))?;
    let doc: ConfigExportV2 =
        serde_json::from_str(&text).map_err(|e| format!("导入文件格式不正确: {e}"))?;
    if doc.version != 2 {
        return Err("不是 v2 网关导出".into());
    }
    let _g = store_lock();
    store.ensure_split_locked()?;
    let mut gateways = crate::gateway_store::load_gateways()?;
    let mut bindings = crate::gateway_store::load_bindings()?;
    let mut keys = std::collections::HashMap::new();
    for g in &gateways {
        if let Ok(Some(k)) = get_key_locked(&g.id) {
            keys.insert(g.id.clone(), k);
        }
    }
    let result = apply_import_v2(doc, &mut gateways, &mut bindings, &mut keys);
    for g in &gateways {
        if let Some(k) = keys.get(&g.id) {
            let _ = set_key(&g.id, k);
        }
    }
    crate::gateway_store::save_gateways(&gateways)?;
    crate::gateway_store::save_bindings(&bindings)?;
    Ok(result)
}

fn merge_incoming_slots(gw: &mut Gateway, incoming: &GatewayExportV2, skipped: &mut Vec<String>) {
    merge_one_slot("anthropic", incoming.slots.anthropic.as_deref(), &mut gw.slots.anthropic, &gw.name, skipped);
    merge_one_slot("openai", incoming.slots.openai.as_deref(), &mut gw.slots.openai, &gw.name, skipped);
    merge_one_slot("responses", incoming.slots.responses.as_deref(), &mut gw.slots.responses, &gw.name, skipped);
    merge_one_slot("gemini", incoming.slots.gemini.as_deref(), &mut gw.slots.gemini, &gw.name, skipped);
    merge_one_slot("cursor", incoming.slots.cursor.as_deref(), &mut gw.slots.cursor, &gw.name, skipped);
    for m in &incoming.models {
        if !gw.models.iter().any(|x| x.id == m.id) {
            gw.models.push(m.clone());
        }
    }
    for (k, v) in &incoming.header_env {
        match gw.header_env.get(k) {
            None => {
                gw.header_env.insert(k.clone(), v.clone());
            }
            Some(existing) if existing == v => {}
            Some(_) => skipped.push(format!("{} 的 Header {k} 冲突，已跳过", gw.name)),
        }
    }
}

fn merge_incoming_binding(existing: &mut Binding, incoming: &BindingExportV2, skipped: &mut Vec<String>) {
    for m in &incoming.models {
        if !existing.models.contains(m) {
            existing.models.push(m.clone());
        }
    }
    match (&existing.protocol, &incoming.protocol) {
        (None, Some(p)) => existing.protocol = Some(p.clone()),
        (Some(a), Some(b)) if a != b => {
            skipped.push(format!("{} 的协议冲突（{a} / {b}），已跳过", incoming.agent));
        }
        _ => {}
    }
    // grok 的 api_backend 同协议口径合并：空则补、冲突记 skipped
    match (&existing.api_backend, &incoming.api_backend) {
        (None, Some(v)) if incoming.agent == "grok" => existing.api_backend = Some(v.clone()),
        (Some(a), Some(b)) if a != b => {
            skipped.push(format!("{} 的 API 后端冲突（{a} / {b}），已跳过", incoming.agent));
        }
        _ => {}
    }
    for (k, v) in &incoming.extra_env {
        match existing.extra_env.get(k) {
            None => {
                existing.extra_env.insert(k.clone(), v.clone());
            }
            Some(existing_v) if existing_v == v => {}
            Some(_) => skipped.push(format!("{} 的 extraEnv {k} 冲突，已跳过", incoming.agent)),
        }
    }
}

fn merge_one_slot(
    name: &str,
    incoming: Option<&str>,
    live: &mut Option<String>,
    gw_name: &str,
    skipped: &mut Vec<String>,
) {
    let Some(url) = incoming.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    match live.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => *live = Some(url.to_string()),
        Some(existing) if existing.trim_end_matches('/') == url.trim_end_matches('/') => {}
        Some(_) => skipped.push(format!("{gw_name} 的 {name} 槽冲突，已跳过")),
    }
}

#[tauri::command]
pub fn list_gateways(store: tauri::State<'_, ProfileStore>) -> Result<Vec<Gateway>, String> {
    store.list_gateways()
}

#[tauri::command]
pub fn merge_gateway_models(
    store: tauri::State<'_, ProfileStore>,
    gateway_id: String,
    slot: String,
    ids: Vec<String>,
) -> Result<Gateway, String> {
    store.merge_fetched_models(&gateway_id, &slot, ids)
}

#[tauri::command]
pub fn save_gateway(
    store: tauri::State<'_, ProfileStore>,
    id: Option<String>,
    input: GatewayInput,
) -> Result<Gateway, String> {
    store.save_gateway(id, input)
}

#[tauri::command]
pub fn delete_gateway(store: tauri::State<'_, ProfileStore>, id: String) -> Result<(), String> {
    store.delete_gateway(&id)
}

#[tauri::command]
pub fn bind_gateway(
    store: tauri::State<'_, ProfileStore>,
    input: BindingInput,
) -> Result<Profile, String> {
    store.bind_gateway(input)
}

#[tauri::command]
pub fn unbind_split_merge(store: tauri::State<'_, ProfileStore>) -> Result<usize, String> {
    let _g = store_lock();
    store.ensure_split_locked()?;
    let path = crate::gateway_store::merge_journal_path()?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("读取合并清单失败: {e}")),
    };
    let journal: crate::gateway_store::MergeJournal =
        serde_json::from_str(&text).map_err(|e| format!("合并清单损坏: {e}"))?;
    if journal.entries.is_empty() {
        return Ok(0);
    }
    let mut gateways = crate::gateway_store::load_gateways()?;
    let mut bindings = crate::gateway_store::load_bindings()?;
    let (restored, copies) =
        crate::gateway_store::restore_merged_bindings(&journal, &mut gateways, &mut bindings);
    for (from, to) in copies {
        if let Ok(Some(k)) = get_key_locked(&from) {
            let _ = set_key(&to, &k);
            if let Some(g) = gateways.iter_mut().find(|g| g.id == to) {
                g.key_hint = Some(key_hint_of(&k));
            }
        }
    }
    crate::gateway_store::save_gateways(&gateways)?;
    crate::gateway_store::save_bindings(&bindings)?;
    let _ = fs::remove_file(&path);
    Ok(restored)
}

#[tauri::command]
pub fn clear_gateway_key(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<(), String> {
    store.clear_gateway_key(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== atomic_write 的两条跨平台前置条件 =====

    #[test]
    fn atomic_write_creates_missing_parent_dirs() {
        // MCP 分发会写到尚未初始化的 agent 配置目录（本机 ~/.cursor 就不存在）；
        // 缺这步用户看到的是「系统找不到指定的路径」外加一个没见过的 .tmp 名字。
        let dir = std::env::temp_dir().join(format!("ccode-aw-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested").join("deep").join("cfg.json");
        atomic_write(&path, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_replaces_readonly_target_and_leaves_no_tmp() {
        // Windows 的 MoveFileExW 对只读目标返回 ERROR_ACCESS_DENIED，
        // 而 POSIX rename(2) 只看父目录权限 —— 这条在 macOS 上本来就过。
        let dir = std::env::temp_dir().join(format!("ccode-aw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        atomic_write(&path, "v1").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        atomic_write(&path, "v2").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v2");
        assert!(
            !dir.join("note.tmp").exists(),
            "成功路径不得留下 .tmp"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

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
            api_backend: None,
            base_url: None,
            models: vec![],
            extra_env: Default::default(),
            request_policy: RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: false,
            gateway_id: None,
            slot_missing: false,
            provider_override: None,
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

    #[test]
    fn apply_session_provider_uses_rollout_name() {
        let gid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let mut p = Profile {
            id: "b".into(),
            agent: "codex".into(),
            name: "n".into(),
            account_type: AccountType::Api,
            no_auth: false,
            protocol: None,
            api_backend: None,
            base_url: Some("https://example.com".into()),
            models: vec![],
            extra_env: Default::default(),
            request_policy: RequestPolicy::default(),
            key_hint: None,
            model: None,
            last_used_at: None,
            has_key: true,
            gateway_id: Some(gid.into()),
            slot_missing: false,
            provider_override: None,
        };
        assert_eq!(p.provider_name(), crate::provider_id::provider_id(gid));
        p.apply_session_provider(Some("ccode"));
        assert_eq!(p.provider_name(), crate::provider_id::LEGACY);
        p.apply_session_provider(Some("ccode-a1b2c3d4"));
        assert_eq!(p.provider_name(), "ccode-a1b2c3d4");
        p.apply_session_provider(None);
        assert_eq!(p.provider_name(), crate::provider_id::provider_id(gid));
        p.apply_session_provider(Some("openai"));
        assert_eq!(p.provider_name(), crate::provider_id::provider_id(gid));
    }

    #[test]
    fn backup_split_sidecars_copies_both_files() {
        let dir = std::env::temp_dir().join(format!("ccode-bak-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let profiles = dir.join("profiles.json");
        let keys = dir.join("keys.json");
        std::fs::write(&profiles, "{\"a\":1}").unwrap();
        std::fs::write(&keys, "{\"k\":\"v\"}").unwrap();
        backup_split_sidecars(&profiles, &keys);
        assert_eq!(
            std::fs::read_to_string(dir.join("profiles.json.bak-gateway-split")).unwrap(),
            "{\"a\":1}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("keys.json.bak-gateway-split")).unwrap(),
            "{\"k\":\"v\"}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn sample_gw(id: &str, name: &str, url: &str) -> Gateway {
        Gateway {
            id: id.into(),
            name: name.into(),
            no_auth: false,
            key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some(url.into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            last_probe: vec![],
            slot_probes: vec![],
        }
    }

    fn sample_bind(agent: &str, gid: &str, models: &[&str]) -> Binding {
        Binding {
            id: uuid::Uuid::new_v4().to_string(),
            agent: agent.into(),
            kind: BindingKind::Api,
            gateway_id: Some(gid.into()),
            protocol: None,
            api_backend: None,
            models: models.iter().map(|s| (*s).to_string()).collect(),
            extra_env: Default::default(),
            last_used_at: None,
        }
    }

    #[test]
    fn extra_env_for_export_drops_key_token_names() {
        let mut env = std::collections::HashMap::new();
        env.insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
        env.insert("CUSTOM_API_KEY".into(), "sk-should-not-export".into());
        env.insert("AUTH_TOKEN".into(), "tok".into());
        let out = extra_env_for_export(&env);
        assert_eq!(out.get("HTTPS_PROXY").map(String::as_str), Some("http://127.0.0.1:7890"));
        assert!(!out.contains_key("CUSTOM_API_KEY"));
        assert!(!out.contains_key("AUTH_TOKEN"));
    }

    #[test]
    fn export_import_v2_roundtrip_and_unique_constraint() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let b = sample_bind("claude-code", "g1", &["m1"]);
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-live-secret-abcdef".into());
        let (doc, text) = build_export_v2(&[gw.clone()], &[b.clone()], &keys, true).unwrap();
        assert!(text.contains("sk-live-secret-abcdef"));
        assert_eq!(doc.gateways[0].api_key.as_deref(), Some("sk-live-secret-abcdef"));

        let mut gateways = vec![gw.clone()];
        let mut bindings = vec![b.clone()];
        let mut live_keys = keys.clone();
        let incoming = ConfigExportV2 {
            version: 2,
            gateways: vec![GatewayExportV2 {
                name: "中转 A".into(),
                no_auth: false,
                slots: gw.slots.clone(),
                header_env: {
                    let mut h = std::collections::BTreeMap::new();
                    h.insert("X-Trace".into(), "TRACE_ID".into());
                    h
                },
                models: vec![],
                api_key: Some("sk-live-secret-abcdef".into()),
            }],
            bindings: vec![BindingExportV2 {
                agent: "claude-code".into(),
                gateway_ref: GatewayRefV2 {
                    name: "中转 A".into(),
                    slot_fp: slot_fingerprint(&gw.slots),
                },
                protocol: Some("anthropic".into()),
                api_backend: None,
                models: vec!["m2".into()],
                extra_env: {
                    let mut e = std::collections::HashMap::new();
                    e.insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
                    e
                },
            }],
        };
        let res = apply_import_v2(incoming, &mut gateways, &mut bindings, &mut live_keys);
        assert_eq!(res.added_gateways, 0);
        assert_eq!(res.added_bindings, 0);
        assert!(res.skipped_slots.is_empty(), "{:?}", res.skipped_slots);
        assert_eq!(gateways.len(), 1);
        assert_eq!(bindings.len(), 1);
        assert!(bindings[0].models.contains(&"m1".into()));
        assert!(bindings[0].models.contains(&"m2".into()));
        assert_eq!(bindings[0].protocol.as_deref(), Some("anthropic"));
        assert_eq!(
            bindings[0].extra_env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(gateways[0].header_env.get("X-Trace").map(String::as_str), Some("TRACE_ID"));
    }

    #[test]
    fn import_v2_rotated_key_falls_back_to_slot_fingerprint() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let mut gateways = vec![gw.clone()];
        let mut bindings = vec![];
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-old-key-11111111".into());
        let incoming = ConfigExportV2 {
            version: 2,
            gateways: vec![GatewayExportV2 {
                name: "中转 A".into(),
                no_auth: false,
                slots: gw.slots.clone(),
                header_env: Default::default(),
                models: vec![],
                api_key: Some("sk-new-key-22222222".into()),
            }],
            bindings: vec![],
        };
        let res = apply_import_v2(incoming, &mut gateways, &mut bindings, &mut keys);
        assert_eq!(res.added_gateways, 0, "换密钥的同一槽应并入已有网关");
        assert_eq!(gateways.len(), 1);
        assert_eq!(keys.get("g1").map(String::as_str), Some("sk-new-key-22222222"));
    }

    #[test]
    fn import_v2_slot_conflict_and_header_conflict_are_skipped_with_detail() {
        let mut gw = sample_gw("g1", "中转 A", "https://api.example.com");
        gw.header_env.insert("X-Trace".into(), "OLD".into());
        let mut gateways = vec![gw.clone()];
        let mut bindings = vec![];
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-same".into());
        let mut slots = gw.slots.clone();
        slots.anthropic = Some("https://other.example.com".into());
        let incoming = ConfigExportV2 {
            version: 2,
            gateways: vec![GatewayExportV2 {
                name: "中转 A".into(),
                no_auth: false,
                slots,
                header_env: {
                    let mut h = std::collections::BTreeMap::new();
                    h.insert("X-Trace".into(), "NEW".into());
                    h
                },
                models: vec![],
                api_key: Some("sk-same".into()),
            }],
            bindings: vec![],
        };
        let res = apply_import_v2(incoming, &mut gateways, &mut bindings, &mut keys);
        assert_eq!(res.added_gateways, 0);
        assert!(
            res.skipped_slots.iter().any(|s| s.contains("anthropic") && s.contains("跳过")),
            "{:?}",
            res.skipped_slots
        );
        assert!(
            res.skipped_slots.iter().any(|s| s.contains("Header X-Trace")),
            "{:?}",
            res.skipped_slots
        );
        assert_eq!(gateways[0].slots.anthropic.as_deref(), Some("https://api.example.com"));
        assert_eq!(gateways[0].header_env.get("X-Trace").map(String::as_str), Some("OLD"));
    }

    #[test]
    fn export_v2_redact_reload_keeps_keys_when_requested() {
        let gw = sample_gw("g1", "中转 A", "https://api.example.com");
        let mut keys = std::collections::HashMap::new();
        keys.insert("g1".into(), "sk-live-secret-abcdef".into());
        let (_, text) = build_export_v2(&[gw], &[], &keys, true).unwrap();
        let doc: ConfigExportV2 = serde_json::from_str(&text).unwrap();
        let mut gateways = vec![];
        let mut bindings = vec![];
        let mut live = std::collections::HashMap::new();
        let res = apply_import_v2(doc, &mut gateways, &mut bindings, &mut live);
        assert_eq!(res.added_gateways, 1);
        assert_eq!(live.values().next().map(String::as_str), Some("sk-live-secret-abcdef"));
    }

    #[cfg(unix)]
    #[test]
    fn export_with_keys_sets_0600() {
        let dir = std::env::temp_dir().join(format!("ccode-exp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.json");
        atomic_write(&path, "{\"k\":\"v\"}").unwrap();
        restrict_file_mode(&path);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }
}
