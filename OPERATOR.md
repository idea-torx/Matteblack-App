# Phase K — The Matte operator (drive Claude Code in-app)

The Matte agent panel is now an **in-app operator**: the user types in the panel, and Matteblack
drives their **Claude Code** (their Claude *subscription*) headlessly, with the matteblack MCP tools
wired in. Claude generates onto the canvas; the conversation + tool activity stream back into the panel.

This replaces the retired BYOK Anthropic agent. It uses the subscription — no per-token API key.

## Flow

```
Matte panel (OperatorPanel) ──POST /api/operator/message (SSE)──▶ server/operator/claudeOperator.ts
                                                                     │ spawn `claude -p --output-format stream-json`
                                                                     │   --mcp-config <matteblack> --strict-mcp-config
                                                                     │   --allowedTools mcp__matteblack__*  (only these)
                                                                     │   --append-system-prompt <Matte persona>
                                                                     │   env CLAUDE_CODE_OAUTH_TOKEN=<user token>
                                                                     ▼
                              Claude (subscription) ──MCP──▶ matteblack MCP server ──HTTP──▶ this app
                                                                     ▼  dispatchToFal → canvas
                              stream-json events ◀── parsed → SSE → panel (text / tool chips / result)
```

## Auth model

The Claude *subscription* can't be called by a third-party app directly, and ambient Claude Code auth
isn't reliably reachable by a spawned process. So the app owns auth explicitly:

1. User runs **`claude setup-token`** once (mints a long-lived subscription OAuth token).
2. Pastes it into **Settings → Claude Code token** (stored in `config.json` next to the fal key).
3. The operator passes it to the spawned `claude` as `CLAUDE_CODE_OAUTH_TOKEN`.

`getClaudeCodeToken()` also honours a `CLAUDE_CODE_OAUTH_TOKEN` env fallback. The `claude` binary is
auto-detected (`~/.local/bin/claude(.exe)`, npm global, PATH) with a `claudeCodePath` config / `MB_CLAUDE_PATH`
env override.

## Safety scoping

- `--allowedTools` lists ONLY the six `mcp__matteblack__*` tools. In headless `-p` mode, tools not on the
  list are auto-denied — so the operator can generate but can't touch the filesystem or run shell.
- `--strict-mcp-config` loads ONLY our MCP server (ignores the user's other connected MCP servers).
- `ANTHROPIC_API_KEY` is blanked in the child env so an ambient key can't hijack the subscription token.

## Pieces

| Piece | File |
|---|---|
| Token + binary config | `server/config/userConfig.ts` (`getClaudeCodeToken` / `getClaudeCodePath`) |
| Settings status/save | `server/index.ts` (`/api/settings` → `claudeCodeToken`) |
| Operator core (spawn + stream-json parser) | `server/operator/claudeOperator.ts` (+ `.test.ts`) |
| SSE routes | `server/routes/operator.ts` (`GET /api/operator/status`, `POST /api/operator/message`) |
| Electron env wiring | `electron/main.cjs` (`MB_APP_EXEC`, `MB_MCP_SCRIPT`) |
| Panel UI | `src/components/OperatorPanel.tsx` (+ `.css`), mounted in `src/App.tsx` |
| Token entry | `src/components/SettingsPanel.tsx` (Claude Code token field) |

The legacy `AgentPanel` is retained behind `SHOW_LEGACY_AGENT = false` in `App.tsx` for a clean revert.

## Verified

- Stream-json parser: 8 unit tests (`claudeOperator.test.ts`) — session / text / tool_use / tool_result /
  result(success|error). ✅
- Server plumbing (dummy token): SSE emits `ping → session → text → done(isError) → end`; Claude Code spawns,
  loads the MCP config, starts a session, and the 401 (bad token) surfaces gracefully — no hang. ✅
- **Live generation (real token): the user's test** — enter the token in Settings, open Matte, chat.

## To test live

1. `npm run electron:dev` (current code; the shipped v0.2 installer predates Phase K).
2. In the app: Settings (key icon) → paste your `claude setup-token` token → Save.
3. Open the Matte panel → ask it to generate something → watch it land on the canvas.
