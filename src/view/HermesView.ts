// HermesView — the sidebar chat panel with a multi-tab manager (decision D2).
//
// Pure Obsidian DOM API (no React), mirroring Claudian's approach. Each tab
// owns its own conversation state, messages container, and in-flight handle.

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Menu, setIcon, Notice } from "obsidian";
import type HermesPlugin from "../main";
import { ChatHandle, ChatMessage, HermesGatewayClient, ToolEvent, UsageInfo } from "../runtime/gatewayClient";
import { resolveWorkingFolder } from "../runtime/context";
import { contextPercent, contextWindowFor, greetingOptions, humanizeModel } from "../runtime/protocol";

export const VIEW_TYPE_HERMES = "hermes-chat";

/** Minimal shape of Electron's remote dialog, obtained via require("electron"). */
interface ElectronRemote {
  dialog: {
    showOpenDialog(opts: {
      properties: string[];
      title?: string;
      defaultPath?: string;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
}

interface Tab {
  id: string;
  title: string;
  messages: ChatMessage[];
  sessionId?: string;
  handle: ChatHandle | null;
  bodyEl: HTMLElement; // scroll container holding this tab's messages
  tabButtonEl: HTMLElement;
  tokensUsed: number; // cumulative session tokens for this tab
  lastPromptTokens: number; // latest turn's prompt tokens = current context occupancy
  greeting?: string; // chosen empty-state greeting (kept stable per tab)
}

export class HermesView extends ItemView {
  private plugin: HermesPlugin;
  private client: HermesGatewayClient;

  private tabBarEl!: HTMLElement;
  private bodyHostEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private includeNoteToggle!: HTMLInputElement;
  private includeSelectionToggle!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private metaModelEl!: HTMLElement;
  private metaThinkingEl!: HTMLElement;
  private metaTokensEl!: HTMLElement;
  private gaugeEl!: HTMLElement;
  private gaugePctEl!: HTMLElement;
  private folderChipEl!: HTMLElement;
  private folderLabelEl!: HTMLElement;

  /** Active model id + context window, resolved from the gateway (/v1/models). */
  private resolvedModel: { id: string; contextWindow: number } | null = null;

  private tabs: Tab[] = [];
  private activeTabId = "";
  private tabSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: HermesPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.client = plugin.client;
  }

  getViewType(): string {
    return VIEW_TYPE_HERMES;
  }
  getDisplayText(): string {
    return "Hermes Agent";
  }
  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("hermes-view");

    // Header
    const header = root.createDiv({ cls: "hermes-header" });
    header.createSpan({ cls: "hermes-title", text: "Hermes Agent" });
    const headerActions = header.createDiv({ cls: "hermes-header-actions" });
    const newTabBtn = headerActions.createEl("button", { cls: "hermes-icon-btn", attr: { "aria-label": "New tab" } });
    setIcon(newTabBtn, "plus");
    newTabBtn.onclick = () => this.newTab();
    this.stopBtn = headerActions.createEl("button", { cls: "hermes-icon-btn", attr: { "aria-label": "Stop" } });
    setIcon(this.stopBtn, "square");
    this.stopBtn.onclick = () => this.stopActive();
    this.stopBtn.disabled = true;

    // Tab bar
    this.tabBarEl = root.createDiv({ cls: "hermes-tabbar" });

    // Body host (per-tab bodies live here)
    this.bodyHostEl = root.createDiv({ cls: "hermes-body-host" });

    // Context toggles
    const ctxRow = root.createDiv({ cls: "hermes-context-row" });
    const noteLabel = ctxRow.createEl("label", { cls: "hermes-context-toggle" });
    this.includeNoteToggle = noteLabel.createEl("input", { type: "checkbox" });
    noteLabel.createSpan({ text: " current note" });
    const selLabel = ctxRow.createEl("label", { cls: "hermes-context-toggle" });
    this.includeSelectionToggle = selLabel.createEl("input", { type: "checkbox" });
    selLabel.createSpan({ text: " selection" });

    // Input
    const inputWrap = root.createDiv({ cls: "hermes-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "hermes-input",
      attr: { rows: "3", placeholder: "Message Hermes..." }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.onSend();
      }
    });
    const inputActions = inputWrap.createDiv({ cls: "hermes-input-actions" });

    // Meta bar (model | thinking | tokens | working folder), like Claudian's footer.
    const metaEl = inputActions.createDiv({ cls: "hermes-input-meta" });

    this.metaModelEl = metaEl.createDiv({
      cls: "hermes-meta-item hermes-meta-model",
      attr: { "aria-label": "Model — click for settings" }
    });
    this.metaModelEl.onclick = () => this.openPluginSettings();

    this.metaThinkingEl = metaEl.createDiv({
      cls: "hermes-meta-item hermes-meta-thinking",
      attr: { "aria-label": "Reasoning effort — click to change" }
    });
    this.metaThinkingEl.onclick = (e) => this.showThinkingMenu(e);

    // Context gauge: a donut showing the % of the model's context window used
    // by the latest turn's prompt tokens (like Claudian's gauge).
    this.metaTokensEl = metaEl.createDiv({
      cls: "hermes-meta-item hermes-meta-tokens",
      attr: { "aria-label": "Context window used in this tab" }
    });
    this.gaugeEl = this.metaTokensEl.createSpan({ cls: "hermes-gauge" });
    this.gaugePctEl = this.metaTokensEl.createSpan({ cls: "hermes-gauge-pct" });

    // Working-folder chip: click opens a native folder picker (like Claudian).
    this.folderChipEl = metaEl.createDiv({ cls: "hermes-folder-chip" });
    const folderIcon = this.folderChipEl.createSpan({ cls: "hermes-folder-icon" });
    setIcon(folderIcon, "folder");
    this.folderLabelEl = this.folderChipEl.createSpan({ cls: "hermes-folder-label" });
    this.folderChipEl.onclick = () => void this.pickWorkingFolder();

    const rightEl = inputActions.createDiv({ cls: "hermes-input-actions-right" });
    this.statusEl = rightEl.createSpan({ cls: "hermes-status" });
    this.sendBtn = rightEl.createEl("button", { cls: "hermes-send-btn", text: "Send" });
    this.sendBtn.onclick = () => void this.onSend();

    // First tab
    this.newTab();
    this.refreshMetaBar();
    // Resolve the real model name / context window from the gateway (async).
    void this.loadResolvedModel();
  }

  /** Query the gateway for the active model + context window, then refresh. */
  async loadResolvedModel(): Promise<void> {
    try {
      this.resolvedModel = await this.client.resolveActiveModel();
    } catch {
      this.resolvedModel = null;
    }
    this.refreshMetaBar();
  }

  async onClose(): Promise<void> {
    for (const t of this.tabs) t.handle?.abort();
  }

  // ---- tab management ----

  newTab(): void {
    if (this.tabs.length >= Math.max(1, this.plugin.settings.maxTabs)) {
      new Notice(`Hermes: tab limit reached (${this.plugin.settings.maxTabs}). Adjust it in settings.`);
      return;
    }
    this.tabSeq += 1;
    const id = `tab-${Date.now()}-${this.tabSeq}`;
    const bodyEl = this.bodyHostEl.createDiv({ cls: "hermes-body" });
    const tabButtonEl = this.tabBarEl.createDiv({ cls: "hermes-tab" });
    const tab: Tab = {
      id,
      title: `Chat ${this.tabSeq}`,
      messages: [],
      handle: null,
      bodyEl,
      tabButtonEl,
      tokensUsed: 0,
      lastPromptTokens: 0
    };
    this.renderGreeting(tab);

    const label = tabButtonEl.createSpan({ cls: "hermes-tab-label", text: tab.title });
    label.onclick = () => this.activateTab(id);
    const closeBtn = tabButtonEl.createSpan({ cls: "hermes-tab-close" });
    setIcon(closeBtn, "x");
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      this.closeTab(id);
    };

    this.tabs.push(tab);
    this.activateTab(id);
  }

  private activateTab(id: string): void {
    this.activeTabId = id;
    for (const t of this.tabs) {
      const active = t.id === id;
      t.bodyEl.toggleClass("is-active", active);
      t.tabButtonEl.toggleClass("is-active", active);
    }
    this.refreshRunningState();
    this.refreshMetaBar();
  }

  private closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    tab.handle?.abort();
    tab.bodyEl.remove();
    tab.tabButtonEl.remove();
    this.tabs.splice(idx, 1);
    if (this.tabs.length === 0) {
      this.newTab();
      return;
    }
    if (this.activeTabId === id) {
      this.activateTab(this.tabs[Math.max(0, idx - 1)].id);
    }
  }

  private activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  private refreshRunningState(): void {
    const running = !!this.activeTab()?.handle;
    this.stopBtn.disabled = !running;
    this.sendBtn.disabled = running;
    this.statusEl.setText(running ? "Hermes is thinking..." : "");
  }

  /**
   * Refresh the footer meta bar (model, reasoning effort, session tokens, and
   * the working-folder chip). Public so the settings tab can refresh it live.
   */
  refreshMetaBar(): void {
    if (!this.folderChipEl) return;
    const s = this.plugin.settings;

    // Model — the real underlying id (e.g. "gpt-5.5"), resolved from the
    // gateway; falls back to the configured value, then the meta-label.
    const modelId = s.model || this.resolvedModel?.id || "";
    this.metaModelEl.setText(humanizeModel(modelId) || "hermes-agent");

    // Reasoning effort
    this.metaThinkingEl.empty();
    this.metaThinkingEl.createSpan({ cls: "hermes-meta-key", text: "Thinking: " });
    this.metaThinkingEl.createSpan({ cls: "hermes-meta-val", text: s.reasoningEffort || "default" });

    // Context gauge — latest turn's prompt tokens as a % of the context window.
    const used = this.activeTab()?.lastPromptTokens || 0;
    const ctxWindow = this.resolvedModel?.contextWindow || contextWindowFor(modelId);
    const pct = contextPercent(used, ctxWindow);
    this.gaugeEl.style.setProperty("--hermes-gauge-pct", String(pct));
    this.gaugePctEl.setText(`${pct}%`);
    this.metaTokensEl.toggleClass("hermes-hidden", used <= 0);
    this.metaTokensEl.setAttr(
      "aria-label",
      `Context: ${used.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${pct}%)`
    );

    // Working folder
    const base = this.plugin.getVaultBasePath();
    const folder = resolveWorkingFolder(base, s.workingFolder || "");
    const autoApprove = s.autoApproveTools !== false;
    const name = folder ? folder.split(/[\\/]/).filter(Boolean).pop() || folder : "(no folder)";
    this.folderLabelEl.setText(name);
    this.folderChipEl.toggleClass("is-readonly", !autoApprove);
    this.folderChipEl.setAttr(
      "aria-label",
      `Working folder: ${folder || "(unavailable)"}\n` +
        `Tools: ${autoApprove ? "auto-approve ON (read/write)" : "OFF (read-only replies)"}\n` +
        `Click to choose a folder`
    );
  }

  /** Render the empty-state greeting in a tab body (kept stable per tab). */
  private renderGreeting(tab: Tab): void {
    if (tab.messages.length > 0) return;
    if (!tab.greeting) {
      const opts = greetingOptions(this.plugin.settings.userName || "");
      tab.greeting = opts[Math.floor(Math.random() * opts.length)];
    }
    const wrap = tab.bodyEl.createDiv({ cls: "hermes-greeting" });
    wrap.createDiv({ cls: "hermes-greeting-text", text: tab.greeting });
  }

  /** Remove the empty-state greeting once a conversation starts. */
  private clearGreeting(tab: Tab): void {
    tab.bodyEl.querySelector(".hermes-greeting")?.remove();
  }

  /** Context menu to pick the reasoning effort, updating settings live. */
  private showThinkingMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const current = this.plugin.settings.reasoningEffort || "";
    const options: Array<{ value: string; label: string }> = [
      { value: "", label: "default" },
      { value: "minimal", label: "minimal" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" }
    ];
    for (const opt of options) {
      menu.addItem((item) =>
        item
          .setTitle(opt.label)
          .setChecked(current === opt.value)
          .onClick(async () => {
            this.plugin.settings.reasoningEffort = opt.value;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /**
   * Open a native folder-selection dialog (Electron remote) and store the chosen
   * folder as the agent's working directory. Mirrors Claudian's picker. Falls
   * back to opening settings if the dialog API is unavailable.
   */
  private async pickWorkingFolder(): Promise<void> {
    let remote: ElectronRemote | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      remote = (require("electron") as { remote?: ElectronRemote }).remote;
    } catch {
      remote = undefined;
    }
    if (!remote?.dialog?.showOpenDialog) {
      new Notice("Native folder picker unavailable. Set the working folder in settings.");
      this.openPluginSettings();
      return;
    }
    const base = this.plugin.getVaultBasePath();
    try {
      const result = await remote.dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Select Hermes working folder",
        ...(base ? { defaultPath: base } : {})
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
      const picked = result.filePaths[0];
      this.plugin.settings.workingFolder = this.toStoredFolder(picked, base);
      await this.plugin.saveSettings();
      this.plugin.refreshOpenViews();
      new Notice(`Hermes working folder: ${picked}`);
    } catch (e) {
      new Notice(`Could not open folder picker: ${(e as Error)?.message || e}`);
    }
  }

  /**
   * Store the picked folder as vault-relative when it is inside the vault (more
   * portable), the empty string when it is the vault root, or the absolute path
   * when it is outside the vault.
   */
  private toStoredFolder(picked: string, base: string): string {
    const norm = (p: string) => p.replace(/[\\/]+$/, "");
    const p = norm(picked);
    const b = norm(base);
    if (!b) return p;
    if (p.toLowerCase() === b.toLowerCase()) return "";
    const sep = b.includes("\\") ? "\\" : "/";
    const prefix = (b + sep).toLowerCase();
    if (p.toLowerCase().startsWith(prefix)) return p.slice((b + sep).length);
    return p;
  }

  /** Open Obsidian settings on the Hermes Agent tab (best effort). */
  private openPluginSettings(): void {
    const settingApi = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    if (settingApi?.open) {
      settingApi.open();
      settingApi.openTabById?.("hermes-agent");
    } else {
      new Notice("Open Settings -> Hermes Agent to set the working folder.");
    }
  }

  // ---- sending ----

  /** Public entry used by commands: push a prepared prompt into the active tab. */
  submitPrompt(prompt: string): void {
    void this.runTurn(prompt);
  }

  private async onSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    // Gather context from the currently active markdown editor.
    let notePath: string | undefined;
    let selection: string | undefined;
    let noteContent: string | undefined;

    const mdView = this.plugin.getActiveMarkdownView();
    if (mdView) {
      notePath = mdView.file?.path;
      if (this.includeSelectionToggle.checked) {
        const sel = mdView.editor.getSelection();
        if (sel) selection = sel;
      }
      if (this.includeNoteToggle.checked) {
        noteContent = this.plugin.settings.includeNoteContent ? mdView.editor.getValue() : undefined;
        if (!notePath) notePath = mdView.file?.path;
      }
    }

    const { buildPrompt } = await import("../runtime/context");
    const prompt = buildPrompt(text, {
      notePath: this.includeNoteToggle.checked || this.includeSelectionToggle.checked ? notePath : undefined,
      selection,
      noteContent
    });
    this.inputEl.value = "";
    await this.runTurn(prompt, text);
  }

  /**
   * Run one conversation turn in the active tab.
   * @param prompt   the full prompt (with context) sent to Hermes
   * @param display  optional shorter text to show as the user bubble
   */
  private async runTurn(prompt: string, display?: string): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    if (tab.handle) {
      new Notice("Hermes: a response is already streaming in this tab.");
      return;
    }

    this.clearGreeting(tab);
    this.renderUserMessage(tab, display ?? prompt);
    const assistant = this.createAssistantMessage(tab);

    const history = tab.messages.slice();
    tab.messages.push({ role: "user", content: prompt });

    let buffer = "";
    let reasoning = "";

    const flush = () => {
      assistant.contentEl.empty();
      void MarkdownRenderer.render(this.app, buffer || "", assistant.contentEl, "", this);
      this.scrollToBottom(tab);
    };

    tab.handle = this.client.sendMessage(
      prompt,
      history,
      {
        onChunk: (t) => {
          buffer += t;
          flush();
        },
        onReasoning: (t) => {
          reasoning += t;
          assistant.reasoningEl.style.display = "block";
          assistant.reasoningBodyEl.setText(reasoning);
          this.scrollToBottom(tab);
        },
        onToolEvent: (e: ToolEvent) => {
          this.renderToolEvent(assistant, e);
          this.scrollToBottom(tab);
        },
        onUsage: (u: UsageInfo) => {
          assistant.usageEl.setText(
            `tokens: ${u.totalTokens} (in ${u.promptTokens} / out ${u.completionTokens})`
          );
          tab.tokensUsed += u.totalTokens;
          // Context occupancy = the latest turn's prompt tokens (mirrors the
          // desktop's gauge); the prompt already includes prior history.
          if (u.promptTokens > 0) tab.lastPromptTokens = u.promptTokens;
          if (tab.id === this.activeTabId) this.refreshMetaBar();
        },
        onError: (msg) => {
          assistant.contentEl.empty();
          assistant.contentEl.createDiv({ cls: "hermes-error", text: msg });
          tab.handle = null;
          tab.messages.push({ role: "assistant", content: `[error] ${msg}` });
          this.refreshRunningState();
          this.scrollToBottom(tab);
        },
        onDone: (sessionId) => {
          if (sessionId) tab.sessionId = sessionId;
          tab.messages.push({ role: "assistant", content: buffer });
          tab.handle = null;
          this.refreshRunningState();
        }
      },
      tab.sessionId
    );

    this.refreshRunningState();
  }

  private stopActive(): void {
    const tab = this.activeTab();
    if (tab?.handle) {
      tab.handle.abort();
      tab.handle = null;
      this.refreshRunningState();
    }
  }

  // ---- rendering helpers ----

  private renderUserMessage(tab: Tab, text: string): void {
    const msg = tab.bodyEl.createDiv({ cls: "hermes-msg hermes-msg-user" });
    msg.createDiv({ cls: "hermes-msg-role", text: "You" });
    msg.createDiv({ cls: "hermes-msg-content", text });
    this.scrollToBottom(tab);
  }

  private createAssistantMessage(tab: Tab): {
    contentEl: HTMLElement;
    reasoningEl: HTMLElement;
    reasoningBodyEl: HTMLElement;
    toolsEl: HTMLElement;
    usageEl: HTMLElement;
  } {
    const msg = tab.bodyEl.createDiv({ cls: "hermes-msg hermes-msg-assistant" });
    msg.createDiv({ cls: "hermes-msg-role", text: "Hermes" });

    const reasoningEl = msg.createDiv({ cls: "hermes-reasoning" });
    reasoningEl.style.display = "none";
    reasoningEl.createDiv({ cls: "hermes-reasoning-title", text: "thinking" });
    const reasoningBodyEl = reasoningEl.createDiv({ cls: "hermes-reasoning-body" });

    const toolsEl = msg.createDiv({ cls: "hermes-tools" });
    const contentEl = msg.createDiv({ cls: "hermes-msg-content" });
    const usageEl = msg.createDiv({ cls: "hermes-usage" });

    return { contentEl, reasoningEl, reasoningBodyEl, toolsEl, usageEl };
  }

  private renderToolEvent(
    assistant: { toolsEl: HTMLElement },
    e: ToolEvent
  ): void {
    const line = assistant.toolsEl.createDiv({ cls: `hermes-tool hermes-tool-${e.status}` });
    const icon = e.status === "completed" ? "check" : e.status === "failed" ? "x" : "loader";
    const iconEl = line.createSpan({ cls: "hermes-tool-icon" });
    setIcon(iconEl, icon);
    line.createSpan({ cls: "hermes-tool-name", text: ` ${e.name}` });
    if (e.preview) line.createSpan({ cls: "hermes-tool-preview", text: ` ${e.preview}` });
  }

  private scrollToBottom(tab: Tab): void {
    tab.bodyEl.scrollTop = tab.bodyEl.scrollHeight;
  }
}
