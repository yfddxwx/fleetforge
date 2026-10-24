import type { TaskStatus } from "@fleetforge/schema";
import { openDatabase, type Database } from "./db.js";
import { EventRepo } from "./events.js";
import { LockRepo } from "./locks.js";
import { SessionRepo, type NewSessionInput } from "./sessions.js";
import { SettingsRepo } from "./settings.js";
import { TaskRepo, type NewTaskInput } from "./tasks.js";
import { UsageRepo } from "./usage.js";

/** Facade bundling all repos over one SQLite connection. */
export class FleetStore {
  readonly db: Database;
  readonly tasks: TaskRepo;
  readonly sessions: SessionRepo;
  readonly events: EventRepo;
  readonly usage: UsageRepo;
  readonly locks: LockRepo;
  readonly settings: SettingsRepo;

  constructor(file: string) {
    this.db = openDatabase(file);
    this.tasks = new TaskRepo(this.db);
    this.sessions = new SessionRepo(this.db);
    this.events = new EventRepo(this.db);
    this.usage = new UsageRepo(this.db);
    this.locks = new LockRepo(this.db);
    this.settings = new SettingsRepo(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Multi-statement transaction helper for orchestrator state machines. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

// Re-export input types so consumers don't reach into individual modules.
export type { NewTaskInput, NewSessionInput };
export type { TaskStatus };
