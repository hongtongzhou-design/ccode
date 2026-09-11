//! 科研外部工具开工检查：只探测，不安装、不写个人库、不启动 GUI。
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    name: String,
    status: String,
    detail: String,
    blocking: bool,
}
fn check(name: &str, status: &str, detail: impl Into<String>, blocking: bool) -> ToolCheck {
    ToolCheck {
        name: name.into(),
        status: status.into(),
        detail: detail.into(),
        blocking,
    }
}

#[tauri::command]
pub async fn research_tool_preflight(
    project_root: String,
    step_name: String,
    agent: String,
) -> Result<Vec<ToolCheck>, String> {
    let root = crate::projects::ensure_task_project_root(Path::new(
        &crate::sessions::expand_tilde(&project_root),
    ))?;
    let read = crate::projects::read_config_at(&root);
    let parse_warnings: Vec<_> = read
        .warnings
        .iter()
        .filter(|w| !w.starts_with("步骤「"))
        .collect();
    if !parse_warnings.is_empty() {
        return Err(format!(
            "项目配置需先修复：{}",
            parse_warnings
                .into_iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    let step = read
        .config
        .steps
        .iter()
        .find(|s| s.name == step_name)
        .ok_or("步骤不存在，请刷新")?;
    let library = crate::skills::list_skills().await;
    let mut out = read
        .warnings
        .iter()
        .enumerate()
        .map(|(i, warning)| check(&format!("步骤提示 {}", i + 1), "advisory", warning, false))
        .collect::<Vec<_>>();
    for name in &step.skills {
        let required = step.required_skills.contains(name);
        let skill = library.iter().find(|s| s.name == *name);
        let available = skill
            .is_some_and(|s| s.apps.get(&agent) == Some(&true) && !s.stale_copies.contains(&agent))
            && crate::skills::snapshot_named_skills(&[name.clone()], &agent).is_ok();
        out.push(check(
            name,
            if available { "available" } else { "missing" },
            if available {
                "已启用到所选 Agent；实际调用仍以运行结果为准"
            } else {
                "技能未安装、未启用到所选 Agent 或副本过期；到技能页检查分发"
            },
            required && !available,
        ));
    }
    if step.skills.iter().any(|s| s == "zotero-sync") {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let (status, detail) = match client.get("http://127.0.0.1:23119/api/").send().await {
            Ok(response) if response.status().is_success() => (
                "readable",
                "本地 API 可访问；未请求写库授权，版本与写入权限仍需逐批核对",
            ),
            Ok(response) if response.status().as_u16() == 403 => (
                "disabled",
                "Zotero 本机通信未开启；可继续使用已导入题录/PDF，写库未授权",
            ),
            Ok(_) => (
                "unknown",
                "本地服务响应不兼容；不猜测写入能力，使用文件流程",
            ),
            Err(_) => (
                "offline",
                "未连到 Zotero；已导入文件仍可用，不阻塞离线文献工作",
            ),
        };
        out.push(check("Zotero 本地通道", status, detail, false));
    }
    if step.skills.iter().any(|s| s == "origin-plot") {
        let windows = cfg!(windows);
        out.push(check("Origin 执行环境", if windows { "needs-probe" } else { "unsupported" },
            if windows { "Windows 平台符合；运行随包脚本 --probe，再核对 Origin 2021+ 与许可证。此处不会启动 Origin" }
            else { "Origin 执行要求有授权的 Windows 本机；不能在当前平台悄悄替换为 Python 图" }, !windows && step.required_skills.iter().any(|s| s == "origin-plot")));
    }
    if step.skills.iter().any(|s| s == "blender-research") {
        let probe = crate::mcp_blender::probe_blender_mcp_setup().await?;
        out.push(check(
            "Blender 安装",
            &probe.blender.status,
            probe
                .blender
                .detail
                .unwrap_or_else(|| "未检测到 Blender；可在工具参数里指定安装路径".into()),
            probe.blender.status == "too_old"
                && step.required_skills.iter().any(|s| s == "blender-research"),
        ));
        out.push(check("Blender MCP（交互可选）", &probe.running.status,
            "端口存在不等于目标工程握手。交互需到 MCP 页检测并在新工程核对；后台脚本不依赖 MCP。MCP 无 OS 沙箱", false));
    }
    if step.skills.iter().any(|s| s == "endnote-bridge") {
        out.push(check(
            "EndNote 文件桥",
            "manual-review",
            "转换器不依赖桌面安装；XML/RIS 导入、附件与 Word 插件必须人工验收，不自动控制 EndNote",
            false,
        ));
    }
    Ok(out)
}
