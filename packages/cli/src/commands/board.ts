import { readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { FleetStore } from "@fleetforge/store";
import type { Task } from "@fleetforge/schema";
import { defaultDbPath, defaultStateDir } from "../paths.js";

/**
 * `fleet board` — keyboard-driven aggregate view. Reads the fleet DB (WAL
 * reader while `fleet serve` owns the writer) and sends operator commands
 * (dispatch / cancel / follow-up) to the running server over HTTP.
 * Keymap: docs/shortcuts.md.
 */

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

interface BoardRow {
  task: Task;
  sessionCount: number;
  runningSession: string | null;
}

export interface BoardOptions {
  db?: string;
  intervalMs?: number;
  url?: string;
}

export async function board(options: BoardOptions): Promise<void> {
  const dbFile = options.db ?? defaultDbPath(defaultStateDir());
  const apiUrl = (options.url ?? process.env["FLEETFORGE_URL"] ?? "http://127.0.0.1:7700").replace(/\/$/, "");
  let store: FleetStore;
  try {
    readFileSync(dbFile); // fail fast with a clear message when absent
    store = new FleetStore(dbFile);
  } catch {
    process.stderr.write(`fleet board: no database at ${dbFile} — run \`fleet serve\` or a task first\n`);
    process.exitCode = 1;
    return;
  }

  const colored = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
  const c = (code: string, text: string): string => (colored ? `${code}${text}${ANSI.reset}` : text);

  let cursor = 0;
  let rows: BoardRow[] = [];
  let notice = "";

  function loadRows(): BoardRow[] {
    return store.tasks.list().map((task) => {
      const sessions = store.sessions.listByTask(task.id);
      const live = sessions.find((s) => s.status === "running" || s.status === "starting");
      return { task, sessionCount: sessions.length, runningSession: live?.id ?? null };
    });
  }

  function statusBadge(status: string): string {
    const map: Record<string, string> = {
      backlog: c(ANSI.gray, "backlog "),
      queued: c(ANSI.yellow, "queued  "),
      running: c(ANSI.green, "running "),
      review: c(ANSI.cyan, "review  "),
      conflict: c(ANSI.red, "conflict"),
      done: c(ANSI.blue, "done    "),
      failed: c(ANSI.red, "failed  "),
      cancelled: c(ANSI.gray, "cancel'd"),
    };
    return map[status] ?? status;
  }

  async function apiPost(path: string, body?: unknown): Promise<{ ok: boolean; text: string }> {
    try {
      const response = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
      });
      const text = (await response.text()).slice(0, 160);
      return { ok: response.ok, text };
    } catch (error) {
      return { ok: false, text: `server unreachable at ${apiUrl} (${error instanceof Error ? error.message : "error"})` };
    }
  }

  /** Pause raw mode, ask a question, resume. */
  async function ask(prompt: string): Promise<string> {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\n${prompt}`);
    const answer = await rl.question("");
    rl.close();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return answer.trim();
  }

  function render(): void {
    rows = loadRows();
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
    const out: string[] = [];
    out.push(c(ANSI.bold + ANSI.cyan, "fleet board") + c(ANSI.dim, ` · ${rows.length} tasks · api ${apiUrl} · ? keys`));
    if (notice) out.push(c(ANSI.yellow, `  ${notice}`));
    out.push("");
    out.push(
      [c(ANSI.dim, "  status   "), c(ANSI.dim, "agent        "), c(ANSI.dim, "title                              "), c(ANSI.dim, "cost     "), c(ANSI.dim, "att")].join(""),
    );
    if (rows.length === 0) {
      out.push(c(ANSI.dim, "  (no tasks — create one with `fleet task new`)"));
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row) continue;
      const marker = index === cursor ? c(ANSI.bold, "▶ ") : "  ";
      const title = row.task.title.slice(0, 34).padEnd(34);
      const cost = `$${row.task.costUsd.toFixed(4)}`.padStart(8);
      const attempt = `${row.task.attempt}/${row.task.maxAttempts}`;
      out.push(
        `${marker}${statusBadge(row.task.status)} ${row.task.agent.padEnd(12)} ${title} ${c(ANSI.dim, cost)} ${c(ANSI.dim, attempt)}${row.runningSession ? c(ANSI.green, " ●") : ""}`,
      );
    }
    const selected = rows[cursor];
    if (selected) {
      out.push("");
      out.push(c(ANSI.dim, `  ${selected.task.repoPath} @ ${selected.task.baseBranch} → ${selected.task.branch ?? "-"}`));
      if (selected.task.error) out.push(c(ANSI.red, `  error: ${selected.task.error.slice(0, 110)}`));
      out.push(c(ANSI.dim, "  d dispatch · c cancel · f follow-up · j/k move · r refresh · q quit"));
    }
    process.stdout.write(`\x1b[2J\x1b[H${out.join("\n")}\n`);
  }

  if (!process.stdin.isTTY) {
    rows = loadRows();
    const lines = rows.map(
      (row) => `${row.task.status.padEnd(9)} ${row.task.agent.padEnd(12)} ${row.task.title.slice(0, 34).padEnd(34)} $${row.task.costUsd.toFixed(4)}`,
    );
    process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "(no tasks)\n");
    store.close();
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (key: Buffer | string) => {
    void (async () => {
      const input = typeof key === "string" ? key : key.toString("utf8");
      switch (input) {
        case "q":
        case "\x03":
          process.stdin.setRawMode(false);
          store.close();
          process.stdout.write("\nbye\n");
          process.exit(0);
          break;
        case "j":
        case "\x1b[B":
          cursor = Math.min(rows.length - 1, cursor + 1);
          render();
          break;
        case "k":
        case "\x1b[A":
          cursor = Math.max(0, cursor - 1);
          render();
          break;
        case "r":
          notice = "";
          render();
          break;
        case "?":
          notice = "j/k move · r refresh · d dispatch · c cancel · f follow-up · q quit";
          render();
          break;
        case "d": {
          const selected = rows[cursor];
          if (!selected) break;
          const result = await apiPost(`/api/tasks/${selected.task.id}/dispatch`);
          notice = result.ok ? `dispatched ${selected.task.id.slice(0, 13)}…` : result.text;
          render();
          break;
        }
        case "c": {
          const selected = rows[cursor];
          if (!selected) break;
          const confirm = await ask(`cancel ${selected.task.id.slice(0, 13)}…? [y/N] `);
          if (confirm.toLowerCase() === "y") {
            const result = await apiPost(`/api/tasks/${selected.task.id}/cancel`);
            notice = result.ok ? "cancel issued" : result.text;
          } else {
            notice = "cancel aborted";
          }
          render();
          break;
        }
        case "f": {
          const selected = rows[cursor];
          if (!selected) break;
          const text = await ask("follow-up text: ");
          if (text) {
            const result = await apiPost(`/api/tasks/${selected.task.id}/followup`, { text });
            notice = result.ok ? "follow-up sent" : result.text;
          } else {
            notice = "follow-up aborted";
          }
          render();
          break;
        }
        default:
          break;
      }
    })();
  });

  render();
  const interval = setInterval(render, options.intervalMs ?? 1500);
  interval.unref?.();
  await new Promise(() => {
    /* until q */
  });
}
