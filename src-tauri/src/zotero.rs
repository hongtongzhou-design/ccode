//! Zotero 进料口（只读适配器）。
//!
//! 边界（架构 §10 v3.9「否决 Zotero 式文献库」）：**不做文献管理器**。这里只把用户已有的
//! Zotero 库当成一个**进料口**——读出来、转成流水线自己的产物格式（references.bib + papers/），
//! 之后一概走既有链路。Ccode 从不写 Zotero 的库，也不同步回去。
//!
//! 为什么读 sqlite 而不是调 Zotero 的本地 API：本地 API 要 Zotero 正在运行；
//! 用户多半是关着 Zotero 在写论文。读库文件则离线可用。
//! 使用 SQLite 在线备份读取一致的内存快照；超时失败，不落明文库副本。

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 一条可导入的 Zotero 条目（已归一为流水线需要的字段）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItemDto {
    /// Zotero item key（8 位大写字母数字），兼作 bib 键去重依据
    pub key: String,
    pub title: String,
    /// 作者姓氏列表（按 Zotero 顺序）
    pub creators: Vec<String>,
    /// 四位年份；解析不出为 None
    pub year: Option<String>,
    pub doi: Option<String>,
    pub publication: Option<String>,
    /// 已下载的 PDF 绝对路径（多个附件取第一个可读的）；无附件为 None
    pub pdf_path: Option<String>,
    /// Zotero 条目类型（journalArticle / thesis / book …）：决定 BibTeX 的条目类型
    pub item_type: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub library_id: i64,
}

/// 一个 Zotero 分类
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollectionDto {
    pub id: i64,
    pub name: String,
    /// 该分类下的条目数（含子条目，不含附件与笔记）
    pub count: i64,
}

/// 库探测结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroLibraryDto {
    /// zotero.sqlite 绝对路径
    pub db_path: String,
    /// storage 目录（附件按 <storage>/<itemKey>/<filename> 存放）
    pub storage_dir: String,
    pub collections: Vec<ZoteroCollectionDto>,
    /// 未分类在内的全部条目数
    pub total: i64,
}

/// 默认库位置（跨平台）：Zotero 7 默认 ~/Zotero
fn default_data_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("Zotero"));
        // Windows 旧版会放在 Documents 下
        out.push(home.join("Documents").join("Zotero"));
    }
    out
}

/// 找出可用的 Zotero 数据目录（含 zotero.sqlite）
fn locate_data_dir(explicit: Option<&str>) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = match explicit {
        Some(p) if !p.trim().is_empty() => {
            vec![PathBuf::from(crate::sessions::expand_tilde(p))]
        }
        _ => default_data_dirs(),
    };
    for dir in candidates {
        if dir.join("zotero.sqlite").is_file() {
            return Ok(dir);
        }
    }
    Err("没找到 Zotero 数据目录（默认 ~/Zotero）。可在导入时手动指定路径".into())
}

/// SQLite 在线备份得到一致的内存快照。只读源连接；忙/锁超时即失败，绝不退回裸复制。
fn open_snapshot(db_path: &Path) -> Result<Connection, String> {
    let source = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("只读打开 Zotero 库失败: {e}"))?;
    source
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let mut snapshot = Connection::open_in_memory().map_err(|e| e.to_string())?;
    {
        let backup = rusqlite::backup::Backup::new(&source, &mut snapshot)
            .map_err(|e| format!("建立 Zotero 一致快照失败: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match backup
                .step(1024)
                .map_err(|e| format!("读取 Zotero 快照失败: {e}"))?
            {
                rusqlite::backup::StepResult::Done => break,
                rusqlite::backup::StepResult::More => {
                    if Instant::now() >= deadline {
                        return Err(
                            "Zotero 库较大，未在时限内读完。请完全退出 Zotero 后重试。".into(),
                        );
                    }
                }
                _ => {
                    if Instant::now() >= deadline {
                        return Err(
                            "Zotero 正在写入库（开着或正在同步）。请完全退出 Zotero 后再导入，不要只是隐藏窗口。".into(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    snapshot
        .execute_batch("PRAGMA query_only = ON;")
        .map_err(|e| e.to_string())?;
    Ok(snapshot)
}

pub fn inspect_library(explicit_dir: Option<&str>) -> Result<ZoteroLibraryDto, String> {
    let dir = locate_data_dir(explicit_dir)?;
    let db_path = dir.join("zotero.sqlite");
    let conn = open_snapshot(&db_path)?;
    let result = (|| -> Result<ZoteroLibraryDto, String> {
        let mut stmt = conn
            .prepare(
                "SELECT c.collectionID, c.collectionName, \
                 (SELECT COUNT(*) FROM collectionItems ci \
                  JOIN items i ON i.itemID = ci.itemID \
                  JOIN itemTypes it ON it.itemTypeID = i.itemTypeID \
                  WHERE ci.collectionID = c.collectionID \
                    AND it.typeName NOT IN ('attachment','note') \
                    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)) \
                 FROM collections c ORDER BY c.collectionName",
            )
            .map_err(|e| format!("读取分类失败: {e}"))?;
        let collections = stmt
            .query_map([], |row| {
                Ok(ZoteroCollectionDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    count: row.get(2)?,
                })
            })
            .map_err(|e| format!("读取分类失败: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items i JOIN itemTypes it ON it.itemTypeID = i.itemTypeID \
                 WHERE it.typeName NOT IN ('attachment','note') \
                   AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(ZoteroLibraryDto {
            db_path: db_path.to_string_lossy().into_owned(),
            storage_dir: dir.join("storage").to_string_lossy().into_owned(),
            collections,
            total,
        })
    })();
    drop(conn);
    result
}

/// 从 Zotero 的 date 字段里抠四位年份。
/// 该字段是自由文本 + Zotero 自己的多段格式（如 "2025-12-00 12/2025"、"2024-00-00 2024"），
/// 不能当 ISO 日期解析，只取第一个四位数字。
fn extract_year(raw: &str) -> Option<String> {
    let bytes: Vec<char> = raw.chars().collect();
    for w in bytes.windows(4) {
        if w.iter().all(|c| c.is_ascii_digit()) {
            let y: String = w.iter().collect();
            // 合理年份区间，避免抓到卷号/页码
            if (1500..=2200).contains(&y.parse::<i32>().unwrap_or(0)) {
                return Some(y);
            }
        }
    }
    None
}

/// 读取条目（collection_id = None 表示整库）
pub fn read_items(
    explicit_dir: Option<&str>,
    collection_id: Option<i64>,
) -> Result<Vec<ZoteroItemDto>, String> {
    read_items_with_base(explicit_dir, collection_id, None)
}

fn read_items_with_base(
    explicit_dir: Option<&str>,
    collection_id: Option<i64>,
    linked_base: Option<&Path>,
) -> Result<Vec<ZoteroItemDto>, String> {
    let dir = locate_data_dir(explicit_dir)?;
    let conn = open_snapshot(&dir.join("zotero.sqlite"))?;
    let storage = dir.join("storage");
    let result = (|| -> Result<Vec<ZoteroItemDto>, String> {
        let base = "SELECT i.itemID, i.key, it.typeName, \
             MAX(CASE WHEN f.fieldName='title' THEN idv.value END), \
             MAX(CASE WHEN f.fieldName='date' THEN idv.value END), \
             MAX(CASE WHEN f.fieldName='DOI' THEN idv.value END), \
             MAX(CASE WHEN f.fieldName='publicationTitle' THEN idv.value END), i.libraryID \
             FROM items i \
             JOIN itemTypes it ON it.itemTypeID = i.itemTypeID \
             LEFT JOIN itemData id ON id.itemID = i.itemID \
             LEFT JOIN itemDataValues idv ON idv.valueID = id.valueID \
             LEFT JOIN fields f ON f.fieldID = id.fieldID \
             WHERE it.typeName NOT IN ('attachment','note') \
               AND i.itemID NOT IN (SELECT itemID FROM deletedItems)";
        let sql = match collection_id {
            Some(_) => format!(
                "{base} AND i.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID = ?1) \
                 GROUP BY i.itemID"
            ),
            None => format!("{base} GROUP BY i.itemID"),
        };
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("读取条目失败: {e}"))?;
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<(i64, ZoteroItemDto)> {
            let item_id: i64 = row.get(0)?;
            let date: Option<String> = row.get(4)?;
            Ok((
                item_id,
                ZoteroItemDto {
                    key: row.get(1)?,
                    item_type: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    title: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    creators: Vec::new(),
                    year: date.as_deref().and_then(extract_year),
                    doi: row.get(5)?,
                    publication: row.get(6)?,
                    pdf_path: None,
                    fields: BTreeMap::new(),
                    library_id: row.get(7)?,
                },
            ))
        };
        let rows: Vec<(i64, ZoteroItemDto)> = match collection_id {
            Some(cid) => stmt
                .query_map([cid], map_row)
                .map_err(|e| format!("读取条目失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取条目失败: {e}"))?,
            None => stmt
                .query_map([], map_row)
                .map_err(|e| format!("读取条目失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取条目失败: {e}"))?,
        };

        let mut out = Vec::with_capacity(rows.len());
        for (item_id, mut item) in rows {
            item.creators = read_creators(&conn, item_id);
            let mut fields = conn.prepare("SELECT f.fieldName, v.value FROM itemData d JOIN fields f ON f.fieldID=d.fieldID JOIN itemDataValues v ON v.valueID=d.valueID WHERE d.itemID=?1")
                .map_err(|e| e.to_string())?;
            item.fields = fields
                .query_map([item_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            item.pdf_path = find_pdf(&conn, &storage, item_id, linked_base);
            if !item.title.trim().is_empty() {
                out.push(item);
            }
        }
        out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(out)
    })();
    drop(conn);
    result
}

fn read_creators(conn: &Connection, item_id: i64) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT cr.lastName, cr.firstName FROM itemCreators ic \
         JOIN creators cr ON cr.creatorID = ic.creatorID \
         WHERE ic.itemID = ?1 ORDER BY ic.orderIndex",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([item_id], |row| {
        let last: String = row.get::<_, Option<String>>(0)?.unwrap_or_default();
        let first: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        Ok(if first.trim().is_empty() {
            last
        } else {
            format!("{last}, {first}")
        })
    })
    .map(|rows| {
        rows.filter_map(|r| r.ok())
            .filter(|s| !s.trim().is_empty())
            .collect()
    })
    .unwrap_or_default()
}

/// 找该条目已下载的 PDF。附件 path 有三种形态：
/// - `storage:<文件名>`（导入的副本）→ 实际落在 <storage>/<附件key>/<文件名>
/// - 绝对路径（linkMode=2 链接文件，ZotFile 等常见）→ 直接用
/// - `attachments:<相对路径>`：只在用户明确选择链接附件基目录后解析；拒绝越界。
fn find_pdf(
    conn: &Connection,
    storage: &Path,
    item_id: i64,
    linked_base: Option<&Path>,
) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT ai.key, a.path FROM itemAttachments a \
             JOIN items ai ON ai.itemID = a.itemID \
             WHERE a.parentItemID = ?1 AND a.contentType = 'application/pdf' \
               AND a.itemID NOT IN (SELECT itemID FROM deletedItems)",
        )
        .ok()?;
    let rows = stmt
        .query_map([item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })
        .ok()?;
    for (key, path) in rows.filter_map(|r| r.ok()) {
        if path.is_empty() {
            continue;
        }
        let candidate = if let Some(relative) = path.strip_prefix("attachments:") {
            let Some(base) = linked_base else {
                continue;
            };
            if Path::new(relative).is_absolute()
                || relative.replace('\\', "/").split('/').any(|p| p == "..")
            {
                continue;
            }
            let Ok(base) = crate::paths::canonicalize_plain(base) else {
                continue;
            };
            let Ok(candidate) = crate::paths::canonicalize_plain(&base.join(relative)) else {
                continue;
            };
            if !crate::paths::path_within_path(&candidate, &base) {
                continue;
            }
            candidate
        } else {
            match path.strip_prefix("storage:") {
                Some(name) if !name.is_empty() => storage.join(&key).join(name),
                Some(_) => continue,
                // 链接文件：库里存的就是绝对路径
                None => PathBuf::from(&path),
            }
        };
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Zotero 条目类型 → BibTeX 条目类型。全按 @article 会把学位论文/书籍标错，
/// 投稿时参考文献格式直接出错。未知类型回落 misc（诚实的「不知道」，不冒充期刊论文）
fn bib_entry_type(item_type: &str) -> &'static str {
    match item_type {
        "journalArticle" | "magazineArticle" | "newspaperArticle" => "article",
        "book" => "book",
        "bookSection" => "incollection",
        "conferencePaper" => "inproceedings",
        "thesis" => "phdthesis",
        "report" | "manuscript" | "preprint" => "techreport",
        "webpage" | "blogPost" => "online",
        "patent" => "patent",
        _ => "misc",
    }
}

/// 导出键采用稳定 Zotero 身份；主引用库已有键只由人工对账保留。
fn bib_key(item: &ZoteroItemDto) -> String {
    // Zotero library + item key 是稳定身份，不随标题修订、排序或同姓条目增减漂移。
    format!("zotero{}{}", item.library_id, item.key.to_ascii_lowercase())
}

/// 生成 BibTeX 全文。缺字段一律标「待补」而不是编造——与 lit-notes 技能同一口径。
fn bib_escape(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' | '%' | '_' | '#' | '{' | '}' | '$' => {
                out.push('\\');
                out.push(ch);
            }
            '\r' | '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out
}

pub fn render_bibtex(items: &[ZoteroItemDto]) -> String {
    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = String::from("% 由 Mesa 从 Zotero 导入生成；缺失字段标「待补」，未编造\n\n");
    for item in items {
        let base = bib_key(item);
        let n = used.entry(base.clone()).or_insert(0);
        *n += 1;
        let key = if *n == 1 {
            base
        } else {
            format!("{base}-{}", *n)
        };
        out.push_str(&format!("@{}{{{key},\n", bib_entry_type(&item.item_type)));
        out.push_str(&format!("  title = {{{}}},\n", bib_escape(&item.title)));
        let authors = if item.creators.is_empty() {
            "待补".to_string()
        } else {
            item.creators
                .iter()
                .map(|c| bib_escape(c))
                .collect::<Vec<_>>()
                .join(" and ")
        };
        out.push_str(&format!("  author = {{{authors}}},\n"));
        out.push_str(&format!(
            "  year = {{{}}},\n",
            item.year.clone().unwrap_or_else(|| "待补".into())
        ));
        // journal 只对期刊类有意义：学位论文/书籍写个「待补 journal」是噪音
        if bib_entry_type(&item.item_type) == "article" {
            out.push_str(&format!(
                "  journal = {{{}}},\n",
                bib_escape(item.publication.as_deref().unwrap_or("待补"))
            ));
        } else if !item.fields.contains_key("bookTitle")
            && !item.fields.contains_key("conferenceName")
        {
            if let Some(p) = &item.publication {
                if !p.trim().is_empty() {
                    out.push_str(&format!("  booktitle = {{{}}},\n", bib_escape(p)));
                }
            }
        }
        if let Some(doi) = &item.doi {
            if !doi.trim().is_empty() {
                out.push_str(&format!("  doi = {{{}}},\n", bib_escape(doi)));
            }
        }
        for (source, target) in [
            ("volume", "volume"),
            ("issue", "number"),
            ("pages", "pages"),
            ("url", "url"),
            ("ISBN", "isbn"),
            ("publisher", "publisher"),
            ("university", "school"),
            ("bookTitle", "booktitle"),
            ("conferenceName", "booktitle"),
        ] {
            if let Some(value) = item.fields.get(source).filter(|s| !s.trim().is_empty()) {
                out.push_str(&format!("  {target} = {{{}}},\n", bib_escape(value)));
            }
        }
        out.push_str("}\n\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, creators: &[&str], year: Option<&str>) -> ZoteroItemDto {
        ZoteroItemDto {
            key: "ABCD1234".into(),
            fields: BTreeMap::new(),
            library_id: 1,
            title: title.into(),
            creators: creators.iter().map(|s| (*s).to_string()).collect(),
            year: year.map(|s| s.to_string()),
            doi: None,
            publication: None,
            pdf_path: None,
            item_type: "journalArticle".into(),
        }
    }

    #[test]
    fn extract_year_handles_zotero_date_formats() {
        // Zotero 的 date 是自由文本 + 多段格式，不能当 ISO 解析
        assert_eq!(extract_year("2025-12-00 12/2025").as_deref(), Some("2025"));
        assert_eq!(extract_year("2024-00-00 2024").as_deref(), Some("2024"));
        assert_eq!(
            extract_year("2026-05-05 2026-05-05").as_deref(),
            Some("2026")
        );
        assert_eq!(extract_year("in press").as_deref(), None);
        // 不该把卷号/页码当年份
        assert_eq!(extract_year("vol. 12, pp. 3345").as_deref(), None);
    }

    #[test]
    fn bib_key_is_stable_and_ascii() {
        let i = item(
            "Transition Metal Borides for HER",
            &["Hong, Tongzhou"],
            Some("2025"),
        );
        assert_eq!(bib_key(&i), "zotero1abcd1234");
        // 无作者/无年份也要出得来键，不 panic
        let bare = item("某中文标题", &[], None);
        assert!(!bib_key(&bare).is_empty());
    }

    #[test]
    fn render_bibtex_dedupes_keys_and_marks_missing() {
        let items = vec![
            item("Alpha Study", &["Li, Wei"], Some("2024")),
            item("Alpha Study", &["Li, Wei"], Some("2024")),
            item("无作者的条目", &[], None),
        ];
        let bib = render_bibtex(&items);
        assert!(bib.contains("@article{zotero1abcd1234,"), "{bib}");
        // 同键第二条加后缀，不产生重复键
        assert!(bib.contains("@article{zotero1abcd1234-2,"), "{bib}");
        // 缺字段标「待补」，不编造
        assert!(bib.contains("author = {待补}"), "{bib}");
        assert!(bib.contains("year = {待补}"), "{bib}");
        assert!(!bib.contains("doi = {}"), "空 DOI 不该写出来: {bib}");
    }

    #[test]
    fn bib_entry_type_maps_beyond_articles() {
        // 全按 @article 会把学位论文/书籍标错，投稿时参考文献格式直接出错
        assert_eq!(bib_entry_type("journalArticle"), "article");
        assert_eq!(bib_entry_type("thesis"), "phdthesis");
        assert_eq!(bib_entry_type("book"), "book");
        assert_eq!(bib_entry_type("conferencePaper"), "inproceedings");
        assert_eq!(bib_entry_type("preprint"), "techreport");
        // 未知类型回落 misc，不冒充期刊论文
        assert_eq!(bib_entry_type("podcast"), "misc");
        assert_eq!(bib_entry_type(""), "misc");
    }

    #[test]
    fn render_bibtex_respects_item_type() {
        let mut thesis = item("某某方向研究", &["Hong, T"], Some("2026"));
        thesis.item_type = "thesis".into();
        thesis.publication = Some("某大学".into());
        let bib = render_bibtex(&[thesis]);
        assert!(bib.contains("@phdthesis{"), "{bib}");
        // 非期刊类不写 journal 字段（写个「待补 journal」是噪音）
        assert!(!bib.contains("journal ="), "{bib}");
        assert!(bib.contains("booktitle = {某大学}"), "{bib}");
    }

    #[test]
    fn locate_data_dir_rejects_missing() {
        assert!(locate_data_dir(Some("/definitely/not/here")).is_err());
    }

    #[test]
    fn online_snapshot_is_consistent_and_query_only() {
        let root =
            std::env::temp_dir().join(format!("mesa-zotero-snapshot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("zotero.sqlite");
        let mut source = Connection::open(&path).unwrap();
        source.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('committed');").unwrap();
        let tx = source.transaction().unwrap();
        tx.execute("UPDATE example SET value='uncommitted'", [])
            .unwrap();
        let snapshot = open_snapshot(&path).unwrap();
        assert_eq!(
            snapshot
                .query_row("SELECT value FROM example", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "committed"
        );
        assert!(snapshot.execute("DELETE FROM example", []).is_err());
        tx.rollback().unwrap();
        drop(snapshot);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_keep_resources_and_every_candidate_without_overwriting_main_bib() {
        let root =
            std::env::temp_dir().join(format!("mesa-zotero-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        fs::write(
            root.join(".ccode/project.toml"),
            "settings = [\"保留原始数据\"]\n",
        )
        .unwrap();
        let pdf = root.join("paper.pdf");
        fs::write(&pdf, "PDF fixture").unwrap();
        let mut paper = item("Example", &["Doe, Jane"], Some("2026"));
        paper.pdf_path = Some(pdf.to_string_lossy().into_owned());
        let first = import_items_at(&root, &[paper.clone()]).unwrap();
        assert_eq!(first.config.lit_source, "zotero");
        assert_eq!(first.pdf_count, 1);
        assert_eq!(
            first
                .config
                .resources
                .iter()
                .filter(|r| r.kind == "paper")
                .count(),
            1
        );
        let original = fs::read(root.join("references.bib")).unwrap();
        let second = import_items_at(&root, &[paper.clone()]).unwrap();
        let third = import_items_at(&root, &[paper]).unwrap();
        assert_ne!(second.bib_rel, third.bib_rel);
        assert!(root.join(&second.bib_rel).is_file());
        assert_eq!(fs::read(root.join("references.bib")).unwrap(), original);
        assert_eq!(
            third
                .config
                .resources
                .iter()
                .filter(|r| r.kind == "paper")
                .count(),
            1
        );
        assert!(third
            .config
            .resources
            .iter()
            .any(|r| r.path == second.bib_rel && r.kind == "reference"));
        assert!(third.config.settings.contains(&"保留原始数据".into()));
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(third.manifest_rel)).unwrap()).unwrap();
        assert_eq!(manifest[0]["id"], "1:ABCD1234");
        assert_eq!(manifest[0]["bibKey"], "zotero1abcd1234");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn title_changes_do_not_change_keys_and_export_preserves_metadata() {
        let mut paper = item("A & B_{test}", &["Doe, Jane"], Some("2026"));
        paper.fields.insert("volume".into(), "12".into());
        paper.fields.insert("pages".into(), "1--4".into());
        let key = bib_key(&paper);
        paper.title = "Corrected title".into();
        assert_eq!(bib_key(&paper), key);
        assert!(render_bibtex(&[paper]).contains("volume = {12}"));
        assert_eq!(bib_escape("A&B_{x}"), "A\\&B\\_\\{x\\}");
    }

    /// 实机验证（默认不跑：依赖本机真实 Zotero 库，CI 与他人机器上没有）。
    /// 手动跑：cargo test zotero -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_end_to_end() {
        let lib = match inspect_library(None) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("跳过：{e}");
                return;
            }
        };
        eprintln!("库：{} 条，分类 {} 个", lib.total, lib.collections.len());
        for c in &lib.collections {
            eprintln!("  [{}] {} — {} 条", c.id, c.name, c.count);
        }
        let items = read_items(None, lib.collections.first().map(|c| c.id)).unwrap();
        eprintln!("首个分类读出 {} 条", items.len());
        let with_pdf = items.iter().filter(|i| i.pdf_path.is_some()).count();
        let with_doi = items.iter().filter(|i| i.doi.is_some()).count();
        let with_year = items.iter().filter(|i| i.year.is_some()).count();
        eprintln!("  有 PDF {with_pdf} / 有 DOI {with_doi} / 有年份 {with_year}");
        for i in items.iter().take(3) {
            eprintln!(
                "  · {} | {} | {} | pdf={}",
                i.year.clone().unwrap_or_else(|| "?".into()),
                i.creators.first().cloned().unwrap_or_else(|| "?".into()),
                i.title.chars().take(50).collect::<String>(),
                i.pdf_path.is_some()
            );
        }
        let bib = render_bibtex(&items);
        eprintln!(
            "--- bib 前 400 字 ---\n{}",
            bib.chars().take(400).collect::<String>()
        );
        // 硬断言：键唯一（重复键会让 bib-check 全线误报）
        let keys: Vec<&str> = bib
            .lines()
            .filter_map(|l| l.strip_prefix("@article{"))
            .filter_map(|l| l.strip_suffix(','))
            .collect();
        let uniq: std::collections::HashSet<&&str> = keys.iter().collect();
        assert_eq!(keys.len(), uniq.len(), "bib 键必须唯一");
        assert!(!items.is_empty(), "首个分类不该是空的");

        // 整库路径单独验一遍：PDF 多半挂在未分类条目上，
        // 只测某个分类会漏掉 find_pdf 这条链路（实测 references 分类下 0 个 PDF，
        // 而库里有 4 个——附件的父条目不在任何分类里）
        let all = read_items(None, None).unwrap();
        let all_pdf = all.iter().filter(|i| i.pdf_path.is_some()).count();
        eprintln!("整库 {} 条，其中带 PDF {} 条", all.len(), all_pdf);
        for i in all.iter().filter(|i| i.pdf_path.is_some()).take(3) {
            let p = i.pdf_path.as_deref().unwrap();
            eprintln!("  pdf: {p}");
            assert!(
                std::path::Path::new(p).is_file(),
                "find_pdf 返回的路径必须真实存在: {p}"
            );
        }
        assert!(all.len() >= items.len(), "整库不该少于单个分类");
    }
}

// ===== Tauri commands =====

/// 导入结果：写了哪些文件、多少条、多少 PDF
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroImportDto {
    /// references.bib 相对项目根路径
    pub bib_rel: String,
    pub item_count: usize,
    /// 已登记为项目资源的 PDF 数
    pub pdf_count: usize,
    /// 无 PDF 附件的条目数（这些进 papers/to-fetch.md 的候选，由 agent 后续处理）
    pub missing_pdf: usize,
    pub config: crate::projects::ProjectConfigDto,
    pub manifest_rel: String,
}

#[tauri::command]
pub async fn zotero_inspect(data_dir: Option<String>) -> Result<ZoteroLibraryDto, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_library(data_dir.as_deref()))
        .await
        .map_err(|e| format!("读取 Zotero 库失败: {e}"))?
}

#[tauri::command]
pub async fn zotero_items(
    data_dir: Option<String>,
    collection_id: Option<i64>,
) -> Result<Vec<ZoteroItemDto>, String> {
    tauri::async_runtime::spawn_blocking(move || read_items(data_dir.as_deref(), collection_id))
        .await
        .map_err(|e| format!("读取 Zotero 条目失败: {e}"))?
}

/// 导入选定分类到项目：生成 references.bib，并把已下载的 PDF 按**绝对路径**登记为项目资源。
///
/// PDF 只登记不复制（机制一「资料只记位置不复制」）：Zotero 的 storage 才是权威副本，
/// 复制一份进项目只会产生两份会各自漂移的文件。TASK.md 的「项目资源」段给绝对路径，
/// agent 直读即可。
#[tauri::command]
pub async fn zotero_import(
    project_root: String,
    data_dir: Option<String>,
    collection_id: Option<i64>,
    linked_attachment_base: Option<String>,
) -> Result<ZoteroImportDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        let linked = linked_attachment_base
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(Path::new);
        if linked.is_some_and(|p| !p.is_dir()) {
            return Err("链接附件基目录不存在".into());
        }
        let items = read_items_with_base(data_dir.as_deref(), collection_id, linked)?;
        if items.is_empty() {
            return Err("这个分类下没有可导入的条目".into());
        }
        import_items_at(&root, &items)
    })
    .await
    .map_err(|e| format!("导入 Zotero 失败: {e}"))?
}

fn import_items_at(root: &Path, items: &[ZoteroItemDto]) -> Result<ZoteroImportDto, String> {
    let _guard = crate::projects::project_config_lock(root)?;
    let read = crate::projects::read_config_at(root);
    // validate_step 的「步骤…」是输入/交付提示，导入本来就是为补齐输入；解析错误才拒写。
    let parse_warnings: Vec<_> = read
        .warnings
        .iter()
        .filter(|w| !w.starts_with("步骤「"))
        .collect();
    if !parse_warnings.is_empty() {
        return Err(format!(
            "项目配置需先修复：{}",
            parse_warnings
                .into_iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    let mut cfg = read.config;
    let batch = uuid::Uuid::new_v4().to_string();
    let bib_rel = if root.join("references.bib").exists() {
        format!("papers/imports/zotero-{batch}.bib")
    } else {
        "references.bib".to_string()
    };
    let manifest_rel = format!("papers/imports/zotero-{batch}.json");
    for relative in [&bib_rel, &manifest_rel] {
        let mut path = root.to_path_buf();
        for part in Path::new(relative).components() {
            path.push(part);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("导入路径经过符号链接，未写入".into());
            }
        }
    }
    crate::profiles::atomic_write(&root.join(&bib_rel), &render_bibtex(items))?;
    let rows: Vec<_> = items
        .iter()
        .map(|item| {
            serde_json::json!({
                "id": format!("{}:{}", item.library_id, item.key), "title": item.title,
                "bibKey": bib_key(item), "doi": item.doi, "pdfPath": item.pdf_path,
                "status": if bib_rel == "references.bib" { "imported" } else { "pending-merge" }
            })
        })
        .collect();
    crate::profiles::atomic_write(
        &root.join(&manifest_rel),
        &serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?,
    )?;
    let mut known: std::collections::HashSet<String> = cfg
        .resources
        .iter()
        .map(|r| r.path.replace('\\', "/"))
        .collect();
    let mut pdf_count = 0;
    for item in items {
        if let Some(path) = item
            .pdf_path
            .as_ref()
            .filter(|p| known.insert(p.replace('\\', "/")))
        {
            cfg.resources.push(crate::projects::ResourceDto {
                name: item.title.clone(),
                path: path.clone(),
                kind: "paper".into(),
                readonly: true,
                note: format!("Zotero {}:{}", item.library_id, item.key),
            });
            pdf_count += 1;
        }
    }
    if known.insert(bib_rel.clone()) {
        cfg.resources.push(crate::projects::ResourceDto {
            name: "Zotero 题录（保留已有引用键，先对账再合并）".into(),
            path: bib_rel.clone(),
            kind: "reference".into(),
            readonly: true,
            note: format!("条目/PDF 映射：{manifest_rel}；重复导入不自动改主引用库"),
        });
    }
    cfg.lit_source = "zotero".into();
    crate::projects::write_config_at(root, &cfg)?;
    Ok(ZoteroImportDto {
        bib_rel,
        item_count: items.len(),
        pdf_count,
        missing_pdf: items.iter().filter(|i| i.pdf_path.is_none()).count(),
        config: cfg,
        manifest_rel,
    })
}
