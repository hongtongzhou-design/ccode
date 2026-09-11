//! 项目知识仍是 Markdown；结构化块只记录人工确认、来源与替代关系，不自动采纳 Agent 结论。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

const OPEN: &str = "<!-- mesa-memory:";
const CLOSE: &str = "<!-- /mesa-memory -->";
const LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMeta {
    pub id: String,
    pub created_at: String,
    pub source_version: Option<String>,
    pub goal_name: String,
    pub state: String,
    pub replaces: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub files: Vec<crate::projects::ContentFingerprint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub meta: MemoryMeta,
    pub text: String,
    pub stale_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocument {
    pub revision: String,
    pub legacy_text: String,
    pub entries: Vec<MemoryEntry>,
}

fn revision(text: &str) -> String { format!("{:x}", Sha256::digest(text.as_bytes())) }

pub(crate) fn read_raw(root: &Path) -> Result<String, String> {
    let path = crate::projects::memory_path(root);
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("读取项目知识失败：{e}")),
    };
    let mut bytes = Vec::new();
    (&mut file).take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT { return Err("项目知识超过 2 MB，请先拆分归档，不会按空知识继续".into()); }
    String::from_utf8(bytes).map_err(|_| "项目知识不是 UTF-8 文本".into())
}

fn parse(text: &str) -> Result<MemoryDocument, String> {
    let mut entries = Vec::new();
    let mut legacy = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        legacy.push_str(&rest[..start]);
        let block = &rest[start + OPEN.len()..];
        let end_meta = block.find(" -->").ok_or("项目知识条目头损坏")?;
        let meta: MemoryMeta = serde_json::from_str(&block[..end_meta]).map_err(|e| format!("项目知识条目损坏：{e}"))?;
        let body = &block[end_meta + 4..];
        let end = body.find(CLOSE).ok_or("项目知识条目未闭合")?;
        if !matches!(meta.state.as_str(), "active" | "superseded" | "revoked") { return Err("未知项目知识状态".into()); }
        if entries.iter().any(|entry: &MemoryEntry| entry.meta.id == meta.id) { return Err("项目知识存在重复身份".into()); }
        entries.push(MemoryEntry { meta, text: body[..end].trim().into(), stale_paths: Vec::new() });
        rest = &body[end + CLOSE.len()..];
    }
    legacy.push_str(rest);
    Ok(MemoryDocument { revision: revision(text), legacy_text: legacy.trim().into(), entries })
}

fn render(doc: &MemoryDocument) -> Result<String, String> {
    let mut text = doc.legacy_text.trim().to_string();
    for entry in &doc.entries {
        text.push_str(&format!("\n\n{OPEN}{} -->\n{}\n{CLOSE}", serde_json::to_string(&entry.meta).map_err(|e| e.to_string())?, entry.text));
    }
    text.push('\n');
    if text.len() as u64 > LIMIT { return Err("项目知识超过 2 MB，未写入".into()); }
    Ok(text)
}

fn validate_text(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 32 * 1024 { return Err("知识内容不能为空且不得超过 32 KB".into()); }
    if text.contains(OPEN) || text.contains(CLOSE) { return Err("知识正文不能包含内部记录标记".into()); }
    Ok(text)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop { let n = input.read(&mut buf).map_err(|e| e.to_string())?; if n == 0 { break; } hash.update(&buf[..n]); }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn read_at(root: &Path) -> Result<MemoryDocument, String> {
    let mut doc = parse(&read_raw(root)?)?;
    for entry in &mut doc.entries {
        if entry.meta.state != "active" { continue; }
        for file in &entry.meta.files {
            let valid = !Path::new(&file.path).is_absolute()
                && !file.path.split(['/', '\\']).any(|p| matches!(p, ".." | "." | ""));
            let path = root.join(&file.path);
            let within = valid && crate::paths::canonicalize_plain(&path).ok().is_some_and(|p| crate::paths::path_within_path(&p, root));
            let matches = within && file.sha256.as_ref().is_some_and(|expected| hash_file(&path).ok().as_ref() == Some(expected));
            if !matches { entry.stale_paths.push(file.path.clone()); }
        }
    }
    Ok(doc)
}

pub(crate) fn context_at(root: &Path) -> Result<String, String> {
    let doc = read_at(root)?;
    let mut parts = Vec::new();
    for entry in doc.entries.iter().rev().filter(|entry| entry.meta.state == "active") {
        if entry.stale_paths.is_empty() {
            parts.push(format!("- {}（人工确认；来源 {}）", entry.text, entry.meta.source_version.as_deref().unwrap_or("手工确认")));
        } else {
            parts.push(format!("- 待重新确认的知识 {}：来源文件已变化（{}）；不得沿用为当前结论。", entry.meta.id, entry.stale_paths.join("、")));
        }
    }
    if !doc.legacy_text.is_empty() { parts.push(format!("旧知识原文（未逐条绑定证据，冲突时以最新人工确认内容为准）：\n{}", doc.legacy_text)); }
    Ok(parts.join("\n"))
}

fn write_at(root: &Path, before: &str, doc: &MemoryDocument) -> Result<(), String> {
    let text = render(doc)?;
    if !before.is_empty() {
        let backup = root.join(".ccode/memory-history").join(format!("{}.md", revision(before)));
        if !backup.exists() { crate::profiles::atomic_write(&backup, before)?; }
    }
    crate::profiles::atomic_write(&crate::projects::memory_path(root), &text)
}

pub(crate) fn append_confirmed(root: &Path, goal: &str, text: &str, version: Option<&str>) -> Result<(), String> {
    if text.trim().is_empty() { return Ok(()); }
    let text = validate_text(text)?;
    fs::create_dir_all(root.join(".ccode")).map_err(|e| e.to_string())?;
    let _lock = crate::storage::lock_at(&root.join(".ccode/memory.lock"))?;
    let before = read_raw(root)?;
    let mut doc = parse(&before)?;
    if let Some(version) = version {
        if doc.entries.iter().any(|e| e.meta.source_version.as_deref() == Some(version) && e.text == text)
            || before.contains(&format!("<!-- mesa-run:{version} -->")) { return Ok(()); }
    }
    let files = crate::projects::read_acceptance_log_at(root).into_iter().rev()
        .find(|e| Some(e.version_id.as_str()) == version && e.note.trim() == text)
        .map(|e| e.content_fingerprints).unwrap_or_default();
    doc.entries.push(MemoryEntry { meta: MemoryMeta {
        id: uuid::Uuid::new_v4().to_string(), created_at: crate::sessions::now_iso(), source_version: version.map(str::to_owned),
        goal_name: goal.into(), state: "active".into(), replaces: None, reason: "验收时人工确认".into(), files,
    }, text: text.into(), stale_paths: Vec::new() });
    write_at(root, &before, &doc)
}

fn update_at(root: &Path, expected: &str, id: Option<&str>, action: &str, text: &str, reason: &str) -> Result<MemoryDocument, String> {
    fs::create_dir_all(root.join(".ccode")).map_err(|e| e.to_string())?;
    let _lock = crate::storage::lock_at(&root.join(".ccode/memory.lock"))?;
    let before = read_raw(root)?;
    if revision(&before) != expected { return Err("项目知识已被修改，请重新读取后再确认".into()); }
    let mut doc = parse(&before)?;
    if !matches!(action, "add" | "replace" | "revoke") { return Err("未知知识操作".into()); }
    if reason.trim().is_empty() { return Err("请写明确认或作废的依据".into()); }
    if action != "revoke" { validate_text(text)?; }
    if action != "add" {
        let old = doc.entries.iter_mut().find(|e| Some(e.meta.id.as_str()) == id && e.meta.state == "active").ok_or("知识条目不存在或已失效")?;
        old.meta.state = if action == "revoke" { "revoked" } else { "superseded" }.into();
        old.meta.reason = reason.trim().into();
    }
    if action != "revoke" {
        doc.entries.push(MemoryEntry { meta: MemoryMeta {
            id: uuid::Uuid::new_v4().to_string(), created_at: crate::sessions::now_iso(), source_version: None, goal_name: "人工维护".into(),
            state: "active".into(), replaces: id.map(str::to_owned), reason: reason.trim().into(), files: Vec::new(),
        }, text: text.trim().into(), stale_paths: Vec::new() });
    }
    write_at(root, &before, &doc)?;
    read_at(root)
}

#[tauri::command]
pub fn project_memory_read(path: String) -> Result<MemoryDocument, String> {
    let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&path)))?;
    read_at(&root)
}

#[tauri::command]
pub fn project_memory_update(path: String, expected_revision: String, id: Option<String>, action: String, text: String, reason: String) -> Result<MemoryDocument, String> {
    let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&path)))?;
    update_at(&root, &expected_revision, id.as_deref(), &action, &text, &reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmed_memory_is_versioned_and_never_silently_revived() {
        let root = std::env::temp_dir().join(format!("mesa-memory-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        fs::write(crate::projects::memory_path(&root), "旧的手工笔记\n").unwrap();
        append_confirmed(&root, "目标", "旧结论", Some("run:1")).unwrap();
        append_confirmed(&root, "目标", "旧结论", Some("run:1")).unwrap();
        let doc = read_at(&root).unwrap();
        assert_eq!(doc.entries.len(), 1);
        let next = update_at(&root, &doc.revision, Some(&doc.entries[0].meta.id), "replace", "修正结论", "发现新证据").unwrap();
        assert!(update_at(&root, &doc.revision, None, "add", "失配", "旧窗口").is_err());
        let context = context_at(&root).unwrap();
        assert!(context.contains("修正结论") && !context.contains("旧结论") && context.contains("旧的手工笔记"));
        let newest = next.entries.last().unwrap();
        update_at(&root, &next.revision, Some(&newest.meta.id), "revoke", "", "不再成立").unwrap();
        assert!(!context_at(&root).unwrap().contains("修正结论"));
        assert!(root.join(".ccode/memory-history").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn damaged_memory_is_not_treated_as_empty() {
        let root = std::env::temp_dir().join(format!("mesa-memory-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(crate::projects::memory_path(&root)).unwrap();
        assert!(append_confirmed(&root, "目标", "结论", None).is_err());
        assert!(parse("<!-- mesa-memory:broken --> x").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
