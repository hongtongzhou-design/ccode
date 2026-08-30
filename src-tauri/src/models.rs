use crate::profiles;

/// 任务卡（项目档案卡 project.toml 的 [[tasks]] 段）：对话/会话的归档夹。
/// 卡片本身无状态机，不碰工作区/评审流程。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskCardDto {
    /// "t-<短随机>"，项目内唯一
    pub id: String,
    /// 卡片名（同项目内唯一，大小写敏感）
    pub name: String,
    /// 挂到的流水线步骤名（步骤 name）；未挂为 None
    pub step: Option<String>,
    /// 开工后绑定的工作区名（先留字段，前端后续填）
    pub workspace: Option<String>,
    /// 卡片种类："draft"（服务于任务书草稿的讨论卡）| "idea"（自由想法卡，只读纯聊、可融合进任务书）；
    /// 缺省推断 = step 非空 → draft，否则 idea（正好等于引入 kind 前的两种行为）
    pub kind: String,
    pub created_at: String,
}

impl Default for TaskCardDto {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            step: None,
            workspace: None,
            kind: "idea".into(),
            created_at: String::new(),
        }
    }
}

/// 模型列表缓存：按「agent|protocol|base_url」落盘（config_dir/ccode/model-list-cache.json）。
/// 大网关的全量列表是现算+传输（400+ 条动辄 10s），拉一次后复用；force=true（↻ 刷新/连通测试）才走网络。
/// 是缓存不是用户配置：读取损坏容忍为空表，写入 tmp+rename 原子落盘，失败静默（下次拉取自然重试）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ModelListCacheEntry {
    models: Vec<String>,
    /// RFC3339 本地时间，仅展示用
    fetched_at: String,
}

type ModelListCache = std::collections::HashMap<String, ModelListCacheEntry>;

static MODEL_LIST_CACHE: std::sync::RwLock<Option<ModelListCache>> =
    std::sync::RwLock::new(None);

fn model_list_cache_path() -> Option<std::path::PathBuf> {
    Some(dirs::config_dir()?.join("ccode").join("model-list-cache.json"))
}

fn model_list_cache_get(key: &str) -> Option<ModelListCacheEntry> {
    if cfg!(test) {
        return None; // 测试不读本机真实缓存（同 model_registry 口径）
    }
    let mut guard = MODEL_LIST_CACHE.write().ok()?;
    if guard.is_none() {
        *guard = Some(
            model_list_cache_path()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
        );
    }
    guard.as_ref()?.get(key).cloned()
}

fn model_list_cache_put(key: &str, entry: ModelListCacheEntry) {
    if cfg!(test) {
        return;
    }
    let Ok(mut guard) = MODEL_LIST_CACHE.write() else {
        return;
    };
    let map = guard.get_or_insert_with(Default::default);
    map.insert(key.to_string(), entry);
    let Some(path) = model_list_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// fetch_models 的返回：模型列表 + 是否命中缓存 + 拉取时间（前端展示「缓存 · HH:MM」）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsResult {
    models: Vec<String>,
    from_cache: bool,
    fetched_at: String,
}

/// 从 profile 的端点拉取可用模型列表。
/// 密钥优先用表单里新输入的，否则取 keys.json 已存的；只用于本次请求，不持久化。
#[tauri::command]
pub async fn fetch_models(
    base_url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
    agent_id: Option<String>,
    protocol: Option<String>,
    gateway_id: Option<String>,
    // true = 跳过缓存强制走网络（↻ 刷新、「测试」按钮）
    force: Option<bool>,
) -> Result<FetchModelsResult, String> {
    let resolved_gateway = gateway_id.clone().or_else(|| {
        profile_id.as_deref().and_then(|id| {
            crate::profiles::ProfileStore::new()
                .ok()
                .and_then(|s| s.get(id).ok())
                .and_then(|p| p.gateway_id)
        })
    });
    let key = match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(k),
        None => {
            if let Some(gid) = resolved_gateway.as_deref() {
                profiles::get_key(gid)?
            } else if let Some(id) = profile_id.as_deref() {
                let store = crate::profiles::ProfileStore::new()?;
                match store.get(id) {
                    Ok(p) => profiles::get_key_for_profile(&p)?,
                    Err(_) => profiles::get_key(id)?,
                }
            } else {
                None
            }
        }
    };

    let agent = agent_id.as_deref().unwrap_or("openai");
    if agent == "cursor" {
        return Err("Cursor 使用专有协议，无法通过通用模型列表接口获取模型".into());
    }
    let gemini = agent == "gemini";
    let anthropic = matches!(agent, "claude-code" | "codebuddy")
        || matches!(protocol.as_deref(), Some("anthropic"));
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 Base URL".into());
    }
    let slot = crate::gateway_store::slot_for_agent(agent, protocol.as_deref());
    let cache_key = match resolved_gateway.as_deref() {
        Some(gid) => format!("{gid}|{}", slot.as_str()),
        None => format!("{agent}|{}|{base}", protocol.as_deref().unwrap_or("")),
    };
    if !force.unwrap_or(false) {
        if let Some(hit) = model_list_cache_get(&cache_key) {
            return Ok(FetchModelsResult {
                models: hit.models,
                from_cache: true,
                fetched_at: hit.fetched_at,
            });
        }
    }
    // 候选地址：已含 /v1 直接拼 /models；否则先试 /v1/models 再试 /models
    let candidates: Vec<String> = if gemini {
        if base.ends_with("/v1beta") || base.ends_with("/v1") {
            vec![format!("{base}/models")]
        } else {
            vec![format!("{base}/v1beta/models"), format!("{base}/models")]
        }
    } else if base.ends_with("/v1") {
        vec![format!("{base}/models")]
    } else {
        vec![format!("{base}/v1/models"), format!("{base}/models")]
    };

    // 30s：大网关全量模型列表（400+ 条带元数据）传输+解压可能超过 10s，压线即超时
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut last_err = String::new();
    for url in candidates {
        let mut req = client.get(&url);
        if let Some(k) = &key {
            if gemini {
                if let Ok(mut parsed) = reqwest::Url::parse(&url) {
                    parsed.query_pairs_mut().append_pair("key", k);
                    req = client.get(parsed);
                }
            }
            // 同时携带两种鉴权头：OpenAI 系认 Bearer，Anthropic 系认 x-api-key，多余的头无害
            if !gemini {
                req = req.header("Authorization", format!("Bearer {k}"));
            }
            if anthropic {
                req = req.header("x-api-key", k).header("anthropic-version", "2023-06-01");
            }
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                // 先读文本再解析：失败时能把响应开头（脱敏后）带进报错，
                // 否则 reqwest 的 "error decoding response body" 无任何自查线索
                let text = resp
                    .text()
                    .await
                    .map_err(|e| format!("读取响应失败: {e}"))?;
                let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
                    format!("解析响应失败: {e}；响应开头: {}", body_preview(&text))
                })?;
                // 顺带沉淀能力元数据（OpenRouter 风格响应带 context_length/modality 等；
                // 纯 id 列表的网关此调用为 no-op）——能力注册表的最准数据源
                crate::model_registry::record_relay_models(&body, resolved_gateway.as_deref());
                let fetched_at = chrono::Local::now().to_rfc3339();
                let models = parse_model_ids(&body);
                model_list_cache_put(
                    &cache_key,
                    ModelListCacheEntry {
                        models: models.clone(),
                        fetched_at: fetched_at.clone(),
                    },
                );
                return Ok(FetchModelsResult {
                    models,
                    from_cache: false,
                    fetched_at,
                });
            }
            Ok(resp) => {
                last_err = redact_fetch_error(
                    &format!("{url} 返回 HTTP {}", resp.status()),
                    key.as_deref(),
                );
            }
            Err(e) => {
                last_err = redact_fetch_error(
                    &format!("{url} 请求失败: {e}"),
                    key.as_deref(),
                );
            }
        }
    }
    Err(format!(
        "获取模型列表失败：{}",
        crate::sessions::redact_sensitive_text(&last_err)
    ))
}

/// 拉目录失败文案：reqwest Display 常带完整请求 URL，gemini 槽密钥在 query 里。
fn redact_fetch_error(message: &str, key: Option<&str>) -> String {
    let mut s = message.to_string();
    if let Some(k) = key.filter(|k| k.chars().count() >= 8) {
        s = s.replace(k, "[已隐藏密钥]");
    }
    crate::sessions::redact_sensitive_text(&s)
}

/// 解析失败时附进报错的响应预览：压平空白、截断、过脱敏（网关错误页可能回显 key）
fn body_preview(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = crate::sessions::redact_sensitive_text(&flat);
    const MAX: usize = 200;
    if redacted.chars().count() > MAX {
        let cut: String = redacted.chars().take(MAX).collect();
        format!("{cut}…")
    } else {
        redacted
    }
}

fn push_unique(out: &mut Vec<String>, s: &str) {
    let s = s.trim();
    if !s.is_empty() && !out.iter().any(|x| x == s) {
        out.push(s.to_string());
    }
}

/// 兼容三种常见返回：OpenAI/Anthropic 的 `data[].id`、Gemini 的 `models[].name`、裸字符串数组
fn parse_model_ids(v: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                push_unique(&mut out, id);
            } else if let Some(s) = item.as_str() {
                push_unique(&mut out, s);
            }
        }
    }
    if out.is_empty() {
        if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(name) = item.get("name").and_then(|i| i.as_str()) {
                    // Gemini 风格的 name 形如 "models/gemini-pro"，去掉前缀
                    push_unique(&mut out, name.strip_prefix("models/").unwrap_or(name));
                } else if let Some(s) = item.as_str() {
                    push_unique(&mut out, s);
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(arr) = v.as_array() {
            for item in arr {
                if let Some(s) = item.as_str() {
                    push_unique(&mut out, s);
                } else if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                    push_unique(&mut out, id);
                }
            }
        }
    }
    out
}

/// 按 openai → anthropic → gemini → responses 顺序拉目录，第一个成功的写入 catalogFromSlot。
#[tauri::command]
pub async fn fetch_gateway_catalog(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    gateway_id: String,
) -> Result<crate::profiles::Gateway, String> {
    let gw = store
        .list_gateways()?
        .into_iter()
        .find(|g| g.id == gateway_id)
        .ok_or("网关不存在")?;
    let order = [
        ("opencode", crate::gateway_store::Slot::Openai, None),
        ("claude-code", crate::gateway_store::Slot::Anthropic, None),
        ("gemini", crate::gateway_store::Slot::Gemini, None),
        ("codex", crate::gateway_store::Slot::Responses, None),
    ];
    let mut last_err = "没有可拉取的协议槽".to_string();
    for (agent, slot, protocol) in order {
        let Some(url) = crate::gateway_store::slot_url(&gw.slots, slot) else {
            continue;
        };
        match fetch_models(
            url.to_string(),
            None,
            None,
            Some(agent.to_string()),
            protocol,
            Some(gateway_id.clone()),
            Some(true),
        )
        .await
        {
            Ok(res) if !res.models.is_empty() => {
                return store.merge_fetched_models(&gateway_id, slot.as_str(), res.models);
            }
            Ok(_) => last_err = format!("{} 槽返回空目录", slot.as_str()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_openai_data_format() {
        let v = json!({"object": "list", "data": [{"id": "gpt-5"}, {"id": "gpt-5-codex"}, {"id": "gpt-5"}]});
        assert_eq!(parse_model_ids(&v), vec!["gpt-5", "gpt-5-codex"]);
    }

    #[test]
    fn parses_gemini_models_format_and_strips_prefix() {
        let v = json!({"models": [{"name": "models/gemini-3.6-flash"}, {"name": "models/gemini-3-pro"}]});
        assert_eq!(parse_model_ids(&v), vec!["gemini-3.6-flash", "gemini-3-pro"]);
    }

    #[test]
    fn parses_bare_string_array_and_tolerates_junk() {
        let v = json!(["claude-sonnet-4", " ", {"id": "claude-opus-4"}]);
        assert_eq!(parse_model_ids(&v), vec!["claude-sonnet-4", "claude-opus-4"]);
    }

    #[test]
    fn body_preview_flattens_whitespace() {
        assert_eq!(body_preview("<html>\n  <body>oops</body>\n</html>"), "<html> <body>oops</body> </html>");
    }

    #[test]
    fn fetch_error_redacts_key_in_reqwest_url() {
        let key = "super-secret-gateway-key-zzzz";
        let msg = format!(
            "https://generativelanguage.googleapis.com/v1beta/models 请求失败: error sending request for url (https://generativelanguage.googleapis.com/v1beta/models?key={key})"
        );
        let out = redact_fetch_error(&msg, Some(key));
        assert!(!out.contains(key), "{out}");
        assert!(out.contains("[已隐藏密钥]"), "{out}");
    }

    #[test]
    fn body_preview_truncates_long_body() {
        let long = "x".repeat(500);
        let out = body_preview(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 201);
    }

}
