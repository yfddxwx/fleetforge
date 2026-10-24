import type { EventEnvelopeView } from "./store";

/** Compact one-line rendering of a normalized event (mirrors the CLI renderer). */
export function describeEvent(event: EventEnvelopeView): { label: string; text: string; tone: "dim" | "info" | "good" | "bad" | "warn" } {
  const p = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "session.started":
      return { label: "start", text: `${String(p["driver"])}${p["model"] ? ` · ${String(p["model"])}` : ""}`, tone: "good" };
    case "session.completed": {
      const status = String(p["status"]);
      return {
        label: "end",
        text: `${status}${p["error"] ? ` — ${String(p["error"]).slice(0, 140)}` : ""}`,
        tone: status === "completed" ? "good" : status === "cancelled" ? "warn" : "bad",
      };
    }
    case "message":
      return { label: String(p["role"]), text: String(p["text"]).slice(0, 240), tone: p["role"] === "assistant" ? "info" : "dim" };
    case "message.delta":
      return { label: "delta", text: String(p["text"]).slice(0, 120), tone: "dim" };
    case "thinking":
      return { label: "think", text: String(p["text"]).slice(0, 160), tone: "dim" };
    case "tool.started":
      return { label: "tool", text: `${String(p["name"])} ${summarize(p["input"])}`, tone: "warn" };
    case "tool.completed":
      return {
        label: "tool",
        text: (p["error"] !== null && p["error"] !== undefined ? `✖ ${String(p["error"])}` : `${String(p["output"] ?? "").slice(0, 180)}`),
        tone: p["status"] === "success" ? "dim" : "bad",
      };
    case "usage":
      return { label: "usage", text: `in ${String(p["inputTokens"])} · out ${String(p["outputTokens"])}`, tone: "dim" };
    case "file.changed": {
      const mark: Record<string, string> = { add: "+", modify: "~", delete: "-", rename: "→" };
      return { label: "file", text: `${mark[String(p["change"])] ?? "?"} ${String(p["path"])}`, tone: "good" };
    }
    case "session.log":
      return { label: p["stream"] === "stderr" ? "stderr" : "stdout", text: String(p["text"]).slice(0, 200), tone: "dim" };
    case "followup":
      return { label: "operator", text: String(p["text"]).slice(0, 200), tone: "warn" };
    case "raw":
      return { label: "raw", text: String(p["wire"]).slice(0, 120), tone: "dim" };
    default:
      return { label: event.kind, text: "", tone: "dim" };
  }
}

function summarize(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "pattern"]) {
      if (typeof record[key] === "string") return String(record[key]).slice(0, 80);
    }
  }
  return String(input).slice(0, 80);
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
