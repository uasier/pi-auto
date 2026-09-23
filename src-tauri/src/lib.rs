mod herdr;
mod jev;
mod update;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

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
    pub cols: u16,
    pub rows: u16,
}

fn snapshot_sessions(preview_ids: &[String]) -> Result<Vec<AgentSession>, String> {
    let (_endpoint, panes) = match herdr::list_panes() {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let mut sessions = Vec::new();
    for pane in panes {
        let id = format!("herdr:{}", pane.pane_id);
        let want_live = preview_ids.iter().any(|item| item == &id);
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
            cols: pane.cols,
            rows: pane.rows,
        });
    }
    Ok(sessions)
}

#[tauri::command]
fn list_sessions(
    preview_id: Option<String>,
    preview_ids: Option<Vec<String>>,
) -> Result<Vec<AgentSession>, String> {
    let mut ids = preview_ids.unwrap_or_default();
    if let Some(id) = preview_id {
        if !ids.iter().any(|item| item == &id) {
            ids.push(id);
        }
    }
    snapshot_sessions(&ids)
}

#[tauri::command]
fn send_to_session(id: String, text: String, force: bool) -> Result<String, String> {
    let sessions = snapshot_sessions(&[id.clone()])?;
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
fn read_session_text(id: String) -> Result<String, String> {
    let pane_id = id.strip_prefix("herdr:").unwrap_or(id.as_str());
    herdr::read_pane(pane_id)
}

#[tauri::command]
async fn probe_decision(
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> jev::ProbeReport {
    tauri::async_runtime::spawn_blocking(move || jev::probe(provider, api_key, base_url))
        .await
        .unwrap_or_else(|err| jev::ProbeReport {
            ok: false,
            message: format!("检查失败：{err}"),
            endpoint: String::new(),
            latency_ms: 0,
        })
}

#[tauri::command]
async fn decision_status(laya_base: Option<String>) -> jev::BackendStatus {
    tauri::async_runtime::spawn_blocking(move || jev::backend_status(laya_base))
        .await
        .unwrap_or(jev::BackendStatus {
            jev: false,
            laya: false,
            laya_base: None,
        })
}

#[tauri::command]
async fn jev_choose(
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    state: String,
    options: Vec<jev::JevOption>,
    instructions: Option<String>,
    include_stop: Option<bool>,
) -> Result<jev::JevDecision, String> {
    tauri::async_runtime::spawn_blocking(move || {
        jev::choose(
            provider,
            api_key,
            base_url,
            state,
            options,
            instructions,
            include_stop,
        )
    })
    .await
    .map_err(|e| format!("{e}"))?
}

#[tauri::command]
fn nudge_session(id: String, text: String) -> Result<String, String> {
    let pane_id = id
        .strip_prefix("herdr:")
        .unwrap_or(id.as_str())
        .to_string();
    let via = herdr::nudge_pane(&pane_id, &text)?;
    Ok(format!("已输入「{}」唤醒 {pane_id}（{via}）", text.trim()))
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

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let ai_keys = MenuItem::with_id(app, "ai-keys", "密钥设置…", true, Some("CmdOrCtrl+,") )?;
    let close_window = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let usage = MenuItem::with_id(app, "usage", "使用说明", true, Some("CmdOrCtrl+/"))?;
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "终端自动应答",
                true,
                &[
                    &ai_keys,
                    &PredefinedMenuItem::separator(app)?,
                    &check_update,
                    &PredefinedMenuItem::separator(app)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::hide(app, Some("隐藏"))?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::separator(app)?,
                    &close_window,
                    &PredefinedMenuItem::quit(app, Some("退出"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("撤销"))?,
                    &PredefinedMenuItem::redo(app, Some("重做"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("剪切"))?,
                    &PredefinedMenuItem::copy(app, Some("拷贝"))?,
                    &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                    &PredefinedMenuItem::select_all(app, Some("全选"))?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                tauri::menu::HELP_SUBMENU_ID,
                "说明",
                true,
                &[&usage],
            )?,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("app-menu", event.id().0.clone());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            install_menu(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            send_to_session,
            nudge_session,
            read_session_text,
            jev_choose,
            probe_decision,
            decision_status,
            herdr_status,
            app_info,
            check_update,
            open_release_page,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
