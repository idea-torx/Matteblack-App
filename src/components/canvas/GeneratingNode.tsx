import type { CanvasNode } from "../../types/canvas";
import { QuantumThinking } from "../QuantumThinking";
import "./GeneratingNode.css";

type Props = {
  node: CanvasNode;
  // Optional dismiss handler invoked when the user clicks the X on a failed
  // placeholder. The parent canvas wires this to its node-delete path so the
  // chat card's chip flips back to "Add to canvas".
  onDismiss?: (nodeId: string) => void;
};

export function GeneratingNode({ node, onDismiss }: Props) {
  const meta = (node.metadata || {}) as Record<string, unknown>;
  const status = (meta.status as string) || "pending";
  const errorMsg = (meta.errorMsg as string) || "";
  const prompt = (meta.prompt as string) || node.label || "";
  const isError = status === "failed";

  if (!isError) {
    return (
      <div className="gen-node gen-node--loading" role="status" aria-live="polite" aria-label="Generating">
        <div className="gen-node__glow gen-node__glow--sharp" aria-hidden="true" />
        <div className="gen-node__glow-blur" aria-hidden="true">
          <div className="gen-node__glow gen-node__glow--soft" />
        </div>
        <div className="gen-node__spinner" aria-hidden="true">
          <QuantumThinking size={64} className="gen-node__quantum" ariaLabel="Generating" />
        </div>
      </div>
    );
  }

  return (
    <div className="gen-node gen-node--failed">
      {onDismiss && (
        <button
          type="button"
          className="gen-node__dismiss"
          aria-label="Dismiss failed generation"
          title="Dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(node.id); }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      <div className="gen-node__content">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span className="gen-node__label">{errorMsg || "Generation failed"}</span>
        {prompt && <span className="gen-node__prompt" title={prompt}>{prompt}</span>}
      </div>
    </div>
  );
}
