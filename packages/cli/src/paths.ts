import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

/** Where fleet state (db, worktrees) lives. */
export function defaultStateDir(): string {
  const override = process.env["FLEETFORGE_STATE"];
  if (override) return resolve(override);
  return join(homedir(), ".fleetforge");
}

export function defaultDbPath(stateDir: string): string {
  return join(stateDir, "fleet.db");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

const nodeRequire = createRequire(import.meta.url);

/** Locate sim-agent's built entry (workspace layout aware). */
export function findSimAgentEntry(): string | null {
  try {
    return nodeRequire.resolve("@fleetforge/sim-agent");
  } catch {
    return null;
  }
}
