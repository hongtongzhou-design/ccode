//! 定时产物证据：工作目录可复用，但评审和采纳只读每次执行冻结的副本。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const FILE_CAP: u64 = 2 * 1024 * 1024;
const SNAPSHOT_CAP: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchFile {
    pub path: String,
    pub before: Option<String>,
    pub initial: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchSnapshot {
    pub run_id: String,
    pub project_root: String,
    pub files: Vec<WatchFile>,
}

pub(crate) fn review_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定配置目录")?
        .join("ccode/watch-reviews"))
}

fn snapshot_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效的运行编号")?;
    Ok(dir.join(format!("{id}.json")))
}

// 只允许固定产物；即使父目录是 symlink 也不能越出给定根。
fn checked_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !crate::scheduler::WATCH_ADOPT_FILES.contains(&rel) {
        return Err(format!("不允许采纳此路径：{rel}"));
    }
    let root = crate::paths::canonicalize_plain(root).map_err(|e| format!("目录不可用：{e}"))?;
    let target = root.join(rel);
    let mut probe = target.as_path();
    loop {
        match fs::symlink_metadata(probe) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!("产物路径不允许符号链接：{rel}"));
                }
                let actual = crate::paths::canonicalize_plain(probe).map_err(|e| e.to_string())?;
                if !crate::paths::path_within_path(&actual, &root) {
                    return Err(format!("产物路径超出项目：{rel}"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("检查产物路径失败：{e}")),
        }
        if probe == root {
            break;
        }
        probe = probe.parent().ok_or("产物路径无效")?;
    }
    Ok(target)
}

fn read_text(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let path = checked_path(root, rel)?;
    match fs::metadata(&path) {
        Ok(meta) if !meta.is_file() => return Err(format!("产物不是普通文件：{rel}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 {rel} 失败：{e}")),
        _ => {}
    }
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 {rel} 失败：{e}")),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err(format!("产物不是普通文件：{rel}"));
    }
    let mut bytes = Vec::new();
    file.take(FILE_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > FILE_CAP {
        return Err(format!("{rel} 超过 2 MB，不能自动采纳"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("{rel} 不是 UTF-8 文本"))
}

pub(crate) fn prepare(
    run_id: &str,
    project: &Path,
    isolation: &Path,
) -> Result<WatchSnapshot, String> {
    let mut files = Vec::new();
    for rel in crate::scheduler::WATCH_ADOPT_FILES {
        files.push(WatchFile {
            path: (*rel).into(),
            before: read_text(project, rel)?,
            initial: read_text(isolation, rel)?,
            after: None,
        });
    }
    Ok(WatchSnapshot {
        run_id: run_id.into(),
        project_root: project.to_string_lossy().into_owned(),
        files,
    })
}

// 失败不先删目标；新文件从创建起即 0600。只在同目录 rename，保留已有权限。
fn replace_text(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("目标没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".ccode-review-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
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
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions()).map_err(|e| e.to_string())?;
        }
        drop(file);
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub(crate) fn freeze_at(
    dir: &Path,
    mut snapshot: WatchSnapshot,
    isolation: &Path,
) -> Result<(), String> {
    for file in &mut snapshot.files {
        file.after = read_text(isolation, &file.path)?;
    }
    let _lock = adopt_lock(dir)?;
    let path = snapshot_path(dir, &snapshot.run_id)?;
    if path.exists() {
        return Err("本次运行已有冻结证据，拒绝改写".into());
    }
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SNAPSHOT_CAP {
        return Err("产物证据超过安全容量上限".into());
    }
    replace_text(&path, &bytes)
}

pub(crate) fn load_at(dir: &Path, id: &str) -> Result<WatchSnapshot, String> {
    let path = snapshot_path(dir, id)?;
    let file = fs::File::open(path).map_err(|_| "本次运行没有冻结产物证据（旧记录或运行未成功完成），不能自动采纳；请检查工作目录并手动合并".to_string())?;
    let mut bytes = Vec::new();
    file.take(SNAPSHOT_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SNAPSHOT_CAP {
        return Err("产物证据过大".into());
    }
    let snapshot: WatchSnapshot =
        serde_json::from_slice(&bytes).map_err(|e| format!("产物证据损坏：{e}"))?;
    if snapshot.run_id != id {
        return Err("产物证据与运行编号不一致".into());
    }
    if snapshot.files.len() != crate::scheduler::WATCH_ADOPT_FILES.len() {
        return Err("产物证据清单不完整".into());
    }
    for rel in crate::scheduler::WATCH_ADOPT_FILES {
        if snapshot.files.iter().filter(|f| f.path == *rel).count() != 1 {
            return Err("产物证据路径不完整或重复".into());
        }
    }
    Ok(snapshot)
}

/// 对 Mesa 采纳操作跨进程互斥；外部编辑器仍使用内容基线乐观检查。
fn adopt_lock(dir: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("adopt.lock"))
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "另一个采纳操作正在执行，请稍后重试")?;
    Ok(file)
}

pub(crate) fn adopt_at(
    dir: &Path,
    snapshot: &WatchSnapshot,
    project: &Path,
    protected: &[String],
) -> Result<Vec<String>, String> {
    adopt_with_writer(dir, snapshot, project, protected, replace_text)
}

fn adopt_with_writer(
    dir: &Path,
    snapshot: &WatchSnapshot,
    project: &Path,
    protected: &[String],
    mut write: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let _lock = adopt_lock(dir)?;
    let mut pending = Vec::new();
    for file in &snapshot.files {
        if file.initial == file.after {
            continue;
        }
        // 与 runs.rs 验收写回同一判定（含大小写折叠）：保护 NOTES/ 时 notes/ 下写回也要拦
        if crate::projects::path_is_protected(&file.path, protected) {
            return Err(format!("保护路径不可覆盖：{}", file.path));
        }
        let current = read_text(project, &file.path)?;
        if current == file.after {
            continue;
        }
        if file.after.is_none() {
            return Err(format!(
                "{} 在任务中被删除；请手动确认删除，不自动采纳",
                file.path
            ));
        }
        if current != file.before || file.initial != file.before {
            return Err(format!(
                "{} 与任务起始版本冲突，未写入任何文件；请对比冻结证据后手动合并",
                file.path
            ));
        }
        pending.push(file);
    }
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let backup = dir
        .join("backups")
        .join(&snapshot.run_id)
        .join(uuid::Uuid::new_v4().to_string());
    // 写任何项目文件前，持久化整批恢复材料（None 代表原文件不存在）。
    replace_text(
        &backup.join("before.json"),
        &serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )?;
    let mut written: Vec<&WatchFile> = Vec::new();
    for file in pending {
        let result = (|| {
            if read_text(project, &file.path)? != file.before {
                return Err(format!("{} 在采纳期间变化", file.path));
            }
            let target = checked_path(project, &file.path)?;
            write(&target, file.after.as_deref().unwrap().as_bytes())
        })();
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            for old in written.iter().rev() {
                let rollback = (|| {
                    if read_text(project, &old.path)? != old.after {
                        return Err("文件再次被外部修改，未强制回滚".to_string());
                    }
                    let target = checked_path(project, &old.path)?;
                    match &old.before {
                        Some(text) => replace_text(&target, text.as_bytes()),
                        None => fs::remove_file(target).map_err(|e| e.to_string()),
                    }
                })();
                if let Err(e) = rollback {
                    rollback_errors.push(format!("{}: {e}", old.path));
                }
            }
            return Err(format!(
                "采纳失败：{error}。已尝试回滚；恢复备份：{}。{}",
                backup.display(),
                rollback_errors.join("；")
            ));
        }
        written.push(file);
    }
    Ok(written.iter().map(|f| f.path.clone()).collect())
}

#[tauri::command]
pub async fn watch_run_snapshot(run_id: String) -> Result<WatchSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = crate::runs::run_get(run_id.clone())?.ok_or("运行记录不存在")?;
        if run.task_kind != "watch" {
            return Err("不是定时任务".into());
        }
        let mut snapshot = load_at(&review_dir()?, &run_id)?;
        for file in &mut snapshot.files {
            file.before = file
                .before
                .take()
                .map(|s| crate::sessions::redact_sensitive_text(&s));
            file.initial = file
                .initial
                .take()
                .map(|s| crate::sessions::redact_sensitive_text(&s));
            file.after = file
                .after
                .take()
                .map(|s| crate::sessions::redact_sensitive_text(&s));
        }
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        project: PathBuf,
        isolation: PathBuf,
        reviews: PathBuf,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ccode-watch-review-{}", uuid::Uuid::new_v4()));
            let project = root.join("project");
            let isolation = root.join("isolation");
            let reviews = root.join("reviews");
            for dir in [&project, &isolation] {
                fs::create_dir_all(dir.join("notes")).unwrap();
                fs::write(dir.join("notes/inbox.md"), "original").unwrap();
            }
            Self {
                root,
                project,
                isolation,
                reviews,
                id: uuid::Uuid::new_v4().to_string(),
            }
        }
        fn freeze(&self) -> WatchSnapshot {
            let evidence = prepare(&self.id, &self.project, &self.isolation).unwrap();
            fs::write(self.isolation.join("notes/inbox.md"), "result").unwrap();
            freeze_at(&self.reviews, evidence, &self.isolation).unwrap();
            load_at(&self.reviews, &self.id).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn frozen_evidence_does_not_follow_reused_directory() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        fs::write(f.isolation.join("notes/inbox.md"), "next run").unwrap();
        let loaded = load_at(&f.reviews, &f.id).unwrap();
        assert_eq!(
            loaded
                .files
                .iter()
                .find(|x| x.path == "notes/inbox.md")
                .unwrap()
                .after
                .as_deref(),
            Some("result")
        );
        let paths = adopt_at(&f.reviews, &snapshot, &f.project, &[]).unwrap();
        assert_eq!(paths, vec!["notes/inbox.md"]);
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "result"
        );
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[])
            .unwrap()
            .is_empty());
        assert!(freeze_at(&f.reviews, snapshot, &f.isolation).is_err());
        assert!(f.reviews.join("backups").join(&f.id).is_dir());
    }

    #[test]
    fn project_change_conflicts_without_overwrite() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        fs::write(f.project.join("notes/inbox.md"), "human edits").unwrap();
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[])
            .unwrap_err()
            .contains("冲突"));
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "human edits"
        );
    }

    #[test]
    fn stale_isolation_cannot_erase_changes_already_present_at_start() {
        let f = Fixture::new();
        fs::write(f.project.join("notes/inbox.md"), "main newer").unwrap();
        let snapshot = f.freeze();
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[])
            .unwrap_err()
            .contains("冲突"));
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "main newer"
        );
    }

    #[test]
    fn validates_all_files_before_writing_and_honors_protected_paths() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        assert!(adopt_at(
            &f.reviews,
            &snapshot,
            &f.project,
            &["notes/references.bib".into()]
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "original"
        );
        assert!(!f.project.join("notes/references.bib").exists());
    }

    #[test]
    fn protected_paths_match_case_insensitively_on_adopt() {
        // 保护「NOTES」时，APFS/NTFS 上 notes/ 是同一目录，写回必须拦
        //（与 projects::path_is_protected 的 path_key_folded 同一口径）
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &["NOTES".into()]).is_err());
        assert!(!f.project.join("notes/references.bib").exists());
    }

    #[test]
    fn refuses_deleted_outputs_and_missing_snapshot() {
        let f = Fixture::new();
        assert!(load_at(&f.reviews, &f.id).unwrap_err().contains("没有冻结"));
        let evidence = prepare(&f.id, &f.project, &f.isolation).unwrap();
        fs::remove_file(f.isolation.join("notes/inbox.md")).unwrap();
        freeze_at(&f.reviews, evidence, &f.isolation).unwrap();
        assert!(adopt_at(
            &f.reviews,
            &load_at(&f.reviews, &f.id).unwrap(),
            &f.project,
            &[]
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "original"
        );
        assert!(snapshot_path(&f.reviews, "../escape").is_err());
    }

    #[test]
    fn adoption_lock_excludes_second_writer_and_releases_on_drop() {
        let f = Fixture::new();
        let lock = adopt_lock(&f.reviews).unwrap();
        assert!(adopt_lock(&f.reviews).is_err());
        drop(lock);
        assert!(adopt_lock(&f.reviews).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn parent_symlink_cannot_escape_or_create_external_directories() {
        let f = Fixture::new();
        let snapshot = f.freeze();
        let outside = f.root.join("outside");
        fs::rename(f.project.join("notes"), &outside).unwrap();
        std::os::unix::fs::symlink(&outside, f.project.join("notes")).unwrap();
        assert!(adopt_at(&f.reviews, &snapshot, &f.project, &[]).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("inbox.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn second_file_failure_rolls_back_first_and_keeps_backup() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        let mut writes = 0;
        let error = adopt_with_writer(&f.reviews, &snapshot, &f.project, &[], |path, bytes| {
            writes += 1;
            if writes == 2 {
                return Err("模拟第二个文件写入失败".into());
            }
            replace_text(path, bytes)
        })
        .unwrap_err();
        assert!(error.contains("已尝试回滚"));
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "original"
        );
        assert!(!f.project.join("notes/references.bib").exists());
        assert!(f.reviews.join("backups").join(&f.id).is_dir());
    }

    #[test]
    fn rollback_does_not_erase_new_external_change() {
        let f = Fixture::new();
        let mut snapshot = f.freeze();
        snapshot
            .files
            .iter_mut()
            .find(|x| x.path == "notes/references.bib")
            .unwrap()
            .after = Some("refs".into());
        let mut writes = 0;
        let error = adopt_with_writer(&f.reviews, &snapshot, &f.project, &[], |path, bytes| {
            writes += 1;
            if writes == 2 {
                fs::write(f.project.join("notes/inbox.md"), "changed during adoption").unwrap();
                return Err("模拟写入失败".into());
            }
            replace_text(path, bytes)
        })
        .unwrap_err();
        assert!(error.contains("未强制回滚"));
        assert_eq!(
            fs::read_to_string(f.project.join("notes/inbox.md")).unwrap(),
            "changed during adoption"
        );
    }

    #[test]
    fn rejects_oversize_and_non_utf8_artifacts() {
        let f = Fixture::new();
        let path = f.project.join("notes/inbox.md");
        fs::write(&path, vec![b'x'; FILE_CAP as usize + 1]).unwrap();
        assert!(prepare(&f.id, &f.project, &f.isolation)
            .unwrap_err()
            .contains("2 MB"));
        fs::write(&path, [0xff]).unwrap();
        assert!(prepare(&f.id, &f.project, &f.isolation)
            .unwrap_err()
            .contains("UTF-8"));
    }
}
