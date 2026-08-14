var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _a;
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error process is a nodejs global
var host = process.env.TAURI_DEV_HOST;
// 工作区（git worktree）里跑第二个实例时，用注入的 CCODE_PORT 避免与主实例撞端口
// 默认 17575：Codex 桌面版的 NetworkService 会占用 Tauri 惯例端口 1420（本机实测冲突）
// 注意：CCODE_PORT 只改 vite 监听端口；tauri dev 加载的 devUrl（tauri.conf.json，固定
// 17575）不支持环境变量。worktree 里二次开发 Ccode 时必须同步覆盖 devUrl，例如：
// npm run tauri:dev -- --config "{\"build\":{\"devUrl\":\"http://localhost:$CCODE_PORT\"}}"
// @ts-expect-error process is a nodejs global
var port = Number((_a = process.env.CCODE_PORT) !== null && _a !== void 0 ? _a : 17575);
// https://vite.dev/config/
export default defineConfig(function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        return [2 /*return*/, ({
                plugins: [react(), tailwindcss()],
                build: {
                    rollupOptions: {
                        output: {
                            // 大依赖拆独立 vendor chunk：首屏只载 react + 当前页，
                            // xterm 随终端页懒加载，monaco 随文件预览懒加载
                            manualChunks: function (id) {
                                if (!id.includes("node_modules"))
                                    return undefined;
                                if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
                                    return "react";
                                if (id.includes("node_modules/@xterm/"))
                                    return "xterm";
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
                    port: port,
                    strictPort: true,
                    host: host || false,
                    hmr: host
                        ? {
                            protocol: "ws",
                            host: host,
                            port: port + 1,
                        }
                        : undefined,
                    watch: {
                        // 3. tell Vite to ignore watching `src-tauri`
                        ignored: ["**/src-tauri/**"],
                    },
                },
            })];
    });
}); });
