//! 后台子进程的统一创建入口。
//!
//! Windows release 构建使用 `windows_subsystem = "windows"`，自身没有控制台；
//! 若直接启动 git/cmd 等 console 程序，系统会为每次调用创建可见控制台窗口，表现为
//! 终端页周期性闪黑窗。所有不需要独立可见窗口的命令必须经过这里。
//!
//! 这里同时在 spawn/wait 边界记录脱敏后的程序、参数、PID 与退出时间，供 Windows
//! 诊断包离线分析。环境变量不会进入记录。

use std::ffi::OsStr;
use std::process::Command;
#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::ops::{Deref, DerefMut};
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::process::{Child, ExitStatus, Output, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    let mut command = Command::new(program);
    configure_background(&mut command);
    BackgroundCommand { inner: command }
}

#[cfg(not(windows))]
pub fn background_command<S: AsRef<OsStr>>(program: S) -> BackgroundCommand {
    Command::new(program)
}

pub fn configure_background(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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
