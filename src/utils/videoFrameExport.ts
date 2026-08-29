import type { CanvasNode } from "../types/canvas";
import { findOverlappingVideoNodes, renderOverlayCanvas, toProxiedUrl } from "./frameExportHelpers";

export type VideoExportResolution = "match" | "1080p" | "720p";

export type VideoExportStage =
  | "idle"
  | "preparing"
  | "loading-ffmpeg"
  | "fetching-media"
  | "encoding"
  | "finalizing"
  | "done"
  | "error"
  | "cancelled";

export type VideoExportOptions = {
  resolution: VideoExportResolution;
  includeAudio: boolean;
  signal?: AbortSignal;
  onStage?: (stage: VideoExportStage) => void;
  onProgress?: (progress: number) => void;
};

type FFmpegInstance = {
  load: () => Promise<void>;
  on: (event: string, cb: (data: { progress?: number; message?: string; type?: string }) => void) => void;
  writeFile: (name: string, data: Uint8Array | string) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  readFile: (name: string) => Promise<Uint8Array>;
  deleteFile: (name: string) => Promise<void>;
  terminate: () => void;
};

const MAX_DURATION_S = 30;

function evenDim(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r - 1;
}

function aspectFitDims(frameW: number, frameH: number, targetW: number, targetH: number): { w: number; h: number } {
  const aspect = frameW / frameH;
  let w = targetW;
  let h = Math.round(w / aspect);
  if (h > targetH) {
    h = targetH;
    w = Math.round(h * aspect);
  }
  return { w: evenDim(w), h: evenDim(h) };
}

function probeVideoDuration(src: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.crossOrigin = "anonymous";
    let settled = false;
    const cleanup = () => {
      v.onloadedmetadata = null;
      v.onerror = null;
      try { v.src = ""; } catch {}
    };
    const finish = (val: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };
    const timeout = setTimeout(() => finish(0), 8000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      finish(0);
    }, { once: true });
    v.onloadedmetadata = () => {
      clearTimeout(timeout);
      const d = isFinite(v.duration) ? v.duration : 0;
      finish(d || 0);
    };
    v.onerror = () => {
      clearTimeout(timeout);
      finish(0);
    };
    v.src = toProxiedUrl(src);
  });
}

function safeColor(fill: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(fill)) return fill;
  if (/^#[0-9a-fA-F]{3}$/.test(fill)) return fill;
  return "black";
}

export async function exportFrameAsVideo(
  frameNode: CanvasNode,
  allNodes: CanvasNode[],
  opts: VideoExportOptions
): Promise<Blob> {
  const { resolution, includeAudio, signal, onStage, onProgress } = opts;
  const stage = (s: VideoExportStage) => onStage?.(s);
  const prog = (p: number) => onProgress?.(p);
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };

  stage("preparing");
  prog(0);

  const videoNodes = findOverlappingVideoNodes(frameNode, allNodes);
  if (videoNodes.length === 0) {
    throw new Error("No video found in frame");
  }

  const frameW = Math.max(1, Math.round(frameNode.width));
  const frameH = Math.max(1, Math.round(frameNode.height));
  let outW: number;
  let outH: number;
  if (resolution === "1080p") {
    ({ w: outW, h: outH } = aspectFitDims(frameW, frameH, 1920, 1080));
  } else if (resolution === "720p") {
    ({ w: outW, h: outH } = aspectFitDims(frameW, frameH, 1280, 720));
  } else {
    outW = evenDim(frameW);
    outH = evenDim(frameH);
  }

  const overlayCanvas = await renderOverlayCanvas(frameNode, allNodes, outW, outH);
  if (!overlayCanvas) throw new Error("Failed to render overlay layer");
  checkAbort();

  const overlayBlob = await new Promise<Blob | null>((resolve) => overlayCanvas.toBlob(resolve, "image/png"));
  if (!overlayBlob) throw new Error("Failed to encode overlay layer");
  const overlayBytes = new Uint8Array(await overlayBlob.arrayBuffer());

  prog(0.05);
  checkAbort();

  stage("loading-ffmpeg");
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const { fetchFile } = await import("@ffmpeg/util");

  let ffmpeg: FFmpegInstance | null = new FFmpeg() as unknown as FFmpegInstance;
  const writtenFiles: string[] = [];

  const onAbort = () => {
    try { ffmpeg?.terminate(); } catch {}
  };
  signal?.addEventListener("abort", onAbort);

  try {
    ffmpeg.on("progress", ({ progress: p }) => {
      if (signal?.aborted) return;
      if (typeof p === "number") {
        prog(Math.min(0.95, 0.40 + p * 0.55));
      }
    });

    await ffmpeg.load();
    checkAbort();

    stage("fetching-media");

    const durations: number[] = [];
    for (const v of videoNodes) {
      const d = await probeVideoDuration(v.src, signal);
      checkAbort();
      durations.push(d);
    }

    const longestDur = durations.reduce((a, b) => Math.max(a, b), 0);
    const targetDur = Math.min(longestDur > 0 ? longestDur : MAX_DURATION_S, MAX_DURATION_S);

    const inputFiles: string[] = [];
    for (let i = 0; i < videoNodes.length; i++) {
      const v = videoNodes[i];
      const url = toProxiedUrl(v.src);
      const ext = (() => {
        const m = v.src.match(/\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/);
        const e = m ? m[1].toLowerCase() : "";
        return /^(mp4|mov|webm|mkv|m4v|avi|ogv|ogg)$/.test(e) ? e : "mp4";
      })();
      const fname = `video_${i}.${ext}`;
      let data: Uint8Array;
      try {
        data = await fetchFile(url);
      } catch (err) {
        throw new Error(`Failed to fetch video "${v.label || v.id}": ${err instanceof Error ? err.message : "unknown error"}`);
      }
      checkAbort();
      await ffmpeg.writeFile(fname, data);
      writtenFiles.push(fname);
      inputFiles.push(fname);
      prog(0.10 + ((i + 1) / videoNodes.length) * 0.25);
    }

    await ffmpeg.writeFile("overlay.png", overlayBytes);
    writtenFiles.push("overlay.png");

    prog(0.38);
    checkAbort();

    stage("encoding");

    const args: string[] = [];
    const frameFill = (frameNode.metadata?.fill as string) || "#333333";
    const colorVal = safeColor(frameFill);

    args.push("-f", "lavfi", "-i", `color=c=${colorVal}:s=${outW}x${outH}:d=${targetDur.toFixed(3)}:r=30`);
    args.push("-loop", "1", "-t", targetDur.toFixed(3), "-i", "overlay.png");
    for (const fname of inputFiles) {
      args.push("-i", fname);
    }

    const scaleX = outW / frameW;
    const scaleY = outH / frameH;

    const filterParts: string[] = [];
    let prevLabel = "[0:v]";

    for (let i = 0; i < videoNodes.length; i++) {
      const v = videoNodes[i];
      const dur = durations[i] > 0 ? Math.min(durations[i], targetDur) : targetDur;
      const inputIdx = 2 + i;
      const vw = evenDim(v.width * scaleX);
      const vh = evenDim(v.height * scaleY);
      const vx = Math.round((v.x - frameNode.x) * scaleX);
      const vy = Math.round((v.y - frameNode.y) * scaleY);

      let chain = `[${inputIdx}:v]scale=${vw}:${vh}:force_original_aspect_ratio=increase,crop=${vw}:${vh},setpts=PTS-STARTPTS`;
      const padDur = targetDur - dur;
      if (padDur > 0.05) {
        chain += `,tpad=stop_mode=clone:stop_duration=${padDur.toFixed(3)}`;
      }
      chain += `,trim=duration=${targetDur.toFixed(3)}`;
      const vLabel = `vp${i}`;
      filterParts.push(`${chain}[${vLabel}]`);

      const outLabel = `bg${i}`;
      filterParts.push(`${prevLabel}[${vLabel}]overlay=${vx}:${vy}:eof_action=repeat[${outLabel}]`);
      prevLabel = `[${outLabel}]`;
    }

    filterParts.push(`${prevLabel}[1:v]overlay=0:0:shortest=1[outv]`);

    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", "[outv]");

    if (includeAudio) {
      let longestIdx = 0;
      for (let i = 1; i < durations.length; i++) {
        if (durations[i] > durations[longestIdx]) longestIdx = i;
      }
      args.push("-map", `${2 + longestIdx}:a?`);
      args.push("-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");
    args.push("-pix_fmt", "yuv420p");
    args.push("-t", targetDur.toFixed(3));
    args.push("-movflags", "+faststart");

    const outputName = "output.mp4";
    args.push(outputName);

    let exitCode: number;
    try {
      exitCode = await ffmpeg.exec(args);
    } catch (err) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error(`FFmpeg execution failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    checkAbort();

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}`);
    }

    stage("finalizing");
    prog(0.97);

    const outputData = await ffmpeg.readFile(outputName);
    writtenFiles.push(outputName);

    const blob = new Blob([outputData as BlobPart], { type: "video/mp4" });
    prog(1);
    stage("done");
    return blob;
  } catch (err) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (ffmpeg) {
      for (const f of writtenFiles) {
        try { await ffmpeg.deleteFile(f); } catch {}
      }
      try { ffmpeg.terminate(); } catch {}
      ffmpeg = null;
    }
  }
}
