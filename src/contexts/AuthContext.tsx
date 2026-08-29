import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { prefetchAll, invalidateAll } from "../services/AssetCache";

export type User = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  billingLine1?: string | null;
  billingLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string | null;
  role?: string;
  emailVerified?: boolean;
  authMethod?: string;
};

type ProfileFields = {
  displayName?: string;
  email?: string;
  avatarUrl?: string | null;
  firstName?: string;
  lastName?: string;
  phone?: string;
  dateOfBirth?: string;
  billingLine1?: string;
  billingLine2?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  billingCountry?: string;
};

export type FeatureFlags = {
  sharingV1: boolean;
};

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  sessionExpired: boolean;
  features: FeatureFlags;
  /** True in the login-less local/desktop build — hide billing/upgrade UI. */
  isLocal: boolean;
  signIn: () => void;
  logout: () => Promise<void>;
  updateProfile: (fields: ProfileFields) => Promise<{ error?: string; emailChangeRequested?: boolean; message?: string }>;
  deleteAccount: () => Promise<{ error?: string }>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

interface ApiData {
  error?: string;
  user?: User;
  ok?: boolean;
  emailChangeRequested?: boolean;
  message?: string;
  logoutUrl?: string;
  sessionExpired?: boolean;
  features?: FeatureFlags;
}

const SESSION_EXPIRED_EVENT = "auth:session-expired";

export function dispatchSessionExpired() {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

function getRetryDelay(res: Response): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return 500;
}

async function fetchWithAuthRetry(url: string, opts?: RequestInit): Promise<Response> {
  const fetchOpts: RequestInit = {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
    credentials: "include",
  };
  const res = await fetch(url, fetchOpts);
  if (res.status === 401 || res.status === 503) {
    const delay = getRetryDelay(res);
    await new Promise(resolve => setTimeout(resolve, delay));
    const retryRes = await fetch(url, fetchOpts);
    if (retryRes.status === 401) {
      dispatchSessionExpired();
    }
    return retryRes;
  }
  return res;
}

export async function authFetch(url: string, opts?: RequestInit): Promise<Response> {
  return fetchWithAuthRetry(url, opts);
}

async function apiFetch(url: string, opts?: RequestInit): Promise<{ ok: false; error: string } | { ok: true; data: ApiData }> {
  let res: Response;
  try {
    res = await fetchWithAuthRetry(url, opts);
  } catch {
    return { ok: false, error: "Network error" };
  }
  let data: ApiData;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Invalid server response" };
  }
  if (!res.ok) return { ok: false, error: data.error || "Request failed" };
  return { ok: true, data };
}

const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const VISIBILITY_DEBOUNCE_MS = 60000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [devAuth, setDevAuth] = useState(false);
  const [isLocal, setIsLocal] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [features, setFeatures] = useState<FeatureFlags>({ sharingV1: false });
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCheckRef = useRef<number>(0);
  const checkInFlightRef = useRef<boolean>(false);
  const startHeartbeatRef = useRef<(() => void) | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  const checkSession = useCallback(async () => {
    if (checkInFlightRef.current) return;
    checkInFlightRef.current = true;
    lastCheckRef.current = Date.now();
    try {
      const res = await apiFetch("/api/auth/me");
      if (res.ok) {
        if (res.data.sessionExpired) {
          setUser(null);
          setSessionExpired(true);
          return;
        }
        if (res.data.user) {
          const incoming = res.data.user;
          const current = userRef.current;
          const allKeys = new Set([
            ...(Object.keys(incoming) as (keyof User)[]),
            ...(current ? Object.keys(current) as (keyof User)[] : []),
          ]);
          const changed = !current || Array.from(allKeys).some(
            (k) => incoming[k] !== current[k]
          );
          if (changed) {
            setUser(incoming);
          }
          if (res.data.features) setFeatures(res.data.features);
          setSessionExpired(false);
        }
      }
    } finally {
      checkInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    apiFetch("/api/auth/me").then((meRes) => {
      if (meRes.ok) {
        if (meRes.data.sessionExpired) {
          setSessionExpired(true);
        } else if (meRes.data.user) {
          setUser(meRes.data.user ?? null);
          if (meRes.data.features) setFeatures(meRes.data.features);
          prefetchAll();
        }
      }
      setLoading(false);
    });

    fetch("/api/auth/mode", { credentials: "include" })
      .then(r => r.json())
      .catch(() => ({ devAuth: false, local: false }))
      .then((modeData) => {
        setDevAuth(!!modeData.devAuth);
        setIsLocal(!!modeData.local);
      });
  }, []);

  useEffect(() => {
    const handleSessionExpired = () => {
      setUser(null);
      setSessionExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const elapsed = Date.now() - lastCheckRef.current;
        if (elapsed >= VISIBILITY_DEBOUNCE_MS) {
          checkSession();
        }
        if (user && startHeartbeatRef.current) {
          startHeartbeatRef.current();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [checkSession, user]);

  useEffect(() => {
    const startHeartbeat = () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      heartbeatRef.current = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        checkSession();
      }, HEARTBEAT_INTERVAL_MS);
    };

    startHeartbeatRef.current = startHeartbeat;

    if (user) {
      startHeartbeat();
    } else {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    }
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [user, checkSession]);

  const signIn = useCallback(() => {
    setSessionExpired(false);
    if (devAuth) {
      const email = window.prompt("Enter email for dev login:", "dev@localhost.com");
      if (email) {
        window.location.href = `/auth/dev-login?email=${encodeURIComponent(email)}`;
      }
      return;
    }
    window.location.href = "/auth/login";
  }, [devAuth]);

  const logout = useCallback(async () => {
    const res = await apiFetch("/auth/logout", { method: "POST" });
    invalidateAll();
    setUser(null);
    setSessionExpired(false);
    if (res.ok && res.data.logoutUrl) {
      window.location.href = res.data.logoutUrl;
    } else if (devAuth) {
      window.location.href = "/";
    }
  }, [devAuth]);

  const updateProfile = useCallback(async (fields: ProfileFields) => {
    const res = await apiFetch("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
    if (!res.ok) return { error: res.error };
    setUser(res.data.user ?? null);
    if (res.data.emailChangeRequested) {
      return { emailChangeRequested: true, message: res.data.message };
    }
    return {};
  }, []);

  const deleteAccount = useCallback(async () => {
    const res = await apiFetch("/api/auth/account", { method: "DELETE" });
    if (!res.ok) return { error: res.error };
    setUser(null);
    return {};
  }, []);

  const refreshUser = useCallback(async () => {
    const res = await apiFetch("/api/auth/me");
    if (res.ok) {
      if (res.data.sessionExpired) {
        setUser(null);
        setSessionExpired(true);
      } else if (res.data.user) {
        setUser(res.data.user);
        setSessionExpired(false);
      }
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, sessionExpired, features, isLocal, signIn, logout, updateProfile, deleteAccount, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
