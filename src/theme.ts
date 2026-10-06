import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { log } from "./log";
import { applyTermTheme } from "./terminal";

type AppTheme = {
  id: string;
  label: string;
  light: boolean;
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  idle: string;
  busy: string;
  warn: string;
  term: string;
  termFg: string;
  ink: string;
};

function paintTheme(theme: AppTheme) {
  const root = document.documentElement;
  const pairs: Array<[string, string]> = [
    ["--bg", theme.bg],
    ["--surface", theme.surface],
    ["--surface-2", theme.surface2],
    ["--line", theme.line],
    ["--text", theme.text],
    ["--muted", theme.muted],
    ["--accent", theme.accent],
    ["--idle", theme.idle],
    ["--busy", theme.busy],
    ["--warn", theme.warn],
    ["--term", theme.term],
    ["--term-fg", theme.termFg],
    ["--ink", theme.ink],
    ["--focus", theme.line],
  ];
  for (const [key, value] of pairs) root.style.setProperty(key, value);
  root.style.colorScheme = theme.light ? "light" : "dark";
  root.dataset.theme = theme.id;
  applyTermTheme({
    background: theme.term,
    foreground: theme.termFg,
    cursor: theme.accent,
    red: theme.warn,
    green: theme.idle,
    yellow: theme.busy,
    blue: theme.accent,
    cyan: theme.idle,
  });
}

export async function installTheme() {
  await listen<AppTheme>("theme-changed", (event) => {
    paintTheme(event.payload);
    log(`已切换 Herdr 主题：${event.payload.label}`);
  });
  await listen<string>("theme-error", (event) => log(event.payload, true));
  try {
    const listed = await invoke<{ current: string; themes: AppTheme[] }>("list_themes");
    const current = listed.themes.find((theme) => theme.id === listed.current) ?? listed.themes[0];
    if (current) paintTheme(current);
  } catch (error) {
    log(`读取 Herdr 主题失败：${error}`, true);
  }
}
