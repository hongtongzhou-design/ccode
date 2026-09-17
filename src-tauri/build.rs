fn main() {
    placeholder_for_sidecar();
    tauri_build::build()
}

/// tauri-build 对 `bundle.externalBin` 做的是**每次 cargo build/test 都跑**的存在性
/// 校验（binaries/mesa_helper-<triple> 不在场直接报错），而真实二进制只能由
/// `scripts/stage-sidecar.mjs` 在打包前 cargo build 出来——先有鸡还是先有蛋。
/// 这里在 tauri-build 校验前落一个占位文件保住裸 cargo 命令（dev / test / check）；
/// `tauri build` 的 beforeBuildCommand 会在打包前用真实二进制覆写同一路径。
fn placeholder_for_sidecar() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    if target.is_empty() {
        return;
    }
    let name = if target.contains("windows") {
        format!("mesa_helper-{target}.exe")
    } else {
        format!("mesa_helper-{target}")
    };
    let path = std::path::Path::new("binaries").join(name);
    if !path.exists() {
        let _ = std::fs::create_dir_all("binaries");
        let _ = std::fs::write(&path, b"");
    }
}
