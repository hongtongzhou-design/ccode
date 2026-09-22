//! EndNote 出库：把项目 `references.bib` 转成 `papers/endnote-import.xml`。
//! 不写 EndNote 个人库，不触发 Word 插件。未选择 EndNote 交差则不生成。

use std::path::{Path, PathBuf};

const BRIDGE_PY: &str = include_str!("../resources/skills/endnote-bridge/scripts/bridge.py");

fn python_bin() -> Result<PathBuf, String> {
    crate::agents::resolve_binary("python3")
        .or_else(|| crate::agents::resolve_binary("python"))
        .ok_or_else(|| "本机找不到 python3，无法生成 EndNote 导入文件".to_string())
}

fn wants_endnote_export(project_root: &Path) -> bool {
    let text =
        std::fs::read_to_string(project_root.join(".ccode/project.toml")).unwrap_or_default();
    text.contains("科研工具/libraryExport：endnote")
}

/// 项目选了 EndNote 交差且有 bib 时生成 xml；未选或没有 bib 则跳过。
pub fn export_if_configured(project_root: &Path) -> Result<Option<PathBuf>, String> {
    if !wants_endnote_export(project_root) {
        return Ok(None);
    }
    if !project_root.join("references.bib").is_file() {
        return Ok(None);
    }
    Ok(Some(export_xml(project_root)?))
}

fn run_bridge(
    py: &Path,
    script: &Path,
    bib: &Path,
    papers: &Path,
    stamp: &uuid::Uuid,
    kind: &str,
    dest: &Path,
    report: &Path,
    root: &Path,
) -> Result<(), String> {
    let out_tmp = papers.join(format!(".ccode-endnote-{stamp}.{kind}"));
    let report_tmp = papers.join(format!(".ccode-endnote-{stamp}-{kind}.json"));
    let mut cmd = crate::process::background_command(py);
    cmd.arg(script)
        .arg("--input")
        .arg(bib)
        .arg("--output")
        .arg(&out_tmp)
        .arg("--report")
        .arg(&report_tmp)
        .current_dir(root);
    let out = cmd.output().map_err(|e| format!("无法启动转换: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&out_tmp);
        let _ = std::fs::remove_file(&report_tmp);
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "生成 EndNote 导入文件失败".into()
        } else {
            err.to_string()
        });
    }
    crate::storage::replace(&out_tmp, dest)?;
    if kind == "xml" {
        crate::storage::replace(&report_tmp, report)?;
    } else {
        let _ = std::fs::remove_file(&report_tmp);
    }
    Ok(())
}

pub fn export_xml(project_root: &Path) -> Result<PathBuf, String> {
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    let bib = root.join("references.bib");
    if !bib.is_file() {
        return Err("还没有 references.bib，没法生成 EndNote 导入文件".into());
    }
    let papers = root.join("papers");
    std::fs::create_dir_all(&papers).map_err(|e| format!("无法创建 papers/: {e}"))?;
    let xml = papers.join("endnote-import.xml");
    let ris = papers.join("endnote-import.ris");
    let report = papers.join("endnote-report.json");
    let stamp = uuid::Uuid::new_v4();
    let script = std::env::temp_dir().join(format!("ccode-endnote-bridge-{stamp}.py"));
    crate::storage::atomic_write(&script, BRIDGE_PY.as_bytes(), true)?;
    let py = python_bin()?;
    let enw = papers.join("endnote-import.enw");
    run_bridge(
        &py, &script, &bib, &papers, &stamp, "xml", &xml, &report, &root,
    )?;
    run_bridge(
        &py, &script, &bib, &papers, &stamp, "ris", &ris, &report, &root,
    )?;
    run_bridge(
        &py, &script, &bib, &papers, &stamp, "enw", &enw, &report, &root,
    )?;
    let _ = std::fs::remove_file(&script);
    if !xml.is_file() {
        return Err("转换结束但没有 papers/endnote-import.xml".into());
    }
    Ok(xml)
}

/// 不写死版本号或本机路径。macOS 先问 Launch Services（刚装完拖进「应用程序」就会登记），
/// 再扫常见安装目录；Windows 扫 Program Files 下名字带 EndNote 的文件夹。
fn find_endnote_app() -> Option<PathBuf> {
    let mut apps = Vec::new();
    #[cfg(target_os = "macos")]
    apps.extend(mdfind_endnote_apps());
    apps.extend(scan_endnote_install_dirs());
    apps.sort_by(|a, b| {
        b.file_name()
            .unwrap_or_default()
            .cmp(a.file_name().unwrap_or_default())
    });
    apps.into_iter().find(|p| is_endnote_bundle(p))
}

#[cfg(target_os = "macos")]
fn mdfind_endnote_apps() -> Vec<PathBuf> {
    let queries = [
        r#"kMDItemCFBundleIdentifier == "com.ThomsonResearchSoft.EndNote""#,
        r#"kMDItemCFBundleIdentifier == "*endnote*"c"#,
    ];
    let mut out = Vec::new();
    for query in queries {
        let Ok(result) = crate::process::background_command("mdfind")
            .arg(query)
            .output()
        else {
            continue;
        };
        if !result.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&result.stdout).lines() {
            let path = PathBuf::from(line.trim());
            if is_plausible_endnote_app(&path) {
                out.push(path);
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

fn scan_endnote_install_dirs() -> Vec<PathBuf> {
    let mut apps = Vec::new();
    // 显式标注：push 都在 macos/windows 的 cfg 块里，Linux 上两块都不编译、推断不出元素类型
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
    }
    #[cfg(windows)]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(key) {
                roots.push(PathBuf::from(pf));
            }
        }
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !name_has_endnote(&path) {
                continue;
            }
            if is_endnote_bundle(&path) {
                apps.push(path);
                continue;
            }
            if !path.is_dir() {
                continue;
            }
            let Ok(inner) = std::fs::read_dir(&path) else {
                continue;
            };
            for child in inner.flatten() {
                let child_path = child.path();
                if name_has_endnote(&child_path) && is_endnote_bundle(&child_path) {
                    apps.push(child_path);
                }
            }
        }
    }
    apps
}

fn name_has_endnote(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase().contains("endnote"))
        .unwrap_or(false)
}

fn is_plausible_endnote_app(path: &Path) -> bool {
    if !path.exists() || !name_has_endnote(path) || !is_endnote_bundle(path) {
        return false;
    }
    let skip = ["downloads", "logs", "library/logs"];
    let lowered = path.to_string_lossy().to_ascii_lowercase();
    !skip.iter().any(|s| lowered.contains(s))
}

fn is_endnote_bundle(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        path.extension().is_some_and(|e| e == "app")
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        false
    }
}

fn copy_to_downloads(src: &Path, name: &str) -> Option<PathBuf> {
    let dest = dirs::download_dir()?.join(name);
    std::fs::copy(src, &dest).ok()?;
    Some(dest)
}

fn copy_path_to_clipboard(path: &Path) {
    let text = path.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::Stdio;
        if let Ok(mut child) = crate::process::background_command("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::Stdio;
        if let Ok(mut child) = crate::process::background_command("clip")
            .stdin(Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (path, text);
    }
}

fn launch_endnote_with_file(file: &Path) -> Result<(), String> {
    let app = find_endnote_app().ok_or_else(|| {
        "找不到 EndNote。把下载里的 Mesa-EndNote-import.ris 拖到 EndNote 图标上（不要拖进窗口）。".to_string()
    })?;
    #[cfg(target_os = "macos")]
    {
        // `open -a App file` 等于把文件拖到应用程序图标上。
        let status = crate::process::background_command("open")
            .arg("-a")
            .arg(&app)
            .arg(file)
            .status()
            .map_err(|e| format!("没法打开 EndNote: {e}"))?;
        if !status.success() {
            return Err(
                "请把下载里的 Mesa-EndNote-import.ris 拖到 Dock 或「应用程序」里的 EndNote 图标上。".into(),
            );
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let status = crate::process::background_command(&app)
            .arg(file)
            .status()
            .map_err(|e| format!("没法打开 EndNote: {e}"))?;
        if !status.success() {
            return Err("请把下载里的 Mesa-EndNote-import.ris 拖到 EndNote 图标上。".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, file);
        Err("请把 Mesa-EndNote-import.ris 拖到 EndNote 图标上。".into())
    }
}

#[tauri::command]
pub async fn endnote_export_xml(project_root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::expand_tilde(&project_root);
        let xml = export_xml(Path::new(&root))?;
        let ris = Path::new(&root).join("papers/endnote-import.ris");
        let handy = copy_to_downloads(&ris, "Mesa-EndNote-import.ris")
            .unwrap_or_else(|| ris.clone());
        copy_path_to_clipboard(&handy);
        match launch_endnote_with_file(&handy) {
            Ok(()) => Ok(
                "已把导入文件交给 EndNote（相当于拖到图标上）。若没进库：把下载里的 Mesa-EndNote-import.ris 拖到 EndNote 图标上，不要拖进窗口。".into(),
            ),
            Err(e) => Ok(format!(
                "文件已放到下载：Mesa-EndNote-import.ris。把它拖到 EndNote 图标上（不要拖进窗口）。{e}"
            )),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_shuttle_is_not_tex_accent() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".ccode")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            r#"@article{a,
  title = "solving the \"shuttle effect\" in magnesium",
  author = {Doe, Jane},
  year = {2024},
  journal = {J},
}
"#,
        )
        .unwrap();
        let xml = export_xml(&dir);
        let text = xml
            .as_ref()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok());
        let _ = std::fs::remove_dir_all(&dir);
        if xml.is_err() && xml.as_ref().unwrap_err().contains("找不到 python") {
            return;
        }
        let text = text.expect("xml");
        assert!(text.contains("shuttle effect"), "{text}");
    }

    #[test]
    fn flips_given_family_authors_in_ris() {
        let dir = std::env::temp_dir().join(format!("ccode-endnote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("papers")).unwrap();
        std::fs::write(
            dir.join("references.bib"),
            r#"@article{b,
  title = {Given family names must flip},
  author = {Jinlong Hu and R. Jurgan Behm and Doe, Jane and Smith JM},
  year = {2026},
  journal = {J},
}
"#,
        )
        .unwrap();
        let xml = export_xml(&dir);
        let ris = std::fs::read_to_string(dir.join("papers/endnote-import.ris")).ok();
        let _ = std::fs::remove_dir_all(&dir);
        if xml.is_err() && xml.as_ref().unwrap_err().contains("找不到 python") {
            return;
        }
        let ris = ris.expect("ris");
        assert!(ris.contains("AU  - Hu, Jinlong"), "{ris}");
        assert!(ris.contains("AU  - Behm, R. Jurgan"), "{ris}");
        assert!(ris.contains("AU  - Doe, Jane"), "{ris}");
        assert!(ris.contains("AU  - Smith, JM"), "{ris}");
    }

    #[test]
    fn finds_endnote_app_if_installed() {
        let Some(app) = find_endnote_app() else {
            return;
        };
        assert!(
            app.to_string_lossy()
                .to_ascii_lowercase()
                .contains("endnote"),
            "{}",
            app.display()
        );
        assert!(is_endnote_bundle(&app));
    }
}
