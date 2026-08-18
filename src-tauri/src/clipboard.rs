//! 剪贴板图片落盘（终端粘贴图片 → 绝对路径写进 PTY，九家 CLI 通吃的输入方式）。
//! 前端 paste 事件拿到 image/* 字节后经本模块落盘到 <config>/ccode/tmp/paste-*，
//! 每次调用顺带清理 7 天前的残留文件。不引 arboard：读取剪贴板在前端完成，这里只存字节。

use std::path::PathBuf;

/// 单张图片上限 50MB（剪贴板截图通常 <5MB，防误传大对象拖垮 IPC/磁盘）
const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
/// 粘贴图片保留 7 天
const PASTE_TTL_SECS: i64 = 7 * 24 * 3600;

fn paste_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("tmp"))
}

/// 扩展名白名单：前端按 MIME 映射后传入，这里再兜一层，非法一律 png
fn sanitize_ext(ext: &str) -> &str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => ext,
        _ => "png",
    }
}

/// paste-* 且 mtime 早于截止时刻才算残留（其它文件绝不碰）
fn is_expired_paste(name: &str, mtime_secs: i64, now_secs: i64, ttl_secs: i64) -> bool {
    name.starts_with("paste-") && mtime_secs < now_secs - ttl_secs
}

/// 清理 dir 下的过期粘贴图片（失败静默：清理是顺带动作，不挡主流程）
fn cleanup_old(dir: &std::path::Path, ttl_secs: i64) {
    let now = chrono::Utc::now().timestamp();
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        if let Some(m) = mtime {
            if is_expired_paste(&name.to_string_lossy(), m, now, ttl_secs) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// 保存剪贴板图片到临时目录，返回绝对路径（前端随后把路径写进 PTY）。
/// 文件名：paste-<yyyymmdd-hhmmss>-<短随机>.<ext>（同秒连贴防重名）
#[tauri::command]
pub fn save_clipboard_image(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("剪贴板图片为空".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片超过 50MB（{}MB）", bytes.len() / 1024 / 1024));
    }
    let dir = paste_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    cleanup_old(&dir, PASTE_TTL_SECS);
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let name = format!(
        "paste-{}-{}.{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        &uuid[..8],
        sanitize_ext(&ext),
    );
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| format!("保存剪贴板图片失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_ext_whitelist() {
        assert_eq!(sanitize_ext("png"), "png");
        assert_eq!(sanitize_ext("jpg"), "jpg");
        assert_eq!(sanitize_ext("jpeg"), "jpeg");
        assert_eq!(sanitize_ext("gif"), "gif");
        assert_eq!(sanitize_ext("webp"), "webp");
        assert_eq!(sanitize_ext("bmp"), "png");
        assert_eq!(sanitize_ext("PNG"), "png");
        assert_eq!(sanitize_ext("../../etc/x"), "png");
    }

    #[test]
    fn expired_paste_judgement() {
        let now = 1_800_000_000;
        assert!(is_expired_paste("paste-a.png", now - PASTE_TTL_SECS - 1, now, PASTE_TTL_SECS));
        assert!(!is_expired_paste("paste-a.png", now - PASTE_TTL_SECS + 1, now, PASTE_TTL_SECS));
        assert!(!is_expired_paste("keep.txt", 1, now, PASTE_TTL_SECS));
    }

    #[test]
    fn cleanup_keeps_fresh_and_non_paste_files() {
        let dir = std::env::temp_dir().join(format!("ccode-clip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("paste-new.png");
        let other = dir.join("keep.txt");
        std::fs::write(&fresh, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();

        cleanup_old(&dir, PASTE_TTL_SECS);

        assert!(fresh.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
