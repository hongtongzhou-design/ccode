//! 工作树（§6.9）：目录列举与只读文件预览。
//! 预览路径被限制在调用方给出的项目根内（canonicalize 后前缀校验，防 ../ 逃逸）。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

const LIST_CAP: usize = 2000;
const PREVIEW_CAP: usize = 256 * 1024;
const BINARY_SNIFF: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>, // ISO 时间
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewDto {
    pub text: String,
    pub truncated: bool,
}

fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

/// unix 秒 → ISO UTC（civil from days，与 sessions.rs 同款算法）
fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let tod = secs % 86400;
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn list_dir_sync(path: &str, show_hidden: bool) -> Result<Vec<DirEntryDto>, String> {
    let dir = expand_tilde(path);
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut entries = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        // 读不到元数据的条目（坏链接、权限不足）静默跳过
        let Ok(md) = e.metadata() else {
            continue;
        };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| iso_from_unix(d.as_secs()));
        entries.push(DirEntryDto {
            name,
            path: e.path().to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            modified,
        });
        if entries.len() >= LIST_CAP {
            break;
        }
    }
    // 目录在前，组内按名称（忽略大小写）排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(LIST_CAP);
    Ok(entries)
}

fn read_file_preview_sync(path: &str, root: &str) -> Result<FilePreviewDto, String> {
    let root_c = PathBuf::from(expand_tilde(root))
        .canonicalize()
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = PathBuf::from(expand_tilde(path))
        .canonicalize()
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if !path_c.starts_with(&root_c) {
        return Err("路径超出项目根目录，拒绝预览".into());
    }
    let md = fs::metadata(&path_c).map_err(|e| format!("读取文件失败: {e}"))?;
    if md.is_dir() {
        return Err("目录不支持预览".into());
    }
    let f = fs::File::open(&path_c).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut buf = Vec::new();
    f.take((PREVIEW_CAP + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败: {e}"))?;
    // 二进制检测：前 8KB 出现 NUL 即判二进制
    if buf.iter().take(BINARY_SNIFF).any(|b| *b == 0) {
        return Err("二进制文件不支持预览".into());
    }
    let truncated = buf.len() > PREVIEW_CAP;
    if truncated {
        buf.truncate(PREVIEW_CAP);
    }
    Ok(FilePreviewDto {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

#[tauri::command]
pub async fn list_dir(path: String, show_hidden: bool) -> Result<Vec<DirEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_sync(&path, show_hidden))
        .await
        .map_err(|e| format!("读取目录失败: {e}"))?
}

#[tauri::command]
pub async fn read_file_preview(path: String, root: String) -> Result<FilePreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_preview_sync(&path, &root))
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-fstree-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_dir_dirs_first_case_insensitive() {
        let dir = tmpdir("sort");
        fs::create_dir_all(dir.join("zeta")).unwrap();
        fs::create_dir_all(dir.join("Alpha")).unwrap();
        fs::write(dir.join("beta.txt"), "x").unwrap();
        fs::write(dir.join("Gamma.txt"), "x").unwrap();
        fs::write(dir.join(".hidden"), "x").unwrap();
        let entries = list_dir_sync(dir.to_str().unwrap(), false).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "zeta", "beta.txt", "Gamma.txt"]);
        assert!(entries[0].is_dir && entries[1].is_dir);
        assert!(!entries[2].is_dir);
        assert!(entries[2].modified.is_some());
        assert!(!names.contains(&".hidden"), "默认不显示隐藏文件");
        let with_hidden = list_dir_sync(dir.to_str().unwrap(), true).unwrap();
        assert!(with_hidden.iter().any(|e| e.name == ".hidden"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_refuses_path_escape() {
        let root = tmpdir("root");
        let outside = tmpdir("outside");
        let secret = outside.join("secret.txt");
        fs::write(&secret, "nope").unwrap();
        // 直接给根外绝对路径
        let err = read_file_preview_sync(secret.to_str().unwrap(), root.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("超出项目根目录"), "{err}");
        // ../ 逃逸
        let escape = format!("{}/../", root.display());
        let err2 = read_file_preview_sync(&escape, root.to_str().unwrap()).unwrap_err();
        assert!(err2.contains("超出项目根目录") || err2.contains("目录"), "{err2}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn preview_detects_binary_via_nul() {
        let dir = tmpdir("bin");
        let f = dir.join("bin.dat");
        fs::write(&f, b"abc\0def").unwrap();
        let err = read_file_preview_sync(f.to_str().unwrap(), dir.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "二进制文件不支持预览");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_truncates_at_cap() {
        let dir = tmpdir("cap");
        let f = dir.join("big.txt");
        fs::write(&f, "a".repeat(PREVIEW_CAP + 1000)).unwrap();
        let p = read_file_preview_sync(f.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        assert!(p.truncated);
        assert_eq!(p.text.len(), PREVIEW_CAP);
        let small = dir.join("small.txt");
        fs::write(&small, "hello").unwrap();
        let p2 = read_file_preview_sync(small.to_str().unwrap(), dir.to_str().unwrap()).unwrap();
        assert!(!p2.truncated);
        assert_eq!(p2.text, "hello");
        fs::remove_dir_all(&dir).ok();
    }
}
