//! Mesa 浏览器桥 helper（通道 C 的本机端，独立进程）：
//! 浏览器扩展经 native messaging（stdin：4 字节小端长度 + JSON）发来
//! `{kind:"mesa-save-pdf", doi, title, url, bytesB64}`；helper 解码校验后调主程序
//! 的入库函数落**当前活跃项目** papers/（项目根由主程序写 helper-context.json 告知），
//! 回 `{ok, saved}` / `{ok:false, error}`。循环处理直到 stdin 关闭。
//!
//! 安全边界：stdin/stdout 只对本机浏览器；不监听网络；不读密钥；
//! 入库走主程序同一套口径（ensure_task_project_root + save_paper_bytes + 60MB/魔数）。

use std::io::{Read, Write};

fn read_frame(stdin: &mut impl Read) -> Option<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stdin.read_exact(&mut len_buf).ok()?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > 96 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn write_frame(stdout: &mut impl Write, obj: &serde_json::Value) {
    let body = serde_json::to_vec(obj).unwrap_or_default();
    let len = (body.len() as u32).to_le_bytes();
    let _ = stdout.write_all(&len);
    let _ = stdout.write_all(&body);
    let _ = stdout.flush();
}

fn helper_context_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("ccode").join("helper-context.json"))
}

fn active_project_root() -> Result<String, String> {
    let path = helper_context_path().ok_or("无法确定配置目录")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|_| "Mesa 里还没有「当前项目」——先在待获取清单点一次「在浏览器打开」".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("helper 语境损坏: {e}"))?;
    v.get("projectRoot")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Mesa 里还没有「当前项目」".to_string())
}

fn main() {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    while let Some(frame) = read_frame(&mut stdin) {
        let msg: serde_json::Value = match serde_json::from_slice(&frame) {
            Ok(v) => v,
            Err(_) => {
                write_frame(&mut stdout, &serde_json::json!({"ok": false, "error": "消息解析失败"}));
                continue;
            }
        };
        if msg.get("kind").and_then(|k| k.as_str()) != Some("mesa-save-pdf") {
            write_frame(&mut stdout, &serde_json::json!({"ok": false, "error": "未知消息类型"}));
            continue;
        }
        let reply = handle(&msg);
        write_frame(&mut stdout, &reply);
    }
}

fn handle(msg: &serde_json::Value) -> serde_json::Value {
    let bytes_b64 = msg.get("bytesB64").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = match base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        bytes_b64,
    ) {
        Ok(b) => b,
        Err(e) => return serde_json::json!({"ok": false, "error": format!("解码失败: {e}")}),
    };
    if bytes.is_empty() || bytes.len() > 60 * 1024 * 1024 {
        return serde_json::json!({"ok": false, "error": "内容为空或超过 60MB"});
    }
    if !bytes.starts_with(b"%PDF-") {
        return serde_json::json!({"ok": false, "error": "内容不是有效 PDF"});
    }
    let root = match active_project_root() {
        Ok(r) => r,
        Err(e) => return serde_json::json!({"ok": false, "error": e}),
    };
    let title = msg.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let doi = msg.get("doi").and_then(|v| v.as_str()).unwrap_or("");
    let hint = if !title.trim().is_empty() { title } else { doi };
    match ccode_lib::helper_ingest(&root, hint, &bytes) {
        Ok(saved) => serde_json::json!({"ok": true, "saved": saved}),
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    }
}
