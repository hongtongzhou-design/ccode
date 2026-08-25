//! 模型能力注册表（2026-08-17 起）：内置前缀表 + <config>/ccode/model-capabilities.json
//! 覆盖 + 关键词推断兜底，同 pricing.rs「内置定价表 + pricing.json 覆盖」口径
//! （最长前缀匹配、剥中转 provider/ 前缀）。
//! 消费方：kimi（KIMI_MODEL_CAPABILITIES / KIMI_MODEL_MAX_CONTEXT_SIZE / [models.*] 的
//! capabilities）、codex（catalog context_window）、opencode（models 条目 reasoning/limit）。
//! 内置表宁缺毋滥：只收官方文档明确支持思考的模型，不确定的不收（落关键词推断），
//! 收错的能力声明（思考开了报错）比漏报更有害。

use std::path::PathBuf;
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

/// 单条能力：thinking = 支持思考档位；context = 上下文窗口、output = 输出上限
/// （None = 走保守默认）。output 只为 opencode 的 limit.output 服务（1.18 起 schema 必填），
/// 内置表不逐模型收（宁缺毋滥同 context 口径），覆盖文件可配，缺省落 DEFAULT_OUTPUT_LIMIT
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCaps {
    pub thinking: bool,
    pub context: Option<i64>,
    pub output: Option<i64>,
}

const fn caps(thinking: bool, context: Option<i64>) -> ModelCaps {
    ModelCaps { thinking, context, output: None }
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
/// 格式：{"模型前缀": {"thinking": true, "context": 262144, "output": 8192}}（三个字段都可选）
fn override_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("ccode")
            .join("model-capabilities.json"),
    )
}

fn load_override() -> Vec<(String, ModelCaps)> {
    let mut out = Vec::new();
    let Some(path) = override_path() else { return out };
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
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
            // 至少一个字段有效才算条目；thinking 缺省按 false（显式关思考也是合法覆盖）
            out.push((
                prefix.to_lowercase(),
                ModelCaps {
                    thinking: thinking.unwrap_or(false),
                    context,
                    output,
                },
            ));
        }
    }
    out
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

/// 注册表查询：覆盖文件优先于内置表（用户覆盖赢）
fn lookup(model: &str) -> Option<ModelCaps> {
    let m = normalize(model);
    if let Some(c) = longest_match(&load_override(), &m) {
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

pub fn model_capability(model: &str) -> ModelCapabilityDto {
    let normalized = normalize(model);
    let vision = if normalized.contains("kimi-k3")
        || normalized.starts_with("gemini-2.5")
        || normalized.starts_with("gemini-3")
        || normalized.starts_with("gpt-4o")
        || normalized.starts_with("claude-opus-4")
    {
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
    fn context_size_chain() {
        assert_eq!(model_context_size("kimi-k3"), 1_048_576);
        assert_eq!(model_context_size("kimi-k2.7"), 262_144);
        // 表内 thinking 条目 context=None → 保守默认
        assert_eq!(model_context_size("gpt-5"), 131_072);
        // 表外模型 → fallback 映射
        assert_eq!(model_context_size("unknown-model"), 131_072);
    }
}
