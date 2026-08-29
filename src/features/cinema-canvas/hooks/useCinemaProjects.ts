import { useState, useCallback, useRef, useEffect } from "react";

export type CinemaProject = {
  id: string;
  name: string;
  date?: string;
  items?: number;
  node_count?: number;
  gradient?: string;
  thumbnail_url?: string;
  thumbnails?: string[];
  updated_at?: string;
  created_at?: string;
};

type UseCinemaProjectsOptions = {
  workspaceId: string | null;
};

export function useCinemaProjects({ workspaceId }: UseCinemaProjectsOptions) {
  const [cinemaProjects, setCinemaProjects] = useState<CinemaProject[]>([]);
  const [activeCinemaProjectId, setActiveCinemaProjectId] = useState<string | null>(null);
  const fetchVersionRef = useRef(0);
  const activeIdRef = useRef(activeCinemaProjectId);
  activeIdRef.current = activeCinemaProjectId;

  const fetchCinemaProjects = useCallback(async (autoSelectId?: string | null) => {
    if (!workspaceId) { setCinemaProjects([]); setActiveCinemaProjectId(null); return; }
    const version = ++fetchVersionRef.current;
    try {
      const r = await fetch(`/api/projects/${workspaceId}?project_type=cinema`, { credentials: "include" });
      if (fetchVersionRef.current !== version) return;
      if (!r.ok) throw new Error("Failed");
      const data = await r.json();
      if (fetchVersionRef.current !== version) return;
      const list: CinemaProject[] = data.projects || [];
      setCinemaProjects(list);
      if (list.length > 0) {
        if (autoSelectId && list.some((p) => p.id === autoSelectId)) {
          setActiveCinemaProjectId(autoSelectId);
        } else if (!activeIdRef.current || !list.some((p) => p.id === activeIdRef.current)) {
          setActiveCinemaProjectId(list[0].id);
        }
      } else {
        setActiveCinemaProjectId(null);
      }
    } catch {
      if (fetchVersionRef.current !== version) return;
      setCinemaProjects([]);
      setActiveCinemaProjectId(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchCinemaProjects();
  }, [fetchCinemaProjects]);

  const activeCinemaProject = cinemaProjects.find((p) => p.id === activeCinemaProjectId) || null;

  const createCinemaProject = useCallback(async (name: string) => {
    if (!workspaceId) return;
    try {
      const r = await fetch(`/api/projects/${workspaceId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, project_type: "cinema" }),
      });
      if (r.ok) {
        const data = await r.json();
        if (data.project) fetchCinemaProjects(data.project.id);
      }
    } catch {}
  }, [workspaceId, fetchCinemaProjects]);

  const deleteCinemaProject = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/projects/${id}`, { method: "DELETE", credentials: "include" });
      if (r.ok) {
        fetchCinemaProjects(activeCinemaProjectId === id ? null : activeCinemaProjectId);
      }
    } catch {}
  }, [activeCinemaProjectId, fetchCinemaProjects]);

  const renameCinemaProject = useCallback(async (id: string, newName: string) => {
    try {
      const r = await fetch(`/api/projects/${id}/rename`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (r.ok) fetchCinemaProjects(activeCinemaProjectId);
    } catch {}
  }, [activeCinemaProjectId, fetchCinemaProjects]);

  const selectCinemaProject = useCallback((id: string) => {
    setActiveCinemaProjectId(id);
  }, []);

  return {
    cinemaProjects,
    activeCinemaProjectId,
    activeCinemaProject,
    fetchCinemaProjects,
    createCinemaProject,
    deleteCinemaProject,
    renameCinemaProject,
    selectCinemaProject,
  };
}
