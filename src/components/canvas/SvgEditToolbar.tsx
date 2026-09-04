
export type SvgEditTool = "move" | "cut" | "join" | "curve";

type SvgEditToolbarProps = {
  activeTool: SvgEditTool;
  onToolChange: (tool: SvgEditTool) => void;
  onCutAction?: () => void;
  onJoinAction?: () => void;
  onSimplifyAction?: () => void;
  onExit?: () => void;
  zoom: number;
  canJoin?: boolean;
  canCut?: boolean;
};

const ICON = {
  move: (
    <>
      <polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" />
    </>
  ),
  curve: (
    <>
      <path d="M2 12c0-5.5 4.5-10 10-10s10 4.5 10 10" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </>
  ),
  join: (
    <>
      <path d="M8 6h10" /><path d="M6 12h12" /><path d="M8 18h10" />
      <path d="M4 6l-2 0" /><path d="M22 6l-2 0" />
    </>
  ),
  simplify: (
    <>
      <path d="M3 18c6 0 6-12 12-12" />
      <circle cx="3" cy="18" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    </>
  ),
  exit: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
} as const;

function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {ICON[name]}
    </svg>
  );
}

const DIVIDER = <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.18)", margin: "0 3px", alignSelf: "center", position: "relative", zIndex: 1 }} />;

export function SvgEditToolbar({ activeTool, onToolChange, onCutAction, onJoinAction, onSimplifyAction, onExit, zoom, canJoin, canCut }: SvgEditToolbarProps) {
  // Same pill and the same zoom-resistant scale as the node mini-menu, just
  // parked above the node so it never covers the points being edited.
  const scale = Math.min(1.55 * Math.pow(1 / zoom, 0.55), 3.5);

  const button = (
    key: string,
    name: keyof typeof ICON,
    label: string,
    onClick: () => void,
    opts?: { active?: boolean; disabled?: boolean },
  ) => (
    <button
      key={key}
      type="button"
      className={`freeform-canvas__toolbar-btn ${opts?.active ? "freeform-canvas__toolbar-btn--active" : ""}`}
      title={label}
      aria-label={label}
      disabled={opts?.disabled}
      onClick={onClick}
      style={opts?.active ? { background: "rgba(33, 150, 243, 0.35)", color: "#fff" } : undefined}
    >
      <Icon name={name} />
    </button>
  );

  return (
    <div
      className="freeform-canvas__floating-toolbar"
      style={{
        top: `${-34 * scale}px`,
        padding: "5px 7px",
        bottom: "auto",
        left: "50%",
        transform: `translateX(-50%) translateY(-100%) scale(${scale})`,
        transformOrigin: "bottom center",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="freeform-canvas__floating-toolbar__glass-shadow" aria-hidden="true" />
      <div className="freeform-canvas__floating-toolbar__glass-backdrop" aria-hidden="true" />
      {button("move", "move", "Move", () => onToolChange("move"), { active: activeTool === "move" })}
      {button("curve", "curve", "Curve", () => onToolChange("curve"), { active: activeTool === "curve" })}
      {DIVIDER}
      {button("cut", "cut", "Cut", () => onCutAction?.(), { disabled: !canCut })}
      {button("join", "join", "Join", () => onJoinAction?.(), { disabled: !canJoin })}
      {button("simplify", "simplify", "Simplify — fewer points, same shape", () => onSimplifyAction?.())}
      {DIVIDER}
      {button("exit", "exit", "Done (Esc)", () => onExit?.())}
    </div>
  );
}
