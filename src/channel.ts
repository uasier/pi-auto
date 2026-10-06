import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $ } from "./dom";
import { log } from "./log";

export const DEFAULT_CHANNEL_URL = "wss://154.36.168.192:8443/v1/ws";
export const DEFAULT_CHANNEL_PIN = "38b30e49ecfb8daace9100a133399992bc1a7cdc62954eeaa3a87290881e1507";

type ChannelView = {
  enabled: boolean;
  url: string;
  token: string;
  pinSha256: string;
  allowInput: boolean;
  connected: boolean;
  devices: number;
  error: string | null;
  pageUrl: string;
  apkUrl: string;
  accountName: string;
  githubLogin: string;
  githubName: string;
};

function field() {
  return {
    enabled: $<HTMLInputElement>("channel-enabled"),
    url: $<HTMLInputElement>("channel-url"),
    token: $<HTMLInputElement>("channel-token"),
    pin: $<HTMLInputElement>("channel-pin"),
    input: $<HTMLInputElement>("channel-input"),
  };
}

function fill(view: ChannelView) {
  const ui = field();
  ui.enabled.checked = view.enabled;
  ui.url.value = view.url || DEFAULT_CHANNEL_URL;
  ui.token.value = view.token || "";
  ui.pin.value = view.pinSha256 || DEFAULT_CHANNEL_PIN;
  ui.input.checked = view.allowInput;
  const note = $("channel-note");
  note.textContent = view.error ? view.error : view.githubLogin ? (view.connected ? "手机登录同一账号即可看到这台 Mac" : "正在上线") : "登录后才会出现在手机里";
  note.classList.toggle("ok", view.connected && !view.error);
  $("github-user").textContent = view.githubLogin ? view.githubLogin : "未登录";
  $("github-login").textContent = view.githubLogin ? "重新登录" : "登录并上线";
  $("github-logout").classList.toggle("hidden", !view.githubLogin);
  $<HTMLInputElement>("channel-page").value = view.pageUrl || "";
  $<HTMLInputElement>("channel-apk").value = view.apkUrl || "";
  const button = $("channel-btn");
  button.textContent = view.connected ? `通道 ${view.devices}` : "通道";
  button.classList.toggle("on", view.connected);
}

export async function refreshChannel() {
  try {
    fill(await invoke<ChannelView>("channel_status"));
  } catch (error) {
    $("channel-note").textContent = String(error);
  }
}

export function showChannel() {
  $("channel-modal").classList.remove("hidden");
  void refreshChannel();
}

export function hideChannel() {
  $("channel-modal").classList.add("hidden");
}

async function startGitHub() {
  $("github-code").textContent = "正在向服务器申请 GitHub 登录…";
  try {
    const started = await invoke<{ userCode: string; verificationUri: string; pollId: string }>("channel_github_start");
    $("github-code").textContent = "在浏览器里点授权，然后回到这里。";
    await openUrl(started.verificationUri);
  } catch (error) {
    $("github-code").textContent = String(error);
    log(`GitHub 登录失败：${error}`, true);
  }
}

export async function saveChannel() {
  const ui = field();
  try {
    fill(await invoke<ChannelView>("channel_save", {
      enabled: ui.enabled.checked,
      url: ui.url.value,
      token: ui.token.value,
      pinSha256: ui.pin.value,
      allowInput: ui.input.checked,
    }));
    log(ui.enabled.checked ? "通道已保存，正在连接中继" : "通道已关闭");
  } catch (error) {
    $("channel-note").textContent = String(error);
    log(`通道保存失败：${error}`, true);
  }
}

async function copy(id: string) {
  const value = $<HTMLInputElement>(id).value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    log("已复制链接");
  } catch {
    $<HTMLInputElement>(id).select();
  }
}

export function installChannel() {
  $("channel-btn").addEventListener("click", () => showChannel());
  $("channel-close").addEventListener("click", () => hideChannel());
  $("channel-save").addEventListener("click", () => void saveChannel());
  $("github-login").addEventListener("click", () => void startGitHub());
  $("github-logout").addEventListener("click", () => {
    void invoke("channel_github_logout").then(() => refreshChannel()).catch((error) => {
      $("github-code").textContent = String(error);
    });
  });
  void listen<{ login?: string; error?: string }>("github-login", (event) => {
    if (event.payload.error) {
      $("github-code").textContent = event.payload.error;
      log(`GitHub 登录失败：${event.payload.error}`, true);
      return;
    }
    $("github-code").textContent = event.payload.login ? `已关联 ${event.payload.login}` : "已登录";
    log(`GitHub 已登录：${event.payload.login || ""}`);
    void refreshChannel();
  });
  $("channel-copy").addEventListener("click", () => void copy("channel-page"));
  $("channel-copy-apk").addEventListener("click", () => void copy("channel-apk"));
  $("channel-reveal").addEventListener("click", () => {
    const input = field().token;
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    $("channel-reveal").textContent = hidden ? "隐藏" : "显示";
  });
  $("channel-modal").addEventListener("click", (event) => {
    if (event.target === $("channel-modal")) hideChannel();
  });
  void listen<ChannelView>("channel-status", (event) => {
    fill(event.payload);
  });
  void refreshChannel();
}
