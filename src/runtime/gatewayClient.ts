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
// Auth: Authorization: Bearer <key>. We use the standard browser `fetch` API
// (available in both the Obsidian desktop renderer and Obsidian mobile's
// webview). Using `fetch` (rather than Node's `http`/`https`) is what lets this
// plugin run on iOS/Android, where there is no Node runtime. The trade-off is
// that cross-origin requests from the mobile webview are subject to CORS, so
// the gateway must allow the browser Origin (see the plugin README's iOS
// notes) and we must avoid request headers that aren't CORS-allowed — hence we
// pass the session id only in the request body (`session_id`) and never set a
// custom `X-Hermes-Session-Id` request header.
//
// NOTE: `fetch`, `ReadableStream`, `TextDecoder`, `AbortController`, and
// `AbortSignal.timeout` are all globals in the Obsidian runtime; they are not
// imported and must not be bundled by esbuild.

import { HermesSettings } from "../settings/types";
import {
  HermesCapabilities,
  ToolEvent,
  UsageInfo,
  chatDeltaContent,
  contextWindowFor,
  normaliseBaseUrl,
  parseSseBlock,
  runCompletedUsage,
  runEventReasoningText,
  supportsRunsTransport,
  toolEventFromRunEvent
} from "./protocol";
import { contextFolderInstructions, resolveWorkingFolder } from "./context";

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

// ---- UUID helper (Node's crypto.randomUUID is unavailable on mobile) -------
function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    try {
      return g.crypto.randomUUID();
    } catch {
      /* fall through to manual generator */
    }
  }
  // RFC4122-ish v4, good enough for a session id.
  let s = "";
  for (let i = 0; i < 32; i++) {
    const r = (Math.random() * 16) | 0;
    if (i === 8 || i === 12 || i === 16 || i === 20) s += "-";
    s += (i === 12 ? 4 : i === 16 ? (r & 0x3) | 0x8 : r).toString(16);
  }
  return s;
}

// ---- the client ------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
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
    return contextFolderInstructions(this.workingFolderPath());
  }

  private authHeaders(): Record<string, string> {
    const key = (this.getSettings().apiKey || "").trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /** One-shot (non-streaming) JSON request used for capabilities/models. */
  private async jsonRequest(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    timeoutMs = 8000
  ): Promise<RawResponse> {
    const url = `${this.base()}${path}`;
    const headers: Record<string, string> = { ...this.authHeaders() };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal
      });
      const text = await res.text();
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k.toLowerCase()] = v;
      });
      return { status: res.status, body: text, headers: outHeaders };
    } finally {
      clearTimeout(timer);
    }
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
      if (/ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH|Failed to fetch|NetworkError/i.test(msg)) {
        return {
          ok: false,
          detail: `Cannot reach the gateway at ${this.base()}. Start the Hermes gateway, then retry: launch Hermes Desktop, or (CLI/TUI install) run \`hermes gateway\`. (${msg})`
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
      stream: true
    };
    if (resumeSessionId) bodyObj.session_id = resumeSessionId;
    if (s.reasoningEffort) bodyObj.reasoning_effort = s.reasoningEffort;

    // The session id is generated client-side so we don't depend on reading a
    // custom response header (which CORS would hide from the mobile webview).
    // It is carried in the request body (`session_id`) for server-side
    // continuity, never as a custom request header.
    const hasKey = !!(this.getSettings().apiKey || "").trim();
    const sessionId = resumeSessionId || (hasKey ? `obs-${Date.now()}-${uuid()}` : "");

    const payload = JSON.stringify(bodyObj);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.authHeaders()
    };

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
        if (typeof json.error?.message === "string") lastError = json.error.message;
      } catch {
        /* skip malformed block */
      }
      return false;
    };

    const controller = new AbortController();
    reqs.push({ destroy: () => controller.abort() });
    const timer = setTimeout(() => controller.abort(), s.requestTimeoutMs);

    void (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal: controller.signal
        });

        if (res.status !== 200) {
          const errBody = await res.text();
          try {
            const err = JSON.parse(errBody) as { error?: { message?: unknown } };
            const m = err.error?.message;
            finish(typeof m === "string" ? m : `API error ${res.status}`);
          } catch {
            finish(`Gateway returned ${res.status}: ${errBody.slice(0, 200)}`);
          }
          return;
        }

        if (!res.body) {
          finish(hasContent ? undefined : lastError || undefined, sessionId);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const part of parts) {
              const parsed = parseSseBlock(part);
              if (!parsed) continue;
              if (parsed.eventType) continue; // custom (tool-progress) events — ignore for now
              if (processData(parsed.data)) return;
            }
          }
        } catch (err) {
          if (isAborted() || (err as Error)?.name === "AbortError") return;
          finish(`Stream error: ${(err as Error)?.message || err}`);
          return;
        }
        if (buffer.trim()) {
          for (const part of buffer.split("\n\n")) {
            const parsed = parseSseBlock(part);
            if (parsed && !parsed.eventType && processData(parsed.data)) return;
          }
        }
        finish(hasContent ? undefined : lastError || undefined, sessionId);
      } catch (err) {
        if (isAborted() || (err as Error)?.name === "AbortError") return;
        finish(`API request failed: ${(err as Error)?.message || err}`);
      } finally {
        clearTimeout(timer);
      }
    })();
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
    const hasKey = !!(this.getSettings().apiKey || "").trim();
    const sessionId = resumeSessionId || (hasKey ? `obs-${Date.now()}-${uuid()}` : "");

    const bodyObj: Record<string, unknown> = {
      model: s.model || "hermes-agent",
      input,
      conversation_history: history.map((m) => ({ role: m.role, content: m.content }))
    };
    const folder = this.workingFolderPath();
    const instructions = contextFolderInstructions(folder);
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
      ...auth
    };

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
        // The agent is asking permission to use a tool (file read/write, search,
        // terminal). Auto-approve so the vault really is its working directory;
        // otherwise we'd deadlock or have to fall back to a tool-less reply.
        if (this.getSettings().autoApproveTools !== false && runId) {
          const command = typeof raw.command === "string" ? raw.command : "";
          cb.onToolEvent?.({
            name: "approval",
            status: "completed",
            preview: command ? `auto-approved: ${command}` : "auto-approved"
          });
          // Respond "always" + resolve_all so repeated identical requests don't
          // re-prompt; keep listening on the existing event stream.
          this.postRunApproval(apiUrl, runId, "always");
          return;
        }
        // Manual mode: no approval UI, so cancel + fall back to a plain reply.
        if (runId) this.postRunStop(apiUrl, runId);
        fallback();
        return;
      }
    };

    const openEventStream = (id: string) => {
      const eventsUrl = `${apiUrl}/v1/runs/${encodeURIComponent(id)}/events`;
      const controller = new AbortController();
      reqs.push({ destroy: () => controller.abort() });
      const timer = setTimeout(() => controller.abort(), s.requestTimeoutMs);

      void (async () => {
        try {
          const res = await fetch(eventsUrl, {
            method: "GET",
            headers: auth,
            signal: controller.signal
          });
          if (res.status !== 200) {
            fallback();
            return;
          }
          if (!res.body) {
            finish(hasContent ? undefined : undefined, sessionId);
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
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
            }
          } catch (err) {
            if (isAborted() || (err as Error)?.name === "AbortError") return;
            if (!hasContent) {
              fallback();
              return;
            }
            finish(`Run event stream failed: ${(err as Error)?.message || err}`);
            return;
          }
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
        } catch (err) {
          if (isAborted() || (err as Error)?.name === "AbortError") return;
          if (!hasContent) fallback();
          else finish(`Run event stream failed: ${(err as Error)?.message || err}`);
        } finally {
          clearTimeout(timer);
        }
      })();
    };

    const startUrl = `${apiUrl}/v1/runs`;
    const startController = new AbortController();
    reqs.push({ destroy: () => startController.abort() });
    const startTimer = setTimeout(() => startController.abort(), 30000);

    void (async () => {
      try {
        const res = await fetch(startUrl, {
          method: "POST",
          headers,
          body: payload,
          signal: startController.signal
        });
        if (res.status !== 200 && res.status !== 202) {
          fallback();
          return;
        }
        const raw = await res.text();
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
      } catch (err) {
        if (isAborted() || (err as Error)?.name === "AbortError") return;
        fallback();
      } finally {
        clearTimeout(startTimer);
      }
    })();
  }

  /** Cancel a run (best effort; fire-and-forget). */
  private postRunStop(apiUrl: string, runId: string): void {
    const url = `${apiUrl}/v1/runs/${encodeURIComponent(runId)}/stop`;
    try {
      void fetch(url, { method: "POST", headers: this.authHeaders() }).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  /** Answer a pending tool-approval request for a run (fire-and-forget). */
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
        ...this.authHeaders()
      };
      void fetch(url, { method: "POST", headers, body: payload }).catch(() => {});
    } catch {
      /* best effort */
    }
  }
}
