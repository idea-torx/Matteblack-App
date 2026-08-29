import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";

type VerifyState = "loading" | "success" | "error" | "expired";

export function VerifyEmailPage({ token }: { token: string }) {
  const { refreshUser } = useAuth();
  const [state, setState] = useState<VerifyState>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function verify() {
      try {
        const res = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
          credentials: "include",
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          if (data.error?.toLowerCase().includes("expired")) {
            setState("expired");
          } else {
            setState("error");
          }
          setErrorMsg(data.error || "Verification failed");
          return;
        }
        setState("success");
        await refreshUser();
        setTimeout(() => {
          window.location.href = "/";
        }, 2000);
      } catch {
        if (!cancelled) {
          setState("error");
          setErrorMsg("Network error. Please try again.");
        }
      }
    }
    verify();
    return () => { cancelled = true; };
  }, [token, refreshUser]);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--bg, #0a0a0a)",
      zIndex: 9999,
    }}>
      <div style={{
        maxWidth: 420,
        width: "100%",
        padding: 40,
        textAlign: "center",
        color: "var(--text, #e5e5e5)",
      }}>
        {state === "loading" && (
          <>
            <div style={{
              width: 48,
              height: 48,
              border: "3px solid rgba(255,255,255,0.1)",
              borderTopColor: "#fff",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              margin: "0 auto 24px",
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Verifying your email...</h2>
            <p style={{ fontSize: 14, color: "var(--text-muted, #888)" }}>Please wait a moment.</p>
          </>
        )}

        {state === "success" && (
          <>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(74, 222, 128, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 24px",
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Email verified!</h2>
            <p style={{ fontSize: 14, color: "var(--text-muted, #888)" }}>Redirecting you to the app...</p>
          </>
        )}

        {(state === "error" || state === "expired") && (
          <>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(248, 113, 113, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 24px",
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
              {state === "expired" ? "Link expired" : "Verification failed"}
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-muted, #888)", lineHeight: 1.6, marginBottom: 24 }}>
              {errorMsg}
            </p>
            <button
              type="button"
              onClick={() => { window.location.href = "/"; }}
              style={{
                padding: "12px 32px",
                background: "#fff",
                color: "#000",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Go to app
            </button>
          </>
        )}
      </div>
    </div>
  );
}
