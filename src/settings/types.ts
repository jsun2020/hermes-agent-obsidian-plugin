// Plugin settings shape + defaults.

export type TransportPreference = "auto" | "runs" | "chat";

export interface HermesSettings {
  /** Base URL of the local Hermes gateway. Default profile pins port 8642. */
  baseUrl: string;
  /** API_SERVER_KEY from ~/.hermes/.env, pasted by the user (decision D1). */
  apiKey: string;
  /** Model id (e.g. "gpt-5.5"). Empty -> the gateway's "hermes-agent" default. */
  model: string;
  /**
   * Which transport to use against the gateway:
   *  - auto: probe /v1/capabilities, prefer the richer Runs transport,
   *          fall back to Chat Completions.
   *  - runs: force the Runs transport.
   *  - chat: force OpenAI-compatible Chat Completions.
   */
  transport: TransportPreference;
  /** Reasoning effort hint: "", minimal, low, medium, high, xhigh. */
  reasoningEffort: string;
  /** When sending the current note, include its full text (not just the path). */
  includeNoteContent: boolean;
  /** Per-request timeout in milliseconds for the chat/run streams. */
  requestTimeoutMs: number;
  /** Maximum number of concurrent chat tabs. */
  maxTabs: number;
}

export const DEFAULT_SETTINGS: HermesSettings = {
  baseUrl: "http://127.0.0.1:8642",
  apiKey: "",
  model: "",
  transport: "auto",
  reasoningEffort: "",
  includeNoteContent: true,
  requestTimeoutMs: 120000,
  maxTabs: 3
};
