use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const AGENT_KINDS: &[&str] = &["pi", "claude", "codex", "grok"];
static REQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrStatus {
    pub connected: bool,
    pub endpoint: Option<String>,
    pub pane_count: usize,
    pub agent_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HerdrPane {
    pub pane_id: String,
    pub agent: String,
    pub agent_label: String,
    pub state: String,
    pub cwd: String,
    pub title: String,
    pub interactive_ready: bool,
    pub cols: u16,
    pub rows: u16,
}

pub fn discover_socket() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let config = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&home).join(".config"));
    let root = config.join("herdr");
    let mut candidates = vec![root.join("herdr.sock")];
    if let Ok(entries) = std::fs::read_dir(root.join("sessions")) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("herdr.sock"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

pub fn status() -> HerdrStatus {
    match list_panes() {
        Ok((endpoint, panes)) => HerdrStatus {
            connected: true,
            endpoint: Some(endpoint),
            pane_count: panes.len(),
            agent_count: panes.len(),
            error: None,
        },
        Err(error) => HerdrStatus {
            connected: false,
            endpoint: discover_socket().map(|p| p.display().to_string()),
            pane_count: 0,
            agent_count: 0,
            error: Some(error),
        },
    }
}

pub fn list_panes() -> Result<(String, Vec<HerdrPane>), String> {
    let sock = discover_socket().ok_or_else(|| "未找到 herdr.sock。请先启动 Herdr 或 Pi Agent Desktop。".to_string())?;
    let endpoint = sock.display().to_string();
    let result = rpc(&sock, "session.snapshot", json!({}))?;
    if result.get("type").and_then(|v| v.as_str()) != Some("session_snapshot") {
        return Err("Herdr snapshot 响应无效".into());
    }
    let snapshot = result.get("snapshot").cloned().unwrap_or(Value::Null);
    let panes_wire = snapshot
        .get("panes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let agents_wire = snapshot
        .get("agents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut agents_by_pane = std::collections::HashMap::new();
    for agent in agents_wire {
        if let Some(id) = agent.get("pane_id").and_then(|v| v.as_str()) {
            agents_by_pane.insert(id.to_string(), agent);
        }
    }
    let mut size_by_pane = std::collections::HashMap::new();
    if let Some(layouts) = snapshot.get("layouts").and_then(|v| v.as_array()) {
        for layout in layouts {
            let Some(panes) = layout.get("panes").and_then(|v| v.as_array()) else {
                continue;
            };
            for pane in panes {
                let Some(id) = pane.get("pane_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(rect) = pane.get("rect") else {
                    continue;
                };
                let width = rect.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
                let height = rect.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
                if width > 0 && height > 0 {
                    size_by_pane.insert(id.to_string(), (width as u16, height as u16));
                }
            }
        }
    }

    let mut panes = Vec::new();
    for wire in panes_wire {
        let pane_id = match wire.get("pane_id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let detected = agents_by_pane.get(&pane_id).unwrap_or(&wire);
        let kind_raw = detected
            .get("agent")
            .and_then(|v| v.as_str())
            .or_else(|| detected.get("display_agent").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_lowercase();
        let kind = normalize_kind(&kind_raw);
        if !AGENT_KINDS.contains(&kind.as_str()) {
            continue;
        }
        let state = detected
            .get("agent_status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let cwd = wire
            .get("foreground_cwd")
            .and_then(|v| v.as_str())
            .or_else(|| wire.get("cwd").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let title = ["label", "title", "terminal_title_stripped"]
            .iter()
            .find_map(|k| wire.get(*k).and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let (cols, rows) = size_by_pane.get(&pane_id).copied().unwrap_or_else(|| {
            let rows = wire
                .get("scroll")
                .and_then(|v| v.get("viewport_rows"))
                .and_then(|v| v.as_u64())
                .unwrap_or(24) as u16;
            (80, rows.max(8))
        });
        panes.push(HerdrPane {
            pane_id,
            agent: kind.clone(),
            agent_label: agent_label(&kind).to_string(),
            state,
            cwd,
            title,
            interactive_ready: detected
                .get("interactive_ready")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            cols,
            rows,
        });
    }
    Ok((endpoint, panes))
}

pub fn read_pane(pane_id: &str) -> Result<String, String> {
    let sock = discover_socket().ok_or_else(|| "Herdr 未运行".to_string())?;
    let result = rpc(
        &sock,
        "pane.read",
        json!({
            "pane_id": pane_id,
            "source": "visible",
            "format": "ansi",
            "strip_ansi": false
        }),
    )
    .or_else(|_| {
        rpc(
            &sock,
            "pane.read",
            json!({
                "pane_id": pane_id,
                "source": "recent",
                "lines": 80,
                "format": "ansi",
                "strip_ansi": false
            }),
        )
    })?;
    Ok(result
        .get("read")
        .and_then(|r| r.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

pub fn prompt_agent(pane_id: &str, text: &str) -> Result<(), String> {
    let sock = discover_socket().ok_or_else(|| "Herdr 未运行".to_string())?;
    let result = rpc(
        &sock,
        "agent.prompt",
        json!({ "target": pane_id, "text": text }),
    )?;
    if result.get("type").and_then(|v| v.as_str()) != Some("agent_prompted") {
        return Err("Herdr 未接受这条 prompt".into());
    }
    Ok(())
}

/// Wake a frozen CLI by submitting `text`.
/// `agent.prompt` still submits while the agent is `working`.
/// Blocked or not-ready agents reject that, so fall back to raw pane input.
pub fn nudge_pane(pane_id: &str, text: &str) -> Result<&'static str, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("唤醒文本不能为空".into());
    }
    match prompt_agent(pane_id, text) {
        Ok(()) => Ok("prompt"),
        Err(prompt_err) => match send_pane_input(pane_id, text) {
            Ok(()) => Ok("input"),
            Err(input_err) => Err(format!(
                "prompt 失败：{prompt_err}；终端输入失败：{input_err}"
            )),
        },
    }
}

fn send_pane_input(pane_id: &str, text: &str) -> Result<(), String> {
    let sock = discover_socket().ok_or_else(|| "Herdr 未运行".to_string())?;
    rpc(
        &sock,
        "pane.send_input",
        json!({
            "pane_id": pane_id,
            "text": text,
            "keys": ["enter"]
        }),
    )?;
    Ok(())
}

fn agent_label(agent: &str) -> &'static str {
    match agent {
        "pi" => "Pi",
        "claude" => "Claude",
        "codex" => "Codex",
        "grok" => "Grok",
        _ => "Agent",
    }
}

fn normalize_kind(raw: &str) -> String {
    let s = raw.to_lowercase();
    if s.starts_with("pi") {
        "pi".into()
    } else if s.contains("claude") {
        "claude".into()
    } else if s.contains("codex") {
        "codex".into()
    } else if s.contains("grok") {
        "grok".into()
    } else {
        s.chars().take(32).collect()
    }
}

fn rpc(sock: &Path, method: &str, params: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(sock).map_err(|e| format!("连接 Herdr 失败：{e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok();
    let id = format!("pi-auto:{}", REQ.fetch_add(1, Ordering::Relaxed));
    let payload = json!({ "id": id, "method": method, "params": params });
    stream
        .write_all(format!("{payload}\n").as_bytes())
        .map_err(|e| format!("写入 Herdr 失败：{e}"))?;
    stream.flush().ok();

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("读取 Herdr 失败：{e}"))?;
    if line.trim().is_empty() {
        return Err("Herdr 返回空响应".into());
    }
    let value: Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("Herdr JSON 无效：{e}"))?;
    if let Some(err) = value.get("error") {
        let code = err
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let message = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Herdr 请求失败");
        return Err(format!("{code}: {message}"));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "Herdr 响应缺少 result".into())
}
