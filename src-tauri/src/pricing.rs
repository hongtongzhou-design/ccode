//! 自定义模型定价文件（<config>/ccode/pricing.json）的读写。
//! 统计页估算费用时由后端读取该文件；这里只做带校验的安全落盘。

use std::path::PathBuf;

fn pricing_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("pricing.json"))
}

/// 读取 pricing.json 内容；文件不存在返回空串（前端据此显示占位）
#[tauri::command]
pub fn read_pricing_file() -> Result<String, String> {
    match std::fs::read_to_string(pricing_path()?) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取 pricing.json 失败: {e}")),
    }
}

/// 写入 pricing.json：先校验是 JSON 对象，再原子写（tmp + rename）
#[tauri::command]
pub fn write_pricing_file(text: String) -> Result<(), String> {
    if !text.trim().is_empty() {
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("不是合法 JSON: {e}"))?;
        if !v.is_object() {
            return Err("pricing.json 必须是 JSON 对象".into());
        }
    }
    let path = pricing_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)
}
