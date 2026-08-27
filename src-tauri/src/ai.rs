//! 无头 AI 调用层（§6.12 闭环）：复用 profile 的 launch_plan 注入，
//! 以各 agent 的非交互模式跑一次性 prompt，供提交信息/会话摘要/PR 描述三个生成功能使用。

use crate::agents;
use crate::profiles::{self, Profile, ProfileStore};
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

const AI_TIMEOUT: Duration = Duration::from_secs(120);
const DIFF_CAP: usize = 8 * 1024;

// ===== profile 解析与无头参数 =====

/// 内置 AI 功能 key（settings.ai_profiles 的键）：按功能独立指定 profile
pub const FN_COMMIT: &str = "commit"; // ai_commit_message（◈ 提交信息）
pub const FN_SUMMARIZE: &str = "summarize"; // ai_summarize_session（会话摘要）
pub const FN_PR: &str = "pr"; // ai_draft_pr（PR 描述起草）
pub const FN_DISTILL: &str = "distill"; // ai_distill_skill（✦ 沉淀为技能）
pub const FN_CONFLICT: &str = "conflict"; // ai_conflict_advice（冲突选侧建议）
pub const FN_DIGEST: &str = "digest"; // build_session_digest（◈ 提炼接力）+ ai_distill_review（评审沉淀起草）
// 「translate」由 JS 侧（技能页翻译）作为 ai_prompt 的 fnKey 显式传入，Rust 无字面引用
#[allow(dead_code)]
pub const FN_TRANSLATE: &str = "translate";

/// 显式 id 优先；其次该功能的专属 profile（ai_profiles[fn_key]）；再次设置页 AI 专用 profile；
/// 最后最近使用（last_used_at 最新）；一个都没有才报错。
/// 功能专属 id 已失效（被删）视为不存在继续回落；显式/全局专用 id 失效仍明确报错。
/// 软停用（settings.hidden_profiles）只作用于「最近使用」这一自动回落槽：停用项被跳过，
/// 全部被停用时回落含停用项（好过报错哑掉）；显式/专属/专用槽是用户显式绑定，照常尊重
pub(crate) fn resolve_profile_from(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    fn_profile_id: Option<String>,
    dedicated_id: Option<String>,
    hidden_ids: &std::collections::HashSet<String>,
) -> Result<Profile, String> {
    if let Some(id) = profile_id.filter(|v| !v.trim().is_empty()) {
        return profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("profile 不存在: {id}"));
    }
    if let Some(id) = fn_profile_id.filter(|v| !v.trim().is_empty()) {
        if let Some(p) = profiles.iter().find(|p| p.id == id) {
            return Ok(p.clone());
        }
    }
    if let Some(id) = dedicated_id.filter(|v| !v.trim().is_empty()) {
        return profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("profile 不存在: {id}（如来自设置页的 AI 专用配置，请到设置页重选）"));
    }
    profiles
        .iter()
        .filter(|p| !hidden_ids.contains(&p.id))
        .max_by(|a, b| a.last_used_at.cmp(&b.last_used_at))
        .or_else(|| profiles.iter().max_by(|a, b| a.last_used_at.cmp(&b.last_used_at)))
        .cloned()
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
        // codebuddy 位置参数是交互模式；无头必须 -p/--print
        "codebuddy" => vec!["-p".into(), prompt.into()],
        // cursor 无头：-p/--print + --output-format text（与 claude 同形）
        "cursor" => vec!["-p".into(), prompt.into(), "--output-format".into(), "text".into()],
        // grok 无头：-p/--print + --output-format json（**不读 stdin**，prompt 必须走参数）
        "grok" => vec!["-p".into(), prompt.into(), "--output-format".into(), "json".into()],
        "opencode" => vec!["run".into(), prompt.into()],
        // qwen 与未知 agent 按位置参数兜底
        _ => vec![prompt.into()],
    }
}

/// 定时任务（scheduler）的无头参数：与 headless_args 同形，唯一区别是 codex 用
/// workspace-write 沙箱、grok 加 --yolo——定时任务要在项目里写文件（如 lit-watch 的
/// notes/inbox.md、papers/watch-seen.md），read-only 跑不了；grok headless 默认权限模式
/// 未确认（若默认交互式问权限，headless 下非白名单请求会被 Cancelled 导致任务失败），
/// 照 codex `-s workspace-write` 的先例给 grok 加 --yolo（自动批准全部工具，含写文件）
pub(crate) fn headless_task_args(agent: &str, prompt: &str) -> Vec<String> {
    match agent {
        // workspace-write 默认拦网，lit-watch 巡检必须联网；headless 无人可批，不开网必失败
        "codex" => vec!["exec".into(), "--skip-git-repo-check".into(), "-s".into(), "workspace-write".into(), "-c".into(), "sandbox_workspace_write.network_access=true".into(), prompt.into()],
        "grok" => vec!["-p".into(), prompt.into(), "--output-format".into(), "json".into(), "--yolo".into()],
        other => headless_args(other, prompt),
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

pub(crate) fn run_capture(cmd: &mut crate::process::BackgroundCommand, timeout: Duration) -> Result<String, String> {
    // stdin 置空：GUI 环境无控制终端，子进程若读 stdin 会永久挂起
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
                        "AI 调用超时（{}s）。部分输出:\n{}",
                        timeout.as_secs(),
                        tail_chars(format!("{out}\n{err}").trim(), 4000)
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                // try_wait 失败时子进程状态未知：必须 kill + 等读线程收尾，不允许泄漏
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err(format!("等待 agent 失败: {e}"));
            }
        }
    }
}

pub(crate) fn ai_prompt_impl(
    profiles: Vec<Profile>,
    profile_id: Option<String>,
    fn_key: Option<&str>,
    prompt: String,
) -> Result<String, String> {
    // 设置页的按功能/全局专用 profile 作为显式 id 之外的默认（每次现读，改动即时生效）
    let settings = crate::settings::read_current();
    let fn_profile = fn_key.and_then(|k| {
        settings
            .ai_profiles
            .as_ref()
            .and_then(|m| m.get(k).cloned())
    });
    let profile = resolve_profile_from(
        profiles,
        profile_id,
        fn_profile,
        settings.ai_profile_id,
        &settings
            .hidden_profiles
            .unwrap_or_default()
            .into_iter()
            .collect(),
    )?;
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在调用瞬间读出注入子进程，与终端启动同一约束
    let key = profiles::get_key(&profile.id)?;
    let plan = agents::launch_plan(&profile, key, profile.models.first().map(|s| s.as_str()));
    let mut cmd = crate::process::background_command(&binary_path);
    for a in compose_headless_args(&profile.agent, &plan.args, &headless_args(&profile.agent, &prompt)) {
        cmd.arg(a);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    // 官方账号 profile：剔除继承环境里的残留 API 密钥变量（与终端启动同一约束）
    for k in &plan.env_remove {
        cmd.env_remove(k);
    }
    // 隔离的临时 cwd：防止 agent 把当前项目环境（AGENTS.md 等）混进生成结果
    let cwd = std::env::temp_dir().join(format!("ccode-ai-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&cwd).map_err(|e| format!("创建临时目录失败: {e}"))?;
    // 在启动前登记精确来源；usage 只认该登记，不再把用户主动在 /tmp 运行的任务误判为内部活动。
    if let Err(error) = crate::usage::register_internal_ai_run(&profile.agent, &cwd) {
        let _ = fs::remove_dir_all(&cwd);
        return Err(error);
    }
    cmd.current_dir(&cwd);
    let result = run_capture(&mut cmd, AI_TIMEOUT);
    let _ = fs::remove_dir_all(&cwd);
    result
}

/// 定时任务执行段（scheduler 用）：与 ai_prompt_impl 同一注入链路，但 cwd 是传入的
/// 项目目录——不建/删临时目录，也不登记 usage 内部运行：任务跑在用户项目里，
/// token 本来就该按该项目的正常活动归因。密钥同样只在拉起瞬间读出注入。
/// 去掉 plan 参数里的沙箱档位（-s/--sandbox 键值对）：无头场景沙箱档位由各调用点的
/// headless 参数定夺（一次性 prompt = read-only、定时任务 = workspace-write），
/// 与 plan 的默认 workspace-write 并存会让 codex 报「-s 不能重复」直接退出
fn strip_sandbox_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "-s" || a == "--sandbox" {
            skip_next = true;
            continue;
        }
        out.push(a.clone());
    }
    out
}

/// 无头调用的最终参数拼装（plan 注入参数 + 无头形态参数）。
/// codex 的 exec 是子命令：plan 的 -c/-m 必须跟在子命令头之后——实测 codex v0.148 把
/// `-c` 放在 exec 前会被顶层解析静默吞掉（provider 回落到 ~/.codex/config.toml 的默认
/// provider，自定义端点配置整个失效，报错的 401 极具迷惑性）；plan 的默认沙箱档剥离，
/// 由 headless 尾部的档位决定（-s 单值参数，重复即报错）。其余 agent 无子命令，顺序照旧
pub(crate) fn compose_headless_args(agent: &str, plan_args: &[String], headless: &[String]) -> Vec<String> {
    // headless_task_args/headless_args 的 codex 形状固定为 ["exec", "--skip-git-repo-check", …]（有测试钉住）
    const CODEX_HEAD: usize = 2;
    if agent == "codex" && headless.len() >= CODEX_HEAD {
        let mut out = headless[..CODEX_HEAD].to_vec();
        out.extend(strip_sandbox_args(plan_args));
        out.extend(headless[CODEX_HEAD..].iter().cloned());
        out
    } else {
        let mut out = plan_args.to_vec();
        out.extend(headless.iter().cloned());
        out
    }
}

pub(crate) fn run_agent_task(
    profile: &Profile,
    prompt: &str,
    cwd: &std::path::Path,
    timeout: Duration,
) -> Result<String, String> {
    let binary = agents::binary_for(&profile.agent)
        .ok_or_else(|| format!("profile 所属 agent 不支持无头调用: {}", profile.agent))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    let key = profiles::get_key(&profile.id)?;
    let plan = agents::launch_plan(profile, key, profile.models.first().map(|s| s.as_str()));
    let mut cmd = crate::process::background_command(&binary_path);
    for a in compose_headless_args(&profile.agent, &plan.args, &headless_task_args(&profile.agent, prompt)) {
        cmd.arg(a);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    for k in &plan.env_remove {
        cmd.env_remove(k);
    }
    cmd.current_dir(cwd);
    run_capture(&mut cmd, timeout)
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
pub(crate) fn cap_text_middle(text: &str, max: usize) -> String {
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

fn build_commit_prompt(status: &str, numstat: &str, diff: &str, style: Option<&str>) -> String {
    // 状态栏「⚡ Commit & Push」分割菜单的风格偏好（空 = 默认 conventional commits 风格）
    let style_line = style
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("风格偏好（覆盖默认风格要求）：{}\n", s.trim()))
        .unwrap_or_default();
    format!(
        "请根据以下 git 变更生成提交信息。\n\
         要求：第一行是 conventional commits 风格主题（feat/fix/refactor/docs/chore 等开头，≤50 字符）；\
         空一行；再写 1-3 行中文要点。只输出提交信息本身，不要解释、不要包裹引号、不要代码块。\n\
         {style_line}\n\
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

/// 「◈ 提炼接力」：全会话蒸馏成结构化续作简报正文，供新会话读简报续作（非完整记忆）。
/// 用户消息是思想锚点：关键用户消息必须原文摘录；AI 回复只提炼结论。
pub(crate) fn build_digest_prompt(conversation: &str) -> String {
    format!(
        "下面是一个 AI 编程会话的完整对话记录。请把它提炼成一份「接力简报」，\
         供另一个全新的 AI 会话阅读后接着把任务做完——目标是保留续作所需的全部关键信息，\
         同时丢掉寒暄、试错过程与重复内容。\n\
         用户的消息是思想锚点：用户的关键消息（拍板、约束、纠正、偏好）必须原文摘录\
         （用引用块逐条列出），不得改写、翻译或概括掉语气与限定词；助手回复只提炼结论，附在对应用户消息之后。\n\
         只输出中文 markdown 正文（不要解释、不要用代码块包裹全文），按以下小节组织：\n\
         ## 任务目标\n## 关键决策与结论\n## 思路与理由\n## 已否决方向\n\
         ## 已完成的改动（文件 + 要点）\n## 当前状态与未完成事项\n## 下一步建议\n## 环境与约束\n\
         要求：「思路与理由」为每个关键决策附上对话中出现过的理由/动机；\
         「已否决方向」列出考虑过但被否掉的方向及其否决原因，没有则写「无」；\
         不复述工具调用细节；涉及文件写具体路径；其余没有内容的小节写「（无）」。\n\n\
         ## 会话记录\n{conversation}"
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

/// 评审「沉淀到下一步」的 AI 起草 prompt（功能键复用 FN_DIGEST）：
/// 本步的提交清单 + diff 统计 + TASK.md 简报 → 给下一步的任务书草稿小节初稿（人改完才落盘）。
fn build_review_distill_prompt(step_name: &str, task_brief: &str, log: &str, numstat: &str) -> String {
    let brief_section = if task_brief.trim().is_empty() {
        "（本步 TASK.md 未读到，按提交材料起草）".to_string()
    } else {
        cap_text(task_brief, DIFF_CAP)
    };
    format!(
        "你在科研流程的评审现场：步骤刚验收合并，要把评审结论沉淀成给下一步「{step_name}」的草稿小节初稿，\
         由人改完定稿后写进下一步任务书草稿（.ccode/drafts/）。\n\
         只输出中文 markdown 正文（不要解释、不要用代码块包裹全文），按以下小节组织：\n\
         ## 本步验收结论\n## 关键决策与理由\n## 给下一步的要点\n## 风险与待办\n\
         要求：只基于给出的材料，不要编造未出现的文件或结论；没有内容的小节写「（无）」。\n\n\
         ## 本步 TASK.md 简报\n{brief_section}\n\n## git log --oneline\n{log}\n\n## diff --numstat\n{numstat}"
    )
}

fn build_distill_skill_prompt(excerpt: &str) -> String {
    format!(
        "下面这段文字是用户与 AI 助手的一段交互摘录（用户纠正/指导了助手的做法）。\
         请把其中可复用的经验提炼成一个「技能」草稿，供以后让 AI 遵循。\n\
         只输出一个 JSON 对象，不要解释、不要代码块：\n\
         {{\"name\":\"技能目录名（单段安全名称：小写字母/数字/连字符，如 review-paper-notes）\",\
         \"description\":\"一句话中文描述：这个技能帮 AI 做什么\",\
         \"content\":\"SKILL.md 正文（markdown）：整理成规则清单/步骤，直接可执行，不复述原文\"}}\n\n\
         ## 交互摘录\n{excerpt}"
    )
}

/// 从 AI 输出里抠 JSON 对象解析（模型可能裹 markdown/废话，防御式：截取首个 {{ 到末个 }}）
fn parse_skill_draft(raw: &str) -> Result<SkillDraftDto, String> {
    let parse_err = || {
        format!(
            "AI 输出无法解析为技能草稿：{}",
            raw.chars().take(80).collect::<String>()
        )
    };
    let (s, e) = match (raw.find('{'), raw.rfind('}')) {
        (Some(s), Some(e)) if s < e => (s, e),
        _ => return Err(parse_err()),
    };
    let draft: SkillDraftDto =
        serde_json::from_str(&raw[s..=e]).map_err(|_| parse_err())?;
    let name = draft.name.trim().to_lowercase();
    let description = draft.description.trim().to_string();
    let content = draft.content.trim().to_string();
    if name.is_empty() || content.is_empty() {
        return Err(parse_err());
    }
    Ok(SkillDraftDto { name, description, content })
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

fn git_text_selected(cwd: &str, command: &[&str], paths: &[String]) -> Result<String, String> {
    // 统一走二进制解析（GUI 打包版短 PATH 兜底），解析不到再退回裸名
    let git = agents::resolve_binary("git").unwrap_or_else(|| PathBuf::from("git"));
    let mut cmd = crate::process::background_command(git);
    cmd.arg("-C")
        .arg(cwd)
        .arg("--literal-pathspecs")
        .args(command)
        .arg("--")
        .args(paths);
    let out = cmd.output().map_err(|e| format!("执行 git 失败: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn collect_commit_material(
    cwd: &str,
    paths: Option<&[String]>,
) -> Result<(String, String, String), String> {
    let selected = paths
        .map(|paths| crate::git_info::validate_selected_paths(cwd, paths))
        .transpose()?;
    let status = match &selected {
        Some(paths) => git_text_selected(cwd, &["status", "--porcelain"], paths)?,
        None => git_text(cwd, &["status", "--porcelain"])?
    };
    if status.trim().is_empty() {
        return Err("工作区干净，没有可提交的变更".into());
    }
    let numstat = match &selected {
        Some(paths) => git_text_selected(cwd, &["diff", "--numstat", "HEAD"], paths),
        None => git_text(cwd, &["diff", "--numstat", "HEAD"]),
    }
    .unwrap_or_default();
    let diff = match &selected {
        Some(paths) => git_text_selected(cwd, &["diff", "HEAD"], paths),
        None => git_text(cwd, &["diff", "HEAD"]),
    }
    .unwrap_or_default();
    Ok((status, numstat, diff))
}

/// 会话文本：user/assistant 的 text 块按角色拼起来
pub(crate) fn conversation_text(msgs: &[crate::sessions::ChatMessageDto]) -> String {
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

/// 「✦ 沉淀为技能」的草稿：name/description 进 SKILL.md frontmatter，content 为正文规则清单
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillDraftDto {
    pub name: String,
    pub description: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAdviceDto {
    pub path: String,
    /// "ours"（选分支侧）| "theirs"（选 base 侧）| "manual"（建议人工逐行合并）
    pub choice: String,
    pub reason: String,
}

/// 无头一次性 prompt（供前端调试与未来功能复用）；fn_key = 功能 key（见 FN_* 常量），None 走全局默认
#[tauri::command]
pub async fn ai_prompt(
    store: tauri::State<'_, ProfileStore>,
    profile_id: Option<String>,
    fn_key: Option<String>,
    prompt: String,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        ai_prompt_impl(profiles, profile_id, fn_key.as_deref(), prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 「◈ 提交信息」生成；style = 状态栏分割菜单的风格偏好（None = 默认 conventional commits）
#[tauri::command]
pub async fn ai_commit_message(
    store: tauri::State<'_, ProfileStore>,
    cwd: String,
    paths: Option<Vec<String>>,
    style: Option<String>,
) -> Result<String, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::sessions::expand_tilde(&cwd);
        let (status, numstat, diff) = collect_commit_material(&cwd, paths.as_deref())?;
        // 出站前脱敏（与会话摘要同一约束）：diff 可能含误提交的 .env / 粘进代码的密钥
        let status = crate::sessions::redact_sensitive_text(&status);
        let numstat = crate::sessions::redact_sensitive_text(&numstat);
        let diff = crate::sessions::redact_sensitive_text(&diff);
        ai_prompt_impl(
            profiles,
            None,
            Some(FN_COMMIT),
            build_commit_prompt(&status, &numstat, &diff, style.as_deref()),
        )
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
        let summary = ai_prompt_impl(
            profiles,
            None,
            Some(FN_SUMMARIZE),
            build_summary_prompt(&cap_text_middle(&text, DIFF_CAP)),
        )?;
        let summary = crate::sessions::redact_sensitive_text(&summary);
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
        ai_prompt_impl(profiles, None, Some(FN_PR), build_pr_prompt(&log, &numstat))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 评审「沉淀到下一步」的 AI 起草：本步提交清单 + diff 统计 + TASK.md（读不到则省略）→ 初稿文本。
/// 功能键复用 FN_DIGEST（同属「蒸馏简报」场景，不新增设置项）；输出脱敏后返回，
/// 落盘由前端走 append_step_draft 写进下一步任务书草稿（.ccode/drafts/）。
#[tauri::command]
pub async fn ai_distill_review(
    store: tauri::State<'_, ProfileStore>,
    id: String,
    step_name: String,
) -> Result<String, String> {
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
            return Err("分支上还没有提交，无法起草沉淀".into());
        }
        let mb = crate::workspaces::run_git(&wt, &["merge-base", &base, "HEAD"], Duration::from_secs(30))?;
        let numstat = crate::workspaces::run_git(
            &wt,
            &["diff", "--numstat", &format!("{mb}..HEAD")],
            Duration::from_secs(30),
        )
        .unwrap_or_default();
        // TASK.md 是开步脚手架（不进 git），读不到不阻断起草
        let task_brief = fs::read_to_string(wt.join("TASK.md")).unwrap_or_default();
        let raw = ai_prompt_impl(
            profiles,
            None,
            Some(FN_DIGEST),
            build_review_distill_prompt(&step_name, &task_brief, &log, &numstat),
        )?;
        Ok(crate::sessions::redact_sensitive_text(&raw))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 选段「✦ 沉淀为技能」：把交互摘录提炼成技能草稿（前端预填新建技能 modal，保存仍走 create_skill）
#[tauri::command]
pub async fn ai_distill_skill(
    store: tauri::State<'_, ProfileStore>,
    excerpt: String,
) -> Result<SkillDraftDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        // 出站前脱敏（与会话摘要同一约束）：选段可能粘到完整密钥
        let excerpt = crate::sessions::redact_sensitive_text(&excerpt);
        if excerpt.trim().is_empty() {
            return Err("选段为空，无法提炼".into());
        }
        let raw = ai_prompt_impl(
            profiles,
            None,
            Some(FN_DISTILL),
            build_distill_skill_prompt(&cap_text_middle(&excerpt, DIFF_CAP)),
        )?;
        parse_skill_draft(&raw)
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
            // 删/改冲突（一侧已删除）时工作区里文件不存在，直读会 os error 2：
            // 回落到索引两侧（:2 工作区分支 / :3 基准分支）拼内容供 AI 判读
            let text = match fs::read_to_string(wt.join(f)) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let ours =
                        crate::workspaces::run_git_raw(&wt, &["show", &format!(":2:{f}")]).ok();
                    let theirs =
                        crate::workspaces::run_git_raw(&wt, &["show", &format!(":3:{f}")]).ok();
                    match (ours, theirs) {
                        (Some(o), Some(t)) => format!(
                            "<<<<<<< {}（工作区侧）\n{o}\n=======\n{t}\n>>>>>>> {}（基准侧）\n",
                            w.branch, w.base_branch
                        ),
                        (Some(o), None) => format!(
                            "（本文件在基准侧「{}」已删除；以下为工作区侧「{}」内容）\n{o}",
                            w.base_branch, w.branch
                        ),
                        (None, Some(t)) => format!(
                            "（本文件在工作区侧「{}」已删除；以下为基准侧「{}」内容）\n{t}",
                            w.branch, w.base_branch
                        ),
                        (None, None) => {
                            return Err(format!(
                                "读取 {f} 失败: 工作区与索引两侧均无内容（os error 2）"
                            ))
                        }
                    }
                }
                Err(e) => return Err(format!("读取 {f} 失败: {e}")),
            };
            contents.push((f.clone(), text));
        }
        let raw = ai_prompt_impl(profiles, None, Some(FN_CONFLICT), build_conflict_prompt(&w.branch, &w.base_branch, &contents))?;
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
            account_type: Default::default(),
            no_auth: false,
            protocol: None,
            base_url: None,
            models: vec![],
            extra_env: std::collections::HashMap::new(),
            request_policy: crate::profiles::RequestPolicy::default(),
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
        let no_hidden = &Default::default();
        // 显式 id 优先
        let p = resolve_profile_from(profiles.clone(), Some("a".into()), None, None, no_hidden).unwrap();
        assert_eq!(p.id, "a");
        // 否则 last_used_at 最新者；None 排最后
        let p = resolve_profile_from(profiles.clone(), None, None, None, no_hidden).unwrap();
        assert_eq!(p.id, "b");
        // 全都没用过：取其一（max_by 的稳定首个），不报错
        let fresh = vec![profile("x", "codex", None), profile("y", "gemini", None)];
        assert!(resolve_profile_from(fresh, None, None, None, no_hidden).is_ok());
        // 空列表报错
        let err = resolve_profile_from(vec![], None, None, None, no_hidden).unwrap_err();
        assert!(err.contains("请先在配置页创建并保存一个 profile"), "{err}");
        // 不存在的 id 报错
        assert!(resolve_profile_from(profiles, Some("zzz".into()), None, None, no_hidden).is_err());
    }

    #[test]
    fn profile_resolution_dedicated_beats_last_used_but_not_explicit() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        let no_hidden = &Default::default();
        // 设置页专用 profile 盖过最近使用
        let p = resolve_profile_from(profiles.clone(), None, None, Some("a".into()), no_hidden).unwrap();
        assert_eq!(p.id, "a");
        // 显式 id 仍最优先
        let p = resolve_profile_from(profiles.clone(), Some("b".into()), None, Some("a".into()), no_hidden).unwrap();
        assert_eq!(p.id, "b");
        // 专用 id 已被删除：明确报错（提示去设置页重选），不静默回落
        let err = resolve_profile_from(profiles, None, None, Some("gone".into()), no_hidden).unwrap_err();
        assert!(err.contains("profile 不存在"), "{err}");
    }

    #[test]
    fn profile_resolution_fn_specific_beats_dedicated_but_not_explicit() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        let no_hidden = &Default::default();
        // 功能专属盖过全局专用
        let p = resolve_profile_from(profiles.clone(), None, Some("b".into()), Some("a".into()), no_hidden).unwrap();
        assert_eq!(p.id, "b");
        // 显式 id 仍最优先
        let p = resolve_profile_from(profiles.clone(), Some("a".into()), Some("b".into()), None, no_hidden).unwrap();
        assert_eq!(p.id, "a");
        // 功能专属 id 已失效（被删）：视为不存在，回落全局专用
        let p = resolve_profile_from(profiles.clone(), None, Some("gone".into()), Some("a".into()), no_hidden).unwrap();
        assert_eq!(p.id, "a");
        // 功能专属与全局都失效：继续回落最近使用（不报错）
        let p = resolve_profile_from(profiles, None, Some("gone".into()), None, no_hidden).unwrap();
        assert_eq!(p.id, "b");
    }

    #[test]
    fn profile_resolution_hidden_skipped_in_last_used_fallback() {
        let profiles = vec![
            profile("a", "codex", Some("2026-07-01T00:00:00Z")),
            profile("b", "claude-code", Some("2026-07-30T00:00:00Z")),
        ];
        let hidden: std::collections::HashSet<String> = ["b".to_string()].into_iter().collect();
        // 软停用只作用于「最近使用」自动回落：b 更新但被停用 → 挑 a
        let p = resolve_profile_from(profiles.clone(), None, None, None, &hidden).unwrap();
        assert_eq!(p.id, "a");
        // 显式/专属槽是用户显式绑定，停用项照常尊重
        let p = resolve_profile_from(profiles.clone(), Some("b".into()), None, None, &hidden).unwrap();
        assert_eq!(p.id, "b");
        let p = resolve_profile_from(profiles.clone(), None, Some("b".into()), None, &hidden).unwrap();
        assert_eq!(p.id, "b");
        // 全部被停用：回落含停用项，不报错哑掉
        let all_hidden: std::collections::HashSet<String> =
            ["a".to_string(), "b".to_string()].into_iter().collect();
        let p = resolve_profile_from(profiles, None, None, None, &all_hidden).unwrap();
        assert_eq!(p.id, "b");
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
        assert_eq!(headless_args("codebuddy", "你好"), vec!["-p", "你好"]);
        assert_eq!(headless_args("cursor", "你好"), vec!["-p", "你好", "--output-format", "text"]);
    }

    #[test]
    fn headless_task_args_codex_workspace_write_others_same() {
        // 定时任务要写项目文件（notes/inbox.md 等），codex 必须 workspace-write + 开网（巡检要联网）
        assert_eq!(
            headless_task_args("codex", "你好"),
            vec!["exec", "--skip-git-repo-check", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "你好"]
        );
        // 其余 agent 与 headless_args 同形
        assert_eq!(headless_task_args("claude-code", "你好"), headless_args("claude-code", "你好"));
        assert_eq!(headless_task_args("kimi", "你好"), headless_args("kimi", "你好"));
        assert_eq!(headless_task_args("opencode", "你好"), headless_args("opencode", "你好"));
    }

    #[test]
    fn compose_headless_args_codex_puts_plan_args_after_exec() {
        // 回归锚点（实测 codex v0.148）：-c/-m 在 exec 前被顶层解析静默吞掉，
        // provider 回落桌面版 config.toml —— plan 参数必须跟在 exec 子命令头之后；
        // plan 默认带的 -s workspace-write 要剥离，由 headless 尾部的档位定夺（重复即报错）
        let plan = vec![
            "-c".to_string(),
            r#"model_provider="ccode""#.to_string(),
            "-m".to_string(),
            "m1".to_string(),
            "-s".to_string(),
            "workspace-write".to_string(),
        ];
        let out = compose_headless_args("codex", &plan, &headless_task_args("codex", "你好"));
        assert_eq!(
            out,
            vec![
                "exec", "--skip-git-repo-check",
                "-c", r#"model_provider="ccode""#, "-m", "m1",
                "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "你好"
            ]
        );
        // 一次性 prompt 路径：沙箱档 = read-only（plan 的 workspace-write 不重复出现）
        let out_ro = compose_headless_args("codex", &plan, &headless_args("codex", "你好"));
        assert_eq!(
            out_ro,
            vec![
                "exec", "--skip-git-repo-check",
                "-c", r#"model_provider="ccode""#, "-m", "m1",
                "-s", "read-only", "你好"
            ]
        );
        // 其余 agent：plan 在前、无头参数在后（无子命令，旧顺序不变）
        let out2 = compose_headless_args("kimi", &plan, &headless_task_args("kimi", "你好"));
        assert_eq!(out2, vec!["-c", r#"model_provider="ccode""#, "-m", "m1", "-s", "workspace-write", "-p", "你好"]);
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
    fn parse_skill_draft_extracts_json_and_normalizes() {
        // 裹了废话/markdown 的输出也能抠出 JSON；name 归一为小写
        let raw = "好的：\n```json\n{\"name\":\"Paper-Notes \",\"description\":\"整理论文笔记\",\"content\":\"# 规则\\n- 先摘要\"}\n```";
        let d = parse_skill_draft(raw).unwrap();
        assert_eq!(d.name, "paper-notes");
        assert_eq!(d.description, "整理论文笔记");
        assert!(d.content.starts_with("# 规则"));
        // 无 JSON / 缺字段都要报错（前端行内提示，不落半成品）
        assert!(parse_skill_draft("我不知道").is_err());
        assert!(parse_skill_draft("{\"name\":\"x\",\"description\":\"\",\"content\":\"\"}").is_err());
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
    fn digest_prompt_has_sections_and_constraints() {
        let p = build_digest_prompt("[用户] 做一个提炼接力功能");
        for section in [
            "任务目标",
            "关键决策与结论",
            "思路与理由",
            "已否决方向",
            "已完成的改动",
            "当前状态与未完成事项",
            "下一步建议",
            "环境与约束",
        ] {
            assert!(p.contains(section), "缺小节 {section}");
        }
        // 用户消息锚定：关键用户消息必须原文摘录，不得改写
        assert!(p.contains("原文摘录"), "缺用户消息原文锚定要求");
        assert!(p.contains("不要逐条复述工具调用") || p.contains("不复述工具调用"));
        assert!(p.contains("[用户] 做一个提炼接力功能"));
    }

    #[test]
    fn review_distill_prompt_carries_step_and_materials() {
        let p = build_review_distill_prompt(
            "写论文",
            "# 任务\n做数据分析",
            "abc123 feat: 分析",
            "5\t1\tdata/out.csv",
        );
        for section in ["本步验收结论", "关键决策与理由", "给下一步的要点", "风险与待办"] {
            assert!(p.contains(section), "缺小节 {section}");
        }
        assert!(p.contains("下一步「写论文」"));
        assert!(p.contains("做数据分析"));
        assert!(p.contains("abc123"));
        assert!(p.contains("不要编造"));
        // 沉淀去向：写进下一步任务书草稿（不再有「钉卡」口径）
        assert!(p.contains("任务书草稿"), "{p}");
        // TASK.md 缺省时给明确占位，不留空段误导模型
        let p = build_review_distill_prompt("写论文", "", "abc123 x", "");
        assert!(p.contains("未读到"));
    }

    #[test]
    fn prompt_builders_contain_material_and_caps() {        let diff = "line\n".repeat(3000); // ~15KB > 8KB 上限
        let p = build_commit_prompt(" M a.rs", "1\t0\ta.rs", &diff, None);
        assert!(p.contains("conventional commits"));
        assert!(p.contains(" M a.rs"));
        assert!(p.contains("...（内容过长已截断）"));
        assert!(p.len() < 12000, "prompt 必须被截断: {}", p.len());
        // 风格偏好附加进 prompt（状态栏分割菜单的 Customize Prompt）
        let p2 = build_commit_prompt(" M a.rs", "1\t0\ta.rs", "x", Some("全英文，带 emoji"));
        assert!(p2.contains("全英文，带 emoji"));
        assert!(!p.contains("风格偏好"));
        let s = build_summary_prompt("[用户] 修 bug");
        assert!(s.contains("3-5 行"));
        let pr = build_pr_prompt("abc123 feat: x", "5\t1\tsrc/a.rs");
        assert!(pr.contains("## 变更点"));
        assert!(pr.contains("不要编造"));
    }
}
