import type { CanvasNode } from "../../../types/canvas";

export type CinemaNodeType = "video" | "audio" | "image";

export type CinemaMetadata = {
  cinemaNodeType?: CinemaNodeType;
  audioSubtype?: "tts" | "music" | "sfx" | "voice";
  duration?: number;
  trackIndex?: number;
  startTime?: number;
  prompt?: string;
};

export function isCinemaFrameNode(node: CanvasNode): boolean {
  return node.node_type === "cinema";
}

export function getCinemaNodeType(node: CanvasNode): CinemaNodeType | null {
  if (node.node_type === "cinema") return null;
  if (node.metadata?.cinemaNodeType) return node.metadata.cinemaNodeType as CinemaNodeType;
  if (node.node_type === "video") return "video";
  if (node.node_type === "audio") return "audio";
  if (node.node_type === "image") return "image";
  return null;
}

export function isCinemaVideoNode(node: CanvasNode): boolean {
  return getCinemaNodeType(node) === "video" || node.node_type === "video";
}

export function isCinemaAudioNode(node: CanvasNode): boolean {
  return getCinemaNodeType(node) === "audio" || node.node_type === "audio";
}

export function getCinemaMetadata(node: CanvasNode): CinemaMetadata {
  return {
    cinemaNodeType: (node.metadata?.cinemaNodeType as CinemaNodeType) || undefined,
    audioSubtype: (node.metadata?.audioSubtype as CinemaMetadata["audioSubtype"]) || undefined,
    duration: (node.metadata?.duration as number) || undefined,
    trackIndex: (node.metadata?.trackIndex as number) || undefined,
    startTime: (node.metadata?.startTime as number) || undefined,
    prompt: (node.metadata?.prompt as string) || node.label || undefined,
  };
}

export function setCinemaMetadata(
  node: CanvasNode,
  meta: Partial<CinemaMetadata>
): Record<string, unknown> {
  return { ...node.metadata, ...meta };
}

export function buildCinemaVideoNodeProps(prompt: string): Partial<CanvasNode> {
  return {
    node_type: "video",
    label: prompt,
    width: 480,
    height: 270,
    metadata: {
      cinemaNodeType: "video" as CinemaNodeType,
      prompt,
    },
  };
}

export function buildCinemaAudioNodeProps(
  subtype: CinemaMetadata["audioSubtype"],
  prompt: string
): Partial<CanvasNode> {
  return {
    node_type: "audio",
    label: prompt,
    width: 320,
    height: 120,
    metadata: {
      cinemaNodeType: "audio" as CinemaNodeType,
      audioSubtype: subtype,
      prompt,
    },
  };
}
