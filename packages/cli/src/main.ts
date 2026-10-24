#!/usr/bin/env node
import process from "node:process";
import { Command } from "commander";
import { taskNew } from "./commands/task-new.js";
import { renderDoctor, runDoctor } from "./commands/doctor.js";

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
