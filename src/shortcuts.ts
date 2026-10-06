import { $ } from "./dom";
import { PRESET_TEXT_STORAGE } from "./keys";
import { log } from "./log";

export type ShortcutId = "tab" | "shift" | "refine";

const IDS: ShortcutId[] = ["tab", "shift", "refine"];

function storageKey(id: ShortcutId) {
  return `pi-auto-shortcut-${id}`;
}

export function shortcutEnabled(id: ShortcutId) {
  return localStorage.getItem(storageKey(id)) !== "0";
}

function box(id: ShortcutId) {
  return $<HTMLInputElement>(`shortcut-${id}`);
}

export function showShortcuts() {
  for (const id of IDS) box(id).checked = shortcutEnabled(id);
  $<HTMLTextAreaElement>("preset-text").value = localStorage.getItem(PRESET_TEXT_STORAGE) ?? "";
  $("shortcuts-foot").textContent = "";
  $("shortcuts-modal").classList.remove("hidden");
  $<HTMLTextAreaElement>("preset-text").focus();
}

export function hideShortcuts() {
  $("shortcuts-modal").classList.add("hidden");
}

export function saveShortcuts() {
  for (const id of IDS) {
    localStorage.setItem(storageKey(id), box(id).checked ? "1" : "0");
  }
  const text = $<HTMLTextAreaElement>("preset-text").value.trim();
  if (text) localStorage.setItem(PRESET_TEXT_STORAGE, text);
  else localStorage.removeItem(PRESET_TEXT_STORAGE);
  $("shortcuts-foot").textContent = "已保存";
  $("shortcuts-foot").className = "key-note ok";
  log("已保存快捷键设置");
}
