import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type AgentSession = {
  id: string;
  paneId: string;
  title: string;
  agent: string;
  agentLabel: string;
  agentState: string;
  cwd: string;
  idle: boolean;
  confidence: string;
  reason: string;
  preview: string;
};

type TaskStatus = "pending" | "running" | "committing" | "done";
type TaskItem = {
  id: string;
  title: string;
  text: string;
  commit: boolean;
  status: TaskStatus;
};
type Phase = "idle" | "sent" | "working" | "settling";
type Plan = {
  tasks: TaskItem[];
  template: Array<Pick<TaskItem, "title" | "text" | "commit">>;
  currentRound: number;
  phase: Phase;
  idleSince: number | null;
  sentAt: number | null;
  planRunning: boolean;
  compacting: boolean;
  compactFrom: number | null;
  needCompact: boolean;
  loopRounds: number;
  idleMs: number;
  compactAt: number;
  commitAfter: boolean;
  jev: boolean;
  jevMax: number;
  jevRuns: number;
};
type HerdrStatus = {
  connected: boolean;
  endpoint: string | null;
  paneCount: number;
  agentCount: number;
  error: string | null;
};
type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  name: string;
  notes: string;
  htmlUrl: string;
  assetName: string;
  assetUrl: string;
  repo: string;
};
type AppInfo = {
  version: string;
  repo: string;
};

const AGENT_ORDER = ["pi", "claude", "codex", "grok", "shell"] as const;
const AGENT_META: Record<string, { label: string; hint: string }> = {
  pi: { label: "Pi", hint: "π" },
  claude: { label: "Claude", hint: "Anthropic" },
  codex: { label: "Codex", hint: "OpenAI" },
  grok: { label: "Grok", hint: "xAI" },
  shell: { label: "终端", hint: "shell" },
};
const LAUNCH_COMMAND: Record<string, string> = {
  shell: "",
  pi: "pi",
  claude: "claude",
  codex: "codex",
  grok: "grok",
};

function commitPrompt(task: TaskItem) {
  return `任务「${task.title}」的功能改动已经完成。现在请立刻做 git 提交，不要继续改功能代码。

要求：
1. 运行 git status 和 git diff，只纳入这次任务相关文件
2. 不要 add 无关文件，不要 git push，不要 amend 别人的 commit
3. 若有改动：git add 后 git commit；message 用中文，可带上「${task.title}」
4. 若没有任何相关改动：不要空提交，回复「无文件变更，已跳过提交」
5. 提交完成后只确认 hash 和 message，不要再开新任务`;
}

let sessions: AgentSession[] = [];
let selectedId: string | null = null;
const plans = new Map<string, Plan>();
let pollTimer: number | null = null;
let activeSheet: (typeof AGENT_ORDER)[number] = "pi";
let followPane: { paneId: string; want: string; until: number } | null = null;
let importDraft: string[] = [];
let term: Terminal | null = null;
let lastListSig = "";
let lastQueueSig = "";
let editingTaskId: string | null = null;
let editingDraft = "";
let lastHeadSig = "";
let lastHerdrText = "";
let herdrGuideAutoShown = false;
const HERDR_INSTALL_CMD = "curl -fsSL https://herdr.dev/install.sh | sh";
const HERDR_DOCS = "https://herdr.dev/docs/install/";
const USAGE_SEEN_KEY = "pi-auto-usage-seen";
const SKIP_VERSION_KEY = "pi-auto-skip-version";
const UPDATE_CHECKED_KEY = "pi-auto-update-checked-at";
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const STALL_CHECK_MS = 5 * 60 * 1000;
const STALL_DIFF_RATIO = 0.01;
const NUDGE_TEXT = "继续";
let appInfo: AppInfo | null = null;
let updateInfo: UpdateCheck | null = null;
let updateChecking = false;
let updateInstalling = false;
let pollInFlight = false;
type StallWatch = { text: string; at: number };
const stallWatch = new Map<string, StallWatch>();
const stallNudging = new Set<string>();

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const loopRoundsInput = () => $<HTMLInputElement>("loop-rounds");
const idleMsInput = () => $<HTMLInputElement>("idle-ms");
const commitAfterInput = () => $<HTMLInputElement>("commit-after");
const compactAtInput = () => $<HTMLInputElement>("compact-at");
const jevOnInput = () => $<HTMLInputElement>("jev-on");
const jevMaxInput = () => $<HTMLInputElement>("jev-max");
const jevProviderInput = () => $<HTMLSelectElement>("jev-provider");
const JEV_KEY_STORAGE = "pi-auto-jev-key";
const DEEPSEEK_KEY_STORAGE = "pi-auto-deepseek-key";
const LAYA_KEY_STORAGE = "pi-auto-laya-key";
const JEV_BASE_STORAGE = "pi-auto-jev-base";
const DEEPSEEK_BASE_STORAGE = "pi-auto-deepseek-base";
const JEV_PROVIDER_STORAGE = "pi-auto-jev-provider";
const LAYA_BASE_STORAGE = "pi-auto-laya-base";
const JEV_MIN_CONFIDENCE = 0.45;
const JEV_MIN_CONTINUE = 0.55;
const JEV_ASK = `【下一步建议】完成上面的工作后，在回复最末尾单独给出 2 到 4 条下一步，用这个代码块，不要在块外解释：

\`\`\`jev-next
1. 一条可立刻执行的下一步
2. 另一条
\`\`\`

每条一行，写具体要改的文件或要验证的行为。不要重复已经做完的事。如果没有值得继续的下一步，代码块里只写「无」。`;

function log(message: string, err = false) {
  const box = $("log");
  const item = document.createElement("div");
  item.className = `item${err ? " err" : ""}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<span class="time">${time}</span><span>${escapeHtml(message)}</span>`;
  box.prepend(item);
  while (box.childElementCount > 80) {
    box.removeChild(box.lastElementChild as Node);
  }
}

function emptyPlan(): Plan {
  return {
    tasks: [],
    template: [],
    currentRound: 1,
    phase: "idle",
    idleSince: null,
    sentAt: null,
    planRunning: false,
    compacting: false,
    compactFrom: null,
    needCompact: true,
    loopRounds: 1,
    idleMs: 2,
    compactAt: 70,
    commitAfter: true,
    jev: false,
    jevMax: 3,
    jevRuns: 0,
  };
}

function getPlan(id: string): Plan {
  let plan = plans.get(id);
  if (!plan) {
    plan = emptyPlan();
    plans.set(id, plan);
  }
  return plan;
}

function activePlan(): Plan | null {
  return selectedId ? getPlan(selectedId) : null;
}

function syncPlanInputsFromUi() {
  const plan = selectedId ? plans.get(selectedId) : null;
  if (!plan) return;
  plan.loopRounds = Math.max(1, Number(loopRoundsInput().value) || 1);
  plan.idleMs = Math.max(1, Number(idleMsInput().value) || 2);
  plan.compactAt = Math.max(10, Math.min(95, Number(compactAtInput().value) || 70));
  plan.commitAfter = commitAfterInput().checked;
  plan.jev = jevOnInput().checked;
  plan.jevMax = Math.max(1, Math.min(8, Number(jevMaxInput().value) || 3));
}

function applyPlanInputsToUi() {
  const plan = activePlan();
  if (!plan) return;
  loopRoundsInput().value = String(plan.loopRounds);
  idleMsInput().value = String(plan.idleMs);
  compactAtInput().value = String(plan.compactAt);
  commitAfterInput().checked = plan.commitAfter;
  jevOnInput().checked = plan.jev;
  jevMaxInput().value = String(plan.jevMax);
}

function selectSession(id: string | null) {
  syncPlanInputsFromUi();
  selectedId = id;
  applyPlanInputsToUi();
  lastQueueSig = "";
  lastHeadSig = "";
  lastListSig = "";
  renderAll();
}

function setAppTheme(agent?: string) {
  const app = $("app");
  if (agent) app.dataset.agent = agent;
  else delete app.dataset.agent;
  app.classList.toggle("is-auto", !!activePlan()?.planRunning);
  const color =
    agent === "pi"
      ? "#b794f6"
      : agent === "claude"
        ? "#e07a5f"
        : agent === "codex"
          ? "#3dd6c6"
          : "#ffd34e";
  app.style.setProperty("--agent", color);
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sessionLabel(session: { paneId: string; cwd: string; title?: string }) {
  const title = session.title?.replace(/^[\s\-–—]+/, "").trim();
  if (title) return title;
  const path = shortPath(session.cwd);
  const name = path.split("/").filter(Boolean).pop();
  return name && name !== "~" ? name : session.paneId;
}

function shortPath(cwd: string) {
  if (!cwd) return "未知目录";
  const home = "/Users/";
  if (cwd.startsWith(home)) {
    const rest = cwd.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash === -1) return "~";
    return `~${rest.slice(slash)}`;
  }
  return cwd;
}

function statusLabel(session: AgentSession | undefined) {
  if (!session) return { text: "待选择", cls: "idle-unknown" };
  if (!session.idle) return { text: "执行中", cls: "idle-no" };
  if (session.confidence === "high") return { text: "空闲", cls: "idle-yes" };
  return { text: "可能空闲", cls: "idle-maybe" };
}

function selected(): AgentSession | undefined {
  return sessions.find((s) => s.id === selectedId);
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
}

function outputSnapshot(raw: string) {
  return stripAnsi(raw)
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function outputChangeRatio(prev: string, next: string) {
  if (prev === next) return 0;
  const max = Math.max(prev.length, next.length);
  if (max === 0) return 0;
  const min = Math.min(prev.length, next.length);
  let head = 0;
  while (head < min && prev.charCodeAt(head) === next.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < min - head &&
    prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
  ) {
    tail++;
  }
  return (max - head - tail) / max;
}

function armStallWatch(session: AgentSession) {
  const text = outputSnapshot(session.preview);
  stallWatch.set(session.id, {
    text,
    at: text ? Date.now() : Date.now() - STALL_CHECK_MS,
  });
}

function clearStallWatch(id: string | null) {
  if (!id) return;
  stallWatch.delete(id);
  stallNudging.delete(id);
}

function stallPreviewIds(now = Date.now()) {
  const ids: string[] = [];
  for (const [id, plan] of plans) {
    if (!plan.planRunning) continue;
    const watch = stallWatch.get(id);
    if (!watch || now - watch.at >= STALL_CHECK_MS) ids.push(id);
  }
  return ids;
}

function pollPreviewIds(now = Date.now()) {
  const ids = new Set(stallPreviewIds(now));
  for (const [id, plan] of plans) {
    if (plan.planRunning && plan.compacting) ids.add(id);
  }
  return [...ids];
}

function compactDoneText(preview: string) {
  const tail = stripAnsi(preview).replace(/\r/g, "").slice(-4000);
  return /compacted|compact(?:ion)? complete|conversation compacted|context compacted|已压缩|压缩完成|compact summary/i.test(tail);
}

function agentBack(session: AgentSession) {
  return session.idle || session.agentState === "blocked" || session.agentState === "done";
}

function compactEvidence(session: AgentSession, plan: Plan, ctx: number | null) {
  const dropped = ctx != null && ctx < compactThreshold(plan);
  const fell = plan.compactFrom != null && ctx != null && ctx <= plan.compactFrom - 8;
  const saidDone = compactDoneText(session.preview);
  return { dropped, fell, saidDone, ready: saidDone || dropped || fell };
}

function finishCompact(session: AgentSession, plan: Plan, reason: string) {
  plan.compacting = false;
  plan.compactFrom = null;
  plan.phase = "idle";
  plan.idleSince = Date.now();
  plan.sentAt = null;
  log(`${sessionLabel(session)} 上下文压缩完成${reason}`);
  if (session.id === selectedId) refreshSelectedPlan();
}

function parseContextPercent(preview: string): number | null {
  const tail = stripAnsi(preview).split(/\n/).slice(-18).join("\n");
  const patterns = [
    /(\d{1,3}(?:\.\d+)?)\s*%\s*\/\s*[\d.]+\s*[kKmM]?/,
    /(?:context|ctx|上下文)[^\n%]{0,20}(\d{1,3}(?:\.\d+)?)\s*%/i,
    /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:context|ctx|used)/i,
  ];
  for (const re of patterns) {
    const match = tail.match(re);
    if (!match) continue;
    const value = Number(match[1]);
    if (value >= 0 && value <= 100) return value;
  }
  return null;
}

function compactThreshold(plan?: Plan) {
  if (plan) return Math.max(10, Math.min(95, plan.compactAt || 70));
  return Math.max(10, Math.min(95, Number(compactAtInput().value) || 70));
}

function compactCommand(agent: string) {
  if (agent === "grok") {
    return "/compact\n请压缩当前上下文，保留任务目标和未完成工作，不要继续写代码。";
  }
  return "/compact";
}

function loopRounds(plan?: Plan) {
  if (plan) return Math.max(1, Math.min(99, plan.loopRounds || 1));
  return Math.max(1, Math.min(99, Number(loopRoundsInput().value) || 1));
}

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function taskTitle(text: string) {
  const line = text.split(/\n/)[0]?.trim() ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line || "未命名任务";
}

function withJevAsk(text: string, enabled: boolean) {
  if (!enabled) return text.trim();
  if (text.includes("```jev-next")) return text.trim();
  return `${text.trim()}\n\n${JEV_ASK}`;
}

type DecisionProvider = "jev" | "deepseek" | "laya";

function jevProvider(): DecisionProvider {
  const value = jevProviderInput().value;
  return value === "deepseek" || value === "laya" ? value : "jev";
}

function providerLabel(provider = jevProvider()) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "laya") return "Laya";
  return "Jev";
}

function keyStorage(provider = jevProvider()) {
  if (provider === "deepseek") return DEEPSEEK_KEY_STORAGE;
  if (provider === "laya") return LAYA_KEY_STORAGE;
  return JEV_KEY_STORAGE;
}

function baseStorage(provider = jevProvider()) {
  if (provider === "deepseek") return DEEPSEEK_BASE_STORAGE;
  if (provider === "laya") return LAYA_BASE_STORAGE;
  return JEV_BASE_STORAGE;
}

function providerKey(provider = jevProvider()) {
  return localStorage.getItem(keyStorage(provider))?.trim() || "";
}

function providerBase(provider = jevProvider()) {
  return localStorage.getItem(baseStorage(provider))?.trim() || null;
}

function storeSetting(storage: string, value: string) {
  const text = value.trim();
  if (text) localStorage.setItem(storage, text);
  else localStorage.removeItem(storage);
}

const KEY_DEFAULTS: Record<DecisionProvider, string> = {
  jev: "https://api.typesafe.ai",
  deepseek: "https://api.deepseek.com",
  laya: "http://127.0.0.1:8100",
};
const KEY_IDS: DecisionProvider[] = ["jev", "deepseek", "laya"];

function keyInput(provider: DecisionProvider) {
  return $<HTMLInputElement>(`key-${provider}`);
}

function baseInput(provider: DecisionProvider) {
  return $<HTMLInputElement>(`base-${provider}`);
}

function setKeyStatus(provider: DecisionProvider, text: string, tone: "" | "ok" | "bad" = "") {
  const status = $(`key-status-${provider}`);
  status.textContent = text;
  status.className = `key-status${tone ? ` ${tone}` : ""}`;
}

function setKeyNote(provider: DecisionProvider, text: string, tone: "" | "ok" | "bad" = "") {
  const note = $(`key-note-${provider}`);
  note.textContent = text;
  note.className = `key-note${tone ? ` ${tone}` : ""}`;
}

function showKeys() {
  keyInput("jev").value = localStorage.getItem(JEV_KEY_STORAGE) ?? "";
  baseInput("jev").value = localStorage.getItem(JEV_BASE_STORAGE) ?? "";
  keyInput("deepseek").value = localStorage.getItem(DEEPSEEK_KEY_STORAGE) ?? "";
  baseInput("deepseek").value = localStorage.getItem(DEEPSEEK_BASE_STORAGE) ?? "";
  keyInput("laya").value = localStorage.getItem(LAYA_KEY_STORAGE) ?? "";
  baseInput("laya").value = localStorage.getItem(LAYA_BASE_STORAGE) ?? "";
  for (const provider of KEY_IDS) {
    setKeyStatus(provider, "未检查");
    setKeyNote(provider, "");
  }
  $("keys-foot").textContent = "";
  $("keys-modal").classList.remove("hidden");
  keyInput("jev").focus();
}

function hideKeys() {
  $("keys-modal").classList.add("hidden");
}

function saveKeys() {
  storeSetting(JEV_KEY_STORAGE, keyInput("jev").value);
  storeSetting(JEV_BASE_STORAGE, baseInput("jev").value);
  storeSetting(DEEPSEEK_KEY_STORAGE, keyInput("deepseek").value);
  storeSetting(DEEPSEEK_BASE_STORAGE, baseInput("deepseek").value);
  storeSetting(LAYA_KEY_STORAGE, keyInput("laya").value);
  storeSetting(LAYA_BASE_STORAGE, baseInput("laya").value);
  $("keys-foot").textContent = "已保存。续跑和贪吃蛇会使用这份配置。";
  $("keys-foot").className = "key-note ok";
  log("已保存密钥设置");
  void refreshGameBackends();
}

function formBase(provider: DecisionProvider) {
  const value = baseInput(provider).value.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return undefined;
  return value;
}

async function checkProvider(provider: DecisionProvider) {
  const base = formBase(provider);
  if (base === undefined) {
    setKeyStatus(provider, "地址无效", "bad");
    setKeyNote(provider, "地址需要以 http:// 或 https:// 开头", "bad");
    return;
  }
  const button = document.querySelector<HTMLButtonElement>(`[data-check="${provider}"]`);
  if (button) button.disabled = true;
  setKeyStatus(provider, "检查中");
  setKeyNote(provider, "");
  try {
    const report = await invoke<{
      ok: boolean;
      message: string;
      endpoint: string;
      latencyMs: number;
    }>("probe_decision", {
      provider,
      apiKey: keyInput(provider).value.trim() || null,
      baseUrl: base,
    });
    setKeyStatus(provider, report.ok ? "可用" : "失败", report.ok ? "ok" : "bad");
    const where = report.endpoint ? `${report.endpoint} · ` : "";
    setKeyNote(
      provider,
      `${where}${report.message} · ${report.latencyMs}ms`,
      report.ok ? "ok" : "bad",
    );
  } catch (error) {
    setKeyStatus(provider, "失败", "bad");
    setKeyNote(provider, String(error), "bad");
  } finally {
    if (button) button.disabled = false;
  }
}

async function checkAllProviders() {
  const button = $<HTMLButtonElement>("keys-check-all");
  button.disabled = true;
  try {
    await Promise.all(KEY_IDS.map((provider) => checkProvider(provider)));
  } finally {
    button.disabled = false;
  }
}

function suggestionLines(body: string) {
  return body
    .split(/\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length >= 4)
    .filter((line) => !/^(无|没有|none|n\/a)$/i.test(line))
    .filter((line) => line !== "一条可立刻执行的下一步" && line !== "另一条")
    .slice(0, 4);
}

function parseJevSuggestions(raw: string) {
  const text = stripAnsi(raw).replace(/\r/g, "");
  const fences = [...text.matchAll(/```(?:jev-next|next)\s*([\s\S]*?)```/gi)];
  const fenced = fences.length ? fences[fences.length - 1][1] : "";
  const fromFence = suggestionLines(fenced);
  if (fromFence.length) return fromFence;
  const lines = text.split(/\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/下一步建议|jev-next|下一步/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  return suggestionLines(lines.slice(start + 1, start + 12).join("\n"));
}

function continuationPrompt(step: string) {
  return withJevAsk(
    `Jev 已选定下一步。现在只做这一项，做完就停：\n\n${step}\n\n不要同时做其他建议，不要扩大范围。`,
    true,
  );
}

type JevDecision = {
  choice: string;
  confidence: number;
  continueNow: number;
  endpoint?: string;
};

function logLaya(scope: string, detail: string, err = false) {
  log(`Laya · ${scope} · ${detail}`, err);
}

function logSnake(detail: string, err = false) {
  const box = $("idle-game-log-list");
  const item = document.createElement("div");
  item.className = `idle-log-item${err ? " err" : ""}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<span class="time">${time}</span>${escapeHtml(detail)}`;
  box.prepend(item);
  while (box.childElementCount > 80) box.removeChild(box.lastElementChild as Node);
}

async function maybeJevContinue(session: AgentSession, plan: Plan, task: TaskItem) {
  if (!plan.jev) return false;
  if (plan.jevRuns >= plan.jevMax) {
    log(`${sessionLabel(session)} Jev 续跑已达 ${plan.jevMax} 次`);
    return false;
  }
  let raw = session.preview;
  try {
    const fresh = await invoke<string>("read_session_text", { id: session.id });
    if (fresh.trim()) raw = fresh;
  } catch (error) {
    log(`${sessionLabel(session)} 读取下一步失败：${error}`, true);
  }
  const suggestions = parseJevSuggestions(raw);
  if (suggestions.length === 0) {
    log(`${sessionLabel(session)} 未解析到下一步建议，结束 Jev 续跑`);
    return false;
  }
  const options = suggestions.map((text, i) => ({ id: `s${i + 1}`, text }));
  const tail = stripAnsi(raw).slice(-3500);
  const state = [
    `任务：${task.title}`,
    task.text.slice(0, 800),
    "候选下一步：",
    ...suggestions.map((item, i) => `${i + 1}. ${item}`),
    "终端输出末尾：",
    tail,
  ].join("\n");
  let decision: JevDecision;
  const provider = jevProvider();
  const started = Date.now();
  if (provider === "laya") {
    logLaya(
      sessionLabel(session),
      `请求 ${providerBase() || "默认地址"} · ${options.map((item) => item.id).join("/")}`,
    );
  }
  try {
    decision = await invoke<JevDecision>("jev_choose", {
      provider,
      apiKey: providerKey() || null,
      baseUrl: providerBase(),
      state,
      options,
    });
  } catch (error) {
    if (provider === "laya") logLaya(sessionLabel(session), `失败 ${error}`, true);
    else log(`${sessionLabel(session)} ${providerLabel()} 决策失败，结束续跑：${error}`, true);
    return false;
  }
  if (provider === "laya") {
    const pct = (value: number) => `${Math.round(value * 100)}%`;
    logLaya(
      sessionLabel(session),
      `${decision.endpoint ?? ""} · ${decision.choice} · 置信 ${pct(decision.confidence)} · 继续 ${pct(decision.continueNow)} · ${Date.now() - started}ms`,
    );
  }
  const picked = options.find((item) => item.id === decision.choice);
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (
    !picked ||
    decision.confidence < JEV_MIN_CONFIDENCE ||
    decision.continueNow < JEV_MIN_CONTINUE
  ) {
    log(
      `${sessionLabel(session)} ${providerLabel()} 决定停止（${decision.choice}，置信 ${pct(decision.confidence)}，继续 ${pct(decision.continueNow)}）`,
    );
    return false;
  }
  try {
    await sendNow(session, plan, continuationPrompt(picked.text), false);
  } catch (error) {
    log(`${sessionLabel(session)} Jev 续跑发送失败：${error}`, true);
    return false;
  }
  plan.jevRuns += 1;
  log(`${sessionLabel(session)} ${providerLabel()} 续跑 ${plan.jevRuns}/${plan.jevMax}：${picked.text}`);
  if (session.id === selectedId) refreshSelectedPlan();
  return true;
}

function makeTask(text: string, commit: boolean): TaskItem {
  const body = text.trim();
  return {
    id: newId(),
    title: taskTitle(body),
    text: body,
    commit,
    status: "pending",
  };
}

function snapshotTemplate(plan: Plan) {
  plan.template = plan.tasks.map((t) => ({
    title: t.title,
    text: t.text,
    commit: t.commit,
  }));
}

function counts(plan: Plan) {
  return {
    total: plan.tasks.length,
    pending: plan.tasks.filter((t) => t.status === "pending").length,
    running: plan.tasks.filter((t) => t.status === "running" || t.status === "committing").length,
    done: plan.tasks.filter((t) => t.status === "done").length,
  };
}

function currentTask(plan: Plan) {
  return (
    plan.tasks.find((t) => t.status === "running" || t.status === "committing") ??
    plan.tasks.find((t) => t.status === "pending")
  );
}

function parseTaskList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown }).tasks)
        ? (parsed as { tasks: unknown[] }).tasks
        : null;
    if (list) {
      return list
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") {
            const rec = item as { title?: unknown; body?: unknown; text?: unknown };
            const title = typeof rec.title === "string" ? rec.title.trim() : "";
            const body =
              typeof rec.body === "string"
                ? rec.body.trim()
                : typeof rec.text === "string"
                  ? rec.text.trim()
                  : "";
            return [title, body].filter(Boolean).join("\n");
          }
          return "";
        })
        .filter(Boolean);
    }
  } catch {
    // not json
  }
  if (/\n\s*\n/.test(trimmed)) {
    return trimmed
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter((block) => block && !block.startsWith("#"));
  }
  return trimmed
    .split(/\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
}

function renderLoopStatus() {
  const plan = activePlan();
  const bound = $("plan-bound");
  if (bound) {
    const session = selected();
    bound.textContent = session ? sessionLabel(session) : "未绑定";
  }
  if (!plan) {
    $("loop-bar-fill").style.width = "0%";
    $("loop-status").textContent = "先选会话";
    syncExecPanels();
    return;
  }
  const totalRounds = loopRounds(plan);
  const { total, pending, running, done } = counts(plan);
  const fill = $("loop-bar-fill");
  const all = Math.max(1, total * totalRounds);
  const finished = (plan.currentRound - 1) * total + done;
  const pct = Math.max(0, Math.min(100, Math.round((finished / all) * 100)));
  fill.style.width = `${pct}%`;
  if (!plan.planRunning) {
    $("loop-status").textContent = total
      ? `${total} 条 · 循环 ${totalRounds} 次`
      : "空";
    return;
  }
  const cur = currentTask(plan);
  const committing = plan.tasks.some((t) => t.status === "committing");
  const now = plan.compacting
    ? "压缩上下文"
    : committing
      ? "提交中"
      : running
        ? "执行中"
        : pending
          ? "等待空闲"
          : "本轮收尾";
  $("loop-status").textContent =
    `第 ${plan.currentRound}/${totalRounds} 次 · 完成 ${done}/${total} · ${now}` +
    (cur ? ` · ${cur.title}` : "");
  syncExecPanels();
}

function setRunState(id: string, text: string, cls: "off" | "on" | "busy") {
  const el = $(id);
  el.textContent = text;
  el.className = `run-state ${cls}`;
}

function syncExecPanels() {
  const plan = activePlan();
  const jevOn = jevOnInput().checked;
  $("jev-cfg").classList.toggle("is-off", !jevOn);
  $("commit-cfg").classList.toggle("is-off", !commitAfterInput().checked);
  if (!plan || !jevOn) {
    setRunState("jev-run-state", "关闭", "off");
  } else if (!plan.planRunning) {
    setRunState("jev-run-state", `就绪 · ${providerLabel()} · 最多 ${plan.jevMax} 次`, "on");
  } else if (plan.jevRuns > 0) {
    setRunState("jev-run-state", `续跑中 ${plan.jevRuns}/${plan.jevMax} · ${providerLabel()}`, "busy");
  } else {
    setRunState("jev-run-state", `本轮结束后由 ${providerLabel()} 选择`, "on");
  }
  const committing = !!plan?.tasks.some((task) => task.status === "committing");
  if (!plan?.commitAfter) setRunState("commit-run-state", "关闭", "off");
  else if (committing) setRunState("commit-run-state", "正在提交，不 push", "busy");
  else setRunState("commit-run-state", "任务和续跑结束后提交", "on");
}

function groupedSessions() {
  const grouped = new Map<string, AgentSession[]>();
  for (const key of AGENT_ORDER) grouped.set(key, []);
  for (const session of sessions) {
    const key = AGENT_ORDER.includes(session.agent as (typeof AGENT_ORDER)[number])
      ? session.agent
      : "pi";
    grouped.get(key)?.push(session);
  }
  return grouped;
}

function listSig() {
  return (
    `${activeSheet}|${selectedId}|` +
    sessions
      .map((s) => {
        const plan = plans.get(s.id);
        return `${s.id}:${s.title}:${s.idle}:${s.agentState}:${plan?.planRunning ? 1 : 0}:${plan?.tasks.length ?? 0}`;
      })
      .join(";")
  );
}

function queueSig() {
  const plan = activePlan();
  if (!plan) return `${selectedId}|empty`;
  return `${selectedId}|${plan.currentRound}|${plan.planRunning}|` + plan.tasks.map((t) => `${t.id}:${t.status}:${t.commit}`).join(";");
}

function renderList(force = false) {
  const sig = listSig();
  if (!force && sig === lastListSig) return;
  lastListSig = sig;
  const grouped = groupedSessions();
  const bar = $("sheet-bar");
  bar.innerHTML = AGENT_ORDER.map((agent) => {
    const count = grouped.get(agent)?.length ?? 0;
    const on = agent === activeSheet ? " on" : "";
    const meta = AGENT_META[agent];
    return `<button type="button" class="sheet${on}" data-agent="${agent}" style="--agent: var(--${agent})">
      <b>${meta.label}</b>
      <em>${count}</em>
    </button>`;
  }).join("");
  bar.querySelectorAll<HTMLButtonElement>(".sheet").forEach((btn) => {
    btn.addEventListener("click", () => {
      const agent = btn.dataset.agent as (typeof AGENT_ORDER)[number];
      if (!agent || agent === activeSheet) return;
      activeSheet = agent;
      lastListSig = "";
      renderList(true);
    });
  });

  const box = $("session-list");
  box.dataset.agent = activeSheet;
  const scroll = box.scrollTop;
  const items = grouped.get(activeSheet) ?? [];
  const meta = AGENT_META[activeSheet];
  if (items.length === 0) {
    box.innerHTML = `<div class="empty boot">没有 ${meta.label}</div>`;
    return;
  }
  box.innerHTML = items
    .map((s) => {
      const active = s.id === selectedId ? " active" : "";
      const st = statusLabel(s);
      const plan = plans.get(s.id);
      const planHint = plan && plan.tasks.length
        ? `<span class="plan-bind${plan.planRunning ? " on" : ""}">${plan.planRunning ? "循环" : "计划"} ${plan.tasks.filter((t) => t.status === "done").length}/${plan.tasks.length}</span>`
        : "";
      return `<button type="button" class="session${active}" data-id="${escapeHtml(s.id)}">
        <div class="row">
          <span class="host">${escapeHtml(sessionLabel(s))}</span>
          <span class="pill ${st.cls}"><span class="pill-dot"></span>${st.text}</span>
        </div>
        <div class="cwd">${escapeHtml(shortPath(s.cwd))}${planHint ? ` · ${planHint}` : ""}</div>
      </button>`;
    })
    .join("");
  box.querySelectorAll<HTMLButtonElement>(".session").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectSession(btn.dataset.id ?? null);
      void poll();
    });
  });
  box.scrollTop = scroll;
}

function renderQueue(force = false) {
  const sig = queueSig();
  if (!force && sig === lastQueueSig) {
    renderLoopStatus();
    return;
  }
  lastQueueSig = sig;
  const plan = activePlan();
  const { total } = plan ? counts(plan) : { total: 0 };
  $("queue-count").textContent = String(total);
  const list = $("queue-list");
  if (!plan) {
    list.innerHTML = `<li class="empty">先选会话</li>`;
    renderLoopStatus();
    return;
  }
  if (plan.tasks.length === 0) {
    list.innerHTML = `<li class="empty">还没有任务</li>`;
    renderLoopStatus();
    return;
  }
  const running = plan.planRunning;
  list.innerHTML = plan.tasks
    .map((item, i) => {
      const mark =
        item.status === "done"
          ? "✓"
          : item.status === "running"
            ? "▶"
            : item.status === "committing"
              ? "↑"
              : String(i + 1).padStart(2, "0");
      const stage =
        item.status === "done"
          ? "已完成"
          : item.status === "running"
            ? "执行中"
            : item.status === "committing"
              ? "提交中"
              : "等待";
      const locked = running && item.status !== "pending";
      const editing = item.id === editingTaskId && item.status === "pending";
      const body = editing
        ? `<div class="task-edit">
            <textarea data-edit="${item.id}">${escapeHtml(editingDraft)}</textarea>
            <div class="task-ops">
              <button type="button" data-act="save" data-id="${item.id}" class="primary">保存</button>
              <button type="button" data-act="cancel" data-id="${item.id}">取消</button>
            </div>
          </div>`
        : `<div>
            <div class="title${item.status === "pending" ? " can-edit" : ""}" data-act="edit" data-id="${item.id}">${escapeHtml(item.title)}</div>
            <div class="meta">${stage}${item.commit ? " · 提交" : ""}</div>
          </div>
          <div class="task-ops">
            <button type="button" data-act="edit" data-id="${item.id}" ${item.status !== "pending" ? "disabled" : ""}>编辑</button>
            <button type="button" data-act="commit" data-id="${item.id}" ${locked ? "disabled" : ""}>${item.commit ? "提交" : "不提交"}</button>
            <button type="button" data-act="remove" data-id="${item.id}" ${locked ? "disabled" : ""}>×</button>
          </div>`;
      return `<li class="task ${item.status}${editing ? " editing" : ""}>
        <span class="mark">${mark}</span>
        ${body}
      </li>`;
    })
    .join("");
  list.querySelectorAll<HTMLTextAreaElement>("textarea[data-edit]").forEach((area) => {
    area.addEventListener("input", () => {
      editingDraft = area.value;
    });
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
  list.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      const task = plan.tasks.find((t) => t.id === id);
      if (!task) return;
      if (act === "edit") {
        if (task.status !== "pending") return;
        editingTaskId = task.id;
        editingDraft = task.text;
      } else if (act === "cancel") {
        editingTaskId = null;
        editingDraft = "";
      } else if (act === "save") {
        const text = editingDraft.trim();
        if (!text) return;
        task.text = text;
        task.title = taskTitle(text);
        if (!plan.planRunning) snapshotTemplate(plan);
        editingTaskId = null;
        editingDraft = "";
      } else if (act === "commit") {
        if (task.status !== "pending") return;
        task.commit = !task.commit;
        if (!plan.planRunning) snapshotTemplate(plan);
      } else if (act === "remove") {
        if (running && task.status !== "pending") return;
        plan.tasks = plan.tasks.filter((t) => t.id !== id);
        if (editingTaskId === id) {
          editingTaskId = null;
          editingDraft = "";
        }
        if (!plan.planRunning) snapshotTemplate(plan);
      }
      lastQueueSig = "";
      renderQueue(true);
    });
  });
  renderLoopStatus();
}

function addPlanTask(text: string) {
  const body = text.trim();
  const session = selected();
  const plan = activePlan();
  if (!body || !session || !plan) {
    if (!session) log("请先选择一个会话", true);
    return;
  }
  syncPlanInputsFromUi();
  plan.tasks.push(makeTask(body, plan.commitAfter));
  if (!plan.planRunning) snapshotTemplate(plan);
  lastQueueSig = "";
  renderQueue(true);
  log(`已加入 ${sessionLabel(session)} 的计划：${taskTitle(body)}`);
}

const termFit = new FitAddon();
let termLive = false;
let termEpoch = 0;
let termAttachId = "";
let termGeneration = 0;
let termPainted = false;
let termFullCount = 0;
let termBuffering = false;
let termHoldResize = false;
let termRevealTimer: number | null = null;
let termWantCols = 0;
let termWantRows = 0;
type TermFrame = { generation: number; full: boolean; width: number; height: number; bytes: string };
const termQueue: TermFrame[] = [];
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

function paintTermFrame(frame: TermFrame) {
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

async function startLiveTerm(session: AgentSession) {
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

function stopLiveTerm() {
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

function hideTerm() {
  $("term-host").classList.add("hidden");
}

type Cell = { x: number; y: number };
type SnakeDriver = "manual" | "jev" | "laya";
const SNAKE_GRID = 15;
const SNAKE_CELL = 16;
const SNAKE_SPEED = 180;
const SNAKE_DRIVER_KEY = "pi-auto-snake-driver";
const DINO_DRIVER_KEY = "pi-auto-dino-driver";
let snakeTimer: number | null = null;
let snakeProbe: number | null = null;
let snakeBody: Cell[] = [];
let snakeDir: Cell = { x: 1, y: 0 };
let snakeNext: Cell = { x: 1, y: 0 };
let snakeFood: Cell = { x: 7, y: 7 };
let snakeScore = 0;
let snakeOver = false;
let snakeEpoch = 0;
let snakeShown = false;
let snakeAiBusy = false;
let snakeRunning = false;
let gameBackends = { jev: false, laya: false };
let gameLayaBase = "http://127.0.0.1:8100";
let snakeSteerNote = "";

function storedDriver(game: IdleGameKind): SnakeDriver {
  const value = localStorage.getItem(game === "dino" ? DINO_DRIVER_KEY : SNAKE_DRIVER_KEY);
  if (game === "dino") return value === "laya" ? "laya" : "manual";
  return value === "jev" || value === "laya" ? value : "manual";
}

function snakeDriver(): SnakeDriver {
  const value = $<HTMLSelectElement>("idle-driver").value;
  if (idleGame() === "dino") return value === "laya" ? "laya" : "manual";
  return value === "jev" || value === "laya" ? value : "manual";
}

type IdleGameKind = "snake" | "dino";
const IDLE_GAME_KEY = "pi-auto-idle-game";

function idleGame(): IdleGameKind {
  const value = $<HTMLSelectElement>("idle-game-kind").value;
  return value === "dino" ? "dino" : "snake";
}

function dinoUsesLaya() {
  return idleGame() === "dino" && snakeDriver() === "laya";
}

function syncDriverOptions() {
  const snake = idleGame() === "snake";
  const jevOpt = $<HTMLOptionElement>("idle-driver-jev");
  const layaOpt = $<HTMLOptionElement>("idle-driver-laya");
  jevOpt.hidden = !snake;
  jevOpt.disabled = !snake || !gameBackends.jev;
  layaOpt.disabled = !gameBackends.laya;
  jevOpt.textContent = gameBackends.jev ? "Jev" : "Jev 未接入";
  layaOpt.textContent = gameBackends.laya ? "Laya" : "Laya 未接入";
  syncStartButton();
}

function loadDriverSelect(game: IdleGameKind = idleGame()) {
  const select = $<HTMLSelectElement>("idle-driver");
  const driver = storedDriver(game);
  syncDriverOptions();
  if (select.value !== driver) select.value = driver;
}

function syncSnakeControls() {
  const snake = idleGame() === "snake";
  $("idle-game").classList.toggle("hidden", !snake);
  $("idle-dino").classList.toggle("hidden", snake);
  $("idle-snake-log").classList.toggle("hidden", !snake);
  $("idle-dino-log").classList.toggle("hidden", snake);
  syncDriverOptions();
}

function placeSnakeFood() {
  const used = new Set(snakeBody.map((cell) => `${cell.x},${cell.y}`));
  const open: Cell[] = [];
  for (let y = 0; y < SNAKE_GRID; y += 1) {
    for (let x = 0; x < SNAKE_GRID; x += 1) {
      if (!used.has(`${x},${y}`)) open.push({ x, y });
    }
  }
  snakeFood = open[Math.floor(Math.random() * open.length)] ?? { x: 0, y: 0 };
}

function resetSnake() {
  snakeBody = [
    { x: 4, y: 7 },
    { x: 3, y: 7 },
    { x: 2, y: 7 },
  ];
  snakeDir = { x: 1, y: 0 };
  snakeNext = snakeDir;
  snakeScore = 0;
  snakeOver = false;
  placeSnakeFood();
  drawSnake();
}

function drawSnake() {
  const canvas = $<HTMLCanvasElement>("idle-game");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const size = SNAKE_GRID * SNAKE_CELL;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#15181e";
  ctx.lineWidth = 1;
  for (let i = 1; i < SNAKE_GRID; i += 1) {
    const at = i * SNAKE_CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at, size);
    ctx.moveTo(0, at);
    ctx.lineTo(size, at);
    ctx.stroke();
  }
  drawSnakeFood(ctx);
  for (let index = snakeBody.length - 1; index >= 0; index -= 1) drawSnakePart(ctx, index);
  $("idle-game-score").textContent = snakeOver ? `${snakeScore} · 点开始重来` : String(snakeScore);
  const driver = $<HTMLSelectElement>("idle-driver").value;
  const driving = driver === "jev" || driver === "laya";
  $("idle-game-hint").textContent = snakeSteerNote
    ? snakeSteerNote
    : driving
      ? `${driver === "laya" ? "Laya" : "Jev"} 控制 · 收到决策才移动`
      : "方向键移动 · 选会话后停止";
}

function waitingToStart() {
  if (idleGame() === "dino") return !dinoRunning || dinoOver;
  return !snakeRunning || snakeOver;
}

function syncStartButton() {
  const button = $<HTMLButtonElement>("idle-start");
  button.classList.toggle("hidden", !waitingToStart());
  if (idleGame() === "dino") {
    button.disabled = dinoUsesLaya() && !gameBackends.laya;
    return;
  }
  const driver = snakeDriver();
  button.disabled = (driver === "jev" && !gameBackends.jev) || (driver === "laya" && !gameBackends.laya);
}

function beginGame() {
  if (idleGame() === "dino") {
    beginDino();
    return;
  }
  const driver = snakeDriver();
  if (driver === "jev" && !gameBackends.jev) return;
  if (driver === "laya" && !gameBackends.laya) return;
  stopDino();
  snakeRunning = true;
  resetSnake();
  startControlLoop();
  syncStartButton();
}

const SNAKE_ASK_FRUIT =
  "先吃到果子，再选更近的。不要选会困住的，除非每个选项都会困住。距离相同就选走后可达格更多的，再保持当前朝向。";
const SNAKE_ASK_LIVE =
  "这些方向都不会立刻死，但都不更近。选不会困住且距离最小的。都会困住时，选走后可达格更多的。";

const SNAKE_DIRS = [
  { id: "up" as const, name: "上", dir: { x: 0, y: -1 } },
  { id: "down" as const, name: "下", dir: { x: 0, y: 1 } },
  { id: "left" as const, name: "左", dir: { x: -1, y: 0 } },
  { id: "right" as const, name: "右", dir: { x: 1, y: 0 } },
];

function cellKey(cell: Cell) {
  return `${cell.x},${cell.y}`;
}

function snakeChar(x: number, y: number) {
  if (x < 0 || y < 0 || x >= SNAKE_GRID || y >= SNAKE_GRID) return "#";
  if (x === snakeBody[0]?.x && y === snakeBody[0]?.y) return "H";
  const tail = snakeBody[snakeBody.length - 1];
  if (tail && x === tail.x && y === tail.y) return "T";
  if (snakeBody.some((cell) => cell.x === x && cell.y === y)) return "o";
  if (x === snakeFood.x && y === snakeFood.y) return "*";
  return ".";
}

function drawSnakeFood(ctx: CanvasRenderingContext2D) {
  const x = snakeFood.x * SNAKE_CELL;
  const y = snakeFood.y * SNAKE_CELL;
  ctx.fillStyle = "#c98b86";
  ctx.fillRect(x + 6, y + 6, 4, 4);
  ctx.fillRect(x + 7, y + 3, 2, 10);
  ctx.fillRect(x + 3, y + 7, 10, 2);
}

function drawSnakePart(ctx: CanvasRenderingContext2D, index: number) {
  const cell = snakeBody[index];
  const x = cell.x * SNAKE_CELL;
  const y = cell.y * SNAKE_CELL;
  const head = index === 0;
  const tail = index === snakeBody.length - 1;
  ctx.fillStyle = head ? "#e7ebf2" : tail ? "#5f8f86" : "#7eaea6";
  const inset = head ? 2 : 3;
  ctx.fillRect(x + inset, y + inset, SNAKE_CELL - inset * 2, SNAKE_CELL - inset * 2);
  if (index > 0) {
    const prev = snakeBody[index - 1];
    ctx.fillRect(((cell.x + prev.x) * SNAKE_CELL) / 2 + 6, ((cell.y + prev.y) * SNAKE_CELL) / 2 + 6, 4, 4);
  }
  if (!head) return;
  ctx.fillStyle = "#0a0c10";
  const px = snakeDir.y;
  const py = -snakeDir.x;
  ctx.fillRect(x + 7 + snakeDir.x * 3 + px * 2, y + 7 + snakeDir.y * 3 + py * 2, 2, 2);
  ctx.fillRect(x + 7 + snakeDir.x * 3 - px * 2, y + 7 + snakeDir.y * 3 - py * 2, 2, 2);
}

function dirName(dir: Cell) {
  if (dir.x === 1) return "右";
  if (dir.x === -1) return "左";
  if (dir.y === 1) return "下";
  return "上";
}

function foodSide(dx: number, dy: number) {
  const horizontal = dx === 0 ? "" : dx > 0 ? `右 ${dx}` : `左 ${-dx}`;
  const vertical = dy === 0 ? "" : dy > 0 ? `下 ${dy}` : `上 ${-dy}`;
  return [horizontal, vertical].filter(Boolean).join("、") || "已重合";
}

function boardMap() {
  const rows: string[] = [];
  for (let y = 0; y < SNAKE_GRID; y += 1) {
    let line = "";
    for (let x = 0; x < SNAKE_GRID; x += 1) line += snakeChar(x, y);
    rows.push(line);
  }
  return rows.join("\n");
}

function localMap() {
  const head = snakeBody[0];
  const rows: string[] = [];
  for (let dy = -2; dy <= 2; dy += 1) {
    const cells: string[] = [];
    for (let dx = -2; dx <= 2; dx += 1) cells.push(snakeChar(head.x + dx, head.y + dy));
    rows.push(`y${head.y + dy}: ${cells.join(" ")}`);
  }
  return rows.join("\n");
}

function clearAhead(dir: Cell) {
  const blocked = new Set(snakeBody.map(cellKey));
  let count = 0;
  let x = snakeBody[0].x + dir.x;
  let y = snakeBody[0].y + dir.y;
  while (x >= 0 && y >= 0 && x < SNAKE_GRID && y < SNAKE_GRID && !blocked.has(`${x},${y}`)) {
    count += 1;
    x += dir.x;
    y += dir.y;
  }
  return count;
}

function spaceAfter(dir: Cell) {
  const head = snakeBody[0];
  const next = { x: head.x + dir.x, y: head.y + dir.y };
  const eats = next.x === snakeFood.x && next.y === snakeFood.y;
  const body = eats ? [next, ...snakeBody] : [next, ...snakeBody.slice(0, -1)];
  const blocked = new Set(body.slice(1).map(cellKey));
  const queue = [next];
  const seen = new Set([cellKey(next)]);
  let space = 0;
  while (queue.length > 0) {
    const cell = queue.shift();
    if (!cell) break;
    space += 1;
    for (const step of SNAKE_DIRS) {
      const nx = cell.x + step.dir.x;
      const ny = cell.y + step.dir.y;
      const key = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= SNAKE_GRID || ny >= SNAKE_GRID || seen.has(key) || blocked.has(key)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return { space, length: body.length, traps: space < body.length };
}

function snakeState(chasing: boolean, avoidedTrap: boolean) {
  const head = snakeBody[0];
  const dx = snakeFood.x - head.x;
  const dy = snakeFood.y - head.y;
  return [
    "贪吃蛇。先吃到果子，同时不要死，也不要走进死路。",
    `棋盘 ${SNAKE_GRID}x${SNAKE_GRID}。x 向右增大，y 向下增大。上方是 y=0。`,
    "H 蛇头，o 蛇身，T 尾巴，* 果子，. 空格，# 棋盘外。头碰到墙、蛇身或尾巴都失败。尾巴这一步不会让开。",
    boardMap(),
    "头周围 5x5：",
    localMap(),
    `头 (${head.x},${head.y}) 朝${dirName(snakeDir)}。果子 (${snakeFood.x},${snakeFood.y})，在${foodSide(dx, dy)}，距离 ${Math.abs(dx) + Math.abs(dy)}。身长 ${snakeBody.length}。`,
    `四向到障碍的空格：${SNAKE_DIRS.map((item) => `${item.name}${clearAhead(item.dir)}`).join(" ")}。`,
    "走后可达格少于走后身长，就是困住。",
    avoidedTrap
      ? "有方向会困住，那些没有放进选项。"
      : chasing
        ? "选项都不会立刻死，并且在吃到或靠近果子。"
        : "靠近果子的方向会立刻死。选项都不会立刻死。",
  ].join("\n");
}

type SnakeMove = {
  id: "up" | "down" | "left" | "right";
  dir: Cell;
  dist: number;
  eats: boolean;
  closer: boolean;
  open: number;
  space: number;
  length: number;
  traps: boolean;
};

function candidateMoves(): SnakeMove[] {
  const head = snakeBody[0];
  const now = Math.abs(snakeFood.x - head.x) + Math.abs(snakeFood.y - head.y);
  return SNAKE_DIRS.filter((move) => move.dir.x !== -snakeDir.x || move.dir.y !== -snakeDir.y)
    .map((move) => {
      const x = head.x + move.dir.x;
      const y = head.y + move.dir.y;
      const wall = x < 0 || y < 0 || x >= SNAKE_GRID || y >= SNAKE_GRID;
      const body = snakeBody.some((cell) => cell.x === x && cell.y === y);
      const room = spaceAfter(move.dir);
      const dist = Math.abs(snakeFood.x - x) + Math.abs(snakeFood.y - y);
      return {
        id: move.id,
        dir: move.dir,
        dist,
        eats: x === snakeFood.x && y === snakeFood.y,
        closer: dist < now,
        open: clearAhead(move.dir),
        space: room.space,
        length: room.length,
        traps: room.traps,
        blocked: wall || body,
      };
    })
    .filter((move) => !move.blocked)
    .map(({ id, dir, dist, eats, closer, open, space, length, traps }) => ({
      id,
      dir,
      dist,
      eats,
      closer,
      open,
      space,
      length,
      traps,
    }));
}

function movesForDecision() {
  const safe = candidateMoves();
  const open = safe.filter((move) => !move.traps);
  const pool = open.length > 0 ? open : safe;
  const eaters = pool.filter((move) => move.eats);
  const closer = pool.filter((move) => move.closer);
  const moves = eaters.length > 0 ? eaters : closer.length > 0 ? closer : pool;
  return {
    chasing: eaters.length > 0 || closer.length > 0,
    avoidedTrap: open.length > 0 && open.length < safe.length,
    moves,
  };
}

function describeMove(move: SnakeMove) {
  const head = snakeBody[0];
  const x = head.x + move.dir.x;
  const y = head.y + move.dir.y;
  const fruit = move.eats ? "这一步吃到果子" : move.closer ? `不吃，距离 ${move.dist}，更近` : `不吃，距离 ${move.dist}，不更近`;
  const room = move.traps
    ? `走后可达 ${move.space}，少于身长 ${move.length}，会困住`
    : `走后可达 ${move.space}，身长 ${move.length}，不会困住`;
  const turn = move.dir.x === snakeDir.x && move.dir.y === snakeDir.y ? "朝向不变" : "要转向";
  return `${dirName(move.dir)}到 (${x},${y})。不是墙，不是蛇身。${fruit}。前方空 ${move.open} 格。${room}。${turn}。`;
}

function applyStep(dir: Cell) {
  if (snakeOver || snakeBody.length === 0) return;
  snakeDir = dir;
  snakeNext = dir;
  const head = { x: snakeBody[0].x + dir.x, y: snakeBody[0].y + dir.y };
  const hitWall = head.x < 0 || head.y < 0 || head.x >= SNAKE_GRID || head.y >= SNAKE_GRID;
  const hitSelf = snakeBody.some((cell) => cell.x === head.x && cell.y === head.y);
  if (hitWall || hitSelf) {
    snakeOver = true;
    snakeRunning = false;
    snakeSteerNote = hitSelf ? "碰到蛇身，失败" : "撞墙，失败";
    drawSnake();
    syncStartButton();
    return;
  }
  snakeBody.unshift(head);
  if (head.x === snakeFood.x && head.y === snakeFood.y) {
    snakeScore += 1;
    placeSnakeFood();
  } else {
    snakeBody.pop();
  }
  drawSnake();
}

async function aiTurn(epoch: number) {
  const driver = snakeDriver();
  if (!snakeRunning || driver === "manual" || snakeOver || epoch !== snakeEpoch) return;
  if (snakeAiBusy) {
    window.setTimeout(() => void aiTurn(epoch), 200);
    return;
  }
  const plan = movesForDecision();
  const moves = plan.moves;
  if (moves.length === 0) {
    snakeOver = true;
    snakeRunning = false;
    snakeSteerNote = "无路可走";
    drawSnake();
    syncStartButton();
    return;
  }
  if (moves.length === 1) {
    const only = moves[0];
    logSnake(`只有 ${only.id} 可走，直接走 · 距离 ${only.dist} · 可达 ${only.space}`);
    applyStep(only.dir);
    if (!snakeOver && epoch === snakeEpoch && snakeDriver() !== "manual") queueAiTurn();
    return;
  }
  snakeAiBusy = true;
  snakeSteerNote = `等待 ${driver === "laya" ? "Laya" : "Jev"}，蛇停住`;
  drawSnake();
  const started = Date.now();
  logSnake(
    `${plan.avoidedTrap ? "绕开死路" : plan.chasing ? "吃果子" : "先保命再吃"} · ${moves.map((move) => `${move.id}:${move.dist}/${move.space}`).join(" ")}`,
  );
  try {
    const decision = await invoke<JevDecision>("jev_choose", {
      provider: driver,
      apiKey: localStorage.getItem(keyStorage(driver))?.trim() || null,
      baseUrl: providerBase(driver),
      state: snakeState(plan.chasing, plan.avoidedTrap),
      options: moves.map((move) => ({ id: move.id, text: describeMove(move) })),
      instructions: plan.chasing ? SNAKE_ASK_FRUIT : SNAKE_ASK_LIVE,
      includeStop: false,
    });
    if (epoch !== snakeEpoch || snakeOver || $("preview-empty").classList.contains("hidden")) return;
    const picked = moves.find((move) => move.id === decision.choice);
    snakeSteerNote = "";
    logSnake(
      `${decision.endpoint ?? (driver === "laya" ? gameLayaBase : "Jev")} · ${decision.choice} · 距离 ${picked?.dist ?? "?"} · 置信 ${Math.round(decision.confidence * 100)}% · ${Date.now() - started}ms`,
    );
    applyStep((picked ?? moves.slice().sort((a, b) => a.dist - b.dist)[0]).dir);
  } catch (error) {
    if (epoch !== snakeEpoch) return;
    snakeSteerNote = `${driver === "laya" ? "Laya" : "Jev"} 决策失败，正在重试`;
    logSnake(`失败 ${error}`, true);
    drawSnake();
    if (snakeDriver() !== "manual") window.setTimeout(() => void aiTurn(epoch), 600);
    return;
  } finally {
    snakeAiBusy = false;
  }
  if (!snakeOver && epoch === snakeEpoch && snakeDriver() !== "manual") queueAiTurn();
}

function queueAiTurn() {
  if (snakeAiBusy || !snakeRunning || snakeDriver() === "manual") return;
  const epoch = snakeEpoch;
  window.setTimeout(() => void aiTurn(epoch), 30);
}

async function refreshGameBackends() {
  const localJev = Boolean(localStorage.getItem(JEV_KEY_STORAGE)?.trim());
  const layaBase = providerBase("laya") || "";
  try {
    const status = await invoke<{ jev: boolean; laya: boolean; layaBase?: string | null }>(
      "decision_status",
      { layaBase: layaBase || null },
    );
    gameBackends = { jev: localJev || status.jev, laya: status.laya };
    if (status.layaBase) {
      gameLayaBase = status.layaBase;
      const saved = localStorage.getItem(LAYA_BASE_STORAGE) ?? "";
      if (!saved || saved.includes(":8000")) {
        localStorage.setItem(LAYA_BASE_STORAGE, status.layaBase);
      }
    }
  } catch {
    gameBackends = { jev: localJev, laya: false };
  }
  syncDriverOptions();
  if (idleGame() === "snake") drawSnake();
  else drawDino();
  if (!$("preview-empty").classList.contains("hidden") && idleGame() === "snake" && snakeDriver() !== "manual" && snakeTimer != null) {
    startControlLoop();
  }
}

function stepSnake() {
  applyStep(snakeNext);
}

function startControlLoop() {
  snakeEpoch += 1;
  if (snakeTimer != null) {
    window.clearInterval(snakeTimer);
    snakeTimer = null;
  }
  if (!snakeRunning) {
    snakeSteerNote = "点开始";
    drawSnake();
    return;
  }
  if (snakeDriver() === "manual") {
    snakeSteerNote = "";
    snakeTimer = window.setInterval(stepSnake, SNAKE_SPEED);
    drawSnake();
    return;
  }
  snakeSteerNote = `等待 ${snakeDriver() === "laya" ? "Laya" : "Jev"}，蛇停住`;
  drawSnake();
  queueAiTurn();
}

const DINO_W = 480;
const DINO_H = 150;
const DINO_GROUND = 118;
const DINO_BEST_KEY = "pi-auto-dino-best";
type DinoObstacle = { x: number; w: number; h: number; y: number; bird: boolean };
let dinoRaf: number | null = null;
let dinoRunning = false;
let dinoOver = false;
let dinoScore = 0;
let dinoBest = Number(localStorage.getItem(DINO_BEST_KEY) || 0) || 0;
let dinoY = 0;
let dinoVy = 0;
let dinoDuck = false;
let dinoSpeed = 2.4;
let dinoObstacles: DinoObstacle[] = [];
let dinoGap = 220;
let dinoLeg = 0;
let dinoLast = 0;
let dinoEpoch = 0;
let dinoSteerNote = "";
let dinoAsking = false;
const DINO_ASK = "恐龙正在实时跑动，不会停。请综合跳跃高度、地面柱子和头顶上挡，选择现在不会撞上的动作。跳能越过柱子，但可能撞上挡；蹲能躲开低处上挡，但过不了柱子；跑保持当前姿态。多个都能过时，优先跑，其次蹲，最后跳。";
type DinoAction = "run" | "jump" | "duck";

function logDino(detail: string) {
  const box = $("idle-dino-log-list");
  const item = document.createElement("div");
  item.className = "idle-log-item";
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<span class="time">${time}</span>${escapeHtml(detail)}`;
  box.prepend(item);
  while (box.childElementCount > 40) box.removeChild(box.lastElementChild as Node);
}

function dinoBox() {
  if (dinoDuck && dinoY < 2) return { x: 24, y: DINO_GROUND - 16, w: 38, h: 14 };
  return { x: 28, y: DINO_GROUND - 34 - dinoY, w: 20, h: 32 };
}

function resetDino() {
  dinoRunning = false;
  dinoOver = false;
  dinoScore = 0;
  dinoY = 0;
  dinoVy = 0;
  dinoDuck = false;
  dinoSpeed = 2.4;
  dinoObstacles = [];
  dinoGap = 260;
  dinoLeg = 0;
  if (dinoRaf != null) {
    cancelAnimationFrame(dinoRaf);
    dinoRaf = null;
  }
  $("idle-dino-best").textContent = String(dinoBest);
  drawDino();
}

function stopDino() {
  dinoEpoch += 1;
  dinoRunning = false;
  dinoDuck = false;
  dinoAsking = false;
  dinoSteerNote = "";
  if (dinoRaf != null) {
    cancelAnimationFrame(dinoRaf);
    dinoRaf = null;
  }
}

function rememberDinoScore() {
  const score = Math.floor(dinoScore);
  if (score > dinoBest) {
    dinoBest = score;
    localStorage.setItem(DINO_BEST_KEY, String(dinoBest));
    logDino(`新纪录 ${dinoBest}`);
  } else if (score > 0) {
    logDino(`本局 ${score} · 最高 ${dinoBest}`);
  }
  $("idle-dino-best").textContent = String(dinoBest);
}

function spawnDinoObstacle() {
  const bird = dinoScore > 280 && Math.random() < 0.16;
  if (bird) {
    const low = Math.random() < 0.7;
    dinoObstacles.push({ x: DINO_W + 20, w: 26, h: 10, y: low ? DINO_GROUND - 22 : DINO_GROUND - 46, bird: true });
    return;
  }
  const h = Math.random() < 0.75 ? 20 : 32;
  dinoObstacles.push({ x: DINO_W + 20, w: 12, h, y: DINO_GROUND - h, bird: false });
}

function dinoHits(obstacle: DinoObstacle) {
  const box = dinoBox();
  return box.x < obstacle.x + obstacle.w - 6 && box.x + box.w > obstacle.x + 6 && box.y < obstacle.y + obstacle.h - 6 && box.y + box.h > obstacle.y + 6;
}

function drawDinoGround(ctx: CanvasRenderingContext2D) {
  const scroll = Math.floor(dinoScore * 14);
  ctx.strokeStyle = "#2a303a";
  ctx.beginPath();
  ctx.moveTo(0, DINO_GROUND + 1);
  ctx.lineTo(DINO_W, DINO_GROUND + 1);
  ctx.stroke();
  ctx.fillStyle = "#1c2129";
  for (let i = 0; i < 18; i += 1) {
    const x = ((i * 28 - (scroll % 28)) + 28) % (DINO_W + 28) - 8;
    ctx.fillRect(x, DINO_GROUND + 5, 10, 1);
  }
}

function drawDinoTree(ctx: CanvasRenderingContext2D, obstacle: DinoObstacle) {
  const x = obstacle.x;
  const y = obstacle.y;
  const w = obstacle.w;
  const h = obstacle.h;
  const trunkW = 4;
  const trunkX = x + Math.floor((w - trunkW) / 2);
  ctx.fillStyle = "#6d7582";
  ctx.fillRect(trunkX, y + 8, trunkW, h - 8);
  ctx.fillStyle = "#86a892";
  const crownH = Math.min(12, Math.max(7, h - 12));
  ctx.fillRect(x, y, w, crownH);
  ctx.fillRect(x + 1, y + 3, w - 2, crownH - 2);
  ctx.fillStyle = "#a4c2ad";
  ctx.fillRect(x + 2, y + 2, Math.max(2, w - 8), 3);
}

function drawDinoBird(ctx: CanvasRenderingContext2D, obstacle: DinoObstacle) {
  const x = obstacle.x;
  const y = obstacle.y;
  const flap = Math.floor(dinoLeg + obstacle.x / 12) % 2 === 0;
  ctx.fillStyle = "#8aa4c2";
  ctx.fillRect(x + 6, y + 3, 14, 5);
  ctx.fillRect(x + 16, y + 4, 6, 2);
  ctx.fillStyle = "#a9bdd4";
  if (flap) {
    ctx.fillRect(x, y, 10, 3);
    ctx.fillRect(x + 14, y, 10, 3);
  } else {
    ctx.fillRect(x + 1, y + 6, 9, 3);
    ctx.fillRect(x + 15, y + 6, 9, 3);
  }
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(x + 17, y + 4, 1, 1);
}

function drawDinoRunner(ctx: CanvasRenderingContext2D) {
  const box = dinoBox();
  const ducking = dinoDuck && dinoY < 2;
  const step = Math.floor(dinoLeg) % 2 === 0;
  ctx.fillStyle = "#e7ebf2";
  if (ducking) {
    ctx.fillRect(box.x + 2, box.y + 4, 22, 7);
    ctx.fillRect(box.x + 20, box.y + 2, 12, 6);
    ctx.fillRect(box.x + 31, box.y + 4, 5, 2);
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(box.x + 26, box.y + 4, 2, 2);
    ctx.fillStyle = "#8b93a1";
    ctx.fillRect(box.x + (step ? 8 : 16), box.y + 11, 6, 2);
    return;
  }
  ctx.fillRect(box.x - 7, box.y + 12, 8, 3);
  ctx.fillRect(box.x, box.y + 10, 14, 10);
  ctx.fillRect(box.x + 10, box.y + 4, 5, 8);
  ctx.fillRect(box.x + 12, box.y, 8, 7);
  ctx.fillRect(box.x + 18, box.y + 2, 2, 3);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(box.x + 16, box.y + 2, 2, 2);
  ctx.fillStyle = "#e7ebf2";
  ctx.fillRect(box.x + (step ? 2 : 8), box.y + 20, 3, 10);
  ctx.fillRect(box.x + (step ? 9 : 3), box.y + 20, 3, 10);
}

function drawDino() {
  const canvas = $<HTMLCanvasElement>("idle-dino");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== DINO_W * dpr) {
    canvas.width = DINO_W * dpr;
    canvas.height = DINO_H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, DINO_W, DINO_H);
  drawDinoGround(ctx);
  for (const obstacle of dinoObstacles) {
    if (obstacle.bird) drawDinoBird(ctx, obstacle);
    else drawDinoTree(ctx, obstacle);
  }
  drawDinoRunner(ctx);
  const shown = Math.floor(dinoScore);
  $("idle-game-score").textContent = dinoOver ? `${shown} · 最高 ${dinoBest}` : String(shown);
  $("idle-game-hint").textContent = dinoSteerNote
    ? dinoSteerNote
    : dinoRunning && !dinoOver
      ? dinoUsesLaya()
        ? snakeAiBusy
          ? "Laya 决策中"
          : "Laya 控制 · 靠近障碍再决策"
        : "空格 / ↑ 跳 · ↓ 蹲"
      : `最高 ${dinoBest} · 空格开始`;
}

function dinoDist(obstacle: DinoObstacle) {
  return obstacle.x - (dinoBox().x + dinoBox().w);
}

function poseAt(y: number, duck: boolean) {
  if (duck && y < 2) return { x: 24, y: DINO_GROUND - 16, w: 38, h: 14 };
  return { x: 28, y: DINO_GROUND - 34 - y, w: 20, h: 32 };
}

function band(obstacle: DinoObstacle) {
  const bottom = Math.round(DINO_GROUND - (obstacle.y + obstacle.h));
  const top = Math.round(DINO_GROUND - obstacle.y);
  return { bottom, top };
}

function obstacleName(obstacle: DinoObstacle) {
  if (!obstacle.bird) return "柱子";
  return obstacle.y >= DINO_GROUND - 30 ? "低处上挡" : "高处上挡";
}

function foresee(action: DinoAction) {
  let y = dinoY;
  let vy = dinoVy;
  let duck = action === "duck" ? y < 2 : action === "run" && y < 2 ? false : dinoDuck && action !== "jump";
  if (action === "jump" && y < 2) {
    vy = -7.4;
    duck = false;
  }
  const obstacles = dinoObstacles.map((item) => ({ ...item }));
  for (let frame = 0; frame < 100; frame += 1) {
    vy += duck && y < 2 ? 0.62 : 0.34;
    y = Math.max(0, y - vy);
    if (y === 0) vy = 0;
    const box = poseAt(y, duck);
    for (const obstacle of obstacles) {
      obstacle.x -= dinoSpeed;
      if (box.x < obstacle.x + obstacle.w - 6 && box.x + box.w > obstacle.x + 6 && box.y < obstacle.y + obstacle.h - 6 && box.y + box.h > obstacle.y + 6) {
        return { ok: false, hit: `${obstacleName(obstacle)}，约 ${frame} 帧后` };
      }
    }
    if (obstacles.every((item) => item.x + item.w < box.x)) return { ok: true, hit: "" };
  }
  return { ok: true, hit: "" };
}

function dinoScene() {
  const jumpPeak = Math.round((7.4 * 7.4) / (2 * 0.34));
  const ahead = dinoObstacles
    .filter((item) => dinoDist(item) > -8)
    .sort((a, b) => a.x - b.x)
    .slice(0, 3);
  const lines = ahead.map((item, index) => {
    const span = band(item);
    return `${index + 1}. ${obstacleName(item)}，距离 ${Math.round(dinoDist(item))}，占据离地 ${span.bottom}-${span.top}，宽 ${item.w}`;
  });
  return [
    `跳跃：在地面起跳，初速度 7.4，最高约离地 ${jumpPeak}。当前离地 ${Math.round(dinoY)}，竖直速度 ${dinoVy.toFixed(1)}（负为上升）。${dinoY < 2 ? "现在可以跳或蹲。" : "已在空中，不能再跳，也不能蹲。"}`,
    ahead.length ? `前方障碍，从近到远：\n${lines.join("\n")}` : "前方没有障碍。",
    "柱子从地面长上来，要用跳越过。上挡在空中，低处上挡要蹲，高处上挡不要跳进去。",
  ].join("\n");
}

function dinoActions(): DinoAction[] {
  return dinoY >= 2 ? ["run"] : ["run", "jump", "duck"];
}

function nearestThreat() {
  return dinoObstacles
    .filter((item) => dinoDist(item) > -24)
    .sort((a, b) => a.x - b.x)[0];
}

function dinoNeedsDecision() {
  const next = nearestThreat();
  if (!next) return false;
  return dinoDist(next) <= 260 || dinoY >= 2 || dinoDuck;
}

function dinoChoices() {
  const actions = dinoActions();
  const label: Record<DinoAction, string> = { run: "继续跑", jump: "现在起跳", duck: "现在蹲下" };
  return actions.map((id) => {
    const outcome = foresee(id);
    return {
      id,
      text: `${label[id]}。按当前速度和跳跃轨迹推演：${outcome.ok ? "能过前方柱子和上挡" : `会撞上${outcome.hit}`}`,
    };
  });
}

function applyDinoAction(id: DinoAction) {
  if (id === "jump") {
    if (dinoY >= 2) return;
    dinoDuck = false;
    dinoVy = -7.4;
    return;
  }
  if (dinoY < 2) dinoDuck = id === "duck";
}

function releaseDinoDuck() {
  if (!dinoDuck || !dinoUsesLaya()) return;
  const box = dinoBox();
  const blocking = dinoObstacles.some((item) => item.bird && item.y >= DINO_GROUND - 30 && item.x + item.w > box.x - 8);
  if (!blocking) dinoDuck = false;
}

function liveChoiceFits(id: DinoAction) {
  return foresee(id).ok;
}

function continueDinoAsk(epoch: number, delay = 30) {
  dinoAsking = false;
  if (epoch !== dinoEpoch || !dinoRunning || dinoOver || !dinoUsesLaya()) return;
  if (!dinoNeedsDecision()) return;
  dinoAsking = true;
  window.setTimeout(() => void dinoTurn(epoch), delay);
}

async function dinoTurn(epoch: number) {
  if (epoch !== dinoEpoch || !dinoRunning || dinoOver || !dinoUsesLaya() || !dinoNeedsDecision()) {
    dinoAsking = false;
    return;
  }
  if (snakeAiBusy) {
    window.setTimeout(() => void dinoTurn(epoch), 200);
    return;
  }
  const options = dinoChoices();
  const viable = options.filter((item) => foresee(item.id).ok);
  if (viable.length <= 1) {
    const only = viable[0];
    if (only && only.id !== "run") {
      applyDinoAction(only.id);
      logDino(`只有 ${only.id} 能过，直接执行`);
    }
    dinoSteerNote = "";
    continueDinoAsk(epoch, 140);
    return;
  }
  snakeAiBusy = true;
  dinoSteerNote = "Laya 决策中";
  const started = Date.now();
  logDino(`问 · ${options.map((item) => `${item.id}${foresee(item.id).ok ? "可过" : "会撞"}`).join(" ")}`);
  try {
    const decision = await invoke<JevDecision>("jev_choose", {
      provider: "laya",
      apiKey: localStorage.getItem(keyStorage("laya"))?.trim() || null,
      baseUrl: providerBase("laya"),
      state: [
        "恐龙正在实时跑动，不会停下来等你。综合跳跃、柱子和上挡再选。",
        `分数 ${Math.floor(dinoScore)}。水平速度 ${dinoSpeed.toFixed(1)}。`,
        dinoScene(),
      ].join("\n"),
      options: options.map((item) => ({ id: item.id, text: item.text })),
      instructions: DINO_ASK,
      includeStop: false,
    });
    if (epoch !== dinoEpoch || dinoOver || idleGame() !== "dino") return;
    const picked = options.find((item) => item.id === decision.choice) ?? options.find((item) => liveChoiceFits(item.id)) ?? options[0];
    if (!liveChoiceFits(picked.id)) {
      logDino(`${picked.id} 返回时已不适用，不执行`);
    } else {
      logDino(`${decision.endpoint ?? gameLayaBase} · ${picked.id} · 置信 ${Math.round(decision.confidence * 100)}% · ${Date.now() - started}ms`);
      applyDinoAction(picked.id);
    }
    dinoSteerNote = "";
  } catch (error) {
    if (epoch !== dinoEpoch) return;
    dinoSteerNote = "Laya 决策失败，正在重试";
    logDino(`失败 ${error}`);
    window.setTimeout(() => void dinoTurn(epoch), 600);
    return;
  } finally {
    snakeAiBusy = false;
  }
  continueDinoAsk(epoch);
}

function queueDinoTurn() {
  if (!dinoRunning || dinoOver || !dinoUsesLaya() || snakeAiBusy || dinoAsking || !dinoNeedsDecision()) return;
  dinoAsking = true;
  const epoch = dinoEpoch;
  window.setTimeout(() => void dinoTurn(epoch), 30);
}

function stepDino(now: number) {
  if (!dinoRunning || dinoOver || idleGame() !== "dino") return;
  dinoRaf = null;
  releaseDinoDuck();
  const dt = Math.min(32, dinoLast ? now - dinoLast : 16) / 16;
  dinoLast = now;
  dinoSpeed = Math.min(4.6, 2.4 + dinoScore * 0.0016);
  dinoVy += (dinoDuck ? 0.62 : 0.34) * dt;
  dinoY = Math.max(0, dinoY - dinoVy * dt);
  if (dinoY === 0) dinoVy = 0;
  dinoScore += dinoSpeed * dt * 0.08;
  dinoLeg += dt;
  dinoGap -= dinoSpeed * dt;
  if (dinoGap <= 0) {
    spawnDinoObstacle();
    dinoGap = 240 + Math.random() * 140;
  }
  for (const obstacle of dinoObstacles) obstacle.x -= dinoSpeed * dt;
  dinoObstacles = dinoObstacles.filter((obstacle) => obstacle.x + obstacle.w > -8);
  if (dinoUsesLaya()) queueDinoTurn();
  if (dinoObstacles.some(dinoHits)) {
    dinoOver = true;
    dinoRunning = false;
    rememberDinoScore();
    drawDino();
    syncStartButton();
    return;
  }
  drawDino();
  dinoRaf = requestAnimationFrame(stepDino);
}

function beginDino() {
  if (dinoUsesLaya() && !gameBackends.laya) return;
  resetDino();
  dinoEpoch += 1;
  dinoRunning = true;
  dinoLast = 0;
  dinoSteerNote = "";
  dinoAsking = false;
  drawDino();
  syncStartButton();
  dinoRaf = requestAnimationFrame(stepDino);
  if (dinoUsesLaya()) queueDinoTurn();
}

function dinoJump() {
  if (!dinoRunning || dinoOver || dinoY > 0 || (dinoDuck && dinoY < 2)) return;
  dinoVy = -7.4;
}

function onDinoKey(event: KeyboardEvent) {
  if (event.key === " " || event.key === "ArrowUp" || event.key === "w") {
    event.preventDefault();
    if (!dinoRunning || dinoOver) {
      beginDino();
      return;
    }
    if (!dinoUsesLaya()) dinoJump();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "s") {
    event.preventDefault();
    if (dinoRunning && !dinoOver && !dinoUsesLaya()) dinoDuck = true;
  }
}

function showIdleGame() {
  if (snakeShown) return;
  snakeShown = true;
  syncSnakeControls();
  if (idleGame() === "dino") resetDino();
  else {
    resetSnake();
    startControlLoop();
  }
  void refreshGameBackends();
  if (snakeProbe == null) snakeProbe = window.setInterval(() => void refreshGameBackends(), 8000);
}

function hideIdleGame() {
  snakeShown = false;
  snakeEpoch += 1;
  snakeRunning = false;
  if (snakeTimer != null) {
    window.clearInterval(snakeTimer);
    snakeTimer = null;
  }
  if (snakeProbe != null) {
    window.clearInterval(snakeProbe);
    snakeProbe = null;
  }
  stopDino();
}

function onIdleGameKey(event: KeyboardEvent) {
  if ($("preview-empty").classList.contains("hidden")) return;
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (idleGame() === "dino") {
    onDinoKey(event);
    return;
  }
  const turn: Record<string, Cell> = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    w: { x: 0, y: -1 },
    s: { x: 0, y: 1 },
    a: { x: -1, y: 0 },
    d: { x: 1, y: 0 },
  };
  const next = turn[event.key];
  if (next) {
    event.preventDefault();
    if (waitingToStart()) return;
    if (next.x === -snakeDir.x && next.y === -snakeDir.y) return;
    if (snakeDriver() === "manual") {
      snakeNext = next;
      return;
    }
    snakeEpoch += 1;
    applyStep(next);
    if (!snakeOver) queueAiTurn();
    return;
  }
  if ((event.key === " " || event.key === "Enter") && waitingToStart()) {
    event.preventDefault();
    beginGame();
  }
}

function renderMain() {
  const session = selected();
  setAppTheme(session?.agent);

  const ctx = session ? parseContextPercent(session.preview) : null;
  const headSig = session
    ? `${session.id}:${session.title}:${session.idle}:${session.agentState}:${session.reason}:${ctx ?? ""}`
    : "none";
  const headChanged = headSig !== lastHeadSig;
  lastHeadSig = headSig;

  const st = statusLabel(session);
  if (headChanged) {
    $("status-pill").className = `pill ${st.cls}`;
    $("status-text").textContent = st.text;
  }

  const empty = $("preview-empty");

  if (!session) {
    $("target-kicker").textContent = "未选择";
    $("target-title").textContent = "选择一个会话";
    $("target-meta").textContent = "";
    empty.classList.remove("hidden");
    stopLiveTerm();
    hideTerm();
    showIdleGame();
    return;
  }

  hideIdleGame();
  empty.classList.add("hidden");
  if (termAttachId !== session.id) {
    termAttachId = session.id;
    void startLiveTerm(session);
  }
  if (headChanged) {
    $("target-kicker").textContent = session.agentLabel;
    $("target-title").textContent = sessionLabel(session);
    const ctxBit = ctx == null ? "" : ` · ${ctx.toFixed(0)}%`;
    $("status-text").textContent = activePlan()?.compacting ? "压缩中" : `${st.text}${ctxBit}`;
    $("target-meta").textContent = shortPath(session.cwd);
  }

  showLiveHost();
}

function renderAll() {
  renderList();
  renderMain();
  renderQueue();
}

function showImport(raw = "") {
  $("import-modal").classList.remove("hidden");
  const area = $<HTMLTextAreaElement>("import-raw");
  if (raw) area.value = raw;
  $<HTMLInputElement>("import-commit").checked = commitAfterInput().checked;
  refreshImportPreview();
  area.focus();
}

function hideImport() {
  $("import-modal").classList.add("hidden");
}

function refreshImportPreview() {
  importDraft = parseTaskList($<HTMLTextAreaElement>("import-raw").value);
  const box = $("import-preview");
  if (importDraft.length === 0) {
    box.innerHTML = "还没有解析到任务。";
    return;
  }
  const commit = $<HTMLInputElement>("import-commit").checked;
  box.innerHTML = `<b>将导入 ${importDraft.length} 条</b>${commit ? "，每条附带提交代码要求" : ""}<br>` +
    importDraft
      .slice(0, 8)
      .map((t, i) => `${i + 1}. ${escapeHtml(taskTitle(t))}`)
      .join("<br>") +
    (importDraft.length > 8 ? `<br>…还有 ${importDraft.length - 8} 条` : "");
}

function confirmImport() {
  refreshImportPreview();
  if (importDraft.length === 0) {
    log("没有可导入的任务", true);
    return;
  }
  const plan = activePlan();
  const session = selected();
  if (!plan || !session) {
    log("请先选择一个 Herdr pane", true);
    return;
  }
  const commit = $<HTMLInputElement>("import-commit").checked;
  for (const text of importDraft) {
    plan.tasks.push(makeTask(text, commit));
  }
  if (!plan.planRunning) snapshotTemplate(plan);
  lastQueueSig = "";
  renderQueue();
  log(`已导入 ${importDraft.length} 条到 ${sessionLabel(session)}${commit ? "（含完成后提交代码）" : ""}`);
  hideImport();
}

async function sendNow(session: AgentSession, plan: Plan | null, text: string, force: boolean) {
  const result = await invoke<string>("send_to_session", {
    id: session.id,
    text,
    force,
  });
  log(`${sessionLabel(session)} · ${result}`);
  if (plan) {
    plan.phase = "sent";
    plan.sentAt = Date.now();
    plan.idleSince = null;
  }
  armStallWatch(session);
}

function syncRunButtons() {
  const plan = activePlan();
  const running = !!plan?.planRunning;
  $("start-loop").toggleAttribute("disabled", running || !plan);
  $("pause-loop").toggleAttribute("disabled", !running);
  $("stop-loop").toggleAttribute(
    "disabled",
    !plan || (!running && plan.currentRound === 1 && !plan.tasks.some((t) => t.status !== "pending")),
  );
  $("start-loop").textContent = running
    ? "循环中…"
    : plan?.tasks.some((t) => t.status === "done")
      ? "继续循环"
      : "开始循环";
  const planBtn = $("toggle-plan");
  if (planBtn) planBtn.classList.toggle("on", document.getElementById("app")?.classList.contains("plan-open") ?? false);
  const railBtn = $("toggle-rail");
  if (railBtn) railBtn.classList.toggle("on", document.getElementById("app")?.classList.contains("rail-open") ?? false);
}

function startLoop() {
  const session = selected();
  const plan = activePlan();
  if (!session || !plan) {
    log("请先选择一个 Herdr pane", true);
    return;
  }
  if (plan.planRunning) return;
  if (plan.tasks.length === 0) {
    log("请先加入或导入任务再开始循环", true);
    return;
  }
  syncPlanInputsFromUi();
  snapshotTemplate(plan);
  const allDone = plan.tasks.every((t) => t.status === "done");
  if (allDone) {
    plan.currentRound = 1;
    plan.jevRuns = 0;
    for (const task of plan.tasks) task.status = "pending";
  }
  const running = plan.tasks.find((t) => t.status === "running" || t.status === "committing");
  if (!running) {
    plan.phase = "idle";
    plan.idleSince = null;
    plan.sentAt = null;
  }
  plan.planRunning = true;
  plan.compacting = false;
  plan.compactFrom = null;
  plan.needCompact = true;
  armStallWatch(session);
  lastQueueSig = "";
  if (plan.jev && jevProvider() !== "laya" && !providerKey()) {
    log(`${sessionLabel(session)} 已开启续跑，但没有 ${providerLabel()} API Key。决策时会跳过续跑`, true);
  }
  log(
    `${sessionLabel(session)} 开始循环：${plan.tasks.length} 条 · 循环 ${loopRounds(plan)} 次${plan.jev ? ` · ${providerLabel()} 续跑` : ""}`,
  );
  setAppTheme(session.agent);
  syncRunButtons();
  renderQueue(true);
  void maybeAutoSend();
}

function pauseLoop() {
  const plan = activePlan();
  if (!plan?.planRunning) return;
  plan.planRunning = false;
  plan.compacting = false;
  plan.compactFrom = null;
  clearStallWatch(selectedId);
  log(`${selected() ? sessionLabel(selected()!) : "当前窗口"} 已暂停循环`);
  setAppTheme(selected()?.agent);
  syncRunButtons();
  lastQueueSig = "";
  renderQueue(true);
}

function stopLoop() {
  const plan = activePlan();
  if (!plan) return;
  plan.planRunning = false;
  plan.compacting = false;
  plan.compactFrom = null;
  plan.needCompact = true;
  plan.currentRound = 1;
  plan.phase = "idle";
  plan.idleSince = null;
  plan.sentAt = null;
  plan.jevRuns = 0;
  clearStallWatch(selectedId);
  for (const task of plan.tasks) task.status = "pending";
  log(`${selected() ? sessionLabel(selected()!) : "当前窗口"} 已停止循环，进度已清零`);
  setAppTheme(selected()?.agent);
  syncRunButtons();
  lastQueueSig = "";
  renderQueue(true);
}

function finishPlan(session: AgentSession, plan: Plan) {
  plan.planRunning = false;
  plan.currentRound = 1;
  plan.phase = "idle";
  log(`${sessionLabel(session)} 计划已全部完成`);
  if (session.id === selectedId) {
    setAppTheme(session.agent);
    syncRunButtons();
    lastQueueSig = "";
    renderQueue(true);
  }
}

function startNextRound(session: AgentSession, plan: Plan) {
  const total = loopRounds(plan);
  if (plan.currentRound >= total) {
    finishPlan(session, plan);
    return false;
  }
  plan.currentRound += 1;
  plan.tasks = plan.template.map((item) => ({
    id: newId(),
    title: item.title,
    text: item.text,
    commit: item.commit,
    status: "pending" as TaskStatus,
  }));
  plan.phase = "idle";
  plan.idleSince = null;
  log(`${sessionLabel(session)} 开始第 ${plan.currentRound}/${total} 次循环`);
  if (session.id === selectedId) renderQueue();
  return plan.tasks.length > 0;
}

function showHerdrGuide() {
  hideUsageGuide();
  $("herdr-guide").classList.remove("hidden");
}

function hideHerdrGuide() {
  $("herdr-guide").classList.add("hidden");
  maybeShowUsageGuide();
}

function usageSeen() {
  return localStorage.getItem(USAGE_SEEN_KEY) === "1";
}

function markUsageSeen() {
  localStorage.setItem(USAGE_SEEN_KEY, "1");
}

function showUsageGuide() {
  $("herdr-guide").classList.add("hidden");
  $("usage-guide").classList.remove("hidden");
}

function hideUsageGuide() {
  $("usage-guide").classList.add("hidden");
}

function maybeShowUsageGuide() {
  if (usageSeen()) return;
  if (!$("herdr-guide").classList.contains("hidden")) return;
  showUsageGuide();
}

function showAbout() {
  $("about-modal").classList.remove("hidden");
  renderAbout();
}

function hideAbout() {
  $("about-modal").classList.add("hidden");
}

function renderAbout() {
  const current = appInfo?.version ?? updateInfo?.currentVersion ?? "0.1.0";
  $("about-current").textContent = `v${current}`;
  $("about-latest").textContent = updateInfo ? `v${updateInfo.latestVersion}` : "尚未检查";
  $("about-status").textContent = updateChecking
    ? "正在检查…"
    : updateInstalling
      ? "正在下载…"
      : updateInfo?.available
        ? "有新版本"
        : updateInfo
          ? "已是最新"
          : "—";
  const err = $("about-error");
  err.classList.add("hidden");
  const asset = $("about-asset");
  if (updateInfo?.assetName) {
    asset.textContent = `安装包：${updateInfo.assetName}`;
    asset.classList.remove("hidden");
  } else {
    asset.classList.add("hidden");
  }
  const notes = $("about-notes");
  if (updateInfo?.notes) {
    notes.textContent = updateInfo.notes;
    notes.classList.remove("hidden");
  } else {
    notes.classList.add("hidden");
  }
  $("install-update").toggleAttribute("disabled", updateInstalling || !updateInfo?.available);
  $("check-update").toggleAttribute("disabled", updateChecking);
  const banner = $("update-banner");
  const skipped = localStorage.getItem(SKIP_VERSION_KEY);
  if (updateInfo?.available && updateInfo.latestVersion !== skipped) {
    $("update-banner-text").textContent = `发现新版本 v${updateInfo.latestVersion}`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function showAboutError(message: string) {
  const err = $("about-error");
  err.textContent = message;
  err.classList.remove("hidden");
}

async function runUpdateCheck(force: boolean, quiet: boolean) {
  if (updateChecking) return null;
  updateChecking = true;
  renderAbout();
  try {
    const info = await invoke<UpdateCheck>("check_update", { force });
    updateInfo = info;
    localStorage.setItem(UPDATE_CHECKED_KEY, String(Date.now()));
    if (!quiet && !info.available) log(`已是最新版本 ${info.currentVersion}`);
    if (!quiet && info.available) log(`发现新版本 ${info.latestVersion}`);
    return info;
  } catch (error) {
    if (!quiet) {
      showAboutError(String(error));
      log(`检查更新失败：${error}`, true);
    }
    return null;
  } finally {
    updateChecking = false;
    renderAbout();
  }
}

async function loadAppInfo() {
  try {
    appInfo = await invoke<AppInfo>("app_info");
    $("about-current").textContent = `v${appInfo.version}`;
  } catch {
    /* ignore */
  }
}

async function maybeCheckUpdate() {
  const last = Number(localStorage.getItem(UPDATE_CHECKED_KEY) || 0);
  if (last && Date.now() - last < UPDATE_CHECK_EVERY_MS) return;
  await runUpdateCheck(false, true);
}

async function refreshHerdrStatus() {
  try {
    const status = await invoke<HerdrStatus>("herdr_status");
    const el = $("herdr-banner");
    const text = status.connected
      ? `已连接 · ${status.agentCount}`
      : status.error
        ? `未连接`
        : "未连接";
    if (text !== lastHerdrText) {
      lastHerdrText = text;
      el.className = `herdr-banner ${status.connected ? "on" : "off"}`;
      $("herdr-banner-text").textContent = text;
    }
    if (status.connected) {
      $("herdr-guide").classList.add("hidden");
      maybeShowUsageGuide();
    } else if (!herdrGuideAutoShown) {
      herdrGuideAutoShown = true;
      showHerdrGuide();
    }
  } catch (error) {
    const el = $("herdr-banner");
    const text = "未连接";
    if (text === lastHerdrText) return;
    lastHerdrText = text;
    el.className = "herdr-banner off";
    $("herdr-banner-text").textContent = text;
    if (!herdrGuideAutoShown) {
      herdrGuideAutoShown = true;
      showHerdrGuide();
    }
  }
}

function refreshSelectedPlan() {
  if (selectedId) {
    lastQueueSig = "";
    lastListSig = "";
    syncRunButtons();
    renderList();
    renderQueue();
  }
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    sessions = await invoke<AgentSession[]>("list_sessions", {
      previewId: selectedId,
      previewIds: pollPreviewIds(),
    });
    if (selectedId && !sessions.some((s) => s.id === selectedId)) {
      log(`会话 ${selectedId} 已退出，计划仍保留`, true);
      selectSession(null);
    }
    followCreatedPane();
    void refreshHerdrStatus();
    renderList();
    renderMain();
    await maybeAutoSend();
    await maybeUnstickStalled();
    renderQueue();
  } catch (error) {
    log(String(error), true);
  } finally {
    pollInFlight = false;
  }
}

function followCreatedPane() {
  const follow = followPane;
  if (!follow) return;
  if (Date.now() > follow.until) {
    followPane = null;
    return;
  }
  const found = sessions.find((item) => item.paneId === follow.paneId);
  if (!found) return;
  if (found.agent !== activeSheet && (AGENT_ORDER as readonly string[]).includes(found.agent)) {
    activeSheet = found.agent as (typeof AGENT_ORDER)[number];
    lastListSig = "";
  }
  if (selectedId !== found.id) selectSession(found.id);
  if (found.agent === follow.want || (follow.want === "shell" && found.agent === "shell")) {
    followPane = null;
  }
}

const TERM_CWD_KEY = "pi-auto-term-cwd";

function termCwdChoices() {
  const seen = new Set<string>();
  const items: string[] = [];
  const add = (cwd: string) => {
    const path = cwd.trim();
    if (!path || path === "未知目录" || seen.has(path)) return;
    seen.add(path);
    items.push(path);
  };
  const current = selected();
  if (current?.cwd) add(current.cwd);
  for (const session of sessions) add(session.cwd);
  add(localStorage.getItem(TERM_CWD_KEY) ?? "");
  return items;
}

function setTermCwd(cwd: string) {
  $<HTMLInputElement>("term-cwd").value = cwd;
  const label = $("term-cwd-label");
  label.textContent = cwd ? shortPath(cwd) : "沿用当前工作区";
  label.title = cwd;
  document.querySelectorAll<HTMLButtonElement>("#term-cwd-list button").forEach((button) => {
    button.classList.toggle("on", (button.dataset.cwd ?? "") === cwd);
  });
  if (cwd) localStorage.setItem(TERM_CWD_KEY, cwd);
  else localStorage.removeItem(TERM_CWD_KEY);
}

function renderTermPaths(preferred: string) {
  const box = $("term-cwd-list");
  const choices = termCwdChoices();
  if (preferred && !choices.includes(preferred)) choices.unshift(preferred);
  box.innerHTML = [
    `<button type="button" data-cwd="">沿用当前工作区</button>`,
    ...choices.map((cwd) => `<button type="button" data-cwd="${escapeHtml(cwd)}">${escapeHtml(shortPath(cwd))}</button>`),
  ].join("");
  box.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.addEventListener("click", () => setTermCwd(button.dataset.cwd ?? ""));
  });
  setTermCwd(preferred);
}

async function pickTermCwd() {
  const current = $<HTMLInputElement>("term-cwd").value || selected()?.cwd || undefined;
  const picked = await open({
    directory: true,
    multiple: false,
    title: "选择目录",
    defaultPath: current,
    canCreateDirectories: true,
  });
  if (typeof picked === "string" && picked) renderTermPaths(picked);
}

function showTermCreate() {
  const kind = $<HTMLSelectElement>("term-kind");
  $<HTMLInputElement>("term-command").value = LAUNCH_COMMAND[kind.value] ?? "";
  $("term-command-row").classList.toggle("hidden", kind.value === "shell");
  const preferred = selected()?.cwd || localStorage.getItem(TERM_CWD_KEY) || "";
  renderTermPaths(preferred);
  $("term-modal").classList.remove("hidden");
}

function hideTermCreate() {
  $("term-modal").classList.add("hidden");
}

async function createTerminal(event: Event) {
  event.preventDefault();
  const kind = $<HTMLSelectElement>("term-kind").value;
  const cwd = $<HTMLInputElement>("term-cwd").value.trim();
  const command = kind === "shell" ? "" : $<HTMLInputElement>("term-command").value.trim();
  const button = $<HTMLButtonElement>("term-create").querySelector("button[type=submit]");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    const created = await invoke<{ paneId: string; workspaceId: string; cwd: string; launchError?: string | null }>(
      "create_terminal",
      {
        cwd: cwd || null,
        command: command || null,
        label: null,
      },
    );
    followPane = { paneId: created.paneId, want: kind === "shell" ? "shell" : kind, until: Date.now() + 20000 };
    hideTermCreate();
    log(`已新建终端 ${created.paneId}${created.cwd ? ` · ${shortPath(created.cwd)}` : ""}`);
    if (created.launchError) log(`启动命令失败：${created.launchError}`, true);
    await poll();
  } catch (error) {
    log(`新建终端失败：${error}`, true);
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

async function maybeUnstickStalled() {
  const now = Date.now();
  const live = new Set(sessions.map((s) => s.id));
  for (const id of [...stallWatch.keys()]) {
    if (!plans.get(id)?.planRunning || !live.has(id)) stallWatch.delete(id);
  }
  for (const session of sessions) {
    const plan = plans.get(session.id);
    if (!plan?.planRunning) continue;
    const prev = stallWatch.get(session.id);
    if (prev && now - prev.at < STALL_CHECK_MS) continue;
    const snap = outputSnapshot(session.preview);
    if (!snap) {
      stallWatch.set(session.id, {
        text: prev?.text ?? "",
        at: now - STALL_CHECK_MS + 15_000,
      });
      continue;
    }
    if (!prev?.text) {
      stallWatch.set(session.id, { text: snap, at: now });
      continue;
    }
    const ratio = outputChangeRatio(prev.text, snap);
    stallWatch.set(session.id, { text: snap, at: now });
    if (session.idle || ratio >= STALL_DIFF_RATIO) continue;
    if (stallNudging.has(session.id)) continue;
    stallNudging.add(session.id);
    try {
      const result = await invoke<string>("nudge_session", {
        id: session.id,
        text: NUDGE_TEXT,
      });
      log(
        `${sessionLabel(session)} 输出 5 分钟几乎无变化（差异 ${(ratio * 100).toFixed(2)}%），${result}`,
      );
    } catch (error) {
      log(`${sessionLabel(session)} 卡死唤醒失败：${error}`, true);
      const watch = stallWatch.get(session.id);
      if (watch) watch.at = Date.now() - STALL_CHECK_MS + 60_000;
    } finally {
      stallNudging.delete(session.id);
    }
  }
}

function completeRunning(session: AgentSession, plan: Plan, running: TaskItem) {
  running.status = "done";
  plan.phase = "idle";
  plan.idleSince = Date.now();
  plan.sentAt = null;
  plan.needCompact = true;
  log(`${sessionLabel(session)} 完成：${running.title}`);
  if (session.id === selectedId) refreshSelectedPlan();
}

async function startCommit(session: AgentSession, plan: Plan, task: TaskItem) {
  task.status = "committing";
  log(`${sessionLabel(session)} 开始提交：${task.title}`);
  if (session.id === selectedId) refreshSelectedPlan();
  await sendNow(session, plan, commitPrompt(task), false);
}

async function startCompact(session: AgentSession, plan: Plan) {
  plan.compacting = true;
  plan.compactFrom = parseContextPercent(session.preview);
  plan.needCompact = false;
  log(`${sessionLabel(session)} 上下文 ${plan.compactFrom?.toFixed(0) ?? "?"}% ≥ ${compactThreshold(plan)}%，先压缩`);
  await sendNow(session, plan, compactCommand(session.agent), false);
}

async function tickPlan(session: AgentSession, plan: Plan) {
  const now = Date.now();
  const stableMs = Math.max(1, plan.idleMs || 2) * 1000;
  const ctx = parseContextPercent(session.preview);

  if (plan.compacting) {
    const elapsed = plan.sentAt ? now - plan.sentAt : 0;
    const back = agentBack(session);
    const evidence = compactEvidence(session, plan, ctx);
    if (!back) {
      plan.phase = "working";
      plan.idleSince = null;
      if (evidence.ready && elapsed >= 8000) {
        const why = evidence.saidDone ? " · 终端已结束" : ` · 上下文 ${ctx?.toFixed(0) ?? "?"}%`;
        finishCompact(session, plan, why);
      }
      return;
    }
    if (plan.phase === "sent") {
      if (elapsed < 3000 && !evidence.ready) return;
      plan.phase = "settling";
      plan.idleSince = now;
    } else if (plan.phase === "working") {
      plan.phase = "settling";
      plan.idleSince = now;
    }
    const settled = plan.phase === "settling" && (!plan.idleSince || now - plan.idleSince >= stableMs);
    if (evidence.ready && (settled || elapsed >= 3000)) {
      const why = evidence.saidDone
        ? " · 终端已结束"
        : ctx != null
          ? ` · 上下文 ${ctx.toFixed(0)}%`
          : "";
      finishCompact(session, plan, why);
      return;
    }
    if (settled && ctx != null && ctx >= compactThreshold(plan) && !evidence.saidDone && elapsed < 45_000) return;
    if (settled && elapsed >= 15_000) {
      const stillHigh = ctx != null && ctx >= compactThreshold(plan);
      finishCompact(session, plan, stillHigh ? ` · 已回到提示符，上下文仍 ${ctx.toFixed(0)}%` : " · 已回到提示符");
      return;
    }
    if (elapsed >= 120_000) {
      finishCompact(session, plan, " · 等待过久，继续后续任务");
    }
    return;
  }

  const running = plan.tasks.find((t) => t.status === "running" || t.status === "committing");
  if (running) {
    if (!session.idle) {
      plan.phase = "working";
      plan.idleSince = null;
      return;
    }
    if (plan.phase === "sent") {
      if (plan.sentAt && now - plan.sentAt < 3000) return;
      plan.phase = "settling";
      plan.idleSince = now;
    } else if (plan.phase === "working") {
      plan.phase = "settling";
      plan.idleSince = now;
    }
    if (plan.phase === "settling") {
      if (plan.idleSince && now - plan.idleSince < stableMs) return;
      if (running.status === "running" && (await maybeJevContinue(session, plan, running))) {
        return;
      }
      if (running.status === "running" && running.commit) {
        try {
          await startCommit(session, plan, running);
        } catch (error) {
          log(`${sessionLabel(session)} 提交发送失败：${error}`, true);
          completeRunning(session, plan, running);
        }
        return;
      }
      completeRunning(session, plan, running);
    }
    return;
  }

  if (!session.idle) return;
  if (plan.idleSince && now - plan.idleSince < stableMs) return;

  if (plan.needCompact && ctx != null && ctx >= compactThreshold(plan)) {
    try {
      await startCompact(session, plan);
    } catch (error) {
      plan.compacting = false;
      plan.compactFrom = null;
      log(`${sessionLabel(session)} 压缩发送失败：${error}`, true);
    }
    return;
  }

  let next = plan.tasks.find((t) => t.status === "pending");
  if (!next) {
    if (!startNextRound(session, plan)) return;
    next = plan.tasks.find((t) => t.status === "pending");
    if (!next) return;
  }
  try {
    next.status = "running";
    plan.jevRuns = 0;
    if (session.id === selectedId) refreshSelectedPlan();
    await sendNow(session, plan, withJevAsk(next.text, plan.jev), false);
  } catch (error) {
    next.status = "pending";
    plan.phase = "idle";
    plan.planRunning = false;
    log(`${sessionLabel(session)} ${String(error)}`, true);
    if (session.id === selectedId) {
      setAppTheme(session.agent);
      refreshSelectedPlan();
    }
  }
}

async function maybeAutoSend() {
  for (const session of sessions) {
    const plan = plans.get(session.id);
    if (!plan?.planRunning) continue;
    await tickPlan(session, plan);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("new-window-btn").addEventListener("click", () => {
    void invoke("new_window").catch((error) => log(`新建窗口失败：${error}`, true));
  });
  $("new-term-btn").addEventListener("click", () => showTermCreate());
  $("term-pick").addEventListener("click", () => {
    void pickTermCwd().catch((error) => log(`选择目录失败：${error}`, true));
  });
  $("term-cancel").addEventListener("click", () => hideTermCreate());
  $("term-create").addEventListener("submit", (event) => {
    void createTerminal(event);
  });
  $("term-modal").addEventListener("click", (event) => {
    if (event.target === $("term-modal")) hideTermCreate();
  });
  $<HTMLSelectElement>("term-kind").addEventListener("change", () => {
    const kind = $<HTMLSelectElement>("term-kind").value;
    $<HTMLInputElement>("term-command").value = LAUNCH_COMMAND[kind] ?? "";
    $("term-command-row").classList.toggle("hidden", kind === "shell");
  });
  $("refresh-btn").addEventListener("click", () => {
    $("refresh-btn").classList.remove("spin");
    void $("refresh-btn").offsetWidth;
    $("refresh-btn").classList.add("spin");
    void poll();
  });
  $("import-btn").addEventListener("click", () => showImport());
  $("plan-add").addEventListener("submit", (event) => {
    event.preventDefault();
    const area = $<HTMLTextAreaElement>("plan-add-text");
    addPlanTask(area.value);
    area.value = "";
  });
  $("import-pick").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    showImport(text);
    (event.target as HTMLInputElement).value = "";
  });
  $("import-raw").addEventListener("input", () => refreshImportPreview());
  $("import-commit").addEventListener("change", () => refreshImportPreview());
  $("import-confirm").addEventListener("click", () => confirmImport());
  $("import-cancel").addEventListener("click", () => hideImport());
  $("import-btn").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    $("import-file").click();
  });
  $("herdr-guide-btn").addEventListener("click", () => showHerdrGuide());
  $("herdr-guide-close").addEventListener("click", () => hideHerdrGuide());
  $("about-close").addEventListener("click", () => hideAbout());
  void listen<TermFrame>("term-bytes", (event) => {
    const frame = event.payload;
    if (termBuffering) {
      termQueue.push(frame);
      return;
    }
    if (!termLive || !term || frame.generation !== termGeneration) return;
    paintTermFrame(frame);
  });
  void listen<string>("term-closed", (event) => {
    if (!termLive) return;
    termLive = false;
    log(event.payload || "终端连接已断开", true);
  });
  void listen<string>("app-menu", (event) => {
    if (event.payload === "ai-keys") showKeys();
    if (event.payload === "usage") showUsageGuide();
    if (event.payload === "check-update") {
      showAbout();
      void runUpdateCheck(true, false);
    }
  });
  $("check-update").addEventListener("click", () => {
    void runUpdateCheck(true, false);
  });
  $("open-release").addEventListener("click", () => {
    void invoke("open_release_page", { url: updateInfo?.htmlUrl ?? null });
  });
  $("install-update").addEventListener("click", async () => {
    if (updateInstalling || !updateInfo?.available) return;
    updateInstalling = true;
    renderAbout();
    try {
      const path = await invoke<string>("install_update");
      log(`已打开安装包：${path}`);
    } catch (error) {
      showAboutError(String(error));
      log(`下载更新失败：${error}`, true);
    } finally {
      updateInstalling = false;
      renderAbout();
    }
  });
  $("update-banner-open").addEventListener("click", () => showAbout());
  $("update-banner-skip").addEventListener("click", () => {
    if (updateInfo?.latestVersion) localStorage.setItem(SKIP_VERSION_KEY, updateInfo.latestVersion);
    $("update-banner").classList.add("hidden");
  });
  $("usage-start").addEventListener("click", () => {
    markUsageSeen();
    hideUsageGuide();
  });
  $("usage-install").addEventListener("click", () => showHerdrGuide());
  $("herdr-recheck").addEventListener("click", () => {
    void refreshHerdrStatus();
    void poll();
  });
  $("herdr-docs").addEventListener("click", () => {
    void openUrl(HERDR_DOCS);
  });
  $("copy-herdr-install").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(HERDR_INSTALL_CMD);
      $("copy-herdr-install").textContent = "已复制";
      window.setTimeout(() => {
        $("copy-herdr-install").textContent = "复制安装命令";
      }, 1600);
    } catch {
      log("复制失败，请手动复制安装命令", true);
    }
  });
  $("start-loop").addEventListener("click", () => startLoop());
  $("pause-loop").addEventListener("click", () => pauseLoop());
  $("stop-loop").addEventListener("click", () => stopLoop());
  $("toggle-rail").addEventListener("click", () => {
    $("app").classList.toggle("rail-open");
    syncRunButtons();
  });
  $("toggle-plan").addEventListener("click", () => {
    $("app").classList.toggle("plan-open");
    syncRunButtons();
  });
  const persistPlanInputs = () => {
    syncPlanInputsFromUi();
    renderLoopStatus();
  };
  loopRoundsInput().addEventListener("change", persistPlanInputs);
  idleMsInput().addEventListener("change", persistPlanInputs);
  compactAtInput().addEventListener("change", persistPlanInputs);
  commitAfterInput().addEventListener("change", persistPlanInputs);
  jevOnInput().addEventListener("change", persistPlanInputs);
  jevMaxInput().addEventListener("change", persistPlanInputs);
  jevProviderInput().value = localStorage.getItem(JEV_PROVIDER_STORAGE) ?? "jev";
  jevProviderInput().addEventListener("change", () => {
    localStorage.setItem(JEV_PROVIDER_STORAGE, jevProvider());
    syncExecPanels();
  });
  $("keys-save").addEventListener("click", saveKeys);
  $("keys-close").addEventListener("click", hideKeys);
  $("keys-check-all").addEventListener("click", () => void checkAllProviders());
  $("keys-modal").addEventListener("click", (event) => {
    if (event.target === $("keys-modal")) hideKeys();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-check]").forEach((button) => {
    button.addEventListener("click", () => void checkProvider(button.dataset.check as DecisionProvider));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-reveal]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = keyInput(button.dataset.reveal as DecisionProvider);
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      button.textContent = hidden ? "隐藏" : "显示";
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-default]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = button.dataset.default as DecisionProvider;
      baseInput(provider).value = KEY_DEFAULTS[provider];
      setKeyStatus(provider, "未检查");
      setKeyNote(provider, "");
    });
  });
  for (const provider of KEY_IDS) {
    const mark = () => {
      setKeyStatus(provider, "未检查");
      setKeyNote(provider, "");
    };
    keyInput(provider).addEventListener("input", mark);
    baseInput(provider).addEventListener("input", mark);
  }
  window.addEventListener("keydown", (event) => {
    if (!$("term-modal").classList.contains("hidden") && event.key === "Escape") {
      hideTermCreate();
      return;
    }
    if ($("keys-modal").classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hideKeys();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveKeys();
    }
  });
  syncRunButtons();
  window.addEventListener("keydown", onIdleGameKey);
  window.addEventListener("keyup", (event) => {
    if ((event.key === "ArrowDown" || event.key === "s") && !dinoUsesLaya()) dinoDuck = false;
  });
  const driver = $<HTMLSelectElement>("idle-driver");
  const kind = $<HTMLSelectElement>("idle-game-kind");
  kind.value = localStorage.getItem(IDLE_GAME_KEY) === "dino" ? "dino" : "snake";
  loadDriverSelect();
  $("idle-dino-best").textContent = String(dinoBest);
  driver.addEventListener("change", () => {
    const game = idleGame();
    const next = snakeDriver();
    localStorage.setItem(game === "dino" ? DINO_DRIVER_KEY : SNAKE_DRIVER_KEY, next);
    snakeEpoch += 1;
    snakeRunning = false;
    if (snakeTimer != null) {
      window.clearInterval(snakeTimer);
      snakeTimer = null;
    }
    stopDino();
    syncSnakeControls();
    if ($("preview-empty").classList.contains("hidden")) return;
    if (game === "dino") resetDino();
    else startControlLoop();
  });
  kind.addEventListener("change", () => {
    const game = idleGame();
    localStorage.setItem(IDLE_GAME_KEY, game);
    loadDriverSelect(game);
    snakeEpoch += 1;
    snakeRunning = false;
    if (snakeTimer != null) {
      window.clearInterval(snakeTimer);
      snakeTimer = null;
    }
    stopDino();
    syncSnakeControls();
    if ($("preview-empty").classList.contains("hidden")) return;
    if (game === "dino") resetDino();
    else {
      resetSnake();
      startControlLoop();
    }
  });
  $("idle-start").addEventListener("click", beginGame);
  showIdleGame();

  log("已启动");
  void loadAppInfo().then(() => maybeCheckUpdate());
  void refreshHerdrStatus();
  void poll();
  pollTimer = window.setInterval(() => {
    void poll();
  }, 1300);
});

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});
