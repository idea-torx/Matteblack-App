import { useCallback, type MutableRefObject } from "react";
import { jsPDF } from "jspdf";
import type { CanvasNode } from "../types/canvas";
import { renderFrameCanvas } from "../utils/frameExportHelpers";

type ExportFormat = "png" | "pdf";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportFramesAsPng(frameNodes: CanvasNode[], allNodes: CanvasNode[]) {
  for (let i = 0; i < frameNodes.length; i++) {
    const frameNode = frameNodes[i];
    const canvas = await renderFrameCanvas(frameNode, allNodes);
    if (!canvas) continue;
    let blob: Blob | null = null;
    try {
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    } catch (err) {
      console.warn(`[frameExport] Canvas toBlob failed (canvas may be tainted): ${err}`);
      continue;
    }
    if (!blob) continue;
    const w = Math.max(1, Math.round(frameNode.width));
    const h = Math.max(1, Math.round(frameNode.height));
    const filename = frameNodes.length === 1
      ? `frame-${w}x${h}.png`
      : `frame-${i + 1}-${w}x${h}.png`;
    downloadBlob(blob, filename);
  }
}

async function exportFramesAsPdf(frameNodes: CanvasNode[], allNodes: CanvasNode[]) {
  if (frameNodes.length === 0) return;

  const canvases: HTMLCanvasElement[] = [];
  for (const frameNode of frameNodes) {
    const canvas = await renderFrameCanvas(frameNode, allNodes);
    if (canvas) canvases.push(canvas);
  }
  if (canvases.length === 0) return;

  const firstCanvas = canvases[0];
  const pxToMm = 25.4 / 96;
  const firstW = firstCanvas.width * pxToMm;
  const firstH = firstCanvas.height * pxToMm;
  const orientation = firstW > firstH ? "landscape" : "portrait";
  const pdf = new jsPDF({
    orientation,
    unit: "mm",
    format: [firstW, firstH],
  });

  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i];
    const pageW = canvas.width * pxToMm;
    const pageH = canvas.height * pxToMm;

    if (i > 0) {
      const pageOrientation = pageW > pageH ? "l" : "p";
      pdf.addPage([pageW, pageH], pageOrientation);
    }

    let imgData: string;
    try {
      imgData = canvas.toDataURL("image/png");
    } catch (err) {
      console.warn(`[frameExport] Canvas toDataURL failed (canvas may be tainted): ${err}`);
      continue;
    }
    pdf.addImage(imgData, "PNG", 0, 0, pageW, pageH);
  }

  pdf.save(frameNodes.length === 1 ? "frame-export.pdf" : "frames-export.pdf");
}

export function useFrameExport(nodesRef: MutableRefObject<CanvasNode[]>) {
  const exportFrames = useCallback(
    async (frameIds: string[], format: ExportFormat) => {
      const allNodes = nodesRef.current;
      const frameNodes = frameIds
        .map((id) => allNodes.find((n) => n.id === id && n.node_type === "frame"))
        .filter((n): n is CanvasNode => !!n);

      if (frameNodes.length === 0) return;

      if (format === "pdf") {
        await exportFramesAsPdf(frameNodes, allNodes);
      } else {
        await exportFramesAsPng(frameNodes, allNodes);
      }
    },
    [nodesRef]
  );

  return { exportFrames };
}
