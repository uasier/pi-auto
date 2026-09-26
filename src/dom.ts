export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function shortPath(cwd: string) {
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

export function sessionLabel(session: { paneId: string; cwd: string; title?: string }) {
  const title = session.title?.replace(/^[\s\-–—]+/, "").trim();
  if (title) return title;
  const path = shortPath(session.cwd);
  const name = path.split("/").filter(Boolean).pop();
  return name && name !== "~" ? name : session.paneId;
}
