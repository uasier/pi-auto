import { AGENT_META, AGENT_ORDER, selected, store } from "./store";
import type { AgentSession } from "./types";
import { $, escapeHtml, sessionLabel, shortPath } from "./dom";
import { log } from "./log";
import { commitAfterInput, jevOnInput, providerLabel } from "./fields";
import { activePlan, applyPlanInputsToUi, counts, currentTask, loopRounds, makeTask, parseContextPercent, poll, snapshotTemplate, syncPlanInputsFromUi, taskTitle } from "./plan";
import { hideIdleGame, showIdleGame } from "./idle-game";
import { attachSessionTerm, hideTerm, stopLiveTerm } from "./terminal";

export function selectSession(id: string | null) {
  syncPlanInputsFromUi();
  store.selectedId = id;
  applyPlanInputsToUi();
  store.lastQueueSig = "";
  store.lastHeadSig = "";
  store.lastListSig = "";
  renderAll();
}

export function setAppTheme(agent?: string) {
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

export function statusLabel(session: AgentSession | undefined) {
  if (!session) return { text: "待选择", cls: "idle-unknown" };
  if (!session.idle) return { text: "执行中", cls: "idle-no" };
  if (session.confidence === "high") return { text: "空闲", cls: "idle-yes" };
  return { text: "可能空闲", cls: "idle-maybe" };
}

export function renderLoopStatus() {
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

export function setRunState(id: string, text: string, cls: "off" | "on" | "busy") {
  const el = $(id);
  el.textContent = text;
  el.className = `run-state ${cls}`;
}

export function syncExecPanels() {
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

export function groupedSessions() {
  const grouped = new Map<string, AgentSession[]>();
  for (const key of AGENT_ORDER) grouped.set(key, []);
  for (const session of store.sessions) {
    const key = AGENT_ORDER.includes(session.agent as (typeof AGENT_ORDER)[number])
      ? session.agent
      : "pi";
    grouped.get(key)?.push(session);
  }
  return grouped;
}

export function listSig() {
  return (
    `${store.activeSheet}|${store.selectedId}|` +
    store.sessions
      .map((s) => {
        const plan = store.plans.get(s.id);
        return `${s.id}:${s.title}:${s.idle}:${s.agentState}:${plan?.planRunning ? 1 : 0}:${plan?.tasks.length ?? 0}`;
      })
      .join(";")
  );
}

export function queueSig() {
  const plan = activePlan();
  if (!plan) return `${store.selectedId}|empty`;
  return `${store.selectedId}|${plan.currentRound}|${plan.planRunning}|` + plan.tasks.map((t) => `${t.id}:${t.status}:${t.commit}`).join(";");
}

export function renderList(force = false) {
  const sig = listSig();
  if (!force && sig === store.lastListSig) return;
  store.lastListSig = sig;
  const grouped = groupedSessions();
  const bar = $("sheet-bar");
  bar.innerHTML = AGENT_ORDER.map((agent) => {
    const count = grouped.get(agent)?.length ?? 0;
    const on = agent === store.activeSheet ? " on" : "";
    const meta = AGENT_META[agent];
    return `<button type="button" class="sheet${on}" data-agent="${agent}" style="--agent: var(--${agent})">
      <b>${meta.label}</b>
      <em>${count}</em>
    </button>`;
  }).join("");
  bar.querySelectorAll<HTMLButtonElement>(".sheet").forEach((btn) => {
    btn.addEventListener("click", () => {
      const agent = btn.dataset.agent as (typeof AGENT_ORDER)[number];
      if (!agent || agent === store.activeSheet) return;
      store.activeSheet = agent;
      store.lastListSig = "";
      renderList(true);
    });
  });

  const box = $("session-list");
  box.dataset.agent = store.activeSheet;
  const scroll = box.scrollTop;
  const items = grouped.get(store.activeSheet) ?? [];
  const meta = AGENT_META[store.activeSheet];
  if (items.length === 0) {
    box.innerHTML = `<div class="empty boot">没有 ${meta.label}</div>`;
    return;
  }
  box.innerHTML = items
    .map((s) => {
      const active = s.id === store.selectedId ? " active" : "";
      const st = statusLabel(s);
      const plan = store.plans.get(s.id);
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

export function renderQueue(force = false) {
  const sig = queueSig();
  if (!force && sig === store.lastQueueSig) {
    renderLoopStatus();
    return;
  }
  store.lastQueueSig = sig;
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
      const editing = item.id === store.editingTaskId && item.status === "pending";
      const body = editing
        ? `<div class="task-edit">
            <textarea data-edit="${item.id}">${escapeHtml(store.editingDraft)}</textarea>
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
      store.editingDraft = area.value;
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
        store.editingTaskId = task.id;
        store.editingDraft = task.text;
      } else if (act === "cancel") {
        store.editingTaskId = null;
        store.editingDraft = "";
      } else if (act === "save") {
        const text = store.editingDraft.trim();
        if (!text) return;
        task.text = text;
        task.title = taskTitle(text);
        if (!plan.planRunning) snapshotTemplate(plan);
        store.editingTaskId = null;
        store.editingDraft = "";
      } else if (act === "commit") {
        if (task.status !== "pending") return;
        task.commit = !task.commit;
        if (!plan.planRunning) snapshotTemplate(plan);
      } else if (act === "remove") {
        if (running && task.status !== "pending") return;
        plan.tasks = plan.tasks.filter((t) => t.id !== id);
        if (store.editingTaskId === id) {
          store.editingTaskId = null;
          store.editingDraft = "";
        }
        if (!plan.planRunning) snapshotTemplate(plan);
      }
      store.lastQueueSig = "";
      renderQueue(true);
    });
  });
  renderLoopStatus();
}

export function addPlanTask(text: string) {
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
  store.lastQueueSig = "";
  renderQueue(true);
  log(`已加入 ${sessionLabel(session)} 的计划：${taskTitle(body)}`);
}



export function renderMain() {
  const session = selected();
  setAppTheme(session?.agent);

  const ctx = session ? parseContextPercent(session.preview) : null;
  const headSig = session
    ? `${session.id}:${session.title}:${session.idle}:${session.agentState}:${session.reason}:${ctx ?? ""}`
    : "none";
  const headChanged = headSig !== store.lastHeadSig;
  store.lastHeadSig = headSig;

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
  attachSessionTerm(session);
  if (headChanged) {
    $("target-kicker").textContent = session.agentLabel;
    $("target-title").textContent = sessionLabel(session);
    const ctxBit = ctx == null ? "" : ` · ${ctx.toFixed(0)}%`;
    $("status-text").textContent = activePlan()?.compacting ? "压缩中" : `${st.text}${ctxBit}`;
    $("target-meta").textContent = shortPath(session.cwd);
  }
}

export function renderAll() {
  renderList();
  renderMain();
  renderQueue();
}

export function syncRunButtons() {
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

export function refreshSelectedPlan() {
  if (store.selectedId) {
    store.lastQueueSig = "";
    store.lastListSig = "";
    syncRunButtons();
    renderList();
    renderQueue();
  }
}
