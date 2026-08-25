//! 期刊指标表（IF / 中科院分区 / TOP）：供文献雷达命中条目显示期刊徽章。
//!
//! 数据源是用户本机两份 CSV（从 github.com/hitfyd/ShowJCR 下载，不随应用分发）：
//! - `dirs::config_dir()/ccode/journal-metrics/JCR2025-UTF8.csv`：JCR 影响因子
//!   （表头 `Journal,ISSN,...,IF(2025),Category_1,...`，字段可能带引号逗号，必须正经 CSV 解析）
//! - `dirs::config_dir()/ccode/journal-metrics/FQBJCR2025-UTF8.csv`：中科院分区表
//!   （表头含 `大类分区`（形如 `3 [168/495]`，取开头数字）与 `Top`（是/否））
//!
//! 两表按「期刊名规范化」（复用 lit_watch::normalize_title：去非字母数字 + 小写）合并成一张
//! HashMap，进程内缓存（4MB+2.7MB 不能每次 list 都重解析），下载完成后 invalidate_cache。
//! 表文件不存在时整个模块静默表现为「无数据」（lookup 恒 None、status.available=false），不报错；
//! 查询只做规范化后的精确匹配，miss 诚实返回 None，不做模糊匹配。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

/// JCR 表文件名 / 中科院分区表文件名（固定名，下载与读取共用）
const JCR_FILE: &str = "JCR2025-UTF8.csv";
const FQB_FILE: &str = "FQBJCR2025-UTF8.csv";
/// 下载总超时（含连接）：本机访问 GitHub 慢，两份 CSV 给足余量
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(240);
/// ShowJCR 仓库内 CSV 所在目录名（URL 编码后）
const REMOTE_DIR: &str =
    "%E4%B8%AD%E7%A7%91%E9%99%A2%E5%88%86%E5%8C%BA%E8%A1%A8%E5%8F%8AJCR%E5%8E%9F%E5%A7%8B%E6%95%B0%E6%8D%AE%E6%96%87%E4%BB%B6";

// ===== DTO（camelCase，风格同 lit_watch.rs） =====

/// 单刊合并指标（两表任一命中即返回）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsDto {
    /// JCR2025 IF 原样字符串（如 "29.1"）；JCR 表没有该刊为 None
    pub impact_factor: Option<String>,
    /// 中科院升级版大类分区 1-4；FQB 表没有该刊为 None
    pub cas_quartile: Option<u8>,
    /// 中科院 Top 期刊标记（Top=是）
    pub top: bool,
}

/// journal_metrics_status 返回：表是否可用 + 合并后总刊数
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsStatusDto {
    /// 至少一张表存在且能解析出条目
    pub available: bool,
    /// 合并后总刊数
    pub journal_count: u32,
    /// 本地表下载时间（RFC3339；两份 CSV 取较新的 mtime），未装为 None
    pub downloaded_at: Option<String>,
}

/// check_journal_metrics_update 返回：上游 ShowJCR 数据目录最近一次 commit 时间
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalMetricsUpdateDto {
    /// 上游数据目录最近 commit 时间（RFC3339）
    pub upstream_updated_at: Option<String>,
    /// 上游比本地表新（本地未装恒 false——未装时按钮本来就是「下载」态）
    pub has_update: bool,
}

// ===== 加载与缓存 =====

fn metrics_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("ccode").join("journal-metrics"))
}

/// 表缓存：RwLock<Option<Arc<..>>> 而非 OnceLock——下载完成后要 invalidate 重建
static TABLE_CACHE: RwLock<Option<Arc<HashMap<String, JournalMetricsDto>>>> = RwLock::new(None);

/// 下载完成后清缓存（下次 lookup 重新解析）
pub(crate) fn invalidate_cache() {
    if let Ok(mut guard) = TABLE_CACHE.write() {
        *guard = None;
    }
}

/// 取合并表（首次调用时解析磁盘文件；文件不存在/解析失败按空表处理，不报错）
fn table() -> Arc<HashMap<String, JournalMetricsDto>> {
    if let Ok(guard) = TABLE_CACHE.read() {
        if let Some(t) = guard.as_ref() {
            return t.clone();
        }
    }
    let loaded = Arc::new(load_from_disk());
    if let Ok(mut guard) = TABLE_CACHE.write() {
        *guard = Some(loaded.clone());
    }
    loaded
}

fn load_from_disk() -> HashMap<String, JournalMetricsDto> {
    let mut map: HashMap<String, JournalMetricsDto> = HashMap::new();
    let Some(dir) = metrics_dir() else {
        return map;
    };
    if let Ok(text) = fs::read_to_string(dir.join(JCR_FILE)) {
        parse_jcr(&text, &mut map);
    }
    if let Ok(text) = fs::read_to_string(dir.join(FQB_FILE)) {
        parse_fqb(&text, &mut map);
    }
    map
}

// ===== 解析（注入文本，便于单测） =====

/// 在表头里找列位置；IF 列名随年份变化（`IF(2025)`），按前缀匹配
fn col_index(headers: &csv::StringRecord, exact: &str, prefix_fallback: Option<&str>) -> Option<usize> {
    headers
        .iter()
        .position(|h| h == exact)
        .or_else(|| prefix_fallback.and_then(|p| headers.iter().position(|h| h.starts_with(p))))
}

/// 取/建合并条目：key 为规范化期刊名（空名跳过整行）
fn entry_for<'a>(
    map: &'a mut HashMap<String, JournalMetricsDto>,
    journal: &str,
) -> Option<&'a mut JournalMetricsDto> {
    let key = crate::lit_watch::normalize_title(journal.trim());
    if key.is_empty() {
        return None;
    }
    Some(map.entry(key).or_insert_with(|| JournalMetricsDto {
        impact_factor: None,
        cas_quartile: None,
        top: false,
    }))
}

/// 解析 JCR 表：填 impact_factor（空串按 None）
fn parse_jcr(text: &str, map: &mut HashMap<String, JournalMetricsDto>) {
    // flexible：允许行尾列数不齐，坏行跳过不整体失败
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(text.as_bytes());
    let Ok(headers) = rdr.headers() else { return };
    let Some(i_journal) = col_index(headers, "Journal", None) else { return };
    let Some(i_if) = col_index(headers, "IF(2025)", Some("IF(")) else { return };
    for rec in rdr.records().flatten() {
        let (Some(journal), Some(impact)) = (rec.get(i_journal), rec.get(i_if)) else {
            continue;
        };
        let impact = impact.trim();
        if impact.is_empty() {
            continue;
        }
        if let Some(e) = entry_for(map, journal) {
            e.impact_factor = Some(impact.to_string());
        }
    }
}

/// 大类分区字段形如 `3 [168/495]`：取开头数字 1-4
fn parse_cas_quartile(field: &str) -> Option<u8> {
    field
        .split_whitespace()
        .next()?
        .parse::<u8>()
        .ok()
        .filter(|q| (1..=4).contains(q))
}

/// 解析中科院分区表：填 cas_quartile / top
fn parse_fqb(text: &str, map: &mut HashMap<String, JournalMetricsDto>) {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(text.as_bytes());
    let Ok(headers) = rdr.headers() else { return };
    let (Some(i_journal), Some(i_quartile), Some(i_top)) = (
        col_index(headers, "Journal", None),
        col_index(headers, "大类分区", None),
        col_index(headers, "Top", None),
    ) else {
        return;
    };
    for rec in rdr.records().flatten() {
        let Some(journal) = rec.get(i_journal) else { continue };
        let quartile = rec.get(i_quartile).and_then(parse_cas_quartile);
        let top = rec.get(i_top).is_some_and(|t| t.trim() == "是");
        // 两列都空（分区表尾部空行等）就不建条目
        if quartile.is_none() && !top {
            continue;
        }
        if let Some(e) = entry_for(map, journal) {
            e.cas_quartile = quartile;
            e.top = top;
        }
    }
}

// ===== 查询 =====

/// 规范化后的精确匹配（注入表，便于单测）；miss 时逐级剥掉末尾的出版商括号尾巴
/// （巡检来源常写成「Advanced Functional Materials (Wiley)」「…（ACS）」，表里没有这截）再重试
fn lookup_in(table: &HashMap<String, JournalMetricsDto>, journal_name: &str) -> Option<JournalMetricsDto> {
    let mut name = journal_name.trim().to_string();
    loop {
        let key = crate::lit_watch::normalize_title(&name);
        if !key.is_empty() {
            if let Some(m) = table.get(&key) {
                return Some(m.clone());
            }
        }
        match strip_trailing_paren(&name) {
            Some(rest) => name = rest,
            None => return None,
        }
    }
}

/// 剥掉末尾括号段（半角/全角，可多级），返回剩余部分；没有可剥的返回 None
fn strip_trailing_paren(name: &str) -> Option<String> {
    let t = name.trim_end();
    let open = if t.ends_with(')') {
        '('
    } else if t.ends_with('）') {
        '（'
    } else {
        return None;
    };
    let idx = t.rfind(open)?;
    let rest = t[..idx].trim();
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

/// 文献雷达 enrichment 用：规范化精确匹配，miss / 无表文件返回 None
pub(crate) fn lookup(journal_name: &str) -> Option<JournalMetricsDto> {
    lookup_in(&table(), journal_name)
}

/// 本地表的下载时间：两份 CSV 的 mtime 取较新者（原子落盘即刷新 mtime，无需另记 meta）
fn local_downloaded_at() -> Option<String> {
    let dir = metrics_dir()?;
    let mut newest: Option<std::time::SystemTime> = None;
    for name in [JCR_FILE, FQB_FILE] {
        if let Ok(mtime) = fs::metadata(dir.join(name)).and_then(|m| m.modified()) {
            newest = Some(newest.map_or(mtime, |cur| cur.max(mtime)));
        }
    }
    newest.map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
}

fn compute_status() -> JournalMetricsStatusDto {
    let any_file = metrics_dir().is_some_and(|d| d.join(JCR_FILE).exists() || d.join(FQB_FILE).exists());
    let t = table();
    JournalMetricsStatusDto {
        available: any_file && !t.is_empty(),
        journal_count: t.len() as u32,
        downloaded_at: local_downloaded_at(),
    }
}

// ===== 下载 =====

/// 下载一份 CSV：先 jsDelivr CDN，失败回落 raw.githubusercontent（本机访问 GitHub 慢）。
/// reqwest 用法与 lit_watch::fetch_pdf_bytes 同口径（UA、超时、状态码检查）。
async fn fetch_csv(file_name: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent("Ccode journal-metrics (https://github.com/hongtongzhou-design/ccode)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let urls = [
        format!("https://cdn.jsdelivr.net/gh/hitfyd/ShowJCR@master/{REMOTE_DIR}/{file_name}"),
        format!("https://raw.githubusercontent.com/hitfyd/ShowJCR/master/{REMOTE_DIR}/{file_name}"),
    ];
    let mut last_err = String::new();
    for url in &urls {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .bytes()
                    .await
                    .map(|b| b.to_vec())
                    .map_err(|e| format!("读取下载内容失败: {e}"));
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = format!("{e}"),
        }
    }
    Err(format!("下载 {file_name} 失败（CDN 与 GitHub 均不可达）: {last_err}"))
}

/// 落盘：先写 .tmp 再原子改名（同 lit_watch 下载口径）
fn save_csv(dir: &PathBuf, file_name: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let tmp = dir.join(format!("{file_name}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, dir.join(file_name)).map_err(|e| format!("改名落盘失败: {e}"))?;
    Ok(())
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn journal_metrics_status() -> Result<JournalMetricsStatusDto, String> {
    tauri::async_runtime::spawn_blocking(compute_status)
        .await
        .map_err(|e| format!("读取期刊指标状态失败: {e}"))
}

#[tauri::command]
pub async fn download_journal_metrics() -> Result<JournalMetricsStatusDto, String> {
    let mut downloads: Vec<(&str, Vec<u8>)> = Vec::new();
    for name in [JCR_FILE, FQB_FILE] {
        let bytes = fetch_csv(name).await?;
        downloads.push((name, bytes));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = metrics_dir().ok_or("无法定位应用数据目录")?;
        for (name, bytes) in &downloads {
            save_csv(&dir, name, bytes)?;
        }
        invalidate_cache();
        Ok(compute_status())
    })
    .await
    .map_err(|e| format!("保存期刊指标表失败: {e}"))?
}

// ===== 上游更新检查 =====

/// 更新检查超时：只取一条 commit 元数据，比整表下载轻得多
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 从 GitHub commits API 响应提取最近 commit 时间（注入文本，便于单测）；
/// 按数据目录查（path=目录），两份 CSV 任一有 commit 都算上游动过
fn parse_upstream_commit_date(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let date = v
        .as_array()?
        .first()?
        .get("commit")?
        .get("committer")?
        .get("date")?
        .as_str()?;
    Some(date.to_string())
}

/// 上游是否比本地表新：两边时间都能解析才比较，解析失败按「无新版」（不虚构提醒）
fn upstream_is_newer(upstream: &str, local: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(upstream),
        chrono::DateTime::parse_from_rfc3339(local),
    ) {
        (Ok(u), Ok(l)) => u > l,
        _ => false,
    }
}

/// 查上游 ShowJCR 仓库数据目录最近一次 commit，与本地表下载时间比对。
/// 失败（网络/限流）返回 Err，前端静默吞掉——更新提示是增强信息，不打扰主功能。
#[tauri::command]
pub async fn check_journal_metrics_update() -> Result<JournalMetricsUpdateDto, String> {
    let client = reqwest::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .user_agent("Ccode journal-metrics (https://github.com/hongtongzhou-design/ccode)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let url =
        format!("https://api.github.com/repos/hitfyd/ShowJCR/commits?path={REMOTE_DIR}&per_page=1");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("查询上游更新失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("查询上游更新失败: HTTP {}", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取上游响应失败: {e}"))?;
    let upstream = parse_upstream_commit_date(&body);
    let has_update = match (&upstream, local_downloaded_at()) {
        (Some(up), Some(local)) => upstream_is_newer(up, &local),
        _ => false,
    };
    Ok(JournalMetricsUpdateDto {
        upstream_updated_at: upstream,
        has_update,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const JCR_SAMPLE: &str = "\
Journal,ISSN,EISSN,Web of Science,IF(2025),Category_1,IF Quartile(2025)_1,IF Rank(2025)_1
CA-A CANCER JOURNAL FOR CLINICIANS,0007-9235,1542-4863,SCIE,685.2,ONCOLOGY,Q1,1/333
Advanced Materials,0935-9648,1521-4095,SCIE,29.1,\"MATERIALS SCIENCE, MULTIDISCIPLINARY\",Q1,10/460
No Impact Journal,0000-0000,,ESCI,,CHEMISTRY,Q4,300/301
";

    const FQB_SAMPLE: &str = "\
Journal,年份,ISSN/EISSN,Review,OA Journal Index（OAJ）,Open Access,Web of Science,标注,大类,大类分区,Top,小类1,小类1分区
2D Materials,2025,2053-1583/2053-1583,否,否,否,SCIE,,材料科学,3 [168/495],否,\" MATERIALS SCIENCE, MULTIDISCIPLINARY 材料科学：综合\",3 [168/436]
Advanced Materials,2025,0935-9648/1521-4095,否,否,否,SCIE,,材料科学,1 [8/495],是, MATERIALS SCIENCE 材料科学,1 [8/436]
";

    fn merged() -> HashMap<String, JournalMetricsDto> {
        let mut map = HashMap::new();
        parse_jcr(JCR_SAMPLE, &mut map);
        parse_fqb(FQB_SAMPLE, &mut map);
        map
    }

    #[test]
    fn parses_upstream_commit_date() {
        let body = r#"[{"sha":"abc","commit":{"author":{"date":"2025-06-20T01:02:03Z"},"committer":{"date":"2025-06-21T04:05:06Z"}}}]"#;
        assert_eq!(
            parse_upstream_commit_date(body).as_deref(),
            Some("2025-06-21T04:05:06Z")
        );
        // 空数组 / 非 JSON / 缺字段都诚实 None
        assert_eq!(parse_upstream_commit_date("[]"), None);
        assert_eq!(parse_upstream_commit_date("not json"), None);
        assert_eq!(parse_upstream_commit_date(r#"[{"commit":{}}]"#), None);
    }

    #[test]
    fn upstream_newer_only_when_strictly_later() {
        let local = "2025-06-20T12:00:00+08:00";
        assert!(upstream_is_newer("2025-06-20T12:00:01+08:00", local));
        assert!(!upstream_is_newer("2025-06-20T12:00:00+08:00", local));
        assert!(!upstream_is_newer("2025-06-19T12:00:00+08:00", local));
        // 跨时区同一时刻不算新；解析失败不算新
        assert!(!upstream_is_newer("2025-06-20T04:00:00Z", local));
        assert!(!upstream_is_newer("garbage", local));
    }

    #[test]
    fn jcr_parses_quoted_comma_fields() {
        let mut map = HashMap::new();
        parse_jcr(JCR_SAMPLE, &mut map);
        // 带引号逗号的 Category 字段不得错位：IF 仍取到 29.1
        let m = map.get("advancedmaterials").unwrap();
        assert_eq!(m.impact_factor.as_deref(), Some("29.1"));
        assert_eq!(map.get("caacancerjournalforclinicians").unwrap().impact_factor.as_deref(), Some("685.2"));
        // IF 为空的刊不建条目
        assert!(map.get("noimpactjournal").is_none());
    }

    #[test]
    fn fqb_extracts_quartile_and_top() {
        let mut map = HashMap::new();
        parse_fqb(FQB_SAMPLE, &mut map);
        let m2d = map.get("2dmaterials").unwrap();
        assert_eq!(m2d.cas_quartile, Some(3));
        assert!(!m2d.top);
        let am = map.get("advancedmaterials").unwrap();
        assert_eq!(am.cas_quartile, Some(1));
        assert!(am.top);
    }

    #[test]
    fn cas_quartile_parses_leading_digit() {
        assert_eq!(parse_cas_quartile("3 [168/495]"), Some(3));
        assert_eq!(parse_cas_quartile("1 [8/495]"), Some(1));
        assert_eq!(parse_cas_quartile(""), None);
        assert_eq!(parse_cas_quartile("-"), None);
        assert_eq!(parse_cas_quartile("9 [1/1]"), None); // 分区只有 1-4
    }

    #[test]
    fn merges_both_tables_into_one_entry() {
        let map = merged();
        let m = map.get("advancedmaterials").unwrap();
        assert_eq!(m.impact_factor.as_deref(), Some("29.1")); // 来自 JCR
        assert_eq!(m.cas_quartile, Some(1)); // 来自 FQB
        assert!(m.top);
        // 只在单表的刊也各有半边
        assert_eq!(map.get("2dmaterials").unwrap().impact_factor, None);
        assert_eq!(map.get("caacancerjournalforclinicians").unwrap().cas_quartile, None);
    }

    #[test]
    fn lookup_normalizes_case_and_punctuation() {
        let map = merged();
        // 大小写 / 标点 / 空格差异都应命中
        assert!(lookup_in(&map, "Advanced Materials").is_some());
        assert!(lookup_in(&map, "ADVANCED MATERIALS").is_some());
        assert!(lookup_in(&map, "advanced  materials!").is_some());
        assert!(lookup_in(&map, "2D Materials").is_some());
        assert!(lookup_in(&map, "CA: A Cancer Journal for Clinicians").is_some());
    }

    #[test]
    fn lookup_miss_returns_none() {
        let map = merged();
        assert!(lookup_in(&map, "Journal of Nonexistent Results").is_none());
        assert!(lookup_in(&map, "arxiv").is_none());
        assert!(lookup_in(&map, "").is_none());
        assert!(lookup_in(&map, "  ").is_none());
    }

    #[test]
    fn lookup_strips_publisher_suffix() {
        let map = merged();
        // 巡检来源常带出版商尾巴：逐级剥掉末尾括号段后命中
        assert!(lookup_in(&map, "Advanced Materials (Wiley)").is_some());
        assert!(lookup_in(&map, "Advanced Materials（Wiley）").is_some());
        assert!(lookup_in(&map, "2D Materials (IOP) (UK)").is_some());
        // 剥完仍查不到 = None（不模糊猜测）；「(Wiley)」整串剥完为空也 None
        assert!(lookup_in(&map, "Unknown Journal (Wiley)").is_none());
        assert!(lookup_in(&map, "(Wiley)").is_none());
        // 表内名本身带括号尾也能先全名命中（不剥优先）
        assert!(lookup_in(&map, "Advanced Materials").is_some());
    }
}
