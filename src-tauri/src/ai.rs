//! 无头 AI 调用层（§6.12 闭环）：复用 profile 的 launch_plan 注入，
//! 以各 agent 的非交互模式跑一次性 prompt，供提交信息/会话摘要/PR 描述三个生成功能使用。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const AI_TIMEOUT: Duration = Duration::from_secs(120);
const DIFF_CAP: usize = 8 * 1024;

// ===== profile 解析与无头参数 =====

/// 显式 id 优先；其次设置页指定的 AI 专用 profile；否则最近使用（last_used_at 最新）；一个都没有才报错
fn resolve_profile_from(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    dedicated_id: Option<String>,
) -> Result<Profile, String> {
    for id in [profile_id, dedicated_id].into_iter().flatten() {
        if id.trim().is_empty() {
            continue;
        }
        return profiles
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("profile 不存在: {id}（如来自设置页的 AI 专用配置，请到设置页重选）"));
    }
    profiles
        .into_iter()
        .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        .ok_or_else(|| "请先在配置页创建并保存一个 profile".to_string())
}

/// 各 agent 的非交互调用参数（matrix「关键启动参数」列；codex 的 provider -c 参数在 plan.args 里）
fn headless_args(agent: &str, prompt: &str) -> Vec<String> {
    match agent {
        "claude-code" => vec!["-p".into(), prompt.into(), "--output-format".into(), "text".into()],
        // AI 无头调用只读沙箱（只生成文本，不需要写权限）
        "codex" => vec!["exec".into(), "--skip-git-repo-check".into(), "-s".into(), "read-only".into(), prompt.into()],
        "gemini" => vec!["-p".into(), prompt.into()],
        "kimi" => vec!["-p".into(), prompt.into()],
        "opencode" => vec!["run".into(), prompt.into()],
        // qwen 与未知 agent 按位置参数兜底
        _ => vec![prompt.into()],
    }
}

// ===== 进程执行（不走 PTY；stdout/stderr 各开线程读，超时 kill 并返回部分输出） =====

fn tail_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        chars[chars.len() - max..].iter().collect()
    }
}

fn run_capture(cmd: &mut Command, timeout: Duration) -> Result<String, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("启动 agent 失败: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
                let err = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
                if status.success() {
                    let text = out.trim().to_string();
                    if text.is_empty() {
                        return Err("AI 返回为空（无文本输出）".into());
                    }
                    return Ok(text);
                }
                let detail = if err.trim().is_empty() { out } else { err };
                return Err(format!("agent 退出码 {:?}:\n{}", status.code(), tail_chars(detail.trim(), 4000)));
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let out = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
                    let err = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
                    return Err(format!(
                        "AI 调用超时（120s）。部分输出:\n{}",
                        tail_chars(format!("{out}\n{err}").trim(), 4000)
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 agent 失败: {e}")),
        }
    }
}

fn ai_prompt_impl(profiles: Vec<Profile>, profile_id: Option<String>, prompt: String) -> Result<String, String> {
    // 设置页的 AI 专用 profile 作为显式 id 之外的默认（每次现读，改动即时生效）
    let dedicated = crate::settings::read_current().ai_profile_id;
    let profile = resolve_profile_from(profiles, profile_id, dedicated)?;
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在调用瞬间读出注入子进程，与终端启动同一约束
    let key = profiles::get_key(&profile.id);
    let plan = agents::launch_plan(&profile, key, profile.models.first().map(|s| s.as_str()));
    let mut cmd = Command::new(&binary_path);
    for a in &plan.args {
        cmd.arg(a);
    }
    for a in headless_args(&profile.agent, &prompt) {
        cmd.arg(a);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    // 隔离的临时 cwd：防止 agent 把当前项目环境（AGENTS.md 等）混进生成结果
    let cwd = std::env::temp_dir().join(format!("ccode-ai-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&cwd).map_err(|e| format!("创建临时目录失败: {e}"))?;
    cmd.current_dir(&cwd);
    let result = run_capture(&mut cmd, AI_TIMEOUT);
    let _ = fs::remove_dir_all(&cwd);
    result
}

// ===== prompt 构造（纯函数，可测） =====

/// 截断到 max 字节：先对齐 UTF-8 边界，再尽量在换行处收（不切断行）
fn cap_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = text[..end].rfind('\n').map(|i| i + 1).unwrap_or(end);
    let cut = if cut == 0 { end } else { cut };
    format!("{}\n...（内容过长已截断）", &text[..cut])
}

/// 超长时保留首尾、挖掉中间（会话文本用，头尾信息密度最高）
fn cap_text_middle(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let half = max / 2;
    let mut head_end = half;
    while !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = text.len() - half;
    while !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    format!("{}\n...（中间省略）...\n{}", &text[..head_end], &text[tail_start..])
}

fn build_commit_prompt(status: &str, numstat: &str, diff: &str) -> String {
    format!(
        "请根据以下 git 变更生成提交信息。\n\
         要求：第一行是 conventional commits 风格主题（feat/fix/refactor/docs/chore 等开头，≤50 字符）；\
         空一行；再写 1-3 行中文要点。只输出提交信息本身，不要解释、不要包裹引号、不要代码块。\n\n\
         ## git status\n{status}\n\n## git diff --numstat\n{numstat}\n\n## git diff\n{}",
        cap_text(diff, DIFF_CAP)
    )
}

fn build_summary_prompt(conversation: &str) -> String {
    format!(
        "用 3-5 行中文概括下面这个编程会话：目标是什么、做了哪些关键改动、结果如何。\
         不要逐条复述工具调用，不要客套话，直接给概括。\n\n{conversation}"
    )
}

fn build_pr_prompt(log: &str, numstat: &str) -> String {
    format!(
        "根据以下提交记录与 diff 统计，为一个 PR 起草中文描述（markdown），结构：\n\
         ## 变更点（分点列出）\n## 动机\n## 测试情况（如提交里没有测试，说明原因）\n\
         只基于给出的提交记录与统计，不要编造未出现的文件或改动。\n\n\
         ## git log --oneline\n{log}\n\n## diff --numstat\n{numstat}"
    )
}

fn build_conflict_prompt(branch: &str, base: &str, files: &[(String, String)]) -> String {
    let mut body = String::new();
    for (path, content) in files {
        body.push_str(&format!("## 文件 {path}\n{}\n\n", cap_text(content, 4000)));
    }
    format!(
        "你在帮用户解决 git 合并冲突：分支 {branch} 正在把 {base} 并入。\
         下面文件中 <<<<<<< HEAD 与 ======= 之间是「分支侧」内容，======= 与 >>>>>>> 之间是「{base} 侧」内容。\n\
         请逐个文件判断该选哪侧：ours（分支侧合理）、theirs（{base} 侧合理）、\
         manual（两边需要各保留一部分，建议人工逐行合并）。\n\
         只输出 JSON 数组，不要解释、不要代码块：\n\
         [{{\"path\":\"文件路径\",\"choice\":\"ours|theirs|manual\",\"reason\":\"一句话中文理由\"}}]\n\n{body}"
    )
}

/// 从 AI 输出里抠出 JSON 数组解析（模型可能裹 markdown/废话，防御式；失败则全部 manual）
fn parse_conflict_advice(raw: &str, files: &[String]) -> Vec<ConflictAdviceDto> {
    if let (Some(s), Some(e)) = (raw.find('['), raw.rfind(']')) {
        if let Ok(list) = serde_json::from_str::<Vec<ConflictAdviceDto>>(&raw[s..=e]) {
            if !list.is_empty() {
                return list;
            }
        }
    }
    files
        .iter()
        .map(|f| ConflictAdviceDto {
            path: f.clone(),
            choice: "manual".into(),
            reason: format!("AI 输出无法解析：{}", raw.chars().take(80).collect::<String>()),
        })
        .collect()
}

// ===== git 材料收集 =====

fn git_text(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::git_info::run_git(cwd, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn collect_commit_material(cwd: &str) -> Result<(String, String, String), String> {
    let status = git_text(cwd, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Err("工作区干净，没有可提交的变更".into());
    }
    let numstat = git_text(cwd, &["diff", "--numstat", "HEAD"]).unwrap_or_default();
    let diff = git_text(cwd, &["diff", "HEAD"]).unwrap_or_default();
    Ok((status, numstat, diff))
}

/// 会话文本：user/assistant 的 text 块按角色拼起来
fn conversation_text(msgs: &[crate::sessions::ChatMessageDto]) -> String {
    let mut out = String::new();
    for m in msgs {
        for b in &m.blocks {
            if b.kind == "text" && !b.text.trim().is_empty() {
                let role = if m.role == "user" { "用户" } else { "助手" };
                out.push_str(&format!("[{role}] {}\n", b.text.trim()));
            }
        }
    }
    out
}

// ===== Tauri commands =====

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAdviceDto {
    pub path: String,
    /// "ours"（选分支侧）| "theirs"（选 base 侧）| "manual"（建议人工逐行合并）
    pub choice: String,
    pub reason: String,
}

/// 无头一次性 prompt（供前端调试与未来功能复用）
#[tauri::command]
pub async fn ai_prompt(
    store: tauri::State<'_, ProfileStore>,
    profile_id: Option<String>,
    prompt: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || ai_prompt_impl(profiles, profile_id, prompt))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_commit_message(
    store: tauri::State<'_, ProfileStore>,
    cwd: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::sessions::expand_tilde(&cwd);
        let (status, numstat, diff) = collect_commit_material(&cwd)?;
        ai_prompt_impl(profiles, None, build_commit_prompt(&status, &numstat, &diff))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_summarize_session(
    store: tauri::State<'_, ProfileStore>,
    agent: String,
    session_id: String,
    file_path: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let msgs = crate::sessions::conversation_impl(&agent, &file_path);
        let text = conversation_text(&msgs);
        if text.trim().is_empty() {
            return Err("会话内容为空，无法概括".into());
        }
        let summary = ai_prompt_impl(profiles, None, build_summary_prompt(&cap_text_middle(&text, DIFF_CAP)))?;
        crate::sessions::set_session_summary(&agent, &session_id, &summary)?;
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_draft_pr(store: tauri::State<'_, ProfileStore>, id: String) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::workspaces::db()?;
        let w = crate::workspaces::get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        let base = crate::workspaces::base_ref(&wt, &w.base_branch);
        let log = crate::workspaces::run_git(
            &wt,
            &["log", "--oneline", &format!("{base}..HEAD"), "-50"],
            Duration::from_secs(30),
        )?;
        if log.trim().is_empty() {
            return Err("分支上还没有提交，先提交再起草 PR".into());
        }
        let mb = crate::workspaces::run_git(&wt, &["merge-base", &base, "HEAD"], Duration::from_secs(30))?;
        let numstat = crate::workspaces::run_git(
            &wt,
            &["diff", "--numstat", &format!("{mb}..HEAD")],
            Duration::from_secs(30),
        )
        .unwrap_or_default();
        ai_prompt_impl(profiles, None, build_pr_prompt(&log, &numstat))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// AI 冲突审查：读取工作区里待解决的冲突文件，逐个给出选侧建议 + 理由
#[tauri::command]
pub async fn ai_conflict_advice(
    store: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<Vec<ConflictAdviceDto>, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::workspaces::db()?;
        let w = crate::workspaces::get_workspace(&conn, &id)?;
        let wt = PathBuf::from(&w.worktree_path);
        let unmerged = crate::workspaces::run_git(
            &wt,
            &["diff", "--name-only", "--diff-filter=U"],
            Duration::from_secs(10),
        )?;
        let files: Vec<String> = unmerged
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();
        if files.is_empty() {
            return Err("没有待解决的冲突文件（先「并入主分支」产生冲突后再来）".into());
        }
        let mut contents = Vec::new();
        for f in &files {
            let text = fs::read_to_string(wt.join(f)).map_err(|e| format!("读取 {f} 失败: {e}"))?;
            contents.push((f.clone(), text));
        }
        let raw = ai_prompt_impl(profiles, None, build_conflict_prompt(&w.branch, &w.base_branch, &contents))?;
        Ok(parse_conflict_advice(&raw, &files))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::Profile;

    fn profile(id: &str, agent: &str, last_used_at: Option<&str>) -> Profile {
        Profile {
            id: id.into(),
            agent: agent.into(),
            name: id.into(),
            protocol: None,
            base_url: None,
            models: vec![],
            extra_env: std::collections::HashMap::new(),
            key_hint: None,
            model: None,
            has_key: false,
            last_used_at: last_used_at.map(String::from),
        }
    }

    #[test]
    fn profile_resolution_prefers_last_used() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
            profile("c", "gemini", None),
        ];
        // 显式 id 优先
        let p = resolve_profile_from(profiles.clone(), Some("a".into()), None).unwrap();
        assert_eq!(p.id, "a");
        // 否则 last_used_at 最新者；None 排最后
        let p = resolve_profile_from(profiles.clone(), None, None).unwrap();
        assert_eq!(p.id, "b");
        // 全都没用过：取其一（max_by 的稳定首个），不报错
        let fresh = vec![profile("x", "codex", None), profile("y", "gemini", None)];
        assert!(resolve_profile_from(fresh, None, None).is_ok());
        // 空列表报错
        let err = resolve_profile_from(vec![], None, None).unwrap_err();
        assert!(err.contains("请先在配置页创建并保存一个 profile"), "{err}");
        // 不存在的 id 报错
        assert!(resolve_profile_from(profiles, Some("zzz".into()), None).is_err());
    }

    #[test]
    fn profile_resolution_dedicated_beats_last_used_but_not_explicit() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        // 设置页专用 profile 盖过最近使用
        let p = resolve_profile_from(profiles.clone(), None, Some("a".into())).unwrap();
        assert_eq!(p.id, "a");
        // 显式 id 仍最优先
        let p = resolve_profile_from(profiles.clone(), Some("b".into()), Some("a".into())).unwrap();
        assert_eq!(p.id, "b");
        // 专用 id 已被删除：明确报错（提示去设置页重选），不静默回落
        let err = resolve_profile_from(profiles, None, Some("gone".into())).unwrap_err();
        assert!(err.contains("profile 不存在"), "{err}");
    }

    #[test]
    fn headless_args_per_agent() {
        assert_eq!(
            headless_args("claude-code", "你好"),
            vec!["-p", "你好", "--output-format", "text"]
        );
        assert_eq!(headless_args("codex", "你好"), vec!["exec", "--skip-git-repo-check", "-s", "read-only", "你好"]);
        assert_eq!(headless_args("gemini", "你好"), vec!["-p", "你好"]);
        assert_eq!(headless_args("qwen", "你好"), vec!["你好"]);
        assert_eq!(headless_args("kimi", "你好"), vec!["-p", "你好"]);
        assert_eq!(headless_args("opencode", "你好"), vec!["run", "你好"]);
    }

    #[test]
    fn cap_text_respects_boundaries_and_lines() {
        let short = "abc";
        assert_eq!(cap_text(short, 100), "abc");
        // 多字节字符边界：上限落在「中」中间时不炸、不断字
        let text = "中文行一\n中文行二\n中文行三\n";
        let capped = cap_text(text, 8);
        assert!(capped.ends_with("...（内容过长已截断）"));
        assert!(!capped.contains('\u{FFFD}'));
        // 换行处收：尽量保住整行
        let lines = "aaaa\nbbbb\ncccc\n";
        let capped = cap_text(lines, 9);
        assert!(capped.starts_with("aaaa\n"));
        // 中间挖空保留首尾
        let long = "首".repeat(3000) + &"中".repeat(3000) + &"尾".repeat(3000);
        let capped = cap_text_middle(&long, 2000);
        assert!(capped.contains("...（中间省略）..."));
        assert!(capped.starts_with('首'));
        assert!(capped.ends_with('尾'));
    }

    #[test]
    fn parse_conflict_advice_extracts_json_and_falls_back() {
        let files = vec!["a.txt".to_string(), "b.txt".to_string()];
        // 裹了废话/markdown 的输出也能抠出 JSON
        let raw = "好的，分析如下：\n```json\n[{\"path\":\"a.txt\",\"choice\":\"ours\",\"reason\":\"分支侧更新\"}]\n```";
        let list = parse_conflict_advice(raw, &files);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].choice, "ours");
        // 无 JSON → 全部 manual 兜底
        let list = parse_conflict_advice("我不知道", &files);
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|a| a.choice == "manual"));
    }

    #[test]
    fn prompt_builders_contain_material_and_caps() {
        let diff = "line\n".repeat(3000); // ~15KB > 8KB 上限
        let p = build_commit_prompt(" M a.rs", "1\t0\ta.rs", &diff);
        assert!(p.contains("conventional commits"));
        assert!(p.contains(" M a.rs"));
        assert!(p.contains("...（内容过长已截断）"));
        assert!(p.len() < 12000, "prompt 必须被截断: {}", p.len());
        let s = build_summary_prompt("[用户] 修 bug");
        assert!(s.contains("3-5 行"));
        let pr = build_pr_prompt("abc123 feat: x", "5\t1\tsrc/a.rs");
        assert!(pr.contains("## 变更点"));
        assert!(pr.contains("不要编造"));
    }
}
