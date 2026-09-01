//! 引用健康检查（评审可信度证据）：扫描目录下 .md 文件中的 Quarto/Pandoc 引用键
//!（`[@key]` / `[@k1; @k2]` / `[-@key]`），对照 references.bib 的条目键给出可解析统计。
//! 纯只读扫描，不走 AI；路径口径同 pdf.rs——canonicalize 后必须落在注册项目根或
//! 工作区工作树/主仓内。

use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 扫描上限：防巨型目录拖慢评审打开（超出部分不计入统计，宁缺勿滥）
const MAX_MD_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CitationHealthDto {
    /// 文中出现的去重引用键总数
    pub total_refs: usize,
    /// 在 bib 中找到条目的键数
    pub resolved: usize,
    /// bib 中缺失的键（排序去重）
    pub missing: Vec<String>,
    /// 是否找到 references.bib（根目录或 manuscript/ 下）
    pub bib_found: bool,
}

/// 提取一段 markdown 文本里的引用键（去重排序）：
/// 只认方括号引用段，段内按分号拆多键，键名允许字母数字与 `_- . :`
pub(crate) fn extract_cite_keys(text: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(']') else { break };
        let seg = &after[..close];
        // 引用段不含嵌套 '['：含了说明前面的 '[' 是未闭合的普通括号，越过它继续找
        if seg.contains('[') {
            rest = after;
            continue;
        }
        if seg.contains('@') {
            for part in seg.split(';') {
                let part = part.trim();
                // 抑制引用 [-@key]：剥前导减号后与正常引用同口径
                let part = part.strip_prefix('-').unwrap_or(part);
                let Some(rest_key) = part.strip_prefix('@') else {
                    continue;
                };
                let key: String = rest_key
                    .chars()
                    .take_while(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':')
                    })
                    .collect();
                if !key.is_empty() {
                    keys.insert(key);
                }
            }
        }
        rest = &after[close + 1..];
    }
    keys
}

/// 提取 bib 文本的条目键：`@类型{键,`（@comment/@preamble 等非条目行的伪键无害——
/// 只有被正文引用的键才参与比对）
pub(crate) fn extract_bib_keys(text: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for line in text.lines() {
        let t = line.trim_start();
        if !t.starts_with('@') {
            continue;
        }
        let Some(open) = t.find('{') else { continue };
        let key: String = t[open + 1..]
            .chars()
            .take_while(|c| *c != ',')
            .collect();
        let key = key.trim();
        if !key.is_empty() {
            keys.insert(key.to_string());
        }
    }
    keys
}

/// 递归收集 .md 文件：跳过隐藏目录（.git 等）与 node_modules，数量/单文件大小有界
fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_MD_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_MD_FILES {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            collect_md_files(&path, out);
        } else if name.to_lowercase().ends_with(".md") && meta.len() <= MAX_FILE_BYTES {
            out.push(path);
        }
    }
}

/// references.bib 定位：根目录优先，其次 manuscript/ 下
fn find_bib(root: &Path) -> Option<PathBuf> {
    for candidate in [root.join("references.bib"), root.join("manuscript").join("references.bib")] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn check_citation_health_sync(path: &str) -> Result<CitationHealthDto, String> {
    let root = PathBuf::from(crate::sessions::expand_tilde(path))
        .canonicalize()
        .map_err(|e| format!("目录不存在或不可读: {e}"))?;
    if !root.is_dir() {
        return Err("引用健康检查的目标必须是目录".into());
    }
    // 白名单（同 pdf.rs 口径）：注册项目根 / 工作区工作树 / 工作区主仓；来源失败静默跳过（宁缺勿滥）
    let canon = |p: &PathBuf| p.canonicalize().ok();
    let mut roots: Vec<PathBuf> = crate::projects::project_roots_and_resources()
        .0
        .iter()
        .filter_map(canon)
        .collect();
    roots.extend(
        crate::workspaces::worktree_rows()
            .into_iter()
            .flat_map(|w| [w.worktree_path, w.repo_path])
            .filter_map(|p| canon(&PathBuf::from(p))),
    );
    if !roots
        .iter()
        .any(|r| crate::paths::path_within_path(&root, r))
    {
        return Err("路径不在项目/工作区范围内，拒绝扫描".into());
    }

    let mut md_files = Vec::new();
    collect_md_files(&root, &mut md_files);
    let mut cited = BTreeSet::new();
    for f in &md_files {
        if let Ok(text) = fs::read_to_string(f) {
            cited.extend(extract_cite_keys(&text));
        }
    }

    let bib = find_bib(&root);
    let bib_keys = bib
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|text| extract_bib_keys(&text))
        .unwrap_or_default();
    let missing: Vec<String> = cited
        .iter()
        .filter(|k| !bib_keys.contains(*k))
        .cloned()
        .collect();
    Ok(CitationHealthDto {
        total_refs: cited.len(),
        resolved: cited.len() - missing.len(),
        missing,
        bib_found: bib.is_some(),
    })
}

#[tauri::command]
pub async fn check_citation_health(path: String) -> Result<CitationHealthDto, String> {
    tauri::async_runtime::spawn_blocking(move || check_citation_health_sync(&path))
        .await
        .map_err(|e| format!("引用健康检查失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_supports_multi_key_and_suppressed() {
        let text = "参见 [@doe2020] 与 [@smith21; @lee2022]，以及抑制引用 [-@hidden9]。\n\
                    普通链接 [text](https://x) 与脚注 [^1] 不算；行尾定位 [@key2, p. 33] 只取键。";
        let keys = extract_cite_keys(text);
        assert_eq!(
            keys.into_iter().collect::<Vec<_>>(),
            vec!["doe2020", "hidden9", "key2", "lee2022", "smith21"]
        );
    }

    #[test]
    fn extract_ignores_malformed_segments() {
        // 口径保守：项必须以 [-]@key 起头，带前缀的 [cf. @a1] 与空键 [@]/[@;] 都不收
        assert!(extract_cite_keys("[cf. @a1] [@] [@;]").is_empty());
        // 未闭合的方括号段不吞掉后面的正常引用
        let keys = extract_cite_keys("[@open 后面没有闭合\n正常 [@closed1]");
        assert_eq!(keys.into_iter().collect::<Vec<_>>(), vec!["closed1"]);
    }

    #[test]
    fn bib_keys_parse_entry_heads() {
        let bib = "@article{doe2020,\n  title={X}\n}\n\n@book{lee2022, title={Y}}\n% @comment 行\n";
        let keys = extract_bib_keys(bib);
        assert!(keys.contains("doe2020"));
        assert!(keys.contains("lee2022"));
        assert_eq!(keys.len(), 2);
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-cite-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 白名单外直接拒绝；白名单内的统计逻辑用纯函数级测试覆盖（db 依赖本机配置目录）
    #[test]
    fn rejects_path_outside_whitelist() {
        let dir = tmpdir("outside");
        fs::write(dir.join("a.md"), "[@x]").unwrap();
        let err = check_citation_health_sync(dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("拒绝扫描"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn walk_skips_hidden_and_node_modules() {
        let dir = tmpdir("walk");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::create_dir_all(dir.join("manuscript")).unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        fs::write(dir.join(".git").join("b.md"), "").unwrap();
        fs::write(dir.join("node_modules").join("c.md"), "").unwrap();
        fs::write(dir.join("manuscript").join("d.md"), "").unwrap();
        let mut out = Vec::new();
        collect_md_files(&dir, &mut out);
        let mut names: Vec<String> = out
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.md", "d.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bib_lookup_prefers_root_then_manuscript() {
        let dir = tmpdir("bibloc");
        assert!(find_bib(&dir).is_none());
        fs::create_dir_all(dir.join("manuscript")).unwrap();
        fs::write(dir.join("manuscript").join("references.bib"), "").unwrap();
        assert!(find_bib(&dir).unwrap().ends_with("manuscript/references.bib"));
        fs::write(dir.join("references.bib"), "").unwrap();
        assert_eq!(find_bib(&dir).unwrap(), dir.join("references.bib"));
        let _ = fs::remove_dir_all(&dir);
    }
}
