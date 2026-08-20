# Ignis additive transport upgrade plan

**Date:** 2026-08-21
**Status:** Implemented on `feature/ignis-additive-transport` — awaiting upstream review
**Scope:** Address the requested changes on upstream PR #14 without regressing
desktop Obsidian users.

## Goal

Support Hermes in Ignis's browser-hosted Obsidian as an additional execution
path. The existing desktop integration remains the default and preserves its
Node HTTP client and Runs Server-Sent Events (SSE) behaviour.

This plan deliberately separates the independently useful saved-conversation
restoration change from the Ignis transport work.

## Constraints and decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Default gateway address | Keep `http://127.0.0.1:8642`. | `/hermes` resolves incorrectly from desktop Obsidian's `app://` origin. |
| Desktop requests | Keep the Node `http`/`https` requester. | The local gateway has CORS disabled; browser `fetch` cannot replace it on desktop. |
| Desktop Runs | Keep `GET /v1/runs/{id}/events` SSE. | It provides streamed output, reasoning, tool events, failure fallback, and approval handling. |
| Browser requests | Add a browser `fetch` requester selected only when Node HTTP is unavailable, or when an explicit browser selection is made. | Ignis does not expose Node `http.request()`. |
| Browser Runs | Poll `GET /v1/runs/{id}` only for the browser path. | Ignis buffers proxied SSE responses. |
| Relay convention | Document `/hermes` as an Ignis deployment option, not a universal default. | It is deployment-specific and normally injects credentials server-side. |
| User-facing text | English defaults only in this change. | Keeps upstream UI consistent; localization can be a later, focused change. |
| Mobile declaration | Do not set `isDesktopOnly: false` until all top-level Node imports are removed or made safe. | A browser/mobile load must not evaluate `fs`, `os`, or `path`. |

## Delivery 1 — saved conversation restoration

Create `feature/restore-saved-conversation` from the current upstream `main`.
Include only the `HermesView.ts` change that restores the newest persisted
conversation when the view opens.

### Acceptance criteria

- Opening the view with history restores the newest conversation.
- Opening the view without history shows one empty tab.
- No transport, manifest, settings, or user-facing status changes are part of
  this PR.
- Existing history tests and the full project validation suite pass.

## Delivery 2 — opt-in Ignis transport

Create `feature/ignis-additive-transport` from upstream `main`; do not reuse
the fork's `main` as the PR head. This delivery must remain reviewable without
the conversation-restoration PR, although it may be rebased on it after that
PR merges.

### 1. Split request transport from API transport

`transport` already means `auto` / `runs` / `chat`. Keep that meaning. Add a
separate request-execution selection, for example:

```ts
type RequestTransportPreference = "auto" | "node" | "browser";
```

- `auto`: choose Node when `window.require` is available; otherwise choose the
  browser adapter.
- `node`: available only where Node HTTP is available; report a clear error if
  a user forces it in a browser environment.
- `browser`: explicitly use the browser adapter for testing or supported
  browser-hosted deployments.

The setting label and description must use neutral English. It must not refer
to a particular reverse proxy, Cloudflare Access, or deployment.

### 2. Preserve the desktop client intact

Keep the current upstream Node requester and its runs event-stream path as the
desktop implementation. In particular retain:

- streamed chat and run chunks;
- `onReasoning` and `toolEventFromRunEvent` handling;
- `run.failed` fallback to Chat Completions before content is produced;
- cancellation and request-timeout handling; and
- manual approval behaviour: stop the run and fall back to plain chat when
  `autoApproveTools` is false.

Extract only the shared request interface and common parsing helpers. Do not
make the Node requester emulate browser APIs or make the browser requester
emulate Node event emitters unless that materially reduces tested duplication.

### 3. Add the browser client path

Implement the browser adapter with `fetch`, `AbortController`, and
`ReadableStream` for calls where streaming is available. It should:

- use the configured base URL and optional bearer key unchanged;
- call Ignis's same-origin proxy only when its browser-specific API is present
  and the configured URL is cross-origin;
- make normal JSON calls for capabilities, models, stop, and approval; and
- use run-status polling only for Runs in browser mode.

For polling, expose short English progress updates based on status and
`last_event`. A `waiting_for_approval` state must either submit the configured
automatic approval or stop polling, stop the run, and use the normal chat
fallback. It must never wait indefinitely in manual-approval mode.

### 4. Make the plugin safe to load outside desktop

Before setting `isDesktopOnly: false`:

- remove top-level imports of `fs`, `os`, and `path` from `src/main.ts`;
- obtain Node-only modules only inside guarded desktop code; and
- make filesystem model-config discovery and native folder selection safely
  unavailable in browser mode, with a graceful UI fallback.

If this cannot be completed and tested in the same PR, retain
`isDesktopOnly: true` and document the browser work as an unsupported preview
instead of publishing an inaccurate manifest.

### 5. Restore settings and documentation boundaries

- Restore `DEFAULT_SETTINGS.baseUrl` and an emptied gateway-address field to
  `http://127.0.0.1:8642`.
- Restore `reloadModelInViews()` after base URL and API-key changes.
- Restore local-gateway setting copy and normal authentication error messages.
- Add a clearly titled **Ignis deployment** section to the README explaining
  that an Ignis administrator may configure `/hermes` as a same-origin relay.
  Keep credential injection and private-host allowlisting server-side and out
  of generic desktop setup instructions.

## Test matrix

| Scenario | Expected result |
| --- | --- |
| Fresh desktop install | Default gateway is `http://127.0.0.1:8642`; connection uses Node HTTP without browser CORS. |
| Desktop Runs | Event stream shows chunks, reasoning, tool events, usage, and terminal state. |
| Desktop run failure before output | Falls back to Chat Completions. |
| Desktop manual approval | Stops and falls back rather than hanging. |
| Browser/Ignis Runs | Uses status polling and displays English progress. |
| Browser/Ignis automatic approval | Posts approval once and continues polling. |
| Browser/Ignis manual approval | Stops polling and falls back; no infinite wait. |
| Browser load | No top-level Node-module failure. |
| Settings changes | Base URL and API-key changes refresh model information in open views. |

Add focused automated tests for transport selection, the browser polling
terminal states, and the manual-approval fallback. Retain the existing
protocol/history tests.

## Required validation before each PR

```bash
npm run typecheck
npm run lint
npm test
npm run build
node --check main.js
git diff --check
```

Additionally perform the applicable manual checks from the test matrix using a
desktop Obsidian instance and the Ignis deployment. Record the tested gateway
address, selected request transport, and observed terminal run state in the PR
description; never record API keys or session cookies.

## PR and branch workflow

1. Keep the current PR #14 unchanged as review evidence until its replacements
   are ready.
2. Open the saved-conversation PR from `feature/restore-saved-conversation`.
3. Open the Ignis PR from `feature/ignis-additive-transport` with a concise
   before/after behaviour table and the completed validation list.
4. Mark PR #14 as superseded only after both replacements are available for
   review, with links to them in the closing comment.
5. Rebase each feature branch onto upstream `main` before final review; rebuild
   `main.js` after source conflict resolution rather than resolving generated
   bundle conflicts by hand.

## Out of scope

- Changing Hermes gateway CORS policy.
- Shipping a Cloudflare- or Nginx-specific integration in the generic plugin.
- Adding a manual tool-approval UI.
- A full localization framework. English strings are sufficient for this
  upgrade; localization can follow in a dedicated PR.
