# Hermes Agent — Obsidian plugin

Chat with your locally installed **Hermes Agent** from inside Obsidian. The plugin talks to
the local Hermes gateway (started by Hermes Desktop) over its HTTP API and streams replies into
a multi-tab sidebar panel. It sends the current note or selected text as context.

It is a separate plugin from Claudian and does not modify or replace it.

## How it works

- Hermes Desktop runs a local **gateway** (default `http://127.0.0.1:8642`).
- The plugin capability-detects via `GET /v1/capabilities` and then uses:
  - the **Runs** transport (`POST /v1/runs` + `GET /v1/runs/{id}/events`) when available — this
    gives tool/reasoning/usage events; or
  - **Chat Completions** (`POST /v1/chat/completions`, OpenAI-compatible, streaming) as a fallback.
- Auth uses `Authorization: Bearer <API_SERVER_KEY>`. You paste that key into the plugin settings.

The transport logic is a direct port of Hermes Desktop's own client (`src/main/hermes.ts` /
`src/main/run-stream.ts`), so it mirrors the reference behavior.

## Prerequisites

1. **Install + run Hermes Desktop at least once.** This creates `~/.hermes` (on Windows:
   `%USERPROFILE%\.hermes`), generates `API_SERVER_KEY`, and starts the gateway. The portable
   build is at `hermes-desktop/dist/hermes-desktop-0.5.8-portable.exe`.
2. Find your key in `%USERPROFILE%\.hermes\.env` (line `API_SERVER_KEY=...`).
3. The gateway must be running (Hermes Desktop open) when you use the plugin.

## Build

```powershell
cd C:\Users\sr9rfx\.claude-project\Obsidian\hermes-agent
npm install
npm run build      # emits main.js
npm test           # runs protocol unit tests (Node built-in test runner)
```

`npm run build` produces `main.js` next to `manifest.json` and `styles.css` — the three files
Obsidian needs.

## Install into the vault

Copy `main.js`, `manifest.json`, and `styles.css` into a **new** plugin folder (do NOT touch the
existing `claudian` folder):

```
C:\Users\sr9rfx\Obsidian-vault\.obsidian\plugins\hermes-agent\
  main.js
  manifest.json
  styles.css
```

Then in Obsidian: Settings -> Community plugins -> enable **Hermes Agent** (toggle it on; it will
be added to `community-plugins.json` alongside `claudian`).

## Configure

Open Settings -> Hermes Agent:

- **Gateway base URL** — `http://127.0.0.1:8642` (named profiles may use 8643-8742).
- **API key** — paste `API_SERVER_KEY`.
- **Model** — e.g. `gpt-5.5`, or leave empty for the gateway default. Use **Test connection** to
  list available models.
- **Transport** — `Auto` recommended.
- Optional: reasoning effort, include-full-note-content, request timeout, max tabs.

### Agent workspace (file access)

This is what makes Hermes a real collaborator instead of a chatbot: the vault becomes the
agent's working directory, so it can read, write, search, and run multi-step workflows over your
notes.

- **Working folder** — the folder the agent operates in, relative to the vault root. Leave empty
  to use the whole vault. An absolute path is also accepted. The plugin sends this to the gateway
  as the run's `instructions` (Hermes has no `cwd` field), telling the agent to use file tools with
  absolute paths under this folder. The quickest way to set it is the **folder chip** in the chat
  footer — click it to open a native folder picker (folders inside the vault are stored relative,
  outside the vault as an absolute path).
- **Auto-approve tool requests** (default **on**) — lets the agent use file read/write, search, and
  terminal tools without prompting. When Hermes asks for permission mid-run, the plugin answers
  `always` via `POST /v1/runs/{id}/approval`. **This grants the agent real read/write access to the
  working folder.** Turn it off to get plain, tool-less replies (every tool request is then
  cancelled and the run falls back to a normal chat completion).

> **Windows note:** the gateway's shell/code-execution sandbox may be unavailable on Windows
> (PowerShell can fail to start). File read/write/search tools do **not** need the shell and work
> regardless, so note-centric tasks (read, summarise, edit, create) still work. Pure shell/bash
> workflows are limited by the gateway environment, not the plugin.

Click **Test connection** to verify reachability, the chosen transport, and the model list.

## Use

- Ribbon **bot** icon or command **Hermes Agent: Open chat view** opens the sidebar.
- Type a message and press **Enter** (Shift+Enter for newline).
- Context toggles above the input attach the **current note** and/or **selection** to the message.
- Commands:
  - **Open chat view**
  - **New chat tab**
  - **Send current note to Hermes**
  - **Send selection to Hermes**
- The **+** button adds a tab; each tab is an independent conversation. The **stop** (square)
  button cancels the in-flight reply.

### Chat footer (meta bar)

Below the input, a Claudian-style meta bar shows, left to right:

- **Model** — the model id (`hermes-agent` or your configured model). Click to open settings.
- **Thinking: <effort>** — the reasoning effort. Click to pick one (default/minimal/low/medium/
  high/xhigh) from a menu, applied immediately.
- **Session tokens** — cumulative tokens used in the active tab (shown once the first reply
  reports usage).
- **Folder chip** — the agent's working folder. Click to open a **native folder picker**; the chip
  dims when auto-approve is off (read-only).

## Manual test checklist

1. With Hermes Desktop running, open settings and click **Test connection** -> expect
   "Connected. Transport: runs|chat. N model(s) available."
2. Open the panel, send "hello" -> a streamed reply appears under "Hermes".
3. Select text in a note, run **Send selection to Hermes** -> the reply references the selection.
4. Stop a long reply mid-stream with the square button -> streaming halts.
5. With Hermes Desktop closed, send a message -> a clear error explains the gateway is unreachable.

## Troubleshooting

- **"Cannot reach the gateway"** — start Hermes Desktop (it launches the gateway).
- **Auth failed (401/403)** — re-paste `API_SERVER_KEY`; it must match the active profile's key.
- **Empty/!200 from /v1/models** — older gateways may not expose it; the chat still works. Set the
  model id manually.
- **Wrong port** — named profiles bind 8643-8742; check `platforms.api_server.extra.port` in
  `~/.hermes/config.yaml` and set the base URL accordingly.
