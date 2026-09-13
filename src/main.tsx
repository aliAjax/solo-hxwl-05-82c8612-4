import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 离线支持：注册 service worker（localhost 与 http 环境容错，失败不影响使用）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* 预览环境不支持时静默忽略，localStorage 仍保证数据离线可用 */
    });
  });
}
