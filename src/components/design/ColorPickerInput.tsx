import { useState, useRef, useEffect, useCallback } from "react";
import NumericInput from "../NumericInput";

function hexToHsb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s * 100, max * 100];
}

function hsbToHex(h: number, s: number, b: number): string {
  const sat = s / 100;
  const val = b / 100;
  const c = val * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = val - c;
  let r = 0, g = 0, bl = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; bl = x; }
  else if (h < 240) { g = x; bl = c; }
  else if (h < 300) { r = x; bl = c; }
  else { r = c; bl = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

type ColorPickerInputProps = {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
  showNone?: boolean;
  isNone?: boolean;
  onNoneToggle?: () => void;
};

export function ColorPickerInput({ value, onChange, label, showNone, isNone, onNoneToggle }: ColorPickerInputProps) {
  const [open, setOpen] = useState(false);
  const [hexText, setHexText] = useState(value.replace("#", ""));
  const [hsb, setHsb] = useState<[number, number, number]>(() => hexToHsb(value));
  const containerRef = useRef<HTMLDivElement>(null);
  const gradientRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingGradient = useRef(false);
  const draggingHue = useRef(false);

  useEffect(() => {
    setHexText(value.replace("#", ""));
    setHsb(hexToHsb(value));
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const commitHex = useCallback((raw: string) => {
    const clean = raw.replace(/[^a-fA-F0-9]/g, "").slice(0, 6);
    if (clean.length === 6) {
      const hex = `#${clean}`;
      onChange(hex);
      setHsb(hexToHsb(hex));
    }
    setHexText(clean);
  }, [onChange]);

  const updateFromHsb = useCallback((h: number, s: number, b: number) => {
    const clamped: [number, number, number] = [
      ((h % 360) + 360) % 360,
      Math.max(0, Math.min(100, s)),
      Math.max(0, Math.min(100, b)),
    ];
    setHsb(clamped);
    const hex = hsbToHex(clamped[0], clamped[1], clamped[2]);
    setHexText(hex.replace("#", ""));
    onChange(hex);
  }, [onChange]);

  const handleGradientInteraction = useCallback((clientX: number, clientY: number) => {
    if (!gradientRef.current) return;
    const rect = gradientRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    updateFromHsb(hsb[0], x * 100, (1 - y) * 100);
  }, [hsb, updateFromHsb]);

  const handleHueInteraction = useCallback((clientX: number) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    updateFromHsb(x * 360, hsb[1], hsb[2]);
  }, [hsb, updateFromHsb]);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (draggingGradient.current) handleGradientInteraction(e.clientX, e.clientY);
      if (draggingHue.current) handleHueInteraction(e.clientX);
    };
    const handleUp = () => {
      draggingGradient.current = false;
      draggingHue.current = false;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [handleGradientInteraction, handleHueInteraction]);

  const hueColor = hsbToHex(hsb[0], 100, 100);

  return (
    <div ref={containerRef} className="cpicker-root">
      <div className="cpicker-row">
        {label && <span className="cpicker-label">{label}</span>}
        <div className="cpicker-controls">
          <button
            type="button"
            className="cpicker-swatch"
            style={{ background: isNone ? "transparent" : value }}
            onClick={() => setOpen(!open)}
          >
            {isNone && (
              <svg width="14" height="14" viewBox="0 0 16 16" stroke="rgba(255,100,100,0.7)" strokeWidth="1.5" fill="none">
                <line x1="3" y1="13" x2="13" y2="3" />
              </svg>
            )}
          </button>
          <div className="cpicker-hex-wrap">
            <span className="cpicker-hash">#</span>
            <input
              type="text"
              className="cpicker-hex-input"
              value={hexText}
              maxLength={6}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^a-fA-F0-9]/g, "");
                setHexText(raw);
                if (raw.length === 6) commitHex(raw);
              }}
              onBlur={() => commitHex(hexText)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitHex(hexText);
              }}
              spellCheck={false}
            />
            {showNone && !isNone && (
              <button
                type="button"
                className="cpicker-clear"
                title="Remove color"
                onClick={onNoneToggle}
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
              className="cpicker-restore"
              onClick={onNoneToggle}
            >
              Add
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="cpicker-popover">
          <div
            ref={gradientRef}
            className="cpicker-gradient"
            style={{ background: hueColor }}
            onPointerDown={(e) => {
              draggingGradient.current = true;
              handleGradientInteraction(e.clientX, e.clientY);
            }}
          >
            <div className="cpicker-gradient-white" />
            <div className="cpicker-gradient-black" />
            <div
              className="cpicker-cursor"
              style={{
                left: `${hsb[1]}%`,
                top: `${100 - hsb[2]}%`,
              }}
            />
          </div>

          <div
            ref={hueRef}
            className="cpicker-hue-bar"
            onPointerDown={(e) => {
              draggingHue.current = true;
              handleHueInteraction(e.clientX);
            }}
          >
            <div
              className="cpicker-hue-thumb"
              style={{ left: `${(hsb[0] / 360) * 100}%` }}
            />
          </div>

          <div className="cpicker-values">
            <div className="cpicker-value-group">
              <span className="cpicker-value-label">H</span>
              <NumericInput
                className="cpicker-value-input"
                value={Math.round(hsb[0])}
                min={0}
                max={360}
                onChange={(e) => updateFromHsb(Number(e.target.value), hsb[1], hsb[2])}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="cpicker-value-group">
              <span className="cpicker-value-label">S</span>
              <NumericInput
                className="cpicker-value-input"
                value={Math.round(hsb[1])}
                min={0}
                max={100}
                onChange={(e) => updateFromHsb(hsb[0], Number(e.target.value), hsb[2])}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="cpicker-value-group">
              <span className="cpicker-value-label">B</span>
              <NumericInput
                className="cpicker-value-input"
                value={Math.round(hsb[2])}
                min={0}
                max={100}
                onChange={(e) => updateFromHsb(hsb[0], hsb[1], Number(e.target.value))}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
