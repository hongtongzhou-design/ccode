import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IS_MAC, IS_WINDOWS } from "./hotkeys";

// 平台标记：Windows 的文字光栅化（DirectWrite 灰度抗锯齿）与 macOS 差异大，
// App.css 据此区分字体栈与 text-rendering
document.documentElement.dataset.platform = IS_MAC
  ? "mac"
  : IS_WINDOWS
    ? "windows"
    : "linux";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
