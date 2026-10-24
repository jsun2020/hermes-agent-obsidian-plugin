// src/runtime/protocol.ts
function normaliseBaseUrl(raw) {
  let url = (raw || "").trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/v1$/i, "");
  return url;
}
function boolFeature(caps, name) {
  return caps?.features?.[name] === true;
}
function endpointPath(caps, name) {
  const endpoint = caps?.endpoints?.[name];
  if (!endpoint || typeof endpoint !== "object") return "";
  const path = endpoint.path;
  return typeof path === "string" ? path : "";
}
function supportsRunsTransport(caps) {
  return boolFeature(caps, "run_submission") && boolFeature(caps, "run_events_sse") && boolFeature(caps, "run_stop") && boolFeature(caps, "run_approval_response") && boolFeature(caps, "tool_progress_events") && endpointPath(caps, "runs") === "/v1/runs" && endpointPath(caps, "run_events") === "/v1/runs/{run_id}/events" && endpointPath(caps, "run_approval") === "/v1/runs/{run_id}/approval" && endpointPath(caps, "run_stop") === "/v1/runs/{run_id}/stop";
}
function parseSseBlock(block) {
  let eventType = "";
  const dataLines = [];
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
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function toolEventFromRunEvent(event) {
  const name = stringValue(event.event);
  if (!["tool.started", "tool.completed", "tool.failed"].includes(name)) return null;
  const tool = stringValue(event.tool) || stringValue(event.tool_name) || "tool";
  const status = name === "tool.completed" ? "completed" : name === "tool.failed" ? "failed" : "running";
  const preview = stringValue(event.preview);
  return { name: tool, status, ...preview ? { preview } : {} };
}
function runEventReasoningText(event) {
  if (event.event !== "reasoning.available") return "";
  return stringValue(event.text) || stringValue(event.delta);
}
function runCompletedUsage(event) {
  if (event.event !== "run.completed") return null;
  const usage = event.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage;
  return {
    promptTokens: Number(u.input_tokens) || 0,
    completionTokens: Number(u.output_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0
  };
}
function chatCompletionUsage(json) {
  const j = json;
  const usage = j?.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage;
  return {
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0
  };
}
function chatDeltaContent(json) {
  const j = json;
  const delta = j?.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : "";
}
function humanizeModel(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  const beforeAt = s.split("@")[0];
  const lastSeg = beforeAt.split("/").pop() || beforeAt;
  return lastSeg.trim();
}
var CONTEXT_WINDOW_DEFAULT = 2e5;
var KNOWN_CONTEXT_WINDOWS = {
  "gpt-5.5": 272e3,
  "gpt-5.4": 272e3,
  "gpt-5.3": 272e3,
  "gpt-5.2": 272e3,
  "gpt-5.1": 272e3,
  "gpt-5": 272e3
};
function contextWindowFor(modelId, advertised) {
  if (typeof advertised === "number" && advertised > 0) return advertised;
  const id = humanizeModel(modelId).toLowerCase();
  if (KNOWN_CONTEXT_WINDOWS[id]) return KNOWN_CONTEXT_WINDOWS[id];
  if (id.startsWith("gpt-5")) return 272e3;
  return CONTEXT_WINDOW_DEFAULT;
}
function contextPercent(usedPromptTokens, contextWindow) {
  if (!contextWindow || contextWindow <= 0) return 0;
  const pct = Math.round(usedPromptTokens / contextWindow * 100);
  return Math.min(100, Math.max(0, pct));
}
function cleanScalar(raw) {
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
function parseConfigModel(yamlText) {
  const lines = (yamlText || "").split(/\r?\n/);
  let i = lines.findIndex((l) => /^model:\s*(#.*)?$/.test(l));
  if (i < 0) return {};
  const out = {};
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const m = /^\s+(default|model):\s*(.+)$/.exec(line);
    if (m && !out.model) out.model = cleanScalar(m[2]);
    const p = /^\s+provider:\s*(.+)$/.exec(line);
    if (p && !out.provider) out.provider = cleanScalar(p[1]);
  }
  return out;
}
function sanitizeProfileName(raw) {
  const name = (raw || "").trim();
  if (!name || name.length > 64) return "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") ? name : "";
}
function parseContextLengthCache(yamlText, modelId) {
  const want = humanizeModel(modelId);
  if (!want) return void 0;
  for (const line of (yamlText || "").split(/\r?\n/)) {
    if (!/^\s/.test(line)) continue;
    const m = /^\s+(.+):\s*(\d+)\s*$/.exec(line);
    if (!m) continue;
    if (humanizeModel(m[1]) === want) return Number(m[2]);
  }
  return void 0;
}
function greetingOptions(userName) {
  const name = (userName || "").trim();
  const p = (base, fallback) => name ? `${base}, ${name}` : fallback ?? base;
  return [
    p("What's new") + "?",
    p("Welcome back") + "!",
    p("How's it going") + "?",
    p("Hey there"),
    name ? `Hi ${name}, how can I help?` : "How can I help you today?"
  ];
}
function approvalRequestFromEvent(raw) {
  const all = ["once", "session", "always", "deny"];
  const offered = Array.isArray(raw.choices) ? all.filter((c) => raw.choices.includes(c)) : [];
  const text = (v) => typeof v === "string" ? v : "";
  const requestId = text(raw.request_id) || text(raw.prompt_id);
  const generation = raw.execution_generation;
  return {
    command: text(raw.command),
    description: text(raw.description) || text(raw.reason) || text(raw.pattern_key),
    choices: offered.length ? offered : ["once", "deny"],
    ...requestId ? { requestId } : {},
    ...typeof generation === "number" && Number.isInteger(generation) ? { executionGeneration: generation } : {}
  };
}
function approvalResponseBody(request, choice) {
  if (request?.requestId && request.executionGeneration !== void 0) {
    return { request_id: request.requestId, execution_generation: request.executionGeneration, choice };
  }
  return { choice, resolve_all: choice === "always" || choice === "session" };
}
function profileBaseUrl(baseUrl, profile) {
  const base = normaliseBaseUrl(baseUrl);
  const name = (profile || "").trim().replace(/^\/+|\/+$/g, "").replace(/^p\//, "");
  return name ? `${base}/p/${encodeURIComponent(name)}` : base;
}
function runStopBody(run) {
  const admission = run.admission_id;
  const generation = run.execution_generation;
  if (typeof admission === "string" && admission && typeof generation === "number" && Number.isInteger(generation)) {
    return { admission_id: admission, execution_generation: generation };
  }
  return void 0;
}
export {
  CONTEXT_WINDOW_DEFAULT,
  approvalRequestFromEvent,
  approvalResponseBody,
  chatCompletionUsage,
  chatDeltaContent,
  contextPercent,
  contextWindowFor,
  greetingOptions,
  humanizeModel,
  normaliseBaseUrl,
  parseConfigModel,
  parseContextLengthCache,
  parseSseBlock,
  profileBaseUrl,
  runCompletedUsage,
  runEventReasoningText,
  runStopBody,
  sanitizeProfileName,
  supportsRunsTransport,
  toolEventFromRunEvent
};
