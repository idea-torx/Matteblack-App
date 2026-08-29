import { useEffect, useCallback, memo } from "react";
import type { CanvasNode } from "../../types/canvas";
import { isGradientFill, parseGradientFill, gradientToCss } from "../../utils/gradientUtils";
import { getDefaultTextColor } from "../../theme";

const _loadedFonts = new Set<string>();
function ensureGoogleFont(fontFamily: string) {
  const match = fontFamily.match(/^'([^']+)'/);
  if (!match) return;
  const name = match[1];
  if (_loadedFonts.has(name)) return;
  _loadedFonts.add(name);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@100;200;300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
}

type TextNodeContentProps = {
  node: CanvasNode;
  isHidden?: boolean;
  onStartEdit: (nodeId: string) => void;
};

export const TextNodeContent = memo(function TextNodeContent({
  node,
  isHidden,
  onStartEdit,
}: TextNodeContentProps) {
  const meta = node.metadata as Record<string, unknown>;
  const fontFamily = (meta?.fontFamily as string) || "Inter, sans-serif";
  const fontWeight = (meta?.fontWeight as number) || 400;
  const fontSize = (meta?.fontSize as number) || 48;
  const color = (meta?.color as string) || getDefaultTextColor();
  const textAlign = (meta?.textAlign as string) || "left";
  const textContent = (meta?.textContent as string) || "";
  const letterSpacing = (meta?.letterSpacing as number) || 0;
  const lineHeight = (meta?.lineHeight as number) || 120;

  useEffect(() => { ensureGoogleFont(fontFamily); }, [fontFamily]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStartEdit(node.id);
  }, [onStartEdit, node.id]);

  const isGradColor = isGradientFill(color);
  const gradCss = isGradColor ? (() => {
    const gd = parseGradientFill(color);
    return gd ? gradientToCss(gd) : null;
  })() : null;

  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    fontFamily,
    fontWeight,
    fontSize: fontSize,
    color: gradCss ? undefined : (isGradColor ? "#ffffff" : color),
    textAlign: textAlign as React.CSSProperties["textAlign"],
    outline: "none",
    border: "none",
    background: gradCss ? undefined : "transparent",
    backgroundImage: gradCss ? gradCss : undefined,
    overflow: "hidden",
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
    padding: 4,
    boxSizing: "border-box",
    cursor: "default",
    userSelect: "none",
    letterSpacing: `${letterSpacing}px`,
    lineHeight: lineHeight / 100,
    visibility: isHidden ? "hidden" : undefined,
  };

  const gradClassName = gradCss ? "freeform-canvas__text-gradient" : undefined;

  return (
    <div
      className={gradClassName}
      style={style}
      onDoubleClick={handleDoubleClick}
    >
      {textContent}
    </div>
  );
});
