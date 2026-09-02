/**
 * Matteblack MCP bridge (Phase J2) — a stdio Model Context Protocol server that
 * lets a Claude *subscription* client (Claude Desktop / Claude Code) drive the
 * local Matteblack generation harness.
 *
 * This process is spawned by the Claude client (`node dist-mcp/index.js` or
 * `tsx server/mcp/index.ts`). It is SEPARATE from the Express app: it finds the
 * running app via a discovery file (`<dataDir>/mcp-endpoint.json`, written by the
 * server on boot) and talks to it over HTTP loopback:
 *
 *   Claude client ──stdio(JSON-RPC)──▶ this server ──HTTP──▶ Fal Forge app
 *                                                          GET  /api/agent/tools
 *                                                          POST /api/agent/tool
 *                                                          GET  /api/job/:id  (poll)
 *
 * The three generation tools are request/response here (unlike the in-app SSE
 * agent): each call dispatches a job and BLOCKS, polling the job to completion,
 * then returns the result URL. Claude-the-client handles multi-step orchestration
 * natively, so none of the in-app prompt gymnastics are needed.
 *
 * CRITICAL: stdout is the JSON-RPC transport. NEVER write to stdout. All logs go
 * to stderr via `logErr`.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveLocalPath } from "../utils/localPath.js";
import { applyExactPatch } from "../skills/patchText.js";
import { parseToolAllowlist } from "./toolAllowlist.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Resolve the data dir the same way server/config/runtime.ts does, without
 *  importing it (keeps this a small standalone bundle and avoids its boot
 *  side-effects). */
function resolveDataDir(): string {
  return process.env.MATTEBLACK_DATA_DIR || path.join(os.homedir(), ".matteblack");
}

const ENDPOINT_FILE = path.join(resolveDataDir(), "mcp-endpoint.json");

/** Optional per-process tool allowlist (see toolAllowlist.ts). Read once: the
 *  spawning runner sets MB_TOOLS for the life of the turn. */
const TOOL_ALLOWLIST = parseToolAllowlist(process.env.MB_TOOLS);

/** Overall poll budget. Images/music land in seconds; video can take minutes,
 *  so default generously. Override with MB_MCP_TIMEOUT_MS. */
const POLL_TIMEOUT_MS = Number(process.env.MB_MCP_TIMEOUT_MS) || 8 * 60 * 1000;
const POLL_INTERVAL_MS = Number(process.env.MB_MCP_POLL_MS) || 2000;

function logErr(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[matteblack-mcp]", ...args);
}

// ---------------------------------------------------------------------------
// Discovery + HTTP helpers
// ---------------------------------------------------------------------------

interface Endpoint {
  baseUrl: string;
  token?: string;
}

/** Read the discovery file each time (the app may (re)start on a new ephemeral
 *  port between calls). Returns null if the app isn't running / hasn't published. */
function readEndpoint(): Endpoint | null {
  try {
    const raw = fs.readFileSync(ENDPOINT_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Endpoint>;
    if (parsed && typeof parsed.baseUrl === "string" && parsed.baseUrl) {
      return { baseUrl: parsed.baseUrl.replace(/\/+$/, ""), token: parsed.token };
    }
  } catch {
    /* not running / not yet published */
  }
  return null;
}

/** Thrown when the app isn't reachable — surfaced to Claude as a clear, actionable
 *  tool error rather than a stack trace. */
class AppUnavailableError extends Error {}

function authHeaders(ep: Endpoint): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // J3 will enforce this token via middleware; harmless for the app to ignore now.
  if (ep.token) h["x-matteblack-token"] = ep.token;
  // Which writer this is, for the skill-library write guard. The after-turn
  // review pass gets its own MCP config with MB_SKILL_ACTOR=review; every other
  // client (a live operator turn, Claude Desktop) is a foreground operator.
  h["x-falforge-actor"] = process.env.MB_SKILL_ACTOR === "review" ? "review" : "operator";
  return h;
}

async function httpJson(
  ep: Endpoint,
  method: "GET" | "POST" | "PUT",
  route: string,
  body?: unknown,
  timeoutMs = 15000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ep.baseUrl}${route}`, {
      method,
      headers: authHeaders(ep),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Connection refused / DNS / abort → the app is down.
    throw new AppUnavailableError(
      `Could not reach the Fal Forge app at ${ep.baseUrl} (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : undefined) || `HTTP ${res.status}`;
    const e = new Error(msg) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tool schema discovery (live, with an embedded fallback so tools still list
// when the app isn't running yet)
// ---------------------------------------------------------------------------

const EMBEDDED_TOOLS: Tool[] = [
  {
    name: "generate_media",
    description:
      "Generate an image or video from a text prompt (optionally with reference image URLs). Blocks until the result is ready and returns its URL; the result also lands on the Fal Forge canvas. Connect the running Fal Forge app for the full, tuned schema.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "video"], description: "What to generate." },
        prompt: { type: "string", description: "The generation prompt." },
        tier: { type: "string", enum: ["quick", "standard", "pro"], description: "Quality/speed tier; picks the model." },
        model: { type: "string", description: "Explicit model key (overrides tier). Custom model keys reported by list_models are accepted here too." },
        aspectRatio: { type: "string", description: "e.g. \"1:1\", \"16:9\", \"9:16\"." },
        resolution: { type: "string", description: "e.g. \"1080p\" (video)." },
        durationSeconds: { type: "number", description: "Video length in seconds." },
        referenceUrls: {
          type: "array",
          items: { type: "string" },
          description: "Up to 4 reference image URLs (http(s)).",
        },
      },
      required: ["kind", "prompt"],
    },
  },
  {
    name: "continue_video",
    description:
      "Continue an existing video clip with a new clip that picks up where it ended (MiniMax H3 Max or Seedance 2.5). Call repeatedly, feeding each result URL back as the next sourceUrl, to build video past the 15s per-clip limit. Connect the running Fal Forge app for the full, tuned schema.",
    inputSchema: {
      type: "object",
      properties: {
        sourceUrl: { type: "string", description: "URL of the clip to continue from." },
        prompt: { type: "string", description: "What happens in this chunk only. End on a holdable rest pose for seam='frame', or on the motion the next chunk continues for seam='reference'." },
        model: { type: "string", enum: ["h3-max", "seedance-2.5"], description: "Model family (default h3-max). seedance-2.5 takes chunks up to 30s and does native audio; keep one family per sequence." },
        seam: { type: "string", enum: ["frame", "reference"], description: "'frame' (default) starts on the source's exact last frame; 'reference' uses its final seconds as a motion reference." },
        durationSeconds: { type: "integer", description: "Chunk length (default 5). h3-max 5-15s, seedance-2.5 4-30s." },
        tailSeconds: { type: "number", description: "seam='reference' only: seconds of tail to reference, 2-15 (default 6)." },
        referenceUrls: {
          type: "array",
          items: { type: "string" },
          description: "seam='reference' only: up to 4 image URLs of the sequence's locked subjects, pinned on every chunk so identity survives past the tail.",
        },
        aspectRatio: { type: "string", enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], description: "The sequence's aspect ratio. Defaults to the source clip's shape on either seam." },
        generateAudio: { type: "boolean", description: "Whether this chunk generates its own audio (default true). Pass false on every chunk of a scored piece so no chunk starts a competing bed." },
      },
      required: ["sourceUrl", "prompt"],
    },
  },
  {
    name: "generate_music",
    description:
      "Generate music/audio from a prompt (and optional lyrics). Blocks until ready and returns the audio URL. Connect the running Fal Forge app for the full schema.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description / style of the music." },
        lyrics: { type: "string", description: "Optional lyrics." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_voiceover",
    description:
      "Speak a line of script aloud (narration, voiceover, dialogue). Blocks until ready and returns the audio URL, which you can lay on a cut's audio track with set_timeline. Connect the running Fal Forge app for the full schema.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact words to speak." },
        voice: { type: "string", description: "Voice id, e.g. \"Friendly_Person\", \"Deep_Voice_Man\"." },
        speed: { type: "number", description: "0.5-2.0, default 1.0." },
        emotion: { type: "string", enum: ["neutral", "happy", "sad", "angry"] },
      },
      required: ["text"],
    },
  },
  {
    name: "transform_media",
    description:
      "Transform an existing image by URL (edit / upscale / background-remove / etc.). Requires a reference image URL in referenceUrls. Blocks until ready and returns the result URL. Connect the running Fal Forge app for the full schema.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "The transform to apply (e.g. edit, upscale, remove_background)." },
        prompt: { type: "string", description: "Instruction for edit-style operations." },
        referenceUrls: {
          type: "array",
          items: { type: "string" },
          description: "Exactly one source image URL (http(s)).",
        },
      },
      required: ["operation", "referenceUrls"],
    },
  },
];

/** Read-only tools served entirely by the MCP server (they hit dedicated app
 *  endpoints, not /api/agent/tools). Let Claude see the canvas + available models
 *  so it can target existing assets as references. */
const READ_TOOLS: Tool[] = [
  {
    name: "list_models",
    description: "List the generation models available in Matteblack and their media type (image/video/audio). Use to self-document what can be generated.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_canvas",
    description:
      "List recent completed generations on the Fal Forge canvas (most recent first) with their id, media type, model, result URL, and prompt. Pass a returned `url` back in `referenceUrls` of generate_media/transform_media to iterate on it.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (1–50, default 20)." },
        workspace_id: { type: "string", description: "Optional workspace to scope to." },
        canvas_id: { type: "string", description: "Optional canvas id (resolves to its workspace)." },
      },
    },
  },
  {
    name: "get_asset",
    description:
      "Fetch one asset by id (from list_canvas). Returns its metadata and, for images, an inline thumbnail so you can see the result and decide next steps.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The asset/job id." } },
      required: ["id"],
    },
  },
  {
    name: "list_skills",
    description:
      "List the user's saved skills — reusable generation recipes they've written down (video scripts, house styles, prompt formulas). Call this FIRST when the user names a skill, says 'use my <x> skill', or asks for something you've made before: a skill carries their exact working prompts, so following one beats improvising.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_repos",
    description:
      "List the GitHub repositories the user attached, in their priority order, with the absolute path each is checked out at. Call this when the user refers to a repo (\"from my site repo\", \"match the brand in X\"), then read the files yourself with Read/Grep/Glob to get real context before writing prompts. It also reports each repo's live git state — branch, last commit, uncommitted changes — and whether the user has enabled authoring on it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "checkout_branch",
    description:
      "Point one attached repo's local checkout at a branch, so everything you read afterwards is that branch's code — use it when the user says \"work from the redesign branch\" or names a PR branch. Refuses if the checkout has uncommitted changes; commit them with `commit_repo` first. This only moves the local clone.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, exactly as `list_repos` reports it." },
        branch: { type: "string", description: "Branch name on the remote, e.g. feat/new-hero." },
      },
      required: ["repo", "branch"],
    },
  },
  {
    name: "commit_repo",
    description:
      "Commit everything you changed in an attached repo, push the branch, and open a pull request if one isn't open yet. Only works on repos where the user explicitly enabled authoring — otherwise it is refused, and that is the user's call, not something to work around. Never commits to the default branch: pass a working `branch` (or check one out first). You cannot merge, and nothing here installs or runs the project — a human reviews and merges the PR.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, exactly as `list_repos` reports it." },
        message: { type: "string", description: "Commit message. The first line also titles the PR, so write it as a real summary of the change." },
        branch: { type: "string", description: "Branch to commit on. Defaults to whatever is checked out; required if that is the default branch." },
      },
      required: ["repo", "message"],
    },
  },
  {
    name: "get_timeline",
    description:
      "Read every cinema frame on the user's canvas — each one's clips in play order, with its nodeId. A canvas can hold several separate cuts. Call this before editing an existing sequence so you reorder/replace against what's actually there, and so you know which nodeId to extend.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_timeline",
    description:
      "Lay a finished sequence on a cinema frame: pass the FULL ordered clip list and the clips are placed end to end from t=0, with the music bed under them. This is the assembly step — after generating the shots for a long-form piece, call this so the user opens a real cut rather than loose clips on the canvas. Declarative WITHIN ONE FRAME: whatever you send becomes that frame's sequence, so reorder, replace a bad shot, or drop one by sending the list again without it. It never overwrites a cut you did not target — with no `nodeId` it writes to an empty frame or adds a new one.",
    inputSchema: {
      type: "object",
      properties: {
        clips: {
          type: "array",
          description: "The shots in play order.",
          items: {
            type: "object",
            properties: {
              src: { type: "string", description: "The generated clip's URL, from the generation result." },
              durationSeconds: { type: "number", description: "The clip's length in seconds — the duration you generated it at." },
              label: { type: "string", description: 'Short shot name, e.g. "Shot 3 — push in on the logo".' },
            },
            required: ["src"],
          },
        },
        nodeId: {
          type: "string",
          description:
            "The cinema frame to write to, from get_timeline. Pass this to EXTEND or edit an existing cut — the frame's clip list is replaced by what you send, so include the clips already there plus the new ones. Omit it for a new piece.",
        },
        newNode: {
          type: "boolean",
          description:
            "Force a brand new cinema frame even if an empty one exists. Only needed when the user explicitly asks for a separate cut.",
        },
        muteVideoAudio: {
          type: "boolean",
          description:
            "Mute the video track, so only the music bed is heard. Generated clips carry their own audio (dialogue, room tone, effects) which fights a music bed laid under them. Pass true when the user asks for music over the picture, or for a silent cut; leave unset to keep the clips' own sound. Reversible — send the list again without it.",
        },
        audio: {
          type: "array",
          description:
            "The cut's audio, laid on as many parallel audio tracks as you use — a music bed, a voiceover, effects, all playing together and mixed on export. Declarative like the clips: sending this replaces every audio track on the frame, so include the beds already there plus the new ones. Leave the key out entirely to keep the existing audio untouched. Durations are measured off the file, so omit durationSeconds unless you want a bed deliberately cut short.",
          items: {
            type: "object",
            properties: {
              src: { type: "string", description: "Audio URL from generate_music / generate_voiceover / generate_media." },
              track: { type: "number", description: "Which audio track, 0-7 (default 0). Put the music bed on one track and the voiceover on another so they play at once — two beds on the SAME track play one after the other." },
              startSeconds: { type: "number", description: "When it starts, in seconds from the top of the cut (default 0). This is how a voiceover is cut to picture." },
              volume: { type: "number", description: "0-1, default 0.8. Duck the music (~0.25) when a voiceover plays over it." },
              durationSeconds: { type: "number", description: "Optional. Measured off the file when omitted." },
              label: { type: "string", description: 'What it is, e.g. "VO — line 2".' },
            },
            required: ["src"],
          },
        },
        music: {
          type: "object",
          description: "Shorthand for a single music bed at t=0 — same thing as one entry in `audio`. Ignored when `audio` is given.",
          properties: {
            src: { type: "string" },
            durationSeconds: { type: "number" },
            volume: { type: "number", description: "0-1, default 0.8." },
          },
        },
      },
      required: ["clips"],
    },
  },
  {
    name: "save_cut",
    description:
      "Record a finished sequence in the user's local cut history — one markdown manifest per cut, committed to a per-project git repo on their machine. Call this right after `set_timeline`, whenever a multi-shot piece is done. It saves the recipe, not the video: the look, the settings, and the exact prompt and clip URL for every shot, so the piece can be revisited, varied or rebuilt later. Write real prose in `description` — it is how the cut gets found again months later, so describe what it actually looks like rather than restating the title.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The ongoing project this belongs to, kebab-case, e.g. 'acme-launch'. Reuse the SAME project across related cuts — that is what groups the history. Check `list_cuts` first." },
        title: { type: "string", description: "This cut's name, e.g. 'Rooftop teaser'." },
        description: { type: "string", description: "Two or three sentences on what the piece looks like and does. Written for a future search: name the subject, setting, mood and any distinctive visual." },
        status: { type: "string", description: "'draft' (default), 'shipped', or 'abandoned'." },
        model: { type: "string", description: "The model every shot was generated with." },
        aspectRatio: { type: "string" },
        resolution: { type: "string" },
        look: { type: "string", description: "The bible's look line — stock, lens, grade, lighting." },
        subjects: { type: "string", description: "The locked subject descriptions, verbatim." },
        notes: { type: "string", description: "What worked, what to change next time." },
        shots: {
          type: "array",
          description: "Every shot in play order — the same list you sent to set_timeline, plus the prompts.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              prompt: { type: "string", description: "The EXACT prompt used, not a paraphrase." },
              bridge: { type: "string", description: "What carried over from the previous shot." },
              reference: { type: "string", description: "Keyframe / reference URL this shot was generated from." },
              src: { type: "string", description: "The finished clip URL." },
              durationSeconds: { type: "number" },
            },
          },
        },
        music: {
          type: "object",
          properties: { prompt: { type: "string" }, src: { type: "string" } },
        },
      },
      required: ["project", "title", "description", "shots"],
    },
  },
  {
    name: "list_cuts",
    description:
      "Read the user's cut history. With no arguments: the projects that have saved cuts. With `project`: that project's index, newest first, one line per cut. With `project` and `file`: the full manifest — every prompt, setting and clip URL. Call this BEFORE starting work that continues or resembles something the user has made before, so a follow-up matches the original instead of drifting. To rebuild a past cut, read its manifest and pass its clip URLs to `set_timeline` in order.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug, from the no-argument listing." },
        file: { type: "string", description: "A manifest filename from the project index, e.g. '2026-08-29-rooftop-teaser.md'." },
      },
    },
  },
  {
    name: "render_html",
    description:
      "Render a complete HTML/CSS document to a PNG and place it on the user's canvas as an ordinary image — programmatic art, no model and no cost. Use this for anything better drawn than generated: type-led posters, quiz cards, receipts, chat screenshots, charts, layouts with real text. Write ONE self-contained document (inline all CSS; no external files, no scripts needed) sized to the exact pixels you pass. To put real imagery in the page — a generated character as a sticker, a photo as a background, a logo from the user's repo — pass `images` and reference each one as `asset:NAME` in your CSS or markup; the pixels are attached server-side and never enter this conversation. The result behaves like any other image on the canvas, so it can be exported in a frame, laid on the cinema timeline, or fed to `transform_media`. To revise a piece, call `get_html` for its markup, then call this again with the same `nodeId` and an `edits` list of exact find/replace pairs — that is far faster than re-sending the whole document, and it never drifts from what is on the canvas. Send `html` again only when the change is structural. Never redraw from memory.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The complete document, CSS inlined in a <style> block. Set the body/page size in CSS to match width/height exactly, with no margin, or the capture will have gutters. Omit when passing `edits`." },
        edits: {
          type: "array",
          description: "Revise the stored markup of `nodeId` in place instead of re-sending it. Each `find` must appear EXACTLY once in the document (copy it verbatim from get_html; add surrounding text to disambiguate) or the whole call is rejected without rendering. Width, height and images are inherited from the node unless you pass them.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Exact text to replace, copied from get_html." },
              replace: { type: "string", description: "What to put in its place." },
            },
            required: ["find", "replace"],
          },
        },
        width: { type: "number", description: "Output width in pixels, e.g. 1080. Default 1080." },
        height: { type: "number", description: "Output height in pixels, e.g. 1350 for 4:5. Default 1350." },
        label: { type: "string", description: "Short name for the node, e.g. 'Quiz card 3'." },
        nodeId: { type: "string", description: "Re-render an existing piece in place (from a previous render_html or get_html). Omit to place a new one." },
        images: {
          type: "object",
          description: "Imagery to embed, as { name: pathOrUrl }. The name is yours to pick ([A-Za-z0-9_-], up to 8 entries); reference it in the document as `asset:name` — e.g. background: url(asset:hero) or <img src=\"asset:logo\">. Each value is a canvas/generation URL (from generate_media or list_canvas), an https URL, or an absolute path on this machine (or ~/...) such as a file in the user's repo. The bytes are read on the server and inlined into the page, so nothing about the image is sent back to you. Anything that can't be read comes back in `missing` instead of silently rendering blank.",
          additionalProperties: { type: "string" },
        },
      },
      required: [],
    },
  },
  {
    name: "get_html",
    description:
      "Read back the exact HTML/CSS a `render_html` piece was made from, so an edit starts from the real markup instead of a reconstruction. Call this before every revision to a piece you did not write in this conversation, then revise it with render_html's `edits`.",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string", description: "The node id returned by render_html." } },
      required: ["nodeId"],
    },
  },
  {
    name: "get_skill",
    description:
      "Read one skill's full markdown by slug (from list_skills). Follow its instructions and reuse its prompts verbatim unless the user asks to vary them.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "The skill slug from list_skills." } },
      required: ["slug"],
    },
  },
  {
    name: "save_skill",
    description:
      "Save a skill back to the user's library as markdown (creates or overwrites by slug). Use it when the user says to save/remember a recipe, or when a generation run worked well and is worth repeating — write down the ACTUAL prompts and model/aspect/tier settings you used, not a paraphrase, so the run can be reproduced. Include a `---\nname: …\ndescription: …\n---` header.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Short kebab-case id, e.g. 'product-hero-loop'." },
        body: { type: "string", description: "The full markdown document." },
      },
      required: ["slug", "body"],
    },
  },
  {
    name: "patch_skill",
    description:
      "Make one small exact edit to an existing skill — the right tool when the user corrects how you handled something, or you learn a better way to do a class of task. `old` must appear EXACTLY once in the skill (copy it verbatim from get_skill, whitespace included); it is replaced by `new`, or deleted when `new` is empty. Prefer this over rewriting the whole skill with save_skill: it keeps the rest of the document intact. Every write is versioned and the user can restore, so a small correction is cheap.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The skill slug from list_skills." },
        old: { type: "string", description: "The exact existing text to replace. Must occur exactly once." },
        new: { type: "string", description: "The replacement text. Empty string deletes the matched text." },
      },
      required: ["slug", "old", "new"],
    },
  },
  {
    name: "recall",
    description:
      "Read your private working memory about this user — corrections they've given you, defaults they prefer, approaches that didn't land. Call this at the START of any substantive piece of work, before you pick models, prompts or structure. This is YOUR memory, not a document the user wrote and not something they see in the app: apply it silently rather than reading it back to them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remember",
    description:
      "Write a note to your private working memory so future sessions start where this one ended. Use it whenever you learn something durable about how this user wants things done: a correction they made, a preference they stated, a model or setting they rejected, a workflow that worked. One fact per note. Re-use an existing slug to correct or replace a note rather than accumulating near-duplicates. Write it as a directive to your future self ('Default to 9:16 — user reframes 16:9 every time'), not as a diary entry. Do not announce that you are saving a memory.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Short kebab-case id, e.g. 'prefers-vertical-aspect'. Reuse to overwrite." },
        note: { type: "string", description: "The fact, plus why it matters, in a sentence or two." },
      },
      required: ["slug", "note"],
    },
  },
  {
    name: "forget",
    description: "Delete one note from your private working memory, by slug. Use it when a note has been proven wrong or the user's preference has changed.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "The note's slug, from recall." } },
      required: ["slug"],
    },
  },
  {
    name: "read_local_file",
    description:
      "Read a UTF-8 text file from this machine by absolute path (or ~/...). Use it for briefs, scripts, brand guidelines, copy decks, code and README files the user points you at — read what the source actually says instead of asking them to paste it. Binary files are refused; use get_asset for media.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or one starting with ~/." },
        maxBytes: { type: "number", description: "Truncate after this many bytes (default 200000)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_local_dir",
    description:
      "List the entries of a directory on this machine by absolute path (or ~/...), so you can find the file you need before calling read_local_file. Returns names, whether each is a directory, and byte sizes.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, or one starting with ~/." } },
      required: ["path"],
    },
  },
  {
    name: "estimate_cost",
    description:
      "What a generation would cost in USD — fal.ai's actual price, no markup, since the user pays fal directly with their own key. Omit `model` to price every model at once and recommend the cheapest that fits. Call this before an expensive generation (video especially: clips range from a few cents to several dollars) or whenever the user asks what something costs.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model key (from list_models). Omit to price the whole catalog." },
        duration: { type: "number", description: "Output length in seconds, for video/audio." },
        resolution: { type: "string", description: 'Resolution token, e.g. "1k", "2k", "720p", "1080p".' },
        features: {
          type: "array",
          items: { type: "string" },
          description: 'Feature flags that change the price, e.g. ["generate_audio"].',
        },
        quantity: { type: "number", description: "Number of outputs (default 1)." },
        characters: { type: "number", description: "Character count, for text-to-speech." },
      },
    },
  },
  {
    name: "search_fal_models",
    description:
      "Search fal.ai's public model catalog by keyword (e.g. \"upscale\", \"lipsync\", \"flux\"). Returns endpoint ids you can inspect with get_fal_model_schema and install with add_model. Use when the user asks for something the installed models (list_models) don't cover.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Free-text search, e.g. \"video upscale\"." } },
      required: ["query"],
    },
  },
  {
    name: "get_fal_model_schema",
    description:
      "Inspect one fal.ai endpoint before installing it: its input fields (type, enum, default, required), the media type it produces, and its price if fal reports one. Read this before add_model so you can set sensible `defaults`.",
    inputSchema: {
      type: "object",
      properties: { endpointId: { type: "string", description: 'A fal endpoint id, e.g. "fal-ai/flux/schnell".' } },
      required: ["endpointId"],
    },
  },
  {
    name: "add_model",
    description:
      "Install a fal.ai endpoint as a usable Matteblack model. It appears in the Make panel with a schema-driven control panel and can be generated with immediately via generate_media model=<key>. Inspect it with get_fal_model_schema first.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string", description: 'A fal endpoint id, e.g. "fal-ai/flux/schnell".' },
        key: { type: "string", description: "Model key to install under (default: derived from the endpoint id)." },
        title: { type: "string", description: "Label shown in the Make panel (default: the endpoint id)." },
        type: { type: "string", enum: ["image", "video", "audio"], description: "Override the media type inferred from the output schema." },
        defaults: { type: "object", description: "Default values for input fields, e.g. {\"num_inference_steps\": 4}." },
      },
      required: ["endpointId"],
    },
  },
];

interface LiveToolDef {
  name: string;
  description?: string;
  inputSchema?: Tool["inputSchema"];
}

/** Adapt a generation tool's schema for THIS transport: the in-app schema attaches
 *  references via `referenceImageIds` (an in-app 'canvas:N' catalog that doesn't
 *  exist over the bridge), so advertise `referenceUrls` — the field the bridge
 *  actually resolves — as the way to attach references. */
function adaptForBridge(tool: Tool): Tool {
  if (tool.name !== "generate_media" && tool.name !== "transform_media") return tool;
  const schema = (tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }) as {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
  };
  const isTransform = tool.name === "transform_media";
  const props: Record<string, object> = { ...(schema.properties ?? {}) };
  props.referenceUrls = {
    type: "array",
    items: { type: "string" },
    maxItems: 4,
    description:
      "Reference image URL(s), http(s). Over this bridge, attach references by URL here (get URLs from list_canvas / get_asset) — NOT via referenceImageIds." +
      (isTransform ? " REQUIRED: the single source image to transform." : ""),
  };
  // The in-app schema tells the model to STOP and ask the user which reference
  // mode they meant whenever an image is attached to a video request. In the app
  // that's right — the image is something the user dropped and the intent is
  // ambiguous. Over this bridge the reference is the operator's own keyframe, so
  // the same sentence turns every shot of a multi-clip sequence into a question
  // and the run never finishes. Replace it with the rule that actually applies.
  if (!isTransform && props.videoReferenceMode) {
    props.videoReferenceMode = {
      ...(props.videoReferenceMode as Record<string, unknown>),
      description:
        "How the referenceUrls are used in a video: 'first_frame' (one image starts the clip — the default for a keyframe you generated), 'first_last_frame' (two images, start and end, Veo 3.1 Lite only), 'references' (2-4 images blended). Over this bridge the references are YOURS, so pick the mode and generate — never stop to ask the user. If you omit it, first_frame is assumed for one URL and references for several.",
    };
  }
  const bridgeNote = isTransform ? "" :
    " Over this bridge you attach references by URL in `referenceUrls` and choose `videoReferenceMode` yourself — do not stop to ask the user which mode they meant. Building a sequence: keep model, aspect ratio, resolution and duration identical across every shot, generate in story order, then call `set_timeline` with the whole ordered list.";
  return {
    ...tool,
    description: (tool.description ?? "") + bridgeNote,
    inputSchema: { ...schema, properties: props } as Tool["inputSchema"],
  };
}

/** Fetch the live tool schemas from the app; fall back to the embedded copy so
 *  Claude always sees the three tools even before the app is open. */
async function listTools(): Promise<Tool[]> {
  const all = await listAllTools();
  return TOOL_ALLOWLIST ? all.filter((t) => TOOL_ALLOWLIST.has(t.name)) : all;
}

async function listAllTools(): Promise<Tool[]> {
  const ep = readEndpoint();
  if (!ep) return [...EMBEDDED_TOOLS.map(adaptForBridge), ...READ_TOOLS];
  try {
    const data = (await httpJson(ep, "GET", "/api/agent/tools", undefined, 4000)) as { tools?: LiveToolDef[] };
    const live = Array.isArray(data?.tools) ? data.tools : [];
    const gen: Tool[] = live.length === 0
      ? EMBEDDED_TOOLS
      : live.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema as Tool["inputSchema"]) ?? { type: "object" as const },
        }));
    return [...gen.map(adaptForBridge), ...READ_TOOLS];
  } catch (err) {
    logErr("live tool discovery failed, using embedded schemas:", err instanceof Error ? err.message : err);
    return [...EMBEDDED_TOOLS.map(adaptForBridge), ...READ_TOOLS];
  }
}

// ---------------------------------------------------------------------------
// Job dispatch + block-and-poll
// ---------------------------------------------------------------------------

interface JobRow {
  job_id?: string;
  id?: string;
  status?: string;
  progress?: number;
  result_url?: string | null;
  error?: string | null;
  error_type?: string | null;
  type?: string;
  model?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A reference the bridge can actually forward.
 *
 *  In the desktop build a generated result is re-hosted onto the app's own
 *  storage, so `list_canvas` hands the model a relative `/uploads/...` URL —
 *  which an https-only guard here silently dropped, taking every reference the
 *  model correctly passed back with it. The server resolves local URLs to
 *  fal-reachable ones at dispatch (makeReferencesFalReachable), so they only
 *  ever needed to survive the trip. Same guard, same fix as `usableSrc` in
 *  routes/agentTimeline.ts. */
function usableRef(u: unknown): u is string {
  return typeof u === "string" && (/^https?:\/\//i.test(u) || u.startsWith("/uploads/"));
}

/** Pull any caller-supplied reference URLs out of the tool arguments so they can
 *  be passed at the top level of /api/agent/tool (the endpoint resolves refs as
 *  URLs; canvas-id resolution arrives in J3's canvas tools). */
function extractReferenceUrls(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["referenceUrls", "referenceImageUrls", "imageUrls"]) {
    const v = args[key];
    if (Array.isArray(v)) {
      for (const u of v) if (usableRef(u)) out.push(u);
    }
  }
  // Single-URL convenience fields.
  for (const key of ["imageUrl", "image_url", "referenceUrl"]) {
    if (usableRef(args[key])) out.push(args[key] as string);
  }
  return out.slice(0, 4);
}

type ProgressFn = (progress: number, message: string) => void;

async function pollToCompletion(ep: Endpoint, jobId: string, onProgress?: ProgressFn): Promise<JobRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  // The job row can briefly 404 immediately after dispatch; tolerate a few.
  let notFound = 0;
  let transient = 0;
  while (Date.now() < deadline) {
    // Fetch is fallible (network / transient app errors) — retry those. Status
    // interpretation lives OUTSIDE the catch so a terminal "failed" propagates
    // instead of being mistaken for a network blip and retried forever.
    let job: JobRow;
    try {
      job = (await httpJson(ep, "GET", `/api/job/${jobId}`, undefined, 15000)) as JobRow;
    } catch (err) {
      if (err instanceof AppUnavailableError) throw err;
      const status = (err as { status?: number }).status;
      if (status === 404) {
        if (++notFound > 5) throw new Error(`Job ${jobId} not found.`);
      } else if (++transient > 5) {
        throw err;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    notFound = 0;
    transient = 0;
    // Terminal success — the app marks finished jobs 'complete' (also accept
    // 'completed'/'succeeded' defensively). Anything else terminal is a failure.
    if (job.status === "complete" || job.status === "completed" || job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "cancelled" || job.status === "canceled") {
      throw new Error(job.error || job.error_type || `Generation ${job.status}.`);
    }
    // queued / processing → report progress (this resets the MCP client's request
    // timeout, so long video/image jobs don't get cut off at the default ~60s).
    onProgress?.(typeof job.progress === "number" ? job.progress : 0, job.status || "processing");
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s waiting for job ${jobId}. It may still be running in the app.`,
  );
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  onProgress?: ProgressFn,
): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) {
    return fail(
      "The Fal Forge app isn't running (no endpoint published). Open the Matteblack desktop app, then try again.",
    );
  }

  const referenceUrls = extractReferenceUrls(args);
  // Send the tool args through as `input`; the app's parse*/build* functions read
  // exactly the fields they expect. referenceUrls are lifted to the top level.
  const payload = { tool: name, input: args, referenceUrls };

  let dispatch: { jobId?: string; type?: string; model?: string; canvasId?: string };
  try {
    dispatch = (await httpJson(ep, "POST", "/api/agent/tool", payload, 30000)) as typeof dispatch;
  } catch (err) {
    if (err instanceof AppUnavailableError) return fail(err.message + " Is the Fal Forge app still open?");
    return fail(`Couldn't start the generation: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!dispatch?.jobId) {
    return fail("The app accepted the request but returned no job id.");
  }

  let job: JobRow;
  try {
    job = await pollToCompletion(ep, dispatch.jobId, onProgress);
  } catch (err) {
    if (err instanceof AppUnavailableError) return fail(err.message + " Is the Fal Forge app still open?");
    return fail(`Generation did not complete: ${err instanceof Error ? err.message : String(err)}`);
  }

  const url = job.result_url || "(no url returned)";
  const lines = [
    `✅ ${dispatch.type ?? name} complete.`,
    `Model: ${dispatch.model ?? job.model ?? "unknown"}`,
    `Result: ${url}`,
  ];
  if (dispatch.canvasId) lines.push(`Placed on canvas: ${dispatch.canvasId}`);
  // Terminal on purpose. This used to end with a note about thumbnails arriving
  // "in a later phase", which read as "you cannot see it yet" and sent the agent
  // off to get_asset / list_canvas to check its own work — so the turn kept
  // running long after the image was already on the user's canvas.
  //
  // continue_video is the one exception: a chunk is a step in a sequence, not a
  // finished piece, so the blanket "stop now" would end a long-form build after
  // its first clip. It still gets the no-verifying rule — just not the stop.
  if (name === "continue_video") {
    lines.push(
      "",
      `This is one chunk of a longer sequence. To continue, call continue_video again with sourceUrl: ${url}`,
      "Keep going until the sequence you and the user agreed on is complete. Then call set_timeline " +
        "with every chunk in play order — a chain is a single continuous piece, and leaving it as loose " +
        "cards on the canvas means the user has to assemble by hand what you already know the order of. " +
        "Then say in one line that the cut is on the timeline BEFORE you write save_cut — the user is waiting on that line, not the manifest. " +
        "Do NOT call get_asset or list_canvas to check this chunk — it is already on the user's canvas.",
    );
  } else {
    lines.push(
      "",
      "Done — the user can already see this on their canvas. Nothing further is required for this " +
        "generation: do NOT call get_asset, list_canvas or any other tool to verify or look at it, and do " +
        "not regenerate it unless the user asks. If this is one shot of a sequence you agreed with the user, go straight on to the next shot; otherwise say one short line about what you made and stop.",
    );
  }
  return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Read tools (list_models / list_canvas / get_asset)
// ---------------------------------------------------------------------------

const NOT_RUNNING =
  "The Fal Forge app isn't running (no endpoint published). Open the Matteblack desktop app, then try again.";

function errToFail(err: unknown): CallToolResult {
  if (err instanceof AppUnavailableError) return fail(err.message + " Is the Fal Forge app still open?");
  return fail(err instanceof Error ? err.message : String(err));
}

async function runListModels(): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const data = (await httpJson(ep, "GET", "/api/agent/models")) as { models?: { key: string; type: string }[] };
    const models = data.models ?? [];
    if (models.length === 0) return ok("No models reported by the app.");
    const groups: Record<string, string[]> = {};
    for (const m of models) (groups[m.type] ??= []).push(m.key);
    const lines = ["Available generation models:"];
    for (const [type, keys] of Object.entries(groups)) lines.push(`\n${type}:\n  ${keys.join(", ")}`);
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

interface AssetRow {
  id: string;
  type: string;
  model: string;
  url: string;
  prompt?: string;
  createdAt?: string;
}

async function runListCanvas(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const qs = new URLSearchParams();
  if (typeof args.limit === "number") qs.set("limit", String(args.limit));
  if (typeof args.workspace_id === "string") qs.set("workspace_id", args.workspace_id);
  if (typeof args.canvas_id === "string") qs.set("canvas_id", args.canvas_id);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    const data = (await httpJson(ep, "GET", `/api/agent/assets${suffix}`)) as { assets?: AssetRow[] };
    const assets = data.assets ?? [];
    if (assets.length === 0) return ok("No generations on the canvas yet.");
    const lines = [`${assets.length} recent generation(s) (most recent first):`, ""];
    for (const a of assets) {
      const p = a.prompt ? ` — "${a.prompt.slice(0, 80)}${a.prompt.length > 80 ? "…" : ""}"` : "";
      lines.push(`• [${a.type}] ${a.id}${p}`);
      lines.push(`  model: ${a.model}  url: ${a.url}`);
    }
    lines.push("", "Pass a url in `referenceUrls` to iterate on it, or call get_asset with an id to view it.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

/** Loopback-fetch an image and return it as an inline MCP image block (the MCP
 *  server can reach loopback URLs that the Claude client cannot). Returns null if
 *  not an image, unreachable, or too large to inline. */
async function fetchThumbnail(ep: Endpoint, url: string): Promise<{ data: string; mimeType: string } | null> {
  const target = /^https?:\/\//i.test(url) ? url : `${ep.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(target, { headers: { "x-matteblack-token": ep.token ?? "" }, signal: ctrl.signal });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") || "image/png";
    if (!mimeType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 1_500_000) return null; // too large to inline; leave the url
    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runGetAsset(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) return fail("get_asset requires an `id`.");
  try {
    const a = (await httpJson(ep, "GET", `/api/agent/asset/${encodeURIComponent(id)}`)) as AssetRow & {
      status?: string;
      error?: string | null;
    };
    const meta = [
      `Asset ${a.id}`,
      `type: ${a.type}`,
      `model: ${a.model}`,
      a.status ? `status: ${a.status}` : "",
      a.prompt ? `prompt: ${a.prompt}` : "",
      `url: ${a.url ?? "(none)"}`,
    ].filter(Boolean).join("\n");

    const content: CallToolResult["content"] = [{ type: "text", text: meta }];
    // Job types are e.g. "text_to_image"/"image_to_image" (not "image"); embed a
    // thumbnail whenever the type or url looks like an image. fetchThumbnail
    // self-guards on the response content-type + a size cap, so this is safe even
    // if the guess is wrong (video/audio → returns null, no huge download).
    const looksImage = /image/i.test(a.type ?? "") || /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i.test(a.url ?? "");
    if (looksImage && a.url) {
      const thumb = await fetchThumbnail(ep, a.url);
      if (thumb) content.push({ type: "image", data: thumb.data, mimeType: thumb.mimeType });
    }
    return { content };
  } catch (err) {
    return errToFail(err);
  }
}

interface CostRow {
  model: string;
  usd: number;
  accuracy: "exact" | "approx";
  basis: string;
}

async function runEstimateCost(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const data = (await httpJson(ep, "POST", "/api/agent/cost", args)) as { estimates?: CostRow[] };
    const rows = data.estimates ?? [];
    if (rows.length === 0) return ok("No fal pricing available for that model.");
    const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);

    if (rows.length === 1) {
      const r = rows[0];
      const tilde = r.accuracy === "approx" ? "about " : "";
      return ok(`${r.model}: ${tilde}${money(r.usd)} — ${r.basis}\n\nThis is fal.ai's price at cost; the user pays it directly from their own fal balance.`);
    }

    const sorted = [...rows].sort((a, b) => a.usd - b.usd);
    const lines = [
      `Cost for these parameters across ${sorted.length} models, cheapest first (fal.ai's price at cost — the user pays it directly):`,
      "",
    ];
    for (const r of sorted) {
      lines.push(`• ${r.model}: ${r.accuracy === "approx" ? "~" : ""}${money(r.usd)} (${r.basis})`);
    }
    lines.push("", "Prices for models whose parameters you didn't supply assume defaults, so compare like with like.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

interface SkillRow { slug: string; title: string; description?: string; updatedAt?: string }

async function runListSkills(): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const data = (await httpJson(ep, "GET", "/api/skills")) as { skills?: SkillRow[] };
    const skills = data.skills ?? [];
    if (skills.length === 0) return ok("The skill library is empty. Save one with save_skill when a run is worth repeating.");
    const lines = [`${skills.length} skill(s):`, ""];
    for (const sk of skills) {
      lines.push(`• ${sk.slug} — ${sk.title}${sk.description ? `: ${sk.description}` : ""}`);
    }
    lines.push("", "Call get_skill with a slug to read one in full before following it.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

type RepoRow = {
  nameWithOwner: string; description: string; dir: string; files?: number; syncedAt?: string; error?: string;
  writable?: boolean;
  git?: { branch: string; sha: string; subject: string; author: string; committedAt: string; dirty: number; ahead: number; behind: number } | null;
};

async function runListRepos(): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const { repos } = (await httpJson(ep, "GET", "/api/github/repos")) as { repos: RepoRow[] };
    if (!repos.length) return ok("No repos attached. The user can attach one in the GitHub panel.");
    const lines = ["Attached repos, highest priority first:"];
    for (const r of repos) {
      lines.push(`• ${r.nameWithOwner} — ${r.dir || "(not cloned)"}${r.files ? ` (${r.files} files)` : ""}${r.description ? ` — ${r.description}` : ""}${r.error ? ` [sync error: ${r.error}]` : ""}`);
      if (r.git) {
        const state = [r.git.dirty ? `${r.git.dirty} uncommitted` : "clean", r.git.ahead ? `${r.git.ahead} ahead` : "", r.git.behind ? `${r.git.behind} behind` : ""].filter(Boolean).join(", ");
        lines.push(`    on ${r.git.branch} · ${state} · last commit ${r.git.sha} ${r.git.subject} (${r.git.author})`);
      }
      lines.push(`    authoring: ${r.writable ? "ENABLED — you may edit files here and call commit_repo" : "off (read-only)"}`);
    }
    lines.push("", "Read these with your own Read/Grep/Glob tools.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

async function runCheckoutBranch(a: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const repo = typeof a.repo === "string" ? a.repo : "";
  const branch = typeof a.branch === "string" ? a.branch : "";
  if (!repo || !branch) return fail("Both `repo` (owner/name) and `branch` are required.");
  try {
    const r = (await httpJson(ep, "POST", "/api/github/repos/branch", { nameWithOwner: repo, branch })) as RepoRow;
    return ok(`${repo} is now on ${r.git?.branch ?? branch} (${r.git?.sha ?? "?"} ${r.git?.subject ?? ""}). Re-read the files — they changed.`);
  } catch (err) {
    return errToFail(err);
  }
}

async function runCommitRepo(a: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const repo = typeof a.repo === "string" ? a.repo : "";
  const message = typeof a.message === "string" ? a.message : "";
  const branch = typeof a.branch === "string" ? a.branch : undefined;
  if (!repo || !message) return fail("Both `repo` (owner/name) and `message` are required.");
  try {
    const r = (await httpJson(ep, "POST", "/api/github/repos/commit", { nameWithOwner: repo, message, branch }, 900_000)) as
      { branch: string; sha: string; pushed: boolean; prUrl?: string };
    return ok(`Committed ${r.sha} on ${r.branch} and pushed.${r.prUrl ? ` PR: ${r.prUrl}` : " No PR URL came back — check the repo on GitHub."} A human reviews and merges it; you cannot.`);
  } catch (err) {
    return errToFail(err);
  }
}

type TimelineClipRow = { src: string; durationSeconds: number; startsAt: number; label: string };

async function runGetTimeline(): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const t = (await httpJson(ep, "GET", "/api/agent/timeline")) as {
      timelines: {
        nodeId: string; label: string; clips: TimelineClipRow[];
        audio?: { src: string; durationSeconds: number; startsAt: number; label: string; track: number }[];
        music: { src: string; durationSeconds: number } | null; muteVideoAudio?: boolean;
      }[];
    };
    const frames = t.timelines ?? [];
    if (!frames.length || frames.every((f) => !f.clips.length)) {
      return ok(
        frames.length
          ? `An empty cinema frame is ready (nodeId: ${frames[0].nodeId}). Generate the shots, then call set_timeline with the ordered list.`
          : "The canvas has no cinema frame yet. Generate the shots, then call set_timeline with the ordered list.",
      );
    }
    const lines: string[] = [];
    for (const f of frames) {
      const total = f.clips.reduce((n, c) => n + (c.durationSeconds || 0), 0);
      lines.push(`${f.label} (nodeId: ${f.nodeId}) — ${f.clips.length} clips, ${total.toFixed(1)}s:`);
      f.clips.forEach((c, i) => lines.push(`  ${i + 1}. ${c.startsAt.toFixed(1)}s +${c.durationSeconds}s — ${c.label || "(unnamed)"} — ${c.src}`));
      for (const a of f.audio ?? []) {
        lines.push(`  Audio track ${a.track}: ${a.startsAt.toFixed(1)}s +${a.durationSeconds.toFixed(1)}s — ${a.label || "(unnamed)"} — ${a.src}`);
      }
      if (!f.audio && f.music) lines.push(`  Music: ${f.music.src}`);
      if (f.muteVideoAudio) lines.push("  Video track is MUTED — only the music bed is audible.");
    }
    lines.push("Pass a nodeId to set_timeline to extend that cut; omit it to start a new one.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

async function runSetTimeline(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const clips = Array.isArray(args.clips) ? args.clips : [];
  if (!clips.length) return fail("set_timeline requires a `clips` array in play order.");
  try {
    const r = (await httpJson(
      ep, "POST", "/api/agent/timeline",
      { clips,
        // Only forward the keys the caller actually sent: on this route the
        // presence of `audio`/`music` is what says "rewrite the audio tracks",
        // so passing `music: null` unconditionally would wipe the bed on every
        // clip-only call.
        ...("audio" in args ? { audio: args.audio } : {}),
        ...("music" in args ? { music: args.music } : {}),
        muteVideoAudio: args.muteVideoAudio === true,
        nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined, newNode: args.newNode === true },
      60000,
    )) as { clips: number; audioClips?: number; totalSeconds: number; muteVideoAudio: boolean; nodeId: string };
    return ok(
      `Timeline set on cinema frame ${r.nodeId}: ${r.clips} clips, ${r.totalSeconds.toFixed(1)}s` +
        (r.audioClips ? `, ${r.audioClips} audio clip(s)` : "") +
        `${r.muteVideoAudio ? ", video audio muted" : ""}. ` +
        "Pass that nodeId back to set_timeline to extend this same cut. The user can play it in the cinema frame and export from there.",
    );
  } catch (err) {
    return errToFail(err);
  }
}

async function runSaveCut(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  if (!Array.isArray(args.shots) || args.shots.length === 0) return fail("save_cut requires a `shots` array in play order.");
  if (typeof args.description !== "string" || !args.description.trim()) {
    return fail("save_cut requires a `description` — a couple of sentences on what the piece looks like, so it can be found again.");
  }
  try {
    const r = (await httpJson(ep, "POST", "/api/agent/cut", args, 60000)) as {
      project: string; file: string; runtime: number; committed: boolean; gitError?: string; promptSaved?: boolean;
    };
    const where = `${r.project}/${r.file}`;
    const filed = r.promptSaved ? " The look is now in the user's Prompts library too." : "";
    return ok(
      (r.committed
        ? `Saved and committed to the ${r.project} cut history as ${where} (${Math.round(r.runtime)}s). Read it back any time with list_cuts.`
        : `Saved to ${where}, but the git commit failed: ${r.gitError || "unknown error"}. The manifest is on disk either way.`) + filed,
    );
  } catch (err) {
    return errToFail(err);
  }
}

async function runListCuts(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const project = typeof args.project === "string" ? args.project : "";
  const file = typeof args.file === "string" ? args.file : "";
  const query = project
    ? `?project=${encodeURIComponent(project)}${file ? `&file=${encodeURIComponent(file)}` : ""}`
    : "";
  try {
    const r = (await httpJson(ep, "GET", `/api/agent/cuts${query}`)) as {
      projects?: { project: string; cuts: number }[]; index?: string; body?: string;
    };
    if (r.body) return ok(r.body);
    if (r.index) return ok(r.index);
    const projects = r.projects ?? [];
    if (!projects.length) return ok("No cuts saved yet. After you assemble a sequence with set_timeline, call save_cut to start the history.");
    const lines = ["Projects with saved cuts:"];
    for (const p of projects) lines.push(`\u2022 ${p.project} — ${p.cuts} cut(s)`);
    lines.push("", "Call list_cuts with a project to see its index.");
    return ok(lines.join("\n"));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return fail(`Nothing saved under "${project}"${file ? `/${file}` : ""}. Call list_cuts with no arguments to see what exists.`);
    return errToFail(err);
  }
}

async function runRenderHtml(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
  if (!hasEdits && (typeof args.html !== "string" || !args.html.trim())) {
    return fail("render_html requires a complete `html` document, or `edits` plus the `nodeId` to apply them to.");
  }
  if (hasEdits && typeof args.nodeId !== "string") return fail("`edits` revises an existing piece — pass its `nodeId` too.");
  try {
    const r = (await httpJson(ep, "POST", "/api/agent/render-html", {
      html: args.html,
      edits: hasEdits ? args.edits : undefined,
      width: args.width,
      height: args.height,
      label: args.label,
      nodeId: args.nodeId,
      images: args.images,
    }, 60000)) as { nodeId: string; src: string; width: number; height: number; replaced: boolean; missing?: string[]; problems?: string[] };
    const missing = r.missing?.length
      ? `\nCouldn't read: ${(r.problems?.length ? r.problems : r.missing).join("; ")} — those asset: references rendered blank.`
      : "";
    return ok(
      `${r.replaced ? "Re-rendered" : "Rendered"} ${r.width}x${r.height} and placed on the canvas.\nnodeId: ${r.nodeId}\nURL: ${r.src}${missing}\nPass that nodeId back to render_html with \`edits\` to revise it, or the URL to transform_media / set_timeline.`,
    );
  } catch (err) {
    return errToFail(err);
  }
}

async function runGetHtml(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const nodeId = typeof args.nodeId === "string" ? args.nodeId : "";
  if (!nodeId) return fail("get_html requires the `nodeId` render_html returned.");
  try {
    const r = (await httpJson(ep, "GET", `/api/agent/html/${encodeURIComponent(nodeId)}`)) as {
      html: string; width: number | null; height: number | null; images?: Record<string, string>;
    };
    // The markup keeps its `asset:` placeholders, so the map has to come back
    // with it — re-rendering without it drops every image on the page.
    const imgs = r.images && Object.keys(r.images).length
      ? `\nimages: ${JSON.stringify(r.images)}  (pass these back to render_html unchanged)`
      : "";
    return ok(`${r.width ?? "?"}x${r.height ?? "?"}${imgs}\n\n${r.html}`);
  } catch (err) {
    return errToFail(err);
  }
}

async function runGetSkill(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const slug = typeof args.slug === "string" ? args.slug : "";
  if (!slug) return fail("get_skill requires a `slug`.");
  try {
    const sk = (await httpJson(ep, "GET", `/api/skills/${encodeURIComponent(slug)}`)) as SkillRow & { body?: string };
    return ok(`# ${sk.title} (${sk.slug})\n\n${sk.body ?? ""}`);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return fail(`No skill called "${slug}". Call list_skills to see what exists.`);
    return errToFail(err);
  }
}

async function runSaveSkill(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const slug = typeof args.slug === "string" ? args.slug : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!slug || !body) return fail("save_skill requires both `slug` and `body`.");
  try {
    const saved = (await httpJson(ep, "PUT", `/api/skills/${encodeURIComponent(slug)}`, { body })) as SkillRow;
    return ok(`Saved skill "${saved.title}" as ${saved.slug}. It's in the user's Skills panel now.`);
  } catch (err) {
    return errToFail(err);
  }
}

async function runPatchSkill(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const slug = typeof args.slug === "string" ? args.slug : "";
  const oldText = typeof args.old === "string" ? args.old : "";
  const newText = typeof args.new === "string" ? args.new : "";
  if (!slug || !oldText) return fail("patch_skill requires a `slug` and a non-empty `old` string.");
  try {
    const sk = (await httpJson(ep, "GET", `/api/skills/${encodeURIComponent(slug)}`)) as SkillRow & { body?: string };
    const patched = applyExactPatch(sk.body ?? "", oldText, newText);
    if (!patched.ok) return fail(patched.error);
    await httpJson(ep, "PUT", `/api/skills/${encodeURIComponent(slug)}`, { body: patched.body });
    return ok(`Patched skill "${slug}".`);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return fail(`No skill called "${slug}". Call list_skills to see what exists.`);
    return errToFail(err);
  }
}

// ---------------------------------------------------------------------------
// Private agent memory + local files
//
// Both run entirely inside this bridge process — no HTTP hop, so they work
// whether or not the desktop app happens to be open, and memory never travels
// over an endpoint the app's UI could call.
// ---------------------------------------------------------------------------

const MEMORY_DIR = path.join(resolveDataDir(), "agent-memory");

/** Filename-safe id, and the trust boundary: the result can never contain a
 *  path separator or dots, so a slug cannot escape MEMORY_DIR. */
function memorySlug(input: string): string {
  return input.toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 64);
}

function runRecall(): CallToolResult {
  let files: string[];
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
  } catch (err) {
    return fail(`Couldn't read memory: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (files.length === 0) {
    return ok("No memory yet. As you learn how this user works, save it with `remember`.");
  }
  const notes = files
    .map((f) => {
      const full = path.join(MEMORY_DIR, f);
      return { slug: f.slice(0, -3), body: fs.readFileSync(full, "utf8").trim(), at: fs.statSync(full).mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((n) => n.body);
  return ok(
    "Your private notes on this user (newest first). Not visible to them anywhere in " +
    "the app — apply them silently rather than reading them back.\n\n" +
    notes.map((n) => `- (${n.slug}) ${n.body}`).join("\n"),
  );
}

function runRemember(args: Record<string, unknown>): CallToolResult {
  const slug = memorySlug(typeof args.slug === "string" ? args.slug : "");
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!slug || !note) return fail("remember requires both `slug` and `note`.");
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEMORY_DIR, `${slug}.md`), note, "utf8");
  } catch (err) {
    return fail(`Couldn't save memory: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ok(`Noted as "${slug}".`);
}

function runForget(args: Record<string, unknown>): CallToolResult {
  const slug = memorySlug(typeof args.slug === "string" ? args.slug : "");
  if (!slug) return fail("forget requires a `slug`.");
  const p = path.join(MEMORY_DIR, `${slug}.md`);
  if (!fs.existsSync(p)) return fail(`No memory called "${slug}". Call recall to see what's there.`);
  try { fs.unlinkSync(p); } catch (err) {
    return fail(`Couldn't delete memory: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ok(`Forgot "${slug}".`);
}

function runReadLocalFile(args: Record<string, unknown>): CallToolResult {
  const r = resolveLocalPath(args.path);
  if ("error" in r) return fail(r.error);
  const maxBytes = typeof args.maxBytes === "number" && args.maxBytes > 0
    ? Math.min(args.maxBytes, 2_000_000) : 200_000;
  let stat: fs.Stats;
  try { stat = fs.statSync(r.path); } catch {
    return fail(`No such file: ${r.path}`);
  }
  if (stat.isDirectory()) return fail(`${r.path} is a directory — use list_local_dir.`);
  let buf: Buffer;
  try { buf = fs.readFileSync(r.path); } catch (err) {
    return fail(`Couldn't read ${r.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A NUL in the first block is the cheap, reliable binary tell.
  if (buf.subarray(0, 4096).includes(0)) {
    return fail(`${r.path} looks binary, not text. Use get_asset for media files.`);
  }
  const truncated = buf.length > maxBytes;
  const text = buf.subarray(0, maxBytes).toString("utf8");
  return ok(`${r.path} (${stat.size} bytes)${truncated ? `, truncated to ${maxBytes}` : ""}\n\n${text}`);
}

function runListLocalDir(args: Record<string, unknown>): CallToolResult {
  const r = resolveLocalPath(args.path);
  if ("error" in r) return fail(r.error);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(r.path, { withFileTypes: true }); } catch (err) {
    return fail(`Couldn't list ${r.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (entries.length === 0) return ok(`${r.path} is empty.`);
  const lines = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => {
      if (e.isDirectory()) return `  ${e.name}/`;
      let size = "";
      try { size = ` (${fs.statSync(path.join(r.path, e.name)).size} bytes)`; } catch { /* raced */ }
      return `  ${e.name}${size}`;
    });
  return ok(`${r.path}\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  "Matteblack generates images, video, and music locally using the user's own fal.ai key; every result lands on the user's Fal Forge canvas (a separate window they keep open beside this chat).",
  "",
  "TOOLS: `generate_media` (image or short video), `generate_music` (a music bed), `generate_voiceover` (spoken narration / dialogue), `transform_media` (edit / upscale / remove-background / resize an existing image), `render_html` / `get_html` (programmatic HTML/CSS art rendered to a PNG on the canvas — free, exact, and the right tool for anything type-led). Read tools: `list_canvas` (recent generations + their URLs), `get_asset` (one asset's metadata + an inline image thumbnail), `list_models` (what's installed — including models added at runtime), `search_fal_models` / `get_fal_model_schema` / `add_model` (find a model on fal.ai and install it into the app when nothing installed fits), `estimate_cost` (what a generation costs in USD). Skills: `list_skills` / `get_skill` / `save_skill` / `patch_skill`. Memory: `recall` / `remember` / `forget` (private). Files: `list_local_dir` / `read_local_file`. Repos: `list_repos`. Editing: `get_timeline` / `set_timeline` (assemble generated clips into one sequence on the cinema timeline, with as many parallel audio tracks — music, voiceover, effects — as the piece needs). History: `list_cuts` / `save_cut` (the user's local, git-backed record of every finished piece).",
  "",
  "REPOS: the user can attach GitHub repositories, checked out on this machine. Call `list_repos` for their paths, live git state and authoring flag, and read them with your own file tools when the user references a repo — use what the code, README or brand files actually say rather than guessing. A skill is the recipe, a repo is the subject; combine them when both apply. `checkout_branch` moves a clone onto the branch the user names. On repos where the user enabled authoring you may edit files and call `commit_repo`, which commits to a working branch and opens a PR: never the default branch, never a merge, and never installing or running the project. On every other repo you are read-only — say so rather than trying another route.",
  "SEQUENCES: for anything longer than one shot — an ad, a trailer, a scene — you are the editor, not just the generator. Lock the settings first (one model, one aspect ratio, one resolution, one clip duration) and keep them identical across every shot; generate the shots in story order so each can reference the last; then call `set_timeline` with the full ordered clip list and the music bed. Send the whole list every time — it is the cut. Read it back with `get_timeline` before regenerating a shot, and when a shot is wrong regenerate only that shot and re-send the list with that cut's `nodeId`. A canvas can hold several cuts: always pass the `nodeId` you are extending, and omit it only when the user wants a separate new cut — an existing cut is never overwritten by accident. The `bridge` skill has the continuity method; follow it. For the shots themselves — how a 5s, 10s or 15s H3 Max clip is structured, and the camera grammar for realistic / dramatic / action — read the `cinematographer` skill before writing the prompts.",
  "HISTORY: finished sequences are kept as one markdown manifest per cut in a local git repo per project. Call `list_cuts` before work that continues or resembles something the user has made before — a follow-up should match the original, and the manifest holds the exact prompts and settings that produced it. Call `save_cut` right after `set_timeline` whenever a multi-shot piece is done, reusing the same `project` slug across related cuts. Saving is cheap and local; not saving is how a good run becomes unrepeatable.",
  "MEMORY (private, yours): call `recall` at the start of any substantive piece of work — before you choose models, prompts, aspect ratios or structure — and follow what it says. Call `remember` whenever the user corrects you, states a preference, rejects an option, or a workflow lands well; write it as a directive to your future self, one fact per slug, reusing a slug to replace a stale note. This memory is not shown anywhere in the app and is not the user's document: apply it silently, don't read it back or announce that you're saving to it. Skills are the user's recipes; memory is what you've learned about working with them. It is how you get better across sessions instead of restarting from zero every time.",
  "LOCAL FILES: `list_local_dir` and `read_local_file` read this machine directly by absolute path (or ~/...). When the user points at a brief, script, brand guide, copy deck or repo, open it and use what it actually says rather than asking them to paste it. Credentials files are refused by design — don't try to route around that.",
  "SKILLS: the user keeps reusable recipes — video scripts, house styles, prompt formulas — as markdown in their skill library. Check `list_skills` when they name a skill, ask for 'the usual', or want something you've built before, and follow the skill's prompts verbatim rather than improvising a fresh one. When a run turns out well or the user says to remember it, call `save_skill` with the ACTUAL prompts and settings you used so it reproduces exactly. The library is your own runbook too: when the user corrects how you did something, fix the skill that governed it with `patch_skill` (one exact edit) instead of only remembering it. Every write is versioned and restorable, so a small correction is cheap. Never rewrite a pinned skill or one the user edited by hand without asking.",
  "",
  "COST: the user pays fal.ai directly with their own key, so prices are real money, at cost, and vary hugely — a sound effect is under a cent, a 5s 1080p Seedance clip is over three dollars. Check `estimate_cost` before anything expensive (any video, or a large batch), state the figure, and get a yes before spending. Quote the number plainly ('about $3.40'); don't editorialise about it. For a multi-shot piece, price and approve the WHOLE sequence once, up front — then generate every shot without asking again. Re-asking between shots strands a half-finished sequence, which is worse than the spend.",
  "",
  "BLOCKING & ORCHESTRATION: the generation tools run synchronously — each call waits for the job to finish and returns the result URL. Multi-step work is yours to drive: to make N variations, call `generate_media` N times; to iterate, generate then inspect with `get_asset` then generate again. There is no batching or status-line protocol to follow here — just call the tools.",
  "",
  "REFERENCES (important — differs from the in-app UI): to build on or edit an existing asset, first get its URL from `list_canvas` (or `get_asset`), then pass that URL in `referenceUrls`. Do NOT use `referenceImageIds` or 'canvas:N' / 'agent:N' ids — that catalog belongs to the in-app panel and is not available over this bridge. `transform_media` REQUIRES a source image URL in `referenceUrls`.",
  "",
  "MODEL/TIER: omit `model` and let `tier` choose — 'premium' (best, default), 'quality' (mid), 'quick' (cheap/fast, use only when the user asks for cheap/draft/fast/'save credits'). Set `model` only when the user names one explicitly.",
  "VIDEO references: when attaching a reference to a video, also set `videoReferenceMode` (first_frame / first_last_frame / references). If the user hasn't made the intended mode clear, ask before generating rather than guessing.",
  "ASPECT: default 1:1 unless the subject implies otherwise (e.g. wallpaper → 16:9, phone screen → 9:16).",
  "",
  "FORWARD FAITHFULLY: pass creative requests through as written. The fal.ai providers run their own moderation and return a clear error if something is disallowed, so don't pre-refuse or add disclaimers for ordinary creative work (real people, brands, styles, mature themes are all fine to attempt).",
  "",
  "The Matteblack desktop app must be open. If a tool reports it can't reach the app, ask the user to open it.",
].join("\n");

async function main(): Promise<void> {
  const server = new Server(
    { name: "falforge", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (TOOL_ALLOWLIST && !TOOL_ALLOWLIST.has(name)) {
      return fail(`Tool "${name}" is not enabled for this run.`);
    }
    // Read tools first (no job dispatch / progress).
    if (name === "list_models") return runListModels();
    if (name === "search_fal_models") return runSearchFalModels(args);
    if (name === "get_fal_model_schema") return runGetFalModelSchema(args);
    if (name === "add_model") return runAddModel(args);
    if (name === "list_canvas") return runListCanvas(args);
    if (name === "get_asset") return runGetAsset(args);
    if (name === "estimate_cost") return runEstimateCost(args);
    if (name === "recall") return runRecall();
    if (name === "remember") return runRemember(args);
    if (name === "forget") return runForget(args);
    if (name === "read_local_file") return runReadLocalFile(args);
    if (name === "list_local_dir") return runListLocalDir(args);
    if (name === "list_skills") return runListSkills();
    if (name === "get_skill") return runGetSkill(args);
    if (name === "list_repos") return runListRepos();
    if (name === "checkout_branch") return runCheckoutBranch(args);
    if (name === "commit_repo") return runCommitRepo(args);
    if (name === "get_timeline") return runGetTimeline();
    if (name === "set_timeline") return runSetTimeline(args);
    if (name === "render_html") return runRenderHtml(args);
    if (name === "get_html") return runGetHtml(args);
    if (name === "save_cut") return runSaveCut(args);
    if (name === "list_cuts") return runListCuts(args);
    if (name === "save_skill") return runSaveSkill(args);
    if (name === "patch_skill") return runPatchSkill(args);
    if (name !== "generate_media" && name !== "generate_music" && name !== "generate_voiceover"
        && name !== "transform_media" && name !== "continue_video") {
      return fail(`Unknown tool: ${name}`);
    }
    // If the client passed a progress token, stream progress during the block-and-
    // poll. Emitting progress resets the client's per-request timeout, so long
    // (video / high-res) generations don't get cut off at the client default.
    const progressToken = req.params._meta?.progressToken;
    const onProgress: ProgressFn | undefined =
      progressToken === undefined
        ? undefined
        : (progress, message) => {
            extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, message },
            }).catch((e) => logErr("progress notification failed:", e));
          };
    return runTool(name, args, onProgress);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr(`ready (endpoint file: ${ENDPOINT_FILE})`);
}

// ---------------------------------------------------------------------------
// Model discovery / installation (search_fal_models / get_fal_model_schema / add_model)
// ---------------------------------------------------------------------------

type SchemaField = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
};

/** One line per input field: name (type) [enum] = default — required. */
function summarizeSchema(input: { properties?: Record<string, SchemaField>; required?: string[] }): string[] {
  const req = new Set(input.required ?? []);
  return Object.entries(input.properties ?? {}).map(([name, f]) => {
    const bits = [`  ${name} (${f.type ?? "any"})`];
    if (Array.isArray(f.enum) && f.enum.length) bits.push(`one of ${f.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    if (f.default !== undefined) bits.push(`default ${JSON.stringify(f.default)}`);
    if (req.has(name)) bits.push("REQUIRED");
    return bits.join("  ");
  });
}

async function runSearchFalModels(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("`query` is required.");
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const data = (await httpJson(ep, "GET", `/api/models/search?q=${encodeURIComponent(query)}`, undefined, 20000)) as {
      results?: { endpointId: string; title: string; category: string; description: string }[];
    };
    const results = data.results ?? [];
    if (results.length === 0) return ok(`No fal.ai models matched "${query}".`);
    return ok(
      [`fal.ai models matching "${query}":`, ...results.map((r) => `  ${r.endpointId}  [${r.category}]  ${r.title} — ${r.description}`),
        "", "Inspect one with get_fal_model_schema, then install it with add_model."].join("\n"),
    );
  } catch (err) {
    return errToFail(err);
  }
}

async function runGetFalModelSchema(args: Record<string, unknown>): Promise<CallToolResult> {
  const endpointId = typeof args.endpointId === "string" ? args.endpointId.trim() : "";
  if (!endpointId) return fail("`endpointId` is required.");
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const s = (await httpJson(ep, "GET", `/api/models/schema?endpoint=${encodeURIComponent(endpointId)}`, undefined, 20000)) as {
      endpointId: string;
      type: string;
      input: { properties?: Record<string, SchemaField>; required?: string[] };
    };
    const lines = [`${s.endpointId} — produces ${s.type}`, "", "Input fields:", ...summarizeSchema(s.input)];
    // Price is best-effort: estimate_cost only knows installed models, so a
    // not-yet-installed endpoint simply has no quote to give.
    try {
      const cost = (await httpJson(ep, "POST", "/api/agent/cost", { model: endpointId })) as { estimates?: { usd?: number }[] };
      const usd = cost.estimates?.[0]?.usd;
      if (typeof usd === "number") lines.push("", `Approx cost: $${usd}`);
    } catch { /* no price for an endpoint the app doesn't know yet */ }
    lines.push("", "Install it with add_model.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

async function runAddModel(args: Record<string, unknown>): Promise<CallToolResult> {
  const endpointId = typeof args.endpointId === "string" ? args.endpointId.trim() : "";
  if (!endpointId) return fail("`endpointId` is required.");
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const body: Record<string, unknown> = { endpointId };
    for (const k of ["key", "title", "type", "defaults"]) if (args[k] !== undefined) body[k] = args[k];
    const r = (await httpJson(ep, "POST", "/api/models/custom", body, 30000)) as {
      model?: { key: string; type: string; title: string; falModelId: string };
    };
    const m = r.model;
    if (!m) return fail(`The app did not return a model for "${endpointId}".`);
    return ok(
      `Installed ${m.falModelId} as "${m.key}" (${m.type}).\n` +
        `It's in the Make panel now and usable via generate_media model=${m.key}.`,
    );
  } catch (err) {
    return errToFail(err);
  }
}

main().catch((err) => {
  logErr("fatal:", err);
  process.exit(1);
});
