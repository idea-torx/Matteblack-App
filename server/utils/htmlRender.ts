/**
 * HTML/CSS -> PNG, rendered by the Electron main process.
 *
 * The Express server runs as an Electron `utilityProcess` child with no window
 * of its own, so it posts the markup up the built-in parent port and gets PNG
 * bytes back (electron/main.cjs `handleRenderHtml`). Outside the desktop build
 * there is no parent port and `canRenderHtml()` is false.
 */
import { randomUUID } from "node:crypto";

interface ParentPort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort ?? null;

/** One visible element of a rendered page, in CSS pixels of the render. */
export type HtmlElement = { tag: string; text: string; bbox: [number, number, number, number] };
/** A nudge for the element at walk index `i`, in CSS pixels of the render. */
export type HtmlMove = { i: number; dx: number; dy: number };
/** `html` is only present when moves were applied: the markup with them baked in. */
export type HtmlRender = { png: Buffer; map: HtmlElement[]; html?: string };

const pending = new Map<string, { resolve: (r: HtmlRender) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

port?.on("message", (e) => {
  const m = e.data as { type?: string; id?: string; png?: string; map?: HtmlElement[]; html?: string; error?: string } | null;
  if (!m || m.type !== "render-html-result" || typeof m.id !== "string") return;
  const waiting = pending.get(m.id);
  if (!waiting) return; // already timed out
  pending.delete(m.id);
  clearTimeout(waiting.timer);
  if (typeof m.png === "string") waiting.resolve({ png: Buffer.from(m.png, "base64"), map: Array.isArray(m.map) ? m.map : [], html: typeof m.html === "string" ? m.html : undefined });
  else waiting.reject(new Error(m.error || "Render produced no image."));
});

export function canRenderHtml(): boolean {
  return port !== null;
}

/** ponytail: flat 30s ceiling — art pages are static, so slower means hung. */
const RENDER_TIMEOUT_MS = 30_000;

export function renderHtmlToPng(html: string, width: number, height: number, moves?: HtmlMove[]): Promise<HtmlRender> {
  if (!port) return Promise.reject(new Error("HTML rendering is only available in the desktop app."));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Render timed out after 30s."));
    }, RENDER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ type: "render-html", id, html, width, height, moves });
  });
}
