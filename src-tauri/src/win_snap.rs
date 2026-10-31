//! Windows 11 贴靠布局：去掉原生标题栏后，自绘的最大化按钮悬停不会弹系统的布局菜单
//! （系统只认原生标题栏的命中测试）。悬停够久时由这里替用户按一次 Win+Z——系统给当前前台窗口
//! 弹同一个布局菜单。只在 Windows 11、且 Mesa 是前台窗口时按；其余平台与 Windows 10 什么都不做。

/// 悬停最大化按钮够久后前端调用：弹出了返回 true
#[tauri::command]
pub fn window_show_snap_layouts(window: tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        if !is_windows_11() || !window.is_focused().unwrap_or(false) {
            return false;
        }
        send_win_z()
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// 布局菜单是 Windows 11（build 22000 起）的功能；Windows 10 的 Win+Z 不是这个意思，不能按。
/// 启动建窗也用它判 Mica 有没有（main_window.rs），所以直接读注册表、不起 `reg` 子进程：
/// 建窗前多等一个子进程，窗口就晚一拍出来。读不到按 Windows 10 算（启动页回落实心底，不会透出桌面）
#[cfg(windows)]
pub(crate) fn is_windows_11() -> bool {
    use std::sync::OnceLock;
    static BUILD: OnceLock<u32> = OnceLock::new();
    *BUILD.get_or_init(read_build_number) >= 22000
}

#[cfg(windows)]
fn read_build_number() -> u32 {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let name = wide("CurrentBuildNumber");
    let mut buf = [0u16; 32];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if rc != 0 {
        return 0;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().parse().unwrap_or(0)
}

#[cfg(windows)]
fn send_win_z() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN, VK_Z,
    };
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    // Win 先按后放、Z 夹在中间：Win 单独按放会弹开始菜单
    let inputs = [key(VK_LWIN, false), key(VK_Z, false), key(VK_Z, true), key(VK_LWIN, true)];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    sent == inputs.len() as u32
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn build_number_reads_from_registry() {
        // CI 的 Windows runner 与本机都是 Windows 10 起的版本，build 号五位数：只验读得到
        assert!(read_build_number() > 10_000);
    }
}
