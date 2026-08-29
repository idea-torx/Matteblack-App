import { useState, useRef, useEffect, useCallback } from "react";

export type Notification = {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: string;
  metadata: Record<string, unknown>;
  read: boolean;
  created_at: string;
};

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=20", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unread_count || 0);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNotifications();
    pollRef.current = setInterval(() => { void fetchNotifications(); }, 30000);
    return () => clearInterval(pollRef.current);
  }, [fetchNotifications]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "PATCH", credentials: "include" });
    } catch { /* ignore */ }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await fetch("/api/notifications/read-all", { method: "POST", credentials: "include" });
    } catch { /* ignore */ }
  }, []);

  return { notifications, unreadCount, fetchNotifications, markRead, markAllRead };
}
