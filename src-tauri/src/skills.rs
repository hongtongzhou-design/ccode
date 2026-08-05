//! 技能管理（§6.13）：技能库（SSOT）+ 分发到六个 CLI 的技能目录。
//! 库位置 <config>/ccode/skills/<name>/，元数据 skills.json；分发优先 symlink，失败回退 copy。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const MARKER_FILE: &str = ".ccode-copy"; // copy 分发的标记，删除时据此区分用户自有内容
const MAX_READ_PREVIEW: u64 = 64 * 1024;
const ZIP_MAX_ENTRIES: usize = 10_000;
const ZIP_MAX_UNCOMPRESSED: u64 = 128 * 1024 * 1024;
const ZIP_MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;
const BACKUP_KEEP: usize = 5;
/// 目录遍历深度上限：防符号链接环或异常嵌套导致无限递归。
/// 必须低于各平台 OS 的符号链接解析上限（macOS 实测 16 跳即 ELOOP），
/// 保证先命中我们自己的上限而不是依赖 OS 行为
const MAX_WALK_DEPTH: usize = 8;

// ===== DTO =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String, // local | zip | github | discovered
    pub repo: Option<String>,
    #[serde(default)]
    pub repo_ref: Option<String>,
    #[serde(default)]
    pub repo_subdir: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub apps: HashMap<String, bool>,
    pub installed_at: String,
    /// 用户自定义分类（None = 未分类）
    #[serde(default)]
    pub category: Option<String>,
    /// copy 分发后库已更新、副本还是旧内容的 agent（不入库文件，list 时现算；
    /// 空数组时序列化省略——前端需用 ?? [] 兜底）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stale_copies: Vec<String>,
    /// 各 agent 的分发形态（"symlink" | "copy"，list 时现算，仅启用的 agent 有键）
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub app_modes: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDto {
    pub name: String,
    pub description: String,
    pub path: String,
    pub from_agent: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportConflictDto {
    pub name: String,
    pub existing_id: Option<String>,
    pub source: String,
    pub update_available: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResultDto {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<String>,
    pub conflicts: Vec<SkillImportConflictDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateDto {
    pub id: String,
    pub update_available: bool,
    pub current_revision: Option<String>,
    pub latest_revision: Option<String>,
    pub message: String,
}

// ===== 库与元数据存储 =====

#[derive(Debug, Clone)]
struct SkillStore {
    json_path: PathBuf,
    lib: PathBuf,
}

impl SkillStore {
    fn default_paths() -> Result<Self, String> {
        let dir = dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode");
        Ok(Self {
            json_path: dir.join("skills.json"),
            lib: dir.join("skills"),
        })
    }

    fn read(&self) -> Vec<SkillDto> {
        fs::read_to_string(&self.json_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write(&self, skills: &[SkillDto]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(skills).map_err(|e| e.to_string())?;
        crate::profiles::atomic_write(&self.json_path, &text)
    }

    fn skill_dir(&self, name: &str) -> PathBuf {
        self.lib.join(name)
    }
}

/// 六个 agent 的技能目录（§6.13；目录来自 AgentSpec.skills_dir，opencode 在 ~/.config 下）
fn agent_dirs() -> HashMap<String, PathBuf> {
    let mut m = HashMap::new();
    if let Some(home) = dirs::home_dir() {
        for spec in crate::agent_specs::all_agent_specs() {
            let dir = spec.skills_dir.iter().fold(home.clone(), |p, seg| p.join(seg));
            m.insert(spec.id.to_string(), dir);
        }
    }
    m
}

fn new_skill(name: String, description: Option<String>, source: &str, repo: Option<String>) -> SkillDto {
    let mut apps = HashMap::new();
    for spec in crate::agent_specs::all_agent_specs() {
        apps.insert(spec.id.to_string(), false);
    }
    SkillDto {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: description.unwrap_or_default(),
        source: source.to_string(),
        repo,
        repo_ref: None,
        repo_subdir: None,
        source_revision: None,
        apps,
        installed_at: crate::sessions::now_iso(),
        category: None,
        stale_copies: Vec::new(),
        app_modes: HashMap::new(),
    }
}

// ===== SKILL.md 防御式解析（开放标准：frontmatter 只取 name/description，扩展字段忽略） =====

fn parse_skill_md(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(raw) = fs::read(path) else {
        return (None, None);
    };
    let text = String::from_utf8_lossy(&raw);
    // BOM 与 CRLF 都容忍
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim_end()) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

// ===== 发现：含 SKILL.md 的目录即技能，找到不下钻，跳过 . 开头目录 =====

fn find_skill_dirs(root: &Path, out: &mut Vec<PathBuf>) {
    find_skill_dirs_at(root, out, 0);
}

fn find_skill_dirs_at(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > MAX_WALK_DEPTH || !root.is_dir() {
        return;
    }
    if root.join("SKILL.md").is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let skip = p
            .file_name()
            .map(|n| n.to_string_lossy().starts_with('.'))
            .unwrap_or(true);
        if !skip {
            find_skill_dirs_at(&p, out, depth + 1);
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    copy_dir_recursive_at(src, dst, 0)
}

fn copy_dir_recursive_at(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_WALK_DEPTH {
        return Err(format!("目录嵌套超过 {MAX_WALK_DEPTH} 层（疑似符号链接环）: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| format!("创建目录 {} 失败: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {e}", src.display()))?;
    for e in entries.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        // fs::copy 跟随符号链接复制内容（物化），与导入语义一致
        if from.is_dir() {
            copy_dir_recursive_at(&from, &to, depth + 1)?;
        } else if from.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败: {e}", from.display()))?;
        }
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || path.is_absolute()
        || path.components().count() != 1
        || name.contains(['/', '\\', '\0'])
    {
        return Err(format!("技能名称必须是单个安全目录名: {name:?}"));
    }
    Ok(())
}

fn backup_library_dir(store: &SkillStore, name: &str) -> Result<Option<PathBuf>, String> {
    let src = store.skill_dir(name);
    if !src.exists() {
        return Ok(None);
    }
    let root = store
        .json_path
        .parent()
        .ok_or("无法确定技能备份目录")?
        .join("skill-backups");
    fs::create_dir_all(&root).map_err(|e| format!("创建技能备份目录失败: {e}"))?;
    let mut dst = root.join(format!("{name}.{}", now_compact()));
    if dst.exists() {
        dst = root.join(format!(
            "{name}.{}-{}",
            now_compact(),
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
    }
    fs::rename(&src, &dst).map_err(|e| format!("覆盖前备份技能 {name} 失败: {e}"))?;
    prune_backups(&root, name);
    Ok(Some(dst))
}

enum ImportDecision {
    Add(String),
    Overwrite,
    Skip,
    Conflict,
}

fn import_decision(
    store: &SkillStore,
    skills: &[SkillDto],
    name: &str,
    resolutions: Option<&HashMap<String, String>>,
) -> Result<ImportDecision, String> {
    validate_skill_name(name)?;
    let exists = skills.iter().any(|skill| skill.name == name) || store.skill_dir(name).exists();
    if !exists {
        return Ok(ImportDecision::Add(name.to_string()));
    }
    match resolutions.and_then(|items| items.get(name)).map(String::as_str) {
        Some("overwrite") => Ok(ImportDecision::Overwrite),
        Some("skip") => Ok(ImportDecision::Skip),
        Some(value) if value.starts_with("rename:") => {
            let target = value.trim_start_matches("rename:").trim();
            validate_skill_name(target)?;
            if skills.iter().any(|skill| skill.name == target) || store.skill_dir(target).exists() {
                return Err(format!("另存为名称已存在: {target}"));
            }
            Ok(ImportDecision::Add(target.to_string()))
        }
        Some(value) => Err(format!("未知冲突处理方式: {value}")),
        None => Ok(ImportDecision::Conflict),
    }
}

fn add_skill_from_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    install_name: &str,
    source: &str,
    repo: Option<String>,
) -> Result<(), String> {
    let dst = store.skill_dir(install_name);
    copy_dir_recursive(src_dir, &dst)?;
    let (_, description) = parse_skill_md(&dst.join("SKILL.md"));
    skills.push(new_skill(install_name.to_string(), description, source, repo));
    if let Err(e) = store.write(skills) {
        skills.pop();
        let _ = fs::remove_dir_all(&dst);
        return Err(e);
    }
    Ok(())
}

fn overwrite_skill_from_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    name: &str,
    source: &str,
    repo: Option<String>,
) -> Result<(), String> {
    let existing_pos = skills.iter().position(|skill| skill.name == name);
    let previous = existing_pos.map(|pos| skills[pos].clone());
    let backup = backup_library_dir(store, name)?;
    let dst = store.skill_dir(name);
    if let Err(e) = copy_dir_recursive(src_dir, &dst) {
        let _ = fs::remove_dir_all(&dst);
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, &dst);
        }
        return Err(e);
    }
    let (_, description) = parse_skill_md(&dst.join("SKILL.md"));
    match existing_pos {
        Some(pos) => {
            skills[pos].description = description.unwrap_or_default();
            skills[pos].source = source.into();
            skills[pos].repo = repo;
            skills[pos].installed_at = crate::sessions::now_iso();
        }
        None => skills.push(new_skill(name.to_string(), description, source, repo)),
    }
    if let Err(e) = store.write(skills) {
        let _ = fs::remove_dir_all(&dst);
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, &dst);
        }
        match (existing_pos, previous) {
            (Some(pos), Some(previous)) => skills[pos] = previous,
            (None, _) => {
                skills.pop();
            }
            _ => {}
        }
        return Err(e);
    }
    Ok(())
}

fn import_one_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    requested_name: Option<&str>,
    source: &str,
    repo: Option<String>,
    resolutions: Option<&HashMap<String, String>>,
    result: &mut SkillImportResultDto,
) -> Result<(), String> {
    let name = requested_name
        .map(ToOwned::to_owned)
        .or_else(|| src_dir.file_name().map(|name| name.to_string_lossy().into_owned()))
        .ok_or("无法确定技能名称")?;
    match import_decision(store, skills, &name, resolutions)? {
        ImportDecision::Add(target) => {
            add_skill_from_dir(store, skills, src_dir, &target, source, repo)?;
            result.added.push(target);
        }
        ImportDecision::Overwrite => {
            overwrite_skill_from_dir(store, skills, src_dir, &name, source, repo)?;
            result.updated.push(name);
        }
        ImportDecision::Skip => result.skipped.push(name),
        ImportDecision::Conflict => {
            let existing = skills.iter().find(|skill| skill.name == name);
            result.conflicts.push(SkillImportConflictDto {
                name,
                existing_id: existing.map(|skill| skill.id.clone()),
                source: source.into(),
                update_available: source == "github"
                    && existing.and_then(|skill| skill.repo.as_ref()) == repo.as_ref(),
            });
        }
    }
    Ok(())
}

// ===== 分发：symlink 优先，失败回退 copy（带标记文件） =====

fn try_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(src, dst)
    }
}

/// 目标位置是否由我们管理：symlink 指向库目录，或带 .ccode-copy 标记的副本
fn is_ours(target: &Path, lib: &Path) -> bool {
    if let Ok(link) = fs::read_link(target) {
        return link.starts_with(lib);
    }
    target.join(MARKER_FILE).exists()
}

fn remove_ours(target: &Path, lib: &Path) -> Result<(), String> {
    if let Ok(link) = fs::read_link(target) {
        if link.starts_with(lib) {
            // 符号链接按文件删；Windows 目录符号链接需要 remove_dir
            fs::remove_file(target)
                .or_else(|_| fs::remove_dir(target))
                .map_err(|e| format!("移除链接 {} 失败: {e}", target.display()))?;
            return Ok(());
        }
    }
    if target.join(MARKER_FILE).exists() {
        fs::remove_dir_all(target).map_err(|e| format!("移除 {} 失败: {e}", target.display()))?;
    }
    // 无标记的目录视为用户自有内容，绝不动
    Ok(())
}

fn apply_impl(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    id: &str,
    agent: &str,
    enabled: bool,
    allow_symlink: bool,
) -> Result<(), String> {
    let mut skills = store.read();
    let pos = skills
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let name = skills[pos].name.clone();
    let lib_dir = store.skill_dir(&name);
    if !lib_dir.is_dir() {
        return Err(format!("库目录缺失: {}", lib_dir.display()));
    }
    let agent_root = dirs
        .get(agent)
        .ok_or_else(|| format!("未知 agent: {agent}"))?;
    let target = agent_root.join(&name);
    if enabled {
        // 先备好父目录再做删旧建新，缩短「旧分发已删、新分发未建」的窗口
        fs::create_dir_all(agent_root).map_err(|e| format!("创建目录失败: {e}"))?;
        if target.exists() || fs::read_link(&target).is_ok() {
            if !is_ours(&target, &store.lib) {
                return Err(format!(
                    "目标已存在且不是由 Ccode 管理，请先手动处理: {}",
                    target.display()
                ));
            }
            remove_ours(&target, &store.lib)?; // 重复应用 = 先清掉旧分发
        }
        let linked = allow_symlink && try_symlink(&lib_dir, &target).is_ok();
        if !linked {
            // Windows 无权限等场景回退为副本，标记以便日后区分用户自有内容
            let distribute = copy_dir_recursive(&lib_dir, &target).and_then(|_| {
                fs::write(target.join(MARKER_FILE), lib_dir.to_string_lossy().as_ref())
                    .map_err(|e| format!("写入标记失败: {e}"))
            });
            if let Err(e) = distribute {
                // 旧分发已删、新分发未建成：元数据回落为未启用，避免「显示启用但盘上无物」
                skills[pos].apps.insert(agent.to_string(), false);
                let _ = store.write(&skills);
                return Err(e);
            }
        }
    } else {
        remove_ours(&target, &store.lib)?;
    }
    skills[pos].apps.insert(agent.to_string(), enabled);
    store.write(&skills)
}

// ===== 删除与备份（保留每个名字最近 5 份） =====

fn backups_root() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("skill-backups"))
}

/// now_iso "2026-07-30T10:13:37Z" → "20260730-101337"
fn now_compact() -> String {
    compact_iso(&crate::sessions::now_iso())
}

/// 数字不足 9 位（格式漂移）时原样返回，不做硬切片 panic
fn compact_iso(iso: &str) -> String {
    let digits: String = iso.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() > 8 {
        format!("{}-{}", &digits[..8], &digits[8..])
    } else {
        digits
    }
}

fn prune_backups(backups: &Path, name: &str) {
    let Ok(entries) = fs::read_dir(backups) else {
        return;
    };
    let prefix = format!("{name}.");
    let mut mine: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    mine.sort(); // 时间戳命名可字典序排序
    while mine.len() > BACKUP_KEEP {
        let _ = fs::remove_dir_all(mine.remove(0));
    }
}

fn delete_impl(store: &SkillStore, dirs: &HashMap<String, PathBuf>, backups: &Path, id: &str) -> Result<(), String> {
    let mut skills = store.read();
    let pos = skills
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let name = skills[pos].name.clone();
    // 先全量卸载再备份删除
    for spec in crate::agent_specs::all_agent_specs() {
        if let Some(root) = dirs.get(spec.id) {
            let _ = remove_ours(&root.join(&name), &store.lib);
        }
    }
    let lib_dir = store.skill_dir(&name);
    if lib_dir.exists() {
        fs::create_dir_all(backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
        let dst = backups.join(format!("{name}.{}", now_compact()));
        fs::rename(&lib_dir, &dst).map_err(|e| format!("备份失败: {e}"))?;
        prune_backups(backups, &name);
    }
    skills.remove(pos);
    store.write(&skills)
}

// ===== ZIP 导入（安全三件套：预算 / 路径穿越 / symlink 物化） =====

fn import_zip_impl(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    zip_path: &Path,
    subdir: Option<&str>,
    source: &str,
    repo: Option<String>,
    resolutions: Option<&HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    import_zip_limited(store, skills, zip_path, subdir, source, repo, resolutions, ZIP_MAX_UNCOMPRESSED)
}

/// 按实际解压出的字节数累计计费，超过预算即中止（中央目录声明值不可信，防 zip 炸弹）
fn charge_bytes(extracted_total: &mut u64, bytes: usize, budget: u64) -> Result<(), String> {
    *extracted_total += bytes as u64;
    if *extracted_total > budget {
        return Err(format!(
            "ZIP 实际解压体积超过 {}MB 预算，中止解压",
            budget / 1024 / 1024
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn import_zip_limited(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    zip_path: &Path,
    subdir: Option<&str>,
    source: &str,
    repo: Option<String>,
    resolutions: Option<&HashMap<String, String>>,
    max_uncompressed: u64,
) -> Result<SkillImportResultDto, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {e}"))?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(format!("ZIP 条目过多（{} > {ZIP_MAX_ENTRIES}），拒绝解压", archive.len()));
    }
    // 中央目录声明值只做快速预检；真实预算靠解压时逐字节累计（声明可能撒谎）
    let total: u64 = (0..archive.len()).map(|i| archive.by_index(i).map(|e| e.size()).unwrap_or(0)).sum();
    if total > max_uncompressed {
        return Err(format!("ZIP 解压后体积超过 {}MB，拒绝解压", max_uncompressed / 1024 / 1024));
    }
    // 找技能根：含 SKILL.md 的目录；嵌套命中的只保留最外层；子目录过滤（github subdir 参数）
    let mut roots: Vec<PathBuf> = Vec::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else { continue };
        let Some(name) = entry.enclosed_name() else { continue }; // 路径穿越条目直接丢弃
        if name.file_name().map(|n| n == "SKILL.md").unwrap_or(false) {
            let root = name.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            // zipball 有一层 <owner-repo-sha>/ 前缀；subdir 在其下匹配
            if let Some(sub) = subdir {
                let after_top: PathBuf = root.components().skip(1).collect();
                let sub = Path::new(sub);
                if !(after_top == sub || after_top.starts_with(sub)) {
                    continue;
                }
            }
            roots.push(root);
        }
    }
    roots.sort();
    roots.dedup();
    let all = roots.clone();
    roots.retain(|r| !all.iter().any(|o| o != r && r.starts_with(o)));
    let temp = std::env::temp_dir().join(format!("ccode-skill-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(|e| format!("创建技能导入临时目录失败: {e}"))?;
    let imported = (|| {
        let mut result = SkillImportResultDto::default();
        let mut extracted_total: u64 = 0;
        for (index, root) in roots.into_iter().enumerate() {
            let install_name = root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| {
                    zip_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "skill".into())
                });
            let extracted = temp.join(index.to_string());
            for i in 0..archive.len() {
                let Ok(mut entry) = archive.by_index(i) else { continue };
                let Some(name) = entry.enclosed_name() else { continue };
                if name != root && !name.starts_with(&root) {
                    continue;
                }
                let rel = match name.strip_prefix(&root) {
                    Ok(rel) if !rel.as_os_str().is_empty() => rel.to_path_buf(),
                    _ => continue,
                };
                let out_path = extracted.join(&rel);
                if entry.is_dir() {
                    fs::create_dir_all(&out_path)
                        .map_err(|e| format!("创建 ZIP 目录失败: {e}"))?;
                    continue;
                }
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("创建 ZIP 文件目录失败: {e}"))?;
                }
                let mut buf = Vec::new();
                // 多读 1 字节探测超限，不按声明大小分配
                let probe = max_uncompressed.saturating_sub(extracted_total) + 1;
                std::io::Read::read_to_end(&mut std::io::Read::take(&mut entry, probe), &mut buf)
                    .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
                charge_bytes(&mut extracted_total, buf.len(), max_uncompressed)?;
                fs::write(&out_path, &buf)
                    .map_err(|e| format!("写入 {} 失败: {e}", out_path.display()))?;
            }
            if !extracted.join("SKILL.md").is_file() {
                return Err(format!("ZIP 中技能 {install_name} 缺少 SKILL.md"));
            }
            import_one_dir(
                store,
                skills,
                &extracted,
                Some(&install_name),
                source,
                repo.clone(),
                resolutions,
                &mut result,
            )?;
        }
        Ok(result)
    })();
    let _ = fs::remove_dir_all(&temp);
    imported
}

// ===== 导出 =====

fn export_impl(store: &SkillStore, ids: &[String], dest_path: &str) -> Result<String, String> {
    let skills = store.read();
    let file = fs::File::create(dest_path).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let mut exported = 0;
    for id in ids {
        let Some(skill) = skills.iter().find(|s| &s.id == id) else {
            continue;
        };
        let src = store.skill_dir(&skill.name);
        if !src.is_dir() {
            continue;
        }
        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let p = e.path();
                let rel = p.strip_prefix(&src).map_err(|e| e.to_string())?;
                let zip_name = format!("{}/{}", skill.name, rel.to_string_lossy().replace('\\', "/"));
                if p.is_dir() {
                    stack.push(p);
                } else if p.is_file() {
                    writer
                        .start_file(zip_name, options)
                        .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
                    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
                    std::io::Write::write_all(&mut writer, &bytes).map_err(|e| e.to_string())?;
                }
            }
        }
        exported += 1;
    }
    if exported == 0 {
        return Err("没有可导出的技能".into());
    }
    writer.finish().map_err(|e| format!("完成 ZIP 失败: {e}"))?;
    Ok(dest_path.to_string())
}

// ===== copy 分发漂移检测（symlink 永远新，只有带标记的副本会旧） =====

/// 目录清单哈希：相对路径 + 大小 + 内容哈希（md5）逐文件计入后整体取 md5。
/// 漂移检测不需要抗碰撞；.ccode-copy 标记只有副本侧有，比较时统一排除。
fn dir_manifest_hash(root: &Path) -> Option<String> {
    if !root.is_dir() {
        return None;
    }
    let mut entries: Vec<(String, u64, String)> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH {
            continue; // 符号链接环等异常嵌套：超出部分不计入清单
        }
        for e in fs::read_dir(&dir).ok()?.flatten() {
            let p = e.path();
            let Ok(rel) = p.strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.is_file() {
                if rel == MARKER_FILE {
                    continue;
                }
                let bytes = fs::read(&p).ok()?;
                entries.push((rel, bytes.len() as u64, format!("{:x}", md5::compute(&bytes))));
            }
        }
    }
    entries.sort();
    let mut ctx = md5::Context::new();
    for (rel, size, hash) in entries {
        ctx.consume(rel.as_bytes());
        ctx.consume(b"\0");
        ctx.consume(size.to_string().as_bytes());
        ctx.consume(b"\0");
        ctx.consume(hash.as_bytes());
        ctx.consume(b"\0");
    }
    Some(format!("{:x}", ctx.compute()))
}

fn stale_agents(store: &SkillStore, dirs: &HashMap<String, PathBuf>, skill: &SkillDto) -> Vec<String> {
    let Some(lib_hash) = dir_manifest_hash(&store.skill_dir(&skill.name)) else {
        return Vec::new();
    };
    let mut stale = Vec::new();
    for (agent, enabled) in &skill.apps {
        if !enabled {
            continue;
        }
        let Some(root) = dirs.get(agent) else {
            continue;
        };
        let target = root.join(&skill.name);
        if !target.join(MARKER_FILE).exists() {
            continue; // symlink 或用户自有目录不在漂移检测范围
        }
        if dir_manifest_hash(&target).as_deref() != Some(lib_hash.as_str()) {
            stale.push(agent.clone());
        }
    }
    stale.sort();
    stale
}

/// 把 stale 的 copy 全部重新分发（保持 copy 形态），返回修复的 agent 列表
fn resync_impl(store: &SkillStore, dirs: &HashMap<String, PathBuf>, id: &str) -> Result<Vec<String>, String> {
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let stale = stale_agents(store, dirs, skill);
    for agent in &stale {
        apply_impl(store, dirs, id, agent, true, false)?;
    }
    Ok(stale)
}

// ===== Tauri commands =====

/// 某 agent 已启用的技能数（启动栏提示用）
#[tauri::command]
pub async fn count_enabled_skills(agent: String) -> usize {
    let store = match SkillStore::default_paths() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    store
        .read()
        .iter()
        .filter(|s| s.apps.get(&agent).copied().unwrap_or(false))
        .count()
}

#[tauri::command]
pub async fn set_skill_category(id: String, category: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = SkillStore::default_paths()?;
        let mut skills = store.read();
        let s = skills
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("技能不存在: {id}"))?;
        s.category = category
            .filter(|c| !c.trim().is_empty())
            .map(|c| c.trim().to_string());
        store.write(&skills)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 各启用 agent 的分发形态：带 .ccode-copy 标记 = copy，否则 symlink（apps=true 的都是我们分发的）
fn app_modes(dirs: &HashMap<String, PathBuf>, skill: &SkillDto) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (agent, enabled) in &skill.apps {
        if !enabled {
            continue;
        }
        let Some(root) = dirs.get(agent) else {
            continue;
        };
        let target = root.join(&skill.name);
        if !target.exists() && !target.is_symlink() {
            continue; // 目标已被用户手动删掉
        }
        out.insert(
            agent.clone(),
            if target.join(MARKER_FILE).exists() { "copy".into() } else { "symlink".into() },
        );
    }
    out
}

#[tauri::command]
pub async fn list_skills() -> Vec<SkillDto> {
    let Ok(store) = SkillStore::default_paths() else {
        return Vec::new();
    };
    let dirs = agent_dirs();
    let mut skills = store.read();
    for s in &mut skills {
        s.stale_copies = stale_agents(&store, &dirs, s);
        s.app_modes = app_modes(&dirs, s);
    }
    skills
}

#[tauri::command]
pub async fn resync_skill_copies(id: String) -> Result<Vec<String>, String> {
    let store = SkillStore::default_paths()?;
    resync_impl(&store, &agent_dirs(), &id)
}

#[tauri::command]
pub async fn apply_skill(id: String, agent: String, enabled: bool) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    apply_impl(&store, &agent_dirs(), &id, &agent, enabled, true)
}

#[tauri::command]
pub async fn delete_skill(id: String) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    delete_impl(&store, &agent_dirs(), &backups_root()?, &id)
}

#[tauri::command]
pub async fn import_skills_from_dir(
    path: String,
    resolutions: Option<HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let root = PathBuf::from(crate::sessions::expand_tilde(&path));
    if !root.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let mut found = Vec::new();
    find_skill_dirs(&root, &mut found);
    let mut skills = store.read();
    let mut result = SkillImportResultDto::default();
    for dir in found {
        import_one_dir(
            &store,
            &mut skills,
            &dir,
            None,
            "local",
            None,
            resolutions.as_ref(),
            &mut result,
        )?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn import_skills_from_zip(
    path: String,
    resolutions: Option<HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    import_zip_impl(
        &store,
        &mut skills,
        Path::new(&path),
        None,
        "zip",
        None,
        resolutions.as_ref(),
    )
}

#[tauri::command]
pub async fn import_skills_from_github(
    repo: String,
    branch: Option<String>,
    subdir: Option<String>,
    resolutions: Option<HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    if repo.split('/').count() != 2 {
        return Err("仓库格式应为 owner/name".into());
    }
    let branch = branch.filter(|b| !b.trim().is_empty());
    let refs: Vec<String> = match branch.clone() {
        Some(b) => vec![b],
        // 未指定分支：先默认分支（不带 ref），再 main/master 回退
        None => vec![String::new(), "main".into(), "master".into()],
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .user_agent("ccode-skills")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut last_err = String::new();
    let mut zip_bytes = None;
    for r in &refs {
        let url = if r.is_empty() {
            format!("https://api.github.com/repos/{repo}/zipball")
        } else {
            format!("https://api.github.com/repos/{repo}/zipball/{r}")
        };
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match download_limited(resp).await {
                Ok(bytes) => {
                    zip_bytes = Some(bytes);
                    break;
                }
                Err(e) => last_err = e,
            },
            Ok(resp) => last_err = format!("GitHub 返回 {}", resp.status()),
            Err(e) => last_err = format!("请求 GitHub 失败: {e}"),
        }
    }
    let Some(bytes) = zip_bytes else {
        return Err(format!("下载 {repo} 失败: {last_err}"));
    };
    let tmp = std::env::temp_dir().join(format!("ccode-gh-{}.zip", uuid::Uuid::new_v4()));
    fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    let result = import_zip_impl(
        &store,
        &mut skills,
        &tmp,
        subdir.as_deref(),
        "github",
        Some(repo.clone()),
        resolutions.as_ref(),
    );
    let _ = fs::remove_file(&tmp);
    let result = result?;
    if !result.added.is_empty() || !result.updated.is_empty() {
        let revision = github_latest_revision(&client, &repo, branch.as_deref())
            .await
            .ok();
        let changed: std::collections::HashSet<&str> = result
            .added
            .iter()
            .chain(result.updated.iter())
            .map(String::as_str)
            .collect();
        let mut recorded = store.read();
        for skill in &mut recorded {
            if changed.contains(skill.name.as_str()) {
                skill.repo_ref = branch.clone();
                skill.repo_subdir = subdir.clone();
                skill.source_revision = revision.clone();
            }
        }
        store
            .write(&recorded)
            .map_err(|e| format!("技能已导入，但记录 GitHub 版本失败，重试导入即可补全: {e}"))?;
    }
    Ok(result)
}

/// 边下边计数：content_length 预检 + 实际字节超限即中止（防 zipball 内存炸弹）
async fn download_limited(mut resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > ZIP_MAX_DOWNLOAD {
            return Err(format!(
                "ZIP 体积 {}MB 超过 256MB 上限，拒绝下载",
                len / 1024 / 1024
            ));
        }
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载失败: {e}"))? {
        buf.extend_from_slice(&chunk);
        if buf.len() as u64 > ZIP_MAX_DOWNLOAD {
            return Err("ZIP 下载超过 256MB 上限，中止下载".into());
        }
    }
    Ok(buf)
}

async fn github_latest_revision(
    client: &reqwest::Client,
    repo: &str,
    reference: Option<&str>,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&format!("https://api.github.com/repos/{repo}/commits/"))
        .map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "无法构造 GitHub commit URL".to_string())?
        .pop_if_empty()
        .push(reference.unwrap_or("HEAD"));
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("检查 GitHub 版本失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub 版本接口返回 {}", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 版本失败: {e}"))?;
    value
        .get("sha")
        .and_then(|sha| sha.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "GitHub 响应缺少 commit SHA".into())
}

#[tauri::command]
pub async fn check_skill_updates() -> Result<Vec<SkillUpdateDto>, String> {
    let store = SkillStore::default_paths()?;
    let skills: Vec<SkillDto> = store
        .read()
        .into_iter()
        .filter(|skill| skill.source == "github" && skill.repo.is_some())
        .collect();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ccode-skills")
        .build()
        .map_err(|e| format!("创建 GitHub 客户端失败: {e}"))?;
    let mut cache: HashMap<(String, Option<String>), Result<String, String>> = HashMap::new();
    let mut out = Vec::new();
    for skill in skills {
        let repo = skill.repo.clone().unwrap_or_default();
        let key = (repo.clone(), skill.repo_ref.clone());
        let latest = if let Some(cached) = cache.get(&key) {
            cached.clone()
        } else {
            let value = github_latest_revision(&client, &repo, skill.repo_ref.as_deref()).await;
            cache.insert(key, value.clone());
            value
        };
        match latest {
            Ok(latest) => {
                let update_available = skill.source_revision.as_deref() != Some(latest.as_str());
                out.push(SkillUpdateDto {
                    id: skill.id,
                    update_available,
                    current_revision: skill.source_revision.clone(),
                    latest_revision: Some(latest),
                    message: if skill.source_revision.is_some() {
                        if update_available {
                            "GitHub 有新提交，可重新导入并选择覆盖".into()
                        } else {
                            "已是 GitHub 最新版本".into()
                        }
                    } else {
                        "旧记录没有安装版本；建议重新导入一次以建立更新基线".into()
                    },
                });
            }
            Err(message) => out.push(SkillUpdateDto {
                id: skill.id,
                update_available: false,
                current_revision: skill.source_revision,
                latest_revision: None,
                message,
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn discover_unmanaged() -> Vec<DiscoveredDto> {
    let Ok(store) = SkillStore::default_paths() else {
        return Vec::new();
    };
    let skills = store.read();
    let known: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
    let mut roots: Vec<(String, PathBuf)> = agent_dirs().into_iter().collect();
    if let Some(home) = dirs::home_dir() {
        roots.push(("agents".to_string(), home.join(".agents").join("skills")));
    }
    let mut out = Vec::new();
    for (agent, root) in roots {
        let mut found = Vec::new();
        find_skill_dirs(&root, &mut found);
        for dir in found {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.is_empty() || known.contains(&name.as_str()) {
                continue; // 已在库里的不重复收编
            }
            let (_, description) = parse_skill_md(&dir.join("SKILL.md"));
            out.push(DiscoveredDto {
                name,
                description: description.unwrap_or_default(),
                path: dir.to_string_lossy().into_owned(),
                from_agent: agent.clone(),
            });
        }
    }
    out
}

#[tauri::command]
pub async fn import_discovered(paths: Vec<String>) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    let mut result = SkillImportResultDto::default();
    for p in paths {
        let dir = PathBuf::from(&p);
        if dir.join("SKILL.md").is_file() {
            import_one_dir(
                &store,
                &mut skills,
                &dir,
                None,
                "discovered",
                None,
                None,
                &mut result,
            )?;
        }
    }
    // 同名冲突不静默吞：随结果透出给前端提示
    Ok(result)
}

#[tauri::command]
pub async fn export_skills(ids: Vec<String>, dest_path: String) -> Result<String, String> {
    let store = SkillStore::default_paths()?;
    export_impl(&store, &ids, &dest_path)
}

#[tauri::command]
pub async fn read_skill_md(id: String) -> Result<String, String> {
    let store = SkillStore::default_paths()?;
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let path = store.skill_dir(&skill.name).join("SKILL.md");
    let mut file = fs::File::open(&path).map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(&mut file, MAX_READ_PREVIEW), &mut buf)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fx {
        dir: PathBuf,
        store: SkillStore,
        agents: HashMap<String, PathBuf>,
    }

    impl Fx {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let store = SkillStore {
                json_path: dir.join("skills.json"),
                lib: dir.join("skills"),
            };
            fs::create_dir_all(&store.lib).unwrap();
            let mut agents = HashMap::new();
            for spec in crate::agent_specs::all_agent_specs() {
                agents.insert(spec.id.to_string(), dir.join("agents").join(spec.id));
            }
            Self { dir, store, agents }
        }

        fn add_lib_skill(&self, name: &str, description: &str) -> SkillDto {
            let dir = self.store.skill_dir(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n---\nbody\n")).unwrap();
            let skill = new_skill(name.to_string(), Some(description.to_string()), "local", None);
            let mut skills = self.store.read();
            skills.push(skill.clone());
            self.store.write(&skills).unwrap();
            skill
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn frontmatter_tolerates_bom_crlf_and_missing_fields() {
        let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("SKILL.md");
        fs::write(&f, "\u{feff}---\r\nname: pdf\r\ndescription: 处理 PDF 文件\r\nextra: ignored\r\n---\r\n# body\r\n").unwrap();
        let (name, desc) = parse_skill_md(&f);
        assert_eq!(name.as_deref(), Some("pdf"));
        assert_eq!(desc.as_deref(), Some("处理 PDF 文件"));
        fs::write(&f, "---\nname: only-name\n---\n").unwrap();
        assert_eq!(parse_skill_md(&f), (Some("only-name".into()), None));
        fs::write(&f, "# 没有 frontmatter\n").unwrap();
        assert_eq!(parse_skill_md(&f), (None, None));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discovery_flattens_nested_and_skips_dot_dirs() {
        let fx = Fx::new();
        // 嵌套技能（找到不下钻）+ dot-dir 里的技能被跳过
        fs::create_dir_all(fx.dir.join("src/skills/doc/docx")).unwrap();
        fs::write(fx.dir.join("src/skills/doc/docx/SKILL.md"), "---\nname: docx\n---\n").unwrap();
        fs::create_dir_all(fx.dir.join("src/.hidden/secret")).unwrap();
        fs::write(fx.dir.join("src/.hidden/secret/SKILL.md"), "---\nname: secret\n---\n").unwrap();
        let mut found = Vec::new();
        find_skill_dirs(&fx.dir.join("src"), &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name().unwrap(), "docx");
        let mut skills = Vec::new();
        let mut first = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &found[0],
            None,
            "local",
            None,
            None,
            &mut first,
        )
        .unwrap();
        assert_eq!(first.added, vec!["docx"]);
        assert_eq!(skills[0].name, "docx", "拍平为末段目录名");
        assert!(fx.store.skill_dir("docx").join("SKILL.md").exists());
        // 同名再导入必须返回结构化冲突，不能静默跳过
        let mut second = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &found[0],
            None,
            "local",
            None,
            None,
            &mut second,
        )
        .unwrap();
        assert_eq!(second.conflicts.len(), 1);
        assert_eq!(second.conflicts[0].name, "docx");
    }

    #[test]
    fn import_conflict_can_overwrite_with_backup() {
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "旧版本");
        let incoming = fx.dir.join("incoming/pdf");
        fs::create_dir_all(&incoming).unwrap();
        fs::write(
            incoming.join("SKILL.md"),
            "---\nname: pdf\ndescription: 新版本\n---\nnew body\n",
        )
        .unwrap();
        let mut skills = fx.store.read();
        let resolutions = HashMap::from([("pdf".to_string(), "overwrite".to_string())]);
        let mut result = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &incoming,
            None,
            "local",
            None,
            Some(&resolutions),
            &mut result,
        )
        .unwrap();
        assert_eq!(result.updated, vec!["pdf"]);
        assert_eq!(fx.store.read()[0].description, "新版本");
        assert!(fs::read_to_string(fx.store.skill_dir("pdf").join("SKILL.md"))
            .unwrap()
            .contains("new body"));
        let backup_root = fx.dir.join("skill-backups");
        let backup = fs::read_dir(&backup_root)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.file_name().unwrap().to_string_lossy().starts_with("pdf."))
            .expect("覆盖前必须留下备份");
        assert!(fs::read_to_string(backup.join("SKILL.md"))
            .unwrap()
            .contains("旧版本"));
    }

    #[test]
    fn import_conflict_can_save_as_new_name() {
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "旧版本");
        let incoming = fx.dir.join("incoming/pdf");
        fs::create_dir_all(&incoming).unwrap();
        fs::write(
            incoming.join("SKILL.md"),
            "---\nname: pdf\ndescription: 另一个版本\n---\n",
        )
        .unwrap();
        let mut skills = fx.store.read();
        let resolutions = HashMap::from([(
            "pdf".to_string(),
            "rename:pdf-alternative".to_string(),
        )]);
        let mut result = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &incoming,
            None,
            "zip",
            None,
            Some(&resolutions),
            &mut result,
        )
        .unwrap();
        assert_eq!(result.added, vec!["pdf-alternative"]);
        assert_eq!(fx.store.read().len(), 2);
        assert!(fx.store.skill_dir("pdf").exists());
        assert!(fx.store.skill_dir("pdf-alternative").exists());
    }

    #[test]
    fn apply_copy_fallback_marker_protection_and_conflicts() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        let target = fx.agents["codex"].join("pdf");
        // allow_symlink=false 强制 copy 回退：带标记文件
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        assert!(target.join("SKILL.md").exists());
        assert!(target.join(MARKER_FILE).exists());
        assert!(fx.store.read()[0].apps["codex"]);
        // 关闭：带标记的副本被删除
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", false, false).unwrap();
        assert!(!target.exists());
        // 用户自有目录（无标记）：关闭时绝不动
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "user's own").unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", false, false).unwrap();
        assert!(target.join("SKILL.md").exists(), "无标记目录必须保留");
        // 同名冲突：开启时报错且不覆盖
        let err = apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap_err();
        assert!(err.contains("不是由 Ccode 管理"), "{err}");
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "user's own");
    }

    #[test]
    fn apply_symlink_preferred_on_unix() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", true, true).unwrap();
        let target = fx.agents["claude-code"].join("pdf");
        #[cfg(unix)]
        assert!(fs::read_link(&target).is_ok(), "Unix 上应优先 symlink");
        // 重复应用（重挂）不出错
        apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", true, true).unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", false, true).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn delete_backups_up_and_prunes_to_five() {
        let fx = Fx::new();
        let backups = fx.dir.join("backups");
        fs::create_dir_all(&backups).unwrap();
        // 预置 5 份旧备份，删除后总数 6 → 剪掉最旧一份
        for i in 0..5 {
            fs::create_dir_all(backups.join(format!("pdf.2026070{i}-000000"))).unwrap();
        }
        let skill = fx.add_lib_skill("pdf", "x");
        delete_impl(&fx.store, &fx.agents, &backups, &skill.id).unwrap();
        assert!(fx.store.read().is_empty());
        assert!(!fx.store.skill_dir("pdf").exists());
        let remaining: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 5, "只保留最近 5 份");
        assert!(!backups.join("pdf.20260700-000000").exists(), "最旧的被剪掉");
    }

    fn build_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            w.start_file(name, opt).unwrap();
            std::io::Write::write_all(&mut w, data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn zip_import_groups_skills_and_rejects_traversal() {
        let fx = Fx::new();
        let zip_path = fx.dir.join("in.zip");
        build_zip(
            &zip_path,
            &[
                ("repo-sha/skills/doc/docx/SKILL.md", b"---\ndescription: word\n---\n"),
                ("repo-sha/skills/doc/docx/template.bin", b"\x00\x01"),
                ("repo-sha/skills/pdf/SKILL.md", b"---\ndescription: pdf\n---\n"),
                ("../evil/SKILL.md", b"evil"),
                ("/abs/evil.md", b"evil"),
            ],
        );
        let mut skills = Vec::new();
        let result =
            import_zip_impl(&fx.store, &mut skills, &zip_path, None, "zip", None, None).unwrap();
        assert_eq!(result.added.len(), 2);
        assert!(fx.store.skill_dir("docx").join("template.bin").exists());
        assert_eq!(skills.iter().find(|s| s.name == "docx").unwrap().description, "word");
        assert!(!fx.dir.join("evil").exists(), "路径穿越条目不得落盘");
        // subdir 过滤
        let fx2 = Fx::new();
        let result = import_zip_impl(
            &fx2.store,
            &mut Vec::new(),
            &zip_path,
            Some("skills/pdf"),
            "zip",
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.added.len(), 1);
        assert!(fx2.store.skill_dir("pdf").exists());
        assert!(!fx2.store.skill_dir("docx").exists());
    }

    #[test]
    fn zip_budget_rejects_too_many_entries() {
        let fx = Fx::new();
        let zip_path = fx.dir.join("many.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default();
        for i in 0..(ZIP_MAX_ENTRIES + 1) {
            w.start_file(format!("f{i}.txt"), opt).unwrap();
        }
        w.finish().unwrap();
        let err = import_zip_impl(
            &fx.store,
            &mut Vec::new(),
            &zip_path,
            None,
            "zip",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("条目过多"), "{err}");
    }

    #[test]
    fn export_roundtrips_through_zip_flow() {
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "PDF 技能");
        fx.add_lib_skill("docx", "Word 技能");
        let ids: Vec<String> = fx.store.read().iter().map(|s| s.id.clone()).collect();
        let dest = fx.dir.join("out.zip");
        export_impl(&fx.store, &ids, dest.to_str().unwrap()).unwrap();
        // 再按 ZIP 导入流程进另一个库，验证往返一致
        let fx2 = Fx::new();
        let result =
            import_zip_impl(&fx2.store, &mut Vec::new(), &dest, None, "zip", None, None).unwrap();
        assert_eq!(result.added.len(), 2);
        assert!(fx2.store.skill_dir("pdf").join("SKILL.md").exists());
        assert!(fx2.store.skill_dir("docx").join("SKILL.md").exists());
        // 空选择报错
        assert!(export_impl(&fx.store, &["nonexistent".into()], dest.to_str().unwrap()).is_err());
    }

    #[test]
    fn stale_copy_detected_and_resynced() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        // codex 走 copy（强制），gemini 走 symlink
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "gemini", true, true).unwrap();
        let skill = fx.store.read().into_iter().find(|s| s.id == skill.id).unwrap();
        assert!(stale_agents(&fx.store, &fx.agents, &skill).is_empty(), "刚分发完不应有漂移");
        // 库更新 → copy 副本漂移，symlink 不受影响
        fs::write(
            fx.store.skill_dir("pdf").join("SKILL.md"),
            "---\nname: pdf\ndescription: 新版\n---\nbody v2\n",
        )
        .unwrap();
        let stale = stale_agents(&fx.store, &fx.agents, &skill);
        assert_eq!(stale, vec!["codex".to_string()], "symlink 的 gemini 不算漂移");
        let fixed = resync_impl(&fx.store, &fx.agents, &skill.id).unwrap();
        assert_eq!(fixed, vec!["codex".to_string()]);
        assert!(stale_agents(&fx.store, &fx.agents, &skill).is_empty(), "resync 后漂移清零");
        let copied = fs::read_to_string(fx.agents["codex"].join("pdf").join("SKILL.md")).unwrap();
        assert!(copied.contains("新版"), "副本内容已追平库");
        assert!(fx.agents["codex"].join("pdf").join(MARKER_FILE).exists(), "仍保持 copy 形态");
    }

    #[test]
    fn stale_detection_covers_whole_manifest() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        fs::write(fx.store.skill_dir("pdf").join("template.txt"), "v1").unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        let skill = fx.store.read().into_iter().find(|s| s.id == skill.id).unwrap();
        assert!(
            stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
            "副本与库一致时不漂移（.ccode-copy 标记不参与比较）"
        );
        // 只改 SKILL.md 之外的辅助文件也必须检出漂移
        fs::write(fx.store.skill_dir("pdf").join("template.txt"), "v2").unwrap();
        assert_eq!(stale_agents(&fx.store, &fx.agents, &skill), vec!["codex".to_string()]);
        // 库新增文件同样检出
        resync_impl(&fx.store, &fx.agents, &skill.id).unwrap();
        fs::write(fx.store.skill_dir("pdf").join("extra.txt"), "new").unwrap();
        assert_eq!(
            stale_agents(&fx.store, &fx.agents, &skill),
            vec!["codex".to_string()],
            "库新增文件也算漂移"
        );
    }

    #[test]
    fn compact_iso_defensive_on_malformed() {
        assert_eq!(compact_iso("2026-07-30T10:13:37Z"), "20260730-101337");
        // 格式漂移（数字不足 9 位）不得 panic，原样返回已有数字
        assert_eq!(compact_iso("abc"), "");
        assert_eq!(compact_iso("2026"), "2026");
        assert_eq!(compact_iso("2026-07-30"), "20260730");
    }

    #[test]
    fn find_skill_dirs_respects_depth_limit() {
        let fx = Fx::new();
        // 18 层嵌套深处藏一个技能：超过 MAX_WALK_DEPTH 不得被发现
        let deep = (0..18).fold(fx.dir.join("deep"), |p, i| p.join(format!("d{i}")));
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("SKILL.md"), "---\nname: too-deep\n---\n").unwrap();
        let mut found = Vec::new();
        find_skill_dirs(&fx.dir.join("deep"), &mut found);
        assert!(found.is_empty(), "超过深度上限的目录不得下钻");
    }

    #[cfg(unix)]
    #[test]
    fn walks_survive_symlink_loops() {
        let fx = Fx::new();
        // 真实空目录 a + 回指根目录的链接 up：路径解析次数随深度线性增长，
        // 保证命中我们自己的深度上限，而不是依赖 OS 的 ELOOP 行为
        let root = fx.dir.join("loop");
        fs::create_dir_all(root.join("a")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("up")).unwrap();
        let mut found = Vec::new();
        find_skill_dirs(&root, &mut found); // 无深度上限时这里会无限递归
        assert!(found.is_empty());
        let err = copy_dir_recursive(&root, &fx.dir.join("loop-copy")).unwrap_err();
        assert!(err.contains("嵌套超过"), "{err}");
    }

    #[test]
    fn charge_bytes_aborts_over_budget() {
        let mut total = 0;
        charge_bytes(&mut total, 100, 250).unwrap();
        charge_bytes(&mut total, 100, 250).unwrap();
        let err = charge_bytes(&mut total, 100, 250).unwrap_err();
        assert!(err.contains("预算"), "{err}");
    }

    #[test]
    fn zip_budget_uses_injected_limit() {
        let fx = Fx::new();
        let zip_path = fx.dir.join("big.zip");
        build_zip(
            &zip_path,
            &[("skill-a/SKILL.md", b"---\nname: a\n---\n"), ("skill-a/blob.bin", &[0u8; 200])],
        );
        // 声明总量 ~215 超过注入预算 100：预检拒绝
        let err = import_zip_limited(&fx.store, &mut Vec::new(), &zip_path, None, "zip", None, None, 100)
            .unwrap_err();
        assert!(err.contains("拒绝解压"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn apply_failure_rolls_back_metadata() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        assert!(fx.store.read()[0].apps["codex"]);
        // 库文件不可读 → 重复应用（先删旧分发再建新）的复制阶段必然失败
        let lib_file = fx.store.skill_dir("pdf").join("SKILL.md");
        fs::set_permissions(&lib_file, fs::Permissions::from_mode(0o000)).unwrap();
        let err = apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap_err();
        fs::set_permissions(&lib_file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(err.contains("复制"), "{err}");
        assert!(
            !fx.store.read()[0].apps["codex"],
            "失败后元数据必须回落为未启用，不能显示启用但盘上无物"
        );
        assert!(!fx.agents["codex"].join("pdf").join(MARKER_FILE).exists());
    }
}
