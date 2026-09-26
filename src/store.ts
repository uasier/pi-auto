import type { AgentSession, AppInfo, Plan, StallWatch, UpdateCheck } from "./types";

export const AGENT_ORDER = ["pi", "claude", "codex", "grok", "shell"] as const;
export const AGENT_META: Record<string, { label: string; hint: string }> = {
  pi: { label: "Pi", hint: "π" },
  claude: { label: "Claude", hint: "Anthropic" },
  codex: { label: "Codex", hint: "OpenAI" },
  grok: { label: "Grok", hint: "xAI" },
  shell: { label: "终端", hint: "shell" },
};
export const LAUNCH_COMMAND: Record<string, string> = {
  shell: "",
  pi: "pi",
  claude: "claude",
  codex: "codex",
  grok: "grok",
};

export const store = {
  sessions: [] as AgentSession[],
  selectedId: null as string | null,
  plans: new Map<string, Plan>(),
  pollTimer: null as number | null,
  activeSheet: "pi" as (typeof AGENT_ORDER)[number],
  followPane: null as { paneId: string; want: string; until: number } | null,
  importDraft: [] as string[],
  lastListSig: "",
  lastQueueSig: "",
  editingTaskId: null as string | null,
  editingDraft: "",
  lastHeadSig: "",
  lastHerdrText: "",
  herdrGuideAutoShown: false,
  appInfo: null as AppInfo | null,
  updateInfo: null as UpdateCheck | null,
  updateChecking: false,
  updateInstalling: false,
  pollInFlight: false,
  stallWatch: new Map<string, StallWatch>(),
  stallNudging: new Set<string>(),
};

export function selected() {
  return store.sessions.find((item) => item.id === store.selectedId);
}
