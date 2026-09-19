mod herdr;
mod update;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub pane_id: String,
    pub agent: String,
    pub agent_label: String,
    pub agent_state: String,
    pub cwd: String,
    pub title: String,
    pub idle: bool,
    pub confidence: String,
    pub reason: String,
    pub preview: String,
    pub interactive_ready: bool,
}

fn snapshot_sessions(preview_id: Option<String>) -> Result<Vec<AgentSession>, String> {
    let (_endpoint, panes) = match herdr::list_panes() {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let mut sessions = Vec::new();
    for pane in panes {
        let id = format!("herdr:{}", pane.pane_id);
        let want_live = preview_id.as_deref() == Some(id.as_str());
        let preview = if want_live {
            herdr::read_pane(&pane.pane_id).unwrap_or_default()
        } else {
            String::new()
        };
        let idle = pane.state == "idle" || pane.state == "done";
        let confidence = if matches!(pane.state.as_str(), "idle" | "done" | "working" | "blocked") {
            "high"
        } else {
            "low"
        };
        let reason = match pane.state.as_str() {
            "idle" => "Herdr 判定为空闲".into(),
            "done" => "Herdr 判定为已完成".into(),
            "working" => "Herdr 判定为执行中".into(),
            "blocked" => "Herdr 判定为阻塞（等待确认）".into(),
            other => format!("Herdr 状态：{other}"),
        };
        sessions.push(AgentSession {
            id,
            pane_id: pane.pane_id,
            agent: pane.agent,
            agent_label: pane.agent_label,
            agent_state: pane.state,
            cwd: pane.cwd,
            title: pane.title,
            idle,
            confidence: confidence.into(),
            reason,
            preview,
            interactive_ready: pane.interactive_ready,
        });
    }
    Ok(sessions)
}

#[tauri::command]
fn list_sessions(preview_id: Option<String>) -> Result<Vec<AgentSession>, String> {
    snapshot_sessions(preview_id)
}

#[tauri::command]
fn send_to_session(id: String, text: String, force: bool) -> Result<String, String> {
    let sessions = snapshot_sessions(Some(id.clone()))?;
    let session = sessions
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("找不到会话 {id}，Herdr pane 可能已关闭"))?;
    if !force && !session.idle {
        return Err(format!("{} 还在执行：{}", session.agent_label, session.reason));
    }
    herdr::prompt_agent(&session.pane_id, &text)?;
    Ok(format!(
        "已通过 Herdr 发送到 {} ({})",
        session.agent_label, session.pane_id
    ))
}

#[tauri::command]
fn herdr_status() -> herdr::HerdrStatus {
    herdr::status()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    repo: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: update::current_version().into(),
        repo: update::github_repo(),
    }
}

#[tauri::command]
async fn check_update(force: Option<bool>) -> Result<update::UpdateCheck, String> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || update::check_update(force))
        .await
        .map_err(|e| format!("{e}"))?
}

#[tauri::command]
async fn open_release_page(url: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update::open_release(url))
        .await
        .map_err(|e| format!("{e}"))?
}

#[tauri::command]
async fn install_update() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(update::install_update)
        .await
        .map_err(|e| format!("{e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            send_to_session,
            herdr_status,
            app_info,
            check_update,
            open_release_page,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
