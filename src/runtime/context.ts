// Build the prompt sent to Hermes from the user's text plus optional note
// context. Mirrors Claudian's idea of serializing context as simple XML-ish
// tags appended to the prompt, kept deliberately small and readable.

export interface NoteContext {
  notePath?: string;
  selection?: string;
  noteContent?: string;
}

export function buildPrompt(userText: string, ctx: NoteContext): string {
  const parts: string[] = [userText.trim()];

  if (ctx.selection && ctx.selection.trim()) {
    parts.push(
      [
        "<editor_selection>",
        `<file_path>${ctx.notePath ?? ""}</file_path>`,
        "<selection>",
        ctx.selection,
        "</selection>",
        "</editor_selection>"
      ].join("\n")
    );
  }

  if (ctx.noteContent && ctx.noteContent.trim()) {
    parts.push(
      [
        "<current_note>",
        `<file_path>${ctx.notePath ?? ""}</file_path>`,
        "<content>",
        ctx.noteContent,
        "</content>",
        "</current_note>"
      ].join("\n")
    );
  } else if (ctx.notePath) {
    parts.push(`<current_note>${ctx.notePath}</current_note>`);
  }

  return parts.filter(Boolean).join("\n\n");
}

// ---- agent working folder -------------------------------------------------
//
// Hermes does not take a `cwd` field on /v1/runs. Like Hermes Desktop, we tell
// the agent its workspace through the `instructions` system message. The folder
// is the Obsidian vault root by default, or a configured sub-folder/absolute
// path, so the vault becomes the agent's working directory.

/**
 * True when `p` is an absolute path. A Windows drive (`C:\`) or UNC (`\\srv`)
 * is always absolute; a bare leading slash is absolute only on POSIX (inferred
 * from the vault base style) so that a Windows user typing "/Projects" or
 * "\Projects" gets a vault sub-folder, not a drive-root path.
 */
function isAbsolutePath(p: string, base: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows drive
  if (/^\\\\/.test(p)) return true; // UNC
  if (/^\//.test(p)) return !base.includes("\\"); // POSIX absolute
  return false;
}

/**
 * Resolve the agent's working folder.
 * @param vaultBase  absolute path of the Obsidian vault root
 * @param configured the user's "working folder" setting (vault-relative, or
 *                   absolute, or empty for the vault root)
 */
export function resolveWorkingFolder(vaultBase: string, configured: string): string {
  const base = (vaultBase || "").replace(/[\\/]+$/, "");
  const sub = (configured || "").trim();
  if (!sub) return base;
  if (isAbsolutePath(sub, base)) return sub.replace(/[\\/]+$/, "");
  if (!base) return sub;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}${sub.replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep)}`;
}

/**
 * Build the `instructions` system message that scopes the agent to a folder.
 * Mirrors Hermes Desktop's contextFolderSystemMessage(), with an added nudge to
 * prefer file tools because shell/PowerShell execution is unavailable on some
 * Windows gateway builds. Returns "" when no folder is known.
 */
export function contextFolderInstructions(folder: string): string {
  const f = (folder || "").trim();
  if (!f) return "";
  return (
    `The working folder for this conversation is ${f}. ` +
    `This folder is an Obsidian vault. When the user asks you to read, create, ` +
    `modify, search, or summarise notes or files, use the file read/write/search ` +
    `tools with absolute paths under this folder. Prefer the file tools over shell ` +
    `commands; shell/PowerShell execution may be unavailable on this system.`
  );
}
