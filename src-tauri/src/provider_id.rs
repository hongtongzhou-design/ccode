//! Codex / OpenCode / Kimi 的 provider 身份：从网关 id 派生，禁止再写死 `"ccode"`。
//! 旧 rollout 仍记 `model_provider="ccode"`，恢复时用 [`LEGACY`] 注入以对上旧会话。

pub const LEGACY: &str = "ccode";
pub const PREFIX: &str = "ccode-";

/// `ccode-` + 网关 UUID 去掉连字符后的前 8 位十六进制。
pub fn provider_id(gateway_id: &str) -> String {
    let hex: String = gateway_id
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(8)
        .collect();
    if hex.is_empty() {
        return LEGACY.to_string();
    }
    format!("{PREFIX}{hex}")
}

/// 从 `ccode-<短id>` 取出短 id；legacy / 其它返回 None。
pub fn short_id_from_provider(provider: &str) -> Option<&str> {
    provider.strip_prefix(PREFIX).filter(|s| !s.is_empty())
}

pub fn is_ccode_provider(provider: &str) -> bool {
    provider == LEGACY || provider.starts_with(PREFIX)
}

/// 网关 id 是否匹配会话记录的派生 provider。
pub fn gateway_matches_provider(gateway_id: &str, provider: &str) -> bool {
    match short_id_from_provider(provider) {
        Some(short) => {
            let hex: String = gateway_id
                .chars()
                .filter(|c| c.is_ascii_hexdigit())
                .collect();
            hex.starts_with(short)
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_from_uuid() {
        assert_eq!(
            provider_id("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
            "ccode-a1b2c3d4"
        );
    }

    #[test]
    fn empty_falls_back_legacy() {
        assert_eq!(provider_id(""), LEGACY);
        assert_eq!(provider_id("---"), LEGACY);
    }

    #[test]
    fn parse_and_match() {
        let gid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let pid = provider_id(gid);
        assert_eq!(short_id_from_provider(&pid), Some("a1b2c3d4"));
        assert!(gateway_matches_provider(gid, &pid));
        assert!(!gateway_matches_provider(gid, LEGACY));
        assert!(is_ccode_provider(LEGACY));
        assert!(is_ccode_provider(&pid));
        assert!(!is_ccode_provider("openai"));
    }
}
