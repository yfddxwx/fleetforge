#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { Scenario } from "./scenario.js";
import { SimRunner } from "./runner.js";

/**
 * sim-agent — programmable fake coding-agent CLI (tests & CI only).
 * Wire protocol (JSONL, claude stream-json shaped) on stdout; logs on stderr.
 */
export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      script: { type: "string" },
      "speed": { type: "string", default: "1" },
      "cwd": { type: "string", default: process.cwd() },
      "help": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help || !values.script) {
    writeSync(
      2,
      "usage: sim-agent --script <scenario.json> [--speed N] [--cwd DIR]\n" +
        "  --speed N   time factor; 0 = full speed (CI)\n",
    );
    return values.help ? 0 : 2;
  }

  const raw = JSON.parse(readFileSync(values.script, "utf8"));
  const scenario = Scenario.parse(raw);
  const speedFactor = Number(values.speed);

  // Sync writes so a hard exit (crash step) never truncates the wire stream.
  const out = (line: string): void => {
    writeSync(1, line + "\n");
  };
  const err = (line: string): void => {
    writeSync(2, line + "\n");
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    });

  const runner = new SimRunner(scenario, values.cwd, speedFactor, out, err, sleep);

  // Follow-ups arrive as JSON lines on stdin: {"type":"followup","text":"..."}
  process.stdin.setEncoding("utf8");
  let stdinBuf = "";
  process.stdin.on("data", (chunk: string) => {
    stdinBuf += chunk;
    let idx: number;
    while ((idx = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; text?: string };
        if (parsed.type === "followup" && typeof parsed.text === "string") {
          void runner.handleFollowUp(parsed.text);
        }
      } catch {
        err(`sim-agent: unparsable stdin line ignored: ${line.slice(0, 200)}`);
      }
    }
  });

  return await runner.start();
}

/* c8 ignore next */
{
  // Robust "running as the bin" detection across symlinked bins and Windows paths.
  try {
    const { realpathSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : null;
    const self = realpathSync(fileURLToPath(import.meta.url));
    if (entry && entry === self) {
      main(process.argv.slice(2)).then(
        (code) => {
          // Hard exit: sync writes are already flushed; a live stdin pipe must
          // not keep the CLI alive after the scenario completes (or crashes).
          process.exit(code);
        },
        (error: unknown) => {
          writeSync(2, `sim-agent: ${error instanceof Error ? error.stack : String(error)}\n`);
          process.exit(1);
        },
      );
    }
  } catch {
    // Not runnable as main (e.g. imported for tests) — nothing to do.
  }
}
