import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export type VoiceChangerParams = {
  voice: string;
  stability: string;
  similarity: string;
  outputFormat: string;
  audioDataUrl: string;
};

type VoiceChangerPanelProps = {
  onGenerate: (params: VoiceChangerParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  initialValues?: VoiceChangerParams | null;
  reuseVersion?: number;
};

type AudioSource = "upload" | "library" | "record";

const VOICES = [
  "Rachel", "Aria", "Roger", "Sarah", "Laura", "Charlie", "George",
  "Callum", "River", "Liam", "Charlotte", "Alice", "Matilda", "Will",
  "Jessica", "Eric", "Chris", "Brian", "Daniel", "Lily", "Bill",
] as const;

type StabilityLevel = "low" | "medium" | "high";
type SimilarityLevel = "low" | "medium" | "high";
type OutputFormat = "mp3_44100_128" | "mp3_44100_192" | "pcm_44100";

const OUTPUT_FORMATS: { id: OutputFormat; label: string }[] = [
  { id: "mp3_44100_128", label: "MP3 128kbps" },
  { id: "mp3_44100_192", label: "MP3 192kbps" },
  { id: "pcm_44100", label: "WAV 44.1kHz" },
];

type LibraryFile = { id: string; name: string; duration: string; url: string };

const LIBRARY_FILES: LibraryFile[] = [
  { id: "lib-1", name: "Interview clip.mp3", duration: "2:34", url: "/audio/library/interview-clip.mp3" },
  { id: "lib-2", name: "Podcast intro.wav", duration: "0:45", url: "/audio/library/podcast-intro.wav" },
  { id: "lib-3", name: "Voiceover take 3.mp3", duration: "1:12", url: "/audio/library/voiceover-take3.mp3" },
  { id: "lib-4", name: "Meeting excerpt.mp3", duration: "3:08", url: "/audio/library/meeting-excerpt.mp3" },
  { id: "lib-5", name: "Song demo.wav", duration: "4:20", url: "/audio/library/song-demo.wav" },
];

export function VoiceChangerPanel({ onGenerate, creditsRequired = 30, userBalance = 0, unlimited = false, initialValues, reuseVersion = 0 }: VoiceChangerPanelProps) {
  const estimateParams = useMemo(() => ({
    type: "audio_voice_changer",
    model: "elevenlabs-voice-changer",
  }), []);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const gate = useGenerateButton(userBalance, unlimited, totalCost);
  const [audioSource, setAudioSource] = useState<AudioSource>("upload");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [selectedLibFile, setSelectedLibFile] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedLabel, setRecordedLabel] = useState<string | null>(null);
  const [recordTime, setRecordTime] = useState(0);
  const [playingBack, setPlayingBack] = useState(false);
  const [voice, setVoice] = useState<(typeof VOICES)[number]>("Rachel");
  const [stability, setStability] = useState<StabilityLevel>("medium");
  const [similarity, setSimilarity] = useState<SimilarityLevel>("high");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("mp3_44100_128");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimeRef = useRef(0);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!initialValues) return;
    if (initialValues.voice) setVoice(initialValues.voice as (typeof VOICES)[number]);
    if (initialValues.stability) setStability(initialValues.stability as StabilityLevel);
    if (initialValues.similarity) setSimilarity(initialValues.similarity as SimilarityLevel);
    if (initialValues.outputFormat) setOutputFormat(initialValues.outputFormat as OutputFormat);
  }, [reuseVersion]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    source: true,
    voice: false,
    settings: false,
    format: false,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFile(file);
      setUploadedFileName(file.name);
    }
  };

  const stopPlayback = useCallback(() => {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause();
      playbackAudioRef.current.src = "";
      playbackAudioRef.current = null;
    }
    setPlayingBack(false);
  }, []);

  const togglePlayback = useCallback(() => {
    if (playingBack) {
      stopPlayback();
      return;
    }
    if (!recordedBlob) return;
    const url = URL.createObjectURL(recordedBlob);
    const audio = new Audio(url);
    playbackAudioRef.current = audio;
    setPlayingBack(true);
    audio.addEventListener("ended", () => { stopPlayback(); URL.revokeObjectURL(url); });
    audio.addEventListener("error", () => { stopPlayback(); URL.revokeObjectURL(url); });
    audio.play().catch(() => stopPlayback());
  }, [playingBack, recordedBlob, stopPlayback]);

  const startRecording = useCallback(async () => {
    try {
      stopPlayback();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        setRecordedBlob(blob);
        setRecordedLabel(`Recording (${formatTime(recordTimeRef.current)})`);
      };
      mr.start();
      setRecording(true);
      setRecordTime(0);
      recordTimeRef.current = 0;
      setRecordedBlob(null);
      setRecordedLabel(null);
      recordTimerRef.current = setInterval(() => {
        recordTimeRef.current += 1;
        setRecordTime(recordTimeRef.current);
      }, 1000);
    } catch (err) {
      console.error("Microphone access denied:", err);
      alert("Microphone access is required for recording.");
    }
  }, [stopPlayback]);

  const stopRecording = useCallback(() => {
    setRecording(false);
    clearInterval(recordTimerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(recordTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (playbackAudioRef.current) {
        playbackAudioRef.current.pause();
        playbackAudioRef.current.src = "";
      }
    };
  }, []);

  const [generating, setGenerating] = useState(false);

  const hasAudio =
    (audioSource === "upload" && uploadedFile) ||
    (audioSource === "library" && selectedLibFile) ||
    (audioSource === "record" && recordedBlob);

  const getAudioDataUrl = async (): Promise<string | null> => {
    if (audioSource === "upload" && uploadedFile) {
      return blobToDataUrl(uploadedFile);
    }
    if (audioSource === "record" && recordedBlob) {
      return blobToDataUrl(recordedBlob);
    }
    if (audioSource === "library" && selectedLibFile) {
      const libFile = LIBRARY_FILES.find((f) => f.id === selectedLibFile);
      if (libFile?.url) {
        try {
          const resp = await fetch(libFile.url);
          if (!resp.ok) {
            alert("Could not load the selected library file. Please upload a file or record audio instead.");
            return null;
          }
          const blob = await resp.blob();
          return blobToDataUrl(blob);
        } catch {
          alert("Could not load the selected library file. Please upload a file or record audio instead.");
          return null;
        }
      }
      return null;
    }
    return null;
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        {/* Audio Source */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("source")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <span className="rpanel-card-toggle-label">Audio Source</span>
            <span className="rpanel-tag">
              {audioSource === "upload" ? "Upload" : audioSource === "library" ? "Library" : "Record"}
            </span>
            <svg className={`rpanel-card-chevron ${openSections.source ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.source && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {/* Upload */}
                <button
                  type="button"
                  className={`rpanel-list-btn ${audioSource === "upload" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setAudioSource("upload")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload File
                </button>

                {/* Library */}
                <button
                  type="button"
                  className={`rpanel-list-btn ${audioSource === "library" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setAudioSource("library")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  Library
                </button>

                {/* Record */}
                <button
                  type="button"
                  className={`rpanel-list-btn ${audioSource === "record" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setAudioSource("record")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  Record
                </button>
              </div>

              {/* Upload content */}
              {audioSource === "upload" && (
                <div className="rpanel-source-content">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    onChange={handleFileSelect}
                    style={{ display: "none" }}
                  />
                  {uploadedFileName ? (
                    <div className="rpanel-upload-file">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                      <span className="rpanel-upload-filename">{uploadedFileName}</span>
                      <button
                        type="button"
                        className="rpanel-upload-remove"
                        onClick={() => { setUploadedFile(null); setUploadedFileName(null); }}
                        aria-label="Remove file"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="rpanel-upload-btn"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span>Click to browse or drop file</span>
                    </button>
                  )}
                </div>
              )}

              {/* Library content */}
              {audioSource === "library" && (
                <div className="rpanel-source-content">
                  <div className="rpanel-list">
                    {LIBRARY_FILES.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`rpanel-list-btn ${selectedLibFile === f.id ? "rpanel-list-btn--active" : ""}`}
                        onClick={() => setSelectedLibFile(f.id === selectedLibFile ? null : f.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                        </svg>
                        <span style={{ flex: 1 }}>{f.name}</span>
                        <span className="rpanel-tag" style={{ marginLeft: "auto" }}>{f.duration}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Record content */}
              {audioSource === "record" && (
                <div className="rpanel-source-content">
                  {recordedBlob && !recording ? (
                    <div className="rpanel-recording-result">
                      <div className="rpanel-upload-file">
                        <button
                          type="button"
                          className="rpanel-playback-btn"
                          onClick={togglePlayback}
                          title={playingBack ? "Pause" : "Play recording"}
                          aria-label={playingBack ? "Pause" : "Play recording"}
                        >
                          {playingBack ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                          )}
                        </button>
                        <span className="rpanel-upload-filename">{recordedLabel || "Recording"}</span>
                        <button
                          type="button"
                          className="rpanel-upload-remove"
                          onClick={() => { stopPlayback(); setRecordedBlob(null); setRecordedLabel(null); }}
                          aria-label="Discard recording"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      </div>
                      <button
                        type="button"
                        className="rpanel-rerecord-btn"
                        onClick={() => { stopPlayback(); setRecordedBlob(null); setRecordedLabel(null); startRecording(); }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <circle cx="12" cy="12" r="4" fill="currentColor" />
                        </svg>
                        Re-record
                      </button>
                    </div>
                  ) : (
                    <div className="rpanel-record-zone">
                      <div className={`rpanel-record-indicator ${recording ? "rpanel-record-indicator--active" : ""}`} />
                      {recording && (
                        <span className="rpanel-record-time">{formatTime(recordTime)}</span>
                      )}
                      <button
                        type="button"
                        className={`rpanel-record-btn ${recording ? "rpanel-record-btn--recording" : ""}`}
                        onClick={recording ? stopRecording : startRecording}
                      >
                        {recording ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <rect x="6" y="6" width="12" height="12" rx="2" />
                            </svg>
                            Stop
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10" />
                              <circle cx="12" cy="12" r="4" fill="currentColor" />
                            </svg>
                            Start Recording
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Voice */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("voice")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            <span className="rpanel-card-toggle-label">Target Voice</span>
            <span className="rpanel-tag">{voice}</span>
            <svg className={`rpanel-card-chevron ${openSections.voice ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.voice && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {VOICES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`rpanel-list-btn ${voice === v ? "rpanel-list-btn--active" : ""}`}
                    onClick={() => setVoice(v)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                    </svg>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Settings */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("settings")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <span className="rpanel-card-toggle-label">Settings</span>
            <svg className={`rpanel-card-chevron ${openSections.settings ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.settings && (
            <div className="rpanel-card-body">
              <div className="rpanel-setting-group">
                <span className="rpanel-setting-label">Stability</span>
                <div className="rpanel-btn-row">
                  {(["low", "medium", "high"] as StabilityLevel[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`rpanel-btn-row-item ${stability === level ? "rpanel-btn-row-item--active" : ""}`}
                      onClick={() => setStability(level)}
                    >
                      {level.charAt(0).toUpperCase() + level.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rpanel-setting-group">
                <span className="rpanel-setting-label">Similarity</span>
                <div className="rpanel-btn-row">
                  {(["low", "medium", "high"] as SimilarityLevel[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`rpanel-btn-row-item ${similarity === level ? "rpanel-btn-row-item--active" : ""}`}
                      onClick={() => setSimilarity(level)}
                    >
                      {level.charAt(0).toUpperCase() + level.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Output Format */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("format")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="rpanel-card-toggle-label">Output Format</span>
            <svg className={`rpanel-card-chevron ${openSections.format ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.format && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {OUTPUT_FORMATS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`rpanel-list-btn ${outputFormat === f.id ? "rpanel-list-btn--active" : ""}`}
                    onClick={() => setOutputFormat(f.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button
          type="button"
          className={gate.className(`rpanel-action-btn rpanel-action-btn--tall ${gate.state === "ready" && (!hasAudio || generating) ? "rpanel-action-btn--disabled" : ""}`)}
          onClick={gate.state !== "ready" ? () => gate.handleClick(() => {}) : (hasAudio && !generating ? async () => {
            setGenerating(true);
            try {
              const audioDataUrl = await getAudioDataUrl();
              if (!audioDataUrl) { setGenerating(false); return; }
              onGenerate({ voice, stability, similarity, outputFormat, audioDataUrl });
            } finally {
              setGenerating(false);
            }
          } : undefined)}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && !!hasAudio && !generating} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label(generating ? "Preparing..." : "Change Voice")}</span>
        </button>
      </div>
    </aside>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
