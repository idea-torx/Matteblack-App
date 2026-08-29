// Brand IQ — lightweight URL crawler.
//
// Fetches an HTML page with a short timeout, parses out useful brand
// signals (title, meta description, og:* tags, headings, visible body
// text snippet), and returns a structured object the synthesize endpoint
// can feed to Claude as evidence. Failures are returned as { ok: false,
// error } rather than thrown so the caller can persist a status per URL
// without aborting an entire batch.
//
// SSRF defense: every URL — including each redirect target — is resolved
// through the system DNS resolver and rejected if any candidate IP falls
// inside a private / loopback / link-local / reserved range. We also
// require https/http scheme and a default port (no scanning :22, :3306,
// :6379 etc.) so a user can't aim the server-side fetcher at internal
// services or cloud-metadata endpoints (169.254.169.254).

import { promises as dns } from "node:dns";
import net from "node:net";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 800_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_HEADINGS = 30;
const MAX_REDIRECTS = 4;

export type CrawlEvidence = {
  url: string;
  ok: boolean;
  status?: number;
  fetched_at: string;
  title?: string;
  description?: string;
  og?: Record<string, string>;
  headings?: { level: 1 | 2 | 3; text: string }[];
  text?: string;
  error?: string;
  // Resolved absolute URL of the page's favicon (best-effort: rel="icon"
  // or rel="shortcut icon"; falls back to /favicon.ico). Empty when the
  // page declares none and the fallback wasn't validated.
  favicon_url?: string;
  // Single hex color string lifted from the page's <meta name="theme-color">
  // tag (and <meta name="msapplication-TileColor"> as a fallback). This is
  // the closest stand-in we have for "dominant brand color" without
  // pulling and decoding the OG image. Synthesize uses it as one more
  // palette evidence signal.
  dominant_color?: string;
  // Lifecycle marker used by the routes layer when a crawl is enqueued
  // and resolved asynchronously. 'pending' means the row was queued but
  // the background fetcher hasn't completed it yet; 'ok'/'error' echo the
  // final outcome. Absent on legacy rows — treat that as 'ok'.
  state?: "pending" | "ok" | "error";
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

// IPv4 ranges to deny: loopback, private, link-local, CGNAT, broadcast,
// metadata, multicast, reserved. IPv6 ranges to deny: loopback, unique
// local, link-local, IPv4-mapped private equivalents.
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fec0:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — recheck the embedded v4.
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

async function assertPublicHost(hostname: string): Promise<{ ok: true } | { ok: false; error: string }> {
  // Block raw IPs that point at private space directly (e.g. 169.254.169.254).
  const ipKind = net.isIP(hostname);
  if (ipKind === 4) {
    return isPrivateIPv4(hostname)
      ? { ok: false, error: "URL resolves to a non-public address" }
      : { ok: true };
  }
  if (ipKind === 6) {
    return isPrivateIPv6(hostname)
      ? { ok: false, error: "URL resolves to a non-public address" }
      : { ok: true };
  }
  // Reject obvious local hostnames before even resolving.
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return { ok: false, error: "URL resolves to a non-public address" };
  }
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, error: "DNS lookup failed" };
  }
  if (addrs.length === 0) return { ok: false, error: "DNS lookup returned no addresses" };
  for (const a of addrs) {
    const bad = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address);
    if (bad) return { ok: false, error: "URL resolves to a non-public address" };
  }
  return { ok: true };
}

function validateUrlForFetch(u: URL): { ok: true } | { ok: false; error: string } {
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "Only http/https URLs are supported" };
  }
  // Lock down to default ports — refuse arbitrary :22, :3306, :11211, etc.
  if (u.port && u.port !== "" && u.port !== "80" && u.port !== "443") {
    return { ok: false, error: "Only default http/https ports are supported" };
  }
  return { ok: true };
}

// Manual redirect handling so each hop is re-validated against the SSRF
// rules (a public hostname can otherwise CNAME / 302 onto a private one).
async function fetchWithSafeRedirects(
  startUrl: URL,
  signal: AbortSignal,
): Promise<{ ok: true; resp: Response; finalUrl: string } | { ok: false; error: string; status?: number }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const v = validateUrlForFetch(current);
    if (!v.ok) return { ok: false, error: v.error };
    const guard = await assertPublicHost(current.hostname);
    if (!guard.ok) return { ok: false, error: guard.error };
    let resp: Response;
    try {
      resp = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MatteBrandIQ/1.0; +https://matte.run)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Fetch failed";
      return { ok: false, error: msg };
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return { ok: false, error: `Redirect ${resp.status} with no Location`, status: resp.status };
      let next: URL;
      try { next = new URL(loc, current); }
      catch { return { ok: false, error: "Invalid redirect target", status: resp.status }; }
      current = next;
      continue;
    }
    return { ok: true, resp, finalUrl: current.toString() };
  }
  return { ok: false, error: "Too many redirects" };
}

export async function crawlUrl(rawUrl: string): Promise<CrawlEvidence> {
  const fetchedAt = new Date().toISOString();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, ok: false, fetched_at: fetchedAt, error: "Invalid URL" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const f = await fetchWithSafeRedirects(parsed, controller.signal);
    if (!f.ok) {
      return { url: parsed.toString(), ok: false, status: f.status, fetched_at: fetchedAt, error: f.error };
    }
    const resp = f.resp;
    if (!resp.ok) {
      return { url: f.finalUrl, ok: false, status: resp.status, fetched_at: fetchedAt, error: `HTTP ${resp.status}` };
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("xml") && !ct.includes("text")) {
      return { url: f.finalUrl, ok: false, status: resp.status, fetched_at: fetchedAt, error: `Unsupported content-type: ${ct}` };
    }
    // Cap body read so a runaway page doesn't blow memory.
    const buf = await resp.arrayBuffer();
    const sliced = buf.byteLength > MAX_BODY_BYTES ? buf.slice(0, MAX_BODY_BYTES) : buf;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(sliced);

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(stripTags(titleMatch[1])).slice(0, 250) : undefined;

    let description: string | undefined;
    let dominantColor: string | undefined;
    let tileColor: string | undefined;
    const og: Record<string, string> = {};
    const metaRe = /<meta\b([^>]*)>/gi;
    let metaMatch: RegExpExecArray | null;
    while ((metaMatch = metaRe.exec(html))) {
      const tag = metaMatch[0];
      const name = (pickAttr(tag, "name") || pickAttr(tag, "property") || "").toLowerCase();
      const content = pickAttr(tag, "content");
      if (!name || !content) continue;
      if (name === "description" && !description) {
        description = decodeHtmlEntities(content).slice(0, 500);
      } else if (name === "theme-color" && !dominantColor) {
        // Normalize: only accept #rrggbb / #rgb forms.
        const v = content.trim();
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) dominantColor = v;
      } else if (name === "msapplication-tilecolor" && !tileColor) {
        const v = content.trim();
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) tileColor = v;
      } else if (name.startsWith("og:") || name.startsWith("twitter:")) {
        og[name] = decodeHtmlEntities(content).slice(0, 500);
      }
    }
    if (!dominantColor && tileColor) dominantColor = tileColor;

    // Favicon: prefer an explicit <link rel="icon" href="..."> tag (any
    // rel that contains the word "icon"); fall back to the conventional
    // /favicon.ico at the page origin. We don't fetch it here — just
    // surface the absolute URL so the panel/synthesize step can reference
    // or render it.
    let faviconUrl: string | undefined;
    const linkRe = /<link\b([^>]*)>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRe.exec(html))) {
      const tag = linkMatch[0];
      const rel = (pickAttr(tag, "rel") || "").toLowerCase();
      if (!rel.includes("icon")) continue;
      const href = pickAttr(tag, "href");
      if (!href) continue;
      try {
        faviconUrl = new URL(href, f.finalUrl).toString();
        break;
      } catch { /* skip invalid hrefs */ }
    }
    if (!faviconUrl) {
      try { faviconUrl = new URL("/favicon.ico", f.finalUrl).toString(); }
      catch { /* ignore */ }
    }

    const headings: { level: 1 | 2 | 3; text: string }[] = [];
    const headRe = /<h([123])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
    let hMatch: RegExpExecArray | null;
    while ((hMatch = headRe.exec(html)) && headings.length < MAX_HEADINGS) {
      const level = parseInt(hMatch[1], 10) as 1 | 2 | 3;
      const text = decodeHtmlEntities(stripTags(hMatch[2])).slice(0, 200);
      if (text) headings.push({ level, text });
    }

    const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[0] : html;
    const text = decodeHtmlEntities(stripTags(bodyHtml)).slice(0, MAX_TEXT_CHARS);

    return {
      url: f.finalUrl,
      ok: true,
      status: resp.status,
      fetched_at: fetchedAt,
      title,
      description,
      og,
      headings,
      text,
      favicon_url: faviconUrl,
      dominant_color: dominantColor,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Crawl failed";
    return { url: parsed.toString(), ok: false, fetched_at: fetchedAt, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
