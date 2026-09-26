import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { $, escapeHtml, sessionLabel, shortPath } from "./dom";
import { DEEPSEEK_KEY_STORAGE, keyInput, providerBase } from "./keys";
import { log, logShortcut } from "./log";

type AgentSession = { id: string; paneId: string; cwd: string; title?: string; agentLabel: string };
type TermFrame = { generation: number; full: boolean; width: number; height: number; bytes: string };

let currentSession: () => AgentSession | undefined = () => undefined;
export function bindPromptSession(fn: () => AgentSession | undefined) {
  currentSession = fn;
}

const termFit = new FitAddon();
export let term: Terminal | null = null;
export let termLive = false;
let termEpoch = 0;
export let termAttachId = "";
export let termGeneration = 0;
let termPainted = false;
let termFullCount = 0;
export let termBuffering = false;
let termHoldResize = false;
let termRevealTimer: number | null = null;
let termWantCols = 0;
let termWantRows = 0;
export const termQueue: TermFrame[] = [];
const TERM_FONT = '"SF Mono", Menlo, "PingFang SC", "Hiragino Sans GB", ui-monospace, monospace';

function b64ToBytes(payload: string): Uint8Array {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function ensureTerm() {
  if (term) return term;
  term = new Terminal({
    convertEol: false,
    disableStdin: false,
    fontFamily: TERM_FONT,
    rescaleOverlappingGlyphs: true,
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: "#0a0c10",
      foreground: "#d5dbe4",
      cursor: "#d5dbe4",
      black: "#15181e",
      red: "#c98b86",
      green: "#86a892",
      yellow: "#c6b48a",
      blue: "#8aa4c2",
      magenta: "#a99bc4",
      cyan: "#7eaea6",
      white: "#d5dbe4",
      brightBlack: "#6d7582",
      brightRed: "#dba8a4",
      brightGreen: "#a4c2ad",
      brightYellow: "#d8c7a8",
      brightBlue: "#a9bdd4",
      brightMagenta: "#c4b8d8",
      brightCyan: "#a4ccc6",
      brightWhite: "#e7ebf2",
    },
  });
  term.loadAddon(termFit);
  const host = $("term-host");
  term.open(host);
  term.onData((data) => {
    if (!termLive) return;
    void invoke("term_input", { bytesB64: textToB64(data) });
  });
  host.addEventListener("wheel", onTermWheel, { capture: true, passive: false });
  const observer = new ResizeObserver(() => {
    if (termLive) void resizeLiveTerm();
  });
  observer.observe(host);
  return term;
}

function wheelLines(event: WheelEvent): number {
  const sign = Math.sign(event.deltaY);
  const amount = Math.abs(event.deltaY);
  if (sign === 0 || amount === 0) return 0;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return sign * Math.min(3, Math.max(1, Math.round(amount)));
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return sign * 3;
  return sign * Math.min(3, Math.max(1, Math.round(amount / 48)));
}

function onTermWheel(event: WheelEvent) {
  if (!termLive || !term) return;
  const lines = wheelLines(event);
  if (lines === 0) return;
  event.preventDefault();
  event.stopPropagation();
  void invoke("term_scroll", {
    direction: lines < 0 ? "up" : "down",
    lines: Math.abs(lines),
  }).catch(() => undefined);
}

function showLiveHost() {
  const host = $("term-host");
  host.classList.add("live");
  host.classList.remove("hidden");
}

function frameMatches(frame: TermFrame) {
  return frame.full && frame.width === termWantCols && frame.height === termWantRows && frame.width > 0;
}

function showTermReady() {
  if (termRevealTimer != null) {
    window.clearTimeout(termRevealTimer);
    termRevealTimer = null;
  }
  if (!termLive || !termPainted) return;
  termHoldResize = false;
  $("term-host").classList.add("ready");
}

export function paintTermFrame(frame: TermFrame) {
  if (!term) return;
  if (!termPainted && !frameMatches(frame)) return;
  if (term.cols !== frame.width || term.rows !== frame.height) term.resize(frame.width, frame.height);
  const first = !termPainted;
  termPainted = true;
  if (frame.full && frameMatches(frame)) termFullCount += 1;
  const revealAfterWrite = termFullCount >= 2;
  if (first && termRevealTimer == null) termRevealTimer = window.setTimeout(showTermReady, 450);
  term.write(b64ToBytes(frame.bytes), () => {
    term?.scrollToBottom();
    if (revealAfterWrite) showTermReady();
  });
}

async function waitForTermLayout() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function stableTermSize(epoch: number) {
  if (!term) return false;
  let last = "";
  for (let i = 0; i < 12; i++) {
    if (epoch !== termEpoch) return false;
    await waitForTermLayout();
    const proposed = termFit.proposeDimensions();
    if (!proposed || proposed.cols < 2 || proposed.rows < 2) continue;
    term.resize(proposed.cols, proposed.rows);
    const sig = `${term.cols}x${term.rows}`;
    if (sig === last) {
      termWantCols = term.cols;
      termWantRows = term.rows;
      return true;
    }
    last = sig;
  }
  termWantCols = term.cols;
  termWantRows = term.rows;
  return termWantCols > 0;
}

let termResizeTimer: number | null = null;
function resizeLiveTerm() {
  if (!termLive || !term || termHoldResize) return;
  if (termResizeTimer != null) window.clearTimeout(termResizeTimer);
  termResizeTimer = window.setTimeout(() => {
    termResizeTimer = null;
    if (!termLive || !term) return;
    termFit.fit();
    void invoke("term_resize", { cols: term.cols, rows: term.rows }).catch(() => undefined);
  }, 80);
}

export async function startLiveTerm(session: AgentSession) {
  const epoch = ++termEpoch;
  const t = ensureTerm();
  termLive = false;
  termBuffering = true;
  termGeneration = 0;
  termPainted = false;
  termFullCount = 0;
  termQueue.length = 0;
  termHoldResize = true;
  if (termRevealTimer != null) {
    window.clearTimeout(termRevealTimer);
    termRevealTimer = null;
  }
  $("term-host").classList.remove("ready");
  showLiveHost();
  t.reset();
  if (!(await stableTermSize(epoch))) return;
  try {
    const generation = await invoke<number>("term_attach", {
      paneId: session.paneId,
      cols: termWantCols,
      rows: termWantRows,
    });
    if (epoch !== termEpoch) return;
    termGeneration = generation;
    termBuffering = false;
    const queued = termQueue.splice(0).filter((frame) => frame.generation === generation);
    const firstFit = queued.findIndex((frame) => frameMatches(frame));
    termLive = true;
    for (const frame of firstFit >= 0 ? queued.slice(firstFit) : []) paintTermFrame(frame);
    t.focus();
  } catch (error) {
    if (epoch !== termEpoch) return;
    termLive = false;
    termBuffering = false;
    log(`终端接入失败：${error}`, true);
  }
}

export function stopLiveTerm() {
  if (!termLive && !termAttachId) return;
  termEpoch += 1;
  termLive = false;
  termBuffering = false;
  termGeneration = 0;
  termPainted = false;
  termFullCount = 0;
  termQueue.length = 0;
  termHoldResize = false;
  if (termRevealTimer != null) {
    window.clearTimeout(termRevealTimer);
    termRevealTimer = null;
  }
  termAttachId = "";
  $("term-host").classList.remove("live", "ready");
  void invoke("term_detach").catch(() => undefined);
}

export function hideTerm() {
  $("term-host").classList.add("hidden");
}

export function onTermBytes(frame: TermFrame) {
  if (termBuffering) {
    termQueue.push(frame);
    return;
  }
  if (!termLive || !term || frame.generation !== termGeneration) return;
  paintTermFrame(frame);
}

export function onTermClosed(message: string) {
  if (!termLive) return;
  termLive = false;
  log(message || "终端连接已断开", true);
}

export function attachSessionTerm(session: AgentSession) {
  if (termAttachId !== session.id) {
    termAttachId = session.id;
    void startLiveTerm(session);
  }
  showLiveHost();
}

export function onPromptKey(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (!$("complete-picker").classList.contains("hidden")) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      logShortcut("Esc 取消补全");
      hideCompletePicker();
      return true;
    }
    const index = Number(event.key) - 1;
    if (index >= 0 && index < completeChoices.length) {
      event.preventDefault();
      event.stopPropagation();
      logShortcut(`${index + 1} 选择补全`);
      void chooseComplete(index);
      return true;
    }
  }
  if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey && terminalFocused(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - lastTabAt < 320) {
      lastTabAt = 0;
      if (tabTimer != null) window.clearTimeout(tabTimer);
      tabTimer = null;
      logShortcut("双击 Tab 补全");
      void completeTerminalInput();
    } else {
      noteSingleTab();
    }
    return true;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && (key === "o" || event.code === "KeyO")) {
    event.preventDefault();
    event.stopPropagation();
    logShortcut("⌘⇧O 优化输入");
    void replaceInputWithRefine();
    return true;
  }
  return false;
}

let refineBusy = false;
let refineOpenedAt = 0;

function deepseekKey() {
  return localStorage.getItem(DEEPSEEK_KEY_STORAGE)?.trim() || keyInput("deepseek").value.trim();
}

function logicalLine(y: number, endX?: number) {
  if (!term) return "";
  const buf = term.buffer.active;
  let row = y;
  while (row > 0 && buf.getLine(row)?.isWrapped) row -= 1;
  let text = "";
  for (let at = row; at <= y; at += 1) {
    const line = buf.getLine(at);
    if (!line) continue;
    const end = at === y ? endX : undefined;
    text += line.translateToString(false, 0, end);
  }
  return text.replace(/\s+$/, "");
}

function stripPrompt(raw: string) {
  const marked = raw.match(/^\s*[❯›»▶λπ>$#]\s*([\s\S]*)$/u);
  return (marked ? marked[1] : raw).replace(/\s+$/, "");
}

function currentTerminalInput() {
  if (!term) return "";
  const buf = term.buffer.active;
  const cursorY = buf.baseY + buf.cursorY;
  const cursorLine = stripPrompt(logicalLine(cursorY, Math.min(buf.cursorX + 1, term.cols)));
  if (cursorLine.trim()) return cursorLine.trim();
  for (let y = cursorY - 1, guard = 0; y >= 0 && guard < 4; y -= 1, guard += 1) {
    if (buf.getLine(y + 1)?.isWrapped) continue;
    const text = stripPrompt(logicalLine(y));
    if (text.trim()) return text.trim();
  }
  return "";
}

function terminalContext() {
  if (!term) return "";
  const buf = term.buffer.active;
  const cursorY = buf.baseY + buf.cursorY;
  const start = Math.max(0, cursorY - 80);
  const lines: string[] = [];
  for (let y = start; y < cursorY; y += 1) {
    const line = buf.getLine(y);
    const text = line?.translateToString(true) ?? "";
    if (!text) continue;
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const recent = lines.join("\n").slice(-4000);
  const session = currentSession();
  const head = session ? `会话：${sessionLabel(session)} · ${session.agentLabel} · ${shortPath(session.cwd)}` : "";
  return [head, recent].filter(Boolean).join("\n");
}

function terminalRequestText() {
  const typed = currentTerminalInput();
  if (typed) return typed;
  return term?.getSelection()?.trim() ?? "";
}

async function replaceTerminalInput(original: string, next: string) {
  if (!termLive) throw new Error("终端未接入");
  const erasers = "\x7f".repeat(Array.from(original).length);
  await invoke("term_input", { bytesB64: textToB64(erasers + next) });
  term?.focus();
}

export function terminalFocused(target?: EventTarget | null) {
  const host = $("term-host");
  const active = document.activeElement;
  if (target instanceof Node && host.contains(target)) return true;
  return !!active && (host.contains(active) || active.classList.contains("xterm-helper-textarea"));
}

export let lastTabAt = 0;
export let tabTimer: number | null = null;
let completeSource = "";
let completeChoices: string[] = [];

export function hideCompletePicker() {
  completeChoices = [];
  completeSource = "";
  $("complete-picker").classList.add("hidden");
  $("complete-options").innerHTML = "";
}

function showCompletePicker(source: string, options: string[], intent = "") {
  completeSource = source;
  completeChoices = options.slice(0, 3);
  $("complete-intent").textContent = intent || "下一步";
  const box = $("complete-options");
  box.innerHTML = completeChoices
    .map((item, index) => `<button type="button" data-index="${index}"><b>${index + 1}</b><span>${escapeHtml(item)}</span></button>`)
    .join("");
  box.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.addEventListener("click", () => {
      void chooseComplete(Number(button.dataset.index));
    });
  });
  $("complete-picker").classList.remove("hidden");
}

export async function chooseComplete(index: number) {
  const next = completeChoices[index];
  const source = completeSource;
  if (!next || !source) return;
  hideCompletePicker();
  try {
    await replaceTerminalInput(source, next);
    log(`已写入补全 ${index + 1}`);
  } catch (error) {
    log(String(error), true);
  }
}

export function noteSingleTab() {
  lastTabAt = Date.now();
  if (tabTimer != null) window.clearTimeout(tabTimer);
  tabTimer = window.setTimeout(() => {
    lastTabAt = 0;
    tabTimer = null;
    if (termLive) void invoke("term_input", { bytesB64: textToB64("\t") }).catch(() => undefined);
  }, 320);
}

export async function completeTerminalInput() {
  const now = Date.now();
  if (refineBusy || now - refineOpenedAt < 400) return;
  refineOpenedAt = now;
  const typed = currentTerminalInput();
  const selected = term?.getSelection()?.trim() ?? "";
  const text = typed || selected;
  if (!text) {
    const raw = term ? logicalLine(term.buffer.active.baseY + term.buffer.active.cursorY, term.buffer.active.cursorX) : "";
    log(`终端里没有可补全的输入${raw ? `，光标行是「${raw}」` : ""}`, true);
    return;
  }
  if (!deepseekKey()) {
    log("未配置 DeepSeek API Key。请在系统菜单「密钥设置」中填写", true);
    return;
  }
  refineBusy = true;
  log("正在生成 3 条补全…");
  try {
    const result = await invoke<{ intent: string; options: string[] }>("complete_prompt", {
      apiKey: deepseekKey() || null,
      baseUrl: providerBase("deepseek") || null,
      text,
      context: terminalContext() || null,
    });
    if (result.options.length === 0) throw new Error("没有可用的补全");
    if (result.intent) log(`揣测意图：${result.intent}`);
    showCompletePicker(text, result.options, result.intent);
  } catch (error) {
    log(String(error), true);
  } finally {
    refineBusy = false;
  }
}

export async function replaceInputWithRefine() {
  const now = Date.now();
  if (refineBusy || now - refineOpenedAt < 400) return;
  refineOpenedAt = now;
  const text = terminalRequestText();
  if (!text) {
    log("终端里没有可替换的输入", true);
    return;
  }
  if (!deepseekKey()) {
    log("未配置 DeepSeek API Key。请在系统菜单「密钥设置」中填写", true);
    return;
  }
  refineBusy = true;
  log("正在优化终端输入…");
  try {
    const result = await invoke<string>("refine_prompt", {
      apiKey: deepseekKey() || null,
      baseUrl: providerBase("deepseek") || null,
      text,
      context: terminalContext() || null,
    });
    const next = result.replace(/\s*\n+\s*/g, " ").trim();
    await replaceTerminalInput(text, next);
    log("已用优化后的问题替换终端输入");
  } catch (error) {
    log(String(error), true);
  } finally {
    refineBusy = false;
  }
}
