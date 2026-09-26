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
    pub title: String,
    pub agent: String,
    pub agent_label: String,
    pub state: String,
    pub cwd: String,
}

fn pane_title(wire: &Value) -> String {
    let raw = wire
        .get("terminal_title_stripped")
        .or_else(|| wire.get("terminal_title"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let raw = raw.trim_start_matches(['π', 'Π', 'π']).trim();
    raw.trim_start_matches('-').trim().to_string()
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
        let normalized = normalize_kind(&kind_raw);
        let kind = if AGENT_KINDS.contains(&normalized.as_str()) {
            normalized
        } else {
            "shell".to_string()
        };
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
        panes.push(HerdrPane {
            pane_id,
            title: pane_title(&wire),
            agent: kind.clone(),
            agent_label: agent_label(&kind).to_string(),
            state,
            cwd,
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
        "shell" => "终端",
        _ => "Agent",
    }
}

fn expand_cwd(raw: &str) -> String {
    let raw = raw.trim();
    if raw == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| raw.to_string());
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return Path::new(&home).join(rest).display().to_string();
        }
    }
    raw.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTerminal {
    pub pane_id: String,
    pub workspace_id: String,
    pub cwd: String,
    pub launch_error: Option<String>,
}

pub fn create_terminal(
    cwd: Option<String>,
    command: Option<String>,
    label: Option<String>,
) -> Result<CreatedTerminal, String> {
    let sock = discover_socket().ok_or_else(|| "Herdr 未运行".to_string())?;
    let mut params = json!({ "focus": true });
    let cwd = cwd.map(|value| expand_cwd(&value)).filter(|value| !value.is_empty());
    if let Some(cwd) = cwd.as_ref() {
        if !Path::new(cwd).is_dir() {
            return Err(format!("目录不存在：{cwd}"));
        }
        params["cwd"] = json!(cwd);
    }
    let label = label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| cwd.as_ref().and_then(|path| Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned())));
    if let Some(label) = label.as_ref() {
        params["label"] = json!(label);
    }
    let result = rpc(&sock, "workspace.create", params)?;
    if result.get("type").and_then(|v| v.as_str()) != Some("workspace_created") {
        return Err("Herdr 没有创建终端窗口".into());
    }
    let pane_id = result
        .pointer("/root_pane/pane_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if pane_id.is_empty() {
        return Err("Herdr 没有返回新终端".into());
    }
    let workspace_id = result
        .pointer("/workspace/workspace_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd = result
        .pointer("/root_pane/foreground_cwd")
        .or_else(|| result.pointer("/root_pane/cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let launch_error = match command.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        Some(command) => send_pane_input(&pane_id, &command).err(),
        None => None,
    };
    Ok(CreatedTerminal {
        pane_id,
        workspace_id,
        cwd,
        launch_error,
    })
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
