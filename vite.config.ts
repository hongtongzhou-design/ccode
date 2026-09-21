import { readFileSync } from "node:fs";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** monaco 在 WKWebView 里每次 click/keydown 会 cancel 上一次剪贴板 DeferredPromise。 */
const MONACO_CLIPBOARD_CANCEL =
  "this.webKitPendingClipboardWritePromise.cancel();";
const MONACO_CLIPBOARD_CANCEL_PATCH =
  "void this.webKitPendingClipboardWritePromise.p.catch(() => {}); this.webKitPendingClipboardWritePromise.cancel();";

function patchMonacoClipboardCancel(code: string): string | null {
  if (
    !code.includes(MONACO_CLIPBOARD_CANCEL) ||
    code.includes(MONACO_CLIPBOARD_CANCEL_PATCH)
  ) {
    return null;
  }
  return code.replace(MONACO_CLIPBOARD_CANCEL, MONACO_CLIPBOARD_CANCEL_PATCH);
}

function monacoClipboardCancelPlugin(): Plugin {
  return {
    name: "monaco-clipboard-cancel",
    transform(code, id) {
      const path = id.replace(/\\/g, "/");
      if (
        !path.includes("/monaco-editor/") ||
        !path.includes("clipboardService")
      ) {
        return undefined;
      }
      const patched = patchMonacoClipboardCancel(code);
      return patched ? { code: patched, map: null } : undefined;
    },
  };
}

function monacoClipboardCancelEsbuildPlugin(): EsbuildPlugin {
  return {
    name: "monaco-clipboard-cancel",
    setup(build) {
      build.onLoad({ filter: /clipboardService\.js$/ }, (args) => {
        if (!args.path.replace(/\\/g, "/").includes("/monaco-editor/")) {
          return;
        }
        const patched = patchMonacoClipboardCancel(
          readFileSync(args.path, "utf8"),
        );
        return patched ? { contents: patched, loader: "js" } : undefined;
      });
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// 工作区（git worktree）或第二 clone 里跑第二个实例时，用注入的 CCODE_PORT 避免与主实例撞端口
// 默认 17575：Codex 桌面版的 NetworkService 会占用 Tauri 惯例端口 1420（本机实测冲突）
// 注意：CCODE_PORT 只改 vite 监听端口；tauri dev 加载的 devUrl（tauri.conf.json，固定
// 17575）不支持环境变量。第二实例不要临时拼 --config，直接用入库的固定配置：
// npm run tauri:dev:17576（窗口标题带「 :17576」后缀，验收按标题+端口区分实例）
// @ts-expect-error process is a nodejs global
const port = Number(process.env.CCODE_PORT ?? 17575);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), monacoClipboardCancelPlugin()],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [monacoClipboardCancelEsbuildPlugin()],
    },
  },

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
          if (id.includes("node_modules/mermaid")) return "mermaid";
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
