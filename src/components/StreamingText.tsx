import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./StreamingText.css";

/* Words resolve out of blur as they arrive.
 *
 * The whole trick is the key: each word keeps its index, so React reuses its
 * DOM node across chunks and only the newly appended spans run the animation.
 * Re-rendering the text as innerHTML (what the settled markdown path does)
 * replaces the subtree every chunk, which would restart every word's animation
 * at once — hence a separate component for the streaming phase only.
 *
 * Inline emphasis is resolved as it arrives so the reader never watches raw
 * `**` markers get typed out and then vanish on stream-end. An unclosed marker
 * opens and runs to the end of what's revealed, which is exactly right for a
 * cursor that is mid-word: the bold simply starts, then the rest joins it.
 *
 * ponytail: emphasis and inline code only, not a markdown tokenizer — block
 * structure (headings, lists, tables) is half-formed mid-stream anyway, and the
 * finished message re-renders through renderMarkdown the moment the stream
 * ends. */

type Seg = { text: string; bold: boolean; italic: boolean; code: boolean };

/** Split revealed text into runs carrying their emphasis. Markers are consumed,
 *  so they never reach the DOM; an unterminated one stays open to the end. */
function segments(src: string): Seg[] {
  const out: Seg[] = [];
  let buf = "", bold = false, italic = false, code = false;
  const push = () => { if (buf) out.push({ text: buf, bold, italic, code }); buf = ""; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    // Inside a code span nothing else is a marker — that's what backticks mean.
    if (c === "`") { push(); code = !code; continue; }
    if (!code && c === "*") {
      push();
      if (src[i + 1] === "*") { bold = !bold; i++; } else { italic = !italic; }
      continue;
    }
    buf += c;
  }
  push();
  return out;
}
/** Nearest ancestor that actually scrolls, or null. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
  }
  return null;
}

export function StreamingText({ text }: { text: string }) {
  // Keep the separators so indentation and blank lines survive; pre-wrap does
  // the rest.
  const parts = useMemo(() => text.split(/(\s+)/), [text]);
  // Reveal on our own clock rather than at the model's. Chunks land as whole
  // paragraphs, so painting them on arrival makes the block appear and then
  // restyle; a cursor walking the token list turns that back into typing.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= parts.length) return;
    // Catch-up: the further behind the cursor is, the more it takes per tick,
    // so a 200-word chunk drains in about a second while a steady trickle
    // still lands one word at a time.
    const step = Math.max(1, Math.ceil((parts.length - shown) / 40));
    const t = setTimeout(() => setShown((s) => Math.min(parts.length, s + step)), 26);
    return () => clearTimeout(t);
  }, [shown, parts.length]);

  // The transcript's own auto-scroll pins on new *messages*, but the reveal
  // grows the text between them — so each tick has to keep itself in view or
  // the tail slides under the composer. Stops the moment the reader scrolls
  // up, same as the transcript's own stick-to-bottom rule.
  const hostRef = useRef<HTMLParagraphElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = (scrollerRef.current ||= scrollParent(hostRef.current));
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const segs = useMemo(() => segments(parts.slice(0, shown).join("")), [parts, shown]);

  // One counter across every segment: the key is what makes React reuse a
  // word's node between chunks, so it has to keep counting past a segment
  // boundary rather than restarting inside each run.
  let w = 0;
  return (
    <p className="streaming-text" ref={hostRef}>
      {segs.map((seg) =>
        seg.text.split(/(\s+)/).map((part) =>
          /^\s+$/.test(part) || !part ? part : (
            <span
              key={w++}
              className={`streaming-text__word${seg.bold ? " streaming-text__word--b" : ""}${seg.italic ? " streaming-text__word--i" : ""}${seg.code ? " streaming-text__word--c" : ""}`}
            >
              {part}
            </span>
          ),
        ),
      )}
      <span className="streaming-text__caret" aria-hidden="true" />
    </p>
  );
}

export default StreamingText;
