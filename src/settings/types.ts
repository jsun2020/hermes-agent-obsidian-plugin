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
  /**
   * Working folder for the agent, relative to the vault root. Empty -> the
   * vault root. An absolute path is used as-is. This becomes the agent's
   * working directory (sent as the run's `instructions` system message).
   */
  workingFolder: string;
  /**
   * Auto-approve the agent's tool/command requests (file read/write, search,
   * terminal) so it can actually act on the vault. When false, runs that need
   * approval are cancelled and fall back to a plain (tool-less) chat reply.
   */
  autoApproveTools: boolean;
  /** Your name, used to personalize the empty-chat greeting. Optional. */
  userName: string;
  /**
   * Path to the Hermes home (the folder containing `config.yaml`), used to read
   * the REAL underlying model id (e.g. "gpt-5.5") and its context window, which
   * the gateway API never exposes. Empty -> auto-detect (`$HERMES_HOME`, then
   * `~/.hermes`). Portable-build users should point this at the portable
   * `hermes-data/hermes` folder next to the exe.
   */
  hermesHome: string;
}

export const DEFAULT_SETTINGS: HermesSettings = {
  baseUrl: "http://127.0.0.1:8642",
  apiKey: "",
  model: "",
  transport: "auto",
  reasoningEffort: "",
  includeNoteContent: true,
  requestTimeoutMs: 120000,
  maxTabs: 3,
  workingFolder: "",
  autoApproveTools: true,
  userName: "",
  hermesHome: ""
};
