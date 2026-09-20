import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
let termFit: FitAddon | null = null;
let lastTermText = "";
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
let appInfo: AppInfo | null = null;
let updateInfo: UpdateCheck | null = null;
let updateChecking = false;
let updateInstalling = false;

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const taskInput = () => $<HTMLTextAreaElement>("task-input");
const loopRoundsInput = () => $<HTMLInputElement>("loop-rounds");
const idleMsInput = () => $<HTMLInputElement>("idle-ms");
const commitAfterInput = () => $<HTMLInputElement>("commit-after");
const compactAtInput = () => $<HTMLInputElement>("compact-at");

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
}

function applyPlanInputsToUi() {
  const plan = activePlan();
  if (!plan) return;
  loopRoundsInput().value = String(plan.loopRounds);
  idleMsInput().value = String(plan.idleMs);
  compactAtInput().value = String(plan.compactAt);
  commitAfterInput().checked = plan.commitAfter;
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
    bound.textContent = session ? `绑定 ${session.paneId}` : "未绑定窗口";
  }
  if (!plan) {
    $("loop-bar-fill").style.width = "0%";
    $("loop-status").textContent = "先选一个会话，计划会绑到该窗口";
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
      ? `待命 · ${total} 条任务 × ${totalRounds} 次 · 进度 ${pct}%`
      : "尚未开始";
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
    `第 ${plan.currentRound}/${totalRounds} 次 · ${done}/${total} 完成 · ${now}` +
    (cur ? ` · ${cur.title}` : "");
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
    box.innerHTML = `<div class="empty boot">Herdr 里没有运行中的 ${meta.label} pane</div>`;
    return;
  }
  box.innerHTML = items
    .map((s) => {
      const active = s.id === selectedId ? " active" : "";
      const st = statusLabel(s);
      const plan = plans.get(s.id);
      const planHint = plan && plan.tasks.length
        ? `<div class="plan-bind${plan.planRunning ? " on" : ""}">${plan.planRunning ? "循环中" : "计划"} ${plan.tasks.filter((t) => t.status === "done").length}/${plan.tasks.length}</div>`
        : "";
      const title = s.title?.trim()
        ? `<div class="win">${escapeHtml(s.title)}</div>`
        : "";
      return `<button type="button" class="session${active}" data-id="${escapeHtml(s.id)}">
        <div class="row">
          <span class="host">${escapeHtml(s.agentLabel)}</span>
          <span class="pill ${st.cls}"><span class="pill-dot"></span>${st.text}</span>
        </div>
        <div class="tty">${escapeHtml(s.paneId)} · ${escapeHtml(s.agentState)}${s.interactiveReady ? " · 可交互" : ""}</div>
        <div class="cwd">${escapeHtml(shortPath(s.cwd))}</div>
        ${title}
        ${planHint}
        <div class="why">${escapeHtml(s.reason)}</div>
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
    list.innerHTML = `<li class="empty">先选一个会话，计划会绑到该窗口。</li>`;
    renderLoopStatus();
    return;
  }
  if (plan.tasks.length === 0) {
    list.innerHTML = `<li class="empty">这个窗口还没有任务。加入计划或导入。</li>`;
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
          <div class="meta">${stage} · ${item.commit ? "完成后提交" : "不提交"}</div>
        </div>
        <div class="task-ops">
          <button type="button" data-act="commit" data-id="${item.id}" ${locked ? "disabled" : ""}>${item.commit ? "含提交" : "无提交"}</button>
          <button type="button" data-act="remove" data-id="${item.id}" ${locked ? "disabled" : ""}>移除</button>
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

function ensureTerm() {
  if (term) return term;
  term = new Terminal({
    convertEol: true,
    disableStdin: true,
    fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    scrollback: 2000,
    theme: {
      background: "#0b0805",
      foreground: "#f6e3b0",
      cursor: "#ffd34e",
      black: "#1a140c",
      red: "#ff7a6e",
      green: "#7dce82",
      yellow: "#ffd34e",
      blue: "#8bb4ff",
      magenta: "#b794f6",
      cyan: "#3dd6c6",
      white: "#fff4d6",
      brightBlack: "#6a542c",
      brightRed: "#ff9b90",
      brightGreen: "#9be7a0",
      brightYellow: "#ffe27a",
      brightBlue: "#adc6ff",
      brightMagenta: "#d0b8ff",
      brightCyan: "#7eefe3",
      brightWhite: "#fffaf0",
    },
  });
  termFit = new FitAddon();
  term.loadAddon(termFit);
  term.open($("term-host"));
  termFit.fit();
  const host = $("term-host");
  const observer = new ResizeObserver(() => termFit?.fit());
  observer.observe(host);
  return term;
}

function writeTerm(ansi: string) {
  const host = $("term-host");
  host.classList.remove("hidden");
  $("preview").classList.add("hidden");
  const t = ensureTerm();
  if (ansi === lastTermText) return;
  lastTermText = ansi;
  const payload = ansi.replace(/\n/g, "\r\n");
  t.write(`\x1b[?2026h\x1b[H\x1b[J${payload}\x1b[?2026l`);
}

function hideTerm() {
  $("term-host").classList.add("hidden");
  lastTermText = "";
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
    $("target-kicker").textContent = "等待选择";
    $("target-title").textContent = "未选择 Herdr pane";
    $("target-meta").textContent = "先启动 Herdr，在 pane 里打开 agent，再从左侧点选";
    $("preview-hint").textContent = "";
    live.textContent = "待机";
    live.className = "live-badge";
    empty.classList.remove("hidden");
    hideTerm();
    if (pre.textContent) pre.textContent = "";
    return;
  }

  empty.classList.add("hidden");
  if (headChanged) {
    $("target-kicker").textContent = `${session.agentLabel} · Herdr`;
    const ctxLabel = ctx == null ? session.agentState : `${session.agentState}  ·  上下文 ${ctx.toFixed(0)}%`;
    $("target-title").textContent = `${session.paneId}  ·  ${ctxLabel}`;
    $("status-text").textContent =
      activePlan()?.compacting ? "压缩中" : ctx != null && ctx >= compactThreshold() ? `${st.text} · ${ctx.toFixed(0)}%` : st.text;
    $("target-meta").textContent = `${shortPath(session.cwd)}  ·  ${session.reason}`;
    live.textContent = session.idle ? "IDLE" : "WORKING";
    live.className = `live-badge ${session.idle ? "on" : "busy"}`;
    $("preview-hint").textContent = "Herdr visible · ANSI";
  }

  const nextText = session.preview.trim();
  if (!nextText) {
    hideTerm();
    pre.classList.remove("hidden");
    pre.textContent = "暂无 pane 画面";
    return;
  }
  writeTerm(nextText);
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
  lastQueueSig = "";
  log(`${session.paneId} 开始循环：${plan.tasks.length} 条 × ${loopRounds(plan)} 次`);
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
  $("app-version").textContent = `v${current}`;
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
    $("app-version").textContent = `v${appInfo.version}`;
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
      ? `Herdr 已连接 · ${status.agentCount} 个 agent`
      : status.error
        ? `Herdr 未连接：${status.error}`
        : "Herdr 未连接。请安装并启动 Herdr。";
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
    const text = `Herdr 检测失败：${error}`;
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
  try {
    sessions = await invoke<AgentSession[]>("list_sessions", {
      previewId: selectedId,
    });
    if (selectedId && !sessions.some((s) => s.id === selectedId)) {
      log(`会话 ${selectedId} 已退出，计划仍保留`, true);
      selectSession(null);
    }
    void refreshHerdrStatus();
    renderList();
    renderMain();
    await maybeAutoSend();
    renderQueue();
  } catch (error) {
    log(String(error), true);
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
    if (session.id === selectedId) refreshSelectedPlan();
    await sendNow(session, plan, next.text, false);
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
  $("toggle-help").addEventListener("click", () => showUsageGuide());
  $("app-version").addEventListener("click", () => showAbout());
  $("about-close").addEventListener("click", () => hideAbout());
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
  syncRunButtons();

  log("已启动。任务走 Herdr pane，可导入列表并在完成后自动要求提交代码。");
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
