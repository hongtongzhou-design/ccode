//! 普通目标评审证据：开工写项目基线哈希，收尾冻结变更内容；评审与采纳只读冻结副本。
//! 与 watch_review.rs 同构（冻结拒绝改写、采纳三向判定），但面向任务声明的任意输出范围，
//! 不是固定文件白名单。本模块只做文件事实，不碰数据库；编排（任务/Run  lookup、事件）在 runs.rs。
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 单文件超过 64 MB 不进冻结内容副本：进清单供人知悉，但不能自动采纳。
const PAYLOAD_FILE_CAP: u64 = 64 * 1024 * 1024;
/// 冻结内容总预算，与任务输入复制预算同量级。
const PAYLOAD_TOTAL_CAP: u64 = 512 * 1024 * 1024;
/// 单次遍历文件数上限，防失控目录把收尾卡死。
const WALK_FILE_CAP: usize = 20_000;
/// 小文件在基线里同时存内容哈希：stat 变了但内容没变（保存未改/撤销编辑）不算漂移；
/// 大文件（PDF/数据）stat-only，靠 stat 判漂移。阈值以下是「人会编辑的文本」量级。
const SMALL_HASH_CAP: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaselineEntry {
    pub path: String,
    /// stat 快路径（size + mtime 纳秒）：与 git 的 stat-dirty 判定同源——stat 未变即未变，
    /// 不读文件内容；stat 变了按变化处理（保守，宁多报不漏报）。Option = 旧格式基线
    /// （2026-09-09 前只有内容哈希）回落哈希比对；文件系统不给 mtime 时同样回落。
    #[serde(default)]
    pub copy_size: Option<u64>,
    #[serde(default)]
    pub copy_mtime_ns: Option<i64>,
    #[serde(default)]
    pub project_size: Option<u64>,
    #[serde(default)]
    pub project_mtime_ns: Option<i64>,
    /// 旧基线格式的内容哈希（新基线为 None）
    #[serde(default)]
    pub copy_sha256: Option<String>,
    /// 旧基线格式：项目根同路径文件在开工时的哈希；None = 当时项目里没有这个文件。
    #[serde(default)]
    pub project_sha256: Option<String>,
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
    /// 同一 Run 内的冻结版本号：回合结束再冻结（freeze_or_refresh）递增；
    /// 采纳端按它绑定「人看过的那版」，对不上 = 看过之后又有新成果。
    #[serde(default)]
    pub seq: u32,
    pub changes: Vec<SnapshotChange>,
    /// 新版副本按 UUID 独立保存；None 兼容旧版 payload/，旧副本不迁走。
    #[serde(default)]
    pub payload_id: Option<String>,
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("读取文件失败（{}）：{e}", path.display()))?;
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

/// 文件签名：(大小, mtime 纳秒)；None = 不存在。mtime 为 None = 文件系统不提供，
/// 该文件的 stat 快路径自动失效（回落哈希或按变化处理）。
fn stat_sig(path: &Path, label: &str) -> Result<Option<(u64, Option<i64>)>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{label}失败（{}）：{e}", path.display())),
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("{label}不能是符号链接：{}", path.display()))
        }
        Ok(meta) if !meta.is_file() => Err(format!("{label}不是普通文件：{}", path.display())),
        Ok(meta) => Ok(Some((
            meta.len(),
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i64),
        ))),
    }
}

/// 基线判「未变」：stat 快路径优先；stat 变了且有小文件哈希则内容比对（保存未改不算变）；
/// 大文件无哈希可回落 = 按变化处理（保守）。
fn unchanged_by_baseline(
    entry: &BaselineEntry,
    size: u64,
    mtime_ns: Option<i64>,
    hash: impl FnOnce() -> Result<String, String>,
) -> Result<bool, String> {
    if let (Some(base_size), Some(base_mtime), Some(cur_mtime)) =
        (entry.copy_size, entry.copy_mtime_ns, mtime_ns)
    {
        if base_size == size && base_mtime == cur_mtime {
            return Ok(true);
        }
    }
    if let Some(base_hash) = &entry.copy_sha256 {
        return Ok(*base_hash == hash()?);
    }
    // 纯 stat 基线：两侧都有 mtime 且不同 = 已变化；stat 不可用（任一侧无 mtime）只剩大小可判
    Ok(entry.copy_size == Some(size) && (entry.copy_mtime_ns.is_none() || mtime_ns.is_none()))
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
        let metadata =
            fs::symlink_metadata(&dir_or_file).map_err(|e| format!("读取任务输出失败：{e}"))?;
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

/// 开工基线：对隔离目录现状（= 刚复制好的输入）逐文件记 stat 签名（不读内容），
/// 同时记项目根同路径签名。复用上一版目录时两侧可以不一致——那正是本版要防的漂移起点。
pub(crate) fn write_baseline(
    dir: &Path,
    run_id: &str,
    run_root: &Path,
    project_root: &Path,
    created_at: &str,
) -> Result<RunBaseline, String> {
    let mut files = Vec::new();
    for relative in collect_scoped_files(run_root, &[".".to_string()])? {
        let (copy_size, copy_mtime_ns) = stat_sig(&run_root.join(&relative), "读取任务副本")?
            .ok_or_else(|| format!("读取任务副本失败：{relative}"))?;
        // 小文件顺带存内容哈希（stat 变但内容不变的「保存未改」不算漂移）；大文件 stat-only
        let copy_sha256 = if copy_size <= SMALL_HASH_CAP {
            Some(hash_file(&run_root.join(&relative))?.0)
        } else {
            None
        };
        let (project_size, project_mtime_ns, project_sha256) =
            match stat_sig(&project_root.join(&relative), "读取项目文件")? {
                Some((size, mtime)) => {
                    let hash = if size <= SMALL_HASH_CAP {
                        Some(hash_file(&project_root.join(&relative))?.0)
                    } else {
                        None
                    };
                    (Some(size), mtime, hash)
                }
                None => (None, None, None),
            };
        files.push(BaselineEntry {
            path: relative,
            copy_size: Some(copy_size),
            copy_mtime_ns,
            project_size,
            project_mtime_ns,
            copy_sha256,
            project_sha256,
        });
    }
    let baseline = RunBaseline {
        run_id: run_id.into(),
        created_at: created_at.into(),
        files,
    };
    save_baseline(dir, &baseline)?;
    Ok(baseline)
}

/// 返修继承原始基线，不能把尚未采纳的上一版成果当成新输入而从清单抹掉。
pub(crate) fn continue_baseline(
    dir: &Path,
    run_id: &str,
    previous_dir: &Path,
) -> Result<RunBaseline, String> {
    let mut baseline = load_baseline(previous_dir)?
        .ok_or("上一版没有开工基线，无法安全续改；请重新开始目标，旧副本仍保留")?;
    baseline.run_id = run_id.into();
    save_baseline(dir, &baseline)?;
    Ok(baseline)
}

fn save_baseline(dir: &Path, baseline: &RunBaseline) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建评审证据目录失败：{e}"))?;
    let path = dir.join("baseline.json");
    if path.exists() {
        return Err("本次运行已有开工基线，拒绝改写".into());
    }
    crate::profiles::atomic_write_bytes(
        &path,
        &serde_json::to_vec(baseline).map_err(|e| e.to_string())?,
    )
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

/// 收尾冻结内核：隔离目录现状对基线现算 diff（stat 快路径，只有变化文件读内容并复制进
/// payload_dir）。没有基线（机制上线前的旧 Run）返回 Ok(None)，不伪造证据。
fn build_snapshot(
    dir: &Path,
    payload_dir: &Path,
    run_id: &str,
    run_root: &Path,
    output_paths: &[String],
    frozen_at: &str,
    seq: u32,
) -> Result<Option<ResultSnapshot>, String> {
    let Some(baseline) = load_baseline(dir)? else {
        return Ok(None);
    };
    let baseline_by_path: std::collections::HashMap<&str, &BaselineEntry> = baseline
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut changes = Vec::new();
    let mut payload_bytes = 0_u64;
    let payload = payload_dir.to_path_buf();
    for relative in collect_scoped_files(run_root, output_paths)? {
        let file_path = run_root.join(&relative);
        let Some((cur_size, cur_mtime)) = stat_sig(&file_path, "读取任务输出")? else {
            continue;
        };
        let entry = baseline_by_path.get(relative.as_str());
        if let Some(entry) = entry {
            if unchanged_by_baseline(entry, cur_size, cur_mtime, || {
                hash_file(&file_path).map(|(hash, _)| hash)
            })? {
                continue;
            }
        }
        let kind = if entry.is_some() { "modified" } else { "added" };
        // 哈希与副本必须来自同一次读取，避免 Agent 写入时「哈希 A、复制 B」。
        let mut bytes = Vec::new();
        fs::File::open(&file_path)
            .map_err(|e| format!("读取任务输出失败：{e}"))?
            .take(PAYLOAD_FILE_CAP + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取任务输出失败：{e}"))?;
        let too_large = bytes.len() as u64 > PAYLOAD_FILE_CAP;
        let size = if too_large {
            cur_size.max(bytes.len() as u64)
        } else {
            bytes.len() as u64
        };
        let sha256 = if too_large {
            None
        } else {
            Some(format!("{:x}", sha2::Sha256::digest(&bytes)))
        };
        if !too_large {
            if payload_bytes + size > PAYLOAD_TOTAL_CAP {
                return Err("冻结内容超过总预算，未写入任何快照".into());
            }
            let dest = payload.join(&relative);
            crate::profiles::atomic_write_bytes(&dest, &bytes)?;
            payload_bytes += size;
        }
        changes.push(SnapshotChange {
            path: relative,
            kind: kind.into(),
            sha256,
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
    Ok(Some(ResultSnapshot {
        run_id: run_id.into(),
        frozen_at: frozen_at.into(),
        seq,
        changes,
        payload_id: None,
    }))
}

/// 冻结串行发布：每版先写独立副本与清单，再原子更新当前清单；失败不触碰旧版。
fn publish_snapshot(
    dir: &Path,
    run_id: &str,
    run_root: &Path,
    output_paths: &[String],
    frozen_at: &str,
    refresh: bool,
) -> Result<Option<ResultSnapshot>, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建评审证据目录失败：{e}"))?;
    let _lock = crate::storage::lock_at(&dir.join("freeze.lock"))?;
    let previous = load_snapshot(dir)?;
    if !refresh && previous.is_some() {
        return Err("本次运行已有冻结证据，拒绝改写".into());
    }
    let seq = previous
        .map_or(0, |s| s.seq)
        .checked_add(1)
        .ok_or("冻结版本号已达上限")?;
    let payload_id = uuid::Uuid::new_v4().to_string();
    let version_dir = dir.join("versions").join(&payload_id);
    let result = (|| {
        let Some(mut snapshot) = build_snapshot(
            dir,
            &version_dir.join("payload"),
            run_id,
            run_root,
            output_paths,
            frozen_at,
            seq,
        )?
        else {
            return Ok(None);
        };
        snapshot.payload_id = Some(payload_id);
        let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
        crate::profiles::atomic_write_bytes(&version_dir.join("snapshot.json"), &bytes)?;
        crate::profiles::atomic_write_bytes(&dir.join("snapshot.json"), &bytes)?;
        Ok(Some(snapshot))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(version_dir);
    }
    result
}

pub(crate) fn freeze(
    dir: &Path,
    run_id: &str,
    run_root: &Path,
    output_paths: &[String],
    frozen_at: &str,
) -> Result<Option<ResultSnapshot>, String> {
    publish_snapshot(dir, run_id, run_root, output_paths, frozen_at, false)
}

pub(crate) fn freeze_or_refresh(
    dir: &Path,
    run_id: &str,
    run_root: &Path,
    output_paths: &[String],
    frozen_at: &str,
) -> Result<Option<ResultSnapshot>, String> {
    publish_snapshot(dir, run_id, run_root, output_paths, frozen_at, true)
}

pub(crate) fn snapshot_payload_dir(
    dir: &Path,
    snapshot: &ResultSnapshot,
) -> Result<PathBuf, String> {
    match &snapshot.payload_id {
        Some(id) => {
            uuid::Uuid::parse_str(id).map_err(|_| "冻结副本标识损坏")?;
            Ok(dir.join("versions").join(id).join("payload"))
        }
        None => Ok(dir.join("payload")),
    }
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
pub(crate) struct ContextEnvironment {
    pub project_id: Option<String>,
    pub project_root: String,
    pub isolation_path: String,
    pub agent: String,
    pub permission: String,
    pub input_paths: Vec<String>,
    pub output_paths: Vec<String>,
    pub files: Vec<BaselineEntry>,
    pub rules: Vec<(String, String)>,
    pub memory_sha256: String,
    pub skills: Vec<crate::skills::SkillSnapshot>,
    pub warnings: Vec<String>,
}

pub(crate) fn collect_environment(
    project: &Path, run_root: &Path, agent: &str, permission: &str,
    input_paths: &[String], output_paths: &[String], skills: Vec<crate::skills::SkillSnapshot>, baseline: Option<RunBaseline>,
) -> Result<ContextEnvironment, String> {
    let read = crate::projects::read_config_at(project);
    if !read.warnings.is_empty() { return Err(format!("项目规则未能完整读取：{}", read.warnings.join("；"))); }
    let mut rules = Vec::new();
    for name in [".ccode/project.toml", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "TASK.md"] {
        let path = project.join(name);
        let mut bytes = Vec::new();
        match fs::File::open(&path) {
            Ok(file) => { file.take(512 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?; }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("读取规则 {name} 失败：{e}")),
        }
        if bytes.len() > 512 * 1024 { return Err(format!("规则 {name} 超过 512 KB，无法冻结")); }
        rules.push((name.into(), String::from_utf8(bytes).map_err(|_| format!("规则 {name} 不是 UTF-8"))?));
    }
    let memory = crate::project_memory::context_at(project)?;
    Ok(ContextEnvironment {
        project_id: crate::projects::project_id_at(project), project_root: project.to_string_lossy().into_owned(),
        isolation_path: run_root.to_string_lossy().into_owned(), agent: agent.into(), permission: permission.into(),
        input_paths: input_paths.into(), output_paths: output_paths.into(), files: baseline.map(|b| b.files).unwrap_or_default(), rules,
        memory_sha256: format!("{:x}", sha2::Sha256::digest(memory.as_bytes())), skills,
        warnings: vec!["记录的是启动时提供的材料与技能，不证明 Agent 实际读取或执行；父目录规则、CLI 内置指令和外部工具状态未封存。大文件基线以 stat 记录，非内容封存。".into()],
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextSnapshot {
    pub run_id: String,
    pub created_at: String,
    pub sha256: String,
    pub text: String,
    #[serde(default)]
    pub environment: Option<ContextEnvironment>,
    #[serde(default)]
    pub environment_sha256: Option<String>,
}

pub(crate) fn write_context_snapshot(
    dir: &Path,
    run_id: &str,
    text: &str,
    created_at: &str,
    environment: Option<ContextEnvironment>,
) -> Result<ContextSnapshot, String> {
    let environment_sha256 = environment.as_ref().map(|e| serde_json::to_vec(e)
        .map(|bytes| format!("{:x}", sha2::Sha256::digest(bytes)))).transpose().map_err(|e| e.to_string())?;
    let snapshot = ContextSnapshot {
        environment, environment_sha256,
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
            if let Some(environment) = &snapshot.environment {
                let bytes = serde_json::to_vec(environment).map_err(|e| e.to_string())?;
                if snapshot.environment_sha256.as_deref() != Some(format!("{:x}", sha2::Sha256::digest(bytes)).as_str()) {
                    return Err("工作环境清单与哈希不一致".into());
                }
            }
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

pub(crate) fn payload_file(
    dir: &Path,
    snapshot: &ResultSnapshot,
    relative: &str,
) -> Result<PathBuf, String> {
    let cleaned = relative.trim_matches('/');
    if cleaned.is_empty()
        || cleaned
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("冻结路径必须是相对路径".into());
    }
    Ok(snapshot_payload_dir(dir, snapshot)?.join(cleaned))
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
    accepted: &HashMap<String, String>,
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
            return Err(format!(
                "{relative} 在副本中被删除；删除不自动写回，请在项目中手动处理"
            ));
        }
        if change.too_large {
            return Err(format!(
                "{relative} 超过单文件冻结上限，未进冻结副本；请手动复制"
            ));
        }
        let source = payload_file(dir, snapshot, relative)?;
        let (actual_sha, _) = hash_file(&source)?;
        if Some(&actual_sha) != change.sha256.as_ref() {
            return Err(format!(
                "{relative} 的冻结内容与记录不一致，证据目录可能被改动，拒绝采纳"
            ));
        }
        let target = project_root.join(relative);
        let target_stat = stat_sig(&target, "读取项目文件")?;
        // 项目已是目标内容 → 跳过（幂等；只在这时读内容）
        let target_sha = if target_stat.is_some() {
            Some(hash_file(&target)?.0)
        } else {
            None
        };
        if target_sha.is_some() && target_sha == change.sha256 {
            continue;
        }
        // 同一目标此前已接受的内容也是合法前态；只认账本中的内容哈希，不拿现读文件重设基线。
        if target_sha
            .as_ref()
            .is_some_and(|sha| accepted.get(relative) == Some(sha))
        {
            planned.push((relative.clone(), source));
            continue;
        }
        let allowed = match baseline_by_path.get(relative.as_str()) {
            // 新格式基线：stat 口径比对项目侧开工签名；stat 变了但小文件内容哈希一致
            // （保存未改/撤销编辑）放行；大文件 stat 变了即保守判冲突
            Some(entry) if entry.project_size.is_some() => match target_stat {
                Some((size, mtime)) => {
                    let stat_same = Some(size) == entry.project_size
                        && match (entry.project_mtime_ns, mtime) {
                            (Some(base), Some(cur)) => base == cur,
                            _ => false,
                        };
                    stat_same
                        || match &entry.project_sha256 {
                            Some(base) => hash_file(&target)?.0 == *base,
                            None => false,
                        }
                }
                None => false, // 开工时项目里有、现在没了 = 漂移
            },
            // 旧格式基线（2026-09-09 前）：内容哈希口径
            Some(entry) if entry.project_sha256.is_some() => {
                target_stat.is_some()
                    && hash_file(&target)?.0 == *entry.project_sha256.as_ref().unwrap()
            }
            // 开工时项目里没有此文件（或新增）：要求现在也没有
            _ => target_stat.is_none(),
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

    #[test]
    fn refreshing_keeps_the_previously_reviewed_payload() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        write_baseline(&review, "r1", &run, &project, "start").unwrap();
        fs::write(run.join("report.md"), "reviewed version").unwrap();
        let first = freeze(&review, "r1", &run, &[".".into()], "t1")
            .unwrap()
            .unwrap();
        let baseline = load_baseline(&review).unwrap();
        let plan = check_adoption(
            &review,
            &first,
            baseline.as_ref(),
            &["report.md".into()],
            &project,
            &HashMap::new(),
        )
        .unwrap();
        fs::write(run.join("report.md"), "new unreviewed version").unwrap();
        let second = freeze_or_refresh(&review, "r1", &run, &[".".into()], "t2")
            .unwrap()
            .unwrap();
        assert_eq!(second.seq, first.seq + 1);
        assert_eq!(fs::read(&plan[0].1).unwrap(), b"reviewed version");
        assert!(check_adoption(
            &review,
            &first,
            baseline.as_ref(),
            &["report.md".into()],
            &project,
            &HashMap::new()
        )
        .is_ok());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn continuation_keeps_unchanged_unaccepted_outputs() {
        let (base, run, project) = fixture();
        let first_review = base.join("first");
        write_baseline(&first_review, "r1", &run, &project, "start").unwrap();
        fs::write(run.join("data.csv"), "value\n1\n").unwrap();
        fs::write(run.join("report.md"), "first report").unwrap();
        freeze(&first_review, "r1", &run, &[".".into()], "t1").unwrap();
        let next_review = base.join("second");
        continue_baseline(&next_review, "r2", &first_review).unwrap();
        fs::write(run.join("report.md"), "corrected report").unwrap();
        let next = freeze(&next_review, "r2", &run, &[".".into()], "t2")
            .unwrap()
            .unwrap();
        assert_eq!(
            next.changes
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            vec!["data.csv", "report.md"]
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn accepted_version_can_be_revised_without_allowing_external_drift() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        write_baseline(&review, "r1", &run, &project, "start").unwrap();
        fs::write(run.join("a.md"), "first result").unwrap();
        let first = freeze(&review, "r1", &run, &[".".into()], "t1")
            .unwrap()
            .unwrap();
        fs::copy(
            payload_file(&review, &first, "a.md").unwrap(),
            project.join("a.md"),
        )
        .unwrap();
        let accepted = HashMap::from([("a.md".into(), first.changes[0].sha256.clone().unwrap())]);
        let next_review = base.join("next-review");
        continue_baseline(&next_review, "r2", &review).unwrap();
        fs::write(run.join("a.md"), "revised result").unwrap();
        let next = freeze(&next_review, "r2", &run, &[".".into()], "t2")
            .unwrap()
            .unwrap();
        let baseline = load_baseline(&next_review).unwrap();
        assert_eq!(
            check_adoption(
                &next_review,
                &next,
                baseline.as_ref(),
                &["a.md".into()],
                &project,
                &accepted
            )
            .unwrap()
            .len(),
            1
        );
        fs::write(project.join("a.md"), "external change").unwrap();
        assert!(check_adoption(
            &next_review,
            &next,
            baseline.as_ref(),
            &["a.md".into()],
            &project,
            &accepted
        )
        .is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn refreshing_legacy_snapshot_keeps_its_payload_and_failed_refresh_keeps_current() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        write_baseline(&review, "r1", &run, &project, "start").unwrap();
        fs::write(run.join("a.md"), "legacy").unwrap();
        let legacy = build_snapshot(
            &review,
            &review.join("payload"),
            "r1",
            &run,
            &[".".into()],
            "t1",
            1,
        )
        .unwrap()
        .unwrap();
        crate::profiles::atomic_write_bytes(
            &review.join("snapshot.json"),
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        fs::write(review.join("versions"), "block directory creation").unwrap();
        fs::write(run.join("a.md"), "next version").unwrap();
        assert!(freeze_or_refresh(&review, "r1", &run, &[".".into()], "t2").is_err());
        assert_eq!(load_snapshot(&review).unwrap().unwrap().seq, 1);
        assert_eq!(
            fs::read(payload_file(&review, &legacy, "a.md").unwrap()).unwrap(),
            b"legacy"
        );
        fs::remove_file(review.join("versions")).unwrap();
        let next = freeze_or_refresh(&review, "r1", &run, &[".".into()], "t2")
            .unwrap()
            .unwrap();
        assert!(next.payload_id.is_some());
        assert_eq!(
            fs::read(payload_file(&review, &legacy, "a.md").unwrap()).unwrap(),
            b"legacy"
        );
        assert_eq!(
            fs::read(payload_file(&review, &next, "a.md").unwrap()).unwrap(),
            b"next version"
        );
        fs::remove_dir_all(base).unwrap();
    }

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ccode-task-review-{}", uuid::Uuid::new_v4()));
        let run = base.join("run");
        let project = base.join("project");
        fs::create_dir_all(run.join("notes")).unwrap();
        fs::create_dir_all(project.join("notes")).unwrap();
        (base, run, project)
    }

    #[test]
    fn stat_fastpath_skips_untouched_and_refresh_bumps_seq() {
        let (base, run, project) = fixture();
        let review = base.join("review");
        fs::write(run.join("notes/a.md"), "a1").unwrap();
        fs::write(project.join("notes/a.md"), "a1").unwrap();
        write_baseline(&review, "r1", &run, &project, "now").unwrap();
        // 未动 → 无变化（stat 快路径，不读内容）
        let snap = freeze(&review, "r1", &run, &[".".to_string()], "t1")
            .unwrap()
            .unwrap();
        assert!(snap.changes.is_empty());
        assert_eq!(snap.seq, 1);
        // 保存未改（mtime 变、内容同）→ 小文件哈希兜底，不算变化
        fs::write(run.join("notes/a.md"), "a1").unwrap();
        let snap2 = freeze_or_refresh(&review, "r1", &run, &[".".to_string()], "t2")
            .unwrap()
            .unwrap();
        assert!(
            snap2.changes.is_empty(),
            "保存未改不应报变化: {:?}",
            snap2.changes
        );
        assert_eq!(snap2.seq, 2);
        // 真改 → modified，seq 再进一位；payload 跟着换
        fs::write(run.join("notes/a.md"), "a2").unwrap();
        let snap3 = freeze_or_refresh(&review, "r1", &run, &[".".to_string()], "t3")
            .unwrap()
            .unwrap();
        assert_eq!(snap3.seq, 3);
        assert_eq!(snap3.changes.len(), 1);
        assert_eq!(snap3.changes[0].kind, "modified");
        assert_eq!(
            fs::read(payload_file(&review, &snap3, "notes/a.md").unwrap()).unwrap(),
            b"a2"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_hash_only_baseline_still_works() {
        // 2026-09-09 前的旧基线（只有内容哈希、没有 stat 字段）必须继续可用
        let (base, run, project) = fixture();
        let review = base.join("review");
        fs::create_dir_all(&review).unwrap();
        fs::write(run.join("a.md"), "v1").unwrap();
        fs::write(project.join("a.md"), "v1").unwrap();
        let hash = format!("{:x}", sha2::Sha256::digest(b"v1"));
        fs::write(
            review.join("baseline.json"),
            serde_json::to_string(&serde_json::json!({
                "runId": "r1", "createdAt": "old",
                "files": [{ "path": "a.md", "copySha256": hash, "projectSha256": hash, "size": 2 }]
            }))
            .unwrap(),
        )
        .unwrap();
        // 内容不变（重写同内容）：旧格式走哈希比对，不算变化
        fs::write(run.join("a.md"), "v1").unwrap();
        let snap = freeze(&review, "r1", &run, &[".".to_string()], "t1")
            .unwrap()
            .unwrap();
        assert!(snap.changes.is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn context_snapshot_roundtrip_and_refuse_rewrite() {
        let (base, _run, _project) = fixture();
        let review = base.join("review");
        write_context_snapshot(&review, "r1", "上下文全文 v1", "now", None).unwrap();
        assert!(write_context_snapshot(&review, "r1", "别的内容", "later", None).is_err());
        let loaded = load_context_snapshot(&review).unwrap().unwrap();
        assert_eq!(loaded.text, "上下文全文 v1");
        // 篡改内容后哈希对不上，读取即拒绝
        let path = review.join("context.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["text"] = serde_json::Value::String("被改过".into());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(load_context_snapshot(&review).is_err());
        assert!(load_context_snapshot(&base.join("empty"))
            .unwrap()
            .is_none());
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
            fs::read(payload_file(&review, &snapshot, "notes/a.md").unwrap()).unwrap(),
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
            &HashMap::new(),
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
            &HashMap::new(),
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
            &HashMap::new(),
        )
        .is_err());
        fs::remove_file(project.join("b.md")).unwrap();
        // payload 被外部改动：哈希对不上，拒绝
        fs::write(
            payload_file(&review, &snapshot, "a.md").unwrap(),
            "tampered",
        )
        .unwrap();
        let err = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string()],
            &project,
            &HashMap::new(),
        )
        .unwrap_err();
        assert!(err.contains("不一致"), "{err}");
        // 项目已是冻结内容：跳过（幂等）
        fs::remove_dir_all(snapshot_payload_dir(&review, &snapshot).unwrap()).unwrap();
        fs::create_dir_all(snapshot_payload_dir(&review, &snapshot).unwrap()).unwrap();
        fs::write(payload_file(&review, &snapshot, "a.md").unwrap(), "v2").unwrap();
        fs::write(project.join("a.md"), "v2").unwrap();
        let planned = check_adoption(
            &review,
            &snapshot,
            Some(&baseline),
            &["a.md".to_string()],
            &project,
            &HashMap::new(),
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
            &HashMap::new(),
        )
        .unwrap_err();
        assert!(err.contains("删除"), "{err}");
        assert_eq!(fs::read(project.join("a.md")).unwrap(), b"v1");
        fs::remove_dir_all(base).unwrap();
    }
}
