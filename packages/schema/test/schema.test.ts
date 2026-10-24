import { describe, expect, it } from "vitest";
import {
  EventPayloads,
  SCHEMA_VERSION,
  Task,
  ev,
  makeEnvelope,
  newId,
  parseEventBody,
  slugify,
} from "../src/index.js";

describe("event schema v1", () => {
  it("accepts a valid tool event body", () => {
    const body = ev("tool.started", { toolCallId: "t1", name: "Write", input: { path: "a.ts" } });
    expect(parseEventBody(body)).toMatchObject({ kind: "tool.started" });
  });

  it("rejects unknown kinds", () => {
    expect(() => parseEventBody({ kind: "brain.download", payload: {} })).toThrow();
  });

  it("rejects payloads failing the kind's schema", () => {
    expect(() => parseEventBody(ev("usage", { inputTokens: "many" }))).toThrow();
  });

  it("applies payload defaults", () => {
    const parsed = parseEventBody(ev("session.started", { driver: "sim" })) as {
      payload: { pid: number | null };
    };
    expect(parsed.payload.pid).toBeNull();
  });

  it("stamps envelopes with identity and schema version", () => {
    const body = ev("message.delta", { text: "hello" }, 123);
    const envelope = makeEnvelope(body as never, {
      taskId: "task_1",
      sessionId: "sess_1",
      seq: 7,
      id: "evt",
    });
    expect(envelope).toMatchObject({
      seq: 7,
      ts: 123,
      schemaVersion: SCHEMA_VERSION,
      taskId: "task_1",
      sessionId: "sess_1",
      kind: "message.delta",
      payload: { text: "hello" },
    });
  });

  it("covers every kind with a payload schema", () => {
    for (const [kind, schema] of Object.entries(EventPayloads)) {
      expect(schema, kind).toBeTruthy();
    }
  });
});

describe("domain model", () => {
  it("parses a task with defaults", () => {
    const task = Task.parse({
      id: newId("task"),
      title: "FizzBuzz",
      prompt: "write fizzbuzz",
      agent: "sim",
      repoPath: "D:/tmp/repo",
      baseBranch: "main",
      status: "backlog",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(task.priority).toBe(0);
    expect(task.attempt).toBe(1);
    expect(task.branch).toBeNull();
    expect(task.mergeStrategy).toBe("ff");
  });

  it("rejects bad status", () => {
    expect(() =>
      Task.parse({
        id: "task_1",
        title: "x",
        prompt: "",
        agent: "sim",
        repoPath: "/r",
        baseBranch: "main",
        status: "flying",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow();
  });
});

describe("ids", () => {
  it("slugifies for branch names", () => {
    expect(slugify("写个 FizzBuzz 模块!")).toBe("fizzbuzz");
    expect(slugify("!!!")).toBe("task");
  });
});
