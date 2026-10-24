import { FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, WorkspaceLeaf, normalizePath } from "obsidian";
import type * as FsModule from "fs";
import type * as OsModule from "os";
import type * as PathModule from "path";
import { createFetchTransport, createNodeTransport } from "./runtime/transport";
import { DEFAULT_SETTINGS, HermesSettings } from "./settings/types";
import { HermesSettingTab } from "./settings/HermesSettingTab";
import { HermesView, VIEW_TYPE_HERMES } from "./view/HermesView";
import { HermesGraphView, VIEW_TYPE_HERMES_GRAPH } from "./view/HermesGraphView";
import { HermesGatewayClient } from "./runtime/gatewayClient";
import { SmartGraph } from "./runtime/graph";
import { buildPrompt } from "./runtime/context";
import { parseConfigModel, parseContextLengthCache, sanitizeProfileName } from "./runtime/protocol";
import {
  Conversation,
  parseHistoryFile,
  removeConversation,
  serializeHistoryFile,
  upsertConversation
} from "./runtime/history";

/**
 * Node built-ins exist only in the desktop app. They are loaded lazily so the
 * plugin also starts on iOS/Android, where reading the local Hermes home is
 * simply skipped.
 */
interface NodeModules {
  fs: typeof FsModule;
  os: typeof OsModule;
  path: typeof PathModule;
}
function nodeModules(): NodeModules | null {
  if (!Platform.isDesktopApp) return null;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return {
      fs: require("fs") as typeof FsModule,
      os: require("os") as typeof OsModule,
      path: require("path") as typeof PathModule
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch {
    return null;
  }
}

export default class HermesPlugin extends Plugin {
  settings!: HermesSettings;
  client!: HermesGatewayClient;

  /** Locally persisted chat history (newest first), loaded from history.json. */
  conversations: Conversation[] = [];

  /**
   * Last Markdown view that was actually focused, tracked via
   * `active-leaf-change`. `getActiveViewOfType(MarkdownView)` alone returns
   * null once focus moves into the Hermes sidebar (e.g. clicking the chat
   * input), which silently dropped the "current note" attachment even when
   * the toggle was checked. This cache is the fallback for that case.
   */
  private lastMarkdownView: MarkdownView | null = null;

  /**
   * Snapshot of the last non-empty selection seen in `lastMarkdownView`.
   * Updated continuously (see the `selectionchange` listener in `onload`)
   * rather than only at the moment focus leaves the editor — waiting for a
   * single focus-change event turned out to still race with editor/theme
   * combinations that collapse the visual selection right around the same
   * moment. A live, always-up-to-date snapshot sidesteps that timing
   * entirely: by the time the user clicks Send, the value is already
   * sitting here from whenever they last had something selected.
   *
   * Expires 5s after the last relevant activity (a new selection, or typing
   * in the chat input — see `touchSelectionActivity`) so a selection you
   * made and then walked away from doesn't silently get attached to some
   * unrelated message sent much later. Set only via `setSelectionSnapshot`.
   */
  private lastSelectionSnapshot: { notePath?: string; text: string } | null = null;
  private selectionExpiryTimer: number | null = null;
  private static readonly SELECTION_EXPIRY_MS = 5000;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadHistory();
    this.client = new HermesGatewayClient(
      () => this.settings,
      () => this.getVaultBasePath(),
      Platform.isDesktopApp ? createNodeTransport() : createFetchTransport()
    );

    this.registerView(VIEW_TYPE_HERMES, (leaf) => new HermesView(leaf, this));
    this.registerView(VIEW_TYPE_HERMES_GRAPH, (leaf) => new HermesGraphView(leaf, this));

    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (this.lastMarkdownView) {
          const sel = this.captureViewSelection(this.lastMarkdownView);
          if (sel) this.setSelectionSnapshot({ notePath: this.lastMarkdownView.file?.path, text: sel });
        }
        const view = leaf?.view;
        if (view instanceof MarkdownView) this.lastMarkdownView = view;
      })
    );

    // Primary capture mechanism: fires on every selection change anywhere in
    // the document (mouse drag, shift+arrow, double-click-to-select, ...).
    // Only stores it when the selection actually lands inside the tracked
    // Markdown view, so selecting/copying text elsewhere (e.g. the Hermes
    // chat log itself) never overwrites a genuine note selection.
    this.registerDomEvent(activeDocument, "selectionchange", () => {
      const view = this.lastMarkdownView;
      if (!view) return;
      const sel = this.captureViewSelection(view);
      if (sel) this.setSelectionSnapshot({ notePath: view.file?.path, text: sel });
    });

    this.addRibbonIcon("bot", "Open Hermes Agent", () => {
      void this.activateView();
    });

    this.addRibbonIcon("git-fork", "Open Hermes smart graph", () => {
      void this.activateGraphView();
    });

    this.addCommand({
      id: "open-view",
      name: "Open chat view",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "new-tab",
      name: "New chat tab",
      callback: async () => {
        const view = await this.activateView();
        view?.newTab();
      }
    });

    this.addCommand({
      id: "open-graph",
      name: "Open smart graph",
      callback: () => void this.activateGraphView()
    });

    this.addCommand({
      id: "analyze-graph",
      name: "Analyze vault for smart graph",
      callback: async () => {
        const view = await this.activateGraphView();
        view?.analyzeFromCommand();
      }
    });

    this.addCommand({
      id: "send-note",
      name: "Send current note to Hermes",
      checkCallback: (checking) => {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return false;
        if (!checking) void this.sendNote(mdView);
        return true;
      }
    });

    this.addCommand({
      id: "send-selection",
      name: "Send selection to Hermes",
      // Not editorCheckCallback: that only sees the CodeMirror selection,
      // which stays empty for text highlighted by dragging over Reading
      // View (rendered HTML, not the editor). captureViewSelection covers
      // both modes.
      checkCallback: (checking) => {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return false;
        const sel = this.captureViewSelection(mdView);
        if (!sel) return false;
        if (!checking) void this.sendSelection(mdView, sel);
        return true;
      }
    });

    this.addSettingTab(new HermesSettingTab(this.app, this));
  }

  onunload(): void {
    // Obsidian detaches leaves automatically; HermesView.onClose aborts streams.
    if (this.selectionExpiryTimer !== null) window.clearTimeout(this.selectionExpiryTimer);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<HermesSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- chat history persistence ----
  //
  // Stored in a separate `history.json` in the plugin folder (NOT data.json, so
  // the API key / settings stay isolated). Survives view reloads and restarts.

  private historyPath(): string {
    return normalizePath(`${this.manifest.dir}/history.json`);
  }

  /** Load persisted conversations from disk (best effort; never throws). */
  async loadHistory(): Promise<void> {
    try {
      const p = this.historyPath();
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(p)) {
        this.conversations = parseHistoryFile(await adapter.read(p));
      }
    } catch {
      this.conversations = [];
    }
  }

  private async persistHistory(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.historyPath(), serializeHistoryFile(this.conversations));
    } catch {
      /* best effort — a failed history write must never break a chat turn */
    }
  }

  /** Insert or update a conversation, then persist. */
  async saveConversation(entry: Conversation): Promise<void> {
    this.conversations = upsertConversation(this.conversations, entry);
    await this.persistHistory();
  }

  /** Delete a conversation by id, then persist. */
  async deleteConversation(id: string): Promise<void> {
    this.conversations = removeConversation(this.conversations, id);
    await this.persistHistory();
  }

  /**
   * Get the active markdown editor view, if any. Falls back to the last
   * Markdown view that had focus before it (e.g. before the user clicked
   * into the Hermes sidebar chat input), as long as that view's leaf is
   * still open in the workspace.
   */
  getActiveMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    const fallback = this.lastMarkdownView;
    if (fallback && this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === fallback)) {
      return fallback;
    }
    return null;
  }

  /**
   * The editor selection to attach to a chat turn: a live read if a
   * Markdown view is genuinely focused right now, otherwise the snapshot
   * captured at the moment focus last left an editor (see
   * `lastSelectionSnapshot`). Prefer this over calling
   * `editor.getSelection()` directly from the chat panel — by the time the
   * user has clicked into the sidebar and pressed Send, the live read is
   * not reliable across all editor/theme combinations.
   */
  getCurrentSelection(): { notePath?: string; text: string } | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      const sel = this.captureViewSelection(active);
      if (sel) return { notePath: active.file?.path, text: sel };
    }
    return this.lastSelectionSnapshot;
  }

  /** Store a selection snapshot and (re)start its 5s expiry countdown. */
  private setSelectionSnapshot(snap: { notePath?: string; text: string }): void {
    this.lastSelectionSnapshot = snap;
    this.scheduleSelectionExpiry();
  }

  private scheduleSelectionExpiry(): void {
    if (this.selectionExpiryTimer !== null) window.clearTimeout(this.selectionExpiryTimer);
    this.selectionExpiryTimer = window.setTimeout(() => {
      this.lastSelectionSnapshot = null;
      this.selectionExpiryTimer = null;
    }, HermesPlugin.SELECTION_EXPIRY_MS);
  }

  /**
   * Extend the selection's expiry window in response to activity that
   * signals the user still means to use it — e.g. typing a message in the
   * chat panel after selecting some text. Without this, composing a
   * message that takes longer than 5s would let the selection expire out
   * from under the user right before they hit Send.
   */
  touchSelectionActivity(): void {
    if (this.lastSelectionSnapshot) this.scheduleSelectionExpiry();
  }

  /**
   * Read the currently highlighted text in a Markdown view, covering BOTH
   * editing modes:
   *  - Reading View: the note is rendered HTML, not a CodeMirror instance —
   *    `editor.getSelection()` only ever reflects the underlying source
   *    buffer's cursor/selection state, which mouse-dragging over rendered
   *    HTML never touches. So a plain-text selection made while reading a
   *    note was previously always silently dropped.
   *  - Source / Live Preview: a genuine CodeMirror selection, read via the
   *    Editor API as before.
   * Native `window.getSelection()` is tried first since it covers Reading
   * View (and also works in Live Preview, which renders real DOM text) —
   * but only if the selection actually lands inside this view's container,
   * so a selection the user made somewhere else (e.g. highlighting text in
   * the Hermes chat log itself) isn't mistaken for "the note".
   */
  private captureViewSelection(view: MarkdownView): string {
    try {
      const domSel = window.getSelection();
      if (domSel && !domSel.isCollapsed && domSel.rangeCount > 0) {
        const range = domSel.getRangeAt(0);
        if (view.containerEl.contains(range.commonAncestorContainer)) {
          const text = domSel.toString();
          if (text.trim()) return text;
        }
      }
    } catch {
      /* window.getSelection() is always available on desktop, but stay defensive */
    }
    try {
      return view.editor.getSelection();
    } catch {
      return "";
    }
  }

  /**
   * Absolute filesystem path of the vault root, used as the agent's working
   * directory. Empty string if the vault is not on a local filesystem (this
   * plugin is desktop-only, so in practice it always resolves).
   */
  getVaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  /**
   * Candidate Hermes home directories (folders that hold `config.yaml`), in
   * priority order: the configured override, then `$HERMES_HOME`, then
   * `~/.hermes`. The gateway runs on this same machine, so these are readable.
   */
  private hermesHomeCandidates(): string[] {
    const node = nodeModules();
    if (!node) return [];
    const { os, path } = node;
    const homes: string[] = [];
    const configured = (this.settings.hermesHome || "").trim();
    if (configured) homes.push(configured);
    const env = (process.env.HERMES_HOME || process.env.HERMES_CONFIG_DIR || "").trim();
    if (env) homes.push(env);
    try {
      homes.push(path.join(os.homedir(), ".hermes"));
    } catch {
      /* ignore */
    }
    // Multi-profile installs keep the served config in profiles/<name>/config.yaml
    // (the root config.yaml is then just a template), so the active profile dir
    // must win over its parent home or the footer shows a stale model.
    const out: string[] = [];
    for (const home of homes) {
      const profileDir = this.activeProfileDir(home);
      if (profileDir) out.push(profileDir);
      out.push(home);
    }
    return out;
  }

  /**
   * Resolve `<home>/profiles/<active>/config.yaml`'s directory when this home
   * uses profiles (an `active_profile` marker file names the selected one).
   * Returns "" when the home has no profiles — callers fall back to the home
   * itself, preserving the pre-profile behavior.
   */
  private activeProfileDir(home: string): string {
    const node = nodeModules();
    if (!node) return "";
    const { fs, path } = node;
    try {
      const marker = path.join(home, "active_profile");
      if (!fs.existsSync(marker)) return "";
      const name = sanitizeProfileName(fs.readFileSync(marker, "utf-8"));
      if (!name) return "";
      const dir = path.join(home, "profiles", name);
      return fs.existsSync(path.join(dir, "config.yaml")) ? dir : "";
    } catch {
      return "";
    }
  }

  /**
   * Read the REAL underlying model id + its context window from the local
   * Hermes config (the gateway API only ever advertises the "hermes-agent"
   * meta-label). Returns null when no config.yaml can be found/parsed.
   */
  readHermesModelConfig(): { model: string; contextWindow?: number } | null {
    const node = nodeModules();
    if (!node) return null;
    const { fs, path } = node;
    for (const home of this.hermesHomeCandidates()) {
      try {
        const cfgPath = path.join(home, "config.yaml");
        if (!fs.existsSync(cfgPath)) continue;
        const cfg = parseConfigModel(fs.readFileSync(cfgPath, "utf-8"));
        if (!cfg.model) continue;
        let contextWindow: number | undefined;
        try {
          const cachePath = path.join(home, "context_length_cache.yaml");
          if (fs.existsSync(cachePath)) {
            contextWindow = parseContextLengthCache(fs.readFileSync(cachePath, "utf-8"), cfg.model);
          }
        } catch {
          /* cache optional */
        }
        return { model: cfg.model, ...(contextWindow ? { contextWindow } : {}) };
      } catch {
        /* try next candidate */
      }
    }
    return null;
  }

  /** Refresh the footer meta bar in every open Hermes view. */
  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES)) {
      const view = leaf.view;
      if (view instanceof HermesView) view.refreshMetaBar();
    }
  }

  /** Re-resolve the active model (after a model/URL/key change) in open views. */
  reloadModelInViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES)) {
      const view = leaf.view;
      if (view instanceof HermesView) void view.loadResolvedModel();
    }
  }

  /** Reveal the Hermes view in the right sidebar and return it. */
  async activateView(): Promise<HermesView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_HERMES);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_HERMES, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
    return (leaf?.view as HermesView) ?? null;
  }

  /**
   * Reveal the smart-graph view in a main-area tab (a graph wants room, unlike
   * the sidebar chat) and return it. Reuses an existing graph leaf if open.
   */
  async activateGraphView(): Promise<HermesGraphView | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_HERMES_GRAPH);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_GRAPH, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
    return (leaf?.view as HermesGraphView) ?? null;
  }

  // ---- smart-graph cache persistence ----
  //
  // The last analysis is cached in `graph-cache.json` in the plugin folder (NOT
  // data.json, keeping it out of the settings/API-key file), so reopening the
  // graph view shows the previous result instead of a blank canvas.

  private graphCachePath(): string {
    return normalizePath(`${this.manifest.dir}/graph-cache.json`);
  }

  /** Load the cached smart graph, or null if none/invalid (never throws). */
  async loadGraphCache(): Promise<SmartGraph | null> {
    try {
      const p = this.graphCachePath();
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(p)) {
        const parsed = JSON.parse(await adapter.read(p)) as SmartGraph;
        if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) return parsed;
      }
    } catch {
      /* ignore a missing/corrupt cache */
    }
    return null;
  }

  /** Persist the latest smart graph (best effort; never breaks the view). */
  async saveGraphCache(graph: SmartGraph): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.graphCachePath(), JSON.stringify(graph));
    } catch {
      /* best effort */
    }
  }

  private async sendNote(mdView: MarkdownView): Promise<void> {
    const view = await this.activateView();
    if (!view) return;
    const notePath = mdView.file?.path;
    const noteContent = this.settings.includeNoteContent ? mdView.editor.getValue() : undefined;
    const display = "Please review the current note.";
    const prompt = buildPrompt(display, { notePath, noteContent });
    view.submitPrompt(prompt, display, { notePath, noteContent });
  }

  private async sendSelection(mdView: MarkdownView, selection: string): Promise<void> {
    if (!selection) {
      new Notice("Hermes: no text selected.");
      return;
    }
    const view = await this.activateView();
    if (!view) return;
    const notePath = mdView.file?.path;
    const display = "Please review the selected text.";
    const prompt = buildPrompt(display, { notePath, selection });
    view.submitPrompt(prompt, display, { notePath, selection });
  }
}
