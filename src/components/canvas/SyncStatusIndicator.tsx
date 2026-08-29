import { useState, useEffect, useCallback, useRef } from "react";

export type SyncStatus = "synced" | "syncing" | "confirming" | "failed";

type SyncStatusIndicatorProps = {
  status: SyncStatus;
  failedSeconds: number;
  onRetry?: () => void;
};

export function SyncStatusIndicator({ status, failedSeconds, onRetry }: SyncStatusIndicatorProps) {
  const showBanner = status === "failed" && failedSeconds >= 30;

  if (!showBanner) return null;

  return (
    <div style={{
      position: "fixed",
      top: 16,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 99999,
      background: "#dc2626",
      color: "#fff",
      padding: "10px 20px",
      borderRadius: 8,
      fontSize: 14,
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}>
      <span>⚠ Changes haven't synced for a while. Check your connection.</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            background: "rgba(255,255,255,0.2)",
            border: "1px solid rgba(255,255,255,0.4)",
            color: "#fff",
            padding: "4px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
            whiteSpace: "nowrap",
          }}
        >
          Retry now
        </button>
      )}
    </div>
  );
}

const CONFIRM_WINDOW_MS = 30_000;

export function useSyncStatus() {
  const [rawStatus, setRawStatus] = useState<"synced" | "syncing" | "failed">("synced");
  const [failedSince, setFailedSince] = useState<number | null>(null);
  const [failedSeconds, setFailedSeconds] = useState(0);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmed, setConfirmed] = useState(true);

  const markSyncing = useCallback(() => {
    setRawStatus("syncing");
  }, []);

  const markSynced = useCallback(() => {
    setRawStatus("synced");
    setFailedSince(null);
    setFailedSeconds(0);
    setConfirmed(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmed(true);
    }, CONFIRM_WINDOW_MS);
  }, []);

  const markFailed = useCallback(() => {
    setRawStatus("failed");
    setFailedSince((prev) => prev ?? Date.now());
  }, []);

  useEffect(() => {
    if (failedSince === null) return;
    const interval = setInterval(() => {
      setFailedSeconds(Math.floor((Date.now() - failedSince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [failedSince]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  let status: SyncStatus;
  if (rawStatus === "failed") {
    status = "failed";
  } else if (rawStatus === "syncing") {
    status = "syncing";
  } else if (!confirmed) {
    status = "confirming";
  } else {
    status = "synced";
  }

  return { status, failedSeconds, markSyncing, markSynced, markFailed };
}
