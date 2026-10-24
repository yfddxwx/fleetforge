import { createInterface } from "node:readline";
import { AgentEventBody, ev } from "@fleetforge/schema";
import type { DriverSession, SessionExit } from "./types.js";
import { EventChannel } from "./types.js";
import { spawnTree, type SpawnedProcess } from "./process.js";

export interface LineSessionOptions {
  sessionId: string;
  driverId: string;
  model: string | null;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Per-session wire parser (stateful factories are fine). */
  createParser: () => { parse: (line: string) => AgentEventBody[]; ref?: { externalRef: string | null } };
  /** How to serialize a follow-up onto the child's stdin; null = unsupported. */
  followUpWriter: ((text: string) => string) | null;
  onExternalRef?: (ref: string) => void;
}

/**
 * Shared session loop for line-protocol (JSONL-on-stdout) drivers:
 * spawn → readline → parse → channel; synthesizes the session lifecycle
 * (started first, completed last — the synthesized completion waits for both
 * output pipes to drain so a crashing CLI's stderr lands in the stream and in
 * the error text); reaps the whole process tree on cancel.
 */
export function startLineProtocolSession(
  options: LineSessionOptions,
): DriverSession & { externalRef: () => string | null } {
  const channel = new EventChannel();
  let exited = false;
  let exitInfo: SessionExit = { code: null, signal: null };
  const exitWaiters: Array<(info: SessionExit) => void> = [];
  let spawned: SpawnedProcess | null = null;
  let stdinOpen = false;
  let completedEmitted = false;
  let cancelled = false;
  let lastStderr: string | null = null;

  const parser = options.createParser();

  const session: DriverSession & { externalRef: () => string | null } = {
    sessionId: options.sessionId,
    pid: null,
    events: channel,
    async sendFollowUp(text: string) {
      if (!options.followUpWriter || !spawned || !stdinOpen) {
        throw new Error(`driver "${options.driverId}" cannot send follow-ups (no live stdin)`);
      }
      spawned.child.stdin?.write(options.followUpWriter(text));
    },
    async cancel() {
      cancelled = true;
      if (spawned) await spawned.killTree();
    },
    whenExit() {
      if (exited) return Promise.resolve(exitInfo);
      return new Promise((resolve) => exitWaiters.push(resolve));
    },
    externalRef: () => parser.ref?.externalRef ?? null,
  };

  function resolveExit(info: SessionExit): void {
    exited = true;
    exitInfo = info;
    for (const waiter of exitWaiters.splice(0)) waiter(info);
  }

  function emitCompleted(code: number | null, error: string | null): void {
    if (completedEmitted) return;
    completedEmitted = true;
    channel.push(ev("session.completed", { status: cancelled ? "cancelled" : code === 0 ? "completed" : "failed", exitCode: code, error }));
  }

  spawned = spawnTree(options.command, options.args, { cwd: options.cwd, env: options.env });
  session.pid = spawned.pid;
  channel.push(
    ev("session.started", {
      driver: options.driverId,
      pid: spawned.pid,
      model: options.model,
      externalRef: null,
    }),
  );

  const child = spawned.child;

  child.on("error", (error: Error) => {
    emitCompleted(null, `spawn failed: ${error.message}`);
    channel.close();
    resolveExit({ code: null, signal: null });
  });

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      for (const body of parser.parse(line)) {
        if (body.kind === "session.completed") completedEmitted = true;
        channel.push(body);
      }
    });
  }

  if (child.stderr) {
    const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on("line", (line: string) => {
      const text = line.trim();
      if (text) {
        lastStderr = text;
        channel.push(ev("session.log", { stream: "stderr", text }));
      }
    });
  }

  child.stdin?.on("close", () => {
    stdinOpen = false;
  });
  stdinOpen = true;
  // Drivers without follow-up support close stdin immediately: CLIs that read
  // stdin get a clean EOF instead of hanging forever.
  if (!options.followUpWriter) child.stdin?.end();

  child.on("exit", (code: number | null, signal: string | null) => {
    resolveExit({ code, signal });
    // Synthesize completion only after both pipes drained, so stderr of a
    // crashing CLI is part of the stream and of the error text.
    finalizeWhenDrained(code);
  });

  function finalizeWhenDrained(code: number | null): void {
    const streams = [child.stdout, child.stderr].filter(
      (stream): stream is NonNullable<typeof stream> => stream !== null && !stream.destroyed,
    );
    if (streams.length === 0) {
      finish(code);
      return;
    }
    let remaining = streams.length;
    let finished = false;
    for (const stream of streams) {
      stream.once("close", () => {
        remaining -= 1;
        if (remaining === 0 && !finished) {
          finished = true;
          finish(code);
        }
      });
    }
    // Windows sometimes delivers 'close' on the parent's copies late; never
    // let the channel hang: 1s hard cap after process exit.
    setTimeout(() => {
      if (!finished) {
        finished = true;
        finish(code);
      }
    }, 1000).unref?.();
  }

  function finish(code: number | null): void {
    if (!completedEmitted) {
      const detail =
        cancelled
          ? "cancelled by operator"
          : code === 0
            ? null
            : lastStderr !== null
              ? `${lastStderr} (exit code ${code ?? "null"})`
              : `process exited with code ${code ?? "null"}`;
      emitCompleted(code, detail);
    }
    channel.close();
  }

  return session;
}
