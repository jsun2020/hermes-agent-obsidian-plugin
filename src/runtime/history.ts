// Pure helpers for the plugin's local chat-history store.
//
// No Obsidian imports here, so these functions are unit-testable in isolation
// (mirrors protocol.ts / context.ts). The plugin persists conversations to a
// separate `history.json` in the plugin folder — deliberately NOT in data.json,
// so the API key / settings stay isolated and history can grow independently.

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Conversation {
  /** Stable id (the originating tab id, or a restored conversation's id). */
  id: string;
  /** Short single-line label derived from the first user message. */
  title: string;
  /** Gateway session id, so a restored chat continues server-side context. */
  sessionId?: string;
  /** Epoch ms of the last turn — used for ordering and the age label. */
  updatedAt: number;
  messages: StoredMessage[];
}

/** Max conversations retained on disk (oldest dropped beyond this). */
export const MAX_CONVERSATIONS = 100;

/** First non-empty user line, collapsed and trimmed to a short title. */
export function deriveTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  const raw = (firstUser?.content || "").replace(/\s+/g, " ").trim();
  if (!raw) return "New chat";
  return raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
}

/** A compact label for a chat tab (ASCII-only ellipsis per project rules). */
export function tabLabel(title: string): string {
  const t = (title || "").trim();
  if (!t) return "Chat";
  return t.length > 20 ? t.slice(0, 18) + "..." : t;
}

/** Insert or replace a conversation by id, newest first, capped to `max`. */
export function upsertConversation(
  list: Conversation[],
  entry: Conversation,
  max: number = MAX_CONVERSATIONS
): Conversation[] {
  const rest = list.filter((c) => c.id !== entry.id);
  const next = [entry, ...rest];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next.slice(0, Math.max(1, max));
}

/** Remove a conversation by id. */
export function removeConversation(list: Conversation[], id: string): Conversation[] {
  return list.filter((c) => c.id !== id);
}

/** Human-friendly age label given the current time (both epoch ms). */
export function relativeTime(nowMs: number, thenMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
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

/** Parse the on-disk history file defensively (never throws). */
export function parseHistoryFile(text: string): Conversation[] {
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data?.conversations;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c: unknown): c is Record<string, unknown> => {
        return !!c && typeof (c as { id?: unknown }).id === "string" &&
          Array.isArray((c as { messages?: unknown }).messages);
      })
      .map((c) => {
        const messages = (c.messages as unknown[])
          .filter(
            (m): m is StoredMessage =>
              !!m &&
              typeof (m as { content?: unknown }).content === "string" &&
              typeof (m as { role?: unknown }).role === "string"
          )
          .map((m) => ({ role: m.role, content: m.content }));
        return {
          id: c.id as string,
          title: typeof c.title === "string" ? (c.title as string) : deriveTitle(messages),
          sessionId: typeof c.sessionId === "string" ? (c.sessionId as string) : undefined,
          updatedAt: typeof c.updatedAt === "number" ? (c.updatedAt as number) : 0,
          messages
        };
      });
  } catch {
    return [];
  }
}

/** Serialize the store for disk (stable, human-readable). */
export function serializeHistoryFile(list: Conversation[]): string {
  return JSON.stringify({ version: 1, conversations: list }, null, 2);
}
