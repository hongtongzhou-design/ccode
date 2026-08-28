//! 后台子进程的统一创建入口。
//!
//! Windows release 构建使用 `windows_subsystem = "windows"`，自身没有控制台；
//! 若直接启动 git/cmd 等 console 程序，系统会为每次调用创建可见控制台窗口，表现为
//! 终端页周期性闪黑窗。所有不需要独立可见窗口的命令必须经过这里。
//!
//! 这里同时在 spawn/wait 边界记录脱敏后的程序、参数、PID 与退出时间，供 Windows
//! 诊断包离线分析。环境变量不会进入记录。

use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;
#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::ops::{Deref, DerefMut};
#[cfg(windows)]
use std::process::{Child, ExitStatus, Output, Stdio};

use portable_pty::CommandBuilder;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn configure_background(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
pub struct BackgroundCommand {
    inner: Command,
}

#[cfg(not(windows))]
pub type BackgroundCommand = Command;

#[cfg(windows)]
pub struct TrackedChild {
    inner: Child,
    trace_id: Option<u64>,
}

#[cfg(windows)]
pub fn background_command<S: AsRef<OsStr>>(program: S) -> BackgroundCommand {
    // .cmd/.bat 批处理 shim 无法直接 CreateProcess（os error 193）：与 pty_command 同口径，
    // 优先深化为 node 直启（--version 探测、npm view 等都走这里），失败回落 cmd 包装
    let path = Path::new(program.as_ref());
    let mut command = if let Some((node, entry)) = node_entry_from_cmd_shim(path) {
        let mut c = Command::new(node);
        c.arg(entry);
        c
    } else if is_cmd_batch_shim(path) {
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/c", "call"]);
        c.arg(path);
        c
    } else {
        Command::new(program)
    };
    configure_background(&mut command);
    BackgroundCommand { inner: command }
}

#[cfg(not(windows))]
pub fn background_command<S: AsRef<OsStr>>(program: S) -> BackgroundCommand {
    Command::new(program)
}

/// 构建 PTY 命令。Windows 上 npm 系 CLI（npm 自己、npm 全局装的 codex 等）是
/// .cmd/.bat 批处理 shim，ConPTY/CreateProcess 无法直接执行批处理文件：
/// 优先解析 shim 文本里的 JS 入口改用 node 直启——参数不再过 cmd 解析，
/// 含引号/百分号/& 的 prompt 与参数也不会被 cmd 吞掉或误展开；
/// shim 结构解析失败才回落 cmd /c call 包装。
pub fn pty_command(program: &Path, args: &[String]) -> CommandBuilder {
    #[cfg(windows)]
    {
        if let Some((node, entry)) = node_entry_from_cmd_shim(program) {
            let mut command = CommandBuilder::new(node);
            command.arg(entry);
            for arg in args {
                command.arg(arg);
            }
            return command;
        }
        if is_cmd_batch_shim(program) {
            let mut command = CommandBuilder::new("cmd.exe");
            command.args(["/d", "/c", "call"]);
            command.arg(program);
            for arg in args {
                command.arg(arg);
            }
            return command;
        }
    }

    let mut command = CommandBuilder::new(program);
    for arg in args {
        command.arg(arg);
    }
    command
}

/// 是否 .cmd/.bat 批处理 shim（Windows 的 CreateProcess 无法直接执行）
#[cfg(any(windows, test))]
fn is_cmd_batch_shim(program: &Path) -> bool {
    program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// 从 npm 系 .cmd shim 文本提取相对 shim 目录的 JS 入口路径。
/// 兼容 cmd-shim 包的两代写法（`%~dp0\` 与 `%dp0%\`）；只认 .js 入口，
/// 跳过 shim 里对 node.exe 自身的引用。cfg(test) 下跨平台可测。
#[cfg(any(windows, test))]
fn js_entry_from_shim(content: &str) -> Option<String> {
    for token in content.split(|c: char| c == '"' || c.is_whitespace()) {
        for prefix in ["%~dp0\\", "%~dp0/", "%dp0%\\", "%dp0%/"] {
            if let Some(rest) = token.strip_prefix(prefix) {
                if rest.to_ascii_lowercase().ends_with(".js") {
                    return Some(rest.replace('/', "\\"));
                }
            }
        }
    }
    None
}

/// .cmd shim → (node 绝对路径, JS 入口绝对路径)：入口文件必须真实存在；
/// node 优先取 shim 同目录的 node.exe（官方 Node 布局），否则全局解析。
/// npm.cmd 自身是 Node 安装器的变量化脚本（SET NPM_CLI_JS=...，文本解析拿不到
/// 入口），但布局固定为 node_modules/npm/bin/npm-cli.js，走特殊 case；
/// 其余 shim（cmd-shim 包生成，如 codex.cmd）直接解析文本里的 %~dp0 入口。
#[cfg(windows)]
fn node_entry_from_cmd_shim(program: &Path) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    if !is_cmd_batch_shim(program) {
        return None;
    }
    let dir = program.parent()?;
    let entry = if program
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("npm.cmd"))
    {
        dir.join("node_modules").join("npm").join("bin").join("npm-cli.js")
    } else {
        let content = std::fs::read_to_string(program).ok()?;
        dir.join(js_entry_from_shim(&content)?)
    };
    if !entry.is_file() {
        return None;
    }
    let sibling = dir.join("node.exe");
    let node = if sibling.is_file() {
        sibling
    } else {
        crate::agents::resolve_binary("node")?
    };
    Some((node, entry))
}

#[cfg(windows)]
impl BackgroundCommand {
    pub fn arg<S: AsRef<OsStr>>(&mut self, arg: S) -> &mut Self {
        self.inner.arg(arg);
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.inner.args(args);
        self
    }

    pub fn current_dir<P: AsRef<Path>>(&mut self, dir: P) -> &mut Self {
        self.inner.current_dir(dir);
        self
    }

    pub fn env<K: AsRef<OsStr>, V: AsRef<OsStr>>(&mut self, key: K, value: V) -> &mut Self {
        self.inner.env(key, value);
        self
    }

    pub fn envs<I, K, V>(&mut self, vars: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner.envs(vars);
        self
    }

    pub fn env_remove<K: AsRef<OsStr>>(&mut self, key: K) -> &mut Self {
        self.inner.env_remove(key);
        self
    }

    pub fn stdin<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Self {
        self.inner.stdin(cfg);
        self
    }

    pub fn stdout<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Self {
        self.inner.stdout(cfg);
        self
    }

    pub fn stderr<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Self {
        self.inner.stderr(cfg);
        self
    }

    pub fn spawn(&mut self) -> io::Result<TrackedChild> {
        let child = self.inner.spawn()?;
        let trace_id = crate::diagnostics::record_spawn(&self.inner, child.id());
        Ok(TrackedChild {
            inner: child,
            trace_id: Some(trace_id),
        })
    }

    pub fn output(&mut self) -> io::Result<Output> {
        self.stdout(Stdio::piped()).stderr(Stdio::piped());
        self.spawn()?.wait_with_output()
    }
}

#[cfg(windows)]
impl TrackedChild {
    fn record_exit(&mut self, status: &ExitStatus) {
        if let Some(trace_id) = self.trace_id.take() {
            crate::diagnostics::record_spawn_exit(trace_id, status.code());
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.inner.try_wait()?;
        if let Some(ref status) = status {
            self.record_exit(status);
        }
        Ok(status)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.inner.wait()?;
        self.record_exit(&status);
        Ok(status)
    }

    pub fn kill(&mut self) -> io::Result<()> {
        self.inner.kill()
    }

    pub fn wait_with_output(self) -> io::Result<Output> {
        let TrackedChild {
            inner,
            mut trace_id,
        } = self;
        let output = inner.wait_with_output();
        if let (Some(id), Ok(value)) = (trace_id.take(), output.as_ref()) {
            crate::diagnostics::record_spawn_exit(id, value.status.code());
        }
        output
    }
}

#[cfg(windows)]
impl Deref for TrackedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

#[cfg(windows)]
impl DerefMut for TrackedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}

/// 带超时的读线程收尾：超时就放弃这个线程（它会在管道最终关闭时自行退出），
/// 不让漏网的子孙进程把调用方的工作线程永久钉死。
///
/// 超时路径必须用它而不是裸 `join()`：Windows 上包装层（`cmd /C`）之下的孙进程
/// 才是真正持有 stdout/stderr 管道写端的那个，只 kill 包装层的话读线程永远等不到 EOF。
/// 配合 `pty::kill_process_tree` 使用——先杀树消除根因，这里只是最后一道兜底。
pub(crate) fn join_with_timeout(
    handle: std::thread::JoinHandle<Vec<u8>>,
    timeout: std::time::Duration,
) -> Vec<u8> {
    let deadline = std::time::Instant::now() + timeout;
    while !handle.is_finished() {
        if std::time::Instant::now() > deadline {
            return Vec::new();
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    handle.join().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // cmd-shim 包现代格式（SET dp0 + "%dp0%\..."）
    const MODERN_SHIM: &str = r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
"#;

    // cmd-shim 包旧格式（直接 "%~dp0\..."）
    const LEGACY_SHIM: &str = r#"@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\node_modules\npm\bin\npm-cli.js" %*
) ELSE (
  node  "%~dp0\node_modules\npm\bin\npm-cli.js" %*
)
"#;

    #[test]
    fn shim_parses_modern_dp0_format() {
        assert_eq!(
            js_entry_from_shim(MODERN_SHIM).as_deref(),
            Some(r"node_modules\@openai\codex\bin\codex.js")
        );
    }

    #[test]
    fn shim_parses_legacy_tilde_format() {
        assert_eq!(
            js_entry_from_shim(LEGACY_SHIM).as_deref(),
            Some(r"node_modules\npm\bin\npm-cli.js")
        );
    }

    #[test]
    fn shim_rejects_non_js_and_garbage() {
        // 只认 .js 入口：node.exe 引用、空 dp0、无关内容都不算
        assert_eq!(js_entry_from_shim("SET dp0=%~dp0"), None);
        assert_eq!(js_entry_from_shim("\"%~dp0\\node.exe\" %*"), None);
        assert_eq!(js_entry_from_shim("echo hello"), None);
        assert_eq!(js_entry_from_shim(""), None);
    }

    #[test]
    fn installer_style_npm_cmd_is_not_text_parseable() {
        // Node 官方安装器的 npm.cmd 用变量间接引用入口（实机采样）：
        // 文本解析应返回 None，由 node_entry_from_cmd_shim 的固定布局 special case 接管
        let installer_style = "SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\n\
             SET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\n\
             \"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\n";
        assert_eq!(js_entry_from_shim(installer_style), None);
    }
}
