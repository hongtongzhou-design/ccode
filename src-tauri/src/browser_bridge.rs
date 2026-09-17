//! 浏览器桥安装（通道 C 的装机件）：把 NativeMessagingHosts 清单写进各浏览器的
//! 期望位置，指向随应用分发的 `mesa_helper` 二进制。扩展（仓库 `extension/`，
//! ID 固定 `dmjplopfhbdamkihimfllomdmkfainnn`）经 native messaging 调 helper 落 papers/。
//!
//! 路径口径（Chrome 官方文档）：
//! - macOS：`~/Library/Application Support/<Browser>/NativeMessagingHosts/`
//! - Linux：`~/.config/<Browser>/NativeMessagingHosts/`
//! - Windows：清单任意位置 + HKCU 注册表键指向它（写注册表经 background_command，
//!   不闪 conhost）

const HOST_NAME: &str = "dev.ccode.mesa";
/// 与 extension/manifest.json 内置 key 派生的 ID 一致（装错 ID 浏览器会拒连）。
/// 派生口径：SHA-256(manifest key 的 DER) 前 128 bit → 32 位十六进制 → a-p 映射
/// （2026-09-17 修正：旧值 16 字符不是合法 Chrome ID，allowed_origins 永不匹配）
const EXT_ID: &str = "dmjplopfhbdamkihimfllomdmkfainnn";

fn helper_exe_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "定位程序目录失败".to_string())?;
    let name = if cfg!(windows) {
        "mesa_helper.exe"
    } else {
        "mesa_helper"
    };
    let p = dir.join(name);
    if !p.exists() {
        return Err(format!(
            "找不到 helper（{}）——开发模式需 cargo build 生成；打包版随应用分发",
            p.display()
        ));
    }
    Ok(p)
}

fn host_manifest(helper: &std::path::Path) -> String {
    let helper = helper.to_string_lossy().replace('\\', "\\\\");
    format!(
        r#"{{"name":"{HOST_NAME}","description":"Mesa 文献收货通道","path":"{helper}","type":"stdio","allowed_origins":["chrome-extension://{EXT_ID}/"]}}"#
    )
}

fn write_manifest(dir: &std::path::Path, body: &str) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = dir.join(format!("{HOST_NAME}.json"));
    std::fs::write(&path, body).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 安装浏览器桥：写 NativeMessagingHosts 清单（Chrome/Edge/Chromium）。
/// 返回各浏览器的安装结果（人话），前端直接展示
#[tauri::command]
pub fn install_browser_bridge() -> Vec<String> {
    let mut out = Vec::new();
    let helper = match helper_exe_path() {
        Ok(h) => h,
        Err(e) => return vec![format!("✗ {e}")],
    };
    let body = host_manifest(&helper);
    if cfg!(target_os = "macos") {
        if let Some(base) = dirs::config_dir() {
            for (browser, sub) in [
                ("Chrome", "Google/Chrome"),
                ("Edge", "Microsoft Edge"),
                ("Chromium", "Chromium"),
            ] {
                let dir = base.join(sub).join("NativeMessagingHosts");
                match write_manifest(&dir, &body) {
                    Ok(p) => out.push(format!("{browser}：已安装（{p}）")),
                    Err(e) => out.push(format!("{browser}：✗ {e}")),
                }
            }
        }
    } else if cfg!(target_os = "linux") {
        if let Some(base) = dirs::config_dir() {
            for (browser, sub) in [
                ("Chrome", "google-chrome"),
                ("Edge", "microsoft-edge"),
                ("Chromium", "chromium"),
            ] {
                let dir = base.join(sub).join("NativeMessagingHosts");
                match write_manifest(&dir, &body) {
                    Ok(p) => out.push(format!("{browser}：已安装（{p}）")),
                    Err(e) => out.push(format!("{browser}：✗ {e}")),
                }
            }
        }
    } else if cfg!(target_os = "windows") {
        // Windows：清单放各浏览器配置目录，注册表键（HKCU）指回清单文件
        if let Some(base) = dirs::config_dir() {
            for (browser, vendor, reg_root) in [
                ("Chrome", "Google\\Chrome", "Software\\Google\\Chrome"),
                ("Edge", "Microsoft\\Edge", "Software\\Microsoft\\Edge"),
            ] {
                let dir = base.join(vendor).join("NativeMessagingHosts");
                let manifest = match write_manifest(&dir, &body) {
                    Ok(p) => p,
                    Err(e) => {
                        out.push(format!("{browser}：✗ {e}"));
                        continue;
                    }
                };
                let key = format!(r"HKCU\{reg_root}\NativeMessagingHosts\{HOST_NAME}");
                let ok = crate::process::background_command("reg")
                    .args([
                        "add",
                        &key,
                        "/ve",
                        "/t",
                        "REG_SZ",
                        "/d",
                        &manifest,
                        "/f",
                    ])
                    .output()
                    .is_ok_and(|o| o.status.success());
                out.push(if ok {
                    format!("{browser}：已安装（清单+注册表）")
                } else {
                    format!("{browser}：✗ 注册表写入失败（清单在 {manifest}）")
                });
            }
        }
    } else {
        out.push("✗ 不支持的平台".into());
    }
    if !out.is_empty() {
        crate::logbuf::record(
            "info",
            "browser-bridge",
            &format!("浏览器桥安装：{}", out.join("；")),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_manifest_locks_extension_id() {
        let m = host_manifest(std::path::Path::new("/bin/mesa_helper"));
        assert!(m.contains(format!("chrome-extension://{EXT_ID}/").as_str()));
        assert!(m.contains(r#""type":"stdio""#));
        assert!(m.contains("/bin/mesa_helper"));
    }
}
