import { ev, type AgentEventBody } from "@fleetforge/schema";

/**
 * Parser for OpenAI Codex CLI `codex exec --json` wire (JSONL).
 * Mapping (v1):
 *   thread.started (thread_id)         → init/externalRef captured
 *   turn.started                       → turn.started
 *   item.started / item.completed      → tool/message/file events by item.type
 *     agent_message                    → message (assistant)
 *     reasoning (summary)              → thinking
 *     command_execution (command)      → tool.started (Bash) + tool.completed
 *     file_change (changes[])          → file.changed
 *     mcp_tool_call / web_search       → tool.started/completed
 *     error                            → tool.completed(error) context
 *   turn.completed (usage)             → usage + turn.completed
 *   turn.failed (error.message)        → session.completed(failed)
 *   error                              → session.completed(failed)
 * Anything unparsable → raw (never dropped).
 */
export interface CodexParser {
  parse: (line: string) => AgentEventBody[];
  ref: { externalRef: string | null };
}

export function createCodexParser(): CodexParser {
  const ref: { externalRef: string | null } = { externalRef: null };
  const turnToolCounter = new Map<string, number>();

  return {
    ref,
    parse(line: string): AgentEventBody[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return [ev("raw", { wire: trimmed.slice(0, 2000), parseError: "not JSON" })];
      }
      return mapCodexLine(json, ref, turnToolCounter);
    },
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function mapCodexLine(
  json: Record<string, unknown>,
  ref: { externalRef: string | null },
  toolCounter: Map<string, number>,
): AgentEventBody[] {
  const type = str(json["type"]) ?? "";

  switch (type) {
    case "thread.started": {
      const threadId = str((json["thread_id"] as Record<string, unknown> | undefined)?.["id"] ?? json["thread_id"]);
      if (threadId) ref.externalRef = threadId;
      return [];
    }
    case "turn.started": {
      return [ev("turn.started", { turn: num(json["turn_index"]) || 1 })];
    }
    case "turn.completed": {
      const usage = json["usage"] as Record<string, unknown> | undefined;
      const out: AgentEventBody[] = [];
      if (usage) {
        const tokenUsage = (usage["input_tokens"] !== undefined ? usage : (usage["token_usage"] as Record<string, unknown> | undefined)) ?? usage;
        out.push(
          ev("usage", {
            model: str(usage["model"]) ?? str(json["model"]),
            inputTokens: num(tokenUsage["input_tokens"]),
            outputTokens: num(tokenUsage["output_tokens"]),
            cacheReadTokens: num(tokenUsage["cached_input_tokens"]),
            cacheWriteTokens: 0,
          }),
        );
      }
      out.push(ev("turn.completed", { turn: num(json["turn_index"]) || 1, stopReason: str(json["stop_reason"]) ?? null }));
      return out;
    }
    case "turn.failed": {
      const error = json["error"] as { message?: string } | undefined;
      return [
        ev("session.completed", {
          status: "failed",
          exitCode: null,
          error: error?.message ? `turn failed: ${error.message}` : "turn failed",
        }),
      ];
    }
    case "error": {
      const message = str(json["message"]) ?? "codex error";
      return [ev("session.completed", { status: "failed", exitCode: null, error: message })];
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = json["item"] as Record<string, unknown> | undefined;
      if (!item) return [];
      const itemType = str(item["type"]) ?? "";
      const key = `${type}:${itemType}`;

      if (type === "item.started") {
        toolCounter.set(key, (toolCounter.get(key) ?? 0) + 1);
      }
      const callId = str(item["call_id"]) ?? str(item["id"]) ?? `${itemType}-${toolCounter.get(key) ?? 1}`;

      switch (itemType) {
        case "agent_message": {
          if (type !== "item.completed") return [];
          const textParts = Array.isArray(item["content"])
            ? (item["content"] as Array<Record<string, unknown>>)
                .map((part) => str(part["text"]) ?? "")
                .join("")
            : (str(item["text"]) ?? "");
          return textParts ? [ev("message", { role: "assistant", text: textParts })] : [];
        }
        case "reasoning": {
          if (type !== "item.completed") return [];
          const summary = Array.isArray(item["summary"])
            ? (item["summary"] as Array<Record<string, unknown>>)
                .map((part) => str(part["text"]) ?? "")
                .join(" ")
            : (str(item["text"]) ?? "");
          return summary ? [ev("thinking", { text: summary })] : [];
        }
        case "command_execution": {
          if (type === "item.started") {
            return [ev("tool.started", { toolCallId: callId, name: "Bash", input: { command: str(item["command"]) ?? "" } })];
          }
          if (type === "item.completed") {
            const exitCode = item["exit_code"];
            const status = exitCode === null || exitCode === undefined ? "success" : num(exitCode) === 0 ? "success" : "error";
            return [
              ev("tool.completed", {
                toolCallId: callId,
                status,
                output: str(item["output"]) ?? "",
                error: status === "error" ? `exit code ${String(exitCode)}` : null,
              }),
            ];
          }
          return [];
        }
        case "file_change": {
          if (type !== "item.completed") return [];
          const changes = Array.isArray(item["changes"]) ? (item["changes"] as Array<Record<string, unknown>>) : [];
          return changes.map((change) =>
            ev("file.changed", {
              path: str(change["path"]) ?? "",
              change: changeKind(change),
              previousPath: str(change["old_path"]),
            }),
          );
        }
        case "mcp_tool_call":
        case "web_search": {
          if (type === "item.started") {
            return [ev("tool.started", { toolCallId: callId, name: str(item["server"]) ?? itemType, input: { query: str(item["query"]) } })];
          }
          if (type === "item.completed") {
            return [ev("tool.completed", { toolCallId: callId, status: "success", output: str(item["output"]) ?? "", error: null })];
          }
          return [];
        }
        case "error": {
          if (type !== "item.completed") return [];
          return [
            ev("tool.completed", { toolCallId: callId, status: "error", output: null, error: str(item["message"]) ?? "item error" }),
          ];
        }
        default:
          return [ev("raw", { wire: JSON.stringify(json).slice(0, 2000), parseError: null })];
      }
    }
    default:
      return [ev("raw", { wire: JSON.stringify(json).slice(0, 2000), parseError: null })];
  }
}

function changeKind(change: Record<string, unknown>): "add" | "modify" | "delete" | "rename" {
  const kind = str(change["kind"] ?? change["type"]);
  if (kind === "add" || kind === "added" || kind === "create") return "add";
  if (kind === "delete" || kind === "deleted") return "delete";
  if (kind === "rename" || kind === "renamed") return "rename";
  return "modify";
}
