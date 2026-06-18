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

// ---- footer meta-bar helpers (model name, context gauge, greeting) ----------
//
// The gateway speaks the meta-label "hermes-agent" at the API layer; the real
// underlying model (e.g. "gpt-5.5") lives in Hermes Desktop's config and is only
// observable to a pure API client through /v1/models. These helpers mirror the
// desktop's own footer logic (display = last path segment of the model id; the
// context gauge = latest turn's prompt tokens / the model's context window).

/**
 * Human-friendly model label from a raw model id. Strips a provider prefix
 * ("openai-codex/gpt-5.5" -> "gpt-5.5") and a "@base_url" suffix
 * ("gpt-5.5@https://..." -> "gpt-5.5"). Returns "" for blank input.
 */
export function humanizeModel(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const beforeAt = s.split("@")[0];
  const lastSeg = beforeAt.split("/").pop() || beforeAt;
  return lastSeg.trim();
}

/** Generic fallback when the model's context window is unknown. */
export const CONTEXT_WINDOW_DEFAULT = 200000;

/** Known context windows by bare model id (gpt-5 family on Codex = 272k). */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.5": 272000,
  "gpt-5.4": 272000,
  "gpt-5.3": 272000,
  "gpt-5.2": 272000,
  "gpt-5.1": 272000,
  "gpt-5": 272000
};

/**
 * Context-window size (in tokens) for a model. Prefers a value advertised by
 * the gateway's /v1/models (authoritative), then a known-model table, then the
 * gpt-5 family default, then the generic default.
 */
export function contextWindowFor(modelId: string, advertised?: number): number {
  if (typeof advertised === "number" && advertised > 0) return advertised;
  const id = humanizeModel(modelId).toLowerCase();
  if (KNOWN_CONTEXT_WINDOWS[id]) return KNOWN_CONTEXT_WINDOWS[id];
  if (id.startsWith("gpt-5")) return 272000;
  return CONTEXT_WINDOW_DEFAULT;
}

/**
 * Percentage of the context window occupied by the latest turn's prompt tokens.
 * Clamped to 0..100. Mirrors Hermes Desktop's ContextGauge formula.
 */
export function contextPercent(usedPromptTokens: number, contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) return 0;
  const pct = Math.round((usedPromptTokens / contextWindow) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** Strip a YAML scalar's quotes / inline `# comment` to its bare value. */
function cleanScalar(raw: string): string {
  let v = raw.trim();
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0];
    const end = v.indexOf(q, 1);
    if (end > 0) return v.slice(1, end);
  }
  const hash = v.indexOf(" #");
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

/**
 * Extract the real underlying model + provider from a Hermes `config.yaml`.
 * The gateway only ever advertises the meta-label ("hermes-agent" / the profile
 * name) over its API, so the actual model (e.g. "gpt-5.5") is only readable from
 * the top-level `model:` block. Scoped to that block so the many other
 * `default:`/`model:` keys (providers, etc.) don't leak in.
 */
export function parseConfigModel(yamlText: string): { model?: string; provider?: string } {
  const lines = (yamlText || "").split(/\r?\n/);
  let i = lines.findIndex((l) => /^model:\s*(#.*)?$/.test(l));
  if (i < 0) return {};
  const out: { model?: string; provider?: string } = {};
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break; // dedent to column 0 = next top-level key
    const m = /^\s+(default|model):\s*(.+)$/.exec(line);
    if (m && !out.model) out.model = cleanScalar(m[2]);
    const p = /^\s+provider:\s*(.+)$/.exec(line);
    if (p && !out.provider) out.provider = cleanScalar(p[1]);
  }
  return out;
}

/**
 * Look up a model's context window from a Hermes `context_length_cache.yaml`.
 * Keys look like `gpt-5.5@https://.../codex: 272000`; we match on the bare model
 * id (the part before `@`). Returns undefined when not present.
 */
export function parseContextLengthCache(yamlText: string, modelId: string): number | undefined {
  const want = humanizeModel(modelId);
  if (!want) return undefined;
  for (const line of (yamlText || "").split(/\r?\n/)) {
    if (!/^\s/.test(line)) continue; // only indented entries
    const m = /^\s+(.+):\s*(\d+)\s*$/.exec(line); // greedy key -> last colon before digits
    if (!m) continue;
    if (humanizeModel(m[1]) === want) return Number(m[2]);
  }
  return undefined;
}

/**
 * Greeting options for the empty-chat state, personalized when a name is set
 * (mirrors Claudian's greeting array). The view picks one at random.
 */
export function greetingOptions(userName: string): string[] {
  const name = (userName || "").trim();
  const p = (base: string, fallback?: string): string =>
    name ? `${base}, ${name}` : fallback ?? base;
  return [
    p("What's new") + "?",
    p("Welcome back") + "!",
    p("How's it going") + "?",
    p("Hey there"),
    name ? `Hi ${name}, how can I help?` : "How can I help you today?"
  ];
}
