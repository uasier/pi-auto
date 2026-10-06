mod channel;
mod herdr;
mod herdr_term;
mod jev;
mod theme;
mod update;

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

fn open_new_window(app: &AppHandle) -> Result<(), String> {
    let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("win-{seq}");
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("herdr+")
        .inner_size(1180.0, 800.0)
        .min_inner_size(880.0, 560.0);
    if let Some(current) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        if let (Ok(pos), Ok(size)) = (current.outer_position(), current.inner_size()) {
            let scale = current.scale_factor().unwrap_or(1.0).max(1.0);
            builder = builder
                .inner_size(size.width as f64 / scale, size.height as f64 / scale)
                .position(pos.x as f64 / scale + 28.0, pos.y as f64 / scale + 28.0);
        }
    }
    builder.build().map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn new_window(app: AppHandle) -> Result<(), String> {
    open_new_window(&app)
}

#[tauri::command]
fn resize_window(window: tauri::WebviewWindow, delta_height: f64) -> Result<(), String> {
    let size = window.inner_size().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?.max(1.0);
    let width = size.width as f64 / scale;
    let height = (size.height as f64 / scale + delta_height).clamp(560.0, 1600.0);
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub pane_id: String,
    pub title: String,
    pub agent: String,
    pub agent_label: String,
    pub agent_state: String,
    pub cwd: String,
    pub idle: bool,
    pub confidence: String,
    pub reason: String,
    pub preview: String,
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
            title: pane.title,
            agent: pane.agent,
            agent_label: pane.agent_label,
            agent_state: pane.state,
            cwd: pane.cwd,
            idle,
            confidence: confidence.into(),
            reason,
            preview,
        });
    }
    Ok(sessions)
}

pub(crate) fn session_snapshot() -> Vec<AgentSession> {
    snapshot_sessions(&[]).unwrap_or_default()
}

#[tauri::command]
async fn complete_prompt(
    api_key: Option<String>,
    base_url: Option<String>,
    text: String,
    context: Option<String>,
) -> Result<jev::CompleteResult, String> {
    tauri::async_runtime::spawn_blocking(move || jev::complete_options(api_key, base_url, text, context))
        .await
        .map_err(|err| format!("{err}"))?
}

#[tauri::command]
async fn refine_prompt(
    api_key: Option<String>,
    base_url: Option<String>,
    text: String,
    context: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || jev::refine_prompt(api_key, base_url, text, context))
        .await
        .map_err(|err| format!("{err}"))?
}

#[tauri::command]
async fn create_terminal(
    cwd: Option<String>,
    command: Option<String>,
    label: Option<String>,
) -> Result<herdr::CreatedTerminal, String> {
    tauri::async_runtime::spawn_blocking(move || herdr::create_terminal(cwd, command, label))
        .await
        .map_err(|err| format!("{err}"))?
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
fn is_debug() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: update::current_version().into(),
        repo: update::github_repo(),
    }
}

#[tauri::command]
async fn check_update() -> Result<update::UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(update::check_update)
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
    let channel = MenuItem::with_id(app, "channel", "通道…", true, None::<&str>)?;
    let current_theme = theme::list_themes().current;
    let mut theme_items = Vec::new();
    for item in theme::menu_themes() {
        let label = if item.light {
            format!("{} · 浅色", item.label)
        } else {
            item.label.to_string()
        };
        theme_items.push(CheckMenuItem::with_id(
            app,
            format!("theme:{}", item.id),
            label,
            true,
            item.id == current_theme,
            None::<&str>,
        )?);
    }
    let theme_refs: Vec<&dyn IsMenuItem<_>> = theme_items.iter().map(|item| item as _).collect();
    let theme_menu = Submenu::with_items(app, "主题", true, &theme_refs)?;
    let new_window = MenuItem::with_id(app, "new-window", "新建窗口", true, Some("CmdOrCtrl+N"))?;
    let close_window = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let refine = MenuItem::with_id(app, "refine", "优化对话…", true, Some("CmdOrCtrl+Shift+O"))?;
    let usage = MenuItem::with_id(app, "usage", "使用说明", true, Some("CmdOrCtrl+/"))?;
    let shortcuts = MenuItem::with_id(app, "shortcuts", "管理快捷键…", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "herdr+",
                true,
                &[
                    &ai_keys,
                    &channel,
                    &theme_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &check_update,
                    &PredefinedMenuItem::separator(app)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::hide(app, Some("隐藏"))?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::separator(app)?,
                    &new_window,
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
            &Submenu::with_items(app, "系统", true, &[&shortcuts])?,
            &Submenu::with_id_and_items(
                app,
                tauri::menu::HELP_SUBMENU_ID,
                "说明",
                true,
                &[&refine, &usage],
            )?,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(move |app, event| {
        if let Some(name) = event.id().0.strip_prefix("theme:") {
            match theme::set_theme(name.to_string()) {
                Ok(chosen) => {
                    for item in &theme_items {
                        let _ = item.set_checked(item.id().0 == event.id().0);
                    }
                    for window in app.webview_windows().into_values() {
                        let _ = window.emit("theme-changed", &chosen);
                    }
                }
                Err(err) => {
                    for window in app.webview_windows().into_values() {
                        let _ = window.emit("theme-error", err.clone());
                    }
                }
            }
            return;
        }
        if event.id().0 == "new-window" {
            let _ = open_new_window(app);
        }
        let windows = app.webview_windows();
        let target = windows
            .values()
            .find(|window| window.is_focused().unwrap_or(false))
            .cloned()
            .or_else(|| app.get_webview_window("main"))
            .or_else(|| windows.into_values().next());
        if let Some(window) = target {
            let _ = window.emit("app-menu", event.id().0.clone());
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            install_menu(app)?;
            channel::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                herdr_term::detach_label(window.label());
                let app = window.app_handle();
                if app.webview_windows().len() <= 1 {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            send_to_session,
            nudge_session,
            herdr_term::term_attach,
            herdr_term::term_input,
            herdr_term::term_scroll,
            herdr_term::term_resize,
            herdr_term::term_detach,
            read_session_text,
            jev_choose,
            probe_decision,
            decision_status,
            herdr_status,
            app_info,
            check_update,
            open_release_page,
            install_update,
            new_window,
            resize_window,
            create_terminal,
            is_debug,
            theme::list_themes,
            theme::set_theme,
            channel::channel_status,
            channel::channel_save,
            channel::channel_github_start,
            channel::channel_github_logout,
            refine_prompt,
            complete_prompt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
