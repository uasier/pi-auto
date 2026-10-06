const DEFAULT_URL = "wss://154.36.168.192:8443/v1/ws";
const DEFAULT_PIN = "38b30e49ecfb8daace9100a133399992bc1a7cdc62954eeaa3a87290881e1507";
const STORE = "herdr-plus-remote";
let githubPoll = 0;
let selectedMac = "";
let selectedMacName = "";
let pendingMac = "";
let pendingTimer = 0;
let macs = [];
let socketGen = 0;
const STATE_LABEL = { idle: "空闲", done: "完成", working: "执行中", blocked: "等待确认", unknown: "未知" };

const $ = (id) => document.getElementById(id);
const native = () => window.NativeRelay;

let ws = null;
let usingNative = false;
let sessions = [];
let current = "";
let term = null;
let lastSeq = 0;
let reconnectTimer = 0;
let wantConnect = false;
let filter = "all";
let liveTimer = 0;
const link = { socket: "off", host: false, input: false, herdr: true, herdrError: "" };
const seen = new Map();
const entered = new Set();

function defaultURL() {
  if (location.protocol === "https:" || location.protocol === "http:") {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/v1/ws`;
  }
  return DEFAULT_URL;
}

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
}

function loadSettings() {
  const saved = readStore();
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const pin = hash.get("pin") || saved.pin || DEFAULT_PIN;
  const url = hash.get("url") || saved.url || defaultURL();
  const session = hash.get("session") || saved.session || "";
  const login = hash.get("login") || saved.login || "";
  $("server-url").value = url;
  $("pin").value = pin;
  paintAccount(login);
  if (hash.has("url") || hash.has("pin") || hash.has("session") || hash.has("login")) {
    localStorage.setItem(STORE, JSON.stringify({ url, pin, session, login }));
    history.replaceState(null, "", location.pathname + location.search);
  }
  return { url, pin, session, login };
}

function saveSettings() {
  const previous = readStore();
  const data = {
    url: $("server-url").value.trim(),
    pin: $("pin").value.trim(),
    session: previous.session || "",
    login: previous.login || "",
  };
  localStorage.setItem(STORE, JSON.stringify(data));
  return data;
}

function saveSession(session, login) {
  const data = saveSettings();
  data.session = session || "";
  data.login = login || "";
  localStorage.setItem(STORE, JSON.stringify(data));
  paintAccount(login);
}

function monogram(name) {
  const text = String(name || "").trim();
  return text ? text.slice(0, 1).toUpperCase() : "?";
}

function paintAccount(login) {
  const stored = readStore();
  const name = login || stored.login || "";
  const loggedIn = Boolean(stored.session && name);
  document.body.dataset.account = loggedIn ? "in" : "out";
  $("account-line").textContent = loggedIn ? "已登录" : "和电脑使用同一个 GitHub 账号";
  $("settings-title").textContent = loggedIn ? name : "登录";
  $("account-avatar").textContent = monogram(name);
  $("settings-btn").querySelector("i").textContent = monogram(loggedIn ? name : "");
  $("settings-btn").querySelector("span").textContent = loggedIn ? name : "登录";
  $("account-login").classList.toggle("hidden", loggedIn);
  $("account-logout").classList.toggle("hidden", !loggedIn);
  paintGate();
}

function paintGate() {
  const count = macs.length;
  const entering = macs.find((item) => item.id === pendingMac);
  const current = macs.find((item) => item.id === selectedMac);
  const state = entering ? "entering" : count ? "devices" : "empty";
  $("picker-sheet").dataset.state = state;
  $("picker-title").textContent = entering ? (entering.name || "Mac") : count ? "选择 Mac" : "没有在线设备";
  $("picker-lead").textContent = entering
    ? "正在进入这台 Mac"
    : count
      ? "点一台进入对话"
      : "在电脑上打开通道，登录并上线";
  const label = current?.name || selectedMacName || "设备";
  $("mac-back").querySelector("span").textContent = selectedMac ? label : "设备";
  $("mac-back").querySelector("i").textContent = selectedMac ? monogram(label) : "";
}

function toast(text, bad = false) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  $("toasts").append(el);
  window.setTimeout(() => el.remove(), 3400);
}

function setStatus(text, state) {
  $("status").textContent = text;
  $("status-pill").dataset.state = state;
  const phone = $("phone-status");
  if (phone) phone.textContent = text;
}

function renderStatus() {
  if (link.socket === "off") return setStatus("未连接", "off");
  if (link.socket === "connecting") return setStatus("正在连接", "wait");
  if (link.socket === "reconnecting") return setStatus("断开，正在重连", "wait");
  if (!link.host && !selectedMac) return setStatus("已登录，请选择一台 Mac", "wait");
  if (selectedMac && !sessions.length) return setStatus("正在读取这台 Mac 的会话", "wait");
  if (!link.herdr) return setStatus(link.herdrError || "电脑上的 Herdr 未连接", "bad");
  const summary = sessionSummary();
  if (!link.input) return setStatus(summary ? `只读 · ${summary}` : "只读", "mute");
  setStatus(summary || "可输入", "live");
}

function sessionSummary() {
  const count = (name) => sessions.filter((item) => item.agentState === name).length;
  const parts = [];
  if (count("working")) parts.push(`${count("working")} 执行中`);
  if (count("blocked")) parts.push(`${count("blocked")} 等待确认`);
  const idle = count("idle") + count("done");
  if (idle) parts.push(`${idle} 空闲`);
  return parts.join(" · ");
}

function b64ToBytes(payload) {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function ensureTerm() {
  if (term) return term;
  term = new Terminal({
    convertEol: false,
    fontFamily: '"SF Mono", Menlo, "PingFang SC", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: "#07080b",
      foreground: "#d5dbe4",
      cursor: "#d7dee8",
      selectionBackground: "#314055",
    },
    cursorBlink: !native(),
    scrollback: native() ? 400 : 3000,
  });
  term.open($("term-scale"));
  new ResizeObserver(() => scheduleFit()).observe($("term"));
  term.onData((data) => {
    if (!link.input || !current || !data) return;
    send({ type: "term.input", paneId: current, bytes: textToB64(data) });
  });
  const area = term.textarea;
  if (area) {
    area.setAttribute("enterkeyhint", "send");
    area.setAttribute("autocomplete", "off");
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("autocorrect", "off");
    area.setAttribute("spellcheck", "false");
  }
  let tap = null;
  term.element?.addEventListener("pointerdown", (event) => {
    tap = { x: event.clientX, y: event.clientY, t: Date.now() };
  });
  term.element?.addEventListener("pointerup", (event) => {
    if (!tap) return;
    const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
    if (moved < 8 && Date.now() - tap.t < 350) term.focus();
    tap = null;
  });
  term.element?.addEventListener("pointercancel", () => { tap = null; });
  return term;
}

let fitKey = "";
let fitQueued = false;

function scheduleFit() {
  fitKey = "";
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitFont();
  });
}

function fitFont() {
  if (!term) return;
  const host = $("term");
  const box = $("term-scale");
  const screen = box?.querySelector(".xterm-screen") || term.element;
  const canvas = screen?.querySelector("canvas");
  if (!host || !box || !screen) return;
  const availW = Math.max(host.clientWidth - 8, 1);
  const availH = Math.max(host.clientHeight - 8, 1);
  const cols = Math.max(term.cols || 80, 1);
  const rows = Math.max(term.rows || 24, 1);
  const font = Math.max(6, Math.min(14, Math.floor(Math.min(availW / (cols * 0.62), availH / (rows * 1.5)))));
  if (term.options.fontSize !== font) {
    term.options.fontSize = font;
    fitKey = "";
    scheduleFit();
    return;
  }
  const needW = Math.max(canvas?.offsetWidth || 0, screen.offsetWidth || 0, 1);
  const needH = Math.max(canvas?.offsetHeight || 0, screen.offsetHeight || 0, 1);
  const key = `${availW}x${availH}:${needW}x${needH}`;
  if (key === fitKey) return;
  fitKey = key;
  const rowH = Math.max(needH / rows, font * 1.5, 1);
  const scale = Math.min((availW - 4) / needW, (availH - 4) / (needH + rowH * 0.5), 1);
  const safe = Math.floor((Number.isFinite(scale) && scale > 0 ? scale : 1) * 1000) / 1000;
  box.style.transformOrigin = "top left";
  box.style.transform = `scale(${safe})`;
}

function fitViewport() {
  const view = window.visualViewport;
  const app = document.querySelector(".app");
  const keyboard = view && window.innerHeight - view.height > 140;
  document.body.classList.toggle("keyboard", Boolean(keyboard) || document.body.classList.contains("native") && view && view.height < window.innerHeight - 80);
  if (!view || !app || native()) {
    if (app) {
      app.style.height = "";
      app.style.transform = "";
    }
    fitFont();
    return;
  }
  app.style.height = `${view.height}px`;
  app.style.transform = `translateY(${view.offsetTop}px)`;
  fitFont();
}

function pageLines() {
  return Math.max(8, Math.min(24, (term?.rows || 16) - 2));
}

function scrollHistory(direction, lines) {
  if (!current) return;
  let left = Math.max(1, Math.min(48, lines | 0));
  const step = () => {
    if (!current || left <= 0) return;
    const count = Math.min(3, left);
    send({ type: "term.scroll", paneId: current, direction, lines: count });
    left -= count;
    if (left > 0) window.setTimeout(step, 35);
  };
  step();
}

function shortPath(path) {
  if (!path) return "";
  const parts = String(path).split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function matches(item) {
  if (filter === "all") return true;
  if (filter === "idle") return item.agentState === "idle" || item.agentState === "done";
  return item.agentState === filter;
}

let sessionSig = "";

function renderSessions() {
  const host = $("sessions");
  const visible = sessions.filter(matches);
  const sig = `${filter}|${current}|` + visible.map((item) => `${item.paneId}:${item.agentState}:${item.title}`).join(";");
  if (sig === sessionSig) return;
  sessionSig = sig;
  host.replaceChildren();
  $("session-count").textContent = String(sessions.length);
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = sessions.length ? "这个筛选下没有会话" : selectedMac ? "正在读取这台 Mac 的会话" : "先选择一台已登录的 Mac";
    host.append(empty);
    paintStage();
    return;
  }
  for (const item of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session" + (entered.has("s:" + item.paneId) ? "" : " rise") + (item.paneId === current ? " on" : "");
    entered.add("s:" + item.paneId);
    button.dataset.agent = item.agent || "shell";
    button.dataset.state = item.agentState || "unknown";
    const bar = document.createElement("i");
    bar.className = "bar";
    const copy = document.createElement("span");
    copy.className = "copy";
    const title = document.createElement("b");
    title.textContent = item.title || item.paneId;
    const agent = document.createElement("span");
    agent.className = "agent";
    agent.textContent = item.agentLabel || item.agent || "终端";
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = shortPath(item.cwd);
    copy.append(title, agent);
    if (path.textContent) copy.append(path);
    const state = document.createElement("span");
    state.className = "state";
    state.textContent = STATE_LABEL[item.agentState] || item.agentState || "未知";
    button.append(bar, copy, state);
    button.addEventListener("click", () => selectPane(item.paneId));
    host.append(button);
  }
  paintStage();
}

function paintStage() {
  const item = sessions.find((entry) => entry.paneId === current);
  const empty = $("term-empty");
  if (!item) {
    $("pane-kicker").textContent = selectedMac ? "已选择" : "未选择";
    $("pane-title").textContent = selectedMac ? "正在读取会话" : "选择一台 Mac";
    $("pane-meta").textContent = selectedMac ? "已连上这台 Mac，正在等待 Herdr 会话" : "登录后从列表选择一台已转发的 Mac";
    $("pane-state").textContent = selectedMac ? "读取中" : "待选择";
    $("pane-state").dataset.state = "unknown";
    empty.classList.remove("hidden");
    empty.querySelector("strong").textContent = selectedMac ? "正在读取" : "还没有画面";
    paintPhone(selectedMac ? "正在读取会话" : "选择会话", selectedMac ? "等待这台 Mac 的画面" : "点这里或底部会话", "unknown");
    return;
  }
  empty.classList.add("hidden");
  $("pane-kicker").textContent = item.agentLabel || "终端";
  $("pane-title").textContent = item.title || item.paneId;
  $("pane-meta").textContent = item.cwd || item.reason || item.paneId;
  $("pane-state").textContent = STATE_LABEL[item.agentState] || item.agentState || "未知";
  $("pane-state").dataset.state = item.agentState || "unknown";
  $("term-project").textContent = shortPath(item.cwd) || item.title || "";
  paintPhone(item.title || item.paneId, item.agentLabel || STATE_LABEL[item.agentState] || "终端", item.agentState || "unknown");
  if (link.input) ensureTerm().focus();
}

function paintPhone(title, sub, state) {
  const name = $("phone-title");
  if (!name) return;
  name.textContent = title;
  $("phone-sub").textContent = sub;
  $("phone-dot").dataset.state = state || "unknown";
}

function noteStates() {
  if (native()) return;
  if (Notification.permission !== "granted") {
    sessions.forEach((item) => seen.set(item.paneId, item.agentState));
    return;
  }
  for (const item of sessions) {
    const prev = seen.get(item.paneId);
    seen.set(item.paneId, item.agentState);
    if (!prev || prev === item.agentState) continue;
    const title = item.title || item.paneId;
    if (item.agentState === "idle" || item.agentState === "done") {
      new Notification(`${title} 空闲`, { body: "可以发下一句", tag: item.paneId });
    } else if (item.agentState === "blocked") {
      new Notification(`${title} 等待确认`, { body: "终端停在确认上", tag: item.paneId });
    }
  }
}

function selectPane(paneId) {
  if (!paneId) return;
  if (current && current !== paneId) send({ type: "term.unsubscribe", paneId: current });
  current = paneId;
  lastSeq = 0;
  ensureTerm().reset();
  send({ type: "term.subscribe", paneId });
  renderSessions();
  document.body.classList.remove("sessions-open");
  $("nav-sessions")?.classList.remove("on");
  ensureTerm().focus();
  fitFont();
}

function send(obj) {
  const text = JSON.stringify(obj);
  if (usingNative && native()) {
    native().send(text);
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
}

function pulse() {
  if (window.matchMedia("(max-width: 860px)").matches) return;
  const mark = $("live-mark");
  mark.classList.add("on");
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => mark.classList.remove("on"), 700);
}

function onFrame(msg) {
  if (msg.paneId !== current) return;
  if (typeof msg.seq === "number" && msg.seq > 0 && msg.seq <= lastSeq) return;
  if (typeof msg.seq === "number" && msg.seq > 0) lastSeq = msg.seq;
  const view = ensureTerm();
  if (msg.width && msg.height && (view.cols !== msg.width || view.rows !== msg.height)) {
    view.resize(msg.width, msg.height);
    scheduleFit();
  }
  if (msg.bytes) {
    view.write(b64ToBytes(msg.bytes));
    pulse();
  }
}

function onMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === "relay.welcome") {
    link.socket = "live";
    link.host = false;
    if (msg.accountName) paintAccount(msg.accountName);
    if (msg.macs) offerMacs(msg.macs);
    if (!selectedMac) showPicker();
    setStatus(msg.login ? msg.login : "已登录", "wait");
    return;
  }
  if (msg.type === "macs") {
    offerMacs(msg.items || []);
    return;
  }
  if (msg.type === "mac.selected") {
    selectedMac = msg.id || "";
    selectedMacName = msg.name || selectedMacName;
    pendingMac = "";
    window.clearTimeout(pendingTimer);
    if (selectedMac) localStorage.setItem("herdr-plus-last-mac", selectedMac);
    link.host = true;
    sessions = [];
    current = "";
    $("pane-title").textContent = msg.name || "Mac";
    $("pane-kicker").textContent = msg.name || "Mac";
    $("pane-meta").textContent = "正在读取会话";
    hidePicker();
    renderSessions();
    paintGate();
    setStatus(msg.name || "已连接", "live");
    return;
  }
  if (msg.type === "mac.offline" || msg.type === "mac.left") {
    if (msg.type === "mac.offline") localStorage.removeItem("herdr-plus-last-mac");
    selectedMac = "";
    selectedMacName = "";
    pendingMac = "";
    link.host = false;
    sessions = [];
    current = "";
    showPicker();
    renderSessions();
    if (msg.type === "mac.offline") toast("这台 Mac 已离线", true);
    return;
  }
  if (msg.type === "relay.peer" && msg.role === "host") {
    link.host = msg.event === "join";
    if (!link.host) {
      sessions = [];
      toast("电脑已断开", true);
    } else toast("电脑已上线");
    renderSessions();
    renderStatus();
    return;
  }
  if (msg.type === "host.state") {
    link.input = !!msg.allowInput;
    renderStatus();
    paintStage();
    return;
  }
  if (msg.type === "herdr") {
    link.herdr = msg.connected !== false;
    link.herdrError = msg.error || "";
    renderStatus();
    return;
  }
  if (msg.type === "sessions") {
    sessions = msg.items || [];
    if (current && !sessions.some((item) => item.paneId === current)) current = "";
    noteStates();
    renderSessions();
    renderStatus();
    return;
  }
  if (msg.type === "term.frame") onFrame(msg);
  if (msg.type === "term.close" && msg.paneId === current) toast(msg.reason || "终端断开", true);
  if (msg.type === "error") {
    if (String(msg.message || "").includes("主机钥匙")) return;
    toast(msg.message || "错误", true);
    setStatus(msg.message || "错误", "bad");
  }
}

function httpBase(url) {
  return url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/v1\/ws.*$/, "");
}

async function connect() {
  const cfg = saveSettings();
  if (!cfg.url || !cfg.session) {
    setStatus("请用 GitHub 登录", "off");
    showAccount();
    return;
  }
  if (!/^wss:\/\//.test(cfg.url) && !/^ws:\/\/(127\.0\.0\.1|localhost)/.test(cfg.url)) {
    setStatus("公网地址必须是 wss://", "bad");
    return;
  }
  wantConnect = true;
  clearTimeout(reconnectTimer);
  link.socket = "connecting";
  renderStatus();
  openChannel(cfg, `session=${encodeURIComponent(cfg.session)}`);
}

function openChannel(cfg, query) {
  if (native()) {
    usingNative = true;
    native().connect(cfg.url, "", cfg.pin || DEFAULT_PIN, cfg.session || "");
    $("settings").classList.add("hidden");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN && ws.__query === query) {
    if (selectedMac) send({ type: "mac.select", id: selectedMac });
    return;
  }
  clearTimeout(reconnectTimer);
  const gen = ++socketGen;
  if (ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    old.close();
  }
  const join = cfg.url.includes("?") ? "&" : "?";
  const url = `${cfg.url}${join}${query}`;
  const socket = new WebSocket(url);
  socket.__query = query;
  ws = socket;
  socket.onopen = () => {
    if (gen !== socketGen) return;
    link.socket = "live";
    renderStatus();
    $("settings").classList.add("hidden");
    if (selectedMac) send({ type: "mac.select", id: selectedMac });
    else if (current) send({ type: "term.subscribe", paneId: current });
  };
  socket.onmessage = (event) => onMessage(String(event.data));
  socket.onerror = () => {
    if (gen !== socketGen) return;
    setStatus("连接失败，浏览器需先信任证书", "bad");
  };
  socket.onclose = () => {
    if (gen !== socketGen) return;
    ws = null;
    if (!wantConnect) {
      link.socket = "off";
      renderStatus();
      return;
    }
    link.socket = "reconnecting";
    renderStatus();
    reconnectTimer = window.setTimeout(connect, 2000);
  };
}

function disconnect() {
  wantConnect = false;
  clearTimeout(reconnectTimer);
  link.socket = "off";
  link.host = false;
  if (usingNative && native()) native().disconnect();
  if (ws) ws.close();
  ws = null;
  renderStatus();
  toast("已断开");
}

function notifyState() {
  const node = $("notify-state");
  if (native() && native().notificationState) {
    const state = native().notificationState();
    node.textContent = state === "granted" ? "系统通知已开启。空闲和断线会在通知栏响。" : "通知还没开。退到后台就看不到空闲提醒。";
    $("notify-btn").textContent = state === "granted" ? "通知已开启" : "开启通知";
    return;
  }
  if (!("Notification" in window)) {
    node.textContent = "这个环境没有系统通知。";
    return;
  }
  node.textContent = Notification.permission === "granted"
    ? "浏览器通知已开启。页面在后台时，空闲和等待确认会提醒。"
    : "浏览器需要授权后，才能在后台提醒。";
  $("notify-btn").textContent = Notification.permission === "granted" ? "通知已开启" : "开启通知";
}

async function enableNotify() {
  if (native() && native().requestNotifications) {
    native().requestNotifications();
    window.setTimeout(notifyState, 600);
    return;
  }
  if (!("Notification" in window)) {
    toast("当前环境不能发系统通知", true);
    return;
  }
  const result = await Notification.requestPermission();
  notifyState();
  toast(result === "granted" ? "通知已开启" : "没有获得通知权限", result !== "granted");
}

window.__relay = {
  onMessage,
  applyConfig(url, _token, pin) {
    if (url) $("server-url").value = url;
    if (pin) $("pin").value = pin;
    connect();
  },
  openPane(id) { selectPane(id); },
  onB64(payload) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    onMessage(new TextDecoder().decode(bytes));
  },
  onStatus(text) {
    setStatus(text, "wait");
    toast(text);
  },
  refreshNotify: notifyState,
  refit: fitViewport,
};

const termFrame = document.querySelector(".term-frame");
termFrame.addEventListener("wheel", (event) => {
  if (!current) return;
  const sign = Math.sign(event.deltaY);
  if (!sign) return;
  event.preventDefault();
  const lines = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
    ? 3
    : Math.min(3, Math.max(1, Math.round(Math.abs(event.deltaY) / 48)));
  scrollHistory(sign < 0 ? "up" : "down", lines);
}, { capture: true, passive: false });

let touchY = 0;
let touchX = 0;
termFrame.addEventListener("touchstart", (event) => {
  touchY = event.changedTouches[0].clientY;
  touchX = event.changedTouches[0].clientX;
}, { passive: true });
termFrame.addEventListener("touchmove", (event) => {
  if (!current) return;
  const point = event.changedTouches[0];
  const dy = point.clientY - touchY;
  const dx = point.clientX - touchX;
  if (Math.abs(dy) < 28 || Math.abs(dy) < Math.abs(dx)) return;
  event.preventDefault();
  scrollHistory(dy > 0 ? "up" : "down", 3);
  touchY = point.clientY;
  touchX = point.clientX;
}, { capture: true, passive: false });

window.addEventListener("keydown", (event) => {
  if (event.target.closest("input, textarea")) return;
  if (event.key === "PageUp") {
    event.preventDefault();
    scrollHistory("up", pageLines());
  } else if (event.key === "PageDown") {
    event.preventDefault();
    scrollHistory("down", pageLines());
  }
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("on", item === button));
    renderSessions();
  });
});

$("settings-btn").addEventListener("click", () => {
  $("settings").classList.remove("hidden");
  notifyState();
});
$("settings-close").addEventListener("click", () => $("settings").classList.add("hidden"));
$("settings").addEventListener("click", (event) => {
  if (event.target === $("settings")) $("settings").classList.add("hidden");
});
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});
async function api(path, body) {
  const cfg = saveSettings();
  if (native()?.request) return JSON.parse(native().request(cfg.url, path, JSON.stringify(body || {}), cfg.pin || DEFAULT_PIN));
  const res = await fetch(`${httpBase(cfg.url)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.pending) throw new Error(data.message || "登录失败");
  return data;
}

function showAccount() {
  $("settings").classList.remove("hidden");
  notifyState();
}

function showPicker() {
  if (!readStore().session) {
    showAccount();
    return;
  }
  $("picker").classList.remove("hidden");
  document.body.classList.add("picking");
  $("mac-back").classList.add("hidden");
}

function hidePicker() {
  $("picker").classList.add("hidden");
  document.body.classList.remove("picking");
  $("mac-back").classList.remove("hidden");
}

function offerMacs(items) {
  macs = items || [];
  renderMacs();
  if (selectedMac && macs.some((item) => item.id === selectedMac)) return;
  const last = localStorage.getItem("herdr-plus-last-mac") || "";
  const pick = macs.find((item) => item.id === last) || (macs.length === 1 ? macs[0] : null);
  if (pick) {
    chooseMac(pick, true);
    return;
  }
  showPicker();
}

function chooseMac(mac, quiet = false) {
  if (!mac) return;
  if (mac.id === selectedMac && !pendingMac) {
    hidePicker();
    return;
  }
  pendingMac = mac.id;
  selectedMacName = mac.name || mac.id;
  window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    if (pendingMac !== mac.id) return;
    pendingMac = "";
    renderMacs();
    toast("没有进入这台 Mac", true);
  }, 8000);
  renderMacs();
  if (!quiet) showPicker();
  send({ type: "mac.select", id: mac.id });
}

function renderMacs() {
  const host = $("mac-list");
  if (!host) return;
  host.replaceChildren();
  paintGate();
  if (!readStore().session) return;
  if (!macs.length) {
    const empty = document.createElement("div");
    empty.className = "empty mac-empty";
    empty.innerHTML = "<strong>没有在线的 Mac</strong><p>在电脑上打开通道，登录并上线。</p>";
    host.append(empty);
    return;
  }
  for (const mac of macs) {
    const button = document.createElement("button");
    const state = mac.id === pendingMac ? "pending" : mac.id === selectedMac ? "on" : "online";
    button.type = "button";
    button.className = "mac" + (entered.has("m:" + mac.id) ? "" : " rise");
    button.dataset.state = state;
    entered.add("m:" + mac.id);
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = mac.name || mac.id;
    const meta = document.createElement("span");
    meta.textContent = mac.agentCount ? `${mac.agentCount} 个会话 · 在线` : "在线";
    copy.append(title, meta);
    const mark = document.createElement("em");
    mark.textContent = state === "pending" ? "进入中" : state === "on" ? "当前" : "进入";
    button.append(copy, mark);
    button.addEventListener("click", () => chooseMac(mac));
    host.append(button);
  }
}

function setLoginCode(text) {
  const node = $("github-code");
  if (node) node.textContent = text;
}

async function startGitHub() {
  setLoginCode("正在打开 GitHub…");
  clearInterval(githubPoll);
  const cfg = saveSettings();
  if (!native() && (location.protocol === "https:" || location.protocol === "http:")) {
    location.href = `${httpBase(cfg.url)}/auth/github?client=web`;
    return;
  }
  try {
    const started = await api("/v1/auth/github/device", { client: native() ? "android" : "web" });
    if (!started.ok || !started.authorizeUrl) throw new Error(started.message || "无法开始登录");
    setLoginCode("已打开 GitHub。点授权即可，不用输入验证码。");
    const opened = native()?.open ? native().open(started.authorizeUrl) : "";
    if (opened) throw new Error(opened);
    if (!native()?.open) window.open(started.authorizeUrl, "_blank", "noopener");
    githubPoll = window.setInterval(async () => {
      try {
        const result = await api("/v1/auth/github/poll", { pollId: started.pollId });
        if (result.pending) return;
        clearInterval(githubPoll);
        if (!result.session) throw new Error(result.message || "登录失败");
        saveSession(result.session, result.login);
        toast(`已登录 ${result.login}`);
        void connect();
      } catch (error) {
        clearInterval(githubPoll);
        setLoginCode(String(error).replace(/^Error: /, ""));
      }
    }, Math.max(2, started.interval || 5) * 1000);
  } catch (error) {
    setLoginCode(String(error).replace(/^Error: /, ""));
  }
}

function logout() {
  const session = readStore().session;
  saveSession("", "");
  selectedMac = "";
  selectedMacName = "";
  pendingMac = "";
  macs = [];
  disconnect();
  $("picker").classList.add("hidden");
  document.body.classList.remove("picking");
  showAccount();
  renderMacs();
  if (session) void api("/v1/auth/logout", { session }).catch(() => undefined);
}

$("github-login")?.addEventListener("click", () => void startGitHub());
$("notify-btn").addEventListener("click", () => void enableNotify());
$("keepalive-btn").addEventListener("click", () => native()?.keepAlive?.());
$("status-pill").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 860px)").matches) return;
  if (!readStore().session) {
    showAccount();
    return;
  }
  showPicker();
  renderMacs();
});
window.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
fitViewport();

if (native()) $("keepalive-btn").classList.remove("hidden");
notifyState();
const SKIP_VERSION = "herdr-plus-skip-version";
const UPDATE_CHECKED = "herdr-plus-update-checked";
let updateInfo = null;

function paintUpdate(info, status) {
  if (info) updateInfo = info;
  const version = native()?.appVersion?.() || info?.currentVersion || "";
  $("app-version").textContent = version ? `v${version}` : "版本";
  $("update-status").textContent = status || "";
  const notes = $("update-notes");
  if (info?.notes) {
    notes.textContent = info.notes;
    notes.classList.remove("hidden");
  } else {
    notes.classList.add("hidden");
  }
  $("install-update").classList.toggle("hidden", !(info?.available && info?.assetUrl));
  const skipped = localStorage.getItem(SKIP_VERSION);
  const banner = $("update-banner");
  if (info?.available && info.latestVersion !== skipped) {
    $("update-banner-text").textContent = `发现新版本 v${info.latestVersion}`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function runUpdateCheck(quiet) {
  if (!native()?.checkUpdate) {
    $("update-status").textContent = "仅手机应用可检查更新";
    return;
  }
  $("check-update").disabled = true;
  $("update-status").textContent = "正在检查…";
  try {
    const info = JSON.parse(native().checkUpdate());
    localStorage.setItem(UPDATE_CHECKED, String(Date.now()));
    const status = info.available
      ? (info.assetUrl ? `有新版本 v${info.latestVersion}` : "有新版本，但还没有安装包")
      : "已是最新";
    paintUpdate(info, status);
    if (!quiet && info.message && info.ok === false) toast(info.message, true);
  } catch (error) {
    $("update-status").textContent = "检查失败";
    if (!quiet) toast(String(error).replace(/^Error: /, ""), true);
  } finally {
    $("check-update").disabled = false;
  }
}

function runInstallUpdate() {
  if (!native()?.installUpdate || $("install-update").disabled) return;
  $("install-update").disabled = true;
  $("update-status").textContent = "正在下载…";
  try {
    const result = JSON.parse(native().installUpdate());
    $("update-status").textContent = result.message || (result.ok ? "已打开安装包" : "下载失败");
    if (!result.ok) toast(result.message || "下载失败", true);
  } catch (error) {
    $("update-status").textContent = "下载失败";
    toast(String(error).replace(/^Error: /, ""), true);
  } finally {
    $("install-update").disabled = false;
  }
}

$("check-update")?.addEventListener("click", () => runUpdateCheck(false));
$("install-update")?.addEventListener("click", runInstallUpdate);
$("open-release")?.addEventListener("click", () => {
  const url = updateInfo?.htmlUrl || "https://github.com/uasier/pi-auto/releases";
  if (native()?.browse) native().browse(url);
  else window.open(url, "_blank", "noopener");
});
$("update-banner-open")?.addEventListener("click", () => {
  $("settings").classList.remove("hidden");
  runUpdateCheck(true);
});
$("update-banner-skip")?.addEventListener("click", () => {
  if (updateInfo?.latestVersion) localStorage.setItem(SKIP_VERSION, updateInfo.latestVersion);
  $("update-banner").classList.add("hidden");
});
$("account-login").addEventListener("click", () => void startGitHub());
$("account-logout").addEventListener("click", logout);
$("mac-back").addEventListener("click", () => {
  showPicker();
  renderMacs();
});
function toggleSessions() {
  const open = document.body.classList.toggle("sessions-open");
  $("nav-sessions")?.classList.toggle("on", open);
  if (!open) fitFont();
}
function ignoreSwipe(button) {
  if (!button) return;
  let x = 0;
  let y = 0;
  let moved = false;
  button.addEventListener("pointerdown", (event) => {
    x = event.clientX;
    y = event.clientY;
    moved = false;
  });
  button.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - x, event.clientY - y) > 12) moved = true;
  });
  button.addEventListener("click", (event) => {
    if (!moved) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
document.querySelectorAll(".phone-nav button, #phone-switch, #pick-session").forEach(ignoreSwipe);
$("nav-sessions")?.addEventListener("click", toggleSessions);
$("phone-switch")?.addEventListener("click", toggleSessions);
$("pick-session")?.addEventListener("click", toggleSessions);
$("session-backdrop")?.addEventListener("click", () => {
  document.body.classList.remove("sessions-open");
  $("nav-sessions")?.classList.remove("on");
  fitFont();
});
$("rail-close")?.addEventListener("click", () => {
  document.body.classList.remove("sessions-open");
  $("nav-sessions")?.classList.remove("on");
  fitFont();
});
$("nav-device")?.addEventListener("click", () => {
  document.body.classList.remove("sessions-open");
  $("nav-sessions")?.classList.remove("on");
  if (!readStore().session) {
    showAccount();
    return;
  }
  showPicker();
  renderMacs();
});
$("nav-account")?.addEventListener("click", () => {
  document.body.classList.remove("sessions-open");
  $("nav-sessions")?.classList.remove("on");
  showAccount();
});
const initial = loadSettings();
paintAccount(initial.login);
if (native()?.appVersion) paintUpdate(null, "");
if (native()?.checkUpdate) {
  const last = Number(localStorage.getItem(UPDATE_CHECKED) || 0);
  if (!last || Date.now() - last > 12 * 60 * 60 * 1000) runUpdateCheck(true);
}
if (initial.session) {
  showPicker();
  void connect();
} else {
  showAccount();
  setStatus("请先登录", "off");
}
