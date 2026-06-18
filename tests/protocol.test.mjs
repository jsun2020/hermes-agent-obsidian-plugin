// Unit tests for the pure protocol helpers.
//
// These import the esm build produced by `npm run build:test` (esbuild bundles
// src/runtime/protocol.ts -> tests/.build/protocol.mjs), then run with the
// Node built-in test runner: `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSseBlock,
  supportsRunsTransport,
  toolEventFromRunEvent,
  runEventReasoningText,
  runCompletedUsage,
  normaliseBaseUrl,
  chatDeltaContent,
  humanizeModel,
  contextWindowFor,
  contextPercent,
  greetingOptions,
  parseConfigModel,
  parseContextLengthCache
} from "./.build/protocol.mjs";

test("parseSseBlock parses data-only blocks with CRLF", () => {
  assert.deepEqual(parseSseBlock('data: {"event":"message.delta"}\r\n\r\n'), {
    eventType: "",
    data: '{"event":"message.delta"}'
  });
});

test("parseSseBlock captures event type", () => {
  assert.deepEqual(parseSseBlock("event: hermes.tool.progress\ndata: hi"), {
    eventType: "hermes.tool.progress",
    data: "hi"
  });
});

test("parseSseBlock returns null without data lines", () => {
  assert.equal(parseSseBlock(": keep-alive comment"), null);
});

test("supportsRunsTransport accepts a full capabilities payload", () => {
  assert.equal(
    supportsRunsTransport({
      features: {
        run_submission: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
        tool_progress_events: true
      },
      endpoints: {
        runs: { path: "/v1/runs" },
        run_events: { path: "/v1/runs/{run_id}/events" },
        run_approval: { path: "/v1/runs/{run_id}/approval" },
        run_stop: { path: "/v1/runs/{run_id}/stop" }
      }
    }),
    true
  );
});

test("supportsRunsTransport rejects chat-only gateways", () => {
  assert.equal(
    supportsRunsTransport({
      features: { chat_completions_streaming: true },
      endpoints: { chat_completions: { path: "/v1/chat/completions" } }
    }),
    false
  );
});

test("supportsRunsTransport rejects null", () => {
  assert.equal(supportsRunsTransport(null), false);
});

test("toolEventFromRunEvent maps lifecycle events", () => {
  assert.deepEqual(
    toolEventFromRunEvent({ event: "tool.started", tool: "terminal", preview: "npm test" }),
    { name: "terminal", status: "running", preview: "npm test" }
  );
  assert.deepEqual(toolEventFromRunEvent({ event: "tool.completed", tool: "terminal" }), {
    name: "terminal",
    status: "completed"
  });
  assert.equal(toolEventFromRunEvent({ event: "message.delta" }), null);
});

test("runEventReasoningText extracts reasoning", () => {
  assert.equal(runEventReasoningText({ event: "reasoning.available", text: "hmm" }), "hmm");
  assert.equal(runEventReasoningText({ event: "message.delta", delta: "x" }), "");
});

test("runCompletedUsage maps token usage", () => {
  assert.deepEqual(
    runCompletedUsage({
      event: "run.completed",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
    }),
    { promptTokens: 11, completionTokens: 7, totalTokens: 18 }
  );
  assert.equal(runCompletedUsage({ event: "run.failed" }), null);
});

test("normaliseBaseUrl strips trailing slash and /v1", () => {
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8642/"), "http://127.0.0.1:8642");
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8642/v1"), "http://127.0.0.1:8642");
  assert.equal(normaliseBaseUrl("  http://host/v1/  "), "http://host");
});

test("chatDeltaContent extracts OpenAI delta", () => {
  assert.equal(chatDeltaContent({ choices: [{ delta: { content: "hello" } }] }), "hello");
  assert.equal(chatDeltaContent({ choices: [{ delta: {} }] }), "");
  assert.equal(chatDeltaContent({}), "");
});

test("humanizeModel strips provider prefix and base-url suffix", () => {
  assert.equal(humanizeModel("openai-codex/gpt-5.5"), "gpt-5.5");
  assert.equal(humanizeModel("gpt-5.5@https://chatgpt.com/backend-api/codex"), "gpt-5.5");
  assert.equal(humanizeModel("gpt-5.5"), "gpt-5.5");
  assert.equal(humanizeModel("  "), "");
});

test("contextWindowFor prefers advertised, then known table, then default", () => {
  assert.equal(contextWindowFor("gpt-5.5", 123456), 123456); // advertised wins
  assert.equal(contextWindowFor("openai-codex/gpt-5.5"), 272000); // known
  assert.equal(contextWindowFor("gpt-5.9-future"), 272000); // gpt-5 family default
  assert.equal(contextWindowFor("some-other-model"), 200000); // generic default
  assert.equal(contextWindowFor("gpt-5.5", 0), 272000); // 0 advertised ignored
});

test("contextPercent computes a clamped, rounded percentage", () => {
  assert.equal(contextPercent(27200, 272000), 10);
  assert.equal(contextPercent(0, 272000), 0);
  assert.equal(contextPercent(999999999, 272000), 100); // clamp high
  assert.equal(contextPercent(100, 0), 0); // no window -> 0
});

test("parseConfigModel reads the top-level model block only", () => {
  const yaml = [
    "# comment",
    "model:",
    "  # Default model",
    '  default: "gpt-5.5"',
    '  provider: "openai-codex"',
    "  openai_runtime: codex_app_server",
    "",
    "providers:",
    "  some:",
    "    default: nope",
    "    model: alsonope"
  ].join("\n");
  assert.deepEqual(parseConfigModel(yaml), { model: "gpt-5.5", provider: "openai-codex" });
});

test("parseConfigModel handles the 'model:' key alias and inline comments", () => {
  const yaml = "model:\n  model: gpt-5.4   # active\n  provider: auto\n";
  assert.deepEqual(parseConfigModel(yaml), { model: "gpt-5.4", provider: "auto" });
});

test("parseConfigModel returns empty when no model block", () => {
  assert.deepEqual(parseConfigModel("other:\n  default: x\n"), {});
});

test("parseContextLengthCache matches on the bare model id", () => {
  const yaml =
    "context_lengths:\n" +
    "  gpt-5.5@https://chatgpt.com/backend-api/codex: 272000\n" +
    "  gpt-4o@https://api.openai.com/v1: 128000\n";
  assert.equal(parseContextLengthCache(yaml, "gpt-5.5"), 272000);
  assert.equal(parseContextLengthCache(yaml, "openai-codex/gpt-4o"), 128000);
  assert.equal(parseContextLengthCache(yaml, "gpt-9"), undefined);
});

test("greetingOptions personalizes when a name is set", () => {
  const named = greetingOptions("Jason");
  assert.ok(named.includes("What's new, Jason?"));
  assert.ok(named.some((g) => g === "Hi Jason, how can I help?"));
  const anon = greetingOptions("");
  assert.ok(anon.includes("What's new?"));
  assert.ok(anon.includes("How can I help you today?"));
});
