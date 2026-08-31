import { useEffect, useState } from "react";
import "./ThinkingPill.css";

interface ThinkingPillProps {
  className?: string;
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

export function ThinkingPill({ className, label = "Thinking…" }: ThinkingPillProps) {
  const elapsed = useElapsed();
  return (
    <span
      className={`thinking-pill${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={label}
    >
      <span className="thinking-pill__grid" aria-hidden="true">
        {CHEVRON.map((delay, i) => (
          <span key={i} className="thinking-pill__cell" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span className="thinking-pill__text" aria-hidden="true">{label}</span>
      <span className="thinking-pill__elapsed" aria-hidden="true">{elapsed}</span>
    </span>
  );
}

export default ThinkingPill;
