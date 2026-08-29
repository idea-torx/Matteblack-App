import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";

type State = "loading" | "needs-auth" | "joining" | "error";

export function SharePage({ token }: { token: string }) {
  const { user, loading } = useAuth();
  const [state, setState] = useState<State>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setState("needs-auth");
      return;
    }
    let cancelled = false;
    (async () => {
      setState("joining");
      try {
        const res = await fetch("/api/share/redeem", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.error || `Could not open this share link (${res.status})`);
          setState("error");
          return;
        }
        const data = await res.json();
        const projectId = data.projectId as string;
        // Use a URL param so the open intent survives any client-side state
        // resets and can be picked up deterministically on the next render.
        window.location.replace(`/?p=${encodeURIComponent(projectId)}`);
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : "Network error");
        setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [loading, user, token]);

  const goLogin = () => {
    const here = `/share/${encodeURIComponent(token)}`;
    window.location.href = `/auth/login?redirect=${encodeURIComponent(here)}`;
  };

  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg, #0a0a0a)", zIndex: 9999,
    }}>
      <div style={{ maxWidth: 420, width: "100%", padding: 40, textAlign: "center", color: "var(--text, #e5e5e5)" }}>
        {(state === "loading" || state === "joining") && (
          <>
            <div style={{
              width: 48, height: 48, border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#fff",
              borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 24px",
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <h2 style={{ fontSize: 20, fontWeight: 600 }}>
              {state === "joining" ? "Opening shared project..." : "Loading..."}
            </h2>
          </>
        )}
        {state === "needs-auth" && (
          <>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>You've been invited to view a project</h2>
            <p style={{ color: "#a3a3a3", fontSize: 15, marginBottom: 24 }}>Sign in to open this shared project.</p>
            <button type="button" onClick={goLogin} style={{
              padding: "12px 32px", background: "#fff", color: "#000", border: "none",
              borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}>Sign in to continue</button>
          </>
        )}
        {state === "error" && (
          <>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Can't open this link</h2>
            <p style={{ color: "#a3a3a3", fontSize: 14, marginBottom: 24 }}>{errorMsg}</p>
            <button type="button" onClick={() => { window.location.href = "/"; }} style={{
              padding: "12px 32px", background: "#fff", color: "#000", border: "none",
              borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: "pointer",
            }}>Go to app</button>
          </>
        )}
      </div>
    </div>
  );
}
