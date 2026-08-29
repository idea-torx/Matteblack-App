import { useState, useEffect } from "react";
import { NODE_SCHEMAS, type WorkflowNode, type WorkflowEdge } from "./nodeTypes";
import "./RightPanel.css";

type Props = {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onClose: () => void;
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void;
  onDeleteNode: (nodeId: string) => void;
};

function getConnectedPromptValue(nodeId: string, portId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): string | null {
  const edge = edges.find((e) => e.targetNode === nodeId && e.targetPort === portId);
  if (!edge) return null;
  const sourceNode = nodes.find((n) => n.id === edge.sourceNode);
  if (!sourceNode) return null;
  if (sourceNode.type === "text") return (sourceNode.config.value as string) || "";
  if (sourceNode.type === "style") return (sourceNode.config.stylePrompt as string) || "";
  return null;
}

function TextInspector({ node, onConfigChange }: { node: WorkflowNode; onConfigChange: (id: string, c: Record<string, unknown>) => void }) {
  const [value, setValue] = useState((node.config.value as string) || "");
  return (
    <div className="rpanel-card rpanel-card--prompt">
      <h3 className="rpanel-card-title">Text Value</h3>
      <textarea
        className="rpanel-textarea"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onConfigChange(node.id, { ...node.config, value: e.target.value });
        }}
        placeholder="Enter text..."
      />
    </div>
  );
}

function ImageInspector({ node, nodes, edges, onConfigChange }: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onConfigChange: (id: string, c: Record<string, unknown>) => void;
}) {
  const [model, setModel] = useState((node.config.model as string) || "nano-banana-2");
  const [resolution, setResolution] = useState((node.config.resolution as string) || "1k");
  const [ar, setAr] = useState((node.config.ar as string) || "1:1");
  const [prompt, setPrompt] = useState((node.config.prompt as string) || "");

  const connectedPrompt = getConnectedPromptValue(node.id, "prompt", nodes, edges);
  const hasConnectedPrompt = connectedPrompt !== null;
  const displayPrompt = hasConnectedPrompt ? connectedPrompt : prompt;

  useEffect(() => {
    if (!hasConnectedPrompt) setPrompt((node.config.prompt as string) || "");
  }, [node.id, node.config.prompt, hasConnectedPrompt]);

  const update = (patch: Record<string, unknown>) => {
    onConfigChange(node.id, { ...node.config, ...patch });
  };

  return (
    <>
      <div className="rpanel-card rpanel-card--prompt" style={{ minHeight: 80 }}>
        <div className="rpanel-card-toggle" style={{ cursor: "default", marginBottom: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          <span className="rpanel-card-toggle-label">Prompt</span>
        </div>
        <textarea
          className="rpanel-textarea"
          placeholder={hasConnectedPrompt ? "Inherited from connected node" : "Describe the image..."}
          value={displayPrompt}
          readOnly={hasConnectedPrompt}
          onChange={(e) => { setPrompt(e.target.value); update({ prompt: e.target.value }); }}
        />
        {hasConnectedPrompt && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>Connected from text node</div>
        )}
      </div>
      <div className="rpanel-card">
        <div className="rpanel-card-title">Model</div>
        <div className="rpanel-list">
          {["nano-banana-2", "seedream"].map((m) => (
            <button key={m} type="button" className={`rpanel-list-btn ${model === m ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel(m); update({ model: m }); }}>
              {m === "nano-banana-2" ? (<><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" /><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path d="M5.84 14.09A6.68 6.68 0 0 1 5.5 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" /><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg> Nano Banana 2</>) : (<><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 16s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M2 12s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M18 8l2-2" /><circle cx="20" cy="6" r="0.5" fill="currentColor" /><path d="M6 16v2" /><path d="M10 16v1" /><path d="M14 16v2" /></svg> Seedream</>)}
            </button>
          ))}
        </div>
      </div>
      <div className="rpanel-card">
        <div className="rpanel-card-title">Resolution</div>
        <div className="rpanel-option-row">
          {["1k", "2k", "4k"].map((r) => (
            <button key={r} type="button" className={`rpanel-option ${resolution === r ? "rpanel-option--active" : ""}`} onClick={() => { setResolution(r); update({ resolution: r }); }}>
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="rpanel-card">
        <div className="rpanel-card-title">Aspect Ratio</div>
        <div className="rpanel-option-row">
          {["1:1", "4:3", "16:9", "9:16", "21:9"].map((a) => (
            <button key={a} type="button" className={`rpanel-option ${ar === a ? "rpanel-option--active" : ""}`} onClick={() => { setAr(a); update({ ar: a }); }}>
              {a}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function VideoInspector({ node, nodes, edges, onConfigChange }: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onConfigChange: (id: string, c: Record<string, unknown>) => void;
}) {
  const [model, setModel] = useState((node.config.model as string) || "kling-o3-pro");
  const [duration, setDuration] = useState((node.config.duration as string) || "5");
  const [generateAudio, setGenerateAudio] = useState((node.config.generateAudio as boolean) ?? true);
  const [prompt, setPrompt] = useState((node.config.prompt as string) || "");

  const connectedPrompt = getConnectedPromptValue(node.id, "prompt", nodes, edges);
  const hasConnectedPrompt = connectedPrompt !== null;
  const displayPrompt = hasConnectedPrompt ? connectedPrompt : prompt;

  useEffect(() => {
    if (!hasConnectedPrompt) setPrompt((node.config.prompt as string) || "");
  }, [node.id, node.config.prompt, hasConnectedPrompt]);

  const update = (patch: Record<string, unknown>) => {
    onConfigChange(node.id, { ...node.config, ...patch });
  };

  return (
    <>
      <div className="rpanel-card rpanel-card--prompt" style={{ minHeight: 80 }}>
        <div className="rpanel-card-toggle" style={{ cursor: "default", marginBottom: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          <span className="rpanel-card-toggle-label">Prompt</span>
        </div>
        <textarea
          className="rpanel-textarea"
          placeholder={hasConnectedPrompt ? "Inherited from connected node" : "Describe the motion or story for your video..."}
          value={displayPrompt}
          readOnly={hasConnectedPrompt}
          onChange={(e) => { setPrompt(e.target.value); update({ prompt: e.target.value }); }}
        />
        {hasConnectedPrompt && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>Connected from text node</div>
        )}
      </div>
      <div className="rpanel-card">
        <div className="rpanel-card-title">Model</div>
        <div className="rpanel-list">
          <button type="button" className={`rpanel-list-btn ${model === "kling-o3-pro" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("kling-o3-pro"); update({ model: "kling-o3-pro" }); }}>
            Kling O3 Pro
          </button>
          <button type="button" className={`rpanel-list-btn ${model === "kling-o3-4k" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("kling-o3-4k"); update({ model: "kling-o3-4k" }); }}>
            Kling O3 4K
          </button>
          <button type="button" className={`rpanel-list-btn ${model === "veo3.1-lite" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("veo3.1-lite"); update({ model: "veo3.1-lite" }); }}>
            Veo 3.1 Lite
          </button>
          <button type="button" className={`rpanel-list-btn ${model === "kling-3.0" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("kling-3.0"); update({ model: "kling-3.0" }); }}>
            Kling 3.0
            <span className="rpanel-tag">New</span>
          </button>
        </div>
      </div>
      <div className="rpanel-card">
        <div className="rpanel-card-title">Duration</div>
        <div className="rpanel-list">
          <button type="button" className={`rpanel-list-btn ${duration === "5" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setDuration("5"); update({ duration: "5" }); }}>
            5 seconds
          </button>
          <button type="button" className={`rpanel-list-btn ${duration === "10" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setDuration("10"); update({ duration: "10" }); }}>
            10 seconds
          </button>
        </div>
      </div>
      <div className="rpanel-card">
        <div className="rpanel-card-title">Audio</div>
        <div className="rpanel-toggle-row">
          <span className="rpanel-toggle-label">Generate Audio</span>
          <button
            type="button"
            className={`rpanel-toggle ${generateAudio ? "rpanel-toggle--on" : ""}`}
            onClick={() => { const v = !generateAudio; setGenerateAudio(v); update({ generateAudio: v }); }}
            aria-pressed={generateAudio}
          >
            <span className="rpanel-toggle-knob" />
          </button>
        </div>
      </div>
    </>
  );
}

function SliderInspector({ node, label, configKey, min, max, step, suffix, onConfigChange }: {
  node: WorkflowNode; label: string; configKey: string;
  min: number; max: number; step?: number; suffix?: string;
  onConfigChange: (id: string, c: Record<string, unknown>) => void;
}) {
  const [val, setVal] = useState((node.config[configKey] as number) ?? min);
  return (
    <div className="rpanel-card">
      <div className="rpanel-card-title">{label}</div>
      <div className="rpanel-slider-group">
        <div className="rpanel-slider-header">
          <span className="rpanel-slider-label">{label}</span>
          <span className="rpanel-slider-value">{val}{suffix || ""}</span>
        </div>
        <input type="range" className="rpanel-slider" min={min} max={max} step={step || 1} value={val}
          onChange={(e) => { const v = Number(e.target.value); setVal(v); onConfigChange(node.id, { ...node.config, [configKey]: v }); }} />
      </div>
    </div>
  );
}

function GenericInspector({ node }: { node: WorkflowNode }) {
  const schema = NODE_SCHEMAS[node.type];
  return (
    <div className="rpanel-card">
      <div className="rpanel-card-title">Info</div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
        {schema.description}
      </p>
      {node.inputs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Inputs: </span>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{node.inputs.map((p) => p.label).join(", ")}</span>
        </div>
      )}
      {node.outputs.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Outputs: </span>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{node.outputs.map((p) => p.label).join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function renderInspectorContent(node: WorkflowNode, nodes: WorkflowNode[], edges: WorkflowEdge[], onConfigChange: (id: string, c: Record<string, unknown>) => void) {
  switch (node.type) {
    case "text":
      return <TextInspector node={node} onConfigChange={onConfigChange} />;
    case "image":
      return <ImageInspector node={node} nodes={nodes} edges={edges} onConfigChange={onConfigChange} />;
    case "video":
      return <VideoInspector node={node} nodes={nodes} edges={edges} onConfigChange={onConfigChange} />;
    case "upscale":
      return <SliderInspector node={node} label="Scale" configKey="scale" min={2} max={4} onConfigChange={onConfigChange} suffix="x" />;
    default:
      return <GenericInspector node={node} />;
  }
}

export function NodeInspectorPanel({ node, nodes, edges, onClose, onConfigChange, onDeleteNode }: Props) {
  const schema = NODE_SCHEMAS[node.type];

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0 8px" }}>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {schema.label}
          </span>
          <button type="button" onClick={onClose} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,0.06)", color: "var(--text-secondary)", cursor: "pointer", transition: "background 0.12s, color 0.12s", border: "none" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {renderInspectorContent(node, nodes, edges, onConfigChange)}
      </div>

      <div className="rpanel-footer">
        <button type="button" className="rpanel-action-btn" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          Run from here
        </button>
        <button
          type="button"
          onClick={() => onDeleteNode(node.id)}
          style={{ width: "100%", fontSize: 12, color: "var(--text-muted)", padding: "8px 0", borderRadius: 6, textAlign: "center", transition: "color 0.12s, background 0.12s", background: "none", border: "none", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#f87171"; e.currentTarget.style.background = "rgba(248,113,113,0.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
        >
          Delete Node
        </button>
      </div>
    </aside>
  );
}
