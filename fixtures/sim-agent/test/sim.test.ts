import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SimRunner } from "../src/runner.js";
import { Scenario } from "../src/scenario.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRunner(steps: Scenario["steps"], followUpSteps: Scenario["followUpSteps"] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "sim-agent-"));
  dirs.push(cwd);
  const lines: string[] = [];
  const errors: string[] = [];
  const scenario = Scenario.parse({
    name: "test-scenario",
    model: "sim-large",
    steps,
    followUpSteps,
  });
  const runner = new SimRunner(scenario, cwd, 0, (l) => lines.push(l), (e) => errors.push(e), async () => {});
  return { runner, lines, errors, cwd };
}

describe("sim runner wire protocol", () => {
  it("emits init, streamed deltas, final message, usage, result", async () => {
    const { runner, lines } = makeRunner([
      { type: "think", text: "thinking hard" },
      { type: "say", text: "hello world", chunks: 3 },
      { type: "usage", inputTokens: 120, outputTokens: 30 },
    ]);
    const code = await runner.start();
    expect(code).toBe(0);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ type: "system", subtype: "init", model: "sim-large" });

    const events = parsed.map((p) => p["type"]);
    expect(events).toContain("stream_event");
    expect(events).toContain("assistant");
    expect(events).toContain("usage");
    const result = parsed.at(-1) as { type: string; subtype: string; usage: { input_tokens: number } };
    expect(result.type).toBe("result");
    expect(result.subtype).toBe("success");
    expect(result.usage.input_tokens).toBe(120);

    const deltas = parsed
      .filter((p) => p["type"] === "stream_event")
      .map((p) => (p as { event: { delta: { text: string } } }).event.delta.text)
      .join("");
    expect(deltas).toBe("hello world");
  });

  it("performs real file writes and reports tool calls", async () => {
    const { runner, lines, cwd } = makeRunner([
      { type: "write", path: "fizzbuzz.ts", content: "export const answer = 42;\n" },
    ]);
    const code = await runner.start();
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, "fizzbuzz.ts"), "utf8")).toContain("answer = 42");

    const toolUse = lines.find((l) => l.includes('"tool_use"'));
    expect(toolUse).toBeTruthy();
    const toolResult = lines.find((l) => l.includes('"tool_result"'));
    expect(toolResult).toBeTruthy();
  });

  it("edits files (old text required)", async () => {
    const { runner, lines, cwd } = makeRunner([
      { type: "write", path: "a.txt", content: "one two three" },
      { type: "edit", path: "a.txt", old: "two", new: "TWO" },
    ]);
    const code = await runner.start();
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one TWO three");
    expect(lines.filter((l) => l.includes('"tool_result"')).length).toBe(2);
  });

  it("fails when shell command fails", async () => {
    const { runner, lines } = makeRunner([{ type: "shell", command: "exit 3" }]);
    const code = await runner.start();
    expect(code).toBe(1);
    const result = JSON.parse(lines.at(-1) as string) as { type: string; subtype: string };
    expect(result.subtype).toBe("error");
  });

  it("runs git through shell step (real repo effects)", async () => {
    const { runner, cwd } = makeRunner([
      { type: "write", path: "x.txt", content: "hi" },
      { type: "shell", command: "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init" },
    ]);
    const code = await runner.start();
    expect(code).toBe(0);
    // git objects exist -> repo has a commit
    const { spawnSync } = await import("node:child_process");
    const log = spawnSync("git", ["log", "--oneline"], { cwd, encoding: "utf8" });
    expect(log.stdout.trim().split("\n").length).toBe(1);
  });

  it("crash exits without a result line", async () => {
    const { runner, lines, errors } = makeRunner([
      { type: "say", text: "starting" },
      { type: "crash", exitCode: 137, message: "killed by OOM (sim)" },
    ]);
    const code = await runner.start();
    expect(code).toBe(137);
    expect(lines.some((l) => l.includes('"result"'))).toBe(false);
    expect(errors.join("\n")).toContain("killed by OOM (sim)");
  });

  it("follow-up echoes user message and replays followUpSteps", async () => {
    const { runner, lines } = makeRunner([{ type: "say", text: "done" }], [
      { type: "say", text: "follow-up handled", chunks: 1 },
    ]);
    await runner.start();
    await runner.handleFollowUp("now add tests");
    const last = JSON.parse(lines.at(-1) as string) as { type: string };
    expect(last.type).toBe("assistant");
    const userMsg = lines.find((l) => l.includes("[follow-up] now add tests"));
    expect(userMsg).toBeTruthy();
    expect(lines.at(-1)).toContain("follow-up handled");
  });
});

describe("scenario validation", () => {
  it("rejects unknown step types", () => {
    expect(() =>
      Scenario.parse({ name: "x", steps: [{ type: "detonate" }] }),
    ).toThrow();
  });

  it("applies defaults", () => {
    const scenario = Scenario.parse({ name: "x", steps: [{ type: "sleep", ms: 5 }] });
    expect(scenario.model).toBe("sim-large");
    expect(scenario.wire).toBe("sim");
    expect(scenario.followUpSteps).toEqual([]);
  });
});
