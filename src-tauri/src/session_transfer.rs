//! 会话导出 / 导入（`.ccode-sessions.zip`）。
//!
//! 导出把八家 CLI（不含 opencode）的会话文件原样打进 zip；导入在落盘时才改写 cwd，
//! 并按 B 机目录重建各家落位。写 CLI 会话目录是只读原则的第五个用户显式例外，
//! 防护口径见 `docs/conventions/safety.md`。

use crate::paths::{path_within, same_path};
use crate::profiles::{self, ProfileStore};
use crate::provider_id::is_ccode_provider;
use crate::sessions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

const MANIFEST_VERSION: u32 = 1;
const ZIP_MAX_ENTRIES: usize = 20_000;
const ZIP_MAX_UNCOMPRESSED: u64 = 512 * 1024 * 1024;
const ZIP_MAX_FILE: u64 = 200 * 1024 * 1024;
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

const TRANSFER_AGENTS: &[&str] = &[
    "claude-code",
    "codex",
    "gemini",
    "qwen",
    "kimi",
    "codebuddy",
    "cursor",
    "grok",
];

// ===== DTO =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportKeyDto {
    pub agent: String,
    pub session_id: String,
    pub file_path: String,
    pub title: Option<String>,
    pub project_path: String,
    pub provider: Option<String>,
    pub pinned: bool,
    pub custom_title: Option<String>,
    pub tags: Vec<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    size_bytes: u64,
    mtime_ms: u64,
    md5: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCcode {
    pinned: bool,
    custom_title: Option<String>,
    tags: Vec<String>,
    summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    agent: String,
    session_id: String,
    title: Option<String>,
    /// 列表侧项目路径（工作区会话已归并成主仓）。向导推荐目录用它。
    project_path: String,
    /// 会话文件里的真实 cwd（工作树路径可能与 project_path 不同）。改写用它。
    #[serde(default)]
    cwd: Option<String>,
    provider: Option<String>,
    files: Vec<ManifestFile>,
    ccode: ManifestCcode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    exported_at: String,
    app_version: String,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBindingDto {
    pub id: String,
    pub name: String,
    pub base_url: Option<String>,
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewEntryDto {
    pub index: usize,
    pub agent: String,
    pub session_id: String,
    pub title: Option<String>,
    pub project_path: String,
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub status: String,
    pub reason: Option<String>,
    pub needs_client_register: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewDto {
    pub exported_at: String,
    pub app_version: String,
    pub entries: Vec<ImportPreviewEntryDto>,
    pub codex_bindings: Vec<CodexBindingDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDecisionDto {
    pub index: usize,
    #[serde(default)]
    pub skip: bool,
    pub target_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItemReportDto {
    pub index: usize,
    pub agent: String,
    pub session_id: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReportDto {
    pub imported: u32,
    pub skipped: u32,
    pub failed: u32,
    pub items: Vec<ImportItemReportDto>,
    pub register_note: Option<String>,
}

// ===== 路径编码（对照实机会话目录 / matrix） =====

/// Claude / Qwen：路径中所有非字母数字换成 `-`（含开头的 `/` → 前导 `-`）。
fn path_slug_non_alnum(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Cursor / CodeBuddy：去掉前导 `/`，分隔符换成 `-`（本机 cursor 目录实证）。
/// Windows 盘符 `C:` 的冒号是非法文件名，必须再洗一遍，否则 Mac→Win 落盘会 os error 123。
fn path_slug_separators(path: &str) -> String {
    let n = path.replace('\\', "/");
    let n = n.trim_start_matches('/');
    fs_safe_component(&n.replace('/', "-"))
}

/// Windows 文件名非法字符（与 paths::FS_ILLEGAL 同集）换成 `-`，三平台同一套，
/// 避免 Mac 导出的会话在 Windows 上建不出目录。
fn fs_safe_component(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect()
}

fn percent_encode_path(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Grok：URL 编码 cwd；超过 255 字节改 slug+hash 并需要写 `.cwd`。
/// 短路径与本机 `~/.grok/sessions/%2FUsers%2F...` 一致；长路径 hash 算法 grok 未开源，
/// 用 md5 前 8 位并**必须**写 `.cwd`（扫描器以 summary.json `info.cwd` 为准）。
fn grok_encode_cwd(cwd: &str) -> (String, bool) {
    let enc = percent_encode_path(cwd);
    if enc.len() <= 255 {
        return (enc, false);
    }
    let stem = Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cwd".into());
    let stem: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    let stem = if stem.is_empty() {
        "cwd".to_string()
    } else {
        stem
    };
    let hash = format!("{:x}", md5::compute(cwd.as_bytes()));
    (format!("{}-{}", stem, &hash[..8]), true)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Kimi 新版 `wd_<basename>_<sha256(workDir)[:12]>`（本机 session_index 实证）。
fn kimi_wd_bucket(work_dir: &str) -> String {
    let base = Path::new(work_dir)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "wd".into());
    let hash = sha256_hex(work_dir.as_bytes());
    format!("wd_{}_{}", base, &hash[..12])
}

fn kimi_legacy_bucket(work_dir: &str) -> String {
    format!("{:x}", md5::compute(work_dir.as_bytes()))
}

fn gemini_import_slug(target: &str) -> String {
    let hash = format!("{:x}", md5::compute(target.as_bytes()));
    format!("ccode-{}", &hash[..12])
}

fn md5_hex(bytes: &[u8]) -> String {
    format!("{:x}", md5::compute(bytes))
}

fn mtime_ms(path: &Path) -> u64 {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn restore_mtime(path: &Path, ms: u64) {
    if ms == 0 {
        return;
    }
    let ft = UNIX_EPOCH + Duration::from_millis(ms);
    if let Ok(f) = fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(ft);
    }
}

fn maybe_decompress(bytes: &[u8]) -> Vec<u8> {
    if !bytes.starts_with(&ZSTD_MAGIC) {
        return bytes.to_vec();
    }
    zstd::decode_all(bytes).unwrap_or_default()
}

fn is_transfer_agent(agent: &str) -> bool {
    TRANSFER_AGENTS.contains(&agent)
}

fn rewrite_keys_for(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude-code" | "qwen" | "codebuddy" | "codex" => &["cwd"],
        "gemini" => &["directories"],
        // cursor 字段名未拿到实机 jsonl 样本；与扫描器候选名单同源，存在哪个改哪个
        "cursor" => &["cwd", "project_path", "workingDirectory"],
        // kimi 新版 wire 实证：event.args.cwd / event.display.cwd；state.json 实证：workDir
        "kimi" => &["cwd", "workDir"],
        "grok" => &["cwd"],
        _ => &["cwd"],
    }
}

// ===== JSON 行级改写 =====

fn rewrite_value(v: &mut Value, old: &str, new: &str, keys: &[&str]) {
    match v {
        Value::Object(map) => {
            let names: Vec<String> = map.keys().cloned().collect();
            for name in names {
                if let Some(val) = map.get_mut(&name) {
                    if keys.iter().any(|k| *k == name) {
                        match val {
                            Value::String(s) if same_path(s, old) => {
                                *s = new.to_string();
                            }
                            Value::Array(arr) => {
                                for item in arr {
                                    if let Value::String(s) = item {
                                        if same_path(s, old) {
                                            *s = new.to_string();
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    rewrite_value(val, old, new, keys);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                rewrite_value(item, old, new, keys);
            }
        }
        _ => {}
    }
}

fn rewrite_prefix(v: &mut Value, old_prefix: &str, new_prefix: &str, keys: &[&str]) {
    match v {
        Value::Object(map) => {
            let names: Vec<String> = map.keys().cloned().collect();
            for name in names {
                if let Some(val) = map.get_mut(&name) {
                    if keys.iter().any(|k| *k == name) {
                        if let Value::String(s) = val {
                            if s == old_prefix
                                || s.starts_with(&(old_prefix.to_string() + "/"))
                                || s.starts_with(&(old_prefix.to_string() + "\\"))
                            {
                                *s = format!("{}{}", new_prefix, &s[old_prefix.len()..]);
                            }
                        }
                    }
                    rewrite_prefix(val, old_prefix, new_prefix, keys);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                rewrite_prefix(item, old_prefix, new_prefix, keys);
            }
        }
        _ => {}
    }
}

fn rewrite_json_bytes(
    bytes: &[u8],
    old: &str,
    new: &str,
    keys: &[&str],
    prefix: Option<(&str, &str, &[&str])>,
) -> Vec<u8> {
    if old == new && prefix.is_none() {
        return bytes.to_vec();
    }
    let raw = maybe_decompress(bytes);
    let Ok(text) = std::str::from_utf8(&raw) else {
        return bytes.to_vec();
    };
    let had_trailing = text.ends_with('\n');
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(mut v) => {
                rewrite_value(&mut v, old, new, keys);
                if let Some((old_p, new_p, pkeys)) = prefix {
                    rewrite_prefix(&mut v, old_p, new_p, pkeys);
                }
                out.push_str(&v.to_string());
            }
            Err(_) => out.push_str(line),
        }
    }
    if had_trailing && !out.ends_with('\n') {
        out.push('\n');
    }
    out.into_bytes()
}

fn rewrite_json_object(
    bytes: &[u8],
    old: &str,
    new: &str,
    keys: &[&str],
    prefix: Option<(&str, &str, &[&str])>,
) -> Vec<u8> {
    if old == new && prefix.is_none() {
        return bytes.to_vec();
    }
    let Ok(mut v) = serde_json::from_slice::<Value>(bytes) else {
        return bytes.to_vec();
    };
    rewrite_value(&mut v, old, new, keys);
    if let Some((old_p, new_p, pkeys)) = prefix {
        rewrite_prefix(&mut v, old_p, new_p, pkeys);
    }
    serde_json::to_vec(&v).unwrap_or_else(|_| bytes.to_vec())
}

// ===== zip 安全 =====

fn zip_name_ok(name: &str) -> Result<String, String> {
    let n = name.replace('\\', "/");
    if n.is_empty() {
        return Err("ZIP 条目名为空".into());
    }
    if n.starts_with('/') || n.starts_with('\\') {
        return Err("ZIP 条目不能是绝对路径".into());
    }
    if n.split('/').any(|s| s == ".." || s == ".") {
        return Err("ZIP 条目含路径穿越，拒绝解压".into());
    }
    if n.contains('\0') {
        return Err("ZIP 条目名非法".into());
    }
    Ok(n)
}

fn read_zip_map(zip_path: &Path) -> Result<(Manifest, HashMap<String, Vec<u8>>), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {e}"))?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(format!(
            "ZIP 条目过多（{} > {ZIP_MAX_ENTRIES}），拒绝解压",
            archive.len()
        ));
    }
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    let mut uncompressed: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("ZIP 含路径穿越条目，拒绝解压".into());
        };
        let name = zip_name_ok(&enclosed.to_string_lossy())?;
        if name != "manifest.json" && !name.starts_with("sessions/") {
            return Err(format!("ZIP 含非会话条目 {name}，拒绝解压"));
        }
        let size = entry.size();
        if size > ZIP_MAX_FILE {
            return Err(format!("ZIP 内单文件超过 {}MB", ZIP_MAX_FILE / 1024 / 1024));
        }
        uncompressed = uncompressed.saturating_add(size);
        if uncompressed > ZIP_MAX_UNCOMPRESSED {
            return Err(format!(
                "ZIP 解压后体积超过 {}MB，拒绝解压",
                ZIP_MAX_UNCOMPRESSED / 1024 / 1024
            ));
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取 ZIP 内容失败: {e}"))?;
        if buf.len() as u64 > ZIP_MAX_FILE {
            return Err("ZIP 单文件实际体积超限".into());
        }
        files.insert(name, buf);
    }
    let manifest_bytes = files
        .get("manifest.json")
        .ok_or("ZIP 缺少 manifest.json")?;
    let manifest: Manifest = serde_json::from_slice(manifest_bytes)
        .map_err(|e| format!("manifest.json 无法解析: {e}"))?;
    if manifest.version != MANIFEST_VERSION {
        return Err(format!(
            "不支持的会话包版本 {}（当前只接受 {MANIFEST_VERSION}）",
            manifest.version
        ));
    }
    Ok((manifest, files))
}

fn write_zip(dest: &Path, manifest: &Manifest, blobs: &[(String, Vec<u8>)]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
    }
    let file = fs::File::create(dest).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let man = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    writer
        .start_file("manifest.json", options)
        .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
    writer
        .write_all(&man)
        .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
    for (name, bytes) in blobs {
        writer
            .start_file(name, options)
            .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
    }
    writer.finish().map_err(|e| format!("完成 ZIP 失败: {e}"))?;
    Ok(())
}

// ===== 导出收集 =====

fn skip_pack_name(name: &str) -> bool {
    name.ends_with(".lock") || name.ends_with(".tmp")
}

fn collect_tree(root: &Path, rel_base: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if skip_pack_name(&name) {
            continue;
        }
        let rel = if rel_base.is_empty() {
            name.clone()
        } else {
            format!("{rel_base}/{name}")
        };
        if p.is_dir() {
            collect_tree(&p, &rel, out);
        } else if p.is_file() {
            out.push((rel.replace('\\', "/"), p));
        }
    }
}

fn kimi_session_dir(file_path: &Path) -> Option<PathBuf> {
    // 新版 …/<id>/agents/main/wire.jsonl；旧版 …/<id>/context.jsonl
    let name = file_path.file_name()?.to_string_lossy();
    if name == "wire.jsonl" {
        Some(file_path.parent()?.parent()?.parent()?.to_path_buf())
    } else {
        Some(file_path.parent()?.to_path_buf())
    }
}

fn grok_session_dir(file_path: &Path) -> Option<PathBuf> {
    file_path.parent().map(|p| p.to_path_buf())
}

fn pack_files_for(agent: &str, file_path: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    match agent {
        "kimi" => {
            let dir = kimi_session_dir(file_path).ok_or("无法确定 Kimi 会话目录")?;
            let mut files = Vec::new();
            collect_tree(&dir, "", &mut files);
            if files.is_empty() {
                return Err("Kimi 会话目录是空的".into());
            }
            Ok(files)
        }
        "grok" => {
            let dir = grok_session_dir(file_path).ok_or("无法确定 Grok 会话目录")?;
            let mut files = Vec::new();
            collect_tree(&dir, "", &mut files);
            if files.is_empty() {
                return Err("Grok 会话目录是空的".into());
            }
            Ok(files)
        }
        "codex" => {
            let name = file_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or("Codex 会话文件名无效")?;
            let rel = if let Some(date) = codex_date_from_path(file_path) {
                format!("{date}/{name}")
            } else {
                name
            };
            Ok(vec![(rel, file_path.to_path_buf())])
        }
        _ => {
            let name = file_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or("会话文件名无效")?;
            Ok(vec![(name, file_path.to_path_buf())])
        }
    }
}

fn codex_date_from_path(path: &Path) -> Option<String> {
    let s = path.to_string_lossy().replace('\\', "/");
    let parts: Vec<&str> = s.split('/').collect();
    for i in 0..parts.len().saturating_sub(3) {
        let y = parts[i];
        let m = parts[i + 1];
        let d = parts[i + 2];
        if y.len() == 4
            && y.chars().all(|c| c.is_ascii_digit())
            && m.len() == 2
            && m.chars().all(|c| c.is_ascii_digit())
            && d.len() == 2
            && d.chars().all(|c| c.is_ascii_digit())
        {
            return Some(format!("{y}/{m}/{d}"));
        }
    }
    None
}

fn export_one(spec: &ExportKeyDto) -> Result<(ManifestEntry, Vec<(String, Vec<u8>)>), String> {
    if spec.agent == "opencode" || !is_transfer_agent(&spec.agent) {
        return Err(format!("{} 不支持会话包导出（OpenCode 留 v2）", spec.agent));
    }
    let src = PathBuf::from(sessions::expand_tilde(&spec.file_path));
    if !src.exists() {
        return Err("会话源文件已不存在".into());
    }
    if src.is_file() && !sessions::session_file_in_whitelist(&src) {
        return Err("拒绝导出会话数据目录之外的文件".into());
    }
    let packed = pack_files_for(&spec.agent, &src)?;
    let mut files = Vec::new();
    let mut blobs = Vec::new();
    for (rel, path) in packed {
        let bytes = fs::read(&path).map_err(|e| format!("读取会话文件失败: {e}"))?;
        if bytes.len() as u64 > ZIP_MAX_FILE {
            return Err("会话文件过大，无法导出".into());
        }
        let zip_path = format!("sessions/{rel}");
        files.push(ManifestFile {
            path: zip_path.clone(),
            size_bytes: bytes.len() as u64,
            mtime_ms: mtime_ms(&path),
            md5: md5_hex(&bytes),
        });
        blobs.push((zip_path, bytes));
    }
    let cwd = extract_cwd_from_pairs(&spec.agent, &blobs);
    Ok((
        ManifestEntry {
            agent: spec.agent.clone(),
            session_id: spec.session_id.clone(),
            title: spec.title.clone(),
            project_path: spec.project_path.clone(),
            cwd,
            provider: spec.provider.clone(),
            files,
            ccode: ManifestCcode {
                pinned: spec.pinned,
                custom_title: spec.custom_title.clone(),
                tags: spec.tags.clone(),
                summary: spec.summary.clone(),
            },
        },
        blobs,
    ))
}

pub fn export_impl(specs: &[ExportKeyDto], dest: &Path) -> Result<String, String> {
    if specs.is_empty() {
        return Err("没有要导出的对话".into());
    }
    let mut entries = Vec::new();
    let mut blobs = Vec::new();
    for (i, spec) in specs.iter().enumerate() {
        let (mut entry, files) = export_one(spec)?;
        let prefix = format!("sessions/{i}/");
        for f in &mut entry.files {
            let rel = f.path.strip_prefix("sessions/").unwrap_or(&f.path);
            f.path = format!("{prefix}{rel}");
        }
        for (name, bytes) in files {
            let rel = name.strip_prefix("sessions/").unwrap_or(&name);
            blobs.push((format!("{prefix}{rel}"), bytes));
        }
        entries.push(entry);
    }
    let manifest = Manifest {
        version: MANIFEST_VERSION,
        exported_at: sessions::now_iso(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        entries,
    };
    write_zip(dest, &manifest, &blobs)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn export_sessions(entries: Vec<ExportKeyDto>, dest_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_impl(&entries, Path::new(&dest_path)))
        .await
        .map_err(|e| e.to_string())?
}

// ===== 既有会话索引 / 校验 =====

fn cwd_from_value(agent: &str, v: &Value) -> Option<String> {
    let take = |s: &str| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    };
    match agent {
        "codex" => {
            if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                v.get("payload")
                    .and_then(|p| p.get("cwd"))
                    .and_then(|x| x.as_str())
                    .and_then(take)
            } else {
                None
            }
        }
        "gemini" => v
            .get("directories")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.as_str())
            .and_then(take),
        "cursor" => ["cwd", "project_path", "workingDirectory"]
            .iter()
            .find_map(|k| v.get(*k).and_then(|x| x.as_str()).and_then(take)),
        "kimi" => v
            .get("workDir")
            .or_else(|| v.get("cwd"))
            .and_then(|x| x.as_str())
            .and_then(take)
            .or_else(|| {
                v.pointer("/event/args/cwd")
                    .and_then(|x| x.as_str())
                    .and_then(take)
            }),
        "grok" => v
            .pointer("/info/cwd")
            .and_then(|x| x.as_str())
            .and_then(take),
        _ => v.get("cwd").and_then(|x| x.as_str()).and_then(take),
    }
}

fn extract_cwd_from_bytes(agent: &str, bytes: &[u8]) -> Option<String> {
    let raw = maybe_decompress(bytes);
    if let Ok(v) = serde_json::from_slice::<Value>(&raw) {
        if let Some(c) = cwd_from_value(agent, &v) {
            return Some(c);
        }
    }
    let text = String::from_utf8_lossy(&raw);
    for line in text.lines().take(80) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(c) = cwd_from_value(agent, &v) {
            return Some(c);
        }
    }
    None
}

fn extract_cwd_from_pairs(agent: &str, pairs: &[(String, Vec<u8>)]) -> Option<String> {
    let prefer_end = match agent {
        "grok" => Some("summary.json"),
        "kimi" => Some("state.json"),
        _ => None,
    };
    if let Some(end) = prefer_end {
        if let Some((_, b)) = pairs.iter().find(|(n, _)| n.ends_with(end)) {
            if let Some(c) = extract_cwd_from_bytes(agent, b) {
                return Some(c);
            }
        }
    }
    for (_, b) in pairs {
        if let Some(c) = extract_cwd_from_bytes(agent, b) {
            return Some(c);
        }
    }
    None
}

fn extract_cwd_from_files(
    agent: &str,
    files: &[ManifestFile],
    blobs: &HashMap<String, Vec<u8>>,
) -> Option<String> {
    let prefer_end = match agent {
        "grok" => Some("summary.json"),
        "kimi" => Some("state.json"),
        _ => None,
    };
    if let Some(end) = prefer_end {
        for f in files {
            if f.path.ends_with(end) {
                if let Some(b) = blobs.get(&f.path) {
                    if let Some(c) = extract_cwd_from_bytes(agent, b) {
                        return Some(c);
                    }
                }
            }
        }
    }
    for f in files {
        if let Some(b) = blobs.get(&f.path) {
            if let Some(c) = extract_cwd_from_bytes(agent, b) {
                return Some(c);
            }
        }
    }
    None
}

/// 改写用的旧 cwd：文件内路径优先，缺了才回落列表侧 projectPath。
fn rewrite_old(entry: &ManifestEntry, files: &[(&ManifestFile, &[u8])]) -> String {
    if let Some(c) = entry.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return c.to_string();
    }
    for (_, b) in files {
        if let Some(c) = extract_cwd_from_bytes(&entry.agent, b) {
            return c;
        }
    }
    entry.project_path.clone()
}

fn extract_session_id(agent: &str, bytes: &[u8]) -> Option<String> {
    let raw = maybe_decompress(bytes);
    if agent == "codex" && bytes.starts_with(&ZSTD_MAGIC) && raw.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&raw);
    for line in text.lines().take(40) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if agent == "codex" {
            if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                if let Some(p) = v.get("payload") {
                    return p
                        .get("id")
                        .or_else(|| p.get("session_id"))
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
            }
            continue;
        }
        if agent == "gemini" && v.get("type").is_none() {
            if let Some(id) = v.get("sessionId").and_then(|x| x.as_str()) {
                return Some(id.to_string());
            }
        }
        if let Some(id) = v
            .get("sessionId")
            .or_else(|| v.get("session_id"))
            .and_then(|x| x.as_str())
        {
            return Some(id.to_string());
        }
    }
    None
}

fn validate_entry_files(
    agent: &str,
    session_id: &str,
    files: &[ManifestFile],
    blobs: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    if files.is_empty() {
        return Err("条目没有文件".into());
    }
    for f in files {
        let bytes = blobs.get(&f.path).ok_or_else(|| format!("缺文件 {}", f.path))?;
        if md5_hex(bytes) != f.md5 {
            return Err(format!("{} 校验和不符", f.path));
        }
        if f.path.ends_with(".jsonl.zst") || bytes.starts_with(&ZSTD_MAGIC) {
            if !bytes.starts_with(&ZSTD_MAGIC) {
                return Err("声明为 zstd 但魔数不符".into());
            }
            if maybe_decompress(bytes).is_empty() {
                return Err("zstd 内容无法解码".into());
            }
        }
    }
    let main = pick_main_file(agent, files).ok_or("缺主会话文件")?;
    let bytes = blobs.get(&main.path).ok_or("缺主会话文件")?;
    if agent == "grok" {
        let has_updates = files.iter().any(|f| f.path.ends_with("updates.jsonl"));
        let has_summary = files.iter().any(|f| f.path.ends_with("summary.json"));
        if !has_updates || !has_summary {
            return Err("Grok 会话须含 updates.jsonl 与 summary.json".into());
        }
        return Ok(());
    }
    if agent == "kimi" {
        let new = files
            .iter()
            .any(|f| f.path.ends_with("agents/main/wire.jsonl") || f.path.ends_with("/wire.jsonl"));
        let legacy = files.iter().any(|f| f.path.ends_with("context.jsonl"));
        if !new && !legacy {
            return Err("Kimi 会话缺 wire.jsonl / context.jsonl".into());
        }
        return Ok(());
    }
    match extract_session_id(agent, bytes) {
        Some(id) if id == session_id => Ok(()),
        Some(id) => Err(format!("会话 id 不匹配（文件内 {id}）")),
        None => {
            // 文件名即 id 的几家：解析不到时用 stem 兜底，仍要能对上
            let stem = Path::new(&main.path)
                .file_stem()
                .map(|s| s.to_string_lossy().replace(".jsonl", ""))
                .unwrap_or_default();
            if stem == session_id || stem.ends_with(session_id) {
                Ok(())
            } else {
                Err("首行无法解析出 sessionId".into())
            }
        }
    }
}

fn pick_main_file<'a>(agent: &str, files: &'a [ManifestFile]) -> Option<&'a ManifestFile> {
    match agent {
        "grok" => files.iter().find(|f| f.path.ends_with("updates.jsonl")),
        "kimi" => files
            .iter()
            .find(|f| f.path.ends_with("wire.jsonl"))
            .or_else(|| files.iter().find(|f| f.path.ends_with("context.jsonl"))),
        "codex" => files.iter().find(|f| {
            f.path.ends_with(".jsonl") || f.path.ends_with(".jsonl.zst")
        }),
        _ => files
            .iter()
            .find(|f| f.path.ends_with(".jsonl") || f.path.ends_with(".jsonl.zst")),
    }
}

fn walk_jsonl(dir: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    if max_depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_jsonl(&p, max_depth - 1, out);
        } else {
            let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if n.ends_with(".jsonl") || n.ends_with(".jsonl.zst") {
                out.push(p);
            }
        }
    }
}

fn index_existing_at(home: &Path) -> HashSet<(String, String)> {
    let mut out = HashSet::new();
    let mut push = |agent: &str, path: &Path| {
        if let Ok(bytes) = fs::read(path) {
            if let Some(id) = extract_session_id(agent, &bytes) {
                out.insert((agent.to_string(), id));
                return;
            }
        }
        if let Some(stem) = path.file_stem() {
            out.insert((agent.to_string(), stem.to_string_lossy().into_owned()));
        }
    };
    let mut files = Vec::new();
    walk_jsonl(&home.join(".claude").join("projects"), 2, &mut files);
    for f in files.drain(..) {
        push("claude-code", &f);
    }
    walk_jsonl(&home.join(".codex").join("sessions"), 5, &mut files);
    walk_jsonl(&home.join(".codex").join("archived_sessions"), 5, &mut files);
    for f in files.drain(..) {
        push("codex", &f);
    }
    walk_jsonl(&home.join(".gemini").join("tmp"), 3, &mut files);
    for f in files.drain(..) {
        push("gemini", &f);
    }
    walk_jsonl(&home.join(".qwen").join("projects"), 4, &mut files);
    for f in files.drain(..) {
        push("qwen", &f);
    }
    walk_jsonl(&home.join(".codebuddy").join("projects"), 2, &mut files);
    for f in files.drain(..) {
        push("codebuddy", &f);
    }
    walk_jsonl(&home.join(".cursor").join("projects"), 4, &mut files);
    for f in files.drain(..) {
        if f.components().any(|c| c.as_os_str() == "agent-transcripts") {
            push("cursor", &f);
        }
    }
    if let Ok(text) = fs::read_to_string(home.join(".kimi-code").join("session_index.jsonl")) {
        for line in text.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(id) = v.get("sessionId").and_then(|x| x.as_str()) {
                    out.insert(("kimi".into(), id.to_string()));
                }
            }
        }
    }
    let mut kimi_files = Vec::new();
    walk_jsonl(&home.join(".kimi").join("sessions"), 3, &mut kimi_files);
    for f in kimi_files {
        if let Some(id) = f.parent().and_then(|p| p.file_name()) {
            out.insert(("kimi".into(), id.to_string_lossy().into_owned()));
        }
    }
    let grok_root = home.join(".grok").join("sessions");
    if let Ok(groups) = fs::read_dir(&grok_root) {
        for g in groups.flatten() {
            let gp = g.path();
            if !gp.is_dir() {
                continue;
            }
            if let Ok(subs) = fs::read_dir(&gp) {
                for s in subs.flatten() {
                    let sp = s.path();
                    if sp.is_dir() && sp.join("updates.jsonl").exists() {
                        if let Some(id) = sp.file_name() {
                            out.insert(("grok".into(), id.to_string_lossy().into_owned()));
                        }
                    }
                }
            }
        }
    }
    out
}

fn path_exists_dir(p: &str) -> bool {
    if p.trim().is_empty() {
        return false;
    }
    PathBuf::from(sessions::expand_tilde(p)).is_dir()
}

fn inspect_at(
    zip_path: &Path,
    home: &Path,
    bindings: &[CodexBindingDto],
) -> Result<ImportPreviewDto, String> {
    let (manifest, blobs) = read_zip_map(zip_path)?;
    let existing = index_existing_at(home);
    let mut entries = Vec::new();
    for (index, e) in manifest.entries.iter().enumerate() {
        let mut status = "ok".to_string();
        let mut reason = None;
        let mut needs_client_register = false;
        if e.agent == "opencode" || !is_transfer_agent(&e.agent) {
            status = "unsupported".into();
            reason = Some("OpenCode 会话不支持导入（SQLite 插库留 v2）".into());
        } else if let Err(err) = validate_entry_files(&e.agent, &e.session_id, &e.files, &blobs) {
            status = "unsupported".into();
            reason = Some(err);
        } else if existing.contains(&(e.agent.clone(), e.session_id.clone())) {
            status = "conflict".into();
            reason = Some("同 Agent 同会话已存在，已跳过（v1 不覆盖）".into());
        } else {
            let source = e
                .cwd
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| extract_cwd_from_files(&e.agent, &e.files, &blobs))
                .unwrap_or_else(|| e.project_path.clone());
            if !path_exists_dir(&source) {
                status = "needs-path".into();
                reason = Some("原目录在本机不存在，请指定要落到的项目目录".into());
            }
        }
        if status != "unsupported"
            && e.agent == "codex"
            && e.provider
                .as_deref()
                .is_some_and(is_ccode_provider)
        {
            needs_client_register = true;
        }
        let cwd = e
            .cwd
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| extract_cwd_from_files(&e.agent, &e.files, &blobs));
        entries.push(ImportPreviewEntryDto {
            index,
            agent: e.agent.clone(),
            session_id: e.session_id.clone(),
            title: e.title.clone(),
            project_path: e.project_path.clone(),
            cwd,
            provider: e.provider.clone(),
            status,
            reason,
            needs_client_register,
        });
    }
    let any_reg = entries.iter().any(|e| e.needs_client_register);
    Ok(ImportPreviewDto {
        exported_at: manifest.exported_at,
        app_version: manifest.app_version,
        entries,
        codex_bindings: if any_reg {
            bindings.to_vec()
        } else {
            Vec::new()
        },
    })
}

fn list_codex_bindings(store: &ProfileStore) -> Vec<CodexBindingDto> {
    let Ok(profiles) = store.list() else {
        return Vec::new();
    };
    profiles
        .into_iter()
        .filter(|p| {
            p.agent == "codex"
                && p.account_type != crate::profiles::AccountType::Official
                && p.base_url.is_some()
        })
        .map(|p| CodexBindingDto {
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            has_key: p.has_key,
        })
        .collect()
}

#[tauri::command]
pub async fn import_sessions_inspect(
    zip_path: String,
    store: tauri::State<'_, ProfileStore>,
) -> Result<ImportPreviewDto, String> {
    let bindings = list_codex_bindings(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
        inspect_at(Path::new(&zip_path), &home, &bindings)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 落位白名单 =====

fn write_allowed(dest: &Path, home: &Path) -> bool {
    let dest_s = dest.to_string_lossy();
    let kimi_index = home.join(".kimi-code").join("session_index.jsonl");
    let kimi_json = home.join(".kimi").join("kimi.json");
    if same_path(&dest_s, &kimi_index.to_string_lossy())
        || same_path(&dest_s, &kimi_json.to_string_lossy())
    {
        return true;
    }
    for (dir, _) in sessions::session_data_dirs_at(home) {
        if path_within(&dest_s, &dir.to_string_lossy()) {
            return true;
        }
    }
    let cursor_root = home.join(".cursor").join("projects");
    if path_within(&dest_s, &cursor_root.to_string_lossy()) {
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.ends_with(".jsonl")
            && dest
                .components()
                .any(|c| c.as_os_str() == "agent-transcripts")
        {
            return true;
        }
    }
    false
}

fn atomic_write_checked(dest: &Path, bytes: &[u8], home: &Path, mtime: u64) -> Result<(), String> {
    if !write_allowed(dest, home) {
        return Err(format!("拒绝写入会话数据目录之外：{}", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        // canonicalize 后 macOS /var → /private/var，必须用 canonical home 再判一次
        if let (Ok(parent_c), Some(name)) = (parent.canonicalize(), dest.file_name()) {
            let dest_c = parent_c.join(name);
            let home_c = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
            if !write_allowed(&dest_c, home) && !write_allowed(&dest_c, &home_c) {
                return Err(format!("拒绝写入会话数据目录之外：{}", dest.display()));
            }
        }
    }
    profiles::atomic_write_bytes(dest, bytes)?;
    restore_mtime(dest, mtime);
    Ok(())
}

fn entry_blobs<'a>(
    entry: &'a ManifestEntry,
    blobs: &'a HashMap<String, Vec<u8>>,
) -> Result<Vec<(&'a ManifestFile, &'a [u8])>, String> {
    let mut out = Vec::new();
    for f in &entry.files {
        let b = blobs
            .get(&f.path)
            .ok_or_else(|| format!("缺文件 {}", f.path))?;
        out.push((f, b.as_slice()));
    }
    Ok(out)
}

fn zip_rel(entry_index: usize, zip_path: &str) -> String {
    let prefix = format!("sessions/{entry_index}/");
    zip_path.strip_prefix(&prefix).unwrap_or(zip_path).to_string()
}

fn rewrite_needed(old: &str, target: &str) -> bool {
    !old.is_empty() && !same_path(old, target)
}

fn apply_entry(
    home: &Path,
    entry: &ManifestEntry,
    index: usize,
    blobs: &HashMap<String, Vec<u8>>,
    target: &str,
    existing: &HashSet<(String, String)>,
) -> Result<String, String> {
    if existing.contains(&(entry.agent.clone(), entry.session_id.clone())) {
        return Err("conflict".into());
    }
    let files = entry_blobs(entry, blobs)?;
    let old = rewrite_old(entry, &files);
    match entry.agent.as_str() {
        "claude-code" => land_single(
            home,
            &entry.agent,
            &entry.session_id,
            &files,
            index,
            target,
            &old,
            home.join(".claude")
                .join("projects")
                .join(path_slug_non_alnum(target)),
        ),
        "qwen" => land_single(
            home,
            &entry.agent,
            &entry.session_id,
            &files,
            index,
            target,
            &old,
            home.join(".qwen")
                .join("projects")
                .join(path_slug_non_alnum(target))
                .join("chats"),
        ),
        "codebuddy" => land_single(
            home,
            &entry.agent,
            &entry.session_id,
            &files,
            index,
            target,
            &old,
            home.join(".codebuddy")
                .join("projects")
                .join(path_slug_separators(target)),
        ),
        "cursor" => land_cursor(home, entry, &files, index, target, &old),
        "gemini" => land_gemini(home, entry, &files, index, target, &old),
        "codex" => land_codex(home, entry, &files, index, target, &old),
        "kimi" => land_kimi(home, entry, &files, index, target, &old),
        "grok" => land_grok(home, entry, &files, index, target, &old),
        _ => Err(format!("{} 不支持导入", entry.agent)),
    }
}

fn land_single(
    home: &Path,
    agent: &str,
    session_id: &str,
    files: &[(&ManifestFile, &[u8])],
    index: usize,
    target: &str,
    old: &str,
    dir: PathBuf,
) -> Result<String, String> {
    let (f, bytes) = files
        .iter()
        .find(|(f, _)| f.path.ends_with(".jsonl") || f.path.ends_with(".jsonl.zst"))
        .copied()
        .ok_or("缺 jsonl 主文件")?;
    let name = Path::new(&zip_rel(index, &f.path))
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("{session_id}.jsonl"));
    let dest = dir.join(name);
    if dest.exists() {
        return Err("目标文件已存在".into());
    }
    let body = if rewrite_needed(old, target) {
        rewrite_json_bytes(bytes, old, target, rewrite_keys_for(agent), None)
    } else {
        bytes.to_vec()
    };
    atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
    Ok("imported".into())
}

fn land_cursor(
    home: &Path,
    entry: &ManifestEntry,
    files: &[(&ManifestFile, &[u8])],
    index: usize,
    target: &str,
    old: &str,
) -> Result<String, String> {
    let (f, bytes) = files
        .iter()
        .find(|(f, _)| f.path.ends_with(".jsonl"))
        .copied()
        .ok_or("缺 cursor jsonl")?;
    let dest = home
        .join(".cursor")
        .join("projects")
        .join(path_slug_separators(target))
        .join("agent-transcripts")
        .join(&entry.session_id)
        .join(format!("{}.jsonl", entry.session_id));
    if dest.exists() {
        return Err("目标文件已存在".into());
    }
    let _ = index;
    let body = if rewrite_needed(old, target) {
        rewrite_json_bytes(
            bytes,
            old,
            target,
            rewrite_keys_for("cursor"),
            None,
        )
    } else {
        bytes.to_vec()
    };
    atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
    Ok("imported".into())
}

fn land_gemini(
    home: &Path,
    entry: &ManifestEntry,
    files: &[(&ManifestFile, &[u8])],
    index: usize,
    target: &str,
    old: &str,
) -> Result<String, String> {
    let (f, bytes) = files
        .iter()
        .find(|(f, _)| f.path.ends_with(".jsonl"))
        .copied()
        .ok_or("缺 gemini jsonl")?;
    let slug = gemini_import_slug(target);
    let slug_dir = home.join(".gemini").join("tmp").join(&slug);
    let name = Path::new(&zip_rel(index, &f.path))
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("{}.jsonl", entry.session_id));
    let dest = slug_dir.join("chats").join(name);
    if dest.exists() {
        return Err("目标文件已存在".into());
    }
    let body = if rewrite_needed(old, target) {
        rewrite_json_bytes(
            bytes,
            old,
            target,
            rewrite_keys_for("gemini"),
            None,
        )
    } else {
        bytes.to_vec()
    };
    atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
    let marker = slug_dir.join(".project_root");
    atomic_write_checked(&marker, format!("{target}\n").as_bytes(), home, 0)?;
    Ok("imported".into())
}

fn land_codex(
    home: &Path,
    entry: &ManifestEntry,
    files: &[(&ManifestFile, &[u8])],
    index: usize,
    target: &str,
    old: &str,
) -> Result<String, String> {
    let (f, bytes) = files
        .iter()
        .find(|(f, _)| f.path.contains("jsonl"))
        .copied()
        .ok_or("缺 codex rollout")?;
    let rel = zip_rel(index, &f.path);
    let date = codex_date_from_path(Path::new(&rel)).unwrap_or_else(|| {
        let stamp = entry
            .files
            .first()
            .map(|x| x.mtime_ms / 1000)
            .unwrap_or(0);
        let t = UNIX_EPOCH + Duration::from_secs(stamp);
        let d = chrono::DateTime::<chrono::Utc>::from(t);
        d.format("%Y/%m/%d").to_string()
    });
    let mut name = Path::new(&rel)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("rollout-{}.jsonl", entry.session_id));
    let rewrite = rewrite_needed(old, target);
    let body = if rewrite {
        if name.ends_with(".zst") {
            name = name.trim_end_matches(".zst").to_string();
        }
        rewrite_json_bytes(
            bytes,
            old,
            target,
            rewrite_keys_for("codex"),
            None,
        )
    } else {
        bytes.to_vec()
    };
    let dest = home.join(".codex").join("sessions").join(date).join(name);
    if dest.exists() {
        return Err("目标文件已存在".into());
    }
    atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
    Ok("imported".into())
}

fn land_kimi(
    home: &Path,
    entry: &ManifestEntry,
    files: &[(&ManifestFile, &[u8])],
    index: usize,
    target: &str,
    old: &str,
) -> Result<String, String> {
    let is_new = files
        .iter()
        .any(|(f, _)| f.path.ends_with("wire.jsonl"));
    if is_new {
        let dest_dir = home
            .join(".kimi-code")
            .join("sessions")
            .join(kimi_wd_bucket(target))
            .join(&entry.session_id);
        if dest_dir.exists() {
            return Err("目标会话目录已存在".into());
        }
        let new_home = dest_dir.join("agents").join("main");
        for (f, bytes) in files {
            let rel = zip_rel(index, &f.path);
            let dest = dest_dir.join(rel);
            let mut body = if rewrite_needed(old, target) {
                if f.path.ends_with(".json") {
                    rewrite_json_object(
                        bytes,
                        old,
                        target,
                        rewrite_keys_for("kimi"),
                        None,
                    )
                } else {
                    rewrite_json_bytes(
                        bytes,
                        old,
                        target,
                        rewrite_keys_for("kimi"),
                        None,
                    )
                }
            } else {
                bytes.to_vec()
            };
            if f.path.ends_with("state.json") {
                body = rewrite_kimi_homedir(&body, &new_home);
            }
            atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
        }
        append_kimi_index(home, &entry.session_id, &dest_dir, target)?;
        Ok("imported".into())
    } else {
        let dest_dir = home
            .join(".kimi")
            .join("sessions")
            .join(kimi_legacy_bucket(target))
            .join(&entry.session_id);
        if dest_dir.exists() {
            return Err("目标会话目录已存在".into());
        }
        for (f, bytes) in files {
            let rel = zip_rel(index, &f.path);
            let dest = dest_dir.join(Path::new(&rel).file_name().unwrap_or(rel.as_ref()));
            let body = if rewrite_needed(old, target) {
                if f.path.ends_with(".json") {
                    rewrite_json_object(
                        bytes,
                        old,
                        target,
                        rewrite_keys_for("kimi"),
                        None,
                    )
                } else {
                    rewrite_json_bytes(
                        bytes,
                        old,
                        target,
                        rewrite_keys_for("kimi"),
                        None,
                    )
                }
            } else {
                bytes.to_vec()
            };
            atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
        }
        upsert_kimi_work_dir(home, target)?;
        Ok("imported".into())
    }
}

fn rewrite_kimi_homedir(bytes: &[u8], new_agent_home: &Path) -> Vec<u8> {
    let Ok(mut v) = serde_json::from_slice::<Value>(bytes) else {
        return bytes.to_vec();
    };
    if let Some(main) = v.pointer_mut("/agents/main") {
        if let Some(obj) = main.as_object_mut() {
            obj.insert(
                "homedir".into(),
                Value::String(new_agent_home.to_string_lossy().into_owned()),
            );
        }
    }
    serde_json::to_vec(&v).unwrap_or_else(|_| bytes.to_vec())
}

fn append_kimi_index(
    home: &Path,
    session_id: &str,
    session_dir: &Path,
    work_dir: &str,
) -> Result<(), String> {
    let path = home.join(".kimi-code").join("session_index.jsonl");
    let mut lines: Vec<String> = if path.exists() {
        fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    } else {
        Vec::new()
    };
    lines.retain(|l| {
        serde_json::from_str::<Value>(l)
            .ok()
            .and_then(|v| v.get("sessionId").and_then(|x| x.as_str()).map(|s| s != session_id))
            .unwrap_or(true)
    });
    let row = serde_json::json!({
        "sessionId": session_id,
        "sessionDir": session_dir.to_string_lossy(),
        "workDir": work_dir,
    });
    lines.push(row.to_string());
    let mut text = lines.join("\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write_checked(&path, text.as_bytes(), home, 0)
}

fn upsert_kimi_work_dir(home: &Path, work_dir: &str) -> Result<(), String> {
    let path = home.join(".kimi").join("kimi.json");
    let mut root = if path.exists() {
        serde_json::from_slice::<Value>(&fs::read(&path).unwrap_or_default())
            .unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let arr = root
        .as_object_mut()
        .ok_or("kimi.json 不是对象")?
        .entry("work_dirs")
        .or_insert_with(|| Value::Array(Vec::new()));
    let list = arr.as_array_mut().ok_or("kimi.json work_dirs 不是数组")?;
    let exists = list.iter().any(|d| {
        d.get("path")
            .and_then(|x| x.as_str())
            .is_some_and(|p| same_path(p, work_dir))
    });
    if !exists {
        list.push(serde_json::json!({ "path": work_dir }));
        let text = serde_json::to_vec_pretty(&root).map_err(|e| e.to_string())?;
        atomic_write_checked(&path, &text, home, 0)?;
    }
    Ok(())
}

fn land_grok(
    home: &Path,
    entry: &ManifestEntry,
    files: &[(&ManifestFile, &[u8])],
    index: usize,
    target: &str,
    old: &str,
) -> Result<String, String> {
    let (encoded, need_cwd_file) = grok_encode_cwd(target);
    let dest_dir = home
        .join(".grok")
        .join("sessions")
        .join(&encoded)
        .join(&entry.session_id);
    if dest_dir.exists() {
        return Err("目标会话目录已存在".into());
    }
    for (f, bytes) in files {
        let rel = zip_rel(index, &f.path);
        let dest = dest_dir.join(rel);
        let mut body = bytes.to_vec();
        if f.path.ends_with("summary.json") && rewrite_needed(old, target) {
            body = rewrite_json_object(
                bytes,
                old,
                target,
                rewrite_keys_for("grok"),
                None,
            );
        }
        atomic_write_checked(&dest, &body, home, f.mtime_ms)?;
    }
    if need_cwd_file {
        atomic_write_checked(&dest_dir.parent().unwrap().join(".cwd"), target.as_bytes(), home, 0)?;
    }
    Ok("imported".into())
}

fn write_ccode_meta(entry: &ManifestEntry) -> Result<(), String> {
    let c = &entry.ccode;
    if !c.pinned && c.custom_title.is_none() && c.tags.is_empty() && c.summary.is_none() {
        return Ok(());
    }
    let conn = sessions::open_db()?;
    let tags_json = serde_json::to_string(&c.tags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, pinned, custom_title, tags, summary)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(agent, session_id) DO UPDATE SET
           pinned=excluded.pinned,
           custom_title=excluded.custom_title,
           tags=excluded.tags,
           summary=excluded.summary",
        rusqlite::params![
            entry.agent,
            entry.session_id,
            if c.pinned { 1 } else { 0 },
            c.custom_title,
            tags_json,
            c.summary,
        ],
    )
    .map_err(|e| format!("写入 session_meta 失败: {e}"))?;
    Ok(())
}

fn apply_at(
    zip_path: &Path,
    home: &Path,
    decisions: &[ImportDecisionDto],
) -> Result<(ImportReportDto, Vec<String>), String> {
    let (manifest, blobs) = read_zip_map(zip_path)?;
    let mut existing = index_existing_at(home);
    let mut items = Vec::new();
    let mut imported = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;
    let mut imported_providers: Vec<String> = Vec::new();
    let decision_map: HashMap<usize, &ImportDecisionDto> =
        decisions.iter().map(|d| (d.index, d)).collect();
    for (index, entry) in manifest.entries.iter().enumerate() {
        let dec = decision_map.get(&index);
        let skip = dec.map(|d| d.skip).unwrap_or(false);
        if skip {
            skipped += 1;
            items.push(ImportItemReportDto {
                index,
                agent: entry.agent.clone(),
                session_id: entry.session_id.clone(),
                status: "skipped".into(),
                reason: Some("用户跳过或同 id 已存在".into()),
            });
            continue;
        }
        if entry.agent == "opencode" || !is_transfer_agent(&entry.agent) {
            skipped += 1;
            items.push(ImportItemReportDto {
                index,
                agent: entry.agent.clone(),
                session_id: entry.session_id.clone(),
                status: "skipped".into(),
                reason: Some("不支持的 Agent".into()),
            });
            continue;
        }
        if let Err(err) = validate_entry_files(&entry.agent, &entry.session_id, &entry.files, &blobs)
        {
            failed += 1;
            items.push(ImportItemReportDto {
                index,
                agent: entry.agent.clone(),
                session_id: entry.session_id.clone(),
                status: "failed".into(),
                reason: Some(err),
            });
            continue;
        }
        let target = dec
            .and_then(|d| d.target_dir.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| entry.project_path.clone());
        let target = sessions::expand_tilde(&target);
        if target.trim().is_empty() {
            failed += 1;
            items.push(ImportItemReportDto {
                index,
                agent: entry.agent.clone(),
                session_id: entry.session_id.clone(),
                status: "failed".into(),
                reason: Some("未指定目标目录".into()),
            });
            continue;
        }
        match apply_entry(home, entry, index, &blobs, &target, &existing) {
            Ok(_) => {
                let _ = write_ccode_meta(entry);
                existing.insert((entry.agent.clone(), entry.session_id.clone()));
                imported += 1;
                if entry.agent == "codex" {
                    if let Some(p) = entry.provider.as_deref() {
                        if is_ccode_provider(p) && !imported_providers.iter().any(|x| x == p) {
                            imported_providers.push(p.to_string());
                        }
                    }
                }
                items.push(ImportItemReportDto {
                    index,
                    agent: entry.agent.clone(),
                    session_id: entry.session_id.clone(),
                    status: "imported".into(),
                    reason: None,
                });
            }
            Err(err) if err == "conflict" => {
                skipped += 1;
                items.push(ImportItemReportDto {
                    index,
                    agent: entry.agent.clone(),
                    session_id: entry.session_id.clone(),
                    status: "skipped".into(),
                    reason: Some("同 Agent 同会话已存在，已跳过".into()),
                });
            }
            Err(err) => {
                failed += 1;
                items.push(ImportItemReportDto {
                    index,
                    agent: entry.agent.clone(),
                    session_id: entry.session_id.clone(),
                    status: "failed".into(),
                    reason: Some(err),
                });
            }
        }
    }
    sessions::invalidate_scan_cache();
    Ok((
        ImportReportDto {
            imported,
            skipped,
            failed,
            items,
            register_note: None,
        },
        imported_providers,
    ))
}

#[tauri::command]
pub async fn import_sessions_apply(
    zip_path: String,
    decisions: Vec<ImportDecisionDto>,
    register_binding_id: Option<String>,
    register_to_client: bool,
    store: tauri::State<'_, ProfileStore>,
) -> Result<ImportReportDto, String> {
    let (mut report, providers) = tauri::async_runtime::spawn_blocking({
        let zip_path = zip_path.clone();
        let decisions = decisions.clone();
        move || {
            let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
            apply_at(Path::new(&zip_path), &home, &decisions)
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    if register_to_client {
        if let Some(pid) = register_binding_id.filter(|s| !s.is_empty()) {
            if !providers.is_empty() {
                match crate::global_config::profile_for_register(&store, &pid) {
                    Ok((profile, key)) => {
                        let mut notes = Vec::new();
                        for name in &providers {
                            match crate::global_config::register_codex_client_provider_named(
                                profile.clone(),
                                key.clone(),
                                name.clone(),
                            ) {
                                Ok(_) => notes.push(format!("已注册 {name}")),
                                Err(e) => notes.push(format!("{name} 注册失败：{e}")),
                            }
                        }
                        report.register_note = Some(notes.join("；"));
                    }
                    Err(e) => {
                        report.register_note = Some(format!("未注册到 Codex 客户端：{e}"));
                    }
                }
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccode-st-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_zip_test(dir: &Path, manifest: &Manifest, files: Vec<(String, Vec<u8>)>) -> PathBuf {
        let p = dir.join("pack.ccode-sessions.zip");
        write_zip(&p, manifest, &files).unwrap();
        p
    }

    fn sample_claude(cwd: &str, id: &str) -> String {
        format!(
            r#"{{"type":"user","sessionId":"{id}","cwd":"{cwd}","timestamp":"2026-09-01T00:00:00Z","message":{{"role":"user","content":"hello"}}}}
"#
        )
    }

    #[test]
    fn claude_slug_matches_real_layout() {
        assert_eq!(
            path_slug_non_alnum("/Users/tongzhouhong/Documents/Review"),
            "-Users-tongzhouhong-Documents-Review"
        );
    }

    #[test]
    fn cursor_slug_strips_leading_slash() {
        assert_eq!(
            path_slug_separators("/Users/tongzhouhong/Documents/Ccode"),
            "Users-tongzhouhong-Documents-Ccode"
        );
    }

    #[test]
    fn windows_target_slugs_are_fs_safe() {
        let win = r"C:\Users\bob\Documents\Ccode";
        let claude = path_slug_non_alnum(win);
        assert_eq!(claude, "C--Users-bob-Documents-Ccode");
        assert!(!claude.chars().any(|c| "<>:\"/\\|?*".contains(c)));
        let cursor = path_slug_separators(win);
        assert_eq!(cursor, "C--Users-bob-Documents-Ccode");
        assert!(!cursor.contains(':'));
        let (grok, long) = grok_encode_cwd(win);
        assert!(!long);
        assert!(!grok.contains(':'));
        assert!(!grok.contains('\\'));
    }

    #[test]
    fn rewrite_unix_cwd_to_windows_target() {
        let src = "{\"cwd\":\"/Users/alice/proj\",\"sessionId\":\"s1\"}\n";
        let out = rewrite_json_bytes(
            src.as_bytes(),
            "/Users/alice/proj",
            r"C:\Users\bob\proj",
            &["cwd"],
            None,
        );
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("C:\\\\Users\\\\bob\\\\proj"),
            "Windows 路径进 JSON 应转义反斜杠: {text}"
        );
        assert!(!text.contains("/Users/alice/proj"));
    }

    #[test]
    fn kimi_wd_bucket_matches_machine() {
        assert_eq!(
            kimi_wd_bucket("/Users/tongzhouhong"),
            "wd_tongzhouhong_ff5267b44b9c"
        );
        assert_eq!(
            kimi_wd_bucket("/Users/tongzhouhong/Documents/Codex/2026-07-29/ban"),
            "wd_ban_32b867789ad1"
        );
    }

    #[test]
    fn grok_encode_matches_machine() {
        let (enc, long) = grok_encode_cwd("/Users/tongzhouhong/Documents/Ccode");
        assert!(!long);
        assert_eq!(enc, "%2FUsers%2Ftongzhouhong%2FDocuments%2FCcode");
    }

    #[test]
    fn grok_long_path_uses_slug_and_flags_cwd_file() {
        let long = format!("/{}", "a".repeat(300));
        let (enc, need) = grok_encode_cwd(&long);
        assert!(need);
        assert!(enc.len() < 80);
        assert!(enc.contains('-'));
    }

    #[test]
    fn rewrite_keeps_broken_lines_and_replaces_cwd() {
        let src = concat!(
            r#"{"cwd":"/old/proj","sessionId":"s1"}"#,
            "\n",
            r#"{"cwd":"/old/proj""#, // 截断
            "\n",
            r#"{"other":"/old/proj"}"#,
            "\n",
        );
        let out = rewrite_json_bytes(src.as_bytes(), "/old/proj", "/new/proj", &["cwd"], None);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("\"cwd\":\"/new/proj\""));
        assert!(text.contains(r#"{"cwd":"/old/proj""#));
        assert!(text.contains(r#""other":"/old/proj""#), "非目标键不改");
    }

    #[test]
    fn zip_slip_rejected() {
        let dir = tmp();
        let zip_path = dir.join("bad.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(file);
            let opt = zip::write::SimpleFileOptions::default();
            w.start_file("../etc/passwd", opt).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
        let err = read_zip_map(&zip_path).unwrap_err();
        assert!(
            err.contains("穿越") || err.contains("绝对") || err.contains("非会话"),
            "{err}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    fn claude_manifest(id: &str, cwd: &str, zip_file: &str, bytes: &[u8]) -> Manifest {
        Manifest {
            version: 1,
            exported_at: "2026-09-01T00:00:00Z".into(),
            app_version: "0.1.0".into(),
            entries: vec![ManifestEntry {
                agent: "claude-code".into(),
                session_id: id.into(),
                title: Some("hello".into()),
                project_path: cwd.into(),
                cwd: Some(cwd.into()),
                provider: None,
                files: vec![ManifestFile {
                    path: zip_file.into(),
                    size_bytes: bytes.len() as u64,
                    mtime_ms: 1_725_000_000_000,
                    md5: md5_hex(bytes),
                }],
                ccode: ManifestCcode {
                    pinned: true,
                    custom_title: Some("我的标题".into()),
                    tags: vec!["a".into()],
                    summary: None,
                },
            }],
        }
    }

    #[test]
    fn inspect_needs_path_and_conflict_and_version() {
        let dir = tmp();
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();
        let id = "11111111-1111-1111-1111-111111111111";
        let body = sample_claude("/Users/alice/proj", id);
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = claude_manifest(id, "/Users/alice/proj", &zip_file, body.as_bytes());
        let zip = write_zip_test(
            &dir,
            &man,
            vec![(zip_file.clone(), body.as_bytes().to_vec())],
        );
        let preview = inspect_at(&zip, &home, &[]).unwrap();
        assert_eq!(preview.entries[0].status, "needs-path");
        assert_eq!(
            preview.entries[0].cwd.as_deref(),
            Some("/Users/alice/proj")
        );

        // 冲突：先落一份
        let dest_dir = home
            .join(".claude")
            .join("projects")
            .join(path_slug_non_alnum("/tmp/exists"));
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(dest_dir.join(format!("{id}.jsonl")), &body).unwrap();
        // 目标目录存在且同 id
        let proj = dir.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let man2 = claude_manifest(id, proj.to_str().unwrap(), &zip_file, body.as_bytes());
        let zip2 = write_zip_test(&dir, &man2, vec![(zip_file, body.as_bytes().to_vec())]);
        let preview2 = inspect_at(&zip2, &home, &[]).unwrap();
        assert_eq!(preview2.entries[0].status, "conflict");

        let mut bad = man;
        bad.version = 2;
        let zip3 = write_zip_test(&dir, &bad, vec![]);
        let err = inspect_at(&zip3, &home, &[]).unwrap_err();
        assert!(err.contains("版本"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_claude_rewrites_cwd_and_skips_conflict() {
        let dir = tmp();
        let home = dir.join("home");
        let target = dir.join("work");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&target).unwrap();
        let id = "22222222-2222-2222-2222-222222222222";
        let body = sample_claude("/Users/alice/proj", id);
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = claude_manifest(id, "/Users/alice/proj", &zip_file, body.as_bytes());
        let zip = write_zip_test(
            &dir,
            &man,
            vec![(zip_file, body.as_bytes().to_vec())],
        );
        let dec = vec![ImportDecisionDto {
            index: 0,
            skip: false,
            target_dir: Some(target.to_string_lossy().into_owned()),
        }];
        let (report, _) = apply_at(&zip, &home, &dec).unwrap();
        assert_eq!(report.imported, 1, "{:?}", report.items);
        let dest = home
            .join(".claude")
            .join("projects")
            .join(path_slug_non_alnum(target.to_str().unwrap()))
            .join(format!("{id}.jsonl"));
        let got = fs::read_to_string(&dest).unwrap();
        assert!(got.contains(&format!("\"cwd\":\"{}\"", target.to_string_lossy().replace('\\', "\\\\")) ) || got.contains(&target.to_string_lossy().replace('\\', "/")), "got={got}");
        assert!(!got.contains("/Users/alice/proj"));

        let (report2, _) = apply_at(&zip, &home, &dec).unwrap();
        assert_eq!(report2.skipped, 1);
        assert_eq!(report2.imported, 0);
        fs::remove_dir_all(&dir).ok();
    }

    fn worktree_entry(
        id: &str,
        repo: &str,
        worktree: Option<&str>,
        zip_file: &str,
        bytes: &[u8],
    ) -> Manifest {
        Manifest {
            version: 1,
            exported_at: "2026-09-01T00:00:00Z".into(),
            app_version: "0.1.0".into(),
            entries: vec![ManifestEntry {
                agent: "claude-code".into(),
                session_id: id.into(),
                title: Some("wt".into()),
                project_path: repo.into(),
                cwd: worktree.map(str::to_string),
                provider: None,
                files: vec![ManifestFile {
                    path: zip_file.into(),
                    size_bytes: bytes.len() as u64,
                    mtime_ms: 1_725_000_000_000,
                    md5: md5_hex(bytes),
                }],
                ccode: ManifestCcode {
                    pinned: false,
                    custom_title: None,
                    tags: vec![],
                    summary: None,
                },
            }],
        }
    }

    /// 工作区会话：列表 projectPath 是主仓，文件 cwd 是工作树。改写必须用后者。
    #[test]
    fn apply_rewrites_file_cwd_not_aggregated_project_path() {
        let dir = tmp();
        let home = dir.join("home");
        let repo = dir.join("repo");
        let target = dir.join("b-machine");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&target).unwrap();
        let worktree = "/Users/alice/.ccode/worktrees/search";
        let id = "55555555-5555-5555-5555-555555555555";
        let body = sample_claude(worktree, id);
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = worktree_entry(
            id,
            repo.to_str().unwrap(),
            Some(worktree),
            &zip_file,
            body.as_bytes(),
        );
        let zip = write_zip_test(&dir, &man, vec![(zip_file, body.as_bytes().to_vec())]);
        let t = target.to_string_lossy().into_owned();
        let (report, _) = apply_at(
            &zip,
            &home,
            &[ImportDecisionDto {
                index: 0,
                skip: false,
                target_dir: Some(t.clone()),
            }],
        )
        .unwrap();
        assert_eq!(report.imported, 1, "{:?}", report.items);
        let dest = home
            .join(".claude")
            .join("projects")
            .join(path_slug_non_alnum(&t))
            .join(format!("{id}.jsonl"));
        let got = fs::read_to_string(&dest).unwrap();
        let json_cwd = t.replace('\\', "\\\\");
        assert!(
            got.contains(&format!("\"cwd\":\"{json_cwd}\""))
                || got.contains(&format!("\"cwd\":\"{}\"", t.replace('\\', "/"))),
            "应改写成 B 机目录, got={got}"
        );
        assert!(
            !got.contains(worktree),
            "工作树路径必须被改掉, got={got}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// 旧包没有 cwd 字段时，从 jsonl 抽出工作树路径再改写，不能拿主仓 projectPath。
    #[test]
    fn apply_extracts_file_cwd_when_manifest_cwd_absent() {
        let dir = tmp();
        let home = dir.join("home");
        let repo = dir.join("repo");
        let target = dir.join("b-machine");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&target).unwrap();
        let worktree = "/Users/alice/.ccode/worktrees/search";
        let id = "66666666-6666-6666-6666-666666666666";
        let body = sample_claude(worktree, id);
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = worktree_entry(id, repo.to_str().unwrap(), None, &zip_file, body.as_bytes());
        let zip = write_zip_test(&dir, &man, vec![(zip_file, body.as_bytes().to_vec())]);
        let t = target.to_string_lossy().into_owned();
        let (report, _) = apply_at(
            &zip,
            &home,
            &[ImportDecisionDto {
                index: 0,
                skip: false,
                target_dir: Some(t.clone()),
            }],
        )
        .unwrap();
        assert_eq!(report.imported, 1, "{:?}", report.items);
        let dest = home
            .join(".claude")
            .join("projects")
            .join(path_slug_non_alnum(&t))
            .join(format!("{id}.jsonl"));
        let got = fs::read_to_string(dest).unwrap();
        assert!(!got.contains(worktree), "got={got}");
        fs::remove_dir_all(&dir).ok();
    }

    /// 主仓在 B 机还在、工作树已经没了 → 仍要选目录（不能因为 projectPath 存在就标 ok）。
    #[test]
    fn inspect_needs_path_when_worktree_cwd_missing_even_if_repo_exists() {
        let dir = tmp();
        let home = dir.join("home");
        let repo = dir.join("repo");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repo).unwrap();
        let worktree = dir.join("missing-worktree");
        let wt = worktree.to_string_lossy().into_owned();
        assert!(!worktree.exists());
        let id = "77777777-7777-7777-7777-777777777777";
        let body = sample_claude(&wt, id);
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = worktree_entry(
            id,
            repo.to_str().unwrap(),
            Some(&wt),
            &zip_file,
            body.as_bytes(),
        );
        let zip = write_zip_test(&dir, &man, vec![(zip_file, body.as_bytes().to_vec())]);
        let preview = inspect_at(&zip, &home, &[]).unwrap();
        assert_eq!(preview.entries[0].status, "needs-path");
        assert_eq!(preview.entries[0].cwd.as_deref(), Some(wt.as_str()));
        assert_eq!(
            preview.entries[0].project_path,
            repo.to_string_lossy().as_ref()
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_same_path_zero_rewrite() {
        let dir = tmp();
        let home = dir.join("home");
        let target = dir.join("same");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&target).unwrap();
        let id = "33333333-3333-3333-3333-333333333333";
        let cwd = target.to_string_lossy().into_owned();
        let body = sample_claude(&cwd, id);
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = claude_manifest(id, &cwd, &zip_file, body.as_bytes());
        let zip = write_zip_test(&dir, &man, vec![(zip_file, body.as_bytes().to_vec())]);
        let dec = vec![ImportDecisionDto {
            index: 0,
            skip: false,
            target_dir: Some(cwd.clone()),
        }];
        apply_at(&zip, &home, &dec).unwrap();
        let dest = home
            .join(".claude")
            .join("projects")
            .join(path_slug_non_alnum(&cwd))
            .join(format!("{id}.jsonl"));
        let got = fs::read_to_string(dest).unwrap();
        assert_eq!(got, body, "同路径应原样落盘");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_cursor_keeps_hierarchy() {
        let dir = tmp();
        let home = dir.join("home");
        let target = dir.join("cur");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&target).unwrap();
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let body = format!(
            r#"{{"type":"user_message","sessionId":"{id}","cwd":"/old","text":"hi"}}
"#
        );
        let zip_file = format!("sessions/0/{id}.jsonl");
        let man = Manifest {
            version: 1,
            exported_at: "2026-09-01T00:00:00Z".into(),
            app_version: "0.1.0".into(),
            entries: vec![ManifestEntry {
                agent: "cursor".into(),
                session_id: id.into(),
                title: None,
                project_path: "/old".into(),
                cwd: None,
                provider: None,
                files: vec![ManifestFile {
                    path: zip_file.clone(),
                    size_bytes: body.len() as u64,
                    mtime_ms: 0,
                    md5: md5_hex(body.as_bytes()),
                }],
                ccode: ManifestCcode {
                    pinned: false,
                    custom_title: None,
                    tags: vec![],
                    summary: None,
                },
            }],
        };
        let zip = write_zip_test(&dir, &man, vec![(zip_file, body.into_bytes())]);
        let dec = vec![ImportDecisionDto {
            index: 0,
            skip: false,
            target_dir: Some(target.to_string_lossy().into_owned()),
        }];
        let (report, _) = apply_at(&zip, &home, &dec).unwrap();
        assert_eq!(report.imported, 1, "{:?}", report.items);
        let dest = home
            .join(".cursor")
            .join("projects")
            .join(path_slug_separators(target.to_str().unwrap()))
            .join("agent-transcripts")
            .join(id)
            .join(format!("{id}.jsonl"));
        assert!(dest.exists(), "{}", dest.display());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_gemini_writes_project_root() {
        let dir = tmp();
        let home = dir.join("home");
        let target = dir.join("gproj");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&target).unwrap();
        let id = "g-session";
        let body = format!(
            r#"{{"sessionId":"{id}","directories":["/old/g"]}}
{{"type":"user","content":"q"}}
"#
        );
        let zip_file = "sessions/0/session-x.jsonl".to_string();
        let man = Manifest {
            version: 1,
            exported_at: "2026-09-01T00:00:00Z".into(),
            app_version: "0.1.0".into(),
            entries: vec![ManifestEntry {
                agent: "gemini".into(),
                session_id: id.into(),
                title: None,
                project_path: "/old/g".into(),
                cwd: None,
                provider: None,
                files: vec![ManifestFile {
                    path: zip_file.clone(),
                    size_bytes: body.len() as u64,
                    mtime_ms: 0,
                    md5: md5_hex(body.as_bytes()),
                }],
                ccode: ManifestCcode {
                    pinned: false,
                    custom_title: None,
                    tags: vec![],
                    summary: None,
                },
            }],
        };
        let zip = write_zip_test(&dir, &man, vec![(zip_file, body.into_bytes())]);
        let t = target.to_string_lossy().into_owned();
        let (report, _) = apply_at(
            &zip,
            &home,
            &[ImportDecisionDto {
                index: 0,
                skip: false,
                target_dir: Some(t.clone()),
            }],
        )
        .unwrap();
        assert_eq!(report.imported, 1, "{:?}", report.items);
        let slug = gemini_import_slug(&t);
        let marker = home
            .join(".gemini")
            .join("tmp")
            .join(&slug)
            .join(".project_root");
        assert_eq!(fs::read_to_string(marker).unwrap().trim(), t.trim());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_kimi_new_index_and_workdir() {
        let dir = tmp();
        let home = dir.join("home");
        let target = dir.join("kproj");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&target).unwrap();
        let id = "session_kimi_1";
        let wire = r#"{"type":"metadata","protocol_version":"v1"}
{"type":"context.append_loop_event","event":{"args":{"cwd":"/old/k"},"display":{"cwd":"/old/k"}}}
"#;
        let state = r#"{"title":"k","workDir":"/old/k","agents":{"main":{"homedir":"/old/sess/agents/main"}}}"#;
        let files = vec![
            (
                "sessions/0/agents/main/wire.jsonl".to_string(),
                wire.as_bytes().to_vec(),
            ),
            ("sessions/0/state.json".to_string(), state.as_bytes().to_vec()),
        ];
        let man = Manifest {
            version: 1,
            exported_at: "2026-09-01T00:00:00Z".into(),
            app_version: "0.1.0".into(),
            entries: vec![ManifestEntry {
                agent: "kimi".into(),
                session_id: id.into(),
                title: Some("k".into()),
                project_path: "/old/k".into(),
                cwd: None,
                provider: None,
                files: vec![
                    ManifestFile {
                        path: "sessions/0/agents/main/wire.jsonl".into(),
                        size_bytes: wire.len() as u64,
                        mtime_ms: 0,
                        md5: md5_hex(wire.as_bytes()),
                    },
                    ManifestFile {
                        path: "sessions/0/state.json".into(),
                        size_bytes: state.len() as u64,
                        mtime_ms: 0,
                        md5: md5_hex(state.as_bytes()),
                    },
                ],
                ccode: ManifestCcode {
                    pinned: false,
                    custom_title: None,
                    tags: vec![],
                    summary: None,
                },
            }],
        };
        let zip = write_zip_test(&dir, &man, files);
        let t = target.to_string_lossy().into_owned();
        let (report, _) = apply_at(
            &zip,
            &home,
            &[ImportDecisionDto {
                index: 0,
                skip: false,
                target_dir: Some(t.clone()),
            }],
        )
        .unwrap();
        assert_eq!(report.imported, 1, "{:?}", report.items);
        let index = fs::read_to_string(home.join(".kimi-code").join("session_index.jsonl")).unwrap();
        assert!(index.contains(id));
        assert!(index.contains(&t.replace('\\', "/")) || index.contains(&t));
        let state_got = fs::read_to_string(
            home.join(".kimi-code")
                .join("sessions")
                .join(kimi_wd_bucket(&t))
                .join(id)
                .join("state.json"),
        )
        .unwrap();
        assert!(state_got.contains("workDir"));
        assert!(!state_got.contains("/old/k"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_roundtrip_manifest_version() {
        let dir = tmp();
        let proj = dir.join("p");
        fs::create_dir_all(&proj).unwrap();
        // 不走真实 ~/.claude：直接测 rewrite / zip 结构
        let id = "44444444-4444-4444-4444-444444444444";
        let body = sample_claude(proj.to_str().unwrap(), id);
        let src = dir.join(format!("{id}.jsonl"));
        fs::write(&src, &body).unwrap();
        // 白名单拦真实 home 外文件，这里只测 pack 内部函数
        let packed = pack_files_for("claude-code", &src).unwrap();
        assert_eq!(packed.len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_allowed_rejects_outside() {
        let dir = tmp();
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();
        assert!(!write_allowed(&dir.join("etc").join("passwd"), &home));
        assert!(write_allowed(
            &home
                .join(".claude")
                .join("projects")
                .join("x")
                .join("a.jsonl"),
            &home
        ));
        fs::remove_dir_all(&dir).ok();
    }
}
