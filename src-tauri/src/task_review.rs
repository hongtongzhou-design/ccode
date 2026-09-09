//! 普通目标评审证据：开工写项目基线哈希，收尾冻结变更内容；评审与采纳只读冻结副本。
//! 与 watch_review.rs 同构（冻结拒绝改写、采纳三向判定），但面向任务声明的任意输出范围，
//! 不是固定文件白名单。本模块只做文件事实，不碰数据库；编排（任务/Run  lookup、事件）在 runs.rs。
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 单文件超过 64 MB 不进冻结内容副本：进清单供人知悉，但不能自动采纳。
const PAYLOAD_FILE_CAP: u64 = 64 * 1024 * 1024;
/// 冻结内容总预算，与任务输入复制预算同量级。
const PAYLOAD_TOTAL_CAP: u64 = 512 * 1024 * 1024;
/// 单次遍历文件数上限，防失控目录把收尾卡死。
const WALK_FILE_CAP: usize = 20_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaselineEntry {
    pub path: String,
    /// 隔离目录里该文件在开工时的哈希。
    pub copy_sha256: String,
    /// 项目根里同路径文件在开工时的哈希；None = 当时项目里没有这个文件。
    pub project_sha256: Option<String>,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunBaseline {
    pub run_id: String,
    pub created_at: String,
    pub files: Vec<BaselineEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotChange {
    pub path: String,
    /// added / modified / deleted（deleted 只是证据，永不自动写回）。
    pub kind: String,
    pub sha256: Option<String>,
    pub size: u64,
    /// 超单文件上限未复制进 payload，只能人工处理。
    pub too_large: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultSnapshot {
    pub run_id: String,
    pub frozen_at: String,
    pub changes: Vec<SnapshotChange>,
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取文件失败（{}）：{e}", path.display()))?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0_u8; 8192];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("读取文件失败（{}）：{e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn rel_posix(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "路径不在目录内".to_string())?;
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() || text.split('/').any(|part| part == "..") {
        return Err("路径必须是目录内相对路径".into());
    }
    Ok(text)
}

/// 按输出范围收集隔离目录里的普通文件（相对 posix 路径，排序去重）。
/// 范围含 "." = 整个目录；符号链接文件直接报错（fail-closed，冻结缺失比冻结错的内容好）。
fn collect_scoped_files(root: &Path, output_paths: &[String]) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = if output_paths.iter().any(|path| path == ".") {
        vec![root.to_path_buf()]
    } else {
        output_paths
            .iter()
            .map(|raw| root.join(raw.trim_matches('/')))
            .filter(|path| path.exists())
            .collect()
    };
    while let Some(dir_or_file) = stack.pop() {
        let metadata = fs::symlink_metadata(&dir_or_file)
            .map_err(|e| format!("读取任务输出失败：{e}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("任务输出不允许符号链接：{}", dir_or_file.display()));
        }
        if metadata.is_dir() {
            let mut entries = fs::read_dir(&dir_or_file)
                .map_err(|e| format!("读取任务输出失败：{e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取任务输出失败：{e}"))?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                stack.push(entry.path());
            }
        } else if metadata.is_file() {
            files.push(rel_posix(root, &dir_or_file)?);
            if files.len() > WALK_FILE_CAP {
                return Err(format!("任务输出超过 {WALK_FILE_CAP} 个文件，不能冻结"));
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn path_in_scope(path: &str, output_paths: &[String]) -> bool {
    output_paths.iter().any(|raw| {
        let scope = raw.trim_matches('/');
        scope == "." || path == scope || path.starts_with(&format!("{scope}/"))
    })
}

/// 开工基线：对隔离目录现状（= 刚复制好的输入）逐文件记哈希，同时记项目根同路径哈希。
/// 复用上一版目录时两侧可以不一致——那正是本版要防的漂移起点。
pub(crate) fn write_baseline(
    dir: &Path,
    run_id: &str,
    run_root: &Path,
    project_root: &Path,
    created_at: &str,
) -> Result<RunBaseline, String> {
    let mut files = Vec::new();
    for relative in collect_scoped_files(run_root, &[".".to_string()])? {
        let (copy_sha256, size) = hash_file(&run_root.join(&relative))?;
        let project_path = project_root.join(&relative);
        let project_sha256 = match fs::symlink_metadata(&project_path) {
            Ok(meta) if meta.is_file() => Some(hash_file(&project_path)?.0),
            Ok(_) => return Err(format!("项目内路径不是普通文件：{relative}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读取项目文件失败（{relative}）：{e}")),
        };
        files.push(BaselineEntry {
            path: relative,
            copy_sha256,
            project_sha256,
            size,
        });
    }
    let baseline = RunBaseline {
        run_id: run_id.into(),
        created_at: created_at.into(),
        files,
    };
    fs::create_dir_all(dir).map_err(|e| format!("创建评审证据目录失败：{e}"))?;
    let path = dir.join("baseline.json");
    if path.exists() {
        return Err("本次运行已有开工基线，拒绝改写".into());
    }
    crate::profiles::atomic_write_bytes(
        &path,
        &serde_json::to_vec(&baseline).map_err(|e| e.to_string())?,
    )?;
    Ok(baseline)
}

pub(crate) fn load_baseline(dir: &Path) -> Result<Option<RunBaseline>, String> {
    let path = dir.join("baseline.json");
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("开工基线损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取开工基线失败：{e}")),
    }
}

/// 收尾冻结：隔离目录现状对基线现算 diff，变化文件内容复制进 payload/，快照拒绝改写。
/// 没有基线（机制上线前的旧 Run）返回 Ok(None)，不伪造证据。
pub(crate) fn freeze(
    dir: &Path,
    run_id: &str,
    run_root: &Path,
    output_paths: &[String],
    frozen_at: &str,
) -> Result<Option<ResultSnapshot>, String> {
    let Some(baseline) = load_baseline(dir)? else {
        return Ok(None);
    };
    let snapshot_path = dir.join("snapshot.json");
    if snapshot_path.exists() {
        return Err("本次运行已有冻结证据，拒绝改写".into());
    }
    let baseline_by_path: std::collections::HashMap<&str, &BaselineEntry> = baseline
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut changes = Vec::new();
    let mut payload_bytes = 0_u64;
    let payload = dir.join("payload");
    for relative in collect_scoped_files(run_root, output_paths)? {
        let (sha256, size) = hash_file(&run_root.join(&relative))?;
        let kind = match baseline_by_path.get(relative.as_str()) {
            Some(entry) if entry.copy_sha256 == sha256 => continue,
            Some(_) => "modified",
            None => "added",
        };
        let too_large = size > PAYLOAD_FILE_CAP;
        if !too_large {
            if payload_bytes + size > PAYLOAD_TOTAL_CAP {
                return Err("冻结内容超过总预算，未写入任何快照".into());
            }
            let dest = payload.join(&relative);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建冻结目录失败：{e}"))?;
            }
            crate::profiles::atomic_write_bytes(&dest, &fs::read(run_root.join(&relative)).map_err(|e| format!("读取任务输出失败：{e}"))?)?;
            payload_bytes += size;
        }
        changes.push(SnapshotChange {
            path: relative,
            kind: kind.into(),
            sha256: Some(sha256),
            size,
            too_large,
        });
    }
    // 基线内、范围内、现已消失 = 删除证据；只记录，永不自动写回。
    for entry in &baseline.files {
        if path_in_scope(&entry.path, output_paths) && !run_root.join(&entry.path).exists() {
            changes.push(SnapshotChange {
                path: entry.path.clone(),
                kind: "deleted".into(),
                sha256: None,
                size: 0,
                too_large: false,
            });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    let snapshot = ResultSnapshot {
        run_id: run_id.into(),
        frozen_at: frozen_at.into(),
        changes,
    };
    crate::profiles::atomic_write_bytes(
        &snapshot_path,
        &serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?,
    )?;
    Ok(Some(snapshot))
}

pub(crate) fn load_snapshot(dir: &Path) -> Result<Option<ResultSnapshot>, String> {
    let path = dir.join("snapshot.json");
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("冻结证据损坏：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取冻结证据失败：{e}")),
    }
}

/// 冻结内容副本里的某个文件（校验相对路径不越出 payload）。
/// 有效上下文快照（审计 §4.8）：开工一刻实际下发给 Agent 的上下文全文
/// （Context Pack + 目标行），不是摘要。写入后拒绝改写，评审时可核对
/// 「这版成果是基于什么材料做出来的」。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextSnapshot {
    pub run_id: String,
    pub created_at: String,
    pub sha256: String,
    pub text: String,
}

pub(crate) fn write_context_snapshot(
    dir: &Path,
    run_id: &str,
    text: &str,
    created_at: &str,
) -> Result<ContextSnapshot, String> {
    let snapshot = ContextSnapshot {
        run_id: run_id.into(),
        created_at: created_at.into(),
        sha256: format!("{:x}", sha2::Sha256::digest(text.as_bytes())),
        text: text.into(),
    };
    fs::create_dir_all(dir).map_err(|e| format!("创建评审证据目录失败：{e}"))?;
    let path = dir.join("context.json");
    if path.exists() {
        return Err("本次运行已有上下文快照，拒绝改写".into());
    }
    crate::profiles::atomic_write_bytes(
        &path,
        &serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?,
    )?;
    Ok(snapshot)
}

pub(crate) fn load_context_snapshot(dir: &Path) -> Result<Option<ContextSnapshot>, String> {
    let path = dir.join("context.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let snapshot: ContextSnapshot =
                serde_json::from_slice(&bytes).map_err(|e| format!("上下文快照损坏：{e}"))?;
            // 出站前校验内容仍与记录一致（防证据目录被外部动过）
            if snapshot.sha256 != format!("{:x}", sha2::Sha256::digest(snapshot.text.as_bytes())) {
                return Err("上下文快照内容与哈希不一致，证据目录可能被改动".into());
            }
            Ok(Some(snapshot))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取上下文快照失败：{e}")),
    }
}

pub(crate) fn payload_file(dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let cleaned = relative.trim_matches('/');
    if cleaned.is_empty()
        || cleaned
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("冻结路径必须是相对路径".into());
    }
    Ok(dir.join("payload").join(cleaned))
}

/// 采纳前逐文件三向判定：项目现读 vs 开工基线 vs 冻结内容。
/// 通过的文件返回其 payload 路径；任何一个冲突即整批拒绝并点名（不部分写入）。
/// 同时校验 payload 实际内容仍等于冻结时记录的哈希（防快照目录被外部动过）。
pub(crate) fn check_adoption(
    dir: &Path,
    snapshot: &ResultSnapshot,
    baseline: Option<&RunBaseline>,
    selected: &[String],
    project_root: &Path,
) -> Result<Vec<(String, PathBuf)>, String> {
    let baseline_by_path: std::collections::HashMap<&str, &BaselineEntry> = baseline
        .map(|baseline| {
            baseline
                .files
                .iter()
                .map(|entry| (entry.path.as_str(), entry))
                .collect()
        })
        .unwrap_or_default();
    let mut planned = Vec::new();
    for relative in selected {
        let change = snapshot
            .changes
            .iter()
            .find(|change| &change.path == relative)
            .ok_or_else(|| format!("没有可采纳的冻结变更：{relative}"))?;
        if change.kind == "deleted" {
            return Err(format!("{relative} 在副本中被删除；删除不自动写回，请在项目中手动处理"));
        }
        if change.too_large {
            return Err(format!("{relative} 超过单文件冻结上限，未进冻结副本；请手动复制"));
        }
        let source = payload_file(dir, relative)?;
        let (actual_sha, _) = hash_file(&source)?;
        if Some(&actual_sha) != change.sha256.as_ref() {
            return Err(format!("{relative} 的冻结内容与记录不一致，证据目录可能被改动，拒绝采纳"));
        }
        let target = project_root.join(relative);
        let current = match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("项目文件是符号链接，拒绝覆盖：{relative}"));
            }
            Ok(meta) if meta.is_file() => Some(hash_file(&target)?.0),
            Ok(_) => return Err(format!("输出目标是目录：{relative}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读取项目文件失败（{relative}）：{e}")),
        };
        if current.as_deref() == change.sha256.as_deref() {
            continue; // 项目已是目标内容
        }
        let allowed = match baseline_by_path.get(relative.as_str()) {
            Some(entry) => current == entry.project_sha256,
            None => current.is_none(),
        };
        if !allowed {
            return Err(format!(
                "{relative} 在任务开始后已被修改（与开工基线不一致），未写入任何文件；请先对比再决定"
            ));
        }
        planned.push((relative.clone(), source));
    }
    Ok(planned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ccode-task-review-{}", uuid::Uuid::new_v4()));
        let run = base.join("run");
        let project = base.join("project");
        fs::create_dir_all(run.join("notes")).unwrap();
        fs::create_dir_all(project.join("notes")).unwrap();
        (base, run, project)
    }

    #[test]
    fn context_snapshot_roundtrip_and_refuse_rewrite() {
        let (base, _run, _project) = fixture();
        let review = base.join("review");
        write_context_snapshot(&review, "r1", "上下文全文 v1", "now").unwrap();
        assert!(write_context_snapshot(&review, "r1", "别的内容", "later").is_err());
        let loaded = load_context_snapshot(&review).unwrap().unwrap();
        assert_eq!(loaded.text, "上下文全文 v1");
        // 篡改内容后哈希对不上，读取即拒绝
        let path = review.join("context.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["text"] = serde_json::Value::String("被改过".into());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(load_context_snapshot(&review).is_err());
        assert!(load_context_snapshot(&base.join("empty")).unwrap().is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn baseline_then_freeze_marks_modified_added_deleted() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        fs::write(run.join("notes/a.md"), "a1").unwrap();
        fs::write(project.join("notes/a.md"), "a1").unwrap();
        fs::write(run.join("notes/gone.md"), "g").unwrap();
        fs::write(project.join("notes/gone.md"), "g").unwrap();
        write_baseline(&review, "r1", &run, &project, "now").unwrap();
        // 开工后：改一个、加一个、删一个；项目侧 a.md 保持开工内容
        fs::write(run.join("notes/a.md"), "a2").unwrap();
        fs::write(run.join("notes/new.md"), "n").unwrap();
        fs::remove_file(run.join("notes/gone.md")).unwrap();
        let snapshot = freeze(&review, "r1", &run, &[".".to_string()], "later")
            .unwrap()
            .unwrap();
        let kinds: Vec<(&str, &str)> = snapshot
            .changes
            .iter()
            .map(|change| (change.path.as_str(), change.kind.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("notes/a.md", "modified"),
                ("notes/gone.md", "deleted"),
                ("notes/new.md", "added")
            ]
        );
        assert_eq!(
            fs::read(review.join("payload/notes/a.md")).unwrap(),
            b"a2"
        );
        // 冻结拒绝改写
        assert!(freeze(&review, "r1", &run, &[".".to_string()], "again").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn freeze_without_baseline_is_skipped_not_forged() {
        let (base, run, _project) = fixture();
        let review = base.join("review");
        assert!(freeze(&review, "r1", &run, &[".".to_string()], "now")
            .unwrap()
            .is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn adoption_rejects_project_drift_and_payload_tamper() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        fs::write(run.join("a.md"), "v1").unwrap();
        fs::write(project.join("a.md"), "v1").unwrap();
        write_baseline(&review, "r1", &run, &project, "now").unwrap();
        fs::write(run.join("a.md"), "v2").unwrap();
        fs::write(run.join("b.md"), "new").unwrap();
        let snapshot = freeze(&review, "r1", &run, &[".".to_string()], "later")
            .unwrap()
            .unwrap();
        let baseline = load_baseline(&review).unwrap().unwrap();
        // 用户在任务期间把项目里的 a.md 改成 v9：冲突，拒绝
        fs::write(project.join("a.md"), "v9").unwrap();
        let err = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string()],
            &project,
        )
        .unwrap_err();
        assert!(err.contains("开工基线"), "{err}");
        // 项目保持基线内容：放行；b.md 项目里不存在：放行
        fs::write(project.join("a.md"), "v1").unwrap();
        let planned = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string(), "b.md".to_string()],
            &project,
        )
        .unwrap();
        assert_eq!(planned.len(), 2);
        // 新增文件但项目里已被别人建了同名文件：冲突
        fs::write(project.join("b.md"), "someone-else").unwrap();
        assert!(check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["b.md".to_string()],
            &project,
        )
        .is_err());
        fs::remove_file(project.join("b.md")).unwrap();
        // payload 被外部改动：哈希对不上，拒绝
        fs::write(review.join("payload/a.md"), "tampered").unwrap();
        let err = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string()],
            &project,
        )
        .unwrap_err();
        assert!(err.contains("不一致"), "{err}");
        // 项目已是冻结内容：跳过（幂等）
        fs::remove_dir_all(review.join("payload")).unwrap();
        fs::create_dir_all(review.join("payload")).unwrap();
        fs::write(review.join("payload/a.md"), "v2").unwrap();
        fs::write(project.join("a.md"), "v2").unwrap();
        let planned = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string()],
            &project,
        )
        .unwrap();
        assert!(planned.is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn adoption_never_writes_back_deletions() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        fs::write(run.join("a.md"), "v1").unwrap();
        fs::write(project.join("a.md"), "v1").unwrap();
        write_baseline(&review, "r1", &run, &project, "now").unwrap();
        fs::remove_file(run.join("a.md")).unwrap();
        let snapshot = freeze(&review, "r1", &run, &[".".to_string()], "later")
            .unwrap()
            .unwrap();
        let baseline = load_baseline(&review).unwrap().unwrap();
        let err = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string()],
            &project,
        )
        .unwrap_err();
        assert!(err.contains("删除"), "{err}");
        assert_eq!(fs::read(project.join("a.md")).unwrap(), b"v1");
        fs::remove_dir_all(base).unwrap();
    }
}
