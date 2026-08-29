import { useRef, useState, useCallback, useEffect } from "react";
import type { CanvasNode, ReferenceImage } from "../../types/canvas";
import { clampDimensions } from "../../utils/canvasUtils";
import { enqueueDirty } from "../../services/CanvasStore";
import { extractPathDataFromSvg } from "../../utils/svgPathModel";
import { parseSvgToPathData } from "../../utils/parseSvgToPathData";

// Server caps uploads at 50MB. Very large images (e.g. 5000px+ photos or
// PNG screenshots) can blow past that and the upload silently fails,
// causing the dropped node to vanish from the canvas. To prevent that we
// re-encode raster images that are either oversized in pixels OR oversized
// in bytes BEFORE uploading. SVG is left alone (vector — small + we'd lose
// path data). GIF is left alone too so we don't strip animation frames.
const MAX_UPLOAD_PIXELS = 2560;       // longest edge after downscale
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // re-encode anything over 8MB

async function maybeDownscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // Skip vector and animated formats — re-encoding would break them.
  if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) return file;
  if (file.type === "image/gif") return file;
  // Cheap path: small files in pixel terms can skip the round-trip.
  if (file.size < MAX_UPLOAD_BYTES) {
    // Even small files might be wider than the canvas wants; load to check.
    try {
      const dims = await readImageDims(file);
      if (Math.max(dims.w, dims.h) <= MAX_UPLOAD_PIXELS) return file;
    } catch {
      return file; // can't read dims — leave it alone
    }
  }
  try {
    const bitmap = await loadBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > MAX_UPLOAD_PIXELS ? MAX_UPLOAD_PIXELS / longest : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      if (typeof (bitmap as ImageBitmap).close === "function") {
        (bitmap as ImageBitmap).close();
      }
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (typeof (bitmap as ImageBitmap).close === "function") {
      (bitmap as ImageBitmap).close();
    }
    // PNGs that contain transparency must stay PNG; otherwise prefer JPEG
    // for big size savings on photos. Keep PNG for SVG-rendered exports too.
    const keepPng = file.type === "image/png" || file.type === "image/webp";
    const mime = keepPng ? "image/png" : "image/jpeg";
    const quality = keepPng ? undefined : 0.92;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, mime, quality));
    if (!blob) return file;
    // If our re-encode somehow ended up larger than the original (rare for
    // tiny images), fall back to the original.
    if (blob.size >= file.size && longest <= MAX_UPLOAD_PIXELS) return file;
    const ext = keepPng ? "png" : "jpg";
    const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
    const newName = `${baseName}.${ext}`;
    return new File([blob], newName, { type: mime, lastModified: file.lastModified });
  } catch (err) {
    console.warn("[Canvas] Image downscale failed, uploading original:", err);
    return file;
  }
}

async function loadBitmap(file: File): Promise<HTMLImageElement | ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to <img> path
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function readImageDims(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

type UseCanvasDropParams = {
  screenToCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  addNodeAtPosition: (x: number, y: number, props: Partial<CanvasNode>, options?: { skipSync?: boolean }) => CanvasNode;
  emitNodeMeta: (id: string, node: CanvasNode) => void;
  onSelectImageRef: React.MutableRefObject<(id: string, mode?: "exclusive" | "toggle") => void>;
  onDeselectAllRef: React.MutableRefObject<(() => void) | undefined>;
  onDropPrompt?: (prompt: string) => void;
  onDropReference?: (ref: ReferenceImage) => void;
  onDropTrayItem?: (item: unknown) => void;
  canvasId: string | null;
  idMapRef: React.MutableRefObject<Map<string, string>>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
};

export function useCanvasDrop({
  screenToCanvas,
  addNodeAtPosition,
  emitNodeMeta,
  onSelectImageRef,
  onDeselectAllRef,
  onDropPrompt,
  onDropReference,
  onDropTrayItem,
  canvasId,
  idMapRef,
  viewportRef,
  setNodes,
}: UseCanvasDropParams) {
  const [dragOver, setDragOver] = useState(false);
  const [dragPlaceholder, setDragPlaceholder] = useState<{ x: number; y: number; w: number; h: number; url?: string } | null>(null);
  const dragDimsCache = useRef<Map<string, { w: number; h: number }>>(new Map());
  const dragDimsLoading = useRef<Set<string>>(new Set());

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".cinema-timeline__track")) {
      setDragOver(false);
      setDragPlaceholder(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer.types.includes("application/x-cinema-clip-out")) {
      e.dataTransfer.dropEffect = "move";
      setDragOver(true);
      return;
    }
    if (e.dataTransfer.types.includes("application/x-tray-item")) {
      e.dataTransfer.dropEffect = "move";
      const pos = screenToCanvas(e.clientX, e.clientY);

      const el = document.querySelector("[data-tray-drag-url]") as HTMLElement | null;
      const trayUrl = el?.dataset.trayDragUrl || "";
      const isVideo = el?.dataset.trayDragVideo === "true";
      const isAudio = el?.dataset.trayDragAudio === "true";

      let pw = isAudio ? 300 : isVideo ? 512 : 256;
      let ph = isAudio ? 80 : isVideo ? 288 : 256;
      if (trayUrl && dragDimsCache.current.has(trayUrl)) {
        const cached = dragDimsCache.current.get(trayUrl)!;
        pw = cached.w;
        ph = cached.h;
      } else if (trayUrl && !isAudio && !dragDimsLoading.current.has(trayUrl)) {
        dragDimsLoading.current.add(trayUrl);
        if (isVideo) {
          const vid = document.createElement("video");
          vid.onloadedmetadata = () => {
            const { w, h } = clampDimensions(vid.videoWidth || 512, vid.videoHeight || 288);
            dragDimsCache.current.set(trayUrl, { w, h });
            dragDimsLoading.current.delete(trayUrl);
          };
          vid.onerror = () => { dragDimsLoading.current.delete(trayUrl); };
          vid.src = trayUrl;
        } else {
          const img = new Image();
          img.onload = () => {
            const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
            dragDimsCache.current.set(trayUrl, { w, h });
            dragDimsLoading.current.delete(trayUrl);
          };
          img.onerror = () => { dragDimsLoading.current.delete(trayUrl); };
          img.src = trayUrl;
        }
      }

      setDragPlaceholder({
        x: pos.x - pw / 2,
        y: pos.y - ph / 2,
        w: pw,
        h: ph,
        url: trayUrl || undefined,
      });
    }
    setDragOver(true);
  }, [screenToCanvas]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
      setDragPlaceholder(null);
    }
  }, []);

  useEffect(() => {
    const overHandler = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("application/x-tray-item")) return;
      const viewport = viewportRef.current;
      if (viewport && viewport.contains(e.target as Node)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };
    const endHandler = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("application/x-tray-item")) return;
      setDragOver(false);
      setDragPlaceholder(null);
    };
    document.addEventListener("dragover", overHandler);
    document.addEventListener("dragend", endHandler);
    return () => {
      document.removeEventListener("dragover", overHandler);
      document.removeEventListener("dragend", endHandler);
    };
  }, [viewportRef]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".cinema-timeline__track")) {
      return;
    }

    e.preventDefault();
    setDragOver(false);
    setDragPlaceholder(null);

    const cinemaClipOut = e.dataTransfer.getData("application/x-cinema-clip-out");
    if (cinemaClipOut) {
      try {
        const clip = JSON.parse(cinemaClipOut);
        const canvasPos = screenToCanvas(e.clientX, e.clientY);
        const clipType = clip.type || "image";
        const nodeType = clipType === "audio" ? "audio" : clipType === "video" ? "video" : "image";
        const w = nodeType === "audio" ? 300 : nodeType === "video" ? 480 : 256;
        const h = nodeType === "audio" ? 80 : nodeType === "video" ? 270 : 256;
        const n = addNodeAtPosition(canvasPos.x - w / 2, canvasPos.y - h / 2, {
          node_type: nodeType,
          width: w,
          height: h,
          label: clip.label || "",
          src: clip.src || "",
        });
        emitNodeMeta(n.id, n);
        onSelectImageRef.current(n.id, "exclusive");
      } catch {}
      return;
    }

    const stylePrompt = e.dataTransfer.getData("application/x-style-prompt");
    if (stylePrompt && onDropPrompt) {
      onDropPrompt(stylePrompt);
      return;
    }

    onDeselectAllRef.current?.();

    const selectNewNode = (node: CanvasNode) => {
      emitNodeMeta(node.id, node);
      onSelectImageRef.current(node.id, "exclusive");
    };

    const canvasPos = screenToCanvas(e.clientX, e.clientY);

    const axiomData = e.dataTransfer.getData("application/x-axiom");
    if (axiomData) {
      try {
        const data = JSON.parse(axiomData);
        const thumb = data.axiomThumb || "";
        const allImages: string[] = data.axiomImages || [];
        if (thumb) {
          const img = new Image();
          img.onload = () => {
            const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
            const n = addNodeAtPosition(canvasPos.x - w / 2, canvasPos.y - h / 2, {
              label: data.axiomName || "Product", src: thumb, width: w, height: h,
              metadata: { axiomId: data.axiomId, axiomImages: allImages, axiomName: data.axiomName || "", axiomDescription: data.axiomDescription || "" },
            });
            selectNewNode(n);
          };
          img.onerror = () => {
            const n = addNodeAtPosition(canvasPos.x - 128, canvasPos.y - 128, {
              label: data.axiomName || "Product", src: thumb,
              metadata: { axiomId: data.axiomId, axiomImages: allImages, axiomName: data.axiomName || "", axiomDescription: data.axiomDescription || "" },
            });
            selectNewNode(n);
          };
          img.src = thumb;
        } else {
          const n = addNodeAtPosition(canvasPos.x - 128, canvasPos.y - 128, {
            label: data.axiomName || "Product", src: "",
            metadata: { axiomId: data.axiomId, axiomImages: allImages, axiomName: data.axiomName || "", axiomDescription: data.axiomDescription || "" },
          });
          selectNewNode(n);
        }
      } catch { /* ignore */ }
      return;
    }

    const placeLibAsset = (data: { id: string; label?: string; name?: string; gradient?: string; type?: string }, ox: number, oy: number, autoSelect = false) => {
      const isUrl = data.gradient && !data.gradient.startsWith("linear-gradient") && !data.gradient.startsWith("radial-gradient");
      const srcUrl = isUrl ? data.gradient! : "";
      const isVideo = data.type === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(srcUrl);
      const assetLabel = data.label || data.name || "Asset";
      if (srcUrl && isVideo) {
        const vid = document.createElement("video");
        vid.onloadedmetadata = () => {
          const { w, h } = clampDimensions(vid.videoWidth || 512, vid.videoHeight || 288);
          const n = addNodeAtPosition(ox - w / 2, oy - h / 2, {
            label: assetLabel, src: srcUrl, gradient: "", node_type: "video", width: w, height: h,
          });
          if (autoSelect) selectNewNode(n);
        };
        vid.onerror = () => {
          const n = addNodeAtPosition(ox - 256, oy - 144, {
            label: assetLabel, src: srcUrl, gradient: "", node_type: "video", width: 512, height: 288,
          });
          if (autoSelect) selectNewNode(n);
        };
        vid.src = srcUrl;
      } else if (srcUrl) {
        const img = new Image();
        img.onload = () => {
          const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
          const n = addNodeAtPosition(ox - w / 2, oy - h / 2, {
            label: assetLabel, src: srcUrl, gradient: "", width: w, height: h,
          });
          if (autoSelect) selectNewNode(n);
        };
        img.onerror = () => {
          const n = addNodeAtPosition(ox - 128, oy - 128, {
            label: assetLabel, src: srcUrl, gradient: "",
          });
          if (autoSelect) selectNewNode(n);
        };
        img.src = srcUrl;
      } else {
        const n = addNodeAtPosition(ox - 128, oy - 128, {
          label: assetLabel, src: "", gradient: data.gradient || "",
        });
        if (autoSelect) selectNewNode(n);
      }
    };

    const libAssets = e.dataTransfer.getData("application/x-library-assets");
    const libAsset = e.dataTransfer.getData("application/x-library-asset");
    if (libAssets) {
      try {
        const items: { id: string; label: string; gradient: string; type?: string }[] = JSON.parse(libAssets);
        const cols = Math.ceil(Math.sqrt(items.length));
        const spacing = 280;
        items.forEach((data, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const ox = canvasPos.x + (col - (cols - 1) / 2) * spacing;
          const oy = canvasPos.y + (row - (Math.ceil(items.length / cols) - 1) / 2) * spacing;
          placeLibAsset(data, ox, oy);
        });
        if (onDropReference && items.length > 0) onDropReference({ id: items[0].id, label: items[0].label, gradient: items[0].gradient });
      } catch { /* ignore */ }
      return;
    }
    if (libAsset) {
      try {
        const data = JSON.parse(libAsset);
        placeLibAsset(data, canvasPos.x, canvasPos.y, true);
        if (onDropReference) onDropReference({ id: data.id, label: data.label, gradient: data.gradient });
      } catch { /* ignore parse errors */ }
      return;
    }

    const trayData = e.dataTransfer.getData("application/x-tray-item");
    if (trayData) {
      try {
        const item = JSON.parse(trayData);
        const trayUrl = item.result_url || "";
        const isVideo = item.job_type === "video_gen" || item.job_type === "avatar";
        const isSvg = item.job_type === "text_to_vector" || item.asset_type === "svg";
        const audioJobTypes = new Set(["audio_tts", "audio_music", "audio_sfx", "audio_voice_changer"]);
        const isAudio = audioJobTypes.has(item.job_type || "");
        const itemLabel = item.prompt || (item.metadata?.prompt as string) || "Generation";
        if (trayUrl && isAudio) {
          const aw = 300;
          const ah = 80;
          const subtypeMap: Record<string, string> = { audio_tts: "tts", audio_music: "music", audio_sfx: "sfx", audio_voice_changer: "voice" };
          const audioMeta: Record<string, unknown> = {
            audioSubtype: subtypeMap[item.job_type || ""] || "music",
            prompt: item.prompt || (item.metadata?.prompt as string) || "",
          };
          if (item.job_params) audioMeta.jobParams = item.job_params;
          const n = addNodeAtPosition(canvasPos.x - aw / 2, canvasPos.y - ah / 2, {
            label: itemLabel, src: trayUrl, job_id: item.job_id || null,
            node_type: "audio", width: aw, height: ah, metadata: audioMeta,
          });
          selectNewNode(n);
          onDropTrayItem?.(item);
        } else if (trayUrl && isSvg) {
          const svgMeta: Record<string, unknown> = {};
          if (item.svg_content) svgMeta.svg_content = item.svg_content;
          const img = new Image();
          img.onload = () => {
            const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
            if (item.svg_content) {
              const parsed = extractPathDataFromSvg(item.svg_content, w, h);
              if (parsed) svgMeta.pathData = parsed;
            }
            const n = addNodeAtPosition(canvasPos.x - w / 2, canvasPos.y - h / 2, {
              label: itemLabel, src: trayUrl, job_id: item.job_id || null,
              node_type: "svg", width: w, height: h, metadata: svgMeta,
            });
            selectNewNode(n);
            onDropTrayItem?.(item);
          };
          img.onerror = () => {
            if (item.svg_content) {
              const parsed = extractPathDataFromSvg(item.svg_content, 256, 256);
              if (parsed) svgMeta.pathData = parsed;
            }
            const n = addNodeAtPosition(canvasPos.x - 128, canvasPos.y - 128, {
              label: itemLabel, src: trayUrl, job_id: item.job_id || null,
              node_type: "svg", metadata: svgMeta,
            });
            selectNewNode(n);
            onDropTrayItem?.(item);
          };
          img.src = trayUrl;
        } else if (trayUrl && isVideo) {
          const vid = document.createElement("video");
          vid.onloadedmetadata = () => {
            const { w, h } = clampDimensions(vid.videoWidth || 512, vid.videoHeight || 288);
            const n = addNodeAtPosition(canvasPos.x - w / 2, canvasPos.y - h / 2, {
              label: itemLabel, src: trayUrl, job_id: item.job_id || null,
              node_type: "video", width: w, height: h,
            });
            selectNewNode(n);
            onDropTrayItem?.(item);
          };
          vid.onerror = () => {
            const n = addNodeAtPosition(canvasPos.x - 256, canvasPos.y - 144, {
              label: itemLabel, src: trayUrl, job_id: item.job_id || null,
              node_type: "video", width: 512, height: 288,
            });
            selectNewNode(n);
            onDropTrayItem?.(item);
          };
          vid.src = trayUrl;
        } else if (trayUrl) {
          const img = new Image();
          img.onload = () => {
            const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
            const n = addNodeAtPosition(canvasPos.x - w / 2, canvasPos.y - h / 2, {
              label: itemLabel, src: trayUrl, job_id: item.job_id || null, width: w, height: h,
            });
            selectNewNode(n);
            onDropTrayItem?.(item);
          };
          img.onerror = () => {
            const n = addNodeAtPosition(canvasPos.x - 128, canvasPos.y - 128, {
              label: itemLabel, src: trayUrl, job_id: item.job_id || null,
            });
            selectNewNode(n);
            onDropTrayItem?.(item);
          };
          img.src = trayUrl;
        } else {
          const n = addNodeAtPosition(canvasPos.x - 128, canvasPos.y - 128, {
            label: itemLabel, src: "", job_id: item.job_id || null,
          });
          selectNewNode(n);
          onDropTrayItem?.(item);
        }
      } catch { /* ignore */ }
      return;
    }

    const canvasGen = e.dataTransfer.getData("application/x-canvas-gen");
    if (canvasGen) {
      try {
        const data = JSON.parse(canvasGen);
        const n = addNodeAtPosition(canvasPos.x - 128, canvasPos.y - 128, {
          label: data.label || "Generation",
          gradient: data.gradient || "",
        });
        selectNewNode(n);
      } catch { /* ignore */ }
      return;
    }

    const droppedFiles = e.dataTransfer.files;
    if (!droppedFiles.length) return;

    const validFiles: File[] = [];
    for (let i = 0; i < droppedFiles.length; i++) {
      const f = droppedFiles[i];
      if (f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/")) {
        validFiles.push(f);
      }
    }
    if (!validFiles.length) return;

    const cols = Math.ceil(Math.sqrt(validFiles.length));
    const spacing = 280;
    const totalRows = Math.ceil(validFiles.length / cols);

    validFiles.forEach((file, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const ox = canvasPos.x + (col - (cols - 1) / 2) * spacing;
      const oy = canvasPos.y + (row - (totalRows - 1) / 2) * spacing;

      const localPreviewUrl = URL.createObjectURL(file);
      const isAudioFile = file.type.startsWith("audio/");
      const isVideoFile = file.type.startsWith("video/");
      const isSvgFile = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");

      const uploadFile = (tempNode: CanvasNode, extraMeta?: Record<string, unknown>) => {
        const tempId = tempNode.id;
        const uploadClientId = typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        const removeTempNode = (reason?: string) => {
          URL.revokeObjectURL(localPreviewUrl);
          setNodes((prev) => prev.filter((n) => n.id !== tempId && n.id !== (idMapRef.current.get(tempId) || "")));
          if (reason && typeof window !== "undefined") {
            // Surface a clear error so the dropped node disappearing isn't silent.
            try { window.alert(reason); } catch { /* ignore */ }
          }
        };
        // For images, downscale before upload so 5000px+ photos don't blow
        // past the server's 50MB cap. Videos / audio / SVG go through as-is.
        const prep = (isAudioFile || isVideoFile || isSvgFile)
          ? Promise.resolve(file)
          : maybeDownscaleImage(file);
        prep.then((toUpload) => {
          const formData = new FormData();
          formData.append("file", toUpload);
          formData.append("name", toUpload.name);
          formData.append("type", isAudioFile ? "audio" : isVideoFile ? "video" : "image");
          formData.append("source", "canvas");
          return fetch("/api/assets", { method: "POST", credentials: "include", body: formData })
            .then((r) => {
              if (!r.ok) {
                if (r.status === 413) {
                  throw new Error(`File "${file.name}" is too large to upload (max 50MB).`);
                }
                throw new Error(`Upload failed for "${file.name}" (${r.status}).`);
              }
              return r.json();
            });
        })
          .then((data) => {
            if (!data.asset?.file_url) { removeTempNode(`Upload of "${file.name}" did not return a file URL.`); console.error("[Canvas] Upload succeeded but no file_url returned"); return; }
            const resolvedId = idMapRef.current.get(tempId) || tempId;
            const assetId = data.asset.id || null;
            setNodes((prev) => prev.map((n) => n.id === resolvedId || n.id === tempId ? { ...n, src: data.asset.file_url, asset_id: assetId } : n));
            URL.revokeObjectURL(localPreviewUrl);
            if (canvasId) {
              const nodeForSync = { ...tempNode, src: data.asset.file_url, asset_id: assetId, ...(extraMeta ? { metadata: { ...((tempNode.metadata as Record<string,unknown>) || {}), ...extraMeta } } : {}) };
              enqueueDirty({ type: "create", localId: tempId, clientId: uploadClientId, canvasId, node: nodeForSync, committed: true });
            }
          })
          .catch((err) => {
            console.error("[Canvas] File upload failed:", err);
            const msg = err instanceof Error ? err.message : `Upload of "${file.name}" failed.`;
            removeTempNode(msg);
          });
      };

      const isSingleDrop = validFiles.length === 1;
      const selectDroppedNode = (node: CanvasNode) => {
        emitNodeMeta(node.id, node);
        if (isSingleDrop) {
          onSelectImageRef.current(node.id, "exclusive");
        }
      };

      if (isAudioFile) {
        const aw = 300;
        const ah = 80;
        const audioLabel = file.name.replace(/\.[^.]+$/, "");
        const tempNode = addNodeAtPosition(ox - aw / 2, oy - ah / 2, {
          label: audioLabel,
          src: localPreviewUrl,
          node_type: "audio",
          width: aw,
          height: ah,
          metadata: { audioSubtype: "upload" },
        }, { skipSync: true });
        selectDroppedNode(tempNode);
        uploadFile(tempNode);
      } else if (isSvgFile) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const svgContent = ev.target?.result as string;
          const placeSvgNode = (natW: number, natH: number) => {
            const { w, h } = clampDimensions(natW, natH);
            const svgMeta: Record<string, unknown> = { svg_content: svgContent };
            const parsed = parseSvgToPathData(svgContent, w, h);
            if (parsed) svgMeta.pathData = parsed;
            const tempNode = addNodeAtPosition(ox - w / 2, oy - h / 2, {
              label: file.name.replace(/\.svg$/i, ""),
              src: localPreviewUrl,
              node_type: "svg",
              width: w,
              height: h,
              metadata: svgMeta,
            }, { skipSync: true });
            selectDroppedNode(tempNode);
            uploadFile(tempNode);
          };
          const img = new Image();
          img.onload = () => placeSvgNode(img.naturalWidth || 256, img.naturalHeight || 256);
          img.onerror = () => placeSvgNode(256, 256);
          img.src = localPreviewUrl;
        };
        reader.onerror = () => { URL.revokeObjectURL(localPreviewUrl); };
        reader.readAsText(file);
      } else if (isVideoFile) {
        const placeVideoNode = (natW: number, natH: number) => {
          const { w, h } = clampDimensions(natW, natH);
          const tempNode = addNodeAtPosition(ox - w / 2, oy - h / 2, {
            label: file.name, src: localPreviewUrl, node_type: "video", width: w, height: h,
          }, { skipSync: true });
          selectDroppedNode(tempNode);
          uploadFile(tempNode);
        };
        const vid = document.createElement("video");
        vid.preload = "metadata";
        vid.onloadedmetadata = () => { placeVideoNode(vid.videoWidth || 256, vid.videoHeight || 256); URL.revokeObjectURL(vid.src); };
        vid.onerror = () => { placeVideoNode(256, 256); URL.revokeObjectURL(vid.src); };
        vid.src = localPreviewUrl;
      } else {
        const placeImageNode = (natW: number, natH: number) => {
          const { w, h } = clampDimensions(natW, natH);
          const tempNode = addNodeAtPosition(ox - w / 2, oy - h / 2, {
            label: file.name, src: localPreviewUrl, node_type: "image", width: w, height: h,
          }, { skipSync: true });
          selectDroppedNode(tempNode);
          uploadFile(tempNode);
        };
        const img = new Image();
        img.onload = () => placeImageNode(img.naturalWidth || 256, img.naturalHeight || 256);
        img.onerror = () => placeImageNode(256, 256);
        img.src = localPreviewUrl;
      }
    });
  }, [screenToCanvas, addNodeAtPosition, onDropPrompt, onDropTrayItem, canvasId, emitNodeMeta, onSelectImageRef, onDeselectAllRef, onDropReference, idMapRef, setNodes]);

  return {
    dragOver,
    dragPlaceholder,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
