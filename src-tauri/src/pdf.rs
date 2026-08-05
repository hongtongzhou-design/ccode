//! PDF 字节读取（§11.4 P2a）：供前端 pdf.js 内嵌预览。
//! 防任意文件读取——只有四类白名单来源内的路径才放行：
//! 已注册项目的登记资源（project.toml resources）、已注册项目根内、
//! 工作区/仓库根内、终端标签 cwd 根内（前端 hint，风格同 read_file_preview 的 root 约束）。
//! 目标路径 canonicalize 后再判定，堵符号链接绕过。

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 单文件上限：超出直接报错（pdf.js 需要完整文件，截断无意义）
const PDF_CAP: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfBytesDto {
    /// base64 编码的完整文件字节。
    /// 不走 raw bytes 响应：macOS/iOS 上 Tauri 会把 Raw 退化成 JSON 数字数组（逐字节展开），
    /// 大 PDF 下完全不可用；base64 字符串是全平台一致的传输方式。
    pub data: String,
    pub size: u64,
}

fn canon(p: &Path) -> Option<PathBuf> {
    p.canonicalize().ok()
}

/// 纯函数白名单判定（测试友好）：canonical 目标必须落在某白名单根内，
/// 或精确等于某登记资源路径（资源可以是项目根外的单个文件）。
fn path_allowed(target: &Path, roots: &[PathBuf], resources: &[PathBuf]) -> bool {
    roots.iter().any(|r| target.starts_with(r)) || resources.iter().any(|r| target == r)
}

fn read_pdf_sync(path: &str, cwd_hint: Option<&str>) -> Result<PdfBytesDto, String> {
    let target = PathBuf::from(crate::sessions::expand_tilde(path))
        .canonicalize()
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if target.is_dir() {
        return Err("目录不支持预览".into());
    }
    // 白名单收集：任一来源失败静默跳过（宁缺勿滥，绝不因 db 读不到而整体放行）
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut resources: Vec<PathBuf> = Vec::new();
    if let Some(hint) = cwd_hint {
        if let Some(c) = canon(&PathBuf::from(crate::sessions::expand_tilde(hint))) {
            roots.push(c);
        }
    }
    let (project_roots, project_resources) = crate::projects::project_roots_and_resources();
    roots.extend(project_roots.iter().filter_map(|p| canon(p)));
    resources.extend(project_resources.iter().filter_map(|p| canon(p)));
    roots.extend(
        crate::workspaces::worktree_rows()
            .into_iter()
            .flat_map(|w| [w.worktree_path, w.repo_path])
            .filter_map(|p| canon(Path::new(&p))),
    );
    if !path_allowed(&target, &roots, &resources) {
        return Err("路径不在项目/登记资源/工作区/终端目录范围内，拒绝读取".into());
    }
    let size = fs::metadata(&target)
        .map_err(|e| format!("读取文件失败: {e}"))?
        .len();
    if size > PDF_CAP {
        return Err(format!(
            "PDF 超过 100 MB（{:.1} MB），暂不支持内嵌预览",
            size as f64 / 1024.0 / 1024.0
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("读取文件失败: {e}"))?;
    // PDF 头允许出现在前 1024 字节内（部分生成器会写前导字节），宽松校验给个明白的错误
    let head = &bytes[..bytes.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("文件内容不是有效的 PDF".into());
    }
    Ok(PdfBytesDto {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size,
    })
}

#[tauri::command]
pub async fn read_pdf_bytes(path: String, cwd_hint: Option<String>) -> Result<PdfBytesDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_pdf_sync(&path, cwd_hint.as_deref()))
        .await
        .map_err(|e| format!("读取 PDF 失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ccode-pdf-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn whitelist_pure_rules() {
        let root = PathBuf::from("/proj/a");
        let roots = vec![root.clone()];
        let res = vec![PathBuf::from("/elsewhere/paper.pdf")];
        // 根内放行（含根本身前缀）
        assert!(path_allowed(Path::new("/proj/a/docs/x.pdf"), &roots, &res));
        assert!(path_allowed(Path::new("/proj/a"), &roots, &res));
        // 资源精确路径放行（项目根外单文件）
        assert!(path_allowed(Path::new("/elsewhere/paper.pdf"), &roots, &res));
        // 资源同目录的兄弟文件不放行（资源是精确匹配，不是前缀）
        assert!(!path_allowed(Path::new("/elsewhere/other.pdf"), &roots, &res));
        // 前缀混淆（/proj/ab 不是 /proj/a 内）
        assert!(!path_allowed(Path::new("/proj/ab/x.pdf"), &roots, &res));
        // 完全根外拒绝
        assert!(!path_allowed(Path::new("/etc/passwd"), &roots, &res));
    }

    #[test]
    fn read_within_cwd_hint_ok() {
        let dir = tmpdir("ok");
        let f = dir.join("paper.pdf");
        fs::write(&f, b"%PDF-1.7 fake body").unwrap();
        let dto = read_pdf_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&dto.data)
            .unwrap();
        assert_eq!(decoded, b"%PDF-1.7 fake body");
        assert_eq!(dto.size, 18);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_outside_hint_rejected() {
        let root = tmpdir("root");
        let outside = tmpdir("outside");
        let f = outside.join("paper.pdf");
        fs::write(&f, b"%PDF-1.7 fake").unwrap();
        let err = read_pdf_sync(f.to_str().unwrap(), Some(root.to_str().unwrap())).unwrap_err();
        assert!(err.contains("拒绝读取"), "{err}");
        // 不给 hint 且不在任何注册来源内：同样拒绝
        let err2 = read_pdf_sync(f.to_str().unwrap(), None).unwrap_err();
        assert!(err2.contains("拒绝读取"), "{err2}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn read_rejects_non_pdf_and_dir() {
        let dir = tmpdir("notpdf");
        let f = dir.join("notes.txt");
        fs::write(&f, "plain text").unwrap();
        let err = read_pdf_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("不是有效的 PDF"), "{err}");
        let err2 = read_pdf_sync(dir.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err2.contains("目录"), "{err2}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_rejects_oversize() {
        let dir = tmpdir("cap");
        let f = dir.join("huge.pdf");
        // 稀疏文件置长度，避免真的写 100MB
        let file = fs::File::create(&f).unwrap();
        file.set_len(PDF_CAP + 1).unwrap();
        drop(file);
        let err = read_pdf_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap())).unwrap_err();
        assert!(err.contains("100 MB"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
    fn symlink_escaping_hint_rejected() {
        let root = tmpdir("sroot");
        let outside = tmpdir("soutside");
        let real = outside.join("real.pdf");
        fs::write(&real, b"%PDF-1.7 fake").unwrap();
        std::os::unix::fs::symlink(&real, root.join("link.pdf")).unwrap();
        // 链接在 hint 根内但 canonicalize 后指向根外：拒绝
        let err =
            read_pdf_sync(root.join("link.pdf").to_str().unwrap(), Some(root.to_str().unwrap()))
                .unwrap_err();
        assert!(err.contains("拒绝读取"), "{err}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
