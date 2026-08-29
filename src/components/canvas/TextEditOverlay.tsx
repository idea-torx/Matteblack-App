import { useRef, useEffect, useCallback, memo } from "react";
import { isGradientFill, parseGradientFill, gradientToCss } from "../../utils/gradientUtils";

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

export type InFlightText = {
  nodeId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  color: string;
  textAlign: string;
  letterSpacing: number;
  lineHeight: number;
  label: string;
  _createdAt?: number;
};

type TextEditOverlayProps = {
  inFlight: InFlightText;
  panX: number;
  panY: number;
  zoom: number;
  onCommit: (text: string) => void;
  onTextChange: (text: string) => void;
};

export const TextEditOverlay = memo(function TextEditOverlay({
  inFlight,
  panX,
  panY,
  zoom,
  onCommit,
  onTextChange,
}: TextEditOverlayProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);
  const textRef = useRef(inFlight.text);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { ensureGoogleFont(inFlight.fontFamily); }, [inFlight.fontFamily]);

  useEffect(() => {
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    committedRef.current = false;
    textRef.current = inFlight.text;
    if (editorRef.current) {
      editorRef.current.innerText = inFlight.text;
      editorRef.current.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return () => {
      if (!committedRef.current) {
        const capturedText = textRef.current;
        const capturedCommit = onCommitRef.current;
        cleanupTimerRef.current = setTimeout(() => {
          if (!committedRef.current) {
            committedRef.current = true;
            capturedCommit(capturedText);
          }
        }, 0);
      }
    };
  }, []);

  const doCommit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    onCommitRef.current(textRef.current);
  }, []);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      const text = editorRef.current.innerText;
      textRef.current = text;
      onTextChange(text);
    }
  }, [onTextChange]);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related) {
      const isPanel = related.closest(".rpanel") || related.closest("[data-panel-right]");
      if (isPanel) {
        requestAnimationFrame(() => editorRef.current?.focus());
        return;
      }
    }
    const age = Date.now() - (inFlight._createdAt ?? 0);
    if (age < 500) {
      requestAnimationFrame(() => editorRef.current?.focus());
      return;
    }
    doCommit();
  }, [doCommit, inFlight._createdAt]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      doCommit();
    }
  }, [doCommit]);

  const screenX = inFlight.x * zoom + panX;
  const screenY = inFlight.y * zoom + panY;
  const screenW = inFlight.width * zoom;
  const screenH = inFlight.height * zoom;

  const isGradColor = isGradientFill(inFlight.color);
  const gradCss = isGradColor ? (() => {
    const gd = parseGradientFill(inFlight.color);
    return gd ? gradientToCss(gd) : null;
  })() : null;
  const gradClassName = gradCss ? "freeform-canvas__text-gradient" : undefined;

  const style: React.CSSProperties = {
    position: "absolute",
    left: screenX,
    top: screenY,
    width: screenW,
    minHeight: screenH,
    fontFamily: inFlight.fontFamily,
    fontWeight: inFlight.fontWeight,
    fontSize: inFlight.fontSize * zoom,
    color: gradCss ? undefined : (isGradColor ? "#ffffff" : inFlight.color),
    textAlign: inFlight.textAlign as React.CSSProperties["textAlign"],
    backgroundImage: gradCss ? gradCss : undefined,
    background: gradCss ? undefined : "transparent",
    outline: "none",
    border: "2px solid rgba(91, 95, 199, 0.6)",
    overflow: "hidden",
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
    padding: 4 * zoom,
    boxSizing: "border-box",
    cursor: "text",
    userSelect: "text",
    letterSpacing: `${inFlight.letterSpacing * zoom}px`,
    lineHeight: inFlight.lineHeight / 100,
    zIndex: 999999,
    transformOrigin: "top left",
    pointerEvents: "auto",
  };

  return (
    <div
      ref={editorRef}
      className={gradClassName}
      contentEditable
      suppressContentEditableWarning
      style={style}
      onBlur={handleBlur}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      spellCheck={true}
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  );
});
