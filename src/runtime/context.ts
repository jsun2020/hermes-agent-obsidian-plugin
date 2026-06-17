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
