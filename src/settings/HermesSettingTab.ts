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
    containerEl.createEl("h2", { text: "Hermes Agent" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Connects to the local Hermes gateway started by Hermes Desktop. Launch Hermes Desktop first; it runs the gateway on 127.0.0.1:8642 by default."
    });

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
      .setDesc('Model id, e.g. "gpt-5.5". Leave empty to use the gateway default. Use "Test connection" to list models.')
      .addText((text) =>
        text
          .setPlaceholder("(gateway default)")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
            this.plugin.reloadModelInViews();
          })
      );

    containerEl.createEl("h3", { text: "Agent workspace" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Gives Hermes your vault as its working directory so it can read, write, search, and run multi-step workflows over your notes."
    });

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
