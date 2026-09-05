# Phase J — MCP Bridge: drive the Matteblack harness with your Claude subscription

> Scope for turning Matteblack's in-app agentic harness into an **MCP server** so a
> Claude **subscription** client (Claude Desktop / Claude Code) becomes the model that
> drives generation — replacing the per-token Anthropic **API** key as the agent brain,
> while keeping the exact same tools, canvas, and generation pipeline.

**Status:** J1–J5 implemented & verified; a LIVE round-trip (real fal key) generated an image on the
canvas driven over the bridge. The stdio MCP server (`server/mcp/index.ts`) exposes generation +
canvas-read tools, token-gated, with harness guidance in `instructions`; it's packaged into the Electron
build and registered via **File ▸ Connect to Claude**. Remaining: publish the v0.2 GitHub release for
auto-update; optional in-app Settings UI for Connect (menu + IPC already exist).

---

## 1. The inversion

Today the agent flows **Matteblack → Anthropic API**:

```
user → in-app Agent panel → server/routes/agent.ts → Anthropic Messages API (BYOK key)
     → tool_use blocks (generate_media / generate_music / transform_media)
     → job created → dispatchToFal → result streamed back (SSE) → canvas / chat card
```

The model is bought per-token via `ANTHROPIC_API_KEY`. Phase J flips the driver so the model
is the user's **Claude subscription** — the same way this very session runs — by exposing the
harness as tools Claude connects to:

```
user → Claude Desktop / Claude Code (subscription)
     → MCP tools (matteblack.generate_media / …) served by Matteblack
     → same job pipeline → dispatchToFal → result lands on the Matteblack canvas
```

Nothing about generation changes. What changes is **who orchestrates**: Claude-the-client, not
`agent.ts`'s Anthropic loop. The Anthropic BYOK path stays as an optional in-app fallback; MCP is
**additive**.

### Why this is a clean fit
- **The tools already exist and are model-agnostic.** `GENERATE_MEDIA_TOOL`, `GENERATE_MUSIC_TOOL`,
  `TRANSFORM_MEDIA_TOOL` (`server/routes/agent.ts`) are JSON-Schema tool defs — the exact shape MCP
  wants. Their rich descriptions encode all the model/tier/aspect/reference/brand knowledge.
- **The executors already exist.** A tool_use block already becomes a job + `dispatchToFal`, and the
  agent already has an **`on_canvas` output mode** that places results on the canvas. MCP tools reuse
  that path verbatim.
- **Login-less local auth removes the hard part.** In `LOCAL_MODE`, `getLocalUserFromSession`
  short-circuits to the superadmin local user, so any loopback HTTP call to `/api/*` is authenticated
  with no cookie/token. The MCP server just calls `http://127.0.0.1:<port>/api/...`.
- **The harness's "personality" ports as MCP `instructions`.** `buildSystemPromptStatic()`'s tuned
  guidance (batch rules, tier defaults, brand behavior) becomes the MCP server's `instructions` +
  tool descriptions, so subscription-Claude behaves like the tuned in-app agent.

---

## 2. Target architecture

```
┌─────────────────────────┐        stdio (MCP)        ┌──────────────────────────────┐
│  Claude Desktop / Code   │ ───────────────────────▶ │  matteblack-mcp (Node, stdio)│
│  (user's subscription)   │ ◀─────────────────────── │  server/mcp/index.ts (bundled)│
└─────────────────────────┘   tools / results         └──────────────┬───────────────┘
                                                                      │ HTTP loopback
                                                                      ▼
                                              ┌────────────────────────────────────────┐
                                              │  Matteblack Express server (LOCAL_MODE)  │
                                              │  /api/generate · /api/job/:id · /api/…   │
                                              │  reuses agent tool executors + canvas    │
                                              └──────────────┬───────────────────────────┘
                                                             ▼  dispatchToFal → canvas
                                              (result appears in the Matteblack window)
```

The user runs the **Matteblack app** and their **Claude client** side by side. They talk to Claude;
Claude calls `matteblack.*` tools; generations land on the Matteblack canvas in real time.

---

## 3. MCP tool surface (v1)

Mirror the harness, plus the minimum canvas I/O so Claude can see and place work.

| MCP tool | Maps to | Notes |
|---|---|---|
| `generate_media` | `GENERATE_MEDIA_TOOL` | image/video. Same schema (kind, prompt, model/tier, aspectRatio, resolution, durationSeconds, referenceImageIds, videoReferenceMode, brand flags). **Blocks** until the job completes (internal poll), returns `{ assetId, url, canvasNodeId }`. |
| `generate_music` | `GENERATE_MUSIC_TOOL` | audio. Blocks, returns the audio asset. |
| `transform_media` | `TRANSFORM_MEDIA_TOOL` | edit/upscale/bg-remove/etc. on an existing asset id. |
| `list_canvas` | canvas read API | returns current canvas nodes/assets with the same `canvas:<n>` / `agent:<n>` reference ids the tools already accept, so Claude can target references. |
| `get_asset` | asset fetch | returns a thumbnail/data-uri + metadata so Claude can "see" a result and decide next steps. |
| `list_models` | static/`fal.ts` | enumerates available models + tiers (self-documenting). |
| `blender_run` | `POST /api/agent/blender/run` | runs a short Python step in the session's visible Blender window, preserving artist edits and native Undo (grey-box + camera helpers in `mb`), then puts the playblast/stills on the canvas. The reply is token-lean by design: a compact scene summary (objects capped at 30, camera first/last key + key count, floats rounded), the step's own `print()` output, and the canvas nodes — never Blender's render log. A Python error comes back as `ExcType: message` plus the step line(s) that raised it (no bridge frames); only a Blender crash/timeout returns a digested log tail. Raw `bpy` and optional `mb` helpers are available; `blender-blockout` is only a previs recipe, not a prerequisite (see [visible collaboration](blender/README.md)); `render` is optional so a pose can be checked for free before the one real render. |

**Key behavioral change vs. the in-app agent:** MCP tools are request/response, so the generation
tools **block until done and return the result** (the MCP server internally does the `/api/job/:id`
poll the SPA does today). No SSE, no phantom-tool detection, no batch-forcing prompt gymnastics —
Claude-the-client handles multi-call orchestration natively. The elaborate `agent.ts` prompt rules
(status-line-first, MAX_GENERATIONS_PER_TURN, phantom_tool_turn) exist to coax the *API* model; under
MCP most of that melts away.

---

## 4. Reuse plan — HTTP endpoints, not a module extraction ✅ (J1 done)

**Design correction (made during J1):** the scope originally proposed extracting the executors into a
shared module imported by both the in-app agent and the MCP server. But the MCP server is a *separate
stdio process* (§Transport decision) — importing `agent.ts` would drag the whole server (pool, fal,
credits) into the MCP process. The correct sharing boundary is **HTTP**. And conveniently, the agent's
"executor" (`dispatchAgentGeneration`) is already just a loopback `POST /api/generate` — the heavy
logic lives in the generate route, not the agent.

So J1 added two thin endpoints to `server/routes/agent.ts` that **reuse the existing tuned mapping
functions in place** (`parseGenerateMediaInput` / `parseTransformMediaInput` / `parseGenerateMusicInput`
→ `buildGenerateBody` / `buildTransformBody` / `buildMusicBody` → `dispatchAgentGeneration`) — no risky
extraction from the 4,000-line file:

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/tools` | returns the three tool schemas (framework-neutral `{name, description, inputSchema}`) for the MCP server to register. |
| `POST /api/agent/tool` | body `{ tool, input, referenceUrls?, canvas_id?, workspace_id? }` → runs parse → build → dispatch → returns `{ jobId, type, model, canvasId }`. |

References arrive as **resolved URLs** (the MCP server's canvas tools do id→url), so the in-app
reference-catalog resolver is bypassed. Canvas/workspace auto-resolve via `resolveOrCreateCanvasForUser`.

**Also fixed in J1:** `dispatchAgentGeneration` self-fetched `127.0.0.1:${process.env.PORT}`, which
broke under Electron's ephemeral port (`PORT=0`). The server now writes its real bound port back into
`process.env.PORT` after `listen`, so all in-process loopback self-calls resolve correctly.

**Verified:** `GET /api/agent/tools` → 3 tools; `POST /api/agent/tool` (generate_media, tier=quick) →
tier correctly resolved to `seedream-t2i`, canvas auto-created, job dispatched, `{jobId,…}` returned.

---

## 4b. The stdio MCP server ✅ (J2 done)

`server/mcp/index.ts` — a standalone Node script (bundled to `dist-mcp/index.js` via
`npm run build:mcp`, also runnable in dev with `npm run mcp` / `tsx server/mcp/index.ts`).
Spawned by the Claude client; talks JSON-RPC over **stdio** and HTTP to the app.

- **Discovery.** The Express server writes `<dataDir>/mcp-endpoint.json` = `{ baseUrl, token, pid,
  updatedAt }` in its `listen` callback (LOCAL_MODE only). The MCP server re-reads this file on every
  call (the app may restart on a new ephemeral port), so it always finds the live port.
  `MCP_ENDPOINT_PATH` is exported from `server/config/runtime.ts`; both processes agree on it via
  `MATTEBLACK_DATA_DIR` (defaults to `~/.matteblack`).
- **Tool discovery.** `tools/list` fetches `GET /api/agent/tools` live (4 s timeout) so Claude sees the
  full tuned schemas; falls back to an **embedded** copy of the 3 tools when the app isn't running yet,
  so the tools always appear in the client.
- **Tool calls.** `POST /api/agent/tool` → `{ jobId }`, then **block-and-poll** `GET /api/job/:id` until
  `completed` (return `result_url`) or `failed` (return the error as an MCP tool error). Reference URLs in
  the args are lifted to the top-level `referenceUrls`.
- **Progress → timeout reset.** MCP clients have a default ~60 s per-request timeout. On each poll tick the
  server emits `notifications/progress` (when the client supplied a `progressToken`), which resets that
  timeout — so long video/high-res jobs aren't cut off. Overall budget `MB_MCP_TIMEOUT_MS` (default 8 min).
- **stdout is sacred.** stdout is the JSON-RPC transport; all diagnostics go to **stderr**.
- **App-not-running** → the tool returns a clear "Open the Matteblack app first" error (v1; auto-launch is
  a later option).

**Verified** against the running app via an SDK `Client` over `StdioClientTransport`: connect + instructions,
`tools/list` returns the **live** 14-prop `generate_media` schema, and `tools/call generate_media` runs
dispatch → poll → terminal state, returning the failure cleanly in <1 s when no fal key is set (the exact
path that returns a `result_url` once a key is configured). A control-flow bug (terminal `failed` swallowed
by the network-retry catch → infinite poll until client timeout) was found and fixed during J2.

**Still open for J5:** the discovery-file path depends on `MATTEBLACK_DATA_DIR`; the "Connect to Claude"
config writer must pass that env (Electron userData) to the spawned MCP process, and the MCP script + SDK
must ship in the packaged app (SDK is already a normal dependency, not excluded by the bundle globs).

---

## 4c. Token gate + canvas/read tools ✅ (J3 done)

- **Token middleware.** `requireMcpToken` (routes/agent.ts) validates the `x-matteblack-token` header
  against the per-boot token the server generated + stashed via `server/mcpToken.ts` (`setMcpToken` in the
  `listen` callback; same value written to `mcp-endpoint.json`). Applied to **all** MCP-only routes
  (`/api/agent/tools`, `/api/agent/tool`, `/api/agent/models`, `/api/agent/assets`, `/api/agent/asset/:id`).
  This is the real access control — LOCAL_MODE auth otherwise treats any loopback caller as the superadmin.
  Escape hatch `MB_MCP_NO_TOKEN=1`. Verified: no/wrong token → **401**, correct → **200**.
- **Read tools** (served by the MCP server against new app endpoints):
  - `list_models` → `GET /api/agent/models` (`listAvailableModels()` in fal.ts) — model keys grouped by type.
  - `list_canvas` → `GET /api/agent/assets` — recent **completed** jobs (id, type, model, url, prompt) for the
    user, optionally scoped by `workspace_id` (or a `canvas_id` resolved to its workspace). Note: canvas
    placement isn't recorded on the job row, so scoping is by workspace, not literal canvas membership.
  - `get_asset` → `GET /api/agent/asset/:id` — one asset's metadata; for images the **MCP server**
    loopback-fetches the bytes and returns an inline MCP `image` block (≤1.5 MB), so Claude can *see* the
    result even though the loopback URL is unreachable from the Claude client. (This is the J4 "thumbnail
    back to Claude" capability, landed early via get_asset.)
- Reference flow stays URL-based: Claude reads a `url` from `list_canvas` and passes it in `referenceUrls`;
  no in-app `canvas:N` resolver needed.

---

## 5. Transport, discovery & lifecycle

- **Transport: stdio** (recommended). Universally supported by Claude Desktop (`claude_desktop_config.json`)
  and Claude Code (`.mcp.json` / `claude mcp add`), no ports to expose, no CORS. The stdio server is a
  small bundled Node script.
- **Server discovery.** The Electron app binds an ephemeral port. On boot it writes
  `userData/mcp-endpoint.json` = `{ "baseUrl": "http://127.0.0.1:<port>", "token": "<random>" }`.
  The MCP server reads this to find the running app.
- **If the app isn't running.** v1: the tool returns a clear "Open the Matteblack app first" error.
  v2: the MCP server can launch the app (spawn the installed exe) and wait for readiness.
- **Security.** Loopback only; the discovery-file `token` is sent as a header and checked by a thin
  MCP-only middleware so other local processes can't drive the app. No cloud, no secrets.

---

## 6. "Connect to Claude" ✅ (J5 done)

**File ▸ Connect to Claude** in the desktop app (electron/main.cjs) opens a dialog that:
- **Claude Code:** copies the exact `claude mcp add matteblack --env … -- <cmd> <script>` command.
- **Claude Desktop:** offers to merge the `matteblack` entry into `claude_desktop_config.json` — shows the
  exact JSON + target path and asks to confirm before writing; existing servers are preserved (never a
  silent overwrite).

**Launch mechanism (the key detail):** the command runs the packaged **app's own binary as Node** via
`ELECTRON_RUN_AS_NODE=1` on `…/resources/app/dist-mcp/index.js`, with `MATTEBLACK_DATA_DIR` set to the
app's userData/data dir. So the user needs **no separate Node install**, and the MCP process reads the
same `mcp-endpoint.json` this app publishes. Verified end-to-end: the built bundle launched via
electron-as-node connects and serves all 6 tools with the live 15-prop schema.

Also exposed over IPC (`app:connectToClaude`, `app:getMcpConnectInfo`) + preload
(`window.matteblack.connectToClaude()` / `getMcpConnectInfo()`) so an in-app Settings button can drive
the same flow later. (A `list_models` round-trip already serves as the connection check.)

---

## 7. Sub-phases & effort (S <½d · M 1–3d · L 3+d)

| | Sub-phase | Effort | Output |
|---|---|---|---|
| **J1** ✅ | Expose the harness via `GET /api/agent/tools` + `POST /api/agent/tool` reusing agent.ts mapping in place; fix ephemeral-port loopback | **M** | **done & verified** — endpoints live, in-app agent untouched |
| **J2** ✅ | stdio MCP server (`server/mcp/index.ts`) using `@modelcontextprotocol/sdk`; wire the 3 generation tools to the executors; blocking poll + progress notifications | **M** | **done & verified** — `matteblack-mcp` callable from an MCP client end-to-end |
| **J3** ✅ | Discovery-file token middleware (`requireMcpToken`); canvas/read tools (`list_canvas`, `get_asset`, `list_models`) | **M** | **done & verified** — endpoints token-gated (401 without), 6 tools listed, canvas readable |
| **J4** ✅ | Harness behavior as MCP `instructions` (workflow, tiers, video modes, references-by-URL, forward-faithfully); `referenceUrls` advertised on the generation schemas; thumbnails already land via get_asset (J3) | **S–M** | **done & verified** — instructions delivered, references usable over the bridge |
| **J5** ✅ | `dist-mcp/**` packaged (electron-builder.yml); **File ▸ Connect to Claude** dialog (copy `claude mcp add` / write `claude_desktop_config.json` with confirm) + IPC + preload; launch via app-binary-as-Node (`ELECTRON_RUN_AS_NODE`) | **M** | **done & verified** — bundle runs via electron-as-node, 6 tools, live schema |
| **J6** | Docs + end-to-end verification (Claude Code and Claude Desktop) | **S** | README section, verified round-trip |

Rough total: **~1.5–2.5 weeks**. J1 is the linchpin (and de-risks by keeping the in-app agent
working throughout). J2 gives the first demoable "drive Matteblack from Claude Code" moment.

---

## 8. Open decisions (need your call)

1. **Client target:** Claude Desktop + Claude Code both (stdio, recommended), or also a remote
   HTTP/SSE MCP endpoint hosted by the app (for future web/other clients)?
2. **In-app Anthropic agent:** keep it as an optional BYOK fallback (recommended — MCP is additive),
   or retire it and make MCP the only agent path?
3. **Result destination:** land on the Matteblack canvas (matches today's model; app must be open) —
   and *also* return a thumbnail to Claude so it can reason about the result? (Recommended: both.)
4. **App-not-running behavior:** v1 "open the app first" error, or invest in auto-launch now?
5. **Auth hardening:** is the loopback + discovery-file token enough for v1, or do you want a
   per-connection approve prompt in the app the first time a Claude client connects?

---

## 9. Risks & notes

- **The J1 extraction is the main risk** — `agent.ts` is large and the executor logic is entangled
  with the streaming driver (reference catalog building, brand/product context, credit debit). Budget
  care + a boot/regression pass on the in-app agent after extracting.
- **Blocking tools + long videos:** a 4K video can take minutes; the MCP tool must poll with a
  generous timeout and stream progress via MCP's partial-result / notification channel if we want a
  progress indicator in the Claude client.
- **Two windows, one canvas:** the UX assumes the Matteblack window is open next to Claude. Worth a
  short "why two windows" note in the docs; a future v2 could surface results back into Claude itself.
- **Not a public/remote server:** this is a *local* bridge to a *local* app. No auth server, no
  exposure beyond loopback — keep it that way.
