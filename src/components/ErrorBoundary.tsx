/**
 * Keeps a render throw from taking the whole window with it.
 *
 * Two mount points: one around the canvas, so a bad node keeps the shell and
 * the agent panel usable, and one at the root as a last resort. Canvas edits
 * are already flushed by CanvasSyncEngine, so recovering is a remount, not a
 * restore — the point is that the app is still there to remount into.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** What broke, in the user's words: "The canvas", "The app". */
  what: string;
  /** Root-level: reloading is the only way back. */
  reloadOnly?: boolean;
}

interface State {
  error: Error | null;
  /** Remounting into the same broken state just throws again; a second failure
   *  drops to reload rather than offering a button that cannot work. */
  retried: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retried: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary] ${this.props.what} crashed:`, error, info.componentStack);
  }

  render() {
    const { error, retried } = this.state;
    if (!error) return this.props.children;
    const canRetry = !this.props.reloadOnly && !retried;
    return (
      <div style={S.wrap} role="alert">
        <div style={S.card}>
          <h2 style={S.title}>{this.props.what} hit an error.</h2>
          <p style={S.body}>
            Your work is saved — the canvas syncs continuously. {canRetry
              ? "Try again, or reload if it keeps happening."
              : "Reload to pick up where you left off."}
          </p>
          <pre style={S.detail}>{error.message || String(error)}</pre>
          <div style={S.row}>
            {canRetry && (
              <button style={{ ...S.btn, ...S.primary }} onClick={() => this.setState({ error: null, retried: true })}>
                Try again
              </button>
            )}
            <button style={{ ...S.btn, ...(canRetry ? {} : S.primary) }} onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

// Inline rather than a stylesheet: this has to render when the app is already
// broken, so it depends on nothing but the theme tokens in index.css.
const S: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", minHeight: 240, padding: 24, background: "var(--bg-canvas, #141416)" },
  card: { maxWidth: 460, textAlign: "center", color: "var(--text-primary, #e8e8ed)", font: "14px/1.5 system-ui, sans-serif" },
  title: { margin: "0 0 8px", fontSize: 17, fontWeight: 600 },
  body: { margin: "0 0 14px", color: "var(--text-secondary, #9a9aa6)" },
  detail: { margin: "0 0 18px", padding: "8px 10px", maxHeight: 120, overflow: "auto", textAlign: "left", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted, #5c5c6a)", background: "var(--bg-code, #0c0c0e)", borderRadius: 8 },
  row: { display: "flex", gap: 8, justifyContent: "center" },
  btn: { padding: "8px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer", color: "var(--text-primary, #e8e8ed)", background: "var(--bg-raised, #1b1b1f)", border: "1px solid var(--border-strong, rgba(255,255,255,0.12))", borderRadius: 8 },
  primary: { color: "var(--text-on-accent, #fff)", background: "var(--accent)", borderColor: "transparent" },
};
