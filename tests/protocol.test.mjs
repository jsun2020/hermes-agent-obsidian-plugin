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
  chatDeltaContent
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
