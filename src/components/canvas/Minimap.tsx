import { useMemo, useState, useEffect } from "react";
import type { CanvasNode } from "../../types/canvas";

function useTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") || "dark");
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute("data-theme") || "dark");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

const darkColors = {
  node: "rgba(255, 255, 255, 0.18)",
  image: "rgba(255, 255, 255, 0.2)",
  video: "rgba(255, 255, 255, 0.28)",
  group: "rgba(255, 255, 255, 0.06)",
  groupStroke: "rgba(255, 255, 255, 0.15)",
  groupLabel: "rgba(255, 255, 255, 0.5)",
  viewport: "rgba(255, 255, 255, 0.6)",
};

const lightColors = {
  node: "rgba(0, 0, 0, 0.15)",
  image: "rgba(0, 0, 0, 0.18)",
  video: "rgba(0, 0, 0, 0.22)",
  group: "rgba(0, 0, 0, 0.05)",
  groupStroke: "rgba(0, 0, 0, 0.12)",
  groupLabel: "rgba(0, 0, 0, 0.4)",
  viewport: "rgba(59, 130, 246, 0.6)",
};

export function Minimap({ nodes, panX, panY, zoom, viewportWidth, viewportHeight, onNavigate, selectedIds }: {
  nodes: CanvasNode[];
  panX: number;
  panY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  onNavigate: (x: number, y: number) => void;
  selectedIds: Set<string>;
}) {
  const MINIMAP_W = 160;
  const MINIMAP_H = 100;
  const theme = useTheme();
  const isLight = theme === "light";
  const colors = isLight ? lightColors : darkColors;

  const bounds = useMemo(() => {
    const vpLeft = -panX / zoom;
    const vpTop = -panY / zoom;
    const vpRight = vpLeft + viewportWidth / zoom;
    const vpBottom = vpTop + viewportHeight / zoom;
    let minX = vpLeft, minY = vpTop, maxX = vpRight, maxY = vpBottom;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    const pad = 100;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }, [nodes, panX, panY, zoom, viewportWidth, viewportHeight]);

  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxY - bounds.minY;
  const scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH);

  const vpLeft = -panX / zoom;
  const vpTop = -panY / zoom;
  const vpW = viewportWidth / zoom;
  const vpH = viewportHeight / zoom;

  const handleClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / scale + bounds.minX;
    const my = (e.clientY - rect.top) / scale + bounds.minY;
    onNavigate(mx, my);
  };

  const nodeTypeColors: Record<string, string> = {
    image: colors.image,
    video: colors.video,
    group: colors.group,
  };

  return (
    <div className="freeform-canvas__minimap" onMouseDown={handleClick}>
      <svg width={MINIMAP_W} height={MINIMAP_H} viewBox={`0 0 ${MINIMAP_W} ${MINIMAP_H}`}>
        {nodes.map((n) => {
          const isSelected = selectedIds.has(n.id);
          const isGroup = n.node_type === "group";
          return (
            <g key={n.id}>
              <rect
                x={(n.x - bounds.minX) * scale}
                y={(n.y - bounds.minY) * scale}
                width={Math.max(2, n.width * scale)}
                height={Math.max(2, n.height * scale)}
                fill={isSelected ? "rgba(99, 162, 255, 0.5)" : (nodeTypeColors[n.node_type] || colors.node)}
                stroke={isGroup ? colors.groupStroke : isSelected ? "rgba(99, 162, 255, 0.9)" : "none"}
                strokeWidth={isGroup ? 0.5 : isSelected ? 1 : 0}
                rx={isGroup ? 2 : 1}
              />
              {isGroup && n.label && (
                <text
                  x={(n.x - bounds.minX) * scale + 2}
                  y={(n.y - bounds.minY) * scale - 1}
                  fill={colors.groupLabel}
                  fontSize={Math.max(3, Math.min(6, n.width * scale * 0.08))}
                  fontWeight="600"
                >{n.label}</text>
              )}
            </g>
          );
        })}
        <rect
          x={Math.max(0, Math.min((vpLeft - bounds.minX) * scale, MINIMAP_W))}
          y={Math.max(0, Math.min((vpTop - bounds.minY) * scale, MINIMAP_H))}
          width={Math.max(0, Math.min(vpW * scale, MINIMAP_W - Math.max(0, (vpLeft - bounds.minX) * scale)))}
          height={Math.max(0, Math.min(vpH * scale, MINIMAP_H - Math.max(0, (vpTop - bounds.minY) * scale)))}
          fill="none"
          stroke={colors.viewport}
          strokeWidth={1.5}
          rx={Math.min(4, Math.min(vpW * scale, vpH * scale) * 0.15)}
        />
      </svg>
    </div>
  );
}
