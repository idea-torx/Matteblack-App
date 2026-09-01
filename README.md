# Fal Forge — Local Edition

An open-source AI creative suite: image generation & editing, audio (TTS / music / SFX),
a node-based freeform canvas, a cinema timeline, an AI agent, and brand tooling.

This is the **login-less local build**. It runs entirely on your machine — an
embedded database, files on local disk, no accounts, no billing — and calls the
AI providers directly using **your own API keys**.

- **Frontend:** React 19 + TypeScript + Vite
- **Backend:** Express (Node) + embedded Postgres ([PGlite](https://pglite.dev))
- **Generation:** [fal.ai](https://fal.ai) (bring your own key)
- **Agent:** your **Claude subscription**, driven through Claude Code + MCP locally (no API key)
- **Brand IQ:** Anthropic API key (optional fallback path)

> **Just want to use the app?** See **[INSTALL.md](INSTALL.md)** — either
> `npm run electron:dev` from a clone, or the installer from
> [Releases](https://github.com/idea-torx/FalForge/releases/latest). The rest of
> this file is for working on the source.

> Converting this into a packaged Windows desktop app? See **[CONVERSION.md](CONVERSION.md)**
> for the full architecture and phase-by-phase roadmap.

## Quick start

```bash
npm install
npm run dev:server:local   # backend on :3001 (LOCAL_MODE, embedded DB + local storage)
npm run dev                # frontend on :5000 (proxies /api and /auth to the backend)
```

Then open http://localhost:5000. `LOCAL_MODE` is auto-detected when no
`DATABASE_URL`/`WORKOS_API_KEY` is set, so plain `npm run dev:server` works too.

### Add your API keys

Generation needs a fal.ai key. In the app, open **Settings ▸ API keys** (the key
icon at the bottom of the left rail) and paste:

- **fal.ai key** — required for all generation. Get one at https://fal.ai/dashboard/keys

The AI Agent does **not** need an API key — it runs on your **Claude
subscription** by driving Claude Code locally over MCP (the default and
recommended path; see [INSTALL.md](INSTALL.md) step 4 and
[OPERATOR.md](OPERATOR.md)):

```bash
npm install -g @anthropic-ai/claude-code
claude   # sign in once, then quit
```

- **Anthropic API key** — absolute fallback only (Brand IQ, or the agent when
  Claude Code isn't available). Get one at https://console.anthropic.com/settings/keys

Keys are stored locally at `~/.matteblack/config.json` and used only to call
those providers directly. You can also set `FAL_KEY` / `ANTHROPIC_API_KEY` in a
`.env` file instead (see `.env.example`).

## Where your data lives

Everything is written under `~/.matteblack/` (override with `MATTEBLACK_DATA_DIR`):

| Path | Contents |
|------|----------|
| `~/.matteblack/pgdata/` | Embedded Postgres database (projects, canvases, assets metadata) |
| `~/.matteblack/uploads/` | Uploaded and generated files (images, video, audio) |
| `~/.matteblack/config.json` | Your API keys |

Delete that folder to reset to a clean slate.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite frontend dev server (:5000) |
| `npm run dev:server:local` | Backend in local mode with hot-reload (tsx) |
| `npm run server:local` | Build + run the backend in local mode |
| `npm run build` | Production build of the frontend |
| `npm run lint` | ESLint |

## Cloud build

The original hosted architecture (WorkOS auth, managed Postgres, Cloudflare R2,
Stripe billing, Redis) still works — set `LOCAL_MODE=false` and provide the
corresponding variables from `.env.example`. The local and cloud paths share the
same code, switched by `LOCAL_MODE`.

## License

See [LICENSE](LICENSE). Note that AI generations are subject to the terms of the
providers you configure (fal.ai, Anthropic).
