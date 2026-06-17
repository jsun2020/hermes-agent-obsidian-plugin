// Pure protocol helpers for the Hermes gateway wire format.
//
// Deliberately free of Node/Obsidian imports so they can be unit-tested in
// isolation (see tests/protocol.test.mjs). Ported from Hermes Desktop's
// run-stream.ts / hermes.ts.

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolEvent {
  name: string;
  status: "running" | "completed" | "failed";
  preview?: string;
}

export interface HermesCapabilities {
  features?: Record<string, unknown>;
  endpoints?: Record<string, { path?: unknown } | unknown>;
}

export function normaliseBaseUrl(raw: string): string {
  let url = (raw || "").trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/v1$/i, "");
  return url;
}

function boolFeature(caps: HermesCapabilities | null | undefined, name: string): boolean {
  return caps?.features?.[name] === true;
}

function endpointPath(caps: HermesCapabilities | null | undefined, name: string): string {
  const endpoint = caps?.endpoints?.[name];
  if (!endpoint || typeof endpoint !== "object") return "";
  const path = (endpoint as { path?: unknown }).path;
  return typeof path === "string" ? path : "";
}

/** Mirror of Desktop's supportsHermesRunsTransport(). */
export function supportsRunsTransport(caps: HermesCapabilities | null | undefined): boolean {
  return (
    boolFeature(caps, "run_submission") &&
    boolFeature(caps, "run_events_sse") &&
    boolFeature(caps, "run_stop") &&
    boolFeature(caps, "run_approval_response") &&
    boolFeature(caps, "tool_progress_events") &&
    endpointPath(caps, "runs") === "/v1/runs" &&
    endpointPath(caps, "run_events") === "/v1/runs/{run_id}/events" &&
    endpointPath(caps, "run_approval") === "/v1/runs/{run_id}/approval" &&
    endpointPath(caps, "run_stop") === "/v1/runs/{run_id}/stop"
  );
}

/** Parse a single SSE block into its event type + joined data (CRLF tolerant). */
export function parseSseBlock(block: string): { eventType: string; data: string } | null {
  let eventType = "";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    }
  }
  if (dataLines.length === 0) return null;
  return { eventType, data: dataLines.join("\n") };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Map a Runs SSE event object to a normalized ToolEvent (or null). */
export function toolEventFromRunEvent(event: Record<string, unknown>): ToolEvent | null {
  const name = stringValue(event.event);
  if (!["tool.started", "tool.completed", "tool.failed"].includes(name)) return null;
  const tool = stringValue(event.tool) || stringValue(event.tool_name) || "tool";
  const status = name === "tool.completed" ? "completed" : name === "tool.failed" ? "failed" : "running";
  const preview = stringValue(event.preview);
  return { name: tool, status, ...(preview ? { preview } : {}) };
}

export function runEventReasoningText(event: Record<string, unknown>): string {
  if (event.event !== "reasoning.available") return "";
  return stringValue(event.text) || stringValue(event.delta);
}

export function runCompletedUsage(event: Record<string, unknown>): UsageInfo | null {
  if (event.event !== "run.completed") return null;
  const usage = event.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: Number(u.input_tokens) || 0,
    completionTokens: Number(u.output_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0
  };
}

/** Extract assistant text delta from an OpenAI-style chat.completions chunk. */
export function chatDeltaContent(json: unknown): string {
  const j = json as { choices?: Array<{ delta?: { content?: unknown } }> };
  const delta = j?.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : "";
}
