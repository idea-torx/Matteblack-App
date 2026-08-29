import { useCallback, useRef } from "react";
import type { GenerationParams } from "../../../components/MakePanel";

type UseCinemaGenerationParams = {
  startGeneration: (params: GenerationParams) => Promise<string | null>;
  startAudioGeneration: (params: GenerationParams) => Promise<string | null>;
};

export function useCinemaGeneration({
  startGeneration,
  startAudioGeneration,
}: UseCinemaGenerationParams) {
  const activeNodeIdRef = useRef<string | null>(null);

  const setTargetNode = useCallback((nodeId: string | null) => {
    activeNodeIdRef.current = nodeId;
  }, []);

  const dispatchVideoGeneration = useCallback(
    async (params: GenerationParams): Promise<string | null> => {
      const enriched: GenerationParams = {
        ...params,
        jobType: params.jobType || "video_gen",
      };
      return startGeneration(enriched);
    },
    [startGeneration]
  );

  const dispatchImageGeneration = useCallback(
    async (params: GenerationParams): Promise<string | null> => {
      const enriched: GenerationParams = {
        ...params,
        jobType: params.jobType || "text_to_image",
      };
      return startGeneration(enriched);
    },
    [startGeneration]
  );

  // Cinema-style: route audio panel generations onto the freeform canvas as
  // `audio` nodes via the canvas generation path. The list-based fallback
  // (`startAudioGeneration`) is only used by callers when no design canvas
  // is mounted — see App.tsx audio panel handlers.
  const dispatchAudioGeneration = useCallback(
    async (params: GenerationParams): Promise<string | null> => {
      return startGeneration(params);
    },
    [startGeneration]
  );

  const dispatchAudioGenerationToList = useCallback(
    async (params: GenerationParams): Promise<string | null> => {
      return startAudioGeneration(params);
    },
    [startAudioGeneration]
  );

  return {
    setTargetNode,
    activeNodeId: activeNodeIdRef,
    dispatchVideoGeneration,
    dispatchImageGeneration,
    dispatchAudioGeneration,
    dispatchAudioGenerationToList,
  };
}
