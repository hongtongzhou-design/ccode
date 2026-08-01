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
const BACKUP_KEEP: usize = 5;

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
    pub apps: HashMap<String, bool>,
    pub installed_at: String,
    /// 用户自定义分类（None = 未分类）
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDto {
    pub name: String,
    pub description: String,
    pub path: String,
    pub from_agent: String,
}

const AGENT_IDS: [&str; 6] = ["claude-code", "codex", "gemini", "qwen", "opencode", "kimi"];

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

/// 六个 agent 的技能目录（§6.13；opencode 配置在 ~/.config 下，与 matrix 一致）
fn agent_dirs() -> HashMap<String, PathBuf> {
    let mut m = HashMap::new();
    if let Some(home) = dirs::home_dir() {
        m.insert("claude-code".to_string(), home.join(".claude").join("skills"));
        m.insert("codex".to_string(), home.join(".codex").join("skills"));
        m.insert("gemini".to_string(), home.join(".gemini").join("skills"));
        m.insert("qwen".to_string(), home.join(".qwen").join("skills"));
        m.insert("opencode".to_string(), home.join(".config").join("opencode").join("skills"));
        m.insert("kimi".to_string(), home.join(".kimi-code").join("skills"));
    }
    m
}

fn new_skill(name: String, description: Option<String>, source: &str, repo: Option<String>) -> SkillDto {
    let mut apps = HashMap::new();
    for a in AGENT_IDS {
        apps.insert(a.to_string(), false);
    }
    SkillDto {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: description.unwrap_or_default(),
        source: source.to_string(),
        repo,
        apps,
        installed_at: crate::sessions::now_iso(),
        category: None,
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
    if !root.is_dir() {
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
            find_skill_dirs(&p, out);
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录 {} 失败: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {e}", src.display()))?;
    for e in entries.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        // fs::copy 跟随符号链接复制内容（物化），与导入语义一致
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if from.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// 入库一个技能目录：名字拍平为末段；同名（库里已有目录或元数据已有条目）跳过。返回是否新增
fn import_one_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    source: &str,
    repo: Option<String>,
) -> Result<bool, String> {
    let Some(name) = src_dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Ok(false);
    };
    if name.is_empty() || skills.iter().any(|s| s.name == name) || store.skill_dir(&name).exists() {
        return Ok(false);
    }
    let dst = store.skill_dir(&name);
    copy_dir_recursive(src_dir, &dst)?;
    let (_, description) = parse_skill_md(&dst.join("SKILL.md"));
    skills.push(new_skill(name, description, source, repo));
    Ok(true)
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
        if target.exists() || fs::read_link(&target).is_ok() {
            if !is_ours(&target, &store.lib) {
                return Err(format!(
                    "目标已存在且不是由 Ccode 管理，请先手动处理: {}",
                    target.display()
                ));
            }
            remove_ours(&target, &store.lib)?; // 重复应用 = 先清掉旧分发
        }
        fs::create_dir_all(agent_root).map_err(|e| format!("创建目录失败: {e}"))?;
        let linked = allow_symlink && try_symlink(&lib_dir, &target).is_ok();
        if !linked {
            // Windows 无权限等场景回退为副本，标记以便日后区分用户自有内容
            copy_dir_recursive(&lib_dir, &target)?;
            fs::write(target.join(MARKER_FILE), lib_dir.to_string_lossy().as_ref())
                .map_err(|e| format!("写入标记失败: {e}"))?;
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
    let iso = crate::sessions::now_iso();
    let digits: String = iso.chars().filter(|c| c.is_ascii_digit()).collect();
    format!("{}-{}", &digits[..8], &digits[8..])
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
    for agent in AGENT_IDS {
        if let Some(root) = dirs.get(agent) {
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
) -> Result<usize, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {e}"))?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(format!("ZIP 条目过多（{} > {ZIP_MAX_ENTRIES}），拒绝解压", archive.len()));
    }
    let total: u64 = (0..archive.len()).map(|i| archive.by_index(i).map(|e| e.size()).unwrap_or(0)).sum();
    if total > ZIP_MAX_UNCOMPRESSED {
        return Err("ZIP 解压后体积超过 128MB，拒绝解压".into());
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
    let mut count = 0;
    for root in roots {
        let install_name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                // SKILL.md 在 ZIP 根：用压缩包文件名兜底
                zip_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "skill".into())
            });
        if skills.iter().any(|s| s.name == install_name) || store.skill_dir(&install_name).exists() {
            continue;
        }
        let dst = store.skill_dir(&install_name);
        let mut description = None;
        for i in 0..archive.len() {
            let Ok(mut entry) = archive.by_index(i) else { continue };
            let Some(name) = entry.enclosed_name() else { continue };
            if name != root && !name.starts_with(&root) {
                continue;
            }
            let rel = match name.strip_prefix(&root) {
                Ok(r) if !r.as_os_str().is_empty() => r.to_path_buf(),
                _ => continue,
            };
            let out_path = dst.join(&rel);
            if entry.is_dir() {
                fs::create_dir_all(&out_path).ok();
                continue;
            }
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            // symlink 物化为普通文件（读得到内容就写，否则跳过）
            let mut buf = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut buf).is_err() {
                continue;
            }
            fs::write(&out_path, &buf).map_err(|e| format!("写入 {} 失败: {e}", out_path.display()))?;
            if rel == Path::new("SKILL.md") {
                description = parse_skill_md(&out_path).1;
            }
        }
        skills.push(new_skill(install_name, description, source, repo.clone()));
        count += 1;
    }
    Ok(count)
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

// ===== Tauri commands =====

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

#[tauri::command]
pub async fn list_skills() -> Vec<SkillDto> {
    SkillStore::default_paths().map(|s| s.read()).unwrap_or_default()
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
pub async fn import_skills_from_dir(path: String) -> Result<usize, String> {
    let store = SkillStore::default_paths()?;
    let root = PathBuf::from(crate::sessions::expand_tilde(&path));
    if !root.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let mut found = Vec::new();
    find_skill_dirs(&root, &mut found);
    let mut skills = store.read();
    let mut count = 0;
    for dir in found {
        if import_one_dir(&store, &mut skills, &dir, "local", None)? {
            count += 1;
        }
    }
    store.write(&skills)?;
    Ok(count)
}

#[tauri::command]
pub async fn import_skills_from_zip(path: String) -> Result<usize, String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    let count = import_zip_impl(&store, &mut skills, Path::new(&path), None, "zip", None)?;
    store.write(&skills)?;
    Ok(count)
}

#[tauri::command]
pub async fn import_skills_from_github(
    repo: String,
    branch: Option<String>,
    subdir: Option<String>,
) -> Result<usize, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    if repo.split('/').count() != 2 {
        return Err("仓库格式应为 owner/name".into());
    }
    let refs: Vec<String> = match branch.filter(|b| !b.trim().is_empty()) {
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
            Ok(resp) if resp.status().is_success() => {
                zip_bytes = Some(resp.bytes().await.map_err(|e| format!("下载失败: {e}"))?);
                break;
            }
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
    let result = import_zip_impl(&store, &mut skills, &tmp, subdir.as_deref(), "github", Some(repo));
    let _ = fs::remove_file(&tmp);
    let count = result?;
    store.write(&skills)?;
    Ok(count)
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
pub async fn import_discovered(paths: Vec<String>) -> Result<usize, String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    let mut count = 0;
    for p in paths {
        let dir = PathBuf::from(&p);
        if dir.join("SKILL.md").is_file()
            && import_one_dir(&store, &mut skills, &dir, "discovered", None)?
        {
            count += 1;
        }
    }
    store.write(&skills)?;
    Ok(count)
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
            for a in AGENT_IDS {
                agents.insert(a.to_string(), dir.join("agents").join(a));
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
        assert!(import_one_dir(&fx.store, &mut skills, &found[0], "local", None).unwrap());
        assert_eq!(skills[0].name, "docx", "拍平为末段目录名");
        assert!(fx.store.skill_dir("docx").join("SKILL.md").exists());
        // 同名再导入跳过
        assert!(!import_one_dir(&fx.store, &mut skills, &found[0], "local", None).unwrap());
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
        let n = import_zip_impl(&fx.store, &mut skills, &zip_path, None, "zip", None).unwrap();
        assert_eq!(n, 2);
        assert!(fx.store.skill_dir("docx").join("template.bin").exists());
        assert_eq!(skills.iter().find(|s| s.name == "docx").unwrap().description, "word");
        assert!(!fx.dir.join("evil").exists(), "路径穿越条目不得落盘");
        // subdir 过滤
        let fx2 = Fx::new();
        let n = import_zip_impl(&fx2.store, &mut Vec::new(), &zip_path, Some("skills/pdf"), "zip", None).unwrap();
        assert_eq!(n, 1);
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
        let err = import_zip_impl(&fx.store, &mut Vec::new(), &zip_path, None, "zip", None).unwrap_err();
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
        let n = import_zip_impl(&fx2.store, &mut Vec::new(), &dest, None, "zip", None).unwrap();
        assert_eq!(n, 2);
        assert!(fx2.store.skill_dir("pdf").join("SKILL.md").exists());
        assert!(fx2.store.skill_dir("docx").join("SKILL.md").exists());
        // 空选择报错
        assert!(export_impl(&fx.store, &["nonexistent".into()], dest.to_str().unwrap()).is_err());
    }
}
