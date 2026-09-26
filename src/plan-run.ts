import { AGENT_ORDER, selected, store } from "./store";
import type { AgentSession, Plan, TaskItem, TaskStatus } from "./types";
import { sessionLabel } from "./dom";
import { log } from "./log";
import { jevProvider, providerKey, providerLabel } from "./fields";
import { refreshSelectedPlan, renderList, renderMain, renderQueue, selectSession, setAppTheme, syncRunButtons } from "./view";
import { refreshHerdrStatus } from "./dialogs";
import { invoke } from "@tauri-apps/api/core";
import {
  activePlan,
  agentBack,
  armStallWatch,
  clearStallWatch,
  commitPrompt,
  compactCommand,
  compactEvidence,
  compactThreshold,
  finishCompact,
  loopRounds,
  maybeJevContinue,
  newId,
  outputChangeRatio,
  outputSnapshot,
  parseContextPercent,
  pollPreviewIds,
  snapshotTemplate,
  syncPlanInputsFromUi,
  withJevAsk,
} from "./plan";

const STALL_CHECK_MS = 5 * 60 * 1000;
const STALL_DIFF_RATIO = 0.01;
const NUDGE_TEXT = "继续";

export async function sendNow(session: AgentSession, plan: Plan | null, text: string, force: boolean) {
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

export function startLoop() {
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
  store.lastQueueSig = "";
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

export function pauseLoop() {
  const plan = activePlan();
  if (!plan?.planRunning) return;
  plan.planRunning = false;
  plan.compacting = false;
  plan.compactFrom = null;
  clearStallWatch(store.selectedId);
  log(`${selected() ? sessionLabel(selected()!) : "当前窗口"} 已暂停循环`);
  setAppTheme(selected()?.agent);
  syncRunButtons();
  store.lastQueueSig = "";
  renderQueue(true);
}

export function stopLoop() {
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
  clearStallWatch(store.selectedId);
  for (const task of plan.tasks) task.status = "pending";
  log(`${selected() ? sessionLabel(selected()!) : "当前窗口"} 已停止循环，进度已清零`);
  setAppTheme(selected()?.agent);
  syncRunButtons();
  store.lastQueueSig = "";
  renderQueue(true);
}

export function finishPlan(session: AgentSession, plan: Plan) {
  plan.planRunning = false;
  plan.currentRound = 1;
  plan.phase = "idle";
  log(`${sessionLabel(session)} 计划已全部完成`);
  if (session.id === store.selectedId) {
    setAppTheme(session.agent);
    syncRunButtons();
    store.lastQueueSig = "";
    renderQueue(true);
  }
}

export function startNextRound(session: AgentSession, plan: Plan) {
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
  if (session.id === store.selectedId) renderQueue();
  return plan.tasks.length > 0;
}

export async function poll() {
  if (store.pollInFlight) return;
  store.pollInFlight = true;
  try {
    store.sessions = await invoke<AgentSession[]>("list_sessions", {
      previewId: store.selectedId,
      previewIds: pollPreviewIds(),
    });
    if (store.selectedId && !store.sessions.some((s) => s.id === store.selectedId)) {
      log(`会话 ${store.selectedId} 已退出，计划仍保留`, true);
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
    store.pollInFlight = false;
  }
}

export function followCreatedPane() {
  const follow = store.followPane;
  if (!follow) return;
  if (Date.now() > follow.until) {
    store.followPane = null;
    return;
  }
  const found = store.sessions.find((item) => item.paneId === follow.paneId);
  if (!found) return;
  if (found.agent !== store.activeSheet && (AGENT_ORDER as readonly string[]).includes(found.agent)) {
    store.activeSheet = found.agent as (typeof AGENT_ORDER)[number];
    store.lastListSig = "";
  }
  if (store.selectedId !== found.id) selectSession(found.id);
  if (found.agent === follow.want || (follow.want === "shell" && found.agent === "shell")) {
    store.followPane = null;
  }
}

export async function maybeUnstickStalled() {
  const now = Date.now();
  const live = new Set(store.sessions.map((s) => s.id));
  for (const id of [...store.stallWatch.keys()]) {
    if (!store.plans.get(id)?.planRunning || !live.has(id)) store.stallWatch.delete(id);
  }
  for (const session of store.sessions) {
    const plan = store.plans.get(session.id);
    if (!plan?.planRunning) continue;
    const prev = store.stallWatch.get(session.id);
    if (prev && now - prev.at < STALL_CHECK_MS) continue;
    const snap = outputSnapshot(session.preview);
    if (!snap) {
      store.stallWatch.set(session.id, {
        text: prev?.text ?? "",
        at: now - STALL_CHECK_MS + 15_000,
      });
      continue;
    }
    if (!prev?.text) {
      store.stallWatch.set(session.id, { text: snap, at: now });
      continue;
    }
    const ratio = outputChangeRatio(prev.text, snap);
    store.stallWatch.set(session.id, { text: snap, at: now });
    if (session.idle || ratio >= STALL_DIFF_RATIO) continue;
    if (store.stallNudging.has(session.id)) continue;
    store.stallNudging.add(session.id);
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
      const watch = store.stallWatch.get(session.id);
      if (watch) watch.at = Date.now() - STALL_CHECK_MS + 60_000;
    } finally {
      store.stallNudging.delete(session.id);
    }
  }
}

export function completeRunning(session: AgentSession, plan: Plan, running: TaskItem) {
  running.status = "done";
  plan.phase = "idle";
  plan.idleSince = Date.now();
  plan.sentAt = null;
  plan.needCompact = true;
  log(`${sessionLabel(session)} 完成：${running.title}`);
  if (session.id === store.selectedId) refreshSelectedPlan();
}

export async function startCommit(session: AgentSession, plan: Plan, task: TaskItem) {
  task.status = "committing";
  log(`${sessionLabel(session)} 开始提交：${task.title}`);
  if (session.id === store.selectedId) refreshSelectedPlan();
  await sendNow(session, plan, commitPrompt(task), false);
}

export async function startCompact(session: AgentSession, plan: Plan) {
  plan.compacting = true;
  plan.compactFrom = parseContextPercent(session.preview);
  plan.needCompact = false;
  log(`${sessionLabel(session)} 上下文 ${plan.compactFrom?.toFixed(0) ?? "?"}% ≥ ${compactThreshold(plan)}%，先压缩`);
  await sendNow(session, plan, compactCommand(session.agent), false);
}

export async function tickPlan(session: AgentSession, plan: Plan) {
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
    if (session.id === store.selectedId) refreshSelectedPlan();
    await sendNow(session, plan, withJevAsk(next.text, plan.jev), false);
  } catch (error) {
    next.status = "pending";
    plan.phase = "idle";
    plan.planRunning = false;
    log(`${sessionLabel(session)} ${String(error)}`, true);
    if (session.id === store.selectedId) {
      setAppTheme(session.agent);
      refreshSelectedPlan();
    }
  }
}

export async function maybeAutoSend() {
  for (const session of store.sessions) {
    const plan = store.plans.get(session.id);
    if (!plan?.planRunning) continue;
    await tickPlan(session, plan);
  }
}
