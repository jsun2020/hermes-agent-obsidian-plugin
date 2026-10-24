// src/runtime/history.ts
var MAX_CONVERSATIONS = 100;
function displayText(m) {
  return m.display ?? m.content;
}
function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === "user" && displayText(m).trim());
  const raw = displayText(firstUser ?? { role: "user", content: "" }).replace(/\s+/g, " ").trim();
  if (!raw) return "New chat";
  return raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
}
function lastMessagePreview(messages, max = 80) {
  const visible = messages.filter((m) => m.role !== "system" && displayText(m).trim());
  if (visible.length < 2) return "";
  const last = visible[visible.length - 1];
  const who = last.role === "user" ? "You" : "Hermes";
  const raw = displayText(last).replace(/\s+/g, " ").trim();
  const body = raw.length > max ? raw.slice(0, max - 3) + "..." : raw;
  return `${who}: ${body}`;
}
function tabLabel(title) {
  const t = (title || "").trim();
  if (!t) return "Chat";
  return t.length > 20 ? t.slice(0, 18) + "..." : t;
}
function upsertConversation(list, entry, max = MAX_CONVERSATIONS) {
  const rest = list.filter((c) => c.id !== entry.id);
  const next = [entry, ...rest];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next.slice(0, Math.max(1, max));
}
function removeConversation(list, id) {
  return list.filter((c) => c.id !== id);
}
function relativeTime(nowMs, thenMs) {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1e3));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
function isRecord(v) {
  return typeof v === "object" && v !== null;
}
var VALID_ROLES = /* @__PURE__ */ new Set(["user", "assistant", "system"]);
function parseHistoryFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  let rawArr = [];
  if (Array.isArray(data)) {
    rawArr = data;
  } else if (isRecord(data) && Array.isArray(data.conversations)) {
    rawArr = data.conversations;
  }
  const out = [];
  for (const c of rawArr) {
    if (!isRecord(c) || typeof c.id !== "string" || !Array.isArray(c.messages)) continue;
    const messages = [];
    for (const m of c.messages) {
      if (isRecord(m) && typeof m.content === "string" && typeof m.role === "string" && VALID_ROLES.has(m.role)) {
        const msg = { role: m.role, content: m.content };
        if (typeof m.display === "string") msg.display = m.display;
        if (isRecord(m.attachments)) {
          const a = m.attachments;
          const attachments = {};
          if (typeof a.notePath === "string") attachments.notePath = a.notePath;
          if (typeof a.noteContent === "string") attachments.noteContent = a.noteContent;
          if (typeof a.selection === "string") attachments.selection = a.selection;
          if (Object.keys(attachments).length > 0) msg.attachments = attachments;
        }
        messages.push(msg);
      }
    }
    out.push({
      id: c.id,
      title: typeof c.title === "string" ? c.title : deriveTitle(messages),
      sessionId: typeof c.sessionId === "string" ? c.sessionId : void 0,
      updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
      messages
    });
  }
  return out;
}
function serializeHistoryFile(list) {
  return JSON.stringify({ version: 1, conversations: list }, null, 2);
}
export {
  MAX_CONVERSATIONS,
  deriveTitle,
  lastMessagePreview,
  parseHistoryFile,
  relativeTime,
  removeConversation,
  serializeHistoryFile,
  tabLabel,
  upsertConversation
};
