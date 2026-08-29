import { QuantumThinking } from "./QuantumThinking";
import "./ThinkingPill.css";

interface ThinkingPillProps {
  className?: string;
  label?: string;
  size?: number;
}

export function ThinkingPill({
  className,
  label = "Thinking…",
  size = 18,
}: ThinkingPillProps) {
  return (
    <span
      className={`thinking-pill${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={label}
    >
      <QuantumThinking
        size={size}
        vertices={6}
        ariaLabel={label}
        className="thinking-pill__emblem"
      />
      <span className="thinking-pill__text" aria-hidden="true">{label}</span>
    </span>
  );
}

export default ThinkingPill;
