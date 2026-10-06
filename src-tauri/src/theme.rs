use std::fs;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeChoice {
    pub id: &'static str,
    pub label: &'static str,
    pub light: bool,
    pub bg: &'static str,
    pub surface: &'static str,
    pub surface2: &'static str,
    pub line: &'static str,
    pub text: &'static str,
    pub muted: &'static str,
    pub accent: &'static str,
    pub idle: &'static str,
    pub busy: &'static str,
    pub warn: &'static str,
    pub term: &'static str,
    pub term_fg: &'static str,
    pub ink: &'static str,
}

const THEMES: &[ThemeChoice] = &[
    theme("catppuccin", "Catppuccin", false, "#181825", "#1e1e2e", "#313244", "#45475a", "#cdd6f4", "#6c7086", "#89b4fa", "#a6e3a1", "#f9e2af", "#f38ba8", "#11111b"),
    theme("catppuccin-latte", "Catppuccin Latte", true, "#eff1f5", "#e6e9ef", "#ccd0da", "#bcc0cc", "#4c4f69", "#9ca0b0", "#1e66f5", "#40a02b", "#df8e1d", "#d20f39", "#eff1f5"),
    theme("terminal", "Terminal", false, "#0e1014", "#15181e", "#1c2129", "#2a303a", "#e7ebf2", "#8b93a1", "#d7dee8", "#86a892", "#c6b48a", "#c98b86", "#101318"),
    theme("tokyo-night", "Tokyo Night", false, "#1a1b26", "#232636", "#24283b", "#414868", "#c0caf5", "#565f89", "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#1a1b26"),
    theme("tokyo-night-day", "Tokyo Night Day", true, "#e1e2e7", "#d2d3da", "#c4c8da", "#a8aecb", "#3760bf", "#8990b3", "#2e7de9", "#587539", "#8c6c3e", "#f52a65", "#e1e2e7"),
    theme("dracula", "Dracula", false, "#282a36", "#373c52", "#44475a", "#6272a4", "#f8f8f2", "#6272a4", "#bd93f9", "#50fa7b", "#f1fa8c", "#ff5555", "#282a36"),
    theme("nord", "Nord", false, "#2e3440", "#434c5e", "#3b4252", "#4c566a", "#eceff4", "#4c566a", "#88c0d0", "#a3be8c", "#ebcb8b", "#bf616a", "#2e3440"),
    theme("gruvbox", "Gruvbox", false, "#282828", "#323130", "#3c3836", "#504945", "#ebdbb2", "#928374", "#d79921", "#b8bb26", "#fabd2f", "#fb4934", "#282828"),
    theme("gruvbox-light", "Gruvbox Light", true, "#fbf1c7", "#f2e5bc", "#ebdbb2", "#d5c4a1", "#3c3836", "#928374", "#076678", "#79740e", "#b57614", "#9d0006", "#fbf1c7"),
    theme("one-dark", "One Dark", false, "#282c34", "#313640", "#2c313a", "#3e4451", "#abb2bf", "#5c6370", "#61afef", "#98c379", "#e5c07b", "#e06c75", "#282c34"),
    theme("one-light", "One Light", true, "#fafafa", "#d8dbe2", "#f0f0f1", "#e5e5e6", "#383a42", "#a0a1a7", "#4078f2", "#50a14f", "#c18401", "#e45649", "#fafafa"),
    theme("solarized", "Solarized", false, "#002b36", "#164b57", "#073642", "#586e75", "#93a1a1", "#586e75", "#268bd2", "#859900", "#b58900", "#dc322f", "#002b36"),
    theme("solarized-light", "Solarized Light", true, "#fdf6e3", "#eee8d5", "#eee8d5", "#93a1a1", "#657b83", "#93a1a1", "#268bd2", "#859900", "#b58900", "#dc322f", "#fdf6e3"),
    theme("kanagawa", "Kanagawa", false, "#1f1f28", "#363646", "#2a2a37", "#363646", "#dcd7ba", "#727169", "#7e9cd8", "#76946a", "#c0a36e", "#c34043", "#1f1f28"),
    theme("kanagawa-lotus", "Kanagawa Lotus", true, "#f2ecbc", "#d5cea3", "#dcd5ac", "#c9cbd1", "#545464", "#a09cac", "#4d699b", "#6f894e", "#77713f", "#c84053", "#f2ecbc"),
    theme("rose-pine", "Rosé Pine", false, "#191724", "#26233a", "#1f1d2e", "#26233a", "#e0def4", "#6e6a86", "#c4a7e7", "#31748f", "#f6c177", "#eb6f92", "#191724"),
    theme("rose-pine-dawn", "Rosé Pine Dawn", true, "#faf4ed", "#e3d9cf", "#f2e9e1", "#fffaf3", "#464261", "#9893a5", "#907aa9", "#286983", "#ea9d34", "#b4637a", "#faf4ed"),
    theme("vesper", "Vesper", false, "#1a1a1a", "#101010", "#232323", "#282828", "#ffffff", "#5c5c5c", "#ffc799", "#99ffe4", "#ffc799", "#ff8080", "#1a1a1a"),
];

const fn theme(
    id: &'static str,
    label: &'static str,
    light: bool,
    bg: &'static str,
    surface: &'static str,
    surface2: &'static str,
    line: &'static str,
    text: &'static str,
    muted: &'static str,
    accent: &'static str,
    idle: &'static str,
    busy: &'static str,
    warn: &'static str,
    ink: &'static str,
) -> ThemeChoice {
    ThemeChoice {
        id,
        label,
        light,
        bg,
        surface,
        surface2,
        line,
        text,
        muted,
        accent,
        idle,
        busy,
        warn,
        term: bg,
        term_fg: text,
        ink,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeList {
    pub current: String,
    pub themes: &'static [ThemeChoice],
}

fn config_path() -> Result<PathBuf, String> {
    crate::herdr::config_dir()
        .map(|dir| dir.join("config.toml"))
        .ok_or_else(|| "找不到 Herdr 配置目录".into())
}

pub fn menu_themes() -> &'static [ThemeChoice] {
    THEMES
}

fn find(name: &str) -> Option<&'static ThemeChoice> {
    THEMES.iter().find(|theme| theme.id == name)
}

pub fn read_theme_name(content: &str) -> Option<String> {
    let mut in_theme = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_theme = trimmed == "[theme]";
            continue;
        }
        if !in_theme {
            continue;
        }
        let rest = trimmed
            .strip_prefix("name")
            .filter(|rest| rest.starts_with('=') || rest.starts_with(' '))?;
        let value = rest.split_once('=')?.1.trim().trim_matches('"').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub fn write_theme_name(content: &str, name: &str) -> String {
    let named = upsert_section(content, "theme", "name", &format!("\"{name}\""));
    upsert_section(&named, "theme", "auto_switch", "false")
}

fn upsert_section(content: &str, section: &str, key: &str, value: &str) -> String {
    let header = format!("[{section}]");
    let assignment = format!("{key} = {value}");
    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    let mut i = 0;
    let mut found = false;
    let mut inserted = false;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed == header {
            found = true;
            result.push(line.to_string());
            i += 1;
            while i < lines.len() {
                let current = lines[i];
                let current_trimmed = current.trim();
                if current_trimmed.starts_with('[') && current_trimmed.ends_with(']') {
                    if !inserted {
                        result.push(assignment.clone());
                        inserted = true;
                    }
                    break;
                }
                if current_trimmed.starts_with(&format!("{key} ")) || current_trimmed.starts_with(&format!("{key}=")) {
                    result.push(assignment.clone());
                    inserted = true;
                } else {
                    result.push(current.to_string());
                }
                i += 1;
            }
            continue;
        }
        result.push(line.to_string());
        i += 1;
    }
    if !found {
        if result.last().is_some_and(|line| !line.trim().is_empty()) {
            result.push(String::new());
        }
        result.push(header);
        result.push(assignment);
    } else if !inserted {
        result.push(assignment);
    }
    let mut updated = result.join("\n");
    if !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated
}

#[tauri::command]
pub fn list_themes() -> ThemeList {
    let current = config_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| read_theme_name(&text))
        .filter(|name| find(name).is_some())
        .unwrap_or_else(|| "catppuccin".into());
    ThemeList {
        current,
        themes: THEMES,
    }
}

#[tauri::command]
pub fn set_theme(name: String) -> Result<ThemeChoice, String> {
    let theme = find(name.trim()).copied().ok_or_else(|| format!("未知主题：{name}"))?;
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建 Herdr 配置目录：{err}"))?;
    }
    let current = fs::read_to_string(&path).unwrap_or_default();
    fs::write(&path, write_theme_name(&current, theme.id)).map_err(|err| format!("写入 Herdr 主题失败：{err}"))?;
    crate::herdr::reload_config().map_err(|err| format!("已写入主题，但 Herdr 终端没有刷新：{err}"))?;
    Ok(theme)
}

#[cfg(test)]
mod tests {
    use super::{read_theme_name, write_theme_name};

    #[test]
    fn reads_only_the_theme_section() {
        let content = "name = \"nope\"\n[theme]\nname = \"nord\"\nauto_switch = true\n[ui]\nname = \"other\"\n";
        assert_eq!(read_theme_name(content).as_deref(), Some("nord"));
    }

    #[test]
    fn writes_theme_without_dropping_other_settings() {
        let content = "[terminal]\ndefault_shell = \"zsh\"\n\n[theme]\nname = \"catppuccin\"\nauto_switch = true\n";
        let updated = write_theme_name(content, "dracula");
        assert!(updated.contains("default_shell = \"zsh\""));
        assert!(updated.contains("name = \"dracula\""));
        assert!(updated.contains("auto_switch = false"));
        assert!(!updated.contains("name = \"catppuccin\""));
        assert!(!updated.contains("auto_switch = true"));
    }

    #[test]
    fn creates_theme_section_when_missing() {
        let updated = write_theme_name("[ui]\nsound = true\n", "vesper");
        assert!(updated.contains("[theme]"));
        assert!(updated.contains("name = \"vesper\""));
        assert!(updated.contains("auto_switch = false"));
        assert!(updated.contains("sound = true"));
    }
}
