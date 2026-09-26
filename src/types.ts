export type AgentSession = {
  id: string;
  paneId: string;
  title: string;
  agent: string;
  agentLabel: string;
  agentState: string;
  cwd: string;
  idle: boolean;
  confidence: string;
  reason: string;
  preview: string;
};

export type TaskStatus = "pending" | "running" | "committing" | "done";
export type TaskItem = {
  id: string;
  title: string;
  text: string;
  commit: boolean;
  status: TaskStatus;
};
export type Phase = "idle" | "sent" | "working" | "settling";
export type Plan = {
  tasks: TaskItem[];
  template: Array<Pick<TaskItem, "title" | "text" | "commit">>;
  currentRound: number;
  phase: Phase;
  idleSince: number | null;
  sentAt: number | null;
  planRunning: boolean;
  compacting: boolean;
  compactFrom: number | null;
  needCompact: boolean;
  loopRounds: number;
  idleMs: number;
  compactAt: number;
  commitAfter: boolean;
  jev: boolean;
  jevMax: number;
  jevRuns: number;
};
export type HerdrStatus = {
  connected: boolean;
  endpoint: string | null;
  paneCount: number;
  agentCount: number;
  error: string | null;
};
export type UpdateCheck = {
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
export type AppInfo = {
  version: string;
  repo: string;
};
export type StallWatch = { text: string; at: number };
export type JevDecision = {
  choice: string;
  confidence: number;
  continueNow: number;
  endpoint?: string;
};
