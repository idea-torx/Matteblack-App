import { useCallback, useMemo } from "react";
import type { CanvasNode } from "../../../types/canvas";
import {
  isCinemaVideoNode,
  isCinemaAudioNode,
  getCinemaNodeType,
} from "../helpers/cinemaMetadata";

type UseCinemaCanvasParams = {
  nodes: CanvasNode[];
  selectedImageIds: string[];
  onToolSelect?: (toolId: string) => void;
  activeTool?: string;
};

export function useCinemaCanvas({
  nodes,
  selectedImageIds,
  onToolSelect,
  activeTool,
}: UseCinemaCanvasParams) {
  const selectedNode = useMemo(() => {
    if (selectedImageIds.length !== 1) return null;
    return nodes.find((n) => n.id === selectedImageIds[0]) || null;
  }, [nodes, selectedImageIds]);

  const selectedCinemaType = useMemo(() => {
    if (!selectedNode) return null;
    return getCinemaNodeType(selectedNode);
  }, [selectedNode]);

  const handleCinemaNodeSelect = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const selectToolIfDifferent = (toolId: string) => {
        if (activeTool === toolId) return;
        onToolSelect?.(toolId);
      };

      if (isCinemaVideoNode(node)) {
        selectToolIfDifferent("create");
      } else if (isCinemaAudioNode(node)) {
        const sub = (node.metadata?.audioSubtype as string) || "tts";
        const toolMap: Record<string, string> = {
          tts: "tts",
          music: "music",
          sfx: "sfx",
          voice: "voicechanger",
        };
        selectToolIfDifferent(toolMap[sub] || "tts");
      }
    },
    [nodes, onToolSelect, activeTool]
  );

  return {
    selectedNode,
    selectedCinemaType,
    handleCinemaNodeSelect,
  };
}
