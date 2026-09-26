import { invoke } from "@tauri-apps/api/core";
import { $, escapeHtml } from "./dom";

export function log(message: string, err = false) {
  const box = $("log");
  const item = document.createElement("div");
  item.className = `item${err ? " err" : ""}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<span class="time">${time}</span><span>${escapeHtml(message)}</span>`;
  box.prepend(item);
  while (box.childElementCount > 80) {
    box.removeChild(box.lastElementChild as Node);
  }
  const latest = $("log-latest");
  latest.textContent = message;
  latest.classList.toggle("err", err);
}

const LOG_GROW = 168;
let logOpen = false;
let shortcutLoggedAt = 0;
let shortcutLoggedLabel = "";

export function logShortcut(label: string) {
  const now = Date.now();
  if (label === shortcutLoggedLabel && now - shortcutLoggedAt < 400) return;
  shortcutLoggedAt = now;
  shortcutLoggedLabel = label;
  log(`快捷键 ${label}`);
}

export async function toggleLogDock() {
  const next = !logOpen;
  $("log-dock").classList.toggle("open", next);
  $("log-caret").textContent = next ? "收起" : "展开";
  logOpen = next;
  try {
    await invoke("resize_window", { deltaHeight: next ? LOG_GROW : -LOG_GROW });
  } catch (error) {
    log(`调整窗口失败：${error}`, true);
  }
}
