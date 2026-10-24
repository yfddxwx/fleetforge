import { join } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { defaultRegistry, type DriverRegistry } from "@fleetforge/drivers";
import type { EventEnvelope } from "@fleetforge/schema";
import { newId } from "@fleetforge/schema";
import { FleetStore } from "@fleetforge/store";
import { PriceBook } from "@fleetforge/usage";
import { WorktreeManager, currentBranch } from "@fleetforge/worktree";
import { EventIngestor, Scheduler } from "@fleetforge/orchestrator";

const nodeRequire = createRequire(import.meta.url);

export interface FleetServerOptions {
  dbFile: string;
  stateDir: string;
  host?: string;
  port?: number;
  simEntry?: string | null;
  /** Broadcast hook for tests / embedding (receives every WS frame sent). */
  onFrame?: (frame: WsFrame) => void;
}

export type WsFrame =
  | { type: "hello"; lastSeq: number; tasks: number }
  | { type: "event"; taskId: string; envelope: EventEnvelope }
  | { type: "task"; task: unknown }
  | { type: "notification"; level: "info" | "success" | "error"; text: string };

/**
 * The fleet command deck server: REST over /api + WebSocket fan-out on /ws.
 * One process owns the SQLite writer role; CLI/web are readers + command
 * senders (ADR-0003).
 */
export class FleetServer {
  readonly app: FastifyInstance;
  readonly store: FleetStore;
  private readonly scheduler: Scheduler;
  private readonly registry: DriverRegistry;
  private readonly priceBook: PriceBook;
  private readonly worktrees: WorktreeManager;
  private readonly clients = new Set<WebSocket>();
  private readonly options: FleetServerOptions;

  constructor(options: FleetServerOptions) {
    this.options = options;
    this.app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
    this.store = new FleetStore(options.dbFile);
    this.priceBook = new PriceBook();
    this.registry = defaultRegistry({
      entry:
        options.simEntry ??
        (() => {
          try {
            return nodeRequire.resolve("@fleetforge/sim-agent");
          } catch {
            return null;
          }
        })(),
    });
    this.worktrees = new WorktreeManager(join(options.stateDir, "worktrees"));
    const ingestor = new EventIngestor(this.store, this.priceBook);
    this.scheduler = new Scheduler(this.store, this.registry, ingestor, this.worktrees, {
      maxConcurrent: this.store.settings.get<number>("maxConcurrent") ?? 3,
      maxConcurrentPerRepo: this.store.settings.get<number>("maxConcurrentPerRepo") ?? 2,
    });
    this.scheduler.onEvent((taskId, envelope) => {
      this.broadcast({ type: "event", taskId, envelope: envelope as EventEnvelope });
    });
  }

  /** Register plugins + routes (must complete before listen). */
  async init(): Promise<void> {
    await this.app.register(websocket);
    this.registerRoutes();
  }

  /** Boot recovery + watchdog, then listen. Resolves with the actual port. */
  async start(): Promise<{ port: number }> {
    await this.init();
    await this.scheduler.recover();
    this.scheduler.startWatchdog();
    const port = this.options.port ?? Number(process.env["FLEETFORGE_PORT"] ?? 7700);
    const host = this.options.host ?? "127.0.0.1";
    await this.app.listen({ port, host });
    const address = this.app.server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : port;
    return { port: actualPort };
  }

  async stop(): Promise<void> {
    this.scheduler.stopWatchdog();
    for (const socket of this.clients) socket.close();
    await this.app.close();
    this.store.close();
  }

  private registerRoutes(): void {
    // ---- WebSocket gateway ----
    this.app.get("/ws", { websocket: true }, (socket: WebSocket) => {
      this.clients.add(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          lastSeq: 0,
          tasks: this.store.tasks.list().length,
        } satisfies WsFrame),
      );
      socket.on("message", (raw: Buffer) => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string; taskId?: string; text?: string };
          if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
          if (message.type === "followup" && message.taskId && message.text) {
            void this.scheduler.followUp(message.taskId, message.text).then((result) => {
              socket.send(
                JSON.stringify({
                  type: "notification",
                  level: result.sent ? "info" : "error",
                  text: result.sent ? "follow-up delivered" : `follow-up rejected: ${result.reason}`,
                } satisfies WsFrame),
              );
            });
          }
        } catch {
          socket.send(JSON.stringify({ type: "notification", level: "error", text: "bad message" } satisfies WsFrame));
        }
      });
      socket.on("close", () => this.clients.delete(socket));
    });

    // ---- tasks ----
    this.app.get("/api/tasks", async () => ({
      tasks: this.store.tasks.list(),
    }));

    this.app.post<{
      Body: {
        title?: string;
        prompt: string;
        agent: string;
        repoPath: string;
        baseBranch?: string;
        model?: string;
        priority?: number;
        maxAttempts?: number;
        mergeStrategy?: "ff" | "squash" | "merge";
        dispatch?: boolean;
      };
    }>("/api/tasks", async (request, reply) => {
      const body = request.body;
      if (!body?.prompt || !body?.agent || !body?.repoPath) {
        return reply.code(400).send({ error: "prompt, agent and repoPath are required" });
      }
      const repoPath = body.repoPath;
      const baseBranch = body.baseBranch ?? (await currentBranch(repoPath)) ?? "main";
      const firstLine = body.prompt.split("\n")[0] ?? "";
      const task = this.store.tasks.create({
        id: newId("task"),
        title: (body.title ?? firstLine.slice(0, 80)) || "untitled",
        prompt: body.prompt,
        agent: body.agent,
        model: body.model ?? null,
        repoPath,
        baseBranch,
        branch: null,
        priority: body.priority ?? 0,
        mergeStrategy: body.mergeStrategy ?? "ff",
        maxAttempts: body.maxAttempts ?? 3,
        createdAt: Date.now(),
      });
      if (body.dispatch !== false) this.scheduler.dispatch(task.id);
      this.broadcast({ type: "task", task });
      return reply.code(201).send({ task });
    });

    this.app.get("/api/tasks/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const task = this.store.tasks.get(id);
      if (!task) return reply.code(404).send({ error: "task not found" });
      return {
        task,
        sessions: this.store.sessions.listByTask(id),
        followUpSupported: task.sessionId
          ? this.scheduler.runnerFollowUpCapable(task.sessionId)
          : this.registry.get(task.agent)?.capabilities.followUp === true,
      };
    });

    this.app.post("/api/tasks/:id/dispatch", async (request, reply) => {
      const { id } = request.params as { id: string };
      const task = this.store.tasks.get(id);
      if (!task) return reply.code(404).send({ error: "task not found" });
      return { outcome: this.scheduler.dispatch(id) };
    });

    this.app.post("/api/tasks/:id/cancel", async (request, reply) => {
      const { id } = request.params as { id: string };
      const task = this.store.tasks.get(id);
      if (!task) return reply.code(404).send({ error: "task not found" });
      await this.scheduler.cancel(id);
      return { task: this.store.tasks.get(id) };
    });

    this.app.post("/api/tasks/:id/followup", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { text?: string };
      if (!body?.text) return reply.code(400).send({ error: "text is required" });
      const result = await this.scheduler.followUp(id, body.text);
      if (!result.sent) return reply.code(409).send(result);
      return result;
    });

    this.app.get("/api/tasks/:id/events", async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { sessionId?: string; after?: string; limit?: string };
      const after = Number(query.after ?? 0) || 0;
      const limit = Math.min(Number(query.limit ?? 5000) || 5000, 20000);
      const events = query.sessionId
        ? this.store.events.listBySession(query.sessionId, after, limit)
        : this.store.events.listByTask(id, limit);
      return { events };
    });

    /** Session transcript: ordered message/thinking/tool events as text. */
    this.app.get("/api/tasks/:id/transcript", async (request, reply) => {
      const { id } = request.params as { id: string };
      const task = this.store.tasks.get(id);
      if (!task) return reply.code(404).send({ error: "task not found" });
      const events = this.store.events.listByTask(id);
      const lines: Array<{ ts: number; role: string; text: string }> = [];
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        switch (event.kind) {
          case "message":
            lines.push({ ts: event.ts, role: String(payload["role"]), text: String(payload["text"]) });
            break;
          case "tool.started":
            lines.push({ ts: event.ts, role: "tool", text: `▶ ${String(payload["name"])} ${summarize(payload["input"])}` });
            break;
          case "tool.completed":
            lines.push({ ts: event.ts, role: "tool", text: `${payload["status"] === "success" ? "✔" : "✖"} ${String(payload["output"] ?? payload["error"] ?? "").slice(0, 200)}` });
            break;
          case "followup":
            lines.push({ ts: event.ts, role: "operator", text: String(payload["text"]) });
            break;
          default:
            break;
        }
      }
      return { taskId: id, lines };
    });

    // ---- sessions / agents / usage / settings / doctor ----
    this.app.get("/api/sessions", async () => ({
      sessions: this.store.sessions.listByStatus("running"),
    }));

    this.app.get("/api/agents", async () => {
      const agents = [];
      for (const driver of this.registry.list()) {
        const detect = await driver.detect();
        const cost = this.store.usage.aggregate("agent").find((row) => row.key === driver.id);
        agents.push({
          ...detect,
          running: this.store.tasks.list({ status: "running" }).filter((t) => t.agent === driver.id).length,
          totals: cost ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        });
      }
      return { agents };
    });

    this.app.get("/api/usage/aggregate", async (request) => {
      const query = request.query as { groupBy?: string; taskId?: string; driver?: string };
      const groupBy = (["task", "agent", "model", "day"] as const).find((g) => g === query.groupBy) ?? "task";
      return {
        groupBy,
        rows: this.store.usage.aggregate(groupBy, {
          ...(query.taskId ? { taskId: query.taskId } : {}),
          ...(query.driver ? { driver: query.driver } : {}),
        }),
      };
    });

    this.app.get("/api/settings", async () => ({ settings: this.store.settings.all() }));

    this.app.put("/api/settings", async (request) => {
      const body = request.body as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        this.store.settings.set(key, value);
      }
      this.broadcast({ type: "notification", level: "info", text: "settings updated" });
      return { settings: this.store.settings.all() };
    });

    this.app.get("/api/doctor", async () => {
      const drivers = [];
      for (const driver of this.registry.list()) {
        drivers.push(await driver.detect());
      }
      return {
        healthy: drivers.some((d) => d.installed),
        drivers,
        prices: { source: this.priceBook.sourceLabel, entries: this.priceBook.current.prices.length },
      };
    });

    this.app.get("/api/prices", async () => this.priceBook.current);
    this.app.put<{ Body: unknown }>("/api/prices", async (request, reply) => {
      try {
        const table = request.body;
        this.priceBook.replace(table as never);
        this.store.settings.set("priceTable", table);
        return this.priceBook.current;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "bad price table" });
      }
    });
  }

  runnerFollowUpCapable(sessionId: string): boolean {
    return this.scheduler.runnerFollowUpCapable(sessionId);
  }

  private broadcast(frame: WsFrame): void {
    this.options.onFrame?.(frame);
    const payload = JSON.stringify(frame);
    for (const socket of this.clients) {
      try {
        socket.send(payload);
      } catch {
        this.clients.delete(socket);
      }
    }
  }
}

function summarize(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "pattern"]) {
      if (typeof record[key] === "string") return String(record[key]).slice(0, 80);
    }
  }
  return String(input).slice(0, 80);
}
