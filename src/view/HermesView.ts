// HermesView — the sidebar chat panel with a multi-tab manager (decision D2).
//
// Pure Obsidian DOM API (no React), mirroring Claudian's approach. Each tab
// owns its own conversation state, messages container, and in-flight handle.

import { ItemView, WorkspaceLeaf, MarkdownRenderer, setIcon, Notice } from "obsidian";
import type HermesPlugin from "../main";
import { ChatHandle, ChatMessage, HermesGatewayClient, ToolEvent, UsageInfo } from "../runtime/gatewayClient";

export const VIEW_TYPE_HERMES = "hermes-chat";

interface Tab {
  id: string;
  title: string;
  messages: ChatMessage[];
  sessionId?: string;
  handle: ChatHandle | null;
  bodyEl: HTMLElement; // scroll container holding this tab's messages
  tabButtonEl: HTMLElement;
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
    this.statusEl = inputActions.createSpan({ cls: "hermes-status" });
    this.sendBtn = inputActions.createEl("button", { cls: "hermes-send-btn", text: "Send" });
    this.sendBtn.onclick = () => void this.onSend();

    // First tab
    this.newTab();
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
      tabButtonEl
    };

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
