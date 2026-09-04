//! MCP server 清单与一键分发（规格单一出处 = docs/agent-integration-matrix.md §10，勿凭印象改字段）。
//!
//! 统一模型（Ccode 自有清单 <config>/ccode/mcp-servers.json）→ 各家配置文件的映射层。
//! 分发纪律（红线，见 §10.4）：
//! - 只写用户级配置（项目级在 claude/qwen/cursor/codebuddy 有审批闸，gemini/qwen 未信任目录忽略）；
//! - 目标文件多是混合状态文件，一律读-改-写一个键/段 + 写前备份 + 原子写，绝不整文件覆盖；
//! - 密钥不落明文：清单里 env/header 值允许 `$VAR`/`${VAR}` 引用形式，映射时转各家的间接引用字段；
//! - 企业管理层存在即拒写（claude managed-mcp.json / opencode managed 目录）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

// ===== 统一清单模型 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvPair {
    pub key: String,
    /// 字面值，或 `$VAR` / `${VAR}` 引用环境变量（分发时按各家语法转写，不落明文密钥）
    pub value: String,
}

/// 最近一次连通性体检的沉淀（随清单落盘；DTO 直出前端，error 文案同 check_mcp_server 口径）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLastCheck {
    /// ISO 时间戳（sessions::now_iso 同口径）
    pub at: String,
    pub ok: bool,
    pub latency_ms: u64,
    /// 失败原因；成功为 null
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDto {
    pub id: String,
    /// server 名：各家交集取 [A-Za-z0-9-]（gemini 下划线会让 policy 引擎失效；claude/codex 允许但不取）
    pub name: String,
    /// "stdio" | "remote"
    pub kind: String,
    // stdio
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 可空串；claude/codebuddy/cursor 不写 cwd（未核实支持，matrix §10.2）
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: Vec<McpEnvPair>,
    // remote
    pub url: String,
    #[serde(default)]
    pub headers: Vec<McpEnvPair>,
    /// 分发开关（agent id → 是否分发）
    #[serde(default)]
    pub apps: HashMap<String, bool>,
    /// 全局启用开关（v3.93，matrix §10.2 预留字段落地）：false = 从所有 agent 移除条目
    /// 但保留 apps 映射，重新启用时按原样重投；旧清单无此字段，serde 默认 true
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 来源标记：ccode = 本应用新建；imported:<agent> = 从该 agent 收编；imported:json = 粘贴导入。
    /// 旧清单无此字段反序列化为空串 = 来源未知，删除分流按收编条目对待（宁可少删不可错删）
    #[serde(default)]
    pub origin: String,
    /// 慢启动 server 的启动超时声明（毫秒）：收编 codex/grok 的 startup_timeout_sec 自动带入，
    /// 也可在编辑表单手调；只被体检消费（check_stdio 按 clamp(8s, 30s) 生效），
    /// 分发映射不写它（matrix §10.2：别家无实证等价字段）
    #[serde(default)]
    pub startup_timeout_ms: Option<u64>,
    /// 最近一次体检沉淀（单条/批量检测都会更新；旧清单无此字段）
    #[serde(default)]
    pub last_check: Option<McpLastCheck>,
}

fn default_enabled() -> bool {
    true
}

// ===== 清单存储 =====

// 测试接缝（同 coding.rs TEST_WT_ROOT 先例）：thread_local 只影响设置它的测试线程
#[cfg(test)]
thread_local! {
    static TEST_STORE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    static TEST_HOME: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    static TEST_BACKUP: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn store_path() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(p) = TEST_STORE.with(|c| c.borrow().clone()) {
        return Ok(p);
    }
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("mcp-servers.json"))
}

fn read_store() -> Result<Vec<McpServerDto>, String> {
    let path = store_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("MCP 清单损坏: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 MCP 清单失败: {e}")),
    }
}

fn write_store(list: &[McpServerDto]) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    atomic_write_0600(&path, &text)
}

/// 清单文件 0600 原子写：可能含用户误填的明文密钥，权限与 keys.json 同口径
///（先收窄 tmp 权限再 rename，消除 0644 窗口；Windows 无 0600 语义由目录 ACL 控制）
fn atomic_write_0600(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置权限失败: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))
}

/// server 名校验：各家交集 [A-Za-z0-9-]（gemini 下划线会让 policy 引擎静默失效）
fn validate_server_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("名称只能包含字母、数字、连字符（1-64 字符）".into());
    }
    if name.contains('_') {
        return Err("名称不要含下划线（gemini 的策略引擎按下划线切分，会静默失效）".into());
    }
    Ok(())
}

// ===== JSONC 容错读（gemini/qwen/opencode/codebuddy 容忍注释与尾逗号） =====

/// 去注释 + 尾逗号（字符串/转义状态机，不动字符串内容）；hooks.rs 的 JSONC 容错读也复用
pub(crate) fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // 尾逗号：逗号后只剩空白就接 ]/}（按 char 处理，不动多字节字符）
    let chars: Vec<char> = out.chars().collect();
    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            result.push(c);
            if c == '\\' && i + 1 < chars.len() {
                i += 1;
                result.push(chars[i]);
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            result.push('"');
            i += 1;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == ']' || chars[j] == '}') {
                i += 1; // 丢掉逗号
                continue;
            }
        }
        result.push(c);
        i += 1;
    }
    result
}

fn jsonc_read(path: &Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&strip_jsonc(&text))
        .map_err(|e| format!("{} 解析失败: {e}（已拒写，请先手工修复）", path.display()))
}

// ===== 备份（复用 global_config 的备份根，标签 mcp） =====

fn backup_once(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    #[cfg(test)]
    let dir = match TEST_BACKUP.with(|c| c.borrow().clone()) {
        Some(p) => p,
        None => dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode")
            .join("backups")
            .join("mcp"),
    };
    #[cfg(not(test))]
    let dir = dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("backups")
        .join("mcp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".into());
    let dest = dir.join(format!(
        "{}.{}.bak",
        name,
        crate::sessions::now_iso().replace([':', '.'], "-")
    ));
    std::fs::copy(path, &dest).map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
    Ok(())
}

// ===== env 引用解析 =====

/// `"$VAR"` / `"${VAR}"` → Some("VAR")；其他 → None（字面值）
fn env_ref(value: &str) -> Option<&str> {
    let v = value.trim();
    if let Some(rest) = v.strip_prefix("${") {
        return rest.strip_suffix('}').filter(|s| !s.is_empty());
    }
    v.strip_prefix('$')
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

fn pairs_to_map(pairs: &[McpEnvPair]) -> HashMap<String, String> {
    pairs
        .iter()
        .filter(|p| !p.key.trim().is_empty())
        .map(|p| (p.key.trim().to_string(), p.value.clone()))
        .collect()
}

/// 值里的 $VAR/${VAR} 引用转成目标语法（opencode 用 {env:VAR}，其余保持 ${VAR}）
fn rewrite_refs(value: &str, opencode_style: bool) -> String {
    if !opencode_style {
        return value.to_string();
    }
    let mut out = value.to_string();
    // 只处理整值引用（"Bearer ${X}" 这类内嵌引用 opencode 未核实，保持原样并在文档说明）
    if let Some(name) = env_ref(value) {
        out = format!("{{env:{name}}}");
    }
    out
}

// ===== 各家条目映射（serde_json::Value；codex 单独走 TOML） =====

/// stdio 命令落盘前解析（返回 (命令, 参数)）：
/// 1. 裸名 → 绝对路径（GUI/打包环境 PATH 很短，resolve_binary 候选目录兜底）；
/// 2. 解析结果是 node 系 shim（shebang 为 `#!/usr/bin/env node` 的脚本/symlink，如 npx）→
///    再深一步换成 node 绝对路径 + shim 真实路径作为首参——否则宿主 PATH 没有 node 时
///    照样 spawn ENOENT（shebang 依赖 PATH 里的 node）。解析不到任何一环就保留原样。
fn resolve_command_deep(command: &str, args: &[String]) -> (String, Vec<String>) {
    let name = command.trim();
    let Some(bin) = crate::agents::resolve_binary(name) else {
        return (name.to_string(), args.to_vec());
    };
    // canonicalize 后必须剥 verbatim：`\\?\C:\…\npx.cmd` 写进 claude/codex 配置
    // 部分 CLI 不认，且与前端/其他比较口径分裂。
    let real = crate::paths::canonicalize_plain(&bin)
        .unwrap_or_else(|_| crate::paths::strip_verbatim(bin.clone()));
    #[cfg(windows)]
    if let Some((node, entry)) = crate::process::node_entry_from_cmd_shim(&real) {
        let mut new_args = vec![mcp_path_text(entry)];
        new_args.extend(args.iter().cloned());
        return (mcp_path_text(node), new_args);
    }
    if is_node_shim(&real) {
        if let Some(node) = crate::agents::resolve_binary("node") {
            let mut new_args = vec![mcp_path_text(real)];
            new_args.extend(args.iter().cloned());
            return (mcp_path_text(node), new_args);
        }
    }
    (mcp_path_text(bin), args.to_vec())
}

/// MCP 配置里的路径：剥 Windows verbatim，避免 `\\?\` 落盘。
fn mcp_path_text(path: PathBuf) -> String {
    crate::paths::strip_verbatim(path)
        .to_string_lossy()
        .into_owned()
}

/// 首行 shebang 是 `#!/usr/bin/env node` 的脚本（只读前 128 字节）
fn is_node_shim(path: &Path) -> bool {
    use std::io::Read;
    let mut buf = [0u8; 128];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..read]);
    head.lines()
        .next()
        .is_some_and(|l| l.starts_with("#!") && l.contains("env node"))
}

/// stdio 命令是否是相对路径（./ ../ 及 Windows 反斜杠变体、目录相向前缀）。
/// 相对路径的基准是来源 agent 自己的运行语境（如 codex 插件目录），换个工作目录就找不到
fn is_relative_command(command: &str) -> bool {
    let c = command.trim();
    if c.is_empty() {
        return false;
    }
    let looks_like_path = c.contains('/')
        || c.contains('\\')
        || (c.len() >= 2 && c.as_bytes()[1] == b':');
    // Unix 形态 `/abs/...` 在 Windows 上 Path::is_absolute 为 false（缺盘符前缀），
    // 但仍不是「随 cwd 漂移」的相对路径，不当成相对路径处理。
    let absolute = Path::new(c).is_absolute() || c.starts_with('/');
    looks_like_path && !absolute
}

/// 相对路径命令的解析结果：绝对路径命令 + 规范化后的工作目录
///（cwd 是相对形态（"." "./x" 等）时改成命中所用的基准目录，保留条目对工作目录的语义；
/// 绝对 cwd 保留原值，空 cwd 不动——原配置没声明工作目录，不替它猜）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandFix {
    pub command: String,
    pub cwd: String,
}

/// 相对路径命令的解析基准目录，按序（命中即停，序位即优先级）：
/// 1. 条目自己声明的 cwd（绝对路径时）——条目自带的运行语境最可信；
/// 2. 来源 agent 的配置家目录（agent_paths 写目标的父目录，尊重 CODEX_HOME 等搬迁变量）；
/// 3. 来源 agent 的已知插件/缓存目录（只放有实证的，没有实证的不放）。
/// 去重靠 paths::path_key（禁字符串前缀比较，AGENTS.md 方言层约定）。
fn relative_resolution_bases(cwd: &str, agent: Option<&str>) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |p: PathBuf, bases: &mut Vec<PathBuf>, seen: &mut HashSet<String>| {
        if seen.insert(crate::paths::path_key(&p.to_string_lossy())) {
            bases.push(p);
        }
    };
    let c = cwd.trim();
    if !c.is_empty() && Path::new(c).is_absolute() {
        push(PathBuf::from(c), &mut bases, &mut seen);
    }
    if let Some(agent) = agent {
        if let Ok((write_target, _)) = agent_paths(agent) {
            if let Some(home) = write_target.parent() {
                push(home.to_path_buf(), &mut bases, &mut seen);
                // 有实证的插件/缓存目录（2026-09-03 实机：ChatGPT 桌面版写入 codex 的
                // [mcp_servers.computer-use] 为 command="./Codex Computer Use.app/…" + cwd="."，
                // 只有以 ~/.codex/computer-use 为工作目录拉起才解析得到；2026-08-17 案例同属
                // codex 插件目录）。其余家未观察到相对路径条目，不放
                if agent == "codex" {
                    push(home.join("computer-use"), &mut bases, &mut seen);
                    push(home.join("plugins"), &mut bases, &mut seen);
                }
            }
        }
    }
    bases
}

/// 相对路径命令 → 绝对路径候选（按基准序，路径去重）。
/// base.join(command) 命中已存在的文件即收；多基准同时命中时序位最前的在前，
/// 收编取首候选，一键修复弹层把全量候选交给用户选。
/// Windows 不补 .exe 猜测：实机案例均为精确相对路径，猜扩展名命中率低且会误导选择
fn resolve_relative_candidates(
    command: &str,
    cwd: &str,
    agent: Option<&str>,
) -> Vec<McpCommandFix> {
    if !is_relative_command(command) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for base in relative_resolution_bases(cwd, agent) {
        let joined = base.join(command.trim());
        if !joined.is_file() {
            continue;
        }
        // join("./bin/serve") 会保留 "." 分量：canonicalize 落干净绝对路径（顺带解 symlink）；
        // 失败兜底按分量 lexical 归一（去掉 "." 与重复分隔符）
        let resolved = crate::paths::canonicalize_plain(&joined)
            .unwrap_or_else(|_| joined.components().collect());
        let text = mcp_path_text(resolved);
        if !seen.insert(crate::paths::path_key(&text)) {
            continue;
        }
        let c = cwd.trim();
        let normalized_cwd = if !c.is_empty() && !Path::new(c).is_absolute() {
            mcp_path_text(base.clone())
        } else {
            c.to_string()
        };
        out.push(McpCommandFix {
            command: text,
            cwd: normalized_cwd,
        });
    }
    out
}

/// 分发入口的相对路径处理（先解后拦）：先以条目自己的 cwd（绝对时）为基准尝试解析成
/// 绝对路径；解不出维持拒写，文案具体化——比静默写一个必然 ENOENT 的配置诚实
///（2026-09-03 起替代旧的直接拒写，实机案例见 matrix §10.4）
fn resolve_or_reject_relative(server: &McpServerDto) -> Result<String, String> {
    let c = server.command.trim();
    if !is_relative_command(c) {
        return Ok(c.to_string());
    }
    if let Some(fix) = resolve_relative_candidates(c, &server.cwd, None).first() {
        return Ok(fix.command.clone());
    }
    Err(format!(
        "该 server 的命令是相对路径（{c}）且无法确定基准目录，请改为绝对路径（如 /usr/local/bin/xx）后重试"
    ))
}

fn entry_json(server: &McpServerDto, agent: &str) -> Result<serde_json::Value, String> {
    use serde_json::{json, Map, Value};
    let env: Map<String, Value> = pairs_to_map(&server.env)
        .into_iter()
        .map(|(k, v)| (k, Value::String(rewrite_refs(&v, agent == "opencode"))))
        .collect();
    let headers: Map<String, Value> = pairs_to_map(&server.headers)
        .into_iter()
        .map(|(k, v)| (k, Value::String(rewrite_refs(&v, agent == "opencode"))))
        .collect();
    let mut m = Map::new();
    match agent {
        "claude-code" => {
            m.insert("type".into(), json!(if server.kind == "stdio" { "stdio" } else { "http" }));
        }
        "codebuddy" => {
            m.insert("type".into(), json!(if server.kind == "stdio" { "stdio" } else { "http" }));
        }
        "opencode" => {
            m.insert("type".into(), json!(if server.kind == "stdio" { "local" } else { "remote" }));
        }
        _ => {}
    }
    if server.kind == "stdio" {
        if server.command.trim().is_empty() {
            return Err("stdio 类型必须填命令".into());
        }
        // 相对路径先解后拦：解出绝对路径继续分发，解不出拒写（resolve_or_reject_relative）
        let command = resolve_or_reject_relative(server)?;
        let (command, args) = resolve_command_deep(&command, &server.args);
        if agent == "opencode" {
            // opencode：command 是命令+参数合成的一个数组
            let mut cmd = vec![Value::String(command)];
            cmd.extend(args.iter().map(|a| Value::String(a.clone())));
            m.insert("command".into(), Value::Array(cmd));
            if !env.is_empty() {
                m.insert("environment".into(), Value::Object(env)); // 注意不是 env
            }
        } else {
            m.insert("command".into(), json!(command));
            if !args.is_empty() {
                m.insert("args".into(), json!(args));
            }
            if !env.is_empty() {
                if agent == "kimi" {
                    // kimi 无插值：env 引用形式无法表达，拒写比静默失效诚实
                    for p in &server.env {
                        if env_ref(&p.value).is_some() {
                            return Err(format!(
                                "kimi 不支持 env 引用（{}），请填字面值或改用 headers 的 bearerTokenEnvVar",
                                p.key
                            ));
                        }
                    }
                }
                m.insert("env".into(), Value::Object(env));
            }
        }
        // cwd 只写给核实支持的家（claude/codebuddy/cursor 不写，matrix §10.2）
        if !server.cwd.trim().is_empty() && matches!(agent, "gemini" | "qwen" | "opencode" | "kimi") {
            m.insert("cwd".into(), json!(server.cwd.trim()));
        }
    } else {
        if server.url.trim().is_empty() {
            return Err("remote 类型必须填 URL".into());
        }
        match agent {
            "gemini" | "qwen" => {
                // remote 一律 httpUrl（url = SSE 已 legacy）
                m.insert("httpUrl".into(), json!(server.url.trim()));
            }
            _ => {
                m.insert("url".into(), json!(server.url.trim()));
            }
        }
        if agent == "kimi" {
            // kimi：Authorization: Bearer $X 引头部 → bearerTokenEnvVar；其余引用不支持
            let mut rest: Map<String, Value> = Map::new();
            for p in &server.headers {
                let key = p.key.trim();
                if key.is_empty() {
                    continue;
                }
                let v = p.value.trim();
                let bearer = v
                    .strip_prefix("Bearer ")
                    .or_else(|| v.strip_prefix("bearer "));
                if key.eq_ignore_ascii_case("authorization") {
                    if let Some(b) = bearer {
                        if let Some(name) = env_ref(b) {
                            m.insert("bearerTokenEnvVar".into(), json!(name));
                            continue;
                        }
                    }
                }
                if env_ref(v).is_some() {
                    return Err(format!("kimi 的 header {key} 不支持引用形式，请填字面值"));
                }
                rest.insert(key.to_string(), json!(p.value));
            }
            if !rest.is_empty() {
                m.insert("headers".into(), Value::Object(rest));
            }
        } else if !headers.is_empty() {
            m.insert("headers".into(), Value::Object(headers));
        }
    }
    Ok(Value::Object(m))
}

/// codex 的 TOML 条目（[mcp_servers.<name>]；env 引用走 env_vars/env_http_headers/bearer_token_env_var）
fn entry_toml(server: &McpServerDto) -> Result<toml_edit::Table, String> {
    let mut t = toml_edit::Table::new();
    if server.kind == "stdio" {
        if server.command.trim().is_empty() {
            return Err("stdio 类型必须填命令".into());
        }
        // 相对路径先解后拦：解出绝对路径继续分发，解不出拒写（resolve_or_reject_relative）
        let command = resolve_or_reject_relative(server)?;
        let (command, args) = resolve_command_deep(&command, &server.args);
        t["command"] = toml_edit::value(command.as_str());
        if !args.is_empty() {
            let mut arr = toml_edit::Array::new();
            for a in &args {
                arr.push(a.as_str());
            }
            t["args"] = toml_edit::value(arr);
        }
        let mut env = toml_edit::Table::new();
        let mut env_vars = toml_edit::Array::new();
        for p in &server.env {
            let key = p.key.trim();
            if key.is_empty() {
                continue;
            }
            if let Some(name) = env_ref(&p.value) {
                env_vars.push(name); // codex 无插值：引用 → env_vars 白名单转发
            } else {
                env[key] = toml_edit::value(p.value.as_str());
            }
        }
        if !env.is_empty() {
            t["env"] = toml_edit::Item::Table(env);
        }
        if !env_vars.is_empty() {
            t["env_vars"] = toml_edit::value(env_vars);
        }
        if !server.cwd.trim().is_empty() {
            t["cwd"] = toml_edit::value(server.cwd.trim());
        }
    } else {
        if server.url.trim().is_empty() {
            return Err("remote 类型必须填 URL".into());
        }
        t["url"] = toml_edit::value(server.url.trim());
        let mut headers = toml_edit::Table::new();
        let mut env_headers = toml_edit::Table::new();
        for p in &server.headers {
            let key = p.key.trim();
            if key.is_empty() {
                continue;
            }
            let v = p.value.trim();
            let bearer = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "));
            if key.eq_ignore_ascii_case("authorization") {
                if let Some(b) = bearer {
                    if let Some(name) = env_ref(b) {
                        t["bearer_token_env_var"] = toml_edit::value(name);
                        continue;
                    }
                }
            }
            if let Some(name) = env_ref(v) {
                env_headers[key] = toml_edit::value(name);
            } else {
                headers[key] = toml_edit::value(p.value.as_str());
            }
        }
        if !headers.is_empty() {
            t["http_headers"] = toml_edit::Item::Table(headers);
        }
        if !env_headers.is_empty() {
            t["env_http_headers"] = toml_edit::Item::Table(env_headers);
        }
    }
    Ok(t)
}

// ===== 各家目标文件解析（尊重整体搬迁环境变量；三平台由 home 推导） =====

fn home() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(p) = TEST_HOME.with(|c| c.borrow().clone()) {
        return Ok(p);
    }
    dirs::home_dir().ok_or_else(|| "无法确定用户目录".to_string())
}

fn env_home(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 返回 (写目标, 读候选列表)——codebuddy 有回退链，其他家读=写
fn agent_paths(agent: &str) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let home = home()?;
    Ok(match agent {
        // ~/.claude.json 是高频共享状态文件（user scope）；managed-mcp.json 存在即拒写（§10.4）
        "claude-code" => {
            let base = env_home("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.clone());
            let p = base.join(".claude.json");
            (p.clone(), vec![p])
        }
        "codex" => {
            let base = env_home("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
            let p = base.join("config.toml");
            (p.clone(), vec![p])
        }
        "gemini" => {
            let base = env_home("GEMINI_CLI_HOME").unwrap_or_else(|| home.join(".gemini"));
            let p = base.join("settings.json");
            (p.clone(), vec![p])
        }
        "qwen" => {
            let base = env_home("QWEN_HOME").unwrap_or_else(|| home.join(".qwen"));
            let p = base.join("settings.json");
            (p.clone(), vec![p])
        }
        // 全局目录合并加载 config.json → opencode.json → opencode.jsonc：写已存在者，都不存在建 opencode.jsonc
        "opencode" => {
            let base = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode");
            let candidates = ["config.json", "opencode.json", "opencode.jsonc"]
                .iter()
                .map(|n| base.join(n))
                .collect::<Vec<_>>();
            let write = candidates
                .iter()
                .find(|p| p.exists())
                .cloned()
                .unwrap_or_else(|| base.join("opencode.jsonc"));
            (write, candidates)
        }
        "kimi" => {
            let base = env_home("KIMI_CODE_HOME").unwrap_or_else(|| home.join(".kimi-code"));
            let p = base.join("mcp.json");
            (p.clone(), vec![p])
        }
        // 回退链 .mcp.json → mcp.json（deprecated）；.codebuddy.json 是共享状态文件不碰，缺失则新建 .mcp.json
        "codebuddy" => {
            let base = env_home("CODEBUDDY_CONFIG_DIR").unwrap_or_else(|| home.join(".codebuddy"));
            let primary = base.join(".mcp.json");
            let legacy = base.join("mcp.json");
            let write = if primary.exists() || !legacy.exists() {
                primary.clone()
            } else {
                legacy.clone()
            };
            (write, vec![primary, legacy])
        }
        // CLI 与 IDE 共享（写入同时改变 IDE 行为，UI 需提示）
        "cursor" => {
            let p = home.join(".cursor").join("mcp.json");
            (p.clone(), vec![p])
        }
        // grok：~/.grok/config.toml 的 [mcp_servers.<name>] 段（TOML，不是 JSON）；
        // GROK_HOME 可整体搬迁。首版只做只读清单（agent_entries 解析 TOML），分发/写入
        // 在 apply_to_agent 明确拒绝（grok 自带 `grok mcp add` CLI，不硬造 TOML 原子写管线）
        "grok" => {
            let base = env_home("GROK_HOME").unwrap_or_else(|| home.join(".grok"));
            let p = base.join("config.toml");
            (p.clone(), vec![p])
        }
        _ => return Err(format!("未知 agent: {agent}")),
    })
}

/// 各家的顶层键（opencode 是 mcp，其余 mcpServers；codex 走 TOML 不在此列）
fn top_key(agent: &str) -> &'static str {
    match agent {
        "opencode" => "mcp",
        _ => "mcpServers",
    }
}

/// claude 企业管理层存在即拒写（managed-mcp.json 独占 MCP 配置）
fn check_managed_guard(agent: &str) -> Result<(), String> {
    if agent == "claude-code" {
        let mut paths = vec![
            "/Library/Application Support/ClaudeCode/managed-mcp.json".to_string(),
            "/etc/claude-code/managed-mcp.json".to_string(),
        ];
        if std::env::consts::OS == "windows" {
            paths.push(r"C:\Program Files\ClaudeCode\managed-mcp.json".to_string());
        }
        for p in paths {
            if Path::new(&p).exists() {
                return Err("检测到企业托管 MCP 配置（managed-mcp.json），用户级分发被独占，已跳过".into());
            }
        }
    }
    if agent == "opencode" {
        let mut paths = Vec::new();
        if let Ok(home) = home() {
            let base = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode");
            paths.push(base.join("managed"));
        }
        #[cfg(windows)]
        if let Some(pd) = std::env::var_os("ProgramData") {
            paths.push(PathBuf::from(pd).join("opencode").join("managed"));
        }
        #[cfg(target_os = "macos")]
        paths.push(PathBuf::from("/Library/Application Support/opencode/managed"));
        #[cfg(target_os = "linux")]
        paths.push(PathBuf::from("/etc/opencode/managed"));
        for p in paths {
            if p.exists() {
                return Err("检测到 OpenCode 企业托管配置目录（managed），用户级分发被独占，已跳过".into());
            }
        }
    }
    Ok(())
}

// ===== 读-改-写分发 =====

/// JSON 系七家：写/删 obj[top_key][name]，保留其余一切键；备份 + 原子写 + 读回校验
fn write_json_entry(agent: &str, name: &str, entry: Option<serde_json::Value>) -> Result<(), String> {
    check_managed_guard(agent)?;
    let (path, _) = agent_paths(agent)?;
    let mut root = if path.exists() {
        jsonc_read(&path)?
    } else {
        serde_json::json!({})
    };
    if !root.is_object() {
        return Err(format!("{} 顶层不是 JSON 对象，已拒写", path.display()));
    }
    let expect_present = entry.is_some();
    {
        let obj = root.as_object_mut().expect("已校验 object");
        let key = top_key(agent);
        if !obj.contains_key(key) {
            obj.insert(key.to_string(), serde_json::json!({}));
        }
        let Some(servers) = obj.get_mut(key).and_then(|v| v.as_object_mut()) else {
            return Err(format!("{} 的 {key} 键不是对象，已拒写", path.display()));
        };
        match entry {
            Some(e) => {
                servers.insert(name.to_string(), e);
            }
            None => {
                servers.remove(name);
            }
        }
        // codebuddy 的 disabledMcpServers 是与条目并列的禁用名单：分发/移除时把本条目
        // 从名单里清掉（只动自己名下这一项，其余名字保留）——否则外部禁用后，Ccode 重新
        // 分发重写了条目却仍被名单压着禁用，与 codex 重写即恢复启用的语义不一致
        if agent == "codebuddy" {
            if let Some(list) = obj
                .get_mut("disabledMcpServers")
                .and_then(|v| v.as_array_mut())
            {
                list.retain(|x| x.as_str() != Some(name));
            }
        }
    }
    backup_once(&path)?;
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&path, &text)?;
    // 读回校验：条目按预期存在/消失
    let back = jsonc_read(&path)?;
    let present = back
        .get(top_key(agent))
        .and_then(|v| v.get(name))
        .is_some();
    if present != expect_present {
        return Err(format!("写入 {} 后读回校验失败", path.display()));
    }
    Ok(())
}

/// codex：toml_edit 保格式读-改-写 [mcp_servers.<name>]，其余段不动
fn write_codex_entry(name: &str, entry: Option<toml_edit::Table>) -> Result<(), String> {
    let (path, _) = agent_paths("codex")?;
    let mut doc = if path.exists() {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
        text.parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("{} 解析失败: {e}（已拒写，请先手工修复）", path.display()))?
    } else {
        toml_edit::DocumentMut::new()
    };
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let expect_present = entry.is_some();
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| format!("{} 的 mcp_servers 不是表，已拒写", path.display()))?;
    match entry {
        Some(t) => {
            servers.insert(name, toml_edit::Item::Table(t));
        }
        None => {
            servers.remove(name);
        }
    }
    backup_once(&path)?;
    crate::profiles::atomic_write(&path, &doc.to_string())?;
    // 读回校验
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读回 {} 失败: {e}", path.display()))?;
    let back = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("写入后 {} 无法解析: {e}", path.display()))?;
    let present = back
        .get("mcp_servers")
        .and_then(|t| t.get(name))
        .is_some();
    if present != expect_present {
        return Err(format!("写入 {} 后读回校验失败", path.display()));
    }
    Ok(())
}

/// 写/删一个 agent 侧条目（entry=None 即删除）
fn apply_to_agent(agent: &str, server: &McpServerDto, install: bool) -> Result<(), String> {
    // 只读能力的 agent（grok：TOML [mcp_servers] 与 model 同文件，自带 `grok mcp add`
    // CLI 做读改写，首版不硬造 TOML 原子写管线）按能力表带原因拒绝
    if let Some(crate::agent_specs::McpWriteCap::ReadOnly(reason)) =
        crate::agent_specs::agent_spec(agent).map(|s| s.mcp_write)
    {
        return Err(reason.into());
    }
    if agent == "codex" {
        let entry = if install {
            Some(entry_toml(server)?)
        } else {
            None
        };
        write_codex_entry(&server.name, entry)
    } else {
        let entry = if install {
            Some(entry_json(server, agent)?)
        } else {
            None
        };
        write_json_entry(agent, &server.name, entry)
    }
}

/// 读某 agent 配置里现有的 server 名列表（现状展示 + 漂移检测用）
fn agent_server_names(agent: &str) -> Result<Vec<String>, String> {
    Ok(agent_entries(agent)?.into_iter().map(|(k, _)| k).collect())
}

/// codex 的 TOML 表转 JSON 值（只收 string/array/table，够用且防御）
fn toml_to_json(item: &toml_edit::Item) -> serde_json::Value {
    use serde_json::{Map, Value};
    match item {
        toml_edit::Item::Value(v) => match v {
            toml_edit::Value::String(s) => Value::String(s.value().clone()),
            toml_edit::Value::Integer(i) => Value::Number((*i.value()).into()),
            toml_edit::Value::Float(f) => serde_json::Number::from_f64(*f.value())
                .map(Value::Number)
                .unwrap_or(Value::Null),
            toml_edit::Value::Boolean(b) => Value::Bool(*b.value()),
            toml_edit::Value::Array(a) => {
                Value::Array(a.iter().map(|x| toml_to_json(&toml_edit::Item::Value(x.clone()))).collect())
            }
            _ => Value::Null,
        },
        toml_edit::Item::Table(t) => Value::Object(
            t.iter().map(|(k, v)| (k.to_string(), toml_to_json(v))).collect::<Map<_, _>>(),
        ),
        _ => Value::Null,
    }
}

/// 各家 TOML 配置的段名（codex/grok 都是 mcp_servers，不共用函数体以防 grok 后续分岔）
fn toml_servers_key(agent: &str) -> &'static str {
    match agent {
        _ => "mcp_servers",
    }
}

/// 读某 agent 用户级配置里的完整 server 条目（名称 → 原始 JSON 值）
fn agent_entries(agent: &str) -> Result<Vec<(String, serde_json::Value)>, String> {
    let (_, candidates) = agent_paths(agent)?;
    if agent == "codex" || agent == "grok" {
        // codex：config.toml 的 [mcp_servers.<name>]（分发可写，见 write_codex_entry）
        // grok：同段名同构（TOML），首版只读清单不写——解析成本低且 toml_edit 已在依赖里
        let Some(path) = candidates.iter().find(|p| p.exists()) else {
            return Ok(Vec::new());
        };
        let text = std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
        let doc = text
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("{} 解析失败: {e}", path.display()))?;
        return Ok(doc
            .get(toml_servers_key(agent))
            .and_then(|t| t.as_table())
            .map(|t| {
                t.iter()
                    .map(|(k, v)| (k.to_string(), toml_to_json(v)))
                    .collect()
            })
            .unwrap_or_default());
    }
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let root = jsonc_read(&path)?;
        let entries = root
            .get(top_key(agent))
            .and_then(|v| v.as_object())
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        return Ok(entries);
    }
    Ok(Vec::new())
}

// ===== 反向映射：各家条目 → 统一模型（收编现有配置用；未知字段防御式丢弃） =====

/// 来源配置里的启动超时声明（codex/grok TOML 的 startup_timeout_sec，matrix §10.2）→ 毫秒；
/// 其余家未实证等价字段，不读不猜
fn parse_startup_timeout_ms(v: &serde_json::Value) -> Option<u64> {
    let secs = v.get("startup_timeout_sec").and_then(|x| x.as_f64())?;
    if secs.is_finite() && secs > 0.0 {
        Some((secs * 1000.0) as u64)
    } else {
        None
    }
}

fn reverse_entry(agent: &str, name: &str, v: &serde_json::Value) -> McpServerDto {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let arr = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let pairs = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_object())
            .map(|o| {
                o.iter()
                    .filter_map(|(k, x)| x.as_str().map(|val| McpEnvPair {
                        key: k.clone(),
                        value: val.to_string(),
                    }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    // {env:VAR} → ${VAR}（opencode 插值语法的逆向）
    let unref = |pairs: Vec<McpEnvPair>| -> Vec<McpEnvPair> {
        pairs
            .into_iter()
            .map(|p| {
                let value = p
                    .value
                    .strip_prefix("{env:")
                    .and_then(|r| r.strip_suffix('}'))
                    .map(|n| format!("${{{n}}}"))
                    .unwrap_or(p.value);
                McpEnvPair { key: p.key, value }
            })
            .collect()
    };
    let mut server = McpServerDto {
        id: String::new(),
        name: name.to_string(),
        kind: "stdio".into(),
        command: String::new(),
        args: vec![],
        cwd: String::new(),
        env: vec![],
        url: String::new(),
        headers: vec![],
        apps: HashMap::new(),
        enabled: true,
        // 来源由调用方标记（import_mcp_from_agent / parse_pasted），此处一律未知
        origin: String::new(),
        startup_timeout_ms: parse_startup_timeout_ms(v),
        last_check: None,
    };
    match agent {
        "opencode" => {
            if s("type") == "local" || v.get("command").is_some() {
                let cmd = arr("command");
                server.kind = "stdio".into();
                server.command = cmd.first().cloned().unwrap_or_default();
                server.args = cmd.into_iter().skip(1).collect();
                server.env = unref(pairs("environment"));
            } else {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = unref(pairs("headers"));
            }
            server.cwd = s("cwd");
        }
        "codex" => {
            if v.get("url").is_some() {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = pairs("http_headers");
                // env_http_headers: {Header: VAR} → Header: ${VAR}
                for p in pairs("env_http_headers") {
                    server.headers.push(McpEnvPair {
                        key: p.key,
                        value: format!("${{{}}}", p.value),
                    });
                }
                let bearer = s("bearer_token_env_var");
                if !bearer.is_empty() {
                    server.headers.push(McpEnvPair {
                        key: "Authorization".into(),
                        value: format!("Bearer ${{{bearer}}}"),
                    });
                }
            } else {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
                for name in arr("env_vars") {
                    server.env.push(McpEnvPair {
                        key: name.clone(),
                        value: format!("${{{name}}}"),
                    });
                }
            }
        }
        // grok：与 codex 同构的 [mcp_servers.<name>] TOML 段，但远程另有 `type`("http"/"sse")
        // 且 headers 直收 + bearer_token_env_var 是 env 引用（语义同 codex，无 env_http_headers 中间层）
        "grok" => {
            if v.get("url").is_some() {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = pairs("headers");
                let bearer = s("bearer_token_env_var");
                if !bearer.is_empty() {
                    server.headers.push(McpEnvPair {
                        key: "Authorization".into(),
                        value: format!("Bearer ${{{bearer}}}"),
                    });
                }
            } else {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
            }
        }
        "kimi" => {
            if v.get("url").is_some() {
                server.kind = "remote".into();
                server.url = s("url");
                server.headers = pairs("headers");
                let bearer = s("bearerTokenEnvVar");
                if !bearer.is_empty() {
                    server.headers.push(McpEnvPair {
                        key: "Authorization".into(),
                        value: format!("Bearer ${{{bearer}}}"),
                    });
                }
            } else {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
            }
        }
        _ => {
            // claude/codebuddy/cursor/gemini/qwen：command → stdio，url/httpUrl → remote
            if v.get("command").is_some() {
                server.command = s("command");
                server.args = arr("args");
                server.cwd = s("cwd");
                server.env = pairs("env");
            } else {
                server.kind = "remote".into();
                let url = s("url");
                server.url = if url.is_empty() { s("httpUrl") } else { url };
                server.headers = pairs("headers");
            }
        }
    }
    server
}

/// server 一句话摘要（收编列表展示用）
fn entry_summary(server: &McpServerDto) -> String {
    if server.kind == "stdio" {
        format!("{} {}", server.command, server.args.join(" "))
            .trim()
            .to_string()
    } else {
        server.url.clone()
    }
}

// ===== 明文密钥拦截与外部修改保护 =====

/// env/headers 里疑似明文密钥的「server（键）」清单；$VAR/${VAR} 引用形式不算
fn suspect_plaintext_keys(server: &McpServerDto) -> Vec<String> {
    let mut out = Vec::new();
    for p in server.env.iter().chain(server.headers.iter()) {
        if env_ref(&p.value).is_some() {
            continue;
        }
        if p.value
            .split_whitespace()
            .any(|w| crate::sessions::common_secret_token(w).is_some())
        {
            out.push(format!("{}（{}）", server.name, p.key));
        }
    }
    out
}

/// 外部修改检测：agent 配置里的当前条目 vs 我们此刻会写出的条目（一致才允许静默移除）
fn entry_modified_externally(agent: &str, server: &McpServerDto) -> Result<bool, String> {
    let entries = agent_entries(agent)?;
    let Some((_, current)) = entries.into_iter().find(|(n, _)| *n == server.name) else {
        return Ok(false); // 已不在 = 没什么可保护的
    };
    let expected = if agent == "codex" {
        toml_to_json(&toml_edit::Item::Table(entry_toml(server)?))
    } else {
        entry_json(server, agent)?
    };
    Ok(current != expected)
}

/// 条目级禁用语义只认实证过的三家（matrix §10.1/§10.2 + 2026-09-03 codex 本机实测
/// `enabled = false` 后 `codex mcp list` 显示 disabled）：codex/grok 的 TOML `enabled` 键、
/// codebuddy 的顶层并列 `disabledMcpServers` 名单。其余家未实证有 enabled 语义，
/// 一律不产出「外部已禁用」状态（宁缺毋滥，不猜）。
fn agent_has_enabled_semantics(agent: &str) -> bool {
    matches!(agent, "codex" | "grok" | "codebuddy")
}

/// TOML 系（codex/grok）：条目 `enabled` 缺省 = true
fn toml_entry_disabled(entries: &[(String, serde_json::Value)], name: &str) -> bool {
    entries
        .iter()
        .find(|(n, _)| *n == name)
        .and_then(|(_, v)| v.get("enabled").and_then(|x| x.as_bool()))
        .map(|b| !b)
        .unwrap_or(false)
}

/// codebuddy：顶层 `disabledMcpServers` 名单命中即禁用（与 mcpServers 并列键）
fn codebuddy_disabled(root: &serde_json::Value, name: &str) -> bool {
    root.get("disabledMcpServers")
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)))
}

/// 该条目当前是否在 agent 侧被禁用；不支持 enabled 语义的家恒 false
fn entry_disabled_externally(agent: &str, name: &str) -> Result<bool, String> {
    match agent {
        "codex" | "grok" => Ok(toml_entry_disabled(&agent_entries(agent)?, name)),
        "codebuddy" => {
            let (_, candidates) = agent_paths(agent)?;
            let Some(path) = candidates.iter().find(|p| p.exists()) else {
                return Ok(false);
            };
            Ok(codebuddy_disabled(&jsonc_read(path)?, name))
        }
        _ => Ok(false),
    }
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn list_mcp_servers() -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(read_store)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_mcp_server(
    server: McpServerDto,
    allow_plaintext: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || save_impl(server, allow_plaintext))
        .await
        .map_err(|e| e.to_string())?
}

fn save_impl(mut server: McpServerDto, allow_plaintext: bool) -> Result<Vec<McpServerDto>, String> {
    server.name = server.name.trim().to_string();
    validate_server_name(&server.name)?;
    if server.kind != "stdio" && server.kind != "remote" {
        return Err("类型必须是 stdio 或 remote".into());
    }
    // 明文密钥拦截：引用形式（$VAR）才允许静默通过；PLAINDETECT 前缀供前端识别后确认重试
    let suspects = suspect_plaintext_keys(&server);
    if !allow_plaintext && !suspects.is_empty() {
        return Err(format!("PLAINDETECT:{}", suspects.join("、")));
    }
    let mut list = read_store()?;
    let is_new = server.id.is_empty();
    if is_new {
        if list.iter().any(|s| s.name == server.name) {
            return Err(format!("已存在同名 server: {}", server.name));
        }
        server.id = uuid::Uuid::new_v4().to_string();
        server.origin = "ccode".into(); // 新建只此一个入口（前端传值一律忽略）
        list.push(server.clone());
    } else {
        let Some(pos) = list.iter().position(|s| s.id == server.id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
        if list.iter().any(|s| s.name == server.name && s.id != server.id) {
            return Err(format!("已存在同名 server: {}", server.name));
        }
        server.apps = list[pos].apps.clone(); // 分发开关以开关命令为准，编辑不夹带
        server.enabled = list[pos].enabled; // 全局启用开关同理（set_mcp_server_enabled 管辖）
        server.origin = list[pos].origin.clone(); // 来源标记同理（整结构替换不能丢）
        server.last_check = list[pos].last_check.clone(); // 体检沉淀同理（编辑不是重新检测）
        list[pos] = server.clone();
    }
    // 先重投放到已开启的 agent（内容跟随最新清单），全成功才落库——
    // 顺序反过来会留下「清单说已分发但 agent 侧没写成」的假状态
    for (agent, on) in server.apps.clone() {
        if on {
            apply_to_agent(&agent, &server, true)?;
        }
    }
    write_store(&list)?;
    Ok(list)
}

/// 分发开关：开 = 写入该 agent 用户级配置；关 = 移除同名条目
///（移除前比对内容：该 agent 的条目被外部改过时需 force，防误删用户手调版本）
#[tauri::command]
pub async fn set_mcp_server_app(
    id: String,
    agent: String,
    enabled: bool,
    force: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_specs::agent_spec(&agent).ok_or_else(|| format!("未知 agent: {agent}"))?;
        let mut list = read_store()?;
        let Some(pos) = list.iter().position(|s| s.id == id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
        let server = list[pos].clone();
        if !enabled && !force && entry_modified_externally(&agent, &server)? {
            return Err(format!("EXTMOD:{agent}"));
        }
        apply_to_agent(&agent, &server, enabled)?;
        list[pos].apps.insert(agent, enabled);
        write_store(&list)?;
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 全局启用开关（v3.93）：禁用 = 从所有已分发 agent 移除条目但保留 apps 映射
///（下次启用按原样重投）；禁用的 EXTMOD 预检与 delete 同口径，启用（写入方向）
/// 与 set_app 同口径不查外部修改
#[tauri::command]
pub async fn set_mcp_server_enabled(
    id: String,
    enabled: bool,
    force: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = read_store()?;
        let Some(pos) = list.iter().position(|s| s.id == id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
        let server = list[pos].clone();
        let targets: Vec<String> = server
            .apps
            .iter()
            .filter(|(_, on)| **on)
            .map(|(a, _)| a.clone())
            .collect();
        if !enabled && !force {
            let modified: Vec<String> = targets
                .iter()
                .filter_map(|a| {
                    entry_modified_externally(a, &server)
                        .ok()
                        .filter(|m| *m)
                        .map(|_| a.clone())
                })
                .collect();
            if !modified.is_empty() {
                return Err(format!("EXTMOD:{}", modified.join("、")));
            }
        }
        for agent in &targets {
            apply_to_agent(agent, &server, enabled)?;
        }
        list[pos].enabled = enabled;
        write_store(&list)?;
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除分流：keep_agent_configs=true = 收编条目的安全出口，只从清单移除，
/// 不碰任何 agent 配置文件（跳过 EXTMOD 预检与移除循环——整条目都是从 agent 侧收编的，
/// 默认动作绝不能反向删用户原有配置）；false = 维持完整行为（预检 + 逐 agent 移除）
#[tauri::command]
pub async fn delete_mcp_server(
    id: String,
    force: bool,
    keep_agent_configs: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || delete_impl(&id, force, keep_agent_configs))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_impl(
    id: &str,
    force: bool,
    keep_agent_configs: bool,
) -> Result<Vec<McpServerDto>, String> {
    let mut list = read_store()?;
    let Some(pos) = list.iter().position(|s| s.id == id) else {
        return Err("该 server 不存在（可能已删除）".into());
    };
    if keep_agent_configs {
        list.remove(pos);
        write_store(&list)?;
        return Ok(list);
    }
    let server = list[pos].clone();
    // 外部修改预检全做完再动手（防部分移除后清单与 agent 侧状态错位）
    if !force {
        let modified: Vec<String> = server
            .apps
            .iter()
            .filter(|(_, on)| **on)
            .filter_map(|(agent, _)| {
                entry_modified_externally(agent, &server)
                    .ok()
                    .filter(|m| *m)
                    .map(|_| agent.clone())
            })
            .collect();
        if !modified.is_empty() {
            return Err(format!("EXTMOD:{}", modified.join("、")));
        }
    }
    // 先逐 agent 移除已分发条目（单个失败即停，清单保留便于排查）
    for (agent, on) in &server.apps {
        if *on {
            apply_to_agent(agent, &server, false)?;
        }
    }
    list.remove(pos);
    write_store(&list)?;
    Ok(list)
}

/// 各 agent 用户级配置里现有的 server 名（含非 Ccode 管理的；前端用于漂移/现状展示）
#[tauri::command]
pub async fn mcp_agent_status() -> HashMap<String, Result<Vec<String>, String>> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::agent_specs::all_agent_specs()
            .iter()
            .map(|s| (s.id.to_string(), agent_server_names(s.id)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

// ===== 收编现有配置 + 粘贴 JSON 导入 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpDto {
    pub agent: String,
    pub name: String,
    pub summary: String,
    /// 命令是相对路径（./ ../ 开头）：来源 agent 自己的运行语境下才解析得到，
    /// 收编时 resolver 会尝试落绝对路径；前端在列表行上预警
    pub relative_command: bool,
}

/// 扫描各家用户级配置，列出不在 Ccode 清单里的 server（「发现未纳管」同套路）
#[tauri::command]
pub async fn discover_mcp_servers() -> Result<Vec<DiscoveredMcpDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let known: HashSet<String> = read_store()?.iter().map(|s| s.name.clone()).collect();
        let mut out = Vec::new();
        for spec in crate::agent_specs::all_agent_specs() {
            let entries = match agent_entries(spec.id) {
                Ok(e) => e,
                Err(_) => continue, // 单个 agent 配置损坏不拖垮整体扫描
            };
            for (name, value) in entries {
                if known.contains(&name) {
                    continue;
                }
                let server = reverse_entry(spec.id, &name, &value);
                out.push(DiscoveredMcpDto {
                    agent: spec.id.to_string(),
                    relative_command: server.kind == "stdio"
                        && is_relative_command(&server.command),
                    summary: entry_summary(&server),
                    name,
                });
            }
        }
        out.sort_by(|a, b| a.agent.cmp(&b.agent).then(a.name.cmp(&b.name)));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 收编结果：更新后的清单 + 相对路径命令的处理计数（前端 toast 附注用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportOutcome {
    pub servers: Vec<McpServerDto>,
    /// 相对路径已解析为绝对路径的条数
    pub resolved: usize,
    /// 相对路径未能解析、照原样收进来的条数（清单页有告警与一键修复兜底）
    pub unresolved: usize,
}

/// stdio 相对路径命令的收编解析：命中首候选 → 存绝对路径 + cwd 规范化；
/// 全不命中 → 照原样收进来（fail-open：收编不是写 agent 配置，存下来让用户在清单里
/// 看到再修比拒收好；未解析条目由 mcp_command_path_status 的 relative 态持续告警）。
/// 返回 (resolved, unresolved) 计数
fn resolve_on_import(server: &mut McpServerDto, agent: Option<&str>) -> (usize, usize) {
    if server.kind != "stdio" || !is_relative_command(&server.command) {
        return (0, 0);
    }
    match resolve_relative_candidates(&server.command, &server.cwd, agent).first() {
        Some(fix) => {
            server.command = fix.command.clone();
            server.cwd = fix.cwd.clone();
            (1, 0)
        }
        None => (0, 1),
    }
}

/// 收编：把某 agent 配置里的既有 server 读进 Ccode 清单，并标记已分发到该 agent
#[tauri::command]
pub async fn import_mcp_from_agent(
    agent: String,
    name: String,
) -> Result<McpImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || import_from_agent_impl(&agent, &name))
        .await
        .map_err(|e| e.to_string())?
}

fn import_from_agent_impl(agent: &str, name: &str) -> Result<McpImportOutcome, String> {
    crate::agent_specs::agent_spec(agent).ok_or_else(|| format!("未知 agent: {agent}"))?;
    let mut list = read_store()?;
    if list.iter().any(|s| s.name == name) {
        return Err(format!("清单里已有同名 server: {name}"));
    }
    let entries = agent_entries(agent)?;
    let Some((_, value)) = entries.into_iter().find(|(n, _)| *n == name) else {
        return Err(format!("{} 的配置里找不到 server {name}", agent));
    };
    let mut server = reverse_entry(agent, name, &value);
    let (resolved, unresolved) = resolve_on_import(&mut server, Some(agent));
    server.id = uuid::Uuid::new_v4().to_string();
    server.apps.insert(agent.to_string(), true); // 已在该 agent 配置里，标记已分发
    server.origin = format!("imported:{agent}"); // 收编来源：删除分流据此默认仅从清单移除
    list.push(server);
    write_store(&list)?;
    Ok(McpImportOutcome {
        servers: list,
        resolved,
        unresolved,
    })
}

/// 粘贴 JSON 的纯解析（不写库）：剥包裹层 + 通用形状解析 + 标出将与清单重名被跳过的。
/// 相对路径命令同收编口径尝试解析（粘贴无来源 agent，基准只有条目自己的 cwd）。
/// 返回 (解析出的 server 预览, 同名跳过名单, 疑似明文密钥清单, (相对路径已解析数, 未解析数))
fn parse_pasted(
    text: &str,
) -> Result<(Vec<McpServerDto>, Vec<String>, Vec<String>, (usize, usize)), String> {
    let v: serde_json::Value = serde_json::from_str(strip_jsonc(text).as_str())
        .map_err(|e| format!("不是合法 JSON: {e}"))?;
    let obj = v.as_object().ok_or("必须是 JSON 对象")?;
    // 剥包裹层
    let map = obj
        .get("mcpServers")
        .or_else(|| obj.get("mcp_servers"))
        .or_else(|| obj.get("mcp"))
        .and_then(|v| v.as_object())
        .unwrap_or(obj);
    let existing: HashSet<String> = read_store()?.iter().map(|s| s.name.clone()).collect();
    let mut parsed = Vec::new();
    let mut skipped = Vec::new();
    let mut suspects = Vec::new();
    let mut resolved = 0usize;
    let mut unresolved = 0usize;
    for (name, value) in map {
        let name = name.trim().to_string();
        if name.is_empty() || !value.is_object() {
            continue;
        }
        if existing.contains(&name) {
            skipped.push(name);
            continue;
        }
        validate_server_name(&name).map_err(|e| format!("「{name}」: {e}"))?;
        // 通用形状解析（claude 风格字段；gemini 的 httpUrl 也认）
        let mut server = reverse_entry("claude-code", &name, value);
        if server.kind == "stdio" && server.command.is_empty() && !s_get(value, "url").is_empty() {
            server.kind = "remote".into();
            server.url = s_get(value, "url");
        }
        if server.kind == "remote" && server.url.is_empty() {
            server.url = s_get(value, "httpUrl");
        }
        let (r, u) = resolve_on_import(&mut server, None);
        resolved += r;
        unresolved += u;
        server.id = uuid::Uuid::new_v4().to_string();
        server.origin = "imported:json".into(); // 粘贴导入同收编对待：删除默认仅从清单移除
        suspects.extend(suspect_plaintext_keys(&server));
        parsed.push(server);
    }
    if parsed.is_empty() && skipped.is_empty() {
        return Err("没有解析出任何 server 条目（期望 {\"mcpServers\": {...}} 形状）".into());
    }
    Ok((parsed, skipped, suspects, (resolved, unresolved)))
}

/// 粘贴导入预览：只解析不写库（前端展示将添加的命令清单，确认后才调 import_mcp_json）
#[tauri::command]
pub async fn parse_mcp_json(
    text: String,
) -> Result<(Vec<McpServerDto>, Vec<String>, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (parsed, skipped, suspects, _) = parse_pasted(&text)?;
        Ok((parsed, skipped, suspects))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 粘贴 JSON 导入：确认预览后落库。同名跳过。明文密钥需 allow_plaintext 确认。
/// 返回 (新增, 跳过, 相对路径已解析数, 相对路径未解析数)
#[tauri::command]
pub async fn import_mcp_json(
    text: String,
    allow_plaintext: bool,
) -> Result<(Vec<String>, Vec<String>, usize, usize), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (parsed, skipped, suspects, counts) = parse_pasted(&text)?;
        if !allow_plaintext && !suspects.is_empty() {
            return Err(format!("PLAINDETECT:{}", suspects.join("、")));
        }
        let mut list = read_store()?;
        let added: Vec<String> = parsed.iter().map(|s| s.name.clone()).collect();
        list.extend(parsed);
        write_store(&list)?;
        Ok((added, skipped, counts.0, counts.1))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn s_get(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_server() -> McpServerDto {
        McpServerDto {
            id: "t1".into(),
            name: "fs-tools".into(),
            kind: "stdio".into(),
            // 必定不存在的命令名：resolve_binary 解析不到时回退原名，断言不受机器环境影响
            command: "ccode-test-nonexistent-bin".into(),
            args: vec!["-y".into(), "some-mcp".into()],
            cwd: "/tmp".into(),
            env: vec![
                McpEnvPair { key: "DEBUG".into(), value: "1".into() },
                McpEnvPair { key: "TOKEN".into(), value: "${MY_TOKEN}".into() },
            ],
            url: String::new(),
            headers: vec![],
            apps: HashMap::new(),
            enabled: true,
            origin: String::new(),
            startup_timeout_ms: None,
            last_check: None,
        }
    }

    fn remote_server() -> McpServerDto {
        McpServerDto {
            id: "t2".into(),
            name: "remote-api".into(),
            kind: "remote".into(),
            command: String::new(),
            args: vec![],
            cwd: String::new(),
            env: vec![],
            url: "https://example.com/mcp".into(),
            headers: vec![McpEnvPair {
                key: "Authorization".into(),
                value: "Bearer ${MCP_TOKEN}".into(),
            }],
            apps: HashMap::new(),
            enabled: true,
            origin: String::new(),
            startup_timeout_ms: None,
            last_check: None,
        }
    }

    #[test]
    fn jsonc_strips_comments_and_trailing_commas_keeps_strings() {
        let text = r#"{
            // 行注释
            "a": "http://x//not-comment",
            "b": [1, 2,], /* 块注释 */ "c": "}",
        }"#;
        let v: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(v["a"], "http://x//not-comment");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
        assert_eq!(v["c"], "}");
    }

    #[test]
    fn env_ref_parses_two_forms() {
        assert_eq!(env_ref("$FOO"), Some("FOO"));
        assert_eq!(env_ref("${FOO}"), Some("FOO"));
        assert_eq!(env_ref("Bearer $FOO"), None); // 内嵌不算整值引用
        assert_eq!(env_ref("plain"), None);
    }

    #[test]
    fn relative_stdio_command_rejected_on_distribute() {
        // 先解后拦：条目 cwd（/tmp，绝对）下解不出 ./plugins/foo/bin/serve → 维持拒写
        // 并引导改绝对路径，比静默写必挂配置诚实
        let mut s = stdio_server();
        s.command = "./plugins/foo/bin/serve".into();
        let err = entry_json(&s, "kimi").unwrap_err();
        assert!(err.contains("相对路径"), "{err}");
        assert!(err.contains("绝对路径"), "{err}");
        assert!(err.contains("无法确定基准目录"), "{err}");
        let err = entry_toml(&s).unwrap_err();
        assert!(err.contains("相对路径"), "{err}");
        s.command = "../up/serve".into();
        assert!(entry_json(&s, "claude-code").is_err());
        // 绝对路径与裸名不受影响（用 claude-code 做正例：kimi 会拒写 stdio_server 里的 env 引用）
        s.command = "/abs/path/serve".into();
        assert!(entry_json(&s, "claude-code").is_ok());
        #[cfg(windows)]
        {
            s.command = r"C:\abs\path\serve.exe".into();
            assert!(entry_json(&s, "claude-code").is_ok());
            s.command = r"dir\sub\serve.exe".into();
            assert!(entry_json(&s, "claude-code").is_err());
        }
        s.command = "ccode-test-nonexistent-bin".into();
        assert!(entry_json(&s, "claude-code").is_ok());
    }

    #[test]
    fn mapping_claude_http_and_stdio() {
        let s = stdio_server();
        let v = entry_json(&s, "claude-code").unwrap();
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["command"], "ccode-test-nonexistent-bin");
        // claude 不写 cwd（未核实支持）
        assert!(v.get("cwd").is_none());
        // ${VAR} 引用原样保留
        assert_eq!(v["env"]["TOKEN"], "${MY_TOKEN}");
        let r = entry_json(&remote_server(), "claude-code").unwrap();
        assert_eq!(r["type"], "http");
        assert_eq!(r["headers"]["Authorization"], "Bearer ${MCP_TOKEN}");
    }

    #[test]
    fn mapping_opencode_local_array_and_env_rename() {
        let v = entry_json(&stdio_server(), "opencode").unwrap();
        assert_eq!(v["type"], "local");
        assert_eq!(v["command"], serde_json::json!(["ccode-test-nonexistent-bin", "-y", "some-mcp"]));
        assert_eq!(v["environment"]["DEBUG"], "1");
        // ${VAR} → {env:VAR}
        assert_eq!(v["environment"]["TOKEN"], "{env:MY_TOKEN}");
        assert!(v.get("env").is_none(), "opencode 的字段叫 environment");
    }

    #[test]
    fn mapping_gemini_remote_uses_httpurl() {
        let v = entry_json(&remote_server(), "gemini").unwrap();
        assert_eq!(v["httpUrl"], "https://example.com/mcp");
        assert!(v.get("url").is_none(), "remote 不写 url（SSE 已 legacy）");
    }

    #[test]
    fn mapping_kimi_bearer_ref_to_env_var() {
        let v = entry_json(&remote_server(), "kimi").unwrap();
        assert_eq!(v["bearerTokenEnvVar"], "MCP_TOKEN");
        assert!(v.get("headers").is_none());
        // stdio env 引用对 kimi 是硬错误
        assert!(entry_json(&stdio_server(), "kimi").is_err());
    }

    #[test]
    fn mapping_kimi_stdio_shape_args_array_no_empty_cwd() {
        // 回归：kimi 的 stdio 条目必须是 command + args 数组；cwd 为空时绝不落键
        //（外部编辑器曾把启动参数写进 cwd 导致 spawn ENOENT，Ccode 写出的形状必须干净）
        let mut s = stdio_server();
        s.cwd = String::new();
        s.env = vec![]; // 本测试只看 command/args/cwd 形状（kimi 的 env 引用拒写有独立用例覆盖）
        let v = entry_json(&s, "kimi").unwrap();
        assert!(v.get("cwd").is_none(), "空 cwd 不落键");
        assert_eq!(
            v["args"],
            serde_json::json!(["-y", "some-mcp"]),
            "args 必须是数组"
        );
        // 填了 cwd 才写（kimi 支持 cwd）
        s.cwd = "/tmp".into();
        assert_eq!(entry_json(&s, "kimi").unwrap()["cwd"], "/tmp");
    }

    #[test]
    fn mapping_codex_toml_ref_channels() {
        let t = entry_toml(&stdio_server()).unwrap();
        assert_eq!(t["command"].as_str(), Some("ccode-test-nonexistent-bin"));
        assert_eq!(t["env"]["DEBUG"].as_str(), Some("1"));
        // 引用进 env_vars 白名单，不落 env 明文
        assert!(t["env"].get("TOKEN").is_none());
        assert_eq!(t["env_vars"][0].as_str(), Some("MY_TOKEN"));
        let rt = entry_toml(&remote_server()).unwrap();
        assert_eq!(rt["bearer_token_env_var"].as_str(), Some("MCP_TOKEN"));
        assert!(rt.get("http_headers").is_none());
    }

    #[test]
    fn name_validation_intersection() {
        assert!(validate_server_name("fs-tools2").is_ok());
        assert!(validate_server_name("has space").is_err());
        assert!(validate_server_name("with_under").is_err(), "下划线禁（gemini policy）");
        assert!(validate_server_name("").is_err());
    }

    #[test]
    fn reverse_mapping_codex_refs_and_bearer() {
        let v = serde_json::json!({
            "url": "https://x/mcp",
            "http_headers": {"X-Region": "us"},
            "env_http_headers": {"X-Key": "MY_KEY"},
            "bearer_token_env_var": "MCP_TOKEN"
        });
        let s = reverse_entry("codex", "r", &v);
        assert_eq!(s.kind, "remote");
        assert_eq!(s.url, "https://x/mcp");
        assert!(s.headers.iter().any(|p| p.key == "X-Region" && p.value == "us"));
        assert!(s.headers.iter().any(|p| p.key == "X-Key" && p.value == "${MY_KEY}"));
        assert!(s
            .headers
            .iter()
            .any(|p| p.key == "Authorization" && p.value == "Bearer ${MCP_TOKEN}"));
        // stdio：env_vars 转回 ${VAR} 引用
        let v2 = serde_json::json!({"command": "npx", "args": ["-y"], "env_vars": ["MY_TOKEN"]});
        let s2 = reverse_entry("codex", "t", &v2);
        assert_eq!(s2.command, "npx");
        assert_eq!(s2.env[0].key, "MY_TOKEN");
        assert_eq!(s2.env[0].value, "${MY_TOKEN}");
    }

    #[test]
    fn reverse_mapping_opencode_array_and_unref() {
        let v = serde_json::json!({
            "type": "local",
            "command": ["npx", "-y", "pkg"],
            "environment": {"TOKEN": "{env:MY_TOKEN}", "DEBUG": "1"}
        });
        let s = reverse_entry("opencode", "fs", &v);
        assert_eq!(s.kind, "stdio");
        assert_eq!(s.command, "npx");
        assert_eq!(s.args, vec!["-y", "pkg"]);
        assert!(s.env.iter().any(|p| p.key == "TOKEN" && p.value == "${MY_TOKEN}"));
        assert!(s.env.iter().any(|p| p.key == "DEBUG" && p.value == "1"));
    }

    #[test]
    fn reverse_mapping_gemini_httpurl_and_kimi_bearer() {
        let v = serde_json::json!({"httpUrl": "https://x/mcp", "headers": {"A": "b"}});
        let s = reverse_entry("gemini", "r", &v);
        assert_eq!(s.kind, "remote");
        assert_eq!(s.url, "https://x/mcp");
        let kv = serde_json::json!({"url": "https://x/mcp", "bearerTokenEnvVar": "TOK"});
        let ks = reverse_entry("kimi", "r", &kv);
        assert!(ks
            .headers
            .iter()
            .any(|p| p.key == "Authorization" && p.value == "Bearer ${TOK}"));
    }

    #[test]
    fn plaintext_secret_detection() {
        let mut s = stdio_server();
        s.env = vec![
            McpEnvPair { key: "OK".into(), value: "1".into() },
            McpEnvPair { key: "REF".into(), value: "${MY_TOKEN}".into() },
            McpEnvPair { key: "KEY".into(), value: "sk-abcdef1234567890".into() },
        ];
        s.headers = vec![McpEnvPair {
            key: "Authorization".into(),
            value: "Bearer sk-abcdef1234567890".into(),
        }];
        let suspects = suspect_plaintext_keys(&s);
        // 引用形式放行；裸 sk- 与 Bearer 内嵌 sk- 都拦截
        assert_eq!(suspects.len(), 2, "{suspects:?}");
        assert!(suspects.iter().any(|x| x.contains("KEY")));
        assert!(suspects.iter().any(|x| x.contains("Authorization")));
        assert!(!suspects.iter().any(|x| x.contains("REF")));
        assert!(!suspects.iter().any(|x| x.contains("OK")));
    }

    #[test]
    fn mcp_path_text_strips_verbatim_prefix() {
        let p = PathBuf::from(r"\\?\C:\Users\x\AppData\Roaming\npm\npx.cmd");
        let text = mcp_path_text(p);
        assert!(!text.starts_with(r"\\?\"), "{text}");
        assert!(text.ends_with(r"\npx.cmd") || text.ends_with("/npx.cmd"), "{text}");
    }

    #[test]
    fn is_relative_command_catches_windows_and_unix_shapes() {
        assert!(!is_relative_command("npx"));
        assert!(!is_relative_command("/usr/bin/npx"));
        assert!(is_relative_command("./serve"));
        assert!(is_relative_command("../bin/serve"));
        assert!(is_relative_command(r".\serve"));
        assert!(is_relative_command(r"dir\sub\serve.exe"));
        assert!(is_relative_command("dir/sub/serve"));
        #[cfg(windows)]
        {
            assert!(!is_relative_command(r"C:\tools\serve.exe"));
            assert!(is_relative_command("C:rel.exe"));
            assert!(!is_relative_command(r"\\?\C:\tools\serve.exe"));
        }
    }

    #[test]
    fn node_shim_detected_by_shebang() {
        let dir = std::env::temp_dir().join(format!("ccode-shim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("npx");
        std::fs::write(&shim, "#!/usr/bin/env node\nconsole.log(1)\n").unwrap();
        assert!(is_node_shim(&shim));
        let other = dir.join("tool");
        std::fs::write(&other, "#!/bin/sh\necho hi\n").unwrap();
        assert!(!is_node_shim(&other));
        assert!(!is_node_shim(&dir.join("missing")), "读不到不算 shim");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn json_write_read_roundtrip_and_remove() {
        let dir = std::env::temp_dir().join(format!("ccode-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{\n  // 用户注释\n  \"other\": {\"keep\": true},\n}\n").unwrap();
        // 直接调底层：构造一个假的 agent 路径不可行（agent_paths 写死），
        // 这里验证 jsonc_read + 写回保留其他键的核心语义
        let mut root = jsonc_read(&path).unwrap();
        root["mcpServers"] = serde_json::json!({"fs-tools": {"command": "npx"}});
        crate::profiles::atomic_write(&path, &serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let back = jsonc_read(&path).unwrap();
        assert_eq!(back["other"]["keep"], true, "无关键必须保留");
        assert_eq!(back["mcpServers"]["fs-tools"]["command"], "npx");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== origin 来源标记与收编条目删除分流 =====

    /// 临时 HOME + 临时清单 + 临时备份根的封闭夹具（thread_local 接缝，只影响本测试线程）。
    /// 写入目标用 cursor：agent_paths 里它是唯一没有环境变量搬迁口的家，路径完全由 home 推导
    struct Fixture {
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("ccode-mcp-origin-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TEST_HOME.with(|c| *c.borrow_mut() = Some(dir.clone()));
            TEST_STORE.with(|c| *c.borrow_mut() = Some(dir.join("mcp-servers.json")));
            TEST_BACKUP.with(|c| *c.borrow_mut() = Some(dir.join("backups")));
            Self { dir }
        }
        /// 造假 cursor 用户级配置（含一个既有 MCP 条目），返回文件路径
        fn seed_cursor_config(&self) -> PathBuf {
            let path = self.dir.join(".cursor").join("mcp.json");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                r#"{"mcpServers": {"adopted": {"command": "npx", "args": ["-y", "some-mcp"]}}}"#,
            )
            .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            TEST_HOME.with(|c| *c.borrow_mut() = None);
            TEST_STORE.with(|c| *c.borrow_mut() = None);
            TEST_BACKUP.with(|c| *c.borrow_mut() = None);
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn origin_defaults_to_empty_for_legacy_entries() {
        // 旧清单没有 origin 字段：反序列化为空串（前端按收编条目对待，宁可少删不可错删）
        let v = serde_json::json!({
            "id": "old1", "name": "legacy", "kind": "stdio",
            "command": "npx", "url": ""
        });
        let s: McpServerDto = serde_json::from_value(v).unwrap();
        assert_eq!(s.origin, "");
        assert!(s.enabled, "enabled 的 serde 默认值同样回归覆盖");
    }

    #[test]
    fn origin_written_on_create_adopt_and_paste() {
        let fx = Fixture::new();
        // 路径一：Ccode 新建（save 唯一入口，前端传值被忽略）
        let mut s = stdio_server();
        s.id = String::new();
        s.origin = "bogus-from-frontend".into();
        let list = save_impl(s, false).unwrap();
        assert_eq!(list[0].origin, "ccode");
        // 路径二：收编 agent 既有条目
        fx.seed_cursor_config();
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let adopted = outcome.servers.iter().find(|s| s.name == "adopted").unwrap();
        assert_eq!(adopted.origin, "imported:cursor");
        assert_eq!(adopted.apps.get("cursor"), Some(&true));
        // 路径三：粘贴 JSON 导入（parse 阶段就标好，确认落库不另设）
        let (parsed, _, _, _) =
            parse_pasted(r#"{"mcpServers": {"pasted": {"command": "npx"}}}"#).unwrap();
        assert_eq!(parsed[0].origin, "imported:json");
    }

    #[test]
    fn edit_preserves_origin() {
        // 编辑是整结构替换：origin 必须像 apps/enabled 一样保留旧值，前端传值不能夹带
        let fx = Fixture::new();
        fx.seed_cursor_config();
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let mut edited = outcome
            .servers
            .iter()
            .find(|s| s.name == "adopted")
            .unwrap()
            .clone();
        edited.args = vec!["-y".into(), "other-mcp".into()];
        edited.origin = "ccode".into(); // 前端无论传什么都会被旧值覆盖
        let list = save_impl(edited, false).unwrap();
        assert_eq!(list[0].origin, "imported:cursor");
        assert_eq!(list[0].args, vec!["-y", "other-mcp"], "编辑内容正常生效");
    }

    #[test]
    fn delete_keep_agent_configs_leaves_agent_files_untouched() {
        let fx = Fixture::new();
        let agent_file = fx.seed_cursor_config();
        let before = std::fs::read_to_string(&agent_file).unwrap();
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let id = outcome.servers[0].id.clone();
        // 仅从清单移除：agent 配置文件一字节不动（EXTMOD 预检与移除循环整体跳过）
        let list = delete_impl(&id, false, true).unwrap();
        assert!(list.is_empty());
        assert_eq!(std::fs::read_to_string(&agent_file).unwrap(), before);
        assert!(!fx.dir.join("backups").exists(), "不动 agent 文件就不该产生备份");
        // 对照组：连同配置删除（force 跳过预检）确实会把条目从 agent 配置里移除
        let outcome = import_from_agent_impl("cursor", "adopted").unwrap();
        let list = delete_impl(&outcome.servers[0].id, true, false).unwrap();
        assert!(list.is_empty());
        let after = jsonc_read(&agent_file).unwrap();
        assert!(after["mcpServers"].get("adopted").is_none());
    }

    // ===== check_stdio 双帧格式自适应（unix 专属：假 server 走 shell 脚本） =====

    /// 临时可执行 shell 脚本假 server；返回（目录守卫用路径, 指向脚本的 server DTO）
    #[cfg(unix)]
    fn script_server(body: &str) -> (PathBuf, McpServerDto) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ccode-mcp-stdio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-server.sh");
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut s = stdio_server();
        s.command = script.to_string_lossy().into_owned();
        s.args = vec![];
        s.cwd = String::new();
        s.env = vec![];
        (dir, s)
    }

    /// 规范 NDJSON server：收到 `{` 开头行回一行 JSON 结果
    #[cfg(unix)]
    const NDJSON_SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    '{'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"fake-ndjson","version":"1.0"}}}'
      exit 0
      ;;
  esac
done
"#;

    /// 旧式 Content-Length server：收到 `{` 开头行直接退出（不认 NDJSON），
    /// 收到 Content-Length 头按头+定长体读入并回同格式帧
    #[cfg(unix)]
    const CONTENT_LENGTH_SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in
    '{'*)
      exit 1
      ;;
    [Cc]ontent-[Ll]ength:*)
      len=$(printf '%s' "$line" | sed 's/[^0-9]//g')
      IFS= read -r _blank
      dd bs=1 count="$len" of=/dev/null 2>/dev/null
      resp='{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"legacy-lsp","version":"0.9"}}}'
      printf 'Content-Length: %s\r\n\r\n%s' "${#resp}" "$resp"
      exit 0
      ;;
  esac
done
"#;

    #[cfg(unix)]
    #[test]
    fn check_stdio_ndjson_server_passes_first_try() {
        let (dir, s) = script_server(NDJSON_SERVER);
        let h = check_stdio(&s);
        assert!(h.ok, "{:?}", h.error);
        assert_eq!(h.detail.as_deref(), Some("fake-ndjson@1.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn check_stdio_content_length_server_passes_via_fallback() {
        // NDJSON 尝试下 server 见 `{` 行即退出（进程未响应就退出）→ 换 Content-Length 重试成功
        let (dir, s) = script_server(CONTENT_LENGTH_SERVER);
        let h = check_stdio(&s);
        assert!(h.ok, "{:?}", h.error);
        assert_eq!(h.detail.as_deref(), Some("legacy-lsp@0.9"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn check_stdio_both_frames_dead_report_combined_error() {
        // 两种帧格式都进程秒退：报错区分「两种帧格式均无响应」，且保留 env 缺失提示
        let (dir, mut s) = script_server("#!/bin/sh\nexit 1\n");
        s.env = vec![McpEnvPair {
            key: "TOKEN".into(),
            value: "${CCODE_TEST_DEFINITELY_MISSING_VAR}".into(),
        }];
        let h = check_stdio(&s);
        assert!(!h.ok);
        let err = h.error.unwrap();
        assert!(err.contains("两种帧格式均无响应"), "{err}");
        assert!(err.contains("NDJSON") && err.contains("Content-Length"), "{err}");
        assert!(err.contains("进程未响应就退出了"), "{err}");
        assert!(err.contains("环境变量 CCODE_TEST_DEFINITELY_MISSING_VAR 未设置"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 分发状态五态（mcp_distribution_status） =====

    #[test]
    fn toml_enabled_semantics() {
        let on = vec![(
            "s".to_string(),
            serde_json::json!({"command": "npx", "enabled": true}),
        )];
        let off = vec![(
            "s".to_string(),
            serde_json::json!({"command": "npx", "enabled": false}),
        )];
        let absent = vec![("s".to_string(), serde_json::json!({"command": "npx"}))];
        assert!(!toml_entry_disabled(&on, "s"));
        assert!(toml_entry_disabled(&off, "s"));
        assert!(!toml_entry_disabled(&absent, "s"), "enabled 缺省 = 启用");
        assert!(!toml_entry_disabled(&off, "other"), "条目不存在不算禁用");
        assert!(agent_has_enabled_semantics("codex"));
        assert!(agent_has_enabled_semantics("grok"));
        assert!(agent_has_enabled_semantics("codebuddy"));
        assert!(!agent_has_enabled_semantics("claude-code"), "未实证的家不产出该态");
    }

    #[test]
    fn codebuddy_disabled_list_semantics() {
        let root = serde_json::json!({
            "mcpServers": {"a": {"command": "npx"}},
            "disabledMcpServers": ["a", "other"]
        });
        assert!(codebuddy_disabled(&root, "a"));
        assert!(!codebuddy_disabled(&root, "b"), "不在名单 = 启用");
        let no_key = serde_json::json!({"mcpServers": {"a": {}}});
        assert!(!codebuddy_disabled(&no_key, "a"), "缺键 = 启用");
        let wrong_shape = serde_json::json!({"disabledMcpServers": "a"});
        assert!(!codebuddy_disabled(&wrong_shape, "a"), "非数组不猜");
    }

    /// 造一份 cursor 配置为「与清单产物一致」的辅助：直接走真实分发写入
    fn seed_server_distributed(server: &McpServerDto) {
        write_store(&[server.clone()]).unwrap();
        apply_to_agent("cursor", server, true).unwrap();
    }

    #[test]
    fn distribution_status_ok_modified_missing_off() {
        let fx = Fixture::new();
        let mut s = stdio_server();
        s.apps.insert("cursor".into(), true);
        s.apps.insert("kimi".into(), false);
        seed_server_distributed(&s);
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("ok"));
        assert_eq!(st.get("kimi").map(String::as_str), Some("off"));
        // 外部改内容 → modified
        let path = fx.dir.join(".cursor").join("mcp.json");
        let mut root = jsonc_read(&path).unwrap();
        root["mcpServers"]["fs-tools"]["args"] = serde_json::json!(["-y", "other"]);
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("modified"));
        // 外部删除条目 → missing（清单 apps 仍标已分发）
        root["mcpServers"]
            .as_object_mut()
            .unwrap()
            .remove("fs-tools");
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("missing"));
        // 整个配置文件没了也算 missing，不报警崩溃
        std::fs::remove_file(&path).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("missing"));
        // 配置损坏 → 不报警原则，按 ok 处理
        std::fs::write(&path, "{ not json").unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("cursor").map(String::as_str), Some("ok"));
        s.apps.clear();
    }

    #[test]
    fn distribution_status_disabled_externally_codex_and_codebuddy() {
        // 这两家的路径有环境变量搬迁口（CODEX_HOME / CODEBUDDY_CONFIG_DIR），
        // 设了就跳过——Fixture 的 thread_local HOME 压不住它们
        if std::env::var_os("CODEX_HOME").is_some() || std::env::var_os("CODEBUDDY_CONFIG_DIR").is_some() {
            return;
        }
        let fx = Fixture::new();
        let mut s = stdio_server();
        s.apps.insert("codex".into(), true);
        s.apps.insert("codebuddy".into(), true);
        write_store(&[s.clone()]).unwrap();
        apply_to_agent("codex", &s, true).unwrap();
        apply_to_agent("codebuddy", &s, true).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("codex").map(String::as_str), Some("ok"), "{st:?}");
        assert_eq!(st.get("codebuddy").map(String::as_str), Some("ok"), "{st:?}");
        // codex：外部加 enabled = false → disabled_externally（而不是 modified）
        let codex_path = fx.dir.join(".codex").join("config.toml");
        let mut doc = std::fs::read_to_string(&codex_path)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        doc["mcp_servers"]["fs-tools"]["enabled"] = toml_edit::value(false);
        std::fs::write(&codex_path, doc.to_string()).unwrap();
        // codebuddy：外部把名字加进 disabledMcpServers
        let cb_path = fx.dir.join(".codebuddy").join(".mcp.json");
        let mut root = jsonc_read(&cb_path).unwrap();
        root["disabledMcpServers"] = serde_json::json!(["fs-tools", "someone-else"]);
        std::fs::write(&cb_path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(
            st.get("codex").map(String::as_str),
            Some("disabled_externally"),
            "{st:?}"
        );
        assert_eq!(
            st.get("codebuddy").map(String::as_str),
            Some("disabled_externally"),
            "{st:?}"
        );
        // codebuddy 重新分发会把本条目从禁用名单清掉（名单里别人的名字保留），
        // codex 重写条目即丢掉 enabled=false——两边「拨开开关 = 恢复启用」语义一致
        apply_to_agent("codebuddy", &s, true).unwrap();
        apply_to_agent("codex", &s, true).unwrap();
        let root = jsonc_read(&cb_path).unwrap();
        assert_eq!(
            root["disabledMcpServers"],
            serde_json::json!(["someone-else"]),
            "只清自己名下的名字，键与别人的名字保留"
        );
        let st = distribution_status_impl("t1").unwrap();
        assert_eq!(st.get("codex").map(String::as_str), Some("ok"), "{st:?}");
        assert_eq!(st.get("codebuddy").map(String::as_str), Some("ok"), "{st:?}");
    }

    // ===== 体检沉淀 / 启动超时 / env 引用预检 =====

    #[test]
    fn stdio_check_timeout_defaults_and_clamps() {
        let mut s = stdio_server();
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(8),
            "未声明维持 8s"
        );
        s.startup_timeout_ms = Some(2_000);
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(8),
            "声明值低于 8s 仍按 8s"
        );
        s.startup_timeout_ms = Some(20_000);
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(20),
            "声明值生效"
        );
        s.startup_timeout_ms = Some(120_000);
        assert_eq!(
            stdio_check_timeout(&s),
            std::time::Duration::from_secs(30),
            "声明值封顶 30s"
        );
    }

    #[test]
    fn startup_timeout_reverse_parsed_from_toml_fields() {
        // codex/grok 的 startup_timeout_sec（秒）→ 毫秒；缺键/非正数不落字段
        let v = serde_json::json!({"command": "npx", "startup_timeout_sec": 15});
        assert_eq!(reverse_entry("codex", "s", &v).startup_timeout_ms, Some(15_000));
        let v = serde_json::json!({"command": "npx", "startup_timeout_sec": 0.5});
        assert_eq!(reverse_entry("grok", "s", &v).startup_timeout_ms, Some(500));
        let v = serde_json::json!({"command": "npx"});
        assert_eq!(reverse_entry("codex", "s", &v).startup_timeout_ms, None);
        let v = serde_json::json!({"command": "npx", "startup_timeout_sec": -3});
        assert_eq!(reverse_entry("codex", "s", &v).startup_timeout_ms, None);
        // 粘贴导入（claude 形状 JSON）里带了该键也顺带带入，没带则为空
        let fx = Fixture::new();
        let (parsed, _, _, _) = parse_pasted(
            r#"{"mcpServers": {"slow": {"command": "npx", "startup_timeout_sec": 12}}}"#,
        )
        .unwrap();
        assert_eq!(parsed[0].startup_timeout_ms, Some(12_000));
        drop(fx);
    }

    #[test]
    fn last_check_record_roundtrip_and_edit_preserves() {
        let fx = Fixture::new();
        let mut s = stdio_server();
        s.id = String::new();
        let list = save_impl(s, false).unwrap();
        let id = list[0].id.clone();
        assert!(list[0].last_check.is_none());
        // 沉淀：只动 last_check，其余字段原样
        let mut results = HashMap::new();
        results.insert(
            id.clone(),
            McpHealthDto {
                ok: false,
                latency_ms: 8_123,
                error: Some("8 秒未响应 initialize（超时）".into()),
                detail: None,
            },
        );
        record_last_checks(&results);
        let back = read_store().unwrap();
        let lc = back[0].last_check.as_ref().expect("应已沉淀");
        assert!(!lc.ok);
        assert_eq!(lc.latency_ms, 8_123);
        assert_eq!(lc.error.as_deref(), Some("8 秒未响应 initialize（超时）"));
        assert!(!lc.at.is_empty());
        assert_eq!(back[0].name, "fs-tools", "其他字段不动");
        // 编辑整结构替换不丢沉淀（与 origin/apps/enabled 同口径）
        let mut edited = back[0].clone();
        edited.args = vec!["-y".into(), "other".into()];
        edited.last_check = None; // 前端即使传空也被旧值覆盖
        let list = save_impl(edited, false).unwrap();
        assert_eq!(list[0].args, vec!["-y", "other"]);
        let lc = list[0].last_check.as_ref().expect("编辑后沉淀保留");
        assert_eq!(lc.latency_ms, 8_123);
        drop(fx);
    }

    #[test]
    fn missing_env_refs_collects_unset_only() {
        // 必定未设置的变量名；PATH 全平台必设；字面值与内嵌引用（Bearer $X 非整值）不算
        let pairs = vec![
            McpEnvPair { key: "A".into(), value: "${CCODE_TEST_DEFINITELY_MISSING_VAR}".into() },
            McpEnvPair { key: "B".into(), value: "$CCODE_TEST_DEFINITELY_MISSING_VAR".into() }, // 去重
            McpEnvPair { key: "C".into(), value: "$PATH".into() },
            McpEnvPair { key: "D".into(), value: "plain-literal".into() },
            McpEnvPair { key: "E".into(), value: "Bearer ${CCODE_TEST_DEFINITELY_MISSING_VAR}".into() },
        ];
        let missing = missing_env_refs_impl(&pairs);
        assert_eq!(missing, vec!["CCODE_TEST_DEFINITELY_MISSING_VAR"], "{missing:?}");
        // 空值算未设置（edition 2021，set_var 安全；用独立变量名不与并行测试互踩）
        std::env::set_var("CCODE_TEST_EMPTY_VAR", "");
        let missing = missing_env_refs_impl(&[McpEnvPair {
            key: "K".into(),
            value: "${CCODE_TEST_EMPTY_VAR}".into(),
        }]);
        assert_eq!(missing, vec!["CCODE_TEST_EMPTY_VAR"]);
        std::env::remove_var("CCODE_TEST_EMPTY_VAR");
    }

    // ===== 相对路径命令解析（resolver）与路径健康探测 =====

    /// 造一个临时文件，返回 canonicalize 后的绝对路径字符串
    ///（macOS 的 temp_dir 是 /var → /private/var symlink，与 resolver 产物同口径才好断言）
    fn touch_file(path: &Path) -> String {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
        mcp_path_text(crate::paths::canonicalize_plain(path).unwrap())
    }

    #[test]
    fn resolver_base_order_and_unique_hit() {
        let fx = Fixture::new();
        // 基准 1（条目绝对 cwd）与基准 2（cursor 配置家目录 = 临时 HOME/.cursor）都命中时
        // cwd 基准序位最前胜出
        let cwd_dir = fx.dir.join("plugin-a");
        let hit_a = touch_file(&cwd_dir.join("bin").join("serve"));
        let _hit_b = touch_file(&fx.dir.join(".cursor").join("bin").join("serve"));
        let hits = resolve_relative_candidates(
            "./bin/serve",
            &cwd_dir.to_string_lossy(),
            Some("cursor"),
        );
        assert_eq!(hits.len(), 2, "两个基准各命中一次（路径不同不去重）: {hits:?}");
        assert_eq!(hits[0].command, hit_a, "序位最前 = 条目自己的 cwd 基准");
        // 原 cwd 已是绝对路径：规范化保留原值
        assert_eq!(hits[0].cwd, cwd_dir.to_string_lossy().as_ref());
    }

    #[test]
    fn resolver_normalizes_relative_cwd_to_hit_base() {
        let fx = Fixture::new();
        // 2026-09-03 实机形状：command 相对 + cwd "." —— 命中基准后 cwd 一并规范化
        let hit = touch_file(&fx.dir.join(".cursor").join("bin").join("serve"));
        let hits = resolve_relative_candidates("./bin/serve", ".", Some("cursor"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].command, hit);
        assert_eq!(
            hits[0].cwd,
            fx.dir.join(".cursor").to_string_lossy().as_ref(),
            "相对 cwd（.）改成命中所用的基准目录"
        );
    }

    #[test]
    fn resolver_miss_returns_empty_and_ignores_non_relative() {
        let fx = Fixture::new();
        assert!(
            resolve_relative_candidates("./no/such/file", ".", Some("cursor")).is_empty(),
            "全部基准不命中 = 空候选（调用方 fail-open / 拒写）"
        );
        assert!(resolve_relative_candidates("npx", "", Some("cursor")).is_empty());
        assert!(resolve_relative_candidates("/abs/serve", "", Some("cursor")).is_empty());
        // 粘贴导入无来源 agent：只有条目自己的绝对 cwd 一个基准
        let cwd_dir = fx.dir.join("pasted");
        let hit = touch_file(&cwd_dir.join("serve"));
        let hits = resolve_relative_candidates("./serve", &cwd_dir.to_string_lossy(), None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].command, hit);
        assert!(
            resolve_relative_candidates("./serve", "", None).is_empty(),
            "无 agent 且无绝对 cwd = 无基准可解"
        );
    }

    #[test]
    fn import_resolves_relative_command_and_normalizes_cwd() {
        let fx = Fixture::new();
        // codex 形状实机案例的 cursor 重演：./bin/serve + cwd "."，配置家目录下命中
        let hit = touch_file(&fx.dir.join(".cursor").join("bin").join("serve"));
        let path = fx.dir.join(".cursor").join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers": {"rel-srv": {"command": "./bin/serve", "cwd": "."}}}"#,
        )
        .unwrap();
        let outcome = import_from_agent_impl("cursor", "rel-srv").unwrap();
        assert_eq!(outcome.resolved, 1);
        assert_eq!(outcome.unresolved, 0);
        let s = &outcome.servers[0];
        assert_eq!(s.command, hit, "收编入库的是解析后的绝对路径");
        assert_eq!(s.cwd, fx.dir.join(".cursor").to_string_lossy().as_ref());
    }

    #[test]
    fn import_unresolvable_relative_kept_as_is_fail_open() {
        let fx = Fixture::new();
        // fail-open：解不出也照原样收进来（收编不是写 agent 配置，清单页 relative 告警兜底）
        let path = fx.dir.join(".cursor").join("mcp.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers": {"rel-srv": {"command": "./bin/serve", "cwd": "."}}}"#,
        )
        .unwrap();
        let outcome = import_from_agent_impl("cursor", "rel-srv").unwrap();
        assert_eq!(outcome.resolved, 0);
        assert_eq!(outcome.unresolved, 1);
        assert_eq!(outcome.servers[0].command, "./bin/serve", "原样收进来不拒收");
        assert_eq!(outcome.servers[0].cwd, ".");
        // 清单页探测能把这条标出来
        assert_eq!(command_path_status(&outcome.servers[0].command), Some("relative"));
    }

    #[test]
    fn distribute_resolves_relative_via_own_cwd_before_rejecting() {
        let fx = Fixture::new();
        // 先解：条目自己的绝对 cwd 下有该文件 → 分发产物直接落绝对路径
        let hit = touch_file(&fx.dir.join("plug").join("bin").join("serve"));
        let mut s = stdio_server();
        s.command = "./bin/serve".into();
        s.cwd = fx.dir.join("plug").to_string_lossy().into_owned();
        let v = entry_json(&s, "claude-code").unwrap();
        assert_eq!(v["command"], serde_json::json!(hit));
        // 后拦：cwd 下没有该文件 → 拒写文案具体化
        s.cwd = fx.dir.join("empty-dir").to_string_lossy().into_owned();
        std::fs::create_dir_all(fx.dir.join("empty-dir")).unwrap();
        let err = entry_json(&s, "claude-code").unwrap_err();
        assert!(err.contains("无法确定基准目录"), "{err}");
    }

    #[test]
    fn command_path_status_closed_set() {
        let fx = Fixture::new();
        // relative：./ ../ 形态必挂
        assert_eq!(command_path_status("./bin/serve"), Some("relative"));
        // ok：绝对路径存在
        let hit = touch_file(&fx.dir.join("exists").join("serve"));
        assert_eq!(command_path_status(&hit), Some("ok"));
        // missing：绝对路径不存在（版本升级路径失效）
        let gone = fx.dir.join("gone").join("serve").to_string_lossy().into_owned();
        assert_eq!(command_path_status(&gone), Some("missing"));
        // missing：裸命令名解析不到（必定不存在的名字，同 stdio_server 夹具口径）
        assert_eq!(command_path_status("ccode-test-nonexistent-bin"), Some("missing"));
        // 不判：$VAR 引用式与空命令
        assert_eq!(command_path_status("$MCP_BIN"), None);
        assert_eq!(command_path_status("${MCP_BIN}"), None);
        assert_eq!(command_path_status(""), None);
        // 裸名可解析 = ok（机器上有 node 才验这条，没有就跳过——不绑 CI 环境）
        if crate::agents::resolve_binary("node").is_some() {
            assert_eq!(command_path_status("node"), Some("ok"));
        }
    }
}

/// 分发状态五态闭集（MCP 页开关旁徽标用；开关本身仍表达清单分发意图 apps，
/// 这里只报告磁盘事实）：
/// - `off`：apps 未分发到该 agent；
/// - `ok`：落盘条目与清单产物一致；
/// - `modified`：条目存在但内容被外部改过；
/// - `missing`：apps 标记已分发但磁盘上条目不存在（外部删除）；
/// - `disabled_externally`：条目存在但在 agent 侧被禁用——只在该格式确有 enabled
///   语义时产出（codex/grok 的 TOML `enabled`、codebuddy 的 `disabledMcpServers`，
///   其余家不产出，宁缺毋滥）。
///
/// 只读探测，不写任何文件。此前 `entry_modified_externally` 只在删除/改投时用来
/// 拦「假状态」，界面上看不到——用户不知道自己在 agent 侧手改过的东西会被覆盖。
/// 探测失败（配置损坏/读不到）维持「不报警」原则按 `ok` 处理：假警报比漏报更烦人。
#[tauri::command]
pub async fn mcp_distribution_status(
    id: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || distribution_status_impl(&id))
        .await
        .map_err(|e| format!("查询 MCP 分发状态失败: {e}"))?
}

fn distribution_status_impl(id: &str) -> Result<std::collections::BTreeMap<String, String>, String> {
    let server = read_store()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("找不到该 MCP server")?;
    let mut out = std::collections::BTreeMap::new();
    for (agent, on) in &server.apps {
        if !*on {
            out.insert(agent.clone(), "off".to_string());
            continue;
        }
        let state = match agent_entries(agent) {
            // 探测失败按「已写入」处理：不确定不该报警
            Err(_) => "ok",
            Ok(entries) => {
                if !entries.iter().any(|(n, _)| *n == server.name) {
                    "missing"
                } else if agent_has_enabled_semantics(agent)
                    && entry_disabled_externally(agent, &server.name).unwrap_or(false)
                {
                    // 禁用优先于 modified 报：codex 外部禁用会给条目加 enabled 键，
                    // 内容比对必然也算 modified，先报更准确的「被禁用」
                    "disabled_externally"
                } else if entry_modified_externally(agent, &server).unwrap_or(false) {
                    "modified"
                } else {
                    "ok"
                }
            }
        };
        out.insert(agent.clone(), state.to_string());
    }
    Ok(out)
}

// ===== 连通性健康检测（v3.93） =====

/// check_mcp_server 的返回：ok + 耗时 + 失败原因 + 附加说明（serverInfo / HTTP 状态）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthDto {
    pub ok: bool,
    /// 握手/请求耗时（毫秒）
    pub latency_ms: u64,
    /// 失败原因（路径无效 / 超时 / 连接拒绝…）；成功为 null
    pub error: Option<String>,
    /// 成功时的附加信息：stdio = serverInfo.name@version；remote = HTTP 状态行
    pub detail: Option<String>,
}

fn health_ok(started: std::time::Instant, detail: Option<String>) -> McpHealthDto {
    McpHealthDto {
        ok: true,
        latency_ms: started.elapsed().as_millis() as u64,
        error: None,
        detail,
    }
}

fn health_fail(started: std::time::Instant, error: String) -> McpHealthDto {
    McpHealthDto {
        ok: false,
        latency_ms: started.elapsed().as_millis() as u64,
        error: Some(error),
        detail: None,
    }
}

/// env/header 值注入前的宿主展开：整值引用（$VAR/${VAR}，env_ref 同口径）查宿主环境，
/// 字面值原样；引用未设置的变量返回 Err(变量名)（检测照常跑，失败时附加提示）
fn inject_pair(
    envs: &mut Vec<(String, String)>,
    missing: &mut Vec<String>,
    key: &str,
    value: &str,
) {
    match env_ref(value) {
        Some(var) => match std::env::var(var) {
            Ok(v) => envs.push((key.to_string(), v)),
            Err(_) => missing.push(var.to_string()),
        },
        None => envs.push((key.to_string(), value.to_string())),
    }
}

fn append_missing_hint(error: String, missing: &[String]) -> String {
    if missing.is_empty() {
        error
    } else {
        format!("{error}（另：环境变量 {} 未设置）", missing.join("、"))
    }
}

/// MCP initialize 请求体（stdio 与 remote 共用）
fn initialize_body() -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "ccode-healthcheck", "version": "0.1.0" }
        }
    })
}

/// stdio 发送帧格式：MCP 规范是换行分隔 JSON（NDJSON，无头部）；
/// 少数旧实现说 LSP 风格 Content-Length 帧，做一次性回退兼容
#[derive(Clone, Copy)]
enum StdioFrame {
    Ndjson,
    ContentLength,
}

impl StdioFrame {
    fn label(self) -> &'static str {
        match self {
            Self::Ndjson => "NDJSON",
            Self::ContentLength => "Content-Length",
        }
    }
}

/// 单次 stdio 探测结局：Done = 终局（成功 / server 明确应答拒绝 / 命令级失败）；
/// FrameMismatch = 疑似帧格式不兼容（进程退出、首帧非法、超时），值得换格式重试，
/// 携带的错误文案已含 env 缺失提示与 stderr 末尾，供合并报告
enum StdioAttempt {
    Done(McpHealthDto),
    FrameMismatch(String),
}

/// stdio 体检每次尝试（NDJSON / Content-Length 各一次）的等待上限：
/// server 声明了启动超时的按 clamp(8s, 30s) 生效（慢启动 server 给足声明值、
/// 也不无限放大），未声明维持 8s。remote 探活恒 8s 不走这里
fn stdio_check_timeout(server: &McpServerDto) -> std::time::Duration {
    std::time::Duration::from_millis(
        server
            .startup_timeout_ms
            .map(|ms| ms.clamp(8_000, 30_000))
            .unwrap_or(8_000),
    )
}

/// stdio 检测：按分发同一口径解析命令（resolve_command_deep 含 node shim 深化）→
/// 拉起进程 → stdin 写 initialize 帧 → 上限内等首帧响应（8s，server 声明启动超时按
/// clamp(8s, 30s) 放宽）。覆盖最常见断连：
/// 路径失效/node 缺失（spawn ENOENT）、进程秒退、协议不应答（超时）。
/// 帧格式自适应：先发规范的 NDJSON 帧；server 未响应就退出 / 首帧解析失败 / 超时
/// 时换 Content-Length 帧重试一次（每次尝试各按上述上限）。
fn check_stdio(server: &McpServerDto) -> McpHealthDto {
    let started = std::time::Instant::now();
    let first_err = match check_stdio_attempt(server, StdioFrame::Ndjson, started) {
        StdioAttempt::Done(dto) => return dto,
        StdioAttempt::FrameMismatch(e) => e,
    };
    match check_stdio_attempt(server, StdioFrame::ContentLength, started) {
        StdioAttempt::Done(dto) => dto,
        StdioAttempt::FrameMismatch(second_err) => health_fail(
            started,
            format!(
                "两种帧格式均无响应（{}：{first_err}；{}：{second_err}）",
                StdioFrame::Ndjson.label(),
                StdioFrame::ContentLength.label(),
            ),
        ),
    }
}

/// 拉起一次进程按指定帧格式发 initialize 并等首帧；响应读取器两种帧都认
/// （`{` 开头的行 = NDJSON 帧直接解析；Content-Length: 头走头+定长体路径）
fn check_stdio_attempt(
    server: &McpServerDto,
    frame: StdioFrame,
    started: std::time::Instant,
) -> StdioAttempt {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::Stdio;
    let (cmd, args) = resolve_command_deep(&server.command, &server.args);
    let mut command = crate::process::background_command(&cmd);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 与终端拉起同一环境纪律：NO_COLOR 移除、TERM/COLORTERM 显式设置
        .env_remove("NO_COLOR")
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "Ccode");
    if !server.cwd.trim().is_empty() {
        command.current_dir(server.cwd.trim());
    }
    let mut missing: Vec<String> = Vec::new();
    let mut envs: Vec<(String, String)> = Vec::new();
    for pair in &server.env {
        inject_pair(&mut envs, &mut missing, &pair.key, &pair.value);
    }
    command.envs(envs);
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return StdioAttempt::Done(health_fail(
                started,
                append_missing_hint(format!("命令不存在或路径失效：{cmd}"), &missing),
            ));
        }
        Err(e) => {
            return StdioAttempt::Done(health_fail(
                started,
                append_missing_hint(format!("命令启动失败（{cmd}）：{e}"), &missing),
            ));
        }
    };
    let body = initialize_body().to_string();
    let mut stdin = child.stdin.take().expect("stdin 已 pipe");
    // 发送帧按本次尝试的格式；读取器两种回包都认，server 用哪种帧回都能解析
    let write = match frame {
        StdioFrame::Ndjson => stdin
            .write_all(body.as_bytes())
            .and_then(|_| stdin.write_all(b"\n")),
        StdioFrame::ContentLength => stdin
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .and_then(|_| stdin.write_all(body.as_bytes())),
    }
    .and_then(|_| stdin.flush());
    if let Err(e) = write {
        crate::pty::kill_process_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return StdioAttempt::Done(health_fail(
            started,
            append_missing_hint(format!("写入 initialize 失败（进程可能已退出）：{e}"), &missing),
        ));
    }
    // 响应读取搬进线程，主线程 recv_timeout 实现等待上限（CI 不挂死兜底）；
    // 上限 = stdio_check_timeout（默认 8s，server 声明启动超时按 clamp(8s, 30s) 放宽）
    let mut stdout = child.stdout.take().expect("stdout 已 pipe");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = (|| -> Result<String, String> {
            let mut reader = BufReader::new(&mut stdout);
            let mut content_len: Option<usize> = None;
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("进程未响应就退出了".into());
                }
                let t = line.trim();
                if t.is_empty() {
                    if content_len.is_some() {
                        break;
                    }
                    continue;
                }
                // NDJSON 帧：`{` 开头的一整行 JSON，直接作为响应体
                if t.starts_with('{') {
                    return Ok(t.to_string());
                }
                if let Some(rest) = t.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_len = rest.trim().parse().ok();
                }
            }
            let len = content_len.ok_or("响应缺少 Content-Length 头")?;
            let mut buf = vec![0u8; len.min(1024 * 1024)];
            reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
            String::from_utf8(buf).map_err(|e| e.to_string())
        })();
        let _ = tx.send(r);
    });
    let outcome = rx.recv_timeout(stdio_check_timeout(server));
    let pid = child.id();
    let mut stderr = child.stderr.take();
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    crate::pty::kill_process_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
    let err_bytes =
        crate::process::join_with_timeout(err_handle, std::time::Duration::from_secs(2));
    let err_text = String::from_utf8_lossy(&err_bytes).into_owned();
    // stderr 末尾尽力拼进错误文案，帮助定位 server 侧协议报错
    let with_stderr = |e: String| {
        if err_text.trim().is_empty() {
            e
        } else {
            let tail: String = err_text
                .trim()
                .chars()
                .rev()
                .take(200)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            format!("{e}；stderr 末尾：{tail}")
        }
    };
    match outcome {
        Ok(Ok(frame_json)) => match serde_json::from_str::<serde_json::Value>(&frame_json) {
            Ok(v) => {
                if let Some(err) = v.get("error") {
                    // server 正常应答了 JSON-RPC error：协议互通无问题，不重试
                    return StdioAttempt::Done(health_fail(
                        started,
                        append_missing_hint(format!("server 拒绝 initialize：{err}"), &missing),
                    ));
                }
                let info = v.pointer("/result/serverInfo");
                let detail = info.map(|i| {
                    format!(
                        "{}{}",
                        i.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                        i.get("version")
                            .and_then(|n| n.as_str())
                            .map(|v| format!("@{v}"))
                            .unwrap_or_default()
                    )
                });
                StdioAttempt::Done(health_ok(started, detail.filter(|d| !d.is_empty())))
            }
            Err(e) => StdioAttempt::FrameMismatch(append_missing_hint(
                with_stderr(format!("响应不是合法 JSON-RPC 帧：{e}")),
                &missing,
            )),
        },
        Ok(Err(e)) => StdioAttempt::FrameMismatch(append_missing_hint(with_stderr(e), &missing)),
        Err(_) => StdioAttempt::FrameMismatch(append_missing_hint(
            match server.startup_timeout_ms {
                // 声明了更长启动时间仍超时：点明已按声明等待（声明值即来源，UI 表单可改）
                Some(ms) => format!(
                    "{} 秒未响应 initialize（超时；该 server 声明的启动超时为 {}s，已按此等待）",
                    ms.clamp(8_000, 30_000) / 1_000,
                    ms / 1_000
                ),
                None => "8 秒未响应 initialize（超时）".to_string(),
            },
            &missing,
        )),
    }
}

/// remote 检测：POST initialize（MCP streamable HTTP 口径，Accept 双类型）。
/// 2xx/3xx/4xx 都算「服务在线」（4xx 多为鉴权/协商问题，传输层本身是通的），
/// 5xx 与网络错误才算异常。
async fn check_remote(server: &McpServerDto) -> McpHealthDto {
    let started = std::time::Instant::now();
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => return health_fail(started, format!("HTTP 客户端初始化失败：{e}")),
    };
    let mut req = client
        .post(server.url.trim())
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .json(&initialize_body());
    let mut missing: Vec<String> = Vec::new();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for pair in &server.headers {
        inject_pair(&mut pairs, &mut missing, &pair.key, &pair.value);
    }
    for (k, v) in pairs {
        req = req.header(k, v);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let detail = format!("HTTP {status}");
            if status.is_server_error() {
                health_fail(started, append_missing_hint(detail, &missing))
            } else {
                health_ok(started, Some(detail))
            }
        }
        Err(e) => {
            let why = if e.is_timeout() {
                "8 秒超时".to_string()
            } else if e.is_connect() {
                format!("连接失败（服务未启动或地址错误）：{e}")
            } else {
                format!("请求失败：{e}")
            };
            health_fail(started, append_missing_hint(why, &missing))
        }
    }
}

/// 单条体检分发（单条命令与批量检测共用）：remote 异步探活 / stdio 搬进 blocking 线程拉起握手
async fn check_one(server: &McpServerDto) -> McpHealthDto {
    if server.kind == "remote" {
        check_remote(server).await
    } else {
        let s = server.clone();
        match tauri::async_runtime::spawn_blocking(move || check_stdio(&s)).await {
            Ok(h) => h,
            Err(e) => health_fail(std::time::Instant::now(), format!("检测任务失败: {e}")),
        }
    }
}

/// 体检结果沉淀进清单的 last_check 字段（读-改-写只动该字段，其余一律保留；
/// 落盘失败静默——检测结果已经拿到，不该被持久化失败拖垮）
fn record_last_checks(results: &HashMap<String, McpHealthDto>) {
    let _ = (|| -> Result<(), String> {
        let mut list = read_store()?;
        let mut dirty = false;
        for s in list.iter_mut() {
            if let Some(h) = results.get(&s.id) {
                s.last_check = Some(McpLastCheck {
                    at: crate::sessions::now_iso(),
                    ok: h.ok,
                    latency_ms: h.latency_ms,
                    error: h.error.clone(),
                });
                dirty = true;
            }
        }
        if dirty {
            write_store(&list)?;
        }
        Ok(())
    })();
}

/// 现场连通性检测（行内 ⚡ / 状态点点按触发）：不进页面时自动跑——
/// 拉起 N 个 stdio 进程的代价不该由打开页面承担，检测过才显示状态点。
/// 结果沉淀进清单 last_check（回页/刷新后行内仍能显示上次状态）
#[tauri::command]
pub async fn check_mcp_server(id: String) -> Result<McpHealthDto, String> {
    let server = tauri::async_runtime::spawn_blocking(move || {
        read_store()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "该 server 不存在（可能已删除）".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let health = check_one(&server).await;
    let mut one = HashMap::new();
    one.insert(server.id.clone(), health.clone());
    tauri::async_runtime::spawn_blocking(move || record_last_checks(&one))
        .await
        .map_err(|e| e.to_string())?;
    Ok(health)
}

/// 批量体检（MCP 页「全部检测」）：对清单里所有启用的 server 分波并发检测
///（每波最多 4 个，避免一次拉起十几个 stdio 进程），全部完成后一次性沉淀
/// last_check 并返回 id → 结果（前端一次性回填，不做渐进式事件）
#[tauri::command]
pub async fn check_all_mcp_servers() -> Result<HashMap<String, McpHealthDto>, String> {
    let servers = tauri::async_runtime::spawn_blocking(|| {
        read_store().map(|l| l.into_iter().filter(|s| s.enabled).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut results: HashMap<String, McpHealthDto> = HashMap::new();
    for chunk in servers.chunks(4) {
        let mut handles = Vec::with_capacity(chunk.len());
        for s in chunk {
            let s = s.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let id = s.id.clone();
                (id, check_one(&s).await)
            }));
        }
        for h in handles {
            let (id, health) = h.await.map_err(|e| format!("体检任务失败: {e}"))?;
            results.insert(id, health);
        }
    }
    let persisted = results.clone();
    tauri::async_runtime::spawn_blocking(move || record_last_checks(&persisted))
        .await
        .map_err(|e| e.to_string())?;
    Ok(results)
}

/// $VAR 引用分发预检（只读）：提取 env/header 值里的整值引用（env_ref 同口径），
/// 查宿主环境返回未设置（空值算未设置）的变量名清单，去重排序。
/// 前端在保存/拨开分发开关前调用，缺失时给非阻断警告（GUI 应用读不到 shell rc 的 export）
#[tauri::command]
pub async fn mcp_missing_env_refs(pairs: Vec<McpEnvPair>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || missing_env_refs_impl(&pairs))
        .await
        .unwrap_or_default()
}

fn missing_env_refs_impl(pairs: &[McpEnvPair]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in pairs {
        let Some(var) = env_ref(&p.value) else {
            continue;
        };
        let set = std::env::var(var).map(|v| !v.is_empty()).unwrap_or(false);
        if !set && !out.iter().any(|x| x == var) {
            out.push(var.to_string());
        }
    }
    out.sort();
    out
}

// ===== 命令路径健康探测与一键修复（只读探测 + 相对路径解析，2026-09-03） =====

/// 单条 stdio 命令的路径健康判定（闭集 ok/relative/missing）：
/// - `relative`：./ ../ 相对路径——基准是来源 agent 的运行语境，Ccode 内嵌终端拉起必挂；
/// - `missing`：绝对路径但磁盘上不存在（app 卸载/版本升级后路径失效），
///   或裸命令名连 resolve_binary 候选目录都解析不到；
/// - `ok`：绝对路径存在，或裸命令名可解析（裸名合法，分发时才绝对化，不误报）。
/// None = 不判：空命令 / $VAR 引用式命令（宿主环境展开，静态判不了）/ 非 stdio。
fn command_path_status(command: &str) -> Option<&'static str> {
    let c = command.trim();
    if c.is_empty() || env_ref(c).is_some() {
        return None;
    }
    if is_relative_command(c) {
        return Some("relative");
    }
    let looks_like_path = c.contains('/')
        || c.contains('\\')
        || (c.len() >= 2 && c.as_bytes()[1] == b':');
    if looks_like_path {
        return Some(if Path::new(c).exists() { "ok" } else { "missing" });
    }
    Some(if crate::agents::resolve_binary(c).is_some() {
        "ok"
    } else {
        "missing"
    })
}

/// 清单全量命令路径探测（只读；MCP 页告警徽标数据源）：
/// stdio server id → "ok" | "relative" | "missing"；不判的条目不进 map
#[tauri::command]
pub async fn mcp_command_path_status() -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let list = read_store()?;
        Ok(list
            .iter()
            .filter(|s| s.kind == "stdio")
            .filter_map(|s| command_path_status(&s.command).map(|st| (s.id.clone(), st.to_string())))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 相对路径命令的一键修复候选（MCP 页「修复为绝对路径」）：与收编同一套 resolver，
/// 来源 agent 从 origin（imported:<agent>）推断以启用配置家目录/插件目录基准；
/// 空 vec = 无命中（前端提示手工编辑），多候选由前端弹层交给用户选
#[tauri::command]
pub async fn resolve_mcp_command_fix(id: String) -> Result<Vec<McpCommandFix>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list = read_store()?;
        let Some(server) = list.iter().find(|s| s.id == id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
        if server.kind != "stdio" || !is_relative_command(&server.command) {
            return Ok(Vec::new());
        }
        let agent = server
            .origin
            .strip_prefix("imported:")
            .filter(|a| *a != "json" && crate::agent_specs::agent_spec(a).is_some());
        Ok(resolve_relative_candidates(&server.command, &server.cwd, agent))
    })
    .await
    .map_err(|e| e.to_string())?
}
