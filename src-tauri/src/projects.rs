use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

// 项目档案卡与项目注册（§11.3 机制一、§11.4 P1b 后端部分）：
// - 注册表：app.db 的 projects 表，只记 path/name/时间戳，不碰磁盘；
// - 档案卡：项目目录下 .ccode/project.toml，资源清单 + 流水线定义，跟着 git 走；
// - 资源自动发现与 git 引导为纯只读/幂等辅助，供「添加项目」流程组合调用。

const DEFAULT_ARTIFACT_DIR: &str = "artifacts";
const RESOURCE_TYPES: [&str; 4] = ["paper", "dataset", "reference", "other"];

// ===== 前端 DTO =====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub path: String, // canonical 绝对路径，注册表主键
    pub name: String,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ResourceDto {
    pub name: String,
    pub path: String,
    // type 是 Rust 关键字；TOML 与 JSON 两侧都叫 type
    #[serde(rename = "type")]
    pub kind: String,
    pub readonly: bool,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StepRunDto {
    pub name: String,
    pub command: String,
    #[serde(rename = "default")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StepDto {
    pub name: String,
    pub workspace_name: String,
    pub brief: String,
    pub expected_artifacts: Vec<String>,
    pub skills: Vec<String>,
    pub run: Vec<StepRunDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectConfigDto {
    // 课题主题：一键开步写进 TASK.md「课题主题」段；可省
    pub topic: Option<String>,
    pub artifact_dir: String,
    pub resources: Vec<ResourceDto>,
    pub steps: Vec<StepDto>,
}

impl Default for ProjectConfigDto {
    fn default() -> Self {
        Self {
            topic: None,
            artifact_dir: DEFAULT_ARTIFACT_DIR.into(),
            resources: Vec::new(),
            steps: Vec::new(),
        }
    }
}

/// 读档案卡结果：坏字段不阻断，逐条进 warnings 告知前端
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigReadDto {
    pub config: ProjectConfigDto,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredResourceDto {
    pub path: String, // 相对项目根，统一正斜杠
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub mtime: Option<String>,
    pub exists: bool, // 已在 project.toml 资源清单里登记过
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnsureGitDto {
    pub initialized: bool,      // 本次执行了 git init
    pub gitignore_written: bool, // 本次新建了 .gitignore
}

// ===== 注册表（app.db projects 表；建表风格同 workspaces::db_at） =====

fn app_db_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("app.db"))
}

fn db_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 app.db 等待时间失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects(
          path TEXT PRIMARY KEY, name TEXT NOT NULL,
          created_at TEXT, last_opened_at TEXT);",
    )
    .map_err(|e| format!("初始化 projects 表失败: {e}"))?;
    Ok(conn)
}

fn db() -> Result<Connection, String> {
    db_at(&app_db_path()?)
}

/// 注册用主键：能 canonicalize 就用 canonical 路径，不同写法指向同一目录时去重
fn canonical_key(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn register_at(
    conn: &Connection,
    path: &Path,
    name: &str,
    now: &str,
) -> Result<ProjectDto, String> {
    let key = canonical_key(path);
    // 名称为空时回落目录 basename，避免注册表出现无意义空名
    let name = if name.trim().is_empty() {
        Path::new(&key)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| key.clone())
    } else {
        name.trim().to_string()
    };
    // 重复注册：保留 created_at，更新 name 与 last_opened_at
    conn.execute(
        "INSERT INTO projects(path, name, created_at, last_opened_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET name=?2, last_opened_at=?4",
        params![key, name, now, now],
    )
    .map_err(|e| format!("注册项目失败: {e}"))?;
    let created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM projects WHERE path=?1",
            params![key],
            |r| r.get(0),
        )
        .ok();
    Ok(ProjectDto {
        path: key,
        name,
        created_at,
        last_opened_at: Some(now.to_string()),
    })
}

fn list_projects_in(conn: &Connection) -> Result<Vec<ProjectDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path, name, created_at, last_opened_at FROM projects
             ORDER BY last_opened_at DESC, path ASC",
        )
        .map_err(|e| format!("读取项目列表失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectDto {
                path: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                last_opened_at: r.get(3)?,
            })
        })
        .map_err(|e| format!("读取项目列表失败: {e}"))?;
    Ok(rows.flatten().collect())
}

/// 只删注册记录，磁盘上的项目目录一概不动
fn remove_project_at(conn: &Connection, path: &Path) -> Result<(), String> {
    let key = canonical_key(path);
    conn.execute("DELETE FROM projects WHERE path=?1", params![key])
        .map_err(|e| format!("移除项目注册失败: {e}"))?;
    Ok(())
}

// ===== 档案卡 .ccode/project.toml =====

fn config_path(project: &Path) -> PathBuf {
    project.join(".ccode").join("project.toml")
}

// 解析模型：未知键忽略（前向兼容），风格同 ws_settings.rs
// 坏字段不整体失败：先解析成 toml::Value，再逐条 try_into，坏条目跳过并记 warning。

#[derive(Debug, Deserialize)]
struct TomlResource {
    name: String,
    path: String,
    #[serde(rename = "type", default = "default_resource_type")]
    kind: String,
    #[serde(default)]
    readonly: bool,
    #[serde(default)]
    note: String,
}

fn default_resource_type() -> String {
    "other".into()
}

#[derive(Debug, Deserialize)]
struct TomlStepRun {
    command: String,
    #[serde(default)]
    default: bool,
}

#[derive(Debug, Deserialize)]
struct TomlStep {
    name: String,
    #[serde(default)]
    workspace_name: String,
    #[serde(default)]
    brief: String,
    #[serde(default)]
    expected_artifacts: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    run: BTreeMap<String, TomlStepRun>,
}

fn normalize_resource_type(kind: &str) -> String {
    if RESOURCE_TYPES.contains(&kind) {
        kind.to_string()
    } else {
        "other".into()
    }
}

fn parse_config(text: &str) -> (ProjectConfigDto, Vec<String>) {
    let mut warnings = Vec::new();
    let value: toml::Value = match toml::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            // 整份文件坏掉：回落空配置，错误进 warnings，不谎报「无配置」
            return (
                ProjectConfigDto::default(),
                vec![format!("project.toml 解析失败，已按空配置处理: {e}")],
            );
        }
    };
    let mut config = ProjectConfigDto::default();
    match value.get("topic") {
        None => {}
        // 空白字符串视为未填写，不告警
        Some(toml::Value::String(s)) => {
            let t = s.trim();
            if !t.is_empty() {
                config.topic = Some(t.to_string());
            }
        }
        Some(_) => warnings.push("topic 不是有效字符串，已忽略".to_string()),
    }
    match value.get("artifact_dir") {
        None => {}
        Some(toml::Value::String(s)) if !s.trim().is_empty() => config.artifact_dir = s.clone(),
        Some(_) => warnings.push(format!(
            "artifact_dir 不是有效字符串，已使用默认值 {DEFAULT_ARTIFACT_DIR}"
        )),
    }
    if let Some(resources) = value.get("resources").and_then(|v| v.as_array()) {
        for (i, item) in resources.iter().enumerate() {
            match item.clone().try_into::<TomlResource>() {
                Ok(r) => {
                    let kind = normalize_resource_type(&r.kind);
                    if kind != r.kind {
                        warnings.push(format!(
                            "resources[{i}]（{}）的 type「{}」无法识别，已归为 other",
                            r.name, r.kind
                        ));
                    }
                    config.resources.push(ResourceDto {
                        name: r.name,
                        path: r.path,
                        kind,
                        readonly: r.readonly,
                        note: r.note,
                    });
                }
                Err(e) => warnings.push(format!("resources[{i}] 字段无效，已跳过: {e}")),
            }
        }
    } else if value.get("resources").is_some() {
        warnings.push("resources 不是表数组，已忽略".to_string());
    }
    if let Some(steps) = value.get("steps").and_then(|v| v.as_array()) {
        for (i, item) in steps.iter().enumerate() {
            match item.clone().try_into::<TomlStep>() {
                Ok(s) => config.steps.push(StepDto {
                    name: s.name,
                    workspace_name: s.workspace_name,
                    brief: s.brief,
                    expected_artifacts: s.expected_artifacts,
                    skills: s.skills,
                    run: s
                        .run
                        .into_iter()
                        .map(|(name, r)| StepRunDto {
                            name,
                            command: r.command,
                            is_default: r.default,
                        })
                        .collect(),
                }),
                Err(e) => warnings.push(format!("steps[{i}] 字段无效，已跳过: {e}")),
            }
        }
    } else if value.get("steps").is_some() {
        warnings.push("steps 不是表数组，已忽略".to_string());
    }
    (config, warnings)
}

fn read_config_at(project: &Path) -> ProjectConfigReadDto {
    let path = config_path(project);
    if !path.exists() {
        return ProjectConfigReadDto {
            config: ProjectConfigDto::default(),
            warnings: Vec::new(),
        };
    }
    match fs::read_to_string(&path) {
        Ok(text) => {
            let (config, warnings) = parse_config(&text);
            ProjectConfigReadDto { config, warnings }
        }
        Err(e) => ProjectConfigReadDto {
            config: ProjectConfigDto::default(),
            warnings: vec![format!("读取 project.toml 失败，已按空配置处理: {e}")],
        },
    }
}

/// 生成写入文本：以现有文件为底用 toml_edit 打补丁（同 global_config.rs 的 TOML 补丁风格），
/// 只全量替换 topic/artifact_dir/resources/steps 四个已知部分，其余未知键、注释、格式原样保留。
/// 现有文件无法解析时停止写入并报错，宁可让用户手工修复也不覆盖未知内容。
fn render_config(existing: Option<&str>, config: &ProjectConfigDto) -> Result<String, String> {
    use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};
    let mut doc = existing
        .unwrap_or("")
        .parse::<DocumentMut>()
        .map_err(|e| format!("现有 project.toml 解析失败，已停止写入: {e}"))?;
    match config.topic.as_deref().map(str::trim) {
        Some(topic) if !topic.is_empty() => {
            doc["topic"] = value(topic);
        }
        // 空 topic 视为清除：移除已有行，不写空字符串
        _ => {
            doc.remove("topic");
        }
    }
    let artifact_dir = if config.artifact_dir.trim().is_empty() {
        DEFAULT_ARTIFACT_DIR
    } else {
        config.artifact_dir.trim()
    };
    doc["artifact_dir"] = value(artifact_dir);
    if config.resources.is_empty() {
        doc.remove("resources");
    } else {
        let mut arr = ArrayOfTables::new();
        for r in &config.resources {
            let mut t = Table::new();
            t["name"] = value(&r.name);
            t["path"] = value(&r.path);
            t["type"] = value(normalize_resource_type(&r.kind));
            if r.readonly {
                t["readonly"] = value(true);
            }
            if !r.note.is_empty() {
                t["note"] = value(&r.note);
            }
            arr.push(t);
        }
        doc["resources"] = Item::ArrayOfTables(arr);
    }
    if config.steps.is_empty() {
        doc.remove("steps");
    } else {
        let mut arr = ArrayOfTables::new();
        for s in &config.steps {
            let mut t = Table::new();
            t["name"] = value(&s.name);
            if !s.workspace_name.is_empty() {
                t["workspace_name"] = value(&s.workspace_name);
            }
            if !s.brief.is_empty() {
                t["brief"] = value(&s.brief);
            }
            if !s.expected_artifacts.is_empty() {
                let mut artifacts = toml_edit::Array::new();
                for a in &s.expected_artifacts {
                    artifacts.push(a.as_str());
                }
                t["expected_artifacts"] = value(artifacts);
            }
            if !s.skills.is_empty() {
                let mut skills = toml_edit::Array::new();
                for k in &s.skills {
                    skills.push(k.as_str());
                }
                t["skills"] = value(skills);
            }
            if !s.run.is_empty() {
                let mut run = Table::new();
                for r in &s.run {
                    let mut entry = Table::new();
                    entry["command"] = value(&r.command);
                    if r.is_default {
                        entry["default"] = value(true);
                    }
                    run[&r.name] = Item::Table(entry);
                }
                t["run"] = Item::Table(run);
            }
            arr.push(t);
        }
        doc["steps"] = Item::ArrayOfTables(arr);
    }
    Ok(doc.to_string())
}

fn write_config_at(project: &Path, config: &ProjectConfigDto) -> Result<(), String> {
    let path = config_path(project);
    let existing = if path.exists() {
        Some(
            fs::read_to_string(&path)
                .map_err(|e| format!("读取现有 project.toml 失败，已停止写入: {e}"))?,
        )
    } else {
        None
    };
    let text = render_config(existing.as_deref(), config)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)
}

// ===== 资源自动发现（只读 stat，不读文件内容） =====

fn classify_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "pdf" => Some("paper"),
        "csv" | "tsv" | "parquet" | "xlsx" | "sav" | "dta" => Some("dataset"),
        "bib" | "ris" | "enw" => Some("reference"),
        _ => None,
    }
}

/// 路径规范化比较键：统一正斜杠、去 ./ 前缀与尾部斜杠（三平台路径混写都能对上）
fn norm_path_key(p: &str) -> String {
    p.replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string()
}

fn walk_discover(
    dir: &Path,
    root: &Path,
    depth: usize,
    artifact_dir: &str,
    registered: &[String],
    out: &mut Vec<DiscoveredResourceDto>,
) {
    const MAX_DEPTH: usize = 3;
    let Ok(entries) = fs::read_dir(dir) else {
        return; // 无权限等子目录跳过，不阻断整体扫描
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // file_type 不跟随符号链接：链接环不会导致无限递归，链接指向的目录也不会下钻
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if depth >= MAX_DEPTH
                || name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == artifact_dir
            {
                continue;
            }
            walk_discover(
                &entry.path(),
                root,
                depth + 1,
                artifact_dir,
                registered,
                out,
            );
        } else {
            let ext = entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some(kind) = classify_extension(&ext) else {
                continue;
            };
            let entry_path = entry.path();
            let Ok(rel) = entry_path.strip_prefix(root) else {
                continue;
            };
            let rel_key = norm_path_key(&rel.to_string_lossy());
            let abs_key = norm_path_key(&entry_path.to_string_lossy());
            let exists = registered
                .iter()
                .any(|r| *r == rel_key || *r == abs_key);
            let (size, mtime) = match entry.metadata() {
                Ok(m) => (
                    m.len(),
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| crate::sessions::iso_from_unix(d.as_secs())),
                ),
                Err(_) => (0, None),
            };
            out.push(DiscoveredResourceDto {
                path: rel_key,
                kind: kind.to_string(),
                size,
                mtime,
                exists,
            });
        }
    }
}

fn discover_at(project: &Path) -> Result<Vec<DiscoveredResourceDto>, String> {
    if !project.is_dir() {
        return Err(format!("项目目录不存在或不是目录: {}", project.display()));
    }
    let read = read_config_at(project);
    let registered: Vec<String> = read
        .config
        .resources
        .iter()
        .map(|r| norm_path_key(&r.path))
        .collect();
    let mut out = Vec::new();
    walk_discover(
        project,
        project,
        1,
        read.config.artifact_dir.trim(),
        &registered,
        &mut out,
    );
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

// ===== git 引导（幂等：已是仓库直接返回） =====

fn ensure_git_at(project: &Path) -> Result<EnsureGitDto, String> {
    if !project.is_dir() {
        return Err(format!("项目目录不存在或不是目录: {}", project.display()));
    }
    // git 缺失与「不是仓库」要分开：先解析二进制，缺失直接报错，不误判成未初始化
    if crate::agents::resolve_binary("git").is_none() {
        return Err("找不到 git 可执行文件，请先安装 git".to_string());
    }
    let inside = crate::workspaces::run_git(
        project,
        &["rev-parse", "--is-inside-work-tree"],
        Duration::from_secs(10),
    )
    .map(|out| out.trim() == "true")
    .unwrap_or(false);
    if inside {
        return Ok(EnsureGitDto {
            initialized: false,
            gitignore_written: false,
        });
    }
    crate::workspaces::run_git(project, &["init"], Duration::from_secs(30))
        .map_err(|e| format!("git init 失败: {e}"))?;
    let gitignore = project.join(".gitignore");
    let mut gitignore_written = false;
    if !gitignore.exists() {
        // 已有 .gitignore 不覆盖，避免清掉用户既有规则
        let read = read_config_at(project);
        let artifact_dir = read.config.artifact_dir.trim().trim_matches('/');
        let artifact_dir = if artifact_dir.is_empty() {
            DEFAULT_ARTIFACT_DIR
        } else {
            artifact_dir
        };
        let text = format!(
            "# Ccode 生成：产物与系统垃圾不进 git\n\
             /{artifact_dir}/\n\
             .DS_Store\n\
             \n\
             # 常见数据/产物目录（按需取消注释）\n\
             # /data/\n\
             # /output/\n\
             # /results/\n\
             # /figures/\n"
        );
        crate::profiles::atomic_write(&gitignore, &text)
            .map_err(|e| format!("写入 .gitignore 失败: {e}"))?;
        gitignore_written = true;
    }
    Ok(EnsureGitDto {
        initialized: true,
        gitignore_written,
    })
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn list_projects() -> Result<Vec<ProjectDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let conn = db()?;
        list_projects_in(&conn)
    })
    .await
    .map_err(|e| format!("读取项目列表失败: {e}"))?
}

#[tauri::command]
pub async fn register_project(path: String, name: String) -> Result<ProjectDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let conn = db()?;
        register_at(&conn, &project, &name, &crate::sessions::now_iso())
    })
    .await
    .map_err(|e| format!("注册项目失败: {e}"))?
}

#[tauri::command]
pub async fn remove_project(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let conn = db()?;
        remove_project_at(&conn, &project)
    })
    .await
    .map_err(|e| format!("移除项目注册失败: {e}"))?
}

#[tauri::command]
pub async fn read_project_config(path: String) -> ProjectConfigReadDto {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        read_config_at(&project)
    })
    .await
    .unwrap_or_else(|_| ProjectConfigReadDto {
        config: ProjectConfigDto::default(),
        warnings: vec!["读取项目配置时发生内部错误".to_string()],
    })
}

#[tauri::command]
pub async fn write_project_config(
    path: String,
    config: ProjectConfigDto,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        write_config_at(&project, &config)
    })
    .await
    .map_err(|e| format!("写入项目配置失败: {e}"))?
}

#[tauri::command]
pub async fn discover_resources(path: String) -> Result<Vec<DiscoveredResourceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        discover_at(&project)
    })
    .await
    .map_err(|e| format!("扫描项目资源失败: {e}"))?
}

#[tauri::command]
pub async fn ensure_git_repo(path: String) -> Result<EnsureGitDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        ensure_git_at(&project)
    })
    .await
    .map_err(|e| format!("git 初始化失败: {e}"))?
}

/// 一键开步（§11.4 P1b）：把步骤简报落成工作区 TASK.md。
/// 只写固定文件名且必须位于给定工作树根内；不存在则新建，原子写入。
#[tauri::command]
pub async fn write_workspace_task_md(
    worktree_path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP: usize = 64 * 1024;
        if content.len() > CAP {
            return Err("TASK.md 内容超过 64 KB".into());
        }
        let root = fs::canonicalize(crate::sessions::expand_tilde(&worktree_path))
            .map_err(|e| format!("工作区目录无效: {e}"))?;
        crate::profiles::atomic_write(&root.join("TASK.md"), &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccode-projects-{tag}-{}", uuid::Uuid::new_v4()))
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn sample_config() -> ProjectConfigDto {
        ProjectConfigDto {
            topic: None,
            artifact_dir: "outputs".into(),
            resources: vec![
                ResourceDto {
                    name: "核心论文".into(),
                    path: "papers/a.pdf".into(),
                    kind: "paper".into(),
                    readonly: true,
                    note: "先读这篇".into(),
                },
                ResourceDto {
                    name: "原始数据".into(),
                    path: "data/x.csv".into(),
                    kind: "dataset".into(),
                    readonly: false,
                    note: String::new(),
                },
            ],
            steps: vec![StepDto {
                name: "文献整理".into(),
                workspace_name: "lit".into(),
                brief: "读文献写笔记".into(),
                expected_artifacts: vec!["notes/".into()],
                skills: vec!["paper-notes".into()],
                run: vec![
                    StepRunDto {
                        name: "dev".into(),
                        command: "echo hi".into(),
                        is_default: true,
                    },
                    StepRunDto {
                        name: "test".into(),
                        command: "echo test".into(),
                        is_default: false,
                    },
                ],
            }],
        }
    }

    #[test]
    fn parse_full_config_and_render_round_trip() {
        let text = r#"artifact_dir = "outputs"
future_top_key = 42

[[resources]]
name = "核心论文"
path = "papers/a.pdf"
type = "paper"
readonly = true
note = "先读这篇"
unknown_field = "保持宽容"

[[resources]]
name = "原始数据"
path = "data/x.csv"
type = "dataset"

[[steps]]
name = "文献整理"
workspace_name = "lit"
brief = "读文献写笔记"
expected_artifacts = ["notes/"]
skills = ["paper-notes"]
[steps.run]
dev = { command = "echo hi", default = true }
test = { command = "echo test" }
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
        assert_eq!(config, sample_config());
        // 往返：渲染后再解析应还原；未知顶层键必须保留
        let rendered = render_config(Some(text), &config).unwrap();
        assert!(rendered.contains("future_top_key = 42"), "未知顶层键丢失: {rendered}");
        let (back, back_warnings) = parse_config(&rendered);
        assert!(back_warnings.is_empty(), "回读不应有警告: {back_warnings:?}");
        assert_eq!(back, config);
    }

    #[test]
    fn parse_tolerates_broken_entries_and_reports() {
        let text = r#"artifact_dir = 42
resources = "not-an-array"
"#;
        let (config, warnings) = parse_config(text);
        assert_eq!(config.artifact_dir, DEFAULT_ARTIFACT_DIR);
        assert!(config.resources.is_empty());
        assert_eq!(warnings.len(), 2, "坏标量与坏数组各一条警告: {warnings:?}");

        let text = r#"[[resources]]
name = "没有 path"
type = "paper"

[[resources]]
name = "类型值非法"
path = "a.pdf"
type = 123

[[resources]]
name = "好资源"
path = "data/x.csv"
type = "xlsx-ish"

[[steps]]
brief = "没有 name 的步骤"

[[steps]]
name = "好步骤"
"#;
        let (config, warnings) = parse_config(text);
        assert_eq!(config.resources.len(), 1, "两条坏资源跳过，只留好的");
        assert_eq!(config.resources[0].kind, "other", "无法识别的 type 归为 other");
        assert_eq!(config.steps.len(), 1);
        assert_eq!(config.steps[0].name, "好步骤");
        let joined = warnings.join("\n");
        assert!(joined.contains("resources[0]"), "缺字段条目要报告: {joined}");
        assert!(joined.contains("resources[1]"), "类型非法条目要报告: {joined}");
        assert!(joined.contains("无法识别"), "未知 type 要报告: {joined}");
        assert!(joined.contains("steps[0]"), "缺 name 步骤要报告: {joined}");
    }

    #[test]
    fn parse_broken_file_falls_back_to_default() {
        let (config, warnings) = parse_config("not [valid toml");
        assert_eq!(config, ProjectConfigDto::default());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("解析失败"));
    }

    #[test]
    fn render_replaces_known_sections_keeps_unknown() {
        let existing = r#"# 用户手写注释
artifact_dir = "old"
custom_pipeline = { foo = "bar" }

[[resources]]
name = "旧资源"
path = "old.pdf"
type = "paper"
"#;
        let config = ProjectConfigDto {
            topic: None,
            artifact_dir: "new-out".into(),
            resources: vec![ResourceDto {
                name: "新资源".into(),
                path: "new.csv".into(),
                kind: "dataset".into(),
                readonly: false,
                note: String::new(),
            }],
            steps: Vec::new(),
        };
        let rendered = render_config(Some(existing), &config).unwrap();
        assert!(rendered.contains("# 用户手写注释"), "注释必须保留: {rendered}");
        assert!(rendered.contains("custom_pipeline"), "未知表必须保留: {rendered}");
        assert!(!rendered.contains("旧资源"), "resources 全量替换: {rendered}");
        let (back, _) = parse_config(&rendered);
        assert_eq!(back, config);
        // 现有文件是坏 TOML 时停止写入，不覆盖未知内容
        assert!(render_config(Some("not [valid"), &config).is_err());
    }

    #[test]
    fn topic_round_trip_and_absent() {
        // 缺失时 None，渲染不写入 topic 行
        let (config, warnings) = parse_config("artifact_dir = \"outputs\"\n");
        assert!(warnings.is_empty());
        assert_eq!(config.topic, None);
        let rendered = render_config(None, &config).unwrap();
        assert!(!rendered.contains("topic"), "空 topic 不应写入: {rendered}");

        // 往返：解析 → 渲染 → 再解析一致；未知顶层键保留
        let text = "topic = \"GLP-1 受体激动剂的心血管结局\"\nfuture_top_key = 42\n";
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty());
        assert_eq!(config.topic.as_deref(), Some("GLP-1 受体激动剂的心血管结局"));
        let rendered = render_config(Some(text), &config).unwrap();
        assert!(rendered.contains("future_top_key = 42"), "未知顶层键丢失: {rendered}");
        let (back, back_warnings) = parse_config(&rendered);
        assert!(back_warnings.is_empty(), "回读不应有警告: {back_warnings:?}");
        assert_eq!(back, config);

        // 清空：渲染移除已有 topic 行
        let cleared = ProjectConfigDto { topic: None, ..config };
        let rendered = render_config(Some(&rendered), &cleared).unwrap();
        assert!(!rendered.contains("topic ="), "清空后应移除 topic 行: {rendered}");
        let (back, _) = parse_config(&rendered);
        assert_eq!(back.topic, None);

        // 非字符串 topic：忽略并告警，不阻断
        let (config, warnings) = parse_config("topic = 42\n");
        assert_eq!(config.topic, None);
        assert_eq!(warnings.len(), 1, "坏 topic 要报告: {warnings:?}");
    }

    #[test]
    fn write_then_read_config_through_fs() {
        let dir = temp_dir("rw");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        // 无文件时读默认空配置
        let read = read_config_at(&project);
        assert_eq!(read.config, ProjectConfigDto::default());
        assert!(read.warnings.is_empty());
        // 写入后读回一致（.ccode 目录自动创建）
        let config = sample_config();
        write_config_at(&project, &config).unwrap();
        let read = read_config_at(&project);
        assert_eq!(read.config, config);
        // 再次写入全量替换 resources
        let mut config2 = config.clone();
        config2.resources.clear();
        write_config_at(&project, &config2).unwrap();
        let read = read_config_at(&project);
        assert_eq!(read.config, config2);
        let on_disk = fs::read_to_string(config_path(&project)).unwrap();
        assert!(!on_disk.contains("核心论文"), "resources 应被全量替换: {on_disk}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discover_classifies_limits_depth_and_skips_dirs() {
        let dir = temp_dir("discover");
        let root = dir.join("proj");
        let files = [
            ("paper.pdf", "paper"),
            ("data/a.csv", "dataset"),
            ("refs.bib", "reference"),
            ("deep1/deep2/mid.parquet", "dataset"), // 第 3 层，在内
        ];
        for (rel, _) in files {
            write(&root.join(rel), "x");
        }
        // 应被排除：超深、隐藏目录、node_modules、target、artifacts 目录、未识别扩展名
        for rel in [
            "d1/d2/d3/too-deep.pdf",
            ".hidden/secret.pdf",
            "node_modules/dep.pdf",
            "target/build.pdf",
            "artifacts/out.pdf",
            "notes.txt",
        ] {
            write(&root.join(rel), "x");
        }
        // 登记一个已有资源验证 exists 标记
        let mut config = ProjectConfigDto::default();
        config.resources.push(ResourceDto {
            name: "已登记".into(),
            path: "data/a.csv".into(),
            kind: "dataset".into(),
            readonly: false,
            note: String::new(),
        });
        write_config_at(&root, &config).unwrap();

        let found = discover_at(&root).unwrap();
        let got: Vec<(&str, &str, bool)> = found
            .iter()
            .map(|d| (d.path.as_str(), d.kind.as_str(), d.exists))
            .collect();
        assert_eq!(
            got,
            vec![
                ("data/a.csv", "dataset", true),
                ("deep1/deep2/mid.parquet", "dataset", false),
                ("paper.pdf", "paper", false),
                ("refs.bib", "reference", false),
            ],
            "分类、限深与排除目录都要正确"
        );
        assert!(found.iter().all(|d| d.size == 1 && d.mtime.is_some()));
        // 不存在的目录要报错而不是静默空列表
        assert!(discover_at(&root.join("missing")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn registry_crud_and_reregister() {
        let dir = temp_dir("db");
        let db_path = dir.join("app.db");
        let conn = db_at(&db_path).unwrap();
        let p1 = dir.join("proj-a");
        let p2 = dir.join("proj-b");
        fs::create_dir_all(&p1).unwrap();
        fs::create_dir_all(&p2).unwrap();

        let d1 = register_at(&conn, &p1, "课题甲", "2026-08-01T00:00:00Z").unwrap();
        register_at(&conn, &p2, "课题乙", "2026-08-02T00:00:00Z").unwrap();
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "课题乙", "按 last_opened_at 降序");
        assert_eq!(list[1].path, d1.path);

        // 重复注册：保留 created_at、更新 name 与 last_opened，行数不变
        let d1b = register_at(&conn, &p1, "课题甲改", "2026-08-03T00:00:00Z").unwrap();
        assert_eq!(d1b.path, d1.path, "同目录不同写法应归并到同一主键");
        assert_eq!(d1b.created_at, d1.created_at);
        assert_eq!(d1b.name, "课题甲改");
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "课题甲改");

        // 移除只删注册记录，目录仍在
        remove_project_at(&conn, &p2).unwrap();
        assert!(p2.exists());
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, d1.path);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_git_repo_idempotent() {
        let dir = temp_dir("git");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 ensure_git_repo 用例");
            return;
        }
        let first = ensure_git_at(&project).unwrap();
        assert!(first.initialized && first.gitignore_written);
        assert!(project.join(".git").exists());
        let gitignore = fs::read_to_string(project.join(".gitignore")).unwrap();
        assert!(gitignore.contains("/artifacts/"), "默认产物目录进 gitignore: {gitignore}");
        assert!(gitignore.contains(".DS_Store"));

        // 幂等：已是仓库直接返回，不改写任何文件
        let second = ensure_git_at(&project).unwrap();
        assert!(!second.initialized && !second.gitignore_written);
        assert_eq!(fs::read_to_string(project.join(".gitignore")).unwrap(), gitignore);

        // 自定义 artifact_dir 的项目：gitignore 用配置值
        let project2 = dir.join("proj2");
        fs::create_dir_all(&project2).unwrap();
        let mut config = ProjectConfigDto::default();
        config.artifact_dir = "outputs".into();
        write_config_at(&project2, &config).unwrap();
        let r = ensure_git_at(&project2).unwrap();
        assert!(r.initialized);
        let gitignore2 = fs::read_to_string(project2.join(".gitignore")).unwrap();
        assert!(gitignore2.contains("/outputs/"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
