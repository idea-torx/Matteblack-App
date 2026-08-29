import { useState, useCallback, useRef, useEffect } from "react";
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
    await ffmpeg.exec(["-i", filename, "-f", "null", "-"]);
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

export function useCinemaExport(timeline: TimelineState | null) {
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<ExportStage>("idle");
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const ffmpegRef = useRef<{ terminate: () => void } | null>(null);

  useEffect(() => {
    return () => {
      if (ffmpegRef.current) {
        try { ffmpegRef.current.terminate(); } catch {}
        ffmpegRef.current = null;
      }
    };
  }, []);

  const cancelExport = useCallback(() => {
    cancelRef.current = true;
    if (ffmpegRef.current) {
      try { ffmpegRef.current.terminate(); } catch {}
      ffmpegRef.current = null;
    }
    setStage("cancelled");
    setIsExporting(false);
    setProgress(0);
  }, []);

  const startExport = useCallback(async (config: ExportConfig) => {
    if (!timeline) return;
    cancelRef.current = false;
    setIsExporting(true);
    setError(null);
    setProgress(0);

    let ffmpeg: FFmpegInstance | null = null;
    const writtenFiles: string[] = [];

    try {
      setStage("loading-ffmpeg");
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { fetchFile } = await import("@ffmpeg/util");

      if (cancelRef.current) return;

      ffmpeg = new FFmpeg() as unknown as FFmpegInstance;
      ffmpegRef.current = ffmpeg;

      ffmpeg.on("progress", ({ progress: p }) => {
        if (cancelRef.current) return;
        if (typeof p === "number") {
          setProgress(Math.min(0.95, 0.35 + p * 0.60));
        }
      });

      await ffmpeg.load();
      if (cancelRef.current) return;

      setStage("fetching-media");
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
          const ext = clip.type === "audio" ? "mp3" : "mp4";
          vfsName = `input_${fileIdx++}.${ext}`;

          let fetchUrl = clip.src;
          if (fetchUrl.startsWith("http://") || fetchUrl.startsWith("https://")) {
            fetchUrl = `/api/media-proxy?url=${encodeURIComponent(fetchUrl)}`;
          }

          const data = await fetchFile(fetchUrl);
          if (cancelRef.current) return;
          await ffmpeg.writeFile(vfsName, data);
          writtenFiles.push(vfsName);
          uniqueSrcs.set(clip.src, vfsName);
        }

        clipFileMap.set(clip.id, vfsName);
        fetched++;
        setProgress(0.05 + (fetched / Math.max(clipsToFetch.length, 1)) * 0.15);
      }

      if (cancelRef.current) return;

      if (clipFileMap.size === 0) {
        setError("No clips to export");
        setStage("error");
        setIsExporting(false);
        return;
      }

      setStage("probing");
      setProgress(0.20);

      const probedSrcs = new Map<string, StreamInfo>();
      let probed = 0;
      for (const clip of clipsToFetch) {
        const vfsName = clipFileMap.get(clip.id);
        if (!vfsName) continue;

        const cached = probedSrcs.get(clip.src);
        if (cached) {
          streamInfoMap.set(clip.id, cached);
        } else {
          let info: StreamInfo;
          if (clip.type === "audio") {
            info = { hasAudio: true, isH264: false };
          } else {
            info = await probeStreamInfo(ffmpeg, vfsName);
            if (cancelRef.current) return;
          }

          streamInfoMap.set(clip.id, info);
          probedSrcs.set(clip.src, info);
        }
        probed++;
        setProgress(0.20 + (probed / Math.max(clipsToFetch.length, 1)) * 0.15);
      }

      if (cancelRef.current) return;

      setStage("encoding");
      setProgress(0.35);

      const totalDuration = getTotalDuration(timeline);
      const { args, concatListContent } = buildFFmpegCommand(timeline, clipFileMap, config, totalDuration, streamInfoMap);

      if (concatListContent) {
        await ffmpeg.writeFile("concat_list.txt", concatListContent);
        writtenFiles.push("concat_list.txt");
      }

      const exitCode = await ffmpeg.exec(args);
      if (cancelRef.current) return;

      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}`);
      }

      setStage("finalizing");
      setProgress(0.95);

      const outputName = config.filename.endsWith(".mp4") ? config.filename : `${config.filename}.mp4`;
      const outputData = await ffmpeg.readFile(outputName);
      writtenFiles.push(outputName);

      const blob = new Blob([outputData as BlobPart], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outputName;
      a.click();
      URL.revokeObjectURL(url);

      setProgress(1);
      setStage("done");
    } catch (err) {
      if (cancelRef.current) return;
      console.error("[CinemaExport] Export failed:", err);
      setError(err instanceof Error ? err.message : "Export failed");
      setStage("error");
    } finally {
      if (ffmpeg) {
        for (const f of writtenFiles) {
          try { await ffmpeg.deleteFile(f); } catch {}
        }
        try { ffmpeg.terminate(); } catch {}
        ffmpegRef.current = null;
      }
      setIsExporting(false);
    }
  }, [timeline]);

  return { startExport, cancelExport, progress, stage, isExporting, error };
}
