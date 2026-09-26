//! Direct terminal attach over Herdr's client socket.
//!
//! Frame format matches herdr 0.9.1: `[u32 LE length][bincode standard payload]`.
//! Variant indexes are frozen for protocol 22.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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
}

static LINK: Mutex<Option<Link>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(1);

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
pub fn term_attach(app: AppHandle, pane_id: String, cols: u16, rows: u16) -> Result<u64, String> {
    term_detach()?;
    let pane_id = pane_id.trim().to_string();
    if pane_id.is_empty() {
        return Err("没有 pane".into());
    }
    let (cols, rows) = clamp_size(cols, rows);
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
            target: pane_id.clone(),
            takeover: true,
        },
    )?;
    stream.set_read_timeout(None).ok();
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    if GENERATION.load(Ordering::Relaxed) != generation {
        let _ = write_msg(&mut stream, &ClientMessage::Detach);
        return Err("终端接入被打断".into());
    }
    let reader = stream.try_clone().map_err(|err| format!("复制连接失败：{err}"))?;
    {
        let mut link = LINK.lock().map_err(|_| "终端锁失败".to_string())?;
        *link = Some(Link {
            writer: stream,
            generation,
        });
    }
    std::thread::spawn(move || read_loop(app, reader, generation));
    Ok(generation)
}

fn read_loop(app: AppHandle, mut stream: UnixStream, generation: u64) {
    loop {
        if generation_closed(generation) {
            break;
        }
        let payload = match read_frame(&mut stream) {
            Ok(payload) => payload,
            Err(_) => break,
        };
        if generation_closed(generation) {
            break;
        }
        match decode_server(&payload) {
            Ok(ServerMessage::Terminal(frame)) => {
                let _ = app.emit(
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
            Ok(ServerMessage::ServerShutdown { reason }) => {
                let _ = app.emit(
                    "term-closed",
                    reason.unwrap_or_else(|| "Herdr 关闭了终端连接".into()),
                );
                break;
            }
            Ok(_) | Err(_) => {}
        }
    }
    if !generation_closed(generation) {
        let _ = app.emit("term-closed", "终端连接已断开");
    }
}

fn generation_closed(generation: u64) -> bool {
    LINK
        .lock()
        .ok()
        .and_then(|link| link.as_ref().map(|item| item.generation != generation))
        .unwrap_or(true)
}

fn with_writer(op: impl FnOnce(&mut UnixStream) -> Result<(), String>) -> Result<(), String> {
    let mut link = LINK.lock().map_err(|_| "终端锁失败".to_string())?;
    let link = link.as_mut().ok_or("终端未接入")?;
    op(&mut link.writer)
}

#[tauri::command]
pub fn term_scroll(direction: String, lines: u16) -> Result<(), String> {
    let direction = match direction.trim() {
        "up" => AttachScrollDirection::Up,
        "down" => AttachScrollDirection::Down,
        _ => return Err("滚动方向无效".into()),
    };
    let lines = lines.clamp(1, 3);
    with_writer(|stream| {
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
pub fn term_input(bytes_b64: String) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(bytes_b64.trim())
        .map_err(|err| format!("输入无效：{err}"))?;
    if data.is_empty() {
        return Ok(());
    }
    with_writer(|stream| write_msg(stream, &ClientMessage::Input { data }))
}

#[tauri::command]
pub fn term_resize(cols: u16, rows: u16) -> Result<(), String> {
    let (cols, rows) = clamp_size(cols, rows);
    with_writer(|stream| {
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
pub fn term_detach() -> Result<(), String> {
    let mut link = LINK.lock().map_err(|_| "终端锁失败".to_string())?;
    if let Some(mut current) = link.take() {
        let _ = write_msg(&mut current.writer, &ClientMessage::Detach);
        let _ = current.writer.shutdown(std::net::Shutdown::Both);
    }
    Ok(())
}
