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
    // 词法包含检查（不解析符号链接）：node_modules 这类链接到根外的文件在树上可见，
    // 应允许预览；真正的越权由下方 canonicalize 读取兜底（"../" 无法通过词法前缀）
    let root_exp = norm_sep(&expand_tilde(root));
    let path_exp = norm_sep(&expand_tilde(path));
    let root_norm = root_exp.trim_end_matches('/');
    if !(path_exp == root_norm || path_exp.starts_with(&format!("{root_norm}/"))) {
        return Err("路径超出项目根目录，拒绝预览".into());
    }
    let path_c = PathBuf::from(&path_exp)
        .canonicalize()
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
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

/// 保存预览编辑：与 read_file_preview 相同的根目录约束；超 256KB 暂拒；原子写入
fn save_file_preview_sync(path: &str, root: &str, text: &str) -> Result<(), String> {
    if text.len() > PREVIEW_CAP {
        return Err("文件超过 256 KB，暂不支持在预览里保存".into());
    }
    let root_c = PathBuf::from(expand_tilde(root))
        .canonicalize()
        .map_err(|e| format!("项目根目录无效: {e}"))?;
    let path_c = PathBuf::from(expand_tilde(path))
        .canonicalize()
        .map_err(|e| format!("文件不存在或不可读: {e}"))?;
    if !path_c.starts_with(&root_c) {
        return Err("路径超出项目根目录，拒绝写入".into());
    }
    crate::profiles::atomic_write(&path_c, text)
}

#[tauri::command]
pub async fn save_file_preview(path: String, root: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_file_preview_sync(&path, &root, &text))
        .await
        .map_err(|e| format!("保存文件失败: {e}"))?
}

// ===== 目录监听（P4）：notify 递归监听 + 500ms 防抖，事件 fs-changed-<id> =====

struct WatchEntry {
    _watcher: notify::RecommendedWatcher,
}

static WATCHERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, WatchEntry>>> =
    std::sync::OnceLock::new();

fn watchers() -> &'static std::sync::Mutex<std::collections::HashMap<String, WatchEntry>> {
    WATCHERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 监听噪声过滤：隐藏目录段（/.foo/）、.git、node_modules 下的事件不触发刷新。
/// agent 会话文件和应用 db 都写在隐藏目录，home 根监听时不过滤会形成刷新风暴
fn fs_noise_skip(path: &std::path::Path) -> bool {
    let s = norm_sep(&path.to_string_lossy());
    if s.contains("/.git/") || s.contains("/node_modules/") || s.contains("/target/") || s.contains("/dist/") {
        return true;
    }
    let mut idx = 0;
    while let Some(pos) = s[idx..].find("/.") {
        let abs = idx + pos;
        // "/.foo/" 形式 = 隐藏目录段；路径末尾的隐藏文件（如 .env）放行
        if s[abs + 2..].contains('/') {
            return true;
        }
        idx = abs + 2;
        if idx >= s.len() {
            break;
        }
    }
    false
}

#[tauri::command]
pub fn watch_dir(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use tauri::Emitter;
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| !fs_noise_skip(p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("创建文件监听失败: {e}"))?;
    notify::Watcher::watch(
        &mut watcher,
        std::path::Path::new(&expand_tilde(&path)),
        notify::RecursiveMode::Recursive,
    )
    .map_err(|e| format!("监听目录失败: {e}"))?;

    // 防抖线程：事件涌入时等静默 500ms 再发一次
    let event = format!("fs-changed-{id}");
    std::thread::spawn(move || loop {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(_) => {
                while rx
                    .recv_timeout(std::time::Duration::from_millis(500))
                    .is_ok()
                {
                    // 持续有事件，继续等静默
                }
                let _ = app.emit(&event, ());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break, // watcher 已 drop
        }
    });

    watchers().lock().unwrap().insert(id.clone(), WatchEntry { _watcher: watcher });
    Ok(id)
}

#[tauri::command]
pub fn unwatch_dir(id: String) -> Result<(), String> {
    watchers().lock().unwrap().remove(&id);
    Ok(())
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

    #[test]
    fn save_within_root_writes_content() {
        let dir = tmpdir("save");
        let f = dir.join("edit.txt");
        fs::write(&f, "old").unwrap();
        save_file_preview_sync(f.to_str().unwrap(), dir.to_str().unwrap(), "new content\n").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "new content\n");
        // 超限拒绝且不改动文件
        let big = "x".repeat(PREVIEW_CAP + 1);
        assert!(save_file_preview_sync(f.to_str().unwrap(), dir.to_str().unwrap(), &big).is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "new content\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_rejects_path_escape() {
        let root = tmpdir("save-root");
        let outside = tmpdir("save-outside");
        let secret = outside.join("s.txt");
        fs::write(&secret, "nope").unwrap();
        let err =
            save_file_preview_sync(secret.to_str().unwrap(), root.to_str().unwrap(), "x").unwrap_err();
        assert!(err.contains("超出项目根目录"), "{err}");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "nope");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}

#[cfg(test)]
mod fix_tests {
    use super::*;

    #[test]
    #[cfg(unix)] // 测的是 unix symlink 语义；Windows 上无法无权限创建符号链接
    fn preview_allows_symlink_escaping_root_lexically() {
        let dir = std::env::temp_dir().join(format!("ccode-fx-{}", uuid::Uuid::new_v4()));
        let outside = dir.join("outside");
        let root = dir.join("root");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(outside.join("real.txt"), "hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("real.txt"), root.join("link.txt")).unwrap();
        // 符号链接解析到根外：词法检查应放行
        let r = read_file_preview_sync(root.join("link.txt").to_str().unwrap(), root.to_str().unwrap());
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(r.unwrap().text, "hello");
        // 根外路径仍拒绝
        let r2 = read_file_preview_sync(outside.join("real.txt").to_str().unwrap(), root.to_str().unwrap());
        assert!(r2.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn noise_skip_rules() {
        use std::path::Path;
        assert!(fs_noise_skip(Path::new("/home/u/.claude/projects/x.jsonl")));
        assert!(fs_noise_skip(Path::new("/home/u/proj/.git/index")));
        assert!(fs_noise_skip(Path::new("/home/u/proj/node_modules/x/index.js")));
        assert!(!fs_noise_skip(Path::new("/home/u/proj/src/main.rs")));
        assert!(fs_noise_skip(Path::new("/home/u/proj/target/debug/build/x")));
        assert!(fs_noise_skip(Path::new("/home/u/proj/dist/assets/index.js")));
        assert!(!fs_noise_skip(Path::new("/home/u/proj/.env")));
    }
}

// ===== 项目内文件搜索（P4 补充）：限定根目录内，跳过隐藏/噪声目录 =====

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// 相对搜索根的路径（前端展示用，避免前端按根长截断出错）
    pub rel: String,
}

fn search_walk(
    root: &std::path::Path,
    dir: &std::path::Path,
    query: &str,
    depth: usize,
    visited: &mut usize,
    out: &mut Vec<SearchResultDto>,
) {
    const MAX_DEPTH: usize = 10;
    const MAX_VISITED: usize = 50000;
    const MAX_RESULTS: usize = 50;
    if depth > MAX_DEPTH || *visited >= MAX_VISITED || out.len() >= MAX_RESULTS {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= MAX_RESULTS || *visited >= MAX_VISITED {
            return;
        }
        *visited += 1;
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        let is_dir = path.is_dir();
        if is_dir
            && (name.starts_with('.')
                || matches!(name.as_str(), "node_modules" | "target" | "dist" | "Library"))
        {
            continue;
        }
        if name.to_lowercase().contains(query) {
            out.push(SearchResultDto {
                rel: path
                    .strip_prefix(root)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| name.clone()),
                path: path.to_string_lossy().into_owned(),
                name,
                is_dir,
            });
        }
        if is_dir {
            search_walk(root, &path, query, depth + 1, visited, out);
        }
    }
}

#[tauri::command]
pub async fn search_files(root: String, query: String) -> Result<Vec<SearchResultDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut visited = 0;
        let root_path = std::path::PathBuf::from(expand_tilde(&root));
        search_walk(&root_path, &root_path, &q, 0, &mut visited, &mut out);
        Ok(out)
    })
    .await
    .map_err(|e| format!("搜索失败: {e}"))?
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn search_finds_nested_and_skips_noise() {
        let dir = std::env::temp_dir().join(format!("ccode-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("src/deep")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("src/deep/apple.rs"), "").unwrap();
        fs::write(dir.join("node_modules/pkg/apple.js"), "").unwrap();
        fs::write(dir.join("banana.md"), "").unwrap();
        let mut out = Vec::new();
        let mut visited = 0;
        search_walk(&dir, &dir, "apple", 0, &mut visited, &mut out);
        assert_eq!(out.len(), 1);
        assert!(std::path::Path::new(&out[0].path).ends_with("src/deep/apple.rs"));
        assert!(std::path::Path::new(&out[0].rel).ends_with("src/deep/apple.rs"));
        // 预览：root 传未展开的 "~" 也应通过词法检查
        let home_file = dirs::home_dir().unwrap().join("ccode-test-tilde.txt");
        fs::write(&home_file, "x").unwrap();
        let r = read_file_preview_sync(home_file.to_str().unwrap(), "~");
        assert!(r.is_ok(), "{r:?}");
        let _ = fs::remove_file(&home_file);
        let _ = fs::remove_dir_all(&dir);
    }
}

// ===== 文件树文件操作（P4 补充）：新建文件夹 / 删除，词法根目录约束 =====

/// Windows 反斜杠归一为正斜杠，再做前缀比较（跨平台路径语义一致）
fn norm_sep(s: &str) -> String {
    s.replace('\\', "/")
}

fn lexical_in_root(path: &str, root: &str) -> bool {
    let root_norm = norm_sep(&expand_tilde(root)).trim_end_matches('/').to_string();
    let path_exp = norm_sep(&expand_tilde(path));
    path_exp == root_norm || path_exp.starts_with(&format!("{root_norm}/"))
}

fn create_dir_sync(root: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return Err("文件夹名称无效（不能含 / 或 .）".into());
    }
    let dir = PathBuf::from(expand_tilde(root)).join(name);
    if dir.exists() {
        return Err("已存在同名文件或目录".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建文件夹失败: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 重要系统/用户路径保护：无论根目录范围如何都拒绝删除
fn is_protected_path(path: &str) -> bool {
    // 词法形式与 canonicalize 后形式双重校验：堵住「项目内符号链接指向受保护目录」的绕过
    let lex = expand_tilde(path);
    let canon = std::path::PathBuf::from(&lex)
        .canonicalize()
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| lex.clone());
    is_protected_str(&lex) || (canon != lex && is_protected_str(&canon))
}

fn is_protected_str(p: &str) -> bool {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    let exact: Vec<String> = [
        home.clone(),
        format!("{home}/Documents"),
        format!("{home}/Desktop"),
        format!("{home}/Downloads"),
        format!("{home}/.zshrc"),
        format!("{home}/.bashrc"),
        format!("{home}/.zprofile"),
        format!("{home}/.bash_profile"),
        format!("{home}/.gitconfig"),
    ]
    .into_iter()
    .map(|s| s.trim_end_matches('/').to_string())
    .collect();
    let pn = p.trim_end_matches('/');
    // 精确匹配保护 home 与 shell 配置；关键目录（Library/ssh/CLI 配置/Ccode 数据）连同子路径一并保护
    let dir_prefixes: Vec<String> = [
        format!("{home}/Library"),
        format!("{home}/.ssh"),
        format!("{home}/.claude"),
        format!("{home}/.codex"),
        format!("{home}/.gemini"),
        format!("{home}/.qwen"),
        format!("{home}/.kimi"),
        format!("{home}/.kimi-code"),
        format!("{home}/Library/Application Support/ccode"),
    ]
    .into_iter()
    .map(|s| s.trim_end_matches('/').to_string())
    .collect();
    if exact.iter().any(|e| pn == e)
        || dir_prefixes
            .iter()
            .any(|e| pn == e || pn.starts_with(&format!("{e}/")))
    {
        return true;
    }
    const PREFIXES: [&str; 8] = [
        "/System", "/usr", "/bin", "/sbin", "/etc", "/Library", "/Applications", "/opt",
    ];
    let home_lib = format!("{home}/Library");
    // macOS 的 /etc、/tmp 等是 /private 下的符号链接，canonicalize 后会带 /private 前缀，剥掉再比
    let pn_depriv = pn
        .strip_prefix("/private/")
        .map(|r| format!("/{r}"))
        .unwrap_or_else(|| pn.to_string());
    if PREFIXES
        .iter()
        .any(|pre| pn.starts_with(pre) || pn_depriv.starts_with(pre))
        || pn.starts_with(&home_lib)
    {
        return true;
    }
    // 任何 .git 内部路径
    pn.contains("/.git")
}

fn delete_path_sync(path: &str, root: &str) -> Result<(), String> {
    if is_protected_path(path) {
        return Err("系统/重要目录受保护，拒绝删除".into());
    }
    if !lexical_in_root(path, root) {
        return Err("路径超出项目根目录，拒绝删除".into());
    }
    let root_norm = expand_tilde(root).trim_end_matches('/').to_string();
    let p = expand_tilde(path);
    if p == root_norm {
        return Err("不能删除项目根目录本身".into());
    }
    let pb = PathBuf::from(&p);
    if pb.is_dir() {
        fs::remove_dir_all(&pb).map_err(|e| format!("删除目录失败: {e}"))
    } else {
        fs::remove_file(&pb).map_err(|e| format!("删除文件失败: {e}"))
    }
}

#[tauri::command]
pub async fn fs_create_dir(root: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create_dir_sync(&root, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_delete_path(path: String, root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_path_sync(&path, &root))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod fsops_tests {
    use super::*;

    #[test]
    fn create_and_delete_ops() {
        let dir = std::env::temp_dir().join(format!("ccode-fsops-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let created = create_dir_sync(&root, "newfolder").unwrap();
        assert!(std::path::Path::new(&created).is_dir());
        assert!(create_dir_sync(&root, "a/b").is_err());
        assert!(create_dir_sync(&root, "newfolder").is_err()); // 重名
        fs::write(dir.join("f.txt"), "x").unwrap();
        delete_path_sync(&dir.join("f.txt").to_string_lossy(), &root).unwrap();
        delete_path_sync(&created, &root).unwrap();
        assert!(!std::path::Path::new(&created).exists());
        assert!(delete_path_sync("/tmp", &root).is_err());
        assert!(delete_path_sync(&root, &root).is_err());
        // 保护路径：root 是 home 时系统/关键目录一律拒绝
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        assert!(delete_path_sync(&format!("{home}/Library"), &home).is_err());
        assert!(delete_path_sync(&format!("{home}/.ssh"), &home).is_err());
        assert!(delete_path_sync(&format!("{home}/.claude/projects"), &home).is_err());
        assert!(delete_path_sync("/System", &home).is_err());
        assert!(delete_path_sync(&format!("{home}/proj/.git/index"), &home).is_err());
        // 符号链接绕过：项目内链接指向 ~/.ssh，按词法路径删除时也应被拦截
        #[cfg(unix)]
        {
            let proj = dir.join("projlink");
            fs::create_dir_all(&proj).unwrap();
            let link = proj.join("x");
            std::os::unix::fs::symlink("/etc", &link).unwrap();
            assert!(delete_path_sync(&link.to_string_lossy(), &proj.to_string_lossy().into_owned()).is_err());
            let _ = fs::remove_file(&link);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
