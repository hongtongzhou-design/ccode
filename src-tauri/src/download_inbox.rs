//! 下载收货通道（通道 A，2026-09-16 深夜定稿）：**让真实浏览器干浏览器的事**。
//!
//! 出版商反爬（Akamai TLS 指纹、SD 对下载式请求回 HTML、blob Finished 挂起）针对
//! 的是「非浏览器客户端」——内嵌窗里伪装浏览器的整条漏斗注定逐家踩坑。本通道把
//! 「窗口打开」改为调起系统默认浏览器（用户在真浏览器里登录机构、点站方下载），
//! Mesa 只干收货的事：监听 ~/Downloads，按时间窗 + 归属匹配把新落的 PDF 收进
//! 对应项目 papers/（复用既有 stage_relayed_pdf → inst-pdf-relayed 入库链，收货端
//! 零改动），收完把原文件挪回收站（可反悔）。
//!
//! 事件过滤链（全过才收，防误捞用户无关下载）：
//! ① .pdf 扩展名；② 监听启动快照里的既有文件不收（只记不处理）；③ 改名稳定
//! 检测（1.2s 后大小不变才算写完，Chrome 大文件分片写）；④ 同一文件 5s 去重
//! （macOS notify 发 Create+Modify 两条）；⑤ %PDF- 魔数 + ≤60MB；
//! ⑥ 归属匹配：与「浏览器打开」登记的 PendingCatch（时间窗 ±90s + 文件名与标题
//! normalize_title 互相包含 / MDPI 编号归一）命中才收；名字对不上时兜底取**最近
//! 打开**的那条（用户期望「打开哪个就关联哪个」，2026-09-17 拍板；跨标签回头
//! 下载更早打开的篇目时可能挂错名——回收站可找回、行内「关联本地 PDF」可改正，
//! 比漏收好）。命中即消费（登记出队落盘）。
//!
//! 登记持久化（download-pending.json，opened_at 用 SystemTime 跨进程判窗）：
//! dev 热重启/应用重启不丢——2026-09-17 实测重启把内存登记洗掉、用户下完无人收。
//! 关窗即停：无 pending 且 10 分钟无事件自动 drop watcher，不常驻。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 与「窗口打开」联动的时间窗：用户在浏览器里点下载通常在打开后几十秒内
const CATCH_WINDOW: Duration = Duration::from_secs(90);
/// 同一文件的去重窗（notify 在 macOS 对同一次落盘发 Create+Modify）
const DEDUP_WINDOW: Duration = Duration::from_secs(5);
/// 大小稳定检测间隔（Chrome 分片写大文件）
const SETTLE_DELAY: Duration = Duration::from_millis(1200);
/// 无 pending 且无事件的自动停watcher时限
const IDLE_STOP: Duration = Duration::from_secs(600);
/// pending 滞留上限（用户打开后始终没下载 → 清掉）
const PENDING_TTL: Duration = Duration::from_secs(1800);

/// 一次「在浏览器打开」的收货登记。opened_at 用 SystemTime（进程无关）——
/// 登记落盘持久化，dev 热重启/应用重启不丢
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PendingCatch {
    project_root: String,
    title_norm: String,
    title: String,
    #[serde(default)]
    doi: String,
    open_url: String,
    opened_at: std::time::SystemTime,
}

static PENDING: Mutex<Vec<PendingCatch>> = Mutex::new(Vec::new());
/// 监听启动时的 ~/Downloads 既有 PDF 快照（OsString 文件名 → 大小），
/// 只记不处理——防把用户的历史下载全收走
static DL_FINGERPRINT: Mutex<Option<HashMap<std::ffi::OsString, u64>>> = Mutex::new(None);
/// 同一文件最近一次处理时间（5s 去重）
static LAST_SEEN: std::sync::LazyLock<Mutex<HashMap<PathBuf, std::time::Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// watcher 是否在跑（单实例）
static WATCHER_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 收货决策诊断：终端 + logbuf 双落点（2026-09-17 排障：三次漏收无痕迹）
fn dinbox_log(msg: &str) {
    eprintln!("[download-inbox] {msg}");
    crate::logbuf::record("info", "download-inbox", msg);
}

fn downloads_dir() -> Result<PathBuf, String> {
    dirs::download_dir().ok_or_else(|| "无法确定系统下载目录".to_string())
}

/// 收货登记落盘（dev 热重启/应用重启后自动恢复；TTL 清理/命中消费同样同步落盘）
fn pending_store_path() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|d| d.join("ccode").join("download-pending.json"))
        .ok_or_else(|| "无法确定配置目录".to_string())
}

fn save_pendings(q: &[PendingCatch]) {
    let Ok(path) = pending_store_path() else { return };
    if let Ok(body) = serde_json::to_vec(q) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = crate::storage::atomic_write(&path, &body, false);
    }
}

fn load_pendings() -> Vec<PendingCatch> {
    let Ok(path) = pending_store_path() else { return Vec::new() };
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// 归属匹配（纯逻辑供单测）：按时间窗 + 标题互相包含挑出 PDF 属于哪条 pending；
/// MDPI 编号归一（文件名 reactions-07-00016 ↔ DOI 10.3390/reactions7010016）；
/// 名字对不上时兜底取**最近打开**的一条（LIFO，2026-09-17 用户拍板「打开哪个就
/// 关联哪个」——漏收比错挂难受；错挂可回收站找回 + 行内关联本地 PDF 改正）
fn match_pending(
    pendings: &[PendingCatch],
    file_stem: &str,
    now: std::time::SystemTime,
) -> Option<usize> {
    let file_norm = crate::lit_watch::normalize_title(file_stem);
    let in_window: Vec<usize> = pendings
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            now.duration_since(p.opened_at).unwrap_or(Duration::ZERO) <= CATCH_WINDOW
        })
        .map(|(i, _)| i)
        .collect();
    if in_window.is_empty() {
        return None;
    }
    for &i in &in_window {
        let t = &pendings[i].title_norm;
        if !t.is_empty()
            && !file_norm.is_empty()
            && (t.contains(&file_norm) || file_norm.contains(t))
        {
            return Some(i);
        }
    }
    // MDPI 编号归一（2026-09-17 实测漏收场景）：文件名 reactions-07-00016 与标题
    // 永远对不上，但与 DOI 10.3390/reactions7010016 是同一组数——DOI 后缀 =
    // 刊名+卷+期(2位)+编号(末4位)，文件名 = 刊名-卷(2位)-编号(5位)。两边都归一
    // 成「刊名+卷整数+编号整数」比较；仅 10.3390 前缀启用（分型纪律：最窄分支）
    if let Some(fkey) = mdpi_file_key(file_stem) {
        for &i in &in_window {
            if mdpi_doi_key(&pendings[i].doi).as_deref() == Some(fkey.as_str()) {
                return Some(i);
            }
        }
    }
    // 兜底：最近打开的那条（多数流程是「打开 → 立刻下载」）
    in_window.into_iter().max_by_key(|&i| pendings[i].opened_at)
}

/// MDPI DOI → 刊名+卷+编号 整数键（10.3390/reactions7010016 → "reactions7a16"）
fn mdpi_doi_key(doi: &str) -> Option<String> {
    let suffix = doi.trim().strip_prefix("10.3390/")?;
    let letters_len = suffix.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    let letters = &suffix[..letters_len];
    let digits = &suffix[letters_len..];
    if letters.is_empty() || digits.len() < 7 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let vol: u32 = digits[..digits.len() - 6].parse().ok()?;
    let art: u32 = digits[digits.len() - 4..].parse().ok()?;
    Some(format!("{letters}{vol}a{art}"))
}

/// MDPI 下载文件名 → 同款键（reactions-07-00016 → "reactions7a16"）
fn mdpi_file_key(stem: &str) -> Option<String> {
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() != 3 || !parts[0].chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let vol: u32 = parts[1].parse().ok()?;
    let art: u32 = parts[2].parse().ok()?;
    Some(format!("{}{vol}a{art}", parts[0]))
}

/// 「在浏览器打开」：登记收货语境（有项目根时）→ 确保监听在跑 → 调起系统浏览器。
/// EZproxy/OpenAthens 前缀在打开前改写（浏览器里完成代理登录，同一 profile 持续有效）
#[tauri::command]
pub async fn inst_browser_open(
    app: tauri::AppHandle,
    url: String,
    project_root: Option<String>,
    title: Option<String>,
    doi: Option<String>,
) -> Result<(), String> {
    let target = url.trim().to_string();
    if !crate::inst_access::valid_http_url_pub(&target) {
        return Err("地址须是 http(s):// 开头的完整 URL".into());
    }
    // 前缀改写与内嵌窗同一口径（fetch_via_channel 的 proxy_wrap）
    let settings = crate::settings::read_current();
    let open_target = settings
        .institutional_prefix
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .filter(|v| crate::inst_access::valid_http_url_pub(v))
        .map(|p| crate::inst_access::proxy_wrap_pub(p, &target))
        .unwrap_or(target.clone());
    let root = project_root
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|r| {
            crate::projects::ensure_task_project_root(Path::new(r))
                .map(|p| p.to_string_lossy().into_owned())
        })
        .transpose()?;
    // 「当前项目」语境：浏览器桥 helper（扩展「存到 Mesa」）落盘用
    if let Some(root) = root.as_ref() {
        if let Some(cfg) = dirs::config_dir() {
            let ctx = serde_json::json!({
                "projectRoot": root,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            });
            let path = cfg.join("ccode").join("helper-context.json");
            let _ = std::fs::create_dir_all(path.parent().expect("has parent"));
            let _ = crate::storage::atomic_write(&path, ctx.to_string().as_bytes(), false);
        }
    }
    if let (Some(root), Some(title)) = (root.as_ref(), title.as_deref()) {
        let title = title.trim();
        if !title.is_empty() {
            if let Ok(mut q) = PENDING.lock() {
                // 并入上次进程留下的登记（SystemTime 可跨进程判定窗口）
                let disk = load_pendings();
                for p in disk {
                    if !q.iter().any(|x| x.open_url == p.open_url && x.title == p.title) {
                        q.push(p);
                    }
                }
                q.retain(|p| {
                    std::time::SystemTime::now()
                        .duration_since(p.opened_at)
                        .unwrap_or(Duration::ZERO)
                        < PENDING_TTL
                });
                // 同一篇重复「浏览器打开」：刷新时间戳，不追加（防窗口内出现
                // 同 URL 多条、白占多条名额）
                let now = std::time::SystemTime::now();
                if let Some(existing) = q
                    .iter_mut()
                    .find(|p| p.open_url == target && p.title == title)
                {
                    existing.opened_at = now;
                } else {
                    q.push(PendingCatch {
                        project_root: root.clone(),
                        title_norm: crate::lit_watch::normalize_title(title),
                        title: title.to_string(),
                        doi: doi.clone().unwrap_or_default(),
                        open_url: target.clone(),
                        opened_at: now,
                    });
                }
                if q.len() > 16 {
                    let drop_n = q.len() - 16;
                    q.drain(0..drop_n);
                }
                save_pendings(&q);
            }
        }
    }
    ensure_watcher(&app)?;
    tauri_plugin_opener::open_url(open_target.clone(), None::<&str>)
        .map_err(|e| format!("调起系统浏览器失败: {e}"))
}

/// 应用启动即恢复监听：重启前留下的登记（盘上）也要有人接——此前监听只在
/// 下一次「浏览器打开」才启动，重启后到那之前的下载全漏（2026-09-17 实测）
pub fn ensure_watcher_at_startup(app: &tauri::AppHandle) {
    if let Err(e) = ensure_watcher(app) {
        dinbox_log(&format!("启动恢复监听失败: {e}"));
    }
}

/// 确保收货监听在跑（单实例；启动时快照既有 PDF，只记不处理）
fn ensure_watcher(app: &tauri::AppHandle) -> Result<(), String> {
    if WATCHER_RUNNING
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return Ok(());
    }
    let dir = downloads_dir()?;
    // 快照既有 PDF：后续事件里命中快照的一律跳过
    let mut snap: HashMap<std::ffi::OsString, u64> = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if is_pdf_path(&p) {
                if let Ok(m) = e.metadata() {
                    if let Some(name) = p.file_name() {
                        snap.insert(name.to_os_string(), m.len());
                    }
                }
            }
        }
    }
    if let Ok(mut g) = DL_FINGERPRINT.lock() {
        *g = Some(snap);
    }
    if let Ok(mut seen) = LAST_SEEN.lock() {
        seen.clear();
    }
    // 恢复上次进程留下的收货登记（重启场景）
    if let Ok(mut q) = PENDING.lock() {
        if q.is_empty() {
            *q = load_pendings();
        }
    }
    let app = app.clone();
    let dir_disp = dir.display().to_string();
    std::thread::Builder::new()
        .name("download-inbox".into())
        .spawn(move || watcher_loop(app, dir))
        .map_err(|e| format!("启动收货监听失败: {e}"))?;
    dinbox_log(&format!("监听已启动: {dir_disp}"));
    Ok(())
}

fn is_pdf_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

fn watcher_loop(app: tauri::AppHandle, dir: PathBuf) {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => {
            WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
            return;
        }
    };
    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        dinbox_log(&format!("watch 失败: {e:?}"));
        WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
        return;
    }
    let mut last_event = std::time::Instant::now();
    loop {
        // 无 pending 且静默满 IDLE_STOP → 退出（watcher 随之 drop）
        let pending_empty = PENDING
            .lock()
            .map(|mut q| {
                let before = q.len();
                q.retain(|p| {
                    std::time::SystemTime::now()
                        .duration_since(p.opened_at)
                        .unwrap_or(Duration::ZERO)
                        < PENDING_TTL
                });
                if q.len() != before {
                    save_pendings(&q);
                }
                q.is_empty()
            })
            .unwrap_or(true);
        if pending_empty && last_event.elapsed() > IDLE_STOP {
            break;
        }
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(event)) => {
                last_event = std::time::Instant::now();
                let touched: Vec<PathBuf> = event
                    .paths
                    .iter()
                    .filter(|p| is_pdf_path(p))
                    .cloned()
                    .collect();
                if touched.is_empty() {
                    continue;
                }
                for p in touched {
                    consider_file(&app, &p);
                }
            }
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    WATCHER_RUNNING.store(false, std::sync::atomic::Ordering::Release);
}

/// 事件过滤链主体：去重 → 既有快照排除 → 稳定检测 → 魔数/大小 → 归属 → 入库+回收
fn consider_file(app: &tauri::AppHandle, path: &Path) {
    let Some(name) = path.file_name().map(|n| n.to_os_string()) else {
        return;
    };
    let now = std::time::Instant::now();
    // ④ 5s 去重（Create+Modify 双事件）
    if let Ok(mut seen) = LAST_SEEN.lock() {
        if seen
            .get(path)
            .is_some_and(|at| now.duration_since(*at) < DEDUP_WINDOW)
        {
            dinbox_log(&format!("去重跳过: {}", path.display()));
            return;
        }
        seen.insert(path.to_path_buf(), now);
    }
    // ② 监听启动快照里的既有文件（大小也没变）不收
    if let Ok(g) = DL_FINGERPRINT.lock() {
        if let Some(old_len) = g.as_ref().and_then(|m| m.get(&name)) {
            if let Ok(m) = std::fs::metadata(path) {
                if m.len() == *old_len {
                    dinbox_log(&format!("快照既有文件跳过: {}", path.display()));
                    return;
                }
            }
        }
    }
    // ③ 稳定检测：等 1.2s，大小不再变才算写完（最多再等 25 轮 ≈30s——
    // Safari 等边下边写的浏览器，慢速大文件 6s 不够，提前读会截到半截）
    let mut len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    for _ in 0..25 {
        std::thread::sleep(SETTLE_DELAY);
        let cur = match std::fs::metadata(path) {
            Ok(m) => m.len(),
            Err(_) => return, // 写到一半被挪走/删除
        };
        if cur == len {
            break;
        }
        len = cur;
    }
    // ⑤ 魔数 + 上限（下载内容可能是「另存网页」的 HTML）
    if len == 0 || len > crate::lit_watch::DOWNLOAD_CAP as u64 {
        return;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return,
    };
    if !crate::lit_watch::looks_like_pdf(&bytes) {
        dinbox_log(&format!("非 PDF 跳过: {}", path.display()));
        crate::logbuf::record(
            "info",
            "download-inbox",
            &format!("跳过非 PDF 下载：{}", name.to_string_lossy()),
        );
        return;
    }
    // ⑥ 归属匹配；命中即消费（出队落盘，同一登记不占后续下载的窗口名额）
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let matched = PENDING
        .lock()
        .ok()
        .and_then(|mut q| {
            dinbox_log(&format!(
                "归属判定: stem={stem:?} 窗内登记 {} 条",
                q.iter()
                    .filter(|p| {
                        std::time::SystemTime::now()
                            .duration_since(p.opened_at)
                            .unwrap_or(Duration::ZERO)
                            <= CATCH_WINDOW
                    })
                    .count()
            ));
            let hit = match_pending(&q, &stem, std::time::SystemTime::now());
            hit.map(|i| {
                let p = q.get(i).cloned();
                if let Some(kept) = q.get(i) {
                    let url = kept.open_url.clone();
                    let title = kept.title.clone();
                    q.retain(|x| !(x.open_url == url && x.title == title));
                }
                save_pendings(&q);
                p
            })
        })
        .flatten();
    let Some(p) = matched else {
        dinbox_log(&format!("无归属跳过: {}", path.display()));
        return;
    };
    // 语境跟实际命中的那篇走（多项目并行打开时不得沿用最后一次打开的）
    crate::inst_access::set_relay_context(&p.project_root, &p.title, &p.open_url);
    match crate::inst_access::stage_relayed_pdf(&bytes) {
        Ok(staged) => {
            crate::inst_access::emit_relayed_pdf(app, &staged, bytes.len());
            // 收完挪回收站（可反悔）；入库链读内存槽，不依赖原文件
            let _ = trash::delete(path);
            crate::logbuf::record(
                "info",
                "download-inbox",
                &format!(
                    "已收进 {}：{}{}",
                    p.project_root,
                    p.title,
                    if p.doi.is_empty() {
                        String::new()
                    } else {
                        format!("（{}）", p.doi)
                    }
                ),
            );
        }
        Err(e) => {
            dinbox_log(&format!("收货入库失败: {e}"));
            crate::logbuf::record("warn", "download-inbox", &format!("收货入库失败: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(title: &str, ago: Duration) -> PendingCatch {
        PendingCatch {
            project_root: "/proj".into(),
            title_norm: crate::lit_watch::normalize_title(title),
            title: title.into(),
            doi: String::new(),
            open_url: "https://doi.org/10.1/x".into(),
            opened_at: std::time::SystemTime::now() - ago,
        }
    }

    #[test]
    fn match_by_title_containment() {
        let q = vec![pending(
            "Development of a chloride-free dual-salt electrolyte",
            Duration::from_secs(10),
        )];
        let stem = "Development of a chloride-free dual-salt electrolyte for magnesium-sulfur batteries";
        assert_eq!(
            match_pending(&q, stem, std::time::SystemTime::now()),
            Some(0)
        );
    }

    #[test]
    fn match_single_pending_relaxed_without_title_hit() {
        // 窗内只有一条 pending：文件名对不上也收（放宽防漏——收错可从回收站找回）
        let q = vec![pending("Some Paper", Duration::from_secs(30))];
        assert_eq!(
            match_pending(&q, "unrelated download", std::time::SystemTime::now()),
            Some(0)
        );
    }

    #[test]
    fn multiple_pendings_fall_back_to_most_recent() {
        // 名字对不上时取最近打开的那条（LIFO）：Paper A 10 秒前打开、Paper B 20 秒前
        // → 收给 A（用户期望「打开哪个就关联哪个」，2026-09-17 拍板）
        let q = vec![
            pending("Paper A", Duration::from_secs(10)),
            pending("Paper B", Duration::from_secs(20)),
        ];
        assert_eq!(
            match_pending(&q, "unrelated", std::time::SystemTime::now()),
            Some(0)
        );
    }

    #[test]
    fn out_of_window_not_matched() {
        let q = vec![pending("Old Paper", CATCH_WINDOW + Duration::from_secs(5))];
        assert_eq!(
            match_pending(&q, "Old Paper", std::time::SystemTime::now()),
            None
        );
    }

    #[test]
    fn mdpi_filename_matches_by_number_key() {
        // MDPI 下载文件名与标题永远对不上，靠 DOI 编号归一命中
        // （2026-09-17 实测漏收：窗口内两条 pending、文件名 reactions-07-00016）
        assert_eq!(
            mdpi_doi_key("10.3390/reactions7010016").as_deref(),
            Some("reactions7a16")
        );
        assert_eq!(
            mdpi_doi_key("10.3390/solids7010007").as_deref(),
            Some("solids7a7")
        );
        assert_eq!(
            mdpi_file_key("reactions-07-00016").as_deref(),
            Some("reactions7a16")
        );
        assert_eq!(
            mdpi_file_key("solids-07-00007").as_deref(),
            Some("solids7a7")
        );
        assert_eq!(mdpi_doi_key("10.1016/j.checat.2026.101758"), None);

        let mut a = pending("Some Other Paper", Duration::from_secs(30));
        a.doi = "10.1016/j.checat.2026.101758".into();
        let mut b = pending(
            "Polyaniline-Pyrrole as a Potential Cathode Modifier",
            Duration::from_secs(20),
        );
        b.doi = "10.3390/reactions7010016".into();
        let q = vec![a, b];
        assert_eq!(
            match_pending(&q, "reactions-07-00016", std::time::SystemTime::now()),
            Some(1)
        );
        // 非 MDPI 文件名：两条在窗无命中 → 兜底给最近打开的（b，20 秒前）
        assert_eq!(
            match_pending(&q, "main (1)", std::time::SystemTime::now()),
            Some(1)
        );
    }
}
