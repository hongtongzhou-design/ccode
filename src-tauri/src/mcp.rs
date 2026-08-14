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
}

// ===== 清单存储 =====

fn store_path() -> Result<PathBuf, String> {
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

/// 去注释 + 尾逗号（字符串/转义状态机，不动字符串内容）
fn strip_jsonc(text: &str) -> String {
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
    let real = std::fs::canonicalize(&bin).unwrap_or(bin.clone());
    if is_node_shim(&real) {
        if let Some(node) = crate::agents::resolve_binary("node") {
            let mut new_args = vec![real.to_string_lossy().into_owned()];
            new_args.extend(args.iter().cloned());
            return (node.to_string_lossy().into_owned(), new_args);
        }
    }
    (bin.to_string_lossy().into_owned(), args.to_vec())
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
        let (command, args) = resolve_command_deep(&server.command, &server.args);
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
        let (command, args) = resolve_command_deep(&server.command, &server.args);
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
    if agent == "grok" {
        // grok 的 [mcp_servers.<name>] 在 config.toml 里与 model/hooks 同文件，且自带
        // `grok mcp add` CLI 做读改写；首版不硬造 TOML 原子写管线，明确拒绝分发/写入
        return Err("Grok 的 MCP 分发暂不支持（TOML [mcp_servers] 段与 model 同文件）；请用 `grok mcp add` 或编辑 ~/.grok/config.toml".into());
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

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn list_mcp_servers() -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(read_store)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_mcp_server(
    mut server: McpServerDto,
    allow_plaintext: bool,
) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
            list.push(server.clone());
        } else {
            let Some(pos) = list.iter().position(|s| s.id == server.id) else {
                return Err("该 server 不存在（可能已删除）".into());
            };
            if list.iter().any(|s| s.name == server.name && s.id != server.id) {
                return Err(format!("已存在同名 server: {}", server.name));
            }
            server.apps = list[pos].apps.clone(); // 分发开关以开关命令为准，编辑不夹带
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
    })
    .await
    .map_err(|e| e.to_string())?
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

#[tauri::command]
pub async fn delete_mcp_server(id: String, force: bool) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = read_store()?;
        let Some(pos) = list.iter().position(|s| s.id == id) else {
            return Err("该 server 不存在（可能已删除）".into());
        };
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
    })
    .await
    .map_err(|e| e.to_string())?
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

/// 收编：把某 agent 配置里的既有 server 读进 Ccode 清单，并标记已分发到该 agent
#[tauri::command]
pub async fn import_mcp_from_agent(agent: String, name: String) -> Result<Vec<McpServerDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_specs::agent_spec(&agent).ok_or_else(|| format!("未知 agent: {agent}"))?;
        let mut list = read_store()?;
        if list.iter().any(|s| s.name == name) {
            return Err(format!("清单里已有同名 server: {name}"));
        }
        let entries = agent_entries(&agent)?;
        let Some((_, value)) = entries.into_iter().find(|(n, _)| *n == name) else {
            return Err(format!("{} 的配置里找不到 server {name}", agent));
        };
        let mut server = reverse_entry(&agent, &name, &value);
        server.id = uuid::Uuid::new_v4().to_string();
        server.apps.insert(agent, true); // 已在该 agent 配置里，标记已分发
        list.push(server);
        write_store(&list)?;
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 粘贴 JSON 的纯解析（不写库）：剥包裹层 + 通用形状解析 + 标出将与清单重名被跳过的。
/// 返回 (解析出的 server 预览, 同名跳过名单, 疑似明文密钥清单)
fn parse_pasted(text: &str) -> Result<(Vec<McpServerDto>, Vec<String>, Vec<String>), String> {
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
        server.id = uuid::Uuid::new_v4().to_string();
        suspects.extend(suspect_plaintext_keys(&server));
        parsed.push(server);
    }
    if parsed.is_empty() && skipped.is_empty() {
        return Err("没有解析出任何 server 条目（期望 {\"mcpServers\": {...}} 形状）".into());
    }
    Ok((parsed, skipped, suspects))
}

/// 粘贴导入预览：只解析不写库（前端展示将添加的命令清单，确认后才调 import_mcp_json）
#[tauri::command]
pub async fn parse_mcp_json(
    text: String,
) -> Result<(Vec<McpServerDto>, Vec<String>, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || parse_pasted(&text))
        .await
        .map_err(|e| e.to_string())?
}

/// 粘贴 JSON 导入：确认预览后落库。同名跳过。明文密钥需 allow_plaintext 确认。
/// 返回 (新增, 跳过)
#[tauri::command]
pub async fn import_mcp_json(
    text: String,
    allow_plaintext: bool,
) -> Result<(Vec<String>, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (parsed, skipped, suspects) = parse_pasted(&text)?;
        if !allow_plaintext && !suspects.is_empty() {
            return Err(format!("PLAINDETECT:{}", suspects.join("、")));
        }
        let mut list = read_store()?;
        let added: Vec<String> = parsed.iter().map(|s| s.name.clone()).collect();
        list.extend(parsed);
        write_store(&list)?;
        Ok((added, skipped))
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
}
