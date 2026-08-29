import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useWorkspace } from "../contexts/WorkspaceContext";

export type SubscriptionData = {
  id: string;
  planTier: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  creditsPerPeriod: number;
  workspaceId?: string | null;
} | null;

type SubscriptionState = {
  subscription: SubscriptionData;
  loading: boolean;
  refetch: () => void;
};

export function useSubscription(): SubscriptionState {
  const { user } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const [subscription, setSubscription] = useState<SubscriptionData>(null);
  const [loading, setLoading] = useState(true);

  const fetchSubscription = useCallback(() => {
    if (!user) {
      setSubscription(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const params = new URLSearchParams();
    if (activeWorkspace && activeWorkspace.type === "org") {
      params.set("workspace_id", activeWorkspace.id);
    }
    const url = `/api/payments/subscription${params.toString() ? `?${params}` : ""}`;
    fetch(url, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch subscription");
        return res.json();
      })
      .then((data: { subscription: SubscriptionData }) => {
        setSubscription(data.subscription);
      })
      .catch(() => {
        setSubscription(null);
      })
      .finally(() => setLoading(false));
  }, [user, activeWorkspace]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  return { subscription, loading, refetch: fetchSubscription };
}
