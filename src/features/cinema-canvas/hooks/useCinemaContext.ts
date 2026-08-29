import { useState, useCallback } from "react";

const AUDIO_TOOL_IDS = ["audio", "tts", "music", "voicechanger", "sfx"];
const CINEMA_COMPATIBLE_TOOL_IDS = [
  "cinema", "create", "make", "upscale", "resize", "remove",
  "avatar", "design", "gifmaker", "svgmaker", ...AUDIO_TOOL_IDS,
];

export function useCinemaContext() {
  const [cinemaContext, setCinemaContext] = useState(false);

  const updateCinemaContext = useCallback((toolId: string | null) => {
    if (toolId === "cinema") {
      setCinemaContext(true);
    } else if (toolId && !CINEMA_COMPATIBLE_TOOL_IDS.includes(toolId)) {
      setCinemaContext(false);
    }
  }, []);

  const isAudioTool = (toolId: string | null) =>
    toolId !== null && AUDIO_TOOL_IDS.includes(toolId);

  const isCinemaAudioTool = (toolId: string | null) =>
    isAudioTool(toolId) && cinemaContext;

  return {
    cinemaContext,
    setCinemaContext,
    updateCinemaContext,
    isAudioTool,
    isCinemaAudioTool,
  };
}
