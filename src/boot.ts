import { LAUNCH_COMMAND, selected, store } from "./store";
import { log, logShortcut, toggleLogDock } from "./log";
import { JEV_PROVIDER_STORAGE, commitAfterInput, compactAtInput, idleMsInput, jevMaxInput, jevOnInput, jevProvider, jevProviderInput, loopRoundsInput } from "./fields";
import { syncPlanInputsFromUi } from "./plan";
import { pauseLoop, poll, startLoop, stopLoop } from "./plan-run";
import { addPlanTask, renderLoopStatus, syncExecPanels, syncRunButtons } from "./view";
import { HERDR_DOCS, HERDR_INSTALL_CMD, KEY_DEFAULTS, KEY_IDS, SKIP_VERSION_KEY, baseInput, checkAllProviders, checkProvider, confirmImport, createTerminal, hideAbout, hideHerdrGuide, hideImport, hideKeys, hideTermCreate, hideUsageGuide, loadAppInfo, markUsageSeen, maybeCheckUpdate, pickTermCwd, refreshHerdrStatus, refreshImportPreview, renderAbout, runUpdateCheck, saveKeys, setKeyNote, setKeyStatus, showAbout, showAboutError, showDebugFlag, showHerdrGuide, showImport, showKeys, showTermCreate, showUsageGuide } from "./dialogs";
import { installIdleGame } from "./idle-game";
import { bindPromptSession, onPromptKey, onTermBytes, onTermClosed, replaceInputWithRefine } from "./terminal";
import { keyInput, type DecisionProvider } from "./keys";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $ } from "./dom";
import { hideShortcuts, saveShortcuts, shortcutEnabled, showShortcuts } from "./shortcuts";
import { hideChannel, installChannel, saveChannel, showChannel } from "./channel";
import { installTheme } from "./theme";

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
  void listen<{ generation: number; full: boolean; width: number; height: number; bytes: string }>("term-bytes", (event) => {
    onTermBytes(event.payload);
  });
  void listen<string>("term-closed", (event) => {
    onTermClosed(event.payload || "终端连接已断开");
  });
  void listen<string>("app-menu", (event) => {
    if (event.payload === "ai-keys") {
      logShortcut("⌘, 密钥设置");
      showKeys();
    }
    if (event.payload === "channel") showChannel();
    if (event.payload === "refine") {
      if (!shortcutEnabled("refine")) {
        log("优化输入已在快捷键里关闭");
        return;
      }
      logShortcut("⌘⇧O 优化输入");
      void replaceInputWithRefine();
    }
    if (event.payload === "shortcuts") showShortcuts();
    if (event.payload === "new-window") logShortcut("⌘N 新建窗口");
    if (event.payload === "usage") {
      logShortcut("⌘/ 使用说明");
      showUsageGuide();
    }
    if (event.payload === "check-update") {
      showAbout();
      void runUpdateCheck(false);
    }
  });
  $("check-update").addEventListener("click", () => {
    void runUpdateCheck(false);
  });
  $("open-release").addEventListener("click", () => {
    void invoke("open_release_page", { url: store.updateInfo?.htmlUrl ?? null });
  });
  $("install-update").addEventListener("click", async () => {
    if (store.updateInstalling || !store.updateInfo?.available) return;
    store.updateInstalling = true;
    renderAbout();
    try {
      const path = await invoke<string>("install_update");
      log(`已打开安装包：${path}`);
    } catch (error) {
      showAboutError(String(error));
      log(`下载更新失败：${error}`, true);
    } finally {
      store.updateInstalling = false;
      renderAbout();
    }
  });
  $("update-banner-open").addEventListener("click", () => showAbout());
  $("update-banner-skip").addEventListener("click", () => {
    if (store.updateInfo?.latestVersion) localStorage.setItem(SKIP_VERSION_KEY, store.updateInfo.latestVersion);
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
  $("shortcuts-save").addEventListener("click", saveShortcuts);
  $("shortcuts-close").addEventListener("click", hideShortcuts);
  $("shortcuts-modal").addEventListener("click", (event) => {
    if (event.target === $("shortcuts-modal")) hideShortcuts();
  });
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
  $("log-toggle").addEventListener("click", () => {
    void toggleLogDock();
  });
  window.addEventListener("keydown", (event) => {
    if (onPromptKey(event)) return;
    if (!$("term-modal").classList.contains("hidden") && event.key === "Escape") {
      hideTermCreate();
      return;
    }
    if (!$("shortcuts-modal").classList.contains("hidden") && event.key === "Escape") {
      event.preventDefault();
      hideShortcuts();
      return;
    }
    if (!$("channel-modal").classList.contains("hidden") && event.key === "Escape") {
      event.preventDefault();
      hideChannel();
      return;
    }
    if (!$("channel-modal").classList.contains("hidden") && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void saveChannel();
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
  }, true);
  syncRunButtons();
  bindPromptSession(() => selected());
  installIdleGame();

  installChannel();
  void installTheme();
  void showDebugFlag();
  log("已启动");
  void loadAppInfo().then(() => maybeCheckUpdate());
  void refreshHerdrStatus();
  void poll();
  store.pollTimer = window.setInterval(() => {
    void poll();
  }, 1300);
});

window.addEventListener("beforeunload", () => {
  if (store.pollTimer) window.clearInterval(store.pollTimer);
});
