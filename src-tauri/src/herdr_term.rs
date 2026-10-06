//! Direct terminal attach over Herdr's client socket.
//!
//! Frame format matches herdr 0.9.1: `[u32 LE length][bincode standard payload]`.
//! Variant indexes are frozen for protocol 22.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const PROTOCOL_VERSION: u32 = 22;
const MAX_FRAME: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
enum AttachScrollDirection {
    Up,
    Down,
}

#[derive(Debug, Serialize)]
enum AttachScrollSource {
    Wheel,
    #[allow(dead_code)]
    PageKey {
        input: Vec<u8>,
    },
}

#[derive(Debug, Serialize)]
enum ClientMessage {
    TerminalHello {
        version: u32,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        pixel_mouse: bool,
    },
    Input {
        data: Vec<u8>,
    },
    #[allow(dead_code)]
    UnusedClipboard,
    Resize {
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        pixel_mouse: bool,
    },
    Detach,
    #[allow(dead_code)]
    UnusedAttach,
    AttachScroll {
        source: AttachScrollSource,
        direction: AttachScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
    #[allow(dead_code)]
    UnusedObserve,
    ControlTerminal {
        target: String,
        takeover: bool,
    },
}

#[derive(Debug, Deserialize)]
enum RenderEncoding {
    SemanticFrame,
    TerminalAnsi,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct TerminalFrame {
    seq: u64,
    width: u16,
    height: u16,
    full: bool,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
enum ServerMessage {
    Welcome {
        version: u32,
        encoding: RenderEncoding,
        error: Option<String>,
    },
    Terminal(TerminalFrame),
    Graphics {
        bytes: Vec<u8>,
    },
    ServerShutdown {
        reason: Option<String>,
    },
}

struct Link {
    writer: UnixStream,
    generation: u64,
    pane_id: String,
}

#[derive(Clone)]
pub struct RelayFrame {
    pub seq: u64,
    pub pane_id: String,
    pub generation: u64,
    pub full: bool,
    pub width: u16,
    pub height: u16,
    pub bytes: Vec<u8>,
}

static LINKS: LazyLock<Mutex<HashMap<String, Link>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static GENERATION: AtomicU64 = AtomicU64::new(1);
static FRAME_SEQ: AtomicU64 = AtomicU64::new(1);
static FRAME_OVERFLOW: AtomicBool = AtomicBool::new(false);
static FRAME_TX: LazyLock<Mutex<Option<std::sync::mpsc::SyncSender<RelayFrame>>>> = LazyLock::new(|| Mutex::new(None));
static RELAY_SUBS: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CACHE: LazyLock<Mutex<HashMap<String, Vec<RelayFrame>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static ATTACH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

pub fn set_frame_sender(tx: Option<std::sync::mpsc::SyncSender<RelayFrame>>) {
    if let Ok(mut slot) = FRAME_TX.lock() {
        *slot = tx;
    }
}

pub fn take_frame_overflow() -> bool {
    FRAME_OVERFLOW.swap(false, Ordering::Relaxed)
}

fn publish_frame(mut frame: RelayFrame) {
    if frame.seq == 0 {
        frame.seq = FRAME_SEQ.fetch_add(1, Ordering::Relaxed);
    }
    if let Ok(mut cache) = CACHE.lock() {
        let entry = cache.entry(frame.pane_id.clone()).or_default();
        if frame.full || entry.last().map(|item| item.generation != frame.generation).unwrap_or(false) {
            entry.clear();
        }
        entry.push(frame.clone());
        if entry.len() > 120 {
            // 删除中间增量会使 ANSI 回放失真，超限后改用现时快照。
            entry.clear();
        }
    }
    if !RELAY_SUBS.lock().map(|subs| subs.contains_key(&frame.pane_id)).unwrap_or(false) {
        return;
    }
    let tx = FRAME_TX.lock().ok().and_then(|slot| slot.clone());
    if let Some(tx) = tx {
        if let Err(std::sync::mpsc::TrySendError::Full(_)) = tx.try_send(frame) {
            FRAME_OVERFLOW.store(true, Ordering::Relaxed);
        }
    }
}

pub fn replay(pane_id: &str) -> Vec<RelayFrame> {
    CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(pane_id).cloned())
        .unwrap_or_default()
}

fn client_socket() -> Result<PathBuf, String> {
    let api = crate::herdr::discover_socket().ok_or("未找到 herdr.sock")?;
    let path = api.with_file_name("herdr-client.sock");
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("未找到 {}", path.display()))
    }
}

fn write_msg(stream: &mut UnixStream, msg: &ClientMessage) -> Result<(), String> {
    let payload = bincode::serde::encode_to_vec(msg, bincode::config::standard())
        .map_err(|err| format!("编码失败：{err}"))?;
    if payload.len() > MAX_FRAME {
        return Err("终端帧过大".into());
    }
    stream
        .write_all(&(payload.len() as u32).to_le_bytes())
        .and_then(|_| stream.write_all(&payload))
        .and_then(|_| stream.flush())
        .map_err(|err| format!("写入 Herdr 失败：{err}"))
}

fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, String> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .map_err(|err| format!("读取帧长度失败：{err}"))?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        return Err(format!("帧长度 {len} 超过上限"));
    }
    let mut payload = vec![0u8; len];
    stream
        .read_exact(&mut payload)
        .map_err(|err| format!("读取帧失败：{err}"))?;
    Ok(payload)
}

fn decode_server(payload: &[u8]) -> Result<ServerMessage, String> {
    let (msg, consumed) = bincode::serde::decode_from_slice(payload, bincode::config::standard())
        .map_err(|err| format!("解码失败：{err}"))?;
    if consumed != payload.len() {
        return Err("终端帧有多余字节".into());
    }
    Ok(msg)
}

fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(20, 400), rows.clamp(8, 200))
}

#[derive(Clone, Serialize)]
struct TermBytesEvent {
    generation: u64,
    full: bool,
    width: u16,
    height: u16,
    bytes: String,
}

#[tauri::command]
pub fn term_attach(window: WebviewWindow, pane_id: String, cols: u16, rows: u16) -> Result<u64, String> {
    let label = window.label().to_string();
    let pane_id = pane_id.trim().to_string();
    if pane_id.is_empty() {
        return Err("没有 pane".into());
    }
    let _guard = ATTACH_LOCK.lock().map_err(|_| "终端锁失败".to_string())?;
    release_label(&label, true);
    release_pane(&pane_id);
    let (cols, rows) = clamp_size(cols, rows);
    attach_locked(&label, &pane_id, cols, rows, Some(window.app_handle().clone()))
}

fn attach_locked(
    label: &str,
    pane_id: &str,
    cols: u16,
    rows: u16,
    app: Option<AppHandle>,
) -> Result<u64, String> {
    let mut stream = UnixStream::connect(client_socket()?).map_err(|err| format!("连接终端通道失败：{err}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .ok();
    write_msg(
        &mut stream,
        &ClientMessage::TerminalHello {
            version: PROTOCOL_VERSION,
            cols,
            rows,
            cell_width_px: 8,
            cell_height_px: 16,
            pixel_mouse: false,
        },
    )?;
    let welcome = decode_server(&read_frame(&mut stream)?)?;
    match welcome {
        ServerMessage::Welcome {
            encoding: RenderEncoding::TerminalAnsi,
            error: None,
            ..
        } => {}
        ServerMessage::Welcome { error: Some(error), .. } => return Err(error),
        ServerMessage::Welcome { .. } => return Err("Herdr 没有给出 ANSI 终端".into()),
        _ => return Err("握手响应无效".into()),
    }
    write_msg(
        &mut stream,
        &ClientMessage::ControlTerminal {
            target: pane_id.to_string(),
            takeover: true,
        },
    )?;
    stream.set_read_timeout(None).ok();
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let reader = stream.try_clone().map_err(|err| format!("复制连接失败：{err}"))?;
    {
        let mut links = LINKS.lock().map_err(|_| "终端锁失败".to_string())?;
        links.insert(
            label.to_string(),
            Link {
                writer: stream,
                generation,
                pane_id: pane_id.to_string(),
            },
        );
    }
    let label = label.to_string();
    let pane_id = pane_id.to_string();
    std::thread::spawn(move || read_loop(app, label, pane_id, reader, generation));
    Ok(generation)
}

fn pane_attached(pane_id: &str) -> bool {
    LINKS
        .lock()
        .ok()
        .map(|links| links.values().any(|link| link.pane_id == pane_id))
        .unwrap_or(false)
}

fn release_pane(pane_id: &str) {
    let labels: Vec<String> = LINKS
        .lock()
        .ok()
        .map(|links| {
            links
                .iter()
                .filter(|(_, link)| link.pane_id == pane_id)
                .map(|(label, _)| label.clone())
                .collect()
        })
        .unwrap_or_default();
    for label in labels {
        release_label(&label, false);
    }
}

fn release_label(label: &str, restore: bool) {
    let removed = LINKS.lock().ok().and_then(|mut links| links.remove(label));
    if let Some(mut current) = removed {
        let pane = current.pane_id.clone();
        let _ = write_msg(&mut current.writer, &ClientMessage::Detach);
        let _ = current.writer.shutdown(std::net::Shutdown::Both);
        if restore {
            schedule_restore(&pane);
        }
    }
}

fn schedule_restore(pane_id: &str) {
    let pane_id = pane_id.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let Ok(_guard) = ATTACH_LOCK.lock() else {
            return;
        };
        let wanted = RELAY_SUBS.lock().ok().map(|subs| subs.contains_key(&pane_id)).unwrap_or(false);
        if wanted && !pane_attached(&pane_id) {
            let _ = attach_locked(&format!("relay:{pane_id}"), &pane_id, 100, 32, None);
        }
    });
}

pub fn relay_subscribe(pane_id: &str) -> Result<(), String> {
    let pane_id = pane_id.trim();
    if pane_id.is_empty() {
        return Err("没有 pane".into());
    }
    let _guard = ATTACH_LOCK.lock().map_err(|_| "终端锁失败".to_string())?;
    if !pane_attached(pane_id) {
        attach_locked(&format!("relay:{pane_id}"), pane_id, 100, 32, None)?;
    }
    let mut subs = RELAY_SUBS.lock().map_err(|_| "订阅锁失败".to_string())?;
    *subs.entry(pane_id.to_string()).or_insert(0) += 1;
    Ok(())
}

pub fn relay_unsubscribe(pane_id: &str) {
    let pane_id = pane_id.trim();
    if pane_id.is_empty() {
        return;
    }
    let Ok(_guard) = ATTACH_LOCK.lock() else { return; };
    let left = RELAY_SUBS.lock().ok().and_then(|mut subs| {
        let count = subs.get_mut(pane_id)?;
        *count = count.saturating_sub(1);
        let left = *count;
        if left == 0 {
            subs.remove(pane_id);
        }
        Some(left)
    });
    if left == Some(0) {
        release_label(&format!("relay:{pane_id}"), false);
    }
}

pub fn maintain_relay() {
    let Ok(_guard) = ATTACH_LOCK.try_lock() else {
        return;
    };
    let panes: Vec<String> = RELAY_SUBS
        .lock()
        .ok()
        .map(|subs| subs.keys().cloned().collect())
        .unwrap_or_default();
    for pane in panes {
        if !pane_attached(&pane) {
            let _ = attach_locked(&format!("relay:{pane}"), &pane, 100, 32, None);
        }
    }
}

pub fn write_input_pane(pane_id: &str, data: Vec<u8>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    with_pane(pane_id, |stream| write_msg(stream, &ClientMessage::Input { data }))
}

pub fn write_scroll_pane(pane_id: &str, direction: &str, lines: u16) -> Result<(), String> {
    let direction = match direction.trim() {
        "up" => AttachScrollDirection::Up,
        "down" => AttachScrollDirection::Down,
        _ => return Err("滚动方向无效".into()),
    };
    let lines = lines.clamp(1, 3);
    with_pane(pane_id, |stream| {
        write_msg(
            stream,
            &ClientMessage::AttachScroll {
                source: AttachScrollSource::Wheel,
                direction,
                lines,
                column: None,
                row: None,
                modifiers: 0,
            },
        )
    })
}

fn with_pane(pane_id: &str, op: impl FnOnce(&mut UnixStream) -> Result<(), String>) -> Result<(), String> {
    let mut links = LINKS.lock().map_err(|_| "终端锁失败".to_string())?;
    let link = links
        .values_mut()
        .find(|link| link.pane_id == pane_id)
        .ok_or("终端未接入")?;
    op(&mut link.writer)
}

fn emit_to(app: &AppHandle, label: &str, event: &str, payload: impl serde::Serialize + Clone) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.emit(event, payload);
    }
}

fn read_loop(app: Option<AppHandle>, label: String, pane_id: String, mut stream: UnixStream, generation: u64) {
    loop {
        if generation_closed(&label, generation) {
            break;
        }
        let payload = match read_frame(&mut stream) {
            Ok(payload) => payload,
            Err(_) => break,
        };
        if generation_closed(&label, generation) {
            break;
        }
        match decode_server(&payload) {
            Ok(ServerMessage::Terminal(frame)) => {
                publish_frame(RelayFrame {
                    seq: 0,
                    pane_id: pane_id.clone(),
                    generation,
                    full: frame.full,
                    width: frame.width,
                    height: frame.height,
                    bytes: frame.bytes.clone(),
                });
                if let Some(app) = &app {
                    emit_to(
                        app,
                        &label,
                        "term-bytes",
                        TermBytesEvent {
                            generation,
                            full: frame.full,
                            width: frame.width,
                            height: frame.height,
                            bytes: base64::engine::general_purpose::STANDARD.encode(frame.bytes),
                        },
                    );
                }
            }
            Ok(ServerMessage::ServerShutdown { reason }) => {
                if let Some(app) = &app {
                    emit_to(
                        app,
                        &label,
                        "term-closed",
                        reason.unwrap_or_else(|| "Herdr 关闭了终端连接".into()),
                    );
                }
                break;
            }
            Ok(_) | Err(_) => {}
        }
    }
    if !generation_closed(&label, generation) {
        if let Some(app) = &app {
            emit_to(app, &label, "term-closed", "终端连接已断开");
        }
        release_label(&label, true);
    }
}

fn generation_closed(label: &str, generation: u64) -> bool {
    LINKS
        .lock()
        .ok()
        .and_then(|links| links.get(label).map(|item| item.generation != generation))
        .unwrap_or(true)
}

fn with_writer(label: &str, op: impl FnOnce(&mut UnixStream) -> Result<(), String>) -> Result<(), String> {
    let mut links = LINKS.lock().map_err(|_| "终端锁失败".to_string())?;
    let link = links.get_mut(label).ok_or("终端未接入")?;
    op(&mut link.writer)
}

#[tauri::command]
pub fn term_scroll(window: WebviewWindow, direction: String, lines: u16) -> Result<(), String> {
    let label = window.label().to_string();
    let direction = match direction.trim() {
        "up" => AttachScrollDirection::Up,
        "down" => AttachScrollDirection::Down,
        _ => return Err("滚动方向无效".into()),
    };
    let lines = lines.clamp(1, 3);
    with_writer(&label, |stream| {
        write_msg(
            stream,
            &ClientMessage::AttachScroll {
                source: AttachScrollSource::Wheel,
                direction,
                lines,
                column: None,
                row: None,
                modifiers: 0,
            },
        )
    })
}

#[tauri::command]
pub fn term_input(window: WebviewWindow, bytes_b64: String) -> Result<(), String> {
    let label = window.label().to_string();
    let data = base64::engine::general_purpose::STANDARD
        .decode(bytes_b64.trim())
        .map_err(|err| format!("输入无效：{err}"))?;
    if data.is_empty() {
        return Ok(());
    }
    with_writer(&label, |stream| write_msg(stream, &ClientMessage::Input { data }))
}

#[tauri::command]
pub fn term_resize(window: WebviewWindow, cols: u16, rows: u16) -> Result<(), String> {
    let label = window.label().to_string();
    let (cols, rows) = clamp_size(cols, rows);
    with_writer(&label, |stream| {
        write_msg(
            stream,
            &ClientMessage::Resize {
                cols,
                rows,
                cell_width_px: 8,
                cell_height_px: 16,
                pixel_mouse: false,
            },
        )
    })
}

#[tauri::command]
pub fn term_detach(window: WebviewWindow) -> Result<(), String> {
    detach_label(window.label());
    Ok(())
}

pub fn detach_label(label: &str) {
    release_label(label, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pane: &str, generation: u64, full: bool) -> RelayFrame {
        RelayFrame { seq: 0, pane_id: pane.into(), generation, full, width: 80, height: 24, bytes: b"frame".to_vec() }
    }

    #[test]
    fn replay_never_keeps_a_full_frame_with_missing_deltas() {
        let pane = "test-cache-history";
        publish_frame(frame(pane, 1, true));
        for _ in 0..120 { publish_frame(frame(pane, 1, false)); }
        assert!(replay(pane).is_empty());
        publish_frame(frame(pane, 2, true));
        publish_frame(frame(pane, 2, false));
        assert_eq!(replay(pane).len(), 2);
        publish_frame(frame(pane, 3, false));
        assert_eq!(replay(pane).len(), 1);
        assert!(!replay(pane)[0].full);
        CACHE.lock().unwrap().remove(pane);
    }

    #[test]
    fn bounded_frame_queue_requests_recovery_instead_of_silent_loss() {
        let pane = "test-frame-overflow";
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        set_frame_sender(Some(tx));
        take_frame_overflow();
        publish_frame(frame(pane, 1, true));
        assert!(rx.try_recv().is_err(), "没有远程订阅时不应发送本地画面");
        RELAY_SUBS.lock().unwrap().insert(pane.into(), 1);
        publish_frame(frame(pane, 1, true));
        publish_frame(frame(pane, 1, false));
        assert!(take_frame_overflow());
        assert!(!take_frame_overflow());
        assert!(rx.try_recv().is_ok());
        set_frame_sender(None);
        RELAY_SUBS.lock().unwrap().remove(pane);
        CACHE.lock().unwrap().remove(pane);
    }
}
