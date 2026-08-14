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
    pub created_at: String,
}

impl Default for TaskCardDto {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            step: None,
            workspace: None,
            created_at: String::new(),
        }
    }
}

/// 从 profile 的端点拉取可用模型列表。
/// 密钥优先用表单里新输入的，否则取钥匙串中已存的；只用于本次请求，不持久化。
#[tauri::command]
pub async fn fetch_models(
    base_url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<Vec<String>, String> {
    let key = match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(k),
        None => match profile_id.as_deref() {
            Some(id) => profiles::get_key(id)?,
            None => None,
        },
    };

    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 Base URL".into());
    }
    // 候选地址：已含 /v1 直接拼 /models；否则先试 /v1/models 再试 /models
    let candidates: Vec<String> = if base.ends_with("/v1") {
        vec![format!("{base}/models")]
    } else {
        vec![format!("{base}/v1/models"), format!("{base}/models")]
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut last_err = String::new();
    for url in candidates {
        let mut req = client.get(&url);
        if let Some(k) = &key {
            // 同时携带两种鉴权头：OpenAI 系认 Bearer，Anthropic 系认 x-api-key，多余的头无害
            req = req
                .header("Authorization", format!("Bearer {k}"))
                .header("x-api-key", k)
                .header("anthropic-version", "2023-06-01");
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                let body = resp
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("解析响应失败: {e}"))?;
                return Ok(parse_model_ids(&body));
            }
            Ok(resp) => {
                last_err = format!("{url} 返回 HTTP {}", resp.status());
            }
            Err(e) => {
                last_err = format!("{url} 请求失败: {e}");
            }
        }
    }
    Err(format!("获取模型列表失败：{last_err}"))
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
}
