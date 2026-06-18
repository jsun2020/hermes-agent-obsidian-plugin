// Unit tests for the chat-history store helpers (pure, no Node/Obsidian deps).
//
// Bundled by `npm run build:test` (esbuild src/runtime/history.ts ->
// tests/.build/history.mjs), then run with the Node built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTitle,
  tabLabel,
  upsertConversation,
  removeConversation,
  relativeTime,
  parseHistoryFile,
  serializeHistoryFile,
  MAX_CONVERSATIONS
} from "./.build/history.mjs";

test("deriveTitle uses the first non-empty user message, collapsed and trimmed", () => {
  assert.equal(deriveTitle([{ role: "user", content: "  hello   world \n" }]), "hello world");
  assert.equal(
    deriveTitle([
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what is the weather" }
    ]),
    "what is the weather"
  );
});

test("deriveTitle truncates long titles to 60 chars with an ellipsis", () => {
  const long = "a".repeat(80);
  const out = deriveTitle([{ role: "user", content: long }]);
  assert.equal(out.length, 60);
  assert.ok(out.endsWith("..."));
});

test("deriveTitle falls back to 'New chat' when there is no user text", () => {
  assert.equal(deriveTitle([]), "New chat");
  assert.equal(deriveTitle([{ role: "assistant", content: "only assistant" }]), "New chat");
});

test("tabLabel shortens long titles and keeps short ones", () => {
  assert.equal(tabLabel("short"), "short");
  assert.equal(tabLabel(""), "Chat");
  const out = tabLabel("a".repeat(40));
  assert.equal(out.length, 21); // 18 + "..."
  assert.ok(out.endsWith("..."));
});

test("upsertConversation inserts new and sorts newest first", () => {
  let list = [];
  list = upsertConversation(list, { id: "a", title: "A", updatedAt: 100, messages: [] });
  list = upsertConversation(list, { id: "b", title: "B", updatedAt: 200, messages: [] });
  assert.deepEqual(
    list.map((c) => c.id),
    ["b", "a"]
  );
});

test("upsertConversation replaces an existing id and re-sorts", () => {
  let list = [
    { id: "a", title: "A", updatedAt: 100, messages: [] },
    { id: "b", title: "B", updatedAt: 200, messages: [] }
  ];
  list = upsertConversation(list, { id: "a", title: "A2", updatedAt: 300, messages: [] });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "a");
  assert.equal(list[0].title, "A2");
});

test("upsertConversation caps the list to the max, dropping oldest", () => {
  let list = [];
  for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
    list = upsertConversation(list, { id: `c${i}`, title: `C${i}`, updatedAt: i, messages: [] });
  }
  assert.equal(list.length, MAX_CONVERSATIONS);
  // newest kept, oldest dropped
  assert.equal(list[0].id, `c${MAX_CONVERSATIONS + 4}`);
  assert.ok(!list.some((c) => c.id === "c0"));
});

test("removeConversation drops the matching id only", () => {
  const list = [
    { id: "a", title: "A", updatedAt: 1, messages: [] },
    { id: "b", title: "B", updatedAt: 2, messages: [] }
  ];
  const out = removeConversation(list, "a");
  assert.deepEqual(
    out.map((c) => c.id),
    ["b"]
  );
});

test("relativeTime buckets seconds/minutes/hours/days", () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeTime(now, now - 10_000), "just now");
  assert.equal(relativeTime(now, now - 5 * 60_000), "5m ago");
  assert.equal(relativeTime(now, now - 3 * 3_600_000), "3h ago");
  assert.equal(relativeTime(now, now - 2 * 86_400_000), "2d ago");
  assert.equal(relativeTime(now, now - 14 * 86_400_000), "2w ago");
  assert.equal(relativeTime(now, now - 60 * 86_400_000), "2mo ago");
});

test("parse/serialize round-trips conversations", () => {
  const list = [
    {
      id: "a",
      title: "A",
      sessionId: "sess-1",
      updatedAt: 123,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" }
      ]
    }
  ];
  const round = parseHistoryFile(serializeHistoryFile(list));
  assert.deepEqual(round, list);
});

test("parseHistoryFile is defensive against junk", () => {
  assert.deepEqual(parseHistoryFile("not json"), []);
  assert.deepEqual(parseHistoryFile("{}"), []);
  assert.deepEqual(parseHistoryFile('{"conversations":"nope"}'), []);
  // drops entries missing id/messages, and bad messages within a good entry
  const out = parseHistoryFile(
    JSON.stringify({
      conversations: [
        { id: "ok", messages: [{ role: "user", content: "x" }, { role: "user" }, { bad: 1 }] },
        { messages: [] },
        { id: "nomsgs" }
      ]
    })
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ok");
  assert.equal(out[0].messages.length, 1);
  assert.equal(out[0].updatedAt, 0);
});

test("parseHistoryFile accepts a bare array form", () => {
  const out = parseHistoryFile(
    JSON.stringify([{ id: "a", messages: [{ role: "user", content: "hey" }] }])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "hey");
});
