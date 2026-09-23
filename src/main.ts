import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type AgentSession = {
  id: string;
  paneId: string;
  agent: string;
  agentLabel: string;
  agentState: string;
  cwd: string;
  title: string;
  idle: boolean;
  confidence: string;
  reason: string;
  preview: string;
  interactiveReady: boolean;
  cols: number;
  rows: number;
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

const AGENT_ORDER = ["pi", "claude", "codex", "grok"] as const;
const AGENT_META: Record<string, { label: string; hint: string }> = {
  pi: { label: "Pi", hint: "π" },
  claude: { label: "Claude", hint: "Anthropic" },
  codex: { label: "Codex", hint: "OpenAI" },
  grok: { label: "Grok", hint: "xAI" },
};

const COMMIT_NOTE = `【完成要求】本任务做完后，请把这次改动提交到 git：
1. 查看 git status / diff，确认只包含这次任务相关文件
2. git add 相关文件
3. git commit，message 用中文概括完成了什么
4. 不要 push，除非我另外要求
不要做无关重构。`;

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
let importDraft: string[] = [];
let term: Terminal | null = null;
let lastTermText = "";
let lastTermCols = 0;
let lastTermRows = 0;
let lastListSig = "";
let lastQueueSig = "";
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
const taskInput = () => $<HTMLTextAreaElement>("task-input");
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
  lastTermText = "";
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

function withCommit(text: string, commit: boolean) {
  if (!commit) return text.trim();
  if (text.includes("【完成要求】")) return text.trim();
  return `${text.trim()}\n\n${COMMIT_NOTE}`;
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
    log(`${session.paneId} Jev 续跑已达 ${plan.jevMax} 次`);
    return false;
  }
  let raw = session.preview;
  try {
    const fresh = await invoke<string>("read_session_text", { id: session.id });
    if (fresh.trim()) raw = fresh;
  } catch (error) {
    log(`${session.paneId} 读取下一步失败：${error}`, true);
  }
  const suggestions = parseJevSuggestions(raw);
  if (suggestions.length === 0) {
    log(`${session.paneId} 未解析到下一步建议，结束 Jev 续跑`);
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
      session.paneId,
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
    if (provider === "laya") logLaya(session.paneId, `失败 ${error}`, true);
    else log(`${session.paneId} ${providerLabel()} 决策失败，结束续跑：${error}`, true);
    return false;
  }
  if (provider === "laya") {
    const pct = (value: number) => `${Math.round(value * 100)}%`;
    logLaya(
      session.paneId,
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
      `${session.paneId} ${providerLabel()} 决定停止（${decision.choice}，置信 ${pct(decision.confidence)}，继续 ${pct(decision.continueNow)}）`,
    );
    return false;
  }
  try {
    await sendNow(session, plan, continuationPrompt(picked.text), false);
  } catch (error) {
    log(`${session.paneId} Jev 续跑发送失败：${error}`, true);
    return false;
  }
  plan.jevRuns += 1;
  log(`${session.paneId} ${providerLabel()} 续跑 ${plan.jevRuns}/${plan.jevMax}：${picked.text}`);
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
    bound.textContent = session ? session.paneId : "未绑定";
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
        return `${s.id}:${s.idle}:${s.agentState}:${plan?.planRunning ? 1 : 0}:${plan?.tasks.length ?? 0}`;
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
          <span class="host">${escapeHtml(s.paneId)}</span>
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
      return `<li class="task ${item.status}">
        <span class="mark">${mark}</span>
        <div>
          <div class="title">${escapeHtml(item.title)}</div>
          <div class="meta">${stage}${item.commit ? " · 提交" : ""}</div>
        </div>
        <div class="task-ops">
          <button type="button" data-act="commit" data-id="${item.id}" ${locked ? "disabled" : ""}>${item.commit ? "提交" : "不提交"}</button>
          <button type="button" data-act="remove" data-id="${item.id}" ${locked ? "disabled" : ""}>×</button>
        </div>
      </li>`;
    })
    .join("");
  list.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      if (act === "commit") {
        const task = plan.tasks.find((t) => t.id === id);
        if (task && task.status === "pending") {
          task.commit = !task.commit;
          if (!plan.planRunning) snapshotTemplate(plan);
        }
      } else {
        plan.tasks = plan.tasks.filter((t) => t.id !== id);
        if (!plan.planRunning) snapshotTemplate(plan);
      }
      lastQueueSig = "";
      renderQueue(true);
    });
  });
  renderLoopStatus();
}

function clampScreen(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function scaleTerm() {
  if (!term) return;
  const host = $("term-host");
  const screen = host.querySelector(".xterm") as HTMLElement | null;
  if (!screen || host.classList.contains("hidden")) return;
  screen.style.transform = "none";
  const naturalW = screen.offsetWidth;
  const naturalH = screen.offsetHeight;
  const availW = host.clientWidth - 16;
  const availH = host.clientHeight - 16;
  if (naturalW < 8 || naturalH < 8 || availW < 8 || availH < 8) return;
  const scale = Math.min(availW / naturalW, availH / naturalH);
  if (scale > 0.97 && scale < 1.03) return;
  const current = term.options.fontSize || 14;
  const next = Math.max(5, Math.round(current * scale));
  if (next === current) return;
  term.options.fontSize = next;
}

function ensureTerm() {
  if (term) return term;
  term = new Terminal({
    convertEol: false,
    disableStdin: true,
    fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
    fontSize: 14,
    lineHeight: 1,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    scrollback: 0,
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
  term.open($("term-host"));
  const host = $("term-host");
  const observer = new ResizeObserver(() => scaleTerm());
  observer.observe(host);
  term.onRender(() => scaleTerm());
  return term;
}

function writeTerm(ansi: string, cols: number, rows: number) {
  const host = $("term-host");
  host.classList.remove("hidden");
  $("preview").classList.add("hidden");
  const t = ensureTerm();
  const nextCols = clampScreen(cols, 80, 20, 400);
  const nextRows = clampScreen(rows, 24, 8, 200);
  const sizeChanged = nextCols !== lastTermCols || nextRows !== lastTermRows;
  if (sizeChanged) {
    t.resize(nextCols, nextRows);
    lastTermCols = nextCols;
    lastTermRows = nextRows;
  }
  if (ansi !== lastTermText || sizeChanged) {
    lastTermText = ansi;
    const payload = ansi.replace(/\n/g, "\r\n");
    t.write(`\x1b[0m\x1b[H\x1b[2J\x1b[3J${payload}`);
  }
  requestAnimationFrame(scaleTerm);
}

function hideTerm() {
  $("term-host").classList.add("hidden");
  lastTermText = "";
}

type Cell = { x: number; y: number };
type SnakeDriver = "manual" | "jev" | "laya";
type SnakeLevel = "easy" | "normal" | "hard";
const SNAKE_GRID = 15;
const SNAKE_CELL = 16;
const SNAKE_SPEED: Record<SnakeLevel, number> = { easy: 240, normal: 150, hard: 85 };
const SNAKE_LEVEL_KEY = "pi-auto-snake-level";
const SNAKE_DRIVER_KEY = "pi-auto-snake-driver";
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

function snakeLevel(): SnakeLevel {
  const value = $<HTMLSelectElement>("idle-difficulty").value;
  return value === "easy" || value === "hard" ? value : "normal";
}

function snakeDriver(): SnakeDriver {
  const value = $<HTMLSelectElement>("idle-driver").value;
  return value === "jev" || value === "laya" ? value : "manual";
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
  ctx.fillStyle = "#c98b86";
  ctx.fillRect(snakeFood.x * SNAKE_CELL + 4, snakeFood.y * SNAKE_CELL + 4, SNAKE_CELL - 8, SNAKE_CELL - 8);
  snakeBody.forEach((cell, index) => {
    ctx.fillStyle = index === 0 ? "#e7ebf2" : "#7eaea6";
    ctx.fillRect(cell.x * SNAKE_CELL + 2, cell.y * SNAKE_CELL + 2, SNAKE_CELL - 4, SNAKE_CELL - 4);
  });
  $("idle-game-score").textContent = snakeOver ? `${snakeScore} · 点开始重来` : String(snakeScore);
  const driver = $<HTMLSelectElement>("idle-driver").value;
  const driving = driver === "jev" || driver === "laya";
  $("idle-game-hint").textContent = snakeSteerNote
    ? snakeSteerNote
    : driving
      ? `${driver === "laya" ? "Laya" : "Jev"} 控制 · 收到决策才移动`
      : "方向键移动 · 选会话后停止";
  syncStartButton();
}

function waitingToStart() {
  return !snakeRunning || snakeOver;
}

function syncStartButton() {
  const button = $<HTMLButtonElement>("idle-start");
  const driver = snakeDriver();
  button.classList.toggle("hidden", !waitingToStart());
  button.disabled = (driver === "jev" && !gameBackends.jev) || (driver === "laya" && !gameBackends.laya);
}

function beginGame() {
  const driver = snakeDriver();
  if (driver === "jev" && !gameBackends.jev) return;
  if (driver === "laya" && !gameBackends.laya) return;
  snakeRunning = true;
  resetSnake();
  startControlLoop();
}

const SNAKE_ASK_FRUIT =
  "两个目标：第一是吃到果子，第二才是不要死。蛇头不能碰到蛇身，碰到就是失败。这些方向都不会碰到蛇身或墙。选吃到果子的；没有就选移动后距离最小的。距离相同就保持当前朝向。";
const SNAKE_ASK_LIVE =
  "两个目标：第一是吃到果子，第二才是不要死。蛇头不能碰到蛇身，碰到就是失败。靠近果子的方向这一步都会碰到蛇身或墙。在这些不会死的方向里，选离果子最近的。";

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

function bodyCells() {
  return snakeBody.map((cell, index) => `${index === 0 ? "头" : `身${index}`}(${cell.x},${cell.y})`).join(" ");
}

function boardMap() {
  const rows: string[] = [];
  for (let y = 0; y < SNAKE_GRID; y += 1) {
    let line = "";
    for (let x = 0; x < SNAKE_GRID; x += 1) {
      if (x === snakeBody[0]?.x && y === snakeBody[0]?.y) line += "H";
      else if (snakeBody.some((cell) => cell.x === x && cell.y === y)) line += "o";
      else if (x === snakeFood.x && y === snakeFood.y) line += "*";
      else line += ".";
    }
    rows.push(line);
  }
  return rows.join("\n");
}

function stepFate(dir: Cell) {
  const head = snakeBody[0];
  const x = head.x + dir.x;
  const y = head.y + dir.y;
  if (x < 0 || y < 0 || x >= SNAKE_GRID || y >= SNAKE_GRID) return "撞墙，失败";
  if (snakeBody.some((cell) => cell.x === x && cell.y === y)) return "碰到蛇身，失败";
  if (x === snakeFood.x && y === snakeFood.y) return "吃到果子，不会死";
  const dist = Math.abs(snakeFood.x - x) + Math.abs(snakeFood.y - y);
  return `不会死，移动后距离 ${dist}`;
}

function snakeState(chasing: boolean) {
  const head = snakeBody[0];
  const dx = snakeFood.x - head.x;
  const dy = snakeFood.y - head.y;
  const dirs = [
    { name: "上", dir: { x: 0, y: -1 } },
    { name: "下", dir: { x: 0, y: 1 } },
    { name: "左", dir: { x: -1, y: 0 } },
    { name: "右", dir: { x: 1, y: 0 } },
  ];
  return [
    "贪吃蛇。两个目标：先吃到果子，同时不要死。不能只保命。",
    `棋盘 ${SNAKE_GRID}x${SNAKE_GRID}，坐标从 0 到 ${SNAKE_GRID - 1}。x 向右增大，y 向下增大。`,
    "规则：蛇头下一步如果和任意一节蛇身重合，就是失败。蛇身包括头后面的每一节，尾部也算。撞墙也是失败。",
    "地图：H 是蛇头，o 是蛇身，* 是果子，. 是空格。上方是 y=0。",
    boardMap(),
    `蛇身从头到尾：${bodyCells()}。长度 ${snakeBody.length}。`,
    `头在 (${head.x},${head.y})，当前朝向${dirName(snakeDir)}。不能直接掉头。`,
    `果子在 (${snakeFood.x},${snakeFood.y})，位于头的${foodSide(dx, dy)}。当前曼哈顿距离 ${Math.abs(dx) + Math.abs(dy)}。`,
    "四个方向的结果：",
    ...dirs.map((item) => `${item.name}：${stepFate(item.dir)}`),
    chasing
      ? "选项都不会碰到蛇身或墙，并且在靠近或吃到果子。选距离最小的。"
      : "靠近果子的方向会碰到蛇身或墙。选项都不会死，选离果子最近的。",
  ].join("\n");
}

type SnakeMove = {
  id: "up" | "down" | "left" | "right";
  dir: Cell;
  dist: number;
  eats: boolean;
  closer: boolean;
};

function candidateMoves(): SnakeMove[] {
  const head = snakeBody[0];
  const now = Math.abs(snakeFood.x - head.x) + Math.abs(snakeFood.y - head.y);
  const dirs = [
    { id: "up" as const, dir: { x: 0, y: -1 } },
    { id: "down" as const, dir: { x: 0, y: 1 } },
    { id: "left" as const, dir: { x: -1, y: 0 } },
    { id: "right" as const, dir: { x: 1, y: 0 } },
  ];
  return dirs
    .filter((move) => move.dir.x !== -snakeDir.x || move.dir.y !== -snakeDir.y)
    .map((move) => {
      const x = head.x + move.dir.x;
      const y = head.y + move.dir.y;
      const wall = x < 0 || y < 0 || x >= SNAKE_GRID || y >= SNAKE_GRID;
      const body = snakeBody.some((cell) => cell.x === x && cell.y === y);
      const dist = Math.abs(snakeFood.x - x) + Math.abs(snakeFood.y - y);
      return {
        id: move.id,
        dir: move.dir,
        dist,
        eats: x === snakeFood.x && y === snakeFood.y,
        closer: dist < now,
        blocked: wall || body,
      };
    })
    .filter((move) => !move.blocked)
    .map(({ id, dir, dist, eats, closer }) => ({ id, dir, dist, eats, closer }));
}

function movesForDecision() {
  const safe = candidateMoves();
  const chasing = safe.filter((move) => move.eats || move.closer);
  return {
    chasing: chasing.length > 0,
    moves: chasing.length > 0 ? chasing : safe,
  };
}

function describeMove(move: SnakeMove) {
  const head = snakeBody[0];
  const x = head.x + move.dir.x;
  const y = head.y + move.dir.y;
  const now = Math.abs(snakeFood.x - head.x) + Math.abs(snakeFood.y - head.y);
  const delta = move.dist - now;
  const fruit = move.eats ? "这一步吃到果子" : delta < 0 ? `靠近果子，距离 ${move.dist}，近 ${-delta}` : `暂时吃不到，距离 ${move.dist}`;
  const same = move.dir.x === snakeDir.x && move.dir.y === snakeDir.y ? "，与当前朝向相同" : "";
  return `走到 (${x},${y})。这一格不是蛇身，也不是墙。${fruit}${same}`;
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
    return;
  }
  snakeAiBusy = true;
  snakeSteerNote = `等待 ${driver === "laya" ? "Laya" : "Jev"}，蛇停住`;
  drawSnake();
  const started = Date.now();
  logSnake(
    `${plan.chasing ? "吃果子" : "先保命再吃"} · ${moves.map((move) => `${move.id}:${move.dist}`).join(" ")}`,
  );
  try {
    const decision = await invoke<JevDecision>("jev_choose", {
      provider: driver,
      apiKey: localStorage.getItem(keyStorage(driver))?.trim() || null,
      baseUrl: providerBase(driver),
      state: snakeState(plan.chasing),
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
  const jevOpt = $<HTMLOptionElement>("idle-driver-jev");
  const layaOpt = $<HTMLOptionElement>("idle-driver-laya");
  jevOpt.disabled = !gameBackends.jev;
  layaOpt.disabled = !gameBackends.laya;
  jevOpt.textContent = gameBackends.jev ? "Jev" : "Jev 未接入";
  layaOpt.textContent = gameBackends.laya ? "Laya" : "Laya 未接入";
  drawSnake();
  if (!$("preview-empty").classList.contains("hidden") && snakeDriver() !== "manual" && snakeTimer != null) {
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
    snakeTimer = window.setInterval(stepSnake, SNAKE_SPEED[snakeLevel()]);
    drawSnake();
    return;
  }
  snakeSteerNote = `等待 ${snakeDriver() === "laya" ? "Laya" : "Jev"}，蛇停住`;
  drawSnake();
  queueAiTurn();
}

function showIdleGame() {
  if (snakeShown) return;
  snakeShown = true;
  resetSnake();
  startControlLoop();
  void refreshGameBackends();
  if (snakeProbe == null) snakeProbe = window.setInterval(() => void refreshGameBackends(), 8000);
}

function hideIdleGame() {
  snakeShown = false;
  snakeEpoch += 1;
  if (snakeTimer != null) {
    window.clearInterval(snakeTimer);
    snakeTimer = null;
  }
  if (snakeProbe != null) {
    window.clearInterval(snakeProbe);
    snakeProbe = null;
  }
}

function onIdleGameKey(event: KeyboardEvent) {
  if ($("preview-empty").classList.contains("hidden")) return;
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
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
  const hasTarget = Boolean(session);
  $("queue-btn").toggleAttribute("disabled", !hasTarget);
  $("send-btn").toggleAttribute("disabled", !hasTarget);
  setAppTheme(session?.agent);

  const ctx = session ? parseContextPercent(session.preview) : null;
  const headSig = session
    ? `${session.id}:${session.idle}:${session.agentState}:${session.reason}:${ctx ?? ""}`
    : "none";
  const headChanged = headSig !== lastHeadSig;
  lastHeadSig = headSig;

  const st = statusLabel(session);
  if (headChanged) {
    $("status-pill").className = `pill ${st.cls}`;
    $("status-text").textContent = st.text;
  }

  const empty = $("preview-empty");
  const live = $("live-badge");
  const pre = $("preview");
  const image = $("preview-image") as HTMLImageElement;
  image.classList.add("hidden");

  if (!session) {
    $("target-kicker").textContent = "未选择";
    $("target-title").textContent = "选择一个会话";
    $("target-meta").textContent = "";
    $("preview-hint").textContent = "";
    live.textContent = "—";
    live.className = "live-badge";
    empty.classList.remove("hidden");
    hideTerm();
    if (pre.textContent) pre.textContent = "";
    showIdleGame();
    return;
  }

  hideIdleGame();
  empty.classList.add("hidden");
  if (headChanged) {
    $("target-kicker").textContent = session.agentLabel;
    $("target-title").textContent = session.paneId;
    const ctxBit = ctx == null ? "" : ` · ${ctx.toFixed(0)}%`;
    $("status-text").textContent = activePlan()?.compacting ? "压缩中" : `${st.text}${ctxBit}`;
    $("target-meta").textContent = shortPath(session.cwd);
    live.textContent = session.idle ? "空闲" : "执行";
    live.className = `live-badge ${session.idle ? "on" : "busy"}`;
    $("preview-hint").textContent = "";
  }

  const nextText = session.preview.trim();
  if (!nextText) {
    hideTerm();
    pre.classList.remove("hidden");
    pre.textContent = "暂无 pane 画面";
    return;
  }
  writeTerm(nextText, session.cols, session.rows);
}

function renderAll() {
  renderList();
  renderMain();
  renderQueue();
}

function enqueue() {
  const text = taskInput().value.trim();
  if (!text) return;
  const session = selected();
  const plan = activePlan();
  if (!session || !plan) {
    log("请先选择一个 Herdr pane", true);
    return;
  }
  syncPlanInputsFromUi();
  plan.tasks.push(makeTask(text, plan.commitAfter));
  if (!plan.planRunning) snapshotTemplate(plan);
  taskInput().value = "";
  lastQueueSig = "";
  renderQueue();
  log(`已加入 ${session.paneId} 的计划：${taskTitle(text)}`);
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
  log(`已导入 ${importDraft.length} 条到 ${session.paneId}${commit ? "（含完成后提交代码）" : ""}`);
  hideImport();
}

async function sendNow(session: AgentSession, plan: Plan | null, text: string, force: boolean) {
  const result = await invoke<string>("send_to_session", {
    id: session.id,
    text,
    force,
  });
  log(`${session.paneId} · ${result}`);
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
  plan.needCompact = true;
  armStallWatch(session);
  lastQueueSig = "";
  if (plan.jev && jevProvider() !== "laya" && !providerKey()) {
    log(`${session.paneId} 已开启续跑，但没有 ${providerLabel()} API Key。决策时会跳过续跑`, true);
  }
  log(
    `${session.paneId} 开始循环：${plan.tasks.length} 条 · 循环 ${loopRounds(plan)} 次${plan.jev ? ` · ${providerLabel()} 续跑` : ""}`,
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
  clearStallWatch(selectedId);
  log(`${selected()?.paneId ?? "当前窗口"} 已暂停循环`);
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
  plan.needCompact = true;
  plan.currentRound = 1;
  plan.phase = "idle";
  plan.idleSince = null;
  plan.sentAt = null;
  plan.jevRuns = 0;
  clearStallWatch(selectedId);
  for (const task of plan.tasks) task.status = "pending";
  log(`${selected()?.paneId ?? "当前窗口"} 已停止循环，进度已清零`);
  setAppTheme(selected()?.agent);
  syncRunButtons();
  lastQueueSig = "";
  renderQueue(true);
}

function finishPlan(session: AgentSession, plan: Plan) {
  plan.planRunning = false;
  plan.currentRound = 1;
  plan.phase = "idle";
  log(`${session.paneId} 计划已全部完成`);
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
  log(`${session.paneId} 开始第 ${plan.currentRound}/${total} 次循环`);
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
      previewIds: stallPreviewIds(),
    });
    if (selectedId && !sessions.some((s) => s.id === selectedId)) {
      log(`会话 ${selectedId} 已退出，计划仍保留`, true);
      selectSession(null);
    }
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
        `${session.paneId} 输出 5 分钟几乎无变化（差异 ${(ratio * 100).toFixed(2)}%），${result}`,
      );
    } catch (error) {
      log(`${session.paneId} 卡死唤醒失败：${error}`, true);
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
  log(`${session.paneId} 完成：${running.title}`);
  if (session.id === selectedId) refreshSelectedPlan();
}

async function startCommit(session: AgentSession, plan: Plan, task: TaskItem) {
  task.status = "committing";
  log(`${session.paneId} 开始提交：${task.title}`);
  if (session.id === selectedId) refreshSelectedPlan();
  await sendNow(session, plan, commitPrompt(task), false);
}

async function startCompact(session: AgentSession, plan: Plan) {
  plan.compacting = true;
  plan.needCompact = false;
  log(`${session.paneId} 上下文 ${parseContextPercent(session.preview)?.toFixed(0) ?? "?"}% ≥ ${compactThreshold(plan)}%，先压缩`);
  await sendNow(session, plan, compactCommand(session.agent), false);
}

async function tickPlan(session: AgentSession, plan: Plan) {
  const now = Date.now();
  const stableMs = Math.max(1, plan.idleMs || 2) * 1000;
  const ctx = parseContextPercent(session.preview);

  if (plan.compacting) {
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
      plan.compacting = false;
      plan.phase = "idle";
      plan.idleSince = now;
      plan.sentAt = null;
      log(`${session.paneId} 上下文压缩完成`);
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
          log(`${session.paneId} 提交发送失败：${error}`, true);
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
      log(`${session.paneId} 压缩发送失败：${error}`, true);
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
    log(`${session.paneId} ${String(error)}`, true);
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
  $("refresh-btn").addEventListener("click", () => {
    $("refresh-btn").classList.remove("spin");
    void $("refresh-btn").offsetWidth;
    $("refresh-btn").classList.add("spin");
    void poll();
  });
  $("queue-btn").addEventListener("click", enqueue);
  $("import-btn").addEventListener("click", () => showImport());
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
  $("send-btn").addEventListener("click", async () => {
    const text = taskInput().value.trim();
    if (!text) {
      log("请输入要发送的文本", true);
      return;
    }
    try {
      const session = selected();
      if (!session) throw new Error("请先选择一个 Herdr pane");
      await sendNow(session, activePlan(), withCommit(text, commitAfterInput().checked), true);
      taskInput().value = "";
    } catch (error) {
      log(String(error), true);
    }
  });
  taskInput().addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      $("send-btn").click();
    }
  });
  $("herdr-guide-btn").addEventListener("click", () => showHerdrGuide());
  $("herdr-guide-close").addEventListener("click", () => hideHerdrGuide());
  $("about-close").addEventListener("click", () => hideAbout());
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
  const level = $<HTMLSelectElement>("idle-difficulty");
  const driver = $<HTMLSelectElement>("idle-driver");
  level.value = localStorage.getItem(SNAKE_LEVEL_KEY) ?? "normal";
  driver.value = localStorage.getItem(SNAKE_DRIVER_KEY) ?? "manual";
  level.addEventListener("change", () => {
    localStorage.setItem(SNAKE_LEVEL_KEY, snakeLevel());
    if (!$("preview-empty").classList.contains("hidden")) startControlLoop();
  });
  driver.addEventListener("change", () => {
    localStorage.setItem(SNAKE_DRIVER_KEY, driver.value);
    snakeRunning = false;
    if (!$("preview-empty").classList.contains("hidden")) startControlLoop();
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
