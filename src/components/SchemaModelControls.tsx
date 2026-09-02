import { useEffect, useMemo, useState } from "react";
import "./RightPanel.css";
import { registerCustomModelLabels } from "../utils/modelLabels";

/**
 * Controls for a custom (user/operator-added) fal model, rendered straight from
 * the endpoint's own OpenAPI input schema. No per-model code: enum -> select,
 * number -> range + box, boolean -> checkbox, string -> text/textarea, array ->
 * one URL per line.
 */
export type SchemaField = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  items?: SchemaField;
};

export type ModelSchema = {
  type?: string;
  properties?: Record<string, SchemaField>;
  required?: string[];
};

const label = (name: string, f: SchemaField) => f.title || name.replace(/_/g, " ");

export function SchemaModelControls({
  schema,
  defaults,
  values,
  onChange,
  hidden = [],
}: {
  schema: ModelSchema;
  defaults?: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Fields the Make panel already supplies from its own controls. */
  hidden?: string[];
}) {
  const fields = useMemo(
    () => Object.entries(schema.properties ?? {}).filter(([name]) => !hidden.includes(name)),
    [schema, hidden],
  );
  const required = new Set(schema.required ?? []);
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  const valueOf = (name: string, f: SchemaField) => {
    const v = values[name];
    if (v !== undefined) return v;
    const d = defaults?.[name];
    return d !== undefined ? d : f.default;
  };

  if (fields.length === 0) return null;

  return (
    <div className="rpanel-card">
      <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Model Settings</h3>
      {fields.map(([name, f]) => {
        const v = valueOf(name, f);
        const title = (
          <span className="rpanel-flat-label" style={{ display: "block", marginBottom: 4, textTransform: "capitalize" }}>
            {label(name, f)}
            {required.has(name) && <span className="rpanel-tag" style={{ marginLeft: 6, fontSize: 9 }}>required</span>}
          </span>
        );

        if (Array.isArray(f.enum) && f.enum.length > 0) {
          return (
            <div key={name} style={{ marginBottom: 10 }}>
              {title}
              <select className="rpanel-select" value={String(v ?? "")} onChange={(e) => set(name, e.target.value)}>
                {!required.has(name) && <option value="">—</option>}
                {f.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
              </select>
            </div>
          );
        }

        if (f.type === "boolean") {
          return (
            <label key={name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={v === true} onChange={(e) => set(name, e.target.checked)} />
              <span className="rpanel-flat-label" style={{ textTransform: "capitalize" }}>{label(name, f)}</span>
            </label>
          );
        }

        if (f.type === "integer" || f.type === "number") {
          const step = f.type === "integer" ? 1 : "any";
          const bounded = typeof f.minimum === "number" && typeof f.maximum === "number";
          return (
            <div key={name} style={{ marginBottom: 10 }}>
              {title}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {bounded && (
                  <input
                    type="range" style={{ flex: 1 }}
                    min={f.minimum} max={f.maximum} step={step}
                    value={Number(v ?? f.minimum)}
                    onChange={(e) => set(name, Number(e.target.value))}
                  />
                )}
                <input
                  className="rpanel-select" type="number" style={{ width: bounded ? 80 : "100%" }}
                  min={f.minimum} max={f.maximum} step={step}
                  value={v === undefined || v === null ? "" : String(v)}
                  onChange={(e) => set(name, e.target.value === "" ? undefined : Number(e.target.value))}
                />
              </div>
            </div>
          );
        }

        if (f.type === "array") {
          const lines = Array.isArray(v) ? (v as unknown[]).join("\n") : String(v ?? "");
          return (
            <div key={name} style={{ marginBottom: 10 }}>
              {title}
              <textarea
                className="rpanel-textarea" rows={3} placeholder="One URL per line"
                value={lines}
                onChange={(e) => set(name, e.target.value.split("\n").map((l) => l.trim()).filter(Boolean))}
              />
            </div>
          );
        }

        // Strings. Anything prompt-ish gets the panel's textarea.
        const long = /prompt|text|lyrics|description/i.test(name);
        return (
          <div key={name} style={{ marginBottom: 10 }}>
            {title}
            {long ? (
              <textarea className="rpanel-textarea" rows={3} value={String(v ?? "")} onChange={(e) => set(name, e.target.value)} />
            ) : (
              <input className="rpanel-select" type="text" value={String(v ?? "")} onChange={(e) => set(name, e.target.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default SchemaModelControls;

// ---------------------------------------------------------------------------
// Custom model list + "Add model…" affordance, shared by the image and video
// sections of the Make panel.
// ---------------------------------------------------------------------------

export type CustomModel = {
  key: string;
  falModelId: string;
  type: "image" | "video" | "audio";
  title: string;
  schema: ModelSchema;
  defaults: Record<string, unknown>;
};

/** Fields the Make panel already fills from its own controls — no point
 *  rendering a second box for them. */
export const PANEL_SUPPLIED = [
  "prompt", "image_url", "image_urls", "reference_image_urls",
  "aspect_ratio", "num_images",
];

export function useCustomModels(): { models: CustomModel[]; reload: () => void } {
  const [models, setModels] = useState<CustomModel[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/models/custom", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d) => { if (!live) return; setModels(d.models ?? []); registerCustomModelLabels(d.models ?? []); })
      .catch(() => { /* no custom models is the normal case */ });
    return () => { live = false; };
  }, [tick]);
  return { models, reload: () => setTick((t) => t + 1) };
}

export function CustomModelGroup({
  models, mediaType, selected, onSelect, onAdded,
}: {
  models: CustomModel[];
  mediaType: "image" | "video" | "audio";
  selected: string | null;
  onSelect: (key: string | null) => void;
  onAdded: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = models.filter((m) => m.type === mediaType);

  const add = async () => {
    const id = endpoint.trim();
    if (!id) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpointId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || "Could not add that model."); return; }
      setEndpoint(""); setAdding(false);
      onAdded();
      onSelect(data.model?.key ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {mine.map((m) => (
        <button
          key={m.key} type="button"
          className={`rpanel-list-btn ${selected === m.key ? "rpanel-list-btn--active" : ""}`}
          onClick={() => onSelect(m.key)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2L12 16.6 5.7 21l2.3-7.2-6-4.4h7.6z" /></svg>
          {m.title}
          <span className="rpanel-tag">Custom</span>
        </button>
      ))}
      {adding ? (
        <div style={{ display: "flex", gap: 6, padding: "4px 0" }}>
          <input
            className="rpanel-select" type="text" autoFocus style={{ flex: 1 }}
            placeholder="fal-ai/flux/schnell"
            value={endpoint} disabled={busy}
            onChange={(e) => setEndpoint(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); if (e.key === "Escape") setAdding(false); }}
          />
          <button type="button" className="rpanel-list-btn" disabled={busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      ) : (
        <button type="button" className="rpanel-list-btn" onClick={() => setAdding(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Add model…
        </button>
      )}
      {error && <span className="rpanel-flat-label" style={{ color: "var(--danger, #e55)" }}>{error}</span>}
    </>
  );
}
