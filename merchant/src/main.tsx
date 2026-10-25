import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { captureInstall } from "./lib/install";
import { initialTheme } from "./lib/theme";
import { getLang } from "./lib/i18n";
import "./styles/app.css";

// Before anything renders: the saved theme (no flash), the install prompt listener, and the
// service worker that makes the app installable and quick to reopen.
initialTheme();
document.documentElement.lang = getLang();
captureInstall();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
