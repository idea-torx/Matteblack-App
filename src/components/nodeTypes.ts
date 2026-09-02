export type PortType = "text" | "image" | "video" | "audio";

export type NodePort = {
  id: string;
  type: PortType;
  label: string;
};

export type NodeType =
  | "text"
  | "image"
  | "video"
  | "upscale"
  | "resize"
  | "remove"
  | "tts"
  | "music"
  | "voicechanger"
  | "gifmaker"
  | "axiom"
  | "style";

export type WorkflowNode = {
  id: string;
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  inputs: NodePort[];
  outputs: NodePort[];
  config: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  sourceNode: string;
  sourcePort: string;
  targetNode: string;
  targetPort: string;
};

export const PORT_COLORS: Record<PortType, string> = {
  text: "#71717a",
  image: "var(--accent)",
  video: "#22c55e",
  audio: "#a855f7",
};

type NodeSchema = {
  label: string;
  description: string;
  inputs: NodePort[];
  outputs: NodePort[];
};

export const NODE_SCHEMAS: Record<NodeType, NodeSchema> = {
  text: {
    label: "Text",
    description: "Text prompt or value",
    inputs: [],
    outputs: [{ id: "text", type: "text", label: "text" }],
  },
  image: {
    label: "Image",
    description: "Image node — upload, generate, or edit",
    inputs: [
      { id: "prompt", type: "text", label: "prompt" },
      { id: "image", type: "image", label: "image" },
    ],
    outputs: [{ id: "image", type: "image", label: "image" }],
  },
  video: {
    label: "Video",
    description: "Video node — generate from prompt and/or image",
    inputs: [
      { id: "prompt", type: "text", label: "prompt" },
      { id: "image", type: "image", label: "image" },
    ],
    outputs: [{ id: "video", type: "video", label: "video" }],
  },
  upscale: {
    label: "Upscale",
    description: "Upscale image resolution",
    inputs: [{ id: "image", type: "image", label: "image" }],
    outputs: [{ id: "image", type: "image", label: "image" }],
  },
  resize: {
    label: "Resize",
    description: "Resize to new dimensions",
    inputs: [{ id: "image", type: "image", label: "image" }],
    outputs: [{ id: "image", type: "image", label: "image" }],
  },
  remove: {
    label: "Remove BG",
    description: "Remove background",
    inputs: [{ id: "image", type: "image", label: "image" }],
    outputs: [{ id: "image", type: "image", label: "image" }],
  },
  tts: {
    label: "Text to Speech",
    description: "Convert text to audio",
    inputs: [{ id: "text", type: "text", label: "text" }],
    outputs: [{ id: "audio", type: "audio", label: "audio" }],
  },
  music: {
    label: "Music",
    description: "Generate music from prompt",
    inputs: [{ id: "prompt", type: "text", label: "prompt" }],
    outputs: [{ id: "audio", type: "audio", label: "audio" }],
  },
  voicechanger: {
    label: "Voice Changer",
    description: "Transform voice audio",
    inputs: [{ id: "audio", type: "audio", label: "audio" }],
    outputs: [{ id: "audio", type: "audio", label: "audio" }],
  },
  gifmaker: {
    label: "GIF Maker",
    description: "Convert video to GIF",
    inputs: [{ id: "video", type: "video", label: "video" }],
    outputs: [{ id: "image", type: "image", label: "gif" }],
  },
  axiom: {
    label: "Product",
    description: "4-image reference collection",
    inputs: [],
    outputs: [{ id: "image", type: "image", label: "images" }],
  },
  style: {
    label: "Style",
    description: "Prompt style preset",
    inputs: [],
    outputs: [{ id: "text", type: "text", label: "prompt" }],
  },
};

let _nodeId = 0;
export function createNode(type: NodeType, x: number, y: number): WorkflowNode {
  const schema = NODE_SCHEMAS[type];
  return {
    id: `node-${++_nodeId}`,
    type,
    label: schema.label,
    position: { x, y },
    inputs: schema.inputs.map((p) => ({ ...p })),
    outputs: schema.outputs.map((p) => ({ ...p })),
    config: {},
  };
}

export const DEMO_WORKFLOW: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
  nodes: [
    { id: "n1", type: "text", label: "Text", position: { x: 80, y: 200 }, inputs: [], outputs: [{ id: "text", type: "text", label: "text" }], config: { value: "A futuristic cityscape at sunset" } },
    { id: "n2", type: "image", label: "Image", position: { x: 380, y: 160 }, inputs: [{ id: "prompt", type: "text", label: "prompt" }, { id: "image", type: "image", label: "image" }], outputs: [{ id: "image", type: "image", label: "image" }], config: { _width: 260 } },
    { id: "n3", type: "upscale", label: "Upscale", position: { x: 700, y: 100 }, inputs: [{ id: "image", type: "image", label: "image" }], outputs: [{ id: "image", type: "image", label: "image" }], config: {} },
    { id: "n4", type: "image", label: "Image", position: { x: 700, y: 280 }, inputs: [{ id: "prompt", type: "text", label: "prompt" }, { id: "image", type: "image", label: "image" }], outputs: [{ id: "image", type: "image", label: "image" }], config: { _width: 260 } },
    { id: "n5", type: "video", label: "Video", position: { x: 1000, y: 200 }, inputs: [{ id: "prompt", type: "text", label: "prompt" }, { id: "image", type: "image", label: "image" }], outputs: [{ id: "video", type: "video", label: "video" }], config: { _width: 260 } },
  ],
  edges: [
    { id: "e1", sourceNode: "n1", sourcePort: "text", targetNode: "n2", targetPort: "prompt" },
    { id: "e2", sourceNode: "n2", sourcePort: "image", targetNode: "n3", targetPort: "image" },
    { id: "e3", sourceNode: "n2", sourcePort: "image", targetNode: "n4", targetPort: "image" },
    { id: "e4", sourceNode: "n1", sourcePort: "text", targetNode: "n5", targetPort: "prompt" },
    { id: "e5", sourceNode: "n2", sourcePort: "image", targetNode: "n5", targetPort: "image" },
  ],
};
