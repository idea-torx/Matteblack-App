import { useState, useEffect, useRef, useCallback } from "react";
import "./StyleGuidePage.css";
import "./RightPanel.css";
import "./LeftToolbar.css";
import "./Header.css";

const SECTIONS = [
  { id: "colors", label: "Colors" },
  { id: "typography", label: "Typography" },
  { id: "spacing", label: "Spacing" },
  { id: "buttons", label: "Buttons" },
  { id: "inputs", label: "Inputs" },
  { id: "cards", label: "Cards" },
  { id: "icons", label: "Icons" },
  { id: "sidebar-items", label: "Sidebar Items" },
];

const THEME_COLORS: { varName: string; label: string }[] = [
  { varName: "--bg-base", label: "Background Base" },
  { varName: "--bg-surface", label: "Background Surface" },
  { varName: "--bg-raised", label: "Background Raised" },
  { varName: "--bg-hover", label: "Background Hover" },
  { varName: "--bg-active", label: "Background Active" },
  { varName: "--border", label: "Border" },
  { varName: "--text-primary", label: "Text Primary" },
  { varName: "--text-secondary", label: "Text Secondary" },
  { varName: "--text-muted", label: "Text Muted" },
  { varName: "--accent", label: "Accent" },
  { varName: "--accent-hover", label: "Accent Hover" },
  { varName: "--accent-dim", label: "Accent Dim" },
];

const STATUS_COLORS: { varName: string; value: string; label: string }[] = [
  { varName: "#ef4444", value: "#ef4444", label: "Danger / Error Red" },
  { varName: "#ff6b6b", value: "#ff6b6b", label: "Error Light" },
  { varName: "#22c55e", value: "#22c55e", label: "Success Green" },
  { varName: "#f59e0b", value: "#f59e0b", label: "Warning Amber" },
  { varName: "#f97316", value: "#f97316", label: "Video Orange" },
  { varName: "#14b8a6", value: "#14b8a6", label: "Upscale Teal" },
];

const SPACING_SCALE = [4, 6, 8, 10, 12, 16, 20, 24, 32, 48];

const TYPOGRAPHY_SCALE = [
  { tag: "h1", size: "28px", weight: 700, lineHeight: 1.2, sample: "Heading 1" },
  { tag: "h2", size: "22px", weight: 700, lineHeight: 1.25, sample: "Heading 2" },
  { tag: "h3", size: "18px", weight: 700, lineHeight: 1.3, sample: "Heading 3" },
  { tag: "h4", size: "16px", weight: 600, lineHeight: 1.35, sample: "Heading 4" },
  { tag: "h5", size: "14px", weight: 600, lineHeight: 1.4, sample: "Heading 5" },
  { tag: "h6", size: "13px", weight: 600, lineHeight: 1.4, sample: "Heading 6" },
  { tag: "body", size: "13px", weight: 400, lineHeight: 1.4, sample: "Body text — The quick brown fox jumps over the lazy dog. This is the default text style used across the application." },
  { tag: "caption", size: "11px", weight: 400, lineHeight: 1.4, sample: "Caption text — Used for timestamps, metadata, and secondary information." },
  { tag: "label", size: "12px", weight: 600, lineHeight: 1.3, sample: "LABEL TEXT" },
];

const ICONS: { name: string; svg: React.ReactNode }[] = [
  { name: "Home", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg> },
  { name: "Sidebar Toggle", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg> },
  { name: "Canvas", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 3v6" /></svg> },
  { name: "Create", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg> },
  { name: "Upscale", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg> },
  { name: "Resize", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg> },
  { name: "Remove BG", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg> },
  { name: "Avatar", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg> },
  { name: "Audio", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg> },
  { name: "Microphone", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg> },
  { name: "SFX", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg> },
  { name: "Nodes", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8.6 8.6L15.4 15.4" /></svg> },
  { name: "Shield", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg> },
  { name: "Search", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg> },
  { name: "Clipboard", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /></svg> },
  { name: "Bell", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg> },
  { name: "Chevron Down", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg> },
  { name: "Close", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg> },
  { name: "Grid", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg> },
  { name: "Star", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg> },
  { name: "Play", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 20 12 8 19" /></svg> },
  { name: "Pause", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg> },
  { name: "Mute", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg> },
  { name: "Image", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg> },
  { name: "Video", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg> },
  { name: "Palette", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r="2.5" /><circle cx="19" cy="17" r="2.5" /><circle cx="6" cy="12" r="2.5" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.75 1.5-1.5 0-.39-.15-.74-.39-1.02-.24-.28-.37-.62-.37-.98 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.52-4.48-10-10-10z" /></svg> },
  { name: "Trash", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg> },
  { name: "GIF", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2" /><path d="M10 8v8l6-4-6-4z" /></svg> },
  { name: "Vector", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" /><line x1="12" y1="22" x2="12" y2="15.5" /><polyline points="22 8.5 12 15.5 2 8.5" /></svg> },
  { name: "Cinema", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /></svg> },
  { name: "Voice Changer", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><polyline points="17 11 19 13 23 9" /></svg> },
  { name: "More", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg> },
  { name: "Fit", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg> },
  { name: "Align Left", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="2" x2="4" y2="22" /><rect x="8" y="4" width="12" height="6" rx="1" /><rect x="8" y="14" width="8" height="6" rx="1" /></svg> },
  { name: "Star (filled)", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" /></svg> },
  { name: "Save", svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg> },
];

function resolveColor(varName: string): string {
  const el = document.documentElement;
  const raw = getComputedStyle(el).getPropertyValue(varName).trim();
  if (!raw) return "";
  const temp = document.createElement("div");
  temp.style.color = raw;
  document.body.appendChild(temp);
  const computed = getComputedStyle(temp).color;
  document.body.removeChild(temp);
  return computed;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [text]);
  return (
    <button
      type="button"
      className={`sg-copy-btn ${copied ? "sg-copy-btn--copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function ColorSwatch({ varName, label, fixedValue }: { varName: string; label: string; fixedValue?: string }) {
  const [resolved, setResolved] = useState("");
  useEffect(() => {
    if (fixedValue) {
      setResolved(fixedValue);
    } else {
      setResolved(resolveColor(varName));
    }
  }, [varName, fixedValue]);

  const bg = fixedValue || `var(${varName})`;
  const copyText = fixedValue || varName;

  return (
    <div className="sg-color-swatch">
      <div className="sg-color-preview" style={{ background: bg }} />
      <div className="sg-color-info">
        <span className="sg-color-label">{label}</span>
        <span className="sg-color-var">{varName}</span>
        <span className="sg-color-value">{resolved}</span>
        <CopyButton text={copyText} />
      </div>
    </div>
  );
}

export function StyleGuidePage() {
  const [activeSection, setActiveSection] = useState("colors");
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { root: main, rootMargin: "-20% 0px -70% 0px", threshold: 0 }
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="sg">
      <nav className="sg-sidebar">
        <div className="sg-sidebar-title">Style Guide</div>
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`sg-sidebar-link ${activeSection === id ? "sg-sidebar-link--active" : ""}`}
            onClick={() => scrollTo(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="sg-main" ref={mainRef}>
        <a href="/" className="sg-back-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
          Back to app
        </a>
        <h1 className="sg-page-title">Design System</h1>
        <p className="sg-page-subtitle">
          Living style guide — reference for all visual patterns used in the platform.
          Dev-only, not shipped to production.
        </p>

        <section className="sg-section" id="colors">
          <h2 className="sg-section-title">Colors</h2>
          <p className="sg-section-desc">Theme CSS custom properties</p>
          <div className="sg-color-grid">
            {THEME_COLORS.map((c) => (
              <ColorSwatch key={c.varName} varName={c.varName} label={c.label} />
            ))}
          </div>
          <h3 className="sg-section-title" style={{ marginTop: 32 }}>Status Colors</h3>
          <p className="sg-section-desc">Semantic colors used across components</p>
          <div className="sg-color-grid">
            {STATUS_COLORS.map((c) => (
              <ColorSwatch key={c.varName} varName={c.varName} label={c.label} fixedValue={c.value} />
            ))}
          </div>
        </section>

        <section className="sg-section" id="typography">
          <h2 className="sg-section-title">Typography</h2>
          <p className="sg-section-desc">Heading levels, body, caption, and label styles using Satoshi at 13px base</p>
          <div className="sg-typo-list">
            {TYPOGRAPHY_SCALE.map((t) => (
              <div key={t.tag} className="sg-typo-item">
                <span
                  style={{
                    fontSize: t.size,
                    fontWeight: t.weight,
                    lineHeight: t.lineHeight,
                    letterSpacing: t.tag === "label" ? "0.04em" : undefined,
                    textTransform: t.tag === "label" ? "uppercase" : undefined,
                  }}
                >
                  {t.sample}
                </span>
                <div className="sg-typo-meta">
                  <span>&lt;{t.tag}&gt;</span>
                  <span>{t.size}</span>
                  <span>weight: {t.weight}</span>
                  <span>line-height: {t.lineHeight}</span>
                  <span>Satoshi</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="sg-section" id="spacing">
          <h2 className="sg-section-title">Spacing</h2>
          <p className="sg-section-desc">Spacing scale used throughout the codebase</p>
          <div className="sg-spacing-list">
            {SPACING_SCALE.map((px) => (
              <div key={px} className="sg-spacing-item">
                <span className="sg-spacing-label">{px}px</span>
                <div className="sg-spacing-bar" style={{ width: px * 4 }} />
                <CopyButton text={`${px}px`} />
              </div>
            ))}
          </div>
        </section>

        <section className="sg-section" id="buttons">
          <h2 className="sg-section-title">Buttons</h2>
          <p className="sg-section-desc">Button variants matching actual CSS classes used in the app</p>
          <div className="sg-btn-grid">
            <div>
              <div className="sg-btn-row-label">Primary Action (.rpanel-action-btn)</div>
              <div className="sg-btn-row">
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn" style={{ width: 160 }}>Default</button>
                  <span className="sg-inline-label">Default</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn" style={{ width: 160, background: "var(--accent-hover)" }}>Hover</button>
                  <span className="sg-inline-label">Hover</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn" style={{ width: 160, background: "#1d4ed8" }}>Active</button>
                  <span className="sg-inline-label">Active</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn rpanel-action-btn--disabled" style={{ width: 160 }} disabled>Disabled</button>
                  <span className="sg-inline-label">Disabled</span>
                </div>
              </div>
            </div>

            <div>
              <div className="sg-btn-row-label">Secondary / Mode Toggle (.rpanel-mode-btn)</div>
              <div className="sg-btn-row">
                <div className="sg-btn-state">
                  <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 4, display: "inline-flex" }}>
                    <button type="button" className="rpanel-mode-btn" style={{ padding: "7px 20px" }}>Default</button>
                  </div>
                  <span className="sg-inline-label">Default</span>
                </div>
                <div className="sg-btn-state">
                  <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 4, display: "inline-flex" }}>
                    <button type="button" className="rpanel-mode-btn" style={{ padding: "7px 20px", color: "var(--text-secondary)" }}>Hover</button>
                  </div>
                  <span className="sg-inline-label">Hover</span>
                </div>
                <div className="sg-btn-state">
                  <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 4, display: "inline-flex" }}>
                    <button type="button" className="rpanel-mode-btn rpanel-mode-btn--active" style={{ padding: "7px 20px" }}>Active</button>
                  </div>
                  <span className="sg-inline-label">Active</span>
                </div>
                <div className="sg-btn-state">
                  <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 4, display: "inline-flex" }}>
                    <button type="button" className="rpanel-mode-btn" style={{ padding: "7px 20px", opacity: 0.4, cursor: "not-allowed" }} disabled>Disabled</button>
                  </div>
                  <span className="sg-inline-label">Disabled</span>
                </div>
              </div>
            </div>

            <div>
              <div className="sg-btn-row-label">Ghost / Icon (.hdr-icon-btn, .sidebar-expand-btn)</div>
              <div className="sg-btn-row">
                <div className="sg-btn-state">
                  <button type="button" className="hdr-icon-btn" style={{ width: 32, height: 32 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
                  </button>
                  <span className="sg-inline-label">Default</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="hdr-icon-btn" style={{ width: 32, height: 32, color: "var(--text-secondary)", background: "var(--bg-hover)" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
                  </button>
                  <span className="sg-inline-label">Hover</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="hdr-icon-btn hdr-icon-btn--active" style={{ width: 32, height: 32 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
                  </button>
                  <span className="sg-inline-label">Active</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="hdr-icon-btn" style={{ width: 32, height: 32, opacity: 0.4, cursor: "not-allowed" }} disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
                  </button>
                  <span className="sg-inline-label">Disabled</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="sidebar-expand-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
                  </button>
                  <span className="sg-inline-label">Expand Default</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="sidebar-expand-btn" style={{ color: "var(--text-secondary)", background: "var(--bg-hover)" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
                  </button>
                  <span className="sg-inline-label">Expand Hover</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="sidebar-expand-btn" style={{ color: "var(--text-primary)", background: "var(--bg-hover)" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
                  </button>
                  <span className="sg-inline-label">Expand Active</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="sidebar-expand-btn" style={{ opacity: 0.4, cursor: "not-allowed" }} disabled>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
                  </button>
                  <span className="sg-inline-label">Expand Disabled</span>
                </div>
              </div>
            </div>

            <div>
              <div className="sg-btn-row-label">Destructive (Danger Red)</div>
              <div className="sg-btn-row">
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn" style={{ width: 160, background: "#ef4444" }}>Delete</button>
                  <span className="sg-inline-label">Default</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn" style={{ width: 160, background: "#dc2626" }}>Hover</button>
                  <span className="sg-inline-label">Hover</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn" style={{ width: 160, background: "#b91c1c" }}>Active</button>
                  <span className="sg-inline-label">Active</span>
                </div>
                <div className="sg-btn-state">
                  <button type="button" className="rpanel-action-btn rpanel-action-btn--disabled" style={{ width: 160, background: "#ef4444" }} disabled>Disabled</button>
                  <span className="sg-inline-label">Disabled</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="sg-section" id="inputs">
          <h2 className="sg-section-title">Inputs</h2>
          <p className="sg-section-desc">Text input, textarea, and select elements styled to match existing patterns</p>
          <div className="sg-input-grid">
            <div className="sg-input-group">
              <div className="sg-input-group-label">Text Input (.rpanel-search style)</div>
              <div className="sg-input-row">
                <input className="rpanel-search" type="text" placeholder="Default input" style={{ marginBottom: 0 }} readOnly />
                <input className="rpanel-search" type="text" placeholder="Focus state" style={{ marginBottom: 0, borderColor: "rgba(59, 130, 246, 0.5)", background: "rgba(255, 255, 255, 0.05)" }} readOnly />
                <input className="rpanel-search" type="text" defaultValue="Error state" style={{ marginBottom: 0, borderColor: "#ef4444", background: "rgba(239, 68, 68, 0.05)" }} readOnly />
                <input className="rpanel-search" type="text" placeholder="Disabled" style={{ marginBottom: 0, opacity: 0.4 }} disabled />
              </div>
            </div>

            <div className="sg-input-group">
              <div className="sg-input-group-label">Editable Prompt (.rpanel-prompt-editable style)</div>
              <div className="sg-input-row">
                <div className="rpanel-card rpanel-card--prompt" style={{ width: 260, minHeight: "auto" }}>
                  <div
                    className="rpanel-prompt-editable"
                    contentEditable
                    suppressContentEditableWarning
                    data-placeholder="Enter your prompt here..."
                    style={{ minHeight: 60, marginTop: 0 }}
                  />
                </div>
                <div className="rpanel-card rpanel-card--prompt" style={{ width: 260, minHeight: "auto", opacity: 0.4 }}>
                  <div
                    className="rpanel-prompt-editable"
                    data-placeholder="Disabled prompt"
                    style={{ minHeight: 60, marginTop: 0, pointerEvents: "none" }}
                  />
                </div>
              </div>
            </div>

            <div className="sg-input-group">
              <div className="sg-input-group-label">Textarea (.rpanel-textarea style)</div>
              <div className="sg-input-row">
                <div className="rpanel-card" style={{ width: 260 }}>
                  <textarea className="rpanel-textarea" placeholder="Write something..." style={{ minHeight: 60, marginTop: 0 }} readOnly />
                </div>
                <div className="rpanel-card" style={{ width: 260, opacity: 0.4 }}>
                  <textarea className="rpanel-textarea" placeholder="Disabled" style={{ minHeight: 60, marginTop: 0 }} disabled />
                </div>
              </div>
            </div>

            <div className="sg-input-group">
              <div className="sg-input-group-label">Select</div>
              <div className="sg-input-row">
                <select className="rpanel-search" style={{ marginBottom: 0, width: 260, appearance: "auto" }}>
                  <option>Option 1</option>
                  <option>Option 2</option>
                  <option>Option 3</option>
                </select>
                <select className="rpanel-search" style={{ marginBottom: 0, width: 260, appearance: "auto", opacity: 0.4 }} disabled>
                  <option>Disabled</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className="sg-section" id="cards">
          <h2 className="sg-section-title">Cards</h2>
          <p className="sg-section-desc">Card variants matching rpanel-card patterns</p>
          <div className="sg-card-grid">
            <div className="sg-card sg-card--surface">
              <div className="sg-card-title">Surface Card</div>
              <div className="sg-card-body">Flat card on --bg-surface. Used for content sections that sit just above the base layer.</div>
              <div className="sg-card-variant-label">bg-surface</div>
            </div>
            <div className="sg-card sg-card--elevated">
              <div className="sg-card-title">Elevated Card</div>
              <div className="sg-card-body">Card with subtle shadow on --bg-raised. Used for dropdowns, popovers, and raised content.</div>
              <div className="sg-card-variant-label">bg-raised + shadow</div>
            </div>
            <div className="sg-card sg-card--bordered">
              <div className="sg-card-title">Bordered Card</div>
              <div className="sg-card-body">Card with visible border. Matches the rpanel-card pattern used for tool panels.</div>
              <div className="sg-card-variant-label">rgba border</div>
            </div>
          </div>
        </section>

        <section className="sg-section" id="icons">
          <h2 className="sg-section-title">Icons</h2>
          <p className="sg-section-desc">Inline SVG icons extracted from LeftToolbar, Header, RightPanel, FreeformCanvas, and LibraryPanel</p>
          <div className="sg-icon-grid">
            {ICONS.map((icon) => (
              <div key={icon.name} className="sg-icon-cell">
                {icon.svg}
                <span className="sg-icon-label">{icon.name}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="sg-section" id="sidebar-items">
          <h2 className="sg-section-title">Sidebar Items</h2>
          <p className="sg-section-desc">Navigation item states from LeftToolbar: parent, child, active, and hover</p>

          <div className="sg-sidebar-items-demo">
            <div className="sg-state-label">Parent — Default</div>
            <button type="button" className="nav-row nav-row--parent">
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 3v6" /></svg>
              </span>
              <span className="nav-row-label">Canvas</span>
              <svg className="nav-row-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            <div className="sg-state-label">Parent — Active</div>
            <button type="button" className="nav-row nav-row--parent nav-row--active">
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 3v6" /></svg>
              </span>
              <span className="nav-row-label">Canvas</span>
              <svg className="nav-row-chevron nav-row-chevron--open" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            <div className="sg-state-label">Parent — Hover</div>
            <button type="button" className="nav-row nav-row--parent" style={{ color: "var(--text-primary)", background: "var(--bg-hover)" }}>
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 3v6" /></svg>
              </span>
              <span className="nav-row-label">Canvas</span>
              <svg className="nav-row-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            <div className="sg-state-label">Child — Default</div>
            <button type="button" className="nav-row nav-row--child">
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
              </span>
              <span className="nav-row-label">Create</span>
            </button>

            <div className="sg-state-label">Child — Hover</div>
            <button type="button" className="nav-row nav-row--child" style={{ color: "var(--text-primary)", background: "var(--bg-hover)" }}>
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
              </span>
              <span className="nav-row-label">Create</span>
            </button>

            <div className="sg-state-label">Child — Active</div>
            <button type="button" className="nav-row nav-row--child nav-row--active">
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
              </span>
              <span className="nav-row-label">Create</span>
            </button>

            <div className="sg-state-label">Pending</div>
            <button type="button" className="nav-row nav-row--parent nav-row--pending" disabled>
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /></svg>
              </span>
              <span className="nav-row-label">Cinema</span>
              <svg className="nav-row-lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
