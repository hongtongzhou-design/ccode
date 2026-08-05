//! 跨 Agent 接力（P3，架构 §11.3 机制四）：接力不是记忆转移——
//! 从当前会话的有界尾窗生成结构化简报落成文件，新 Agent 带简报启动，
//! 并用接力链小表记录「新会话接自哪个 agent 的哪个会话」。
//!
//! 安全口径与会话导出一致：简报全文过 redact_sensitive_text 脱敏后才写盘，
//! 密钥不出站；目标路径默认 cwd/.ccode/handoff-<时间>.md，自定义路径必须位于项目目录内。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_specs::{self, PromptInject};
use crate::git_info::GitStatusDto;
use crate::sessions::{self, ChatMessageDto, SessionMetaDto};

/// 简报全文上限（同 inbox 追加口径）
const BRIEF_CAP: usize = 64 * 1024;
/// 对话要点收录的最近用户消息条数
const RECENT_USER_MESSAGES: usize = 5;
/// 单条用户消息摘要截断（字符）
const USER_SNIP: usize = 200;
/// 最后一条助手回复截断（字符）
const ASSISTANT_SNIP: usize = 600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffBriefDto {
    pub file_path: String,
    /// 给界面回显的一句话概述（要点数 / 改动文件数）
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffTargetDto {
    pub id: String,
    /// 本机已安装（resolve_binary 命中）
    pub installed: bool,
    /// 注册表 prompt_inject 非 Unsupported（kimi/opencode 需手动发送首条指令）
    pub prompt_supported: bool,
}

/// 接力目标清单：六 CLI 全量返回，前端按 installed/prompt_supported 排序与标注
#[tauri::command]
pub fn handoff_targets() -> Vec<HandoffTargetDto> {
    agent_specs::all_agent_specs()
        .iter()
        .map(|spec| HandoffTargetDto {
            id: spec.id.into(),
            installed: crate::agents::resolve_binary(spec.binary).is_some(),
            prompt_supported: spec.prompt_inject != PromptInject::Unsupported,
        })
        .collect()
}

/// 折叠空白后按字符截断（简报要点单行化，防多行 prompt 撑破结构）
fn snip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = flat.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(max).collect::<String>())
    }
}

/// 消息正文：只取 text 块（thinking/工具调用不进要点）
fn message_text(m: &ChatMessageDto) -> String {
    m.blocks
        .iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 组装简报 markdown（纯函数，测试直接构造消息与 git 状态）。
/// git 为 None 或 is_repo=false 时注明非仓库。
pub(crate) fn render_handoff_brief(
    agent: &str,
    session_id: &str,
    cwd: &str,
    title: Option<&str>,
    messages: &[ChatMessageDto],
    git: Option<&GitStatusDto>,
) -> String {
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .unwrap_or_else(|| format!("未命名对话 · {}", session_id.chars().take(8).collect::<String>()));
    let mut out = String::new();
    out.push_str(&format!("# 接力简报：{title}\n\n"));
    out.push_str(&format!(
        "> 本简报由 Ccode 从 {agent} 会话生成（{}），是结构化摘要而非完整记忆。\n\n",
        sessions::now_iso()
    ));
    out.push_str("## 任务信息\n\n");
    out.push_str(&format!("- 来源 Agent：{agent}\n"));
    out.push_str(&format!("- 项目目录：{cwd}\n"));
    out.push_str(&format!("- 会话标题：{title}\n"));
    out.push_str(&format!("- 会话 ID：{session_id}\n\n"));

    out.push_str("## 对话要点（会话尾部窗口）\n\n");
    let users: Vec<&ChatMessageDto> = messages
        .iter()
        .filter(|m| m.role == "user" && !message_text(m).trim().is_empty())
        .collect();
    if users.is_empty() {
        out.push_str("- （尾窗内没有可摘要的用户消息）\n");
    } else {
        for m in users.iter().rev().take(RECENT_USER_MESSAGES).collect::<Vec<_>>().into_iter().rev() {
            out.push_str(&format!("- 用户：{}\n", snip(&message_text(m), USER_SNIP)));
        }
    }
    let last_assistant = messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant" && !message_text(m).trim().is_empty());
    match last_assistant {
        Some(m) => out.push_str(&format!(
            "\n助手（最后一条回复）：\n\n{}\n\n",
            snip(&message_text(m), ASSISTANT_SNIP)
        )),
        None => out.push_str("\n（尾窗内没有助手回复）\n\n"),
    }

    out.push_str("## 当前 git 状态\n\n");
    match git {
        Some(g) if g.is_repo => {
            out.push_str(&format!(
                "- 分支：{}（领先 {} / 落后 {}）\n",
                if g.branch.is_empty() { "（未命名）" } else { &g.branch },
                g.ahead,
                g.behind
            ));
            if g.files.is_empty() {
                out.push_str("- 工作区干净，无未提交改动\n");
            } else {
                out.push_str(&format!(
                    "- 改动 {} 个文件（+{} -{}）：\n",
                    g.files.len(),
                    g.total_add,
                    g.total_del
                ));
                for f in &g.files {
                    let stat = match (f.additions, f.deletions) {
                        (Some(a), Some(d)) => format!("（+{a} -{d}）"),
                        _ => "（二进制或新增）".to_string(),
                    };
                    out.push_str(&format!("  - {} {} {}\n", f.status, f.path, stat));
                }
            }
        }
        _ => out.push_str("- （项目目录不是 git 仓库）\n"),
    }

    out.push_str("\n## 接力说明\n\n");
    out.push_str(&format!("- 本简报由 Ccode 从 {agent} 会话生成，非完整记忆。\n"));
    out.push_str("- 源会话的完整上下文仍保留在原 Agent 中；请结合项目文件与 git 历史补全背景。\n");
    out.push_str("- 不要假设你知道简报之外的对话细节；不确定时先读代码与相关文件。\n");
    out
}

/// 全文脱敏后按 64KB 上限截断（字符边界对齐），超限追加截断标记
pub(crate) fn redact_and_cap(text: &str) -> String {
    let redacted = sessions::redact_sensitive_text(text);
    if redacted.len() <= BRIEF_CAP {
        return redacted;
    }
    let marker = "\n\n…（简报超过 64KB 上限，尾部已截断）\n";
    let budget = BRIEF_CAP - marker.len();
    let cut = redacted
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|i| *i <= budget)
        .last()
        .unwrap_or(0);
    format!("{}{marker}", &redacted[..cut])
}

/// 解析简报写入路径：默认 <cwd>/.ccode/handoff-<时间>.md；
/// 自定义路径（相对则基于 cwd）的父目录必须 canonicalize 后仍在项目根内，防符号链接逃逸。
fn handoff_target_path(cwd: &str, target_path: Option<&str>) -> Result<PathBuf, String> {
    let root = fs::canonicalize(sessions::expand_tilde(cwd)).map_err(|e| format!("项目目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("项目路径不是目录".into());
    }
    match target_path.map(str::trim).filter(|p| !p.is_empty()) {
        None => {
            // 文件名时间戳：冒号在 Windows 文件名非法，只留字母数字（同 keys.json 备份名约定）
            let stamp: String = sessions::now_iso()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            Ok(root.join(".ccode").join(format!("handoff-{stamp}.md")))
        }
        Some(p) => {
            let expanded = sessions::expand_tilde(p);
            let candidate = {
                let c = PathBuf::from(&expanded);
                if c.is_absolute() { c } else { root.join(c) }
            };
            // 父目录可能尚不存在：向上找最近的已存在祖先 canonicalize 校验（防符号链接逃逸）
            let mut ancestor = candidate.parent().map(Path::to_path_buf);
            let canon = loop {
                let Some(a) = ancestor else {
                    return Err("目标路径无效".into());
                };
                match fs::canonicalize(&a) {
                    Ok(c) => break c,
                    Err(_) => ancestor = a.parent().map(Path::to_path_buf),
                }
            };
            if !canon.starts_with(&root) {
                return Err("目标路径必须位于项目目录内".into());
            }
            Ok(candidate)
        }
    }
}

fn build_handoff_brief_impl(
    agent: &str,
    session_id: &str,
    file_path: &str,
    cwd: &str,
    title: Option<&str>,
    target_path: Option<&str>,
) -> Result<HandoffBriefDto, String> {
    // 有界尾窗（现有分页接口末页）：长会话只读尾部窗口，消息已过脱敏
    let page = sessions::conversation_page_impl(agent, file_path, None)?;
    let git = crate::git_info::git_status_sync(cwd).ok();
    let brief = render_handoff_brief(agent, session_id, cwd, title, &page.messages, git.as_ref());
    let text = redact_and_cap(&brief);
    let path = handoff_target_path(cwd, target_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)?;
    let user_count = page
        .messages
        .iter()
        .filter(|m| m.role == "user" && !message_text(m).trim().is_empty())
        .count()
        .min(RECENT_USER_MESSAGES);
    let file_count = git.as_ref().filter(|g| g.is_repo).map(|g| g.files.len()).unwrap_or(0);
    Ok(HandoffBriefDto {
        file_path: path.to_string_lossy().into_owned(),
        summary: format!("{user_count} 条对话要点 · {file_count} 个改动文件（已脱敏）"),
    })
}

/// 从源会话生成接力简报并原子写入目标路径，返回文件路径与一句话概述
#[tauri::command]
pub async fn build_handoff_brief(
    agent: String,
    session_id: String,
    file_path: String,
    cwd: String,
    title: Option<String>,
    target_path: Option<String>,
) -> Result<HandoffBriefDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_handoff_brief_impl(
            &agent,
            &session_id,
            &file_path,
            &cwd,
            title.as_deref(),
            target_path.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("生成接力简报失败: {e}"))?
}

// ===== 接力链（app.db 小表）：登记时目标会话还不存在，按 agent+cwd 记录，
// 列表扫描到新会话后固化进 session_meta.handoff_from_* =====

pub(crate) fn ensure_handoff_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS handoff_links(
          target_agent TEXT NOT NULL, target_cwd TEXT NOT NULL,
          from_agent TEXT NOT NULL, from_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(target_agent, target_cwd));",
    )
    .map_err(|e| format!("初始化 handoff_links 表失败: {e}"))
}

fn mark_handoff_at(
    conn: &Connection,
    target_agent: &str,
    target_cwd: &str,
    from_agent: &str,
    from_session_id: &str,
) -> Result<(), String> {
    ensure_handoff_table(conn)?;
    conn.execute(
        "INSERT INTO handoff_links(target_agent, target_cwd, from_agent, from_session_id, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(target_agent, target_cwd) DO UPDATE SET from_agent=?3, from_session_id=?4, created_at=?5",
        params![target_agent, target_cwd, from_agent, from_session_id, sessions::now_iso()],
    )
    .map_err(|e| format!("登记接力链失败: {e}"))?;
    Ok(())
}

/// 发起接力时登记：目标 agent + 目录 ← 来源 agent + 会话
#[tauri::command]
pub fn mark_handoff(
    target_agent: String,
    target_cwd: String,
    from_agent: String,
    from_session_id: String,
) -> Result<(), String> {
    let conn = sessions::open_db()?;
    mark_handoff_at(&conn, &target_agent, &target_cwd, &from_agent, &from_session_id)
}

struct HandoffLink {
    target_agent: String,
    target_cwd: String,
    from_agent: String,
    from_session_id: String,
    created_at: String,
}

fn read_handoff_links(conn: &Connection) -> Vec<HandoffLink> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT target_agent, target_cwd, from_agent, from_session_id, created_at FROM handoff_links",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(HandoffLink {
            target_agent: r.get(0)?,
            target_cwd: r.get(1)?,
            from_agent: r.get(2)?,
            from_session_id: r.get(3)?,
            created_at: r.get(4)?,
        })
    });
    rows.map(|rs| rs.flatten().collect()).unwrap_or_default()
}

/// 会话目录与登记目录的等价判定：先做展开后的字符串相等（零开销），
/// 不一致再走归一化（canonicalize + 分隔符/前缀归一），避免每次列表全量 canonicalize
fn cwd_matches(session_path: &str, link_cwd: &str) -> bool {
    let expanded = sessions::expand_tilde(link_cwd);
    if session_path == expanded {
        return true;
    }
    crate::usage::normalize_provenance_path(session_path)
        == crate::usage::normalize_provenance_path(&expanded)
}

/// 把接力链并入列表结果（list_sessions 在 apply_meta 之后调用）：
/// 对每条登记，找该 agent+cwd 下登记时间之后有活动、且尚未固化接力来源的最新会话，
/// 标注并固化进 session_meta，随后消费该登记（接力来源以 session_meta 为准，
/// 同目录之后更新的会话不再被误标）。
pub(crate) fn apply_handoff(conn: &Connection, sessions: &mut [SessionMetaDto]) {
    if ensure_handoff_table(conn).is_err() {
        return;
    }
    for link in read_handoff_links(conn) {
        let mut best: Option<usize> = None;
        for (i, s) in sessions.iter().enumerate() {
            if s.agent != link.target_agent || s.handoff_from_agent.is_some() {
                continue;
            }
            // 只认登记之后有活动的会话，避免把接力标到发起前就存在的旧会话上
            if s.updated_at.as_deref().unwrap_or("") < link.created_at.as_str() {
                continue;
            }
            if !cwd_matches(&s.project_path, &link.target_cwd) {
                continue;
            }
            if best.is_none_or(|b| sessions[b].updated_at < s.updated_at) {
                best = Some(i);
            }
        }
        let Some(i) = best else { continue };
        sessions[i].handoff_from_agent = Some(link.from_agent.clone());
        sessions[i].handoff_from_session = Some(link.from_session_id.clone());
        let _ = conn.execute(
            "INSERT INTO session_meta(agent, session_id, handoff_from_agent, handoff_from_session)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(agent, session_id) DO UPDATE SET handoff_from_agent=?3, handoff_from_session=?4",
            params![sessions[i].agent, sessions[i].session_id, link.from_agent, link.from_session_id],
        );
        // 固化完成即消费登记：接力链以 session_meta 为持久记录
        let _ = conn.execute(
            "DELETE FROM handoff_links WHERE target_agent=?1 AND target_cwd=?2",
            params![link.target_agent, link.target_cwd],
        );
    }
}

/// 供测试与调用方共用的会话 DTO 构造（字段随 sessions.rs 演进，集中一处）
#[cfg(test)]
fn test_session(agent: &str, session_id: &str, project_path: &str, updated_at: &str) -> SessionMetaDto {
    SessionMetaDto {
        agent: agent.into(),
        session_id: session_id.into(),
        project_path: project_path.into(),
        title: None,
        created_at: None,
        updated_at: Some(updated_at.into()),
        file_path: String::new(),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive: true,
        chain_count: 1,
        workspace: None,
        summary: None,
        live: false,
        source: "cli".into(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{BlockDto, ChatMessageDto};

    fn msg(role: &str, text: &str) -> ChatMessageDto {
        ChatMessageDto {
            role: role.into(),
            blocks: vec![BlockDto { kind: "text".into(), text: text.into(), tool_name: None }],
            timestamp: None,
            usage: None,
        }
    }

    fn git_dto() -> GitStatusDto {
        GitStatusDto {
            is_repo: true,
            branch: "main".into(),
            ahead: 2,
            behind: 0,
            files: vec![crate::git_info::GitFileDto {
                path: "src/a.rs".into(),
                status: "M".into(),
                additions: Some(10),
                deletions: Some(3),
            }],
            total_add: 10,
            total_del: 3,
        }
    }

    /// 简报结构：任务信息 / 对话要点（最近用户消息 + 最后助手回复）/ git 状态 / 接力说明
    #[test]
    fn brief_structure_sections() {
        let messages = vec![
            msg("user", "帮我调研 RAG 评测方案"),
            msg("assistant", "好的，我先读一下代码"),
            msg("user", "重点关注召回率指标"),
            msg("assistant", "已完成初稿，结论如下……"),
        ];
        let brief = render_handoff_brief("codex", "sess-12345678", "/tmp/proj", Some("RAG 调研"), &messages, Some(&git_dto()));
        assert!(brief.contains("# 接力简报：RAG 调研"));
        assert!(brief.contains("- 来源 Agent：codex"));
        assert!(brief.contains("- 项目目录：/tmp/proj"));
        assert!(brief.contains("- 会话 ID：sess-12345678"));
        assert!(brief.contains("- 用户：帮我调研 RAG 评测方案"));
        assert!(brief.contains("- 用户：重点关注召回率指标"));
        assert!(brief.contains("助手（最后一条回复）：\n\n已完成初稿，结论如下……"));
        assert!(brief.contains("- 分支：main（领先 2 / 落后 0）"));
        assert!(brief.contains("  - M src/a.rs （+10 -3）"));
        assert!(brief.contains("非完整记忆"));
        // 最早的用户消息只保留最近 5 条（此处 2 条全收）
        assert_eq!(brief.matches("- 用户：").count(), 2);
    }

    /// 空尾窗与非 git 目录的兜底文案
    #[test]
    fn brief_empty_conversation_and_non_repo() {
        let brief = render_handoff_brief("kimi", "abc", "/tmp/x", None, &[], None);
        assert!(brief.contains("未命名对话 · abc"));
        assert!(brief.contains("（尾窗内没有可摘要的用户消息）"));
        assert!(brief.contains("（尾窗内没有助手回复）"));
        assert!(brief.contains("（项目目录不是 git 仓库）"));
    }

    /// 脱敏生效：已知前缀密钥（sk- 开头 ≥12 字符）不得原样进简报
    #[test]
    fn brief_redacts_known_secret_tokens() {
        let secret = "sk-ant-api03-abcdef123456";
        let messages = vec![msg("user", &format!("用这个密钥调试 {secret} 看看"))];
        let brief = render_handoff_brief("claude-code", "s1", "/tmp/p", None, &messages, None);
        let text = redact_and_cap(&brief);
        assert!(!text.contains(secret), "密钥必须脱敏: {text}");
        assert!(text.contains("已隐藏密钥"));
    }

    /// 64KB 上限：超长内容按字符边界截断并带截断标记
    #[test]
    fn brief_cap_truncates_oversized() {
        let big = "数".repeat(80 * 1024); // 多字节字符验证边界对齐
        let text = redact_and_cap(&big);
        assert!(text.len() <= BRIEF_CAP, "超过上限: {}", text.len());
        assert!(text.contains("尾部已截断"));
        // 未超限时原样返回（不脱敏无密钥文本、不加标记）
        let small = redact_and_cap("# 简报\n\n- 用户：你好\n");
        assert!(small.contains("- 用户：你好"));
        assert!(!small.contains("尾部已截断"));
    }

    /// 目标路径：默认落 .ccode/ 下；自定义路径逃出项目根必须拒绝
    #[test]
    fn target_path_default_and_escape_rejected() {
        let root = std::env::temp_dir().join(format!("ccode-handoff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let cwd = root.to_string_lossy().into_owned();
        let default = handoff_target_path(&cwd, None).unwrap();
        assert!(default.starts_with(fs::canonicalize(&root).unwrap()));
        assert!(default.to_string_lossy().contains(".ccode"));
        assert!(default.extension().is_some_and(|e| e == "md"));
        // 相对路径基于项目根
        let rel = handoff_target_path(&cwd, Some("notes/brief.md")).unwrap();
        assert!(rel.ends_with(std::path::Path::new("notes").join("brief.md").as_path()));
        // 绝对路径逃出项目根：拒绝
        assert!(handoff_target_path(&cwd, Some("/tmp/outside-brief.md")).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        sessions::migrate_session_meta(&conn);
        conn
    }

    /// 接力链往返：登记 → 新会话被扫描到后标注并固化；旧会话/异 agent 不误标
    #[test]
    fn handoff_mark_and_apply_round_trip() {
        let conn = test_db();
        mark_handoff_at(&conn, "codex", "/tmp/proj", "claude-code", "src-sess-1").unwrap();

        // 登记时间之前的旧会话（不应被标注）与之后的新会话
        let old = test_session("codex", "old-sess", "/tmp/proj", "2000-01-01T00:00:00Z");
        let new = test_session("codex", "new-sess", "/tmp/proj", "2999-01-01T00:00:00Z");
        let other_agent = test_session("gemini", "g-sess", "/tmp/proj", "2999-01-01T00:00:00Z");
        let mut sessions = vec![old, new, other_agent];
        apply_handoff(&conn, &mut sessions);

        assert!(sessions[0].handoff_from_agent.is_none(), "登记前的旧会话不得标注");
        assert_eq!(sessions[1].handoff_from_agent.as_deref(), Some("claude-code"));
        assert_eq!(sessions[1].handoff_from_session.as_deref(), Some("src-sess-1"));
        assert!(sessions[2].handoff_from_agent.is_none(), "agent 不匹配不得标注");

        // 已固化进 session_meta：换一批 DTO 走 meta 合并口径也能读到（模拟下次列表）
        let persisted: Option<(String, String)> = conn
            .query_row(
                "SELECT handoff_from_agent, handoff_from_session FROM session_meta WHERE agent='codex' AND session_id='new-sess'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        assert_eq!(
            persisted.as_ref().map(|(a, s)| (a.as_str(), s.as_str())),
            Some(("claude-code", "src-sess-1"))
        );
        // 登记已消费：链接表不再保留该接力，固化后同 cwd 更新的会话不再被误标
        assert!(read_handoff_links(&conn).is_empty());

        // 固化后同 cwd 更新的会话不再抢占该标注
        let newer = test_session("codex", "newer-sess", "/tmp/proj", "2999-06-01T00:00:00Z");
        let mut marked = test_session("codex", "new-sess", "/tmp/proj", "2999-01-01T00:00:00Z");
        marked.handoff_from_agent = Some("claude-code".into());
        marked.handoff_from_session = Some("src-sess-1".into());
        let mut sessions = vec![marked, newer];
        apply_handoff(&conn, &mut sessions);
        assert_eq!(sessions[0].handoff_from_agent.as_deref(), Some("claude-code"));
        assert!(sessions[1].handoff_from_agent.is_none(), "已固化后不得转移标注");
    }

    /// 同 agent+cwd 重复登记：后一次覆盖前一次（重新接力语义）
    #[test]
    fn handoff_mark_overwrites_same_target() {
        let conn = test_db();
        mark_handoff_at(&conn, "kimi", "/tmp/p", "codex", "s1").unwrap();
        mark_handoff_at(&conn, "kimi", "/tmp/p", "qwen", "s2").unwrap();
        let links = read_handoff_links(&conn);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].from_agent, "qwen");
        assert_eq!(links[0].from_session_id, "s2");
    }

    /// 接力目标清单覆盖六 CLI，kimi/opencode 标注需手动注入
    #[test]
    fn handoff_targets_cover_registry() {
        let targets = handoff_targets();
        assert_eq!(targets.len(), 6);
        let manual: Vec<&str> = targets
            .iter()
            .filter(|t| !t.prompt_supported)
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(manual, ["opencode", "kimi"]);
    }
}
