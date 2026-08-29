type Generation = {
  id: string;
  label: string;
  gradient: string;
  operation: "make" | "edit" | "upscale" | "resize" | "remove";
  ar?: string;
  type?: "image" | "video";
  duration?: string;
};

type GenerationRow = {
  id: string;
  items: Generation[];
};

export const DEMO_ROWS: GenerationRow[] = [
  {
    id: "lineage-1",
    items: [
      { id: "l1-upscale", label: "Upscaled", gradient: "linear-gradient(135deg, #0d35ff 0%, #2563eb 30%, #93c5fd 75%, #dbeafe 100%)", operation: "upscale" },
      { id: "l1-edit", label: "Edited", gradient: "linear-gradient(145deg, #1e1b4b 0%, #4338ca 35%, #818cf8 65%, #c7d2fe 100%)", operation: "edit" },
      { id: "l1-make", label: "Original", gradient: "linear-gradient(155deg, #0d35ff 0%, #2563eb 30%, #60a5fa 55%, #93c5fd 75%, #dbeafe 100%)", operation: "make" },
    ],
  },
  {
    id: "lineage-2",
    items: [
      { id: "l2-video", label: "Animated", gradient: "linear-gradient(155deg, #0c1a0c 0%, #166534 35%, #4ade80 65%, #dcfce7 100%)", operation: "make", type: "video", duration: "0:04", ar: "16:9" },
      { id: "l2-resize", label: "Resized", gradient: "linear-gradient(155deg, #14532d 0%, #22c55e 50%, #bbf7d0 100%)", operation: "resize", ar: "16:9" },
      { id: "l2-edit", label: "Edited", gradient: "linear-gradient(140deg, #0c1a0c 0%, #166534 35%, #4ade80 65%, #dcfce7 100%)", operation: "edit" },
      { id: "l2-make", label: "Original", gradient: "linear-gradient(155deg, #0c1a0c 0%, #166534 35%, #4ade80 65%, #dcfce7 100%)", operation: "make" },
    ],
  },
  {
    id: "lineage-3",
    items: [
      { id: "l3-video", label: "Video", gradient: "linear-gradient(160deg, #050508 0%, #0a0a14 15%, #0d35ff 45%, #007aff 60%, #abc5f9 85%, #d8e8ff 100%)", operation: "make", type: "video", duration: "0:08" },
      { id: "l3-make", label: "Original", gradient: "linear-gradient(160deg, #050508 0%, #0a0a14 15%, #0d35ff 45%, #007aff 60%, #abc5f9 85%, #d8e8ff 100%)", operation: "make" },
    ],
  },
  {
    id: "lineage-4",
    items: [
      { id: "l4-resize", label: "Resized", gradient: "linear-gradient(170deg, #1c1917 0%, #92400e 40%, #f59e0b 80%)", operation: "resize", ar: "9:16" },
      { id: "l4-make", label: "Original", gradient: "linear-gradient(170deg, #1c1917 0%, #78350f 30%, #f59e0b 60%, #fef3c7 100%)", operation: "make", ar: "4:5" },
    ],
  },
  {
    id: "lineage-5",
    items: [
      { id: "l5-edit", label: "Edited", gradient: "linear-gradient(140deg, #1a0a2e 0%, #6d28d9 40%, #c4b5fd 100%)", operation: "edit", ar: "21:9" },
      { id: "l5-make", label: "Original", gradient: "linear-gradient(160deg, #0f172a 0%, #1e3a5f 30%, #0ea5e9 60%, #7dd3fc 100%)", operation: "make", ar: "21:9" },
    ],
  },
  {
    id: "lineage-6",
    items: [
      { id: "l6-video", label: "Video", gradient: "linear-gradient(145deg, #4a0e0e 0%, #dc2626 35%, #fca5a5 70%, #fef2f2 100%)", operation: "make", type: "video", duration: "0:12", ar: "16:9" },
      { id: "l6-make", label: "Original", gradient: "linear-gradient(145deg, #4a0e0e 0%, #dc2626 35%, #fca5a5 70%, #fef2f2 100%)", operation: "make" },
    ],
  },
];

export const GENERATION_LOOKUP: Map<string, Generation> = new Map(
  DEMO_ROWS.flatMap((row) => row.items.map((g) => [g.id, g] as const))
);
