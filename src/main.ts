import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, WorkspaceLeaf, normalizePath } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_SETTINGS, HermesSettings } from "./settings/types";
import { HermesSettingTab } from "./settings/HermesSettingTab";
import { HermesView, VIEW_TYPE_HERMES } from "./view/HermesView";
import { HermesGatewayClient } from "./runtime/gatewayClient";
import { buildPrompt } from "./runtime/context";
import { parseConfigModel, parseContextLengthCache } from "./runtime/protocol";
import {
  Conversation,
  parseHistoryFile,
  removeConversation,
  serializeHistoryFile,
  upsertConversation
} from "./runtime/history";

export default class HermesPlugin extends Plugin {
  settings!: HermesSettings;
  client!: HermesGatewayClient;

  /** Locally persisted chat history (newest first), loaded from history.json. */
  conversations: Conversation[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadHistory();
    this.client = new HermesGatewayClient(
      () => this.settings,
      () => this.getVaultBasePath()
    );

    this.registerView(VIEW_TYPE_HERMES, (leaf) => new HermesView(leaf, this));

    this.addRibbonIcon("bot", "Open Hermes Agent", () => {
      void this.activateView();
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
      editorCheckCallback: (checking, editor: Editor, ctx) => {
        const sel = editor.getSelection();
        if (!sel) return false;
        if (!checking) void this.sendSelection(editor, ctx as MarkdownView);
        return true;
      }
    });

    this.addSettingTab(new HermesSettingTab(this.app, this));
  }

  onunload(): void {
    // Obsidian detaches leaves automatically; HermesView.onClose aborts streams.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  /** Get the active markdown editor view, if any. */
  getActiveMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
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
    const out: string[] = [];
    const configured = (this.settings.hermesHome || "").trim();
    if (configured) out.push(configured);
    const env = (process.env.HERMES_HOME || process.env.HERMES_CONFIG_DIR || "").trim();
    if (env) out.push(env);
    try {
      out.push(path.join(os.homedir(), ".hermes"));
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Read the REAL underlying model id + its context window from the local
   * Hermes config (the gateway API only ever advertises the "hermes-agent"
   * meta-label). Returns null when no config.yaml can be found/parsed.
   */
  readHermesModelConfig(): { model: string; contextWindow?: number } | null {
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
    if (leaf) workspace.revealLeaf(leaf);
    return (leaf?.view as HermesView) ?? null;
  }

  private async sendNote(mdView: MarkdownView): Promise<void> {
    const view = await this.activateView();
    if (!view) return;
    const notePath = mdView.file?.path;
    const noteContent = this.settings.includeNoteContent ? mdView.editor.getValue() : undefined;
    const prompt = buildPrompt("Please review the current note.", { notePath, noteContent });
    view.submitPrompt(prompt);
  }

  private async sendSelection(editor: Editor, mdView: MarkdownView | null): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("Hermes: no text selected.");
      return;
    }
    const view = await this.activateView();
    if (!view) return;
    const notePath = mdView?.file?.path;
    const prompt = buildPrompt("Please review the selected text.", { notePath, selection });
    view.submitPrompt(prompt);
  }
}
