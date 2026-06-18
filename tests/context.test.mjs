// Unit tests for the working-folder helpers (pure, no Node/Obsidian deps).
//
// Bundled by `npm run build:test` (esbuild src/runtime/context.ts ->
// tests/.build/context.mjs), then run with the Node built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkingFolder, contextFolderInstructions } from "./.build/context.mjs";

test("resolveWorkingFolder returns the vault root when no sub-folder is set", () => {
  assert.equal(resolveWorkingFolder("C:\\Users\\me\\Vault", ""), "C:\\Users\\me\\Vault");
  assert.equal(resolveWorkingFolder("/home/me/Vault", "  "), "/home/me/Vault");
});

test("resolveWorkingFolder strips a trailing separator from the base", () => {
  assert.equal(resolveWorkingFolder("C:\\Users\\me\\Vault\\", ""), "C:\\Users\\me\\Vault");
  assert.equal(resolveWorkingFolder("/home/me/Vault/", ""), "/home/me/Vault");
});

test("resolveWorkingFolder joins a vault-relative sub-folder with the base separator", () => {
  assert.equal(resolveWorkingFolder("C:\\Users\\me\\Vault", "Projects"), "C:\\Users\\me\\Vault\\Projects");
  assert.equal(resolveWorkingFolder("/home/me/Vault", "Projects/sub"), "/home/me/Vault/Projects/sub");
});

test("resolveWorkingFolder normalises mixed separators in the sub-folder", () => {
  assert.equal(
    resolveWorkingFolder("C:\\Users\\me\\Vault", "Projects/sub"),
    "C:\\Users\\me\\Vault\\Projects\\sub"
  );
  assert.equal(resolveWorkingFolder("C:\\Users\\me\\Vault", "/Projects"), "C:\\Users\\me\\Vault\\Projects");
});

test("resolveWorkingFolder uses an absolute sub-folder as-is", () => {
  assert.equal(resolveWorkingFolder("C:\\Users\\me\\Vault", "D:\\Other"), "D:\\Other");
  assert.equal(resolveWorkingFolder("/home/me/Vault", "/etc/notes"), "/etc/notes");
  assert.equal(resolveWorkingFolder("/home/me/Vault", "\\\\server\\share"), "\\\\server\\share");
});

test("resolveWorkingFolder falls back to the sub-folder when base is empty", () => {
  assert.equal(resolveWorkingFolder("", "Projects"), "Projects");
});

test("contextFolderInstructions embeds the folder and is empty when blank", () => {
  assert.equal(contextFolderInstructions(""), "");
  assert.equal(contextFolderInstructions("   "), "");
  const msg = contextFolderInstructions("C:\\Users\\me\\Vault");
  assert.ok(msg.includes("C:\\Users\\me\\Vault"));
  assert.ok(/working folder/i.test(msg));
  assert.ok(/file/i.test(msg));
});

test("contextFolderInstructions tells the agent to degrade gracefully if sandboxed", () => {
  const msg = contextFolderInstructions("/home/me/Vault");
  assert.ok(/sandbox/i.test(msg));
  assert.ok(/don't have filesystem access|filesystem access/i.test(msg));
  assert.ok(/paste|attach/i.test(msg));
});
