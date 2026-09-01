//! 模型能力注册表（2026-08-17 起）：内置前缀表 + <config>/ccode/model-capabilities.json
//! 覆盖 + 关键词推断兜底，同 usage.rs「内置定价表 + pricing.json 覆盖」口径
//! （最长前缀匹配、剥中转 provider/ 前缀）。
//! 2026-08-31 起公共能力库下载顺带提取定价（models.dev cost / OpenRouter pricing →
//! 条目的 cost 字段），经 db_price_table 供 usage.rs 定价链消费。
//! 消费方：kimi（KIMI_MODEL_CAPABILITIES / KIMI_MODEL_MAX_CONTEXT_SIZE / [models.*] 的
//! capabilities）、codex（catalog context_window）、opencode（models 条目 reasoning/limit）。
//! 内置表宁缺毋滥：只收官方文档明确支持思考的模型，不确定的不收（落关键词推断），
//! 收错的能力声明（思考开了报错）比漏报更有害。

use std::path::{Path, PathBuf};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilityDto {
    pub model: String,
    pub thinking: bool,
    pub context: i64,
    pub tools: Option<bool>,
    pub vision: Option<bool>,
    pub video: Option<bool>,
    pub streaming: Option<bool>,
}

/// 单条能力：thinking = 支持思考档位；context = 上下文窗口、output = 输出上限、
/// vision = 图像输入。**全部字段 Option**：None = 「这层不知道」，查询链逐字段继续向下找
/// （网关只报了上下文不代表它否认推理能力——显式 false 与缺数据必须分开）；
/// 内置表不逐模型收 output/vision（宁缺毋滥同 context 口径）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCaps {
    pub thinking: Option<bool>,
    pub context: Option<i64>,
    pub output: Option<i64>,
    pub vision: Option<bool>,
    /// Grok 目录条目的 apiBackend（responses/chat_completions/messages）；
    /// 仅权威层（用户覆盖/网关实测缓存）可能有值，供设为全局与预览说实话
    pub api_backend: Option<String>,
}

const fn caps(thinking: bool, context: Option<i64>) -> ModelCaps {
    ModelCaps { thinking: Some(thinking), context, output: None, vision: None, api_backend: None }
}

/// 内置前缀表（最长前缀匹配：kimi-k2-thinking 优先于 kimi-k2）。
/// 数据口径：2026-08 各官方文档；context 只填确知值（kimi 系按官方上下文映射），
/// 其余 None 落 fallback_context_size 的保守默认。
const BUILTIN_CAPS: &[(&str, ModelCaps)] = &[
    // Kimi（官方：k3 = 1M 多模态思考，k2.5+ = 256K 思考，k2-thinking = 128K 思考，k2 = 128K 无思考）
    ("kimi-k3", caps(true, Some(1_048_576))),
    ("kimi-k2.7", caps(true, Some(262_144))),
    ("kimi-k2.6", caps(true, Some(262_144))),
    ("kimi-k2.5", caps(true, Some(262_144))),
    ("kimi-k2-thinking", caps(true, Some(131_072))),
    ("kimi-k2", caps(false, Some(131_072))),
    ("kimi-k1.5", caps(true, Some(131_072))),
    // DeepSeek（reasoner = r1 推理版；chat/v3 非思考）
    ("deepseek-reasoner", caps(true, None)),
    ("deepseek-r1", caps(true, None)),
    ("deepseek-chat", caps(false, None)),
    // OpenAI（gpt-5 全系 + o 系为 reasoning 模型；4o/4.1 不是）
    ("gpt-5", caps(true, None)),
    ("o1", caps(true, None)),
    ("o3", caps(true, None)),
    ("o4-mini", caps(true, None)),
    ("gpt-4o", caps(false, None)),
    ("gpt-4.1", caps(false, None)),
    // Anthropic（3.7 起全系 extended thinking；3.5 及更早不支持）
    ("claude-opus-4", caps(true, None)),
    ("claude-sonnet-4", caps(true, None)),
    ("claude-haiku-4", caps(true, None)),
    ("claude-3-7-sonnet", caps(true, None)),
    ("claude-3-5", caps(false, None)),
    // Google（2.5 起全系 thinking）
    ("gemini-3", caps(true, None)),
    ("gemini-2.5", caps(true, None)),
    // 智谱（4.5 起 hybrid thinking 可开关；z1 = 推理专版）
    ("glm-z1", caps(true, None)),
    ("glm-5", caps(true, None)),
    ("glm-4.7", caps(true, None)),
    ("glm-4.6", caps(true, None)),
    ("glm-4.5", caps(true, None)),
    // 阿里（qwen3 全系 hybrid thinking，qwen3-coder 除外；qwq = 推理专版）
    ("qwq", caps(true, None)),
    ("qwen3-coder", caps(false, None)),
    ("qwen3", caps(true, None)),
    // xAI（grok-3 起支持 reasoning）
    ("grok-4", caps(true, None)),
    ("grok-3", caps(true, None)),
];

/// 覆盖文件：<config>/ccode/model-capabilities.json
/// 格式：{"模型前缀": {"thinking": true, "context": 262144, "output": 8192, "vision": true}}（四个字段都可选）
fn override_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities.json"),
    )
}

/// 共享的「前缀 → 能力」JSON 解析（覆盖文件 / 网关实测缓存 / 公共能力库同一形状）
fn parse_caps_map(text: &str) -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return out;
    };
    if let Some(obj) = v.as_object() {
        for (prefix, caps_v) in obj {
            // 空前缀会匹配一切模型名，视为配置错误直接忽略（同 pricing 口径）
            if prefix.trim().is_empty() {
                continue;
            }
            let Some(c) = caps_v.as_object() else { continue };
            let thinking = c.get("thinking").and_then(|b| b.as_bool());
            let context = c.get("context").and_then(|n| n.as_i64()).filter(|n| *n > 0);
            let output = c.get("output").and_then(|n| n.as_i64()).filter(|n| *n > 0);
            let vision = c.get("vision").and_then(|b| b.as_bool());
            let api_backend = c
                .get("api_backend")
                .and_then(|b| b.as_str())
                .filter(|s| GROK_API_BACKENDS.contains(s))
                .map(str::to_string);
            // 至少一个字段有效才算条目；缺省字段 = None（这层不知道，查询链继续向下）
            out.push((
                prefix.to_lowercase(),
                ModelCaps { thinking, context, output, vision, api_backend },
            ));
        }
    }
    out
}

fn load_override() -> Vec<(String, ModelCaps)> {
    // 单测不读本机真实文件：链语义由 chain_field 单测覆盖，本机缓存会让期望值随机器漂移
    if cfg!(test) {
        return Vec::new();
    }
    let out = Vec::new();
    let Some(path) = override_path() else { return out };
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    parse_caps_map(&text)
        .into_iter()
        .map(|(p, c)| (p, c))
        .collect()
}

// ===== 外部能力数据源（2026-08-26；查询链：用户覆盖 > 网关实测缓存 > 公共能力库 > 内置表） =====
//
// ① 网关实测缓存（model-capabilities-relay.json）：「获取模型」时 fetch_models 顺带解析
//    OpenRouter 风格 /models 响应里的元数据落盘——网关自己最清楚它卖的模型（含网关改名模型），
//    是最准的来源；同一模型在不同网关能力不同时最新一次拉取赢。
// ② 公共能力库（model-capabilities-db.json）：用户主动下载，models.dev 优先、OpenRouter 回落
//    （models.dev 本机不可达已实证；两家解析进同一形状）。进程内缓存，下载后失效重载。

fn relay_cache_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities-relay.json"),
    )
}

fn db_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities-db.json"),
    )
}

fn load_relay_for(gateway_id: Option<&str>) -> Vec<(String, ModelCaps)> {
    if cfg!(test) {
        return Vec::new();
    }
    let Some(gid) = gateway_id.filter(|s| !s.is_empty()) else {
        return Vec::new(); // 无网关维度不读 relay（含无前缀旧键）
    };
    let Some(path) = relay_cache_path() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let prefix = format!("{gid}|");
    parse_caps_map(&text)
        .into_iter()
        .filter_map(|(k, c)| k.strip_prefix(&prefix).map(|rest| (rest.to_string(), c)))
        .collect()
}

pub(crate) fn purge_relay_for_gateway(gateway_id: &str) {
    let Some(path) = relay_cache_path() else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let Some(obj) = v.as_object_mut() else { return };
    let prefix = format!("{gateway_id}|");
    obj.retain(|k, _| !k.starts_with(&prefix));
    if let Ok(out) = serde_json::to_string_pretty(&v) {
        let _ = crate::profiles::atomic_write(&path, &out);
    }
}

static DB_CACHE: std::sync::OnceLock<std::sync::RwLock<Option<Vec<(String, ModelCaps)>>>> =
    std::sync::OnceLock::new();
static DB_PRICE_CACHE: std::sync::OnceLock<
    std::sync::RwLock<Option<Vec<(String, (f64, f64))>>>,
> = std::sync::OnceLock::new();

fn load_db() -> Vec<(String, ModelCaps)> {
    if cfg!(test) {
        return Vec::new(); // 同 load_override：单测不读本机真实文件
    }
    let cache = DB_CACHE.get_or_init(|| std::sync::RwLock::new(None));
    if let Some(cached) = cache.read().ok().and_then(|g| g.clone()) {
        return cached;
    }
    let parsed = db_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| parse_caps_map(&t))
        .unwrap_or_default();
    if let Ok(mut g) = cache.write() {
        *g = Some(parsed.clone());
    }
    parsed
}

/// 公共能力库的定价层（usage.rs 定价链消费：内置表 < 公共库 < 用户 pricing.json）。
/// 同一份 model-capabilities-db.json 里的 cost 字段；单测不读本机真实文件
pub(crate) fn db_price_table() -> Vec<(String, (f64, f64))> {
    if cfg!(test) {
        return Vec::new();
    }
    let cache = DB_PRICE_CACHE.get_or_init(|| std::sync::RwLock::new(None));
    if let Some(cached) = cache.read().ok().and_then(|g| g.clone()) {
        return cached;
    }
    let parsed = db_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| parse_price_map(&t))
        .unwrap_or_default();
    if let Ok(mut g) = cache.write() {
        *g = Some(parsed.clone());
    }
    parsed
}

fn invalidate_db_cache() {
    if let Some(c) = DB_CACHE.get() {
        if let Ok(mut g) = c.write() {
            *g = None;
        }
    }
    if let Some(c) = DB_PRICE_CACHE.get() {
        if let Ok(mut g) = c.write() {
            *g = None;
        }
    }
}

/// grok 的 apiBackend 合法值（grok-build parse_remote_model_value 实证闭集）
const GROK_API_BACKENDS: [&str; 3] = ["chat_completions", "responses", "messages"];

/// OpenRouter 风格 /models 响应 → 能力表（网关实测缓存与公共库回落共用）。
/// 只提取能力字段；一个字段都没有的条目丢弃（纯 id 列表不动缓存）。
/// context 兼容 grok 目录的驼峰/snake 别名（contextWindow/context_window/
/// _meta.totalContextTokens，与 grok parse_remote_model_value 同口径）；
/// apiBackend/api_backend 只收闭集值
pub(crate) fn parse_openrouter_models(v: &serde_json::Value) -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    let Some(arr) = v.get("data").and_then(|d| d.as_array()) else {
        return out;
    };
    for item in arr {
        let Some(id) = item.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let context = item
            .get("context_length")
            .and_then(|n| n.as_i64())
            .or_else(|| {
                item.get("top_provider")?
                    .get("context_length")?
                    .as_i64()
            })
            // grok 目录别名（parse_remote_model_value 同口径链）
            .or_else(|| item.get("contextWindow")?.as_i64())
            .or_else(|| item.get("context_window")?.as_i64())
            .or_else(|| item.get("_meta")?.get("totalContextTokens")?.as_i64())
            .filter(|n| *n > 0);
        let output = item
            .get("top_provider")
            .and_then(|t| t.get("max_completion_tokens"))
            .and_then(|n| n.as_i64())
            .or_else(|| item.get("max_output_tokens").and_then(|n| n.as_i64()))
            .filter(|n| *n > 0);
        let vision = item
            .get("architecture")
            .and_then(|a| a.get("input_modalities"))
            .and_then(|m| m.as_array())
            .map(|ms| ms.iter().any(|m| m.as_str() == Some("image")));
        // supported_parameters 字段存在 → 按有没有 reasoning 给显式 true/false；
        // 字段整个缺席 → None（这层不知道，查询链继续向下，不能错记成 false）
        let thinking = item
            .get("supported_parameters")
            .and_then(|p| p.as_array())
            .map(|ps| {
                ps.iter()
                    .any(|p| matches!(p.as_str(), Some("reasoning") | Some("include_reasoning")))
            });
        let api_backend = item
            .get("apiBackend")
            .or_else(|| item.get("api_backend"))
            .and_then(|b| b.as_str())
            .filter(|s| GROK_API_BACKENDS.contains(s))
            .map(str::to_string);
        if context.is_none()
            && output.is_none()
            && vision.is_none()
            && thinking.is_none()
            && api_backend.is_none()
        {
            continue;
        }
        out.push((
            normalize(id),
            ModelCaps {
                thinking,
                context,
                output,
                vision,
                api_backend,
            },
        ));
    }
    out
}

/// models.dev 的 api.json（{provider: {models: {id: {...}}}}）→ 同一能力表形状
fn parse_models_dev(v: &serde_json::Value) -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    let Some(providers) = v.as_object() else {
        return out;
    };
    for (_provider, pv) in providers {
        let Some(models) = pv.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (id, mv) in models {
            let context = mv
                .get("limit")
                .and_then(|l| l.get("context"))
                .and_then(|n| n.as_i64())
                .filter(|n| *n > 0);
            let output = mv
                .get("limit")
                .and_then(|l| l.get("output"))
                .and_then(|n| n.as_i64())
                .filter(|n| *n > 0);
            let vision = mv
                .get("modalities")
                .and_then(|m| m.get("input"))
                .and_then(|i| i.as_array())
                .map(|ms| ms.iter().any(|m| m.as_str() == Some("image")));
            let thinking = mv.get("reasoning").and_then(|b| b.as_bool());
            if context.is_none() && output.is_none() && vision.is_none() && thinking.is_none() {
                continue;
            }
            out.push((
                normalize(id),
                ModelCaps {
                    thinking,
                    context,
                    output,
                    vision,
                    api_backend: None, // models.dev 公共库不携带 wire 后端
                },
            ));
        }
    }
    out
}

// ===== 定价提取（2026-08-31）：同一份公共库响应顺带落 cost，usage.rs 定价链消费 =====

/// models.dev 条目的 cost.{input,output}（美元/每百万 token）→ (id, (输入价, 输出价))
fn parse_models_dev_prices(v: &serde_json::Value) -> Vec<(String, (f64, f64))> {
    let mut out = Vec::new();
    let Some(providers) = v.as_object() else {
        return out;
    };
    for (_provider, pv) in providers {
        let Some(models) = pv.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (id, mv) in models {
            let Some(cost) = mv.get("cost") else { continue };
            let pair = match (
                cost.get("input").and_then(|n| n.as_f64()),
                cost.get("output").and_then(|n| n.as_f64()),
            ) {
                (Some(i), Some(o)) if i.is_finite() && i >= 0.0 && o.is_finite() && o >= 0.0 => {
                    (i, o)
                }
                _ => continue,
            };
            out.push((normalize(id), pair));
        }
    }
    out
}

/// OpenRouter 风格条目的 pricing.{prompt,completion}（每 token 美元，字符串）→
/// 每百万 token 价格。两家数据源解析进同一形状
fn parse_openrouter_prices(v: &serde_json::Value) -> Vec<(String, (f64, f64))> {
    let mut out = Vec::new();
    let Some(arr) = v.get("data").and_then(|d| d.as_array()) else {
        return out;
    };
    for item in arr {
        let Some(id) = item.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let per_million = |key: &str| {
            item.get("pricing")?
                .get(key)?
                .as_str()?
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n * 1_000_000.0)
        };
        let (Some(i), Some(o)) = (per_million("prompt"), per_million("completion")) else {
            continue;
        };
        out.push((normalize(id), (i, o)));
    }
    out
}

/// 公共库落盘文件里的 cost 字段解析（{"模型": {"cost": [输入价, 输出价], ...}}）
fn parse_price_map(text: &str) -> Vec<(String, (f64, f64))> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return out;
    };
    if let Some(obj) = v.as_object() {
        for (prefix, entry) in obj {
            // 空前缀会匹配一切模型名，视为配置错误直接忽略（同 caps 口径）
            if prefix.trim().is_empty() {
                continue;
            }
            let Some(pair) = entry.get("cost").and_then(|c| c.as_array()) else {
                continue;
            };
            if pair.len() != 2 {
                continue;
            }
            if let (Some(i), Some(o)) = (pair[0].as_f64(), pair[1].as_f64()) {
                if i.is_finite() && i >= 0.0 && o.is_finite() && o >= 0.0 {
                    out.push((prefix.to_lowercase(), (i, o)));
                }
            }
        }
    }
    out
}

/// fetch_models 顺带调用：把网关 /models 响应里的元数据合并进实测缓存。
/// 键为 `{gatewayId}|{model}`；无网关 id 不写（禁止再写无前缀键互踩）。
pub(crate) fn record_relay_models(v: &serde_json::Value, gateway_id: Option<&str>) {
    let Some(gid) = gateway_id.filter(|s| !s.is_empty()) else { return };
    let Some(path) = relay_cache_path() else { return };
    record_relay_models_to(&path, v, gid);
}

/// record_relay_models 的可注入内核（测试用）
fn record_relay_models_to(path: &Path, v: &serde_json::Value, gateway_id: &str) {
    let fresh = parse_openrouter_models(v);
    if fresh.is_empty() {
        return;
    }
    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for (id, c) in fresh {
        map.insert(
            format!("{gateway_id}|{id}"),
            serde_json::json!({
                "thinking": c.thinking,
                "context": c.context,
                "output": c.output,
                "vision": c.vision,
            }),
        );
    }
    let Ok(text) =
        serde_json::to_string_pretty(&serde_json::Value::Object(map)).map_err(|e| e.to_string())
    else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = crate::profiles::atomic_write(path, &text);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDbStatusDto {
    pub downloaded: bool,
    pub models: usize,
    /// 带定价（cost 字段）的条目数：统计页费用估算的数据源覆盖度
    pub priced_models: usize,
    /// 下载时间（本地文件 mtime，RFC3339）
    pub downloaded_at: Option<String>,
}

/// 公共能力库状态（设置/配置页展示用）
#[tauri::command]
pub fn model_db_status() -> ModelDbStatusDto {
    let Some(path) = db_path() else {
        return ModelDbStatusDto {
            downloaded: false,
            models: 0,
            priced_models: 0,
            downloaded_at: None,
        };
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return ModelDbStatusDto {
            downloaded: false,
            models: 0,
            priced_models: 0,
            downloaded_at: None,
        };
    };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let models = parse_caps_map(&text).len();
    let priced_models = parse_price_map(&text).len();
    let downloaded_at = meta
        .modified()
        .ok()
        .and_then(|t| {
            let secs = t
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs() as i64;
            chrono::DateTime::from_timestamp(secs, 0).map(|d| d.to_rfc3339())
        });
    ModelDbStatusDto {
        downloaded: true,
        models,
        priced_models,
        downloaded_at,
    }
}

/// models.dev 本机常超时；先 8s 再换 OpenRouter，避免空等 60s。
const MODELS_DEV_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
const OPENROUTER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 下载公共模型能力库：models.dev 优先（社区中立库），不可达回落 OpenRouter /models
/// （两家解析进同一形状；本机实测 models.dev 直连超时、OpenRouter 可达）。
/// 能力之外顺带提取定价（cost），统计页费用估算与能力声明共用同一份快照
#[tauri::command]
pub async fn download_model_db() -> Result<ModelDbStatusDto, String> {
    let mut last_err = String::new();
    #[allow(clippy::type_complexity)]
    let mut parsed: Option<(Vec<(String, ModelCaps)>, Vec<(String, (f64, f64))>)> = None;
    for (url, is_models_dev) in [
        ("https://models.dev/api.json", true),
        ("https://openrouter.ai/api/v1/models", false),
    ] {
        let timeout = if is_models_dev {
            MODELS_DEV_TIMEOUT
        } else {
            OPENROUTER_TIMEOUT
        };
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await
            {
                Ok(v) => {
                    let entries = if is_models_dev {
                        parse_models_dev(&v)
                    } else {
                        parse_openrouter_models(&v)
                    };
                    if entries.is_empty() {
                        last_err = format!("{url} 响应解析为空");
                        continue;
                    }
                    // 定价提取失败不判死：能力库仍是主用途，cost 缺失 = 那层不知道
                    let prices = if is_models_dev {
                        parse_models_dev_prices(&v)
                    } else {
                        parse_openrouter_prices(&v)
                    };
                    parsed = Some((entries, prices));
                    break;
                }
                Err(e) => last_err = format!("{url} 解析失败: {e}"),
            },
            Ok(resp) => last_err = format!("{url} 返回 HTTP {}", resp.status()),
            Err(e) => last_err = format!("{url} 请求失败: {e}"),
        }
    }
    let (entries, prices) = parsed.ok_or_else(|| format!("模型能力库下载失败：{last_err}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = db_path().ok_or("无法确定平台配置目录")?;
        let price_of_id: std::collections::HashMap<&str, (f64, f64)> =
            prices.iter().map(|(id, p)| (id.as_str(), *p)).collect();
        let mut map = serde_json::Map::new();
        for (id, c) in &entries {
            let mut entry = serde_json::json!({
                "thinking": c.thinking,
                "context": c.context,
                "output": c.output,
                "vision": c.vision,
            });
            if let Some((i, o)) = price_of_id.get(id.as_str()) {
                entry["cost"] = serde_json::json!([i, o]);
            }
            map.insert(id.clone(), entry);
        }
        // 只有定价、没有能力字段的条目也保留（费用估算不需要能力声明）
        for (id, p) in &prices {
            if !map.contains_key(id) {
                map.insert(id.clone(), serde_json::json!({"cost": [p.0, p.1]}));
            }
        }
        let text = serde_json::to_string_pretty(&serde_json::Value::Object(map))
            .map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        crate::profiles::atomic_write(&path, &text)?;
        invalidate_db_cache();
        Ok(model_db_status())
    })
    .await
    .map_err(|e| format!("保存模型能力库失败: {e}"))?
}

/// 剥中转/聚合的 provider 前缀（zetatechs/kimi-k3、openai/gpt-5），按末段模型名匹配
/// （同 usage.rs price_of 口径）
fn normalize(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_lowercase()
}

/// 前缀表查询：表内取最长命中的前缀
fn longest_match<'a>(table: &'a [(String, ModelCaps)], model: &str) -> Option<&'a ModelCaps> {
    table
        .iter()
        .filter(|(p, _)| model.starts_with(p.as_str()))
        .max_by_key(|(p, _)| p.len())
        .map(|(_, c)| c)
}

/// 逐字段链式查询内核（测试可注入表）：每层取最长前缀命中，命中但字段为 None
/// （这层不知道）时继续向下——不是整条命中即返回
fn chain_field<T>(
    tables: &[Vec<(String, ModelCaps)>],
    model: &str,
    f: impl Fn(&ModelCaps) -> Option<T>,
) -> Option<T> {
    let m = normalize(model);
    for table in tables {
        if let Some(c) = longest_match(table, &m) {
            if let Some(v) = f(c) {
                return Some(v);
            }
        }
    }
    None
}

/// 逐字段查询链：用户覆盖 > 网关实测缓存（需 gateway_id）> 公共能力库 > 内置表。
fn lookup_field_for<T>(
    model: &str,
    gateway_id: Option<&str>,
    f: impl Fn(&ModelCaps) -> Option<T>,
) -> Option<T> {
    let tables: [Vec<(String, ModelCaps)>; 4] = [
        load_override(),
        load_relay_for(gateway_id),
        load_db(),
        BUILTIN_CAPS
            .iter()
            .map(|(p, c)| (p.to_string(), c.clone()))
            .collect(),
    ];
    chain_field(&tables, model, f)
}

/// 上下文窗口（仅限权威层：用户覆盖 + 网关实测缓存，公共库/内置表/关键词一律不算）。
/// 供 grok「设为全局」写 [model.*].context_window——grok 里 config 的 [model.*] 优先级
/// 高于中转 /models 目录，估值层不配覆盖目录声明；这两层都不知道就不写（grok 按目录或
/// 256_000 默认计）
pub(crate) fn model_context_size_authoritative_for(
    model: &str,
    gateway_id: Option<&str>,
) -> Option<i64> {
    let tables = [load_override(), load_relay_for(gateway_id)];
    chain_field(&tables, model, |c| c.context)
}

/// Grok 目录声明的 apiBackend（仅权威层：用户覆盖/网关实测缓存）。
/// 供预览说实话（「目录已声明 responses」）与设为全局参考
pub(crate) fn model_api_backend_for(model: &str, gateway_id: Option<&str>) -> Option<String> {
    let tables = [load_override(), load_relay_for(gateway_id)];
    chain_field(&tables, model, |c| c.api_backend.clone())
}

/// 关键词推断兜底（注册表未命中时）：覆盖中转改名/全新模型的常见命名。
/// 新推理模型出现时优先补内置表（准确），关键词表只兜底。
fn keyword_thinking(model: &str) -> bool {
    let m = normalize(model);
    m.contains("thinking")
        || m.contains("reasoner")
        || m.contains("-r1")
        || m.contains("qwq")
        || m.contains("glm-z1")
        || m.starts_with("kimi-k2.5")
        || m.starts_with("kimi-k2.6")
        || m.starts_with("kimi-k2.7")
        || m.starts_with("kimi-k3")
}

/// 保守默认上下文映射（注册表条目不填 context 或未命中时的兜底）：
/// kimi 系按官方映射，其余 128K 保守值
fn fallback_context_size(model: &str) -> i64 {
    let m = normalize(model);
    if m.starts_with("kimi-k3") {
        1_048_576
    } else if m.starts_with("kimi-k2.6") || m.starts_with("kimi-k2.7") {
        262_144
    } else {
        131_072
    }
}

/// 模型是否支持思考：逐字段查询链 → 关键词推断兜底
pub fn model_thinking(model: &str) -> bool {
    model_thinking_for(model, None)
}

pub fn model_thinking_for(model: &str, gateway_id: Option<&str>) -> bool {
    lookup_field_for(model, gateway_id, |c| c.thinking).unwrap_or_else(|| keyword_thinking(model))
}

/// 模型上下文窗口：逐字段查询链 → 保守默认映射
pub fn model_context_size(model: &str) -> i64 {
    model_context_size_for(model, None)
}

pub fn model_context_size_for(model: &str, gateway_id: Option<&str>) -> i64 {
    lookup_field_for(model, gateway_id, |c| c.context).unwrap_or_else(|| fallback_context_size(model))
}

/// 输出上限兜底：models.dev 上多数 chat 模型的常见值，保守不越界
/// （opencode 拿 limit.output 当 max output tokens 用，宁小勿大）
const DEFAULT_OUTPUT_LIMIT: i64 = 8192;

/// 模型输出上限：逐字段查询链 → 保守默认
pub fn model_output_limit(model: &str) -> i64 {
    model_output_limit_for(model, None)
}

pub fn model_output_limit_for(model: &str, gateway_id: Option<&str>) -> i64 {
    lookup_field_for(model, gateway_id, |c| c.output).unwrap_or(DEFAULT_OUTPUT_LIMIT)
}

/// 是否支持图像输入：逐字段查询链有显式声明（true/false 都算数——网关如实报了
/// input_modalities 就听它的）→ 未声明时回落确知多模态清单（宁缺毋滥——给纯文本
/// 模型声明图像输入会让用户拖图进去才报错）。
/// codex catalog 的 input_modalities / kimi capabilities image_in / opencode modalities 用
pub fn model_supports_vision(model: &str) -> bool {
    model_supports_vision_for(model, None)
}

pub fn model_supports_vision_for(model: &str, gateway_id: Option<&str>) -> bool {
    if let Some(v) = lookup_field_for(model, gateway_id, |c| c.vision) {
        return v;
    }
    let normalized = normalize(model);
    normalized.contains("kimi-k3")
        || normalized.starts_with("gemini-2.5")
        || normalized.starts_with("gemini-3")
        || normalized.starts_with("gpt-4o")
        || normalized.starts_with("claude-opus-4")
}

pub fn model_capability(model: &str) -> ModelCapabilityDto {
    model_capability_for(model, None)
}

pub fn model_capability_for(model: &str, gateway_id: Option<&str>) -> ModelCapabilityDto {
    let normalized = normalize(model);
    // 与 model_supports_vision 同一判定，单一出处
    let vision = if model_supports_vision_for(model, gateway_id) {
        Some(true)
    } else {
        None
    };
    let video = if normalized.contains("kimi-k3") { Some(true) } else { None };
    let tools = if normalized.contains("coder")
        || normalized.contains("gpt")
        || normalized.contains("claude")
        || normalized.contains("gemini")
        || normalized.contains("kimi")
        || normalized.contains("qwen")
        || normalized.contains("deepseek")
        || normalized.contains("grok")
        || normalized.contains("glm")
    {
        Some(true)
    } else {
        None
    };
    ModelCapabilityDto {
        model: model.to_string(),
        thinking: model_thinking_for(model, gateway_id),
        context: model_context_size_for(model, gateway_id),
        tools,
        vision,
        video,
        streaming: Some(true),
    }
}

#[tauri::command]
pub fn model_capability_brief(gateway_id: String, model_id: String) -> ModelCapabilityDto {
    model_capability_for(&model_id, Some(gateway_id.as_str()))
}

#[tauri::command]
pub fn model_capabilities(
    models: Vec<String>,
    gateway_id: Option<String>,
) -> Vec<ModelCapabilityDto> {
    models
        .iter()
        .map(|model| model_capability_for(model, gateway_id.as_deref()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_table_hits_known_models() {
        assert!(model_thinking("kimi-k3"));
        assert!(model_thinking("kimi-k2-thinking"));
        assert!(!model_thinking("kimi-k2"));
        assert!(model_thinking("deepseek-reasoner"));
        assert!(!model_thinking("deepseek-chat"));
        assert!(model_thinking("gpt-5.1"));
        assert!(!model_thinking("gpt-4o"));
        assert!(model_thinking("claude-sonnet-4-5"));
        assert!(!model_thinking("claude-3-5-sonnet-20241022"));
        assert!(model_thinking("glm-4.6"));
        assert!(model_thinking("qwen3-32b"));
        assert!(!model_thinking("qwen3-coder-plus"));
        assert!(model_thinking("grok-4-1"));
        assert!(model_supports_vision("kimi-k3"));
        assert!(model_capability("kimi-k3").thinking);
    }

    #[test]
    fn provider_prefix_stripped_before_match() {
        assert!(model_thinking("zetatechs/kimi-k3"));
        assert!(model_thinking("openai/gpt-5-codex"));
        assert_eq!(model_context_size("some-relay/kimi-k2.6"), 262_144);
    }

    #[test]
    fn keyword_fallback_for_unknown_models() {
        // 表外模型落关键词推断
        assert!(model_thinking("some-new-model-thinking-v2"));
        assert!(model_thinking("qwq-32b-preview"));
        assert!(!model_thinking("some-random-model"));
    }

    #[test]
    fn longest_prefix_wins_over_shorter() {
        // kimi-k2-thinking 必须命中 thinking 条目，而不是被 kimi-k2（无思考）截胡
        assert!(model_thinking("kimi-k2-thinking"));
        assert!(!model_thinking("kimi-k2-0905-preview"));
    }

    #[test]
    fn output_limit_falls_back_to_conservative_default() {
        // 内置表不收 output（None）→ 一律落 8192 保守默认；覆盖文件可逐前缀配
        assert_eq!(model_output_limit("kimi-k3"), 8192);
        assert_eq!(model_output_limit("gpt-5"), 8192);
        assert_eq!(model_output_limit("some-relay/unknown-model"), 8192);
    }

    #[test]
    fn parse_openrouter_models_extracts_capability_fields() {
        let v = serde_json::json!({"data": [
            {
                "id": "deepseek/deepseek-v3.2",
                "context_length": 163840,
                "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                "top_provider": {"max_completion_tokens": 147456},
                "supported_parameters": ["tools", "reasoning", "structured_outputs"]
            },
            {
                "id": "someone/vision-x",
                "context_length": 262144,
                "architecture": {"input_modalities": ["text", "image"]},
                "supported_parameters": ["tools"]
            },
            {"id": "bare-id-only"}
        ]});
        let map: std::collections::HashMap<String, ModelCaps> =
            parse_openrouter_models(&v).into_iter().collect();
        let d = &map["deepseek-v3.2"];
        assert_eq!(d.thinking, Some(true), "supported_parameters 含 reasoning → 思考");
        assert_eq!(d.context, Some(163840));
        assert_eq!(d.output, Some(147456));
        assert_eq!(d.vision, Some(false));
        let vx = &map["vision-x"];
        // supported_parameters 在场但没有 reasoning → 显式 false（网关如实声明了参数全集）
        assert_eq!(vx.thinking, Some(false));
        assert_eq!(vx.vision, Some(true));
        assert_eq!(vx.context, Some(262144));
        // 纯 id 无元数据的条目丢弃
        assert!(!map.contains_key("bare-id-only"));
    }

    #[test]
    fn openrouter_entry_without_supported_parameters_leaves_thinking_unknown() {
        // supported_parameters 整个缺席 = 这层不知道，必须 None（不能错记 false
        // 挡住公共库的正确答案）
        let v = serde_json::json!({"data": [{
            "id": "relay/partial-model",
            "context_length": 50000,
            "architecture": {"input_modalities": ["text"]}
        }]});
        let map = parse_openrouter_models(&v);
        assert_eq!(map[0].1.thinking, None);
        assert_eq!(map[0].1.context, Some(50000));
    }

    #[test]
    fn parse_openrouter_models_accepts_grok_catalog_aliases() {
        // grok 目录字段（与 grok parse_remote_model_value 同口径）：驼峰/蛇形/_meta 的
        // context 别名 + apiBackend 闭集
        let v = serde_json::json!({"data": [
            {"id": "relay/grok-fast", "contextWindow": 262144, "apiBackend": "responses"},
            {"id": "relay/grok-snake", "context_window": 131072},
            {"id": "relay/grok-meta", "_meta": {"totalContextTokens": 200000}},
            {"id": "relay/bad-backend", "apiBackend": "weird"}
        ]});
        let map: std::collections::HashMap<String, ModelCaps> =
            parse_openrouter_models(&v).into_iter().collect();
        assert_eq!(map["grok-fast"].context, Some(262144));
        assert_eq!(map["grok-fast"].api_backend.as_deref(), Some("responses"));
        assert_eq!(map["grok-snake"].context, Some(131072));
        assert_eq!(map["grok-meta"].context, Some(200000));
        // 闭集外的 apiBackend 丢弃；该条目只有这一个字段 → 整条不沉淀
        assert!(!map.contains_key("bad-backend"));
    }

    #[test]
    fn authoritative_context_ignores_estimated_layers() {
        // cfg!(test) 下文件型加载器不读本机真实缓存 → 用户覆盖与网关缓存都为空；
        // kimi-k3 在内置表/兜底里有值（1M），权威层访问器必须仍返回 None——
        // 估值层不配写进 grok config（那里优先级高于中转目录）
        assert_eq!(model_context_size_authoritative_for("kimi-k3", None), None);
        assert_eq!(
            model_context_size_authoritative_for("openai/gpt-5", Some("gw")),
            None
        );
    }

    #[test]
    fn chain_field_falls_through_per_field_not_per_entry() {
        // 用户场景：网关缓存只有 context（其余 None），公共库同模型有 thinking——
        // 逐字段向下补：context 用网关实测，thinking 用公共库
        let relay = vec![(
            "model-x".to_string(),
            ModelCaps { thinking: None, context: Some(99999), output: None, vision: None, api_backend: None },
        )];
        let db = vec![(
            "model-x".to_string(),
            ModelCaps { thinking: Some(true), context: Some(11111), output: Some(4096), vision: None, api_backend: None },
        )];
        let tables = [relay, db];
        assert_eq!(chain_field(&tables, "model-x", |c| c.context), Some(99999));
        assert_eq!(chain_field(&tables, "model-x", |c| c.thinking), Some(true));
        assert_eq!(chain_field(&tables, "model-x", |c| c.output), Some(4096));
        assert_eq!(chain_field(&tables, "model-x", |c| c.vision), None);
    }

    #[test]
    fn parse_models_dev_extracts_capability_fields() {
        let v = serde_json::json!({
            "moonshot": {"models": {"kimi-k3": {
                "reasoning": true,
                "limit": {"context": 1048576, "output": 8192},
                "modalities": {"input": ["text", "image"], "output": ["text"]}
            }}},
            "openai": {"models": {"gpt-5": {
                "reasoning": true,
                "limit": {"context": 400000, "output": 128000},
                "modalities": {"input": ["text"], "output": ["text"]}
            }}}
        });
        let map: std::collections::HashMap<String, ModelCaps> =
            parse_models_dev(&v).into_iter().collect();
        let k = &map["kimi-k3"];
        assert_eq!(k.thinking, Some(true));
        assert_eq!(k.context, Some(1_048_576));
        assert_eq!(k.vision, Some(true));
        let g = &map["gpt-5"];
        assert_eq!(g.output, Some(128000));
        assert_eq!(g.vision, Some(false));
    }

    #[test]
    fn parse_models_dev_prices_extracts_cost() {
        let v = serde_json::json!({
            "moonshot": {"models": {
                "kimi-k3": {"cost": {"input": 3.0, "output": 15.0, "cache_read": 0.3}},
                "kimi-free-x": {"cost": {"input": 0, "output": 0}},
                "kimi-no-cost": {"reasoning": true},
                "kimi-bad-cost": {"cost": {"input": -1, "output": 2}}
            }}
        });
        let map: std::collections::HashMap<String, (f64, f64)> =
            parse_models_dev_prices(&v).into_iter().collect();
        assert_eq!(map["kimi-k3"], (3.0, 15.0));
        assert_eq!(map["kimi-free-x"], (0.0, 0.0), "免费模型的如实 0 价保留");
        assert!(!map.contains_key("kimi-no-cost"), "无 cost = 这层不知道");
        assert!(!map.contains_key("kimi-bad-cost"), "非法数值丢弃");
    }

    #[test]
    fn parse_openrouter_prices_converts_per_token_to_per_million() {
        let v = serde_json::json!({"data": [
            {"id": "anthropic/claude-sonnet-5", "pricing": {"prompt": "0.000002", "completion": "0.00001"}},
            {"id": "openai/gpt-5.2", "pricing": {"prompt": "0.00000175", "completion": "0.000014"}},
            {"id": "bare/no-pricing"}
        ]});
        let map: std::collections::HashMap<String, (f64, f64)> =
            parse_openrouter_prices(&v).into_iter().collect();
        assert_eq!(map["claude-sonnet-5"], (2.0, 10.0));
        assert_eq!(map["gpt-5.2"], (1.75, 14.0));
        assert!(!map.contains_key("no-pricing"));
    }

    #[test]
    fn parse_price_map_reads_cost_field() {
        // 公共库落盘形状：能力与 cost 同条目共存；无 cost 的条目不产生定价
        let text = r#"{
            "kimi-k3": {"thinking": true, "cost": [3.0, 15.0]},
            "gpt-5": {"thinking": true, "context": 400000},
            "price-only-x": {"cost": [0.5, 1.5]},
            "": {"cost": [9.0, 9.0]}
        }"#;
        let map: std::collections::HashMap<String, (f64, f64)> =
            parse_price_map(text).into_iter().collect();
        assert_eq!(map.len(), 2);
        assert_eq!(map["kimi-k3"], (3.0, 15.0));
        assert_eq!(map["price-only-x"], (0.5, 1.5), "纯定价条目同样入定价层");
    }

    #[test]
    fn relay_cache_record_merges_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!("ccode-mr-{}", uuid::Uuid::new_v4()));
        let path = dir.join("relay.json");
        let v = serde_json::json!({"data": [{
            "id": "relay/custom-model-x",
            "context_length": 99999,
            "architecture": {"input_modalities": ["text", "image"]},
            "supported_parameters": ["tools", "reasoning"]
        }]});
        record_relay_models_to(&path, &v, "gw1");
        let loaded = parse_caps_map(&std::fs::read_to_string(&path).unwrap());
        let c = longest_match(&loaded, "gw1|custom-model-x").unwrap();
        assert!(c.thinking == Some(true) && c.vision == Some(true) && c.context == Some(99999));
        // 再记一条别的模型：合并不覆盖
        let v2 = serde_json::json!({"data": [{"id": "other", "context_length": 1000}]});
        record_relay_models_to(&path, &v2, "gw1");
        let loaded = parse_caps_map(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(loaded.len(), 2);
        // 纯 id 列表不动缓存
        let before = std::fs::read_to_string(&path).unwrap();
        record_relay_models_to(&path, &serde_json::json!({"data": [{"id": "no-meta"}]}), "gw1");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn context_size_chain() {
        assert_eq!(model_context_size("kimi-k3"), 1_048_576);
        assert_eq!(model_context_size("kimi-k2.7"), 262_144);
        // 表内 thinking 条目 context=None → 保守默认
        assert_eq!(model_context_size("gpt-5"), 131_072);
        // 表外模型 → fallback 映射
        assert_eq!(model_context_size("unknown-model"), 131_072);
    }
}
