//! Runtime 的稳定边界：执行形态只描述能力，不携带具体 CLI 细节。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    LocalCli,
    Headless,
    Custom,
}

impl RuntimeKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local_cli" => Some(Self::LocalCli),
            "headless" => Some(Self::Headless),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub can_resume: bool,
    pub can_stop: bool,
    pub streams_output: bool,
    pub can_review: bool,
    pub resume_reason: Option<String>,
}

pub fn capabilities(kind: RuntimeKind) -> RuntimeCapabilities {
    let can_resume = matches!(kind, RuntimeKind::LocalCli);
    RuntimeCapabilities {
        can_resume,
        can_stop: !matches!(kind, RuntimeKind::Headless),
        streams_output: !matches!(kind, RuntimeKind::Headless),
        can_review: true,
        resume_reason: (!can_resume)
            .then(|| "此 Runtime 不支持会话恢复；请明确再次运行，结果仍可评审".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_keep_runtime_boundaries() {
        assert!(capabilities(RuntimeKind::LocalCli).can_resume);
        assert!(!capabilities(RuntimeKind::Headless).can_stop);
        assert!(!capabilities(RuntimeKind::Custom).can_resume);
        assert!(capabilities(RuntimeKind::Custom).can_review);
    }
}
