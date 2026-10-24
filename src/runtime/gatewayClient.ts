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
// Auth: Authorization: Bearer <API_SERVER_KEY>. A remote gateway serving
// several profiles is addressed under /p/<profile>/ (settings.profile).
//
// The network itself goes through a Transport (see ./transport): Node
// http/https on desktop (unchanged behaviour), fetch with streaming on mobile.

import { HermesSettings } from "../settings/types";
import { Transport, createNodeTransport, isTimeoutError, requestOnce } from "./transport";
import {
  HermesCapabilities,
  ToolEvent,
  UsageInfo,
  chatCompletionUsage,
  chatDeltaContent,
  contextWindowFor,
  ApprovalChoice,
  ApprovalRequest,
  approvalRequestFromEvent,
  approvalResponseBody,
  runStopBody,
  parseSseBlock,
  profileBaseUrl,
  runCompletedUsage,
  runEventReasoningText,
  supportsRunsTransport,
  toolEventFromRunEvent
} from "./protocol";
import { buildSystemInstructions, resolveWorkingFolder } from "./context";

export type { ApprovalChoice, ApprovalRequest, HermesCapabilities, ToolEvent, UsageInfo } from "./protocol";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamCallbacks {
  onChunk(text: string): void;
  onReasoning?(text: string): void;
  onToolEvent?(event: ToolEvent): void;
  onUsage?(usage: UsageInfo): void;
  /**
   * Ask the user to approve a tool call (only when auto-approve is off).
   * Resolve with the chosen answer; without this callback the run is stopped
   * and the reply falls back to a plain, tool-less chat completion.
   */
  onApprovalRequest?(request: ApprovalRequest): Promise<ApprovalChoice>;
  onError(message: string): void;
  onDone(sessionId?: string): void;
}

function newSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `obs-${Date.now()}-${id}`;
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

export class HermesGatewayClient {
  private capsCache: { value: HermesCapabilities | null; expiresAt: number } | null = null;

  constructor(
    private getSettings: () => HermesSettings,
    private getVaultBasePath: () => string = () => "",
    private transport: Transport = createNodeTransport()
  ) {}

  private base(): string {
    const s = this.getSettings();
    return profileBaseUrl(s.baseUrl, s.profile);
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
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    return requestOnce(this.transport, url, { method, headers, body: payload, timeoutMs });
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
      if (/ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
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
      ...this.authHeaders()
    };
    let sessionId = resumeSessionId || (headers.Authorization ? newSessionId() : "");
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

    let status = 0;
    let buffer = "";
    let errBody = "";
    let stop = false;
    const req = this.transport.stream(
      url,
      { method: "POST", headers, body: payload, timeoutMs: s.requestTimeoutMs },
      {
        onResponse: (code, resHeaders) => {
          status = code;
          const sid = resHeaders["x-hermes-session-id"];
          if (sid) sessionId = sid;
        },
        onData: (text) => {
          if (stop) return;
          if (status !== 200) {
            errBody += text;
            return;
          }
          buffer += text;
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const parsed = parseSseBlock(part);
            if (!parsed) continue;
            if (parsed.eventType) continue; // custom (tool-progress) events — ignore for now
            if (processData(parsed.data)) {
              stop = true;
              return;
            }
          }
        },
        onEnd: () => {
          if (stop) return;
          if (status !== 200) {
            try {
              const err = JSON.parse(errBody) as { error?: { message?: unknown } };
              const m = err.error?.message;
              finish(typeof m === "string" ? m : `API error ${status}`);
            } catch {
              finish(`Gateway returned ${status}: ${errBody.slice(0, 200)}`);
            }
            return;
          }
          if (buffer.trim()) {
            for (const part of buffer.split("\n\n")) {
              const parsed = parseSseBlock(part);
              if (parsed && !parsed.eventType && processData(parsed.data)) return;
            }
          }
          finish(hasContent ? undefined : lastError || undefined, sessionId);
        },
        onError: (err) => {
          if (isAborted() || err.name === "AbortError" || err.message === "aborted") return;
          if (isTimeoutError(err)) finish("Request timed out.");
          else if (status) finish(`Stream error: ${err.message}`);
          else finish(`API request failed: ${err.message}`);
        }
      }
    );
    reqs.push(req);
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
    const sessionId = resumeSessionId || (auth.Authorization ? newSessionId() : "");

    const bodyObj: Record<string, unknown> = {
      input,
      conversation_history: history.map((m) => ({ role: m.role, content: m.content }))
    };
    // Empty Model setting = auto-detect: omit the field so the gateway applies
    // its own default. Sending a placeholder ("hermes-agent") makes the Runs
    // endpoint forward it verbatim to the provider -> HTTP 400 "Unknown Model".
    const explicitModel = (s.model || "").trim();
    if (explicitModel) bodyObj.model = explicitModel;
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
      ...auth
    };
    if (sessionId) headers["X-Hermes-Session-Id"] = sessionId;

    let runId = "";
    let hasContent = false;
    let fellBack = false;
    let finishedRun = false;
    // Set while the user is answering an approval prompt: an idle timeout of
    // the event stream during that wait is expected and reopens the stream.
    let awaitingApproval = false;
    let reopenAfterApproval = false;

    const fallback = () => {
      if (fellBack || isAborted()) return;
      fellBack = true;
      this.startChat(input, history, cb, resumeSessionId, reqs, isAborted, finish);
    };

    const handleEvent = (raw: Record<string, unknown>) => {
      const name = typeof raw.event === "string" ? raw.event : "";
      if (name === "run.completed" || name === "run.failed" || name === "run.cancelled") finishedRun = true;
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
          void this.postRunApproval(apiUrl, runId, "always", approvalRequestFromEvent(raw));
          return;
        }
        // Manual mode with an approval UI: ask the user, then answer the run.
        if (runId && cb.onApprovalRequest) {
          const request = approvalRequestFromEvent(raw);
          awaitingApproval = true;
          cb.onToolEvent?.({ name: "approval", status: "running", preview: request.command || "approval requested" });
          cb.onApprovalRequest(request)
            .catch((): ApprovalChoice => "deny")
            .then((choice) => {
              awaitingApproval = false;
              if (isAborted()) return;
              cb.onToolEvent?.({
                name: "approval",
                status: "completed",
                preview: `${choice === "deny" ? "denied" : `approved (${choice})`}${request.command ? `: ${request.command}` : ""}`
              });
              void this.postRunApproval(apiUrl, runId, choice, request).then((err) => {
                if (err && !isAborted()) {
                  cb.onToolEvent?.({ name: "approval", status: "failed", preview: `gateway rejected the answer: ${err}` });
                }
              });
              if (reopenAfterApproval) {
                reopenAfterApproval = false;
                openEventStream(runId);
              }
            });
          return;
        }
        // Manual mode without an approval UI: cancel + fall back to a plain reply.
        if (runId) void this.postRunStop(apiUrl, runId);
        fallback();
        return;
      }
    };

    const openEventStream = (id: string) => {
      const eventsUrl = `${apiUrl}/v1/runs/${encodeURIComponent(id)}/events`;
      let status = 0;
      let buffer = "";
      const eventsReq = this.transport.stream(
        eventsUrl,
        { method: "GET", headers: auth, timeoutMs: s.requestTimeoutMs },
        {
          onResponse: (code) => {
            status = code;
          },
          onData: (text) => {
            if (status !== 200) return;
            buffer += text;
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
          },
          onEnd: () => {
            if (status !== 200) {
              fallback();
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
            if (awaitingApproval) {
              reopenAfterApproval = true;
              return;
            }
            finish(hasContent ? undefined : undefined, sessionId);
          },
          onError: (err) => {
            if (isAborted() || err.name === "AbortError") return;
            if (isTimeoutError(err)) {
              if (awaitingApproval) {
                reopenAfterApproval = true;
                return;
              }
              if (!hasContent) fallback();
              else finish("Run event stream timed out.");
              return;
            }
            if (!hasContent) fallback();
            else finish(`Run event stream failed: ${err.message}`);
          }
        }
      );
      reqs.push(eventsReq);
    };

    const startUrl = `${apiUrl}/v1/runs`;
    const startReq = this.transport.stream(
      startUrl,
      { method: "POST", headers, body: payload, timeoutMs: 30000 },
      (() => {
        let status = 0;
        let raw = "";
        return {
          onResponse: (code: number) => {
            status = code;
          },
          onData: (text: string) => {
            raw += text;
          },
          onEnd: () => {
            if (status !== 200 && status !== 202) {
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
            // Stopping in the UI must also stop the run on the gateway; otherwise
            // a run waiting for approval blocks the session's next message.
            const startedRun = runId;
            reqs.push({
              destroy: () => {
                if (!finishedRun) void this.postRunStop(apiUrl, startedRun);
              }
            });
            openEventStream(runId);
          },
          onError: (err: Error) => {
            if (isAborted() || err.name === "AbortError") return;
            fallback();
          }
        };
      })()
    );
    reqs.push(startReq);
  }

  /** Fire-and-forget POST (best effort; errors are ignored). */
  private postQuietly(url: string, body?: unknown): void {
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      requestOnce(this.transport, url, {
        method: "POST",
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: 15000
      }).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  /**
   * Stop a run on the gateway. Gateways running the session authority accept
   * exactly {admission_id, execution_generation} (read from GET /v1/runs/{id});
   * older gateways take an empty body.
   */
  private async postRunStop(apiUrl: string, runId: string): Promise<void> {
    const runUrl = `${apiUrl}/v1/runs/${encodeURIComponent(runId)}`;
    let body: Record<string, unknown> | undefined;
    try {
      const res = await requestOnce(this.transport, runUrl, {
        method: "GET",
        headers: { ...this.authHeaders() },
        timeoutMs: 10000
      });
      if (res.status === 200) body = runStopBody(JSON.parse(res.body) as Record<string, unknown>);
    } catch {
      /* fall back to an empty body */
    }
    this.postQuietly(`${runUrl}/stop`, body);
  }


  /**
   * Answer a pending tool-approval request for a run. Resolves with an error
   * message when the gateway refuses the answer, otherwise with "".
   */
  private async postRunApproval(
    apiUrl: string,
    runId: string,
    choice: ApprovalChoice,
    request: ApprovalRequest | null = null
  ): Promise<string> {
    const url = `${apiUrl}/v1/runs/${encodeURIComponent(runId)}/approval`;
    try {
      const res = await requestOnce(this.transport, url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(approvalResponseBody(request, choice)),
        timeoutMs: 15000
      });
      if (res.status >= 200 && res.status < 300) return "";
      try {
        const parsed = JSON.parse(res.body) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === "string") return `${res.status} ${parsed.error.message}`;
      } catch {
        /* not JSON */
      }
      return `HTTP ${res.status}`;
    } catch (e) {
      return (e as Error)?.message || String(e);
    }
  }
}
