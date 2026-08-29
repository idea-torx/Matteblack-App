import { useState, useMemo, useEffect } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { probeMediaDuration } from "../features/cinema-frame/helpers/probeMediaDuration";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";
import type { ReferenceImage } from "../types/canvas";
import type { GenerationParams } from "./MakePanel";

type UpscaleFactor = 2 | 4;

// Video upscale (Topaz) controls. The `tier` represents the *output*
// resolution band the user is paying for; we map it to fal's `upscale_factor`
// at submit time. fps maps directly to fal's `target_fps`. The model picker
// switches between the two pricing rows (`topaz-upscale-video` â†’
// "Proteus" / `topaz-upscale-video-gaia2` â†’ "Gaia 2").
type VideoTier = "720p" | "1080p" | "4k";
type VideoFps = 30 | 60;
type VideoModelKey = "topaz-upscale-video" | "topaz-upscale-video-gaia2";

const TIER_LABELS: Record<VideoTier, string> = {
  "720p": "â‰¤ 720p",
  "1080p": "720p â€“ 1080p",
  "4k": "> 1080p (up to 4K)",
};

const TIER_TO_UPSCALE_FACTOR: Record<VideoTier, number> = {
  "720p": 1,
  "1080p": 2,
  "4k": 4,
};

const VIDEO_MODEL_LABELS: Record<VideoModelKey, string> = {
  "topaz-upscale-video": "Topaz (Proteus)",
  "topaz-upscale-video-gaia2": "Gaia 2",
};

function getReferenceUrl(ref: ReferenceImage | null): string | null {
  if (!ref) return null;
  const g = ref.gradient;
  if (!g) return null;
  const urlMatch = g.match(/url\(["']?([^"')]+)["']?\)/);
  if (urlMatch) return urlMatch[1];
  if (g.startsWith("http") || g.startsWith("data:") || g.startsWith("/")) return g;
  return null;
}

type UpscalePanelProps = {
  userBalance?: number;
  unlimited?: boolean;
  onUpscaleImage: (params: GenerationParams) => void;
  creditsRequired?: number;
  referenceImage?: ReferenceImage | null;
  referenceVideo?: ReferenceImage | null;
  videoDuration?: number;
  onClearReference?: () => void;
};

export function UpscalePanel({
  onUpscaleImage,
  creditsRequired = 8,
  userBalance = 0,
  unlimited = false,
  referenceImage = null,
  referenceVideo = null,
  videoDuration = 0,
  onClearReference,
}: UpscalePanelProps) {
  const isVideo = !!referenceVideo;
  const hasSelection = isVideo || !!referenceImage;

  // ----- Image upscale (SeedVR) state -----
  const [upscaleFactor, setUpscaleFactor] = useState<UpscaleFactor>(2);

  // ----- Video upscale (Topaz) state -----
  const [videoTier, setVideoTier] = useState<VideoTier>("1080p");
  const [videoFps, setVideoFps] = useState<VideoFps>(30);
  const [videoModel, setVideoModel] = useState<VideoModelKey>("topaz-upscale-video");

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    upscaleFactor: false,
    videoResolution: true,
    videoFps: true,
    videoModel: true,
  });

  // Pricing row key matches the tier+fps token encoded in modelPricing.
  const videoResolutionToken = `${videoTier}_${videoFps}`;

  // Selected canvas video nodes don't always carry a `duration` in their
  // metadata (e.g. older nodes, or videos imported without going through the
  // generation flow). When that's the case, probe the URL client-side so the
  // estimate (and thus the debit) always uses real per-second pricing rather
  // than silently falling back to base Ã— multipliers.
  const videoUrlForProbe = useMemo(() => getReferenceUrl(referenceVideo ?? null), [referenceVideo]);
  const [probedDuration, setProbedDuration] = useState<number | null>(null);
  useEffect(() => {
    setProbedDuration(null);
    if (!isVideo) return;
    if (Number.isFinite(videoDuration) && videoDuration > 0) return;
    if (!videoUrlForProbe) return;
    let cancelled = false;
    probeMediaDuration(videoUrlForProbe, "video").then((d) => {
      if (!cancelled && Number.isFinite(d) && d > 0) setProbedDuration(d);
    });
    return () => { cancelled = true; };
  }, [isVideo, videoDuration, videoUrlForProbe]);

  // Server-side duration is rounded up to whole seconds so a 5.4s clip bills
  // as 6s (matches how fal's per-second pricing works in practice). Use the
  // same rounding here so the displayed estimate matches what's debited.
  const effectiveDuration = useMemo(() => {
    if (Number.isFinite(videoDuration) && videoDuration > 0) return videoDuration;
    if (probedDuration && probedDuration > 0) return probedDuration;
    return 0;
  }, [videoDuration, probedDuration]);
  const billableSeconds = useMemo(() => {
    if (!isVideo) return 0;
    if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return 0;
    return Math.max(1, Math.ceil(effectiveDuration));
  }, [isVideo, effectiveDuration]);

  const estimateParams = useMemo(() => {
    if (isVideo) {
      return {
        type: "upscale",
        model: videoModel,
        resolution: videoResolutionToken,
        duration: billableSeconds > 0 ? String(billableSeconds) : undefined,
      };
    }
    return {
      type: "upscale",
      model: "seedvr-upscale",
    };
  }, [isVideo, videoModel, videoResolutionToken, billableSeconds]);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;
  const gate = useGenerateButton(userBalance, unlimited, totalCost);

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  const handleUpscale = () => {
    if (isVideo && referenceVideo) {
      const videoUrl = getReferenceUrl(referenceVideo);
      if (!videoUrl) {
        alert("Selected video has no reachable URL yet. Wait for it to finish loading and try again.");
        return;
      }
      if (billableSeconds <= 0) {
        alert("Couldn't read this video's duration yet. Wait a moment and try again.");
        return;
      }
      onUpscaleImage({
        jobType: "upscale",
        model: videoModel,
        prompt: "",
        videoUrl,
        upscaleFactor: TIER_TO_UPSCALE_FACTOR[videoTier],
        targetFps: videoFps,
        resolution: videoResolutionToken,
        duration: billableSeconds > 0 ? String(billableSeconds) : undefined,
      });
      return;
    }
    const refUrl = getReferenceUrl(referenceImage);
    onUpscaleImage({
      jobType: "upscale",
      model: "seedvr-upscale",
      prompt: "",
      referenceImageUrls: refUrl ? [refUrl] : [],
      upscaleFactor,
    });
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        {hasSelection ? (
          <div className="rpanel-card">
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>
              {isVideo ? "Reference Video" : "Reference Image"}
            </h3>
            <div className="rpanel-ref-grid">
              <div className="rpanel-ref-large-thumb">
                {isVideo && videoUrlForProbe ? (
                  <>
                    <video
                      className="rpanel-ref-large-thumb-img"
                      src={videoUrlForProbe}
                      muted
                      playsInline
                      preload="metadata"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    <div className="rpanel-ref-video-badge">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    </div>
                  </>
                ) : (
                  <div
                    className="rpanel-ref-large-thumb-img"
                    style={{ backgroundImage: getBackgroundImage((isVideo ? referenceVideo : referenceImage)?.gradient || "") }}
                  />
                )}
              </div>
            </div>
            {isVideo && billableSeconds > 0 && (
              <p className="rpanel-hint" style={{ marginTop: 8 }}>
                Duration: {billableSeconds}s
              </p>
            )}
            <button
              type="button"
              className="rpanel-ref-clear-all"
              onClick={() => onClearReference?.()}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="rpanel-card">
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Reference</h3>
            <p className="rpanel-hint">Select an image or video to upscale.</p>
          </div>
        )}

        {isVideo ? (
          <>
            {/* Video: Output resolution tier */}
            <div className="rpanel-card">
              <button type="button" className="rpanel-card-toggle" onClick={() => toggle("videoResolution")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                <span className="rpanel-card-toggle-label">Output Resolution</span>
                {!openSections.videoResolution && <span className="rpanel-tag">{TIER_LABELS[videoTier]}</span>}
                <svg className={`rpanel-card-chevron ${openSections.videoResolution ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {openSections.videoResolution && (
                <div className="rpanel-card-body">
                  <div className="rpanel-list">
                    {(["720p", "1080p", "4k"] as VideoTier[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`rpanel-list-btn ${videoTier === t ? "rpanel-list-btn--active" : ""}`}
                        onClick={() => setVideoTier(t)}
                      >
                        {TIER_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Video: FPS */}
            <div className="rpanel-card">
              <button type="button" className="rpanel-card-toggle" onClick={() => toggle("videoFps")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                <span className="rpanel-card-toggle-label">Frame Rate</span>
                {!openSections.videoFps && <span className="rpanel-tag">{videoFps} fps</span>}
                <svg className={`rpanel-card-chevron ${openSections.videoFps ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {openSections.videoFps && (
                <div className="rpanel-card-body">
                  <div className="rpanel-list">
                    {([30, 60] as VideoFps[]).map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`rpanel-list-btn ${videoFps === f ? "rpanel-list-btn--active" : ""}`}
                        onClick={() => setVideoFps(f)}
                      >
                        {f} fps
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Video: Model */}
            <div className="rpanel-card">
              <button type="button" className="rpanel-card-toggle" onClick={() => toggle("videoModel")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
                <span className="rpanel-card-toggle-label">Model</span>
                {!openSections.videoModel && <span className="rpanel-tag">{VIDEO_MODEL_LABELS[videoModel]}</span>}
                <svg className={`rpanel-card-chevron ${openSections.videoModel ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {openSections.videoModel && (
                <div className="rpanel-card-body">
                  <div className="rpanel-list">
                    {(["topaz-upscale-video", "topaz-upscale-video-gaia2"] as VideoModelKey[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`rpanel-list-btn ${videoModel === m ? "rpanel-list-btn--active" : ""}`}
                        onClick={() => setVideoModel(m)}
                      >
                        {VIDEO_MODEL_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          /* Image: Upscale Factor */
          <div className="rpanel-card">
            <button type="button" className="rpanel-card-toggle" onClick={() => toggle("upscaleFactor")}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              <span className="rpanel-card-toggle-label">Upscale Factor</span>
              {!openSections.upscaleFactor && <span className="rpanel-tag">{upscaleFactor}x</span>}
              <svg className={`rpanel-card-chevron ${openSections.upscaleFactor ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {openSections.upscaleFactor && (
              <div className="rpanel-card-body">
                <div className="rpanel-list">
                  {([2, 4] as UpscaleFactor[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`rpanel-list-btn ${upscaleFactor === f ? "rpanel-list-btn--active" : ""}`}
                      onClick={() => setUpscaleFactor(f)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                      {f}x
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action footer */}
      <div className="rpanel-footer">
        <button
          type="button"
          className={gate.className("rpanel-action-btn rpanel-action-btn--tall")}
          onClick={() => { gate.handleClick(handleUpscale); }}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready"} forceShow={isVideo} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label(isVideo ? "Upscale Video" : "Upscale Image")}</span>
        </button>
      </div>
    </aside>
  );
}
