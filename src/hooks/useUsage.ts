import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useWorkspace } from "../contexts/WorkspaceContext";

export type UsageByType = Record<string, { count: number; credits: number }>;

export type UsageVariation = {
  type: string;
  credits: number;
  count: number;
};

export type UsageByModelGroup = {
  model: string;
  totalCredits: number;
  totalCount: number;
  variations: UsageVariation[];
};

export type UsageRecentItem = {
  id: string;
  model: string | null;
  type: string;
  creditsCharged: number;
  createdAt: string;
};

export type UsageData = {
  totalCredits: number;
  totalJobs: number;
  grossCharged: number;
  refunds: number;
  netUsed: number;
  periodAllotment: number;
  periodStart: string | null;
  periodEnd: string | null;
  byType: UsageByType;
  byModel: UsageByModelGroup[];
  recent: UsageRecentItem[];
};

type UsageState = {
  data: UsageData | null;
  loading: boolean;
  error: string | null;
};

type RawUsageResponse = {
  total_credits: number;
  total_jobs: number;
  gross_charged?: number;
  refunds?: number;
  net_used?: number;
  period_allotment?: number;
  period_start?: string | null;
  period_end?: string | null;
  by_type: { type: string; credits: number; count: number }[];
  by_model?: {
    model: string;
    total_credits: number;
    total_count: number;
    variations: { type: string; credits: number; count: number }[];
  }[];
  recent?: {
    id: string;
    model: string | null;
    type: string;
    credits_charged: number;
    created_at: string;
  }[];
};

export function useUsage(): UsageState {
  const { user } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (activeWorkspace && activeWorkspace.type === "org") {
      params.set("workspace_id", activeWorkspace.id);
    }
    const url = `/api/usage${params.toString() ? `?${params}` : ""}`;
    fetch(url, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch usage");
        return res.json();
      })
      .then((raw: RawUsageResponse) => {
        const byType: UsageByType = {};
        for (const entry of raw.by_type) {
          byType[entry.type] = { count: entry.count, credits: entry.credits };
        }
        const byModel: UsageByModelGroup[] = (raw.by_model ?? []).map((g) => ({
          model: g.model,
          totalCredits: g.total_credits,
          totalCount: g.total_count,
          variations: g.variations.map((v) => ({
            type: v.type,
            credits: v.credits,
            count: v.count,
          })),
        }));
        const recent: UsageRecentItem[] = (raw.recent ?? []).map((r) => ({
          id: r.id,
          model: r.model,
          type: r.type,
          creditsCharged: r.credits_charged,
          createdAt: r.created_at,
        }));
        setData({
          totalCredits: raw.total_credits,
          totalJobs: raw.total_jobs,
          grossCharged: raw.gross_charged ?? raw.total_credits,
          refunds: raw.refunds ?? 0,
          netUsed: raw.net_used ?? raw.total_credits,
          periodAllotment: raw.period_allotment ?? 0,
          periodStart: raw.period_start ?? null,
          periodEnd: raw.period_end ?? null,
          byType,
          byModel,
          recent,
        });
      })
      .catch((err: Error) => {
        setError(err.message);
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [user, activeWorkspace]);

  return { data, loading, error };
}
