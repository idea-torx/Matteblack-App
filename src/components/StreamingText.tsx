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
export function StreamingText({ text }: { text: string }) {
  // Keep the separators so indentation and blank lines survive; pre-wrap does
  // the rest.
  const parts = text.split(/(\s+)/);
  return (
    <p className="streaming-text">
      {parts.map((part, i) =>
        /^\s+$/.test(part) ? part : (
          <span key={i} className="streaming-text__word">{part}</span>
        ),
      )}
      <span className="streaming-text__caret" aria-hidden="true" />
    </p>
  );
}

export default StreamingText;
