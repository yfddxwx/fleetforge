import type { AgentEventBody } from "@fleetforge/schema";
import { ev } from "@fleetforge/schema";

/**
 * Shared parser for the "claude stream-json" wire family.
 * sim-agent emits exactly this protocol; the claude-code driver targets the
 * real CLI's `-p --output-format stream-json --verbose` output.
 *
 * Line → event mapping (v1):
 *   system/subtype=init                  → (no event; externalRef captured by session loop)
 *   stream_event text_delta              → message.delta
 *   stream_event thinking_delta          → thinking
 *   assistant content thinking           → thinking
 *   assistant content text               → message (assistant)
 *   assistant content tool_use           → tool.started (+ file.changed for file tools)
 *   user content tool_result             → tool.completed
 *   user content text                    → message (user)
 *   usage                                → usage
 *   result subtype=success               → session.completed(completed) [+ usage if first]
 *   result subtype=error*                → session.completed(failed)
 *   anything else                        → raw
 *
 * Purity note: the factory is per-session; the only state is whether a usage
 * line was already seen (result.usage is then a duplicate, not a second dose).
 */
export type WireParser = (line: string) => AgentEventBody[];

export interface ParsedRef {
  externalRef: string | null;
}

/** Tools whose input carries a file path; file.changed is synthesized from them. */
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function createClaudeFamilyParser(driverId: string): { parse: WireParser; ref: ParsedRef } {
  let seenUsage = false;
  const ref: ParsedRef = { externalRef: null };

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
      return mapClaudeFamily(driverId, json, ref, () => (seenUsage = true), seenUsage);
    },
  };
}

function mapClaudeFamily(
  driverId: string,
  json: Record<string, unknown>,
  ref: ParsedRef,
  markUsage: () => void,
  seenUsage: boolean,
): AgentEventBody[] {
  const type = typeof json["type"] === "string" ? json["type"] : "";

  switch (type) {
    case "system": {
      if (json["subtype"] === "init") {
        const sessionId = typeof json["session_id"] === "string" ? json["session_id"] : null;
        if (sessionId) ref.externalRef = sessionId;
        // session.started is synthesized by the session loop (it owns pid/timing).
        return [];
      }
      return [];
    }
    case "stream_event": {
      const event = json["event"] as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
      const delta = event?.delta;
      if (event?.type === "content_block_delta" && delta) {
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          return [ev("message.delta", { text: delta.text })];
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          return [ev("thinking", { text: delta.thinking })];
        }
      }
      return [];
    }
    case "assistant": {
      const message = json["message"] as { content?: Array<Record<string, unknown>> } | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) return [];
      const out: AgentEventBody[] = [];
      for (const block of content) {
        const blockType = typeof block["type"] === "string" ? block["type"] : "";
        if (blockType === "thinking" && typeof block["thinking"] === "string") {
          out.push(ev("thinking", { text: block["thinking"] }));
        } else if (blockType === "text" && typeof block["text"] === "string") {
          out.push(ev("message", { role: "assistant", text: block["text"] }));
        } else if (blockType === "tool_use") {
          const toolCallId = typeof block["id"] === "string" ? block["id"] : `tool_unknown_${Date.now()}`;
          const name = typeof block["name"] === "string" ? block["name"] : "unknown";
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          out.push(ev("tool.started", { toolCallId, name, input }));
          if (FILE_TOOLS.has(name)) {
            const path = typeof input["file_path"] === "string" ? input["file_path"] : null;
            if (path) {
              // Write upserts: add-vs-modify distinction is left to the diff
              // generator (M5); the stream marks best-effort "modify".
              out.push(ev("file.changed", { path, change: "modify", previousPath: null }));
            }
          }
        }
      }
      return out;
    }
    case "user": {
      const message = json["message"] as { role?: string; content?: unknown } | undefined;
      const content = message?.content;
      const out: AgentEventBody[] = [];
      if (typeof content === "string") {
        out.push(ev("message", { role: "user", text: content }));
        return out;
      }
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block["type"] === "tool_result") {
            const toolCallId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "unknown";
            const isError = block["is_error"] === true;
            const text =
              typeof block["content"] === "string"
                ? block["content"]
                : JSON.stringify(block["content"] ?? null);
            out.push(
              ev("tool.completed", {
                toolCallId,
                status: isError ? "error" : "success",
                output: isError ? null : text,
                error: isError ? text : null,
              }),
            );
          } else if (block["type"] === "text" && typeof block["text"] === "string") {
            out.push(ev("message", { role: "user", text: block["text"] }));
          }
        }
      }
      return out;
    }
    case "usage": {
      markUsage();
      return [
        ev("usage", {
          model: typeof json["model"] === "string" ? json["model"] : null,
          inputTokens: numberOr(json["input_tokens"]),
          outputTokens: numberOr(json["output_tokens"]),
          cacheReadTokens: numberOr(json["cache_read_input_tokens"]),
          cacheWriteTokens: numberOr(json["cache_creation_input_tokens"]),
        }),
      ];
    }
    case "result": {
      const subtype = typeof json["subtype"] === "string" ? json["subtype"] : "unknown";
      const success = subtype === "success";
      const usage = json["usage"] as Record<string, unknown> | undefined;
      const out: AgentEventBody[] = [];
      if (usage && !seenUsage) {
        out.push(
          ev("usage", {
            model: typeof json["model"] === "string" ? json["model"] : null,
            inputTokens: numberOr(usage["input_tokens"]),
            outputTokens: numberOr(usage["output_tokens"]),
            cacheReadTokens: numberOr(usage["cache_read_input_tokens"]),
            cacheWriteTokens: numberOr(usage["cache_creation_input_tokens"]),
          }),
        );
      }
      out.push(
        ev("session.completed", {
          status: success ? "completed" : "failed",
          exitCode: null,
          error: success ? null : typeof json["result"] === "string" ? json["result"] : `result subtype: ${subtype}`,
        }),
      );
      return out;
    }
    default:
      return [ev("raw", { wire: trimmed0(json), parseError: null })];
  }
}

function trimmed0(json: Record<string, unknown>): string {
  try {
    return JSON.stringify(json).slice(0, 2000);
  } catch {
    return String(json);
  }
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
