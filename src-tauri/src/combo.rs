//! Agent × 模型 × 网关槽 × 体检 的求交器。
//! 能力链在 Rust；前端只消费本模块下发的 DTO，不得自己查 model_registry。

use crate::agent_specs::{self, request_policy_support};
use crate::gateway_store::{self, probe_field_status, Slot};
use crate::model_registry;
use crate::profiles::{Gateway, ProbeStatus, Profile};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboSurfaceDto {
    pub agent: String,
    pub agents: Vec<String>,
    pub model: String,
    pub gateway_id: Option<String>,
    pub slot: Option<String>,
    pub thinking: bool,
    pub vision: bool,
    pub context: i64,
    pub output: i64,
    /// 状态栏是否展示 CLI 原生 /effort（启动时选中模型求交）
    pub show_native_effort: bool,
    /// 启动注入是否写入 effort（通道 supported 且体检未失败且用户存了值时由 launch 再判）
    pub inject_effort_allowed: bool,
    pub inject_temperature_allowed: bool,
    pub inject_top_p_allowed: bool,
    pub inject_max_tokens_allowed: bool,
    pub inject_headers_allowed: bool,
    /// 已存值但当前求交的 Agent 并集没有通道；模型不会思考时为 false（字段应隐藏而非只读）
    pub effort_readonly: bool,
    pub temperature_readonly: bool,
    pub top_p_readonly: bool,
    pub max_tokens_readonly: bool,
    pub mixed_models_note: Option<String>,
    pub probe_effort: &'static str,
    pub probe_temperature: &'static str,
    pub probe_headers: &'static str,
    pub probe_note: Option<String>,
    pub missing_slot: bool,
}

fn channel_ok(status: &str) -> bool {
    status == "supported"
}

fn probe_blocks(status: ProbeStatus) -> bool {
    status == ProbeStatus::Failed
}

fn union_channel(agents: &[&str], pick: impl Fn(&crate::agent_specs::RequestPolicySupportDto) -> &str) -> bool {
    agents
        .iter()
        .any(|a| channel_ok(pick(&request_policy_support(a))))
}

fn probe_status_any(gateway: Option<&Gateway>, slot: Option<Slot>, field: &str) -> ProbeStatus {
    let Some(g) = gateway else {
        return ProbeStatus::Never;
    };
    if let Some(s) = slot {
        return probe_field_status(g, s, field);
    }
    let mut worst = ProbeStatus::Never;
    for s in [
        Slot::Anthropic,
        Slot::Openai,
        Slot::Responses,
        Slot::Gemini,
        Slot::Cursor,
    ] {
        if gateway_store::slot_url(&g.slots, s).is_none() {
            continue;
        }
        match probe_field_status(g, s, field) {
            ProbeStatus::Failed => return ProbeStatus::Failed,
            ProbeStatus::Passed => worst = ProbeStatus::Passed,
            ProbeStatus::Never => {}
        }
    }
    worst
}

fn probe_note_for(gateway: Option<&Gateway>, probe_effort: ProbeStatus) -> Option<String> {
    if probe_effort != ProbeStatus::Failed {
        return None;
    }
    let when = gateway
        .and_then(|g| {
            g.last_probe
                .iter()
                .filter(|p| p.effort == ProbeStatus::Failed)
                .map(|p| p.probed_at.as_str())
                .max()
        })
        .map(|iso| iso.chars().take(10).collect::<String>())
        .filter(|s| !s.is_empty());
    Some(match when {
        Some(d) => format!("实测该网关会丢弃 effort 参数（{d} 体检）"),
        None => "实测该网关会丢弃 effort 参数".into(),
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn surface_for(
    agent: &str,
    model: &str,
    gateway: Option<&Gateway>,
    slot: Option<Slot>,
    stored_effort: bool,
    binding_models: &[String],
    missing_slot: bool,
) -> ComboSurfaceDto {
    surface_for_agents(
        &[agent],
        model,
        gateway,
        slot,
        stored_effort,
        false,
        false,
        false,
        binding_models,
        missing_slot,
    )
}

pub fn surface_for_agents(
    agents: &[&str],
    model: &str,
    gateway: Option<&Gateway>,
    slot: Option<Slot>,
    stored_effort: bool,
    stored_temp: bool,
    stored_top_p: bool,
    stored_max: bool,
    binding_models: &[String],
    missing_slot: bool,
) -> ComboSurfaceDto {
    let gid = gateway.map(|g| g.id.as_str());
    let thinking = model_registry::model_thinking_for(model, gid);
    let vision = model_registry::model_supports_vision_for(model, gid);
    let context = model_registry::model_context_size_for(model, gid);
    let output = model_registry::model_output_limit_for(model, gid);
    let effort_ch = union_channel(agents, |s| s.reasoning_effort);
    let temp_ch = union_channel(agents, |s| s.temperature);
    let top_p_ch = union_channel(agents, |s| s.top_p);
    let max_ch = union_channel(agents, |s| s.max_output_tokens);
    let headers_ch = union_channel(agents, |s| s.custom_headers);
    let has_native_effort = agents.iter().any(|agent| {
        agent_specs::agent_spec(agent)
            .and_then(|s| s.effort_levels)
            .is_some_and(|(levels, _)| levels.len() > 1)
    });

    let probe_effort = probe_status_any(gateway, slot, "effort");
    let probe_temp = probe_status_any(gateway, slot, "temperature");
    let probe_headers = probe_status_any(gateway, slot, "headers");

    let inject_effort_allowed = thinking && effort_ch && !probe_blocks(probe_effort);
    let show_native_effort = thinking && has_native_effort && !probe_blocks(probe_effort);
    // 不会思考 → 隐藏思考档，不算「通道不通」只读
    let effort_readonly = stored_effort && thinking && !effort_ch;

    let mixed = if binding_models.len() > 1 {
        let flags: Vec<bool> = binding_models
            .iter()
            .map(|m| model_registry::model_thinking_for(m, gid))
            .collect();
        flags.iter().any(|x| *x) && flags.iter().any(|x| !*x)
    } else {
        false
    };
    let mixed_models_note = if mixed {
        Some("此绑定含会思考与不会思考的模型。启动后在 CLI 里换模不会重注策略，要按新模型请重开标签。".into())
    } else {
        None
    };

    ComboSurfaceDto {
        agent: agents.first().copied().unwrap_or("").into(),
        agents: agents.iter().map(|s| (*s).to_string()).collect(),
        model: model.into(),
        gateway_id: gid.map(str::to_string),
        slot: slot.map(|s| s.as_str().to_string()),
        thinking,
        vision,
        context,
        output,
        show_native_effort,
        inject_effort_allowed,
        inject_temperature_allowed: temp_ch && !probe_blocks(probe_temp),
        inject_top_p_allowed: top_p_ch && !probe_blocks(probe_temp),
        inject_max_tokens_allowed: max_ch,
        inject_headers_allowed: headers_ch && !probe_blocks(probe_headers),
        effort_readonly,
        temperature_readonly: stored_temp && !temp_ch,
        top_p_readonly: stored_top_p && !top_p_ch,
        max_tokens_readonly: stored_max && !max_ch,
        mixed_models_note,
        probe_effort: probe_effort.as_str(),
        probe_temperature: probe_temp.as_str(),
        probe_headers: probe_headers.as_str(),
        probe_note: probe_note_for(gateway, probe_effort),
        missing_slot,
    }
}

pub fn apply_to_profile(profile: &mut Profile, model: Option<&str>) {
    let surface = surface_for_profile(profile, model);
    if !surface.inject_effort_allowed {
        profile.request_policy.reasoning_effort = None;
    }
    if !surface.inject_temperature_allowed {
        profile.request_policy.temperature = None;
    }
    if !surface.inject_top_p_allowed {
        profile.request_policy.top_p = None;
    }
    if !surface.inject_max_tokens_allowed {
        profile.request_policy.max_output_tokens = None;
    }
    if !surface.inject_headers_allowed {
        profile.request_policy.header_env.clear();
    }
}

pub fn surface_for_profile(profile: &Profile, model: Option<&str>) -> ComboSurfaceDto {
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| profile.models.first().map(String::as_str))
        .unwrap_or("");
    let gw = profile
        .gateway_id
        .as_deref()
        .and_then(gateway_store::find_gateway);
    let slot = gateway_store::slot_for_agent(&profile.agent, profile.protocol.as_deref());
    let gm = gw
        .as_ref()
        .and_then(|g| g.models.iter().find(|m| m.id == model));
    let stored_effort = profile.request_policy.reasoning_effort.is_some()
        || gm.and_then(|m| m.reasoning_effort.as_ref()).is_some();
    let stored_temp = profile.request_policy.temperature.is_some()
        || gm.and_then(|m| m.temperature).is_some();
    let stored_top_p = profile.request_policy.top_p.is_some() || gm.and_then(|m| m.top_p).is_some();
    let stored_max = profile.request_policy.max_output_tokens.is_some()
        || gm.and_then(|m| m.max_output_tokens).is_some();
    surface_for_agents(
        &[profile.agent.as_str()],
        model,
        gw.as_ref(),
        Some(slot),
        stored_effort,
        stored_temp,
        stored_top_p,
        stored_max,
        &profile.models,
        profile.slot_missing,
    )
}

#[tauri::command]
pub fn combo_surface(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    profile_id: String,
    model: Option<String>,
) -> Result<ComboSurfaceDto, String> {
    let profile = store.get(&profile_id)?;
    Ok(surface_for_profile(&profile, model.as_deref()))
}

/// 网关库语境：绑了该网关的所有 Agent 通道取并集。
#[tauri::command]
pub fn combo_surface_for_gateway(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    gateway_id: String,
    model: String,
) -> Result<ComboSurfaceDto, String> {
    let _ = store;
    let gw = gateway_store::find_gateway(&gateway_id).ok_or("网关不存在")?;
    let bindings = gateway_store::load_bindings().unwrap_or_default();
    let agents: Vec<String> = bindings
        .iter()
        .filter(|b| b.gateway_id.as_deref() == Some(gateway_id.as_str()))
        .map(|b| b.agent.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let agent_refs: Vec<&str> = if agents.is_empty() {
        vec![]
    } else {
        agents.iter().map(String::as_str).collect()
    };
    let gm = gw.models.iter().find(|m| m.id == model);
    let binding_models: Vec<String> = bindings
        .iter()
        .filter(|b| b.gateway_id.as_deref() == Some(gateway_id.as_str()))
        .flat_map(|b| b.models.clone())
        .collect();
    Ok(surface_for_agents(
        &agent_refs,
        &model,
        Some(&gw),
        None,
        gm.and_then(|m| m.reasoning_effort.as_ref()).is_some(),
        gm.and_then(|m| m.temperature).is_some(),
        gm.and_then(|m| m.top_p).is_some(),
        gm.and_then(|m| m.max_output_tokens).is_some(),
        &binding_models,
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Gateway, GatewayModel, ProbeRecord, ProtocolSlots};

    fn gw_with_probe(effort_failed: bool) -> Gateway {
        Gateway {
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            name: "g".into(),
            no_auth: false,
            key_hint: None,
            slots: ProtocolSlots {
                anthropic: Some("https://example.com".into()),
                ..Default::default()
            },
            header_env: Default::default(),
            models: vec![GatewayModel {
                id: "grok-4".into(),
                source: "user".into(),
                temperature: None,
                top_p: None,
                max_output_tokens: None,
                reasoning_effort: Some("high".into()),
            }],
            catalog_fetched_at: None,
            catalog_from_slot: None,
            slot_probes: Vec::new(),
            last_probe: if effort_failed {
                vec![ProbeRecord {
                    slot: "anthropic".into(),
                    model: None,
                    url_fp: "x".into(),
                    key_fp: "k".into(),
                    streaming: ProbeStatus::Passed,
                    effort: ProbeStatus::Failed,
                    headers: ProbeStatus::Never,
                    basic: ProbeStatus::Passed,
                    probed_at: "t".into(),
                    latency_ms: Some(245),
                }]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn claude_thinking_model_shows_native_effort() {
        let dto = surface_for(
            "claude-code",
            "claude-opus-4",
            None,
            Some(Slot::Anthropic),
            false,
            &["claude-opus-4".into()],
            false,
        );
        assert!(dto.thinking);
        assert!(dto.show_native_effort);
        assert!(dto.inject_effort_allowed);
    }

    #[test]
    fn probe_failed_hides_native_effort() {
        let gw = gw_with_probe(true);
        let dto = surface_for(
            "claude-code",
            "grok-4",
            Some(&gw),
            Some(Slot::Anthropic),
            true,
            &["grok-4".into()],
            false,
        );
        assert!(!dto.show_native_effort);
        assert!(!dto.inject_effort_allowed);
        assert_eq!(dto.probe_effort, "failed");
    }

    #[test]
    fn never_probed_does_not_block_supported_channel() {
        let gw = gw_with_probe(false);
        let dto = surface_for(
            "claude-code",
            "claude-opus-4",
            Some(&gw),
            Some(Slot::Anthropic),
            false,
            &["claude-opus-4".into()],
            false,
        );
        assert_eq!(dto.probe_effort, "never");
        assert!(dto.inject_effort_allowed);
    }

    #[test]
    fn gemini_has_no_effort_channel() {
        let dto = surface_for(
            "gemini",
            "gemini-2.5-pro",
            None,
            Some(Slot::Gemini),
            true,
            &["gemini-2.5-pro".into()],
            false,
        );
        assert!(dto.effort_readonly);
        assert!(!dto.inject_effort_allowed);
    }

    #[test]
    fn mixed_models_note() {
        let dto = surface_for(
            "claude-code",
            "claude-opus-4",
            None,
            Some(Slot::Anthropic),
            false,
            &["claude-opus-4".into(), "deepseek-chat".into()],
            false,
        );
        assert!(dto.mixed_models_note.is_some());
    }

    #[test]
    fn agent_union_effort_channel_from_any_bound() {
        let dto = surface_for_agents(
            &["gemini", "claude-code"],
            "claude-opus-4",
            None,
            Some(Slot::Anthropic),
            true,
            false,
            false,
            false,
            &["claude-opus-4".into()],
            false,
        );
        assert!(dto.inject_effort_allowed);
        assert!(!dto.effort_readonly);
        assert!(dto.inject_temperature_allowed);
    }

    #[test]
    fn non_thinking_stored_effort_is_not_channel_readonly() {
        let dto = surface_for(
            "claude-code",
            "deepseek-chat",
            None,
            Some(Slot::Anthropic),
            true,
            &["deepseek-chat".into()],
            false,
        );
        assert!(!dto.thinking);
        assert!(!dto.effort_readonly);
        assert!(!dto.inject_effort_allowed);
    }

    #[test]
    fn probe_failed_sets_note_and_temperature_mapping() {
        let gw = gw_with_probe(true);
        let dto = surface_for(
            "claude-code",
            "grok-4",
            Some(&gw),
            Some(Slot::Anthropic),
            true,
            &["grok-4".into()],
            false,
        );
        assert_eq!(dto.probe_effort, "failed");
        assert_eq!(dto.probe_temperature, "failed");
        assert!(dto.probe_note.as_deref().unwrap().contains("丢弃 effort"));
        assert!(!dto.inject_temperature_allowed);
    }
}
