// 打包前置：把 mesa_helper 编成 release 并按 Tauri sidecar 约定改名落位。
// bundle.externalBin 需要 src-tauri/binaries/mesa_helper-<host-triple>[.exe]——
// 同 crate 的 cargo 多 bin 不会自动进 bundle（2026-09-17 实测：打包版装了浏览器桥
// 却报「找不到 helper」，开发模式能跑纯粹因为 target/debug 里恰好有它）。
// 挂在 beforeBuildCommand 里（npm run build && node scripts/stage-sidecar.mjs），
// 只影响打包，不改 dev 流程（dev 用 target/debug/mesa_helper，README 有说明）。
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const tauriDir = join(root, "src-tauri");

// host triple：aarch64-apple-darwin / x86_64-pc-windows-msvc …（打包机本机）
const v = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = /^host:\s*(\S+)/m.exec(v)?.[1];
if (!triple) throw new Error("[stage-sidecar] 无法从 rustc -vV 解析 host triple");

console.log(`[stage-sidecar] host triple: ${triple}`);
execFileSync(
  "cargo",
  ["build", "--release", "--bin", "mesa_helper"],
  { cwd: tauriDir, stdio: "inherit" },
);

const ext = process.platform === "win32" ? ".exe" : "";
const src = join(tauriDir, "target", "release", `mesa_helper${ext}`);
const outDir = join(tauriDir, "binaries");
mkdirSync(outDir, { recursive: true });
const dst = join(outDir, `mesa_helper-${triple}${ext}`);
copyFileSync(src, dst);
chmodSync(dst, 0o755); // copyFile 虽随源模式，显式钉一遍防 umask 环境差异
console.log(`[stage-sidecar] ${dst}`);
