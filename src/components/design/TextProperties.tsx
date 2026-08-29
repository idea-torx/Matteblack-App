import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import type { ReferenceImage } from "../../types/canvas";
import NumericInput from "../NumericInput";

const SYSTEM_FONTS = [
  { value: "Inter, sans-serif", label: "Inter", type: "system" as const },
  { value: "Arial, sans-serif", label: "Arial", type: "system" as const },
  { value: "Helvetica, Arial, sans-serif", label: "Helvetica", type: "system" as const },
  { value: "Georgia, serif", label: "Georgia", type: "system" as const },
  { value: "'Times New Roman', serif", label: "Times New Roman", type: "system" as const },
  { value: "'Courier New', monospace", label: "Courier New", type: "system" as const },
  { value: "Verdana, sans-serif", label: "Verdana", type: "system" as const },
  { value: "Tahoma, sans-serif", label: "Tahoma", type: "system" as const },
  { value: "'Trebuchet MS', sans-serif", label: "Trebuchet MS", type: "system" as const },
  { value: "Impact, sans-serif", label: "Impact", type: "system" as const },
  { value: "monospace", label: "Monospace", type: "system" as const },
];

const GOOGLE_FONTS = [
  "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins",
  "Raleway", "Nunito", "Playfair Display", "Merriweather", "Ubuntu",
  "Oswald", "Rubik", "Noto Sans", "Roboto Condensed", "Roboto Mono",
  "Source Code Pro", "Fira Code", "JetBrains Mono", "Work Sans", "Quicksand",
  "Josefin Sans", "Barlow", "DM Sans", "Outfit", "Space Grotesk",
  "Manrope", "Sora", "Plus Jakarta Sans", "Lexend", "Archivo",
  "Bebas Neue", "Anton", "Righteous", "Permanent Marker", "Pacifico",
  "Dancing Script", "Caveat", "Satisfy", "Great Vibes", "Lobster",
  "Abril Fatface", "Cormorant Garamond", "Libre Baskerville", "EB Garamond", "Crimson Text",
  "Lora", "Bitter", "Noto Serif", "Source Serif 4", "PT Serif",
  "Space Mono", "IBM Plex Mono", "Inconsolata", "Anonymous Pro", "Overpass Mono",
  "Comfortaa", "Fredoka", "Baloo 2", "Titan One", "Bungee",
];

const loadedFonts = new Set<string>();

function loadGoogleFont(fontName: string) {
  if (loadedFonts.has(fontName)) return;
  loadedFonts.add(fontName);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@100;200;300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
}

const ALL_FONTS = [
  ...SYSTEM_FONTS,
  ...GOOGLE_FONTS.map((name) => ({
    value: `'${name}', sans-serif`,
    label: name,
    type: "google" as const,
  })),
];

const FONT_WEIGHTS = [
  { value: 100, label: "Thin" },
  { value: 200, label: "Extra Light" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semi Bold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Extra Bold" },
  { value: 900, label: "Black" },
] as const;

type TextPropertiesProps = {
  nodeIds: string[];
  selectedNodeMeta?: Map<string, ReferenceImage>;
  onUpdateNodeMetadata?: (nodeId: string, meta: Record<string, unknown>) => void;
};

export function TextProperties({
  nodeIds,
  selectedNodeMeta,
  onUpdateNodeMetadata,
}: TextPropertiesProps) {
  const updateAll = useCallback((key: string, value: unknown) => {
    nodeIds.forEach((id) => {
      onUpdateNodeMetadata?.(id, { [key]: value });
    });
  }, [nodeIds, onUpdateNodeMetadata]);

  const firstId = nodeIds[0];
  const firstMeta = selectedNodeMeta?.get(firstId);
  if (!firstMeta || firstMeta.nodeType !== "text") return null;

  return <TextPropertiesInner meta={firstMeta as ReferenceImage & Record<string, unknown>} updateAll={updateAll} />;
}

function FontSizeInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={focused ? draft : String(value)}
      onFocus={(e) => { setFocused(true); setDraft(String(value)); e.target.select(); }}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9]/g, "");
        setDraft(raw);
        if (raw !== "" && parseInt(raw, 10) > 0) {
          onChange(Math.min(999, parseInt(raw, 10)));
        }
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseInt(draft, 10);
        if (!n || n < 1) onChange(1);
        else onChange(Math.min(999, n));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); return; }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dir = e.key === "ArrowUp" ? 1 : -1;
          const next = Math.max(1, Math.min(999, value + step * dir));
          onChange(next);
          setDraft(String(next));
        }
      }}
      className="rpanel-url-input"
      style={{ width: 60, textAlign: "center" }}
    />
  );
}

function InlineNum({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(Math.round(value)));
  const [focused, setFocused] = useState(false);
  const prevValue = useRef(value);

  useEffect(() => {
    if (!focused && value !== prevValue.current) {
      setText(String(Math.round(value)));
    }
    prevValue.current = value;
  }, [value, focused]);

  const clamp = (v: number) => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const commit = () => {
    const parsed = parseFloat(text);
    if (!isNaN(parsed)) {
      onChange(clamp(Math.round(parsed)));
    } else {
      setText(String(Math.round(value)));
    }
  };

  return (
    <NumericInput
      className="rpanel-url-input"
      step={step}
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) onChange(clamp(Math.round(parsed)));
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
      }}
      style={{ textAlign: "center" }}
    />
  );
}

function TextPropertiesInner({ meta, updateAll }: { meta: ReferenceImage & Record<string, unknown>; updateAll: (key: string, value: unknown) => void }) {
  const fontFamily = (meta.fontFamily as string) || "Inter, sans-serif";
  const fontWeight = (meta.fontWeight as number) || 400;
  const fontSize = (meta.fontSize as number) || 48;
  const textAlign = (meta.textAlign as string) || "left";
  const letterSpacing = (meta.letterSpacing as number) || 0;
  const lineHeight = (meta.lineHeight as number) || 120;

  const [fontSearch, setFontSearch] = useState("");
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const currentFont = ALL_FONTS.find((f) => f.value === fontFamily);

  useEffect(() => {
    if (currentFont?.type === "google") {
      loadGoogleFont(currentFont.label);
    }
  }, [currentFont]);

  useEffect(() => {
    if (!fontDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFontDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [fontDropdownOpen]);

  useEffect(() => {
    if (fontDropdownOpen && searchRef.current) {
      searchRef.current.focus();
    }
  }, [fontDropdownOpen]);

  const filteredFonts = useMemo(() => {
    if (!fontSearch.trim()) return ALL_FONTS;
    const q = fontSearch.toLowerCase();
    return ALL_FONTS.filter((f) => f.label.toLowerCase().includes(q));
  }, [fontSearch]);

  const preloadedRef = useRef(false);
  useEffect(() => {
    if (fontDropdownOpen && !preloadedRef.current) {
      preloadedRef.current = true;
      GOOGLE_FONTS.forEach((f) => loadGoogleFont(f));
    }
  }, [fontDropdownOpen]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div ref={dropdownRef} style={{ position: "relative" }}>
        <span className="rpanel-setting-label">Font Family</span>
        <button
          type="button"
          onClick={() => setFontDropdownOpen((v) => !v)}
          className="rpanel-url-input"
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontFamily: currentFont?.type === "google" ? currentFont.value : undefined,
            textAlign: "left",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentFont?.label || "Inter"}
          </span>
          <span style={{ opacity: 0.4, fontSize: 10, marginLeft: 4 }}>▼</span>
        </button>

        {fontDropdownOpen && (
          <div
            className="font-picker-dropdown"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div style={{ padding: "8px 8px 4px" }}>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search fonts..."
                value={fontSearch}
                onChange={(e) => setFontSearch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                className="rpanel-url-input"
              />
            </div>
            <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
              {filteredFonts.map((f) => {
                const selected = f.value === fontFamily;
                return (
                  <button
                    key={f.value}
                    type="button"
                    className={`font-picker-item${selected ? " font-picker-item--selected" : ""}`}
                    onMouseEnter={() => {
                      if (f.type === "google") loadGoogleFont(f.label);
                    }}
                    onClick={() => {
                      if (f.type === "google") loadGoogleFont(f.label);
                      updateAll("fontFamily", f.value);
                      setFontDropdownOpen(false);
                      setFontSearch("");
                    }}
                    style={{ fontFamily: f.type === "google" ? f.value : undefined }}
                  >
                    <span>{f.label}</span>
                    {f.type === "google" && (
                      <span className="font-picker-item__badge">G</span>
                    )}
                  </button>
                );
              })}
              {filteredFonts.length === 0 && (
                <div className="font-picker-empty">No fonts found</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <span className="rpanel-setting-label">Weight</span>
          <select
            value={fontWeight}
            onChange={(e) => updateAll("fontWeight", Number(e.target.value))}
            className="rpanel-url-input"
            style={{ appearance: "auto" }}
          >
            {FONT_WEIGHTS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 0 }}>
          <span className="rpanel-setting-label">Size</span>
          <FontSizeInput value={fontSize} onChange={(v) => updateAll("fontSize", v)} />
        </div>
      </div>

      <div className="rpanel-align-row" style={{ marginTop: 8 }}>
        {([
          { val: "left", icon: <><line x1="3" y1="4" x2="21" y2="4" /><line x1="3" y1="9" x2="15" y2="9" /><line x1="3" y1="14" x2="21" y2="14" /><line x1="3" y1="19" x2="15" y2="19" /></> },
          { val: "center", icon: <><line x1="3" y1="4" x2="21" y2="4" /><line x1="6" y1="9" x2="18" y2="9" /><line x1="3" y1="14" x2="21" y2="14" /><line x1="6" y1="19" x2="18" y2="19" /></> },
          { val: "right", icon: <><line x1="3" y1="4" x2="21" y2="4" /><line x1="9" y1="9" x2="21" y2="9" /><line x1="3" y1="14" x2="21" y2="14" /><line x1="9" y1="19" x2="21" y2="19" /></> },
        ] as const).map((a) => (
          <button
            key={a.val}
            type="button"
            onClick={() => updateAll("textAlign", a.val)}
            className={`rpanel-align-btn ${textAlign === a.val ? "rpanel-list-btn--active" : ""}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {a.icon}
            </svg>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <div className="rpanel-inline-prop" style={{ flex: 1 }}>
          <span className="rpanel-inline-prop-icon" title="Letter Spacing">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 8h10" />
              <path d="M3 12l3-4 3 4" />
              <path d="M15 12l3-4 3 4" />
              <path d="M3 20h18" />
            </svg>
          </span>
          <div className="rpanel-inline-prop-input">
            <InlineNum min={-20} max={100} value={letterSpacing} onChange={(v) => updateAll("letterSpacing", v)} />
          </div>
        </div>
        <div className="rpanel-inline-prop" style={{ flex: 1 }}>
          <span className="rpanel-inline-prop-icon" title="Line Height">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 6H9" />
              <path d="M21 12H9" />
              <path d="M21 18H9" />
              <polyline points="4 8 4 16" />
              <polyline points="2 6 4 4 6 6" />
              <polyline points="2 18 4 20 6 18" />
            </svg>
          </span>
          <div className="rpanel-inline-prop-input">
            <InlineNum min={50} max={300} value={lineHeight} onChange={(v) => updateAll("lineHeight", v)} />
          </div>
        </div>
      </div>
    </div>
  );
}
