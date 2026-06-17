import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, HermesSettings } from "./settings/types";
import { HermesSettingTab } from "./settings/HermesSettingTab";
import { HermesView, VIEW_TYPE_HERMES } from "./view/HermesView";
import { HermesGatewayClient } from "./runtime/gatewayClient";
import { buildPrompt } from "./runtime/context";

export default class HermesPlugin extends Plugin {
  settings!: HermesSettings;
  client!: HermesGatewayClient;

  async onload(): Promise<void> {
    await this.loadSettings();
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
