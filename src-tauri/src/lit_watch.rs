//! 文献雷达（lit-watch）应用层消费：解析项目根下 lit-watch / lit-search 技能产出的
//! 四个文件为 DTO，并支持处置动作（订阅整表写回、精读清单增删、PDF 下载登记）。
//!
//! 文件约定（见 src-tauri/resources/skills/lit-watch/SKILL.md、lit-search/SKILL.md）：
//! - `notes/inbox.md`：巡检命中条目（`<!-- watch-run: YYYY-MM-DD -->` 批次标记 + `## 标题` + 字段行）
//! - `papers/watch-followup.md`：付费墙/无摘要待办（`- ` 开头一行一条，字段「 — 」分隔）
//! - `papers/watchlist.md`：订阅清单（`关键词 — 来源 — 备注`，来源逗号分隔多选）
//! - `papers/included.md`：精读清单（`标题 — 作者, 年份 — 来源 — 链接/DOI`，一行一篇）
//!
//! 防护口径：一切文件操作限定在已注册项目根内（projects::ensure_task_project_root，
//! 同任务卡写入门檻）；目标文件已存在时先 canonicalize 双校验仍在根内，堵符号链接逃逸
//! （同 append_inbox_at）；写操作一律读-改-原子写（profiles::atomic_write）。
//! 解析全部容错：坏行跳过，不整体失败。
//! 返回前端的文本是用户自己的项目文件内容，原样返回即可（脱敏口径见 AGENTS.md：
//! 会话出站才必须脱敏，项目文件不在此列）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// inbox.md 条目上限：只取最新 500 条（收件箱只增不改，防超大文件拖垮前端）
const MAX_ENTRIES: usize = 500;
/// 下载 PDF 上限：60MB，流式读取超限即中止
const DOWNLOAD_CAP: usize = 60 * 1024 * 1024;
/// 下载总超时（含连接）：60MB 在慢速网络下给足余量
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 文件名 sanitize 后主干（不含扩展名）的字符上限
const FILE_STEM_CAP: usize = 110;

// ===== DTO（camelCase，风格同 models.rs） =====

/// inbox.md 中的一条文献命中
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntryDto {
    /// 内容哈希 id（标题+批次日期），`w-<hex>`；仅作前端列表 key，不持久化
    pub id: String,
    pub title: String,
    /// 来源行第一段（arxiv / 期刊 / 会议名）
    pub source: String,
    pub authors: String,
    pub abstract_first: String,
    pub keywords_hit: Vec<String>,
    /// "推荐" | "相关" | "待确认"；字段缺失时按「待确认」（技能口径：拿不准一律待确认）
    pub relevance: String,
    /// 期刊字段（新增可选行）；旧条目没有为 None
    pub journal: Option<String>,
    /// 中文一句话（新增可选行）；旧条目没有为空串
    pub zh_summary: String,
    /// 来源行里的链接/DOI 段；没有为空串
    pub url: String,
    /// 条目所属巡检批次日期（最近的 `<!-- watch-run: ... -->` 标记）；无标记为 None
    pub date: Option<String>,
    /// 条目在 inbox.md 中的行范围（1 起，闭区间），供前端定位/高亮
    pub raw_line_range: [u32; 2],
    /// 期刊指标徽章（IF/中科院分区/Top）；期刊指标表未下载或查不到为 None
    pub metrics: Option<crate::journal_metrics::JournalMetricsDto>,
}

/// watch-followup.md 中的一条待办（付费墙/无摘要，待人工获取全文）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchFollowupDto {
    pub title: String,
    pub url: String,
    /// 缺失原因/备注（题录中链接之外的其余段）
    pub note: String,
}

/// list_watch_entries 的返回：命中条目 + 跟进待办
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchInboxDto {
    pub entries: Vec<WatchEntryDto>,
    pub followups: Vec<WatchFollowupDto>,
}

/// watchlist.md 订阅行（整表读写的双向 DTO）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchSubscriptionDto {
    pub keyword: String,
    /// 来源多选（arxiv/openalex/crossref/web）；空 = 技能缺省口径
    pub sources: Vec<String>,
    pub note: String,
}

/// included.md 精读清单行
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IncludedEntryDto {
    /// 行内容哈希 id，`i-<hex>`；remove 时原样回传，按行内容精确匹配
    pub line_id: String,
    pub title: String,
    /// 「作者, 年份」整段（不拆开，格式由 lit-search 定义）
    pub authors_year: String,
    pub source: String,
    pub link: String,
    pub raw_line: String,
}

/// add_included_entry 返回：added=false 表示规范化标题已存在（去重）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddIncludedResultDto {
    pub added: bool,
}

/// download_paper_pdf 返回：落盘绝对路径 + 资源登记名（文件 stem）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedPaperDto {
    pub path: String,
    pub name: String,
}

// ===== 公共小件 =====

/// 内容哈希 id（DefaultHasher 固定种子，同一次构建内稳定；id 只服务于前端列表 diff）
fn hash_id(prefix: &str, parts: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    format!("{prefix}-{:016x}", h.finish())
}

/// 门檻 + canonical 项目根（所有 command 的第一道工序）
fn gated_root(project_root: &str) -> Result<PathBuf, String> {
    crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(
        project_root,
    )))
}

/// 根内相对路径解析：文件已存在时 canonicalize 双校验仍在根内（堵 symlink 逃逸），
/// 不存在则原样返回拼接路径（供新建）；root 必须已是 canonical（gated_root 保证）
fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = root.join(rel);
    if p.exists() || p.is_symlink() {
        let c = fs::canonicalize(&p).map_err(|e| format!("路径无效（{rel}）: {e}"))?;
        if !c.starts_with(root) {
            return Err(format!("{rel} 指向项目目录之外，拒绝访问"));
        }
    }
    Ok(p)
}

fn read_text_inside(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let p = resolve_inside(root, rel)?;
    match fs::read_to_string(&p) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取 {rel} 失败: {e}")),
    }
}

/// 读-改-原子写公共尾：父目录不存在则建，写前对已存在文件做过 resolve_inside 校验
fn write_text_inside(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let p = resolve_inside(root, rel)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败（{rel}）: {e}"))?;
    }
    crate::profiles::atomic_write(&p, text)
}

// ===== notes/inbox.md 解析 =====

/// 批次标记行：`<!-- watch-run: YYYY-MM-DD -->`（宽松校验：10 位、只含数字与连字符）
fn parse_batch_marker(line: &str) -> Option<String> {
    let inner = line.trim().strip_prefix("<!-- watch-run:")?.strip_suffix("-->")?;
    let d = inner.trim();
    if d.len() == 10 && d.chars().all(|c| c.is_ascii_digit() || c == '-') {
        Some(d.to_string())
    } else {
        None
    }
}

/// 字段行：`- 标签：值`（全角/半角冒号都收），返回 (标签, 值)
fn parse_field_line(line: &str) -> Option<(&str, &str)> {
    let body = line.trim_start().strip_prefix("- ")?;
    let pos = body.find(['：', ':'])?;
    let (k, rest) = body.split_at(pos);
    // 全角「：」是 3 字节，按字符跳过不能按 1 字节切
    let v = &rest[rest.chars().next()?.len_utf8()..];
    Some((k.trim(), v.trim()))
}

/// 来源行值拆分：固定格式 `<来源> — <日期> — <链接或DOI>`，容错处理缺段
fn split_source_line(value: &str) -> (String, String) {
    let segs: Vec<&str> = value.split(" — ").map(|s| s.trim()).collect();
    let source = segs.first().copied().unwrap_or("").to_string();
    let url = if segs.len() >= 3 {
        // 第三段起都归链接（链接本身含 " — " 的极端情况不砍）
        segs[2..].join(" — ")
    } else {
        // 只有两段时第二段可能是日期也可能是链接：像链接才算链接
        segs.get(1)
            .copied()
            .filter(|s| looks_like_link(s))
            .unwrap_or("")
            .to_string()
    };
    (source, url)
}

fn looks_like_link(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.starts_with("http://")
        || l.starts_with("https://")
        || l.starts_with("doi:")
        || l.contains("doi.org")
        || l.contains("arxiv.org")
        || l.starts_with("10.")
}

fn split_keywords(value: &str) -> Vec<String> {
    value
        .split([',', '，', '、'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 解析中的条目（flush 时补 raw_line_range 末行与 id）
struct EntryBuilder {
    title: String,
    start_line: u32,
    last_line: u32,
    date: Option<String>,
    source: String,
    authors: String,
    abstract_first: String,
    keywords_hit: Vec<String>,
    relevance: String,
    journal: Option<String>,
    zh_summary: String,
    url: String,
}

impl EntryBuilder {
    fn new(title: String, start_line: u32, date: Option<String>) -> Self {
        Self {
            title,
            start_line,
            last_line: start_line,
            date,
            source: String::new(),
            authors: String::new(),
            abstract_first: String::new(),
            keywords_hit: Vec::new(),
            relevance: String::new(),
            journal: None,
            zh_summary: String::new(),
            url: String::new(),
        }
    }

    fn build(self) -> WatchEntryDto {
        let date = self.date;
        WatchEntryDto {
            id: hash_id("w", &[&self.title, date.as_deref().unwrap_or("")]),
            title: self.title,
            source: self.source,
            authors: self.authors,
            abstract_first: self.abstract_first,
            keywords_hit: self.keywords_hit,
            // 技能口径：拿不准一律「待确认」；字段缺失同方向回落
            relevance: if self.relevance.is_empty() {
                "待确认".into()
            } else {
                self.relevance
            },
            journal: self.journal,
            zh_summary: self.zh_summary,
            url: self.url,
            date,
            raw_line_range: [self.start_line, self.last_line],
            // 期刊指标在 list_watch_entries 列表出口统一 enrichment，解析器不管
            metrics: None,
        }
    }

    /// 巡检摘要也可能使用二级标题，但不是文献条目。只有至少有一个文献字段时
    /// 才进入雷达；这样解析器与 scheduler 的新增计数保持同一口径。
    fn is_literature_entry(&self) -> bool {
        !self.source.is_empty()
            || !self.authors.is_empty()
            || !self.abstract_first.is_empty()
            || !self.url.is_empty()
            || !self.keywords_hit.is_empty()
            || !self.relevance.is_empty()
            || self.journal.is_some()
            || !self.zh_summary.is_empty()
    }
}

/// 解析 notes/inbox.md 全文为条目表（文件顺序，旧→新）。容错：坏行跳过；
/// 任何 `## ` 块都算条目（不猜技能之外的块长什么样），缺字段给缺省。
fn parse_inbox_entries_with_cap(text: &str, cap: bool) -> Vec<WatchEntryDto> {
    let mut out: Vec<WatchEntryDto> = Vec::new();
    let mut cur: Option<EntryBuilder> = None;
    let mut cur_batch: Option<String> = None;
    for (idx, line) in text.lines().enumerate() {
        let ln = (idx + 1) as u32;
        if let Some(d) = parse_batch_marker(line) {
            cur_batch = Some(d);
            continue;
        }
        if let Some(title) = line.strip_prefix("## ") {
            if let Some(b) = cur.take() {
                if b.is_literature_entry() {
                    out.push(b.build());
                }
            }
            cur = Some(EntryBuilder::new(title.trim().to_string(), ln, cur_batch.clone()));
            continue;
        }
        if let Some(b) = cur.as_mut() {
            if !line.trim().is_empty() {
                b.last_line = ln;
            }
            if let Some((k, v)) = parse_field_line(line) {
                match k {
                    "来源" => {
                        let (source, url) = split_source_line(v);
                        b.source = source;
                        b.url = url;
                    }
                    "作者" => b.authors = v.to_string(),
                    "摘要首句" => b.abstract_first = v.to_string(),
                    "命中关键词" => b.keywords_hit = split_keywords(v),
                    "相关性" => b.relevance = v.to_string(),
                    "期刊" => {
                        if !v.is_empty() {
                            b.journal = Some(v.to_string())
                        }
                    }
                    "中文一句话" => b.zh_summary = v.to_string(),
                    _ => {} // 未知字段忽略（前向兼容技能后续加行）
                }
            }
        }
    }
    if let Some(b) = cur.take() {
        if b.is_literature_entry() {
            out.push(b.build());
        }
    }
    // 收件箱只增不改，最新的在文件末尾：超上限砍前面
    if cap && out.len() > MAX_ENTRIES {
        out.drain(..out.len() - MAX_ENTRIES);
    }
    out
}

fn parse_inbox_entries(text: &str) -> Vec<WatchEntryDto> {
    parse_inbox_entries_with_cap(text, true)
}

/// scheduler 用：lit-watch 运行前后各数一次条目数取差值（`## ` 标题计数，文件缺失按 0）
pub(crate) fn count_inbox_entries(root: &Path) -> u32 {
    let Ok(text) = fs::read_to_string(root.join("notes").join("inbox.md")) else {
        return 0;
    };
    parse_inbox_entries_with_cap(&text, false).len() as u32
}

// ===== 雷达筛选（project.toml 的 lit_watch_filter；前端 lit-watch.ts 同口径镜像） =====

/// 指标是否通过筛选。指标未知（表未装 / 期刊未收录 / IF 不可解析）一律放行不误伤——
/// 筛选只在有数据时生效，绝不用「查不到」当「不达标」
pub(crate) fn metrics_pass_filter(
    metrics: Option<&crate::journal_metrics::JournalMetricsDto>,
    filter: &crate::projects::LitWatchFilterDto,
) -> bool {
    if filter.is_inert() {
        return true;
    }
    let Some(m) = metrics else { return true };
    if let Some(min) = filter.min_if {
        if let Some(v) = m.impact_factor.as_deref().and_then(|s| s.parse::<f64>().ok()) {
            if v < min {
                return false;
            }
        }
    }
    if let Some(max_q) = filter.max_cas_quartile {
        if let Some(q) = m.cas_quartile {
            if q > max_q {
                return false;
            }
        }
    }
    if filter.top_only && !m.top {
        return false;
    }
    true
}

/// 条目级判定：期刊名取 journal 优先、source 回落（与 list_watch_entries enrichment 同口径）
pub(crate) fn entry_passes_filter(
    e: &WatchEntryDto,
    filter: &crate::projects::LitWatchFilterDto,
) -> bool {
    if filter.is_inert() {
        return true;
    }
    let name = match &e.journal {
        Some(j) if !j.trim().is_empty() => j.as_str(),
        _ => e.source.as_str(),
    };
    let m = crate::journal_metrics::lookup(name);
    metrics_pass_filter(m.as_ref(), filter)
}

/// scheduler 用：数通过筛选的条目数（filter None/全空 = 全部条目，等价 count_inbox_entries）
pub(crate) fn count_inbox_entries_matching(
    root: &Path,
    filter: Option<&crate::projects::LitWatchFilterDto>,
) -> u32 {
    let Some(f) = filter.filter(|f| !f.is_inert()) else {
        return count_inbox_entries(root);
    };
    let Ok(text) = fs::read_to_string(root.join("notes").join("inbox.md")) else {
        return 0;
    };
    parse_inbox_entries_with_cap(&text, false)
        .iter()
        .filter(|e| entry_passes_filter(e, f))
        .count() as u32
}

/// 定时任务成功后给出轻量产物提示，不把可恢复的格式瑕疵伪装成完全正常。
/// 解析规则与 list/count 共用；这里只返回提示，不修改项目文件。
pub(crate) fn output_note(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("notes").join("inbox.md")).ok()?;
    let raw_headers = text.lines().filter(|l| l.starts_with("## ")).count();
    let valid = parse_inbox_entries_with_cap(&text, false).len();
    let ignored = raw_headers.saturating_sub(valid);
    if ignored > 0 {
        return Some(format!("已忽略 {ignored} 个没有文献字段的巡检摘要块"));
    }
    if valid > 0 && !root.join("papers").join("watch-seen.md").is_file() {
        return Some("已写入命中，但未找到 papers/watch-seen.md 去重台账".into());
    }
    None
}

// ===== papers/watch-followup.md 解析 =====

/// 待办行：`- 题录…`，「 — 」分段；标题取首段，链接取第一个像链接的段，其余并入备注。
/// 技能没有钉死 followup 的段序（只约定「题录 + 缺失原因」），解析必须宽进。
fn parse_followups(text: &str) -> Vec<WatchFollowupDto> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(body) = line.trim_start().strip_prefix("- ") else {
            continue; // 标题/注释/空行跳过
        };
        let segs: Vec<&str> = body.split(" — ").map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        let Some(title) = segs.first() else { continue };
        let url = segs[1..]
            .iter()
            .copied()
            .find(|s| looks_like_link(s))
            .unwrap_or("")
            .to_string();
        let note = segs[1..]
            .iter()
            .copied()
            .filter(|s| *s != url || url.is_empty())
            .collect::<Vec<_>>()
            .join(" — ");
        out.push(WatchFollowupDto {
            title: title.to_string(),
            url,
            note,
        });
    }
    out
}

// ===== papers/watchlist.md 读写 =====

/// 订阅行：`关键词 — 来源 — 备注`（splitn(3)：备注里再含 " — " 不砍）。
/// 跳过 `#` 注释行与空行；只有一段时只有关键词。
fn parse_subscriptions(text: &str) -> Vec<WatchSubscriptionDto> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut parts = t.splitn(3, " — ");
        let keyword = parts.next().unwrap_or("").trim().to_string();
        if keyword.is_empty() {
            continue;
        }
        let sources = parts
            .next()
            .map(|s| {
                s.split([',', '，'])
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let note = parts.next().map(|s| s.trim().to_string()).unwrap_or_default();
        out.push(WatchSubscriptionDto {
            keyword,
            sources,
            note,
        });
    }
    out
}

/// 整表写回：保留既有文件里的 `#` 注释行（置前），空关键词条目丢弃；
/// 缺段不补尾巴（无备注写 `关键词 — 来源`，无来源只写 `关键词`）
fn render_watchlist(existing: Option<&str>, subs: &[WatchSubscriptionDto]) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(text) = existing {
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('#') {
                lines.push(line.to_string());
            }
        }
    } else {
        // 新建文件给格式模板注释，打开不是一片空白
        lines.push("# 文献雷达订阅：每行 关键词 — 来源 — 备注".to_string());
        lines.push("# 来源：arxiv / openalex / crossref / web（逗号分隔，缺省 arxiv,openalex）；备注可写时间窗（缺省 7 天）与 +bib".to_string());
    }
    for s in subs {
        let keyword = s.keyword.trim();
        if keyword.is_empty() {
            continue;
        }
        let sources = s
            .sources
            .iter()
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .collect::<Vec<_>>()
            .join(",");
        let note = s.note.trim();
        let mut line = keyword.to_string();
        if !sources.is_empty() || !note.is_empty() {
            line.push_str(" — ");
            line.push_str(&sources);
        }
        if !note.is_empty() {
            line.push_str(" — ");
            line.push_str(note);
        }
        lines.push(line);
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

// ===== papers/included.md 读写 =====

fn included_line_id(raw: &str) -> String {
    hash_id("i", &[raw.trim()])
}

/// 精读清单：`标题 — 作者, 年份 — 来源 — 链接/DOI`（splitn(4)，链接段含 " — " 不砍）。
/// 跳过空行与 `#` 注释行；缺段容错为空串。
fn parse_included(text: &str) -> Vec<IncludedEntryDto> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut parts = t.splitn(4, " — ");
        let title = parts.next().unwrap_or("").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let seg = |p: Option<&str>| p.unwrap_or("").trim().to_string();
        out.push(IncludedEntryDto {
            line_id: included_line_id(line),
            title,
            authors_year: seg(parts.next()),
            source: seg(parts.next()),
            link: seg(parts.next()),
            raw_line: line.to_string(),
        });
    }
    out
}

/// 规范化标题（去重口径同 lit-search：忽略大小写与标点；is_alphanumeric 天然保留中日韩字符）
pub(crate) fn normalize_title(t: &str) -> String {
    t.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn add_included_at(root: &Path, title: &str, authors_year: &str, source: &str, link: &str) -> Result<AddIncludedResultDto, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    const REL: &str = "papers/included.md";
    let existing = read_text_inside(root, REL)?;
    let want = normalize_title(title);
    if let Some(text) = &existing {
        if parse_included(text)
            .iter()
            .any(|e| normalize_title(&e.title) == want)
        {
            return Ok(AddIncludedResultDto { added: false });
        }
    }
    // 字段空缺按 lit-search 口径标「待补」，不留空段
    fn fill_or_tbd(s: &str) -> &str {
        let s = s.trim();
        if s.is_empty() { "待补" } else { s }
    }
    let new_line = format!(
        "{} — {} — {} — {}",
        title,
        fill_or_tbd(authors_year),
        fill_or_tbd(source),
        fill_or_tbd(link)
    );
    let mut text = existing.unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&new_line);
    text.push('\n');
    write_text_inside(root, REL, &text)?;
    Ok(AddIncludedResultDto { added: true })
}

fn remove_included_at(root: &Path, line_id: &str) -> Result<(), String> {
    const REL: &str = "papers/included.md";
    let text = read_text_inside(root, REL)?.ok_or("精读清单不存在")?;
    let mut removed = false;
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            // 按行内容哈希精确匹配，只删第一处（重复行逐次删）
            if !removed && included_line_id(line) == line_id {
                removed = true;
                false
            } else {
                true
            }
        })
        .collect();
    if !removed {
        return Err("该行已不存在（清单可能已变动，请刷新后重试）".into());
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    write_text_inside(root, REL, &out)
}

// ===== PDF 下载 =====

/// PDF 魔数宽松校验：前 1024 字节内含 %PDF- 即认（同 pdf.rs 口径，部分生成器写前导字节）
fn looks_like_pdf(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    head.windows(5).any(|w| w == b"%PDF-")
}

/// 文件名 sanitize：去路径分隔符/控制字符/Windows 非法字符（三平台口径），
/// 去首尾空白与点，主干限长，非 .pdf 结尾补 .pdf；清完为空回落 "paper.pdf"
fn sanitize_pdf_name(hint: &str) -> String {
    const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = hint
        .chars()
        .filter(|c| !c.is_control() && !ILLEGAL.contains(c))
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    let stem = if cleaned.to_ascii_lowercase().ends_with(".pdf") {
        &cleaned[..cleaned.len() - 4]
    } else {
        cleaned
    };
    let stem: String = stem.chars().take(FILE_STEM_CAP).collect();
    let stem = stem.trim_end();
    if stem.is_empty() {
        "paper.pdf".to_string()
    } else {
        format!("{stem}.pdf")
    }
}

/// 重名避让：x.pdf → x-2.pdf → x-3.pdf …
fn unique_pdf_path(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = name.split_at(name.len() - 4); // 调用方保证以 .pdf 结尾
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    for n in 2..=999u32 {
        let c = dir.join(format!("{stem}-{n}{ext}"));
        if !c.exists() {
            return c;
        }
    }
    // 999 个重名还不行，退回 uuid 文件名（理论到不了）
    dir.join(format!("{stem}-{}{}", uuid::Uuid::new_v4().simple(), ext))
}

/// 网络段（async）：scheme 白名单 → 状态码 → content-length 预估 → 分块读取超限即中止 → 魔数校验
async fn fetch_pdf_bytes(url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("链接无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("仅支持 http/https 链接（收到 {s}）")),
    }
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        // 部分出版商/预印本站拦无 UA 请求
        .user_agent("Ccode lit-watch (https://github.com/hongtongzhou-design/ccode)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > DOWNLOAD_CAP as u64 {
            return Err(format!(
                "文件超过 60 MB（{:.1} MB），已中止下载",
                len as f64 / 1024.0 / 1024.0
            ));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断: {e}"))? {
        if buf.len() + chunk.len() > DOWNLOAD_CAP {
            return Err("文件超过 60 MB，已中止下载".into());
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err("下载内容为空".into());
    }
    if !looks_like_pdf(&buf) {
        return Err("下载内容不是有效的 PDF（可能是需登录的页面或付费墙）".into());
    }
    Ok(buf)
}

/// papers/ 目录：不存在则创建，canonical 双校验在根内（堵 symlink 逃逸）
fn papers_dir(root: &Path) -> Result<PathBuf, String> {
    let papers = root.join("papers");
    fs::create_dir_all(&papers).map_err(|e| format!("创建 papers 目录失败: {e}"))?;
    let canon = fs::canonicalize(&papers).map_err(|e| format!("papers 目录无效: {e}"))?;
    if !canon.starts_with(root) {
        return Err("papers 指向项目目录之外，拒绝写入".into());
    }
    Ok(canon)
}

/// 把 papers/ 里已存在的 PDF 登记进 project.toml 的 [[resources]]（type="paper"，
/// name 取文件 stem；path 存相对项目根、统一正斜杠，同 discover_resources 口径；
/// 复用 projects 的读-改-原子写，已登记同路径不重复加）
fn register_pdf(root: &Path, target: &Path) -> Result<DownloadedPaperDto, String> {
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("PDF 文件名无效")?;
    let stem = Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.clone());
    let rel = format!("papers/{file_name}");
    let mut cfg = crate::projects::read_config_at(root).config;
    if !cfg.resources.iter().any(|r| r.path == rel) {
        cfg.resources.push(crate::projects::ResourceDto {
            name: stem.clone(),
            path: rel,
            kind: "paper".into(),
            readonly: false,
            note: String::new(),
        });
        crate::projects::write_config_at(root, &cfg)?;
    }
    Ok(DownloadedPaperDto {
        path: target.to_string_lossy().into_owned(),
        name: stem,
    })
}

/// 落盘 + 资源登记（sync）：文件名清理 + 重名避让，写盘后登记
fn save_and_register_pdf(root: &Path, file_name_hint: &str, bytes: &[u8]) -> Result<DownloadedPaperDto, String> {
    let papers = papers_dir(root)?;
    let name = sanitize_pdf_name(file_name_hint);
    let target = unique_pdf_path(&papers, &name);
    fs::write(&target, bytes).map_err(|e| format!("写入 PDF 失败: {e}"))?;
    register_pdf(root, &target)
}

/// 关联本地 PDF（sync）：用户手动下载的 PDF 复制进 papers/ 并按标题登记。
/// 源文件校验同下载口径（.pdf 扩展名 + %PDF- 魔数 + 60MB 上限），复制而非移动。
fn attach_pdf_at(root: &Path, source_path: &str, title: &str) -> Result<DownloadedPaperDto, String> {
    let src = PathBuf::from(crate::sessions::expand_tilde(source_path));
    let meta = fs::metadata(&src).map_err(|e| format!("源文件不可读: {e}"))?;
    if !meta.is_file() {
        return Err("选择的不是文件".into());
    }
    if meta.len() > DOWNLOAD_CAP as u64 {
        return Err(format!(
            "文件超过 60 MB（{:.1} MB）",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let is_pdf_ext = src
        .extension()
        .is_some_and(|e| e.to_ascii_lowercase() == "pdf");
    if !is_pdf_ext {
        return Err("请选择 PDF 文件".into());
    }
    let mut head = [0u8; 1024];
    let n = {
        use std::io::Read as _;
        fs::File::open(&src)
            .and_then(|mut f| f.read(&mut head))
            .map_err(|e| format!("读取源文件失败: {e}"))?
    };
    if !looks_like_pdf(&head[..n]) {
        return Err("所选文件不是有效的 PDF".into());
    }
    let papers = papers_dir(root)?;
    let target = unique_pdf_path(&papers, &sanitize_pdf_name(title));
    fs::copy(&src, &target).map_err(|e| format!("复制 PDF 失败: {e}"))?;
    register_pdf(root, &target)
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn list_watch_entries(project_root: String) -> Result<WatchInboxDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        let mut entries = match read_text_inside(&root, "notes/inbox.md")? {
            Some(text) => parse_inbox_entries(&text),
            None => Vec::new(),
        };
        // 期刊指标徽章 enrichment：期刊字段（Some 且非空）优先，否则来源行第一段
        // （arxiv 这类查不到自然 miss）；表未下载时 lookup 恒 None，静默无徽章
        for e in &mut entries {
            let name = match &e.journal {
                Some(j) if !j.trim().is_empty() => j.as_str(),
                _ => e.source.as_str(),
            };
            e.metrics = crate::journal_metrics::lookup(name);
        }
        let followups = match read_text_inside(&root, "papers/watch-followup.md")? {
            Some(text) => parse_followups(&text),
            None => Vec::new(),
        };
        Ok(WatchInboxDto { entries, followups })
    })
    .await
    .map_err(|e| format!("读取文献收件箱失败: {e}"))?
}

#[tauri::command]
pub async fn list_watch_subscriptions(
    project_root: String,
) -> Result<Vec<WatchSubscriptionDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        match read_text_inside(&root, "papers/watchlist.md")? {
            Some(text) => Ok(parse_subscriptions(&text)),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| format!("读取订阅清单失败: {e}"))?
}

#[tauri::command]
pub async fn save_watch_subscriptions(
    project_root: String,
    subs: Vec<WatchSubscriptionDto>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        const REL: &str = "papers/watchlist.md";
        let existing = read_text_inside(&root, REL)?;
        let text = render_watchlist(existing.as_deref(), &subs);
        write_text_inside(&root, REL, &text)
    })
    .await
    .map_err(|e| format!("写入订阅清单失败: {e}"))?
}

#[tauri::command]
pub async fn list_included_entries(
    project_root: String,
) -> Result<Vec<IncludedEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        match read_text_inside(&root, "papers/included.md")? {
            Some(text) => Ok(parse_included(&text)),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| format!("读取精读清单失败: {e}"))?
}

#[tauri::command]
pub async fn add_included_entry(
    project_root: String,
    title: String,
    authors_year: String,
    source: String,
    link: String,
) -> Result<AddIncludedResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        add_included_at(&root, &title, &authors_year, &source, &link)
    })
    .await
    .map_err(|e| format!("追加精读清单失败: {e}"))?
}

#[tauri::command]
pub async fn remove_included_entry(project_root: String, line_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        remove_included_at(&root, &line_id)
    })
    .await
    .map_err(|e| format!("删除精读清单行失败: {e}"))?
}

/// 下载文献全文 PDF：网络段 async、落盘与登记段 spawn_blocking（文件操作风格同 pdf.rs）
#[tauri::command]
pub async fn download_paper_pdf(
    project_root: String,
    url: String,
    file_name_hint: String,
) -> Result<DownloadedPaperDto, String> {
    let root = {
        let pr = project_root.clone();
        tauri::async_runtime::spawn_blocking(move || gated_root(&pr))
            .await
            .map_err(|e| format!("校验项目目录失败: {e}"))??
    };
    let bytes = fetch_pdf_bytes(&url).await?;
    tauri::async_runtime::spawn_blocking(move || save_and_register_pdf(&root, &file_name_hint, &bytes))
        .await
        .map_err(|e| format!("保存 PDF 失败: {e}"))?
}

/// 关联本地 PDF（精读清单/新命中的「关联本地 PDF…」）：付费墙等自动下载失败的场景，
/// 用户手动下载后选中文件，一步完成 复制进 papers/ + 登记 project.toml
#[tauri::command]
pub async fn attach_paper_pdf(
    project_root: String,
    source_path: String,
    title: String,
) -> Result<DownloadedPaperDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = gated_root(&project_root)?;
        attach_pdf_at(&root, &source_path, &title)
    })
    .await
    .map_err(|e| format!("关联 PDF 失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-litwatch-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // 生产路径下 root 恒为 canonical（ensure_task_project_root），测试同口径：
        // macOS 的 temp_dir 在 /var（软链到 /private/var），不 canonicalize 会让 starts_with 双校验误杀
        dir.canonicalize().unwrap()
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    const SAMPLE_INBOX: &str = "\
# 文献收件箱

<!-- watch-run: 2026-08-11 -->

## 旧条目没有新增字段
- 来源：arxiv — 2026-08-10 — https://arxiv.org/abs/2608.00001
- 作者：Zhang S, Li M, Wang Q et al.
- 摘要首句：We present a method.
- 命中关键词：perovskite, stability
- 相关性：相关

<!-- watch-run: 2026-08-18 -->

## 完整字段条目
- 来源：期刊 — 2026-08-17 — 10.1000/xyz123
- 作者：Chen L et al.
- 摘要首句：Here we show.
- 命中关键词：solid electrolyte
- 相关性：推荐
- 期刊：Nature Energy
- 中文一句话：提出一种提升固态电解质界面稳定性的方法

坏行不属于任何字段，跳过
- 未知字段：随便什么

## 最小条目
";

    #[test]
    fn parses_full_and_legacy_entries_with_batch_dates() {
        let entries = parse_inbox_entries(SAMPLE_INBOX);
        assert_eq!(entries.len(), 2);
        let legacy = &entries[0];
        assert_eq!(legacy.title, "旧条目没有新增字段");
        assert_eq!(legacy.source, "arxiv");
        assert_eq!(legacy.url, "https://arxiv.org/abs/2608.00001");
        assert_eq!(legacy.authors, "Zhang S, Li M, Wang Q et al.");
        assert_eq!(legacy.abstract_first, "We present a method.");
        assert_eq!(legacy.keywords_hit, vec!["perovskite", "stability"]);
        assert_eq!(legacy.relevance, "相关");
        // 旧条目没有新增字段：journal=None、zh_summary 空串
        assert_eq!(legacy.journal, None);
        assert_eq!(legacy.zh_summary, "");
        // 批次日期归属：第一、二个批次标记
        assert_eq!(legacy.date.as_deref(), Some("2026-08-11"));
        let full = &entries[1];
        assert_eq!(full.journal.as_deref(), Some("Nature Energy"));
        assert_eq!(full.zh_summary, "提出一种提升固态电解质界面稳定性的方法");
        assert_eq!(full.url, "10.1000/xyz123");
        assert_eq!(full.date.as_deref(), Some("2026-08-18"));
        // 没有任何文献字段的标题块（如巡检摘要）不会进入雷达条目。
        // id 稳定且互不相同
        assert_ne!(legacy.id, full.id);
        assert!(legacy.id.starts_with("w-"));
        // 行范围：完整条目从 ## 行（14）起到块内最后一个非空行（24，含坏行/未知字段行）
        assert_eq!(full.raw_line_range, [14, 24]);
    }

    #[test]
    fn entries_before_any_marker_have_no_date_and_bad_lines_skipped() {
        let text = "## 无批次条目\n- 相关性：推荐\n这不是字段行\n- 摘要首句：x\n\n## 第二条\n";
        let entries = parse_inbox_entries(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, None);
        assert_eq!(entries[0].abstract_first, "x");
        assert_eq!(entries[0].relevance, "推荐");
    }

    #[test]
    fn source_line_tolerates_missing_segments() {
        // 只有来源一段
        let (s, u) = split_source_line("arxiv");
        assert_eq!((s.as_str(), u.as_str()), ("arxiv", ""));
        // 两段：第二段像链接才算链接，否则视为日期丢弃
        let (s, u) = split_source_line("arxiv — 2026-08-10");
        assert_eq!((s.as_str(), u.as_str()), ("arxiv", ""));
        let (s, u) = split_source_line("arxiv — https://x.org/1");
        assert_eq!((s.as_str(), u.as_str()), ("arxiv", "https://x.org/1"));
        // 标准三段
        let (s, u) = split_source_line("Nature — 2026-08-01 — 10.1038/s41586");
        assert_eq!((s.as_str(), u.as_str()), ("Nature", "10.1038/s41586"));
    }

    #[test]
    fn entries_capped_at_500_keeping_latest() {
        let mut text = String::new();
        for i in 1..=600 {
            text.push_str(&format!("## 条目 {i}\n- 相关性：相关\n"));
        }
        let entries = parse_inbox_entries(&text);
        assert_eq!(entries.len(), 500);
        // 砍前面留最新：第一条是「条目 101」，最后一条是「条目 600」
        assert_eq!(entries.first().unwrap().title, "条目 101");
        assert_eq!(entries.last().unwrap().title, "条目 600");
    }

    #[test]
    fn count_inbox_entries_counts_valid_literature_entries_and_missing_file_is_zero() {
        let dir = tmpdir("count");
        assert_eq!(count_inbox_entries(&dir), 0);
        write(&dir, "notes/inbox.md", SAMPLE_INBOX);
        assert_eq!(count_inbox_entries(&dir), 2);
        fs::remove_dir_all(&dir).ok();
    }

    // ===== 雷达筛选（metrics_pass_filter 纯判定；指标未知放行不误伤） =====

    fn metrics(if_: Option<&str>, quartile: Option<u8>, top: bool) -> crate::journal_metrics::JournalMetricsDto {
        crate::journal_metrics::JournalMetricsDto {
            impact_factor: if_.map(|s| s.to_string()),
            cas_quartile: quartile,
            top,
        }
    }

    #[test]
    fn filter_inert_passes_everything() {
        let f = crate::projects::LitWatchFilterDto::default();
        assert!(f.is_inert());
        assert!(metrics_pass_filter(None, &f));
        assert!(metrics_pass_filter(Some(&metrics(Some("1.0"), Some(4), false)), &f));
    }

    #[test]
    fn filter_min_if_compares_parsed_value() {
        let f = crate::projects::LitWatchFilterDto {
            min_if: Some(10.0),
            ..Default::default()
        };
        assert!(metrics_pass_filter(Some(&metrics(Some("29.1"), None, false)), &f));
        assert!(!metrics_pass_filter(Some(&metrics(Some("3.9"), None, false)), &f));
        // 恰好等于阈值通过；IF 缺失/不可解析 = 未知 → 放行
        assert!(metrics_pass_filter(Some(&metrics(Some("10"), None, false)), &f));
        assert!(metrics_pass_filter(Some(&metrics(None, Some(4), false)), &f));
        assert!(metrics_pass_filter(Some(&metrics(Some("N/A"), None, false)), &f));
        assert!(metrics_pass_filter(None, &f));
    }

    #[test]
    fn filter_quartile_and_top() {
        let q2 = crate::projects::LitWatchFilterDto {
            max_cas_quartile: Some(2),
            ..Default::default()
        };
        assert!(metrics_pass_filter(Some(&metrics(None, Some(1), false)), &q2));
        assert!(metrics_pass_filter(Some(&metrics(None, Some(2), false)), &q2));
        assert!(!metrics_pass_filter(Some(&metrics(None, Some(3), false)), &q2));
        // 分区未知放行
        assert!(metrics_pass_filter(Some(&metrics(None, None, false)), &q2));

        let top = crate::projects::LitWatchFilterDto {
            top_only: true,
            ..Default::default()
        };
        assert!(metrics_pass_filter(Some(&metrics(None, None, true)), &top));
        assert!(!metrics_pass_filter(Some(&metrics(None, None, false)), &top));
        // 指标完全未知放行不误伤
        assert!(metrics_pass_filter(None, &top));
    }

    #[test]
    fn filter_conditions_are_anded() {
        let f = crate::projects::LitWatchFilterDto {
            min_if: Some(10.0),
            max_cas_quartile: Some(2),
            top_only: true,
        };
        assert!(metrics_pass_filter(Some(&metrics(Some("19.9"), Some(1), true)), &f));
        // 任一条件不达标即排除
        assert!(!metrics_pass_filter(Some(&metrics(Some("5.0"), Some(1), true)), &f));
        assert!(!metrics_pass_filter(Some(&metrics(Some("19.9"), Some(3), true)), &f));
        assert!(!metrics_pass_filter(Some(&metrics(Some("19.9"), Some(1), false)), &f));
    }

    #[test]
    fn output_note_reports_ignored_summary_blocks_and_missing_ledger() {
        let dir = tmpdir("output-note");
        write(
            &dir,
            "notes/inbox.md",
            "## 2026-08-22 巡检（自动雷达）\n- 新命中 0 篇\n\n## 论文 A\n- 来源：arxiv — 2026-08-22 — https://arxiv.org/abs/1\n",
        );
        assert_eq!(
            output_note(&dir).as_deref(),
            Some("已忽略 1 个没有文献字段的巡检摘要块"),
        );
        write(&dir, "papers/watch-seen.md", "# ledger\n");
        assert_eq!(
            output_note(&dir).as_deref(),
            Some("已忽略 1 个没有文献字段的巡检摘要块"),
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn followups_parse_tolerantly() {
        let text = "\
# 跟进队列

- 付费墙论文 A — Chen L et al. — https://doi.org/10.1000/a — 付费墙，待人工获取
- 无摘要论文 B — 10.1000/b
- 只有标题的论文 C
注释行跳过
";
        let f = parse_followups(text);
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].title, "付费墙论文 A");
        assert_eq!(f[0].url, "https://doi.org/10.1000/a");
        assert!(f[0].note.contains("付费墙，待人工获取"), "{}", f[0].note);
        assert!(f[0].note.contains("Chen L et al."));
        assert_eq!(f[1].url, "10.1000/b");
        assert_eq!(f[2].url, "");
        assert_eq!(f[2].note, "");
    }

    #[test]
    fn watchlist_parse_and_render_round_trip_preserving_comments() {
        let text = "\
# 订阅清单：每行 关键词 — 来源 — 备注
perovskite stability — arxiv,openalex — 每周 +bib
solid electrolyte — crossref
lone keyword
# 尾部注释也保留
";
        let subs = parse_subscriptions(text);
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0].keyword, "perovskite stability");
        assert_eq!(subs[0].sources, vec!["arxiv", "openalex"]);
        assert_eq!(subs[0].note, "每周 +bib");
        assert_eq!(subs[1].sources, vec!["crossref"]);
        assert_eq!(subs[1].note, "");
        assert_eq!(subs[2].keyword, "lone keyword");
        assert_eq!(subs[2].sources, Vec::<String>::new());
        // 整表写回：注释保留、字段往返
        let rendered = render_watchlist(Some(text), &subs);
        let back = parse_subscriptions(&rendered);
        assert_eq!(back, subs);
        assert!(rendered.contains("# 订阅清单"), "注释行要保留: {rendered}");
        assert!(rendered.contains("# 尾部注释也保留"), "{rendered}");
        assert!(rendered.contains("perovskite stability — arxiv,openalex — 每周 +bib"));
        // 空关键词丢弃；新建文件带格式模板注释（注释不影响解析）
        let rendered = render_watchlist(
            None,
            &[WatchSubscriptionDto {
                keyword: "  ".into(),
                sources: vec![],
                note: String::new(),
            }],
        );
        assert!(parse_subscriptions(&rendered).is_empty());
        assert!(rendered.contains("# 文献雷达订阅"), "{rendered}");
    }

    #[test]
    fn included_add_list_remove_round_trip_and_dedup() {
        let dir = tmpdir("included");
        // add：文件/父目录不存在则建
        let r = add_included_at(&dir, "Perovskite Solar Cells: A Review", "Zhang S, 2025", "Adv. Mater.", "10.1000/x1").unwrap();
        assert!(r.added);
        assert!(dir.join("papers/included.md").exists());
        // 同标题第二次（大小写/标点差异）→ 去重 added:false
        let r2 = add_included_at(&dir, "perovskite solar cells a review", "Li M, 2026", "JACS", "10.1000/x2").unwrap();
        assert!(!r2.added);
        // 不同标题正常追加；空字段标「待补」
        let r3 = add_included_at(&dir, "另一篇论文", "", "", "").unwrap();
        assert!(r3.added);
        let text = fs::read_to_string(dir.join("papers/included.md")).unwrap();
        assert!(text.contains("另一篇论文 — 待补 — 待补 — 待补"), "{text}");
        // list
        let list = parse_included(&text);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "Perovskite Solar Cells: A Review");
        assert_eq!(list[0].authors_year, "Zhang S, 2025");
        assert_eq!(list[0].source, "Adv. Mater.");
        assert_eq!(list[0].link, "10.1000/x1");
        assert!(list[0].line_id.starts_with("i-"));
        assert_eq!(list[0].raw_line, "Perovskite Solar Cells: A Review — Zhang S, 2025 — Adv. Mater. — 10.1000/x1");
        // remove：按 line_id 精确匹配
        remove_included_at(&dir, &list[0].line_id).unwrap();
        let text2 = fs::read_to_string(dir.join("papers/included.md")).unwrap();
        assert!(!text2.contains("Perovskite"), "{text2}");
        assert!(text2.contains("另一篇论文"));
        // 再删同一 id → 报错
        assert!(remove_included_at(&dir, &list[0].line_id).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pdf_magic_check_follows_pdf_rs_rule() {
        assert!(looks_like_pdf(b"%PDF-1.7 body"));
        // 前导字节 + 魔数落在前 1024 字节窗口内
        let mut v = vec![b' '; 100];
        v.extend_from_slice(b"%PDF-1.7");
        assert!(looks_like_pdf(&v));
        assert!(!looks_like_pdf(b"<html>not a pdf</html>"));
        assert!(!looks_like_pdf(b""));
    }

    #[test]
    fn pdf_name_sanitized_and_deduped() {
        // 分隔符/控制字符/Windows 非法字符清除，非 .pdf 结尾补
        assert_eq!(sanitize_pdf_name("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij.pdf");
        assert_eq!(sanitize_pdf_name("paper.pdf"), "paper.pdf");
        assert_eq!(sanitize_pdf_name("paper.PDF"), "paper.pdf");
        assert_eq!(sanitize_pdf_name(""), "paper.pdf");
        assert_eq!(sanitize_pdf_name("..."), "paper.pdf");
        assert_eq!(sanitize_pdf_name("含中文 标题"), "含中文 标题.pdf");
        // 限长：总长度不超过 主干上限 + .pdf
        let long = "字".repeat(300);
        let name = sanitize_pdf_name(&long);
        assert!(name.chars().count() <= FILE_STEM_CAP + 4, "{}", name.chars().count());
        assert!(name.ends_with(".pdf"));
        // 重名避让 -2/-3
        let dir = tmpdir("dup");
        let p1 = unique_pdf_path(&dir, "x.pdf");
        fs::write(&p1, b"a").unwrap();
        let p2 = unique_pdf_path(&dir, "x.pdf");
        assert_eq!(p2.file_name().unwrap(), "x-2.pdf");
        fs::write(&p2, b"b").unwrap();
        let p3 = unique_pdf_path(&dir, "x.pdf");
        assert_eq!(p3.file_name().unwrap(), "x-3.pdf");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_pdf_registers_resource_in_project_toml() {
        let dir = tmpdir("save");
        let dto = save_and_register_pdf(&dir, "my paper", b"%PDF-1.7 fake").unwrap();
        assert!(std::path::Path::new(&dto.path).ends_with("papers/my paper.pdf"), "{}", dto.path);
        assert_eq!(dto.name, "my paper");
        let cfg = crate::projects::read_config_at(&dir).config;
        assert_eq!(cfg.resources.len(), 1);
        assert_eq!(cfg.resources[0].kind, "paper");
        assert_eq!(cfg.resources[0].name, "my paper");
        assert_eq!(cfg.resources[0].path, "papers/my paper.pdf");
        // 同 hint 再下载：文件避让 -2，资源另登记一条
        let dto2 = save_and_register_pdf(&dir, "my paper", b"%PDF-1.7 fake2").unwrap();
        assert!(std::path::Path::new(&dto2.path).ends_with("papers/my paper-2.pdf"), "{}", dto2.path);
        let cfg2 = crate::projects::read_config_at(&dir).config;
        assert_eq!(cfg2.resources.len(), 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn attach_pdf_copies_and_registers() {
        let dir = tmpdir("attach");
        let src_dir = tmpdir("attach-src");
        let src = src_dir.join("手动下载.pdf");
        fs::write(&src, b"%PDF-1.7 body").unwrap();
        let dto = attach_pdf_at(&dir, src.to_str().unwrap(), "My Paper Title").unwrap();
        assert!(std::path::Path::new(&dto.path).ends_with("papers/My Paper Title.pdf"), "{}", dto.path);
        assert_eq!(dto.name, "My Paper Title");
        // 复制而非移动：源文件还在
        assert!(src.exists());
        let cfg = crate::projects::read_config_at(&dir).config;
        assert_eq!(cfg.resources.len(), 1);
        assert_eq!(cfg.resources[0].kind, "paper");
        assert_eq!(cfg.resources[0].path, "papers/My Paper Title.pdf");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&src_dir).ok();
    }

    #[test]
    fn attach_pdf_rejects_non_pdf() {
        let dir = tmpdir("attach-bad");
        let src_dir = tmpdir("attach-bad-src");
        // 扩展名不对
        let txt = src_dir.join("notes.txt");
        fs::write(&txt, b"%PDF-1.7 disguised").unwrap();
        let err = attach_pdf_at(&dir, txt.to_str().unwrap(), "t").unwrap_err();
        assert!(err.contains("PDF"), "{err}");
        // 扩展名对但魔数不对
        let fake = src_dir.join("fake.pdf");
        fs::write(&fake, b"<html>login page</html>").unwrap();
        let err = attach_pdf_at(&dir, fake.to_str().unwrap(), "t").unwrap_err();
        assert!(err.contains("不是有效的 PDF"), "{err}");
        // 不存在的路径
        let err = attach_pdf_at(&dir, "/nonexistent/x.pdf", "t").unwrap_err();
        assert!(err.contains("不可读"), "{err}");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&src_dir).ok();
    }

    #[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
    #[test]
    fn symlink_escaping_root_rejected() {
        let dir = tmpdir("sroot");
        let outside = tmpdir("soutside");
        let secret = outside.join("inbox.md");
        fs::write(&secret, "## 外面的条目\n").unwrap();
        fs::create_dir_all(dir.join("notes")).unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("notes/inbox.md")).unwrap();
        let err = read_text_inside(&dir, "notes/inbox.md").unwrap_err();
        assert!(err.contains("项目目录之外"), "{err}");
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
