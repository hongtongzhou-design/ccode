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
    // 资源绑定：[[resources]] 条目的 path 精确匹配（相对/绝对均可）；
    // 空数组 = 不绑定 = 全部资源（向后兼容旧档案卡）
    pub resources: Vec<String>,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapCommitDto {
    pub committed: bool,    // 本次是否产生了提交
    pub paths: Vec<String>, // 实际提交的文件（相对仓库根）
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

/// P2a PDF 白名单用（pdf.rs）：全部注册项目根 + 各项目 project.toml 登记资源的绝对路径。
/// 资源相对路径按项目根解析；读不到配置的项目静默跳过（白名单宁缺勿滥）。
pub(crate) fn project_roots_and_resources() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let Ok(conn) = db() else {
        return (Vec::new(), Vec::new());
    };
    let mut roots = Vec::new();
    let mut resources = Vec::new();
    for p in list_projects_in(&conn).unwrap_or_default() {
        let root = PathBuf::from(&p.path);
        roots.push(root.clone());
        let Ok(text) = fs::read_to_string(config_path(&root)) else {
            continue;
        };
        let (config, _) = parse_config(&text);
        for r in config.resources {
            let rp = PathBuf::from(&r.path);
            resources.push(if rp.is_absolute() { rp } else { root.join(&rp) });
        }
    }
    (roots, resources)
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
                Ok(s) => {
                    // resources 不进 TomlStep 由 serde 解析：非数组/非字符串项要逐条容错跳过，
                    // 避免一个坏绑定拖垮整个步骤（风格同其他字段的 warning 文案）
                    let mut bound = Vec::new();
                    match item.get("resources") {
                        None => {}
                        Some(toml::Value::Array(arr)) => {
                            for (j, v) in arr.iter().enumerate() {
                                match v.as_str() {
                                    Some(p) if !p.trim().is_empty() => bound.push(p.to_string()),
                                    _ => warnings.push(format!(
                                        "steps[{i}] 的 resources[{j}] 不是有效字符串，已跳过"
                                    )),
                                }
                            }
                        }
                        Some(_) => warnings
                            .push(format!("steps[{i}] 的 resources 不是数组，已忽略")),
                    }
                    config.steps.push(StepDto {
                        name: s.name,
                        workspace_name: s.workspace_name,
                        brief: s.brief,
                        expected_artifacts: s.expected_artifacts,
                        skills: s.skills,
                        resources: bound,
                        run: s
                            .run
                            .into_iter()
                            .map(|(name, r)| StepRunDto {
                                name,
                                command: r.command,
                                is_default: r.default,
                            })
                            .collect(),
                    });
                }
                Err(e) => warnings.push(format!("steps[{i}] 字段无效，已跳过: {e}")),
            }
        }
    } else if value.get("steps").is_some() {
        warnings.push("steps 不是表数组，已忽略".to_string());
    }
    // 语义级校验（绑定资源存在性、简报产物引用）并入 warnings，read_project_config 自动产出
    for step in &config.steps {
        warnings.extend(validate_step(step, &config.resources));
    }
    (config, warnings)
}

// ===== 步骤资源绑定的轻量校验（纯函数，供 read 流程与后续 command 复用） =====

/// brief 里约定俗成的产物路径引用：引用了但 expectedArtifacts 没有对应项时提示
const BRIEF_ARTIFACT_REFS: [&str; 5] =
    ["papers/", "notes/", "references.bib", "outline.md", "manuscript/"];

/// 校验单个步骤，返回中文提示文案（不做翻译层）：
/// ① 绑定值必须在 [[resources]] 的 path 里精确存在；空数组 = 不绑定，不触发；
/// ② brief 引用了约定产物路径，但 expectedArtifacts 无对应项（同值或以该目录开头）时提示。
pub(crate) fn validate_step(step: &StepDto, resources: &[ResourceDto]) -> Vec<String> {
    let mut warnings = Vec::new();
    for bound in &step.resources {
        if !resources.iter().any(|r| r.path == *bound) {
            warnings.push(format!(
                "步骤「{}」绑定的资源不存在：{bound}",
                step.name
            ));
        }
    }
    for token in BRIEF_ARTIFACT_REFS {
        if step.brief.contains(token)
            && !step
                .expected_artifacts
                .iter()
                .any(|e| e == token || e.starts_with(token))
        {
            warnings.push(format!(
                "步骤「{}」的简报引用了「{token}」，但 expectedArtifacts 未包含对应产物",
                step.name
            ));
        }
    }
    warnings
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

/// RX3a 对话步骤化：workspace_name → 步骤名映射（会话列表按步骤标注/搜索/分组用）。
/// 读不到配置返回空映射，与 read_project_config 的容错风格一致（宁缺勿阻断）。
pub(crate) fn step_names_at(project: &Path) -> std::collections::HashMap<String, String> {
    read_config_at(project)
        .config
        .steps
        .into_iter()
        .filter(|s| !s.workspace_name.is_empty())
        .map(|s| (s.workspace_name, s.name))
        .collect()
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
            // 空数组省略不写：空 = 不绑定 = 全部资源，与省略同语义，档案卡更简洁
            if !s.resources.is_empty() {
                let mut resources = toml_edit::Array::new();
                for r in &s.resources {
                    resources.push(r.as_str());
                }
                t["resources"] = value(resources);
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
             # 文献 PDF 等大文件登记为资源引用，不进 git\n\
             *.pdf\n\
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

// ===== 开步自动提交：只把 .ccode 与 .gitignore 两个 Ccode 自有路径提交进主仓库 =====
// 背景：git init 后档案卡（.ccode/project.toml）与 .gitignore 长期未跟踪，
// 工作区评审合并会被「主仓库有未提交改动」拦截。此命令只碰这两个路径，
// 用户其他文件（PDF 等）绝不纳入——commit 同样带 pathspec，防止扫进用户已暂存的内容。

/// 开步自动提交只处理的两个 Ccode 自有路径（literal pathspec，无 glob 展开）
const BOOTSTRAP_PATHS: [&str; 2] = [".ccode", ".gitignore"];

fn commit_bootstrap_at(repo: &Path) -> Result<BootstrapCommitDto, String> {
    const T: Duration = Duration::from_secs(30);
    if !repo.is_dir() {
        return Err(format!("项目目录不存在或不是目录: {}", repo.display()));
    }
    if crate::agents::resolve_binary("git").is_none() {
        return Err("找不到 git 可执行文件，请先安装 git".to_string());
    }
    let inside = crate::workspaces::run_git(repo, &["rev-parse", "--is-inside-work-tree"], T)
        .map(|out| out.trim() == "true")
        .unwrap_or(false);
    if !inside {
        return Err("不是 git 仓库，请先在项目页执行 git 初始化".to_string());
    }
    // 只处理磁盘上存在的路径：git add 对不存在的 pathspec 会整体失败，先过滤
    let existing: Vec<&str> = BOOTSTRAP_PATHS
        .into_iter()
        .filter(|p| repo.join(p).exists())
        .collect();
    if existing.is_empty() {
        return Ok(BootstrapCommitDto {
            committed: false,
            paths: Vec::new(),
        });
    }
    // 暂存这两个路径下的全部改动（untracked / modified / 已暂存）
    let mut add_args: Vec<&str> = vec!["--literal-pathspecs", "add", "--"];
    add_args.extend(existing.iter().copied());
    crate::workspaces::run_git(repo, &add_args, T)
        .map_err(|e| format!("暂存 .ccode/.gitignore 失败: {e}"))?;
    // 有暂存内容才提交；空仓库（unborn HEAD）下 diff --cached 与空树比较，也能列出新增文件
    let mut staged_args: Vec<&str> =
        vec!["--literal-pathspecs", "diff", "--cached", "--name-only", "--"];
    staged_args.extend(existing.iter().copied());
    let staged = crate::workspaces::run_git(repo, &staged_args, T)
        .map_err(|e| format!("检查暂存内容失败: {e}"))?;
    let paths: Vec<String> = staged
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if paths.is_empty() {
        return Ok(BootstrapCommitDto {
            committed: false,
            paths: Vec::new(),
        });
    }
    // 与 ensure_initial_commit 同一模式：绕过 gpgsign；git 身份缺失时仅本次提交
    // 用 -c 注入临时身份，不写入用户 git config
    let configured = |key: &str| {
        crate::workspaces::run_git(repo, &["config", "--get", key], T)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    };
    let mut args: Vec<&str> = vec!["-c", "commit.gpgsign=false", "--literal-pathspecs"];
    if !configured("user.name") {
        args.extend(["-c", "user.name=Ccode"]);
    }
    if !configured("user.email") {
        args.extend(["-c", "user.email=ccode@localhost"]);
    }
    // pathspec 限定提交范围：用户先前自行暂存的其他文件留在暂存区，不被本次提交带走
    args.extend(["commit", "-m", "Ccode: 项目档案卡与 gitignore 自动提交", "--"]);
    args.extend(existing.iter().copied());
    crate::workspaces::run_git(repo, &args, T).map_err(|e| format!("自动提交失败: {e}"))?;
    Ok(BootstrapCommitDto {
        committed: true,
        paths,
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

/// 一键开步前置：把 .ccode 与 .gitignore 两个 Ccode 自有路径提交进主仓库。
/// 幂等：无改动返回 committed=false；非仓库报错（前端开步流程已先走 ensure_git_repo）。
#[tauri::command]
pub async fn commit_project_bootstrap(repo_path: String) -> Result<BootstrapCommitDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(crate::sessions::expand_tilde(&repo_path));
        commit_bootstrap_at(&repo)
    })
    .await
    .map_err(|e| format!("自动提交项目档案卡失败: {e}"))?
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
        // TASK.md 是开步脚手架而非任务产物：把它加进仓库级 .git/info/exclude，
        // 防止工作区全量提交把它带进分支、合并后污染主项目根目录（旧 TASK.md 会误导后续 Agent）
        exclude_task_md(&root);
        crate::profiles::atomic_write(&root.join("TASK.md"), &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把 TASK.md 追加到仓库共享的 .git/info/exclude（对所有 worktree 与主仓生效）。
/// best-effort：拿不到 git 公共目录（非仓库/异常）时静默跳过，不阻断 TASK.md 写入。
fn exclude_task_md(worktree_root: &Path) {
    let Ok(common) = crate::workspaces::run_git(
        worktree_root,
        &["rev-parse", "--git-common-dir"],
        std::time::Duration::from_secs(30),
    ) else {
        return;
    };
    let common = common.trim();
    if common.is_empty() {
        return;
    }
    // --git-common-dir 可能返回相对路径（相对 worktree 根）
    let dir = Path::new(common);
    let dir = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        worktree_root.join(dir)
    };
    let exclude = dir.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == "TASK.md") {
        return;
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("TASK.md\n");
    let _ = fs::create_dir_all(exclude.parent().unwrap());
    let _ = crate::profiles::atomic_write(&exclude, &content);
}

// ===== P2b「整理为笔记」：PDF 选段 → 笔记工作区 notes/inbox.md =====

/// 归属判定（纯函数，测试友好）：登记资源精确命中优先，其次项目根前缀命中；
/// 前缀取最长匹配（项目嵌套时归内层）。输入均为 canonical 路径。
fn resolve_owner(target: &Path, projects: &[(PathBuf, Vec<PathBuf>)]) -> Option<usize> {
    // 资源可以是项目根外的单个文件，故精确命中先于前缀判定
    if let Some(i) = projects
        .iter()
        .position(|(_, resources)| resources.iter().any(|r| target == r))
    {
        return Some(i);
    }
    projects
        .iter()
        .enumerate()
        .filter(|(_, (root, _))| target.starts_with(root))
        .max_by_key(|(_, (root, _))| root.as_os_str().len())
        .map(|(i, _)| i)
}

fn pdf_owner_at(pdf_path: &Path) -> Result<Option<ProjectDto>, String> {
    let target = fs::canonicalize(pdf_path).map_err(|e| format!("PDF 路径无效: {e}"))?;
    let conn = db()?;
    let projects = list_projects_in(&conn)?;
    let mut entries: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for p in &projects {
        // 根已失效（目录被移走）的项目跳过，不阻断其它项目的判定
        let Ok(root) = fs::canonicalize(&p.path) else {
            continue;
        };
        let mut resources = Vec::new();
        if let Ok(text) = fs::read_to_string(config_path(&root)) {
            let (config, _) = parse_config(&text);
            for r in config.resources {
                let rp = PathBuf::from(&r.path);
                let abs = if rp.is_absolute() { rp } else { root.join(&rp) };
                // 资源文件被移动/删除后无法精确命中，跳过（宁缺勿滥）
                if let Ok(c) = fs::canonicalize(&abs) {
                    resources.push(c);
                }
            }
        }
        entries.push((root, resources));
    }
    Ok(resolve_owner(&target, &entries).map(|i| projects[i].clone()))
}

/// 按 PDF 路径反查归属项目：登记资源精确命中 → 项目根前缀命中 → Ok(None)（前端提示去登记）。
#[tauri::command]
pub async fn pdf_owner_project(pdf_path: String) -> Result<Option<ProjectDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pdf_owner_at(&PathBuf::from(crate::sessions::expand_tilde(&pdf_path)))
    })
    .await
    .map_err(|e| format!("查询 PDF 归属项目失败: {e}"))?
}

/// 首次创建 inbox.md 时的文件头（注明来源与用途）
const INBOX_HEADER: &str = "# 文献摘录收件箱\n\n\
     > 由 Ccode「整理为笔记」从 PDF 选段自动追加；整理进结构化笔记后可清理对应条目。\n";

/// 追加语义 + 白名单（同步函数供测试）：
/// 目标固定为工作区根内 notes/inbox.md（不接受外部传入子路径），单次追加 ≤ 64 KB；
/// 读-改-原子写（atomic_write 走 tmp+rename，symlink 会被整体替换而非穿透）；
/// 已存在的 inbox.md 先 canonicalize 双校验仍在根内，堵符号链接逃逸。
fn append_inbox_at(worktree_path: &Path, content: &str) -> Result<(), String> {
    const CAP: usize = 64 * 1024;
    if content.len() > CAP {
        return Err("追加内容超过 64 KB".into());
    }
    let root = fs::canonicalize(worktree_path).map_err(|e| format!("工作区目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("工作区路径不是目录".into());
    }
    let notes_dir = root.join("notes");
    fs::create_dir_all(&notes_dir).map_err(|e| format!("创建 notes 目录失败: {e}"))?;
    let target = notes_dir.join("inbox.md");
    if target.exists() {
        let canon_target =
            fs::canonicalize(&target).map_err(|e| format!("读取 inbox.md 失败: {e}"))?;
        if !canon_target.starts_with(&root) {
            return Err("notes/inbox.md 指向工作区之外，拒绝写入".into());
        }
    }
    let mut text = if target.exists() {
        fs::read_to_string(&target).map_err(|e| format!("读取 inbox.md 失败: {e}"))?
    } else {
        INBOX_HEADER.to_string()
    };
    text.push_str(content);
    crate::profiles::atomic_write(&target, &text)
}

/// 把选段追加到工作区 notes/inbox.md（P2b）；写入规则见 append_inbox_at。
#[tauri::command]
pub async fn append_workspace_inbox(
    worktree_path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_inbox_at(Path::new(&crate::sessions::expand_tilde(&worktree_path)), &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 流水线模板库：用户自定义模板（<config>/ccode/pipeline-templates.json） =====
// 只存用户模板，内置模板在前端。文件存储风格同 settings.rs（同目录、原子写）；
// 损坏处理参照 keys.json 教训改名备份，但模板不是密钥——备份后按空表继续，
// 不丢其他数据（损坏的整份文件内容保留在 corrupt 备份里供人工恢复）。

/// 契约名别名：流水线步骤 DTO 即本文件的 StepDto（字段/camelCase 完全一致）
pub type ProjectStepDto = StepDto;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTemplateDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: Vec<ProjectStepDto>,
    pub created_at: String,
}

fn templates_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("pipeline-templates.json"))
}

/// 读模板表：文件缺失视为空表；解析失败说明文件损坏——改名备份为
/// pipeline-templates.json.corrupt-<unix 秒> 后按空表继续（模板非密钥，参照 keys.json
/// 教训但不需要报错阻断）；其他 IO 错误向上报，避免下次写回静默清空
fn read_templates_at(path: &Path) -> Result<Vec<PipelineTemplateDto>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(v) => Ok(v),
        Err(_) => {
            // 备份名用 unix 秒：冒号在 Windows 文件名非法（同 keys.json 约定）
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let mut name = path.as_os_str().to_os_string();
            name.push(format!(".corrupt-{ts}"));
            let _ = fs::rename(path, PathBuf::from(name));
            Ok(Vec::new())
        }
    }
}

fn write_templates_at(path: &Path, templates: &[PipelineTemplateDto]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(templates).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 保存模板：name 去空白后非空、steps 非空；同名 = 覆盖（覆盖确认在前端完成），
/// 覆盖时保留原 id 与 created_at，只更新 description/steps
fn save_template_at(
    path: &Path,
    name: &str,
    description: &str,
    steps: Vec<ProjectStepDto>,
) -> Result<PipelineTemplateDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("模板名称不能为空".into());
    }
    if steps.is_empty() {
        return Err("模板至少需要一个步骤".into());
    }
    let mut templates = read_templates_at(path)?;
    let tpl = match templates.iter_mut().find(|t| t.name == name) {
        Some(existing) => {
            existing.description = description.to_string();
            existing.steps = steps;
            existing.clone()
        }
        None => {
            let tpl = PipelineTemplateDto {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                description: description.to_string(),
                steps,
                created_at: crate::sessions::now_iso(),
            };
            templates.push(tpl.clone());
            tpl
        }
    };
    write_templates_at(path, &templates)?;
    Ok(tpl)
}

/// 删除模板：id 不存在时按无操作处理（与 profiles 删除语义一致）
fn delete_template_at(path: &Path, id: &str) -> Result<(), String> {
    let mut templates = read_templates_at(path)?;
    templates.retain(|t| t.id != id);
    write_templates_at(path, &templates)
}

#[tauri::command]
pub async fn list_pipeline_templates() -> Result<Vec<PipelineTemplateDto>, String> {
    tauri::async_runtime::spawn_blocking(|| read_templates_at(&templates_path()?))
        .await
        .map_err(|e| format!("读取流水线模板失败: {e}"))?
}

#[tauri::command]
pub async fn save_pipeline_template(
    name: String,
    description: String,
    steps: Vec<ProjectStepDto>,
) -> Result<PipelineTemplateDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 与 profiles/settings 共用同一把读-改-写锁，防并发保存互相覆盖
        let _g = crate::profiles::store_lock();
        save_template_at(&templates_path()?, &name, &description, steps)
    })
    .await
    .map_err(|e| format!("保存流水线模板失败: {e}"))?
}

#[tauri::command]
pub async fn delete_pipeline_template(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _g = crate::profiles::store_lock();
        delete_template_at(&templates_path()?, &id)
    })
    .await
    .map_err(|e| format!("删除流水线模板失败: {e}"))?
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
                resources: Vec::new(),
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

    // ===== 步骤资源绑定（resources 字段与 validate_step） =====

    #[test]
    fn step_resources_round_trip_and_default_empty() {
        // 缺失 resources 的步骤默认空数组；绑定的步骤精确往返（相对与绝对路径混合）
        let text = r#"[[resources]]
name = "论文A"
path = "papers/a.pdf"

[[resources]]
name = "共享数据"
path = "/shared/data/x.csv"

[[steps]]
name = "文献整理"
brief = "读文献写笔记"

[[steps]]
name = "数据分析"
brief = "跑数据"
resources = ["papers/a.pdf", "/shared/data/x.csv"]
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
        assert_eq!(config.steps[0].resources, Vec::<String>::new(), "缺失默认空");
        assert_eq!(
            config.steps[1].resources,
            vec!["papers/a.pdf".to_string(), "/shared/data/x.csv".to_string()]
        );
        let rendered = render_config(Some(text), &config).unwrap();
        assert!(rendered.contains("resources = ["), "绑定必须写回: {rendered}");
        let (back, back_warnings) = parse_config(&rendered);
        assert!(back_warnings.is_empty(), "回读不应有警告: {back_warnings:?}");
        assert_eq!(back, config);
        // 空数组渲染时省略不写（语义同省略）
        let cleared = StepDto {
            resources: Vec::new(),
            ..config.steps[1].clone()
        };
        let mut cfg = config.clone();
        cfg.steps[1] = cleared;
        let rendered = render_config(Some(&rendered), &cfg).unwrap();
        assert!(!rendered.contains("resources ="), "空绑定不应写入: {rendered}");
        let (back, _) = parse_config(&rendered);
        assert_eq!(back, cfg);
    }

    #[test]
    fn step_resources_tolerates_bad_values() {
        // 非数组 → 整条忽略并告警，步骤本体保留；非字符串/空白项逐条跳过并告警
        let text = r#"[[steps]]
name = "坏绑定一"
resources = "not-an-array"

[[steps]]
name = "坏绑定二"
resources = [1, "papers/a.pdf", "", 42]
"#;
        let (config, warnings) = parse_config(text);
        assert_eq!(config.steps.len(), 2, "坏 resources 不得拖垮步骤: {warnings:?}");
        assert!(config.steps[0].resources.is_empty());
        assert_eq!(config.steps[1].resources, vec!["papers/a.pdf".to_string()]);
        let joined = warnings.join("\n");
        assert!(joined.contains("steps[0] 的 resources 不是数组"), "{joined}");
        assert!(joined.contains("steps[1] 的 resources[0]"), "{joined}");
        assert!(joined.contains("steps[1] 的 resources[2]"), "空白项也要报告: {joined}");
        assert!(joined.contains("steps[1] 的 resources[3]"), "{joined}");
    }

    #[test]
    fn validate_step_binding_rules() {
        let resources = vec![
            ResourceDto {
                name: "论文A".into(),
                path: "papers/a.pdf".into(),
                kind: "paper".into(),
                readonly: true,
                note: String::new(),
            },
            ResourceDto {
                name: "共享数据".into(),
                path: "/shared/x.csv".into(),
                kind: "dataset".into(),
                readonly: false,
                note: String::new(),
            },
        ];
        // 规则①：绑定 path 不在 [[resources]] 里 → 提示；精确命中（相对/绝对）与空绑定不提示
        let step = StepDto {
            name: "分析".into(),
            resources: vec!["papers/a.pdf".into(), "/shared/x.csv".into(), "missing.pdf".into()],
            ..StepDto::default()
        };
        let warnings = validate_step(&step, &resources);
        assert_eq!(warnings.len(), 1, "只有不存在的绑定要提示: {warnings:?}");
        assert!(warnings[0].contains("绑定的资源不存在：missing.pdf"), "{}", warnings[0]);
        let ok = StepDto {
            resources: vec!["papers/a.pdf".into()],
            ..StepDto::default()
        };
        assert!(validate_step(&ok, &resources).is_empty(), "精确命中不提示");
        let unbound = StepDto::default();
        assert!(
            validate_step(&unbound, &resources).is_empty(),
            "空数组 = 不绑定 = 全部资源，不校验"
        );

        // 规则②：brief 引用约定产物路径但 expectedArtifacts 无对应项 → 提示；有对应项或无引用不提示
        let miss = StepDto {
            name: "整理".into(),
            brief: "通读 papers/ 后把笔记写进 notes/，更新 references.bib".into(),
            expected_artifacts: vec!["notes/".into()],
            ..StepDto::default()
        };
        let warnings = validate_step(&miss, &resources);
        assert_eq!(warnings.len(), 2, "papers/ 与 references.bib 各提示一次: {warnings:?}");
        assert!(warnings.iter().any(|w| w.contains("「papers/」")), "{warnings:?}");
        assert!(warnings.iter().any(|w| w.contains("「references.bib」")), "{warnings:?}");
        let hit = StepDto {
            brief: "把综述草稿写进 manuscript/ 并同步 outline.md".into(),
            expected_artifacts: vec!["manuscript/draft.md".into(), "outline.md".into()],
            ..StepDto::default()
        };
        assert!(
            validate_step(&hit, &resources).is_empty(),
            "目录前缀命中与文件精确命中都不提示"
        );
        let no_ref = StepDto {
            brief: "读文献写笔记".into(),
            ..StepDto::default()
        };
        assert!(validate_step(&no_ref, &resources).is_empty(), "无引用不提示");
    }

    #[test]
    fn read_config_merges_validation_warnings() {
        // read_project_config 的 warnings 自动并入校验结果
        let dir = temp_dir("validate");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        let text = r#"[[steps]]
name = "分析"
brief = "产出进 notes/"
resources = ["ghost.pdf"]
"#;
        write(&config_path(&project), text);
        let read = read_config_at(&project);
        let joined = read.warnings.join("\n");
        assert!(joined.contains("绑定的资源不存在：ghost.pdf"), "{joined}");
        assert!(joined.contains("「notes/」"), "{joined}");
        // 无问题的配置 warnings 为空
        write_config_at(&project, &sample_config()).unwrap();
        let read = read_config_at(&project);
        assert!(read.warnings.is_empty(), "干净配置不应有警告: {:?}", read.warnings);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn step_names_at_maps_workspace_to_step() {
        let dir = temp_dir("stepnames");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        // 无档案卡：空映射，不报错
        assert!(step_names_at(&project).is_empty());
        write_config_at(&project, &sample_config()).unwrap();
        let map = step_names_at(&project);
        assert_eq!(map.get("lit").map(String::as_str), Some("文献整理"));
        // 无 workspace_name 的步骤不进映射
        let mut config = sample_config();
        config.steps.push(StepDto {
            name: "无工作区步骤".into(),
            ..StepDto::default()
        });
        write_config_at(&project, &config).unwrap();
        let map = step_names_at(&project);
        assert_eq!(map.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
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

    // ===== 开步自动提交（commit_bootstrap_at） =====

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        crate::workspaces::run_git(dir, args, Duration::from_secs(30))
            .unwrap_or_else(|e| panic!("git {args:?} 失败: {e}"))
    }

    fn git_has_head(dir: &Path) -> bool {
        crate::workspaces::run_git(
            dir,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            Duration::from_secs(10),
        )
        .is_ok()
    }

    #[test]
    fn bootstrap_commit_only_ccode_paths_and_idempotent() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
            return;
        }
        let dir = temp_dir("bootstrap");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        ensure_git_at(&project).unwrap(); // git init + 默认 .gitignore
        write_config_at(&project, &sample_config()).unwrap(); // .ccode/project.toml
        // 用户文件：必须保持未跟踪，绝不纳入自动提交
        write(&project.join("paper.pdf"), "pdf");
        write(&project.join("data/notes.txt"), "n");
        // 用户自行暂存的文件也不得被本次提交带走（commit 有 pathspec 限定）
        write(&project.join("staged.txt"), "s");
        git_ok(&project, &["add", "staged.txt"]);

        let r = commit_bootstrap_at(&project).unwrap();
        assert!(r.committed, "untracked 的 .ccode/.gitignore 必须提交");
        assert!(r.paths.contains(&".gitignore".to_string()), "{:?}", r.paths);
        assert!(
            r.paths.contains(&".ccode/project.toml".to_string()),
            "{:?}",
            r.paths
        );
        assert!(
            !r.paths
                .iter()
                .any(|p| p.contains("paper.pdf") || p.contains("notes") || p.contains("staged")),
            "用户文件绝不进提交清单: {:?}",
            r.paths
        );

        // HEAD 树里只有 Ccode 自有路径
        let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(tree.contains(".gitignore") && tree.contains(".ccode/project.toml"), "{tree}");
        assert!(
            !tree.contains("paper.pdf") && !tree.contains("notes.txt") && !tree.contains("staged.txt"),
            "用户文件绝不进树: {tree}"
        );
        // 用户文件保持原状态：未跟踪的仍 ??，用户暂存的仍 A
        let status = git_ok(&project, &["status", "--porcelain=v1", "--untracked-files=all"]);
        assert!(
            status.lines().any(|l| l.starts_with("??") && l.contains("notes.txt")),
            "未跟踪用户文件不动: {status}"
        );
        assert!(
            status.lines().any(|l| l.starts_with("A ") && l.contains("staged.txt")),
            "用户暂存文件留在暂存区: {status}"
        );

        // 幂等：第二次 committed=false，用户暂存内容仍不被带走
        let r2 = commit_bootstrap_at(&project).unwrap();
        assert!(!r2.committed && r2.paths.is_empty(), "第二次必须幂等: {r2:?}");
        let status2 = git_ok(&project, &["status", "--porcelain=v1"]);
        assert!(
            status2.lines().any(|l| l.starts_with("A ") && l.contains("staged.txt")),
            "{status2}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bootstrap_commit_picks_up_modified_gitignore() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
            return;
        }
        let dir = temp_dir("bootstrap-mod");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        ensure_git_at(&project).unwrap();
        // 只存在 .gitignore（无 .ccode）：只提交存在的路径
        let r1 = commit_bootstrap_at(&project).unwrap();
        assert!(r1.committed && r1.paths == [".gitignore".to_string()], "{r1:?}");

        // 修改已跟踪的 .gitignore：modified 也要被提交
        fs::write(project.join(".gitignore"), "# 用户改过的\n*.pdf\n").unwrap();
        let r2 = commit_bootstrap_at(&project).unwrap();
        assert!(r2.committed, "modified 的 .gitignore 必须提交");
        assert_eq!(r2.paths, [".gitignore".to_string()], "{:?}", r2.paths);

        // 无改动时幂等
        let r3 = commit_bootstrap_at(&project).unwrap();
        assert!(!r3.committed && r3.paths.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bootstrap_commit_unborn_repo_and_non_repo() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
            return;
        }
        let dir = temp_dir("bootstrap-unborn");
        // 非仓库报错（前端开步流程已先走 ensure_git_repo，此处为防御）
        let plain = dir.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert!(commit_bootstrap_at(&plain).is_err(), "非仓库必须报错");

        // 空仓库（unborn HEAD）：bootstrap 直接落第一个内容提交，无需先跑空初始提交
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        ensure_git_at(&project).unwrap();
        assert!(!git_has_head(&project), "前置：仓库应为 unborn");
        write_config_at(&project, &sample_config()).unwrap();
        let r = commit_bootstrap_at(&project).unwrap();
        assert!(r.committed);
        // HEAD 已存在：create_workspace 内的 ensure_initial_commit 见到 HEAD 直接 no-op
        assert!(git_has_head(&project), "bootstrap 后 HEAD 必须存在");
        let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(tree.contains(".gitignore") && tree.contains(".ccode/project.toml"), "{tree}");

        // 空仓库且两个路径都不存在：committed=false，仓库保持 unborn，
        // 由 create_workspace 的 ensure_initial_commit 兜底空提交
        let bare = dir.join("bare");
        fs::create_dir_all(&bare).unwrap();
        git_ok(&bare, &["init"]);
        let r = commit_bootstrap_at(&bare).unwrap();
        assert!(!r.committed && r.paths.is_empty(), "无内容可提交时必须幂等: {r:?}");
        assert!(!git_has_head(&bare), "无内容时不得凭空制造提交");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_owner_rules() {
        let outside_res = PathBuf::from("/shared/paper.pdf");
        let projects = vec![
            (PathBuf::from("/proj/a"), vec![outside_res.clone()]),
            (PathBuf::from("/proj/b"), Vec::new()),
            (PathBuf::from("/proj/a/inner"), Vec::new()),
        ];
        // 登记资源精确命中（资源在项目根外也认）
        assert_eq!(resolve_owner(&outside_res, &projects), Some(0));
        // 项目根前缀命中
        assert_eq!(
            resolve_owner(Path::new("/proj/b/docs/x.pdf"), &projects),
            Some(1)
        );
        // 嵌套项目归内层根（最长前缀）
        assert_eq!(
            resolve_owner(Path::new("/proj/a/inner/x.pdf"), &projects),
            Some(2)
        );
        // 前缀混淆（/proj/bb 不是 /proj/b 内）与完全根外都不命中
        assert_eq!(resolve_owner(Path::new("/proj/bb/x.pdf"), &projects), None);
        assert_eq!(resolve_owner(Path::new("/etc/x.pdf"), &projects), None);
    }

    #[test]
    fn append_inbox_creates_with_header_then_appends() {
        let dir = temp_dir("inbox");
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();
        append_inbox_at(&wt, "## a.pdf · 第 3 页 · 2026-08-05\n\n选段一\n").unwrap();
        let target = wt.join("notes/inbox.md");
        let text = fs::read_to_string(&target).unwrap();
        assert!(text.starts_with("# 文献摘录收件箱"), "首次写入要有文件头: {text}");
        assert!(text.contains("选段一"));
        // 第二次：追加不覆盖，文件头不重复
        append_inbox_at(&wt, "## b.pdf · 第 1 页 · 2026-08-05\n\n选段二\n").unwrap();
        let text = fs::read_to_string(&target).unwrap();
        assert!(text.contains("选段一") && text.ends_with("选段二\n"), "追加语义: {text}");
        assert_eq!(text.matches("文献摘录收件箱").count(), 1, "文件头只出现一次: {text}");
        // 目录不存在要报错而不是静默
        assert!(append_inbox_at(&dir.join("missing"), "x").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_inbox_rejects_oversize() {
        let dir = temp_dir("inbox-cap");
        fs::create_dir_all(&dir).unwrap();
        let big = "x".repeat(64 * 1024 + 1);
        let err = append_inbox_at(&dir, &big).unwrap_err();
        assert!(err.contains("64 KB"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
    fn append_inbox_rejects_symlink_escape() {
        let dir = temp_dir("inbox-sym");
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("inbox.md"), "外部内容").unwrap();
        let wt = dir.join("wt");
        fs::create_dir_all(wt.join("notes")).unwrap();
        std::os::unix::fs::symlink(outside.join("inbox.md"), wt.join("notes/inbox.md")).unwrap();
        let err = append_inbox_at(&wt, "追加").unwrap_err();
        assert!(err.contains("拒绝写入"), "{err}");
        // 外部文件未被改动
        assert_eq!(
            fs::read_to_string(outside.join("inbox.md")).unwrap(),
            "外部内容"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 流水线模板库 =====

    fn templates_file(tag: &str) -> (PathBuf, PathBuf) {
        let dir = temp_dir(tag);
        fs::create_dir_all(&dir).unwrap();
        (dir.join("pipeline-templates.json"), dir)
    }

    fn sample_steps() -> Vec<ProjectStepDto> {
        vec![
            StepDto {
                name: "读文献".into(),
                workspace_name: "lit-notes".into(),
                brief: "整理笔记".into(),
                expected_artifacts: vec!["notes/".into()],
                skills: vec!["paper-notes".into()],
                resources: Vec::new(),
                run: vec![StepRunDto {
                    name: "dev".into(),
                    command: "echo hi".into(),
                    is_default: true,
                }],
            },
            StepDto {
                name: "写论文".into(),
                ..StepDto::default()
            },
        ]
    }

    #[test]
    fn pipeline_template_crud_round_trip() {
        let (path, dir) = templates_file("tpl-crud");
        // 文件缺失时读为空表
        assert!(read_templates_at(&path).unwrap().is_empty());

        let saved = save_template_at(&path, "  科研流水线  ", "三步走", sample_steps()).unwrap();
        assert_eq!(saved.name, "科研流水线", "name 要去空白");
        assert!(!saved.id.is_empty() && !saved.created_at.is_empty());
        assert_eq!(saved.steps.len(), 2);

        let list = read_templates_at(&path).unwrap();
        assert_eq!(list, vec![saved.clone()], "保存后列表往返一致");
        // camelCase 字段名
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"createdAt\""), "{on_disk}");
        assert!(on_disk.contains("\"workspaceName\""), "{on_disk}");

        // 删除后清空；删除不存在的 id 是无操作而非报错
        delete_template_at(&path, &saved.id).unwrap();
        assert!(read_templates_at(&path).unwrap().is_empty());
        delete_template_at(&path, "不存在").unwrap();
        assert!(path.exists(), "删除不应移除文件本身");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_template_same_name_overwrites() {
        let (path, dir) = templates_file("tpl-overwrite");
        let first = save_template_at(&path, "模板A", "旧描述", sample_steps()).unwrap();
        save_template_at(&path, "模板B", "", sample_steps()).unwrap();

        let mut new_steps = sample_steps();
        new_steps.pop();
        let second = save_template_at(&path, "模板A", "新描述", new_steps.clone()).unwrap();
        assert_eq!(second.id, first.id, "同名覆盖保留原 id");
        assert_eq!(second.created_at, first.created_at, "同名覆盖保留 created_at");
        assert_eq!(second.description, "新描述");
        assert_eq!(second.steps, new_steps);

        let list = read_templates_at(&path).unwrap();
        assert_eq!(list.len(), 2, "覆盖不新增条目");
        assert_eq!(list[0].steps.len(), 1, "覆盖后 steps 已更新");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_template_corrupt_file_backed_up_and_empty() {
        let (path, dir) = templates_file("tpl-corrupt");
        fs::write(&path, "{ 不是合法 json").unwrap();

        let list = read_templates_at(&path).unwrap();
        assert!(list.is_empty(), "损坏按空表继续");
        assert!(!path.exists(), "原损坏文件应已改名备份");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("pipeline-templates.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "应生成唯一 corrupt 备份: {backups:?}");
        // 损坏内容完整保留在备份里，可被人工恢复
        assert_eq!(fs::read_to_string(dir.join(&backups[0])).unwrap(), "{ 不是合法 json");
        // 备份后正常保存不受影响
        save_template_at(&path, "模板A", "", sample_steps()).unwrap();
        assert_eq!(read_templates_at(&path).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_template_rejects_empty_name_and_steps() {
        let (path, dir) = templates_file("tpl-reject");
        let err = save_template_at(&path, "   ", "d", sample_steps()).unwrap_err();
        assert!(err.contains("名称不能为空"), "{err}");
        let err = save_template_at(&path, "模板A", "d", Vec::new()).unwrap_err();
        assert!(err.contains("至少需要一个步骤"), "{err}");
        // 校验失败不落盘
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
