//! Outbound channel to a public relay. The phone never talks to Herdr directly.

use std::collections::{HashMap, HashSet};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::herdr_term::{self, RelayFrame};

const DEFAULT_URL: &str = "wss://154.36.168.192:8443/v1/ws";
const DEFAULT_PIN: &str = "38b30e49ecfb8daace9100a133399992bc1a7cdc62954eeaa3a87290881e1507";

static EPOCH: AtomicU64 = AtomicU64::new(1);
static STARTED: OnceLock<()> = OnceLock::new();
static STATE: OnceLock<Mutex<Live>> = OnceLock::new();
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelConfig {
    enabled: bool,
    url: String,
    token: String,
    #[serde(default)]
    pair_token: String,
    #[serde(default)]
    github_session: String,
    #[serde(default)]
    github_login: String,
    #[serde(default)]
    github_name: String,
    pin_sha256: String,
    allow_input: bool,
}

impl Default for ChannelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: DEFAULT_URL.into(),
            token: String::new(),
            pair_token: String::new(),
            github_session: String::new(),
            github_login: String::new(),
            github_name: String::new(),
            pin_sha256: DEFAULT_PIN.into(),
            allow_input: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    enabled: bool,
    url: String,
    token: String,
    pair_token: String,
    pin_sha256: String,
    allow_input: bool,
    connected: bool,
    devices: usize,
    error: Option<String>,
    page_url: String,
    apk_url: String,
    account_name: String,
    github_login: String,
    github_name: String,
    roster: Vec<PairedDevice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStart {
    user_code: String,
    verification_uri: String,
    poll_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PairedDevice {
    id: String,
    name: String,
    online: bool,
}

struct Live {
    connected: bool,
    devices: usize,
    error: Option<String>,
    account_name: String,
    roster: Vec<PairedDevice>,
}

fn live() -> &'static Mutex<Live> {
    STATE.get_or_init(|| {
        Mutex::new(Live {
            connected: false,
            devices: 0,
            error: None,
            account_name: String::new(),
            roster: Vec::new(),
        })
    })
}

fn config_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home)
        .join(".config")
        .join("herdr+")
        .join("channel.json")
}

fn load_config() -> ChannelConfig {
    let path = config_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ChannelConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_config(config: &ChannelConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("无法创建配置目录：{err}"))?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    std::fs::write(path, raw).map_err(|err| format!("无法保存通道配置：{err}"))
}

fn view_of(config: &ChannelConfig) -> ChannelView {
    let live = live().lock().ok();
    ChannelView {
        enabled: config.enabled,
        url: config.url.clone(),
        token: config.token.clone(),
        pair_token: config.pair_token.clone(),
        pin_sha256: config.pin_sha256.clone(),
        allow_input: config.allow_input,
        connected: live.as_ref().map(|item| item.connected).unwrap_or(false),
        devices: live.as_ref().map(|item| item.devices).unwrap_or(0),
        error: live.as_ref().and_then(|item| item.error.clone()),
        page_url: page_url(&config.url, &config.pin_sha256),
        apk_url: apk_url(&config.url, &config.pin_sha256),
        account_name: {
            let live_name = live.as_ref().map(|item| item.account_name.clone()).unwrap_or_default();
            if live_name.is_empty() { config.github_login.clone() } else { live_name }
        },
        github_login: config.github_login.clone(),
        github_name: config.github_name.clone(),
        roster: live.as_ref().map(|item| item.roster.clone()).unwrap_or_default(),
    }
}

pub fn start(app: AppHandle) {
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("herdr-channel".into())
        .spawn(move || run(app))
        .ok();
}

#[tauri::command]
pub fn channel_status() -> ChannelView {
    view_of(&load_config())
}

#[tauri::command]
pub fn channel_save(
    enabled: bool,
    url: String,
    token: String,
    pin_sha256: String,
    allow_input: bool,
) -> Result<ChannelView, String> {
    let url = url.trim().to_string();
    let token = token.trim().to_string();
    validate_url(&url)?;
    if enabled && token.len() < 16 && load_config().github_session.is_empty() {
        return Err("先用 GitHub 登录，或填写主机钥匙".into());
    }
    if !pin_sha256.trim().is_empty() && parse_pin(&pin_sha256).is_none() {
        return Err("证书指纹需要 64 位十六进制".into());
    }
    let mut config = load_config();
    config.enabled = enabled;
    config.url = url;
    config.token = token;
    config.pin_sha256 = pin_sha256.trim().to_string();
    config.allow_input = allow_input;
    save_config(&config)?;
    EPOCH.fetch_add(1, Ordering::Relaxed);
    Ok(view_of(&config))
}

fn run(app: AppHandle) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(128);
    herdr_term::set_frame_sender(Some(frame_tx));
    let mut seen = 0;
    loop {
        let epoch = EPOCH.load(Ordering::Relaxed);
        if epoch != seen {
            seen = epoch;
        }
        let config = load_config();
        if !config.enabled || config.github_session.is_empty() {
            set_live(&app, false, 0, None);
            std::thread::sleep(Duration::from_millis(400));
            continue;
        }
        match session(&app, &config, &frame_rx, epoch) {
            Ok(()) => set_live(&app, false, 0, None),
            Err(err) => set_live(&app, false, 0, Some(err)),
        }
        let wait = if EPOCH.load(Ordering::Relaxed) != epoch { 200 } else { 2000 };
        std::thread::sleep(Duration::from_millis(wait));
    }
}

fn remember_account(msg: &Value) {
    let name = msg.get("accountName").and_then(|value| value.as_str()).unwrap_or("");
    let roster = msg
        .get("devices")
        .and_then(|value| serde_json::from_value::<Vec<PairedDevice>>(value.clone()).ok());
    if let Ok(mut live) = live().lock() {
        if !name.is_empty() {
            live.account_name = name.to_string();
        }
        if let Some(roster) = roster {
            live.devices = roster.iter().filter(|item| item.online).count();
            live.roster = roster;
        }
    }
}

fn set_live(app: &AppHandle, connected: bool, devices: usize, error: Option<String>) {
    if let Ok(mut live) = live().lock() {
        live.connected = connected;
        live.devices = devices;
        live.error = error;
    }
    let view = view_of(&load_config());
    for window in app.webview_windows().into_values() {
        let _ = window.emit("channel-status", &view);
    }
}

fn session(
    app: &AppHandle,
    config: &ChannelConfig,
    frames: &std::sync::mpsc::Receiver<RelayFrame>,
    epoch: u64,
) -> Result<(), String> {
    let mut socket = connect_socket(config)?;
    let mut devices: HashMap<String, HashSet<String>> = HashMap::new();
    let mut device_count = 0;
    set_live(app, true, 0, None);
    send_json(&mut socket, &host_state(config))?;
    send_json(&mut socket, &snapshot_message())?;
    send_json(&mut socket, &herdr_message())?;
    let mut last_push = Instant::now();
    let mut last_sessions = String::new();
    let mut last_herdr = String::new();

    loop {
        if EPOCH.load(Ordering::Relaxed) != epoch {
            let _ = socket.send(tungstenite::Message::Close(None));
            return Ok(());
        }
        while let Ok(frame) = frames.try_recv() {
            send_json(&mut socket, &frame_message(&frame))?;
        }
        if last_push.elapsed() >= Duration::from_millis(1500) {
            last_push = Instant::now();
            let sessions_value = snapshot_message();
            let sessions = serde_json::to_string(&sessions_value).unwrap_or_default();
            if sessions != last_sessions {
                last_sessions = sessions;
                send_json(&mut socket, &sessions_value)?;
            }
            let herdr = serde_json::to_string(&herdr_message()).unwrap_or_default();
            if herdr != last_herdr {
                last_herdr = herdr;
                send_json(&mut socket, &herdr_message())?;
            }
            herdr_term::maintain_relay();
        }
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                    device_count = handle_message(config, &mut socket, &mut devices, device_count, &msg)?;
                    set_live(app, true, device_count, None);
                }
            }
            Ok(tungstenite::Message::Ping(payload)) => {
                socket
                    .send(tungstenite::Message::Pong(payload))
                    .map_err(|err| format!("心跳失败：{err}"))?;
            }
            Ok(tungstenite::Message::Close(_)) => return Err("中继关闭了连接".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == std::io::ErrorKind::WouldBlock || err.kind() == std::io::ErrorKind::TimedOut => {}
            Err(err) => return Err(format!("通道断开：{err}")),
        }
    }
}

fn handle_message(
    config: &ChannelConfig,
    socket: &mut Socket,
    devices: &mut HashMap<String, HashSet<String>>,
    mut device_count: usize,
    msg: &Value,
) -> Result<usize, String> {
    match msg.get("type").and_then(|v| v.as_str()) {
        Some("relay.welcome") => {
            device_count = msg.get("devices").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            remember_account(msg);
        }
        Some("account.devices") => {
            remember_account(msg);
            device_count = live().lock().map(|item| item.devices).unwrap_or(device_count);
        }
        Some("relay.peer") => {
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            match (msg.get("role").and_then(|v| v.as_str()), msg.get("event").and_then(|v| v.as_str())) {
                (Some("device"), Some("join")) => {
                    device_count = device_count.saturating_add(1);
                    send_json(socket, &host_state(config))?;
                    send_json(socket, &snapshot_message())?;
                }
                (Some("device"), Some("leave")) => {
                    device_count = device_count.saturating_sub(1);
                    if let Some(panes) = devices.remove(id) {
                        for pane in panes {
                            herdr_term::relay_unsubscribe(&pane);
                        }
                    }
                }
                _ => {}
            }
        }
        Some("relay.deliver") => {
            let from = msg.get("from").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(payload) = msg.get("payload") {
                handle_device(config, socket, devices, &from, payload)?;
            }
        }
        _ => {}
    }
    Ok(device_count)
}

fn handle_device(
    config: &ChannelConfig,
    socket: &mut Socket,
    devices: &mut HashMap<String, HashSet<String>>,
    from: &str,
    payload: &Value,
) -> Result<(), String> {
    let kind = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let pane = payload.get("paneId").and_then(|v| v.as_str()).unwrap_or("").trim();
    match kind {
        "term.subscribe" => {
            if pane.is_empty() || pane.len() > 80 {
                return Ok(());
            }
            if let Err(err) = herdr_term::relay_subscribe(pane) {
                send_json(socket, &json!({"type":"error","message": err}))?;
                return Ok(());
            }
            devices.entry(from.to_string()).or_default().insert(pane.to_string());
            for frame in replay_or_snapshot(pane) {
                send_json(socket, &frame_message(&frame))?;
            }
        }
        "term.unsubscribe" => {
            devices.get_mut(from).map(|set| set.remove(pane));
            herdr_term::relay_unsubscribe(pane);
        }
        "term.input" => {
            if !config.allow_input {
                send_json(socket, &json!({"type":"error","message":"远程输入已关闭"}))?;
                return Ok(());
            }
            let data = decode_bytes(payload.get("bytes").and_then(|v| v.as_str()).unwrap_or(""))?;
            if data.len() > 64 * 1024 {
                return Ok(());
            }
            if let Err(err) = herdr_term::write_input_pane(pane, data) {
                send_json(socket, &json!({"type":"error","message": err}))?;
            }
        }
        "term.scroll" => {
            let direction = payload.get("direction").and_then(|v| v.as_str()).unwrap_or("down");
            let lines = payload.get("lines").and_then(|v| v.as_u64()).unwrap_or(1) as u16;
            if let Err(err) = herdr_term::write_scroll_pane(pane, direction, lines) {
                send_json(socket, &json!({"type":"error","message": err}))?;
            }
        }
        "prompt" => {
            if !config.allow_input {
                send_json(socket, &json!({"type":"error","message":"远程输入已关闭"}))?;
                return Ok(());
            }
            let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            if text.is_empty() || pane.is_empty() {
                return Ok(());
            }
            if let Err(err) = crate::herdr::prompt_agent(pane, text) {
                send_json(socket, &json!({"type":"error","message": err}))?;
            }
        }
        "ping" => send_json(socket, &json!({"type":"pong"}))?,
        _ => {}
    }
    Ok(())
}

fn replay_or_snapshot(pane: &str) -> Vec<RelayFrame> {
    let frames = herdr_term::replay(pane);
    if frames.first().map(|frame| frame.full).unwrap_or(false) {
        return frames;
    }
    let text = crate::herdr::read_pane(pane).unwrap_or_default();
    if text.is_empty() {
        return frames;
    }
    let (width, height) = frames
        .last()
        .map(|frame| (frame.width, frame.height))
        .unwrap_or((100, 32));
    let mut out = vec![RelayFrame {
        seq: 0,
        pane_id: pane.to_string(),
        generation: 0,
        full: true,
        width,
        height,
        bytes: text.into_bytes(),
    }];
    out.extend(frames);
    out
}

fn snapshot_message() -> Value {
    json!({
        "type": "sessions",
        "items": crate::session_snapshot(),
    })
}

fn herdr_message() -> Value {
    let status = crate::herdr::status();
    json!({
        "type": "herdr",
        "connected": status.connected,
        "agentCount": status.agent_count,
        "error": status.error,
    })
}

fn host_state(config: &ChannelConfig) -> Value {
    json!({
        "type": "host.state",
        "allowInput": config.allow_input,
        "name": "herdr+",
    })
}

fn frame_message(frame: &RelayFrame) -> Value {
    json!({
        "type": "term.frame",
        "paneId": frame.pane_id,
        "seq": frame.seq,
        "generation": frame.generation,
        "full": frame.full,
        "width": frame.width,
        "height": frame.height,
        "bytes": base64::engine::general_purpose::STANDARD.encode(&frame.bytes),
    })
}

fn decode_bytes(raw: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|err| format!("输入无效：{err}"))
}

type Socket = tungstenite::WebSocket<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;

fn send_json(socket: &mut Socket, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|err| err.to_string())?;
    socket
        .send(tungstenite::Message::Text(text.into()))
        .map_err(|err| format!("发送失败：{err}"))
}

fn connect_socket(config: &ChannelConfig) -> Result<Socket, String> {
    let parts = parse_ws_url(&config.url)?;
    let pin = if config.pin_sha256.trim().is_empty() {
        None
    } else {
        Some(parse_pin(&config.pin_sha256).ok_or("证书指纹无效")?)
    };
    let addr = format!("{}:{}", parts.host, parts.port)
        .to_socket_addrs()
        .map_err(|err| format!("无法解析中继：{err}"))?
        .next()
        .ok_or("无法解析中继")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8)).map_err(|err| format!("连接中继失败：{err}"))?;
    tcp.set_nodelay(true).ok();
    // 握手需要等待公网往返，短读超时只用于连接后的转发轮询。
    tcp.set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|err| format!("设置握手读超时失败：{err}"))?;
    tcp.set_write_timeout(Some(Duration::from_secs(10))).ok();
    let tls_config = tls_config(pin)?;
    let name = server_name(&parts.host)?;
    let conn = rustls::ClientConnection::new(Arc::new(tls_config), name).map_err(|err| format!("TLS 初始化失败：{err}"))?;
    let tls = rustls::StreamOwned::new(conn, tcp);
    let request = ws_url(config, &parts).into_client_request().map_err(|err| format!("通道地址无效：{err}"))?;
    let (socket, response) = tungstenite::client::client(request, tls).map_err(|err| format!("WebSocket 失败：{err}"))?;
    if response.status().as_u16() != 101 {
        return Err(format!("中继拒绝连接：HTTP {}", response.status()));
    }
    socket.get_ref().sock.set_read_timeout(Some(Duration::from_millis(20)))
        .map_err(|err| format!("设置通道读超时失败：{err}"))?;
    Ok(socket)
}

fn tls_config(pin: Option<[u8; 32]>) -> Result<rustls::ClientConfig, String> {
    if let Some(pin) = pin {
        return Ok(rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinVerifier { pin }))
            .with_no_client_auth());
    }
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Ok(rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth())
}

fn server_name(host: &str) -> Result<rustls::pki_types::ServerName<'static>, String> {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Ok(rustls::pki_types::ServerName::IpAddress(ip.into()));
    }
    rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|err| format!("主机名无效：{err}"))
}

#[derive(Debug)]
struct PinVerifier {
    pin: [u8; 32],
}

impl rustls::client::danger::ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        if digest.as_slice() == self.pin {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "证书指纹不匹配：{}",
                hex_encode(digest.as_slice())
            )))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

struct WsParts {
    host: String,
    port: u16,
    path: String,
}

fn parse_ws_url(url: &str) -> Result<WsParts, String> {
    let (secure, rest) = if let Some(rest) = url.strip_prefix("wss://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("ws://") {
        (false, rest)
    } else {
        return Err("通道地址需要 wss://".into());
    };
    if !secure && !(rest.starts_with("127.0.0.1") || rest.starts_with("localhost")) {
        return Err("公网通道必须使用 wss://".into());
    }
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let authority = authority.split('?').next().unwrap_or(authority);
    let (host, port) = if let Some(host) = authority.strip_prefix('[') {
        let (host, port) = host.split_once("]:").ok_or("IPv6 地址无效")?;
        (host.to_string(), port.parse::<u16>().map_err(|_| "端口无效".to_string())?)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if host.contains(':') {
            (authority.to_string(), if secure { 443 } else { 80 })
        } else {
            (host.to_string(), port.parse::<u16>().map_err(|_| "端口无效".to_string())?)
        }
    } else {
        (authority.to_string(), if secure { 443 } else { 80 })
    };
    if host.is_empty() {
        return Err("通道地址缺少主机".into());
    }
    let path = if path.is_empty() { "/v1/ws".into() } else { format!("/{path}") };
    let path = path.split('?').next().unwrap_or(&path).to_string();
    Ok(WsParts { host, port, path })
}

fn computer_name() -> String {
    if let Ok(output) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "Mac".into())
}

fn machine_id() -> String {
    let raw = computer_name();
    let mut id = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_matches('-').chars().take(40).collect::<String>().if_empty("mac")
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}
impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() { fallback.to_string() } else { self }
    }
}

fn ws_url(config: &ChannelConfig, parts: &WsParts) -> String {
    let scheme = if config.url.starts_with("wss://") { "wss" } else { "ws" };
    if !config.github_session.is_empty() {
        return format!(
            "{scheme}://{}:{}{}?session={}&mac={}&name={}",
            parts.host,
            parts.port,
            parts.path,
            config.github_session,
            encode(&machine_id()),
            encode(&computer_name())
        );
    }
    format!(
        "{scheme}://{}:{}{}?role=host&token={}&name=herdr-plus&client=host",
        parts.host,
        parts.port,
        parts.path,
        config.token
    )
}

fn https_json(config: &ChannelConfig, path: &str, body: &Value) -> Result<Value, String> {
    let parts = parse_ws_url(&config.url)?;
    let pin = if config.pin_sha256.trim().is_empty() {
        None
    } else {
        Some(parse_pin(&config.pin_sha256).ok_or("证书指纹无效")?)
    };
    let client = reqwest::blocking::Client::builder()
        .use_preconfigured_tls(tls_config(pin)?)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("HTTP 初始化失败：{err}"))?;
    let scheme = if config.url.starts_with("wss://") { "https" } else { "http" };
    let url = format!("{scheme}://{}:{}{path}", parts.host, parts.port);
    let response = client
        .post(url)
        .json(body)
        .send()
        .map_err(|err| format!("无法连接登录服务：{err}"))?;
    let status = response.status();
    let text = response.text().map_err(|err| format!("登录响应无效：{err}"))?;
    let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"message": text}));
    if !status.is_success() {
        return Err(value
            .get("message")
            .and_then(|item| item.as_str())
            .unwrap_or("GitHub 登录失败")
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
pub fn channel_github_logout() -> Result<(), String> {
    let mut saved = load_config();
    saved.github_session.clear();
    saved.github_login.clear();
    saved.github_name.clear();
    saved.enabled = false;
    save_config(&saved)?;
    EPOCH.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn channel_github_start(app: AppHandle) -> Result<GitHubStart, String> {
    let config = load_config();
    let started = https_json(&config, "/v1/auth/github/device", &json!({"client": "desktop"}))?;
    let verification_uri = started
        .get("authorizeUrl")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    let poll_id = started.get("pollId").and_then(|item| item.as_str()).unwrap_or("").to_string();
    if verification_uri.is_empty() || poll_id.is_empty() {
        return Err(started
            .get("message")
            .and_then(|item| item.as_str())
            .unwrap_or("GitHub 登录没有开始")
            .to_string());
    }
    let interval = started.get("interval").and_then(|item| item.as_u64()).unwrap_or(5).max(2);
    let started_id = poll_id.clone();
    std::thread::spawn(move || poll_github(app, started_id, interval));
    Ok(GitHubStart {
        user_code: String::new(),
        verification_uri,
        poll_id,
    })
}

fn poll_github(app: AppHandle, poll_id: String, interval: u64) {
    for _ in 0..40 {
        std::thread::sleep(Duration::from_secs(interval));
        let config = load_config();
        let value = match https_json(&config, "/v1/auth/github/poll", &json!({"pollId": poll_id})) {
            Ok(value) => value,
            Err(err) => {
                let _ = app.emit("github-login", json!({"error": err}));
                return;
            }
        };
        if value.get("pending").and_then(|item| item.as_bool()).unwrap_or(false) {
            continue;
        }
        let session = value.get("session").and_then(|item| item.as_str()).unwrap_or("");
        if session.is_empty() {
            let message = value.get("message").and_then(|item| item.as_str()).unwrap_or("登录失败");
            let _ = app.emit("github-login", json!({"error": message}));
            return;
        }
        let mut saved = load_config();
        saved.github_session = session.to_string();
        saved.github_login = value.get("login").and_then(|item| item.as_str()).unwrap_or("").to_string();
        saved.github_name = value.get("name").and_then(|item| item.as_str()).unwrap_or("").to_string();
        saved.enabled = true;
        let _ = save_config(&saved);
        EPOCH.fetch_add(1, Ordering::Relaxed);
        let _ = app.emit("github-login", json!({"login": saved.github_login, "name": saved.github_name}));
        return;
    }
    let _ = app.emit("github-login", json!({"error": "GitHub 登录超时"}));
}

fn validate_url(url: &str) -> Result<(), String> {
    parse_ws_url(url).map(|_| ())
}

fn page_url(ws_url: &str, pin: &str) -> String {
    let Ok(parts) = parse_ws_url(ws_url) else {
        return String::new();
    };
    let scheme = if ws_url.starts_with("wss://") { "https" } else { "http" };
    format!("{scheme}://{}:{}/#pin={}", parts.host, parts.port, encode(pin))
}

fn apk_url(ws_url: &str, pin: &str) -> String {
    format!("herdrplus://connect?url={}&pin={}", encode(ws_url), encode(pin))
}

fn encode(raw: &str) -> String {
    let mut out = String::new();
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn parse_pin(raw: &str) -> Option<[u8; 32]> {
    let raw: String = raw.chars().filter(|ch| *ch != ':' && !ch.is_whitespace()).collect();
    if raw.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

use tungstenite::client::IntoClientRequest;

#[cfg(test)]
mod tests {
    use super::*;

    fn check_local_relay(tls_delay: Duration, websocket_delay: Duration, reject_first: bool) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        // 夹具证书和私钥仅用于回环连接，不用于任何真实服务。
        let cert = include_bytes!("testdata/channel-cert.der").to_vec();
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(include_bytes!("testdata/channel-key.der").to_vec());
        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone().into()], key.into())
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let config = ChannelConfig {
            url: format!("wss://{}/v1/ws", listener.local_addr().unwrap()),
            pin_sha256: hex_encode(&Sha256::digest(&cert)),
            ..ChannelConfig::default()
        };
        let server = std::thread::spawn(move || {
            if reject_first {
                drop(listener.accept().unwrap());
            }
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            std::thread::sleep(tls_delay);
            let conn = rustls::ServerConnection::new(Arc::new(server_config)).unwrap();
            let mut tls = rustls::StreamOwned::new(conn, tcp);
            while tls.conn.is_handshaking() {
                tls.conn.complete_io(&mut tls.sock).unwrap();
            }
            std::thread::sleep(websocket_delay);
            let mut socket = tungstenite::accept(tls).unwrap();
            let message = socket.read().unwrap();
            socket.send(message).unwrap();
        });

        if reject_first {
            let error = connect_socket(&config).err().expect("首次握手应失败");
            assert!(error.starts_with("WebSocket 失败："), "{error}");
        }
        let result = connect_socket(&config);
        if result.is_err() {
            let _ = server.join();
            panic!("本地中转握手失败：{}", result.err().unwrap());
        }
        let mut socket = result.unwrap();
        let started = Instant::now();
        assert!(matches!(socket.read(), Err(tungstenite::Error::Io(err))
            if matches!(err.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)));
        assert!(started.elapsed() < Duration::from_millis(500), "握手完成后应恢复短轮询");
        // 已验证空闲读取及时返回，回送验证使用宽松期限以避免调度抖动。
        socket.get_ref().sock.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        socket.send(tungstenite::Message::Text("probe".into())).unwrap();
        assert_eq!(socket.read().unwrap().into_text().unwrap(), "probe");
        server.join().unwrap();
    }

    #[test]
    fn connects_after_slow_tls_handshake() {
        check_local_relay(Duration::from_millis(100), Duration::ZERO, false);
    }

    #[test]
    fn connects_after_slow_websocket_handshake() {
        check_local_relay(Duration::ZERO, Duration::from_millis(100), false);
    }

    #[test]
    fn reconnects_after_failed_handshake() {
        check_local_relay(Duration::ZERO, Duration::ZERO, true);
    }

    #[test]
    fn parses_public_wss() {
        let parts = parse_ws_url(DEFAULT_URL).unwrap();
        assert_eq!(parts.host, "154.36.168.192");
        assert_eq!(parts.port, 8443);
        assert_eq!(parts.path, "/v1/ws");
        assert!(parse_pin(DEFAULT_PIN).is_some());
        assert!(parse_ws_url("ws://154.36.168.192:8443/v1/ws").is_err());
    }
}
