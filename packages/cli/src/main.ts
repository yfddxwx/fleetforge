#!/usr/bin/env node
import process from "node:process";
import { Command } from "commander";
import { taskNew } from "./commands/task-new.js";
import { renderDoctor, runDoctor } from "./commands/doctor.js";
import { serve } from "./commands/serve.js";
import { board } from "./commands/board.js";

const version = "0.1.0";

const program = new Command();

program
  .name("fleet")
  .description("Agent fleet command deck: orchestrate coding-agent CLIs through git worktrees")
  .version(version);

program
  .command("version")
  .description("print fleet & schema versions")
  .action(async () => {
    const { SCHEMA_VERSION } = await import("@fleetforge/schema");
    process.stdout.write(`fleet ${version} · event schema v${SCHEMA_VERSION}\n`);
  });

const task = program.command("task").description("manage fleet tasks");

task
  .command("new")
  .description("create a task and run it inline, streaming normalized events (M1 mode)")
  .argument("<prompt>", "task prompt (sim: text | {json} scenario | @file)")
  .option("-a, --agent <agent>", "driver id", "sim")
  .option("--repo <path>", "target git repository (default: cwd)")
  .option("--base <branch>", "base branch (default: current HEAD branch)")
  .option("-m, --model <model>", "model override where the driver supports it")
  .option("-p, --priority <n>", "queue priority 0-9", (v) => Number(v))
  .option("--title <title>", "short title (default: first line of prompt)")
  .option("--db <file>", "sqlite database file")
  .action(async (prompt: string, options) => {
    const code = await taskNew(prompt, {
      agent: options.agent,
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      ...(options.base !== undefined ? { baseBranch: options.base } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.db !== undefined ? { db: options.db } : {}),
    });
    process.exitCode = code;
  });

program
  .command("serve")
  .description("run the command deck: REST + WebSocket + scheduler + watchdog")
  .option("-p, --port <port>", "listen port (default 7700)", (v) => Number(v))
  .option("--host <host>", "listen host (default 127.0.0.1)")
  .option("--db <file>", "sqlite database file")
  .option("--state <dir>", "state directory (worktrees live here)")
  .action(async (options) => {
    await serve({
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.db !== undefined ? { db: options.db } : {}),
      ...(options.state !== undefined ? { state: options.state } : {}),
    });
  });

program
  .command("board")
  .description("keyboard-driven aggregate view over the fleet (j/k · d/c/f)")
  .option("--db <file>", "sqlite database file")
  .option("--url <url>", "fleet serve base URL (default http://127.0.0.1:7700)")
  .option("--interval <ms>", "refresh interval", (v) => Number(v))
  .action(async (options) => {
    await board({
      ...(options.db !== undefined ? { db: options.db } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
      ...(options.interval !== undefined ? { intervalMs: options.interval } : {}),
    });
  });

program
  .command("doctor")
  .description("probe local agent CLIs: installed, version, login state, capability matrix")
  .action(async () => {
    const report = await runDoctor();
    process.stdout.write(`${renderDoctor(report)}\n`);
    process.exitCode = report.healthy ? 0 : 1;
  });

/* c8 ignore next 3 */
program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`fleet: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
