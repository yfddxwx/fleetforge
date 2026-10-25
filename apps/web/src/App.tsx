import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { boardColumns, eventsForTask, useFleet, type TaskView } from "./store";
import { describeEvent, formatUsd } from "./events-format";

/// <reference types="vite/client" />
const API = ((import.meta as unknown as { env?: Record<string, string> }).env?.["VITE_FLEET_API"] ?? "");

export function App() {
  const [view, setView] = useState<"board" | "roster" | "costs" | "settings">("board");
  useFleetConnection();
  useKeyboardNav();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-slate-800 px-4 py-2">
        <h1 className="text-base font-bold text-cyan-400">fleetforge</h1>
        <nav className="flex gap-1">
          {(["board", "roster", "costs", "settings"] as const).map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={`rounded px-2 py-0.5 ${view === item ? "bg-cyan-600/30 text-cyan-300" : "text-slate-400 hover:text-slate-200"}`}
            >
              {item}
            </button>
          ))}
        </nav>
        <ConnectionBadge />
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <span>? keys</span>
        </div>
      </header>
      <main className="flex min-h-0 flex-1">
        {view === "board" && <BoardView />}
        {view === "roster" && <RosterView />}
        {view === "costs" && <CostsView />}
        {view === "settings" && <SettingsView />}
      </main>
      <NotificationCenter />
    </div>
  );
}

function ConnectionBadge() {
  const connected = useFleet((s) => s.connected);
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${connected ? "bg-green-900/60 text-green-300" : "bg-red-900/60 text-red-300"}`}>
      {connected ? "live" : "offline"}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * API + WS plumbing
 * ------------------------------------------------------------------------- */

function useFleetConnection() {
  const setTasks = useFleet((s) => s.setTasks);
  const setAgents = useFleet((s) => s.setAgents);
  const upsertEvent = useFleet((s) => s.upsertEvent);
  const pushNotification = useFleet((s) => s.pushNotification);
  const setConnected = useFleet((s) => s.setConnected);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const [tasksRes, agentsRes] = await Promise.all([fetch(`${API}/api/tasks`), fetch(`${API}/api/agents`)]);
        const tasks = ((await tasksRes.json()) as { tasks: TaskView[] }).tasks;
        const agents = ((await agentsRes.json()) as { agents: never[] }).agents;
        if (!cancelled) {
          setTasks(tasks);
          setAgents(agents);
        }
      } catch {
        /* offline; WS badge reflects state */
      }
    };
    void refresh();
    const poll = setInterval(refresh, 2000);

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      socket = null;
    }
    socket?.addEventListener("open", () => setConnected(true));
    socket?.addEventListener("close", () => setConnected(false));
    socket?.addEventListener("message", (raw) => {
      const frame = JSON.parse((raw as MessageEvent).data as string) as {
        type: string;
        taskId?: string;
        envelope?: { sessionId: string };
        level?: "info" | "success" | "error";
        text?: string;
      };
      if (frame.type === "event" && frame.envelope) {
        const env = frame.envelope as unknown as Record<string, unknown>;
        upsertEvent({ ...env, taskId: frame.taskId as string } as never);
        void refresh();
      } else if (frame.type === "notification" && frame.text) {
        pushNotification(frame.level ?? "info", frame.text);
      } else if (frame.type === "task") {
        void refresh();
      }
    });

    return () => {
      cancelled = true;
      clearInterval(poll);
      socket?.close();
    };
  }, [setTasks, setAgents, upsertEvent, pushNotification, setConnected]);
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  return response.json();
}

/* ---------------------------------------------------------------------------
 * Keyboard navigation (shortcuts.md)
 * ------------------------------------------------------------------------- */

function useKeyboardNav() {
  const tasks = useFleet((s) => s.tasks);
  const selectedTaskId = useFleet((s) => s.selectedTaskId);
  const select = useFleet((s) => s.select);
  const pushNotification = useFleet((s) => s.pushNotification);

  const ordered = useMemo(() => {
    const columns = boardColumns(tasks);
    return [...(columns["backlog"] ?? []), ...(columns["running"] ?? []), ...(columns["review"] ?? []), ...(columns["done"] ?? []), ...(columns["issues"] ?? [])];
  }, [tasks]);

  const dispatchSelected = useCallback(async () => {
    if (!selectedTaskId) return;
    await api("POST", `/api/tasks/${selectedTaskId}/dispatch`);
    pushNotification("info", "dispatch issued");
  }, [selectedTaskId, pushNotification]);

  const cancelSelected = useCallback(async () => {
    if (!selectedTaskId) return;
    if (!confirm("cancel this task?")) return;
    await api("POST", `/api/tasks/${selectedTaskId}/cancel`);
    pushNotification("info", "cancel issued");
  }, [selectedTaskId, pushNotification]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      const index = ordered.findIndex((t) => t.id === selectedTaskId);
      switch (event.key) {
        case "j":
        case "ArrowDown": {
          const next = ordered[Math.min(ordered.length - 1, index + 1)];
          if (next) select(next.id);
          break;
        }
        case "k":
        case "ArrowUp": {
          const prev = ordered[Math.max(0, index - 1)];
          if (prev) select(prev.id);
          break;
        }
        case "d":
          void dispatchSelected();
          break;
        case "c":
          void cancelSelected();
          break;
        case "Escape":
          select(null);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selectedTaskId, select, dispatchSelected, cancelSelected]);
}

/* ---------------------------------------------------------------------------
 * Board
 * ------------------------------------------------------------------------- */

const COLUMN_STYLES: Record<string, { title: string; accent: string }> = {
  backlog: { title: "backlog", accent: "border-slate-600" },
  running: { title: "running", accent: "border-green-500" },
  review: { title: "review", accent: "border-cyan-500" },
  done: { title: "done", accent: "border-blue-500" },
  issues: { title: "failed / dropped", accent: "border-red-500" },
};

function BoardView() {
  const tasks = useFleet((s) => s.tasks);
  const select = useFleet((s) => s.select);
  const setTasks = useFleet((s) => s.setTasks);
  const columns = boardColumns(tasks);

  const onDrop = useCallback(
    async (status: string, taskId: string) => {
      if (status === "backlog") {
        await api("POST", `/api/tasks/${taskId}/cancel`);
      } else if (status === "review") {
        await api("POST", `/api/tasks/${taskId}/merge`, { dryRun: true });
      }
      // other lanes are state-machine driven; a drop only triggers operator intents
      const refreshed = (await (await fetch(`${API}/api/tasks`)).json()) as { tasks: TaskView[] };
      setTasks(refreshed.tasks);
    },
    [setTasks],
  );

  return (
    <div className="flex min-h-0 w-full">
      {Object.entries(columns).map(([key, lane]) => (
        <Lane key={key} laneKey={key} tasks={lane} onDrop={onDrop} onSelect={select} />
      ))}
      <TaskDetail />
    </div>
  );
}

function Lane({
  laneKey,
  tasks,
  onDrop,
  onSelect,
}: {
  laneKey: string;
  tasks: TaskView[];
  onDrop: (status: string, taskId: string) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const style = COLUMN_STYLES[laneKey] ?? { title: laneKey, accent: "border-slate-600" };
  const [dragOver, setDragOver] = useState(false);
  return (
    <section
      className={`flex min-w-56 flex-1 flex-col border-l-2 ${style.accent} ${dragOver ? "bg-slate-800/60" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const taskId = event.dataTransfer.getData("text/fleet-task");
        if (taskId) void onDrop(laneKey, taskId);
      }}
    >
      <h2 className="px-2 py-1 text-xs uppercase tracking-wider text-slate-500">
        {style.title} <span className="text-slate-600">{tasks.length}</span>
      </h2>
      <div className="flex-1 space-y-1 overflow-y-auto p-1">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onSelect={onSelect} />
        ))}
        {tasks.length === 0 && <p className="p-2 text-xs text-slate-700">empty</p>}
      </div>
    </section>
  );
}

function TaskCard({ task, onSelect }: { task: TaskView; onSelect: (id: string) => void }) {
  const selectedTaskId = useFleet((s) => s.selectedTaskId);
  const selected = selectedTaskId === task.id;
  return (
    <article
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/fleet-task", task.id)}
      onClick={() => onSelect(task.id)}
      className={`cursor-pointer rounded border p-2 ${selected ? "border-cyan-400 bg-cyan-950/40" : "border-slate-800 bg-slate-900 hover:border-slate-600"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold">{task.title}</span>
        <span className="shrink-0 text-[10px] text-slate-500">{task.agent}</span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
        <span>{task.branch ?? "—"}</span>
        <span>{formatUsd(task.costUsd)}</span>
      </div>
      {task.error && <p className="mt-1 truncate text-[10px] text-red-400">{task.error}</p>}
    </article>
  );
}

/* ---------------------------------------------------------------------------
 * Task detail: events / transcript / diff
 * ------------------------------------------------------------------------- */

function TaskDetail() {
  const selectedTaskId = useFleet((s) => s.selectedTaskId);
  const tab = useFleet((s) => s.detailTab);
  const setTab = useFleet((s) => s.setTab);
  const state = useFleet();
  const [transcript, setTranscript] = useState<Array<{ role: string; text: string }>>([]);
  const [diff, setDiff] = useState<{ files: Array<{ path: string; change: string; additions: number; deletions: number }>; patch: string; conflicts: string[]; mergeable: boolean } | null>(null);
  const [followUpText, setFollowUpText] = useState("");
  const pushNotification = useFleet((s) => s.pushNotification);

  const events = useMemo(
    () => (selectedTaskId ? eventsForTask(state, selectedTaskId) : []),
    [state, selectedTaskId],
  );
  const task = state.tasks.find((t) => t.id === selectedTaskId);

  useEffect(() => {
    if (!selectedTaskId) return;
    setTranscript([]);
    setDiff(null);
    void (async () => {
      const t = (await (await fetch(`${API}/api/tasks/${selectedTaskId}/transcript`)).json()) as { lines: Array<{ role: string; text: string }> };
      setTranscript(t.lines);
      // historical replay so the events tab shows finished sessions too
      const history = (await (await fetch(`${API}/api/tasks/${selectedTaskId}/events`)).json()) as {
        events: Array<{ sessionId: string }>;
      };
      for (const envelope of history.events as never[]) {
        useFleet.getState().upsertEvent(envelope);
      }
    })();
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId || tab !== "diff" || !task?.branch) return;
    void (async () => {
      const d = (await (await fetch(`${API}/api/tasks/${selectedTaskId}/diff`)).json()) as typeof diff;
      setDiff(d);
    })();
  }, [selectedTaskId, tab, task?.branch]);

  if (!selectedTaskId || !task) {
    return (
      <aside className="w-96 border-l border-slate-800 p-4 text-xs text-slate-600">
        select a task (j/k) to inspect
      </aside>
    );
  }

  const sendFollowUp = async (): Promise<void> => {
    if (!followUpText.trim()) return;
    const result = (await api("POST", `/api/tasks/${selectedTaskId}/followup`, { text: followUpText })) as { sent?: boolean; reason?: string };
    pushNotification(result.sent ? "info" : "error", result.sent ? "follow-up sent" : `follow-up rejected: ${result.reason ?? "?"}`);
    setFollowUpText("");
  };

  const merge = async (dryRun: boolean): Promise<void> => {
    const result = (await api("POST", `/api/tasks/${selectedTaskId}/merge`, { dryRun })) as { merged?: boolean; conflicts?: string[]; error?: string; guidance?: string[] };
    if (dryRun) {
      pushNotification(result.conflicts && result.conflicts.length > 0 ? "error" : "info", result.conflicts?.length ? `conflicts: ${result.conflicts.join(", ")}` : "mergeable — press M to merge");
    } else {
      pushNotification(result.merged ? "success" : "error", result.merged ? "merged" : (result.error ?? "merge failed"));
    }
  };

  return (
    <aside className="flex w-[38rem] flex-col border-l border-slate-800">
      <div className="border-b border-slate-800 p-2">
        <h3 className="truncate text-sm font-semibold">{task.title}</h3>
        <p className="text-[10px] text-slate-500">
          {task.repoPath} @ {task.baseBranch} → {task.branch ?? "—"} · attempt {task.attempt}/{task.maxAttempts}
        </p>
        {task.error && <p className="mt-1 text-[10px] text-red-400">{task.error}</p>}
      </div>
      <div className="flex gap-1 border-b border-slate-800 px-2 py-1">
        {(["events", "transcript", "diff"] as const).map((item, index) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`rounded px-2 py-0.5 text-xs ${tab === item ? "bg-cyan-600/30 text-cyan-300" : "text-slate-500 hover:text-slate-300"}`}
          >
            {index + 1} {item}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {task.status === "review" && (
            <>
              <button onClick={() => void merge(true)} className="rounded bg-slate-800 px-2 text-xs hover:bg-slate-700">dry-run</button>
              <button onClick={() => void merge(false)} className="rounded bg-cyan-800 px-2 text-xs hover:bg-cyan-700">merge</button>
            </>
          )}
          <button
            onClick={() => confirm("discard this task (worktree + branch)?") && void api("POST", `/api/tasks/${selectedTaskId}/discard`, { force: confirm("force? uncommitted changes will be lost") })}
            className="rounded bg-red-900/60 px-2 text-xs hover:bg-red-800"
          >
            discard
          </button>
        </div>
      </div>

      {tab === "events" && (
        <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
          {events.length === 0 && <p className="text-slate-600">waiting for events…</p>}
          {events.map((event) => {
            const { label, text, tone } = describeEvent(event);
            const toneClass = { dim: "text-slate-500", info: "text-cyan-300", good: "text-green-400", bad: "text-red-400", warn: "text-yellow-300" }[tone];
            return (
              <div key={`${event.sessionId}:${event.seq}`} className="flex gap-2">
                <span className="w-10 shrink-0 text-right text-slate-700">{event.seq}</span>
                <span className="w-16 shrink-0 text-slate-600">{label}</span>
                <span className={`min-w-0 flex-1 break-all ${toneClass}`}>{text}</span>
              </div>
            );
          })}
        </div>
      )}

      {tab === "transcript" && (
        <div className="flex-1 overflow-y-auto p-2 text-xs">
          {transcript.map((line, index) => (
            <div key={index} className="mb-2">
              <span className={`mr-2 font-semibold ${line.role === "assistant" ? "text-cyan-300" : line.role === "operator" ? "text-yellow-300" : "text-slate-500"}`}>{line.role}</span>
              <span className="whitespace-pre-wrap text-slate-300">{line.text}</span>
            </div>
          ))}
          {transcript.length === 0 && <p className="text-slate-600">no transcript</p>}
        </div>
      )}

      {tab === "diff" && (
        <div className="flex-1 overflow-y-auto p-2 text-xs">
          {!diff && <p className="text-slate-600">loading diff…</p>}
          {diff && (
            <>
              {diff.conflicts.length > 0 && (
                <div className="mb-2 rounded bg-red-950/60 p-2 text-red-300">
                  conflicts: {diff.conflicts.join(", ")}
                </div>
              )}
              <table className="mb-2 w-full">
                <tbody>
                  {diff.files.map((file) => (
                    <tr key={file.path}>
                      <td className={`w-4 ${file.change === "add" ? "text-green-400" : file.change === "delete" ? "text-red-400" : "text-yellow-300"}`}>
                        {{ add: "+", modify: "~", delete: "-", rename: "→" }[file.change] ?? "?"}
                      </td>
                      <td className="text-slate-300">{file.path}</td>
                      <td className="text-right text-green-500">+{file.additions}</td>
                      <td className="text-right text-red-500">-{file.deletions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <pre className="whitespace-pre-wrap break-all text-[10px] text-slate-400">{diff.patch.slice(0, 20000)}</pre>
            </>
          )}
        </div>
      )}

      <div className="border-t border-slate-800 p-2">
        <div className="flex gap-1">
          <input
            value={followUpText}
            onChange={(event) => setFollowUpText(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void sendFollowUp()}
            placeholder="follow-up to the running agent…"
            className="min-w-0 flex-1 rounded bg-slate-900 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-cyan-600"
          />
          <button onClick={() => void sendFollowUp()} className="rounded bg-slate-800 px-2 text-xs hover:bg-slate-700">send</button>
        </div>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------------------
 * Roster / costs / settings / notifications (M6+M7 surfaces)
 * ------------------------------------------------------------------------- */

function RosterView() {
  const agents = useFleet((s) => s.agents);
  return (
    <div className="w-full overflow-y-auto p-4">
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="p-2">agent</th>
            <th className="p-2">state</th>
            <th className="p-2">version</th>
            <th className="p-2">running</th>
            <th className="p-2">tokens (in/out)</th>
            <th className="p-2">cost</th>
            <th className="p-2">capabilities</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.driverId} className="border-t border-slate-800">
              <td className="p-2 font-semibold">{agent.label}</td>
              <td className={`p-2 ${agent.installed ? (agent.authenticated === false ? "text-yellow-400" : "text-green-400") : "text-slate-600"}`}>
                {agent.installed ? (agent.authenticated === false ? "not logged in" : "ready") : "not installed"}
              </td>
              <td className="p-2 text-slate-500">{agent.version ?? "—"}</td>
              <td className="p-2">{agent.running}</td>
              <td className="p-2 text-slate-400">
                {agent.totals.inputTokens.toLocaleString()} / {agent.totals.outputTokens.toLocaleString()}
              </td>
              <td className="p-2">{formatUsd(agent.totals.costUsd)}</td>
              <td className="p-2 text-[10px] text-slate-500">
                {Object.entries(agent.capabilities)
                  .map(([cap, on]) => `${on ? "" : "!"}${cap}`)
                  .join(" ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {agents.some((a) => a.hint) && (
        <div className="mt-4 space-y-1 text-[10px] text-slate-500">
          {agents.filter((a) => a.hint).map((a) => (
            <p key={a.driverId}>! {a.driverId}: {a.hint}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function CostsView() {
  const [groupBy, setGroupBy] = useState<"task" | "agent" | "model" | "day">("agent");
  const [rows, setRows] = useState<Array<{ key: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; events: number }>>([]);
  const [priceTable, setPriceTable] = useState<string>("");
  const pushNotification = useFleet((s) => s.pushNotification);

  useEffect(() => {
    void (async () => {
      const data = (await (await fetch(`${API}/api/usage/aggregate?groupBy=${groupBy}`)).json()) as { rows: typeof rows };
      setRows(data.rows);
    })();
  }, [groupBy]);

  useEffect(() => {
    void (async () => {
      const prices = (await (await fetch(`${API}/api/prices`)).json()) as unknown;
      setPriceTable(JSON.stringify(prices, null, 2));
    })();
  }, []);

  const savePrices = async (): Promise<void> => {
    try {
      await api("PUT", "/api/prices", JSON.parse(priceTable));
      pushNotification("success", "price table updated");
    } catch (error) {
      pushNotification("error", `price table rejected: ${error instanceof Error ? error.message : "bad json"}`);
    }
  };

  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <div className="flex w-full min-h-0">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">cost dashboard</h2>
          <span className="text-xs text-slate-500">total {formatUsd(total)}</span>
          <div className="ml-auto flex gap-1">
            {(["task", "agent", "model", "day"] as const).map((g) => (
              <button key={g} onClick={() => setGroupBy(g)} className={`rounded px-2 py-0.5 text-xs ${groupBy === g ? "bg-cyan-600/30 text-cyan-300" : "text-slate-500"}`}>
                {g}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="p-2">{groupBy}</th>
              <th className="p-2 text-right">in</th>
              <th className="p-2 text-right">out</th>
              <th className="p-2 text-right">cache-r</th>
              <th className="p-2 text-right">events</th>
              <th className="p-2 text-right">cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-slate-800">
                <td className="p-2">{row.key}</td>
                <td className="p-2 text-right">{row.inputTokens.toLocaleString()}</td>
                <td className="p-2 text-right">{row.outputTokens.toLocaleString()}</td>
                <td className="p-2 text-right">{row.cacheReadTokens.toLocaleString()}</td>
                <td className="p-2 text-right">{row.events}</td>
                <td className="p-2 text-right">{formatUsd(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex w-[28rem] flex-col border-l border-slate-800">
        <div className="flex items-center gap-2 border-b border-slate-800 p-2">
          <h3 className="text-xs font-semibold">price table (editable JSON)</h3>
          <button onClick={() => void savePrices()} className="ml-auto rounded bg-slate-800 px-2 py-0.5 text-xs hover:bg-slate-700">save</button>
        </div>
        <textarea
          value={priceTable}
          onChange={(event) => setPriceTable(event.target.value)}
          spellCheck={false}
          className="flex-1 resize-none bg-slate-950 p-2 font-mono text-[10px] outline-none"
        />
      </div>
    </div>
  );
}

function SettingsView() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const pushNotification = useFleet((s) => s.pushNotification);
  const [saved, setSaved] = useState<Record<string, unknown>>({});

  useEffect(() => {
    void (async () => {
      const data = (await (await fetch(`${API}/api/settings`)).json()) as { settings: Record<string, unknown> };
      setSettings(data.settings);
      setSaved(data.settings);
    })();
  }, []);

  const save = async (): Promise<void> => {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(saved)) {
      const raw = settings[key];
      next[key] = typeof saved[key] === "number" ? Number(raw) : raw;
    }
    await api("PUT", "/api/settings", next);
    pushNotification("success", "settings saved");
  };

  const num = (key: string, label: string, hint: string): ReactElement => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-44 text-slate-400">{label}</span>
      <input
        type="number"
        value={Number(settings[key] ?? 0)}
        onChange={(event) => setSettings({ ...settings, [key]: Number(event.target.value) })}
        className="w-20 rounded bg-slate-900 px-2 py-1 outline-none focus:ring-1 focus:ring-cyan-600"
      />
      <span className="text-[10px] text-slate-600">{hint}</span>
    </label>
  );

  return (
    <div className="w-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">settings</h2>
        <button onClick={() => void save()} className="ml-auto rounded bg-cyan-800 px-3 py-1 text-xs hover:bg-cyan-700">save</button>
      </div>
      <div className="space-y-2">
        {num("maxConcurrent", "global concurrency cap", "max tasks running at once (applies immediately)")}
        {num("maxConcurrentPerRepo", "per-repo concurrency cap", "max tasks per repository")}
      </div>
      <p className="mt-4 text-[10px] text-slate-600">
        merge strategy &amp; driver toggles are per-task / doctor-level; price table edits live on the cost dashboard.
      </p>
    </div>
  );
}

function NotificationCenter() {
  const notifications = useFleet((s) => s.notifications);
  const latest = notifications.slice(-3);
  const timer = useRef<number>(0);
  useEffect(() => {
    timer.current = window.setTimeout(() => undefined, 4000);
    return () => clearTimeout(timer.current);
  }, [notifications.length]);
  return (
    <footer className="space-y-1 border-t border-slate-800 px-4 py-1">
      {latest.map((notification) => (
        <p
          key={notification.id}
          className={`text-xs ${notification.level === "success" ? "text-green-400" : notification.level === "error" ? "text-red-400" : "text-slate-400"}`}
        >
          {notification.level === "error" ? "✖" : notification.level === "success" ? "✔" : "·"} {notification.text}
        </p>
      ))}
      {latest.length === 0 && <p className="text-xs text-slate-700">notifications</p>}
    </footer>
  );
}
