import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { isGradientFill, parseGradientFill, serializeGradientFill, gradientToCss, defaultGradientData, type GradientData } from "../../utils/gradientUtils";

declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
  }
}

const COLOR_MODE_KEY = "colorpicker_mode";

type ColorMode = "HEX" | "RGB" | "HSB" | "HSL";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function hsvToHex(h: number, s: number, v: number): string {
  const [r, g, b] = hsvToRgb(h, s, v);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + 6) % 6 * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function hexToHsv(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [0, 0, 0];
  return rgbToHsv(
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16)
  );
}

function hsvToHsl(h: number, s: number, v: number): [number, number, number] {
  const l = v * (1 - s / 2);
  const sl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, sl, l];
}

function hslToHsv(h: number, s: number, l: number): [number, number, number] {
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return [h, sv, v];
}

function normalizeHex(input: string): string | null {
  let hex = input.trim().replace(/^#/, "");
  if (/^[a-fA-F0-9]{3}$/.test(hex)) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (/^[a-fA-F0-9]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}


function getSavedMode(): ColorMode {
  try {
    const m = localStorage.getItem(COLOR_MODE_KEY);
    if (m === "HEX" || m === "RGB" || m === "HSB" || m === "HSL") return m;
  } catch {}
  return "HEX";
}

const fieldInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "transparent",
  border: "none",
  borderRadius: 0,
  color: "var(--text-primary)",
  fontSize: 11,
  padding: "0 2px",
  textAlign: "center",
  outline: "none",
  fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
  height: "100%",
};

const fieldLabelStyle: React.CSSProperties = {
  color: "rgba(var(--tint-rgb), 0.35)",
  fontSize: 9,
  textAlign: "center",
  marginTop: 2,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  label?: string;
  showNone?: boolean;
  isNone?: boolean;
  onNoneToggle?: () => void;
  canvasColors?: string[];
}

type FillMode = "solid" | "gradient";

export default function ColorPicker({ value, onChange, label, showNone, isNone, onNoneToggle, canvasColors }: ColorPickerProps) {
  const isGrad = isGradientFill(value);
  const [isOpen, setIsOpen] = useState(false);
  const [fillMode, setFillMode] = useState<FillMode>(isGrad ? "gradient" : "solid");
  const [gradientData, setGradientData] = useState<GradientData>(() => {
    if (isGrad) {
      const parsed = parseGradientFill(value);
      return parsed || defaultGradientData();
    }
    return defaultGradientData();
  });
  const [activeStop, setActiveStop] = useState<0 | 1>(0);
  const [hsv, setHsv] = useState<[number, number, number]>(() => {
    if (isGrad) {
      const parsed = parseGradientFill(value);
      return hexToHsv(parsed?.color1 || "#000000");
    }
    return hexToHsv(value || "#000000");
  });
  const [hexInput, setHexInput] = useState(() => {
    if (isGrad) {
      const parsed = parseGradientFill(value);
      return (parsed?.color1 || "#000000").toUpperCase();
    }
    return (normalizeHex(value || "#000000") || "#000000").toUpperCase();
  });
  const [colorMode, setColorMode] = useState<ColorMode>(getSavedMode);
  const [hexHovered, setHexHovered] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const satValRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingSV = useRef(false);
  const draggingHue = useRef(false);
  const draggingPopup = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const gradientPreviewRef = useRef<HTMLDivElement>(null);
  const draggingGradStop = useRef<0 | 1 | null>(null);

  useEffect(() => {
    if (isGradientFill(value)) {
      const parsed = parseGradientFill(value);
      if (parsed) {
        setFillMode("gradient");
        setGradientData(parsed);
        const stopColor = activeStop === 0 ? parsed.color1 : parsed.color2;
        const newHsv = hexToHsv(stopColor);
        setHsv(newHsv);
        setHexInput(stopColor.toUpperCase());
      }
    } else {
      setFillMode("solid");
      const norm = normalizeHex(value || "#000000") || "#000000";
      const newHsv = hexToHsv(norm);
      setHsv(newHsv);
      setHexInput(norm.toUpperCase());
    }
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current && !containerRef.current.contains(e.target as Node) &&
        popupRef.current && !popupRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const calcPopupPos = useCallback(() => {
    if (!containerRef.current) return { top: 100, left: 100 };
    const rect = containerRef.current.getBoundingClientRect();
    const popupWidth = 264;
    const gap = 12;
    const rpanel = containerRef.current.closest(".rpanel");
    let left: number;
    if (rpanel) {
      const panelRect = rpanel.getBoundingClientRect();
      left = panelRect.left - popupWidth - gap;
    } else {
      left = rect.left - popupWidth - gap;
    }
    left = Math.max(8, left);
    const popupHeight = 420;
    let top = Math.round(window.innerHeight / 2 - popupHeight / 2);
    top = Math.max(8, Math.min(top, window.innerHeight - popupHeight));
    return { top, left };
  }, []);

  const openPicker = useCallback(() => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setPopupPos(calcPopupPos());
    setIsOpen(true);
  }, [isOpen, calcPopupPos]);

  const updateFromHsv = useCallback((newHsv: [number, number, number]) => {
    setHsv(newHsv);
    const hex = hsvToHex(newHsv[0], newHsv[1], newHsv[2]);
    setHexInput(hex.toUpperCase());
    if (fillMode === "gradient") {
      setGradientData((prev) => {
        const next = { ...prev };
        if (activeStop === 0) next.color1 = hex;
        else next.color2 = hex;
        onChange(serializeGradientFill(next));
        return next;
      });
    } else {
      onChange(hex);
    }
  }, [onChange, fillMode, activeStop]);

  const handleSVInteraction = useCallback((clientX: number, clientY: number) => {
    if (!satValRef.current) return;
    const rect = satValRef.current.getBoundingClientRect();
    const s = clamp((clientX - rect.left) / rect.width, 0, 1);
    const v = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
    updateFromHsv([hsv[0], s, v]);
  }, [hsv, updateFromHsv]);

  const handleHueInteraction = useCallback((clientX: number) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const h = clamp((clientX - rect.left) / rect.width, 0, 1) * 360;
    updateFromHsv([h, hsv[1], hsv[2]]);
  }, [hsv, updateFromHsv]);

  const handlePopupDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    draggingPopup.current = true;
    dragOffset.current = {
      x: e.clientX - (popupPos?.left ?? 0),
      y: e.clientY - (popupPos?.top ?? 0),
    };
  }, [popupPos]);

  const handleGradStopDrag = useCallback((clientX: number, clientY: number) => {
    if (!gradientPreviewRef.current || draggingGradStop.current === null) return;
    const rect = gradientPreviewRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    setGradientData((prev) => {
      const next = { ...prev };
      if (draggingGradStop.current === 0) { next.x1 = x; next.y1 = y; }
      else { next.x2 = x; next.y2 = y; }
      onChange(serializeGradientFill(next));
      return next;
    });
  }, [onChange]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (draggingSV.current) handleSVInteraction(e.clientX, e.clientY);
      if (draggingHue.current) handleHueInteraction(e.clientX);
      if (draggingPopup.current) {
        setPopupPos({
          left: e.clientX - dragOffset.current.x,
          top: e.clientY - dragOffset.current.y,
        });
      }
      if (draggingGradStop.current !== null) handleGradStopDrag(e.clientX, e.clientY);
    }
    function onMouseUp() {
      draggingSV.current = false;
      draggingHue.current = false;
      draggingPopup.current = false;
      draggingGradStop.current = null;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [handleSVInteraction, handleHueInteraction, handleGradStopDrag]);

  const switchToSolid = useCallback(() => {
    setFillMode("solid");
    const hex = activeStop === 0 ? gradientData.color1 : gradientData.color2;
    const norm = normalizeHex(hex) || hex;
    setHsv(hexToHsv(norm));
    setHexInput(norm.toUpperCase());
    onChange(norm);
  }, [gradientData, activeStop, onChange]);

  const switchToGradient = useCallback(() => {
    setFillMode("gradient");
    const currentColor = hsvToHex(hsv[0], hsv[1], hsv[2]);
    const newGrad = { ...gradientData, color1: currentColor };
    setGradientData(newGrad);
    setActiveStop(0);
    onChange(serializeGradientFill(newGrad));
  }, [hsv, gradientData, onChange]);

  const selectGradientStop = useCallback((stop: 0 | 1) => {
    setActiveStop(stop);
    const color = stop === 0 ? gradientData.color1 : gradientData.color2;
    const norm = normalizeHex(color) || color;
    setHsv(hexToHsv(norm));
    setHexInput(norm.toUpperCase());
  }, [gradientData]);

  const applyAndCommit = useCallback((hex: string) => {
    if (fillMode === "gradient") {
      setGradientData((prev) => {
        const next = { ...prev };
        if (activeStop === 0) next.color1 = hex;
        else next.color2 = hex;
        onChange(serializeGradientFill(next));
        return next;
      });
    } else {
      onChange(hex);
    }
  }, [onChange, fillMode, activeStop]);

  const handleHexSubmit = () => {
    const norm = normalizeHex(hexInput);
    if (norm) {
      setHsv(hexToHsv(norm));
      setHexInput(norm.toUpperCase());
      applyAndCommit(norm);
    } else {
      if (isGradientFill(value)) {
        const gd = parseGradientFill(value);
        const color = gd ? (activeStop === 0 ? gd.color1 : gd.color2) : "#000000";
        setHexInput(color.toUpperCase());
      } else {
        const fallback = normalizeHex(value || "#000000") || "#000000";
        setHexInput(fallback.toUpperCase());
      }
    }
  };

  const hasEyeDropper = typeof window !== "undefined" && !!window.EyeDropper;

  const handleEyeDropper = async () => {
    if (!window.EyeDropper) return;
    try {
      const dropper = new window.EyeDropper();
      const result = await dropper.open();
      const hex = normalizeHex(result.sRGBHex);
      if (hex) {
        setHsv(hexToHsv(hex));
        setHexInput(hex.toUpperCase());
        applyAndCommit(hex);
      }
    } catch {}
  };

  const cycleMode = () => {
    const modes: ColorMode[] = ["HEX", "RGB", "HSB", "HSL"];
    const next = modes[(modes.indexOf(colorMode) + 1) % modes.length];
    setColorMode(next);
    try { localStorage.setItem(COLOR_MODE_KEY, next); } catch {}
  };

  const currentHex = hsvToHex(hsv[0], hsv[1], hsv[2]);
  const hueColor = hsvToHex(hsv[0], 1, 1);
  const [curR, curG, curB] = hsvToRgb(hsv[0], hsv[1], hsv[2]);
  const [curHslH, curHslS, curHslL] = hsvToHsl(hsv[0], hsv[1], hsv[2]);

  const handleChannelChange = (mode: ColorMode, channel: number, val: number) => {
    let newHsv: [number, number, number];
    if (mode === "RGB") {
      const rgb: [number, number, number] = [curR, curG, curB];
      rgb[channel] = clamp(val, 0, 255);
      newHsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    } else if (mode === "HSB") {
      const hsbArr: [number, number, number] = [hsv[0], hsv[1], hsv[2]];
      if (channel === 0) hsbArr[0] = clamp(val, 0, 360);
      else if (channel === 1) hsbArr[1] = clamp(val, 0, 100) / 100;
      else hsbArr[2] = clamp(val, 0, 100) / 100;
      newHsv = hsbArr;
    } else {
      const hslArr: [number, number, number] = [curHslH, curHslS, curHslL];
      if (channel === 0) hslArr[0] = clamp(val, 0, 360);
      else if (channel === 1) hslArr[1] = clamp(val, 0, 100) / 100;
      else hslArr[2] = clamp(val, 0, 100) / 100;
      newHsv = hslToHsv(hslArr[0], hslArr[1], hslArr[2]);
    }
    updateFromHsv(newHsv);
  };

  const channelValues = (): { labels: string[]; values: number[]; maxes: number[] } => {
    if (colorMode === "RGB") {
      return { labels: ["R", "G", "B"], values: [curR, curG, curB], maxes: [255, 255, 255] };
    } else if (colorMode === "HSB") {
      return {
        labels: ["H", "S", "B"],
        values: [Math.round(hsv[0]), Math.round(hsv[1] * 100), Math.round(hsv[2] * 100)],
        maxes: [360, 100, 100],
      };
    } else {
      return {
        labels: ["H", "S", "L"],
        values: [Math.round(curHslH), Math.round(curHslS * 100), Math.round(curHslL * 100)],
        maxes: [360, 100, 100],
      };
    }
  };

  const ch = channelValues();

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28 }}>
        {label && <span style={{ fontSize: 11, color: "rgba(var(--tint-rgb), 0.5)", whiteSpace: "nowrap", flexShrink: 0 }}>{label}</span>}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <div
            onClick={openPicker}
            style={{
              width: 24,
              height: 24,
              borderRadius: 5,
              border: "1px solid rgba(var(--tint-rgb), 0.12)",
              background: isNone ? "transparent" : (isGradientFill(value) ? ((() => { const gd = parseGradientFill(value); return gd ? gradientToCss(gd) : currentHex; })()) : currentHex),
              cursor: "pointer",
              boxSizing: "border-box",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "border-color 0.15s",
            }}
          >
            {isNone && (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="rgba(255,100,100,0.7)" strokeWidth="1.5">
                <line x1="3" y1="13" x2="13" y2="3" />
              </svg>
            )}
          </div>
          <div
            onMouseEnter={() => setHexHovered(true)}
            onMouseLeave={() => setHexHovered(false)}
            onClick={isGradientFill(value) ? openPicker : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              background: "rgba(var(--tint-rgb), 0.04)",
              border: "1px solid rgba(var(--tint-rgb), 0.06)",
              borderRadius: 5,
              padding: "0 6px",
              height: 24,
              transition: "border-color 0.15s",
              position: "relative",
              cursor: isGradientFill(value) ? "pointer" : undefined,
            }}
          >
            {isGradientFill(value) ? (
              <span style={{ fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace", color: "rgba(var(--tint-rgb), 0.5)", userSelect: "none" }}>Gradient</span>
            ) : (
              <>
                <span style={{ fontSize: 11, fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace", color: "rgba(var(--tint-rgb), 0.3)", pointerEvents: "none", userSelect: "none" }}>#</span>
                <input
                  type="text"
                  value={hexInput.replace(/^#/, "").toUpperCase()}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/^#/, "").replace(/[^a-fA-F0-9]/g, "").slice(0, 6);
                    setHexInput("#" + raw);
                    const norm = normalizeHex(raw);
                    if (norm) {
                      setHsv(hexToHsv(norm));
                      onChange(norm);
                    }
                  }}
                  onBlur={handleHexSubmit}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") handleHexSubmit();
                  }}
                  style={{
                    width: 52,
                    background: "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    fontSize: 11,
                    padding: 0,
                    fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
                    outline: "none",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                />
              </>
            )}
            {showNone && !isNone && hexHovered && (
              <button
                type="button"
                onClick={onNoneToggle}
                title="Remove color"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 16,
                  padding: 0,
                  border: "none",
                  borderRadius: 3,
                  background: "transparent",
                  color: "rgba(var(--tint-rgb), 0.3)",
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "color 0.12s",
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "#f87171"; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "rgba(var(--tint-rgb), 0.3)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            )}
          </div>
          {showNone && isNone && (
            <button
              type="button"
              onClick={onNoneToggle}
              style={{
                fontSize: 10,
                padding: "3px 8px",
                borderRadius: 4,
                border: "1px solid rgba(var(--tint-rgb), 0.1)",
                background: "rgba(var(--tint-rgb), 0.04)",
                color: "rgba(var(--tint-rgb), 0.5)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              Add
            </button>
          )}
        </div>
      </div>

      {isOpen && popupPos && createPortal(
        <div
          ref={popupRef}
          style={{
            position: "fixed",
            top: popupPos.top,
            left: popupPos.left,
            zIndex: 99999,
            background: "var(--bg-raised)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(var(--tint-rgb), 0.08)",
            borderRadius: 12,
            padding: 0,
            width: 260,
            boxShadow: "var(--shadow-md), 0 0 0 1px rgba(var(--tint-rgb), 0.04) inset",
            overflow: "hidden",
            userSelect: "none",
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            const tag = (e.target as HTMLElement).tagName;
            if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
          }}
        >
          <div
            onMouseDown={(e) => { handlePopupDragStart(e); e.preventDefault(); }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px 8px",
              borderBottom: "1px solid rgba(var(--tint-rgb), 0.06)",
              cursor: "grab",
              userSelect: "none",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(var(--tint-rgb), 0.7)", letterSpacing: "0.3px" }}>
              {label || "Color"}
            </span>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                width: 22,
                height: 22,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "rgba(var(--tint-rgb), 0.35)",
                cursor: "pointer",
                padding: 0,
                transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; e.currentTarget.style.background = "rgba(var(--tint-rgb), 0.08)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(var(--tint-rgb), 0.35)"; e.currentTarget.style.background = "transparent"; }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="3" x2="9" y2="9" />
                <line x1="9" y1="3" x2="3" y2="9" />
              </svg>
            </button>
          </div>

          <div style={{ display: "flex", padding: "8px 14px 0", gap: 0 }}>
            {(["solid", "gradient"] as FillMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => mode === "solid" ? switchToSolid() : switchToGradient()}
                style={{
                  flex: 1,
                  padding: "6px 0",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.3px",
                  background: fillMode === mode ? "rgba(var(--tint-rgb), 0.1)" : "transparent",
                  border: "1px solid rgba(var(--tint-rgb), 0.08)",
                  borderRadius: mode === "solid" ? "6px 0 0 6px" : "0 6px 6px 0",
                  color: fillMode === mode ? "var(--text-primary)" : "rgba(var(--tint-rgb), 0.4)",
                  cursor: "pointer",
                  transition: "all 0.12s",
                  textTransform: "capitalize",
                }}
              >
                {mode === "solid" ? "Solid" : "Gradient"}
              </button>
            ))}
          </div>

          <div style={{ padding: "12px 14px 14px" }}>
            {fillMode === "gradient" && (
              <div
                ref={gradientPreviewRef}
                style={{
                  width: "100%",
                  height: 160,
                  borderRadius: 8,
                  position: "relative",
                  marginBottom: 12,
                  background: gradientToCss(gradientData),
                  cursor: "crosshair",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const rect = gradientPreviewRef.current!.getBoundingClientRect();
                  const mx = (e.clientX - rect.left) / rect.width;
                  const my = (e.clientY - rect.top) / rect.height;
                  const d0 = Math.hypot(mx - gradientData.x1, my - gradientData.y1);
                  const d1 = Math.hypot(mx - gradientData.x2, my - gradientData.y2);
                  const closest: 0 | 1 = d0 <= d1 ? 0 : 1;
                  draggingGradStop.current = closest;
                  selectGradientStop(closest);
                  handleGradStopDrag(e.clientX, e.clientY);
                }}
              >
                <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
                  <line
                    x1={`${gradientData.x1 * 100}%`} y1={`${gradientData.y1 * 100}%`}
                    x2={`${gradientData.x2 * 100}%`} y2={`${gradientData.y2 * 100}%`}
                    stroke="rgba(255,255,255,0.6)" strokeWidth="2"
                  />
                </svg>
                {([0, 1] as const).map((stopIdx) => {
                  const sx = stopIdx === 0 ? gradientData.x1 : gradientData.x2;
                  const sy = stopIdx === 0 ? gradientData.y1 : gradientData.y2;
                  const color = stopIdx === 0 ? gradientData.color1 : gradientData.color2;
                  const isActive = activeStop === stopIdx;
                  return (
                    <div
                      key={stopIdx}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        draggingGradStop.current = stopIdx;
                        selectGradientStop(stopIdx);
                      }}
                      style={{
                        position: "absolute",
                        left: `${sx * 100}%`,
                        top: `${sy * 100}%`,
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: color,
                        border: isActive ? "2.5px solid #fff" : "2px solid rgba(255,255,255,0.7)",
                        boxShadow: isActive
                          ? "0 0 0 2px rgba(91,95,199,0.5), 0 2px 8px rgba(0,0,0,0.5)"
                          : "0 0 4px rgba(0,0,0,0.5)",
                        transform: "translate(-50%, -50%)",
                        cursor: "grab",
                        zIndex: isActive ? 2 : 1,
                      }}
                    />
                  );
                })}
              </div>
            )}

            <div
              ref={satValRef}
              onMouseDown={(e) => {
                e.preventDefault();
                draggingSV.current = true;
                handleSVInteraction(e.clientX, e.clientY);
              }}
              style={{
                width: "100%",
                height: 160,
                borderRadius: 8,
                position: "relative",
                cursor: "crosshair",
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: `${hsv[1] * 100}%`,
                  top: `${(1 - hsv[2]) * 100}%`,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: "2.5px solid #fff",
                  boxShadow: "0 0 4px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.2)",
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "none",
                }}
              />
            </div>

            <div
              ref={hueRef}
              onMouseDown={(e) => {
                e.preventDefault();
                draggingHue.current = true;
                handleHueInteraction(e.clientX);
              }}
              style={{
                width: "100%",
                height: 12,
                borderRadius: 6,
                cursor: "pointer",
                background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                position: "relative",
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: `${(hsv[0] / 360) * 100}%`,
                  top: "50%",
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: "2.5px solid #fff",
                  boxShadow: "0 0 4px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.2)",
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "none",
                  background: hueColor,
                }}
              />
            </div>

            <div style={{
              display: "flex",
              alignItems: "stretch",
              gap: 6,
              marginBottom: 14,
            }}>
              {hasEyeDropper && (
                <button
                  onClick={handleEyeDropper}
                  title="Pick color from screen"
                  style={{
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(var(--tint-rgb), 0.06)",
                    border: "1px solid rgba(var(--tint-rgb), 0.08)",
                    borderRadius: 6,
                    color: "rgba(var(--tint-rgb), 0.5)",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                    transition: "color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; e.currentTarget.style.background = "rgba(var(--tint-rgb), 0.1)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(var(--tint-rgb), 0.5)"; e.currentTarget.style.background = "rgba(var(--tint-rgb), 0.06)"; }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13.5 2.5l-1.4-1.4a1 1 0 00-1.4 0L8.5 3.3l-.8-.8L6.3 3.9l1 1L2.7 9.5a2 2 0 00-.5 1v2.3a.5.5 0 00.5.5h2.3a2 2 0 001-.5l4.6-4.6 1 1 1.4-1.4-.8-.8 2.2-2.2a1 1 0 000-1.4z"/>
                  </svg>
                </button>
              )}
              <button
                onClick={cycleMode}
                title="Switch color mode"
                style={{
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(var(--tint-rgb), 0.06)",
                  border: "1px solid rgba(var(--tint-rgb), 0.08)",
                  borderRadius: 6,
                  color: "rgba(var(--tint-rgb), 0.5)",
                  cursor: "pointer",
                  padding: "0 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.5px",
                  flexShrink: 0,
                  transition: "color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; e.currentTarget.style.background = "rgba(var(--tint-rgb), 0.1)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(var(--tint-rgb), 0.5)"; e.currentTarget.style.background = "rgba(var(--tint-rgb), 0.06)"; }}
              >
                {colorMode}
              </button>

              {colorMode === "HEX" ? (
                <div style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  background: "rgba(var(--tint-rgb), 0.06)",
                  border: "1px solid rgba(var(--tint-rgb), 0.08)",
                  borderRadius: 6,
                  padding: "0 8px",
                  height: 32,
                  minWidth: 0,
                }}>
                  <span style={{ fontSize: 11, fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace", color: "rgba(var(--tint-rgb), 0.3)", pointerEvents: "none", userSelect: "none" }}>#</span>
                  <input
                    type="text"
                    value={hexInput.replace(/^#/, "").toUpperCase()}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/^#/, "").replace(/[^a-fA-F0-9]/g, "").slice(0, 6);
                      setHexInput("#" + raw);
                      const norm = normalizeHex(raw);
                      if (norm) {
                        const newHsv = hexToHsv(norm);
                        setHsv(newHsv);
                        updateFromHsv(newHsv);
                      }
                    }}
                    onBlur={handleHexSubmit}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") handleHexSubmit();
                    }}
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "none",
                      color: "var(--text-primary)",
                      fontSize: 12,
                      padding: 0,
                      fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
                      outline: "none",
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                      minWidth: 0,
                    }}
                  />
                </div>
              ) : (
                <div style={{ display: "flex", gap: 4, flex: 1, minWidth: 0 }}>
                  {ch.labels.map((lbl, i) => (
                    <div key={lbl} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "stretch", minWidth: 0 }}>
                      <div style={{
                        height: 32,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(var(--tint-rgb), 0.06)",
                        border: "1px solid rgba(var(--tint-rgb), 0.08)",
                        borderRadius: 6,
                        overflow: "hidden",
                      }}>
                        <ChannelInput
                          value={ch.values[i]}
                          max={ch.maxes[i]}
                          onChange={(val) => handleChannelChange(colorMode, i, val)}
                        />
                      </div>
                      <div style={fieldLabelStyle}>{lbl}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: canvasColors && canvasColors.length > 0 ? 14 : 0,
              padding: "8px 0 0",
              borderTop: "1px solid rgba(var(--tint-rgb), 0.06)",
            }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  border: "1px solid rgba(var(--tint-rgb), 0.12)",
                  background: currentHex,
                  flexShrink: 0,
                  boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                }}
                title={currentHex}
              />
              <span style={{ fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace", color: "rgba(var(--tint-rgb), 0.5)", letterSpacing: "0.3px" }}>
                {currentHex.toUpperCase()}
              </span>
            </div>

            {canvasColors && canvasColors.length > 0 && (
              <div>
                <div style={{ color: "rgba(var(--tint-rgb), 0.3)", fontSize: 10, marginBottom: 6, fontWeight: 500, letterSpacing: "0.3px" }}>
                  On This Canvas
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {canvasColors.map((c, i) => (
                    <div
                      key={`${c}-${i}`}
                      onClick={() => {
                        const norm = normalizeHex(c) || c;
                        setHsv(hexToHsv(norm));
                        setHexInput(norm.toUpperCase());
                        applyAndCommit(norm);
                      }}
                      title={c}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 5,
                        background: c,
                        cursor: "pointer",
                        border: c.toLowerCase() === currentHex.toLowerCase()
                          ? "2px solid var(--text-primary)"
                          : "1px solid rgba(var(--tint-rgb), 0.1)",
                        boxSizing: "border-box",
                        transition: "transform 0.1s",
                      }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.transform = "scale(1.1)"; }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = "scale(1)"; }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>,
      document.body)}
    </div>
  );
}

function ChannelInput({ value, max, onChange }: { value: number; max: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = () => {
    const parsed = parseInt(text, 10);
    if (!isNaN(parsed)) {
      onChange(clamp(parsed, 0, max));
    } else {
      setText(String(value));
    }
  };

  return (
    <input
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => { setFocused(true); }}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "ArrowUp") { e.preventDefault(); onChange(clamp(value + 1, 0, max)); }
        if (e.key === "ArrowDown") { e.preventDefault(); onChange(clamp(value - 1, 0, max)); }
      }}
      style={fieldInputStyle}
    />
  );
}