# Installing Fal Forge on macOS

For collaborators. Ten minutes, most of it downloading.

The repo is **private**, so you need to be signed in to GitHub with access to
`idea-torx/FalForge` before the download links will work.

Two ways in:

- **[Run from source](#run-from-source)** — clone and build. No Gatekeeper
  prompt at all, because an app you built yourself was never quarantined. This is
  the recommended path today.
- **[Install the dmg](#1-download)** — one download, but macOS calls the app
  damaged on first launch and you have to clear that by hand (step 2). It stays
  that way until the app is code-signed.

---

## Run from source

Needs [Node 22+](https://nodejs.org) and `git`. The first install pulls Electron,
so budget a few hundred MB and a couple of minutes.

```bash
git clone https://github.com/idea-torx/FalForge.git
cd FalForge
npm install
npm run electron:dev
```

That builds the renderer and both server bundles, then opens the real desktop
app — same code as the dmg, no quarantine flag, no `xattr`. Run it again any
time; to pick up changes, `git pull` and re-run the same command.

Then jump to **[step 3](#3-add-your-falai-key)** to add your fal key — the rest
of the setup is identical.

> There is also `npm run dev:server:local` + `npm run dev` for browser-based
> frontend work with hot reload, but `render_html` (the agent's HTML-to-PNG
> tool) needs Electron and is unavailable there. Use `electron:dev` unless you
> are specifically iterating on the UI.

---

## 1. Download

Go to **[Releases](https://github.com/idea-torx/FalForge/releases/latest)** and take
the `.dmg` for your Mac:

| Your Mac | File |
|----------|------|
| Apple Silicon (M1–M4) | `Fal-Forge-<version>-arm64.dmg` |
| Intel | `Fal-Forge-<version>-x64.dmg` |

Not sure which you have:  ▸ **About This Mac**. "Chip" means Apple Silicon,
"Processor" means Intel.

Open the dmg and drag **Fal Forge** to Applications.

## 2. First launch — the one awkward step

The app is **not signed with an Apple Developer certificate**, so macOS will
refuse to open it and say it is damaged. It isn't; that message is what macOS
says about any app it can't trace to a paid developer account.

Open Terminal and run this once:

```bash
xattr -dr com.apple.quarantine "/Applications/Fal Forge.app"
```

Then open the app normally. You will not have to do it again — until you install
a new version, which arrives with a fresh quarantine flag.

<details>
<summary>Prefer not to use Terminal?</summary>

Double-click the app, let it be refused, then go to  ▸ **System Settings** ▸
**Privacy & Security**, scroll to the bottom, and click **Open Anyway** next to
the message about Fal Forge. Confirm with **Open**. On recent macOS versions this
sometimes has to be done twice.
</details>

## 3. Add your fal.ai key

Generation is billed to **your own** fal account — there is no shared key.

1. Get a key at <https://fal.ai/dashboard/keys>
2. In the app, click the key icon at the bottom of the left rail → **API keys**
3. Paste it in and save

It is stored locally at `~/.matteblack/config.json` and used only to call fal
directly. Nothing is proxied through a server of ours.

## 4. Optional — the agent panel

The AI agent runs on **your Claude subscription**, not an API key. It works by
driving Claude Code locally, so it needs Claude Code installed and signed in:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Run `claude` once, sign in to your subscription when prompted, quit it, then
reopen the agent panel in Fal Forge. If Claude Code isn't installed the panel
says so and the rest of the app works normally.

---

## Where your work lives

Everything is under `~/.matteblack/`:

| Path | Contents |
|------|----------|
| `pgdata/` | Embedded database — projects, canvases, asset metadata |
| `uploads/` | Every image, video and audio file you generate or upload |
| `skills/` | Your skills, as editable markdown |
| `config.json` | Your API keys |

Deleting that folder resets the app to a clean slate. It is **not** backed up
anywhere — copy it if you care about it.

## Updating

Running from source: `git pull && npm install && npm run electron:dev`.

Installed from a dmg: download the newer one from Releases and drag it over the
old app, then re-run the `xattr` command from step 2 on the new copy. (Automatic
updates are wired up but inert on macOS until the app is code-signed.)

Either way your `~/.matteblack/` folder is untouched by an update.

## Uninstalling

Delete the clone, or drag `/Applications/Fal Forge.app` to the Trash. Delete
`~/.matteblack/` too if you want your projects and keys gone.

---

## If something goes wrong

**"Fal Forge is damaged and can't be opened"** — step 2 wasn't run, or was run
before the app was moved into Applications. Run it again against the path the app
is actually at.

**The app opens but generation fails** — no fal key, or a key with no credit.
Check the key icon in the left rail.

**The agent panel says Claude Code isn't installed** — step 4. It has to be on
your `PATH` for the app to find it; `which claude` in Terminal should print a
path.

**A generation runs forever** — check <https://status.fal.ai>. Nothing about the
app is involved once a job is with fal.

Anything else: open an issue with what you did and what the app said.
