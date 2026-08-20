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
// Desktop uses Node HTTP (which avoids the local gateway's browser CORS
// restriction). Browser-hosted Obsidian uses the fetch adapter below only when
// Node's requester is unavailable or the user explicitly opts into it.
import { HermesSettings } from "../settings/types";
import {
  HermesCapabilities,
  ToolEvent,
  UsageInfo,
  chatCompletionUsage,
  chatDeltaContent,
  contextWindowFor,
  normaliseBaseUrl,
  parseSseBlock,
  runCompletedUsage,
  runEventReasoningText,
  supportsRunsTransport,
  toolEventFromRunEvent
} from "./protocol";
import { buildSystemInstructions, resolveWorkingFolder } from "./context";

export type { HermesCapabilities, ToolEvent, UsageInfo } from "./protocol";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamCallbacks {
  onChunk(text: string): void;
  onReasoning?(text: string): void;
  onToolEvent?(event: ToolEvent): void;
  /** A short, user-facing transport/activity update while a run is pending. */
  onProgress?(text: string): void;
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
  headers: Record<string, string>;
}

type EventHandler = (...args: unknown[]) => void;

interface RequestLike {
  on(event: string, handler: EventHandler): this;
  write(chunk: unknown): void;
  end(chunk?: unknown): void;
  destroy(error?: Error): void;
}

interface Requester {
  request(url: string, options: BrowserRequestOptions, onResponse?: (response: BrowserResponse) => void): RequestLike;
}

type IgnisWindow = Window & {
  /** Native fetch retained by Ignis before its cross-origin proxy shim. */
  __originalFetch?: typeof window.fetch;
};

interface BrowserRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

class BrowserResponse {
  private listeners = new Map<string, EventHandler[]>();

  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string>
  ) {}

  on(event: string, handler: EventHandler): this {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }
}

/** Small Node-request-shaped adapter so the protocol code below stays shared. */
class BrowserRequest {
  private readonly controller = new AbortController();
  private readonly listeners = new Map<string, EventHandler[]>();
  private readonly chunks: string[] = [];
  private timer: number | null = null;
  private started = false;

  constructor(
    private readonly url: string,
    private readonly options: BrowserRequestOptions,
    private readonly onResponse?: (response: BrowserResponse) => void
  ) {}

  on(event: string, handler: EventHandler): this {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  write(chunk: unknown): void {
    if (typeof chunk === "string") this.chunks.push(chunk);
  }

  end(chunk?: unknown): void {
    if (chunk != null) this.write(chunk);
    if (this.started) return;
    this.started = true;
    void this.start();
  }

  destroy(error?: Error): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.controller.abort();
    if (error) this.emit("error", error);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  private async start(): Promise<void> {
    if (this.options.timeout && this.options.timeout > 0) {
      this.timer = window.setTimeout(() => {
        this.emit("timeout");
        this.controller.abort();
      }, this.options.timeout);
    }
    try {
      // Content-Length is a forbidden browser header. fetch determines it.
      const headers = { ...(this.options.headers || {}) };
      delete headers["Content-Length"];
      delete headers["content-length"];
      const response = await this.fetch(this.url, {
        method: this.options.method || "GET",
        headers,
        body: this.chunks.length ? this.chunks.join("") : undefined,
        credentials: "same-origin",
        signal: this.controller.signal
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      const stream = new BrowserResponse(response.status, responseHeaders);
      this.onResponse?.(stream);
      if (!response.body) {
        stream.emit("end");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) stream.emit("data", decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) stream.emit("data", tail);
      stream.emit("end");
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (this.timer !== null) window.clearTimeout(this.timer);
    }
  }

  /**
   * Ignis's global fetch shim appends `Origin: app://obsidian.md` before it
   * forwards cross-origin requests. Hermes rejects that synthetic Origin.
   * Calling Ignis's same-origin proxy directly preserves Authorization while
   * avoiding the injected header. Outside Ignis, use ordinary browser fetch.
   */
  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const ignis = window as IgnisWindow;
    const nativeFetch = ignis.__originalFetch;
    let isCrossOrigin = false;
    try {
      isCrossOrigin = new URL(url, window.location.href).origin !== window.location.origin;
    } catch {
      /* ordinary fetch will report an invalid URL */
    }
    if (!nativeFetch || !isCrossOrigin) return window.fetch(url, init);

    const headers = new Headers(init.headers);
    const proxyResponse = await nativeFetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        url,
        method: init.method || "GET",
        headers: Object.fromEntries(headers.entries()),
        body: typeof init.body === "string" ? init.body : null,
        binary: false
      })
    });
    if (!proxyResponse.ok) {
      const error = await proxyResponse.text();
      throw new Error(error || `Ignis proxy returned HTTP ${proxyResponse.status}`);
    }
    const proxied = (await proxyResponse.json()) as {
      status: number;
      headers?: Record<string, string>;
      body?: string;
    };
    const encoded = proxied.body || "";
    const binary = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new Response(binary, { status: proxied.status, headers: proxied.headers });
  }
}

const browserRequester: Requester = {
  request: (url: string, options: BrowserRequestOptions, onResponse?: (response: BrowserResponse) => void) =>
    new BrowserRequest(url, options, onResponse)
};

function newSessionId(): string {
  const uuid = window.crypto?.randomUUID?.();
  return `obs-${Date.now()}-${uuid || Math.random().toString(36).slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "aborted");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown request error";
}

export class HermesGatewayClient {
  private capsCache: { value: HermesCapabilities | null; expiresAt: number } | null = null;

  constructor(
    private getSettings: () => HermesSettings,
    private getVaultBasePath: () => string = () => ""
  ) {}

  private base(): string {
    return normaliseBaseUrl(this.getSettings().baseUrl);
  }

  /** Absolute path of the agent's working folder (vault root or configured sub-folder). */
  private workingFolderPath(): string {
    return resolveWorkingFolder(this.getVaultBasePath() || "", this.getSettings().workingFolder || "");
  }

  /**
   * The `instructions` system message that scopes the agent to its working
   * folder (the vault root, or a configured sub-folder/absolute path). Hermes
   * has no documented `cwd` field on /v1/runs, so this is the primary way the
   * vault is communicated as the working directory.
   */
  private workingFolderInstructions(): string {
    const s = this.getSettings();
    return buildSystemInstructions(this.workingFolderPath(), {
      markdownFormattingEnabled: s.markdownFormattingPromptEnabled,
      customPrompt: s.customSystemPrompt
    });
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.getSettings().apiKey.trim();
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  private nodeRequire(): ((module: string) => { request: Requester["request"] }) | null {
    const requireFn = (window as Window & { require?: unknown }).require;
    return typeof requireFn === "function" ? (requireFn as (module: string) => { request: Requester["request"] }) : null;
  }

  private usesBrowserTransport(): boolean {
    return this.getSettings().requestTransport === "browser" || !this.nodeRequire();
  }

  private requester(): Requester {
    if (this.usesBrowserTransport()) return browserRequester;
    const requireFn = this.nodeRequire();
    if (!requireFn) return browserRequester;
    return {
      request: (url, options, onResponse) =>
        requireFn(url.startsWith("https:") ? "https" : "http").request(url, options, onResponse)
    };
  }

  /** One-shot (non-streaming) JSON request used for capabilities/models. */
  private async jsonRequest(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    timeoutMs = 8000
  ): Promise<RawResponse> {
    const url = `${this.base()}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(new TextEncoder().encode(payload).byteLength);
    }
    return new Promise<RawResponse>((resolve, reject) => {
      const req = this.requester().request(url, { method, headers, timeout: timeoutMs }, (res) => {
        let raw = "";
        res.on("data", (c: string) => (raw += c));
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
    const infos = await this.getModelInfos();
    return infos.map((m) => m.id);
  }

  /**
   * Fetch /v1/models as id + (optional) advertised context window. The gateway
   * uses the OpenAI shape `{ data: [{ id, context_length? }] }`; some providers
   * also expose `max_context_length` or `top_provider.context_length`.
   */
  async getModelInfos(): Promise<Array<{ id: string; contextWindow?: number }>> {
    const res = await this.jsonRequest("/v1/models", "GET");
    if (res.status !== 200) throw new Error(`/v1/models returned ${res.status}`);
    const parsed = JSON.parse(res.body) as { data?: Array<Record<string, unknown>> };
    const toPosInt = (v: unknown): number | undefined => {
      const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    return (parsed.data || [])
      .map((m) => {
        const id = typeof m.id === "string" ? m.id : "";
        const top = m.top_provider as { context_length?: unknown } | undefined;
        const contextWindow =
          toPosInt(m.context_length) ??
          toPosInt(m.max_context_length) ??
          toPosInt(top?.context_length);
        return { id, ...(contextWindow ? { contextWindow } : {}) };
      })
      .filter((m) => m.id);
  }

  /**
   * Resolve the active model for the footer display: the explicitly-configured
   * model when set, otherwise the gateway's first advertised model (the real
   * underlying id, e.g. "gpt-5.5", rather than the "hermes-agent" meta-label).
   * Returns null when the gateway can't be reached and no model is configured.
   */
  async resolveActiveModel(): Promise<{ id: string; contextWindow: number } | null> {
    const configured = (this.getSettings().model || "").trim();
    let infos: Array<{ id: string; contextWindow?: number }> = [];
    try {
      infos = await this.getModelInfos();
    } catch {
      infos = [];
    }
    let chosen: { id: string; contextWindow?: number } | undefined;
    if (configured) {
      chosen = infos.find((m) => m.id === configured) || { id: configured };
    } else {
      chosen = infos[0];
    }
    if (!chosen) return null;
    return { id: chosen.id, contextWindow: contextWindowFor(chosen.id, chosen.contextWindow) };
  }

  /** Probe the gateway and report a user-readable connection status. */
  async testConnection(): Promise<TestResult> {
    try {
      const capabilityResponse = await this.jsonRequest("/v1/capabilities", "GET");
      if (capabilityResponse.status !== 200) {
        const detail = capabilityResponse.body.trim().replace(/\s+/g, " ").slice(0, 240);
        return {
          ok: false,
          detail: `Gateway returned HTTP ${capabilityResponse.status} for /v1/capabilities${
            detail ? `: ${detail}` : "."
          }`
        };
      }
      let caps: HermesCapabilities;
      try {
        caps = JSON.parse(capabilityResponse.body) as HermesCapabilities;
      } catch {
        return {
          ok: false,
          detail: "Gateway returned HTTP 200 for /v1/capabilities, but the response was not valid JSON."
        };
      }
      this.capsCache = { value: caps, expiresAt: Date.now() + 60000 };
      const useRuns = supportsRunsTransport(caps);
      let models: string[] = [];
      let modelError = "";
      try {
        models = await this.listModels();
      } catch (e) {
        /* models endpoint optional for the test */
        modelError = errorMessage(e);
      }
      return {
        ok: true,
        detail: `Connected. Transport: ${useRuns ? "runs" : "chat"}.${
          models.length ? ` ${models.length} model(s) available.` : modelError ? ` /v1/models unavailable: ${modelError}` : ""
        }`,
        transport: useRuns ? "runs" : "chat",
        models
      };
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
        return {
          ok: false,
          detail: `Cannot reach the Hermes gateway at ${this.base()}. Check the address and that the gateway is running. (${msg})`
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

    void (async () => {
      let useRuns = false;
      if (s.transport === "runs") useRuns = true;
      else if (s.transport === "auto") {
        let caps: HermesCapabilities | null = null;
        try {
          caps = await this.getCapabilities();
        } catch {
          caps = null;
        }
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

  /**
   * One-shot, non-streaming convenience wrapper over `sendMessage`: send a
   * single prompt and resolve with the full accumulated reply text. Used by the
   * smart-graph analysis (which wants one JSON blob, not a live stream). Reuses
   * the exact transport selection / fallback logic of `sendMessage`, so there is
   * no duplicated request code. Returns an abortable handle plus a promise.
   */
  runToCompletion(input: string, history: ChatMessage[] = []): { abort(): void; result: Promise<string> } {
    let handle: ChatHandle | null = null;
    const result = new Promise<string>((resolve, reject) => {
      let buf = "";
      handle = this.sendMessage(input, history, {
        onChunk: (t) => {
          buf += t;
        },
        onError: (m) => reject(new Error(m)),
        onDone: () => resolve(buf)
      });
    });
    return { abort: () => handle?.abort(), result };
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
    const messages: ChatMessage[] = [];
    const instructions = this.workingFolderInstructions();
    if (instructions) messages.push({ role: "system", content: instructions });
    messages.push(...history, { role: "user", content: input });
    const bodyObj: Record<string, unknown> = {
      model: s.model || "hermes-agent",
      messages,
      stream: true,
      // Without this, OpenAI-compatible streams omit `usage` entirely, so
      // the chat panel's context-window gauge never updates on this
      // transport (it only ever moved on the Runs transport, which reports
      // usage unconditionally via run.completed).
      stream_options: { include_usage: true }
    };
    if (resumeSessionId) bodyObj.session_id = resumeSessionId;
    if (s.reasoningEffort) bodyObj.reasoning_effort = s.reasoningEffort;

    const payload = JSON.stringify(bodyObj);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(payload).byteLength),
      ...this.authHeaders()
    };
    let sessionId = resumeSessionId || newSessionId();
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
        const usage = chatCompletionUsage(json);
        if (usage) cb.onUsage?.(usage);
        if (typeof json.error?.message === "string") lastError = json.error.message;
      } catch {
        /* skip malformed block */
      }
      return false;
    };

    const req = this.requester().request(
      url,
      { method: "POST", headers, timeout: s.requestTimeoutMs },
      (res) => {
        const sid = res.headers["x-hermes-session-id"];
        if (typeof sid === "string" && sid) sessionId = sid;

        if (res.statusCode !== 200) {
          let errBody = "";
          res.on("data", (d: string) => (errBody += d));
          res.on("end", () => {
            try {
              const err = JSON.parse(errBody) as { error?: { message?: unknown } };
              const m = err.error?.message;
              finish(typeof m === "string" ? m : `API error ${res.statusCode}`);
            } catch {
              finish(`Gateway returned ${res.statusCode}: ${errBody.slice(0, 200)}`);
            }
          });
          return;
        }

        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
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
          if (isAborted() || isAbortError(err)) return;
          finish(`Stream error: ${errorMessage(err)}`);
        });
      }
    );
    reqs.push(req);
    req.on("error", (err) => {
      if (isAborted() || isAbortError(err)) return;
      finish(`API request failed: ${errorMessage(err)}`);
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
    const sessionId = resumeSessionId || newSessionId();

    const bodyObj: Record<string, unknown> = {
      model: s.model || "hermes-agent",
      input,
      conversation_history: history.map((m) => ({ role: m.role, content: m.content }))
    };
    const folder = this.workingFolderPath();
    const instructions = buildSystemInstructions(folder, {
      markdownFormattingEnabled: s.markdownFormattingPromptEnabled,
      customPrompt: s.customSystemPrompt
    });
    if (instructions) bodyObj.instructions = instructions;
    // Forward-compat: the current gateway ignores extra body keys, but the
    // upstream fix for true vault access is for /v1/runs to honor a per-run
    // `cwd` (the agent's Codex sandbox is otherwise rooted at the gateway's
    // launch directory, not the vault). Sending it now means this plugin will
    // "just work" the moment the gateway adds that field. Harmless until then.
    if (folder) bodyObj.cwd = folder;
    if (s.reasoningEffort) bodyObj.reasoning_effort = s.reasoningEffort;
    if (sessionId) bodyObj.session_id = sessionId;

    const payload = JSON.stringify(bodyObj);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(payload).byteLength),
      ...auth
    };
    if (sessionId) headers["X-Hermes-Session-Id"] = sessionId;

    let runId = "";
    let hasContent = false;
    let fellBack = false;
    let lastActivity = "";
    const startedAt = Date.now();

    const reportProgress = (activity: string) => {
      const elapsed = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      const text = `${activity} (${elapsed}s)`;
      if (text !== lastActivity) {
        lastActivity = text;
        cb.onProgress?.(text);
      }
    };

    const fallback = () => {
      if (fellBack || isAborted()) return;
      fellBack = true;
      cb.onProgress?.("Retrying with chat transport…");
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
        if (!hasContent) fallback();
        else finish(typeof raw.error === "string" && raw.error ? raw.error : "Hermes run failed.");
        return;
      }
      if (name === "run.cancelled") {
        finish(hasContent ? undefined : "Hermes run was cancelled.", sessionId);
        return;
      }
      if (name === "approval.request") {
        if (this.getSettings().autoApproveTools !== false && runId) {
          const command = typeof raw.command === "string" ? raw.command : "";
          cb.onToolEvent?.({
            name: "approval",
            status: "completed",
            preview: command ? `auto-approved: ${command}` : "auto-approved"
          });
          this.postRunApproval(apiUrl, runId, "always");
          return;
        }
        if (runId) this.postRunStop(apiUrl, runId);
        fallback();
      }
    };

    const openEventStream = (id: string) => {
      const eventsUrl = `${apiUrl}/v1/runs/${encodeURIComponent(id)}/events`;
      const eventsReq = this.requester().request(
        eventsUrl,
        { method: "GET", headers: auth, timeout: s.requestTimeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            fallback();
            return;
          }
          let buffer = "";
          res.on("data", (chunk: string) => {
            buffer += chunk;
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
            finish(undefined, sessionId);
          });
        }
      );
      reqs.push(eventsReq);
      eventsReq.on("error", (err) => {
        if (isAborted() || isAbortError(err)) return;
        if (!hasContent) fallback();
        else finish(`Run event stream failed: ${errorMessage(err)}`);
      });
      eventsReq.on("timeout", () => {
        eventsReq.destroy();
        if (!hasContent) fallback();
        else finish("Run event stream timed out.");
      });
      eventsReq.end();
    };

    // Ignis buffers upstream SSE, so only the browser path polls status.
    const pollRun = (id: string) => {
      let timer: number | null = null;
      let stopped = false;
      let approvalSubmitted = false;
      const stopPolling = () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
      };
      reqs.push({ destroy: stopPolling });

      const scheduleNext = () => {
        if (!stopped && !isAborted()) timer = window.setTimeout(poll, 1500);
      };

      const poll = () => {
        if (stopped || isAborted()) return;
        reportProgress("Hermes is working");
        const statusUrl = `${apiUrl}/v1/runs/${encodeURIComponent(id)}`;
        const statusReq = this.requester().request(
          statusUrl,
          { method: "GET", headers: auth, timeout: 10000 },
          (res) => {
            let raw = "";
            res.on("data", (chunk: string) => (raw += chunk));
            res.on("end", () => {
              if (stopped || isAborted()) return;
              if (res.statusCode !== 200) {
                stopPolling();
                finish(`Run status request returned ${res.statusCode}: ${raw.slice(0, 240)}`);
                return;
              }
              let status: Record<string, unknown>;
              try {
                status = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                stopPolling();
                finish("Gateway returned an invalid run status response.");
                return;
              }

              const state = typeof status.status === "string" ? status.status : "";
              const lastEvent = typeof status.last_event === "string" ? status.last_event : "";
              if (state === "queued") reportProgress("Waiting in the queue");
              else if (state === "waiting_for_approval") reportProgress("Waiting for tool approval");
              else if (lastEvent === "reasoning.available") reportProgress("Analyzing the request");
              else if (lastEvent === "tool.started") reportProgress("Running a tool");
              else if (lastEvent === "tool.completed") reportProgress("Continuing after a tool completed");
              if (state === "completed") {
                stopPolling();
                const output = typeof status.output === "string" ? status.output : "";
                if (output && !hasContent) {
                  hasContent = true;
                  cb.onChunk(output);
                }
                const usage = runCompletedUsage({ event: "run.completed", usage: status.usage });
                if (usage) cb.onUsage?.(usage);
                finish(undefined, sessionId);
                return;
              }
              if (state === "failed") {
                stopPolling();
                if (!hasContent) fallback();
                else finish(typeof status.error === "string" && status.error ? status.error : "Hermes run failed.");
                return;
              }
              if (state === "cancelled") {
                stopPolling();
                finish("Hermes run was cancelled.", sessionId);
                return;
              }
              if (state === "waiting_for_approval") {
                if (this.getSettings().autoApproveTools !== false && !approvalSubmitted) {
                  approvalSubmitted = true;
                  this.postRunApproval(apiUrl, id, "always");
                } else if (this.getSettings().autoApproveTools === false) {
                  stopPolling();
                  this.postRunStop(apiUrl, id);
                  fallback();
                  return;
                }
              }
              scheduleNext();
            });
          }
        );
        reqs.push(statusReq);
        statusReq.on("error", (err) => {
          if (stopped || isAborted() || isAbortError(err)) return;
          stopPolling();
          finish(`Run status request failed: ${errorMessage(err)}`);
        });
        statusReq.on("timeout", () => {
          statusReq.destroy();
          if (stopped || isAborted()) return;
          stopPolling();
          finish("Run status request timed out.");
        });
        statusReq.end();
      };

      poll();
    };

    const startUrl = `${apiUrl}/v1/runs`;
    cb.onProgress?.("Submitting request to Hermes…");
    const startReq = this.requester().request(
      startUrl,
      { method: "POST", headers, timeout: 30000 },
      (res) => {
        let raw = "";
        res.on("data", (c: string) => (raw += c));
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
          cb.onProgress?.(this.usesBrowserTransport() ? "Request accepted. Checking progress…" : "Request accepted. Opening event stream…");
          if (this.usesBrowserTransport()) pollRun(runId);
          else openEventStream(runId);
        });
      }
    );
    reqs.push(startReq);
    startReq.on("error", (err) => {
      if (isAborted() || isAbortError(err)) return;
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
      const req = this.requester().request(url, { method: "POST", headers: this.authHeaders() });
      req.on("error", () => {});
      req.end();
    } catch {
      /* best effort */
    }
  }

  /** Answer a pending tool-approval request for a run. */
  private postRunApproval(
    apiUrl: string,
    runId: string,
    choice: "once" | "session" | "always" | "deny"
  ): void {
    const url = `${apiUrl}/v1/runs/${encodeURIComponent(runId)}/approval`;
    try {
      const payload = JSON.stringify({ choice, resolve_all: true });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(payload).byteLength),
        ...this.authHeaders()
      };
      const req = this.requester().request(url, { method: "POST", headers });
      req.on("error", () => {});
      req.write(payload);
      req.end();
    } catch {
      /* best effort */
    }
  }
}
