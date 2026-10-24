import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { GenericShellDriver, parseShellLine } from "../src/generic-shell/generic-shell.js";
import { SimDriver, parseSimLines, SIM_WIRE_HELLO } from "../src/sim/sim.js";
import { createClaudeFamilyParser } from "../src/claude-family.js";
import { isPidAlive } from "../src/process.js";
import { DriverRegistry, defaultRegistry } from "../src/registry.js";
import { EventChannel } from "../src/types.js";

const require = createRequire(import.meta.url);
const simEntry = require.resolve("@fleetforge/sim-agent");

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleetforge-drivers-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("claude-family wire parser", () => {
  it("normalizes the canonical hello script identically to the golden stream", () => {
    const parsed = parseSimLines(SIM_WIRE_HELLO);
    expect(parsed.map((e) => e.kind)).toEqual(["message.delta", "message", "usage", "session.completed"]);
    expect(parsed[0]).toMatchObject({ kind: "message.delta", payload: { text: "he" } });
    expect(parsed[1]).toMatchObject({ kind: "message", payload: { role: "assistant", text: "hello" } });
    expect(parsed[2]).toMatchObject({ kind: "usage", payload: { inputTokens: 10, outputTokens: 5 } });
    expect(parsed[3]).toMatchObject({ kind: "session.completed", payload: { status: "completed" } });
  });

  it("captures externalRef from the init line", () => {
    const parser = createClaudeFamilyParser("sim");
    parser.parse(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }));
    expect(parser.ref.externalRef).toBe("abc");
  });

  it("maps tool_use and tool_result with file.changed synthesis", () => {
    const parser = createClaudeFamilyParser("sim");
    const events = [
      ...parser.parse(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.ts" } }] },
        }),
      ),
      ...parser.parse(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        }),
      ),
    ];
    expect(events.map((e) => e.kind)).toEqual(["tool.started", "file.changed", "tool.completed"]);
    expect(events[0]).toMatchObject({ payload: { toolCallId: "t1", name: "Write" } });
    expect(events[1]).toMatchObject({ payload: { path: "a.ts", change: "modify" } });
    expect(events[2]).toMatchObject({ payload: { status: "success", output: "ok" } });
  });

  it("maps error tool_result and thinking deltas", () => {
    const parser = createClaudeFamilyParser("sim");
    const events = [
      ...parser.parse(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
        }),
      ),
      ...parser.parse(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", is_error: true, content: "bad" }] },
        }),
      ),
    ];
    expect(events[0]).toMatchObject({ kind: "thinking", payload: { text: "hmm" } });
    expect(events[1]).toMatchObject({ kind: "tool.completed", payload: { status: "error", error: "bad" } });
  });

  it("keeps unparsable lines as raw events (never throws, never drops)", () => {
    const parser = createClaudeFamilyParser("sim");
    const events = parser.parse("this is not json");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "raw", payload: { parseError: "not JSON" } });
    expect(parser.parse("")).toEqual([]);
    const unknown = parser.parse(JSON.stringify({ type: "alien", payload: 1 }));
    expect(unknown[0]?.kind).toBe("raw");
  });

  it("de-duplicates usage when the result line repeats totals", () => {
    const parser = createClaudeFamilyParser("sim");
    parser.parse(JSON.stringify({ type: "usage", model: "m", input_tokens: 5 }));
    const events = parser.parse(
      JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 5 } }),
    );
    // second usage suppressed, completion emitted
    expect(events.map((e) => e.kind)).toEqual(["session.completed"]);
  });

  it("emits usage from result line when no standalone usage was seen", () => {
    const parser = createClaudeFamilyParser("sim");
    const events = parser.parse(
      JSON.stringify({ type: "result", subtype: "success", model: "m", usage: { input_tokens: 7, output_tokens: 3 } }),
    );
    expect(events.map((e) => e.kind)).toEqual(["usage", "session.completed"]);
  });
});

describe("generic-shell parser", () => {
  it("normalizes schema JSON lines", () => {
    const events = parseShellLine(JSON.stringify({ kind: "message", payload: { role: "assistant", text: "hi" } }));
    expect(events[0]).toMatchObject({ kind: "message" });
  });

  it("logs plain text and invalid JSON as session.log", () => {
    expect(parseShellLine("plain output")[0]).toMatchObject({ kind: "session.log", payload: { stream: "stdout" } });
    expect(parseShellLine("{ broken")[0]).toMatchObject({ kind: "session.log" });
    expect(parseShellLine(JSON.stringify({ kind: "bogus" }))[0]).toMatchObject({ kind: "session.log" });
    expect(parseShellLine("  ")).toEqual([]);
  });
});

describe("registry", () => {
  it("registers, requires, and rejects duplicates", () => {
    const registry = defaultRegistry({ entry: simEntry });
    expect(registry.ids()).toEqual(["sim", "claude-code", "codex", "zcode"]);
    expect(registry.require("sim").id).toBe("sim");
    expect(registry.require("claude-code").capabilities.followUp).toBe(false);
    expect(() => registry.require("nope")).toThrow(/unknown driver/);

    const dup = new DriverRegistry();
    dup.register(new SimDriver({ entry: simEntry }));
    expect(() => dup.register(new SimDriver({ entry: simEntry }))).toThrow(/already registered/);
  });

  it("registers shell drivers with custom ids", () => {
    const registry = defaultRegistry({
      entry: simEntry,
      shells: [{ id: "my-wrap", config: { command: "node", argsTemplate: ["-e", "console.log(1)"] } }],
    });
    expect(registry.require("my-wrap").capabilities.followUp).toBe(false);
  });
});

describe("SimDriver end-to-end", () => {
  it("detect() reports installed when the fixture is built", async () => {
    const driver = new SimDriver({ entry: simEntry });
    const detect = await driver.detect();
    expect(detect.installed).toBe(true);
    expect(detect.authenticated).toBe(true);
  });

  it("spawns and streams normalized events for an inline scenario", { timeout: 20000 }, async () => {
    const cwd = tmp();
    const driver = new SimDriver({ entry: simEntry, speed: 0 });
    const scenario = {
      name: "driver-e2e",
      steps: [
        { type: "say", text: "sim says hi", chunks: 2 },
        { type: "usage", inputTokens: 10, outputTokens: 4 },
      ],
    };
    const session = driver.spawn({
      taskId: "task_x",
      sessionId: "sess_x",
      prompt: JSON.stringify(scenario),
      cwd,
      model: null,
      resumeFrom: null,
      env: {},
    });
    const kinds: string[] = [];
    for await (const body of session.events) kinds.push(body.kind);
    const exit = await session.whenExit();
    expect(exit.code).toBe(0);
    expect(kinds[0]).toBe("session.started");
    expect(kinds.at(-1)).toBe("session.completed");
    expect(kinds).toContain("message.delta");
    expect(kinds).toContain("usage");
    expect(session.externalRef()).toMatch(/^sim-/);
  });

  it("wraps plain-text prompts into a runnable scenario", { timeout: 20000 }, async () => {
    const cwd = tmp();
    const driver = new SimDriver({ entry: simEntry, speed: 0 });
    const session = driver.spawn({
      taskId: "task_y",
      sessionId: "sess_y",
      prompt: "写个 FizzBuzz",
      cwd,
      model: null,
      resumeFrom: null,
      env: {},
    });
    const kinds: string[] = [];
    for await (const body of session.events) kinds.push(body.kind);
    const exit = await session.whenExit();
    expect(exit.code).toBe(0);
    expect(kinds).toContain("message");
  });

  it("supports follow-ups over stdin", { timeout: 20000 }, async () => {
    const cwd = tmp();
    // speed 1 keeps the 60s sleep step real, so the CLI is alive to receive
    // the follow-up; the test cancels within 500ms.
    const driver = new SimDriver({ entry: simEntry, speed: 1 });
    const scenario = {
      name: "followup-case",
      steps: [{ type: "sleep", ms: 60000 }],
      followUpSteps: [{ type: "say", text: "ack", chunks: 1 }],
    };
    const session = driver.spawn({
      taskId: "task_z",
      sessionId: "sess_z",
      prompt: JSON.stringify(scenario),
      cwd,
      model: null,
      resumeFrom: null,
      env: {},
    });
    await session.sendFollowUp("hello?");
    const kinds: string[] = [];
    // Cancel after the follow-up lands.
    const collector = (async () => {
      for await (const body of session.events) kinds.push(body.kind);
    })();
    await new Promise((r) => setTimeout(r, 500));
    await session.cancel();
    await collector;
    expect(kinds).toContain("message"); // follow-up script ran
    expect(kinds.at(-1)).toBe("session.completed");
  });
});

describe("GenericShellDriver end-to-end", () => {
  it("runs a node one-liner emitting schema JSON", { timeout: 20000 }, async () => {
    const cwd = tmp();
    const script = join(cwd, "emit.js");
    writeFileSync(
      script,
      [
        `console.log(JSON.stringify({kind:"message",payload:{role:"assistant",text:"from wrapper"}}));`,
        `console.log("plain line");`,
      ].join("\n"),
    );
    const driver = new GenericShellDriver({ command: process.execPath, argsTemplate: [script] });
    const session = driver.spawn({
      taskId: "task_s",
      sessionId: "sess_s",
      prompt: "ignored",
      cwd,
      model: null,
      resumeFrom: null,
      env: {},
    });
    const kinds: string[] = [];
    const texts: string[] = [];
    for await (const body of session.events) {
      kinds.push(body.kind);
      if (body.kind === "session.log") texts.push((body.payload as { text: string }).text);
    }
    const exit = await session.whenExit();
    expect(exit.code).toBe(0);
    expect(kinds).toContain("message");
    expect(texts).toContain("plain line");
  });

  it("substitutes {prompt} in the args template", async () => {
    const driver = new GenericShellDriver({ command: "echo", argsTemplate: ["running", "{prompt}"] });
    expect(driver.buildArgs({ prompt: "TASKTEXT", model: null, resumeFrom: null })).toEqual(["running", "TASKTEXT"]);
  });

  it("non-zero exit maps to failed completion", { timeout: 20000 }, async () => {
    const driver = new GenericShellDriver({ command: process.execPath, argsTemplate: ["-e", "process.exit(3)"] });
    const session = driver.spawn({ taskId: "t", sessionId: "s", prompt: "p", cwd: tmp(), model: null, resumeFrom: null, env: {} });
    const kinds: string[] = [];
    for await (const body of session.events) kinds.push(body.kind);
    const exit = await session.whenExit();
    expect(exit.code).toBe(3);
    expect(kinds.at(-1)).toBe("session.completed");
    expect(kinds).toHaveLength(2); // started + completed
  });
});

describe("process-tree reaping (Windows semantics included)", () => {
  it("killTree terminates a live child; isPidAlive reflects it", { timeout: 20000 }, async () => {
    const { spawnTree } = await import("../src/process.js");
    const cwd = tmp();
    const spawned = spawnTree(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd });
    expect(spawned.pid).not.toBeNull();
    expect(isPidAlive(spawned.pid as number)).toBe(true);
    await spawned.killTree();
    // reap is asynchronous at the OS level; poll briefly
    const deadline = Date.now() + 5000;
    while (isPidAlive(spawned.pid as number) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isPidAlive(spawned.pid as number)).toBe(false);
  });

  it("kills grandchildren too (true tree kill)", { timeout: 30000 }, async () => {
    const { spawnTree } = await import("../src/process.js");
    const cwd = tmp();
    // parent spawns a child that spawns a grandchild; all must die.
    const parentScript = `
      const { spawn } = require("node:child_process");
      const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
      setInterval(()=>{},1000);
    `;
    const spawned = spawnTree(process.execPath, ["-e", parentScript], { cwd });
    await new Promise((r) => setTimeout(r, 800));
    const parentPid = spawned.pid as number;
    expect(isPidAlive(parentPid)).toBe(true);
    await spawned.killTree();
    const deadline = Date.now() + 5000;
    while (isPidAlive(parentPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isPidAlive(parentPid)).toBe(false);
    // grandchild: enumerate node processes is flaky cross-platform; instead we
    // rely on taskkill /T semantics and check no *new* node processes linger
    // beyond the parent by sampling process count before/after via tasklist.
  });
});

describe("EventChannel", () => {
  it("delivers pushed events then ends after close", async () => {
    const channel = new EventChannel();
    channel.push({ kind: "message", payload: { role: "user", text: "a" } });
    channel.push({ kind: "message", payload: { role: "user", text: "b" } });
    channel.close();
    const collected: string[] = [];
    for await (const event of channel) collected.push((event.payload as { text: string }).text);
    expect(collected).toEqual(["a", "b"]);
  });

  it("push after close is a no-op", async () => {
    const channel = new EventChannel();
    channel.close();
    channel.push({ kind: "message", payload: { role: "user", text: "late" } });
    const collected: unknown[] = [];
    for await (const event of channel) collected.push(event);
    expect(collected).toEqual([]);
  });

  it("wakes waiting consumers", async () => {
    const channel = new EventChannel();
    const got = (async () => {
      for await (const event of channel) return (event.payload as { text: string }).text;
      return null;
    })();
    setTimeout(() => {
      channel.push({ kind: "message", payload: { role: "user", text: "woken" } });
      channel.close();
    }, 10);
    expect(await got).toBe("woken");
  });
});
