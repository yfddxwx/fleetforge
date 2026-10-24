import { describe, expect, it } from "vitest";
import { boardColumns, eventsForTask, useFleet, type TaskView, type EventEnvelopeView } from "../src/store.js";
import { describeEvent, formatUsd } from "../src/events-format.js";

function task(overrides: Partial<TaskView>): TaskView {
  return {
    id: "task_1",
    title: "t",
    agent: "sim",
    status: "backlog",
    branch: null,
    costUsd: 0,
    attempt: 1,
    maxAttempts: 1,
    error: null,
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    mergeStrategy: "ff",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("boardColumns", () => {
  it("maps statuses onto the 4 lanes + issues", () => {
    const columns = boardColumns([
      task({ id: "a", status: "backlog" }),
      task({ id: "b", status: "queued" }),
      task({ id: "c", status: "running" }),
      task({ id: "d", status: "review" }),
      task({ id: "e", status: "conflict" }),
      task({ id: "f", status: "done" }),
      task({ id: "g", status: "failed" }),
      task({ id: "h", status: "cancelled" }),
    ]);
    expect(columns["backlog"]?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(columns["running"]?.map((t) => t.id)).toEqual(["c"]);
    expect(columns["review"]?.map((t) => t.id)).toEqual(["d", "e"]);
    expect(columns["done"]?.map((t) => t.id)).toEqual(["f"]);
    expect(columns["issues"]?.map((t) => t.id)).toEqual(["g", "h"]);
  });
});

describe("store", () => {
  it("upsertEvent appends per session and dedupes by seq", () => {
    useFleet.setState({ eventsBySession: {} });
    const envelope = (seq: number): EventEnvelopeView => ({
      id: `e${seq}`,
      seq,
      ts: seq,
      taskId: "task_1",
      sessionId: "s1",
      kind: "message.delta",
      payload: { text: "x" },
    });
    useFleet.getState().upsertEvent(envelope(1));
    useFleet.getState().upsertEvent(envelope(2));
    useFleet.getState().upsertEvent(envelope(2)); // dup
    expect(useFleet.getState().eventsBySession["s1"]).toHaveLength(2);
  });

  it("eventsForTask filters by taskId across sessions and sorts", () => {
    useFleet.setState({
      eventsBySession: {
        s1: [
          { id: "a", seq: 1, ts: 5, taskId: "task_1", sessionId: "s1", kind: "message", payload: {} },
          { id: "b", seq: 2, ts: 6, taskId: "task_1", sessionId: "s1", kind: "usage", payload: {} },
        ],
        s2: [{ id: "c", seq: 1, ts: 1, taskId: "task_2", sessionId: "s2", kind: "message", payload: {} }],
      },
    });
    const events = eventsForTask(useFleet.getState(), "task_1");
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("notifications cap at 20", () => {
    useFleet.setState({ notifications: [] });
    for (let i = 0; i < 25; i++) useFleet.getState().pushNotification("info", `n${i}`);
    expect(useFleet.getState().notifications.length).toBe(20);
  });
});

describe("describeEvent", () => {
  it("renders tones per kind", () => {
    expect(describeEvent({ id: "1", seq: 1, ts: 1, taskId: "t", sessionId: "s", kind: "session.started", payload: { driver: "sim" } }).tone).toBe("good");
    expect(describeEvent({ id: "2", seq: 2, ts: 2, taskId: "t", sessionId: "s", kind: "session.completed", payload: { status: "failed", error: "boom" } }).text).toContain("boom");
    expect(describeEvent({ id: "3", seq: 3, ts: 3, taskId: "t", sessionId: "s", kind: "tool.started", payload: { name: "Write", input: { file_path: "a.ts" } } }).text).toContain("a.ts");
    expect(describeEvent({ id: "4", seq: 4, ts: 4, taskId: "t", sessionId: "s", kind: "file.changed", payload: { path: "b.ts", change: "add" } }).text).toContain("+");
  });
});

describe("formatUsd", () => {
  it("formats ranges", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0008)).toBe("$0.0008");
    expect(formatUsd(12.3456)).toBe("$12.35");
  });
});
