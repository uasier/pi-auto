import { store } from "./store";
import type { AgentSession, JevDecision, Plan, TaskItem } from "./types";
import { sessionLabel } from "./dom";
import { log } from "./log";
import { commitAfterInput, compactAtInput, idleMsInput, jevMaxInput, jevOnInput, jevProvider, loopRoundsInput, providerKey, providerLabel } from "./fields";
import { providerBase } from "./keys";
import { refreshSelectedPlan } from "./view";
import { invoke } from "@tauri-apps/api/core";
import { sendNow } from "./plan-run";

const STALL_CHECK_MS = 5 * 60 * 1000;
const JEV_MIN_CONFIDENCE = 0.45;
const JEV_MIN_CONTINUE = 0.55;

export function commitPrompt(task: TaskItem) {
  return `任务「${task.title}」的功能改动已经完成。现在请立刻做 git 提交，不要继续改功能代码。

要求：
1. 运行 git status 和 git diff，只纳入这次任务相关文件
2. 不要 add 无关文件，不要 git push，不要 amend 别人的 commit
3. 若有改动：git add 后 git commit；message 用中文，可带上「${task.title}」
4. 若没有任何相关改动：不要空提交，回复「无文件变更，已跳过提交」
5. 提交完成后只确认 hash 和 message，不要再开新任务`;
}

const JEV_ASK = `【下一步建议】完成上面的工作后，在回复最末尾单独给出 2 到 4 条下一步，用这个代码块，不要在块外解释：

\`\`\`jev-next
1. 一条可立刻执行的下一步
2. 另一条
\`\`\`

每条一行，写具体要改的文件或要验证的行为。不要重复已经做完的事。如果没有值得继续的下一步，代码块里只写「无」。`;

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
  let plan = store.plans.get(id);
  if (!plan) {
    plan = emptyPlan();
    store.plans.set(id, plan);
  }
  return plan;
}

export function activePlan(): Plan | null {
  return store.selectedId ? getPlan(store.selectedId) : null;
}

export function syncPlanInputsFromUi() {
  const plan = store.selectedId ? store.plans.get(store.selectedId) : null;
  if (!plan) return;
  plan.loopRounds = Math.max(1, Number(loopRoundsInput().value) || 1);
  plan.idleMs = Math.max(1, Number(idleMsInput().value) || 2);
  plan.compactAt = Math.max(10, Math.min(95, Number(compactAtInput().value) || 70));
  plan.commitAfter = commitAfterInput().checked;
  plan.jev = jevOnInput().checked;
  plan.jevMax = Math.max(1, Math.min(8, Number(jevMaxInput().value) || 3));
}

export function applyPlanInputsToUi() {
  const plan = activePlan();
  if (!plan) return;
  loopRoundsInput().value = String(plan.loopRounds);
  idleMsInput().value = String(plan.idleMs);
  compactAtInput().value = String(plan.compactAt);
  commitAfterInput().checked = plan.commitAfter;
  jevOnInput().checked = plan.jev;
  jevMaxInput().value = String(plan.jevMax);
}


function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
}

export function outputSnapshot(raw: string) {
  return stripAnsi(raw)
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

export function outputChangeRatio(prev: string, next: string) {
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

export function armStallWatch(session: AgentSession) {
  const text = outputSnapshot(session.preview);
  store.stallWatch.set(session.id, {
    text,
    at: text ? Date.now() : Date.now() - STALL_CHECK_MS,
  });
}

export function clearStallWatch(id: string | null) {
  if (!id) return;
  store.stallWatch.delete(id);
  store.stallNudging.delete(id);
}

function stallPreviewIds(now = Date.now()) {
  const ids: string[] = [];
  for (const [id, plan] of store.plans) {
    if (!plan.planRunning) continue;
    const watch = store.stallWatch.get(id);
    if (!watch || now - watch.at >= STALL_CHECK_MS) ids.push(id);
  }
  return ids;
}

export function pollPreviewIds(now = Date.now()) {
  const ids = new Set(stallPreviewIds(now));
  for (const [id, plan] of store.plans) {
    if (plan.planRunning && plan.compacting) ids.add(id);
  }
  return [...ids];
}

function compactDoneText(preview: string) {
  const tail = stripAnsi(preview).replace(/\r/g, "").slice(-4000);
  return /compacted|compact(?:ion)? complete|conversation compacted|context compacted|已压缩|压缩完成|compact summary/i.test(tail);
}

export function agentBack(session: AgentSession) {
  return session.idle || session.agentState === "blocked" || session.agentState === "done";
}

export function compactEvidence(session: AgentSession, plan: Plan, ctx: number | null) {
  const dropped = ctx != null && ctx < compactThreshold(plan);
  const fell = plan.compactFrom != null && ctx != null && ctx <= plan.compactFrom - 8;
  const saidDone = compactDoneText(session.preview);
  return { dropped, fell, saidDone, ready: saidDone || dropped || fell };
}

export function finishCompact(session: AgentSession, plan: Plan, reason: string) {
  plan.compacting = false;
  plan.compactFrom = null;
  plan.phase = "idle";
  plan.idleSince = Date.now();
  plan.sentAt = null;
  log(`${sessionLabel(session)} 上下文压缩完成${reason}`);
  if (session.id === store.selectedId) refreshSelectedPlan();
}

export function parseContextPercent(preview: string): number | null {
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

export function compactThreshold(plan?: Plan) {
  if (plan) return Math.max(10, Math.min(95, plan.compactAt || 70));
  return Math.max(10, Math.min(95, Number(compactAtInput().value) || 70));
}

export function compactCommand(agent: string) {
  if (agent === "grok") {
    return "/compact\n请压缩当前上下文，保留任务目标和未完成工作，不要继续写代码。";
  }
  return "/compact";
}

export function loopRounds(plan?: Plan) {
  if (plan) return Math.max(1, Math.min(99, plan.loopRounds || 1));
  return Math.max(1, Math.min(99, Number(loopRoundsInput().value) || 1));
}

export function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function taskTitle(text: string) {
  const line = text.split(/\n/)[0]?.trim() ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line || "未命名任务";
}

export function withJevAsk(text: string, enabled: boolean) {
  if (!enabled) return text.trim();
  if (text.includes("```jev-next")) return text.trim();
  return `${text.trim()}\n\n${JEV_ASK}`;
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

function logLaya(scope: string, detail: string, err = false) {
  log(`Laya · ${scope} · ${detail}`, err);
}

export async function maybeJevContinue(session: AgentSession, plan: Plan, task: TaskItem) {
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
  if (session.id === store.selectedId) refreshSelectedPlan();
  return true;
}

export function makeTask(text: string, commit: boolean): TaskItem {
  const body = text.trim();
  return {
    id: newId(),
    title: taskTitle(body),
    text: body,
    commit,
    status: "pending",
  };
}

export function snapshotTemplate(plan: Plan) {
  plan.template = plan.tasks.map((t) => ({
    title: t.title,
    text: t.text,
    commit: t.commit,
  }));
}

export function counts(plan: Plan) {
  return {
    total: plan.tasks.length,
    pending: plan.tasks.filter((t) => t.status === "pending").length,
    running: plan.tasks.filter((t) => t.status === "running" || t.status === "committing").length,
    done: plan.tasks.filter((t) => t.status === "done").length,
  };
}

export function currentTask(plan: Plan) {
  return (
    plan.tasks.find((t) => t.status === "running" || t.status === "committing") ??
    plan.tasks.find((t) => t.status === "pending")
  );
}

export function parseTaskList(raw: string): string[] {
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

