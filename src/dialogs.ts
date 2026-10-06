import { LAUNCH_COMMAND, selected, store } from "./store";
import type { AppInfo, HerdrStatus, UpdateCheck } from "./types";
import { $, escapeHtml, sessionLabel, shortPath } from "./dom";
import { log } from "./log";
import { commitAfterInput } from "./fields";
import { activePlan, makeTask, parseTaskList, snapshotTemplate, taskTitle } from "./plan";
import { poll } from "./plan-run";
import { renderQueue } from "./view";
import { refreshGameBackends } from "./snake";
import { DEEPSEEK_BASE_STORAGE, DEEPSEEK_KEY_STORAGE, JEV_BASE_STORAGE, JEV_KEY_STORAGE, LAYA_BASE_STORAGE, LAYA_KEY_STORAGE, keyInput, type DecisionProvider } from "./keys";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export const HERDR_INSTALL_CMD = "curl -fsSL https://herdr.dev/install.sh | sh";
export const HERDR_DOCS = "https://herdr.dev/docs/install/";
const USAGE_SEEN_KEY = "pi-auto-usage-seen";
export const SKIP_VERSION_KEY = "pi-auto-skip-version";
const UPDATE_CHECKED_KEY = "pi-auto-update-checked-at";
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TERM_CWD_KEY = "pi-auto-term-cwd";

export const KEY_DEFAULTS: Record<DecisionProvider, string> = {
  jev: "https://api.typesafe.ai",
  deepseek: "https://api.deepseek.com",
  laya: "http://127.0.0.1:8100",
};
export const KEY_IDS: DecisionProvider[] = ["jev", "deepseek", "laya"];

function storeSetting(storage: string, value: string) {
  const text = value.trim();
  if (text) localStorage.setItem(storage, text);
  else localStorage.removeItem(storage);
}

export function baseInput(provider: DecisionProvider) {
  return $<HTMLInputElement>(`base-${provider}`);
}

export function setKeyStatus(provider: DecisionProvider, text: string, tone: "" | "ok" | "bad" = "") {
  const status = $(`key-status-${provider}`);
  status.textContent = text;
  status.className = `key-status${tone ? ` ${tone}` : ""}`;
}

export function setKeyNote(provider: DecisionProvider, text: string, tone: "" | "ok" | "bad" = "") {
  const note = $(`key-note-${provider}`);
  note.textContent = text;
  note.className = `key-note${tone ? ` ${tone}` : ""}`;
}

export function showKeys() {
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

export function hideKeys() {
  $("keys-modal").classList.add("hidden");
}

export function saveKeys() {
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

export async function checkProvider(provider: DecisionProvider) {
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

export async function checkAllProviders() {
  const button = $<HTMLButtonElement>("keys-check-all");
  button.disabled = true;
  try {
    await Promise.all(KEY_IDS.map((provider) => checkProvider(provider)));
  } finally {
    button.disabled = false;
  }
}

export function showImport(raw = "") {
  $("import-modal").classList.remove("hidden");
  const area = $<HTMLTextAreaElement>("import-raw");
  if (raw) area.value = raw;
  $<HTMLInputElement>("import-commit").checked = commitAfterInput().checked;
  refreshImportPreview();
  area.focus();
}

export function hideImport() {
  $("import-modal").classList.add("hidden");
}

export function refreshImportPreview() {
  store.importDraft = parseTaskList($<HTMLTextAreaElement>("import-raw").value);
  const box = $("import-preview");
  if (store.importDraft.length === 0) {
    box.innerHTML = "还没有解析到任务。";
    return;
  }
  const commit = $<HTMLInputElement>("import-commit").checked;
  box.innerHTML = `<b>将导入 ${store.importDraft.length} 条</b>${commit ? "，每条附带提交代码要求" : ""}<br>` +
    store.importDraft
      .slice(0, 8)
      .map((t, i) => `${i + 1}. ${escapeHtml(taskTitle(t))}`)
      .join("<br>") +
    (store.importDraft.length > 8 ? `<br>…还有 ${store.importDraft.length - 8} 条` : "");
}

export function confirmImport() {
  refreshImportPreview();
  if (store.importDraft.length === 0) {
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
  for (const text of store.importDraft) {
    plan.tasks.push(makeTask(text, commit));
  }
  if (!plan.planRunning) snapshotTemplate(plan);
  store.lastQueueSig = "";
  renderQueue();
  log(`已导入 ${store.importDraft.length} 条到 ${sessionLabel(session)}${commit ? "（含完成后提交代码）" : ""}`);
  hideImport();
}

export function showHerdrGuide() {
  hideUsageGuide();
  $("herdr-guide").classList.remove("hidden");
}

export function hideHerdrGuide() {
  $("herdr-guide").classList.add("hidden");
  maybeShowUsageGuide();
}

function usageSeen() {
  return localStorage.getItem(USAGE_SEEN_KEY) === "1";
}

export function markUsageSeen() {
  localStorage.setItem(USAGE_SEEN_KEY, "1");
}

export function showUsageGuide() {
  $("herdr-guide").classList.add("hidden");
  $("usage-guide").classList.remove("hidden");
}

export function hideUsageGuide() {
  $("usage-guide").classList.add("hidden");
}

function maybeShowUsageGuide() {
  if (usageSeen()) return;
  if (!$("herdr-guide").classList.contains("hidden")) return;
  showUsageGuide();
}

export function showAbout() {
  $("about-modal").classList.remove("hidden");
  renderAbout();
}

export function hideAbout() {
  $("about-modal").classList.add("hidden");
}

export function renderAbout() {
  const current = store.appInfo?.version ?? store.updateInfo?.currentVersion ?? "0.1.0";
  $("about-current").textContent = `v${current}`;
  $("about-latest").textContent = store.updateInfo ? `v${store.updateInfo.latestVersion}` : "尚未检查";
  $("about-status").textContent = store.updateChecking
    ? "正在检查…"
    : store.updateInstalling
      ? "正在下载…"
      : store.updateInfo?.available
        ? "有新版本"
        : store.updateInfo
          ? "已是最新"
          : "—";
  const err = $("about-error");
  err.classList.add("hidden");
  const asset = $("about-asset");
  if (store.updateInfo?.assetName) {
    asset.textContent = `安装包：${store.updateInfo.assetName}`;
    asset.classList.remove("hidden");
  } else {
    asset.classList.add("hidden");
  }
  const notes = $("about-notes");
  if (store.updateInfo?.notes) {
    notes.textContent = store.updateInfo.notes;
    notes.classList.remove("hidden");
  } else {
    notes.classList.add("hidden");
  }
  $("install-update").toggleAttribute("disabled", store.updateInstalling || !store.updateInfo?.available);
  $("check-update").toggleAttribute("disabled", store.updateChecking);
  const banner = $("update-banner");
  const skipped = localStorage.getItem(SKIP_VERSION_KEY);
  if (store.updateInfo?.available && store.updateInfo.latestVersion !== skipped) {
    $("update-banner-text").textContent = `发现新版本 v${store.updateInfo.latestVersion}`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

export function showAboutError(message: string) {
  const err = $("about-error");
  err.textContent = message;
  err.classList.remove("hidden");
}

export async function runUpdateCheck(quiet: boolean) {
  if (store.updateChecking) return null;
  store.updateChecking = true;
  renderAbout();
  try {
    const info = await invoke<UpdateCheck>("check_update");
    store.updateInfo = info;
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
    store.updateChecking = false;
    renderAbout();
  }
}

export async function showDebugFlag() {
  let debug = import.meta.env.DEV;
  try {
    debug = debug || (await invoke<boolean>("is_debug"));
  } catch {
    /* 旧调试进程没有这条命令时，仍按前端开发模式显示 */
  }
  $("debug-flag").classList.toggle("hidden", !debug);
}

export async function loadAppInfo() {
  try {
    store.appInfo = await invoke<AppInfo>("app_info");
    $("about-current").textContent = `v${store.appInfo.version}`;
  } catch {
    /* ignore */
  }
}

export async function maybeCheckUpdate() {
  const last = Number(localStorage.getItem(UPDATE_CHECKED_KEY) || 0);
  if (last && Date.now() - last < UPDATE_CHECK_EVERY_MS) return;
  await runUpdateCheck(true);
}

export async function refreshHerdrStatus() {
  try {
    const status = await invoke<HerdrStatus>("herdr_status");
    const el = $("herdr-banner");
    const text = status.connected ? `已连接 · ${status.agentCount}` : "未连接";
    if (text !== store.lastHerdrText) {
      store.lastHerdrText = text;
      el.className = `herdr-banner ${status.connected ? "on" : "off"}`;
      $("herdr-banner-text").textContent = text;
    }
    if (status.connected) {
      $("herdr-guide").classList.add("hidden");
      maybeShowUsageGuide();
    } else if (!store.herdrGuideAutoShown) {
      store.herdrGuideAutoShown = true;
      showHerdrGuide();
    }
  } catch (error) {
    const el = $("herdr-banner");
    const text = "未连接";
    if (text === store.lastHerdrText) return;
    store.lastHerdrText = text;
    el.className = "herdr-banner off";
    $("herdr-banner-text").textContent = text;
    if (!store.herdrGuideAutoShown) {
      store.herdrGuideAutoShown = true;
      showHerdrGuide();
    }
  }
}

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
  for (const session of store.sessions) add(session.cwd);
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

export async function pickTermCwd() {
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

export function showTermCreate() {
  const kind = $<HTMLSelectElement>("term-kind");
  $<HTMLInputElement>("term-command").value = LAUNCH_COMMAND[kind.value] ?? "";
  $("term-command-row").classList.toggle("hidden", kind.value === "shell");
  const preferred = selected()?.cwd || localStorage.getItem(TERM_CWD_KEY) || "";
  renderTermPaths(preferred);
  $("term-modal").classList.remove("hidden");
}

export function hideTermCreate() {
  $("term-modal").classList.add("hidden");
}

export async function createTerminal(event: Event) {
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
    store.followPane = { paneId: created.paneId, want: kind === "shell" ? "shell" : kind, until: Date.now() + 20000 };
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
