import { useId } from "react";
import "./QuantumThinking.css";

interface QuantumThinkingProps {
  size?: number;
  color?: string;
  className?: string;
  ariaLabel?: string;
  /** Number of vertices/edges. Default 4 (square). 6 renders a hexagon. */
  vertices?: 4 | 6;
}

const VERTICES_4: Array<[number, number]> = [
  [14, 14],
  [50, 14],
  [50, 50],
  [14, 50],
];

const VERTICES_6: Array<[number, number]> = [
  [54, 32],
  [43, 13],
  [21, 13],
  [10, 32],
  [21, 51],
  [43, 51],
];

function buildEdges(vertices: Array<[number, number]>) {
  return vertices.map((from, i) => {
    const to = vertices[(i + 1) % vertices.length];
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    return { from, to, length };
  });
}

const EDGES_4 = buildEdges(VERTICES_4);
const EDGES_6 = buildEdges(VERTICES_6);

export function QuantumThinking({
  size = 24,
  color = "#3B82F6",
  className,
  ariaLabel = "Thinking",
  vertices = 4,
}: QuantumThinkingProps) {
  const id = useId();
  const scopeClass = `qt-${id.replace(/[:]/g, "")}`;
  const verts = vertices === 6 ? VERTICES_6 : VERTICES_4;
  const edges = vertices === 6 ? EDGES_6 : EDGES_4;
  const variantClass = vertices === 6 ? "quantum-thinking--6" : "quantum-thinking--4";

  return (
    <span
      className={`quantum-thinking ${variantClass} ${scopeClass}${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={ariaLabel}
      style={{ width: size, height: size }}
    >
      <style>{`
        .${scopeClass} { --qt-color: ${color}; }
      `}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
      >
        {edges.map(({ from, to, length }, i) => (
          <line
            key={`edge-${i}`}
            x1={from[0]}
            y1={from[1]}
            x2={to[0]}
            y2={to[1]}
            stroke="var(--qt-color)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={length}
            strokeDashoffset={length}
            style={{ ["--qt-edge-len" as string]: length }}
            className={`quantum-thinking__edge quantum-thinking__edge--${i}`}
          />
        ))}
        {verts.map(([cx, cy], i) => (
          <circle
            key={`dot-${i}`}
            cx={cx}
            cy={cy}
            r={vertices === 6 ? 3.4 : 4}
            fill="var(--qt-color)"
            className={`quantum-thinking__dot quantum-thinking__dot--${i}`}
          />
        ))}
      </svg>
    </span>
  );
}

export default QuantumThinking;
