import { useCallback, useRef, useState } from "react";
import type { CanvasNode, UndoCommand } from "../types/canvas";
import { enqueueDirty } from "../services/CanvasStore";
import { saveNodeToLibraryOptimistic, sortNodesReadingOrder } from "../utils/canvasUtils";
import { invalidate } from "../services/AssetCache";
import { useWorkspace } from "../contexts/WorkspaceContext";

type FullscreenState = {
  open: boolean;
  src: string;
  type: "image" | "video" | "svg";
  // Kept so the preview can offer the same actions as the node's mini-menu.
  node?: CanvasNode;
};

type DeleteDeps = {
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
};

export function useNodeToolbar() {
  const { activeWorkspace } = useWorkspace();
  const [fullscreen, setFullscreen] = useState<FullscreenState>({
    open: false,
    src: "",
    type: "image",
  });

  const openFullscreen = useCallback((node: CanvasNode) => {
    const src = node.src || "";
    if (!src) return;
    const type: FullscreenState["type"] =
      node.node_type === "video" ? "video" : node.node_type === "svg" ? "svg" : "image";
    setFullscreen({ open: true, src, type, node });
  }, []);

  const closeFullscreen = useCallback(() => {
    setFullscreen({ open: false, src: "", type: "image" });
  }, []);

  const downloadNode = useCallback(async (node: CanvasNode, projectName?: string, allNodes?: CanvasNode[]) => {
    const url = node.src || "";
    if (!url) return;
    const safePrefix = (projectName || "Asset").replace(/[<>:"/\\|?*]/g, "_");
    const typeLabel = node.node_type === "video" ? "VIDEO" : node.node_type === "audio" ? "AUDIO" : node.node_type === "svg" ? "SVG" : "IMAGE";
    let count = 1;
    if (allNodes) {
      const sameType = sortNodesReadingOrder(allNodes.filter((n) => n.node_type === node.node_type));
      const idx = sameType.findIndex((n) => n.id === node.id);
      count = idx >= 0 ? idx + 1 : sameType.length + 1;
    }
    // Route cross-origin URLs through our media proxy so the browser sees
    // a same-origin response with the right Content-Type, and the <a download>
    // attribute actually triggers a save instead of bouncing through the
    // catch into window.open() (which opens videos inline in a new tab).
    const fetchUrl = url.startsWith("http://") || url.startsWith("https://")
      ? `/api/media-proxy?url=${encodeURIComponent(url)}`
      : url;
    try {
      const resp = await fetch(fetchUrl);
      const ct = resp.headers.get("content-type") || "";
      let ext = node.node_type === "audio" ? ".mp3" : node.node_type === "video" ? ".mp4" : node.node_type === "svg" ? ".svg" : ".png";
      if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
      else if (ct.includes("webp")) ext = ".webp";
      else if (ct.includes("gif")) ext = ".gif";
      else if (ct.includes("webm")) ext = ".webm";
      else if (ct.includes("mov") || ct.includes("quicktime")) ext = ".mov";
      else if (ct.includes("audio/mpeg") || ct.includes("audio/mp3")) ext = ".mp3";
      else if (ct.includes("audio/wav")) ext = ".wav";
      else if (ct.includes("audio/ogg")) ext = ".ogg";
      else if (ct.includes("audio/aac") || ct.includes("audio/mp4")) ext = ".m4a";
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${safePrefix}_${typeLabel}_${String(count).padStart(3, "0")}${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(url, "_blank");
    }
  }, []);

  const savingNodes = useRef(new Set<string>());

  const saveToLibrary = useCallback((node: CanvasNode, onRefresh: () => void): Promise<{ ok: boolean }> => {
    if (savingNodes.current.has(node.id)) return Promise.resolve({ ok: true });
    savingNodes.current.add(node.id);
    return saveNodeToLibraryOptimistic(node, onRefresh).finally(() => {
      savingNodes.current.delete(node.id);
    });
  }, []);

  // A node's label IS the prompt that made it, and /api/styles is already the
  // prompt store the Styles library reads — so "save prompt" is one POST, not a
  // new table. No optimistic insert: the styles list isn't on screen when you
  // click this, so there's nothing to keep in sync, just a cache to drop.
  const savePrompt = useCallback((node: CanvasNode): Promise<{ ok: boolean }> => {
    const prompt = (node.label || "").trim();
    if (!prompt) return Promise.resolve({ ok: false });
    const key = `prompt:${node.id}`;
    if (savingNodes.current.has(key)) return Promise.resolve({ ok: true });
    savingNodes.current.add(key);
    const body: Record<string, unknown> = {
      // The name is what you scan in the library; the prompt is kept whole.
      name: prompt.length > 48 ? `${prompt.slice(0, 48).trimEnd()}…` : prompt,
      prompt,
      image_url: node.src || null,
    };
    if (activeWorkspace?.type === "org" && activeWorkspace.id) {
      body.scope = "org";
      body.workspace_id = activeWorkspace.id;
    }
    return fetch("/api/styles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.ok) invalidate("styles");
        return { ok: res.ok };
      })
      .catch(() => ({ ok: false }))
      .finally(() => { savingNodes.current.delete(key); });
  }, [activeWorkspace?.id, activeWorkspace?.type]);

  const deleteNode = useCallback((node: CanvasNode, deps: DeleteDeps) => {
    const { setNodes, pushUndo, canvasId } = deps;
    pushUndo({
      type: "delete",
      undo: () => setNodes((prev) => [...prev, node]),
      redo: () => {
        setNodes((prev) => prev.filter((n) => n.id !== node.id));
        if (canvasId) enqueueDirty({ type: "delete", canvasId, nodeId: node.id, committed: true });
      },
    });
    setNodes((prev) => prev.filter((n) => n.id !== node.id));
    if (canvasId) enqueueDirty({ type: "delete", canvasId, nodeId: node.id, committed: true });
  }, []);

  return {
    fullscreen,
    openFullscreen,
    closeFullscreen,
    downloadNode,
    saveToLibrary,
    savePrompt,
    deleteNode,
  };
}
