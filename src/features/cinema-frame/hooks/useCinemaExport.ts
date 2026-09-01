import { useCallback, useSyncExternalStore } from "react";
import type { TimelineState } from "../helpers/timelineState";
import { getEffectiveDuration, getTotalDuration } from "../helpers/timelineState";
import { buildFFmpegCommand, type ExportConfig, type StreamInfo } from "../helpers/buildFFmpegCommand";

export type ExportStage =
  | "idle"
  | "loading-ffmpeg"
  | "fetching-media"
  | "probing"
  | "encoding"
  | "finalizing"
  | "done"
  | "error"
  | "cancelled";

type FFmpegInstance = {
  load: () => Promise<void>;
  on: (event: string, cb: (data: { progress?: number; message?: string; type?: string }) => void) => void;
  off: (event: string, cb: (data: { progress?: number; message?: string; type?: string }) => void) => void;
  writeFile: (name: string, data: Uint8Array | string) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  readFile: (name: string) => Promise<Uint8Array>;
  deleteFile: (name: string) => Promise<void>;
  terminate: () => void;
};

async function probeStreamInfo(ffmpeg: FFmpegInstance, filename: string): Promise<StreamInfo> {
  let logOutput = "";
  const logHandler = ({ message }: { message?: string }) => {
    if (message) logOutput += message + "\n";
  };

  ffmpeg.on("log", logHandler);
  try {
    await ffmpeg.exec(["-i", filename, "-t", "0.1", "-f", "null", "-"]);
  } catch {}
  ffmpeg.off("log", logHandler);

  const hasAudio = /Stream\s+#\d+:\d+.*Audio/i.test(logOutput);
  const isH264 = /Stream\s+#\d+:\d+.*Video.*h264/i.test(logOutput);

  let width: number | undefined;
  let height: number | undefined;
  const dimMatch = logOutput.match(/(\d{2,5})x(\d{2,5})/);
  if (dimMatch) {
    width = parseInt(dimMatch[1], 10);
    height = parseInt(dimMatch[2], 10);
  }

  return { hasAudio, isH264, width, height };
}

/**
 * The export lives OUTSIDE React.
 *
 * An ffmpeg.wasm encode takes minutes, and the cinema frame unmounts the
 * moment it scrolls out of the viewport or the user switches panels — which
 * used to terminate the worker mid-encode. Progress state and the running
 * worker are module-level, so the export keeps going and any remount picks
 * the same run back up.
 * ponytail: one export at a time, which is all the UI offers.
 */
type ExportState = { progress: number; stage: ExportStage; isExporting: boolean; error: string | null };
let exportState: ExportState = { progress: 0, stage: "idle", isExporting: false, error: null };
let running: FFmpegInstance | null = null;
let serverExport: AbortController | null = null;
let cancelled = false;
const listeners = new Set<() => void>();

function setExportState(patch: Partial<ExportState>) {
  exportState = { ...exportState, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useCinemaExport(timeline: TimelineState | null) {
  const { progress, stage, isExporting, error } = useSyncExternalStore(subscribe, () => exportState);

  const cancelExport = useCallback(() => {
    cancelled = true;
    serverExport?.abort();
    serverExport = null;
    if (running) {
      try { running.terminate(); } catch {}
      running = null;
    }
    setExportState({ stage: "cancelled", isExporting: false, progress: 0 });
  }, []);

  const startExport = useCallback(async (config: ExportConfig) => {
    if (!timeline) return;
    // A second start while one is running would race the shared worker.
    if (exportState.isExporting) return;
    cancelled = false;
    setExportState({ isExporting: true, error: null, progress: 0 });

    // Native export first: the server runs the system ffmpeg (same command
    // builder), which is an order of magnitude faster than ffmpeg.wasm. Any
    // failure falls through to the wasm path below.
    try {
      setExportState({ stage: "encoding", progress: 0.4 });
      serverExport = new AbortController();
      const r = await fetch("/api/cinema/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline, config }),
        signal: serverExport.signal,
      });
      if (r.ok) {
        // Plain same-origin attachment URL, no blob: the one download path
        // iOS Safari honors, and no in-memory copy of the MP4 anywhere.
        const { url } = (await r.json()) as { url: string };
        const outputName = config.filename.endsWith(".mp4") ? config.filename : `${config.filename}.mp4`;
        const a = document.createElement("a");
        a.href = url;
        a.download = outputName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setExportState({ progress: 1, stage: "done", isExporting: false });
        return;
      }
      console.warn("[CinemaExport] native export unavailable, falling back to wasm:", r.status);
    } catch (err) {
      if (cancelled) { setExportState({ stage: "cancelled", isExporting: false, progress: 0 }); return; }
      console.warn("[CinemaExport] native export failed, falling back to wasm:", err);
    } finally {
      serverExport = null;
    }
    setExportState({ progress: 0 });

    let ffmpeg: FFmpegInstance | null = null;
    const writtenFiles: string[] = [];

    try {
      setExportState({ stage: "loading-ffmpeg" });
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { fetchFile } = await import("@ffmpeg/util");

      if (cancelled) return;

      ffmpeg = new FFmpeg() as unknown as FFmpegInstance;
      running = ffmpeg;

      ffmpeg.on("progress", ({ progress: p }) => {
        if (cancelled) return;
        if (typeof p === "number") {
          setExportState({ progress: Math.min(0.95, 0.35 + p * 0.60) });
        }
      });

      await ffmpeg.load();
      if (cancelled) return;

      setExportState({ stage: "fetching-media" });
      const allClips = timeline.tracks.flatMap((t) => t.clips);
      const clipFileMap = new Map<string, string>();
      const uniqueSrcs = new Map<string, string>();
      const streamInfoMap = new Map<string, StreamInfo>();
      let fileIdx = 0;
      let fetched = 0;
      const clipsToFetch = allClips.filter((c) => c.src && getEffectiveDuration(c) > 0);

      for (const clip of clipsToFetch) {
        if (!clip.src) continue;

        let vfsName = uniqueSrcs.get(clip.src);
        if (!vfsName) {
          // Stills keep their real extension: ffmpeg picks the image demuxer by name.
          const ext = clip.type === "audio" ? "mp3" : clip.type === "image" ? (/\.(png|jpe?g|webp|gif)(?:\?|$)/i.exec(clip.src)?.[1] ?? "png") : "mp4";
          vfsName = `input_${fileIdx++}.${ext}`;

          let fetchUrl = clip.src;
          if (fetchUrl.startsWith("http://") || fetchUrl.startsWith("https://")) {
            fetchUrl = `/api/media-proxy?url=${encodeURIComponent(fetchUrl)}`;
          }

          const data = await fetchFile(fetchUrl);
          if (cancelled) return;
          await ffmpeg.writeFile(vfsName, data);
          writtenFiles.push(vfsName);
          uniqueSrcs.set(clip.src, vfsName);
        }

        clipFileMap.set(clip.id, vfsName);
        fetched++;
        setExportState({ progress: 0.05 + (fetched / Math.max(clipsToFetch.length, 1)) * 0.15 });
      }

      if (cancelled) return;

      if (clipFileMap.size === 0) {
        setExportState({ error: "No clips to export", stage: "error", isExporting: false });
        return;
      }

      setExportState({ stage: "probing", progress: 0.20 });

      const probedSrcs = new Map<string, StreamInfo>();
      let probed = 0;
      for (const clip of clipsToFetch) {
        const vfsName = clipFileMap.get(clip.id);
        if (!vfsName) continue;

        const cached = probedSrcs.get(clip.src);
        if (cached) {
          streamInfoMap.set(clip.id, cached);
        } else {
          // Probe audio clips too — a mirror clip on the audio track can point
          // at a silent video, and assuming hasAudio breaks the filter graph.
          const info: StreamInfo = await probeStreamInfo(ffmpeg, vfsName);
          if (cancelled) return;

          streamInfoMap.set(clip.id, info);
          probedSrcs.set(clip.src, info);
        }
        probed++;
        setExportState({ progress: 0.20 + (probed / Math.max(clipsToFetch.length, 1)) * 0.15 });
      }

      if (cancelled) return;

      setExportState({ stage: "encoding", progress: 0.35 });

      // Picture decides the export length; a longer music bed is cut, not padded with black.
      const totalDuration = getTotalDuration({ ...timeline, tracks: timeline.tracks.filter((t) => t.type === "video") });
      const { args, concatListContent } = buildFFmpegCommand(timeline, clipFileMap, config, totalDuration, streamInfoMap);

      if (concatListContent) {
        await ffmpeg.writeFile("concat_list.txt", concatListContent);
        writtenFiles.push("concat_list.txt");
      }

      const exitCode = await ffmpeg.exec(args);
      if (cancelled) return;

      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}`);
      }

      setExportState({ stage: "finalizing", progress: 0.95 });

      const outputName = config.filename.endsWith(".mp4") ? config.filename : `${config.filename}.mp4`;
      const outputData = await ffmpeg.readFile(outputName);
      writtenFiles.push(outputName);

      const blob = new Blob([outputData as BlobPart], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outputName;
      // Detached anchors and a same-tick revoke both drop the download in
      // Chromium — the click has to happen on a node in the document, and the
      // object URL has to outlive it. Same shape as downloadAsset().
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);

      setExportState({ progress: 1, stage: "done" });
    } catch (err) {
      if (cancelled) return;
      console.error("[CinemaExport] Export failed:", err);
      setExportState({ error: err instanceof Error ? err.message : "Export failed", stage: "error" });
    } finally {
      if (ffmpeg) {
        for (const f of writtenFiles) {
          try { await ffmpeg.deleteFile(f); } catch {}
        }
        try { ffmpeg.terminate(); } catch {}
        running = null;
      }
      setExportState({ isExporting: false });
    }
  }, [timeline]);

  return { startExport, cancelExport, progress, stage, isExporting, error };
}
