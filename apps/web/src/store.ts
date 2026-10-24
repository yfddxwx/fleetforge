import { create } from "zustand";

export interface TaskView {
  id: string;
  title: string;
  agent: string;
  status: string;
  branch: string | null;
  costUsd: number;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  mergeStrategy: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventEnvelopeView {
  id: string;
  seq: number;
  ts: number;
  taskId: string;
  sessionId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface AgentView {
  driverId: string;
  label: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean | string;
  running: number;
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  capabilities: Record<string, boolean>;
  hint: string | null;
}

export interface NotificationView {
  id: number;
  level: "info" | "success" | "error";
  text: string;
}

export type BoardColumn = "backlog" | "queued" | "running" | "review" | "done" | "failed" | "conflict" | "cancelled";

/** Board grouping: the 4 required lanes plus an issues lane. */
export function boardColumns(tasks: TaskView[]): Record<string, TaskView[]> {
  const columns: Record<string, TaskView[]> = {
    backlog: [],
    running: [],
    review: [],
    done: [],
    issues: [],
  };
  for (const task of tasks) {
    if (task.status === "backlog" || task.status === "queued") columns["backlog"]?.push(task);
    else if (task.status === "running") columns["running"]?.push(task);
    else if (task.status === "review" || task.status === "conflict") columns["review"]?.push(task);
    else if (task.status === "done") columns["done"]?.push(task);
    else columns["issues"]?.push(task); // failed / cancelled
  }
  return columns;
}

export interface FleetState {
  tasks: TaskView[];
  agents: AgentView[];
  eventsBySession: Record<string, EventEnvelopeView[]>;
  notifications: NotificationView[];
  selectedTaskId: string | null;
  detailTab: "events" | "transcript" | "diff";
  connected: boolean;

  setTasks: (tasks: TaskView[]) => void;
  setAgents: (agents: AgentView[]) => void;
  upsertEvent: (envelope: EventEnvelopeView) => void;
  pushNotification: (level: NotificationView["level"], text: string) => void;
  select: (taskId: string | null) => void;
  setTab: (tab: FleetState["detailTab"]) => void;
  setConnected: (connected: boolean) => void;
}

let notificationSeq = 0;

export const useFleet = create<FleetState>((set) => ({
  tasks: [],
  agents: [],
  eventsBySession: {},
  notifications: [],
  selectedTaskId: null,
  detailTab: "events",
  connected: false,

  setTasks: (tasks) => set({ tasks }),
  setAgents: (agents) => set({ agents }),

  upsertEvent: (envelope) =>
    set((state) => {
      const existing = state.eventsBySession[envelope.sessionId] ?? [];
      if (existing.some((e) => e.seq === envelope.seq)) return state;
      return {
        eventsBySession: {
          ...state.eventsBySession,
          [envelope.sessionId]: [...existing, envelope],
        },
      };
    }),

  pushNotification: (level, text) =>
    set((state) => ({
      notifications: [
        ...state.notifications.slice(-19),
        { id: ++notificationSeq, level, text },
      ],
    })),

  select: (selectedTaskId) => set({ selectedTaskId, detailTab: "events" }),
  setTab: (detailTab) => set({ detailTab }),
  setConnected: (connected) => set({ connected }),
}));

/** Events for a task across all its sessions, ordered by (ts, seq). */
export function eventsForTask(state: Pick<FleetState, "eventsBySession" | "tasks">, taskId: string): EventEnvelopeView[] {
  const sessionIds = new Set<string>();
  // events arrive keyed by sessionId; find relevant ones by taskId field
  const all: EventEnvelopeView[] = [];
  for (const list of Object.values(state.eventsBySession)) {
    for (const envelope of list) {
      if (envelope.taskId === taskId) all.push(envelope);
    }
  }
  void sessionIds;
  return all.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}
