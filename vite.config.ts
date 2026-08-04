import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// 工作区（git worktree）里跑第二个实例时，用注入的 CCODE_PORT 避免与主实例撞端口
// 默认 17575：Codex 桌面版的 NetworkService 会占用 Tauri 惯例端口 1420（本机实测冲突）
// 注意：CCODE_PORT 只改 vite 监听端口；tauri dev 加载的 devUrl（tauri.conf.json，固定
// 17575）不支持环境变量。worktree 里二次开发 Ccode 时必须同步覆盖 devUrl，例如：
// npm run tauri:dev -- --config "{\"build\":{\"devUrl\":\"http://localhost:$CCODE_PORT\"}}"
// @ts-expect-error process is a nodejs global
const port = Number(process.env.CCODE_PORT ?? 17575);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  build: {
    rollupOptions: {
      output: {
        // 大依赖拆独立 vendor chunk：首屏只载 react + 当前页，
        // xterm 随终端页懒加载，monaco 随文件预览懒加载
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("node_modules/@xterm/")) return "xterm";
          if (id.includes("node_modules/monaco-editor/")) {
            // 语言定义/语言服务由 monaco 内部动态 import 按需加载，保持独立小 chunk
            if (/monaco-editor\/esm\/vs\/(languages|language)\//.test(id)) {
              return undefined;
            }
            return "monaco";
          }
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
