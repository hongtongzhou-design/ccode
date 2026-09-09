//! 本机文件持久化原语：跨进程读改写锁、私有临时文件、安全替换。
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

pub(crate) fn config_lock(name: &str) -> Result<File, String> {
    let dir = dirs::config_dir()
        .ok_or("无法确定配置目录")?
        .join("ccode/locks");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    lock_at(&dir.join(format!("{name}.lock")))
}

pub(crate) fn lock_at(path: &Path) -> Result<File, String> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("打开文件锁失败：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(format!("配置正在被其他实例使用或无法加锁，请稍后重试：{e}")),
        }
    }
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".ccode-write-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if !private {
            if let Ok(meta) = fs::metadata(path) {
                fs::set_permissions(&tmp, meta.permissions()).map_err(|e| e.to_string())?;
            }
        }
        drop(file);
        replace(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("保存 {} 失败：{e}", path.display()))
}

pub(crate) fn replace(tmp: &Path, path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // MoveFileEx 对只读目标拒绝；仅临时调整属性，不删除原文件。
        let original = fs::metadata(path).ok().map(|m| m.permissions());
        let readonly = original.as_ref().is_some_and(|p| p.readonly());
        if readonly {
            let mut writable = original.clone().unwrap();
            writable.set_readonly(false);
            fs::set_permissions(path, writable).map_err(|e| e.to_string())?;
        }
        let result = fs::rename(tmp, path);
        if readonly {
            if let Some(permissions) = original {
                let _ = fs::set_permissions(path, permissions);
            }
        }
        return result.map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_read_modify_write_lock_preserves_both_updates() {
        let dir = std::env::temp_dir().join(format!("ccode-lock-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let value = dir.join("value");
        atomic_write(&value, b"0", false).unwrap();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        let _guard = lock_at(&dir.join("state.lock")).unwrap();
                        let path = dir.join("value");
                        let n: u32 = fs::read_to_string(&path).unwrap().parse().unwrap();
                        atomic_write(&path, (n + 1).to_string().as_bytes(), false).unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(fs::read_to_string(value).unwrap(), "40");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_replace_leaves_old_file_on_failure_and_no_temporary_residue() {
        let dir = std::env::temp_dir().join(format!("ccode-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file");
        atomic_write(&path, b"old", false).unwrap();
        atomic_write(&path, b"new", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(replace(&dir.join("missing"), &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn preserves_executable_mode_and_private_mode_from_creation() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ccode-mode-{}", uuid::Uuid::new_v4()));
        let path = dir.join("file");
        atomic_write(&path, b"one", true).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&path, b"two", false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
        atomic_write(&path, b"private", true).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

/// 网络响应的实际解压字节预算，不能只相信 Content-Length。
pub(crate) async fn response_bytes(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|len| len > cap as u64)
    {
        return Err(format!("响应超过 {} MB 安全上限", cap / 1024 / 1024));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?
    {
        if chunk.len() > cap.saturating_sub(bytes.len()) {
            return Err(format!("响应超过 {} MB 安全上限", cap / 1024 / 1024));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
