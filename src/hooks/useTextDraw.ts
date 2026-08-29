import { useState, useCallback, useRef, type MutableRefObject } from "react";
import type { InFlightText } from "../components/canvas/TextEditOverlay";
import { getDefaultTextColor } from "../theme";

type TextDrawState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type UseTextDrawParams = {
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  onDesignSubToolChangeRef: MutableRefObject<((tool: "select" | "frame" | "shape" | "text" | "pen" | "draw") => void) | undefined>;
  onDeselectAllRef: MutableRefObject<(() => void) | undefined>;
  setInFlightText: (inFlight: InFlightText | null) => void;
};

const MIN_TEXT_DRAG = 32;
const DEFAULT_TEXT_WIDTH = 200;
const DEFAULT_TEXT_HEIGHT = 40;

const DEFAULT_TEXT_META = {
  fontFamily: "Inter, sans-serif",
  fontWeight: 400,
  fontSize: 48,
  color: "#ffffff",
  textAlign: "left" as const,
  letterSpacing: 0,
  lineHeight: 120,
};

export function useTextDraw({
  panXRef,
  panYRef,
  zoomRef,
  onDeselectAllRef,
  setInFlightText,
}: UseTextDrawParams) {
  const [textDraw, setTextDraw] = useState<TextDrawState>(null);
  const textDrawRef = useRef<TextDrawState>(null);

  const handleTextDrawStart = useCallback((e: React.PointerEvent, rect: DOMRect) => {
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const state = { startX: sx, startY: sy, currentX: sx, currentY: sy };
    textDrawRef.current = state;
    setTextDraw(state);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (onDeselectAllRef.current) onDeselectAllRef.current();
  }, [onDeselectAllRef]);

  const handleTextDrawMove = useCallback((e: React.PointerEvent, rect: DOMRect) => {
    setTextDraw((prev) => {
      if (!prev) return null;
      const next = {
        ...prev,
        currentX: e.clientX - rect.left,
        currentY: e.clientY - rect.top,
      };
      textDrawRef.current = next;
      return next;
    });
  }, []);

  const handleTextDrawEnd = useCallback(() => {
    const prev = textDrawRef.current;
    if (!prev) return;
    textDrawRef.current = null;
    setTextDraw(null);

    const panX = panXRef.current;
    const panY = panYRef.current;
    const zoom = zoomRef.current;
    const left = Math.min(prev.startX, prev.currentX);
    const top = Math.min(prev.startY, prev.currentY);
    const w = Math.abs(prev.currentX - prev.startX);
    const h = Math.abs(prev.currentY - prev.startY);
    const worldX = (left - panX) / zoom;
    const worldY = (top - panY) / zoom;
    const worldW = Math.round(w / zoom);
    const worldH = Math.round(h / zoom);

    const hasDragW = worldW >= MIN_TEXT_DRAG;
    const hasDragH = worldH >= MIN_TEXT_DRAG;

    let finalX: number, finalY: number, finalW: number, finalH: number;
    if (hasDragW || hasDragH) {
      finalX = worldX;
      finalY = worldY;
      finalW = hasDragW ? worldW : DEFAULT_TEXT_WIDTH;
      finalH = hasDragH ? worldH : DEFAULT_TEXT_HEIGHT;
    } else {
      finalX = (prev.startX - panX) / zoom;
      finalY = (prev.startY - panY) / zoom;
      finalW = DEFAULT_TEXT_WIDTH;
      finalH = DEFAULT_TEXT_HEIGHT;
    }

    setInFlightText({
      x: finalX,
      y: finalY,
      width: finalW,
      height: finalH,
      text: "",
      label: "",
      ...DEFAULT_TEXT_META,
      color: getDefaultTextColor(),
      _createdAt: Date.now(),
    });
  }, [panXRef, panYRef, zoomRef, setInFlightText]);

  return {
    textDraw,
    setTextDraw,
    handleTextDrawStart,
    handleTextDrawMove,
    handleTextDrawEnd,
  };
}
