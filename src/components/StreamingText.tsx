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
 * ponytail: split on whitespace, not a markdown tokenizer — mid-stream markdown
 * is half-formed anyway, and the finished message re-renders through
 * renderMarkdown the moment the stream ends. */
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

  return (
    <p className="streaming-text" ref={hostRef}>
      {parts.slice(0, shown).map((part, i) =>
        /^\s+$/.test(part) ? part : (
          <span key={i} className="streaming-text__word">{part}</span>
        ),
      )}
      <span className="streaming-text__caret" aria-hidden="true" />
    </p>
  );
}

export default StreamingText;
