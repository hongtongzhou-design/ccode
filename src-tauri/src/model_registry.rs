//! 模型能力注册表（2026-08-17 起）：内置前缀表 + <config>/ccode/model-capabilities.json
//! 覆盖 + 关键词推断兜底，同 pricing.rs「内置定价表 + pricing.json 覆盖」口径
//! （最长前缀匹配、剥中转 provider/ 前缀）。
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
/// vision = 图像输入（None = 走保守默认/确知清单）。output 为 opencode 的 limit.output
/// 服务（1.18 起 schema 必填），内置表不逐模型收（宁缺毋滥同 context 口径）；
/// 三个外部数据源（用户覆盖文件 > 网关实测缓存 > 公共能力库）可全字段覆盖
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCaps {
    pub thinking: bool,
    pub context: Option<i64>,
    pub output: Option<i64>,
    pub vision: Option<bool>,
}

const fn caps(thinking: bool, context: Option<i64>) -> ModelCaps {
    ModelCaps { thinking, context, output: None, vision: None }
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
            // 至少一个字段有效才算条目；thinking 缺省按 false（显式关思考也是合法覆盖）
            out.push((
                prefix.to_lowercase(),
                ModelCaps {
                    thinking: thinking.unwrap_or(false),
                    context,
                    output,
                    vision,
                },
            ));
        }
    }
    out
}

fn load_override() -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
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

fn load_relay_cache() -> Vec<(String, ModelCaps)> {
    let Some(path) = relay_cache_path() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_caps_map(&text)
}

static DB_CACHE: std::sync::OnceLock<std::sync::RwLock<Option<Vec<(String, ModelCaps)>>>> =
    std::sync::OnceLock::new();

fn load_db() -> Vec<(String, ModelCaps)> {
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

fn invalidate_db_cache() {
    if let Some(c) = DB_CACHE.get() {
        if let Ok(mut g) = c.write() {
            *g = None;
        }
    }
}

/// OpenRouter 风格 /models 响应 → 能力表（网关实测缓存与公共库回落共用）。
/// 只提取四个能力字段；一个字段都没有的条目丢弃（纯 id 列表不动缓存）
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
        let thinking = item
            .get("supported_parameters")
            .and_then(|p| p.as_array())
            .map(|ps| {
                ps.iter()
                    .any(|p| matches!(p.as_str(), Some("reasoning") | Some("include_reasoning")))
            });
        if context.is_none() && output.is_none() && vision.is_none() && thinking.is_none() {
            continue;
        }
        out.push((
            normalize(id),
            ModelCaps {
                thinking: thinking.unwrap_or(false),
                context,
                output,
                vision,
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
                    thinking: thinking.unwrap_or(false),
                    context,
                    output,
                    vision,
                },
            ));
        }
    }
    out
}

/// fetch_models 顺带调用：把网关 /models 响应里的元数据合并进实测缓存（同模型最新赢）。
/// 只写能力字段；纯 id 列表（无元数据）不动缓存
pub(crate) fn record_relay_models(v: &serde_json::Value) {
    let Some(path) = relay_cache_path() else { return };
    record_relay_models_to(&path, v);
}

/// record_relay_models 的可注入内核（测试用）
fn record_relay_models_to(path: &Path, v: &serde_json::Value) {
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
            id,
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
            downloaded_at: None,
        };
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return ModelDbStatusDto {
            downloaded: false,
            models: 0,
            downloaded_at: None,
        };
    };
    let models = std::fs::read_to_string(&path)
        .map(|t| parse_caps_map(&t).len())
        .unwrap_or(0);
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
        downloaded_at,
    }
}

const MODEL_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 下载公共模型能力库：models.dev 优先（社区中立库），不可达回落 OpenRouter /models
/// （两家解析进同一形状；本机实测 models.dev 直连超时、OpenRouter 可达）
#[tauri::command]
pub async fn download_model_db() -> Result<ModelDbStatusDto, String> {
    let client = reqwest::Client::builder()
        .timeout(MODEL_DB_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut last_err = String::new();
    let mut parsed: Option<Vec<(String, ModelCaps)>> = None;
    for (url, is_models_dev) in [
        ("https://models.dev/api.json", true),
        ("https://openrouter.ai/api/v1/models", false),
    ] {
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
                    parsed = Some(entries);
                    break;
                }
                Err(e) => last_err = format!("{url} 解析失败: {e}"),
            },
            Ok(resp) => last_err = format!("{url} 返回 HTTP {}", resp.status()),
            Err(e) => last_err = format!("{url} 请求失败: {e}"),
        }
    }
    let entries = parsed.ok_or_else(|| format!("模型能力库下载失败：{last_err}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = db_path().ok_or("无法确定平台配置目录")?;
        let mut map = serde_json::Map::new();
        for (id, c) in &entries {
            map.insert(
                id.clone(),
                serde_json::json!({
                    "thinking": c.thinking,
                    "context": c.context,
                    "output": c.output,
                    "vision": c.vision,
                }),
            );
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

/// 注册表查询链：用户覆盖 > 网关实测缓存 > 公共能力库 > 内置表（前者赢）
fn lookup(model: &str) -> Option<ModelCaps> {
    let m = normalize(model);
    if let Some(c) = longest_match(&load_override(), &m) {
        return Some(*c);
    }
    if let Some(c) = longest_match(&load_relay_cache(), &m) {
        return Some(*c);
    }
    if let Some(c) = longest_match(&load_db(), &m) {
        return Some(*c);
    }
    let builtin: Vec<(String, ModelCaps)> = BUILTIN_CAPS
        .iter()
        .map(|(p, c)| (p.to_string(), *c))
        .collect();
    longest_match(&builtin, &m).copied()
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

/// 模型是否支持思考：注册表（覆盖文件 > 内置表）→ 关键词推断
pub fn model_thinking(model: &str) -> bool {
    lookup(model)
        .map(|c| c.thinking)
        .unwrap_or_else(|| keyword_thinking(model))
}

/// 模型上下文窗口：注册表（覆盖文件 > 内置表）→ 保守默认映射
pub fn model_context_size(model: &str) -> i64 {
    lookup(model)
        .and_then(|c| c.context)
        .unwrap_or_else(|| fallback_context_size(model))
}

/// 输出上限兜底：models.dev 上多数 chat 模型的常见值，保守不越界
/// （opencode 拿 limit.output 当 max output tokens 用，宁小勿大）
const DEFAULT_OUTPUT_LIMIT: i64 = 8192;

/// 模型输出上限：注册表（覆盖文件 > 内置表）→ 保守默认
pub fn model_output_limit(model: &str) -> i64 {
    lookup(model)
        .and_then(|c| c.output)
        .unwrap_or(DEFAULT_OUTPUT_LIMIT)
}

/// 是否支持图像输入：外部数据源（覆盖/网关实测/公共库）声明了 vision 就听它的；
/// 未声明时回落确知多模态清单（宁缺毋滥——给纯文本模型声明图像输入会让用户拖图进去才报错）。
/// codex catalog 的 input_modalities / kimi capabilities image_in / opencode modalities 用
pub fn model_supports_vision(model: &str) -> bool {
    if let Some(c) = lookup(model) {
        if c.vision == Some(true) {
            return true;
        }
    }
    let normalized = normalize(model);
    normalized.contains("kimi-k3")
        || normalized.starts_with("gemini-2.5")
        || normalized.starts_with("gemini-3")
        || normalized.starts_with("gpt-4o")
        || normalized.starts_with("claude-opus-4")
}

pub fn model_capability(model: &str) -> ModelCapabilityDto {
    let normalized = normalize(model);
    // 与 model_supports_vision 同一判定，单一出处
    let vision = if model_supports_vision(model) {
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
        thinking: model_thinking(model),
        context: model_context_size(model),
        tools,
        vision,
        video,
        streaming: Some(true),
    }
}

#[tauri::command]
pub fn model_capabilities(models: Vec<String>) -> Vec<ModelCapabilityDto> {
    models.iter().map(|model| model_capability(model)).collect()
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
        let d = map["deepseek-v3.2"];
        assert!(d.thinking, "supported_parameters 含 reasoning → 思考");
        assert_eq!(d.context, Some(163840));
        assert_eq!(d.output, Some(147456));
        assert_eq!(d.vision, Some(false));
        let vx = map["vision-x"];
        assert!(!vx.thinking);
        assert_eq!(vx.vision, Some(true));
        assert_eq!(vx.context, Some(262144));
        // 纯 id 无元数据的条目丢弃
        assert!(!map.contains_key("bare-id-only"));
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
        let k = map["kimi-k3"];
        assert!(k.thinking);
        assert_eq!(k.context, Some(1_048_576));
        assert_eq!(k.vision, Some(true));
        let g = map["gpt-5"];
        assert_eq!(g.output, Some(128000));
        assert_eq!(g.vision, Some(false));
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
        record_relay_models_to(&path, &v);
        let loaded = parse_caps_map(&std::fs::read_to_string(&path).unwrap());
        let c = longest_match(&loaded, "custom-model-x").unwrap();
        assert!(c.thinking && c.vision == Some(true) && c.context == Some(99999));
        // 再记一条别的模型：合并不覆盖
        let v2 = serde_json::json!({"data": [{"id": "other", "context_length": 1000}]});
        record_relay_models_to(&path, &v2);
        let loaded = parse_caps_map(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(loaded.len(), 2);
        // 纯 id 列表不动缓存
        let before = std::fs::read_to_string(&path).unwrap();
        record_relay_models_to(&path, &serde_json::json!({"data": [{"id": "no-meta"}]}));
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
