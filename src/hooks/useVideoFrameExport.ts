import { useState, useRef, useCallback, useEffect } from "react";
import type { CanvasNode } from "../types/canvas";
import {
  exportFrameAsVideo,
  type VideoExportResolution,
  type VideoExportStage,
} from "../utils/videoFrameExport";
import { findOverlappingVideoNodes } from "../utils/frameExportHelpers";

export type VideoFrameExportState = {
  isExporting: boolean;
  stage: VideoExportStage;
  progress: number;
  error: string | null;
};

const INITIAL_STATE: VideoFrameExportState = {
  isExporting: false,
  stage: "idle",
  progress: 0,
  error: null,
};

export type StartVideoExportArgs = {
  frameId: string;
  resolution: VideoExportResolution;
  includeAudio: boolean;
  nodes: CanvasNode[];
};

export function useVideoFrameExport() {
  const [state, setState] = useState<VideoFrameExportState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const start = useCallback(async ({ frameId, resolution, includeAudio, nodes }: StartVideoExportArgs) => {
    const frameNode = nodes.find((n) => n.id === frameId && n.node_type === "frame");
    if (!frameNode) {
      setState({ isExporting: false, stage: "error", progress: 0, error: "Frame not found" });
      return;
    }
    if (findOverlappingVideoNodes(frameNode, nodes).length === 0) {
      setState({ isExporting: false, stage: "error", progress: 0, error: "Frame contains no video" });
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setState({ isExporting: true, stage: "preparing", progress: 0, error: null });

    try {
      const blob = await exportFrameAsVideo(frameNode, nodes, {
        resolution,
        includeAudio,
        signal: ac.signal,
        onStage: (s) => setState((prev) => ({ ...prev, stage: s })),
        onProgress: (p) => setState((prev) => ({ ...prev, progress: p })),
      });

      const w = Math.max(1, Math.round(frameNode.width));
      const h = Math.max(1, Math.round(frameNode.height));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `frame-${w}x${h}.mp4`;
      a.click();
      URL.revokeObjectURL(url);

      setState({ isExporting: false, stage: "done", progress: 1, error: null });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setState({ isExporting: false, stage: "cancelled", progress: 0, error: null });
      } else {
        const msg = err instanceof Error ? err.message : "Export failed";
        console.error("[videoFrameExport] failed:", err);
        setState({ isExporting: false, stage: "error", progress: 0, error: msg });
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, start, cancel, reset };
}
