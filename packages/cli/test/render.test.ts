import { describe, expect, it } from "vitest";
import { EventStreamRenderer, supportsColor } from "../src/render.js";
import { SCHEMA_VERSION, type EventEnvelope, type EventKind, type EventPayloadMap } from "@fleetforge/schema";

function envelope<K extends EventKind>(seq: number, kind: K, payload: EventPayloadMap[K]): EventEnvelope<K> {
  return {
    id: `e${seq}`,
    seq,
    ts: 1,
    schemaVersion: SCHEMA_VERSION,
    taskId: "task_t",
    sessionId: "sess_s",
    kind,
    payload,
  };
}

function collect(): { lines: string[]; renderer: EventStreamRenderer } {
  const lines: string[] = [];
  return { lines, renderer: new EventStreamRenderer((line) => lines.push(line), false) };
}

describe("EventStreamRenderer", () => {
  it("renders lifecycle, messages, tools, usage, files", () => {
    const { lines, renderer } = collect();
    renderer.render(envelope(1, "session.started", { driver: "sim", pid: 42, model: "sim-large", externalRef: null }));
    renderer.render(envelope(2, "thinking", { text: "deep thought" }));
    renderer.render(envelope(3, "message", { role: "assistant", text: "hello world" }));
    renderer.render(envelope(4, "tool.started", { toolCallId: "t1", name: "Write", input: { file_path: "a.ts" } }));
    renderer.render(envelope(5, "tool.completed", { toolCallId: "t1", status: "success", output: "ok", error: null }));
    renderer.render(envelope(6, "file.changed", { path: "a.ts", change: "modify", previousPath: null }));
    renderer.render(envelope(7, "usage", { model: "sim-large", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    renderer.render(envelope(8, "session.completed", { status: "completed", exitCode: 0, error: null }));

    const text = lines.join("\n");
    expect(text).toContain("session started");
    expect(text).toContain("sim · sim-large · pid 42");
    expect(text).toContain("deep thought");
    expect(text).toContain("hello world");
    expect(text).toContain("Write a.ts");
    expect(text).toContain("a.ts");
    expect(text).toContain("tokens: in 10 · out 5");
    expect(text).toContain("session completed");
  });

  it("folds message deltas into one assistant line on flush", () => {
    const { lines, renderer } = collect();
    renderer.render(envelope(2, "message.delta", { text: "foo " }));
    renderer.render(envelope(3, "message.delta", { text: "bar" }));
    renderer.render(envelope(4, "message", { role: "user", text: "next" }));
    const text = lines.join("\n");
    expect(text).toContain("foo bar");
    expect(lines.some((l) => l.includes("user next"))).toBe(true);
  });

  it("renders failure with error detail", () => {
    const { lines, renderer } = collect();
    renderer.render(envelope(2, "session.completed", { status: "failed", exitCode: 3, error: "boom" }));
    expect(lines.join("\n")).toContain("session failed");
    expect(lines.join("\n")).toContain("boom");
  });

  it("renders raw and log lines without throwing", () => {
    const { lines, renderer } = collect();
    renderer.render(envelope(2, "raw", { wire: "{weird}", parseError: "nope" }));
    renderer.render(envelope(3, "session.log", { stream: "stderr", text: "warn!" }));
    const text = lines.join("\n");
    expect(text).toContain("{weird}");
    expect(text).toContain("[stderr] warn!");
  });
});

describe("supportsColor", () => {
  it("respects NO_COLOR and TTY", () => {
    const hadNoColor = process.env["NO_COLOR"] !== undefined;
    process.env["NO_COLOR"] = "1";
    expect(supportsColor({ isTTY: true } as never)).toBe(false);
    if (!hadNoColor) delete process.env["NO_COLOR"];
    expect(supportsColor({} as never)).toBe(false);
  });
});
