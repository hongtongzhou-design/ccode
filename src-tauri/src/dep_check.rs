//! 依赖体检 + 一键安装（git / node，agent CLI 之外的基础依赖）。
//! 检测走 agents::resolve_binary + version_with_timeout；安装复用 updater 的 PTY 流式
//! 机制（防块缓冲、TUNA 镜像、key "dep-git"/"dep-node" 并发互斥、900s 超时），
//! 事件名沿用 updater 口径（agent-update-output-<key> / agent-update-done-<key>）。
//! macOS 的 /usr/bin/git 是 Xcode CLT 占位 stub：CLT 未装时跑它会弹系统安装窗，
//! 先用 `xcode-select -p` 判 CLT 已装与否，未装报 clt_stub、不做版本探测。

use crate::agents;
use crate::updater::{self, UpdateResultDto};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 平台显式传参（纯逻辑测试可注入），禁在判定函数里隐式读 cfg!
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostOs {
    Macos,
    Windows,
    Linux,
}

fn current_os() -> HostOs {
    if cfg!(target_os = "macos") {
        HostOs::Macos
    } else if cfg!(windows) {
        HostOs::Windows
    } else {
        HostOs::Linux
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepItemDto {
    /// ok | missing | clt_stub（clt_stub 仅 macOS git 可能出现：CLT 未装的系统占位）
    pub status: String,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepCheckDto {
    pub git: DepItemDto,
    pub node: DepItemDto,
    /// 一键安装渠道：brew | winget | xcode | none
    pub channel: String,
    /// 本地时间可读串（YYYY-MM-DD HH:MM:SS）
    pub checked_at: String,
}

fn missing_item() -> DepItemDto {
    DepItemDto {
        status: "missing".into(),
        version: None,
        path: None,
    }
}

/// 二进制存在即 ok；版本探测失败（超时/异常输出）不降级状态，version 留 None
fn ok_item(path: PathBuf) -> DepItemDto {
    let version = agents::version_with_timeout(&path, agents::VERSION_QUERY_TIMEOUT);
    DepItemDto {
        status: "ok".into(),
        version,
        path: Some(path.to_string_lossy().into_owned()),
    }
}

/// 只有 macOS 系统占位路径 /usr/bin/git 才有 CLT stub 语义（brew/自装路径是真 git）
fn is_clt_stub_candidate(os: HostOs, path: &Path) -> bool {
    os == HostOs::Macos && path == Path::new("/usr/bin/git")
}

/// `xcode-select -p`：成功 = CLT（或 Xcode）已装；失败 = 未装。
/// 命令本身起不来时保守按已装处理（不拦后续版本探测）。
#[cfg(target_os = "macos")]
fn clt_missing() -> bool {
    match crate::process::background_command("xcode-select")
        .arg("-p")
        .output()
    {
        Ok(out) => !out.status.success(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "macos"))]
fn clt_missing() -> bool {
    false
}

/// git 探测结果三分（纯函数）：stub 候选路径 + CLT 未装 = clt_stub，其余按正常 git
fn git_status(os: HostOs, path: &Path, clt_missing: bool) -> &'static str {
    if is_clt_stub_candidate(os, path) && clt_missing {
        "clt_stub"
    } else {
        "ok"
    }
}

fn probe_git(os: HostOs) -> DepItemDto {
    let Some(path) = agents::resolve_binary("git") else {
        return missing_item();
    };
    // stub 状态不再跑 `git --version`：stub 会弹系统安装窗，且必被 5s 版本探测超时杀掉
    if git_status(os, &path, clt_missing()) == "clt_stub" {
        return DepItemDto {
            status: "clt_stub".into(),
            version: None,
            path: Some(path.to_string_lossy().into_owned()),
        };
    }
    ok_item(path)
}

fn probe_node() -> DepItemDto {
    match agents::resolve_binary("node") {
        Some(path) => ok_item(path),
        None => missing_item(),
    }
}

/// 一键安装渠道判定（纯函数，可用性注入以便测试）：
/// macOS = 有 brew 走 brew，否则 git 走 xcode（node 无自动渠道，安装时按此报错）；
/// Windows = 有 winget 走 winget 否则 none；Linux = none（提示发行版包管理器）
fn channel_for(os: HostOs, has_brew: bool, has_winget: bool) -> &'static str {
    match os {
        HostOs::Macos => {
            if has_brew {
                "brew"
            } else {
                "xcode"
            }
        }
        HostOs::Windows => {
            if has_winget {
                "winget"
            } else {
                "none"
            }
        }
        HostOs::Linux => "none",
    }
}

fn check_dependencies_sync() -> Result<DepCheckDto, String> {
    let os = current_os();
    let git = probe_git(os);
    let node = probe_node();
    let has_brew = os == HostOs::Macos && agents::resolve_binary("brew").is_some();
    let has_winget = os == HostOs::Windows && agents::resolve_binary("winget").is_some();
    Ok(DepCheckDto {
        git,
        node,
        channel: channel_for(os, has_brew, has_winget).into(),
        checked_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

#[tauri::command]
pub async fn check_dependencies() -> Result<DepCheckDto, String> {
    tauri::async_runtime::spawn_blocking(check_dependencies_sync)
        .await
        .map_err(|e| format!("依赖检测失败: {e}"))?
}

// ===== 一键安装 =====

/// 流式事件与 updater_write 交互共用的 key
fn dep_key(tool: &str) -> String {
    format!("dep-{tool}")
}

fn validate_tool(tool: &str) -> Result<(), String> {
    if matches!(tool, "git" | "node") {
        Ok(())
    } else {
        Err(format!("不支持安装的依赖：{tool}（仅 git / node）"))
    }
}

/// macOS 无 brew 时 node 无自动渠道
const NO_BREW_NODE_MSG: &str =
    "未检测到 Homebrew：请到 nodejs.org 下载官方安装包，或先安装 Homebrew";

fn no_winget_msg(tool: &str) -> String {
    let site = match tool {
        "git" => "git-scm.com",
        _ => "nodejs.org",
    };
    format!("未检测到 winget：请到 {site} 下载安装包，装完点「重新检测」")
}

fn linux_hint(tool: &str) -> String {
    let pkg = match tool {
        "git" => "git",
        _ => "nodejs",
    };
    format!("请用发行版包管理器安装（如 sudo apt install {pkg}），装完点「重新检测」")
}

/// 装完成功：失效探测缓存后重新解析 + 版本探测，新版本写回 version_after
/// （与 updater.rs install_agent 收尾同口径）
fn finish_install(tool: &str, ok: bool, output: String, method: &str) -> UpdateResultDto {
    let version_after = if ok {
        agents::invalidate_detect_cache();
        updater::invalidate_check_cache();
        agents::resolve_binary(tool)
            .and_then(|p| agents::version_with_timeout(&p, agents::VERSION_QUERY_TIMEOUT))
    } else {
        None
    };
    UpdateResultDto {
        ok,
        output,
        method: method.into(),
        version_before: None,
        version_after,
    }
}

fn install_with_brew(app: &AppHandle, tool: &str, package: &str) -> UpdateResultDto {
    let args = vec!["install".to_string(), package.to_string()];
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), "brew", &args);
    finish_install(tool, ok, output, "brew")
}

fn install_with_winget(app: &AppHandle, tool: &str, winget_id: &str) -> UpdateResultDto {
    let args = updater::winget_args("install", winget_id);
    let (ok, output) = updater::run_streaming(app, &dep_key(tool), "winget", &args);
    finish_install(tool, ok, output, "winget")
}

fn install_macos(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    let has_brew = agents::resolve_binary("brew").is_some();
    match tool {
        "git" => {
            if has_brew {
                Ok(install_with_brew(app, tool, "git"))
            } else {
                // xcode-select --install 弹系统 GUI 异步完成：spawn 后立即返回，不等待
                crate::process::background_command("xcode-select")
                    .arg("--install")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("触发系统安装窗口失败: {e}"))?;
                Ok(UpdateResultDto {
                    ok: true,
                    output: "已触发系统安装窗口，请在弹窗中完成安装，装完点「重新检测」".into(),
                    method: "xcode".into(),
                    version_before: None,
                    version_after: None,
                })
            }
        }
        _ => {
            if has_brew {
                Ok(install_with_brew(app, tool, "node"))
            } else {
                Err(NO_BREW_NODE_MSG.into())
            }
        }
    }
}

fn install_windows(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    if agents::resolve_binary("winget").is_none() {
        return Err(no_winget_msg(tool));
    }
    let id = match tool {
        "git" => "Git.Git",
        _ => "OpenJS.NodeJS.LTS",
    };
    Ok(install_with_winget(app, tool, id))
}

fn install_dependency_sync(app: &AppHandle, tool: &str) -> Result<UpdateResultDto, String> {
    // 渠道在每个分支现场判定（resolve brew/winget），不依赖 check_dependencies 的缓存
    match current_os() {
        HostOs::Macos => install_macos(app, tool),
        HostOs::Windows => install_windows(app, tool),
        HostOs::Linux => Err(linux_hint(tool)),
    }
}

/// 结果经 `agent-update-done-dep-<tool>` 推送（前端以事件为准，invoke 返回值兜底）；
/// Err 分支（无渠道/未知 tool）不发 done 事件，由 invoke 的 reject 直接提示
#[tauri::command]
pub async fn install_dependency(app: AppHandle, tool: String) -> Result<UpdateResultDto, String> {
    validate_tool(&tool)?;
    let app2 = app.clone();
    let tool2 = tool.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_dependency_sync(&app2, &tool2))
        .await
        .map_err(|e| format!("安装失败: {e}"))??;
    Ok(updater::emit_done(&app, &dep_key(&tool), result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_matrix_covers_all_platforms() {
        // macOS：brew 优先，无 brew 走 xcode（git 用 xcode-select --install）
        assert_eq!(channel_for(HostOs::Macos, true, false), "brew");
        assert_eq!(channel_for(HostOs::Macos, false, false), "xcode");
        // Windows：winget 唯一自动渠道（brew 在 Windows 不算数）
        assert_eq!(channel_for(HostOs::Windows, false, true), "winget");
        assert_eq!(channel_for(HostOs::Windows, false, false), "none");
        assert_eq!(channel_for(HostOs::Windows, true, true), "winget");
        // Linux：无自动渠道
        assert_eq!(channel_for(HostOs::Linux, true, true), "none");
        assert_eq!(channel_for(HostOs::Linux, false, false), "none");
    }

    #[test]
    fn clt_stub_candidate_is_macos_usr_bin_git_only() {
        assert!(is_clt_stub_candidate(HostOs::Macos, Path::new("/usr/bin/git")));
        // brew/自装的 git 不是 stub
        assert!(!is_clt_stub_candidate(HostOs::Macos, Path::new("/opt/homebrew/bin/git")));
        assert!(!is_clt_stub_candidate(HostOs::Macos, Path::new("/usr/local/bin/git")));
        // 其他平台无 stub 概念（同名字面路径也不算）
        assert!(!is_clt_stub_candidate(HostOs::Linux, Path::new("/usr/bin/git")));
        assert!(!is_clt_stub_candidate(HostOs::Windows, Path::new("/usr/bin/git")));
    }

    #[test]
    fn git_status_tri_state() {
        // stub 候选 + CLT 缺失 = clt_stub
        assert_eq!(git_status(HostOs::Macos, Path::new("/usr/bin/git"), true), "clt_stub");
        // CLT 已装 = 正常 git
        assert_eq!(git_status(HostOs::Macos, Path::new("/usr/bin/git"), false), "ok");
        // 非候选路径不看 CLT
        assert_eq!(git_status(HostOs::Macos, Path::new("/opt/homebrew/bin/git"), true), "ok");
        assert_eq!(git_status(HostOs::Linux, Path::new("/usr/bin/git"), true), "ok");
    }

    #[test]
    fn no_channel_error_messages_point_to_official_sites() {
        assert!(NO_BREW_NODE_MSG.contains("nodejs.org"));
        assert!(NO_BREW_NODE_MSG.contains("Homebrew"));
        let git_msg = no_winget_msg("git");
        assert!(git_msg.contains("git-scm.com"));
        assert!(!git_msg.contains("nodejs.org"));
        let node_msg = no_winget_msg("node");
        assert!(node_msg.contains("nodejs.org"));
        assert!(!node_msg.contains("git-scm.com"));
        // Linux：git/node 包名分别写
        let git_hint = linux_hint("git");
        assert!(git_hint.contains("apt install git"));
        assert!(!git_hint.contains("nodejs"));
        assert!(linux_hint("node").contains("apt install nodejs"));
    }

    #[test]
    fn tool_whitelist_accepts_git_and_node_only() {
        assert!(validate_tool("git").is_ok());
        assert!(validate_tool("node").is_ok());
        for bad in ["brew", "Git", "", "git;rm"] {
            assert!(validate_tool(bad).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn dep_key_matches_event_suffix() {
        // 前端按 agent-update-output-dep-git / agent-update-done-dep-node 订阅
        assert_eq!(dep_key("git"), "dep-git");
        assert_eq!(dep_key("node"), "dep-node");
    }

    /// 本机冒烟（unix CI 上 git/node 至少其一如在 PATH 即被探到）：探测必须返回合法形状。
    /// macOS 上会真实跑 xcode-select -p（毫秒级），无 stub 环境误伤风险。
    #[cfg(unix)]
    #[test]
    fn check_dependencies_returns_valid_shape() {
        let dto = check_dependencies_sync().unwrap();
        assert!(["ok", "missing", "clt_stub"].contains(&dto.git.status.as_str()));
        assert!(["ok", "missing"].contains(&dto.node.status.as_str()));
        assert!(["brew", "winget", "xcode", "none"].contains(&dto.channel.as_str()));
        assert!(!dto.checked_at.is_empty());
        // status=ok 必有 path；missing 时 version/path 均空
        if dto.git.status == "ok" {
            assert!(dto.git.path.is_some());
        }
        if dto.git.status == "missing" {
            assert!(dto.git.version.is_none() && dto.git.path.is_none());
        }
    }
}
