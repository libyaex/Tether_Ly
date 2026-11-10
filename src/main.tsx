import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// Registered after first paint so it never delays the initial render.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw?.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent("sw-update-available", { detail: reg }));
          }
        });
      });
    }).catch((e) => console.error("sw registration failed", e));
    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!refreshed) { refreshed = true; window.location.reload(); } });
  });
}
