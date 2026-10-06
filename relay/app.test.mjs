import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 隔离执行实际页面脚本，使用可控连接和时钟验证通信事件，而非复制状态实现。
function page() {
  const elements = new Map();
  function element(id = "") {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const el = {
      value: "", textContent: "", dataset: {}, style: {}, clientWidth: 1000, clientHeight: 700,
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x), toggle(x, on = !classes.has(x)) { on ? classes.add(x) : classes.delete(x); return on; } },
      addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {}, remove() {}, focus() {},
      querySelector: selector => element(id + selector), querySelectorAll: () => [],
    };
    elements.set(id, el);
    return el;
  }
  const storage = new Map();
  const timers = new Map();
  const sockets = [];
  let timerID = 0;
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(body) { this.onmessage?.({ data: JSON.stringify(body) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.element = element("xterm"); this.output = []; }
    open() {} onData() {} focus() {} reset() { this.output = []; }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    write(bytes) { this.output.push(Buffer.from(bytes).toString()); }
  }
  const scope = {
    document: { body: element("body"), getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: () => element(`new-${Math.random()}`) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, val) => storage.set(key, val), removeItem: key => storage.delete(key) },
    location: { protocol: "https:", host: "relay.test", hash: "", pathname: "/", search: "" },
    history: { replaceState() {} }, WebSocket, Terminal,
    Notification: { permission: "denied" }, ResizeObserver: class { observe() {} },
    TextEncoder, TextDecoder, Uint8Array, URLSearchParams, console,
    atob: text => Buffer.from(text, "base64").toString("binary"), btoa: text => Buffer.from(text, "binary").toString("base64"),
    requestAnimationFrame() {}, addEventListener() {}, matchMedia: () => ({ matches: false }),
    setTimeout: (fn, delay) => { timers.set(++timerID, { fn, delay }); return timerID; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}, innerHeight: 800,
  };
  scope.window = scope;
  const context = vm.createContext(scope);
  vm.runInContext(readFileSync(new URL("./static/app.js", import.meta.url), "utf8"), context);
  function run(code) { return vm.runInContext(code, context); }
  function login() {
    storage.set("herdr-plus-remote", JSON.stringify({ session: "local-test", login: "test" }));
    element("server-url").value = "wss://relay.test/v1/ws";
    run("connect()");
    const socket = sockets.at(-1);
    socket.open();
    socket.receive({ type: "relay.welcome", macs: [{ id: "mac", name: "Mac" }] });
    socket.receive({ type: "mac.selected", id: "mac", name: "Mac" });
    socket.receive({ type: "host.state", allowInput: true });
    socket.receive({ type: "sessions", items: [{ paneId: "pane", title: "终端", agentState: "idle" }] });
    run('selectPane("pane")');
    return socket;
  }
  return { run, login, sockets, storage, elements, timers, receive: msg => scope.__relay.onMessage(JSON.stringify(msg)) };
}

test("断线立即停止输入，重连收到快照后恢复原 pane", () => {
  const p = page(); const old = p.login();
  old.close();
  assert.equal(p.run("link.input"), false);
  assert.equal(p.run("current"), "");
  p.run("connect()"); const next = p.sockets.at(-1); next.open();
  next.receive({ type: "relay.welcome", macs: [{ id: "mac" }] });
  assert.equal(next.sent.filter(x => x.type === "mac.select").length, 1);
  next.receive({ type: "macs", items: [{ id: "mac" }] });
  assert.equal(next.sent.filter(x => x.type === "mac.select").length, 1);
  next.receive({ type: "mac.selected", id: "mac" });
  next.receive({ type: "sessions", items: [{ paneId: "pane" }] });
  assert.equal(p.run("current"), "pane");
  assert.equal(next.sent.filter(x => x.type === "term.subscribe").length, 1);
});

test("旧 WebSocket 事件和主动断开后的消息不再改变页面", () => {
  const p = page(); const old = p.login();
  old.close(); p.run("connect()");
  old.receive({ type: "mac.selected", id: "stale" });
  assert.equal(p.run("selectedMac"), "");
  const current = p.sockets.at(-1);
  p.run("disconnect()");
  current.receive({ type: "host.state", allowInput: true });
  assert.equal(p.run("link.input"), false);
  assert.equal(p.run("link.socket"), "off");
});

test("Mac 暂时离线保留选择意图，恢复时自动重新进入", () => {
  const p = page(); const socket = p.login();
  p.receive({ type: "mac.offline", id: "mac" });
  assert.equal(p.storage.get("herdr-plus-last-mac"), "mac");
  p.receive({ type: "macs", items: [{ id: "different" }] });
  assert.notEqual(socket.sent.at(-1).id, "different");
  p.receive({ type: "macs", items: [{ id: "mac" }] });
  assert.equal(socket.sent.at(-1).id, "mac");
});

test("原生队列溢出会重新选择 Mac 并请求当前终端回放", () => {
  const p = page(); const socket = p.login(); socket.sent = [];
  p.receive({ type: "channel.resync" });
  assert.equal(p.run("link.input"), false);
  assert.equal(socket.sent[0].type, "mac.select");
  p.receive({ type: "mac.selected", id: "mac" });
  p.receive({ type: "sessions", items: [{ paneId: "pane" }] });
  assert.equal(socket.sent.at(-1).type, "term.subscribe");
});

test("新终端代次可重新从较小序号开始，重复帧被忽略", () => {
  const p = page(); p.login();
  const frame = (generation, seq, text) => p.receive({ type: "term.frame", paneId: "pane", generation, seq, full: true, bytes: Buffer.from(text).toString("base64") });
  frame(1, 100, "旧画面"); frame(2, 1, "新画面"); frame(2, 1, "重复画面"); frame(1, 101, "延迟旧帧");
  assert.equal(p.run('term.output.join("")'), "新画面");
});

test("重连间隔逐步增加并有上限，原生断线也清理可输入状态", () => {
  const p = page(); p.login().close();
  for (let i = 0; i < 8; i++) { p.run("connect()"); p.sockets.at(-1).close(); }
  const delay = p.run("reconnectAttempts");
  assert.ok(delay >= 8);
  assert.ok([...p.timers.values()].some(t => t.delay === 20000));
  p.run("link.input = true");
  p.receive({ type: "channel.state", connected: false, reconnecting: true });
  assert.equal(p.run("link.input"), false);
  assert.equal(p.run("link.socket"), "reconnecting");
});

test("Android 原生桥选中 Mac 后主动请求对话列表，无需等待会话变化", () => {
  const p = page();
  p.run('usingNative = true; window.NativeRelay = { send: text => nativeSent.push(JSON.parse(text)) }');
  // 通过原生桥真实入口收发，与浏览器 WebSocket 共用同一页面状态逻辑。
  p.run('window.nativeSent = []');
  p.receive({ type: "relay.welcome", self: "android-device", macs: [] });
  p.receive({ type: "mac.selected", id: "mac" });
  assert.equal(p.run('nativeSent[0].type'), "sessions.get");
  p.receive({ type: "host.state", allowInput: true });
  p.receive({ type: "sessions", to: "other-device", items: [{ paneId: "wrong-pane" }] });
  assert.equal(p.run("sessions.length"), 0);
  p.receive({ type: "sessions", to: "android-device", items: [{ paneId: "android-pane", title: "对话" }] });
  assert.equal(p.elements.get("session-count").textContent, "1");
  assert.equal(p.run('sessions[0].paneId'), "android-pane");
});


test("成功收到空列表后显示暂无会话，而非持续加载", () => {
  const p = page(); p.login();
  p.receive({ type: "sessions", items: [] });
  assert.equal(p.elements.get("status").textContent, "这台 Mac 暂无会话");
});
