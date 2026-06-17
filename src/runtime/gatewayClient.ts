// HermesGatewayClient — the only Hermes-specific layer.
//
// This is a near-direct port of Hermes Desktop's reference implementation
// (src/main/hermes.ts + src/main/run-stream.ts). It speaks to the local
// Hermes gateway HTTP API:
//
//   GET  /v1/capabilities                 -> pick transport
//   [Runs]  POST /v1/runs                 -> { run_id }
//           GET  /v1/runs/{id}/events     -> SSE event stream
//           POST /v1/runs/{id}/stop       -> cancel
//   [Chat]  POST /v1/chat/completions     -> OpenAI-compatible SSE
//   GET  /v1/models                       -> model list (test/connect)
//
// Auth: Authorization: Bearer <API_SERVER_KEY>. We talk to it from the Node
// side (Electron renderer with Node integration), exactly as Desktop does, so
// there is no browser CORS involved and Node's http client ignores the system
// proxy for loopback addresses.

import * as http from "http";
import * as https from "https";
import { randomUUID } from "crypto";
import { HermesSettings } from "../settings/types";
import {
  HermesCapabilities,
  ToolEvent,
  UsageInfo,
  chatDeltaContent,
  normaliseBaseUrl,
  parseSseBlock,
  runCompletedUsage,
  runEventReasoningText,
  supportsRunsTransport,
  toolEventFromRunEvent
} from "./protocol";

export type { HermesCapabilities, ToolEvent, UsageInfo } from "./protocol";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamCallbacks {
  onChunk(text: string): void;
  onReasoning?(text: string): void;
  onToolEvent?(event: ToolEvent): void;
  onUsage?(usage: UsageInfo): void;
  onError(message: string): void;
  onDone(sessionId?: string): void;
}

export interface ChatHandle {
  abort(): void;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  transport?: "runs" | "chat";
  models?: string[];
}

// ---- the client ------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export class HermesGatewayClient {
  private capsCache: { value: HermesCapabilities | null; expiresAt: number } | null = null;

  constructor(private getSettings: () => HermesSettings) {}

  private base(): string {
    return normaliseBaseUrl(this.getSettings().baseUrl);
  }

  private authHeaders(): Record<string, string> {
    const key = (this.getSettings().apiKey || "").trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private requester(url: string): typeof http | typeof https {
    return url.startsWith("https") ? https : http;
  }

  /** One-shot (non-streaming) JSON request used for capabilities/models. */
  private async jsonRequest(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    timeoutMs = 8000
  ): Promise<RawResponse> {
    const url = `${this.base()}${path}`;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    return new Promise<RawResponse>((resolve, reject) => {
      const req = this.requester(url).request(url, { method, headers, timeout: timeoutMs }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: raw, headers: res.headers })
        );
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("request timed out"));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async getCapabilities(force = false): Promise<HermesCapabilities | null> {
    if (!force && this.capsCache && this.capsCache.expiresAt > Date.now()) {
      return this.capsCache.value;
    }
    let value: HermesCapabilities | null = null;
    try {
      const res = await this.jsonRequest("/v1/capabilities", "GET");
      if (res.status === 200) value = JSON.parse(res.body) as HermesCapabilities;
    } catch {
      value = null;
    }
    this.capsCache = { value, expiresAt: Date.now() + 60000 };
    return value;
  }

  async listModels(): Promise<string[]> {
    const res = await this.jsonRequest("/v1/models", "GET");
    if (res.status !== 200) throw new Error(`/v1/models returned ${res.status}`);
    const parsed = JSON.parse(res.body) as { data?: Array<{ id?: unknown }> };
    const ids = (parsed.data || [])
      .map((m) => (typeof m.id === "string" ? m.id : ""))
      .filter(Boolean);
    return ids;
  }

  /** Probe the gateway and report a user-readable connection status. */
  async testConnection(): Promise<TestResult> {
    try {
      const caps = await this.getCapabilities(true);
      const useRuns = supportsRunsTransport(caps);
      let models: string[] = [];
      try {
        models = await this.listModels();
      } catch {
        /* models endpoint optional for the test */
      }
      if (caps === null && models.length === 0) {
        return {
          ok: false,
          detail:
            "Reached the host but got no capabilities/models. Is the Hermes gateway started and the API key correct?"
        };
      }
      return {
        ok: true,
        detail: `Connected. Transport: ${useRuns ? "runs" : "chat"}.${
          models.length ? ` ${models.length} model(s) available.` : ""
        }`,
        transport: useRuns ? "runs" : "chat",
        models
      };
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
        return {
          ok: false,
          detail: `Cannot reach the gateway at ${this.base()}. Start Hermes Desktop (which launches the gateway), then retry. (${msg})`
        };
      }
      if (/401|403/.test(msg)) {
        return { ok: false, detail: `Authentication failed. Check the API key. (${msg})` };
      }
      return { ok: false, detail: `Connection failed: ${msg}` };
    }
  }

  /**
   * Send a message and stream the reply. Picks the transport per settings:
   * auto -> capability-detect (prefer runs), else the forced choice.
   * Returns a handle whose abort() cancels the in-flight request.
   */
  sendMessage(
    input: string,
    history: ChatMessage[],
    cb: StreamCallbacks,
    resumeSessionId?: string
  ): ChatHandle {
    const s = this.getSettings();
    const reqs: Array<{ destroy(): void }> = [];
    let aborted = false;
    let finished = false;

    const finishOnce = (error?: string, sessionId?: string) => {
      if (finished || aborted) return;
      finished = true;
      if (error) cb.onError(error);
      else cb.onDone(sessionId);
    };

    const handle: ChatHandle = {
      abort: () => {
        aborted = true;
        for (const r of reqs) {
          try {
            r.destroy();
          } catch {
            /* ignore */
          }
        }
      }
    };

    (async () => {
      let useRuns = false;
      if (s.transport === "runs") useRuns = true;
      else if (s.transport === "auto") {
        const caps = await this.getCapabilities().catch(() => null);
        useRuns = supportsRunsTransport(caps);
      }
      if (aborted) return;
      if (useRuns) {
        this.startRuns(input, history, cb, resumeSessionId, reqs, () => aborted, finishOnce);
      } else {
        this.startChat(input, history, cb, resumeSessionId, reqs, () => aborted, finishOnce);
      }
    })();

    return handle;
  }

  // ---- Chat Completions transport ----

  private startChat(
    input: string,
    history: ChatMessage[],
    cb: StreamCallbacks,
    resumeSessionId: string | undefined,
    reqs: Array<{ destroy(): void }>,
    isAborted: () => boolean,
    finish: (error?: string, sessionId?: string) => void
  ): void {
    const s = this.getSettings();
    const messages: ChatMessage[] = [...history, { role: "user", content: input }];
    const bodyObj: Record<string, unknown> = {
      model: s.model || "hermes-agent",
      messages,
      stream: true
    };
    if (resumeSessionId) bodyObj.session_id = resumeSessionId;
    if (s.reasoningEffort) bodyObj.reasoning_effort = s.reasoningEffort;

    const payload = Buffer.from(JSON.stringify(bodyObj), "utf-8");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      ...this.authHeaders()
    };
    let sessionId = resumeSessionId || (headers.Authorization ? `obs-${Date.now()}-${randomUUID()}` : "");
    if (sessionId) headers["X-Hermes-Session-Id"] = sessionId;

    const url = `${this.base()}/v1/chat/completions`;
    let hasContent = false;
    let lastError = "";

    const processData = (data: string): boolean => {
      if (data.trim() === "[DONE]") {
        finish(hasContent ? undefined : lastError || undefined, sessionId);
        return true;
      }
      try {
        const json = JSON.parse(data) as { error?: { message?: unknown } };
        const delta = chatDeltaContent(json);
        if (delta) {
          hasContent = true;
          cb.onChunk(delta);
        }
        if (json.error?.message) lastError = String(json.error.message);
      } catch {
        /* skip malformed block */
      }
      return false;
    };

    const req = this.requester(url).request(
      url,
      { method: "POST", headers, timeout: s.requestTimeoutMs },
      (res) => {
        const sid = res.headers["x-hermes-session-id"];
        if (typeof sid === "string" && sid) sessionId = sid;

        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (d) => (errBody += d.toString()));
          res.on("end", () => {
            try {
              const err = JSON.parse(errBody);
              finish(err.error?.message || `API error ${res.statusCode}`);
            } catch {
              finish(`Gateway returned ${res.statusCode}: ${errBody.slice(0, 200)}`);
            }
          });
          return;
        }

        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const parsed = parseSseBlock(part);
            if (!parsed) continue;
            if (parsed.eventType) continue; // custom (tool-progress) events — ignore for now
            if (processData(parsed.data)) return;
          }
        });
        res.on("end", () => {
          if (buffer.trim()) {
            for (const part of buffer.split("\n\n")) {
              const parsed = parseSseBlock(part);
              if (parsed && !parsed.eventType && processData(parsed.data)) return;
            }
          }
          finish(hasContent ? undefined : lastError || undefined, sessionId);
        });
        res.on("error", (err) => {
          if (isAborted() || err.name === "AbortError" || err.message === "aborted") return;
          finish(`Stream error: ${err.message}`);
        });
      }
    );
    reqs.push(req);
    req.on("error", (err) => {
      if (isAborted() || err.name === "AbortError") return;
      finish(`API request failed: ${err.message}`);
    });
    req.on("timeout", () => {
      req.destroy();
      if (!isAborted()) finish("Request timed out.");
    });
    req.write(payload);
    req.end();
  }

  // ---- Runs transport ----

  private startRuns(
    input: string,
    history: ChatMessage[],
    cb: StreamCallbacks,
    resumeSessionId: string | undefined,
    reqs: Array<{ destroy(): void }>,
    isAborted: () => boolean,
    finish: (error?: string, sessionId?: string) => void
  ): void {
    const s = this.getSettings();
    const apiUrl = this.base();
    const auth = this.authHeaders();
    const sessionId = resumeSessionId || (auth.Authorization ? `obs-${Date.now()}-${randomUUID()}` : "");

    const bodyObj: Record<string, unknown> = {
      model: s.model || "hermes-agent",
      input,
      conversation_history: history.map((m) => ({ role: m.role, content: m.content }))
    };
    if (s.reasoningEffort) bodyObj.reasoning_effort = s.reasoningEffort;
    if (sessionId) bodyObj.session_id = sessionId;

    const payload = Buffer.from(JSON.stringify(bodyObj), "utf-8");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      ...auth
    };
    if (sessionId) headers["X-Hermes-Session-Id"] = sessionId;

    let runId = "";
    let hasContent = false;
    let fellBack = false;

    const fallback = () => {
      if (fellBack || isAborted()) return;
      fellBack = true;
      this.startChat(input, history, cb, resumeSessionId, reqs, isAborted, finish);
    };

    const handleEvent = (raw: Record<string, unknown>) => {
      const name = typeof raw.event === "string" ? raw.event : "";
      if (name === "message.delta") {
        const delta = typeof raw.delta === "string" ? raw.delta : "";
        if (delta) {
          hasContent = true;
          cb.onChunk(delta);
        }
        return;
      }
      const reasoning = runEventReasoningText(raw);
      if (reasoning) {
        cb.onReasoning?.(reasoning);
        return;
      }
      const toolEvent = toolEventFromRunEvent(raw);
      if (toolEvent) {
        cb.onToolEvent?.(toolEvent);
        return;
      }
      if (name === "run.completed") {
        const output = typeof raw.output === "string" ? raw.output : "";
        if (output && !hasContent) {
          hasContent = true;
          cb.onChunk(output);
        }
        const usage = runCompletedUsage(raw);
        if (usage) cb.onUsage?.(usage);
        finish(undefined, sessionId);
        return;
      }
      if (name === "run.failed") {
        if (!hasContent) {
          fallback();
          return;
        }
        finish(typeof raw.error === "string" && raw.error ? raw.error : "Hermes run failed.");
        return;
      }
      if (name === "run.cancelled") {
        finish(hasContent ? undefined : "Hermes run was cancelled.", sessionId);
        return;
      }
      if (name === "approval.request") {
        // Approval UI is out of scope for now; cancel + fall back so the user
        // is never deadlocked waiting on a hidden approval prompt.
        if (runId) this.postRunStop(apiUrl, runId);
        fallback();
        return;
      }
    };

    const openEventStream = (id: string) => {
      const eventsUrl = `${apiUrl}/v1/runs/${encodeURIComponent(id)}/events`;
      const eventsReq = this.requester(eventsUrl).request(
        eventsUrl,
        { method: "GET", headers: auth, timeout: s.requestTimeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            fallback();
            return;
          }
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const part of parts) {
              const parsed = parseSseBlock(part);
              if (!parsed || !parsed.data || parsed.data.startsWith(":")) continue;
              try {
                handleEvent(JSON.parse(parsed.data) as Record<string, unknown>);
              } catch {
                /* skip malformed event */
              }
            }
          });
          res.on("end", () => {
            if (buffer.trim()) {
              const parsed = parseSseBlock(buffer);
              if (parsed?.data) {
                try {
                  handleEvent(JSON.parse(parsed.data) as Record<string, unknown>);
                } catch {
                  /* ignore */
                }
              }
            }
            finish(hasContent ? undefined : undefined, sessionId);
          });
        }
      );
      reqs.push(eventsReq);
      eventsReq.on("error", (err) => {
        if (isAborted() || err.name === "AbortError") return;
        if (!hasContent) fallback();
        else finish(`Run event stream failed: ${err.message}`);
      });
      eventsReq.on("timeout", () => {
        eventsReq.destroy();
        if (!hasContent) fallback();
        else finish("Run event stream timed out.");
      });
      eventsReq.end();
    };

    const startUrl = `${apiUrl}/v1/runs`;
    const startReq = this.requester(startUrl).request(
      startUrl,
      { method: "POST", headers, timeout: 30000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c.toString()));
        res.on("end", () => {
          if (res.statusCode !== 200 && res.statusCode !== 202) {
            fallback();
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { run_id?: unknown };
            runId = typeof parsed.run_id === "string" ? parsed.run_id : "";
          } catch {
            runId = "";
          }
          if (!runId) {
            fallback();
            return;
          }
          openEventStream(runId);
        });
      }
    );
    reqs.push(startReq);
    startReq.on("error", (err) => {
      if (isAborted() || err.name === "AbortError") return;
      fallback();
    });
    startReq.on("timeout", () => {
      startReq.destroy();
      fallback();
    });
    startReq.write(payload);
    startReq.end();
  }

  private postRunStop(apiUrl: string, runId: string): void {
    const url = `${apiUrl}/v1/runs/${encodeURIComponent(runId)}/stop`;
    try {
      const req = this.requester(url).request(url, { method: "POST", headers: this.authHeaders() });
      req.on("error", () => {});
      req.end();
    } catch {
      /* best effort */
    }
  }
}
