import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useWorkspace } from "../contexts/WorkspaceContext";

type CreditsState = {
  balance: number;
  totalReceived: number;
  periodAllotment: number;
  periodUsed: number;
  bonusCredits: number;
  loading: boolean;
  unlimited: boolean;
  isWorkspacePool: boolean;
  refetch: () => void;
  startPolling: () => void;
};

const POLL_INTERVAL_MS = 5000;
const POLL_DURATION_MS = 30000;

export function useCredits(): CreditsState {
  const { user } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const [balance, setBalance] = useState(0);
  const [totalReceived, setTotalReceived] = useState(0);
  const [periodAllotment, setPeriodAllotment] = useState(0);
  const [periodUsed, setPeriodUsed] = useState(0);
  const [bonusCredits, setBonusCredits] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unlimited, setUnlimited] = useState(false);
  const [isWorkspacePool, setIsWorkspacePool] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCredits = useCallback(() => {
    if (!user) {
      setBalance(0);
      setTotalReceived(0);
      setPeriodAllotment(0);
      setPeriodUsed(0);
      setBonusCredits(0);
      setUnlimited(false);
      setIsWorkspacePool(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    const params = new URLSearchParams();
    if (activeWorkspace && activeWorkspace.type === "org") {
      params.set("workspace_id", activeWorkspace.id);
    }
    const url = `/api/credits${params.toString() ? `?${params}` : ""}`;
    fetch(url, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch credits");
        return res.json();
      })
      .then((data: {
        balance: number;
        totalReceived?: number;
        periodAllotment?: number;
        periodUsed?: number;
        bonusCredits?: number;
        unlimited?: boolean;
        workspace?: boolean;
      }) => {
        setBalance(data.balance);
        setTotalReceived(data.totalReceived || 0);
        setPeriodAllotment(data.periodAllotment || 0);
        setPeriodUsed(data.periodUsed || 0);
        setBonusCredits(data.bonusCredits || 0);
        setUnlimited(data.unlimited === true);
        setIsWorkspacePool(data.workspace === true);
      })
      .catch(() => {
        setBalance(0);
        setTotalReceived(0);
        setPeriodAllotment(0);
        setPeriodUsed(0);
        setBonusCredits(0);
        setUnlimited(false);
        setIsWorkspacePool(false);
      })
      .finally(() => setLoading(false));
  }, [user, activeWorkspace]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(() => {
      fetchCredits();
    }, POLL_INTERVAL_MS);
    pollingTimeoutRef.current = setTimeout(() => {
      stopPolling();
    }, POLL_DURATION_MS);
  }, [fetchCredits, stopPolling]);

  useEffect(() => {
    fetchCredits();
  }, [fetchCredits]);

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return {
    balance,
    totalReceived,
    periodAllotment,
    periodUsed,
    bonusCredits,
    loading,
    unlimited,
    isWorkspacePool,
    refetch: fetchCredits,
    startPolling,
  };
}
