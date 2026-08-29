import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "del", "span",
];

const ALLOWED_ATTR = ["href", "title", "target", "rel", "class"];

export function renderMarkdown(text: string): string {
  if (!text) return "";
  let html: string;
  try {
    html = marked.parse(text, { async: false }) as string;
  } catch {
    return escapeHtml(text);
  }
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
  return ensureSafeLinks(sanitized);
}

function ensureSafeLinks(html: string): string {
  // Force every anchor to open in a new tab with safe rel.
  return html.replace(/<a\s+([^>]*?)>/gi, (match, attrs: string) => {
    const hasHref = /\bhref=/i.test(attrs);
    if (!hasHref) return match;
    let next = attrs;
    if (!/\btarget=/i.test(next)) next += ` target="_blank"`;
    if (!/\brel=/i.test(next)) next += ` rel="noopener noreferrer"`;
    else next = next.replace(/\brel=("|')(.*?)\1/i, (_m, q, val) => {
      const parts = new Set(String(val).split(/\s+/).filter(Boolean));
      parts.add("noopener");
      parts.add("noreferrer");
      return `rel=${q}${Array.from(parts).join(" ")}${q}`;
    });
    return `<a ${next}>`;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
