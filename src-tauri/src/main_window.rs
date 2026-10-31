//! 主窗口创建（2026-10-31）：各份 tauri*.conf.json 里主窗口 `create: false`，setup 一开头按同一份配置自己建。
//!
//! 为的是 Windows 的启动画面。交给配置建窗时，窗口带着原生标题栏先亮出来，要等 setup 跑完
//! （播种技能、托盘、浏览器桥……开发版实测约 3 秒）lib.rs 才去掉标题栏——启动时先是白底带标题栏，
//! 再是带标题栏的 Mica，最后标题栏才消失。自己建就能在建窗时去掉标题栏；Windows 11 上再给页面
//! 打一个启动即磨砂的标记（index.html 读 `__MESA_BOOT_GLASS__`），启动页从第一帧起直接透出 Mica，
//! 不再先铺主题色实心底、0.4s 后淡回玻璃（同 macOS 10-30 的改法）。Windows 10 没有 Mica，照旧实心底。
//!
//! WebView2 第一次出画面前窗口是白的（实测 0.15–0.9s，随机器忙闲）。Windows 上窗口建好先隐身（DWM cloak：
//! 系统里照常可见、照常渲染，只是不上屏），index.html 把启动字标画出第一帧后调 `boot_window_painted` 露出来；
//! 最多等 1 秒，页面卡住也照样露出（用户拍板：窗口晚零点几秒、一出来就是完整画面，好过先白一下）。
//! 隐身而不是一直 visible(false)：show 之后窗口在系统里就是可见的，WebView2 照常渲染、照常跑首帧回调。
//! macOS / Linux 什么都不加，与配置建窗是同一个调用（tauri 自己也是 setup 前 `from_config(..).build()`）。

/// 隐身最长等多久：首帧没报到也到点露出
#[cfg(windows)]
const BOOT_CLOAK_MAX_MS: u64 = 1000;

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    // 哪份配置漏写 create:false，tauri 已经建好了：照旧由 lib.rs 后面的 set_decorations 兜底
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main") else {
        return Ok(());
    };
    let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
    // 不能写进 tauri.conf：开发配置覆盖时 windows 数组整体替换，平台专属配置会丢
    #[cfg(windows)]
    {
        let mut script = String::from("window.__MESA_BOOT_CLOAK__ = true;");
        if crate::win_snap::is_windows_11() {
            script.push_str("window.__MESA_BOOT_GLASS__ = true;");
        }
        // 先不显示：建好、隐身之后再 show，中间不会上屏一帧白窗
        let window = builder
            .decorations(false)
            .visible(false)
            .initialization_script(script)
            .build()?;
        // 句柄趁在主线程时取好存下：hwnd() 要经事件循环取，setup 后半段占着主线程（开发版约 3 秒）时
        // 兜底线程去取会一直等到 setup 跑完，1 秒上限就成了空话（Mesa Dev 实测隐身了 4 秒）
        if let Ok(hwnd) = window.hwnd() {
            BOOT_HWND.store(hwnd.0 as isize, std::sync::atomic::Ordering::SeqCst);
        }
        set_cloaked(true);
        let _ = window.show();
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(BOOT_CLOAK_MAX_MS));
            if set_cloaked(false) {
                crate::logbuf::record("warn", "window", "启动字标 1 秒内没画出首帧，到点露出窗口");
            }
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        builder.build()?;
        Ok(())
    }
}

/// 启动字标第一帧画好后 index.html 调用（只在 Windows 注入了隐身标记时调）；重复调用、到点后再调都无害
#[tauri::command]
pub fn boot_window_painted() {
    #[cfg(windows)]
    set_cloaked(false);
}

#[cfg(windows)]
static BOOT_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// 改隐身状态；返回这次是否真的改了（露出时：之前还隐着）。直接调 DWM，不经事件循环，哪个线程都能调
#[cfg(windows)]
fn set_cloaked(on: bool) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
    static CLOAKED: AtomicBool = AtomicBool::new(false);
    if CLOAKED.swap(on, Ordering::SeqCst) == on {
        return false;
    }
    let hwnd = BOOT_HWND.load(Ordering::SeqCst);
    if hwnd == 0 {
        return false;
    }
    let value: i32 = on.into();
    unsafe {
        DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_CLOAK as u32,
            (&value as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
    }
    true
}
