import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { deleteWorkspace as apiDeleteWorkspace } from "../api/workspace";

export type WorkspaceItem = {
  id: string;
  name: string;
  type: string;
  owner_id: string;
  role: string;
};

type WorkspaceContextValue = {
  workspaces: WorkspaceItem[];
  activeWorkspace: WorkspaceItem | null;
  loading: boolean;
  setActiveWorkspace: (ws: WorkspaceItem) => void;
  createWorkspace: (name: string) => Promise<{ error?: string }>;
  deleteWorkspace: (id: string) => Promise<{ error?: string }>;
  refreshWorkspaces: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceItem | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchWorkspaces = useCallback(async () => {
    if (!user) {
      if (authLoading) return;
      setWorkspaces([]);
      setActiveWorkspace(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/workspaces", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch workspaces");
      const data: WorkspaceItem[] = await res.json();
      setWorkspaces(data);
      setActiveWorkspace((prev) => {
        if (prev) {
          const updated = data.find((w) => w.id === prev.id);
          if (updated) return updated;
        }
        return data.length > 0 ? data[0] : null;
      });
    } catch {
      setWorkspaces([]);
      setActiveWorkspace(null);
    } finally {
      setLoading(false);
    }
  }, [user, authLoading]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const createWorkspace = useCallback(async (name: string): Promise<{ error?: string }> => {
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        return { error: data.error || "Failed to create workspace" };
      }
      const newWs = await res.json();
      await fetchWorkspaces();
      setActiveWorkspace({
        id: newWs.id,
        name: newWs.name,
        type: newWs.type,
        owner_id: newWs.owner_id,
        role: "owner",
      });
      return {};
    } catch {
      return { error: "Network error" };
    }
  }, [fetchWorkspaces]);

  const deleteWorkspaceHandler = useCallback(async (id: string): Promise<{ error?: string }> => {
    const result = await apiDeleteWorkspace(id);
    if (result.error) return result;
    const res = await fetch("/api/workspaces", { credentials: "include" });
    if (res.ok) {
      const freshList: WorkspaceItem[] = await res.json();
      setWorkspaces(freshList);
      setActiveWorkspace((prev) => {
        if (prev?.id === id) {
          const personal = freshList.find((w) => w.type === "personal");
          return personal || freshList[0] || null;
        }
        const stillExists = freshList.find((w) => w.id === prev?.id);
        return stillExists || freshList[0] || null;
      });
    }
    return {};
  }, []);

  return (
    <WorkspaceContext.Provider value={{ workspaces, activeWorkspace, loading, setActiveWorkspace, createWorkspace, deleteWorkspace: deleteWorkspaceHandler, refreshWorkspaces: fetchWorkspaces }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
