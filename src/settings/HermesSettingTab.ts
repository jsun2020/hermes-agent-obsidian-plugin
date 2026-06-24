import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type HermesPlugin from "../main";

export class HermesSettingTab extends PluginSettingTab {
  private plugin: HermesPlugin;

  constructor(app: App, plugin: HermesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Connection")
      .setDesc(
        "Connects to the local Hermes gateway on 127.0.0.1:8642 by default. Start the gateway first: launch Hermes Desktop (it auto-starts the gateway), or on a CLI/TUI install run `hermes gateway`. The plugin works with either — it only needs the gateway's HTTP API reachable."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Your name")
      .setDesc("Optional. Personalizes the greeting shown in an empty chat (e.g. \"What's new, Jason?\").")
      .addText((text) =>
        text
          .setPlaceholder("(none)")
          .setValue(this.plugin.settings.userName)
          .onChange(async (v) => {
            this.plugin.settings.userName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gateway base URL")
      .setDesc("Default profile uses http://127.0.0.1:8642. A trailing /v1 is stripped automatically.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8642")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.baseUrl = v;
            await this.plugin.saveSettings();
            this.plugin.reloadModelInViews();
          })
      );

    new Setting(containerEl)
      .setName("API key (API_SERVER_KEY)")
      .setDesc("Paste the API_SERVER_KEY from ~/.hermes/.env. Required for session continuity and auth.")
      .addText((text) => {
        text
          .setPlaceholder("paste API_SERVER_KEY")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
            this.plugin.reloadModelInViews();
          });
        text.inputEl.type = "password";
        return text;
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc('Model id, e.g. "gpt-5.5". Leave empty to show the real model from your Hermes config. Use "Test connection" to list models.')
      .addText((text) =>
        text
          .setPlaceholder("(from Hermes config)")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
            this.plugin.reloadModelInViews();
          })
      );

    new Setting(containerEl)
      .setName("Hermes home (for model name)")
      .setDesc(
        "Folder containing config.yaml, used to show the real model (e.g. gpt-5.5) and its context window — the gateway API only reports \"hermes-agent\". Leave empty to auto-detect ($HERMES_HOME, then ~/.hermes). Portable build: point this at the hermes-data/hermes folder next to the exe."
      )
      .addText((text) =>
        text
          .setPlaceholder("(auto-detect)")
          .setValue(this.plugin.settings.hermesHome)
          .onChange(async (v) => {
            this.plugin.settings.hermesHome = v.trim();
            await this.plugin.saveSettings();
            this.plugin.reloadModelInViews();
          })
      );

    new Setting(containerEl)
      .setName("Agent workspace")
      .setDesc(
        "Gives Hermes your vault as its working directory so it can read, write, search, and run multi-step workflows over your notes."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Working folder")
      .setDesc(
        "Folder the agent operates in, relative to the vault root. Leave empty to use the whole vault. An absolute path is also accepted. Tip: click the folder chip in the chat footer to pick a folder visually."
      )
      .addText((text) =>
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.workingFolder)
          .onChange(async (v) => {
            this.plugin.settings.workingFolder = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Auto-approve tool requests")
      .setDesc(
        "Let the agent use file read/write, search, and terminal tools without prompting. This grants it real read/write access to the working folder. Turn off to get plain (tool-less) replies instead."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoApproveTools).onChange(async (v) => {
          this.plugin.settings.autoApproveTools = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Transport")
      .setDesc("auto = detect via /v1/capabilities (prefer the richer Runs transport), else force one.")
      .addDropdown((dd) =>
        dd
          .addOption("auto", "Auto (recommended)")
          .addOption("runs", "Runs")
          .addOption("chat", "Chat Completions")
          .setValue(this.plugin.settings.transport)
          .onChange(async (v) => {
            this.plugin.settings.transport = v as "auto" | "runs" | "chat";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Reasoning effort")
      .setDesc("Optional hint sent to the gateway. Empty leaves the server default.")
      .addDropdown((dd) =>
        dd
          .addOption("", "(server default)")
          .addOption("minimal", "minimal")
          .addOption("low", "low")
          .addOption("medium", "medium")
          .addOption("high", "high")
          .addOption("xhigh", "xhigh")
          .setValue(this.plugin.settings.reasoningEffort)
          .onChange(async (v) => {
            this.plugin.settings.reasoningEffort = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include full note content")
      .setDesc('When "current note" is toggled on a message, send the note body (not just its path).')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.includeNoteContent).onChange(async (v) => {
          this.plugin.settings.includeNoteContent = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Request timeout (ms)")
      .setDesc("Per-request stream timeout. Default 120000 (120s).")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.requestTimeoutMs))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.requestTimeoutMs = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max tabs")
      .setDesc("Maximum number of concurrent chat tabs.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxTabs))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n >= 1 && n <= 10) {
              this.plugin.settings.maxTabs = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Smart graph")
      .setDesc(
        "An agent-built relationship graph: Hermes reads your notes and surfaces semantic links (shared topics, elaborations, prerequisites) beyond explicit [[wikilinks]]. Open it from the ribbon or the \"Open smart graph\" command, then click \"Analyze vault\"."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Max notes to analyze")
      .setDesc("Upper bound on how many notes are sent to Hermes per analysis. Larger vaults are sampled to this many. Default 150.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.graphMaxNotes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n >= 5 && n <= 1000) {
              this.plugin.settings.graphMaxNotes = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Minimum edge strength")
      .setDesc("Inferred (semantic) connections weaker than this are hidden. 0 = show all, 1 = only the strongest. Default 0.3.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.graphMinEdgeWeight))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!Number.isNaN(n) && n >= 0 && n <= 1) {
              this.plugin.settings.graphMinEdgeWeight = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show wikilink edges")
      .setDesc("Also draw explicit [[wikilink]] connections (in a muted color) alongside the inferred semantic ones.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.graphIncludeWikilinks).onChange(async (v) => {
          this.plugin.settings.graphIncludeWikilinks = v;
          await this.plugin.saveSettings();
        })
      );

    const testSetting = new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Probe the gateway and report transport + available models.");
    const resultEl = containerEl.createDiv({ cls: "setting-item-description hermes-test-result" });
    testSetting.addButton((btn) =>
      btn
        .setButtonText("Test connection")
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          resultEl.setText("Testing...");
          const result = await this.plugin.client.testConnection();
          resultEl.setText(result.detail);
          resultEl.toggleClass("hermes-test-ok", result.ok);
          resultEl.toggleClass("hermes-test-fail", !result.ok);
          if (result.ok && result.models && result.models.length > 0) {
            new Notice(`Hermes models: ${result.models.slice(0, 8).join(", ")}`);
          }
          btn.setDisabled(false);
        })
    );
  }
}
