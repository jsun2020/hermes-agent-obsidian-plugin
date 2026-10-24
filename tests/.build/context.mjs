// src/runtime/context.ts
function buildPrompt(userText, ctx) {
  const parts = [userText.trim()];
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
function isAbsolutePath(p, base) {
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (/^\\\\/.test(p)) return true;
  if (/^\//.test(p)) return !base.includes("\\");
  return false;
}
function resolveWorkingFolder(vaultBase, configured) {
  const base = (vaultBase || "").replace(/[\\/]+$/, "");
  const sub = (configured || "").trim();
  if (!sub) return base;
  if (isAbsolutePath(sub, base)) return sub.replace(/[\\/]+$/, "");
  if (!base) return sub;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}${sub.replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep)}`;
}
function contextFolderInstructions(folder) {
  const f = (folder || "").trim();
  if (!f) return "";
  return `The working folder for this conversation is ${f}. This folder is an Obsidian vault and is your current working directory: when the user refers to "the current directory", "this folder", or "my notes", they mean ${f} \u2014 not your process's own directory. When asked to read, create, modify, search, or summarise notes, prefer the file read/write/search tools with absolute paths under this folder over shell commands. If a file or directory operation is blocked by a restricted sandbox, do NOT retry it repeatedly \u2014 state plainly that you don't have filesystem access to the vault in this environment, and offer to work from note content the user pastes or attaches with the "current note" / "selection" toggles instead.`;
}
function markdownFormattingInstructions() {
  return `Your replies are rendered as Markdown inside a narrow Obsidian sidebar panel, so formatting choices matter. Follow standard Markdown conventions: fence code with triple backticks and a language tag (\`\`\`ts, \`\`\`bash, ...), use "-" for bullet lists and "1." for ordered lists with a blank line before/after, use real Markdown tables (header row + "---" separator row) instead of hand-aligned ASCII tables, wrap inline code/identifiers/paths in single backticks, and keep headings to "##" or lower (the panel is narrow \u2014 an "#" heading is oversized). Prefer short paragraphs and lists over long blocks of prose. Don't wrap the entire reply in a code fence \u2014 only actual code/config/output goes in a fence.`;
}
function buildSystemInstructions(folder, opts = {}) {
  const parts = [contextFolderInstructions(folder)];
  if (opts.markdownFormattingEnabled !== false) parts.push(markdownFormattingInstructions());
  const custom = (opts.customPrompt || "").trim();
  if (custom) parts.push(custom);
  return parts.filter(Boolean).join("\n\n");
}
export {
  buildPrompt,
  buildSystemInstructions,
  contextFolderInstructions,
  markdownFormattingInstructions,
  resolveWorkingFolder
};
