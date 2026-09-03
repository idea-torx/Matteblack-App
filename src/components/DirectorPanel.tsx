/**
 * H3 Max Director — a live fal WebRTC session you steer with prompts while it
 * streams. Signalling goes through /api/fal/proxy (the server adds the key);
 * the received stream is recorded and, on Stop, saved to the canvas as a clip.
 */
import { useEffect, useRef, useState } from "react";
import { createFalClient } from "@fal-ai/client";
import { wma, type ManagedRealtimeSession, type WmaRealtimeSession } from "@fal-ai/client/realtime";
import "./RightPanel.css";

/** fal standard rate; promo $0.02/s until 2026-09-14. Sessions bill a 60s minimum, >2min needs fal approval. */
export const DIRECTOR_RATE_USD = 0.08;
export const DIRECTOR_MIN_SECONDS = 60;
export const directorCost = (seconds: number) => Math.max(DIRECTOR_MIN_SECONDS, seconds) * DIRECTOR_RATE_USD;

type Status = "idle" | "opening" | "live" | "saving";
type Props = { onClose: () => void; onSave: (blob: Blob, seconds: number) => Promise<void> };

export function DirectorPanel({ onClose, onSave }: Props) {
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState<"480p" | "768p">("768p");
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [memory, setMemory] = useState(12);
  const [status, setStatus] = useState<Status>("idle");
  const [note, setNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [applied, setApplied] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<ManagedRealtimeSession<WmaRealtimeSession> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const versionRef = useRef(1);
  const startedRef = useRef(0);

  useEffect(() => {
    if (status !== "live") return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status]);
  useEffect(() => () => { sessionRef.current?.close(); }, []);

  const start = () => {
    setNote("");
    setElapsed(0);
    setApplied(0);
    chunksRef.current = [];
    versionRef.current = 1;
    setStatus("opening");
    const fal = createFalClient({ proxyUrl: "/api/fal/proxy" });
    const session = fal.realtime.open(wma("minimax/h3-max/director"), {
      receive: ["video", "audio"],
      onMedia: (stream) => {
        const v = videoRef.current;
        if (v) { v.srcObject = stream; v.play().catch(() => {}); }
        const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
        rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
        rec.start(1000);
        recorderRef.current = rec;
      },
      onData: (raw) => {
        let m: { type?: string; prompt_version?: number; message?: string; code?: string; reason?: string };
        try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "configured") { startedRef.current = Date.now(); setStatus("live"); setApplied(1); }
        else if (m.type === "prompt_applied") setApplied(m.prompt_version ?? 0);
        else if (m.type === "prompt_rejected" || m.type === "error") setNote(`${m.code ?? m.type}: ${m.message ?? ""}`);
        else if (m.type === "stream_exhausted") { setNote(m.reason === "session_limit" ? "Session limit reached" : ""); void stop(); }
      },
      // A close we did not start (network drop, runner gone) still saves what was recorded.
      onState: (s) => { if ((s === "failed" || s === "closed") && sessionRef.current) void stop(); },
      onError: (e) => setNote(e instanceof Error ? e.message : String(e)),
    }) as ManagedRealtimeSession<WmaRealtimeSession>;
    session.send({ type: "configure", protocol_version: 1, prompt, prompt_version: 1, memory, resolution, aspect_ratio: aspect });
    sessionRef.current = session;
  };

  const direct = () => {
    versionRef.current += 1;
    sessionRef.current?.send({ type: "prompt", prompt, prompt_version: versionRef.current });
  };

  const stop = async () => {
    const session = sessionRef.current;
    const rec = recorderRef.current;
    sessionRef.current = null;
    recorderRef.current = null;
    if (!session) return;
    const seconds = startedRef.current ? Math.round((Date.now() - startedRef.current) / 1000) : 0;
    setStatus("saving");
    session.send({ type: "stop" });
    const stopped = rec && rec.state !== "inactive" ? new Promise<void>((r) => { rec.onstop = () => r(); rec.stop(); }) : Promise.resolve();
    await stopped;
    session.close();
    try {
      if (chunksRef.current.length) await onSave(new Blob(chunksRef.current, { type: "video/webm" }), seconds);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("idle");
  };

  const live = status === "live";
  const busy = status === "opening" || status === "saving";
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-card">
          <div className="rpanel-card-body">
            <button type="button" className="rpanel-list-btn" onClick={onClose} disabled={live || busy}>← Back to models</button>
            <video ref={videoRef} autoPlay playsInline style={{ width: "100%", aspectRatio: aspect.replace(":", "/"), background: "#000", borderRadius: 6 }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              <span>{status === "idle" ? "Not started" : status === "opening" ? "Connecting…" : status === "saving" ? "Saving take…" : `LIVE ${mm}:${ss} · v${applied}`}</span>
              <span>${directorCost(elapsed).toFixed(2)}</span>
            </div>
            {note && <div style={{ fontSize: 12, color: "var(--c-red, #e66)", marginTop: 4 }}>{note}</div>}
          </div>
        </div>

        <div className="rpanel-card">
          <div className="rpanel-card-body">
            <textarea className="rpanel-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Direct the scene. Change it any time while live." />
            {live && (
              <button type="button" className="rpanel-action-btn" onClick={direct} disabled={!prompt.trim()}>Direct</button>
            )}
          </div>
        </div>

        {!live && (
          <div className="rpanel-card">
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {(["768p", "480p"] as const).map((r) => (
                  <button key={r} type="button" className={`rpanel-list-btn ${resolution === r ? "rpanel-list-btn--active" : ""}`} onClick={() => setResolution(r)} disabled={busy}>{r}</button>
                ))}
              </div>
              <div className="rpanel-list">
                {(["16:9", "9:16", "1:1"] as const).map((a) => (
                  <button key={a} type="button" className={`rpanel-list-btn ${aspect === a ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspect(a)} disabled={busy}>{a}</button>
                ))}
              </div>
              <div className="rpanel-slider-group">
                <div className="rpanel-slider-header"><span className="rpanel-slider-label">Memory</span><span className="rpanel-slider-value">{memory}</span></div>
                <input className="rpanel-slider" type="range" min={1} max={50} value={memory} onChange={(e) => setMemory(Number(e.target.value))} disabled={busy} />
              </div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>${DIRECTOR_RATE_USD}/s, {DIRECTOR_MIN_SECONDS}s minimum per session. Over 2 min needs fal approval.</div>
            </div>
          </div>
        )}
      </div>

      <div className="rpanel-footer">
        {live ? (
          <button type="button" className="rpanel-action-btn" onClick={() => void stop()}>Stop &amp; save take</button>
        ) : (
          <button type="button" className={`rpanel-action-btn ${busy || !prompt.trim() ? "rpanel-action-btn--disabled" : ""}`} onClick={start} disabled={busy || !prompt.trim()}>
            {status === "opening" ? "Connecting…" : status === "saving" ? "Saving…" : "Go live"}
          </button>
        )}
      </div>
    </aside>
  );
}
