import { App, Modal, Setting } from "obsidian";
import type { ApprovalChoice, ApprovalRequest } from "../runtime/gatewayClient";

const LABELS: Record<ApprovalChoice, string> = {
  once: "Allow once",
  session: "Allow for this chat",
  always: "Always allow",
  deny: "Deny"
};

/**
 * Asks the user whether Hermes may run a tool call. Used when "Auto-approve
 * tool use" is off. Closing the dialog without a choice counts as "deny".
 */
export class ApprovalModal extends Modal {
  private resolve: ((choice: ApprovalChoice) => void) | null = null;
  private choice: ApprovalChoice = "deny";

  constructor(app: App, private request: ApprovalRequest) {
    super(app);
  }

  /** Open the dialog and resolve with the user's answer. */
  wait(): Promise<ApprovalChoice> {
    return new Promise<ApprovalChoice>((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("hermes-approval-modal");
    this.setTitle("Hermes asks for permission");
    if (this.request.description) {
      contentEl.createEl("p", { text: this.request.description });
    }
    if (this.request.command) {
      contentEl.createEl("pre", { cls: "hermes-approval-command" }).createEl("code", { text: this.request.command });
    }
    const buttons = new Setting(contentEl);
    for (const choice of this.request.choices) {
      buttons.addButton((b) => {
        b.setButtonText(LABELS[choice]).onClick(() => {
          this.choice = choice;
          this.close();
        });
        if (choice === "once") b.setCta();
        if (choice === "deny") b.setWarning();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.choice);
    this.resolve = null;
  }
}
