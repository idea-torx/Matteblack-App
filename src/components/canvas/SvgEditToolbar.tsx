import React from "react";

export type SvgEditTool = "move" | "cut" | "join" | "curve";

type SvgEditToolbarProps = {
  activeTool: SvgEditTool;
  onToolChange: (tool: SvgEditTool) => void;
  onCutAction?: () => void;
  onJoinAction?: () => void;
  onExit?: () => void;
  zoom: number;
  canJoin?: boolean;
  canCut?: boolean;
};

const MODE_TOOLS: { id: SvgEditTool; label: string; icon: React.ReactNode }[] = [
  {
    id: "move",
    label: "Move",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" />
        <polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" />
        <line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" />
      </svg>
    ),
  },
  {
    id: "curve",
    label: "Curve",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12c0-5.5 4.5-10 10-10s10 4.5 10 10" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    ),
  },
];

const ACTION_BUTTONS: { id: "cut" | "join"; label: string; icon: React.ReactNode }[] = [
  {
    id: "cut",
    label: "Cut",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
        <line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" />
        <line x1="8.12" y1="8.12" x2="12" y2="12" />
      </svg>
    ),
  },
  {
    id: "join",
    label: "Join",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6h10" /><path d="M6 12h12" /><path d="M8 18h10" />
        <path d="M4 6l-2 0" /><path d="M22 6l-2 0" />
      </svg>
    ),
  },
];

export function SvgEditToolbar({ activeTool, onToolChange, onCutAction, onJoinAction, onExit, zoom, canJoin, canCut }: SvgEditToolbarProps) {
  const scale = 1 / zoom;

  return (
    <div
      style={{
        position: "absolute",
        bottom: `${-20 * scale}px`,
        left: "50%",
        transform: `translateX(-50%) translateY(100%) scale(${scale})`,
        transformOrigin: "top center",
        display: "flex",
        gap: "4px",
        padding: "4px 6px",
        background: "rgba(38, 38, 38, 0.92)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
        opacity: 1,
        pointerEvents: "auto",
        zIndex: 10,
        whiteSpace: "nowrap",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {MODE_TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={`freeform-canvas__toolbar-btn ${activeTool === tool.id ? "freeform-canvas__toolbar-btn--active" : ""}`}
          title={tool.label}
          onClick={() => onToolChange(tool.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "4px 10px",
            width: "auto",
            height: "28px",
            background: activeTool === tool.id ? "rgba(33, 150, 243, 0.3)" : "transparent",
            border: "none",
            borderRadius: "6px",
            color: "#fff",
            cursor: "pointer",
            fontSize: "11px",
            whiteSpace: "nowrap",
          }}
        >
          {tool.icon}
          <span>{tool.label}</span>
        </button>
      ))}
      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.2)", margin: "0 2px" }} />
      {ACTION_BUTTONS.map((btn) => {
        const disabled = (btn.id === "cut" && !canCut) || (btn.id === "join" && !canJoin);
        return (
          <button
            key={btn.id}
            type="button"
            className="freeform-canvas__toolbar-btn"
            title={btn.label}
            disabled={disabled}
            onClick={() => {
              if (btn.id === "cut" && onCutAction) onCutAction();
              if (btn.id === "join" && onJoinAction) onJoinAction();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 10px",
              width: "auto",
              height: "28px",
              background: "transparent",
              border: "none",
              borderRadius: "6px",
              color: disabled ? "#666" : "#fff",
              cursor: disabled ? "default" : "pointer",
              fontSize: "11px",
              whiteSpace: "nowrap",
              opacity: disabled ? 0.4 : 1,
            }}
          >
            {btn.icon}
            <span>{btn.label}</span>
          </button>
        );
      })}
      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.2)", margin: "0 2px" }} />
      <button
        type="button"
        onClick={() => onExit?.()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "4px 10px",
          width: "auto",
          height: "28px",
          background: "rgba(33, 150, 243, 0.25)",
          border: "1px solid rgba(33, 150, 243, 0.5)",
          borderRadius: "6px",
          color: "#64B5F6",
          cursor: "pointer",
          fontSize: "11px",
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        <kbd style={{ fontSize: "10px", padding: "1px 4px", borderRadius: "3px", background: "rgba(33, 150, 243, 0.2)", border: "1px solid rgba(33, 150, 243, 0.4)", color: "#90CAF9", fontFamily: "inherit" }}>Esc</kbd>
        Exit
      </button>
    </div>
  );
}
