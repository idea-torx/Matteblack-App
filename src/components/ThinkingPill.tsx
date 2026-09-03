import { useEffect, useState } from "react";
import "./ThinkingPill.css";

interface ThinkingPillProps {
  className?: string;
  /** What the agent is doing right now. Falls back to the generic wait. */
  label?: string;
}

/* A 3x3 pixel grid with a chevron wavefront driving left-to-right. Cell i's
 * delay is its column plus its distance from the middle row, so the lit cells
 * form a ">" that sweeps across. The 650ms cycle is shorter than the sweep
 * (max delay 360ms + the pulse), so two fronts are always in flight. */
const CHEVRON = Array.from({ length: 9 }, (_, i) => ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90);

/** Tenths of a second since mount, rendered as the agent's own stopwatch. */
function useElapsed() {
  const [ds, setDs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDs((d) => d + 1), 100);
    return () => clearInterval(t);
  }, []);
  const total = ds / 10;
  return total < 60 ? `${total.toFixed(1)}s` : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** Just the pulsing chevron grid. Cell size comes from --tp-cell on the
 * element, so the canvas placeholder can run the same animation at 14px. */
export function ThinkingGrid({ className }: { className?: string }) {
  return (
    <span className={`thinking-pill__grid${className ? ` ${className}` : ""}`} aria-hidden="true">
      {CHEVRON.map((delay, i) => (
        <span key={i} className="thinking-pill__cell" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

export function ThinkingPill({ className, label }: ThinkingPillProps) {
  const text = label ?? "Thinking…";
  const elapsed = useElapsed();
  return (
    <span
      className={`thinking-pill${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={text}
    >
      <ThinkingGrid />
      <span className="thinking-pill__text" aria-hidden="true">{text}</span>
      <span className="thinking-pill__elapsed" aria-hidden="true">{elapsed}</span>
    </span>
  );
}

export default ThinkingPill;
